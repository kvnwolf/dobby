import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";

// ---------------------------------------------------------------------------
// `dobby state init|set|append-worklog|lint` — the STATE.md section engine.
//
// Seam: the in-process `run(argv, cwd, stdin)` contract (ADR-0008 + the spec's
// Testing Decisions: "no other new seams"). Every case builds a THROWAWAY real
// git repo (mkdtempSync + `git init`, pinned gitEnv) and asserts the two things
// the skills observe: the process outcome (exit code / JSON payload) and the
// bytes on disk. No internals, no module imports beyond the dispatcher.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - CANONICAL_SKELETON is the skeleton written out in `plugin/skills/scope`
//    Step 3 — the spec's ONE source for `state init` (Decision 14, and task 25's
//    "scope skeleton == `state init` output byte-for-byte") — with the two flag
//    values substituted. It is a literal, not a re-derivation.
//  - The seven canonical section names, their ORDER, and `_pending_` as the
//    replace-marker are the task spec's own enumeration.
//  - `### Task <id>`, the H2→H3 demotion, `## Spec` re-settable, `## Goal` /
//    `## Source` write-once, `## Work log` never settable, unknown sections
//    preserved: Decision 14 + research default O4, stated verbatim.
//  - Every "preserved" assertion compares against the fixture text WE wrote onto
//    disk — the input document, never a recomputation of what the engine does.
//  - `{ok, path, action}` is the spec's stated JSON shape; `path` is the repo
//    root we created joined with STATE.md.
//
// Why these are RED before the implementation: `runState` returns
// `notImplemented` today, so every subcommand exits 1 with `state: not
// implemented` and touches no file.
// ---------------------------------------------------------------------------

// The canonical section set, in the spec's exact order.
const CANONICAL_SECTIONS = [
  "Goal",
  "Source",
  "Exploration",
  "Findings (interview)",
  "Research",
  "Spec",
  "Work log",
];

// The canonical skeleton `state init --goal "Mechanize the kit" --source prompt`
// must produce, byte for byte: the H1 carrying the goal title, the seven sections
// in order, one blank line between sections, no blank line under a heading,
// `_pending_` everywhere except the two flag-filled bodies, single trailing
// newline. Transcribed from plugin/skills/scope/SKILL.md Step 3.
const CANONICAL_SKELETON = `# Work session: Mechanize the kit

## Goal
Mechanize the kit

## Source
prompt

## Exploration
_pending_

## Findings (interview)
_pending_

## Research
_pending_

## Spec
_pending_

## Work log
_pending_
`;

// A hand-written STATE.md that is structurally valid AND carries an UNKNOWN
// `## Environment` section — the one scope writes for a degraded bring-up
// (Decision 14: "Environment note gets `## Environment`"; unknown sections are
// preserved). Goal/Source are FILLED, so they are past their write-once window.
const DOC_WITH_ENVIRONMENT = `# Work session: preserve everything

## Goal
ship the state engine

## Source
prompt

## Exploration
mapped the CLI surface

## Findings (interview)
twenty decisions, all approved

## Research
six researcher reports

## Environment
degraded bring-up: no browser pane

## Spec
_pending_

## Work log
_pending_
`;

// --- fixtures ---------------------------------------------------------------

const scratchDirs: string[] = [];

// Isolate repo creation from ambient git config (signing, hooks, templates).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "test@dobby.invalid",
  GIT_AUTHOR_NAME: "dobby-test",
  GIT_COMMITTER_EMAIL: "test@dobby.invalid",
  GIT_COMMITTER_NAME: "dobby-test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

// A throwaway git repo (realpath-normalized to match `git rev-parse
// --show-toplevel`), optionally pre-seeded with a STATE.md and/or a .gitignore.
function makeStateRepo(
  opts: { gitignore?: string; state?: string } = {}
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-state-")));
  scratchDirs.push(dir);
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
  if (opts.gitignore !== undefined) {
    writeFileSync(join(dir, ".gitignore"), opts.gitignore);
  }
  if (opts.state !== undefined) {
    writeFileSync(join(dir, "STATE.md"), opts.state);
  }
  return dir;
}

// A directory that is NOT a git repo — the hard-fail case for every subcommand.
function makeNonGitDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-state-nogit-")));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// --- readers (test-side, deliberately dumb) ---------------------------------

function readState(root: string): string {
  return readFileSync(join(root, "STATE.md"), "utf8");
}

// Every `## ` heading in the document, in order, without the marker — the
// structural fingerprint an append must never disturb.
function h2Headings(doc: string): string[] {
  return doc
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

// The body of one `## ` section: everything up to the next `## ` heading (or the
// end of the document), trimmed — inter-section blank lines are pinned by the
// byte-exact skeleton test, not by every body assertion.
function sectionBody(doc: string, heading: string): string {
  const lines = doc.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) {
    throw new Error(`section not found: ## ${heading}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

// A lint-fixture document: the given headings in the given order, each with a
// `_pending_` body. Builds INPUT, never an expected value.
function docFrom(
  headings: string[],
  h1: string | null = "# Work session: lint fixture"
): string {
  const body = headings.map((name) => `## ${name}\n_pending_`).join("\n\n");
  return h1 === null ? `${body}\n` : `${h1}\n\n${body}\n`;
}

// Both channels of a report: the spec fixes exit codes and the violation TEXT,
// not which stream carries it.
function reportOf(result: { stderr: string; stdout: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

// ===========================================================================
// Slice 1 — `state init` writes the canonical skeleton.
//
// The first tracer bullet: every other subcommand reads the document this one
// writes, so the skeleton is the foundation of the whole engine.
// ===========================================================================

describe("dobby state init — the canonical skeleton", () => {
  // NOTE for the implementor: the registry entry shipped by task 1 declares
  // `init: []`, so `--goal` / `--source` are currently rejected by the flag
  // allowlist before the handler is reached. The task spec names them as init's
  // surface (`state init [--goal <s>] [--source <s>]`), which is how
  // `/dobby:scope` will fill Goal and Source — so the `init` token must
  // allowlist `["goal", "source"]`. That is the ONE additive line this task
  // needs in run.ts.
  it("creates STATE.md at the workroot with the canonical skeleton, filling Goal and Source from the flags", async () => {
    const root = makeStateRepo();
    const result = await run(
      ["state", "init", "--goal", "Mechanize the kit", "--source", "prompt"],
      root
    );
    expect(result.exitCode).toBe(0);
    expect(readState(root)).toBe(CANONICAL_SKELETON);
  });

  it("leaves every section body `_pending_` when no goal or source is given", async () => {
    const root = makeStateRepo();
    const result = await run(["state", "init"], root);
    const doc = readState(root);
    expect(result.exitCode).toBe(0);
    expect(doc.startsWith("# Work session:")).toBe(true);
    expect(h2Headings(doc)).toEqual(CANONICAL_SECTIONS);
    for (const name of CANONICAL_SECTIONS) {
      expect(sectionBody(doc, name)).toBe("_pending_");
    }
  });

  it("writes STATE.md at the repo root even when invoked from a subdirectory", async () => {
    const root = makeStateRepo();
    const sub = join(root, "cli", "src");
    mkdirSync(sub, { recursive: true });
    const result = await run(["state", "init"], sub);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "STATE.md"))).toBe(true);
    expect(existsSync(join(sub, "STATE.md"))).toBe(false);
  });
});

// ===========================================================================
// Slice 2 — init's two side contracts: the gitignore entry it OWNS (drift D6:
// the skill no longer does it by hand) and its refusal to clobber a session.
// ===========================================================================

describe("dobby state init — gitignore and refusal", () => {
  it("adds STATE.md to .gitignore when the repo has none", async () => {
    const root = makeStateRepo();
    await run(["state", "init"], root);
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignore.split("\n")).toContain("STATE.md");
  });

  it("appends STATE.md to an existing .gitignore, keeping what was there", async () => {
    const root = makeStateRepo({ gitignore: "node_modules/\n*.local*\n" });
    await run(["state", "init"], root);
    const lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
    expect(lines).toContain("node_modules/");
    expect(lines).toContain("*.local*");
    expect(lines).toContain("STATE.md");
  });

  it("does not duplicate an existing STATE.md gitignore entry", async () => {
    const root = makeStateRepo({ gitignore: "STATE.md\nnode_modules/\n" });
    const result = await run(["state", "init"], root);
    const lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
    expect(result.exitCode).toBe(0);
    expect(lines.filter((line) => line === "STATE.md")).toHaveLength(1);
  });

  it("refuses to overwrite an existing STATE.md, leaving it byte-for-byte intact", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(["state", "init"], root);
    expect(result.exitCode).toBe(1);
    // The refusal names the file it declined to touch — a session's work is on
    // the line, so "something went wrong" is not an acceptable message.
    expect(result.stderr).toContain("STATE.md");
    expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
  });
});

// ===========================================================================
// Slice 3 — `state set` replaces ONE body and leaves the rest alone.
//
// The stage skills (interview/research/spec) all land here, so "everything else
// survives, including sections the CLI has never heard of" is the load-bearing
// claim.
// ===========================================================================

describe("dobby state set — replacing a section body", () => {
  it("replaces the named section's body with the piped input", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "set", "Spec", "--stdin"],
      root,
      "one task: the state engine"
    );
    expect(result.exitCode).toBe(0);
    expect(sectionBody(readState(root), "Spec")).toBe(
      "one task: the state engine"
    );
  });

  it("preserves every other section, including an unknown `## Environment`", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(["state", "set", "Spec", "--stdin"], root, "the spec body");
    const doc = readState(root);
    expect(sectionBody(doc, "Spec")).toBe("the spec body");
    expect(doc).toContain("## Environment\ndegraded bring-up: no browser pane");
    expect(doc).toContain("## Goal\nship the state engine");
    expect(doc).toContain("## Research\nsix researcher reports");
    expect(doc).toContain("## Work log\n_pending_");
    expect(h2Headings(doc)).toEqual([
      "Goal",
      "Source",
      "Exploration",
      "Findings (interview)",
      "Research",
      "Environment",
      "Spec",
      "Work log",
    ]);
  });

  it("changes nothing in the document but the named section's body", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(["state", "set", "Spec", "--stdin"], root, "the spec body");
    const doc = readState(root);
    expect(doc).toContain("the spec body");
    // Putting the marker back must restore the fixture EXACTLY: the body swap is
    // the only difference the write is allowed to make.
    expect(doc.replace("the spec body", "_pending_")).toBe(
      DOC_WITH_ENVIRONMENT
    );
  });

  it("keeps one blank line before the next heading when the input ends with a newline", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(["state", "set", "Spec", "--stdin"], root, "the spec body\n");
    expect(readState(root)).toContain(
      "## Spec\nthe spec body\n\n## Work log\n_pending_"
    );
  });

  it("reads the body from --file", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const bodyFile = join(root, "spec-body.md");
    writeFileSync(bodyFile, "### Overview\nthe spec, from a file\n");
    const result = await run(
      ["state", "set", "Spec", "--file", bodyFile],
      root
    );
    expect(result.exitCode).toBe(0);
    expect(sectionBody(readState(root), "Spec")).toBe(
      "### Overview\nthe spec, from a file"
    );
  });

  it("is idempotent: setting the same body twice leaves the file unchanged", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(["state", "set", "Spec", "--stdin"], root, "the spec body");
    const afterFirst = readState(root);
    const second = await run(
      ["state", "set", "Spec", "--stdin"],
      root,
      "the spec body"
    );
    expect(second.exitCode).toBe(0);
    expect(readState(root)).toBe(afterFirst);
  });

  it("re-sets `## Spec`: a second set with different content wins", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(["state", "set", "Spec", "--stdin"], root, "the first spec");
    const result = await run(
      ["state", "set", "Spec", "--stdin"],
      root,
      "the revised spec"
    );
    const doc = readState(root);
    expect(result.exitCode).toBe(0);
    expect(sectionBody(doc, "Spec")).toBe("the revised spec");
    expect(doc).not.toContain("the first spec");
  });

  it("sets a section that is not canonical but exists in the file (`## Environment`)", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "set", "Environment", "--stdin"],
      root,
      "cmux panes restored"
    );
    expect(result.exitCode).toBe(0);
    expect(sectionBody(readState(root), "Environment")).toBe(
      "cmux panes restored"
    );
  });

  it("sets a multi-word canonical section (`Findings (interview)`)", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "set", "Findings (interview)", "--stdin"],
      root,
      "1. one session, one PR"
    );
    expect(result.exitCode).toBe(0);
    expect(sectionBody(readState(root), "Findings (interview)")).toBe(
      "1. one session, one PR"
    );
  });
});

// ===========================================================================
// Slice 4 — the write guards. Each refusal must leave the document untouched:
// a guard that half-writes is worse than no guard.
// ===========================================================================

describe("dobby state set — write guards", () => {
  it.each(["Goal", "Source"])(
    "refuses to set `## %s` once it carries a value (write-once)",
    async (section) => {
      const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
      const result = await run(
        ["state", "set", section, "--stdin"],
        root,
        "a rewritten goal"
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(section);
      expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
    }
  );

  it("allows setting `## Goal` while its body is still `_pending_`", async () => {
    const root = makeStateRepo();
    await run(["state", "init"], root);
    const result = await run(
      ["state", "set", "Goal", "--stdin"],
      root,
      "mechanize the kit"
    );
    expect(result.exitCode).toBe(0);
    expect(sectionBody(readState(root), "Goal")).toBe("mechanize the kit");
  });

  it("never sets `## Work log`, directing the caller to append-worklog", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "set", "Work log", "--stdin"],
      root,
      "### Task 1 — done"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("append-worklog");
    expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
  });

  it("rejects a section that is neither canonical nor present, naming the valid set", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "set", "Frobnicate", "--stdin"],
      root,
      "nope"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Frobnicate");
    for (const name of CANONICAL_SECTIONS) {
      expect(result.stderr).toContain(name);
    }
    expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
  });

  it("requires an input source (neither --file nor --stdin given)", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(["state", "set", "Spec"], root);
    expect(result.exitCode).toBe(1);
    // The message points at the missing input, not at "something went wrong".
    expect(result.stderr).toMatch(/--file|--stdin/);
    expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
  });

  it("reports a clear error when there is no STATE.md to set into", async () => {
    const root = makeStateRepo();
    const result = await run(["state", "set", "Spec", "--stdin"], root, "body");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("STATE.md");
    expect(existsSync(join(root, "STATE.md"))).toBe(false);
  });
});

// ===========================================================================
// Slice 5 — `state append-worklog`. The architect appends one entry per task,
// serially; the D4 trap is an entry carrying its own `## ` heading, which would
// SPLIT the section and orphan everything after it.
// ===========================================================================

describe("dobby state append-worklog — appending entries", () => {
  it("replaces the `_pending_` body with the first entry, titled `### Task <id>`", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "append-worklog", "--task", "3", "--stdin"],
      root,
      "shipped the ship command; gate cache written"
    );
    const body = sectionBody(readState(root), "Work log");
    expect(result.exitCode).toBe(0);
    expect(body).toContain("### Task 3");
    expect(body).toContain("shipped the ship command; gate cache written");
    expect(body).not.toContain("_pending_");
  });

  it("leaves the other sections untouched", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(
      ["state", "append-worklog", "--task", "3", "--stdin"],
      root,
      "an entry"
    );
    const doc = readState(root);
    expect(sectionBody(doc, "Work log")).toContain("an entry");
    expect(doc).toContain("## Environment\ndegraded bring-up: no browser pane");
    expect(sectionBody(doc, "Spec")).toBe("_pending_");
    expect(sectionBody(doc, "Goal")).toBe("ship the state engine");
  });

  it("demotes an H2 inside the entry to an H3", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(
      ["state", "append-worklog", "--task", "4", "--stdin"],
      root,
      "## Decisions\nkept the registry table"
    );
    const doc = readState(root);
    const lines = doc.split("\n");
    expect(lines).toContain("### Decisions");
    expect(lines).toContain("kept the registry table");
    // LINE-structural, never a substring check: `### Decisions` CONTAINS the
    // string `## Decisions`, so the only statable invariant is that no LINE is
    // the H2 — i.e. the entry introduced no new section heading.
    expect(lines).not.toContain("## Decisions");
    expect(h2Headings(doc)).not.toContain("Decisions");
  });

  it("keeps the document's H2 structure when the entry leads with its own `## Work log` heading", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "append-worklog", "--task", "5", "--stdin"],
      root,
      "## Work log\nthe implementor pasted the whole section"
    );
    const doc = readState(root);
    expect(result.exitCode).toBe(0);
    // The one invariant the demotion exists for: an entry can never introduce a
    // new H2, so the section list is exactly what it was before the append.
    expect(h2Headings(doc)).toEqual([
      "Goal",
      "Source",
      "Exploration",
      "Findings (interview)",
      "Research",
      "Environment",
      "Spec",
      "Work log",
    ]);
    expect(sectionBody(doc, "Work log")).toContain(
      "the implementor pasted the whole section"
    );
  });

  it("appends a second entry after the first, keeping both in order", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    await run(
      ["state", "append-worklog", "--task", "3", "--stdin"],
      root,
      "the first entry"
    );
    await run(
      ["state", "append-worklog", "--task", "4", "--stdin"],
      root,
      "the second entry"
    );
    const body = sectionBody(readState(root), "Work log");
    expect(body).toContain("### Task 3");
    expect(body).toContain("### Task 4");
    expect(body.indexOf("the first entry")).toBeLessThan(
      body.indexOf("the second entry")
    );
  });

  it("requires --task", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "append-worklog", "--stdin"],
      root,
      "an entry with no task id"
    );
    expect(result.exitCode).toBe(1);
    // An entry titled `### Task undefined` is the failure this guard prevents,
    // so the message names the flag that was missing.
    expect(result.stderr).toContain("--task");
    expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
  });
});

// ===========================================================================
// Slice 6 — `state lint`: the structural gate the stage skills run before they
// trust the document (and the drift detector D1-D7 were found by, by hand).
// ===========================================================================

describe("dobby state lint — structural checks", () => {
  it("passes a freshly initialized STATE.md", async () => {
    const root = makeStateRepo();
    await run(["state", "init"], root);
    const result = await run(["state", "lint"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("passes a document carrying an extra unknown section", async () => {
    const root = makeStateRepo({
      gitignore: "STATE.md\n",
      state: DOC_WITH_ENVIRONMENT,
    });
    const result = await run(["state", "lint"], root);
    expect(result.exitCode).toBe(0);
  });

  it("reports a missing canonical section, naming it", async () => {
    const root = makeStateRepo({
      gitignore: "STATE.md\n",
      state: docFrom(CANONICAL_SECTIONS.filter((name) => name !== "Research")),
    });
    const result = await run(["state", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Research");
  });

  it("reports canonical sections that are out of order", async () => {
    const root = makeStateRepo({
      gitignore: "STATE.md\n",
      state: docFrom([
        "Goal",
        "Source",
        "Research",
        "Exploration",
        "Findings (interview)",
        "Spec",
        "Work log",
      ]),
    });
    const result = await run(["state", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Research");
  });

  it("reports a duplicated section", async () => {
    const root = makeStateRepo({
      gitignore: "STATE.md\n",
      state: docFrom([...CANONICAL_SECTIONS, "Spec"]),
    });
    const result = await run(["state", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("Spec");
  });

  it("reports a missing H1", async () => {
    // The ONLY defect here is the absent title line, so a lint that skipped the
    // H1 check would answer ok:true. Asserted through the payload rather than the
    // prose: the spec fixes the verdict, not the wording of this violation.
    const root = makeStateRepo({
      gitignore: "STATE.md\n",
      state: docFrom(CANONICAL_SECTIONS, null),
    });
    const result = await run(["state", "lint", "--json"], root);
    const payload = JSON.parse(result.stdout) as { ok?: unknown };
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
  });

  it("reports STATE.md not being gitignored", async () => {
    const root = makeStateRepo({
      gitignore: "node_modules/\n",
      state: docFrom(CANONICAL_SECTIONS),
    });
    const result = await run(["state", "lint"], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(/gitignore/i);
  });
});

// ===========================================================================
// Slice 7 — the machine surface: the `--json` payload the skills read, and the
// hard failure every action command shares outside a git repo.
// ===========================================================================

describe("dobby state — machine surface", () => {
  it("answers `init --json` with {ok, path, action} as the only stdout", async () => {
    const root = makeStateRepo();
    const result = await run(["state", "init", "--json"], root);
    const payload = JSON.parse(result.stdout) as {
      action?: unknown;
      ok?: unknown;
      path?: unknown;
    };
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.path).toBe(join(root, "STATE.md"));
    expect(payload.action).toBe("init");
  });

  it("answers `set --json` with {ok, path, action} as the only stdout", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "set", "Spec", "--stdin", "--json"],
      root,
      "the spec body"
    );
    const payload = JSON.parse(result.stdout) as {
      action?: unknown;
      ok?: unknown;
      path?: unknown;
    };
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.path).toBe(join(root, "STATE.md"));
    expect(payload.action).toBe("set");
    // The write really happened — a payload alone would be satisfied by a
    // command that answers ok and touches nothing.
    expect(sectionBody(readState(root), "Spec")).toBe("the spec body");
  });

  it("answers a refused `set --json` with ok:false, exit 1 and an untouched document", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "set", "Work log", "--stdin", "--json"],
      root,
      "### Task 1 — done"
    );
    const payload = JSON.parse(result.stdout) as { ok?: unknown };
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    // A refusal still names its subject, on the machine surface as on stderr.
    expect(JSON.stringify(payload)).toContain("append-worklog");
    expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
  });

  it("answers `append-worklog --json` with {ok, path, action} as the only stdout", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "append-worklog", "--task", "7", "--stdin", "--json"],
      root,
      "the seventh entry"
    );
    const payload = JSON.parse(result.stdout) as {
      action?: unknown;
      ok?: unknown;
      path?: unknown;
    };
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.path).toBe(join(root, "STATE.md"));
    expect(payload.action).toBe("append-worklog");
    expect(sectionBody(readState(root), "Work log")).toContain(
      "the seventh entry"
    );
  });

  it("answers a refused `append-worklog --json` with ok:false, exit 1 and an untouched document", async () => {
    const root = makeStateRepo({ state: DOC_WITH_ENVIRONMENT });
    const result = await run(
      ["state", "append-worklog", "--task", "7", "--json"],
      root
    );
    const payload = JSON.parse(result.stdout) as { ok?: unknown };
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload)).toMatch(/--file|--stdin/);
    expect(readState(root)).toBe(DOC_WITH_ENVIRONMENT);
  });

  it("answers a failing `lint --json` with ok:false and the violations, exit 1", async () => {
    const root = makeStateRepo({
      gitignore: "STATE.md\n",
      state: docFrom(CANONICAL_SECTIONS.filter((name) => name !== "Research")),
    });
    const result = await run(["state", "lint", "--json"], root);
    const payload = JSON.parse(result.stdout) as { ok?: unknown };
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload)).toContain("Research");
  });

  it.each(["init", "lint"])(
    "fails hard outside a git repository (%s)",
    async (subcommand) => {
      const plain = makeNonGitDir();
      const result = await run(["state", subcommand], plain);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/git/i);
      expect(existsSync(join(plain, "STATE.md"))).toBe(false);
    }
  );
});
