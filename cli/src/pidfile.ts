import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
// Matches a `dobby dev` command line in any legitimate launch shape: `bunx dobby dev`;
// `bun <…>/node_modules/.bin/dobby dev`; `bun <…>/@kvnwolf/dobby/src/index.ts dev`; and
// `bun <…>/dobby/cli/src/index.ts dev` (this repo's own dogfooded run). Requires a
// `dobby` path segment (preceded by start-of-string or whitespace/`/`) followed by zero
// or more further path segments and then `dev` as the LAST word — so `… dev --dry-run`
// (dev not last) and a path with no `dobby` segment at all both correctly fail to match.
const DOBBY_DEV_COMMAND_RE = /(^|[\s/])dobby([\s/][^\s]*)*\s+dev\s*$/;

// The registry path, relative to a workroot.
const PIDFILE_REL = ".dobby/dev.pid";

/**
 * The outcome of `writePidfile`: `{ registered: true }` once THIS process now
 * owns `.dobby/dev.pid`, or `{ registered: false, pid }` when it does not —
 * `pid` names the process still holding the registration when known, and is
 * `null` for the in-flight window (an EMPTY file: a peer between its own
 * create and its own write) where no pid can yet be read.
 */
export type PidfileRegistration =
  | { registered: true }
  | { registered: false; pid: number | null };

/**
 * Register THIS process in `<workroot>/.dobby/dev.pid` (creating `.dobby/` and
 * gitignoring it first), ATOMICALLY: the create is `writeFileSync(path, pid, {
 * flag: "wx" })`, which fails `EEXIST` when a file is already there — closing
 * the read-then-write race two `dev`s started in the same tick would otherwise
 * hit. On `EEXIST`:
 *   - an EMPTY existing file means a peer is between ITS create and ITS write
 *     (in flight) — never reclaimed, refused with `pid: null`;
 *   - a pid that is alive and OWNED (`liveRegisteredPid`'s semantics) —
 *     refused, naming that pid;
 *   - a dead or unowned pid (stale) — reclaimed by an ATOMIC RENAME of the
 *     registry to a `.stale.<our-pid>` sidecar (never a `rm`), so a peer
 *     reclaiming the SAME file at the same instant either loses the rename
 *     outright (`ENOENT`, defers to `wx` below) or wins it and then
 *     RE-CLASSIFIES what it actually captured — never the read made before
 *     the rename, since a peer can complete its OWN reclaim in that gap. An
 *     empty or live-and-owned capture is put back exactly where it came from
 *     and deferred to (retried, bounded, if that peer then vanishes); only a
 *     capture that is STILL dead/unowned is reclaimed, via the same `wx`
 *     retry, which remains the single arbiter either way.
 *
 * Called by `dobby dev`'s streaming path (`runDev`) at startup, once `planDev`'s
 * soft pre-check has found no live twin — this is the hard, race-proof gate
 * behind it, so a later `down` (via `killFromPidfile`) or `liveRegisteredPid`
 * can find and identify whichever run actually won.
 *
 * @public — self-registration for `dobby dev`.
 */
export function writePidfile(workroot: string): PidfileRegistration {
  const dobbyDir = join(workroot, ".dobby");
  mkdirSync(dobbyDir, { recursive: true });
  ensureGitignored(workroot, ".dobby/");
  const pidPath = join(dobbyDir, "dev.pid");
  return registerOrReclaim(pidPath, workroot, 0);
}

// The bounded retry depth `registerOrReclaim` allows itself when a captured
// registration turns out to belong to a peer that then vanishes before the
// re-check below can confirm it — a double-fault so rare the tests never hit
// it, but recursion still needs a floor under it rather than running forever.
const MAX_RECLAIM_RETRIES = 3;

function registerOrReclaim(
  pidPath: string,
  workroot: string,
  depth: number
): PidfileRegistration {
  if (tryCreatePidfile(pidPath)) {
    return { registered: true };
  }
  if (isEmptyPidfile(pidPath)) {
    return { pid: null, registered: false };
  }
  const twin = liveRegisteredPid(workroot);
  if (twin !== null) {
    return { pid: twin, registered: false };
  }
  // Dead or unowned A MOMENT AGO — reclaim ATOMICALLY: rename the file out of
  // the way (never `rm` it) and retry `wx`. The rename, not the read above, is
  // the race-proof step: a peer can complete its OWN full reclaim (its own
  // rename + wx) in the gap between our read and our rename, so whatever we
  // physically capture below is re-classified from scratch by
  // `classifyCapture` — never trusted from the read above — before we decide
  // it was ever ours to take.
  const stalePath = reclaimStalePath(pidPath);
  try {
    renameSync(pidPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // A peer's rename beat ours — the file at `pidPath` right now (if any) is
    // theirs to adjudicate, never ours to move. `wx` remains the single
    // arbiter either way.
    if (tryCreatePidfile(pidPath)) {
      return { registered: true };
    }
    return {
      pid: isEmptyPidfile(pidPath) ? null : liveRegisteredPid(workroot),
      registered: false,
    };
  }
  return classifyCapture(stalePath, pidPath, workroot, depth);
}

// What renaming `pidPath` to `stalePath` actually captured — decided fresh
// against the file we are now physically holding, never against the read that
// led us here (a peer may have completed its OWN reclaim, and even its own
// registration, in that gap).
function classifyCapture(
  stalePath: string,
  pidPath: string,
  workroot: string,
  depth: number
): PidfileRegistration {
  if (isEmptyPidfile(stalePath)) {
    // In flight: a peer between ITS create and ITS write — the pending write
    // still lands on the same inode wherever it currently sits, so put it
    // back exactly where it was and refuse, same as the ordinary in-flight
    // rule above.
    restoreOrDiscard(stalePath, pidPath);
    return { pid: null, registered: false };
  }
  const capturedPid = livePidAt(stalePath, workroot);
  if (capturedPid !== null) {
    // Live and OWNED: a peer's fresh registration completed AFTER our read
    // above — never stale. Put it back and defer to it.
    restoreOrDiscard(stalePath, pidPath);
    const twinNow = liveRegisteredPid(workroot);
    if (twinNow !== null) {
      return { pid: twinNow, registered: false };
    }
    // The peer vanished between our restore and this re-check — try the
    // whole dance again against the file as it now stands, bounded so a
    // pathological environment can never spin forever.
    return depth < MAX_RECLAIM_RETRIES
      ? registerOrReclaim(pidPath, workroot, depth + 1)
      : { pid: null, registered: false };
  }
  // Genuinely dead or unowned — safe to reclaim. Only the process that
  // captured the file removes it, whether `wx` below wins or loses.
  try {
    if (tryCreatePidfile(pidPath)) {
      return { registered: true };
    }
    return {
      pid: isEmptyPidfile(pidPath) ? null : liveRegisteredPid(workroot),
      registered: false,
    };
  } finally {
    rmSync(stalePath, { force: true });
  }
}

// Put a captured file back exactly where it came from, or discard it when a
// THIRD registrant has already retaken `pidPath` in the meantime (nothing sane
// left to restore it to — the content we captured is superseded).
function restoreOrDiscard(stalePath: string, pidPath: string): void {
  try {
    renameSync(stalePath, pidPath);
  } catch {
    rmSync(stalePath, { force: true });
  }
}

// Where a reclaim moves a registration out of the way before re-classifying
// it — namespaced by THIS process's pid, so two concurrent reclaimers never
// aim their rename at the same destination.
function reclaimStalePath(pidPath: string): string {
  return `${pidPath}.stale.${process.pid}`;
}

// The atomic create: `wx` fails EEXIST when the file is already there (created
// by a peer, or left stale by an earlier run) rather than silently overwriting
// it. Any OTHER error propagates — only EEXIST is this function's business.
function tryCreatePidfile(pidPath: string): boolean {
  try {
    writeFileSync(pidPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

// Whether the pidfile at `pidPath` currently holds no content — the in-flight
// window between a peer's `wx` create (the file now exists) and that same
// peer's write landing (the pid is not yet readable). A vanished file (the
// peer already finished, or `down` cleared it) answers false, deferring to
// `liveRegisteredPid` — which reads null for a missing file — to drive reclaim.
function isEmptyPidfile(pidPath: string): boolean {
  try {
    return readFileSync(pidPath, "utf8").trim() === "";
  } catch {
    return false;
  }
}

/**
 * The registered pid, but ONLY when it is both alive and OWNED by this workroot (see
 * `ownsDetachedRun`) — null for every other case: no pidfile, an unparseable pid, a dead
 * pid, or a reused pid that now belongs to something else. Never throws.
 *
 * @public — the already-registered-run check for `up`/`env` (later task in this plan).
 */
export function liveRegisteredPid(workroot: string): number | null {
  return livePidAt(join(workroot, PIDFILE_REL), workroot);
}

// `liveRegisteredPid`'s own check, parameterized over the path to read — so a
// reclaim can ask the identical question of a `.stale.<pid>` file it just
// captured by rename, not only of the registry's canonical path. `pidPath` is
// also what `ownsDetachedRun` stats for the pidfile's mtime; a POSIX rename
// preserves a file's mtime, so asking about the renamed copy answers exactly
// what asking about the original would have.
function livePidAt(pidPath: string, workroot: string): number | null {
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
 * ALSO sweeps our own `.stale.<our-pid>` reclaim sidecar, if one is somehow
 * still there — belt-and-braces alongside the `finally` inside `writePidfile`
 * that normally removes it inline.
 *
 * @public — self-teardown for `dobby dev`.
 */
export function clearOwnPidfile(workroot: string): void {
  const pidPath = join(workroot, PIDFILE_REL);
  // Tolerate a leftover `.stale.<pid>` this process's own reclaim may have left
  // behind (normally cleaned up inline by `writePidfile`'s `finally`, but
  // belt-and-braces here too) — `force: true` already makes this a silent
  // no-op when there is nothing to remove.
  rmSync(reclaimStalePath(pidPath), { force: true });
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
// (a `dobby dev` run, in any legitimate launch shape — see `DOBBY_DEV_COMMAND_RE`) AND
// (b) a start-time match: the process must have started no later than the pidfile was
// written (+ tolerance).
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
    !DOBBY_DEV_COMMAND_RE.test(command.stdout)
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
