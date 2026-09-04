import {
  appendFileSync,
  mkdirSync,
  readdirSync,
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
// managed-group teardown), tearing a REGISTERED run down from the outside
// (`killFromPidfile`, called by `down` regardless of which environment adapter is
// currently active), and listing the reclaim SIDECARS a captured-but-never-restored
// registration can leave behind (`listStaleSidecars`, consulted by `down`'s plan so
// its sweep treats every leftover exactly like `dev.pid` itself). Sits BELOW both
// `environment.ts` and `lifecycle.ts` in the import graph — it imports neither of
// them, so both may import THIS module freely without ever risking a cycle.

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
// The filename prefix EVERY reclaim sidecar shares (`reclaimStalePath` appends
// `.<pid>.<attempt>`) — what `listStaleSidecars` matches against `.dobby/`'s own
// entries.
const STALE_SIDECAR_PREFIX = "dev.pid.stale.";

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
    // rule above. Neither dead nor foreign — a failed restore must NEVER
    // discard this file either (see `restoreOrKeep`): the peer's `wx` create
    // already exists, its write is still coming, and dropping the capture now
    // would leave that peer's eventual registration with nothing on disk
    // naming it — the exact P1 this round closes, one branch over.
    restoreOrKeep(stalePath, pidPath);
    return { pid: null, registered: false };
  }
  const capturedPid = livePidAt(stalePath, workroot);
  if (capturedPid !== null) {
    // Live and OWNED: a peer's fresh registration completed AFTER our read
    // above — never stale. Put it back and defer to it. A failed restore
    // NEVER discards this file — see `restoreOrKeep`.
    restoreOrKeep(stalePath, pidPath);
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

// Put a captured file (empty/in-flight, or live-and-OWNED) back exactly where
// it came from. When a THIRD registrant has already retaken `pidPath` in the
// meantime the rename fails — and the sidecar is NEVER discarded on that
// failure, for either capture shape: it still holds ANOTHER run's registration
// (an in-flight peer's about-to-land pid, or a live, owned one — review round
// 3, greptile P1: three overlapping `dev`s can have A capture B's registration,
// then C recreate `dev.pid` before A's restore lands), and deleting it would
// make that run invisible to every future `up`/`down`. Only a capture that
// RE-CLASSIFIES as dead or foreign (`classifyCapture`'s third branch) is ever
// removed. A failed restore instead leaves the sidecar on disk for `down`'s
// sidecar sweep (`killFromPidfile`, driven by `listStaleSidecars`) to find and
// act on later.
function restoreOrKeep(stalePath: string, pidPath: string): void {
  try {
    renameSync(stalePath, pidPath);
  } catch {
    // Leave the sidecar exactly where it is — see the comment above.
  }
}

// Where a reclaim moves a registration out of the way before re-classifying
// it — namespaced by THIS process's pid (so two concurrent reclaimers never
// aim their rename at the same destination) AND a per-process, monotonically
// increasing ATTEMPT counter (so THIS process's own bounded retry never aims
// two separate captures at the same destination either). Without the attempt
// number, a live-and-owned capture that `restoreOrKeep` leaves behind on a
// failed restore (review round 3) could be silently overwritten by a LATER
// capture from the same process's own retry (`classifyCapture`'s recursive
// `registerOrReclaim` call) — clobbering the first capture's registration
// exactly as invisibly as the original bug this round fixes.
let reclaimAttempts = 0;

function reclaimStalePath(pidPath: string): string {
  reclaimAttempts += 1;
  return `${pidPath}.stale.${process.pid}.${reclaimAttempts}`;
}

// The prefix EVERY sidecar THIS process's own reclaim attempts share — pid
// only, no attempt number, so it matches all of them. Used by `clearOwnPidfile`
// to find every one of THIS process's own leftovers without touching a peer's.
function ownStalePrefix(pidPath: string): string {
  return `${pidPath}.stale.${process.pid}.`;
}

/**
 * Every reclaim sidecar (`.dobby/dev.pid.stale.*`) currently sitting in
 * `<workroot>/.dobby/`, as paths relative to `workroot` — a reclaim that
 * captured a registration but then failed to restore it (see `restoreOrKeep`)
 * leaves one of these behind PER ATTEMPT (`reclaimStalePath` keys each by pid
 * AND a monotonic attempt counter, so a process's own bounded retry never
 * clobbers an earlier capture with a later one), and it may be the ONLY record
 * left of the run it names. `[]` when `.dobby/` does not exist. Read fresh on
 * every call; never cached.
 *
 * @public — `down`'s sidecar sweep (`lifecycle.ts`'s `runDown`), which treats
 * each entry exactly like `dev.pid` itself via `killFromPidfile`; also
 * `clearOwnPidfile`'s own best-effort sweep of ITS OWN leftovers.
 */
export function listStaleSidecars(workroot: string): string[] {
  const dobbyDir = join(workroot, ".dobby");
  let entries: string[];
  try {
    entries = readdirSync(dobbyDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(STALE_SIDECAR_PREFIX))
    .map((name) => `.dobby/${name}`);
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
//
// REVIEW ROUND 5, greptile P1: a positive "owned" verdict counts, exactly as
// before — but so does a LIVE pid whose verdict is merely "unknown" (`ps`
// exited nonzero, or its `etime` would not parse). Both readers of this
// function — the fast-path check `liveRegisteredPid` makes before `dev` even
// tries to register, and `classifyCapture`'s re-classification of whatever a
// reclaim physically captured on `EEXIST` — must agree that "I could not ask
// `ps`" is never license to treat a live process as absent. This is a
// REGISTRY: the cost of a false "still running" is a `dev` that refuses and
// tells the operator to run `dobby down` (the documented escape hatch, which
// removes the file unconditionally); the cost of a false "not registered"
// is a second server coming up while the first keeps running with nothing on
// disk naming it — silently losing the very thing this file exists to
// prevent. Only a pid that is DEAD, or one `ps` POSITIVELY reports as not a
// dobby run, may be reclaimed — null only for those two cases (or no pid to
// read at all).
function livePidAt(pidPath: string, workroot: string): number | null {
  const pid = readPidAt(pidPath);
  if (pid === null) {
    return null;
  }
  const verdict = ownershipVerdict(pid, workroot, pidPath);
  if (verdict === "not-owned") {
    return null;
  }
  if (verdict === "unknown" && !isAlive(pid)) {
    return null;
  }
  return pid;
}

// The raw pid parsed from `path`'s content, with NO liveness/ownership check —
// `null` for an unreadable file or unparseable content. Shared by `livePidAt`
// (which layers the liveness+ownership check on top) and `clearOwnPidfile`
// (which only needs the bare pid, to compare against ITS OWN, never someone
// else's liveness).
function readPidAt(path: string): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    return null;
  }
  return Number.isInteger(pid) ? pid : null;
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
 * ALSO sweeps every reclaim sidecar THIS process's own attempts left behind
 * (`.stale.<our-pid>.<attempt>` — no longer only a rare double-fault: since
 * review round 3, `restoreOrKeep` deliberately LEAVES a captured registration
 * behind when a restore back to `dev.pid` fails), but NEVER by filename alone:
 * a sidecar is removed here only when its CONTENT is either our own pid, or
 * `ownershipVerdict` POSITIVELY classifies the pid it names as "not-owned"
 * (dead — `isAlive` false — or a `ps` command line that provably isn't a
 * dobby run). Everything else stays: a positively "owned" pid protects a live
 * peer's only registration exactly as before (review round 3 follow-up,
 * greptile P1 restated one call site over — deleting it here would drop it
 * exactly as invisibly as the original bug); an "unknown" verdict — `ps`
 * failing outright, or answering an elapsed time that will not parse — says
 * NOTHING about the pid, and review round 4's greptile P1 is exactly this:
 * reading that silence as "not owned" deletes a live peer's only registration
 * just as surely as the round 3 bug did. Either kept case is left for `down`'s
 * own sweep (`listStaleSidecars` + `killFromPidfile`) to find and act on later
 * — the only path allowed to sign off on a live pid that isn't ours, and one
 * that removes every sidecar it finds regardless of what it names.
 *
 * @public — self-teardown for `dobby dev`.
 */
export function clearOwnPidfile(workroot: string): void {
  const pidPath = join(workroot, PIDFILE_REL);
  const ownPrefix = ownStalePrefix(pidPath);
  for (const rel of listStaleSidecars(workroot)) {
    const sidecarPath = join(workroot, rel);
    if (!sidecarPath.startsWith(ownPrefix)) {
      continue;
    }
    const capturedPid = readPidAt(sidecarPath);
    if (capturedPid === process.pid) {
      rmSync(sidecarPath, { force: true });
      continue;
    }
    // No pid to compare against `capturedPid` (empty or unparseable content) —
    // never our business to adjudicate: an EMPTY sidecar can still be a peer's
    // in-flight write about to land on the same inode (`classifyCapture`'s
    // first branch), so treat it exactly like an inconclusive probe below and
    // leave it for `down`'s sweep.
    const verdict =
      capturedPid === null
        ? "unknown"
        : ownershipVerdict(capturedPid, workroot, sidecarPath);
    // Only a POSITIVE "not-owned" (dead, or a `ps` command line that is
    // provably not a dobby run) earns removal here. "owned" protects a live
    // peer's only registration; "unknown" — `ps` failing or answering an
    // elapsed time that doesn't parse — says nothing at all, and reading
    // silence as absence would delete that same live peer's registration.
    // Either way the sidecar stays on disk for `down`'s own sweep
    // (`listStaleSidecars` + `killFromPidfile`), which removes every sidecar
    // regardless of what it names.
    if (verdict === "not-owned") {
      rmSync(sidecarPath, { force: true });
    }
  }
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
// `dev`'s own SIGTERM handler already tears its child group down) when `ownershipVerdict`
// POSITIVELY answers "owned" (see below); either way remove the pidfile (a stale pid, or
// one this probe cannot classify, is cleaned up silently — `down`'s sweep signals only a
// positively-owned pid but always removes the file). Returns whether a live, owned
// process was actually signalled. The ownership check guards against pid reuse: a
// recycled pid can pass `isAlive` (EPERM counts even another user's process alive), so we
// never signal a process that isn't ours — and an INCONCLUSIVE probe (`ps` failing, or an
// elapsed time that won't parse) is treated exactly like "not owned" here: never signalled,
// same as before this file gained a third verdict.
export function killFromPidfile(pidPath: string, workroot: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return false;
  }
  const owned =
    Number.isInteger(pid) &&
    ownershipVerdict(pid, workroot, pidPath) === "owned";
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

// The three answers an ownership probe can give: positively "owned" (both the
// command-line signature AND the start-time match below), positively
// "not-owned" (the pid is dead, or `ps` names a process that provably is not a
// dobby run, or one whose start time provably falls outside the tolerance),
// or "unknown" — `ps` itself could not be believed (missing, refused, or
// answering an elapsed time that will not parse) — REVIEW ROUND 4, greptile
// P1: an "unknown" verdict says NOTHING about the pid, and a caller that folds
// it into "not owned" risks discarding a live peer's only registration
// (`clearOwnPidfile`'s sidecar sweep — the only caller that acts differently
// on "unknown" than it would on "not-owned"; every other caller below still
// treats anything short of "owned" as not-ours, unchanged from before this
// type existed).
type OwnershipVerdict = "owned" | "not-owned" | "unknown";

// `isAlive` short-circuits first — a dead pid is a positive "not-owned" verdict
// on its own, and there is no reason to shell out to `ps` about a pid that is
// already provably gone.
function ownershipVerdict(
  pid: number,
  workroot: string,
  pidPath: string
): OwnershipVerdict {
  if (!isAlive(pid)) {
    return "not-owned";
  }
  return ownsDetachedRun(pid, workroot, pidPath);
}

// Whether `pid` (already known alive) is OUR detached run — requires BOTH (a) the
// command-line signature (a `dobby dev` run, in any legitimate launch shape — see
// `DOBBY_DEV_COMMAND_RE`) AND (b) a start-time match: the process must have started no
// later than the pidfile was written (+ tolerance).
// (a) alone is insufficient — the signature matches ANY dobby dev, including another
// worktree's (parallel goals are the kit's normal mode), so a recycled pid now running
// an UNRELATED workspace's dev group would still match. The start-time guard closes
// that: a process that came up AFTER we recorded this pid can't be the one we recorded.
// `ps` is a system tool → bare. A `ps` that FAILS or answers something this function
// cannot parse says NOTHING about the pid — "unknown", never "not-owned": review round 4,
// greptile P1, closed here at the source so every caller inherits the fix. Only a `ps`
// that ANSWERS is entitled to a positive verdict either way — a command line that is
// provably not a dobby run ("not-owned"), or a start time provably inside/outside the
// tolerance ("owned"/"not-owned").
function ownsDetachedRun(
  pid: number,
  workroot: string,
  pidPath: string
): OwnershipVerdict {
  const command = runCapture("ps", ["-o", "command=", "-p", String(pid)], {
    root: workroot,
  });
  if (command.error || command.status !== 0 || command.stdout.trim() === "") {
    return "unknown";
  }
  if (!DOBBY_DEV_COMMAND_RE.test(command.stdout)) {
    return "not-owned";
  }
  // (b) Start-time guard against pid REUSE across worktrees. pidfile mtime ≈ when we
  // recorded the pid; the process's `ps` etime gives its start (now − elapsed). Owned
  // only when the process is no NEWER than the pidfile write, within a 15s tolerance.
  // An unstat-able pidfile is left as a positive "not-owned" — unlike the `ps` failures
  // above, nothing here is inconclusive: the file this probe was asked about is simply
  // gone, and the spec scopes the new "unknown" verdict to the `ps` probes only.
  let pidfileMtimeMs: number;
  try {
    pidfileMtimeMs = statSync(pidPath).mtimeMs;
  } catch {
    return "not-owned";
  }
  const etime = runCapture("ps", ["-o", "etime=", "-p", String(pid)], {
    root: workroot,
  });
  if (etime.error || etime.status !== 0) {
    return "unknown";
  }
  const elapsedSeconds = parseEtimeSeconds(etime.stdout);
  if (elapsedSeconds === null) {
    return "unknown";
  }
  const processStartMs = Date.now() - elapsedSeconds * 1000;
  const toleranceMs = 15_000;
  return processStartMs <= pidfileMtimeMs + toleranceMs ? "owned" : "not-owned";
}

// Parse `ps -o etime=` elapsed time to whole seconds. Grammar `[[dd-]hh:]mm:ss` (each
// field one-or-more digits; days optional, hours optional). Deterministic — any shape
// outside the grammar returns null (the caller treats that as "unknown", never a
// positive verdict either way). Pure; kept
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
