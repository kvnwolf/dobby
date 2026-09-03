import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// TASK 10 — `dobby up --json` (the machine-readable up report) + `env` dbTasks.
//
// `up --json` emits ONE JSON object as the ONLY stdout, so `/dobby:execute`'s
// Step 2 and the verifier branch on DATA instead of parsing prose. The payload is
// flat, EnvSnapshot style (explicit nulls, alphabetized):
//   {ok, phase, reason, devUrl, verifyMode, degradedCommand, browserPane,
//    workroot, cmux, slug} — plus, since TASK 4 below, {instructions, live}
// and `reason` is an ENUM (never raw prose — the prose still goes to stderr):
//   not-a-git-repo | config-unreadable | install-failed | worktree-copy-failed |
//   setup-extra-failed | neon-creds-missing | liveness-timeout
// (`dev-start-failed` LEFT the enum with TASK 4: `up` starts nothing, so there is
// no start of its own that can fail.)
//
// Observed ONLY through the in-process `run(argv, cwd) -> {exitCode, stdout,
// stderr}` seam (ADR-0008: tests never spawn the bin); `lifecycle.ts` /
// `envinfo.ts` are never imported directly, so an internal refactor of the
// reason-mapping or the renderer cannot break these tests.
//
// INDEPENDENT SOURCES for every expected value below:
//   - The ten field names, the `phase` values, every `reason` token, the
//     `verifyMode` values, and the degraded command string
//     `DOBBY_SKIP_INSTALL=1 bunx dobby up` are LITERALS the spec (Decision 13 /
//     STATE.md "Resolved — up --json") states outright.
//   - `{ok:true, phase:"noop", verifyMode:"programmatic", browserPane:null}` for a
//     no-app repo and `{ok:false, reason:"install-failed", degradedCommand}` for
//     an install-failure fixture are the task's own VERIFY RECIPE.
//   - `workroot` / `slug` are read back from the temp dir WE created (node:fs
//     realpath + node:path basename — a DIFFERENT mechanism than the code's
//     `git rev-parse --show-toplevel`), and `cmux` is the id WE injected.
//   - The five `db:*` names are the documented drizzle short set (cli/README.md
//     "Inferred database tasks": db:generate / db:migrate / db:push / db:check /
//     db:studio) applied to a package.json WE hand-write.
//
// Every real `up` here runs against a NO-APP (or fail-fast) fixture, so no dev
// server, cmux, neon or portless call ever happens for real — except the ONE
// deliberate `bun install` of the install-failure fixture, whose dependency is an
// unresolvable `file:` path (fails offline, in milliseconds).
// ===========================================================================

const CMUX = "CMUX_WORKSPACE_ID";
const SKIP_INSTALL = "DOBBY_SKIP_INSTALL";
const LIVENESS_RETRIES = "DOBBY_LIVENESS_RETRIES";

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

// A throwaway git repo (git init is enough for the workroot to resolve), with an
// optional package.json (capabilities), dobby.config.json (valid or deliberately
// unparseable) and .env.local (neon creds). Returns the realpath-normalized root;
// its basename is the goal slug.
function makeRepo(
  opts: {
    brokenConfig?: boolean;
    config?: unknown;
    envLocal?: string;
    pkg?: unknown;
  } = {}
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-upjson-")));
  scratchDirs.push(dir);
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
  if (opts.pkg !== undefined) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(opts.pkg, null, 2));
  }
  if (opts.brokenConfig) {
    writeFileSync(join(dir, "dobby.config.json"), "{ this is not valid json");
  } else if (opts.config !== undefined) {
    writeFileSync(
      join(dir, "dobby.config.json"),
      JSON.stringify(opts.config, null, 2)
    );
  }
  if (opts.envLocal !== undefined) {
    writeFileSync(join(dir, ".env.local"), opts.envLocal);
  }
  return dir;
}

// A plain temp dir that is NOT a git repo — the not-a-git-repo failure path.
function makeNonGitDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-upjson-nogit-")));
  scratchDirs.push(dir);
  return dir;
}

// A stub `cmux` on PATH: every subcommand is a silent exit 0, so the workspace
// rename succeeds and pane DISCOVERY finds nothing (no cmux is reachable in CI).
function makeCmuxStubBin(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-upjson-stub-")));
  scratchDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "cmux");
  writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  chmodSync(stub, 0o755);
  return binDir;
}

// A project with NO app capability (drizzle only) — up finishes its setup phase
// and reports 'no app to run', starting nothing.
const NOAPP_PKG = {
  dependencies: { "drizzle-orm": "^0.30.0" },
  name: "upjson-noapp",
  private: true,
};

// An install that CANNOT succeed, offline and instantly: a `file:` dependency
// pointing at a path that does not exist (bun exits nonzero on resolution).
const INSTALL_FAIL_PKG = {
  dependencies: { "dobby-upjson-missing": "file:./does-not-exist" },
  name: "upjson-installfail",
  private: true,
};

// vite (app) + neon, so up passes the no-app gate and reaches the neon step; with
// no .env.local the creds are missing (the guaranteed-isolation hard failure).
const VITE_NEON_PKG = {
  dependencies: { "@neondatabase/serverless": "^0.9.0" },
  devDependencies: { vite: "^5.0.0" },
  name: "upjson-neon",
  private: true,
};

interface UpJson {
  browserPane: string | null;
  cmux: string | null;
  degradedCommand: string | null;
  devUrl: string | null;
  ok: boolean;
  phase: string;
  reason: string | null;
  slug: string | null;
  verifyMode: string;
  workroot: string;
}

// Parse the RAW (untrimmed) stdout: JSON.parse accepts only whitespace around the
// object, so a successful parse of the WHOLE stdout IS the "sole stdout" contract —
// one stray prose line and this throws.
const payloadOf = (stdout: string) => JSON.parse(stdout) as UpJson;

// The exact field set the spec enumerates, alphabetized (EnvSnapshot style:
// explicit nulls, never omitted keys — consumers branch on `browserPane === null`,
// which an absent key would make indistinguishable from "not reported").
const UP_JSON_FIELDS = [
  "browserPane",
  "cmux",
  "degradedCommand",
  "devUrl",
  "instructions",
  "live",
  "ok",
  "phase",
  "reason",
  "slug",
  "verifyMode",
  "workroot",
];

// The literal remedy the spec attaches to an install-phase failure ONLY.
const DEGRADED_COMMAND = "DOBBY_SKIP_INSTALL=1 bunx dobby up";

// Restore an env var to its pre-test value (unset when it was unset).
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

const originalCmux = process.env[CMUX];
const originalSkip = process.env[SKIP_INSTALL];
const originalRetries = process.env[LIVENESS_RETRIES];
const originalPath = process.env.PATH;

afterAll(() => {
  restoreEnv(CMUX, originalCmux);
  restoreEnv(SKIP_INSTALL, originalSkip);
  restoreEnv(LIVENESS_RETRIES, originalRetries);
  restoreEnv("PATH", originalPath);
  for (const dir of scratchDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  scratchDirs.length = 0;
});

beforeEach(() => {
  // No cmux, no real cmux binary, and the documented install seam ON: every slice
  // that wants otherwise sets it explicitly.
  delete process.env[CMUX];
  process.env.PATH = originalPath;
  process.env[SKIP_INSTALL] = "1";
  // Bound the liveness wait everywhere, so a mis-ordered implementation that
  // reaches the probe fails fast instead of sleeping through the production wait.
  process.env[LIVENESS_RETRIES] = "1";
});

// --- Slice J1 (tracer bullet): the payload IS the stdout ----------------------
// The headline contract: a skill runs `bunx dobby up --json` and reads ONE JSON
// object — nothing else on stdout, exit 0 on success.
describe("run() — `up --json` (machine-readable report)", () => {
  it("emits one parseable JSON object as the ONLY stdout and exits 0 for a project with no app", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    // Anti-tautology guard: an unimplemented `up --json` also exits nonzero via
    // other branches — assert this is the genuine up path.
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(() => payloadOf(result.stdout)).not.toThrow();
  });

  it("reports ok:true with phase 'noop' when there is no app to run", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.phase).toBe("noop");
  });

  it("carries exactly the twelve spec'd fields, with explicit nulls instead of omitted keys", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    expect(Object.keys(payload).sort()).toEqual(UP_JSON_FIELDS);
  });

  it("reports the absolute workroot and the goal slug of the repo it ran in", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    // Independent: the dir WE created, read back through node:fs/node:path.
    expect(payload.workroot).toBe(repo);
    expect(payload.slug).toBe(basename(repo));
  });

  it("reports devUrl null and verifyMode 'programmatic' for a project with no app", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    // A no-app project infers no dev command -> no URL to verify against, so the
    // verifier must be told to verify PROGRAMMATICALLY.
    expect(payload.devUrl).toBe(null);
    expect(payload.verifyMode).toBe("programmatic");
  });

  it("reports reason null and degradedCommand null on a successful up", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    expect(payload.reason).toBe(null);
    expect(payload.degradedCommand).toBe(null);
  });

  it("echoes the cmux workspace id and still reports browserPane null when no browser pane was opened", async () => {
    // browserPane is MANDATORY (execute's manual-setup gate and QA's
    // Rung 1 branch on it): a no-app project opens no browser pane, so the field
    // must be present and null even WITH cmux enrichment active.
    process.env[CMUX] = "cmux-ws-upjson";
    process.env.PATH = `${makeCmuxStubBin()}:${originalPath ?? ""}`;
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    // Independent: the id WE injected into the environment.
    expect(payload.cmux).toBe("cmux-ws-upjson");
    expect(payload.browserPane).toBe(null);
  });

  it("keeps setup-phase child output off stdout: the JSON object stays the sole stdout", async () => {
    // A setup[] extra that PRINTS plus one that leaves a file behind. The file
    // proves the extras really ran (so the stdout assertion is not vacuous); the
    // printed marker must never reach stdout — under --json child output belongs
    // on stderr (or in the pane).
    // SEAM LIMIT (flagged for the reviewer): a child that inherits fd 1 writes
    // past the in-process capture seam, so this catches the implementation
    // capturing child output and re-emitting it on dobby's OWN stdout — the
    // fd-level redirection itself is a live-recipe/human-smoke check, like the
    // other spawn mechanics this repo leaves out of CI.
    const marker = "dobby-upjson-child-marker";
    const ranFile = "dobby-upjson-extra-ran";
    const repo = makeRepo({
      config: { files: [], setup: [`echo ${marker}`, `touch ${ranFile}`] },
      pkg: NOAPP_PKG,
    });
    const result = await run(["up", "--json"], repo);
    expect(existsSync(join(repo, ranFile))).toBe(true);
    expect(result.stdout).not.toContain(marker);
    expect(() => payloadOf(result.stdout)).not.toThrow();
  });
});

// --- Slice J2: the failure contract — enum reasons, nonzero exit, prose aside ---
// Every failure path answers with the SAME shaped object (`ok:false` + an enum
// reason) on stdout and a nonzero exit code, with the human message on stderr.
describe("run() — `up --json` (failure reasons are an enum, never prose)", () => {
  it("reports ok:false with reason 'install-failed' and exits nonzero when the install step fails", async () => {
    // The one deliberate real `bun install`: its dependency is an unresolvable
    // `file:` path, so it fails offline and instantly.
    delete process.env[SKIP_INSTALL];
    const repo = makeRepo({ pkg: INSTALL_FAIL_PKG });
    const result = await run(["up", "--json"], repo);
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode).not.toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("install-failed");
  });

  it("offers the DOBBY_SKIP_INSTALL degraded command when the install failed", async () => {
    delete process.env[SKIP_INSTALL];
    const repo = makeRepo({ pkg: INSTALL_FAIL_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    expect(payload.degradedCommand).toBe(DEGRADED_COMMAND);
  });

  it("reports phase 'setup' when the failure happened before the run phase", async () => {
    delete process.env[SKIP_INSTALL];
    const repo = makeRepo({ pkg: INSTALL_FAIL_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = payloadOf(result.stdout);
    expect(payload.phase).toBe("setup");
  });

  it("keeps the failure payload as the sole stdout and sends the human message to stderr", async () => {
    delete process.env[SKIP_INSTALL];
    const repo = makeRepo({ pkg: INSTALL_FAIL_PKG });
    const result = await run(["up", "--json"], repo);
    // stdout: the object and nothing else (a parse of the raw stdout proves it)...
    expect(() => payloadOf(result.stdout)).not.toThrow();
    // ...while the prose explaining WHAT broke is still emitted, on stderr.
    expect(result.stderr.trim()).not.toBe("");
  });

  it("reports reason 'setup-extra-failed' with NO degraded command when a config setup[] extra fails", async () => {
    // `false` exits nonzero inside the setup phase. The degraded command is an
    // INSTALL-phase remedy only — re-running with DOBBY_SKIP_INSTALL=1 would not
    // help here, so the field must stay null.
    const repo = makeRepo({
      config: { files: [], setup: ["false"] },
      pkg: NOAPP_PKG,
    });
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode).not.toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.reason).toBe("setup-extra-failed");
    expect(payload.degradedCommand).toBe(null);
  });

  it("reports ok:false with reason 'not-a-git-repo' and exits nonzero outside a git repository", async () => {
    const result = await run(["up", "--json"], makeNonGitDir());
    expect(result.exitCode).not.toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("not-a-git-repo");
  });

  it("reports ok:false with reason 'config-unreadable' when dobby.config.json cannot be parsed", async () => {
    const repo = makeRepo({ brokenConfig: true, pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode).not.toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("config-unreadable");
  });

  it("reports ok:false with reason 'neon-creds-missing' for a neon project with no creds (no silent main-DB fallback)", async () => {
    const repo = makeRepo({ pkg: VITE_NEON_PKG });
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode).not.toBe(0);
    const payload = payloadOf(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("neon-creds-missing");
  });
});

// --- Slice J3: the default rendering is untouched -------------------------------
// The flag is additive: WITHOUT --json, `up` keeps printing its human report and
// never emits a JSON payload on stdout.
describe("run() — `up` without --json (human rendering unchanged)", () => {
  it("still reports 'no app to run' as prose and emits no JSON object on stdout", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up"], repo);
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/no app to run/i);
    expect(() => payloadOf(result.stdout)).toThrow();
  });
});

// --- Slice J4: `env` gains dbTasks ----------------------------------------------
// The environment snapshot carries the INFERRED db:* task names, so a consumer
// (migrate verify, and any skill that needs them) reads them instead of guessing.
// drizzle is the one db tool -> the five documented short names; no drizzle -> [].
describe("run() — `env` (inferred db:* task names)", () => {
  const DRIZZLE_PKG = {
    dependencies: { "drizzle-orm": "^0.30.0" },
    name: "upjson-env-drizzle",
    private: true,
  };
  const NO_DB_PKG = {
    devDependencies: { vitest: "^2.0.0" },
    name: "upjson-env-nodb",
    private: true,
  };

  // `key: value` text lines -> a map (split on the FIRST colon, so a value like
  // "db:push, db:studio" survives intact).
  function parseEnvText(stdout: string): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {};
    for (const line of stdout.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) {
        continue;
      }
      map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return map;
  }

  it("--json carries dbTasks as the five inferred drizzle short names", async () => {
    const repo = makeRepo({ pkg: DRIZZLE_PKG });
    const result = await run(["env", "--json"], repo);
    expect(result.exitCode).toBe(0);
    const snapshot = JSON.parse(result.stdout) as { dbTasks: string[] };
    // Independent: the documented drizzle task set (cli/README.md), asserted as a
    // SET — the spec fixes the names, not their order.
    expect([...snapshot.dbTasks].sort()).toEqual([
      "db:check",
      "db:generate",
      "db:migrate",
      "db:push",
      "db:studio",
    ]);
  });

  it("--json carries dbTasks as an empty array for a project without the drizzle capability", async () => {
    const repo = makeRepo({ pkg: NO_DB_PKG });
    const result = await run(["env", "--json"], repo);
    expect(result.exitCode).toBe(0);
    const snapshot = JSON.parse(result.stdout) as { dbTasks: string[] };
    expect(snapshot.dbTasks).toEqual([]);
  });

  it("text output names the inferred db tasks for a drizzle project", async () => {
    const repo = makeRepo({ pkg: DRIZZLE_PKG });
    const result = await run(["env"], repo);
    expect(result.exitCode).toBe(0);
    const value = parseEnvText(result.stdout).dbTasks;
    expect(value, "missing field: dbTasks").toBeDefined();
    expect(value).toContain("db:push");
    expect(value).toContain("db:studio");
  });

  it("text output still carries the dbTasks field, naming no task, without the drizzle capability", async () => {
    const repo = makeRepo({ pkg: NO_DB_PKG });
    const result = await run(["env"], repo);
    expect(result.exitCode).toBe(0);
    const value = parseEnvText(result.stdout).dbTasks;
    expect(value, "missing field: dbTasks").toBeDefined();
    expect(value).not.toContain("db:");
  });
});

// ===========================================================================
// TASK 4 — `up` RETURNS INSTRUCTIONS instead of starting.
//
// `up` no longer starts, opens, sends to, closes or renames anything. After the
// setup phase its ONLY executed mechanics are: ONE liveness probe (`curl`),
// reading `.dobby/dev.pid`, cmux pane DISCOVERY (so an instruction can embed a
// surface ref), and — under the `neon` capability only — branch provisioning.
// Everything it used to DO comes back as DATA: `UpFacts` gains
// `instructions: {topic, applies, text}[]` (rename first under cmux, then start
// when the devUrl is not live) and `live: boolean`.
//
// SEAM: exactly one — `run(argv, cwd) -> {exitCode, stdout, stderr}`, in-process.
// `lifecycle.ts`, `environment.ts`, `pidfile.ts` and the adapters are NEVER
// imported here, so how the catalogue is assembled can be restructured freely;
// only what `up --json` REPORTS can break these cases.
//
// INDEPENDENT SOURCES for every expected value below:
//   - the two new field names, the twelve-key set, the instruction shape, the
//     topic ORDER (`rename` then `start`), the `phase` values, the
//     `liveness-timeout` reason and the exit codes are LITERALS the task spec
//     states outright;
//   - every asserted PHRASE (`run_in_background`, `bunx dobby dev`, `cmux send`,
//     `new-pane`, `rename-workspace --workspace w1`) is a literal the spec names
//     for that topic's text;
//   - `w1` is the workspace id WE inject; `surface:4` is invented by the cmux
//     STUB THIS file writes, so an instruction carrying it proves real discovery;
//   - the slug is `basename()` of the temp dir WE created (node:path — a
//     different mechanism than the code's git top-level resolution);
//   - `2147483647` (2^31-1) is above any live pid on darwin/linux, so it is
//     unreachable BY CONSTRUCTION; `00:03` is three seconds by the POSIX
//     `[[dd-]hh:]mm:ss` format, computed by hand, well inside the 15-second
//     ownership window;
//   - the log record prefixes (`curl-ok` / `curl-fail` / `cmux ` / `ps ` /
//     `bunx `) are written by the stubs THIS file installs, never by the code
//     under test.
//
// The stub builder below mirrors `run.test.ts`'s `makeUpStubs` (one shared
// `actions.log` = one total order of what `up` really did). It is duplicated
// rather than shared because this task may touch only these two test files —
// flagged for the implementor/reviewer as a lift-to-`test-helpers.ts` candidate.
// ===========================================================================

// The dev-start line `up` must never run itself (asserted as a NEGATIVE on the
// `bunx` recorder: nothing is spawned to start the app any more).
const DEV_START_LINE = "dobby dev";
// A probe count no run reaches: the stub `curl` then NEVER succeeds.
const NEVER_SUCCEEDS = 999;
// The cmux workspace id every cmux case runs under — echoed verbatim in the
// `--workspace w1` fragment the rename instruction must carry.
const CMUX_ID = "w1";
// A pid above any live process on darwin/linux: unreachable by construction.
const DEAD_PID = "2147483647";
// What the `ps` stub reports for an OWNED run process (contains `dobby dev`)…
const OWNED_COMMAND = "bun /w/node_modules/.bin/dobby dev";
// …and for a process that is emphatically NOT a dobby run.
const FOREIGN_COMMAND = "sleep 300";
// Elapsed time in the POSIX `mm:ss` form: three seconds.
const FRESH_ETIME = "00:03";
// The cmux commands `up` may only ever INSTRUCT, never invoke.
const ACTING_CMUX = [
  "send",
  "new-pane",
  "rename-tab",
  "rename-workspace",
  "close-surface",
];
// The plan's hand-over marker: an instruction is QUOTED under a line beginning
// `agent:`, never rendered as a CLI action line.
const AGENT_LINE = /^\s*agent:/m;
// The action-line literals the old EXECUTING `up` printed, which must be gone.
const DETACHED_LITERALS = ["spawn detached", "nohup"];

// A vite-only package.json (the app capability that gets past up's no-app gate),
// with NO neon signal so the run phase is reached without creds.
const VITE_PKG = {
  devDependencies: { vite: "^5.0.0" },
  name: "upjson-app",
  private: true,
};

interface Instruction {
  applies: boolean;
  text: string;
  topic: string;
}

interface UpFactsJson extends UpJson {
  instructions: Instruction[];
  live: boolean;
}

const factsOf = (stdout: string) => JSON.parse(stdout) as UpFactsJson;

// The topics `up` handed back, in order — the assertion surface pinning BOTH
// which instructions apply and their sequence in one line.
function topicsOf(payload: UpFactsJson): string[] {
  const list = payload.instructions;
  return Array.isArray(list) ? list.map((entry) => entry.topic) : [];
}

// One handed-back instruction by topic (a readable failure when it is absent).
function instructionFor(payload: UpFactsJson, topic: string): Instruction {
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

// The stubs' shared action log as ordered records (empty when nothing ran).
function stubRecords(log: string): string[] {
  if (!existsSync(log)) {
    return [];
  }
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const curlProbes = (lines: string[]) =>
  lines.filter((line) => line.startsWith("curl-")).length;

// Every cmux record that ACTS (as opposed to discovering) — the load-bearing
// negative: `up` may list panes, and nothing else.
const cmuxActions = (lines: string[]) =>
  lines.filter(
    (line) =>
      line.startsWith("cmux ") &&
      ACTING_CMUX.some((verb) => line.includes(verb))
  );

// Where the plan stops listing its OWN actions and starts quoting what it hands
// over (-1 when it never does).
const firstAgentLine = (lines: string[]) =>
  lines.findIndex((line) => line.trimStart().startsWith("agent:"));

const cmuxDiscovery = (lines: string[]) =>
  lines.filter(
    (line) => line.startsWith("cmux ") && line.includes("list-pane")
  );

// Build the stub bin dir a REAL `up` run needs, plus the shared action log every
// stub appends to (one file = one total order of what up did):
//   - `cmux`     — records its argv; answers pane discovery with `opts.panes`
//                  (absent → no kit pane is found).
//   - `curl`     — records `curl-ok` / `curl-fail` per probe, succeeding from the
//                  `succeedFrom`-th call on.
//   - `ps`       — optional; answers the two ownership probes for ONE pid.
//   - `bunx`     — a pure recorder: `up` must never spawn anything through it
//                  (it also keeps a regression from fetching the foreign npm
//                  `dobby` in a temp dir with no node_modules).
//   - `portless` — a safety net so devUrl stays non-null if dobby's bundled
//                  resolution ever fails.
function makeUpStubs(opts: {
  panes?: string;
  ps?: { command: string; pid: number };
  succeedFrom: number;
}): { binDir: string; log: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-upjson-stubs-")));
  scratchDirs.push(dir);
  const log = join(dir, "actions.log");
  const counter = join(dir, "curl.count");
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });

  const writeStub = (name: string, body: string) => {
    const path = join(binDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };

  writeStub(
    "cmux",
    `#!/bin/sh
printf 'cmux %s\\n' "$*" >> ${log}
case "$*" in
  *list-pane-surfaces*) printf '%s' '${opts.panes ?? ""}' ;;
  *list-panes*) printf 'pane:1\\n' ;;
esac
exit 0
`
  );
  writeStub(
    "curl",
    `#!/bin/sh
n=$(cat ${counter} 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > ${counter}
if [ "$n" -ge ${opts.succeedFrom} ]; then
  printf 'curl-ok %s\\n' "$*" >> ${log}
  exit 0
fi
printf 'curl-fail %s\\n' "$*" >> ${log}
exit 1
`
  );
  writeStub(
    "bunx",
    `#!/bin/sh
printf 'bunx %s\\n' "$*" >> ${log}
exit 0
`
  );
  writeStub(
    "portless",
    `#!/bin/sh
printf 'https://stub-dev.localhost\\n'
exit 0
`
  );
  if (opts.ps !== undefined) {
    writeStub(
      "ps",
      `#!/bin/sh
printf 'ps %s\\n' "$*" >> ${log}
case "$*" in
  *${opts.ps.pid}*) ;;
  *) exit 1 ;;
esac
case "$*" in
  *command*) printf '%s\\n' '${opts.ps.command}' ; exit 0 ;;
  *etime*) printf '%s\\n' '  ${FRESH_ETIME}' ; exit 0 ;;
esac
exit 1
`
    );
  }
  return { binDir, log };
}

// Register `pid` in the workroot's `.dobby/dev.pid` RIGHT NOW: the write stamps
// the file's mtime, which is the reference point the 15-second ownership window
// is measured against — so it happens inside the test body, never in a shared
// fixture that could drift out of the window.
function registerDevPid(repo: string, pid: string): void {
  mkdirSync(join(repo, ".dobby"), { recursive: true });
  writeFileSync(join(repo, ".dobby", "dev.pid"), `${pid}\n`);
}

// --- Slice J5 (tracer bullet): nothing is starting → `up` hands the start over --
// The headline change. With the app not answering and no start in flight, `up`
// probes ONCE, reports `live:false`, and returns the start INSTRUCTION for the
// model to run — it no longer spawns anything itself, and this is a SUCCESS.
describe("run() — `up --json` (nothing running: the start is handed back)", () => {
  let repo: string;
  let log: string;

  beforeEach(() => {
    repo = makeRepo({ pkg: VITE_PKG });
    const { binDir, log: actions } = makeUpStubs({
      succeedFrom: NEVER_SUCCEEDS,
    });
    log = actions;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  });

  it("exits 0 and reports ok:true with phase 'run' when the app is not answering", async () => {
    const result = await run(["up", "--json"], repo);
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = factsOf(result.stdout);
    expect([payload.ok, payload.phase]).toEqual([true, "run"]);
  });

  it("reports live:false when the devUrl never answered the probe", async () => {
    const result = await run(["up", "--json"], repo);
    expect(factsOf(result.stdout).live).toBe(false);
  });

  it("hands back exactly one instruction, the start", async () => {
    const result = await run(["up", "--json"], repo);
    expect(topicsOf(factsOf(result.stdout))).toEqual(["start"]);
  });

  it("carries the terminal host's background-job start line in the instruction text", async () => {
    const result = await run(["up", "--json"], repo);
    const start = instructionFor(factsOf(result.stdout), "start");
    expect(start.applies).toBe(true);
    expect(start.text).toContain("run_in_background");
    expect(start.text).toContain("bunx dobby dev");
  });

  it("probes the devUrl exactly once when no start is in flight", async () => {
    await run(["up", "--json"], repo);
    // The retry loop belongs to a start that is ALREADY in flight; with nothing
    // starting there is nothing to wait for.
    expect(curlProbes(stubRecords(log))).toBe(1);
  });

  it("starts nothing itself: no dev spawn and no run registered in .dobby/dev.pid", async () => {
    await run(["up", "--json"], repo);
    const started = stubRecords(log).filter(
      (line) => line.startsWith("bunx ") && line.includes(DEV_START_LINE)
    );
    // Whoever RUNS the instruction owns the registry; `up` only ever reads it, so
    // a pidfile appearing after an `up` means `up` started the app itself.
    expect([
      started.length,
      existsSync(join(repo, ".dobby", "dev.pid")),
    ]).toEqual([0, false]);
  });
});

// --- Slice J6: under cmux the rename comes first, then the start ---------------
// cmux enrichment adds the workspace rename — as an INSTRUCTION, ordered before
// the start — and pane DISCOVERY is the one cmux call `up` may make: the start
// text is written around the discovered `dobby-run-<slug>` surface ref.
describe("run() — `up --json` (cmux enrichment: rename then start, both handed back)", () => {
  let repo: string;
  let log: string;

  beforeEach(() => {
    repo = makeRepo({ pkg: VITE_PKG });
    const { binDir, log: actions } = makeUpStubs({
      panes: `surface:4 dobby-run-${basename(repo)}\n`,
      succeedFrom: NEVER_SUCCEEDS,
    });
    log = actions;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
  });

  it("hands back the rename before the start, both flagged as applicable", async () => {
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = factsOf(result.stdout);
    expect(topicsOf(payload)).toEqual(["rename", "start"]);
    // Only APPLICABLE instructions are reported at all — a not-applicable topic is
    // left out, never handed back with `applies:false`.
    expect(payload.instructions.every((entry) => entry.applies)).toBe(true);
  });

  it("names the workspace rename against the injected workspace id and the goal slug", async () => {
    const result = await run(["up", "--json"], repo);
    const rename = instructionFor(factsOf(result.stdout), "rename");
    expect(rename.text).toContain(`rename-workspace --workspace ${CMUX_ID}`);
    expect(rename.text).toContain(basename(repo));
  });

  it("writes the start around the DISCOVERED run pane instead of creating one", async () => {
    const result = await run(["up", "--json"], repo);
    const start = instructionFor(factsOf(result.stdout), "start");
    expect(start.text).toContain("cmux send");
    expect(start.text).toContain("surface:4");
    expect(start.text).not.toContain("new-pane");
  });

  it("discovers panes but never opens, sends to, renames or closes a cmux surface", async () => {
    await run(["up", "--json"], repo);
    const lines = stubRecords(log);
    // Positive anchor first, so the negative cannot pass on a run that never
    // reached cmux at all.
    expect(cmuxDiscovery(lines).length).toBeGreaterThan(0);
    expect(cmuxActions(lines)).toEqual([]);
  });
});

// --- Slice J7: a start ALREADY in flight is waited out --------------------------
// The one path that still waits: `.dobby/dev.pid` holds a LIVE, OWNED process, so
// a start the model launched is booting — `up` re-probes until it answers, and
// gives up with the `liveness-timeout` reason when it never does. A pid that is
// dead, or alive but not a dobby run, means nothing is starting.
describe("run() — `up --json` (a start in flight: the probe retries)", () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    // Never leak a `sleep` out of the suite, whatever the assertions did.
    child?.kill("SIGKILL");
    child = undefined;
  });

  // A real, long-lived child, its pid registered FRESH — the only honest way to
  // present `up` with a live, owned run process.
  function withRunInFlight(opts: { command: string; succeedFrom: number }): {
    log: string;
    repo: string;
  } {
    const repo = makeRepo({ pkg: VITE_PKG });
    child = spawn("sleep", ["300"], { stdio: "ignore" });
    const { pid } = child;
    if (pid === undefined) {
      throw new Error("test fixture: the long-lived child failed to spawn");
    }
    const stubs = makeUpStubs({
      ps: { command: opts.command, pid },
      succeedFrom: opts.succeedFrom,
    });
    process.env.PATH = `${stubs.binDir}:${originalPath ?? ""}`;
    registerDevPid(repo, String(pid));
    return { log: stubs.log, repo };
  }

  it("reports live:true once a retried probe answers, with nothing left to instruct", async () => {
    process.env[LIVENESS_RETRIES] = "5";
    const { repo } = withRunInFlight({
      command: OWNED_COMMAND,
      succeedFrom: 3,
    });
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = factsOf(result.stdout);
    expect([payload.live, topicsOf(payload).join(",")]).toEqual([true, ""]);
  });

  it("keeps probing until the app answers (three probes for a third-probe boot)", async () => {
    process.env[LIVENESS_RETRIES] = "5";
    const { log, repo } = withRunInFlight({
      command: OWNED_COMMAND,
      succeedFrom: 3,
    });
    await run(["up", "--json"], repo);
    expect(curlProbes(stubRecords(log))).toBe(3);
  });

  it("reports ok:false with reason 'liveness-timeout' and exits nonzero when the in-flight start never answers", async () => {
    const { repo } = withRunInFlight({
      command: OWNED_COMMAND,
      succeedFrom: NEVER_SUCCEEDS,
    });
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode).not.toBe(0);
    const payload = factsOf(result.stdout);
    expect([payload.ok, payload.reason]).toEqual([false, "liveness-timeout"]);
  });

  it("treats a live pid that is NOT a dobby run as nothing starting: one probe, the start handed back", async () => {
    const { log, repo } = withRunInFlight({
      command: FOREIGN_COMMAND,
      succeedFrom: NEVER_SUCCEEDS,
    });
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = factsOf(result.stdout);
    expect([payload.live, topicsOf(payload).join(",")]).toEqual([
      false,
      "start",
    ]);
    expect(curlProbes(stubRecords(log))).toBe(1);
  });

  it("treats a registered pid that is gone as nothing starting: one probe, the start handed back", async () => {
    const repo = makeRepo({ pkg: VITE_PKG });
    const stubs = makeUpStubs({ succeedFrom: NEVER_SUCCEEDS });
    process.env.PATH = `${stubs.binDir}:${originalPath ?? ""}`;
    registerDevPid(repo, DEAD_PID);
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = factsOf(result.stdout);
    expect([payload.live, topicsOf(payload).join(",")]).toEqual([
      false,
      "start",
    ]);
    expect(curlProbes(stubRecords(stubs.log))).toBe(1);
  });
});

// --- Slice J8: the no-app project under cmux still gets its rename --------------
// The rename is INDEPENDENT of the app gate: a project with nothing to run still
// carries the goal identity into the workspace title — as an instruction.
describe("run() — `up --json` (no app under cmux: the rename is the only instruction)", () => {
  it("reports phase 'noop' with live:false and hands back only the rename", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const stubs = makeUpStubs({
      panes: `surface:4 dobby-run-${basename(repo)}\n`,
      succeedFrom: NEVER_SUCCEEDS,
    });
    process.env.PATH = `${stubs.binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
    const result = await run(["up", "--json"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = factsOf(result.stdout);
    expect([payload.phase, payload.live]).toEqual(["noop", false]);
    expect(topicsOf(payload)).toEqual(["rename"]);
  });

  it("hands back an empty instruction list for a no-app project outside cmux", async () => {
    const repo = makeRepo({ pkg: NOAPP_PKG });
    const result = await run(["up", "--json"], repo);
    const payload = factsOf(result.stdout);
    expect([payload.live, topicsOf(payload).length]).toEqual([false, 0]);
  });
});

// --- Slice J9: `--dry-run` QUOTES the instructions, never plans the mechanics ---
// The plan still lists the CLI actions `up` would run (the setup phase, the
// probe) and quotes every instruction it would hand over under an `agent:` line —
// while the pane/detached mechanics it used to plan are gone, and nothing runs.
describe("run() — `up --dry-run` (instructions are quoted, mechanics are gone)", () => {
  let repo: string;
  let log: string;

  beforeEach(() => {
    repo = makeRepo({ pkg: VITE_PKG });
    const { binDir, log: actions } = makeUpStubs({
      succeedFrom: NEVER_SUCCEEDS,
    });
    log = actions;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env[CMUX] = CMUX_ID;
  });

  it("quotes the instructions it would hand over under an `agent:` line", async () => {
    const result = await run(["up", "--dry-run"], repo);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(AGENT_LINE);
  });

  it("shows the workspace rename and the dev start INSIDE that hand-over, never as its own actions", async () => {
    const result = await run(["up", "--dry-run"], repo);
    const lines = result.stdout.split("\n");
    const agentAt = firstAgentLine(lines);
    expect(agentAt, "expected an `agent:` hand-over line").toBeGreaterThan(-1);
    for (const phrase of [
      `rename-workspace --workspace ${CMUX_ID}`,
      "bunx dobby dev",
    ]) {
      const at = lines.findIndex((line) => line.includes(phrase));
      expect(at, `missing from the plan: ${phrase}`).toBeGreaterThan(-1);
      expect(
        at,
        `${phrase} is planned as an action, not handed over`
      ).toBeGreaterThan(agentAt);
    }
  });

  it("plans no cmux command of its own: every acting cmux line sits inside the hand-over", async () => {
    const result = await run(["up", "--dry-run"], repo);
    const lines = result.stdout.split("\n");
    const agentAt = firstAgentLine(lines);
    expect(agentAt, "expected an `agent:` hand-over line").toBeGreaterThan(-1);
    const strayActions = lines.filter(
      (line, index) =>
        index < agentAt &&
        ACTING_CMUX.some((verb) => line.includes(`cmux ${verb}`))
    );
    expect(strayActions).toEqual([]);
  });

  it("plans no detached spawn of its own on the plain terminal host", async () => {
    // The terminal host is where the old `up` spawned a detached `dobby dev`
    // itself; now it hands the background-job instruction over instead.
    Reflect.deleteProperty(process.env, CMUX);
    const result = await run(["up", "--dry-run"], repo);
    // Positive anchor: a real plan IS produced, so the negatives hold against a
    // non-empty rendering.
    expect(result.stdout).toContain("bunx dobby dev");
    expect(result.stdout).toMatch(AGENT_LINE);
    for (const literal of DETACHED_LITERALS) {
      expect(result.stdout, `plan still carries: ${literal}`).not.toContain(
        literal
      );
    }
  });

  it("executes nothing: no probe and no cmux action are recorded", async () => {
    await run(["up", "--dry-run"], repo);
    const lines = stubRecords(log);
    expect(curlProbes(lines)).toBe(0);
    expect(cmuxActions(lines)).toEqual([]);
  });
});
