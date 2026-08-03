import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// The ARTIFACT LINTERS, family A — `dobby spec lint`, `dobby map next|claim|lint`
// and `dobby skill lint`.
//
// All three share ONE report contract: findings one per line, exit 1 on any
// finding, exit 0 + `ok` when clean, `--json` → `{ok, findings: [{check, message,
// where}]}`. They differ only in the check inventory, so the suite is organized
// inventory-first: one clean fixture per artifact (the spine), then one test per
// check, each injecting a SINGLE defect into that otherwise-clean fixture. That
// is what makes a bare `exitCode === 1` a real assertion — the clean-fixture test
// proves the rest of the document is silent, so the exit can only come from the
// injected defect.
//
// Seam: the in-process `run(argv, cwd)` contract (ADR-0008) — the domain module
// is never imported directly, so its internals stay free to move. Every fixture
// is a THROWAWAY real git repo (`makeScratchRepo`), because these commands
// resolve their default targets from the workroot.
//
// Boundaries mocked: NONE. These linters read files and answer; there is no
// network, clock, or randomness in reach. `git` is real (temp repos), which is
// what makes the workroot-resolution assertions trustworthy.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - The required `###` sub-heading set (Overview, Goals, Non-goals, Constraints,
//    Decisions, Testing Decisions, Edge cases, Module structure, Tasks; User flow
//    optional) is the task spec's enumeration, and matches `plugin/skills/spec`
//    Step 2 verbatim.
//  - The task-table columns and the `—` no-dependency convention are
//    `plugin/skills/spec/references/task-decomposition.md`'s literal table, plus
//    the `Destructive` column from the session's open question 5.
//  - `Manual verify setup: none` is the literal field name and default value
//    stated in `plugin/skills/spec/references/testing-decisions.md`.
//  - The banned-command list and its word-boundary, case-insensitive matching are
//    the task spec's own regex.
//  - The ticket format (`## <slug>: Title`, `Blocked by:` / `Status:` / `Type:`,
//    `### Question` / `### Answer`), the three Status values and the three Types
//    are `plugin/skills/map/SKILL.md`'s literal format block.
//  - The frontmatter whitelist, the kebab/≤64/no-`claude` name rule, the ≤1024
//    description cap and the `effort` value set are
//    `plugin/skills/create-skill/references/frontmatter.md`; the ≤500-line budget,
//    the closing `## Acceptance checklist`, "paths as inline code, no markdown
//    links" and "one level deep — never reference a reference" are
//    `plugin/skills/create-skill/SKILL.md`'s craft rules (session decision 18
//    settles 500 over 200).
//  - Every "which ticket is next" answer is read off a fixture WE wrote: the
//    tickets, their order, and their statuses are literals here, so the expected
//    slug is picked by hand from the document, never recomputed the way the code
//    would.
//  - Every "file untouched" assertion compares against the fixture bytes we wrote,
//    never against a re-derivation.
//
// Why these are RED before the implementation: `runArtifactLint` returns
// `notImplemented` today, so every invocation exits 1 with `<command>: not
// implemented` on stderr, empty stdout, and no file touched — no clean verdict,
// no JSON payload, no finding text, no claim.
//
// Surface notes for the implementor (see the work log for the full list):
//  - The targets are POSITIONAL (`spec lint [<file>]`, `map claim <slug>`,
//    `skill lint <dir>`), which is what the task spec names and what `run.ts`
//    already accepts without any change. The registry ALSO allowlists `--file`
//    (and `--task` on `map claim`); supporting them as aliases is fine, but the
//    positional form is the contract asserted here.
//  - `Blocked by: —` is written as the kit's no-dependency marker (the same `—`
//    the task table uses for `Depends on`); it must not be read as a slug.
// ===========================================================================

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
});

// --- report readers (test-side, deliberately dumb) --------------------------

// Both channels of a report: the contract fixes the exit code and the finding
// TEXT, not which stream carries it.
function reportOf(result: { stderr: string; stdout: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

// The `--json` payload as loose data — the shape is asserted key by key, so a
// parse helper never encodes an expectation.
function payloadOf(result: { stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// The non-empty lines of a report — "one finding per line" is a claim about
// lines, not about the whole blob.
function reportLines(result: { stderr: string; stdout: string }): string[] {
  return reportOf(result)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// Top-level per the repo's useTopLevelRegex convention.
const SAYS_GOALS = /Goals/;
const SAYS_TEST_FIRST = /test-first/i;
const SAYS_DEPENDS = /depends on|dependenc/i;
const SAYS_VERIFY_RECIPE = /verify recipe/i;
const SAYS_TABLE = /table/i;
const SAYS_BANNED = /dobby check|banned/i;
const SAYS_MANUAL_SETUP = /manual verify setup/i;
const SAYS_CODE_BLOCK = /fenc|code block/i;
const SAYS_DUPLICATE = /duplicate|unique/i;
const SAYS_CYCLE = /cycle|circular/i;
const SAYS_ANSWER = /answer/i;
const SAYS_DESCRIPTION = /description/i;
const SAYS_LINES = /line/i;
const SAYS_CHECKLIST = /acceptance checklist/i;
const SAYS_LINK = /link/i;
const SAYS_NESTED_REFERENCE = /detail\.md|deeper\.md/;

// ===========================================================================
// FIXTURES — the `## Spec` artifact.
//
// One clean spec in this session's own shape, plus surgical mutations. Every
// builder below constructs INPUT; not one of them computes an expected value.
// ===========================================================================

type Section = readonly [name: string, body: string];
type Sections = readonly Section[];

// The task table's columns, exactly as `task-decomposition.md` presents them,
// plus the optional `Destructive` column.
const TASK_HEADER =
  "| # | Task | Description | Depends on | Affected areas | Test-first | Destructive | Verify recipe |";
const TASK_RULE =
  "|---|------|-------------|------------|----------------|------------|-------------|---------------|";

// Verify recipes are `action → observable` and deliberately carry NO banned
// command (no lint/format/typecheck/tsc/biome/knip/vitest/jest/npm test/bun
// test/dobby check/build), so the clean fixture is clean for the stated reason.
const ROW_1 =
  "| 1 | Command registry | Per-command flag allowlist plus one stub per session command. | — | cli/src/run.ts | yes | no | dobby env --fix → exit 1 naming the flag and the command |";
const ROW_2 =
  "| 2 | Artifact checks A | The spec, map and skill artifact checks in one module. | 1 | cli/src/artifact-lint.ts | yes | no | dobby spec on a document missing ### Goals → exit 1 naming the section |";
const ROW_3 =
  "| 3 | Session preflights | Read-only verdicts for scope and finish. | 1 | cli/src/preflight.ts | yes | no | dobby scope preflight --slug demo → JSON reporting the collision |";

function taskTable(rows: readonly string[]): string {
  return [TASK_HEADER, TASK_RULE, ...rows].join("\n");
}

const CLEAN_TABLE = taskTable([ROW_1, ROW_2, ROW_3]);

// The nine required sub-headings plus the optional `User flow`, each with a body
// a real spec would carry. The fenced block sits under `### Decisions`, where the
// spec skill explicitly allows it (the "snippet exception").
const CLEAN_SECTIONS: Sections = [
  [
    "Overview",
    "The kit's mechanical steps move into the dobby CLI so the stage skills stop hand-rolling them in prose.",
  ],
  [
    "User flow",
    "1. The architect runs a stage skill.\n2. The skill asks the CLI for the mechanical step.\n3. The CLI answers with JSON the skill acts on.",
  ],
  [
    "Goals",
    "- One command per mechanical step.\n- Every artifact judged by the CLI, never by prose.",
  ],
  ["Non-goals", "- Monorepo capability inference stays out of scope."],
  [
    "Constraints",
    "- ADR-0008: node:* only, no framework, the in-process run(argv, cwd) seam.",
  ],
  [
    "Decisions",
    "1. The registry validates flags per command.\n2. Findings print one per line; any finding exits 1.\n\n```ts\ninterface CommandResult {\n  exitCode: number;\n}\n```",
  ],
  [
    "Testing Decisions",
    "Seams: the in-process run(argv, cwd) contract; no other new seams.\n\nManual verify setup: none",
  ],
  [
    "Edge cases",
    "- A document whose Spec section is missing entirely → one finding, never a crash.",
  ],
  [
    "Module structure",
    "- cli/src/artifact-lint.ts — one module for the whole artifact family; the dispatcher stays untouched.",
  ],
  ["Tasks", CLEAN_TABLE],
];

function specBody(sections: Sections): string {
  return sections.map(([name, body]) => `### ${name}\n\n${body}\n`).join("\n");
}

// A full STATE.md carrying the given spec body — the document `spec lint` reads
// by default (its `## Spec` section).
function stateDoc(body: string): string {
  return [
    "# Work session: mechanize the kit",
    "",
    "## Goal",
    "mechanize the kit",
    "",
    "## Source",
    "prompt",
    "",
    "## Exploration",
    "_pending_",
    "",
    "## Findings (interview)",
    "_pending_",
    "",
    "## Research",
    "_pending_",
    "",
    "## Spec",
    "",
    body,
    "## Work log",
    "_pending_",
    "",
  ].join("\n");
}

function withoutSection(name: string): Sections {
  return CLEAN_SECTIONS.filter(([heading]) => heading !== name);
}

function withSection(name: string, body: string): Sections {
  return CLEAN_SECTIONS.map(([heading, original]) =>
    heading === name
      ? ([heading, body] as const)
      : ([heading, original] as const)
  );
}

function withTable(table: string): Sections {
  return withSection("Tasks", table);
}

// A scratch repo holding a STATE.md with the given spec sections. `vitest: false`
// drops the dependency, which is what turns the `Test-first` column from required
// into absent-by-design (the capability comes from the shared detector).
function makeSpecRepo(
  sections: Sections = CLEAN_SECTIONS,
  opts: { vitest?: boolean } = {}
): string {
  const devDependencies =
    opts.vitest === false ? {} : { vitest: "^3.2.0" as string };
  return makeScratchRepo({
    files: { "STATE.md": stateDoc(specBody(sections)) },
    pkg: { devDependencies, name: "fixture-project", private: true },
    prefix: "dobby-artifact-spec-",
    track: scratchDirs,
  });
}

// ===========================================================================
// Slice 1 — the FIRST tracer bullet: a well-formed spec lints CLEAN.
//
// Everything else in this file is a deviation from this one document, so it is
// the slice to make green first: without it, a linter that flags everything
// would "pass" every finding test below.
// ===========================================================================

describe("dobby spec lint — a well-formed spec", () => {
  it("reports ok and exits 0 for a spec carrying every required sub-heading and a well-formed task table", async () => {
    const root = makeSpecRepo();
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("lints the workroot's STATE.md when invoked from a subdirectory", async () => {
    const root = makeSpecRepo();
    const sub = join(root, "cli", "src");
    mkdirSync(sub, { recursive: true });
    const result = await run(["spec", "lint"], sub);
    expect(result.exitCode).toBe(0);
  });

  it("lints the file named as a positional argument", async () => {
    const root = makeScratchRepo({
      files: { "plan.md": stateDoc(specBody(CLEAN_SECTIONS)) },
      pkg: { devDependencies: { vitest: "^3.2.0" }, name: "fixture-project" },
      prefix: "dobby-artifact-spec-",
      track: scratchDirs,
    });
    const result = await run(["spec", "lint", join(root, "plan.md")], root);
    expect(result.exitCode).toBe(0);
  });

  it("accepts a spec with no `### User flow` section (it is the one optional heading)", async () => {
    const root = makeSpecRepo(withoutSection("User flow"));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
  });
});

// ===========================================================================
// Slice 2 — the sub-heading inventory.
// ===========================================================================

describe("dobby spec lint — required sub-headings", () => {
  it("reports a missing `### Goals`, naming it", async () => {
    const root = makeSpecRepo(withoutSection("Goals"));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_GOALS);
  });

  it("reports a missing `### Testing Decisions`, naming it", async () => {
    const root = makeSpecRepo(withoutSection("Testing Decisions"));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Testing Decisions");
  });

  it("reports an unwritten spec (`_pending_`) as findings rather than passing it", async () => {
    // The live-session shape when the plan has not landed yet: the `## Spec`
    // section exists but carries no sub-headings at all.
    const root = makeScratchRepo({
      files: { "STATE.md": stateDoc("_pending_\n") },
      pkg: { devDependencies: { vitest: "^3.2.0" }, name: "fixture-project" },
      prefix: "dobby-artifact-spec-",
      track: scratchDirs,
    });
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Overview");
  });
});

// ===========================================================================
// Slice 3 — the task table: the columns, the cells, and the dependency edges.
// ===========================================================================

describe("dobby spec lint — the task table", () => {
  it("reports a table with no `Verify recipe` column", async () => {
    const table = [
      "| # | Task | Description | Depends on | Affected areas | Test-first | Destructive |",
      "|---|------|-------------|------------|----------------|------------|-------------|",
      "| 1 | Command registry | Per-command flag allowlist. | — | cli/src/run.ts | yes | no |",
      "| 2 | Artifact checks A | The spec, map and skill artifact checks. | 1 | cli/src/artifact-lint.ts | yes | no |",
    ].join("\n");
    const root = makeSpecRepo(withTable(table));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_VERIFY_RECIPE);
  });

  it("accepts a table with no `Destructive` column (it is optional)", async () => {
    const table = [
      "| # | Task | Description | Depends on | Affected areas | Test-first | Verify recipe |",
      "|---|------|-------------|------------|----------------|------------|---------------|",
      "| 1 | Command registry | Per-command flag allowlist. | — | cli/src/run.ts | yes | dobby env --fix → exit 1 naming the flag |",
      "| 2 | Artifact checks A | The spec, map and skill artifact checks. | 1 | cli/src/artifact-lint.ts | yes | dobby spec on a document missing a section → exit 1 naming it |",
    ].join("\n");
    const root = makeSpecRepo(withTable(table));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
  });

  it("reports a missing `Test-first` column when the repo has the vitest capability", async () => {
    const root = makeSpecRepo(withTable(NO_TEST_FIRST_TABLE), { vitest: true });
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_TEST_FIRST);
  });

  it("accepts the same table with no `Test-first` column when the repo has no test suite", async () => {
    const root = makeSpecRepo(withTable(NO_TEST_FIRST_TABLE), {
      vitest: false,
    });
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
  });

  it("reports a row with an empty `Verify recipe` cell", async () => {
    const emptyRecipe =
      "| 3 | Session preflights | Read-only verdicts for scope and finish. | 1 | cli/src/preflight.ts | yes | no |  |";
    const root = makeSpecRepo(
      withTable(taskTable([ROW_1, ROW_2, emptyRecipe]))
    );
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_VERIFY_RECIPE);
  });

  it("reports a `Depends on` cell pointing at a task id that does not exist", async () => {
    const dangling =
      "| 3 | Session preflights | Read-only verdicts for scope and finish. | 9 | cli/src/preflight.ts | yes | no | dobby scope preflight --slug demo → JSON reporting the collision |";
    const root = makeSpecRepo(withTable(taskTable([ROW_1, ROW_2, dangling])));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_DEPENDS);
  });

  it("reports a forward reference — a task depending on one scheduled after it", async () => {
    const forward =
      "| 1 | Command registry | Per-command flag allowlist plus one stub per session command. | 2 | cli/src/run.ts | yes | no | dobby env --fix → exit 1 naming the flag and the command |";
    const root = makeSpecRepo(withTable(taskTable([forward, ROW_2, ROW_3])));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_DEPENDS);
  });

  it("reports a second table under `### Tasks`", async () => {
    const second = [
      CLEAN_TABLE,
      "",
      "| # | Task |",
      "|---|------|",
      "| 4 | A second table nobody asked for |",
    ].join("\n");
    const root = makeSpecRepo(withTable(second));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_TABLE);
  });
});

// The same table, minus the `Test-first` column — used twice, once under each
// capability verdict, so the ONLY difference between those two tests is the
// repo's dependency list.
const NO_TEST_FIRST_TABLE = [
  "| # | Task | Description | Depends on | Affected areas | Destructive | Verify recipe |",
  "|---|------|-------------|------------|----------------|-------------|---------------|",
  "| 1 | Command registry | Per-command flag allowlist. | — | cli/src/run.ts | no | dobby env --fix → exit 1 naming the flag |",
  "| 2 | Artifact checks A | The spec, map and skill artifact checks. | 1 | cli/src/artifact-lint.ts | no | dobby spec on a document missing a section → exit 1 naming it |",
].join("\n");

// ===========================================================================
// Slice 4 — the content rules: banned commands in verify recipes, the manual
// verify setup field, and where a fenced block may live.
// ===========================================================================

describe("dobby spec lint — verify recipes and Testing Decisions", () => {
  it("reports a verify recipe that runs the quality gate instead of observing behavior", async () => {
    const banned =
      "| 3 | Session preflights | Read-only verdicts for scope and finish. | 1 | cli/src/preflight.ts | yes | no | run dobby check --fix → no findings |";
    const root = makeSpecRepo(withTable(taskTable([ROW_1, ROW_2, banned])));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_BANNED);
  });

  it("accepts a verify recipe whose wording merely CONTAINS a banned word (`rebuild`)", async () => {
    // The ban is word-boundary matched: `rebuild` is not `build`, and flagging it
    // would make honest recipes unwritable.
    const rebuild =
      "| 3 | Session preflights | Read-only verdicts for scope and finish. | 1 | cli/src/preflight.ts | yes | no | rebuild the fixture map, then reopen it → the ticket reappears |";
    const root = makeSpecRepo(withTable(taskTable([ROW_1, ROW_2, rebuild])));
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
  });

  it("reports a missing `Manual verify setup:` line under `### Testing Decisions`", async () => {
    const root = makeSpecRepo(
      withSection(
        "Testing Decisions",
        "Seams: the in-process run(argv, cwd) contract; no other new seams."
      )
    );
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_MANUAL_SETUP);
  });

  it("accepts a `Manual verify setup:` line followed by numbered steps", async () => {
    const root = makeSpecRepo(
      withSection(
        "Testing Decisions",
        [
          "Seams: the in-process run(argv, cwd) contract; no other new seams.",
          "",
          "Manual verify setup:",
          "1. Log in as the owner test user in the verification surface.",
          "2. Ensure at least one project exists in that account.",
        ].join("\n")
      )
    );
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
  });

  it("reports a fenced code block outside `### Decisions`", async () => {
    const root = makeSpecRepo(
      withSection(
        "Overview",
        "The kit's mechanical steps move into the dobby CLI.\n\n```ts\nconst snippet = 1;\n```"
      )
    );
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_CODE_BLOCK);
  });

  it("reports a `Manual verify setup:` value that is neither `none` nor followed by numbered steps", async () => {
    const root = makeSpecRepo(
      withSection(
        "Testing Decisions",
        [
          "Seams: the in-process run(argv, cwd) contract; no other new seams.",
          "",
          "Manual verify setup: ask whoever is around to set something up",
        ].join("\n")
      )
    );
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_MANUAL_SETUP);
  });

  it("accepts the field written INLINE at the end of the paragraph, with a trailing period", async () => {
    // The form the kit's own spec skill produces: `None — markdown-only change;
    // no code seams, no test suite involvement. **Manual verify setup: none.**`
    const root = makeSpecRepo(
      withSection(
        "Testing Decisions",
        "None — markdown-only change; no code seams, no test suite involvement. **Manual verify setup: none.**"
      )
    );
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
  });

  it("keeps reading the spec past a fenced snippet that itself contains a `## ` line", async () => {
    // A spec about markdown quotes markdown: the snippet's `## Spec` heading is
    // sample text, and must not end the Spec section (which would report every
    // sub-heading below it — Testing Decisions, Edge cases, Tasks — as missing).
    const root = makeSpecRepo(
      withSection(
        "Decisions",
        [
          "1. The registry validates flags per command.",
          "",
          "```md",
          "## Spec",
          "",
          "### Goals",
          "```",
        ].join("\n")
      )
    );
    const result = await run(["spec", "lint"], root);
    expect(result.exitCode).toBe(0);
  });
});

// ===========================================================================
// Slice 5 — the shared report contract every linter in the family answers with.
// ===========================================================================

describe("dobby spec lint — the report contract", () => {
  it("answers a clean document with {ok: true, findings: []} as the only stdout", async () => {
    const root = makeSpecRepo();
    const result = await run(["spec", "lint", "--json"], root);
    const payload = payloadOf(result);
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.findings).toEqual([]);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  it("answers a defective document with ok:false and findings carrying check, message and where", async () => {
    const root = makeSpecRepo(withoutSection("Goals"));
    const result = await run(["spec", "lint", "--json"], root);
    const payload = payloadOf(result);
    const findings = payload.findings as {
      check?: unknown;
      message?: unknown;
      where?: unknown;
    }[];
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(typeof finding.check).toBe("string");
      expect(typeof finding.message).toBe("string");
      expect(typeof finding.where).toBe("string");
    }
    expect(JSON.stringify(payload)).toMatch(SAYS_GOALS);
  });

  it("prints two defects as two findings, naming both", async () => {
    const banned =
      "| 3 | Session preflights | Read-only verdicts for scope and finish. | 1 | cli/src/preflight.ts | yes | no | run dobby check --fix → no findings |";
    const sections = withoutSection("Goals").map(([name, body]) =>
      name === "Tasks"
        ? ([name, taskTable([ROW_1, ROW_2, banned])] as const)
        : ([name, body] as const)
    );
    const root = makeSpecRepo(sections);
    const result = await run(["spec", "lint"], root);
    const report = reportOf(result);
    expect(result.exitCode).toBe(1);
    expect(report).toMatch(SAYS_GOALS);
    expect(report).toMatch(SAYS_BANNED);
    expect(reportLines(result).length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// FIXTURES — the decision map.
// ===========================================================================

interface Ticket {
  answer?: string;
  blockedBy?: string;
  question?: string;
  slug: string;
  status: string;
  title: string;
  type: string;
}

// `Blocked by: —` is the kit's no-dependency marker (same as the task table's
// `Depends on` column).
function ticketBlock(ticket: Ticket): string {
  return [
    `## ${ticket.slug}: ${ticket.title}`,
    "",
    `Blocked by: ${ticket.blockedBy ?? "—"}`,
    `Status: ${ticket.status}`,
    `Type: ${ticket.type}`,
    "",
    "### Question",
    "",
    ticket.question ?? "The open decision, stated sharply.",
    "",
    "### Answer",
    "",
    ticket.answer ?? "",
  ]
    .join("\n")
    .trimEnd();
}

function mapDoc(tickets: readonly Ticket[]): string {
  const blocks = tickets.map(ticketBlock).join("\n\n");
  return `# Auth rework — decision map\n\n${blocks}\n`;
}

// The spine map: one resolved root, one open ticket unblocked BY that root, and
// one open ticket still blocked behind the second. Read by hand, the only
// claimable ticket is `auth-strategy`.
const CLEAN_TICKETS: readonly Ticket[] = [
  {
    answer: "Relational — Postgres on Neon; see docs/research/db.md.",
    question: "Do the billing rows need relational integrity?",
    slug: "relational-db",
    status: "resolved",
    title: "Relational or non-relational database?",
    type: "Research",
  },
  {
    blockedBy: "relational-db",
    question: "Session cookies or JWT?",
    slug: "auth-strategy",
    status: "open",
    title: "Which auth strategy?",
    type: "Grilling",
  },
  {
    blockedBy: "auth-strategy",
    question: "Is a read-through cache worth it before launch?",
    slug: "cache-layer",
    status: "open",
    title: "Do we need a cache layer?",
    type: "Prototype",
  },
];

const MAP_NAME = "auth-rework";

function mapPath(root: string, name = MAP_NAME): string {
  return join(root, "docs", "maps", `${name}.md`);
}

function makeMapRepo(
  tickets: readonly Ticket[] = CLEAN_TICKETS,
  name = MAP_NAME
): string {
  return makeScratchRepo({
    files: { [`docs/maps/${name}.md`]: mapDoc(tickets) },
    pkg: { name: "fixture-project", private: true },
    prefix: "dobby-artifact-map-",
    track: scratchDirs,
  });
}

function readMap(root: string, name = MAP_NAME): string {
  return readFileSync(mapPath(root, name), "utf8");
}

// A ticket with one field overridden — a mutation helper that builds INPUT only.
function ticketWith(index: number, patch: Partial<Ticket>): Ticket[] {
  return CLEAN_TICKETS.map((ticket, at) =>
    at === index ? { ...ticket, ...patch } : { ...ticket }
  );
}

// ===========================================================================
// Slice 6 — `map lint`: the structural gate over the decision map.
// ===========================================================================

describe("dobby map lint — a well-formed map", () => {
  it("reports ok and exits 0 for a map whose tickets, statuses and edges are all valid", async () => {
    const root = makeMapRepo();
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("lints the map named as a positional argument", async () => {
    const root = makeMapRepo();
    const result = await run(["map", "lint", mapPath(root)], root);
    expect(result.exitCode).toBe(0);
  });

  it("does not read a fenced `## slug:` block inside an Answer as a ticket", async () => {
    // An answer routinely quotes the shape it rejected; those lines are prose,
    // so their slug, Status and Type must never be linted as a real ticket.
    const root = makeMapRepo([
      {
        answer: [
          "Relational — Postgres on Neon. The shape we rejected read:",
          "",
          "```md",
          "## Legacy_Ticket: the shape we rejected",
          "",
          "Status: pending",
          "Type: Vibes",
          "```",
        ].join("\n"),
        question: "Do the billing rows need relational integrity?",
        slug: "relational-db",
        status: "resolved",
        title: "Relational or non-relational database?",
        type: "Research",
      },
    ]);
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(0);
  });
});

describe("dobby map lint — structural findings", () => {
  it("reports two tickets sharing one slug", async () => {
    const root = makeMapRepo([
      ...CLEAN_TICKETS,
      {
        blockedBy: "relational-db",
        slug: "auth-strategy",
        status: "open",
        title: "Which auth strategy, again?",
        type: "Grilling",
      },
    ]);
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("auth-strategy");
    expect(reportOf(result)).toMatch(SAYS_DUPLICATE);
  });

  it("reports a slug that is not kebab-case", async () => {
    const root = makeMapRepo(ticketWith(1, { slug: "Auth_Strategy" }));
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Auth_Strategy");
  });

  it("reports a Status outside open|in-progress|resolved", async () => {
    const root = makeMapRepo(ticketWith(1, { status: "pending" }));
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("pending");
  });

  it("reports a Type outside Research|Prototype|Grilling", async () => {
    const root = makeMapRepo(ticketWith(1, { type: "Vibes" }));
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Vibes");
  });

  it("reports a `Blocked by` edge pointing at a ticket that does not exist", async () => {
    const root = makeMapRepo(ticketWith(1, { blockedBy: "ghost-ticket" }));
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("ghost-ticket");
  });

  it("reports a blocking cycle, naming the tickets caught in it", async () => {
    const root = makeMapRepo([
      {
        blockedBy: "cache-layer",
        slug: "auth-strategy",
        status: "open",
        title: "Which auth strategy?",
        type: "Grilling",
      },
      {
        blockedBy: "auth-strategy",
        slug: "cache-layer",
        status: "open",
        title: "Do we need a cache layer?",
        type: "Prototype",
      },
    ]);
    const result = await run(["map", "lint"], root);
    const report = reportOf(result);
    expect(result.exitCode).toBe(1);
    expect(report).toContain("auth-strategy");
    expect(report).toContain("cache-layer");
    expect(report).toMatch(SAYS_CYCLE);
  });

  it("reports a resolved ticket whose Answer is empty", async () => {
    const root = makeMapRepo(ticketWith(1, { answer: "", status: "resolved" }));
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("auth-strategy");
    expect(reportOf(result)).toMatch(SAYS_ANSWER);
  });

  it("accepts an OPEN ticket with an empty Answer", async () => {
    // Only `resolved` obliges an answer — the whole frontier is answerless.
    const root = makeMapRepo();
    const result = await run(["map", "lint"], root);
    expect(result.exitCode).toBe(0);
  });
});

// ===========================================================================
// Slice 7 — `map next`: which ticket the architect works this cycle.
// ===========================================================================

describe("dobby map next — the next claimable ticket", () => {
  it("names the first open ticket whose blockers are all resolved, without claiming it", async () => {
    const root = makeMapRepo();
    const before = readMap(root);
    const result = await run(["map", "next", "--json"], root);
    const payload = payloadOf(result);
    expect(result.exitCode).toBe(0);
    expect(payload.slug).toBe("auth-strategy");
    expect(readMap(root)).toBe(before);
  });

  it("answers with the ticket's title, type and question", async () => {
    const root = makeMapRepo();
    const result = await run(["map", "next", "--json"], root);
    const payload = payloadOf(result);
    expect(payload.title).toBe("Which auth strategy?");
    expect(payload.type).toBe("Grilling");
    expect(String(payload.question)).toContain("Session cookies or JWT?");
  });

  it("skips a ticket already claimed by another session (in-progress)", async () => {
    const root = makeMapRepo([
      ...ticketWith(1, { status: "in-progress" }),
      {
        blockedBy: "relational-db",
        question: "Do we throttle by IP or by account?",
        slug: "rate-limits",
        status: "open",
        title: "How do we rate-limit?",
        type: "Grilling",
      },
    ]);
    const result = await run(["map", "next", "--json"], root);
    expect(payloadOf(result).slug).toBe("rate-limits");
  });

  it("skips a ticket whose blocker is still open, even when it comes first in the document", async () => {
    const root = makeMapRepo([
      {
        blockedBy: "auth-strategy",
        question: "Is a read-through cache worth it before launch?",
        slug: "cache-layer",
        status: "open",
        title: "Do we need a cache layer?",
        type: "Prototype",
      },
      {
        question: "Session cookies or JWT?",
        slug: "auth-strategy",
        status: "open",
        title: "Which auth strategy?",
        type: "Grilling",
      },
    ]);
    const result = await run(["map", "next", "--json"], root);
    expect(payloadOf(result).slug).toBe("auth-strategy");
  });

  it("answers with no ticket when every ticket is resolved", async () => {
    const root = makeMapRepo([
      {
        answer: "Relational — Postgres on Neon.",
        slug: "relational-db",
        status: "resolved",
        title: "Relational or non-relational database?",
        type: "Research",
      },
      {
        answer: "Session cookies, rotated weekly.",
        blockedBy: "relational-db",
        slug: "auth-strategy",
        status: "resolved",
        title: "Which auth strategy?",
        type: "Grilling",
      },
    ]);
    const result = await run(["map", "next", "--json"], root);
    expect(payloadOf(result).slug ?? null).toBeNull();
  });

  it("reads the NEWEST map in docs/maps when no file is named", async () => {
    const root = makeMapRepo(
      [
        {
          question: "A question nobody is working on any more.",
          slug: "legacy-question",
          status: "open",
          title: "The superseded effort",
          type: "Grilling",
        },
      ],
      "0001-legacy"
    );
    const current = mapPath(root, "0002-current");
    mkdirSync(join(root, "docs", "maps"), { recursive: true });
    const currentDoc = mapDoc([
      {
        question: "The decision this session is actually pushing on.",
        slug: "current-question",
        status: "open",
        title: "The live effort",
        type: "Grilling",
      },
    ]);
    writeFileSync(current, currentDoc);
    // Make the age unambiguous both ways: the legacy map sorts first AND is an
    // hour older on disk.
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(mapPath(root, "0001-legacy"), anHourAgo, anHourAgo);
    const result = await run(["map", "next", "--json"], root);
    expect(payloadOf(result).slug).toBe("current-question");
  });
});

// ===========================================================================
// Slice 8 — `map claim <slug>`: the one WRITE in the map family.
// ===========================================================================

describe("dobby map claim — claiming a ticket", () => {
  it("rewrites the named ticket's Status to in-progress", async () => {
    const root = makeMapRepo();
    const result = await run(["map", "claim", "auth-strategy"], root);
    const doc = readMap(root);
    expect(result.exitCode).toBe(0);
    expect(doc).toContain(
      "## auth-strategy: Which auth strategy?\n\nBlocked by: relational-db\nStatus: in-progress\nType: Grilling"
    );
  });

  it("changes nothing in the map but that one Status line", async () => {
    const root = makeMapRepo();
    const before = readMap(root);
    await run(["map", "claim", "auth-strategy"], root);
    const after = readMap(root);
    // Putting the marker back must restore the fixture EXACTLY: the claim is the
    // only difference the write is allowed to make.
    expect(after).toContain("Status: in-progress");
    expect(after.replace("Status: in-progress", "Status: open")).toBe(before);
  });

  it("answers with the claim as JSON", async () => {
    const root = makeMapRepo();
    const result = await run(["map", "claim", "auth-strategy", "--json"], root);
    const payload = payloadOf(result);
    expect(result.exitCode).toBe(0);
    expect(Object.hasOwn(payload, "claimed")).toBe(true);
    expect(JSON.stringify(payload)).toContain("auth-strategy");
  });

  it("rewrites a Status that is not `open` either — the claim it reports is the claim the file carries", async () => {
    const root = makeMapRepo(ticketWith(1, { status: "pending" }));
    const result = await run(["map", "claim", "auth-strategy"], root);
    const doc = readMap(root);
    expect(result.exitCode).toBe(0);
    expect(doc).toContain(
      "## auth-strategy: Which auth strategy?\n\nBlocked by: relational-db\nStatus: in-progress\nType: Grilling"
    );
    expect(doc).not.toContain("Status: pending");
  });

  it("preserves CRLF line endings when claiming in a Windows-authored map", async () => {
    const crlf = mapDoc(CLEAN_TICKETS).replaceAll("\n", "\r\n");
    const root = makeScratchRepo({
      files: { [`docs/maps/${MAP_NAME}.md`]: crlf },
      pkg: { name: "fixture-project", private: true },
      prefix: "dobby-artifact-map-",
      track: scratchDirs,
    });
    const result = await run(["map", "claim", "auth-strategy"], root);
    const after = readMap(root);
    expect(result.exitCode).toBe(0);
    expect(after).toContain("Status: in-progress\r\n");
    // Same put-the-marker-back proof as above: the claim is the only difference.
    expect(after.replace("Status: in-progress", "Status: open")).toBe(crlf);
  });

  it("refuses to claim a slug the map does not have, naming it and leaving the map untouched", async () => {
    const root = makeMapRepo();
    const before = readMap(root);
    const result = await run(["map", "claim", "ghost-ticket"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("ghost-ticket");
    expect(readMap(root)).toBe(before);
  });
});

// ===========================================================================
// FIXTURES — a skill directory.
// ===========================================================================

const CLEAN_FRONTMATTER: readonly string[] = [
  "---",
  "name: sample-skill",
  "description: Do the sample thing end to end. Use when the user asks for a sample.",
  'argument-hint: "[thing]"',
  "---",
];

const CLEAN_SKILL_BODY: readonly string[] = [
  "",
  "Do the sample thing in two steps, then check the work.",
  "",
  "## Step 1: gather the inputs",
  "",
  "Read the caller's request and restate it.",
  "",
  "## Step 2: do the thing",
  "",
  "Load `references/detail.md` only when the caller needs the conditional flow.",
  "",
  "## Acceptance checklist",
  "",
  "- [ ] The inputs were restated",
  "- [ ] The sample thing was done",
  "",
];

const CLEAN_REFERENCE =
  "# Detail\n\nThe conditional flow, spelled out. It points at no other reference.\n";

function makeSkillRepo(
  opts: {
    body?: readonly string[];
    frontmatter?: readonly string[];
    resources?: Record<string, string>;
    withSkillFile?: boolean;
  } = {}
): { dir: string; root: string } {
  const files: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(
        opts.resources ?? { "references/detail.md": CLEAN_REFERENCE }
      ).map(([relPath, content]) => [
        `plugin/skills/sample/${relPath}`,
        content,
      ])
    ),
  };
  if (opts.withSkillFile !== false) {
    files["plugin/skills/sample/SKILL.md"] = [
      ...(opts.frontmatter ?? CLEAN_FRONTMATTER),
      ...(opts.body ?? CLEAN_SKILL_BODY),
    ].join("\n");
  }
  const root = makeScratchRepo({
    files,
    pkg: { name: "fixture-project", private: true },
    prefix: "dobby-artifact-skill-",
    track: scratchDirs,
  });
  return { dir: join(root, "plugin", "skills", "sample"), root };
}

// Frontmatter with ONE field replaced or added — INPUT only.
function frontmatterWith(...extra: string[]): readonly string[] {
  return [...CLEAN_FRONTMATTER.slice(0, -1), ...extra, "---"];
}

function frontmatterReplacing(field: string, line: string): readonly string[] {
  return CLEAN_FRONTMATTER.map((entry) =>
    entry.startsWith(`${field}:`) ? line : entry
  );
}

// ===========================================================================
// Slice 9 — `skill lint <dir>`: the frontmatter whitelist, the budgets, and the
// resource graph.
// ===========================================================================

describe("dobby skill lint — a well-formed skill", () => {
  it("reports ok and exits 0 for a skill whose frontmatter, budget and resources all check out", async () => {
    const { dir, root } = makeSkillRepo();
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("reports a directory with no SKILL.md", async () => {
    const { dir, root } = makeSkillRepo({ withSkillFile: false });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("SKILL.md");
  });
});

describe("dobby skill lint — frontmatter", () => {
  it("reports a field that is not a skill frontmatter field", async () => {
    const { dir, root } = makeSkillRepo({
      frontmatter: frontmatterWith("version: 1.0.0"),
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("version");
  });

  it("reports a name that is not kebab-case", async () => {
    const { dir, root } = makeSkillRepo({
      frontmatter: frontmatterReplacing("name", "name: Sample_Skill"),
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Sample_Skill");
  });

  it("reports a name containing `claude`", async () => {
    const { dir, root } = makeSkillRepo({
      frontmatter: frontmatterReplacing("name", "name: claude-helper"),
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("claude-helper");
  });

  it("reports a description longer than 1024 characters", async () => {
    const { dir, root } = makeSkillRepo({
      frontmatter: frontmatterReplacing(
        "description",
        `description: ${"Do the sample thing. ".repeat(60)}`
      ),
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_DESCRIPTION);
  });

  it("reports an effort outside the allowed values", async () => {
    const { dir, root } = makeSkillRepo({
      frontmatter: frontmatterWith("effort: turbo"),
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("turbo");
  });
});

describe("dobby skill lint — the craft rules", () => {
  it("reports a SKILL.md longer than 500 lines", async () => {
    const filler = Array.from(
      { length: 520 },
      (_unused, index) => `Line ${index + 1} of the overgrown body.`
    );
    const { dir, root } = makeSkillRepo({
      body: [
        "",
        ...filler,
        "",
        "## Acceptance checklist",
        "",
        "- [ ] The sample thing was done",
        "",
      ],
      resources: {},
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_LINES);
  });

  it("reports a skill that does not end with `## Acceptance checklist`", async () => {
    const { dir, root } = makeSkillRepo({
      body: [
        "",
        "Do the sample thing in one step.",
        "",
        "## Step 1: do the thing",
        "",
        "Load `references/detail.md` only when the caller needs the conditional flow.",
        "",
      ],
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_CHECKLIST);
  });

  it("reports a resource the body points at that is not on disk", async () => {
    const { dir, root } = makeSkillRepo({
      body: [
        "",
        "Do the sample thing.",
        "",
        "## Step 1: do the thing",
        "",
        "Load `references/missing.md` when the caller needs the conditional flow.",
        "",
        "## Acceptance checklist",
        "",
        "- [ ] The sample thing was done",
        "",
      ],
      resources: {},
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("missing.md");
  });

  it("reports a resource on disk the body never points at", async () => {
    const { dir, root } = makeSkillRepo({
      resources: {
        "references/detail.md": CLEAN_REFERENCE,
        "references/orphan.md": "# Orphan\n\nNobody loads this.\n",
      },
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("orphan.md");
  });

  it("reports a reference cited as a markdown link instead of inline code", async () => {
    const { dir, root } = makeSkillRepo({
      body: [
        "",
        "Do the sample thing.",
        "",
        "## Step 1: do the thing",
        "",
        "Load [the detail](references/detail.md) when the caller needs the conditional flow.",
        "",
        "## Acceptance checklist",
        "",
        "- [ ] The sample thing was done",
        "",
      ],
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_LINK);
  });

  it("does not read ANOTHER skill's resource path as one of its own", async () => {
    // `../other-skill/references/x.md` is a citation, not a pointer into this
    // directory: reading it as local turns every cross-skill link into a false
    // "does not exist".
    const { dir, root } = makeSkillRepo({
      body: [
        "",
        "Do the sample thing.",
        "",
        "## Step 1: do the thing",
        "",
        "Load `references/detail.md` for the conditional flow, and follow `../other-skill/references/trackers.md` when the caller wants the tracker rules.",
        "",
        "## Acceptance checklist",
        "",
        "- [ ] The sample thing was done",
        "",
      ],
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(0);
  });

  it("does not read a cross-skill citation INSIDE a reference as a second hop", async () => {
    const { dir, root } = makeSkillRepo({
      resources: {
        "references/detail.md":
          "# Detail\n\nThe conditional flow. The tracker rules live in `../other-skill/references/trackers.md`.\n",
      },
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(0);
  });

  it("reports a reference that points at another reference (resources are one level deep)", async () => {
    const { dir, root } = makeSkillRepo({
      body: [
        "",
        "Do the sample thing.",
        "",
        "## Step 1: do the thing",
        "",
        "Load `references/detail.md` and `references/deeper.md` when the caller needs the conditional flow.",
        "",
        "## Acceptance checklist",
        "",
        "- [ ] The sample thing was done",
        "",
      ],
      resources: {
        "references/deeper.md": "# Deeper\n\nThe second hop.\n",
        "references/detail.md":
          "# Detail\n\nFor the rest, read `references/deeper.md`.\n",
      },
    });
    const result = await run(["skill", "lint", dir], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_NESTED_REFERENCE);
  });
});
