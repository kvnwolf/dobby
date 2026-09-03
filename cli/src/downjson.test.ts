import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import { useSpawnBudget } from "./test-helpers.ts";

// Real git spawns under full-suite parallelism: the config-independent budget
// (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// TASK 7 — `down --json` returns the `stop` INSTRUCTION.
//
// `down` stops CLOSING cmux surfaces itself. Its remaining executed mechanics are
// unchanged (kill by pidfile, delete the neon branch, run `teardown[]` extras,
// fail-fast) plus cmux pane DISCOVERY — and the surface close comes back as DATA:
// `DownFacts` carries `instructions: {topic, applies, text}[]`, holding one
// `stop` instruction whose text names `cmux close-surface` and every discovered
// kit pane ref.
//
// `down --json` emits ONE flat JSON object as the ONLY stdout — the `up --json`
// house style (explicit nulls, never omitted keys) — with exactly:
//   {cmux, instructions, ok, reason, slug, workroot}
// `reason` is an ENUM (never prose):
//   not-a-git-repo | neon-delete-failed | teardown-extra-failed | null
// and the exit code always agrees with the payload: `ok` ⇔ exit 0. Child output
// (the teardown extras) goes to STDERR under `--json`, so stdout stays one
// parseable object.
//
// SEAM: exactly one — `run(argv, cwd) -> {exitCode, stdout, stderr}`, in-process
// (ADR-0008: tests never spawn the bin). `lifecycle.ts`, `environment.ts`,
// `pidfile.ts` and the adapters are NEVER imported here, so how the catalogue is
// assembled can be restructured freely; only what `down` REPORTS can break these.
//
// INDEPENDENT SOURCES for every expected value below:
//   - the six field names, the instruction shape, the `stop` topic, every
//     `reason` token and every exit code are LITERALS the task spec states
//     outright;
//   - `w1` is the workspace id WE inject; `surface:4` / `surface:5` are invented
//     by the cmux STUB THIS file writes, so an instruction carrying them proves
//     real pane discovery happened;
//   - `slug` / `workroot` are read back from the temp dir WE created (node:path
//     `basename` + node:fs `realpathSync` — a DIFFERENT mechanism than the code's
//     `git rev-parse --show-toplevel`);
//   - `2147483647` (2^31-1) is above any live pid on darwin/linux, so it is
//     unreachable BY CONSTRUCTION;
//   - `tearing-down` / `boom` are markers THIS file's fixtures print, never
//     produced by the code under test;
//   - the log record prefix (`cmux `) is written by the stub THIS file installs.
//
// Every `down` here runs against a fixture with no neon capability and no live
// process, so nothing real is ever killed, deleted or closed.
// ===========================================================================

const CMUX = "CMUX_WORKSPACE_ID";

// The cmux workspace id every cmux case runs under — echoed verbatim as the
// `cmux` field of the payload.
const CMUX_ID = "w1";
// A pid above any live process on darwin/linux: unreachable by construction, so
// the ownership check finds nothing to signal and only the file is cleaned up.
const DEAD_PID = "2147483647";
// The cmux verb `down` may only ever INSTRUCT, never invoke.
const CLOSE_VERB = "close-surface";
// The plan's hand-over marker: an instruction is QUOTED under a line beginning
// `agent:`, never rendered as one of down's own CLI action lines.
const AGENT_LINE = /^\s*agent:/m;
// The exact field set the spec enumerates, alphabetized (explicit nulls, never
// omitted keys — a consumer branches on `cmux === null`, which an absent key
// would make indistinguishable from "not reported").
const DOWN_JSON_FIELDS = [
  "cmux",
  "instructions",
  "ok",
  "reason",
  "slug",
  "workroot",
];

// A vite-only package.json: the capability gate `down` is listed behind, with no
// neon signal, so no branch delete is ever attempted.
const VITE_PKG = {
  devDependencies: { vite: "^5.0.0" },
  name: "downjson-app",
  private: true,
};

interface Instruction {
  applies: boolean;
  text: string;
  topic: string;
}

interface DownFacts {
  cmux: string | null;
  instructions: Instruction[];
  ok: boolean;
  reason: string | null;
  slug: string | null;
  workroot: string;
}

// Parse the RAW (untrimmed) stdout: JSON.parse accepts only whitespace around the
// object, so a successful parse of the WHOLE stdout IS the "sole stdout" contract —
// one stray prose line and this throws.
const payloadOf = (stdout: string) => JSON.parse(stdout) as DownFacts;

// The topics `down` handed back, in order — pinning BOTH which instructions apply
// and their sequence in one line.
function topicsOf(payload: DownFacts): string[] {
  const list = payload.instructions;
  return Array.isArray(list) ? list.map((entry) => entry.topic) : [];
}

// One handed-back instruction by topic (a readable failure when it is absent).
function instructionFor(payload: DownFacts, topic: string): Instruction {
  const list = Array.isArray(payload.instructions) ? payload.instructions : [];
  const found = list.find((entry) => entry.topic === topic);
  if (found === undefined) {
    const got = topicsOf(payload).join(", ");
    throw new Error(
      `no '${topic}' instruction was handed back (got: ${got === "" ? "none" : got})`
    );
  }
  return found;
}

const scratchDirs: string[] = [];

// Isolate repo creation from ambient git config (signing, hooks, identity) so the
// throwaway repos build on any developer machine.
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

// A throwaway git repo (git init is enough for the workroot to resolve) with the
// vite capability, plus an optional dobby.config.json (teardown extras) and
// .dobby/dev.pid. Returns the realpath-normalized root; its basename is the slug.
function makeRepo(opts: { config?: unknown; devPid?: string } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-downjson-")));
  scratchDirs.push(dir);
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
  writeFileSync(join(dir, "package.json"), JSON.stringify(VITE_PKG, null, 2));
  if (opts.config !== undefined) {
    writeFileSync(
      join(dir, "dobby.config.json"),
      JSON.stringify(opts.config, null, 2)
    );
  }
  if (opts.devPid !== undefined) {
    mkdirSync(join(dir, ".dobby"), { recursive: true });
    writeFileSync(join(dir, ".dobby", "dev.pid"), opts.devPid);
  }
  return dir;
}

// A plain temp dir that is NOT a git repo — the not-a-git-repo failure path.
function makeNonGitDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "dobby-downjson-nogit-"))
  );
  scratchDirs.push(dir);
  return dir;
}

// Write an EXECUTABLE shell script at <dir>/<name> (creating <dir>), so a spawn
// runs OUR script instead of any real tool.
function writeExecutable(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

// The stub bin dir a real `down` run needs, plus the shared action log the stub
// appends to (one file = one total order of what down really did):
//   - `cmux` — records `cmux <argv>` for EVERY invocation, and answers pane
//     DISCOVERY with `opts.panes` (absent → no kit pane is found). Mirrors
//     `run.test.ts`'s `makeUpStubs`; every other subcommand is a silent exit 0,
//     so a `close-surface` that DID happen would still be recorded.
function makeDownStubs(opts: { panes?: string } = {}): {
  binDir: string;
  log: string;
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-downstub-")));
  scratchDirs.push(dir);
  const log = join(dir, "actions.log");
  const binDir = join(dir, "bin");
  writeExecutable(
    binDir,
    "cmux",
    `#!/bin/sh
printf 'cmux %s\\n' "$*" >> ${log}
case "$*" in
  *list-pane-surfaces*) printf '%s' '${opts.panes ?? ""}' ; exit 0 ;;
  *list-panes*) printf '%s' '${opts.panes ?? ""}' ; exit 0 ;;
esac
exit 0
`
  );
  return { binDir, log };
}

// The stub's action log as ordered records (empty when nothing ran).
function stubRecords(log: string): string[] {
  if (!existsSync(log)) {
    return [];
  }
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

// Discovery records. The substring `list-pane` covers BOTH spellings the kit uses
// (`list-panes` / `list-pane-surfaces`), so the positive anchor holds whichever
// discovery call the implementation makes.
const cmuxDiscovery = (lines: string[]) =>
  lines.filter(
    (line) => line.startsWith("cmux ") && line.includes("list-pane")
  );

// Every cmux record that CLOSES — the load-bearing negative: `down` may list
// panes, and nothing else.
const cmuxCloses = (lines: string[]) =>
  lines.filter((line) => line.startsWith("cmux ") && line.includes(CLOSE_VERB));

// Where the plan stops listing its OWN actions and starts quoting what it hands
// over (-1 when it never does).
const firstAgentLine = (lines: string[]) =>
  lines.findIndex((line) => line.trimStart().startsWith("agent:"));

// The two kit panes a goal's workspace carries, as the discovery stub reports
// them: `<ref> <name>` per line. The refs are INVENTED HERE, so an instruction
// quoting them can only have got them from real discovery.
const RUN_REF = "surface:4";
const BROWSER_REF = "surface:5";
const bothKitPanes = (slug: string) =>
  `${RUN_REF} dobby-run-${slug}\n${BROWSER_REF} dobby-browser-${slug}\n`;

// Restore an env var to its pre-test value (unset when it was unset).
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

const originalCmux = process.env[CMUX];
const originalPath = process.env.PATH;

beforeEach(() => {
  // No cmux and no cmux binary on PATH: every slice that wants otherwise sets it
  // explicitly.
  delete process.env[CMUX];
  process.env.PATH = originalPath;
});

afterEach(() => {
  restoreEnv(CMUX, originalCmux);
  restoreEnv("PATH", originalPath);
});

afterAll(() => {
  restoreEnv(CMUX, originalCmux);
  restoreEnv("PATH", originalPath);
  for (const dir of scratchDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  scratchDirs.length = 0;
});

// --- Slice S1 (tracer bullet): the surface close comes back as an INSTRUCTION ---
// The headline change. Under cmux, `down` DISCOVERS the goal's kit panes and hands
// the close back as data — it closes nothing itself — and that is a SUCCESS.
describe("run() — `down --json` (cmux panes: the stop is handed back)", () => {
  it("exits 0 and reports ok:true with reason null when the goal's kit panes are open", async () => {
    const repo = makeRepo();
    const { binDir } = makeDownStubs({ panes: bothKitPanes(basename(repo)) });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--json"], repo);
    // Anti-tautology guard: `down` IS a known command — a red here must be the
    // absent `--json` behaviour, never an unimplemented command.
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = payloadOf(result.stdout);
    expect([payload.ok, payload.reason]).toEqual([true, null]);
  });

  it("echoes the cmux workspace id it ran under", async () => {
    const repo = makeRepo();
    const { binDir } = makeDownStubs({ panes: bothKitPanes(basename(repo)) });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--json"], repo);
    // Independent: the id WE injected into the environment.
    expect(payloadOf(result.stdout).cmux).toBe(CMUX_ID);
  });

  it("hands back exactly one instruction, the stop", async () => {
    const repo = makeRepo();
    const { binDir } = makeDownStubs({ panes: bothKitPanes(basename(repo)) });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--json"], repo);
    const payload = payloadOf(result.stdout);
    expect(topicsOf(payload)).toEqual(["stop"]);
    // Only APPLICABLE instructions are handed back at all.
    expect(instructionFor(payload, "stop").applies).toBe(true);
  });

  it("names the close command and every discovered kit surface in the stop text", async () => {
    const repo = makeRepo();
    const { binDir } = makeDownStubs({ panes: bothKitPanes(basename(repo)) });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--json"], repo);
    const stop = instructionFor(payloadOf(result.stdout), "stop");
    expect(stop.text).toContain(CLOSE_VERB);
    // The refs are the STUB's invention: quoting them proves real discovery.
    expect(stop.text).toContain(RUN_REF);
    expect(stop.text).toContain(BROWSER_REF);
  });

  it("discovers panes but never closes a cmux surface itself", async () => {
    const repo = makeRepo();
    const { binDir, log } = makeDownStubs({
      panes: bothKitPanes(basename(repo)),
    });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    await run(["down", "--json"], repo);
    const lines = stubRecords(log);
    // Positive anchor first, so the negative cannot pass on a run that never
    // reached cmux at all.
    expect(cmuxDiscovery(lines).length).toBeGreaterThan(0);
    expect(cmuxCloses(lines)).toEqual([]);
  });
});

// --- Slice S2: nothing to hand over when there is no surface to close -----------
// The instruction is reported only when it APPLIES: no kit pane under cmux, and
// no cmux at all, both mean an empty catalogue.
describe("run() — `down --json` (no applicable stop: an empty catalogue)", () => {
  it("hands back no instruction when cmux is present but the goal has no kit pane", async () => {
    const repo = makeRepo();
    const { binDir } = makeDownStubs();
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(payloadOf(result.stdout).instructions).toEqual([]);
  });

  it("hands back no instruction outside cmux and still cleans the run registry", async () => {
    // The terminal host's stop is not applicable — there is no surface to close —
    // but the pidfile cleanup is a mechanic `down` still PERFORMS.
    const repo = makeRepo({ devPid: `${DEAD_PID}\n` });
    const pidfile = join(repo, ".dobby", "dev.pid");
    expect(existsSync(pidfile)).toBe(true);
    const result = await run(["down", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = payloadOf(result.stdout);
    expect([payload.ok, payload.cmux]).toEqual([true, null]);
    expect(payload.instructions).toEqual([]);
    expect(existsSync(pidfile)).toBe(false);
  });

  it("carries exactly the six spec'd fields, with explicit nulls instead of omitted keys", async () => {
    const repo = makeRepo({ devPid: `${DEAD_PID}\n` });
    const result = await run(["down", "--json"], repo);
    const payload = payloadOf(result.stdout);
    expect(Object.keys(payload).sort()).toEqual(DOWN_JSON_FIELDS);
  });

  it("reports the absolute workroot and the goal slug of the repo it ran in", async () => {
    const repo = makeRepo({ devPid: `${DEAD_PID}\n` });
    const result = await run(["down", "--json"], repo);
    const payload = payloadOf(result.stdout);
    // Independent: the dir WE created, read back through node:fs/node:path.
    expect(payload.workroot).toBe(repo);
    expect(payload.slug).toBe(basename(repo));
  });
});

// --- Slice S3: the failure contract — enum reasons, `ok` ⇔ exit -----------------
// Every failure answers with the SAME shaped object on stdout and a nonzero exit,
// with the human prose (and any child output) on stderr.
describe("run() — `down --json` (failures keep the payload as the sole stdout)", () => {
  it("reports ok:false with reason 'not-a-git-repo' and exits 1 outside a git repository", async () => {
    const result = await run(["down", "--json"], makeNonGitDir());
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode).toBe(1);
    const payload = payloadOf(result.stdout);
    expect([payload.ok, payload.reason]).toEqual([false, "not-a-git-repo"]);
    expect(payload.instructions).toEqual([]);
  });

  it("keeps a succeeding teardown extra's output off stdout: the JSON object stays the sole stdout", async () => {
    // Two extras: one PRINTS the marker, one leaves a file behind. The file proves
    // the extras really ran (so the stdout assertion is not vacuous); the printed
    // marker belongs on stderr under --json.
    // SEAM LIMIT (flagged for the implementor): a child that INHERITS fd 1/2 writes
    // past the in-process capture seam, so the stderr assertion below only holds if
    // child output is forwarded through the seam's stderr writer rather than the
    // inherited fd — which is exactly the design this contract asks for.
    const marker = "tearing-down";
    const ranFile = "dobby-teardown-ran";
    const repo = makeRepo({
      config: { files: [], teardown: [`echo ${marker}`, `touch ${ranFile}`] },
    });
    const result = await run(["down", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(repo, ranFile))).toBe(true);
    expect(() => payloadOf(result.stdout)).not.toThrow();
    expect(result.stdout).not.toContain(marker);
    expect(result.stderr).toContain(marker);
  });

  it("reports ok:false with reason 'teardown-extra-failed' and exits nonzero when a teardown extra fails", async () => {
    // The failing extra is an EXECUTABLE this file writes (prints `boom`, exits 3),
    // referenced by absolute path — so the case holds whether extras are run through
    // a shell or spawned directly.
    const repo = makeRepo();
    const failing = writeExecutable(
      join(repo, "scripts"),
      "fail-teardown.sh",
      "#!/bin/sh\necho boom\nexit 3\n"
    );
    writeFileSync(
      join(repo, "dobby.config.json"),
      JSON.stringify({ files: [], teardown: [failing] }, null, 2)
    );
    const result = await run(["down", "--json"], repo);
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode).not.toBe(0);
    const payload = payloadOf(result.stdout);
    expect([payload.ok, payload.reason]).toEqual([
      false,
      "teardown-extra-failed",
    ]);
    expect(result.stderr).toContain("boom");
  });
});

// --- Slice S4: `--dry-run` QUOTES the stop, never plans the close ---------------
// The plan still lists the CLI actions `down` would run and quotes what it hands
// over under an `agent:` line — while the surface close it used to plan as its own
// action is gone, and nothing runs.
describe("run() — `down --dry-run` (the stop is quoted, the close is gone)", () => {
  it("quotes the stop under an `agent:` line, naming the close command and both surfaces", async () => {
    const repo = makeRepo();
    const { binDir } = makeDownStubs({ panes: bothKitPanes(basename(repo)) });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--dry-run"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(AGENT_LINE);
    const lines = result.stdout.split("\n");
    const agentAt = firstAgentLine(lines);
    for (const phrase of [CLOSE_VERB, RUN_REF, BROWSER_REF]) {
      const at = lines.findIndex((line) => line.includes(phrase));
      expect(at, `missing from the plan: ${phrase}`).toBeGreaterThan(-1);
      expect(
        at,
        `${phrase} is planned as an action, not handed over`
      ).toBeGreaterThan(agentAt);
    }
  });

  it("plans no cmux close of its own and closes nothing", async () => {
    const repo = makeRepo();
    const { binDir, log } = makeDownStubs({
      panes: bothKitPanes(basename(repo)),
    });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--dry-run"], repo);
    const lines = result.stdout.split("\n");
    const agentAt = firstAgentLine(lines);
    expect(agentAt, "expected an `agent:` hand-over line").toBeGreaterThan(-1);
    const strayActions = lines.filter(
      (line, index) => index < agentAt && line.includes(`cmux ${CLOSE_VERB}`)
    );
    expect(strayActions).toEqual([]);
    expect(cmuxCloses(stubRecords(log))).toEqual([]);
  });

  it("renders the JSON payload — not the text plan — when --json and --dry-run are combined", async () => {
    // Mirrors the precedent `up` already sets: with `--json` present the JSON
    // payload IS the rendering (`up --json --dry-run` answers with one object on
    // stdout, exit 0), and the README's dry-run invariant still holds — "the same
    // decisions, zero side effects" — so nothing is closed and the run registry is
    // left untouched.
    const repo = makeRepo({ devPid: `${DEAD_PID}\n` });
    const pidfile = join(repo, ".dobby", "dev.pid");
    const { binDir, log } = makeDownStubs({
      panes: bothKitPanes(basename(repo)),
    });
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["down", "--json", "--dry-run"], repo);
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = payloadOf(result.stdout);
    expect(topicsOf(payload)).toEqual(["stop"]);
    expect(cmuxCloses(stubRecords(log))).toEqual([]);
    expect(existsSync(pidfile)).toBe(true);
  });
});

// --- Slice S5: the default rendering is untouched -------------------------------
// The flag is additive: WITHOUT --json, `down` keeps its human rendering and never
// emits a JSON payload on stdout.
describe("run() — `down` without --json (human rendering unchanged)", () => {
  it("exits 0 with prose, not JSON, on a repo with nothing to clean", async () => {
    const repo = makeRepo();
    const result = await run(["down"], repo);
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(() => payloadOf(result.stdout)).toThrow();
  });
});
