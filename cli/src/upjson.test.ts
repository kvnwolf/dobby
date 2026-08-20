import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
//    workroot, cmux, slug}
// and `reason` is an ENUM (never raw prose — the prose still goes to stderr):
//   not-a-git-repo | config-unreadable | install-failed | worktree-copy-failed |
//   setup-extra-failed | neon-creds-missing | dev-start-failed | liveness-timeout
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

  it("carries exactly the ten spec'd fields, with explicit nulls instead of omitted keys", async () => {
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
