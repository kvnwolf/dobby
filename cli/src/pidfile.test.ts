import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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

// What the refusal must SAY: a run is already registered for this worktree.
const ALREADY_RUNNING = "already running";

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
  let devTwin: ChildProcess | undefined;
  let originalCmux: string | undefined;
  let portless: PortlessRun | undefined;

  beforeEach(async () => {
    originalCmux = process.env[CMUX];
    Reflect.deleteProperty(process.env, CMUX);
    // One isolated portless world per test — see PORTLESS ISOLATION below.
    portless = await makePortlessRun(dirs);
  });

  afterEach(async () => {
    restoreEnv(CMUX, originalCmux);
    // Never leak a `sleep`, a `dev`, or a `dev`'s own children out of the suite.
    child?.kill("SIGKILL");
    child = undefined;
    killGroup(devChild);
    devChild = undefined;
    killGroup(devTwin);
    devTwin = undefined;
    // The dev children are down FIRST, so nothing can re-start what this stops.
    await stopPortless(portless);
    portless = undefined;
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

    devChild = spawnDev(repo, portless, binDir);
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
      const log = viteLog(dirs);
      const repo = makeViteRepo(dirs, viteRecordingSleeper(log));
      // A STALE registration the run must overwrite with its own pid.
      const pidfile = registerPid(repo, UNREACHABLE_PID);

      devChild = spawnDev(repo, portless);
      const devPid = pidOf(devChild);
      drain(devChild);

      const registered = await until(
        () => readTrimmed(pidfile) === String(devPid),
        REGISTER_WAIT_MS
      );
      // The registry file appearing is NOT the run being up: a `dev` that
      // registers and then dies at once (portless refusing to start, say)
      // satisfies the line above for an instant, which is exactly how this case
      // passed on a runner where nothing ever started. The app's own bin
      // recording ONE invocation is what says the run actually came up.
      const started = await until(
        () => logLines(log).length === 1,
        REGISTER_WAIT_MS
      );
      // Asked of git itself, so any ignore spelling counts.
      const ignored = isGitIgnored(repo, PIDFILE_REL);

      devChild.kill("SIGTERM");
      await exited(devChild, EXIT_WAIT_MS);
      const cleared = await until(() => !existsSync(pidfile), EXIT_WAIT_MS);

      expect([registered, started, ignored, cleared]).toEqual([
        true,
        true,
        true,
        true,
      ]);
    }
  );

  // -------------------------------------------------------------------------
  // REVIEW ROUND 1 — registration must be ATOMIC, not check-then-write.
  //
  // Two `dobby dev` runs started at the same instant in the same worktree are
  // the case a read-then-write registry cannot answer: both read an absent
  // file, both believe they are first, and the worktree ends up with two dev
  // servers fighting over one port while the registry names only the loser's
  // twin. The observable contract is therefore about the WORLD the two runs
  // leave behind — one registered and running, one refused, and the app's own
  // bin started exactly ONCE — never about which syscall did it.
  //
  // The `ps` stub these cases run under answers OWNED for ANY pid on purpose:
  // the real command line of a spawned child is `bun …/cli/src/index.ts dev`,
  // which does NOT contain `dobby dev`, so real `ps` would report the winner as
  // a foreign process and invite the loser to reclaim its registration — an
  // artefact of running the CLI from source, not the behaviour under test.
  //
  // INDEPENDENT SOURCES: exit code 1 and the `already running` / `dobby down`
  // wording are the review finding's own words for the refusal; the registered
  // pid is the one the OS gave the child WE spawned; "exactly one" is counted
  // from a stub bin THIS file wrote, which records one line per invocation.
  // -------------------------------------------------------------------------

  it.skipIf(!hasBun())(
    "registers exactly one of two runs started at the same instant and refuses the other",
    async () => {
      const log = viteLog(dirs);
      const repo = makeIsolatedViteRepo(dirs, viteRecordingSleeper(log));
      const binDir = makeOwnedPsStub(dirs);
      const pidfile = join(repo, PIDFILE_REL);

      // Back to back in ONE tick: neither run gets a head start.
      const runA = spawnDev(repo, portless, binDir);
      const runB = spawnDev(repo, portless, binDir);
      devChild = runA;
      devTwin = runB;
      const first = watchDev(runA);
      const second = watchDev(runB);

      const settled = await until(
        () =>
          existsSync(pidfile) && (first.code !== null || second.code !== null),
        REGISTER_WAIT_MS
      );
      const refused = first.code === null ? second : first;
      const survivor = first.code === null ? runA : runB;
      const survivorPid = pidOf(survivor);
      // Let a second start — if there is one — reach the app's bin before the
      // invocations are counted.
      await until(() => logLines(log).length > 0, REGISTER_WAIT_MS);
      await pause(SETTLE_MS);
      const starts = logLines(log).length;
      const registered = readTrimmed(pidfile) === String(survivorPid);
      const alive = isRunning(survivorPid);

      survivor.kill("SIGTERM");
      const cleared = await until(() => !existsSync(pidfile), EXIT_WAIT_MS);

      // Named in the message as well as asserted: this case failed on CI with
      // an EMPTY stderr, and stderr was all the message carried — so the report
      // named none of the eight observations that produced the failure.
      const observed = [
        settled,
        refused.code,
        refused.stderr.includes(ALREADY_RUNNING),
        refused.stderr.includes(RECOVERY_HINT),
        registered,
        alive,
        starts,
        cleared,
      ];

      expect(
        observed,
        `observed [settled, code, saysAlreadyRunning, saysRecovery, registered, alive, starts, cleared] = ${JSON.stringify(observed)}\nrefused run said:\n${refused.stderr}`
      ).toEqual([true, 1, true, true, true, true, 1, true]);
    }
  );

  it.skipIf(!hasBun())(
    "takes over a registry file left behind by a run that is gone",
    async () => {
      const repo = makeIsolatedViteRepo(dirs, SLEEPING_VITE);
      const pidfile = registerPid(repo, UNREACHABLE_PID);

      const devRun = spawnDev(repo, portless);
      devChild = devRun;
      drain(devRun);
      const devPid = pidOf(devRun);

      const registered = await until(
        () => readTrimmed(pidfile) === String(devPid),
        REGISTER_WAIT_MS
      );
      const registryHolds = readTrimmed(pidfile);

      // Stop it the way a human would, so the run tears its own children down
      // instead of leaving them to the SIGKILL in `afterEach`.
      devRun.kill("SIGTERM");
      await until(() => !existsSync(pidfile), EXIT_WAIT_MS);

      expect(registered, `registry still reads ${registryHolds}`).toBe(true);
    }
  );

  it.skipIf(!hasBun())(
    "takes over a registry file naming a live process that is not a dobby run",
    async () => {
      const repo = makeIsolatedViteRepo(dirs, SLEEPING_VITE);
      child = startLongLivedProcess();
      const foreignPid = pidOf(child);
      const pidfile = registerPid(repo, String(foreignPid));
      const binDir = makePsStub(dirs, {
        command: FOREIGN_COMMAND,
        pid: foreignPid,
      });

      const devRun = spawnDev(repo, portless, binDir);
      devChild = devRun;
      drain(devRun);
      const devPid = pidOf(devRun);

      const registered = await until(
        () => readTrimmed(pidfile) === String(devPid),
        REGISTER_WAIT_MS
      );

      // …and the foreign process is left strictly alone: reclaiming the FILE is
      // not killing whatever it happened to name.
      const foreignAlive = isRunning(foreignPid);

      devRun.kill("SIGTERM");
      await until(() => !existsSync(pidfile), EXIT_WAIT_MS);

      expect([registered, foreignAlive]).toEqual([true, true]);
    }
  );

  // -------------------------------------------------------------------------
  // REVIEW ROUND 2 — RECLAIMING a stale registration must be atomic too.
  //
  // Round 1 made the FIRST registration atomic (create-exclusively, and the
  // loser is refused). The reclaim path is the same race one layer down: two
  // runs that read the SAME stale file — a dead pid, or a live process that is
  // not a dobby run — both decide it may be taken over. If taking it over is
  // "remove the file, then create it exclusively", the second removal deletes
  // the FIRST run's fresh registration and both runs come up: two dev servers
  // in one worktree, with the registry naming only one of them.
  //
  // The contract is the WORLD the two runs leave behind, and it is identical to
  // round 1's: exactly ONE registered and running, the other refused with the
  // same message and exit code, the app's own bin started EXACTLY ONCE — plus,
  // now, no leftover of whatever the reclaim moved the stale file to. How the
  // reclaim is done (rename, unlink, lock) is never asserted.
  //
  // Each case runs THREE times: a race decided by chance passes once, so a
  // single green run is not evidence. Every round builds its own fixtures, and
  // `beforeEach` gives it its own portless world.
  //
  // INDEPENDENT SOURCES: exit code 1 and the `already running` / `dobby down`
  // wording are the finding's own words for the refusal; the registered pid is
  // the one the OS gave the child WE spawned; `2147483647` is unreachable by
  // construction; "exactly one" is counted from a stub bin THIS file wrote, one
  // line per invocation; "no leftover" is read from the registry DIRECTORY, so
  // it holds for any derivative name a reclaim might leave behind.
  // -------------------------------------------------------------------------

  it.skipIf(!hasBun()).each(RACE_ROUNDS)(
    "registers exactly one of two runs reclaiming a dead registration (round %i)",
    async () => {
      const log = viteLog(dirs);
      const repo = makeIsolatedViteRepo(dirs, viteRecordingSleeper(log));
      // The registration both runs find, and both may take over.
      const pidfile = registerPid(repo, UNREACHABLE_PID);
      const binDir = makeReclaimPsStub(dirs, Number(UNREACHABLE_PID));

      const observed = await raceTwoRuns(repo, portless, binDir, log, pidfile);
      devChild = observed.survivor;
      devTwin = observed.other;

      observed.survivor.kill("SIGTERM");
      const cleared = await until(() => !existsSync(pidfile), EXIT_WAIT_MS);
      // Wait for the survivor to actually land, so its own teardown (and not
      // just the SIGKILL in `afterEach`) takes the app process down with it.
      await exited(observed.survivor, EXIT_WAIT_MS);

      expect(
        [...observed.report, cleared],
        `${RACE_OBSERVATIONS}, cleared] = ${JSON.stringify([...observed.report, cleared])}\nrefused run said:\n${observed.refusal}`
      ).toEqual([true, 1, true, true, true, true, 1, [], true]);
    }
  );

  it.skipIf(!hasBun()).each(RACE_ROUNDS)(
    "registers exactly one of two runs reclaiming a live foreign registration (round %i)",
    async () => {
      const log = viteLog(dirs);
      const repo = makeIsolatedViteRepo(dirs, viteRecordingSleeper(log));
      // A registration naming a LIVE process that is not a dobby run: both runs
      // are entitled to take it over, and neither may touch the process itself.
      child = startLongLivedProcess();
      const foreignPid = pidOf(child);
      const pidfile = registerPid(repo, String(foreignPid));
      const binDir = makeReclaimPsStub(dirs, foreignPid, FOREIGN_COMMAND);

      const observed = await raceTwoRuns(repo, portless, binDir, log, pidfile);
      devChild = observed.survivor;
      devTwin = observed.other;
      // Reclaiming the FILE is never killing what it happened to name.
      const foreignAlive = isRunning(foreignPid);

      observed.survivor.kill("SIGTERM");
      const cleared = await until(() => !existsSync(pidfile), EXIT_WAIT_MS);
      // Wait for the survivor to actually land, so its own teardown (and not
      // just the SIGKILL in `afterEach`) takes the app process down with it.
      await exited(observed.survivor, EXIT_WAIT_MS);

      expect(
        [...observed.report, foreignAlive, cleared],
        `${RACE_OBSERVATIONS}, foreignAlive, cleared] = ${JSON.stringify([...observed.report, foreignAlive, cleared])}\nrefused run said:\n${observed.refusal}`
      ).toEqual([true, 1, true, true, true, true, 1, [], true, true]);
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

// How many uniquely-named app fixtures this process has built so far — the
// counter behind `makeIsolatedViteRepo`'s names.
let appFixtures = 0;

// The same fixture with a package name no OTHER run can be holding: portless
// registers a dev server under the app's name GLOBALLY, so two fixtures sharing
// one name make the second run fail on portless's registry instead of dobby's —
// including across suite runs, when a killed run leaves its registration behind.
// The cases that start REAL, CONCURRENT runs need that isolation; the older ones
// keep the shared name they were written with. (PORTLESS ISOLATION below now
// gives every test its own portless state dir too, so a name can no longer
// collide across tests either — this stays as the belt to that pair of braces.)
function makeIsolatedViteRepo(track: string[], viteScript: string): string {
  appFixtures += 1;
  const repo = makeScratchRepo({
    pkg: { ...VITE_PKG, name: `pidfile-app-${process.pid}-${appFixtures}` },
    prefix: "dobby-pidfile-",
    track,
  });
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

// A `vite` that RECORDS one line per invocation AND then never returns: the
// count of lines is "how many runs actually started the app", and the sleeping
// tail keeps whichever run won alive to be observed and signalled.
function viteRecordingSleeper(log: string): string {
  return `#!/bin/sh
printf 'vite %s\\n' "$*" >> '${log}'
exec sleep 300
`;
}

// A stub `ps` that answers the ownership probes for ANY pid: the process it is
// asked about is a dobby run, started seconds ago. Needed because a child
// spawned as `bun <CLI_ENTRY> dev` does NOT carry `dobby dev` on its real
// command line — an artefact of running the CLI from source, which would
// otherwise make a second run treat the first as a foreign process.
function makeOwnedPsStub(track: string[]): string {
  const binDir = mkStubBinDir(track);
  mkStubBin(
    binDir,
    "ps",
    `#!/bin/sh
case "$*" in
  *command*) printf '%s\\n' '${OWNED_COMMAND}' ; exit 0 ;;
  *etime*) printf '%s\\n' '  ${FRESH_ETIME}' ; exit 0 ;;
esac
exit 1
`
  );
  return binDir;
}

// The rounds each RACE case runs: a race decided by chance can pass once, so a
// single green run says nothing. Three fresh fixtures, three verdicts.
const RACE_ROUNDS = [1, 2, 3];

// How long the stub `ps` dawdles before answering about the STALE pid — the one
// probe both runs make before they decide the registration may be taken over.
// Holding both of them inside that window is what turns a rare interleaving into
// the ordinary one, so the race is hit far more often than by luck alone. (It
// cannot be made certain from outside: the two runs still have to reach the
// registry within that window, and how long each takes to get there is the
// machine's business. That is why each case runs three rounds.)
const STALE_PROBE_DELAY = "1";

// The observation names the race cases report, in the order their array carries
// them — a failing race is unreadable without them (round 1 failed on CI with an
// empty stderr and a bare `[false, null, …]`).
const RACE_OBSERVATIONS =
  "observed [settled, code, saysAlreadyRunning, saysRecovery, registered, alive, starts, leftovers";

// A stub `ps` for the RECLAIM races: it answers about the pid already in the
// registry — slowly, and as a process no run may claim (a foreign command line,
// or nothing at all when the pid is unreachable) — and reports every OTHER pid
// as a fresh, owned dobby run, which is what the loser of the race must see when
// it looks at the winner. (A child spawned as `bun <CLI_ENTRY> dev` does not
// carry `dobby dev` on its real command line, so real `ps` would report the
// winner as foreign and invite the loser to reclaim it — an artefact of running
// the CLI from source.)
function makeReclaimPsStub(
  track: string[],
  stalePid: number,
  staleCommand?: string
): string {
  const binDir = mkStubBinDir(track);
  const staleAnswer =
    staleCommand === undefined
      ? "exit 1"
      : `case "$*" in
      *command*) printf '%s\\n' '${staleCommand}' ; exit 0 ;;
      *etime*) printf '%s\\n' '  ${FRESH_ETIME}' ; exit 0 ;;
    esac
    exit 1`;
  mkStubBin(
    binDir,
    "ps",
    `#!/bin/sh
case "$*" in
  *${stalePid}*)
    sleep ${STALE_PROBE_DELAY}
    ${staleAnswer} ;;
esac
case "$*" in
  *command*) printf '%s\\n' '${OWNED_COMMAND}' ; exit 0 ;;
  *etime*) printf '%s\\n' '  ${FRESH_ETIME}' ; exit 0 ;;
esac
exit 1
`
  );
  return binDir;
}

// What two runs started back to back in ONE tick left behind: which of them
// survived, what the other said, and the eight observations the contract is
// stated in. The survivor is left RUNNING — the caller stops it, so it can also
// assert the registry is cleared on the way down.
interface RaceOutcome {
  other: ChildProcess;
  refusal: string;
  report: [
    boolean,
    number | null,
    boolean,
    boolean,
    boolean,
    boolean,
    number,
    string[],
  ];
  survivor: ChildProcess;
}

async function raceTwoRuns(
  repo: string,
  portless: PortlessRun | undefined,
  binDir: string,
  log: string,
  pidfile: string
): Promise<RaceOutcome> {
  // Back to back in ONE tick: neither run gets a head start.
  const runA = spawnDev(repo, portless, binDir);
  const runB = spawnDev(repo, portless, binDir);
  const first = watchDev(runA);
  const second = watchDev(runB);

  const settled = await until(
    () => existsSync(pidfile) && (first.code !== null || second.code !== null),
    REGISTER_WAIT_MS
  );
  const refused = first.code === null ? second : first;
  const survivor = first.code === null ? runA : runB;
  const other = survivor === runA ? runB : runA;
  // The app coming up is its OWN wait: booting vite is the slow tail, and on a
  // loaded runner it lands well after the registration the line above watched
  // for. Folding the two into one ceiling would report a healthy-but-slow run as
  // a failed race.
  await until(() => logLines(log).length > 0, REGISTER_WAIT_MS);
  // Let a SECOND start — if the reclaim let one through — reach the app's bin
  // before the invocations are counted.
  await pause(SETTLE_MS);
  const survivorPid = pidOf(survivor);

  return {
    other,
    refusal: refused.stderr,
    report: [
      settled,
      refused.code,
      refused.stderr.includes(ALREADY_RUNNING),
      refused.stderr.includes(RECOVERY_HINT),
      readTrimmed(pidfile) === String(survivorPid),
      isRunning(survivorPid),
      logLines(log).length,
      registryLeftovers(repo),
    ],
    survivor,
  };
}

// Anything the registry directory holds that was DERIVED from the registry file:
// the `.stale.<pid>` (or however it is spelled) a reclaim moved the old
// registration to, and never cleaned up. The registry keeps one file.
function registryLeftovers(repo: string): string[] {
  const stateDir = join(repo, ".dobby");
  if (!existsSync(stateDir)) {
    return [];
  }
  return readdirSync(stateDir).filter(
    (name) => name.startsWith("dev.pid") && name !== "dev.pid"
  );
}

// A real `dobby dev` child in `repo`, detached (so `killGroup` can take its
// whole tree down), inside the test's own portless world, optionally with a
// stub-bin dir prepended to its PATH. EVERY real-`dev` spawn in this file goes
// through here, so none of them can miss the isolation below.
function spawnDev(
  repo: string,
  portless: PortlessRun | undefined,
  binDir?: string
): ChildProcess {
  const env = { ...process.env, ...portlessTestEnv(requirePortless(portless)) };
  return spawn("bun", devArgv(), {
    cwd: repo,
    detached: true,
    env: binDir === undefined ? env : { ...env, PATH: stubPath(binDir) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// --- portless isolation -----------------------------------------------------
//
// A real `dev` spawns `portless run <vite>`, and portless's DEFAULT proxy port
// is 443 — privileged. With no TTY (a CI runner) portless cannot ask for sudo,
// so it prints "Proxy is not running and no TTY is available for sudo." and
// EXITS 1 before it ever reaches the app: the run dies the moment it starts.
// This machine hides that, because a root-owned portless daemon started by some
// OTHER project already holds 443 here — which is precisely the accident these
// cases must not depend on.
//
// So every real-`dev` child runs portless in a world this test OWNS:
//   PORTLESS_PORT      an UNPRIVILEGED port. Portless asks for sudo only below
//                      1024, so above it the proxy just starts — this is
//                      verbatim the "use an unprivileged port" option portless's
//                      own refusal recommends.
//   PORTLESS_HTTPS=0   no TLS, so no certificate authority to generate or trust.
//   PORTLESS_STATE_DIR a fresh dir per test. Portless keeps its proxy pid, port
//                      and routes there, so nothing this suite starts can see,
//                      reuse or disturb the machine's own daemon — and nothing
//                      the machine runs can satisfy a test on its behalf.
//   CI=1               the non-interactive path is what a runner takes, so it is
//                      what these cases exercise HERE too, instead of passing on
//                      a developer's TTY and failing on the runner.
//
// `stopPortless` then takes the proxy back down and removes the state dir, so a
// run leaves no daemon behind.

// One test's isolated portless world: the port its proxy binds and the state dir
// it records itself in.
interface PortlessRun {
  port: number;
  stateDir: string;
}

// Where portless records the proxy it started, relative to the state dir.
const PROXY_PID_FILE = "proxy.pid";
const PROXY_PORT_FILE = "proxy.port";

// A fresh portless world: a free port plus a state dir owned by ONE test.
async function makePortlessRun(track: string[]): Promise<PortlessRun> {
  const stateDir = mkdtempSync(join(tmpdir(), "dobby-portless-"));
  track.push(stateDir);
  return { port: await freePort(), stateDir };
}

// The env a real `dev` child hands portless. Never set on `process.env`: the
// in-process `run()` cases in this file must not inherit `CI` or a proxy port.
function portlessTestEnv(portless: PortlessRun): NodeJS.ProcessEnv {
  return {
    CI: "1",
    PORTLESS_HTTPS: "0",
    PORTLESS_PORT: String(portless.port),
    PORTLESS_STATE_DIR: portless.stateDir,
  };
}

// The world the CURRENT test prepared, asserted present rather than assumed.
function requirePortless(portless: PortlessRun | undefined): PortlessRun {
  if (portless === undefined) {
    throw new Error(
      "test fixture: no portless world was prepared for this test"
    );
  }
  return portless;
}

// Ask the OS for a port by binding 0 and letting go again: whatever it hands
// back is ephemeral and therefore far ABOVE 1024, which is the only property
// that matters — portless needs sudo only below it.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("test fixture: could not obtain a free TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

// Stop the proxy portless auto-started for this test and drop its state dir. The
// pid is read from the test's OWN state dir, so the signal can only ever reach a
// proxy this suite started — never the machine's daemon on 443. A proxy that
// survives is REPORTED, not failed: a leak is a harness problem to see, and the
// behaviour under test is elsewhere.
async function stopPortless(portless: PortlessRun | undefined): Promise<void> {
  if (portless === undefined) {
    return;
  }
  const bound = readTrimmed(join(portless.stateDir, PROXY_PORT_FILE));
  if (bound !== undefined && bound !== String(portless.port)) {
    process.stderr.write(
      `warning: portless bound port ${bound}, not the test's ${portless.port}\n`
    );
  }
  const pid = Number.parseInt(
    readTrimmed(join(portless.stateDir, PROXY_PID_FILE)) ?? "",
    10
  );
  if (
    // `pid > 0` is not pedantry: `kill(0, …)` would signal the CALLER's whole
    // process group — vitest itself — and `kill(-n, …)` a group. Portless only
    // ever writes its own `process.pid` here, and this keeps it that way.
    Number.isInteger(pid) &&
    pid > 0 &&
    signalQuietly(pid, "SIGTERM") &&
    !(await until(() => !isRunning(pid), EXIT_WAIT_MS))
  ) {
    signalQuietly(pid, "SIGKILL");
  }
  if (!(await untilPortFree(portless.port, EXIT_WAIT_MS))) {
    process.stderr.write(
      `warning: something is still listening on port ${portless.port} after cleanup\n`
    );
  }
  rmSync(portless.stateDir, { force: true, recursive: true });
}

// Signal a pid, saying whether it was there to signal — a gone process is the
// outcome this asks for, never an error.
function signalQuietly(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Is nothing listening on `port`? Asked by BINDING it, not by shelling out to
// `lsof`: a runner need not carry lsof at all, and a missing binary would read
// as "no leak" — the one answer a leak check must never invent.
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

// Poll until the port is free or the ceiling elapses; the RESULT says which.
async function untilPortFree(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let free = await isPortFree(port);
  while (!free && Date.now() < deadline) {
    await pause(POLL_MS);
    free = await isPortFree(port);
  }
  return free;
}

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

// What a still-RUNNING child has said so far: its exit code once it lands
// (`null` while it is alive) and the stderr it has written. `collect` cannot
// serve the concurrent case — there both children must be observed at once, and
// the SURVIVOR never exits on its own.
interface DevWatch {
  code: number | null;
  stderr: string;
}

function watchDev(proc: ChildProcess): DevWatch {
  const watch: DevWatch = { code: null, stderr: "" };
  proc.stdout?.resume();
  proc.stderr?.on("data", (chunk: Buffer) => {
    watch.stderr += chunk.toString();
  });
  proc.once("exit", (code) => {
    watch.code = code;
  });
  return watch;
}

// The lines a recording stub bin wrote — one per invocation, so `.length` is
// "how many times it ran".
function logLines(path: string): string[] {
  const text = readTrimmed(path);
  return text === undefined || text === "" ? [] : text.split("\n");
}

// A plain wait, for letting a SECOND effect (if the code produced one) land
// before the count that must be 1 is taken.
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

// ===========================================================================
// CI ROUND 1 — ownership is decided by the command line `ps` actually reports.
//
// The registry's ownership check has to recognise a `dobby dev` run in EVERY
// legitimate launch shape, not only the one a published install happens to
// render. On GitHub's Linux runner a run started from source appears as
// `bun …/cli/src/index.ts dev`; a check that recognises only the literal
// `dobby dev` calls that a foreign process, so a second run reclaims a LIVE
// registration instead of being refused. Whatever makes macOS report it
// differently is not something the check may rest on.
//
// SEAM: `down` through `run(argv, cwd)`, with the `ps` stub reporting the
// COMMAND LINE under test for a live, non-detached `sleep 300` — so no real
// `dev` is needed and the outcome is unambiguous: ownership recognised ⇔ the
// registered process is DEAD afterwards; not recognised ⇔ it survives and the
// registry file is merely removed.
//
// INDEPENDENT SOURCES: every command line below is a literal spelled out here,
// four launch shapes the spec calls legitimate (bunx, this repo's own source
// entry, a consumer `.bin` shim, a consumer package entry) and four that are
// not a dobby dev run at all. Each negative pins a DIFFERENT way an over-broad
// recognition could go wrong, which is why they matter even while they pass:
// `sleep 300` is nothing like a run, `… index.ts check` is another subcommand
// under a dobby path, `/tmp/devtools/index.ts dev` ends in `dev` with no dobby
// anywhere, and `… index.ts dev --dry-run` is a dobby path plus `dev` whose
// LAST word is not `dev`. The start-time half of the check is untouched and
// stays satisfied throughout: `registerPid` stamps the file NOW and the stub
// reports `00:03`, three seconds by the POSIX `mm:ss` format.
// ===========================================================================

// Command lines a legitimate `dobby dev` run appears under: ownership is
// recognised, so `down` stops the process it found.
const DOBBY_DEV_COMMANDS = [
  "bunx dobby dev",
  "bun /home/runner/work/dobby/dobby/cli/src/index.ts dev",
  "bun /Users/x/app/node_modules/.bin/dobby dev",
  "bun /Users/x/app/node_modules/@kvnwolf/dobby/src/index.ts dev",
];

// Command lines that are NOT a dobby dev run: whatever the registry named is
// left strictly alone, and only the stale file goes.
const NON_DOBBY_DEV_COMMANDS = [
  "sleep 300",
  "bun /home/runner/work/dobby/dobby/cli/src/index.ts check",
  "bun /tmp/devtools/index.ts dev",
  "bun /x/dobby/cli/src/index.ts dev --dry-run",
];

describe("run() — down command (which command lines count as a dobby dev run)", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  let originalCmux: string | undefined;

  beforeEach(() => {
    originalCmux = process.env[CMUX];
    Reflect.deleteProperty(process.env, CMUX);
  });

  afterEach(() => {
    restoreEnv(CMUX, originalCmux);
    // Never leak a `sleep` out of the suite, whatever the assertions did.
    for (const proc of children) {
      proc.kill("SIGKILL");
    }
    children.length = 0;
  });

  afterAll(() => {
    cleanupDirs(dirs);
    dirs.length = 0;
  });

  it.each(DOBBY_DEV_COMMANDS)(
    "stops the registered run when ps reports it as `%s`",
    async (command) => {
      const repo = makeRepo(dirs);
      const child = startLongLivedProcess();
      children.push(child);
      const pid = pidOf(child);
      const pidfile = registerPid(repo, String(pid));
      const binDir = makePsStub(dirs, { command, pid });

      await withStubPath(binDir, () => run(["down"], repo));
      await exited(child, EXIT_WAIT_MS);

      expect([isRunning(pid), existsSync(pidfile)]).toEqual([false, false]);
    }
  );

  it.each(NON_DOBBY_DEV_COMMANDS)(
    "leaves the registered process alone when ps reports it as `%s`",
    async (command) => {
      const repo = makeRepo(dirs);
      const child = startLongLivedProcess();
      children.push(child);
      const pid = pidOf(child);
      const pidfile = registerPid(repo, String(pid));
      const binDir = makePsStub(dirs, { command, pid });

      await withStubPath(binDir, () => run(["down"], repo));
      await exited(child, SETTLE_MS);

      expect([isRunning(pid), existsSync(pidfile)]).toEqual([true, false]);
    }
  );
});

// ===========================================================================
// REVIEW ROUND 3 — a CAPTURED live registration is never dropped, and teardown
// SWEEPS the sidecars a reclaim left behind.
//
// Round 2's reclaim moves the registration it read as stale ASIDE — into
// `.dobby/dev.pid.stale.<pid>` — instead of deleting it, so the loser of the
// race can put it back. That rename can CAPTURE a LIVE registration: run A reads
// a stale pid, run B registers in the same instant, and A renames what is by then
// B's registration. If A's restore then fails — a third run C has already
// recreated `dev.pid` — deleting the captured file leaves B running with nothing
// on disk naming it, and no teardown can ever find it.
//
// The contract is stated entirely in what a TEARDOWN leaves behind: `dobby down`
// handles every `.dobby/dev.pid.stale.*` file exactly as it handles the
// registration itself — the same ownership check, a signal to the BARE `pid` of
// the owned live ones, and the file gone whatever the outcome — while `dobby up`
// and `dobby dev` keep reading ONLY `dev.pid`, so a sidecar is never mistaken for
// a registration.
//
// The three-process race is NOT reproduced with real processes (a capture needs
// an interleaving no test can command). The sidecars are placed on disk directly
// — that IS the state a capture leaves — and the fix is pinned through the
// sweep's observable effect.
//
// SEAM: `down`, `dev` and `up` through `run(argv, cwd)`, as everywhere else in
// this file. Nothing from the implementation is imported, so WHERE the sweep
// lives, and how the sidecar is spelled internally, cannot break these cases.
//
// INDEPENDENT SOURCES for every expected value below:
//   - `.dobby/dev.pid.stale.*`, "the file is removed regardless of outcome", "a
//     sidecar is never a registration" and exit code 0 for a teardown are the
//     spec's own words.
//   - Every sidecar NAME suffix here (4242, 1, 2, 7) deliberately DISAGREES with
//     the pid inside the file — which is precisely what a capture produces: the
//     name carries the pid the reclaim READ, the bytes carry the registration it
//     actually moved. The pid to act on can therefore only come from the file's
//     CONTENT, and a name-derived pid hits the `ps` stub's miss branch.
//   - `2147483647` (2^31-1) is above any live pid on darwin/linux: unreachable BY
//     CONSTRUCTION.
//   - `00:03` is three seconds by the POSIX `[[dd-]hh:]mm:ss` format, computed by
//     hand — inside the spec's 15-second window around the file's mtime, which
//     the write below stamps with now.
//   - The child is spawned WITHOUT `detached`, so it leads no process group: it
//     can only die if the BARE pid was signalled.
//   - `noop` / `ok:true` for a project with no app is the `up --json` contract
//     already pinned in `upjson.test.ts`, restated here with a sidecar present.
// ===========================================================================

// The sidecar prefix the spec names, inside the registry directory. What follows
// it is whatever the reclaim that produced the file happened to name it.
const SIDECAR_PREFIX = "dev.pid.stale.";

// A package.json with NO app capability (a drizzle dependency and nothing that
// serves): `up` there has nothing to start, so what it reports is about the
// registry alone.
const NOAPP_PKG = {
  dependencies: { "drizzle-orm": "^0.30.0" },
  name: "pidfile-noapp",
  private: true,
};

// The documented test seams: no `bun install`, and no production-length liveness
// wait — so a run that wrongly waited on the sidecar fails fast instead of
// sleeping through the real ceiling.
const SKIP_INSTALL = "DOBBY_SKIP_INSTALL";
const LIVENESS_RETRIES = "DOBBY_LIVENESS_RETRIES";

// The slice of `up --json` these cases read (the full field set is pinned in
// `upjson.test.ts`).
interface UpFacts {
  ok: boolean;
  phase: string;
  reason: string | null;
}

describe("run() — down sweeps the stale registry sidecars a reclaim left behind", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  let originalCmux: string | undefined;
  let originalSkip: string | undefined;
  let originalRetries: string | undefined;

  beforeEach(() => {
    originalCmux = process.env[CMUX];
    originalSkip = process.env[SKIP_INSTALL];
    originalRetries = process.env[LIVENESS_RETRIES];
    Reflect.deleteProperty(process.env, CMUX);
    process.env[SKIP_INSTALL] = "1";
    process.env[LIVENESS_RETRIES] = "1";
  });

  afterEach(() => {
    restoreEnv(CMUX, originalCmux);
    restoreEnv(SKIP_INSTALL, originalSkip);
    restoreEnv(LIVENESS_RETRIES, originalRetries);
    // Never leak a `sleep` out of the suite, whatever the assertions did.
    for (const proc of children) {
      proc.kill("SIGKILL");
    }
    children.length = 0;
  });

  afterAll(() => {
    cleanupDirs(dirs);
    dirs.length = 0;
  });

  it("stops the live run a captured sidecar names and removes both registry files", async () => {
    const repo = makeRepo(dirs);
    const pidfile = registerPid(repo, UNREACHABLE_PID);
    const child = startLongLivedProcess();
    children.push(child);
    const pid = pidOf(child);
    // The capture shape: the NAME carries the pid the reclaim read as stale, the
    // BYTES carry the live registration it actually moved aside.
    const sidecar = writeSidecar(repo, "4242", String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    const result = await withStubPath(binDir, () => run(["down"], repo));
    await exited(child, EXIT_WAIT_MS);

    expect([
      result.exitCode,
      existsSync(pidfile),
      existsSync(sidecar),
      isRunning(pid),
    ]).toEqual([0, false, false, false]);
  });

  it("leaves the process a sidecar names alone when it is not a dobby run, and removes the sidecar anyway", async () => {
    const repo = makeRepo(dirs);
    const pidfile = registerPid(repo, UNREACHABLE_PID);
    const child = startLongLivedProcess();
    children.push(child);
    const pid = pidOf(child);
    const sidecar = writeSidecar(repo, "4242", String(pid));
    const binDir = makePsStub(dirs, { command: FOREIGN_COMMAND, pid });

    const result = await withStubPath(binDir, () => run(["down"], repo));
    await exited(child, SETTLE_MS);

    expect([
      result.exitCode,
      existsSync(pidfile),
      existsSync(sidecar),
      isRunning(pid),
    ]).toEqual([0, false, false, true]);
  });

  it("sweeps every sidecar when there is no registration file left at all", async () => {
    const repo = makeRepo(dirs);
    const child = startLongLivedProcess();
    children.push(child);
    const pid = pidOf(child);
    // Two leftovers from two reclaims: one holding a live, owned run, one holding
    // a pid that is long gone.
    const live = writeSidecar(repo, "1", String(pid));
    const dead = writeSidecar(repo, "2", UNREACHABLE_PID);
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    const result = await withStubPath(binDir, () => run(["down"], repo));
    await exited(child, EXIT_WAIT_MS);

    expect([
      result.exitCode,
      existsSync(live),
      existsSync(dead),
      isRunning(pid),
    ]).toEqual([0, false, false, false]);
  });

  it("plans the sidecar sweep without performing it under --dry-run", async () => {
    const repo = makeRepo(dirs);
    const pidfile = registerPid(repo, UNREACHABLE_PID);
    const child = startLongLivedProcess();
    children.push(child);
    const pid = pidOf(child);
    const sidecar = writeSidecar(repo, "4242", String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    const result = await withStubPath(binDir, () =>
      run(["down", "--dry-run"], repo)
    );
    await exited(child, SETTLE_MS);

    expect([
      result.exitCode,
      result.stdout.includes(SIDECAR_PREFIX),
      existsSync(pidfile),
      existsSync(sidecar),
      isRunning(pid),
    ]).toEqual([0, true, true, true, true]);
  });

  // A sidecar is a LEFTOVER, never a registration: the two commands that read the
  // registry must ignore it entirely, even when it names a live, owned run.
  it("starts a run when the only registry file is a sidecar naming a live dobby run", async () => {
    const repo = makeRepo(dirs);
    const child = startLongLivedProcess();
    children.push(child);
    const pid = pidOf(child);
    writeSidecar(repo, "7", String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    const result = await withStubPath(binDir, () =>
      run(["dev", "--dry-run"], repo)
    );

    expect([
      result.exitCode,
      result.stdout.includes(PLAN_MARKER),
      // …and the process the sidecar names is left strictly alone: `dev` never
      // stops anything.
      isRunning(pid),
    ]).toEqual([0, true, true]);
  });

  it("brings a workroot up as a no-op when the only registry file is a sidecar naming a live dobby run", async () => {
    const repo = makeNoAppRepo(dirs);
    const child = startLongLivedProcess();
    children.push(child);
    const pid = pidOf(child);
    writeSidecar(repo, "7", String(pid));
    const binDir = makePsStub(dirs, { command: OWNED_COMMAND, pid });

    const result = await withStubPath(binDir, () =>
      run(["up", "--json"], repo)
    );

    // Anti-tautology guard: a red here must be the registry behaviour, never an
    // unimplemented command.
    expect(result.stderr).not.toContain("unknown command");
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as UpFacts;
    // `reason` is the line that would move if the sidecar were taken for a start
    // already in flight: `up` would wait on it and time out.
    expect([payload.ok, payload.phase, payload.reason]).toEqual([
      true,
      "noop",
      null,
    ]);
  });
});

// --- review round 3 fixtures ------------------------------------------------

// A registry SIDECAR: `.dobby/dev.pid.stale.<suffix>` holding `pid`, written NOW
// so its mtime is the reference point the 15-second ownership window is measured
// against. `suffix` and `pid` are independent ON PURPOSE — see the capture shape
// in the header above.
function writeSidecar(repo: string, suffix: string, pid: string): string {
  mkdirSync(join(repo, ".dobby"), { recursive: true });
  const path = join(repo, ".dobby", `${SIDECAR_PREFIX}${suffix}`);
  writeFileSync(path, `${pid}\n`);
  return path;
}

// A throwaway git repo with NO app capability, so `up` has nothing to start and
// answers about the registry alone.
function makeNoAppRepo(track: string[]): string {
  return makeScratchRepo({
    pkg: NOAPP_PKG,
    prefix: "dobby-pidfile-noapp-",
    track,
  });
}
