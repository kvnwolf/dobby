import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitIn,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ---------------------------------------------------------------------------
// `dobby kb list|record` + `dobby adr new` — the two durable-artifact writers.
//
// Seam: the in-process `run(argv, cwd)` contract (ADR-0008). Every case builds a
// THROWAWAY real git repo with a fixture `docs/` tree and asserts the two things
// the skills observe: the process outcome (exit code / JSON payload) and the
// BYTES on disk. No module internals, no imports beyond the dispatcher and the
// shared test helpers.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - `CANONICAL_OUT_OF_SCOPE_FILE` is transcribed from the kit's OWN published KB
//    format — `plugin/skills/triage/references/out-of-scope-kb.md` ("File format":
//    H1, blank line, one-line statement, `## Why this is out of scope`, the reason,
//    `## Prior requests`, `- ` bullets) — with this fixture's values substituted.
//    The committed KB files (`docs/learn-discarded/*.md`) follow the same layout,
//    so two sources agree on it. It is a literal, never a re-derivation.
//  - The `DARK_MODE_RECORD` / `AUTO_OPEN_RECORD` list fixtures are lifted from the
//    worked examples in those same two references, so the parsed `title`,
//    `statement` and `priorEntries` are read off a document a human wrote, not off
//    anything the CLI produced.
//  - The two kind-specific heading strings, the two directories, the JSON shapes
//    (`[{concept, path, title, statement, priorEntries}]`, `{path, created,
//    appended}`, `{number, slug, path}`) and the numbering rule (`max + 1` over the
//    local dir AND `origin/HEAD:docs/adr`) are the task spec's own words.
//  - Every ADR number is hand-computed from the fixture filenames the test itself
//    writes (local max 16 + a remote-only 0017 → 18), and the title→slug pair
//    `"Single terminal host"` → `single-terminal-host` is the repo's own committed
//    `docs/adr/0010-single-terminal-host.md` naming.
//  - "unchanged" assertions compare against bytes captured BEFORE the second call,
//    i.e. against the input document, never against a recomputation.
//
// Why these are RED before the implementation: `runKb` / `runAdr` return
// `notImplemented` today, so every invocation exits 1 with `<command>: not
// implemented`, writes nothing, and prints no JSON.
//
// !! NOTE FOR THE IMPLEMENTOR — the flag allowlist (the ONE additive change in
// run.ts these tests need, exactly like task 9's `init: ["goal", "source"]`):
// the registry shipped by task 1 GUESSED the per-subcommand partition before this
// spec existed (STATE.md work log, task 1, finding 4: "kb `record` →
// concept/entry/file/rejected; adr `new` → title/slug/body-file … tasks 19/20
// should pin it"). The spec's surface is
//   kb record --kind <k> --concept <kebab> --title <t> --reason-file <f> --entry <l>
//   adr new <title> [--status proposed|accepted|deprecated]
// so the `record` token must allowlist `title` and `reason-file`, and the `new`
// token must allowlist `status`. All three are ALREADY declared as string options
// in run.ts's `parseArgs` table, so this is two array literals, nothing else —
// `validateInvocation` rejects the invocation with `unknown flag --title for
// \`dobby kb record\`` BEFORE the handler is reached otherwise. The ADR title is a
// POSITIONAL (`adr new "Single terminal host"`), per the spec's own notation, and
// needs no registry change at all.
// ---------------------------------------------------------------------------

// --- the two kinds ----------------------------------------------------------

const OUT_OF_SCOPE = "out-of-scope";
const LEARN_DISCARDED = "learn-discarded";

const KIND_DIR: Record<string, string> = {
  [LEARN_DISCARDED]: join("docs", LEARN_DISCARDED),
  [OUT_OF_SCOPE]: join("docs", OUT_OF_SCOPE),
};

// --- record fixtures --------------------------------------------------------

// The reason file `/dobby:triage` hands the CLI: its FIRST LINE is the one-line
// statement that sits under the H1, everything after it is the substantive reason.
const REASON_FILE_BODY = `Dobby does not create one worktree per machine.

The kit's invariant is ONE SESSION PER GOAL: goals run in PARALLEL worktrees, one
per cmux pane. Collapsing that onto a single worktree per machine would serialize
exactly the parallelism the pane-per-goal model exists to provide.
`;

const RECORD_TITLE = "One worktree per machine";
const RECORD_CONCEPT = "worktree-per-goal";
const RECORD_ENTRY = '#61 — "one worktree per machine, please"';
const SECOND_ENTRY = '#78 — "can we share one worktree across goals?"';

// The document `kb record` must write for a NEW out-of-scope concept, byte for
// byte. Layout transcribed from `plugin/skills/triage/references/out-of-scope-kb.md`
// (the "File format" block): H1, blank line, the one-line statement, a blank line
// before every `## ` heading and after it, `- ` bullets, single trailing newline.
const CANONICAL_OUT_OF_SCOPE_FILE = `# One worktree per machine

Dobby does not create one worktree per machine.

## Why this is out of scope

The kit's invariant is ONE SESSION PER GOAL: goals run in PARALLEL worktrees, one
per cmux pane. Collapsing that onto a single worktree per machine would serialize
exactly the parallelism the pane-per-goal model exists to provide.

## Prior requests

- #61 — "one worktree per machine, please"
`;

// --- list fixtures (hand-written documents, never CLI output) ---------------

// The worked example from `references/out-of-scope-kb.md`, trimmed. A record the
// CLI never wrote: `kb list` has to read what triage wrote by hand, too.
const DARK_MODE_RECORD = `# Dark Mode

This project does not support dark mode or user-facing theming.

## Why this is out of scope

The rendering pipeline assumes a single color palette defined in \`ThemeConfig\`.
Theming is a downstream concern for consumers who redistribute the output.

## Prior requests

- #42 — "Add dark mode support"
- #87 — "Night theme for accessibility"
`;

const PLUGIN_SYSTEM_RECORD = `# Plugin system

Third-party plugins are out of scope.

## Why this is out of scope

Every extension point is a compatibility promise this project will not make.

## Prior requests

- #134 — "Let me extend the pipeline"
`;

// A discarded friction in the style the COMMITTED files use
// (\`docs/learn-discarded/preset-opacity.md\`): bold inline markers rather than the
// record skeleton, one long first paragraph, three paragraphs before the section.
const AUTO_OPEN_RECORD = `# Auto-open the review report

**Friction** — a field session found the text proposal "hard to skim" and suggested \`/dobby:learn\` render an HTML summary and \`open\` it.

**Decision: discarded** (2026-06-11, \`/dobby:learn\` from the acme/billing session).

## Why this was NOT turned into a skill edit

\`learn\` runs where the maintainer is already reading the proposal inline before
approving edits — an auto-opened report adds a browser round-trip for zero
decision value.

## Prior occurrences

- 2026-05-02 session (repo acme/checkout) — "the learn proposal was a wall of text"
- 2026-06-11 session (repo acme/billing) — "can we get a visual summary?"
`;

// --- payload shapes (the spec's own field names) ----------------------------

interface KbEntry {
  concept: string;
  path: string;
  priorEntries: string[];
  statement: string;
  title: string;
}

interface KbRecordPayload {
  appended: boolean;
  created: boolean;
  path: string;
}

interface AdrPayload {
  number: number;
  path: string;
  slug: string;
}

// --- fixtures ---------------------------------------------------------------

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
});

function makeRepo(files: Record<string, string> = {}): string {
  return makeScratchRepo({
    files: Object.keys(files).length === 0 ? undefined : files,
    prefix: "dobby-kbadr-",
    track: scratchDirs,
  });
}

// A repo whose `origin/HEAD` tree carries ADRs the LOCAL snapshot does not: clone
// a seeded upstream, then `git rm` the remote's ADRs locally and commit. The
// remote-tracking ref still points at the seeded commit, which is exactly the
// cross-worktree situation (a sibling worktree's ADR is pushed but not here).
function makeRepoWithRemoteAdrs(
  remote: Record<string, string>,
  local: Record<string, string>
): string {
  const upstream = makeScratchRepo({
    files: remote,
    prefix: "dobby-kbadr-origin-",
    track: scratchDirs,
  });
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "dobby-kbadr-clone-"))
  );
  scratchDirs.push(parent);
  const clone = join(parent, "local");
  gitIn(parent, ["clone", "--quiet", upstream, clone]);
  for (const relPath of Object.keys(remote)) {
    gitIn(clone, ["rm", "-q", relPath]);
  }
  for (const [relPath, content] of Object.entries(local)) {
    writeRepoFile(clone, relPath, content);
  }
  gitIn(clone, ["add", "-A"]);
  gitIn(clone, ["commit", "-q", "-m", "local snapshot"]);
  return realpathSync(clone);
}

function writeRepoFile(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The reason file a `kb record` call points at, written inside the repo.
function writeReasonFile(root: string, content = REASON_FILE_BODY): string {
  const path = join(root, "reason.md");
  writeFileSync(path, content);
  return path;
}

// The `kb record` invocation, built in ONE place: the spec's flag surface lives
// here, so the whole suite moves together if the architect renames a flag.
function recordArgs(opts: {
  concept: string;
  entry: string;
  kind: string;
  reasonFile: string;
  title: string;
}): string[] {
  return [
    "kb",
    "record",
    "--kind",
    opts.kind,
    "--concept",
    opts.concept,
    "--title",
    opts.title,
    "--reason-file",
    opts.reasonFile,
    "--entry",
    opts.entry,
    "--json",
  ];
}

// --- readers (test-side, deliberately dumb) ---------------------------------

function kbPath(root: string, kind: string, concept: string): string {
  return join(root, KIND_DIR[kind] ?? "", `${concept}.md`);
}

function readDoc(path: string): string {
  return readFileSync(path, "utf8");
}

function listFiles(root: string, kind: string): string[] {
  const dir = join(root, KIND_DIR[kind] ?? "");
  return existsSync(dir) ? byName(readdirSync(dir)) : [];
}

// Directory/list order is not part of the contract, so every comparison sorts
// both sides by name first.
function byName(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Everything BEFORE the prior-section heading — the part an append must not touch.
function proseBefore(doc: string, heading: string): string {
  const index = doc.indexOf(heading);
  return index === -1 ? doc : doc.slice(0, index);
}

// ===========================================================================
// Slice 1 — `kb record` creates the first concept file.
//
// The first tracer bullet: `list` reads what `record` writes, and both KBs are
// the same module, so the created skeleton is the foundation of everything else.
// ===========================================================================

describe("dobby kb record — creating a concept file", () => {
  it("writes the canonical concept skeleton for a new out-of-scope concept", async () => {
    const root = makeRepo();
    const reasonFile = writeReasonFile(root);
    const result = await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile,
        title: RECORD_TITLE,
      }),
      root
    );
    expect(result.exitCode).toBe(0);
    expect(readDoc(kbPath(root, OUT_OF_SCOPE, RECORD_CONCEPT))).toBe(
      CANONICAL_OUT_OF_SCOPE_FILE
    );
  });

  it("creates the KB directory lazily, only when the first concept is recorded", async () => {
    const root = makeRepo();
    const reasonFile = writeReasonFile(root);
    expect(existsSync(join(root, KIND_DIR[OUT_OF_SCOPE] ?? ""))).toBe(false);
    await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile,
        title: RECORD_TITLE,
      }),
      root
    );
    expect(listFiles(root, OUT_OF_SCOPE)).toEqual(["worktree-per-goal.md"]);
  });

  it("answers with {path, created:true, appended:false} for a new concept", async () => {
    const root = makeRepo();
    const reasonFile = writeReasonFile(root);
    const result = await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile,
        title: RECORD_TITLE,
      }),
      root
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as KbRecordPayload;
    expect(payload).toMatchObject({
      appended: false,
      created: true,
      path: kbPath(root, OUT_OF_SCOPE, RECORD_CONCEPT),
    });
  });

  it("writes to the repo root's KB even when invoked from a subdirectory", async () => {
    const root = makeRepo();
    const reasonFile = writeReasonFile(root);
    const sub = join(root, "cli", "src");
    mkdirSync(sub, { recursive: true });
    const result = await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile,
        title: RECORD_TITLE,
      }),
      sub
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(kbPath(root, OUT_OF_SCOPE, RECORD_CONCEPT))).toBe(true);
  });
});

// ===========================================================================
// Slice 2 — `kb record` on an EXISTING concept appends, never duplicates.
//
// The KB's whole purpose is dedup by concept: a second rejection of the same
// concept must land as one more bullet in the one file, with the rationale that
// was written the first time left exactly as it was.
// ===========================================================================

describe("dobby kb record — appending to an existing concept", () => {
  async function recordTwice(root: string): Promise<string> {
    const reasonFile = writeReasonFile(root);
    await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile,
        title: RECORD_TITLE,
      }),
      root
    );
    // The skill does not know whether the concept exists, so the second call
    // carries a title and a reason of its own — which the existing record wins over.
    const otherReason = writeReasonFile(
      root,
      "A different statement.\n\nA different reason.\n"
    );
    const second = await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: SECOND_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile: otherReason,
        title: "Shared worktrees",
      }),
      root
    );
    return second.stdout;
  }

  it("keeps ONE file per concept", async () => {
    const root = makeRepo();
    await recordTwice(root);
    expect(listFiles(root, OUT_OF_SCOPE)).toEqual(["worktree-per-goal.md"]);
  });

  it("appends the new entry after the existing one under `## Prior requests`", async () => {
    const root = makeRepo();
    await recordTwice(root);
    const doc = readDoc(kbPath(root, OUT_OF_SCOPE, RECORD_CONCEPT));
    expect(doc).toContain(`- ${RECORD_ENTRY}\n- ${SECOND_ENTRY}`);
  });

  it("leaves the title, statement and reason of the existing record untouched", async () => {
    const root = makeRepo();
    await recordTwice(root);
    const doc = readDoc(kbPath(root, OUT_OF_SCOPE, RECORD_CONCEPT));
    expect(proseBefore(doc, "## Prior requests")).toBe(
      proseBefore(CANONICAL_OUT_OF_SCOPE_FILE, "## Prior requests")
    );
  });

  it("answers with {created:false, appended:true} for an existing concept", async () => {
    const root = makeRepo();
    const stdout = await recordTwice(root);
    const payload = JSON.parse(stdout) as KbRecordPayload;
    expect(payload).toMatchObject({
      appended: true,
      created: false,
      path: kbPath(root, OUT_OF_SCOPE, RECORD_CONCEPT),
    });
  });
});

// ===========================================================================
// Slice 3 — the two kinds are ONE engine. `learn-discarded` differs from
// `out-of-scope` in its directory and its two heading strings, and in NOTHING
// else — the property the single parameterized module exists to hold.
// ===========================================================================

describe("dobby kb record — the second kind", () => {
  async function recordInto(kind: string): Promise<string> {
    const root = makeRepo();
    const reasonFile = writeReasonFile(root);
    await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind,
        reasonFile,
        title: RECORD_TITLE,
      }),
      root
    );
    return readDoc(kbPath(root, kind, RECORD_CONCEPT));
  }

  it("records a discarded friction under docs/learn-discarded/ with the learn headings", async () => {
    const doc = await recordInto(LEARN_DISCARDED);
    expect(doc).toContain("## Why this was NOT turned into a skill edit");
    expect(doc).toContain("## Prior occurrences");
  });

  it("produces a document identical to the out-of-scope one but for the two headings", async () => {
    const discarded = await recordInto(LEARN_DISCARDED);
    const rejected = await recordInto(OUT_OF_SCOPE);
    expect(
      discarded
        .replace(
          "## Why this was NOT turned into a skill edit",
          "## Why this is out of scope"
        )
        .replace("## Prior occurrences", "## Prior requests")
    ).toBe(rejected);
  });

  it("keeps the two KBs separate: an out-of-scope record is not a discarded friction", async () => {
    const root = makeRepo();
    const reasonFile = writeReasonFile(root);
    await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile,
        title: RECORD_TITLE,
      }),
      root
    );
    const result = await run(
      ["kb", "list", "--kind", LEARN_DISCARDED, "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout) as KbEntry[]).toEqual([]);
  });
});

// ===========================================================================
// Slice 4 — `kb list`: the dedup scan every triage / learn session opens with.
// ===========================================================================

describe("dobby kb list — scanning a knowledge base", () => {
  it("answers with an empty list when the KB directory does not exist", async () => {
    const root = makeRepo();
    const result = await run(
      ["kb", "list", "--kind", OUT_OF_SCOPE, "--json"],
      root
    );
    // Absence is the normal state of a lazily created KB — never an error.
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout) as KbEntry[]).toEqual([]);
  });

  it("describes each record by concept, path, title, statement and prior entries", async () => {
    const root = makeRepo({
      "docs/out-of-scope/dark-mode.md": DARK_MODE_RECORD,
    });
    const result = await run(
      ["kb", "list", "--kind", OUT_OF_SCOPE, "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout) as KbEntry[];
    expect(entries).toEqual([
      {
        concept: "dark-mode",
        path: kbPath(root, OUT_OF_SCOPE, "dark-mode"),
        priorEntries: [
          '#42 — "Add dark mode support"',
          '#87 — "Night theme for accessibility"',
        ],
        statement:
          "This project does not support dark mode or user-facing theming.",
        title: "Dark Mode",
      },
    ]);
  });

  it("lists every concept file in the directory", async () => {
    const root = makeRepo({
      "docs/out-of-scope/dark-mode.md": DARK_MODE_RECORD,
      "docs/out-of-scope/plugin-system.md": PLUGIN_SYSTEM_RECORD,
    });
    const result = await run(
      ["kb", "list", "--kind", OUT_OF_SCOPE, "--json"],
      root
    );
    const entries = JSON.parse(result.stdout) as KbEntry[];
    expect(byName(entries.map((entry) => entry.concept))).toEqual([
      "dark-mode",
      "plugin-system",
    ]);
  });

  it("reads a hand-written record whose prose does not follow the skeleton", async () => {
    const root = makeRepo({
      "docs/learn-discarded/auto-open-report.md": AUTO_OPEN_RECORD,
    });
    const result = await run(
      ["kb", "list", "--kind", LEARN_DISCARDED, "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    const [entry] = JSON.parse(result.stdout) as KbEntry[];
    expect(entry).toEqual({
      concept: "auto-open-report",
      path: kbPath(root, LEARN_DISCARDED, "auto-open-report"),
      priorEntries: [
        '2026-05-02 session (repo acme/checkout) — "the learn proposal was a wall of text"',
        '2026-06-11 session (repo acme/billing) — "can we get a visual summary?"',
      ],
      statement:
        '**Friction** — a field session found the text proposal "hard to skim" and suggested `/dobby:learn` render an HTML summary and `open` it.',
      title: "Auto-open the review report",
    });
  });

  it("round-trips a recorded concept: list reports back what record wrote", async () => {
    const root = makeRepo();
    const reasonFile = writeReasonFile(root);
    await run(
      recordArgs({
        concept: RECORD_CONCEPT,
        entry: RECORD_ENTRY,
        kind: OUT_OF_SCOPE,
        reasonFile,
        title: RECORD_TITLE,
      }),
      root
    );
    const result = await run(
      ["kb", "list", "--kind", OUT_OF_SCOPE, "--json"],
      root
    );
    const [entry] = JSON.parse(result.stdout) as KbEntry[];
    expect(entry).toEqual({
      concept: RECORD_CONCEPT,
      path: kbPath(root, OUT_OF_SCOPE, RECORD_CONCEPT),
      priorEntries: [RECORD_ENTRY],
      statement: "Dobby does not create one worktree per machine.",
      title: RECORD_TITLE,
    });
  });

  it("rejects a kind that is neither KB, naming the valid ones", async () => {
    const root = makeRepo({
      "docs/out-of-scope/dark-mode.md": DARK_MODE_RECORD,
    });
    const result = await run(
      ["kb", "list", "--kind", "frobnicate", "--json"],
      root
    );
    // A typo'd kind must never read as "that KB is empty" — dedup would silently
    // stop working and every rejected concept would be re-litigated.
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(OUT_OF_SCOPE);
    expect(`${result.stdout}\n${result.stderr}`).toContain(LEARN_DISCARDED);
  });
});

// ===========================================================================
// Slice 5 — `adr new`: allocate the next number and create the file.
// ===========================================================================

describe("dobby adr new — numbering and creation", () => {
  it("allocates the number after the highest ADR in docs/adr", async () => {
    const root = makeRepo({
      "docs/adr/0001-conductor-execution-host.md": "# 1\n",
      "docs/adr/0007-monorepo-two-surfaces.md": "# 7\n",
      "docs/adr/0016-remove-ngrok-share-tunnel.md": "# 16\n",
    });
    const result = await run(
      ["adr", "new", "Single terminal host", "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as AdrPayload;
    expect(payload).toEqual({
      number: 17,
      path: join(root, "docs", "adr", "0017-single-terminal-host.md"),
      slug: "single-terminal-host",
    });
  });

  it("creates docs/adr lazily and numbers the first ADR 0001", async () => {
    const root = makeRepo();
    const result = await run(
      ["adr", "new", "Zero framework portable CLI", "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as AdrPayload;
    expect(payload.number).toBe(1);
    expect(
      existsSync(join(root, "docs/adr/0001-zero-framework-portable-cli.md"))
    ).toBe(true);
  });

  it("writes a skeleton titled `# NNNN. <title>` with a placeholder body", async () => {
    const root = makeRepo({
      "docs/adr/0016-remove-ngrok-share-tunnel.md": "# 16\n",
    });
    const result = await run(
      ["adr", "new", "Single terminal host", "--json"],
      root
    );
    const payload = JSON.parse(result.stdout) as AdrPayload;
    const lines = readDoc(payload.path).split("\n");
    expect(lines[0]).toBe("# 0017. Single terminal host");
    // Body authorship stays with the architect, but the file must not be an empty
    // stub either: the skeleton carries placeholder prose to replace.
    const prose = lines
      .slice(1)
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(prose.length).toBeGreaterThan(0);
  });

  it("records the requested status", async () => {
    const root = makeRepo({
      "docs/adr/0003-docs-durable-artifacts.md": "# 3\n",
    });
    const result = await run(
      ["adr", "new", "Single terminal host", "--status", "accepted", "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as AdrPayload;
    expect(readDoc(payload.path)).toMatch(/status[^\n]*accepted/i);
  });

  it("rejects a status outside proposed|accepted|deprecated, creating no file", async () => {
    const root = makeRepo({
      "docs/adr/0003-docs-durable-artifacts.md": "# 3\n",
    });
    const result = await run(
      [
        "adr",
        "new",
        "Single terminal host",
        "--status",
        "frobnicate",
        "--json",
      ],
      root
    );
    expect(result.exitCode).toBe(1);
    // The refusal names what IS valid — a rejected status the caller cannot see
    // the alternatives to is a dead end for the skill that typed it.
    expect(result.stderr).toContain("proposed");
    expect(readdirSync(join(root, "docs", "adr"))).toEqual([
      "0003-docs-durable-artifacts.md",
    ]);
  });

  it("requires a title", async () => {
    const root = makeRepo();
    const result = await run(["adr", "new", "--json"], root);
    expect(result.exitCode).toBe(1);
    // An ADR filed as `NNNN-undefined.md` is the failure this guard prevents, so
    // the refusal names the missing input rather than "something went wrong".
    expect(result.stderr).toMatch(/title/i);
    expect(existsSync(join(root, "docs", "adr"))).toBe(false);
  });
});

// ===========================================================================
// Slice 6 — `adr new` never reuses a number. The local directory is only HALF
// the picture: a sibling worktree's ADR is pushed before it ever lands here.
// ===========================================================================

describe("dobby adr new — collision safety", () => {
  it("counts ADRs that exist only on origin/HEAD", async () => {
    // Local max is 0016; origin/HEAD carries a 0017 a sibling worktree pushed and
    // this checkout has never seen. max(16, 17) + 1 = 18.
    const root = makeRepoWithRemoteAdrs(
      { "docs/adr/0017-cross-worktree-numbering.md": "# 17\n" },
      { "docs/adr/0016-remove-ngrok-share-tunnel.md": "# 16\n" }
    );
    const result = await run(
      ["adr", "new", "Single terminal host", "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as AdrPayload;
    expect(payload.number).toBe(18);
    expect(payload.path).toBe(
      join(root, "docs", "adr", "0018-single-terminal-host.md")
    );
  });

  it("works in a repository that has no origin at all", async () => {
    const root = makeRepo({
      "docs/adr/0003-docs-durable-artifacts.md": "# 3\n",
    });
    const result = await run(
      ["adr", "new", "Single terminal host", "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as AdrPayload).number).toBe(4);
  });

  it("never overwrites an ADR: a second call with the same title takes the next number", async () => {
    const root = makeRepo({
      "docs/adr/0016-remove-ngrok-share-tunnel.md": "# 16\n",
    });
    const first = await run(
      ["adr", "new", "Single terminal host", "--json"],
      root
    );
    const firstPayload = JSON.parse(first.stdout) as AdrPayload;
    const firstDoc = readDoc(firstPayload.path);
    const second = await run(
      ["adr", "new", "Single terminal host", "--json"],
      root
    );
    const secondPayload = JSON.parse(second.stdout) as AdrPayload;
    expect(secondPayload.number).toBe(18);
    expect(readDoc(firstPayload.path)).toBe(firstDoc);
  });

  it("ignores files in docs/adr that carry no NNNN prefix", async () => {
    const root = makeRepo({
      "docs/adr/0004-session-level-model-effort.md": "# 4\n",
      "docs/adr/README.md": "# ADRs live here\n",
      "docs/adr/template.md": "# {Short title of the decision}\n",
    });
    const result = await run(
      ["adr", "new", "Single terminal host", "--json"],
      root
    );
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as AdrPayload).number).toBe(5);
  });
});
