import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  mkStubBin,
  mkStubBinDir,
  restoreEnv,
  stubPath,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// Real git spawns plus a real child process under full-suite parallelism.
useSpawnBudget();

// ===========================================================================
// TASK 1 — `pidfile.ts` owns the run-process registry.
//
// The run-process registry moves out of `environment.ts` into its own module,
// and ONE behaviour changes with the move: `killFromPidfile` signals the bare
// `pid` instead of the process group `-pid`, because a model-launched
// `dobby dev` is NOT guaranteed to lead a process group (`dev`'s own SIGTERM
// handler tears its children down).
//
// SEAM: exactly one — `run(argv, cwd) -> {exitCode, stdout, stderr}`, exercised
// IN-PROCESS. `pidfile.ts`, `lifecycle.ts` and `environment.ts` are NEVER
// imported here, so moving the helpers between modules, renaming them, or
// restructuring `down`'s plan cannot break these tests. Everything is observed
// through the command's exit code, its stdout, and the effects it leaves on the
// filesystem and on a real child process.
//
// INDEPENDENT SOURCES for every expected value below:
//   - `2147483647` (2^31-1) is a literal far above any live pid on darwin/linux,
//     so it is unreachable BY CONSTRUCTION — not because some code said so.
//   - `.dobby/dev.pid` is the registry path the spec names; exit code 0 and
//     "the file is gone" are the spec's own words for the stale/cleanup path.
//   - The ownership rule is the spec's: the process's `ps -o command=` output
//     contains `dobby dev` AND its `ps -o etime=` start time is within 15s of
//     the pidfile's mtime. `00:03` is 3 seconds by the POSIX `[[dd-]hh:]mm:ss`
//     format — computed BY HAND from the format, never from dobby's parser.
//   - The `pid`-not-`-pid` expectation is proven by CONSTRUCTION, not by
//     reading the code: the child is spawned WITHOUT `detached`, so it is not a
//     process-group leader and no process group carries its pid as a gid. A
//     `kill(-pid)` would therefore fail with ESRCH and leave it alive. A DEAD
//     child is only possible if the bare `pid` was signalled.
//
// SAFETY: `kill(-pid)` on this child can never reach the test runner — the
// child sits in vitest's own process group, whose gid is the runner's pid, not
// the child's.
// ===========================================================================

const CMUX = "CMUX_WORKSPACE_ID";

// A vite-only package.json: the app capability, with NO neon signal and no
// `dobby.config.json`, so a real `down` here runs the pidfile path and nothing
// else (no panes — CMUX is unset — no neon branch, no teardown[] extras).
const VITE_PKG = {
  devDependencies: { vite: "^5.0.0" },
  name: "pidfile-app",
  private: true,
};

// A pid far above any live pid on darwin/linux (2^31-1): unreachable by
// construction, which is what makes it the STALE case.
const UNREACHABLE_PID = "2147483647";

// The registry path the spec names, relative to the workroot.
const PIDFILE_REL = ".dobby/dev.pid";

// How long a signalled child is given to die before we call it alive. Generous
// because the suite runs under full-parallelism contention; a healthy SIGTERM
// lands in single-digit milliseconds.
const EXIT_WAIT_MS = 5000;

// How long a process is given to prove it SURVIVED. Short on purpose: this is a
// negative wait, paid on every passing run.
const SETTLE_MS = 300;

// What the `ps` stub reports as the registered process's command line. Contains
// `dobby dev`, so the spec's ownership check PASSES.
const OWNED_COMMAND = "bun /w/node_modules/.bin/dobby dev";
// The same slot for a process that is emphatically NOT a dobby run: ownership
// must FAIL and the process must never be signalled.
const FOREIGN_COMMAND = "sleep 300";
// Elapsed time in the POSIX `mm:ss` form: three seconds, well inside the spec's
// 15-second window around the pidfile's mtime.
const FRESH_ETIME = "00:03";

describe("run() — down command (the run-process registry)", () => {
  const dirs: string[] = [];
  let child: ChildProcess | undefined;
  let originalCmux: string | undefined;

  beforeEach(() => {
    originalCmux = process.env[CMUX];
    Reflect.deleteProperty(process.env, CMUX);
  });

  afterEach(() => {
    restoreEnv(CMUX, originalCmux);
    // Never leak a `sleep` out of the suite, whatever the assertions did.
    child?.kill("SIGKILL");
    child = undefined;
  });

  afterAll(() => {
    cleanupDirs(dirs);
    dirs.length = 0;
  });

  it("removes the registry file and exits 0 when the registered pid is unreachable", async () => {
    const repo = makeRepo(dirs);
    const pidfile = registerPid(repo, UNREACHABLE_PID);
    expect(existsSync(pidfile)).toBe(true);

    const result = await run(["down"], repo);

    expect([result.exitCode, existsSync(pidfile)]).toEqual([0, false]);
  });

  it("terminates a live, owned run process that does not lead a process group", async () => {
    const repo = makeRepo(dirs);
    child = startLongLivedProcess();
    const pid = pidOf(child);
    const pidfile = registerPid(repo, String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    await withStubPath(binDir, () => run(["down"], repo));
    await exited(child, EXIT_WAIT_MS);

    expect([existsSync(pidfile), isRunning(pid)]).toEqual([false, false]);
  });

  it("leaves a live process alone when its command line is not a dobby run", async () => {
    const repo = makeRepo(dirs);
    child = startLongLivedProcess();
    const pid = pidOf(child);
    registerPid(repo, String(pid));
    const binDir = makePsStub(dirs, { command: FOREIGN_COMMAND, pid });

    await withStubPath(binDir, () => run(["down"], repo));
    await exited(child, SETTLE_MS);

    expect(isRunning(pid)).toBe(true);
  });

  it("removes the registry file even when the registered process is not owned", async () => {
    const repo = makeRepo(dirs);
    child = startLongLivedProcess();
    const pid = pidOf(child);
    const pidfile = registerPid(repo, String(pid));
    const binDir = makePsStub(dirs, { command: FOREIGN_COMMAND, pid });

    const result = await withStubPath(binDir, () => run(["down"], repo));

    expect([result.exitCode, existsSync(pidfile)]).toEqual([0, false]);
  });

  it("plans the registry kill without performing it under --dry-run", async () => {
    const repo = makeRepo(dirs);
    child = startLongLivedProcess();
    const pid = pidOf(child);
    const pidfile = registerPid(repo, String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    const result = await withStubPath(binDir, () =>
      run(["down", "--dry-run"], repo)
    );
    await exited(child, SETTLE_MS);

    expect([
      result.stdout.includes(PIDFILE_REL),
      existsSync(pidfile),
      isRunning(pid),
    ]).toEqual([true, true, true]);
  });
});

// --- fixtures ---------------------------------------------------------------

// A throwaway git repo with the app capability and nothing else `down` acts on.
function makeRepo(track: string[]): string {
  return makeScratchRepo({ pkg: VITE_PKG, prefix: "dobby-pidfile-", track });
}

// Register `pid` in the workroot's `.dobby/dev.pid`, FRESH: the write stamps the
// file's mtime with now, which is the reference point the spec's 15-second
// ownership window is measured against.
function registerPid(repo: string, pid: string): string {
  mkdirSync(join(repo, ".dobby"), { recursive: true });
  const path = join(repo, PIDFILE_REL);
  writeFileSync(path, `${pid}\n`);
  return path;
}

// A real, long-lived child that is deliberately NOT a process-group leader (no
// `detached`), so `kill(-pid)` cannot reach it while `kill(pid)` can — the whole
// discriminator this suite rests on.
function startLongLivedProcess(): ChildProcess {
  return spawn("sleep", ["300"], { stdio: "ignore" });
}

// The child's pid, asserted present rather than assumed (`ChildProcess.pid` is
// optional: it is undefined only when the spawn itself failed).
function pidOf(child: ChildProcess): number {
  const { pid } = child;
  if (pid === undefined) {
    throw new Error("test fixture: the long-lived child failed to spawn");
  }
  return pid;
}

// A stub `ps` on PATH answering the spec's two ownership probes for ONE pid:
//   `ps -o command= -p <pid>` -> `opts.command`
//   `ps -o etime=   -p <pid>` -> a fresh elapsed time
// Any other pid (and any other column) is a miss: no output, nonzero exit — so a
// stray probe can never accidentally satisfy the ownership check. Every
// invocation is also recorded to a shared `actions.log` beside the stub, for
// diagnosis when a run does not go where it was expected to.
function makePsStub(
  track: string[],
  opts: { command: string; pid: number }
): string {
  const binDir = mkStubBinDir(track);
  const log = join(binDir, "actions.log");
  mkStubBin(
    binDir,
    "ps",
    `#!/bin/sh
printf 'ps %s\\n' "$*" >> '${log}'
case "$*" in
  *${opts.pid}*) ;;
  *) exit 1 ;;
esac
case "$*" in
  *command*) printf '%s\\n' '${opts.command}' ; exit 0 ;;
  *etime*) printf '%s\\n' '  ${FRESH_ETIME}' ; exit 0 ;;
esac
exit 1
`
  );
  return binDir;
}

// --- observers --------------------------------------------------------------

// Is the process still there? ESRCH — and only ESRCH — means gone; EPERM means a
// live process we simply may not signal.
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Resolve once the child has exited (or the ceiling elapses). Waiting on the
// `exit` EVENT rather than polling matters: node reaps the child as part of
// delivering that event, so a subsequent `kill(pid, 0)` sees a gone process
// instead of an unreaped zombie that still answers.
function exited(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ===========================================================================
// TASK 2 — `dobby dev` registers itself and refuses a live twin.
//
// The other half of the registry: `down` READS it (task 1), and now `dev`
// WRITES it. Right after resolving its workroot — before anything is spawned
// and before any cache is cleared — `dev` reads `.dobby/dev.pid`; a live, OWNED
// process there makes it refuse (exit 1, naming the pid and `dobby down`, with
// nothing spawned), and otherwise it registers its OWN pid and clears the file
// when its process group tears down. Unconditional: no environment variable is
// consulted to decide whether to register.
//
// SEAM: `run(argv, cwd)` for the refusal and the dry-run guards — `pidfile.ts`,
// `lifecycle.ts` and `environment.ts` are never imported, so where the registry
// helpers live cannot break these tests. The lifecycle case (the last one) is
// the single exception: a real `dev` blocks its caller until teardown and
// installs signal handlers on the calling process, so running it in-process
// would hang or kill vitest. It therefore spawns the CLI entry as a REAL CHILD
// — a deliberate, single-case deviation from ADR-0008's "no spawning the bin"
// (that ADR's stated reason is `bun` on the runner's PATH, so the case SKIPS
// where bun is absent rather than failing the suite there).
//
// INDEPENDENT SOURCES for every expected value below:
//   - Exit code 1 and "the message names the pid and `dobby down`" are the
//     spec's own words for the refusal; exit 0 plus "the plan prints" are its
//     words for the proceed path.
//   - The registered pid is a value the TEST owns: the pid the OS gave the child
//     WE spawned, compared against the file's bytes. Nothing recomputes it.
//   - `2147483647` (2^31-1) is above any live pid on darwin/linux, so "a dead
//     registration" holds BY CONSTRUCTION.
//   - "Nothing was spawned" is observed on the CONSUMER VITE BIN — a recorder at
//     `<workroot>/node_modules/.bin/vite`, the absolute path a real dev plan
//     resolves and runs. (A `portless` stub on PATH would NOT do: dobby resolves
//     portless from its own bundled tree by absolute path, so a PATH stub is
//     never reached and "portless was not invoked" would hold in red and green
//     alike — a vacuous assertion.)
//   - Git-ignoredness is asked of GIT itself (`git check-ignore`), never matched
//     against one chosen `.gitignore` spelling.
// ===========================================================================

// The CLI entry a real child runs — resolved from THIS file's directory, so it
// follows the source wherever the suite is executed from.
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

// The subcommand the real child runs. Held as a const and assembled by
// `devArgv()` rather than written inline in the `spawn(…)` call because knip's
// binaries plugin reads bare string literals out of a spawn's argv and would
// report `dev` as an unlisted BINARY. The spawned command is unchanged:
// `bun <CLI_ENTRY> dev`.
const DEV_SUBCOMMAND = "dev";

// What the refusal must carry besides the pid: the way OUT.
const RECOVERY_HINT = "dobby down";

// A `portless run …` token sits on the main line of every real dev plan, so its
// presence is the positive proof that `dev` got PAST the registry check and
// produced a plan (a bare exit 0 could also be some no-op branch).
const PLAN_MARKER = "portless run";

// How long a real `dev` child is given to register itself. Generous: it boots
// bun, detects capabilities and starts portless under full-suite parallelism.
const REGISTER_WAIT_MS = 10_000;

// The registry poll interval — fast, so an observation is tight around the
// transition instead of around the timeout.
const POLL_MS = 50;

describe("run() — dev command (the run process registers itself)", () => {
  const dirs: string[] = [];
  let child: ChildProcess | undefined;
  let devChild: ChildProcess | undefined;
  let originalCmux: string | undefined;

  beforeEach(() => {
    originalCmux = process.env[CMUX];
    Reflect.deleteProperty(process.env, CMUX);
  });

  afterEach(() => {
    restoreEnv(CMUX, originalCmux);
    // Never leak a `sleep`, a `dev`, or a `dev`'s own children out of the suite.
    child?.kill("SIGKILL");
    child = undefined;
    killGroup(devChild);
    devChild = undefined;
  });

  afterAll(() => {
    cleanupDirs(dirs);
    dirs.length = 0;
  });

  it("refuses to start while a live dobby dev is registered, naming the pid and how to stop it", async () => {
    const repo = makeRepo(dirs);
    child = startLongLivedProcess();
    const pid = pidOf(child);
    registerPid(repo, String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    const result = await withStubPath(binDir, () => run(["dev"], repo));

    expect([
      result.exitCode,
      result.stderr.includes(String(pid)),
      result.stderr.includes(RECOVERY_HINT),
      // And the registered process is left strictly alone: refusing is not
      // stopping — `dobby down` is what stops it.
      isRunning(pid),
    ]).toEqual([1, true, true, true]);
  });

  it.skipIf(!hasBun())("starts nothing at all when it refuses", async () => {
    // The "nothing spawned" half, which only a REAL run can show: the
    // in-process seam renders a plan instead of executing it, so there
    // "portless/vite was not invoked" would hold whatever the code did.
    const log = viteLog(dirs);
    const repo = makeViteRepo(dirs, viteRecorderScript(log));
    child = startLongLivedProcess();
    const pid = pidOf(child);
    registerPid(repo, String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    devChild = spawn("bun", devArgv(), {
      cwd: repo,
      detached: true,
      env: { ...process.env, PATH: stubPath(binDir) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome = await collect(devChild, REGISTER_WAIT_MS);

    expect([
      outcome.code,
      outcome.stderr.includes(String(pid)),
      outcome.stderr.includes(RECOVERY_HINT),
      // The app's own bin never ran: the refusal happened BEFORE any spawn.
      existsSync(log),
    ]).toEqual([1, true, true, false]);
  });

  it("starts anyway when the registered pid is unreachable", async () => {
    const repo = makeRepo(dirs);
    registerPid(repo, UNREACHABLE_PID);

    const result = await run(["dev", "--dry-run"], repo);

    expect([result.exitCode, result.stdout.includes(PLAN_MARKER)]).toEqual([
      0,
      true,
    ]);
  });

  it("starts anyway when the registered pid is live but is not a dobby run", async () => {
    const repo = makeRepo(dirs);
    child = startLongLivedProcess();
    const pid = pidOf(child);
    registerPid(repo, String(pid));
    const binDir = makePsStub(dirs, { command: FOREIGN_COMMAND, pid });

    const result = await withStubPath(binDir, () =>
      run(["dev", "--dry-run"], repo)
    );
    await exited(child, SETTLE_MS);

    expect([
      result.exitCode,
      result.stdout.includes(PLAN_MARKER),
      isRunning(pid),
    ]).toEqual([0, true, true]);
  });

  it("registers nothing under --dry-run", async () => {
    const repo = makeRepo(dirs);

    const result = await run(["dev", "--dry-run"], repo);

    expect([
      result.exitCode,
      result.stdout.includes(PLAN_MARKER),
      existsSync(join(repo, PIDFILE_REL)),
    ]).toEqual([0, true, false]);
  });

  it.skipIf(!hasBun())(
    "registers its own pid while running and clears the registry when it is stopped",
    async () => {
      const repo = makeViteRepo(dirs, SLEEPING_VITE);
      // A STALE registration the run must overwrite with its own pid.
      const pidfile = registerPid(repo, UNREACHABLE_PID);

      devChild = spawn("bun", devArgv(), {
        cwd: repo,
        detached: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const devPid = pidOf(devChild);
      drain(devChild);

      const registered = await until(
        () => readTrimmed(pidfile) === String(devPid),
        REGISTER_WAIT_MS
      );
      // Asked of git itself, so any ignore spelling counts.
      const ignored = isGitIgnored(repo, PIDFILE_REL);

      devChild.kill("SIGTERM");
      await exited(devChild, EXIT_WAIT_MS);
      const cleared = await until(() => !existsSync(pidfile), EXIT_WAIT_MS);

      expect([registered, ignored, cleared]).toEqual([true, true, true]);
    }
  );
});

// --- task 2 fixtures --------------------------------------------------------

// A scratch repo with the app capability AND a consumer `vite` bin at the
// absolute path a dev plan resolves — the seam through which "was anything
// spawned?" is observable. The bin is written AFTER the scratch commit on
// purpose: `node_modules` is fixture scaffolding, not repo content.
function makeViteRepo(track: string[], viteScript: string): string {
  const repo = makeRepo(track);
  mkStubBin(join(repo, "node_modules", ".bin"), "vite", viteScript);
  return repo;
}

// Where a recording `vite` bin reports that it ran: a fresh path per call, in a
// tracked stub dir, so "the file exists" means "this run spawned it".
function viteLog(track: string[]): string {
  return join(mkStubBinDir(track), "vite.log");
}

// A `vite` that RECORDS the fact it ran and exits immediately — the
// discriminator for "dev spawned the app". Exiting at once keeps a red run
// (where the refusal is missing, so a real dev starts) short and
// self-terminating.
function viteRecorderScript(log: string): string {
  return `#!/bin/sh
printf 'vite %s\\n' "$*" >> '${log}'
exit 0
`;
}

// A `vite` that never returns, so a real `dev` stays up until the test signals
// it — the only way to observe the registry BETWEEN registration and teardown.
const SLEEPING_VITE = `#!/bin/sh
exec sleep 300
`;

// --- task 2 observers -------------------------------------------------------

// The argv a real child runs: the CLI entry plus the dev subcommand.
function devArgv(): string[] {
  return [CLI_ENTRY, DEV_SUBCOMMAND];
}

// Is `bun` on PATH? ADR-0008 rejects spawning the real bin precisely because a
// runner may not carry one; the single case that must spawn skips there instead
// of reporting the environment as a product failure.
function hasBun(): boolean {
  return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
}

// The file's bytes as a trimmed string, or undefined when it is not there.
function readTrimmed(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

// Poll `predicate` until it holds or the ceiling elapses; the RESULT says which
// happened, so a timeout surfaces as a failed assertion rather than a throw.
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  return predicate();
}

// Does GIT consider `relPath` ignored inside `root`? Independent of which
// `.gitignore` the implementation writes, and of where it puts it.
function isGitIgnored(root: string, relPath: string): boolean {
  return (
    spawnSync("git", ["check-ignore", "-q", "--no-index", relPath], {
      cwd: root,
      stdio: "ignore",
    }).status === 0
  );
}

// Wait for a spawned CLI child to finish, returning its exit code and the
// stderr it wrote (the surface a refusal message is asserted on). A child that
// outlives the ceiling resolves with a null code, so a hung run surfaces as a
// failed assertion instead of a suite timeout.
function collect(
  proc: ChildProcess,
  ms: number
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    proc.stdout?.resume();
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      resolve({ code: null, stderr });
    }, ms);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      // Let the last stderr chunks land before the assertion reads them.
      setTimeout(() => {
        resolve({ code, stderr });
      }, POLL_MS);
    });
  });
}

// Keep the child's pipes flowing: an unread pipe fills and stalls the writer,
// which would freeze the very process the test is waiting on.
function drain(proc: ChildProcess): void {
  proc.stdout?.resume();
  proc.stderr?.resume();
}

// Kill a detached child AND everything it started (it leads its own group), so a
// failed run can never leave a portless/vite pair behind.
function killGroup(proc: ChildProcess | undefined): void {
  const pid = proc?.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    proc?.kill("SIGKILL");
  }
}
