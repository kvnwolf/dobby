import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { browserGuideFor } from "./browser-guide.ts";
import { runCapture, spawnBackground } from "./runner.ts";

// The ENVIRONMENT ADAPTER SEAM (issue #27): everywhere the kit's mechanics differ by
// host runner — the run surface, the browser surface, workspace naming, pane
// discovery, teardown, and the UI-verification guide — is behind ONE `Environment`
// interface, resolved ONCE per command via `detectEnvironment()`. Two real
// implementations today: `cmuxEnvironment` (a cmux workspace is present — the
// existing pane mechanics, extracted unchanged) and `terminalEnvironment` (no cmux —
// a detached process + pidfile). A future runner (Claude Desktop, Conductor,
// super.engineering) is a THIRD implementation of this same interface; this file
// intentionally ships no stub for one — see the module CONTEXT.md.
//
// What stays OUT of this seam (lifecycle.ts owns it): portless, the liveness probe,
// Neon branch provisioning, the `up`/`down` plan-rendering data (`UpAction` /
// `DownAction` / `UpPlan` / `DownPlan`) — none of that varies by host runner.

// Top-level regexes (biome useTopLevelRegex).
const SURFACE_REF_RE = /surface:\S+/;
const PANE_REF_RE = /pane:\S+/;
const WHITESPACE_SPLIT_RE = /\s+/;
const TRAILING_SLASH_RE = /\/$/;
const PS_ETIME_RE = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;

// The command every adapter's run surface starts. One literal, shared by the `up`
// plan (lifecycle.ts's `buildUpActions`, for `--dry-run` rendering) and the real
// mechanics here, so they can never diverge.
export const DEV_START_COMMAND = "bunx dobby dev";

// The kit's two named surface refs, discovered by title. `null` when a surface
// doesn't exist (or the environment has no concept of one, e.g. terminal). Not
// exported — reached only through `Environment.discoverPanes`'s return type.
interface PaneRefs {
  browserPane: string | null;
  runPane: string | null;
}

// What `up`'s run/browser-surface mechanics need from the resolved context —
// deliberately NOT `lifecycle.ts`'s `UpContext`: this file must never import from
// lifecycle.ts (lifecycle.ts imports THIS file). `UpContext` structurally satisfies
// this — it carries every field here plus more (`cmux`, `neon`) — so passing it at
// a call site needs no adapter object of its own. Not exported — reached only
// through `Environment`'s surface-method parameter types.
interface SurfaceContext {
  devUrl: string | null;
  slug: string;
  workroot: string;
}

// The adapter interface every host runner implements: detection/naming (`cmux`),
// the run surface, the browser surface, workspace naming, pane discovery, and
// teardown of the surfaces it owns. `browserGuide()` is the UI-verification
// protocol `dobby env` reports — delegated to `browser-guide.ts`, never dissolved
// into this file.
export interface Environment {
  // The verification guide for this environment (see browser-guide.ts).
  browserGuide: () => string;
  // Close whatever surfaces this environment owns (best-effort). Terminal has none
  // (its run process is torn down separately, by `killFromPidfile` — see below).
  closeSurfaces: (workroot: string) => void;
  // The CMUX_WORKSPACE_ID value this environment was detected from, or `null` for
  // the terminal adapter. Reported verbatim as `EnvSnapshot.cmux` / `UpFacts.cmux`.
  readonly cmux: string | null;
  // Discover the kit's run/browser surface refs, or `{ null, null }` when this
  // environment has no such concept (terminal) or none are open.
  discoverPanes: (workroot: string | null) => PaneRefs;
  // Ensure the browser surface exists on `context.devUrl` (no-op for terminal —
  // it has no browser surface).
  ensureBrowserSurface: (context: SurfaceContext) => void;
  // Ensure the run surface is running `dobby dev`. Returns whether the run surface
  // is now in place — `true` always for cmux (best-effort; cmux owns the process),
  // the real detached-spawn outcome for terminal (so a failed spawn can fail `up`
  // fast instead of waiting on liveness for a server that never started).
  ensureRunSurface: (context: SurfaceContext) => boolean;
  // Rename the workspace to `title` (no-op for terminal — it has no workspace).
  renameWorkspace: (workroot: string, title: string) => void;
}

// Resolve the environment for THIS process, from `CMUX_WORKSPACE_ID` — the single
// read every command-level caller (`collectEnv`, `runUp`, `runDown`) makes ONCE and
// threads through, replacing what were four independent reads of the same variable.
// Reads `process.env` fresh on every call (never memoized): tests toggle the
// variable between cases within one process.
export function detectEnvironment(): Environment {
  const cmux = process.env.CMUX_WORKSPACE_ID || null;
  return cmux === null ? terminalEnvironment() : cmuxEnvironment(cmux);
}

// ---------------------------------------------------------------------------
// The cmux adapter — the existing pane mechanics, extracted with their
// invocations unchanged (`new-pane`, `send`, `rename-workspace`, `rename-tab`,
// `list-panes`, `list-pane-surfaces`, `close-surface`).
// ---------------------------------------------------------------------------

function cmuxEnvironment(cmux: string): Environment {
  return {
    browserGuide: () => browserGuideFor(cmux),
    closeSurfaces: (workroot) => closeKitPanes(workroot, cmux),
    cmux,
    discoverPanes: (workroot) => discoverPanesFor(workroot, cmux),
    ensureBrowserSurface: (context) => ensureBrowserPane(context, cmux),
    ensureRunSurface: (context) => {
      ensureRunPane(context, cmux);
      return true;
    },
    renameWorkspace: (workroot, title) =>
      renameCmuxWorkspace(workroot, cmux, title),
  };
}

// Rename the cmux WORKSPACE to the plain goal `title` (the slug) so the user can
// tell which workspace belongs to which goal at a glance. Idempotent by nature
// (re-running re-renames to the same title). Best-effort — a cmux failure never
// blocks the run. NOT CI-tested.
function renameCmuxWorkspace(
  workroot: string,
  cmux: string,
  title: string
): void {
  runCapture("cmux", ["rename-workspace", "--workspace", cmux, title], {
    root: workroot,
  });
}

// ---------------------------------------------------------------------------
// cmux pane orchestration (up) — the two kit panes, created in TIME order.
//
// The RUN terminal opens at START time (its purpose is watching the server boot);
// the BROWSER pane opens only once liveness confirms the devUrl responds — a pane
// created alongside the boot renders a 404 until the server is up. On the ALREADY-LIVE
// short-circuit only the BROWSER pane is reconciled: up starts nothing there, so a
// missing run pane is left missing rather than recreated + sent a second `dobby dev`.
//
// Each pane is created INDEPENDENTLY (`new-pane --direction right`, right of Claude)
// rather than by splitting its sibling: cmux's `new-split` carries no `--type`, so
// a browser pane can only be born from `new-pane`, and the old surface-targeted
// `new-split down` (run BELOW browser) would have forced the browser to exist first.
//
// Both are create-missing-only (spec up step 1): a surviving kit pane is REUSED by
// its discovered surface ref, never duplicated. Surface refs are captured from cmux
// stdout with the spec-mandated discovery-diff fallback (the stdout ref format is
// runtime-unverified). NOT CI-tested for the real cmux; the ORDERING is.
// ---------------------------------------------------------------------------

// Ensure the RUN terminal exists and is running `dobby dev`: reuse a surviving
// `dobby-run-<slug>` pane, else create it right of Claude, rename it, and send the
// workroot-pinned start line. Called ONLY on the FRESH-START path (where up owns the
// start), at START time — never gated on liveness. The already-live short-circuit
// deliberately does NOT call this: sending the start line to an app that already
// answers would double-start the dev server (see executeUp step 1).
function ensureRunPane(context: SurfaceContext, cmux: string): void {
  if (discoverPanesFor(context.workroot, cmux).runPane !== null) {
    return;
  }
  const runRef = createNamedPane(
    context.workroot,
    cmux,
    ["--direction", "right"],
    `dobby-run-${context.slug}`
  );
  // No ref → the pane can't be targeted; nothing to send into.
  if (runRef === null) {
    return;
  }
  runCapture(
    "cmux",
    [
      "send",
      "--surface",
      runRef,
      `cd ${context.workroot} && ${DEV_START_COMMAND}\n`,
    ],
    {
      root: context.workroot,
    }
  );
}

// Ensure the BROWSER pane exists on the devUrl: reuse a surviving
// `dobby-browser-<slug>` pane, else create it right of Claude and rename it. Called
// ONLY when the app is confirmed live (the already-up short-circuit, or after the
// liveness wait succeeded) — never while the server is still booting.
function ensureBrowserPane(context: SurfaceContext, cmux: string): void {
  if (discoverPanesFor(context.workroot, cmux).browserPane !== null) {
    return;
  }
  createNamedPane(
    context.workroot,
    cmux,
    [
      "--type",
      "browser",
      ...(context.devUrl === null ? [] : ["--url", context.devUrl]),
      "--direction",
      "right",
    ],
    `dobby-browser-${context.slug}`
  );
}

// Create a cmux pane (`new-pane --workspace <id> <args…>`), resolve its surface ref
// (stdout token, discovery-diff fallback) and rename it `title`. Returns the ref, or
// null when it can't be resolved (nothing to rename or target).
function createNamedPane(
  workroot: string,
  cmux: string,
  args: string[],
  title: string
): string | null {
  const before = listAllSurfaces(workroot, cmux);
  const created = runCapture(
    "cmux",
    ["new-pane", "--workspace", cmux, ...args],
    { root: workroot }
  );
  const ref =
    captureSurfaceRef(created.stdout) ??
    diffNewSurface(before, listAllSurfaces(workroot, cmux));
  if (ref === null) {
    return null;
  }
  runCapture("cmux", ["rename-tab", "--surface", ref, title], {
    root: workroot,
  });
  return ref;
}

// The first `surface:<ref>` token in cmux stdout, or null (format runtime-unverified).
function captureSurfaceRef(stdout: string): string | null {
  return SURFACE_REF_RE.exec(stdout)?.[0] ?? null;
}

// Every surface ref in the cmux workspace — the discovery-diff fallback input.
// Tolerant: any failure yields an empty set.
function listAllSurfaces(workroot: string, cmux: string): Set<string> {
  const refs = new Set<string>();
  const panes = runCapture("cmux", ["list-panes", "--workspace", cmux], {
    root: workroot,
  });
  if (panes.status !== 0) {
    return refs;
  }
  for (const line of panes.stdout.split("\n")) {
    const paneRef = PANE_REF_RE.exec(line)?.[0];
    if (paneRef === undefined) {
      continue;
    }
    const surfaces = runCapture(
      "cmux",
      ["list-pane-surfaces", "--workspace", cmux, "--pane", paneRef],
      { root: workroot }
    );
    if (surfaces.status !== 0) {
      continue;
    }
    for (const surfaceLine of surfaces.stdout.split("\n")) {
      const ref = SURFACE_REF_RE.exec(surfaceLine)?.[0];
      if (ref !== undefined) {
        refs.add(ref);
      }
    }
  }
  return refs;
}

// The one surface present in `after` but not `before` (the just-created pane).
function diffNewSurface(
  before: Set<string>,
  after: Set<string>
): string | null {
  for (const ref of after) {
    if (!before.has(ref)) {
      return ref;
    }
  }
  return null;
}

// Discover and close the kit panes (`cmux close-surface --surface <ref>` each).
// Live cmux IPC; a no-op when nothing is discoverable. NOT CI-tested.
function closeKitPanes(workroot: string, cmux: string): void {
  const panes = discoverPanesFor(workroot, cmux);
  for (const ref of [panes.browserPane, panes.runPane]) {
    if (ref !== null) {
      runCapture("cmux", ["close-surface", "--surface", ref], {
        root: workroot,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Kit pane refs — discovered through cmux's local IPC (never a network probe).
// Walk the workspace's panes and their surfaces, matching surface titles
// `dobby-run-<slug>` / `dobby-browser-<slug>` where slug is the workroot directory
// basename, and report the matching surface refs.
//
// Any failure — no workroot, cmux binary absent, access denied, no matching
// surface — folds to null (env never fails). The exact cmux listing stdout format
// is runtime-unverified (see research); the parser is deliberately tolerant (scan
// lines for `<kind>:<ref>` tokens, substring-match titles) and is CI-null
// regardless (no reachable cmux surface), with live behavior covered by the
// wrap-stage human smoke.
// ---------------------------------------------------------------------------

function discoverPanesFor(workroot: string | null, cmux: string): PaneRefs {
  const none = { browserPane: null, runPane: null };
  if (workroot === null) {
    return none;
  }
  const slug = basename(workroot);
  const runTitle = `dobby-run-${slug}`;
  const browserTitle = `dobby-browser-${slug}`;

  const panes = runCapture("cmux", ["list-panes", "--workspace", cmux], {
    root: workroot,
  });
  if (panes.status !== 0) {
    return none;
  }
  const paneRefs = parseRefs(panes.stdout, "pane");
  if (paneRefs.length === 0) {
    return none;
  }

  let runPane: string | null = null;
  let browserPane: string | null = null;
  for (const pane of paneRefs) {
    const surfaces = runCapture(
      "cmux",
      ["list-pane-surfaces", "--workspace", cmux, "--pane", pane],
      { root: workroot }
    );
    if (surfaces.status !== 0) {
      continue;
    }
    for (const line of surfaces.stdout.split("\n")) {
      if (runPane === null && line.includes(runTitle)) {
        runPane = refOf(line, "surface");
      }
      if (browserPane === null && line.includes(browserTitle)) {
        browserPane = refOf(line, "surface");
      }
    }
    if (runPane !== null && browserPane !== null) {
      break;
    }
  }
  return { browserPane, runPane };
}

// Extract the ref token of `kind` (e.g. "pane" / "surface") from each non-empty
// line of a cmux listing. cmux "Output defaults to refs" (`pane:3`, `surface:4`);
// we scan for that token and fall back to the line's first whitespace-delimited
// field when it is absent (format is runtime-unverified).
function parseRefs(stdout: string, kind: string): string[] {
  const refs: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const ref = refOf(line, kind);
    if (ref !== null) {
      refs.push(ref);
    }
  }
  return refs;
}

// The `kind:ref` token in a line (`surface:4`), or the first field as a fallback.
function refOf(line: string, kind: string): string | null {
  const token = new RegExp(`${kind}:\\S+`).exec(line);
  if (token !== null) {
    return token[0];
  }
  const [first] = line.trim().split(WHITESPACE_SPLIT_RE);
  return first === undefined || first === "" ? null : first;
}

// ---------------------------------------------------------------------------
// The terminal adapter — no cmux workspace. A REAL second implementation, not
// "cmux with no-ops": its run surface is a detached process + pidfile, it has no
// browser surface, and its verification guide is the non-cmux ladder.
// ---------------------------------------------------------------------------

function terminalEnvironment(): Environment {
  return {
    browserGuide: () => browserGuideFor(null),
    closeSurfaces: () => {
      // No surfaces of its own — the detached run is torn down by `killFromPidfile`
      // (see below), called directly by lifecycle.ts's `down` teardown regardless
      // of which environment is active (a stale pidfile is cleaned up either way).
    },
    cmux: null,
    discoverPanes: () => ({ browserPane: null, runPane: null }),
    ensureBrowserSurface: () => {
      // No browser surface in a plain terminal.
    },
    ensureRunSurface: (context) => startDetached(context),
    renameWorkspace: () => {
      // No workspace to rename in a plain terminal.
    },
  };
}

// ---------------------------------------------------------------------------
// Detached start (up, no cmux) — hand `dobby dev` to the OS, keep the handles.
// ---------------------------------------------------------------------------

// Spawn `dobby dev` DETACHED with output to <workroot>/.dobby/dev.log and its pid
// to <workroot>/.dobby/dev.pid (so a later `down` can signal the group), ensuring
// .dobby/ is gitignored. Returns true when the spawn took (pid written), false when
// the spawn failed (no pidfile) so `up` can fail fast instead of waiting on liveness
// for a server that never started. NOT CI-tested.
function startDetached(context: SurfaceContext): boolean {
  const dobbyDir = join(context.workroot, ".dobby");
  mkdirSync(dobbyDir, { recursive: true });
  ensureGitignored(context.workroot, ".dobby/");
  const pid = spawnBackground("bunx", ["dobby", "dev"], {
    logPath: join(dobbyDir, "dev.log"),
    root: context.workroot,
  });
  if (pid === undefined) {
    return false;
  }
  writeFileSync(join(dobbyDir, "dev.pid"), `${pid}\n`);
  return true;
}

// Append `entry` to <workroot>/.gitignore when absent (idempotent). Best-effort.
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
// Detached teardown (down, no cmux) — kill the process GROUP the pidfile names.
//
// Deliberately a STANDALONE export, not an `Environment` interface method: `down`
// calls this whenever `.dobby/dev.pid` exists on disk, regardless of which
// environment is CURRENTLY active (a stale pidfile left over from an earlier
// terminal run must still be cleaned up even if this `down` runs under cmux) — so
// gating it behind "is the terminal adapter active" would silently stop cleaning
// up a stale pidfile under cmux, a behavior change this extraction must not make.
// ---------------------------------------------------------------------------

// Kill the detached run's process GROUP (SIGTERM to -pid) when the pid is still alive
// AND `ownsDetachedRun` confirms both the command-line signature AND the start-time
// (see below); either way remove the pidfile (a stale pid is cleaned up silently). The
// ownership check guards against pid reuse: a recycled pid can pass `isAlive` (EPERM
// counts even another user's process alive), so we never signal a group that isn't ours.
export function killFromPidfile(pidPath: string, workroot: string): void {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return;
  }
  if (
    Number.isInteger(pid) &&
    isAlive(pid) &&
    ownsDetachedRun(pid, workroot, pidPath)
  ) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The group already vanished — nothing to signal.
    }
  }
  rmSync(pidPath, { force: true });
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
