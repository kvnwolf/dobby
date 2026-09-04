import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitIn,
  makeScratchRepo,
  mkStubBins,
  readStubLog,
  restoreEnv,
  stubLogPath,
  stubPath,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// `dobby instructions <topic>` — the INSTRUCTION CATALOGUE half of the
// environment adapter seam.
//
// The executable half of the seam (panes, detached spawns, teardown) already
// exists; this command answers the OTHER half: for the detected environment
// (cmux enrichment vs the plain terminal host), what the MODEL must do for a
// given topic — `start`, `stop`, `browser`, `rename`. dobby prints the
// instruction; it never performs it.
//
// The seam under test is the PUBLIC one and the ONLY one: `run(argv, cwd) ->
// {exitCode, stdout, stderr}`, exercised in-process. Neither `environment.ts`,
// nor any adapter, nor `browser-guide.ts` is imported here — an internal
// restructure of how the catalogue is assembled cannot break these tests, only
// a change to what `dobby instructions` REPORTS can.
//
// Where every expected value comes from (all independent of any implementation):
//  - the JSON envelope keys (`environment`/`topic`/`applies`/`text`), the
//    environment ids `"cmux"`/`"terminal"`, the four topic names, the exit
//    codes, and the "a non-applicable topic is not an error" rule are the task
//    spec stated outright;
//  - every asserted PHRASE (`run_in_background`, `bunx dobby dev`, `cmux send`,
//    `new-pane --workspace 'w1'`, `close-surface --surface '<ref>'`,
//    `rename-workspace --workspace 'w1' '<slug>'`, `claude-in-chrome`, `curl`)
//    is a literal the spec names for that topic's text — quoted where the value
//    lands on a shell command line (see Slice 6, which owns that rule);
//  - `snapshot --interactive` is a stable distinctive line of the VENDORED
//    cmux-browser protocol (`src/vendor/cmux-browser/SKILL.md`, third-party
//    text, not dobby code), hardcoded here on purpose: if the vendored bytes
//    ever change, that must fail visibly rather than follow along;
//  - the surface refs `surface:4` / `surface:5` are invented by the cmux STUB
//    THIS file writes, so text carrying them proves real pane discovery ran;
//  - `<slug>` is `basename()` of the temp workroot this file created (node:path
//    — a different mechanism than the code's git top-level resolution).
//
// The only real process dobby may reach here is `cmux`, stubbed as an
// executable recorder on a throwaway PATH (the repo's established boundary
// seam). Its recorded argv is the evidence for the other half of the contract:
// dobby DISCOVERS panes (a real `list-panes` call) but EXECUTES nothing it
// merely instructs (`send` / `new-pane` / `close-surface` / `rename-workspace`
// never appear in the log).
// ---------------------------------------------------------------------------

useSpawnBudget();

const CMUX = "CMUX_WORKSPACE_ID";
// The cmux workspace id every cmux case runs under — echoed verbatim in the
// `--workspace w1` fragments the instruction text must carry.
const CMUX_ID = "w1";

const scratchDirs: string[] = [];
const originalCmux = process.env[CMUX];
const originalPath = process.env.PATH;

// One workroot fixture, reused: a real git repo with NO app capability (so the
// devUrl `dobby env` resolves is null — the instruction text must still be
// produced) — and a plain non-git dir for the workroot-precondition cases.
const project = makeScratchRepo({
  branch: "dobby-instructions",
  prefix: "dobby-instr-",
  track: scratchDirs,
});
const slug = basename(project);
const plainDir = realpathSync(
  mkdtempSync(join(tmpdir(), "dobby-instr-plain-"))
);
scratchDirs.push(plainDir);

// Two more workroots whose PATHS carry the shell metacharacters an unquoted
// interpolation breaks on. The repo sits one level down (`…/repo`), so the space
// (and the quote) live in a PARENT component while the goal slug stays a plain
// word — workroot quoting and slug quoting are then independently observable.
const SPACED_SLUG = "repo";
const SPACED_KIT_PANES = `surface:4 dobby-run-${SPACED_SLUG}\nsurface:5 dobby-browser-${SPACED_SLUG}\n`;
const spacedRepo = nestedRepo("dobby r1 space-");
// A single quote is legal in a POSIX path but not on every filesystem; where the
// fixture cannot be created the case SKIPS rather than reporting the filesystem
// as a product failure.
const quotedRepo = tryNestedRepo("dobby r1 it's-");

// REVIEW ROUND 2 — the workroot that is also an ATTACK. Its basename (and so the
// goal slug, and so every kit pane title) carries every metacharacter that turns
// an interpolated value into a command: a space, a single quote, a double quote,
// a `$(…)` substitution and a backtick pair. Both substitutions are `touch
// <marker>`, so a shell that EVALUATES what dobby wrote leaves a file behind —
// the injection is observed by its effect, never by reading quote characters.
const INJECTION_MARKERS = ["sub", "tick"];
const INJECTION_NAME = `r2 it's "q" $(touch ${INJECTION_MARKERS[0]}) \`touch ${INJECTION_MARKERS[1]}\``;
const injectedRepo = tryNamedRepo(INJECTION_NAME);
// The goal slug the catalogue derives from that workroot: its basename, read by
// node:path — a different mechanism than the code's git top-level resolution.
const injectedSlug = injectedRepo === undefined ? "" : basename(injectedRepo);
// The kit panes cmux reports for it, titled with that same slug.
const INJECTED_KIT_PANES = `surface:4 dobby-run-${injectedSlug}\nsurface:5 dobby-browser-${injectedSlug}\n`;

// The two cmux discovery states, in the listing shape cmux itself prints
// (`pane:N` from `list-panes`, `surface:N <title>` from `list-pane-surfaces`):
// both kit panes open, versus a workspace holding only a non-kit pane.
const KIT_PANES = `surface:4 dobby-run-${slug}\nsurface:5 dobby-browser-${slug}\n`;
const NO_KIT_PANES = "surface:9 shell\n";
const RUN_PANE_REF = "surface:4";
const BROWSER_PANE_REF = "surface:5";

// Top-level regexes (biome useTopLevelRegex).
const GIT_MENTION = /git/i;
const NOT_APPLICABLE = /not applicable/i;
const RE_INVOKE = /(re-?invok|re-?run|again)/i;
const UP_TOKEN = /\bup\b/;

// The `--json` envelope the command prints as ONE object on stdout.
interface InstructionPayload {
  applies: boolean;
  environment: string;
  text: string;
  topic: string;
}

// A fresh cmux stub dir (its own recorder log, so each case reads only its own
// invocations), answering pane discovery with `surfaces`.
function cmuxStub(surfaces: string): string {
  return mkStubBins(
    {
      cmux: [
        { match: "list-pane-surfaces", stdout: surfaces },
        { match: "list-panes", stdout: "pane:1\n" },
      ],
    },
    scratchDirs
  );
}

// A throwaway git repo NESTED one level inside a temp dir named with `prefix`,
// so the workroot's path carries whatever `prefix` carries while its basename —
// the goal slug — stays the plain word `repo`. `makeScratchRepo` always inits at
// the temp dir itself, which would put the metacharacter in the slug too.
function nestedRepo(prefix: string): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(parent);
  const dir = join(parent, SPACED_SLUG);
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-q"]);
  gitIn(dir, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README"), "scratch\n");
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "scratch"]);
  return dir;
}

// A throwaway git repo whose own DIRECTORY NAME is `name` — so the workroot path
// AND the goal slug dobby derives from it both carry whatever `name` carries.
function namedRepo(name: string): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "dobby-instr-r2-")));
  scratchDirs.push(parent);
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-q"]);
  gitIn(dir, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README"), "scratch\n");
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "scratch"]);
  return dir;
}

// The same fixture where the filesystem may refuse a character in the name: the
// cases SKIP rather than reporting the filesystem as a product failure.
function tryNamedRepo(name: string): string | undefined {
  const made: string[] = [];
  try {
    made.push(namedRepo(name));
  } catch (error) {
    made.length = 0;
    process.stderr.write(
      `skipping the metacharacter-workroot fixture: ${String(error)}\n`
    );
  }
  return made[0];
}

// The same fixture where the filesystem may refuse the name outright.
function tryNestedRepo(prefix: string): string | undefined {
  const made: string[] = [];
  try {
    made.push(nestedRepo(prefix));
  } catch (error) {
    made.length = 0;
    process.stderr.write(
      `skipping the quoted-path fixture: ${String(error)}\n`
    );
  }
  return made[0];
}

function payloadOf(stdout: string): InstructionPayload {
  return JSON.parse(stdout) as InstructionPayload;
}

// stdout+stderr as one blob — the failure message that makes a red case readable.
function combined(result: { stderr: string; stdout: string }): string {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

afterAll(() => {
  restoreEnv(CMUX, originalCmux);
  restoreEnv("PATH", originalPath);
  cleanupDirs(scratchDirs);
});

// --- Slice 1 (tracer bullet): the terminal host's catalogue -----------------
// The first vertical slice: `instructions` is wired at all, detection with no
// CMUX_WORKSPACE_ID lands on the terminal adapter, and that adapter answers all
// four topics — two of which do not apply, which is a normal exit-0 answer and
// never an error.
describe("dobby instructions — the terminal host's catalogue", () => {
  beforeEach(() => {
    restoreEnv(CMUX, undefined);
  });

  it("tells the model to start the app as a background Bash job in the workroot", async () => {
    const result = await run(["instructions", "start", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("terminal");
    expect(payload.topic).toBe("start");
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain("run_in_background");
    expect(payload.text).toContain("bunx dobby dev");
    expect(payload.text).toContain(project);
  });

  it("tells the model to confirm the boot before re-invoking up", async () => {
    const result = await run(["instructions", "start", "--json"], project);
    const { text } = payloadOf(result.stdout);
    expect(text).toMatch(RE_INVOKE);
    expect(text).toMatch(UP_TOKEN);
  });

  it("reports stop as not applicable, with empty text and a clean exit", async () => {
    // `dobby down` kills the registered process itself, so there is nothing for
    // the model to do — not an error, and the reason never leaks into `text`.
    const result = await run(["instructions", "stop", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.applies).toBe(false);
    expect(payload.text).toBe("");
  });

  it("reports rename as not applicable (a plain terminal has no workspace)", async () => {
    const result = await run(["instructions", "rename", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).applies).toBe(false);
  });

  it("prints a one-line not-applicable reason in text mode", async () => {
    const result = await run(["instructions", "rename"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    expect(result.stdout).toMatch(NOT_APPLICABLE);
  });

  it("answers browser outside a git repo with the non-cmux verification guide", async () => {
    // `browser` embeds no workroot, so it answers ANYWHERE — the one topic with
    // no git precondition.
    const result = await run(["instructions", "browser", "--json"], plainDir);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("terminal");
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain("claude-in-chrome");
    expect(payload.text).toContain("curl");
  });

  it("fails outside a git repo for start, which must embed a workroot", async () => {
    const result = await run(["instructions", "start"], plainDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(GIT_MENTION);
    // …and it fails on the WORKROOT precondition, the way `up` does — never
    // because the command or its topic went unrecognized.
    expect(result.stderr).not.toContain("unknown command");
  });
});

// --- Slice 2: the topic argument itself -------------------------------------
// An unknown topic and a missing topic are the two REAL errors this command
// has: exit 1, naming every valid topic so the caller can correct itself.
describe("dobby instructions — the topic argument", () => {
  beforeEach(() => {
    restoreEnv(CMUX, undefined);
  });

  it("rejects an unknown topic, naming the four valid topics", async () => {
    const result = await run(["instructions", "bogus"], project);
    expect(result.exitCode).toBe(1);
    for (const topic of ["start", "stop", "browser", "rename"]) {
      expect(result.stderr, `missing topic in error: ${topic}`).toContain(
        topic
      );
    }
  });

  it("rejects an invocation with no topic at all, naming the four valid topics", async () => {
    const result = await run(["instructions"], project);
    expect(result.exitCode).toBe(1);
    for (const topic of ["start", "stop", "browser", "rename"]) {
      expect(result.stderr, `missing topic in error: ${topic}`).toContain(
        topic
      );
    }
  });
});

// --- Slice 3: the cmux catalogue -------------------------------------------
// Under cmux enrichment the catalogue is written AROUND the kit panes dobby
// discovers: reuse the surviving run pane, or create one; close what is open;
// drive the browser pane through the vendored protocol; rename the workspace to
// the goal slug. Discovery is the one thing dobby EXECUTES — every acting
// command stays inside the text.
describe("dobby instructions — the cmux catalogue", () => {
  beforeEach(() => {
    process.env[CMUX] = CMUX_ID;
  });

  it("sends the dev line into the surviving run pane instead of creating one", async () => {
    const stubDir = cmuxStub(KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "start", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("cmux");
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain("cmux send");
    expect(payload.text).toContain(RUN_PANE_REF);
    expect(payload.text).toContain(nestedSendArgument(project));
    expect(payload.text).not.toContain("new-pane");
  });

  it("discovers the kit panes but executes nothing it instructs", async () => {
    const stubDir = cmuxStub(KIT_PANES);
    await withStubPath(stubDir, () =>
      run(["instructions", "start", "--json"], project)
    );
    const records = readStubLog(stubDir, "cmux");
    expect(
      records.some((argv) => argv.includes("list-panes")),
      "expected pane discovery to run"
    ).toBe(true);
    expect(
      records.some(
        (argv) => argv.includes("send") || argv.includes("new-pane")
      ),
      "expected no acting cmux call"
    ).toBe(false);
  });

  it("instructs creating and naming a run pane when none is open", async () => {
    const stubDir = cmuxStub(NO_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "start", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain(`new-pane --workspace '${CMUX_ID}'`);
    expect(payload.text).toContain(`'dobby-run-${slug}'`);
  });

  it("instructs closing every discovered kit pane on stop", async () => {
    const stubDir = cmuxStub(KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "stop", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain(`close-surface --surface '${RUN_PANE_REF}'`);
    expect(payload.text).toContain(
      `close-surface --surface '${BROWSER_PANE_REF}'`
    );
    expect(
      readStubLog(stubDir, "cmux").some((argv) =>
        argv.includes("close-surface")
      ),
      "expected no pane to be closed"
    ).toBe(false);
  });

  it("reports stop as not applicable when no kit pane is open", async () => {
    const stubDir = cmuxStub(NO_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "stop", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).applies).toBe(false);
  });

  it("points the browser topic at the discovered browser pane and the cmux-browser protocol", async () => {
    const stubDir = cmuxStub(KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "browser", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain(BROWSER_PANE_REF);
    expect(payload.text).toContain("snapshot --interactive");
  });

  it("instructs renaming the workspace to the goal slug without renaming it", async () => {
    const stubDir = cmuxStub(KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "rename", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain(
      `rename-workspace --workspace '${CMUX_ID}' '${slug}'`
    );
    expect(
      readStubLog(stubDir, "cmux").some((argv) =>
        argv.includes("rename-workspace")
      ),
      "expected no workspace to be renamed"
    ).toBe(false);
  });
});

// --- Slice 4: the t3 code catalogue ----------------------------------------
// t3 code (the vendor's desktop app) hosts the session inside a bundle, so
// detection reads `__CFBundleIdentifier` rather than a workspace id, and the
// rung matches by PREFIX: the production id `com.t3tools.t3code` and every dev
// build `com.t3tools.t3code.dev.<repo>` land on the same adapter. Its catalogue
// is HALF terminal (it cannot start a dev server — the host's background Bash
// does) and half its own: a hand-written browser guide over the vendor's
// `mcp__t3-code__preview_*` tool family.
//
// Where every expected value comes from (all independent of any implementation):
//  - the environment id `"t3-code"`, both bundle ids, the cascade order (cmux
//    wins over t3-code, an unrelated bundle falls through to terminal), and the
//    applies/exit-code answer per topic are stated outright in the task spec;
//  - all 14 `mcp__t3-code__preview_*` names, the `environment-port` target, the
//    `locator` / `curl` fragments and the required step ORDER (status → open →
//    navigate) are literals the spec enumerates for the browser guide;
//  - `v0.0.38` / `2026-09-02` are the vendor version and date the guide was
//    verified against, pinned here as literals ON PURPOSE: when the vendor's
//    tool surface moves, that must fail visibly rather than drift silently;
//  - the `start` text is not restated here at all — it is compared against the
//    TERMINAL adapter's own answer through the same public seam, which is what
//    "exactly terminal's text" means without recomputing either.
//
// No bundle-hosted process is reached: `__CFBundleIdentifier` is an ordinary
// environment variable, so the whole rung is exercised by setting it.

const BUNDLE = "__CFBundleIdentifier";
// The production bundle id, and a dev build of it — the prefix rung must accept
// both, and must NOT accept an unrelated app's id.
const T3_ID = "com.t3tools.t3code";
const T3_DEV_ID = "com.t3tools.t3code.dev.myrepo";
const OTHER_APP_ID = "com.example.other";

// Every tool the browser guide must name, WITH the MCP prefix the model types.
const T3_PREVIEW_TOOLS = [
  "mcp__t3-code__preview_status",
  "mcp__t3-code__preview_open",
  "mcp__t3-code__preview_navigate",
  "mcp__t3-code__preview_resize",
  "mcp__t3-code__preview_set_appearance",
  "mcp__t3-code__preview_snapshot",
  "mcp__t3-code__preview_click",
  "mcp__t3-code__preview_type",
  "mcp__t3-code__preview_press",
  "mcp__t3-code__preview_scroll",
  "mcp__t3-code__preview_evaluate",
  "mcp__t3-code__preview_wait_for",
  "mcp__t3-code__preview_recording_start",
  "mcp__t3-code__preview_recording_stop",
];

const originalBundle = process.env[BUNDLE];

// Claude Desktop announces itself through the host's own entrypoint variable —
// captured here at module load, BEFORE any case mutates it, because the session
// running this suite carries one for real (`sdk-ts` under the Agent SDK).
const ENTRYPOINT = "CLAUDE_CODE_ENTRYPOINT";
const originalEntrypoint = process.env[ENTRYPOINT];

// The ambient host is an input to EVERY case in this file: a session running
// inside t3 code (or a cmux pane, or Claude Desktop) exports these vars for
// real, which would silently re-route the terminal cases above. Each test
// therefore starts from a bare host and states its own enrichment. A file-level
// hook runs before every nested one, so each describe's own `beforeEach` still
// wins.
beforeEach(() => {
  restoreEnv(BUNDLE, undefined);
  restoreEnv(CMUX, undefined);
  restoreEnv(ENTRYPOINT, undefined);
});

afterAll(() => {
  restoreEnv(BUNDLE, originalBundle);
  restoreEnv(ENTRYPOINT, originalEntrypoint);
});

describe("dobby instructions — the t3 code catalogue", () => {
  beforeEach(() => {
    process.env[BUNDLE] = T3_ID;
  });

  it("walks the browser topic through the vendor's preview tools in the vendor's order", async () => {
    const result = await run(["instructions", "browser", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("t3-code");
    expect(payload.applies).toBe(true);
    const { text } = payload;
    // Idempotency first: reuse the tab already open, only then open one, only
    // then navigate it at the app's port.
    for (const tool of [
      "mcp__t3-code__preview_status",
      "mcp__t3-code__preview_open",
      "mcp__t3-code__preview_navigate",
    ]) {
      expect(text, `missing step: ${tool}`).toContain(tool);
    }
    expect(text.indexOf("mcp__t3-code__preview_status")).toBeLessThan(
      text.indexOf("mcp__t3-code__preview_open")
    );
    expect(text.indexOf("mcp__t3-code__preview_open")).toBeLessThan(
      text.indexOf("mcp__t3-code__preview_navigate")
    );
  });

  it("names every preview tool the vendor exposes", async () => {
    const result = await run(["instructions", "browser", "--json"], project);
    const { text } = payloadOf(result.stdout);
    for (const tool of T3_PREVIEW_TOOLS) {
      expect(text, `missing tool: ${tool}`).toContain(tool);
    }
  });

  it("targets the app by environment port, drives it with locators, and falls back to curl", async () => {
    const result = await run(["instructions", "browser", "--json"], project);
    const { text } = payloadOf(result.stdout);
    expect(text).toContain("environment-port");
    expect(text).toContain("locator");
    expect(text).toContain("curl");
  });

  it("records the vendor version the guide was verified against", async () => {
    const result = await run(["instructions", "browser", "--json"], project);
    const { text } = payloadOf(result.stdout);
    expect(text).toContain("v0.0.38");
    expect(text).toContain("2026-09-02");
  });

  it("answers browser outside a git repo, which needs no workroot", async () => {
    const result = await run(["instructions", "browser", "--json"], plainDir);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("t3-code");
    expect(payload.applies).toBe(true);
  });

  it("detects a dev build of the app by its bundle-id prefix", async () => {
    process.env[BUNDLE] = T3_DEV_ID;
    const result = await run(["instructions", "browser", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).environment).toBe("t3-code");
  });

  it("hands the start topic back to the host's background Bash", async () => {
    const result = await run(["instructions", "start", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("t3-code");
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain("run_in_background");
    expect(payload.text).toContain("bunx dobby dev");
  });

  it("answers start with exactly what the plain terminal answers", async () => {
    // t3 code cannot start a dev server, so it adds NOTHING to the terminal's
    // instruction — compared through the same public seam, never restated.
    const inApp = await run(["instructions", "start", "--json"], project);
    restoreEnv(BUNDLE, undefined);
    const inTerminal = await run(["instructions", "start", "--json"], project);
    const appPayload = payloadOf(inApp.stdout);
    const terminalPayload = payloadOf(inTerminal.stdout);
    expect(appPayload.environment).toBe("t3-code");
    expect(terminalPayload.environment).toBe("terminal");
    expect(appPayload.text).toBe(terminalPayload.text);
  });

  it("reports stop as not applicable (the app runs no dev server)", async () => {
    const result = await run(["instructions", "stop", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("t3-code");
    expect(payload.applies).toBe(false);
  });

  it("reports rename as not applicable (the app has no workspace to rename)", async () => {
    const result = await run(["instructions", "rename", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("t3-code");
    expect(payload.applies).toBe(false);
  });

  it("prefers cmux enrichment over the hosting app when both are present", async () => {
    // A cmux pane running inside the app is still a cmux pane: panes are the
    // richer surface, so that rung wins.
    process.env[CMUX] = CMUX_ID;
    const stubDir = cmuxStub(KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "browser", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).environment).toBe("cmux");
  });

  it("falls through to the terminal for an unrelated hosting app", async () => {
    process.env[BUNDLE] = OTHER_APP_ID;
    const result = await run(["instructions", "browser", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).environment).toBe("terminal");
  });
});

// --- Slice 5: the Claude Desktop catalogue ----------------------------------
// Claude Desktop (and the third-party / local-agent flavours of the same app)
// hosts the session inside the desktop client, which announces itself through
// `CLAUDE_CODE_ENTRYPOINT` rather than a bundle id or a workspace id. Its rung
// sits ABOVE t3 code and BELOW cmux enrichment. Its catalogue is HALF terminal
// (it starts no dev server of its own — the host's background Bash does) and
// half its own: a hand-written guide over the built-in `Claude Browser` MCP
// server, carried as UNVERIFIED because the study behind it was observed in the
// field, not re-proven by this change.
//
// Where every expected value comes from (all independent of any implementation):
//  - the environment id `"claude-desktop"`, the three accepted entrypoint
//    values, the two that must fall through to the terminal, the cascade order
//    (cmux beats desktop, desktop beats t3 code) and the applies/exit-code
//    answer per topic are stated outright in the task spec;
//  - every `mcp__Claude_Browser__*` name, the required step ORDER
//    (tabs_context → tabs_create → navigate), the server name `Claude Browser`
//    with its `Claude Preview` alias, the deliberate `claude-in-chrome`
//    exclusion and the `curl` fallback are literals the spec enumerates;
//  - `unverified` / `2026-08-19` / `2.1.229` are the marker the spec dictates —
//    the word, the field-study date and the Claude Code version studied —
//    pinned as literals ON PURPOSE: when someone verifies (or re-dates) the
//    guide, that must be a visible edit here, never a silent drift;
//  - the `start` text is not restated at all — it is compared against the
//    TERMINAL adapter's own answer through the same public seam, which is what
//    "terminal's text" means without recomputing either.
//
// No desktop process is reached: `CLAUDE_CODE_ENTRYPOINT` is an ordinary
// environment variable, so the whole rung is exercised by setting it.

// The entrypoint every Desktop case runs under by default, plus its siblings:
// the two other values the rung must accept, and two ordinary terminal
// entrypoints it must NOT swallow.
const DESKTOP_3P_ENTRYPOINT = "claude-desktop-3p";
const DESKTOP_ENTRYPOINTS = ["claude-desktop", "local-agent"];
const TERMINAL_ENTRYPOINTS = ["sdk-ts", "cli"];

// The tools that DRIVE the page, with the MCP prefix the model types.
const CLAUDE_BROWSER_TOOLS = [
  "mcp__Claude_Browser__read_page",
  "mcp__Claude_Browser__find",
  "mcp__Claude_Browser__form_input",
  "mcp__Claude_Browser__computer",
  "mcp__Claude_Browser__get_page_text",
];

// The two reads that turn a failing page into a diagnosis.
const CLAUDE_BROWSER_DIAGNOSTICS = [
  "mcp__Claude_Browser__read_console_messages",
  "mcp__Claude_Browser__read_network_requests",
];

// The tab lifecycle, in the only order that is idempotent: look at what is
// already open, create only when nothing is, navigate last.
const TABS_CONTEXT = "mcp__Claude_Browser__tabs_context";
const TABS_CREATE = "mcp__Claude_Browser__tabs_create";
const NAVIGATE = "mcp__Claude_Browser__navigate";

async function environmentUnderEntrypoint(entrypoint: string): Promise<string> {
  process.env[ENTRYPOINT] = entrypoint;
  const result = await run(["instructions", "browser", "--json"], project);
  expect(result.exitCode, combined(result)).toBe(0);
  return payloadOf(result.stdout).environment;
}

async function desktopBrowserText(): Promise<string> {
  const result = await run(["instructions", "browser", "--json"], project);
  expect(result.exitCode, combined(result)).toBe(0);
  const payload = payloadOf(result.stdout);
  expect(payload.environment).toBe("claude-desktop");
  return payload.text;
}

describe("dobby instructions — the Claude Desktop catalogue", () => {
  beforeEach(() => {
    process.env[ENTRYPOINT] = DESKTOP_3P_ENTRYPOINT;
  });

  it("reuses a tab already open on the app before creating or navigating one", async () => {
    const result = await run(["instructions", "browser", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("claude-desktop");
    expect(payload.applies).toBe(true);
    const { text } = payload;
    // Present FIRST — `indexOf` answers -1 for a missing step, which would
    // satisfy the ordering comparisons vacuously.
    for (const step of [TABS_CONTEXT, TABS_CREATE, NAVIGATE]) {
      expect(text, `missing step: ${step}`).toContain(step);
    }
    expect(text.indexOf(TABS_CONTEXT)).toBeLessThan(text.indexOf(TABS_CREATE));
    expect(text.indexOf(TABS_CREATE)).toBeLessThan(text.indexOf(NAVIGATE));
  });

  it("names every browser tool the model drives the page with", async () => {
    const text = await desktopBrowserText();
    for (const tool of CLAUDE_BROWSER_TOOLS) {
      expect(text, `missing tool: ${tool}`).toContain(tool);
    }
  });

  it("names the console and network reads that diagnose a failing page", async () => {
    const text = await desktopBrowserText();
    for (const tool of CLAUDE_BROWSER_DIAGNOSTICS) {
      expect(text, `missing diagnostic: ${tool}`).toContain(tool);
    }
  });

  it("names the built-in server and its Claude Preview alias", async () => {
    const text = await desktopBrowserText();
    expect(text).toContain("Claude Browser");
    expect(text).toContain("Claude Preview");
  });

  it("rules out claude-in-chrome and falls back to curl when the tools are absent", async () => {
    const text = await desktopBrowserText();
    expect(text).toContain("claude-in-chrome");
    expect(text).toContain("curl");
  });

  it("marks the guide unverified against the studied date and Claude Code version", async () => {
    const text = await desktopBrowserText();
    expect(text).toContain("unverified");
    expect(text).toContain("2026-08-19");
    expect(text).toContain("2.1.229");
  });

  it.each(DESKTOP_ENTRYPOINTS)(
    "routes the %s entrypoint to the Claude Desktop catalogue",
    async (entrypoint) => {
      expect(await environmentUnderEntrypoint(entrypoint)).toBe(
        "claude-desktop"
      );
    }
  );

  it.each(TERMINAL_ENTRYPOINTS)(
    "leaves the %s entrypoint on the plain terminal",
    async (entrypoint) => {
      expect(await environmentUnderEntrypoint(entrypoint)).toBe("terminal");
    }
  );

  it("prefers Claude Desktop over the hosting t3 code bundle", async () => {
    // Claude Desktop running the session is the surface the model actually
    // drives, so its rung sits above the bundle id underneath it.
    process.env[ENTRYPOINT] = "claude-desktop";
    process.env[BUNDLE] = T3_ID;
    const result = await run(["instructions", "browser", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).environment).toBe("claude-desktop");
  });

  it("prefers cmux enrichment over Claude Desktop when both are present", async () => {
    process.env[ENTRYPOINT] = "claude-desktop";
    process.env[CMUX] = CMUX_ID;
    const stubDir = cmuxStub(KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "browser", "--json"], project)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).environment).toBe("cmux");
  });

  it("hands the start topic back to the host's background Bash", async () => {
    const result = await run(["instructions", "start", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("claude-desktop");
    expect(payload.applies).toBe(true);
    expect(payload.text).toContain("run_in_background");
    expect(payload.text).toContain("bunx dobby dev");
  });

  it("answers start with exactly what the plain terminal answers", async () => {
    // Claude Desktop starts no dev server, so it adds NOTHING to the terminal's
    // instruction — compared through the same public seam, never restated.
    const inDesktop = await run(["instructions", "start", "--json"], project);
    restoreEnv(ENTRYPOINT, undefined);
    const inTerminal = await run(["instructions", "start", "--json"], project);
    const desktopPayload = payloadOf(inDesktop.stdout);
    const terminalPayload = payloadOf(inTerminal.stdout);
    expect(desktopPayload.environment).toBe("claude-desktop");
    expect(terminalPayload.environment).toBe("terminal");
    expect(desktopPayload.text).toBe(terminalPayload.text);
  });

  it("reports stop as not applicable (the app runs no dev server)", async () => {
    const result = await run(["instructions", "stop", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("claude-desktop");
    expect(payload.applies).toBe(false);
  });

  it("reports rename as not applicable (the app has no workspace to rename)", async () => {
    const result = await run(["instructions", "rename", "--json"], project);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("claude-desktop");
    expect(payload.applies).toBe(false);
  });

  it("answers browser outside a git repo, which needs no workroot", async () => {
    const result = await run(["instructions", "browser", "--json"], plainDir);
    expect(result.exitCode, combined(result)).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.environment).toBe("claude-desktop");
    expect(payload.applies).toBe(true);
  });
});

// --- Slice 6: shell quoting in the cmux command lines -----------------------
// Every dynamic value dobby interpolates into a shell command line inside an
// instruction's text — the workroot, the workspace id, the goal slug, a kit pane
// title, a discovered pane ref — is an ARGUMENT the model will type or `cmux
// send` verbatim. Unquoted, `cd /tmp/dobby r1 space-X/repo` is TWO arguments and
// the run starts in the wrong directory (or not at all), which is why the
// contract here is not "a quote character is present" but "a shell running the
// command lands where dobby meant": the workroot cases EXECUTE the extracted
// `cd` through /bin/sh and compare the directory it reaches.
//
// Where every expected value comes from (all independent of any implementation):
//  - the quoted forms `cd '<workroot>' && bunx dobby dev`,
//    `new-pane --workspace 'w1'`, `rename-workspace --workspace 'w1' '<slug>'`
//    and `--surface '<ref>'` are the review finding's own words;
//  - the directory a correct `cd` must reach is the path node:fs created and
//    this file owns — never a path any dobby code resolved;
//  - `'\''` is POSIX single-quote escaping (the SHELL's rule, not dobby's) and
//    is never spelled out in an assertion: the quote-bearing fixture is proven
//    by RUNNING the command, so any correct escaping passes and any broken one
//    fails.
describe("dobby instructions — cmux instructions quote shell arguments", () => {
  beforeEach(() => {
    process.env[CMUX] = CMUX_ID;
  });

  it("quotes a workroot whose path holds a space in the dev command line", async () => {
    const stubDir = cmuxStub(SPACED_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "start", "--json"], spacedRepo)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).text).toContain(
      nestedSendArgument(spacedRepo)
    );
  });

  it("hands cmux send the whole dev command line as ONE argument, for a path holding a space", async () => {
    // The byte-identity half of the contract, where it is well defined: a path
    // with no single quote of its own needs no `'\''` escape, so the argument
    // `cmux send` receives is exactly the review finding's literal.
    const stubDir = cmuxStub(SPACED_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "start", "--json"], spacedRepo)
    );
    const scratch = markerDir();
    const failed = runCmuxLines(
      payloadOf(result.stdout).text,
      stubDir,
      scratch
    );

    expect(
      [failed, sendArguments(readStubLog(stubDir, "cmux"))],
      combined(result)
    ).toEqual([[], [`cd '${spacedRepo}' && bunx dobby dev`]]);
  });

  it("hands over a dev command line a shell parses and enters, for a path holding a space", async () => {
    const stubDir = cmuxStub(SPACED_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "start", "--json"], spacedRepo)
    );
    const scratch = markerDir();
    runCmuxLines(payloadOf(result.stdout).text, stubDir, scratch);

    expect(
      shLandsIn(sendArguments(readStubLog(stubDir, "cmux"))[0], scratch),
      combined(result)
    ).toBe(spacedRepo);
  });

  it.skipIf(quotedRepo === undefined)(
    "hands over a dev command line a shell parses and enters, for a path holding a single quote",
    async () => {
      const workroot = quotedRepo ?? "";
      const stubDir = cmuxStub(SPACED_KIT_PANES);
      const result = await withStubPath(stubDir, () =>
        run(["instructions", "start", "--json"], workroot)
      );
      const scratch = markerDir();
      const failed = runCmuxLines(
        payloadOf(result.stdout).text,
        stubDir,
        scratch
      );

      expect(
        [
          failed,
          shLandsIn(sendArguments(readStubLog(stubDir, "cmux"))[0], scratch),
        ],
        combined(result)
      ).toEqual([[], workroot]);
    }
  );

  it("quotes the discovered run pane ref it sends the dev line to", async () => {
    const stubDir = cmuxStub(SPACED_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "start", "--json"], spacedRepo)
    );
    expect(payloadOf(result.stdout).text).toContain(
      `--surface '${RUN_PANE_REF}'`
    );
  });

  it("quotes the workspace id and the goal slug in the rename command", async () => {
    const stubDir = cmuxStub(SPACED_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "rename", "--json"], spacedRepo)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).text).toContain(
      `rename-workspace --workspace '${CMUX_ID}' '${SPACED_SLUG}'`
    );
  });

  it("quotes the workspace id when it instructs a browser pane to be created", async () => {
    // With no kit pane open, `browser` is the topic that carries a `new-pane`
    // command line of its own.
    const stubDir = cmuxStub(NO_KIT_PANES);
    const result = await withStubPath(stubDir, () =>
      run(["instructions", "browser", "--json"], spacedRepo)
    );
    expect(result.exitCode, combined(result)).toBe(0);
    expect(payloadOf(result.stdout).text).toContain(
      `new-pane --workspace '${CMUX_ID}'`
    );
  });
});

// --- Slice 7: the cmux command lines survive shell metacharacters -----------
// Round 1 single-quoted the values dobby interpolates, but wrapped the whole
// `sendLine` in DOUBLE quotes as the argument to `cmux send` — and inside double
// quotes a shell still reads `"`, `$(…)`, a backtick and `\`. So a workroot (or
// a goal slug, which is its basename) carrying those characters is not merely
// mis-split: it EXECUTES when the model runs the command dobby handed it.
//
// The contract is therefore the one thing a quote-counting assertion cannot
// state: run every cmux command line dobby emitted through /bin/sh, against a
// `cmux` that records its argv, and require that (a) the shell exits 0, (b) NO
// marker file appeared — nothing dobby wrote was evaluated as a command — and
// (c) each dynamic value reached the stub's argv INTACT, byte for byte, as one
// argument. `cmux send` is checked one layer deeper still: the dev command line
// it carried is itself run, and must land in the workroot.
//
// That proof rests on one presentational requirement, which the model copying
// the command needs just as much: every cmux command dobby writes must be
// COPYABLE WHOLE — either standing on its own line, or written as one markdown
// code span (`cmux …`). A command left bare inside a sentence has no end a
// reader (or this test) can find once a value carries a `;`, a `.` or a
// backtick of its own, so it is not a command anyone can run.
//
// Where every expected value comes from (all independent of any implementation):
//  - the workroot, its basename and the pane titles built from it are values
//    THIS file created with node:fs and node:path;
//  - `w1` is the workspace id the test exports; `surface:4`/`surface:5` are
//    invented by the cmux stub this file writes;
//  - exit 0 and "no marker file" are properties of the SHELL, not of dobby;
//  - `'\''` (POSIX single-quote escaping) is never spelled out in an assertion:
//    any correct escaping passes and any broken one fails, because the proof is
//    execution.
describe("dobby instructions — cmux instructions survive shell metacharacters", () => {
  beforeEach(() => {
    process.env[CMUX] = CMUX_ID;
  });

  it.skipIf(injectedRepo === undefined)(
    "sends a dev command that enters a workroot whose name is a shell attack",
    async () => {
      const workroot = injectedRepo ?? "";
      const stubDir = cmuxStub(INJECTED_KIT_PANES);
      const result = await withStubPath(stubDir, () =>
        run(["instructions", "start", "--json"], workroot)
      );
      const scratch = markerDir();
      const failed = runCmuxLines(
        payloadOf(result.stdout).text,
        stubDir,
        scratch
      );
      const records = readStubLog(stubDir, "cmux");
      const sent = sendArguments(records);
      const lands = shLandsIn(sent[0], scratch);
      // Both places a `touch <marker>` could land: the directory the commands
      // ran FROM, and the workroot a `cd` reaches before the `&&`.
      const fired = [...markersFired(scratch), ...markersFired(workroot)];

      expect(
        {
          failed,
          fired,
          lands,
          sent: sent.length,
          strayWorkspace: flagValues(records, "--workspace").filter(
            (value) => value !== CMUX_ID
          ),
          surfaces: flagValues(records, "--surface"),
        },
        cmuxReport(result, stubDir)
      ).toEqual({
        failed: [],
        fired: [],
        lands: workroot,
        sent: 1,
        strayWorkspace: [],
        surfaces: [RUN_PANE_REF],
      });
    }
  );

  it.skipIf(injectedRepo === undefined)(
    "names a new run pane after a goal slug that is a shell attack",
    async () => {
      const workroot = injectedRepo ?? "";
      const stubDir = cmuxStub(NO_KIT_PANES);
      const result = await withStubPath(stubDir, () =>
        run(["instructions", "start", "--json"], workroot)
      );
      const scratch = markerDir();
      const failed = runCmuxLines(
        payloadOf(result.stdout).text,
        stubDir,
        scratch
      );
      const records = readStubLog(stubDir, "cmux");
      const title = `dobby-run-${injectedSlug}`;
      const lands = shLandsIn(sendArguments(records)[0], scratch);
      const fired = markersFired(scratch);

      expect(
        {
          failed,
          fired,
          lands,
          titled: records.flat().includes(title),
          workspaces: [...new Set(flagValues(records, "--workspace"))],
        },
        cmuxReport(result, stubDir)
      ).toEqual({
        failed: [],
        fired: [],
        lands: workroot,
        titled: true,
        workspaces: [CMUX_ID],
      });
    }
  );

  it.skipIf(injectedRepo === undefined)(
    "closes the kit panes of a workroot whose name is a shell attack",
    async () => {
      const workroot = injectedRepo ?? "";
      const stubDir = cmuxStub(INJECTED_KIT_PANES);
      const result = await withStubPath(stubDir, () =>
        run(["instructions", "stop", "--json"], workroot)
      );
      const scratch = markerDir();
      const failed = runCmuxLines(
        payloadOf(result.stdout).text,
        stubDir,
        scratch
      );
      const records = readStubLog(stubDir, "cmux");
      const fired = markersFired(scratch);

      expect(
        { failed, fired, surfaces: flagValues(records, "--surface") },
        cmuxReport(result, stubDir)
      ).toEqual({
        failed: [],
        fired: [],
        surfaces: [RUN_PANE_REF, BROWSER_PANE_REF],
      });
    }
  );

  it.skipIf(injectedRepo === undefined)(
    "renames the workspace to a goal slug that is a shell attack",
    async () => {
      const workroot = injectedRepo ?? "";
      const stubDir = cmuxStub(INJECTED_KIT_PANES);
      const result = await withStubPath(stubDir, () =>
        run(["instructions", "rename", "--json"], workroot)
      );
      const scratch = markerDir();
      const failed = runCmuxLines(
        payloadOf(result.stdout).text,
        stubDir,
        scratch
      );
      const renames = readStubLog(stubDir, "cmux").filter(
        (record) => record[0] === "rename-workspace"
      );
      const fired = markersFired(scratch);

      // The whole argv, verbatim: the workspace id and the goal slug reach cmux
      // as two arguments, byte for byte what this file created.
      expect({ failed, fired, renames }, cmuxReport(result, stubDir)).toEqual({
        failed: [],
        fired: [],
        renames: [["rename-workspace", "--workspace", CMUX_ID, injectedSlug]],
      });
    }
  );

  it.skipIf(injectedRepo === undefined)(
    "names a new browser pane after a goal slug that is a shell attack",
    async () => {
      const workroot = injectedRepo ?? "";
      const stubDir = cmuxStub(NO_KIT_PANES);
      const result = await withStubPath(stubDir, () =>
        run(["instructions", "browser", "--json"], workroot)
      );
      const scratch = markerDir();
      const failed = runCmuxLines(
        payloadOf(result.stdout).text,
        stubDir,
        scratch
      );
      const argv = readStubLog(stubDir, "cmux").flat();
      const wanted = [CMUX_ID, `dobby-browser-${injectedSlug}`];
      const fired = markersFired(scratch);

      expect(
        {
          failed,
          fired,
          intact: wanted.filter((value) => argv.includes(value)),
        },
        cmuxReport(result, stubDir)
      ).toEqual({ failed: [], fired: [], intact: wanted });
    }
  );

  // The negative guard, on an ORDINARY workroot: every cmux command dobby wrote
  // is copyable whole (its own line, or one code span), and with every dynamic
  // argument single-quoted a double quote has no job left to do on it.
  // (Restricted to dobby's own commands: the vendored cmux-browser guide the
  // browser topic carries is third-party prose, full of its own quoting.)
  it.each(DOUBLE_QUOTE_FREE_TOPICS)(
    "writes copyable cmux commands with no double-quoted argument for %s",
    async (topic, surfaces) => {
      const stubDir = cmuxStub(surfaces);
      const result = await withStubPath(stubDir, () =>
        run(["instructions", topic, "--json"], project)
      );
      const { text } = payloadOf(result.stdout);
      const lines = dobbyCmuxCommands(text);

      expect(
        {
          commands: lines.length > 0,
          doubleQuoted: lines.filter((line) => line.includes('"')),
        },
        // The browser topic carries the whole vendored guide, so the report is
        // the command lines plus the OPENING of the text, never all of it.
        `dobby's own cmux command lines:\n${lines.join("\n")}\ntext begins:\n${text.slice(0, TEXT_EXCERPT)}`
      ).toEqual({ commands: true, doubleQuoted: [] });
    }
  );
});

// --- slice 6 + 7 observers --------------------------------------------------
//
// The quoting contract is proven by RUNNING what dobby wrote, never by reading
// the quote characters in it: each cmux command line dobby emits is handed to
// /bin/sh with the recording `cmux` stub first on PATH, and the assertions are
// about what the shell DID — the exit status, the files a substitution would
// have created, and the argv the stub received byte for byte.

// The tail every dev command line ends with — the anchor that identifies the
// argument `cmux send` carried, wherever in the argv it landed.
const DEV_TAIL = " && bunx dobby dev";

// The slot a cmux instruction leaves for a ref the MODEL only learns at run time
// (the pane it just created), and the ref this file fills it with so the command
// can be run for real. Substituting a placeholder is what the model does too; it
// touches nothing dobby quoted.
const REF_PLACEHOLDER = "<ref>";
const SUBSTITUTE_REF = "surface:9";

// The values dobby INJECTS into a cmux command line. A line carrying one of them
// is dobby's own (the vendored cmux-browser guide inside the browser topic's
// text carries none of these — checked against the vendored bytes), which is
// what separates a command dobby composed from a command a third-party document
// merely illustrates.
const INJECTED_MARKERS = [
  CMUX_ID,
  RUN_PANE_REF,
  BROWSER_PANE_REF,
  REF_PLACEHOLDER,
  "dobby-run-",
  "dobby-browser-",
  DEV_TAIL,
];

// The four topics, each with the discovery state in which it WRITES a cmux
// command line of its own: `browser` only composes one when no browser pane is
// open yet (with a pane open it hands over the vendored protocol instead).
// How much of an instruction's text a failure report quotes: enough to read
// dobby's own sentences, never the whole vendored browser guide behind them.
const TEXT_EXCERPT = 400;

const DOUBLE_QUOTE_FREE_TOPICS: [string, string][] = [
  ["start", KIT_PANES],
  ["stop", KIT_PANES],
  ["rename", KIT_PANES],
  ["browser", NO_KIT_PANES],
];

// Everything a failing case needs to be read without re-running it: the
// command's own output plus the argv the stub recorded.
function cmuxReport(
  result: { stderr: string; stdout: string },
  stubDir: string
): string {
  const argv = readStubLog(stubDir, "cmux")
    .map((record) => JSON.stringify(record))
    .join("\n");
  const commands = commandsIn(result.stdout).join("\n");
  return `${combined(result)}\ncommands read out of the text:\n${commands}\ncmux received:\n${argv}`;
}

// The cmux commands in a `--json` stdout, for a failure REPORT: an unparseable
// stdout (an error path, say) answers none rather than throwing inside the
// message that was supposed to explain the failure.
function commandsIn(stdout: string): string[] {
  try {
    return dobbyCmuxCommands(payloadOf(stdout).text);
  } catch {
    return [];
  }
}

// The `cmux send` ARGUMENT dobby hands over for a workroot holding no single
// quote of its own: the dev command line, itself single-quoted so the whole
// thing reaches `cmux send` as ONE argument. Spelled out, not computed — this is
// the review finding's own form, `… 'cd '\''<workroot>'\'' && bunx dobby dev'`.
function nestedSendArgument(workroot: string): string {
  return `'cd '\\''${workroot}'\\'' && bunx dobby dev'`;
}

// The characters that may follow the backtick CLOSING a markdown code span in
// ordinary prose: whitespace, sentence punctuation, or the end of the line. A
// backtick followed by anything else is still inside the span — which is how a
// command carrying a backtick IN ONE OF ITS VALUES is read whole.
const SPAN_ENDS = [" ", "\t", ".", ",", ";", ":", ")", "]", "!", "?", '"'];

// The cmux commands inside ONE line of prose, each read out of the markdown code
// span it is written in (`…`). A line may carry several ("Create one with `cmux
// new-pane …`, then rename it with `cmux rename-tab …`.").
function spanCommands(line: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const open = line.indexOf("`cmux ", from);
    if (open === -1) {
      return found;
    }
    const close = spanClose(line, open + 1);
    found.push(
      close === -1 ? line.slice(open + 1) : line.slice(open + 1, close)
    );
    if (close === -1) {
      return found;
    }
    from = close + 1;
  }
}

// Where the code span opened before `from` closes: the first backtick that ends
// the line or is followed by prose. Answers -1 when the span never closes.
function spanClose(line: string, from: number): number {
  for (let at = from; at < line.length; at += 1) {
    if (line[at] !== "`") {
      continue;
    }
    const next = line[at + 1];
    if (next === undefined || SPAN_ENDS.includes(next)) {
      return at;
    }
  }
  return -1;
}

// Every cmux command DOBBY ITSELF wrote into the text — the commands a model is
// meant to RUN, read whether they stand on their own line or sit in a code span
// inside a sentence, and kept only when they carry a value dobby injected (the
// vendored cmux-browser guide the browser topic quotes carries none).
function dobbyCmuxCommands(text: string): string[] {
  const commands: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("cmux ")) {
      commands.push(line);
    } else {
      commands.push(...spanCommands(line));
    }
  }
  return commands.filter((command) =>
    INJECTED_MARKERS.some((marker) => command.includes(marker))
  );
}

// A throwaway directory to run dobby's command lines FROM: a shell that
// evaluates an interpolated `$(touch …)` or backtick drops the marker file here,
// so an injection is observed by the file it left behind.
function markerDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-instr-marker-")));
  scratchDirs.push(dir);
  return dir;
}

// Which of the injection markers actually fired — `[]` when nothing dobby wrote
// was evaluated as a command.
function markersFired(dir: string): string[] {
  return INJECTION_MARKERS.filter((name) => existsSync(join(dir, name)));
}

// Run every cmux command line in `text` through /bin/sh with the stub first on
// PATH and `cwd` as the working directory, returning the lines that did NOT exit
// 0. The stub's log is cleared first, so the argv read back afterwards is only
// what these lines produced.
function runCmuxLines(text: string, stubDir: string, cwd: string): string[] {
  rmSync(stubLogPath(stubDir, "cmux"), { force: true });
  const failures: string[] = [];
  for (const line of dobbyCmuxCommands(text)) {
    const command = line.replaceAll(REF_PLACEHOLDER, SUBSTITUTE_REF);
    const { status } = spawnSync("sh", ["-c", command], {
      cwd,
      env: { ...process.env, PATH: stubPath(stubDir) },
    });
    if (status !== 0) {
      failures.push(`${line} -> exit ${String(status)}`);
    }
  }
  return failures;
}

// The values a flag was given, across every invocation the stub recorded — the
// verbatim half of the contract: `--surface` must be followed by the ref dobby
// discovered and `--workspace` by the workspace id, each as ONE argv element the
// shell did not split, expand or re-quote. Flag-relative rather than positional,
// so re-ordering the flags on a command line cannot fail this.
function flagValues(records: string[][], flag: string): string[] {
  const values: string[] = [];
  for (const record of records) {
    for (const [at, arg] of record.entries()) {
      const value = record[at + 1];
      if (arg === flag && value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
}

// The dev command lines that reached the stub as ONE argument — the whole point
// of the outer quoting layer. A command line split by the shell into several
// argv elements does not appear here at all.
function sendArguments(records: string[][]): string[] {
  return records
    .flat()
    .filter((arg) => arg.startsWith("cd ") && arg.endsWith(DEV_TAIL));
}

// Where a shell ENDS UP after running the dev command line the pane received —
// the proof the INNER quoting layer survived too. Run from `cwd`, so a
// substitution that fires only here still leaves its marker where the test
// looks. An unquoted path holding a space makes `cd` fail, `&&` short-circuits,
// and this answers the empty string.
function shLandsIn(sendArgument: string | undefined, cwd: string): string {
  if (sendArgument === undefined) {
    return "";
  }
  const enter = sendArgument.slice(0, -DEV_TAIL.length);
  return spawnSync("sh", ["-c", `${enter} && pwd`], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();
}
