import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runCapture } from "./runner.ts";

// PIDFILE.TS — the run-process registry. Owns `<workroot>/.dobby/dev.pid`: writing it
// (`writePidfile`, called by `dobby dev` on startup), reading it back with the liveness +
// ownership check (`liveRegisteredPid`, consulted by `planDev` to refuse a live twin),
// clearing its OWN registration on self-teardown (`clearOwnPidfile`, called by `dev`'s
// managed-group teardown), and tearing a REGISTERED run down from the outside
// (`killFromPidfile`, called by `down` regardless of which environment adapter is
// currently active). Sits BELOW both `environment.ts` and `lifecycle.ts` in the import
// graph — it imports neither of them, so both may import THIS module freely without ever
// risking a cycle.

// Top-level regexes (biome useTopLevelRegex).
const PS_ETIME_RE = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;
const TRAILING_SLASH_RE = /\/$/;

// The registry path, relative to a workroot.
const PIDFILE_REL = ".dobby/dev.pid";

/**
 * Register THIS process in `<workroot>/.dobby/dev.pid` (creating `.dobby/` and
 * gitignoring it first). Called by `dobby dev`'s streaming path (`runDev`) at
 * startup, once `planDev` has confirmed no live twin is already registered, so a
 * later `down` (via `killFromPidfile`) or `liveRegisteredPid` can find and
 * identify it.
 *
 * @public — self-registration for `dobby dev`.
 */
export function writePidfile(workroot: string): void {
  const dobbyDir = join(workroot, ".dobby");
  mkdirSync(dobbyDir, { recursive: true });
  ensureGitignored(workroot, ".dobby/");
  writeFileSync(join(dobbyDir, "dev.pid"), `${process.pid}\n`);
}

/**
 * The registered pid, but ONLY when it is both alive and OWNED by this workroot (see
 * `ownsDetachedRun`) — null for every other case: no pidfile, an unparseable pid, a dead
 * pid, or a reused pid that now belongs to something else. Never throws.
 *
 * @public — the already-registered-run check for `up`/`env` (later task in this plan).
 */
export function liveRegisteredPid(workroot: string): number | null {
  const pidPath = join(workroot, PIDFILE_REL);
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return null;
  }
  if (
    !(
      Number.isInteger(pid) &&
      isAlive(pid) &&
      ownsDetachedRun(pid, workroot, pidPath)
    )
  ) {
    return null;
  }
  return pid;
}

/**
 * Remove `<workroot>/.dobby/dev.pid` when it still names THIS process. Called
 * from `dobby dev`'s own teardown (`runManagedGroup`'s `SIGINT`/`SIGTERM`/child-exit
 * path) so a later `dev` that has already overwritten the file with its OWN pid
 * is not un-registered by an older one finishing its shutdown. A silent no-op
 * when the file is absent, unreadable, or already claimed by a different pid —
 * self-identity is a plain byte compare, not the `ps`-based ownership check
 * (`ownsDetachedRun`), which answers a different question ("is that OTHER pid
 * ours?") for a different caller (`down`, killing someone else's process).
 *
 * @public — self-teardown for `dobby dev`.
 */
export function clearOwnPidfile(workroot: string): void {
  const pidPath = join(workroot, PIDFILE_REL);
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf8").trim();
  } catch {
    return;
  }
  if (raw === String(process.pid)) {
    rmSync(pidPath, { force: true });
  }
}

// Append `entry` to <workroot>/.gitignore when absent (idempotent). Best-effort.
// Private since TASK 4: `writePidfile` (below) was its only external consumer's
// sibling call site (terminal.ts's now-removed `startDetached`) — `up` no longer
// spawns anything of its own to gitignore a log for.
function ensureGitignored(workroot: string, entry: string): void {
  const path = join(workroot, ".gitignore");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No .gitignore yet — created below.
  }
  const bare = entry.replace(TRAILING_SLASH_RE, "");
  const present = raw.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === entry || trimmed === bare;
  });
  if (present) {
    return;
  }
  const prefix = raw === "" || raw.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${prefix}${entry}\n`);
}

// ---------------------------------------------------------------------------
// Detached teardown (down, no cmux) — signal the registered run, then remove the file.
//
// Deliberately a STANDALONE export, not tucked behind an `Environment` interface method:
// `down` calls this whenever `.dobby/dev.pid` exists on disk, regardless of which
// environment is CURRENTLY active (a stale pidfile left over from an earlier terminal run
// must still be cleaned up even if this `down` runs under cmux) — so gating it behind "is
// the terminal adapter active" would silently stop cleaning up a stale pidfile under
// cmux, a behavior this must not do.
// ---------------------------------------------------------------------------

// Kill the detached run's process (SIGTERM to the bare `pid`, NOT the process group
// `-pid`: a model-launched `dobby dev` is not guaranteed to lead a process group, and
// `dev`'s own SIGTERM handler already tears its child group down) when the pid is still
// alive AND `ownsDetachedRun` confirms both the command-line signature AND the start-time
// (see below); either way remove the pidfile (a stale pid is cleaned up silently).
// Returns whether a live, owned process was actually signalled. The ownership check
// guards against pid reuse: a recycled pid can pass `isAlive` (EPERM counts even another
// user's process alive), so we never signal a process that isn't ours.
export function killFromPidfile(pidPath: string, workroot: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return false;
  }
  const owned =
    Number.isInteger(pid) &&
    isAlive(pid) &&
    ownsDetachedRun(pid, workroot, pidPath);
  if (owned) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process already vanished — nothing to signal.
    }
  }
  rmSync(pidPath, { force: true });
  return owned;
}

// Whether `pid` names a live process (`kill(pid, 0)`): ESRCH → dead, EPERM → alive
// (exists but unsignalable).
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Whether `pid` is OUR detached run — requires BOTH (a) the command-line signature
// (`dobby dev`, since it was spawned as `bunx dobby dev`) AND (b) a start-time match:
// the process must have started no later than the pidfile was written (+ tolerance).
// (a) alone is insufficient — the signature matches ANY dobby dev, including another
// worktree's (parallel goals are the kit's normal mode), so a recycled pid now running
// an UNRELATED workspace's dev group would still match. The start-time guard closes
// that: a process that came up AFTER we recorded this pid can't be the one we recorded.
// `ps` is a system tool → bare. Any failure — failed/empty `ps`, a non-matching command,
// an unstat-able pidfile, or an unparseable etime — is treated as NOT ours (the pid is
// stale → signal nothing; the caller still removes the file).
function ownsDetachedRun(
  pid: number,
  workroot: string,
  pidPath: string
): boolean {
  const command = runCapture("ps", ["-o", "command=", "-p", String(pid)], {
    root: workroot,
  });
  if (
    command.error ||
    command.status !== 0 ||
    !command.stdout.includes("dobby dev")
  ) {
    return false;
  }
  // (b) Start-time guard against pid REUSE across worktrees. pidfile mtime ≈ when we
  // recorded the pid; the process's `ps` etime gives its start (now − elapsed). Owned
  // only when the process is no NEWER than the pidfile write, within a 15s tolerance.
  let pidfileMtimeMs: number;
  try {
    pidfileMtimeMs = statSync(pidPath).mtimeMs;
  } catch {
    return false;
  }
  const etime = runCapture("ps", ["-o", "etime=", "-p", String(pid)], {
    root: workroot,
  });
  if (etime.error || etime.status !== 0) {
    return false;
  }
  const elapsedSeconds = parseEtimeSeconds(etime.stdout);
  if (elapsedSeconds === null) {
    return false;
  }
  const processStartMs = Date.now() - elapsedSeconds * 1000;
  const toleranceMs = 15_000;
  return processStartMs <= pidfileMtimeMs + toleranceMs;
}

// Parse `ps -o etime=` elapsed time to whole seconds. Grammar `[[dd-]hh:]mm:ss` (each
// field one-or-more digits; days optional, hours optional). Deterministic — any shape
// outside the grammar returns null (the caller treats that as NOT ours). Pure; kept
// private because the only reachable caller is the kill path, which is a documented
// non-CI boundary (a real matching process can't be conjured through the run() seam).
function parseEtimeSeconds(raw: string): number | null {
  const match = PS_ETIME_RE.exec(raw.trim());
  if (match === null || match[3] === undefined || match[4] === undefined) {
    return null;
  }
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const hours = match[2] === undefined ? 0 : Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}
