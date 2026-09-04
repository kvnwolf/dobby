import type { ChildProcess } from "node:child_process";
import {
  copyFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { loadConfig } from "./config.ts";
import { detectCapabilities, scanCapabilities } from "./detect.ts";
import { resolveDevUrl } from "./envinfo.ts";
import {
  detectEnvironment,
  type Environment,
  type Instruction,
  type Topic,
} from "./environment.ts";
import {
  installPrePushHook,
  type PrePushHookAction,
  planPrePushHook,
} from "./hook-install.ts";
import {
  clearOwnPidfile,
  killFromPidfile,
  listStaleSidecars,
  liveRegisteredPid,
  writePidfile,
} from "./pidfile.ts";
import {
  configArgs,
  requireWorkroot,
  resolveBin,
  resolveViteConfig,
  resolveWorkroot,
  runCapture,
  runInherit,
  spawnDetached,
} from "./runner.ts";
import {
  type DbCommand,
  type DbTaskSet,
  type DevCommand,
  type DevPlan,
  dbTasks,
  devPlan,
  drizzleConfigSpec,
  UPDATE_ARGS,
  viteBlockedMessage,
  viteConfigSpec,
} from "./tasks.ts";

// Top-level regexes (biome useTopLevelRegex — a regex literal inside a function is
// recompiled on every call). Named by what they match.
const GLOB_META_RE = /[*?]/;
const DATABASE_URL_LINE_RE = /^\s*DATABASE_URL\s*=/;
const DATABASE_URL_UNPOOLED_LINE_RE = /^\s*DATABASE_URL_UNPOOLED\s*=/;
const POOLER_HOST_RE = /^([^.]+)\./;

// The action-command executors (the inferred `db:*` tasks, `update`, and
// `up`/`down`/`dev`). They are the IMPURE counterpart to the pure planners in
// `tasks.ts`: they resolve the workroot, touch the filesystem, and spawn children —
// always through `runner.ts` so every child's cwd is pinned to the workroot. Each
// returns DATA (a plan + outcome); `run.ts` owns ALL rendering, so nothing here
// formats output.
//
// node:*-only (vitest imports this under Node/Vite; Bun runs it in production).

// ---------------------------------------------------------------------------
// The SETUP PHASE — folded into `dobby up` (Findings #32: the user always wants a
// workspace running when opening it, so `setup` is no longer a standalone command).
//
// The ordered sequence `up` runs BEFORE its run phase:
//   (1) `bun install` at the workroot — ALWAYS, the inferred default.
//   (2) the PRE-PUSH BACKSTOP install (`hook-install.ts`) — idempotent, in every
//       consumer (spec Decision 7): the setup phase runs even for a no-app
//       project, which is what makes this the one step that reaches them all.
//       Ordered after install so a fresh clone has its local dobby on disk before
//       a hook that execs it can fire.
//   (3) worktree env re-materialization — in a LINKED git worktree only: read the
//       MAIN checkout's `.worktreeinclude`, and for each pattern copy any matched
//       file that is MISSING at the worktree over from main (idempotent — NEVER
//       overwriting a file already present). The belt-and-suspenders complement to
//       the native EnterWorktree copy (documented as ambiguous).
//   (4) config `setup[]` extras — run sequentially, FAIL-FAST on the first nonzero.
//
// `up --dry-run` builds the SAME ordered plan but executes nothing; a real `up`
// executes it fail-fast and only starts the run phase once every step succeeds.
// ---------------------------------------------------------------------------

// One planned setup step. The plan is pure data; `run.ts` renders it and the
// executor below runs it.
export type SetupAction =
  | { kind: "install" }
  | PrePushHookAction
  | { kind: "copy"; rel: string; from: string; to: string }
  | { kind: "extra"; run: string };

// The documented TEST SEAM (task constraint): when `DOBBY_SKIP_INSTALL=1` the
// executor skips ONLY the `bun install` step while still performing the copy +
// extras — so a real run is exercised without ever invoking bun (which the tests
// forbid). Test-only; never set in production.
const SKIP_INSTALL_ENV = "DOBBY_SKIP_INSTALL";

// Build the ordered setup-phase plan for the workroot: (1) install (always),
// (2) the pre-push backstop hook, (3) worktree copies (linked-worktree only,
// missing-only), (4) config `setup[]` extras — in that fixed order. Extras APPEND
// after the defaults. No side effects: the git queries it makes (the worktree
// probe, the hooks path, the marker read) only OBSERVE — nothing is written until
// `executeSetup` walks the plan, which is what makes `--dry-run` honest.
function buildSetupPlan(
  root: string,
  config: { setup?: string[] } | null
): SetupAction[] {
  const plan: SetupAction[] = [{ kind: "install" }];
  const hook = planPrePushHook(root);
  if (hook !== null) {
    plan.push(hook);
  }
  for (const copy of planWorktreeCopies(root)) {
    plan.push(copy);
  }
  for (const extra of config?.setup ?? []) {
    plan.push({ kind: "extra", run: extra });
  }
  return plan;
}

// Run the setup plan in order, fail-fast. Returns the first failing step's exit
// code (0 on success) alongside a `failure` note naming what failed (else null) and
// the machine-readable `reason` for it (the `up --json` enum; null on success).
// `childOutputToStderr` streams each child's stdout to fd 2 — set when the caller
// reserved stdout for the JSON report (see runUp's `machineReport`).
function executeSetup(
  plan: SetupAction[],
  root: string,
  childOutputToStderr: boolean
): UpOutcome {
  const skipInstall = Boolean(process.env[SKIP_INSTALL_ENV]);
  const stdio = { root, stdoutToStderr: childOutputToStderr };

  for (const action of plan) {
    if (action.kind === "install") {
      if (skipInstall) {
        continue;
      }
      const code = runInherit("bun", ["install"], stdio);
      if (code !== 0) {
        return {
          exitCode: code,
          failure: "`bun install` failed",
          reason: "install-failed",
        };
      }
    } else if (action.kind === "hook") {
      // The pre-push backstop. Never fails the phase: a hook that could not be
      // written (an unwritable hooks dir) or one this dobby did not write (the
      // refuse-and-report policy — the plan already named the file) leaves the
      // workspace perfectly runnable, and `up`'s job is to bring it up.
      installPrePushHook(action);
    } else if (action.kind === "copy") {
      const copyFailure = copyIncluded(action);
      if (copyFailure !== null) {
        return copyFailure;
      }
    } else {
      // Extras run through the workroot-pinned runner (sh -c), streaming so a long
      // setup step's progress is visible. Fail-fast: a nonzero exit stops the run.
      const code = runInherit("sh", ["-c", action.run], stdio);
      if (code !== 0) {
        return {
          exitCode: code,
          failure: `setup extra failed (exit ${code}): ${action.run}`,
          reason: "setup-extra-failed",
        };
      }
    }
  }

  return { exitCode: 0, failure: null, reason: null };
}

// Perform ONE worktree re-materialization copy. Idempotent by planning (the plan
// only lists MISSING targets, so a locally-edited file is never clobbered). Returns
// null on success, or the setup failure when the copy throws (an unreadable source,
// a read-only target): a half-materialized worktree must never reach the run phase,
// and `--json` needs a mappable reason instead of an escaping exception.
function copyIncluded(action: {
  from: string;
  rel: string;
  to: string;
}): UpOutcome | null {
  try {
    mkdirSync(dirname(action.to), { recursive: true });
    copyFileSync(action.from, action.to);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      failure: `could not re-materialize ${action.rel} from the main checkout: ${detail}`,
      reason: "worktree-copy-failed",
    };
  }
}

// The worktree re-materialization plan: copy actions for every `.worktreeinclude`
// match present in the MAIN checkout but MISSING at the worktree. Empty unless
// `root` is a LINKED git worktree whose main checkout carries a `.worktreeinclude`.
function planWorktreeCopies(
  root: string
): Array<{ kind: "copy"; rel: string; from: string; to: string }> {
  const mainRoot = linkedWorktreeMain(root);
  if (mainRoot === null) {
    return [];
  }
  const includePath = join(mainRoot, ".worktreeinclude");
  if (!existsSync(includePath)) {
    return [];
  }

  let raw: string;
  try {
    raw = readFileSync(includePath, "utf8");
  } catch {
    return [];
  }

  const copies: Array<{ kind: "copy"; rel: string; from: string; to: string }> =
    [];
  const seen = new Set<string>();
  for (const pattern of parseIncludePatterns(raw)) {
    for (const rel of matchInMain(mainRoot, pattern)) {
      if (seen.has(rel)) {
        continue;
      }
      seen.add(rel);
      const to = join(root, rel);
      // Missing-only: an already-present target is left untouched (idempotent).
      if (existsSync(to)) {
        continue;
      }
      copies.push({ from: join(mainRoot, rel), kind: "copy", rel, to });
    }
  }
  return copies;
}

/**
 * The MAIN checkout root when `root` is a LINKED git worktree, else null. A linked
 * worktree is detected by `--git-dir` differing from `--git-common-dir`; the main
 * checkout root is the PARENT of the common `.git` directory. Both queried as
 * absolute paths so the comparison and dirname are reliable. Never throws — a
 * non-git / non-worktree root yields null (re-materialization simply skips).
 *
 * @public — the shared "am I in a worktree, and where is main?" resolver: the
 * setup phase's re-materialization uses it, and the session preflights
 * (`preflight.ts`) resolve `mainRoot` + nesting through it.
 */
export function linkedWorktreeMain(root: string): string | null {
  const result = runCapture(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { root }
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) {
    return null;
  }
  const [gitDir, commonDir] = lines;
  // Equal dirs => the main checkout itself (not a linked worktree) => no copy.
  if (gitDir === commonDir || commonDir === undefined) {
    return null;
  }
  return dirname(commonDir);
}

// Parse a `.worktreeinclude` body into pattern lines: trim each line, drop blanks
// and `#` comments, and strip a leading `./`.
function parseIncludePatterns(raw: string): string[] {
  const patterns: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    patterns.push(trimmed.startsWith("./") ? trimmed.slice(2) : trimmed);
  }
  return patterns;
}

// Resolve a single `.worktreeinclude` pattern to the relative paths it matches in
// the MAIN checkout. A literal pattern (no `*`/`?`) is a direct existence check —
// the common case (`.env.local`) and the one that dodges dotfile/glob edge cases.
// A glob walks the main checkout (skipping `.git`/`node_modules`) and regex-matches
// relative paths — matching gitignored dotfiles too (no shell-style dot exclusion),
// since those are precisely the files a worktree lacks.
function matchInMain(mainRoot: string, pattern: string): string[] {
  if (!GLOB_META_RE.test(pattern)) {
    return existsSync(join(mainRoot, pattern)) ? [pattern] : [];
  }
  const regex = globToRegExp(pattern);
  const matches: string[] = [];
  for (const rel of walkFiles(mainRoot, "")) {
    if (regex.test(rel)) {
      matches.push(rel);
    }
  }
  return matches;
}

// Regex characters (other than the glob metachars `*`/`?`) that must be escaped
// when a glob is translated to a RegExp. The `$`, `{`, `}` are literal regex
// metacharacters here — not a template placeholder.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex metacharacters, not an interpolation
const REGEX_SPECIALS = ".+^${}()|[]\\";

// Translate a glob to an anchored RegExp: `**` matches across path separators,
// `*` matches within one segment, `?` matches a single non-separator character.
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char !== undefined && REGEX_SPECIALS.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

// Yield every FILE under `root` as a relative POSIX path, skipping `.git` and
// `node_modules`. Tolerant: an unreadable directory contributes nothing.
function* walkFiles(root: string, prefix: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      yield* walkFiles(root, rel);
    } else if (entry.isFile()) {
      yield rel;
    }
  }
}

// ---------------------------------------------------------------------------
// `dobby db:<task>` — the inferred database tasks
//
// The pure name→command map lives in `tasks.ts` (`dbTasks`); this executor
// detects the project's capabilities, resolves the requested task through that
// map, and — unless `--dry-run` — resolves the tool bin CONSUMER-local and spawns
// it (cwd pinned to the workroot). Unknown / ambiguous names fail with the set of
// names that IS available, so the caller sees exactly what to type instead.
// ---------------------------------------------------------------------------

// The outcome of a db task:
//   - `{ ok: false, error }`   — no db capability, or an unknown/ambiguous name.
//     `run.ts` prints `error` on stderr with exit 1 (the available-names hint is
//     baked INTO `error`).
//   - `{ ok: true, kind: "plan" }`  — `--dry-run`: the RESOLVED tool bin (CONSUMER
//     node_modules/.bin path, or the bare name when absent) + args + workroot,
//     rendered by `run.ts`, nothing spawned.
//   - `{ ok: true, kind: "ran" }`   — a real run: the child's exit code plus an
//     optional `failure` note (tool not installed, nonzero exit).
export type DbTaskReport =
  | { ok: false; error: string }
  | { ok: true; kind: "plan"; bin: string; command: DbCommand; cwd: string }
  | { ok: true; kind: "ran"; exitCode: number; failure: string | null };

// Resolve and (unless dry-run) run the `db:<task>` named `name` for the project at
// `cwd`. Capabilities are detected from `cwd` (a single-package project runs dobby
// at its root); the workroot is resolved for the pinned spawn cwd, so a real run
// fails hard outside a git repo. `--dry-run` never spawns — it returns the resolved
// command for `run.ts` to print.
export function runDbTask(
  name: string,
  cwd: string,
  opts: { dryRun: boolean }
): DbTaskReport {
  const set = dbTasks(detectCapabilities(cwd));

  if (set.mode === "none") {
    return {
      error:
        "no database capability detected — dobby infers db:* tasks from a drizzle project",
      ok: false,
    };
  }

  const command = set.tasks.get(name);
  if (command === undefined) {
    return { error: dbUnknownMessage(name, set), ok: false };
  }

  let root: string;
  try {
    root = requireWorkroot(cwd);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }

  // Config-less default (ADR-0015): drizzle-kit gains `--config=<preset>` when the
  // consumer ships no drizzle.config.* — the SAME augmented args feed the dry-run
  // plan and the real spawn, so the plan never lies. A consumer file → NO extra
  // args (bare — native discovery, a total override).
  const cfgArgs = configArgs(root, drizzleConfigSpec()).args;
  const augmented: DbCommand = {
    args: [...command.args, ...cfgArgs],
    tool: command.tool,
  };

  if (opts.dryRun) {
    // Resolve the tool bin CONSUMER-local (part c: the dry-run plan renders the
    // RESOLVED path so the resolution is observable) — bare fallback when absent.
    const bin = resolveBin(command.tool, { root, scope: "consumer" });
    return { bin, command: augmented, cwd: root, kind: "plan", ok: true };
  }

  return { kind: "ran", ok: true, ...executeDbCommand(augmented, root) };
}

// Build the error for an unresolved db name, listing the available (short) drizzle
// task names so the caller sees exactly what to type instead.
function dbUnknownMessage(name: string, set: DbTaskSet): string {
  const available = [...set.tasks.keys()];
  return `unknown db task: ${name}\navailable: ${available.join(", ")}`;
}

// Spawn a resolved db command. The tool bin is resolved CONSUMER-local via the
// shared resolver (the consumer's own node_modules/.bin); a detected-but-not-
// installed tool (resolveBin fell back to the bare name) yields a clear "run dobby
// up" failure rather than a raw ENOENT. The command inherits stdio (finite runs
// stream; db:studio is interactive).
function executeDbCommand(
  command: DbCommand,
  root: string
): { exitCode: number; failure: string | null } {
  const bin = resolveBin(command.tool, { root, scope: "consumer" });
  // A bare-name fallback (bin === the tool name) means it is not installed in the
  // consumer's node_modules/.bin — a setup gap, surfaced actionably.
  if (bin === command.tool) {
    return {
      exitCode: 127,
      failure: `${command.tool} not found — run \`dobby up\` to install it`,
    };
  }

  const code = runInherit(bin, command.args, { root });
  return {
    exitCode: code,
    failure: code === 0 ? null : `${command.tool} exited ${code}`,
  };
}

// ---------------------------------------------------------------------------
// `dobby dev` — the run composition (streaming split, part c)
//
// The pure ordered plan lives in `tasks.ts` (`devPlan`); this executor has two
// entry points around it:
//   - `planDev(cwd)` — the CAPTURE path (used by run() for `--dry-run` and the
//     no-app gate): detect capabilities, build the plan, and turn "no app main"
//     OR "a live twin is already registered" (`pidfile.ts`'s `liveRegisteredPid`)
//     into a hard error. No spawn, no registration — dry-run and the in-process
//     `run()` seam must never write the pidfile. This is a SOFT pre-check only
//     (read-then-decide) — it narrows the window but cannot close a race
//     between two `dev`s starting in the same tick.
//   - `runDev(cwd)` — the STREAMING path (used ONLY by the bin, index.ts): once
//     `planDev`'s pre-check clears, register THIS process ATOMICALLY
//     (`writePidfile`, which is the hard gate — refusing here too when it
//     loses a race `planDev` missed) before touching anything else, clear the
//     `.vite` cache, then spawn the portless-wrapped main + the concurrent
//     secondaries as ONE managed process group; on any child exit or a
//     SIGINT/SIGTERM to dobby, clear the registration (`clearOwnPidfile`, only
//     if it still names US) and tear the whole group down, exiting with the
//     MAIN's code. Inherited stdio — it streams and lives until the group
//     exits. NOT CI-tested (spawns real servers) — covered by the wrap-stage
//     human smoke + the QA's live recipe.
// ---------------------------------------------------------------------------

// A dev command whose bin is RESOLVED to a spawnable path: a consumer-local
// node_modules/.bin path, or the bare tool name when the consumer has not
// installed it (the documented fallback). Both the `--dry-run` render and the
// real spawn read this, so the plan can never diverge from what actually runs.
export interface ResolvedDevCommand {
  args: string[];
  bin: string;
}

// The `dobby dev` plan with every bin resolved (part c: the dry-run render shows
// resolved paths). `secondaries` are CONSUMER-local; the main app command is
// wrapped by the BUNDLED portless (also resolved from dobby's tree).
// `cacheClears` stay logical (a native `rm`, never spawned).
export interface ResolvedDevPlan {
  cacheClears: DevCommand[];
  main: {
    portless: string;
    command: ResolvedDevCommand;
  } | null;
  secondaries: ResolvedDevCommand[];
}

// The outcome of planning `dobby dev`:
//   - `{ ok: false, error }` — one of TWO hard gates: no app main (no vite) →
//     the "nothing to run" gate, OR a live, OWNED twin is already registered
//     (`liveRegisteredPid`) → the "already running" gate (names the pid and
//     `dobby down`). Checked here — not in `runDev` — because this is the ONE
//     function both the in-process `run()` seam (which never reaches `runDev`;
//     see `runDev`'s header) and the streaming path share, so it is the
//     cheapest place a refusal is visible to both; it is a SOFT pre-check,
//     though — `runDev`'s own `writePidfile` call is the hard, race-proof gate
//     that can still refuse after this one passes.
//   - `{ ok: true, plan }`   — an app exists and no live twin blocks it; the
//     RESOLVED ordered plan (main, secondaries) is ready to render (dry-run) or
//     execute (streaming).
export type DevReport =
  | { ok: false; error: string }
  | { ok: true; plan: ResolvedDevPlan };

// Build the `dobby dev` plan for the project at `cwd` (the CAPTURE path — no
// spawn). Capabilities are detected from `cwd` (a single-package project runs
// dobby at its root); `config` is threaded for signature-completeness (v1 has no
// config-driven dev behavior). No vite app → the "nothing to run" gate (exit 1);
// `up` is the graceful path for a project with nothing to serve. A live, OWNED
// twin already registered in `.dobby/dev.pid` → the "already running" gate
// (exit 1, naming the pid and `dobby down`) — checked with a SOFT workroot (no
// workroot, no possible pidfile, so the check is simply skipped rather than
// failing hard; the real streaming path re-asserts a hard workroot separately).
export function planDev(cwd: string): DevReport {
  // Scan ONCE for both the capabilities AND the raw dependency set — the latter
  // feeds `viteConfigSpec`'s require-all-imports guard (the tanstack preset is
  // picked only when every package it imports is declared).
  const { capabilities, dependencies } = scanCapabilities(cwd);
  const loaded = loadConfig(cwd);
  const config = loaded?.ok ? loaded.config : null;
  const plan = devPlan(capabilities, config);

  if (plan.main === null) {
    return {
      error:
        "nothing to run — no app capability (no vite) detected; use `dobby up` for the graceful path",
      ok: false,
    };
  }
  // Resolve every bin now (SOFT workroot — the dry-run capture path must not fail
  // hard outside a git repo; a null root leaves consumer bins as bare names, the
  // documented fallback). The real streaming path re-asserts a hard workroot.
  const root = resolveWorkroot(cwd);
  const twin = root === null ? null : liveRegisteredPid(root);
  if (twin !== null) {
    return {
      error: `already running (pid ${twin}) — \`dobby down\` stops it`,
      ok: false,
    };
  }
  // The vite default (ADR-0015): BLOCKED for a config-less tanstack app missing an
  // imported package — no import-safe fallback serves the app, so it is a HARD ERROR
  // through the plan/run error path (dev's 'nothing to run' twin), not a silent base.
  const viteCfg = resolveViteConfig(
    root,
    viteConfigSpec(capabilities, dependencies)
  );
  if (viteCfg.blocked) {
    return { error: viteBlockedMessage(viteCfg.missing), ok: false };
  }
  return {
    ok: true,
    plan: resolveDevPlan(plan, root, viteCfg.args),
  };
}

// Resolve the logical dev plan's bins to spawnable paths: consumer-local for the
// app/email tools (`<root>/node_modules/.bin/<tool>`, bare fallback), BUNDLED for
// the portless wrapper (dobby's own tree). The SAME resolution feeds the dry-run
// render and the real spawn, so the plan never lies about what runs. `viteConfigArgs`
// are the config-less default `--config <preset>` args (ADR-0015) the caller already
// resolved from the workroot (empty when the consumer ships its own vite config) —
// appended so both the dry-run render and the real spawn read the identical path.
// A BLOCKED tanstack default is handled by the caller (`planDev`) BEFORE this point.
function resolveDevPlan(
  plan: DevPlan,
  root: string | null,
  viteConfigArgs: string[]
): ResolvedDevPlan {
  const consumer = (command: DevCommand): ResolvedDevCommand => ({
    args: command.args,
    bin: resolveBin(command.tool, {
      root: root ?? undefined,
      scope: "consumer",
    }),
  });
  // The vite dev command (the main) gains `--config <preset>` when absent — the
  // caller-resolved `viteConfigArgs` (empty when the consumer ships its own config).
  const main = ((): ResolvedDevPlan["main"] => {
    if (plan.main === null) {
      return null;
    }
    const command = consumer(plan.main.command);
    return {
      command: {
        args: [...command.args, ...viteConfigArgs],
        bin: command.bin,
      },
      portless: resolveBin("portless", { scope: "bundled" }),
    };
  })();
  return {
    cacheClears: plan.main?.cacheClears ?? [],
    main,
    secondaries: plan.secondaries.map(consumer),
  };
}

// Execute a live `dobby dev` (the STREAMING path). Returns the process exit code
// once the managed group tears down. The bin (index.ts) is the ONLY caller — it
// installs no output capture, so children stream straight to the terminal.
export async function runDev(cwd: string): Promise<number> {
  const report = planDev(cwd);
  if (!report.ok) {
    process.stderr.write(`${report.error}\n`);
    return 1;
  }

  let root: string;
  try {
    root = requireWorkroot(cwd);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }

  const { cacheClears, main, secondaries } = report.plan;
  if (main === null) {
    // Unreachable: planDev returns ok only when the app main exists.
    return 1;
  }

  // Register THIS process — `planDev` (above) is only a SOFT pre-check (it can
  // race another `dev` started in the same tick); `writePidfile` is the hard,
  // atomic gate that actually decides the winner. Before any cache clear or
  // spawn, so a refused run starts nothing and a crash between here and the
  // managed group still leaves an accurate registration for the next `dev` or a
  // `down` to find.
  const registration = writePidfile(root);
  if (!registration.registered) {
    const pidNote =
      registration.pid === null ? "" : ` (pid ${registration.pid})`;
    process.stderr.write(
      `already running${pidNote} — \`dobby down\` stops it\n`
    );
    return 1;
  }

  // (1) Cache-clear (`rm -rf node_modules/.vite`) — done natively, before spawning.
  for (const clear of cacheClears) {
    const target = clear.args.at(-1);
    if (clear.tool === "rm" && target !== undefined) {
      rmSync(join(root, target), { force: true, recursive: true });
    }
  }

  // (2) The portless-wrapped main + concurrent secondaries as ONE managed group.
  // portless resolves from DOBBY's OWN tree (bundled); the app/email bins are
  // consumer-local; portless wraps ONLY the main. A bare (unresolved) portless
  // means dobby's own tree is broken — fail with the clear message.
  if (!isAbsolute(main.portless)) {
    process.stderr.write(
      "could not resolve the bundled portless binary from dobby\n"
    );
    return 1;
  }
  const mainSpawn = {
    args: [main.portless, "run", main.command.bin, ...main.command.args],
    bin: process.execPath,
  };
  const secondarySpawns = secondaries.map((secondary) => ({
    args: secondary.args,
    bin: secondary.bin,
  }));

  return await runManagedGroup(mainSpawn, secondarySpawns, root);
}

// Spawn the main + secondaries as ONE managed process group and resolve once it
// tears down. Each child is DETACHED (its own group) via the runner, so teardown
// is `process.kill(-pid, …)` — the child AND its descendants (vite workers, the
// email dev server, …) die together. ANY child exiting, or a SIGINT/SIGTERM to
// dobby, collapses the whole group; the resolved code is the MAIN's exit code (a
// secondary dying or a signal is a nonzero teardown). node:child_process semantics
// only. Teardown ALSO clears our own registry entry (`clearOwnPidfile` — only when
// it still names US, so a newer `dev` that already overwrote the pidfile is not
// un-registered by this older one finishing its shutdown).
function runManagedGroup(
  main: { bin: string; args: string[] },
  secondaries: Array<{ bin: string; args: string[] }>,
  root: string
): Promise<number> {
  const mainChild = spawnDetached(main.bin, main.args, { root });
  const secondaryChildren = secondaries.map((spec) =>
    spawnDetached(spec.bin, spec.args, { root })
  );
  const children = [mainChild, ...secondaryChildren];

  return new Promise<number>((resolve) => {
    let settled = false;
    const teardown = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearOwnPidfile(root);
      for (const child of children) {
        killGroup(child);
      }
      resolve(code);
    };

    for (const child of children) {
      child.on("exit", (childCode, signal) => {
        const code = child === mainChild ? (childCode ?? (signal ? 1 : 0)) : 1;
        teardown(code);
      });
      child.on("error", () => teardown(1));
    }

    // Detached children sit in their own process groups, so a terminal Ctrl-C does
    // NOT reach them — dobby receives the signal and forwards teardown to the group.
    process.on("SIGINT", () => teardown(130));
    process.on("SIGTERM", () => teardown(143));
  });
}

// SIGTERM a child's whole process group (the NEGATIVE pid). Guards against a child
// that never started or already exited; a vanished group is ignored.
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already dead or no such group — nothing to tear down.
  }
}

// ---------------------------------------------------------------------------
// `dobby build` — the inferred mechanical build (ADR-0015)
//
// External builders build THROUGH dobby: a consumer's Vercel `buildCommand` is
// `bunx dobby build`, so dobby (not the raw framework CLI) owns the build spawn —
// which lets future niceties (env checks, cache warmup, telemetry) land CENTRALLY
// without every consumer editing its buildCommand. The real run is the consumer's
// OWN `vite build` (never dobby's — the dual-Vite invariant) + the config-less
// default `--config <preset>` (ADR-0015) when the consumer ships no vite config.
//
// Capability-gated on `vite` (mirroring `dev`'s gate): no vite → exit 1 'nothing to
// build'. FINITE (not the streaming split) — it is dispatched inside run() and
// inherits stdio through the runner (the `db:*` pattern), so run() renders the
// outcome. `--dry-run` renders the plan (bin + args + pinned cwd), no spawn.
// `check --build` reuses the SAME config resolution (viteConfigSpec).
// ---------------------------------------------------------------------------

// The outcome of `dobby build`:
//   - `{ ok: false, error }` — no vite capability ('nothing to build'), or outside
//     a git repo. `run.ts` prints `error` on stderr with exit 1.
//   - `{ ok: true, kind: "plan", bin, args, cwd }` — `--dry-run`: the RESOLVED
//     consumer vite bin + args (incl. the `--config` default when absent) + the
//     pinned workroot, rendered by `run.ts`, nothing spawned.
//   - `{ ok: true, kind: "ran", exitCode, failure }` — a real run: the child's exit
//     code plus an optional failure note (vite not installed, nonzero exit).
export type BuildReport =
  | { ok: false; error: string }
  | { ok: true; kind: "plan"; bin: string; args: string[]; cwd: string }
  | { ok: true; kind: "ran"; exitCode: number; failure: string | null };

// Resolve and (unless dry-run) run `vite build` for the project at `cwd`.
// Capabilities are detected from `cwd` (a single-package project runs dobby at its
// root); no vite → the hard 'nothing to build' gate (dev's gate's twin). The
// workroot is resolved for the pinned spawn cwd, so a real run fails hard outside a
// git repo.
export function runBuild(cwd: string, opts: { dryRun: boolean }): BuildReport {
  // Scan ONCE — capabilities gate the build, the dependency set feeds
  // `viteConfigSpec`'s require-all-imports guard (tanstack preset vs vite base).
  const { capabilities, dependencies } = scanCapabilities(cwd);
  if (!capabilities.includes("vite")) {
    return {
      error:
        "nothing to build — no app capability (no vite) detected; `dobby build` is the inferred build for vite apps",
      ok: false,
    };
  }

  let root: string;
  try {
    root = requireWorkroot(cwd);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }

  const bin = resolveBin("vite", { root, scope: "consumer" });
  const viteCfg = resolveViteConfig(
    root,
    viteConfigSpec(capabilities, dependencies)
  );
  // BLOCKED (ADR-0015): a config-less tanstack app missing an imported package has no
  // import-safe fallback that serves — fail loud (exit 1) via the run error path (the
  // 'nothing to build' twin) in BOTH dry-run and a real build. Never a silent base.
  if (viteCfg.blocked) {
    return { error: viteBlockedMessage(viteCfg.missing), ok: false };
  }
  const args = ["build", ...viteCfg.args];

  if (opts.dryRun) {
    return { args, bin, cwd: root, kind: "plan", ok: true };
  }

  // A bare-name fallback (bin === "vite") means it is not installed in the
  // consumer's node_modules/.bin — a setup gap, surfaced actionably (mirrors db:*).
  if (bin === "vite") {
    return {
      exitCode: 127,
      failure: "vite not found — run `dobby up` to install it",
      kind: "ran",
      ok: true,
    };
  }

  const code = runInherit(bin, args, { root });
  return {
    exitCode: code,
    failure: code === 0 ? null : `vite build exited ${code}`,
    kind: "ran",
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// `dobby update` — taze in interactive mode
//
// Resolves taze from DOBBY's OWN dependency tree (it is bundled, not a consumer
// dep) and runs it with inherited stdio: the interactive picker is driven by the
// user and terminates with them. Fails hard outside a git repo (an action command).
// ---------------------------------------------------------------------------

// The outcome of `dobby update`:
//   - `{ ok: false, error }` — outside a git repo, or the bundled taze is missing.
//   - `{ ok: true, exitCode }` — taze ran (interactively); its exit code, streamed.
export type UpdateReport =
  | { ok: false; error: string }
  | { ok: true; exitCode: number };

export function runUpdate(cwd: string): UpdateReport {
  let root: string;
  try {
    root = requireWorkroot(cwd);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }

  // taze is BUNDLED — resolve it from dobby's OWN tree, run via process.execPath
  // (bun runs the resolved bin). A bare (unresolved) taze means dobby's own tree
  // is broken; surface the clear message rather than a raw PATH miss.
  const bin = resolveBin("taze", { scope: "bundled" });
  if (!isAbsolute(bin)) {
    return {
      error: "could not resolve the bundled taze binary from dobby",
      ok: false,
    };
  }

  return {
    exitCode: runInherit(process.execPath, [bin, ...UPDATE_ARGS], { root }),
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// `dobby up` / `dobby down` — the run-lifecycle pair
//
// `up` is THE single lifecycle entry point: it PREPARES the workspace (the setup
// phase — bun install + linked-worktree `.worktreeinclude` re-materialization +
// config `setup[]` extras, fail-fast) and THEN brings the app up (liveness-first,
// idempotent). `down` mechanizes finish teardown. Both are ACTION commands (fail
// hard outside a git repo) and both expose `--dry-run`, which builds the SAME
// decision-derived plan but executes NOTHING. `up --dry-run` prints the FULL ordered
// plan — the setup phase THEN the run phase, including what would be skipped and why.
// `run.ts` renders the plan (a list of `SetupAction` + `UpAction` / `DownAction` —
// this module returns DATA, run.ts owns all formatting); a real run walks the same
// decisions imperatively.
//
// The plan-vs-execution split is deliberate: the DRY-RUN plan is fully CI-tested
// (through the `--dry-run` render), while the real execution (curl liveness probe,
// `bunx neonctl` branch create/delete, the cmux pane orchestration with its
// runtime surface-ref capture, the detached spawn) needs a live server / cmux /
// neonctl and is covered by the QA's live recipe + the wrap-stage human
// smoke — NOT CI (mirroring how `dev`'s streaming path is handled). The cmux stdout
// ref format is runtime-unverified, so the orchestration carries the spec-mandated
// discovery-diff fallback. The ONE execution property CI does pin is the pane-vs-
// liveness ORDER (browser pane strictly after a successful probe), through a real
// `up` run against stub `cmux`/`curl` bins on PATH.
//
// slug = workroot basename (a spec Decision); the neon branch is `dobby/<slug>`
// (SLASH), the kit panes are `dobby-{browser,run}-<slug>` (DASHES).
// ---------------------------------------------------------------------------

// The single liveness probe: `curl -sf --max-time 5 <devUrl>` — HTTP 200 on the
// portless root (neither consumer has a health endpoint). The retry wait loops it.
const LIVENESS_MAX_TIME_SEC = 5;
const LIVENESS_RETRIES = 6;
const LIVENESS_INTERVAL_SEC = 5;

// The documented TEST SEAM for the retry wait (the sibling of `DOBBY_SKIP_INSTALL`):
// `DOBBY_LIVENESS_RETRIES=<n>` caps the number of probes, so a test can exercise the
// never-reachable path (which must NOT open the browser pane) without sitting through
// minutes of real `sleepSync`. Test-only; never set in production. The PLAN reads the
// same resolved value, so `--dry-run` never lies about how long a real run would wait.
const LIVENESS_RETRIES_ENV = "DOBBY_LIVENESS_RETRIES";

// The effective probe count: the seam's positive integer when set, else the default.
function livenessRetries(): number {
  const raw = process.env[LIVENESS_RETRIES_ENV];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : LIVENESS_RETRIES;
}

// One planned `up` action, discriminated by `kind`. `run.ts` renders each to its
// shell-style plan line(s); `executeUp` performs the real operation. Every literal
// a test reads (the neon branch verb, the liveness-probe shape) is carried HERE as
// data. Since TASK 4 `up` no longer plans its own start (cmux pane / detached
// spawn) — that is now an `Instruction` (see `UpPlan.instructions`), quoted by
// `run.ts`'s `formatUpPlan` under an `agent:` hand-over, never executed here.
export type UpAction =
  | { kind: "probe"; url: string | null }
  | { kind: "neon-branch"; branch: string; projectId: string }
  | { kind: "wait"; url: string | null; retries: number; intervalSec: number };

// The ordered `up` plan for `--dry-run`: the workroot it is pinned to, its slug,
// the SETUP-PHASE actions (install → copies → extras) that run first, up's OWN
// run-phase `actions` in execution order (probe → neon → wait — `wait` is what the
// in-flight retry path would run), the INSTRUCTIONS the run would hand over to the
// model (rename when cmux, then start — applicable ones only, same shape as
// `UpFacts.instructions`), and `runSkipped` — the reason the run phase is skipped
// (e.g. 'no app to run') or null when it runs. The rename instruction is present
// whenever cmux is, INDEPENDENT of the app gate — a no-app project still carries
// its goal identity into the workspace title.
export interface UpPlan {
  actions: UpAction[];
  instructions: Instruction[];
  runSkipped: string | null;
  setup: SetupAction[];
  slug: string;
  workroot: string;
}

// WHY `up` failed, as a CLOSED enum — the machine-readable half of every failure
// (the human prose keeps going to stderr, unchanged). One member per failure path
// runUp can take, in the order the path is reached:
//   not-a-git-repo      — the workroot precondition (requireWorkroot threw).
//   config-unreadable   — dobby.config.json exists but does not parse.
//   install-failed      — the setup phase's `bun install` step exited nonzero.
//   worktree-copy-failed— a `.worktreeinclude` re-materialization copy threw.
//   setup-extra-failed  — a config `setup[]` extra exited nonzero.
//   neon-creds-missing  — a neon project without NEON_API_KEY / NEON_PROJECT_ID.
//   neon-branch-failed  — the neon capability's branch could not be provisioned
//                         (`bunx neonctl` failed); the stderr prose names it. NOT
//                         CI-tested (needs real neonctl) — see `provisionNeonBranch`.
//   liveness-timeout    — a start already in flight never answered the devUrl
//                         within the retry wait.
// A consumer branches on these; it must NEVER have to parse prose.
// (`dev-start-failed` LEFT this enum with TASK 4: `up` starts nothing itself
// anymore, so there is no start of its own that can fail — a failed START is now
// something the model that ran the instruction sees in its own stderr.)
type UpReason =
  | "not-a-git-repo"
  | "config-unreadable"
  | "install-failed"
  | "worktree-copy-failed"
  | "setup-extra-failed"
  | "neon-creds-missing"
  | "neon-branch-failed"
  | "liveness-timeout";

// WHERE `up` was when it stopped: the setup phase, the run phase, or the no-app
// gate (nothing to run — a success, not a failure).
type UpPhase = "noop" | "run" | "setup";

// The machine-readable `up` report: flat, EnvSnapshot style (explicit nulls, never
// omitted keys — a consumer branches on `browserPane === null`, which an absent key
// would make indistinguishable from "not reported"). Decided HERE (data); `run.ts`
// renders it as the sole stdout of `up --json`.
interface UpFacts {
  // The kit browser-pane surface ref, or null when none is open. Resolved ONLY for
  // a machine report (see runUp's `machineReport`) — the sole consumer — so a plain
  // `up` never pays for cmux IPC nobody reads.
  browserPane: string | null;
  // The CMUX_WORKSPACE_ID value, or null outside cmux.
  cmux: string | null;
  // The remedy to offer the user, or null when none applies. INSTALL-phase only:
  // re-running with the documented skip seam is what gets past a broken install,
  // and nothing else.
  degradedCommand: string | null;
  // The portless dev URL the app was brought up on, or null (no app / not resolved
  // because the run never reached the run phase).
  devUrl: string | null;
  // What the MODEL must do next — ONLY the applicable ones, ordered `rename`
  // (cmux) then `start`. Always present (possibly empty): a live app with no cmux
  // hands back nothing, an in-flight start that never answers hands back nothing
  // either (the failure IS the report). Each entry is exactly what
  // `environment.instruction(topic, ctx)` returns — never duplicated text here.
  instructions: Instruction[];
  // Whether the devUrl answered the (single, or in-flight-retried) probe. `false`
  // pairs with an `ok:true` "please start it" report just as often as with an
  // `ok:false` timeout — it says nothing about success on its own.
  live: boolean;
  // Whether `up` succeeded. FALSE always pairs with a nonzero exit code.
  ok: boolean;
  phase: UpPhase;
  // Null on success; the enum member on failure — never prose.
  reason: UpReason | null;
  // The goal slug (workroot basename), or null when no workroot resolved.
  slug: string | null;
  // How to verify the work: against the live URL when there is one, else
  // programmatically (tests / CLI) — derived from devUrl, never reported apart.
  verifyMode: "programmatic" | "url";
  // The absolute workroot; the directory `up` ran in when none resolved
  // (not-a-git-repo) — the field is a string so a consumer can always print it.
  workroot: string;
}

// The outcome of `dobby up`:
//   - `{ ok: false, error }` — a HARD failure (outside a git repo; the neon
//     capability present but its creds missing — no silent main-DB fallback).
//     `run.ts` prints `error` on stderr with exit 1.
//   - `{ ok: true, kind: "noop", message }` — the no-app gate: a project with no
//     vite capability has nothing to serve ('no app to run', exit 0) — the graceful
//     counterpart to `dev`'s hard 'nothing to run'.
//   - `{ ok: true, kind: "plan", plan }` — `--dry-run`: the ordered plan to render.
//   - `{ ok: true, kind: "ran", exitCode, failure }` — a real run executed; `failure`
//     names what went wrong (else null), rendered on stderr.
// EVERY arm also carries `facts` — the same outcome as the flat machine report
// (`up --json`). `ok`/`kind` say what run.ts must RENDER; `facts.ok` says whether
// the workspace is up (a failed real run is `{ok: true, kind: "ran"}` with
// `facts.ok === false`).
export type UpReport =
  | { ok: false; error: string; facts: UpFacts }
  | { ok: true; kind: "noop"; message: string; facts: UpFacts }
  | { ok: true; kind: "plan"; plan: UpPlan; facts: UpFacts }
  | {
      ok: true;
      kind: "ran";
      exitCode: number;
      failure: string | null;
      facts: UpFacts;
    };

// The exit outcome of a real phase (setup or run): a clean success, or a failure
// carrying BOTH the human note and its machine-readable reason. Modelled as a union
// so the two can never drift apart — a failure without a reason does not typecheck.
// Shared by `executeSetup` (the setup phase) and `executeUp` (the run phase, via
// `UpRunOutcome` below, which adds the run phase's own `instructions`/`live`).
type UpOutcome =
  | { exitCode: 0; failure: null; reason: null }
  | { exitCode: number; failure: string; reason: UpReason };

// `executeUp`'s own outcome: everything `UpOutcome` carries, PLUS what the run
// phase resolved — `instructions` (what the model must do next) and `live`
// (whether the probe answered). A failure carries an empty instruction list (the
// failure itself IS the report).
type UpRunOutcome = UpOutcome & { instructions: Instruction[]; live: boolean };

// The ONE remedy `up` offers, and only for an install-phase failure: re-run with the
// documented skip seam so a broken/offline install does not block the workspace.
const DEGRADED_UP_COMMAND = "DOBBY_SKIP_INSTALL=1 bunx dobby up";

// Assemble the machine report from what the caller resolved. `verifyMode` and
// `degradedCommand` are DERIVED here so every path agrees on them: a devUrl means
// QA can hit a URL (else it verifies programmatically), and the degraded
// command is attached to install-phase failures alone.
function upFacts(parts: {
  browserPane?: string | null;
  cmux: string | null;
  devUrl?: string | null;
  instructions: Instruction[];
  live: boolean;
  phase: UpPhase;
  reason: UpReason | null;
  slug: string | null;
  workroot: string;
}): UpFacts {
  const devUrl = parts.devUrl ?? null;
  return {
    browserPane: parts.browserPane ?? null,
    cmux: parts.cmux,
    degradedCommand:
      parts.reason === "install-failed" ? DEGRADED_UP_COMMAND : null,
    devUrl,
    instructions: parts.instructions,
    live: parts.live,
    ok: parts.reason === null,
    phase: parts.phase,
    reason: parts.reason,
    slug: parts.slug,
    verifyMode: devUrl === null ? "programmatic" : "url",
    workroot: parts.workroot,
  };
}

// Compute the APPLICABLE instructions for `topics`, in the given order, against the
// resolved surface context — the single helper every `up` path (real run, dry-run
// plan, both `hasApp` arms) uses so `applies: false` entries never leak into a
// report (spec: "instructions holds ONLY applicable ones").
function applicableInstructions(
  environment: Environment,
  topics: Topic[],
  context: { devUrl: string | null; slug: string; workroot: string }
): Instruction[] {
  return topics
    .map((topic) => environment.instruction(topic, context))
    .filter((instruction) => instruction.applies);
}

// The decisions `up` resolves ONCE (git precondition, capabilities, devUrl, cmux,
// neon creds) — the single source both the plan and the imperative execution derive
// from, so `--dry-run` never lies about what a real run would do.
interface UpContext {
  cmux: string | null;
  devUrl: string | null;
  // The resolved adapter — carries the actual run/browser-surface mechanics (see
  // environment.ts). `cmux` above stays as its own field for plan-rendering / report
  // data (`UpAction`, `UpFacts`), unchanged in shape from before the seam.
  environment: Environment;
  neon: { apiKey: string; projectId: string } | null;
  slug: string;
  workroot: string;
}

// Resolve `up` for the git worktree enclosing `cwd`, then either PLAN (`--dry-run`)
// or execute. The single lifecycle entry point:
//   (0) fail hard outside a git repo (git precondition wins over every gate);
//   (1) the SETUP PHASE — bun install + linked-worktree copies + config `setup[]`
//       extras, fail-fast (a real run stops with exit 1 and the run phase never
//       starts on any setup failure);
//   (2) the no-app gate (no vite) — the graceful exit-0 no-op (dev's hard gate's
//       gentle twin), reached only AFTER the setup phase;
//   (3) the RUN PHASE — liveness-first, idempotent; a neon project with missing
//       creds fails hard (guaranteed branch isolation, no main-DB fallback).
// `--dry-run` prints the FULL ordered plan (setup phase + run phase, or the skip
// reason) without executing anything.
//
// `machineReport` (set by `up --json`) changes NO decision — only two mechanics the
// machine report needs: setup children stream their stdout to fd 2 (stdout belongs
// to the JSON object), and the browser-pane ref is discovered for the report.
export function runUp(
  cwd: string,
  opts: { dryRun: boolean; machineReport?: boolean }
): UpReport {
  const machineReport = opts.machineReport === true;
  // The environment — resolved ONCE (independent of the app gate) so it feeds the
  // instruction catalogue, the plan, and every report arm alike. `cmux` is its
  // CMUX_WORKSPACE_ID-derived identity, unchanged in shape from the old direct read.
  const environment = detectEnvironment();
  const { cmux } = environment;

  let workroot: string;
  try {
    workroot = requireWorkroot(cwd);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      // No worktree resolved: the directory `up` ran in is the only root there is,
      // and there is no slug without a workroot to take a basename of.
      facts: upFacts({
        cmux,
        instructions: [],
        live: false,
        phase: "setup",
        reason: "not-a-git-repo",
        slug: null,
        workroot: cwd,
      }),
      ok: false,
    };
  }

  const slug = basename(workroot);
  // Every arm reports the SAME identity (workroot / slug / cmux) and differs only in
  // phase, reason, devUrl, instructions and live. The browser pane is discovered at
  // REPORT time (after any pane this run opened exists) and only for a machine
  // report — a plain `up` must not pay for cmux IPC nobody reads.
  const reportFacts = (parts: {
    devUrl?: string | null;
    instructions: Instruction[];
    live: boolean;
    phase: UpPhase;
    reason: UpReason | null;
  }): UpFacts =>
    upFacts({
      ...parts,
      browserPane: machineReport
        ? environment.discoverPanes(workroot).browserPane
        : null,
      cmux,
      slug,
      workroot,
    });

  // The setup phase reads config `setup[]` extras. A broken config is a hard failure
  // (an action command must not proceed on an unreadable contract); absent = none.
  const loaded = loadConfig(workroot);
  if (loaded && !loaded.ok) {
    return {
      error: loaded.error,
      facts: reportFacts({
        instructions: [],
        live: false,
        phase: "setup",
        reason: "config-unreadable",
      }),
      ok: false,
    };
  }
  const config = loaded?.config ?? null;

  const setupPlan = buildSetupPlan(workroot, config);
  const capabilities = detectCapabilities(cwd);
  const hasApp = capabilities.includes("vite");
  // The workspace rename — an INSTRUCTION now, present whenever cmux is,
  // INDEPENDENT of the app gate: a no-app project still carries its goal identity
  // into the workspace title. `devUrl: null` because it is not yet resolved this
  // early (and the rename instruction never reads it).
  const renameInstructions = applicableInstructions(environment, ["rename"], {
    devUrl: null,
    slug,
    workroot,
  });

  if (opts.dryRun) {
    // No app → the run phase is skipped, but the FULL plan still shows the setup
    // phase, the rename instruction (when cmux), and names the skip reason
    // (spec's --dry-run contract).
    if (!hasApp) {
      return {
        facts: reportFacts({
          instructions: renameInstructions,
          live: false,
          phase: "noop",
          reason: null,
        }),
        kind: "plan",
        ok: true,
        plan: {
          actions: [],
          instructions: renameInstructions,
          runSkipped: "no app to run",
          setup: setupPlan,
          slug,
          workroot,
        },
      };
    }
    const resolved = resolveUpContext(
      cwd,
      workroot,
      slug,
      capabilities,
      environment
    );
    if (!resolved.ok) {
      return {
        error: resolved.error,
        facts: reportFacts({
          instructions: [],
          live: false,
          phase: "run",
          reason: "neon-creds-missing",
        }),
        ok: false,
      };
    }
    // A dry run EXECUTES nothing, so the instructions quoted are what a real run
    // would hand over ASSUMING nothing is already running — dry-run never curls,
    // so it cannot know whether the app (or a start) is already live.
    const instructions = applicableInstructions(
      environment,
      ["rename", "start"],
      { devUrl: resolved.context.devUrl, slug, workroot }
    );
    return {
      // The report describes the run it planned: the phase it would end in, no
      // reason, and the devUrl it resolved.
      facts: reportFacts({
        devUrl: resolved.context.devUrl,
        instructions,
        live: false,
        phase: "run",
        reason: null,
      }),
      kind: "plan",
      ok: true,
      plan: {
        actions: buildUpActions(resolved.context),
        instructions,
        runSkipped: null,
        setup: setupPlan,
        slug,
        workroot,
      },
    };
  }

  // A real run: (1) the setup phase, fail-fast — any failure stops here (exit
  // nonzero, the run phase never starts).
  const setupOutcome = executeSetup(setupPlan, workroot, machineReport);
  if (setupOutcome.reason !== null) {
    return {
      exitCode: setupOutcome.exitCode,
      facts: reportFacts({
        instructions: [],
        live: false,
        phase: "setup",
        reason: setupOutcome.reason,
      }),
      failure: setupOutcome.failure,
      kind: "ran",
      ok: true,
    };
  }

  // (2) The no-app gate — the graceful no-op, reached only after the setup phase.
  // The rename instruction is still owed (INDEPENDENT of the app gate) — `up` no
  // longer renames anything itself, so it is handed back here instead of run.
  if (!hasApp) {
    return {
      facts: reportFacts({
        instructions: renameInstructions,
        live: false,
        phase: "noop",
        reason: null,
      }),
      kind: "noop",
      message: "no app to run",
      ok: true,
    };
  }

  // (3) The run phase (a neon project with missing creds fails hard).
  const resolved = resolveUpContext(
    cwd,
    workroot,
    slug,
    capabilities,
    environment
  );
  if (!resolved.ok) {
    return {
      error: resolved.error,
      facts: reportFacts({
        instructions: [],
        live: false,
        phase: "run",
        reason: "neon-creds-missing",
      }),
      ok: false,
    };
  }
  const outcome = executeUp(resolved.context);
  return {
    exitCode: outcome.exitCode,
    facts: reportFacts({
      devUrl: resolved.context.devUrl,
      instructions: outcome.instructions,
      live: outcome.live,
      phase: "run",
      reason: outcome.reason,
    }),
    failure: outcome.failure,
    kind: "ran",
    ok: true,
  };
}

// Resolve the run-phase decisions (devUrl, cmux, neon creds) for a vite app into an
// `UpContext`, or a HARD error when a neon project is missing its isolation creds.
// The single source both the plan and the imperative execution derive from, so
// `--dry-run` never lies about what a real run would do.
function resolveUpContext(
  cwd: string,
  workroot: string,
  slug: string,
  capabilities: string[],
  environment: Environment
): { ok: false; error: string } | { ok: true; context: UpContext } {
  const devUrl = resolveDevUrl(cwd, workroot, capabilities);

  // Neon isolation: BOTH creds must be present in the worktree's .env.local, or up
  // fails hard — refusing to fall back to the shared main database.
  let neon: { apiKey: string; projectId: string } | null = null;
  if (capabilities.includes("neon")) {
    const creds = readNeonCreds(workroot);
    if (creds.apiKey === null || creds.projectId === null) {
      return {
        error:
          "neon capability detected but NEON_API_KEY and/or NEON_PROJECT_ID are missing from .env.local — refusing to fall back to the main database (each dev copies .env.local for guaranteed branch isolation)",
        ok: false,
      };
    }
    neon = { apiKey: creds.apiKey, projectId: creds.projectId };
  }

  return {
    context: {
      cmux: environment.cmux,
      devUrl,
      environment,
      neon,
      slug,
      workroot,
    },
    ok: true,
  };
}

// The ordered `up` plan derived from the resolved decisions: probe → neon branch
// (when neon) → the liveness wait. `wait` is what a REAL run's in-flight path
// executes (see `executeUp`) — it is planned unconditionally because `--dry-run`
// never knows whether a start is already in flight (it never curls). Since TASK 4
// the start itself (cmux RUN pane XOR the terminal background job) is no longer
// planned HERE — it is an `Instruction` (see `UpPlan.instructions`), computed
// alongside this action list and quoted by `run.ts`'s `formatUpPlan` under an
// `agent:` hand-over.
function buildUpActions(context: UpContext): UpAction[] {
  const actions: UpAction[] = [{ kind: "probe", url: context.devUrl }];

  if (context.neon !== null) {
    actions.push({
      branch: `dobby/${context.slug}`,
      kind: "neon-branch",
      projectId: context.neon.projectId,
    });
  }

  actions.push({
    intervalSec: LIVENESS_INTERVAL_SEC,
    kind: "wait",
    retries: livenessRetries(),
    url: context.devUrl,
  });

  return actions;
}

// Execute a real `up`: probe once, then decide. `up` no longer starts, opens,
// sends to, closes or renames anything itself — everything it used to DO comes
// back as an `Instruction` for the model to carry out. The pane-vs-liveness
// ORDERING below IS CI-tested — a real run against stub `cmux`/`curl`/`ps` bins
// recording into one log.
function executeUp(context: UpContext): UpRunOutcome {
  const instructionCtx = {
    devUrl: context.devUrl,
    slug: context.slug,
    workroot: context.workroot,
  };
  // The rename is owed whenever cmux is present, REGARDLESS of whether the app is
  // already live or a start is already in flight — it is not something `up` starts
  // or waits on.
  const renameInstructions = applicableInstructions(
    context.environment,
    ["rename"],
    instructionCtx
  );

  // (1) Already up? A single probe decides it. NOTHING is started on this path —
  // the server that answers the probe need not be one `up` can see (the user may
  // have closed the run surface, or it may be a detached process from an earlier
  // session) — so a live app is simply left running.
  if (
    context.devUrl !== null &&
    probeLiveness(context.workroot, context.devUrl)
  ) {
    return {
      exitCode: 0,
      failure: null,
      instructions: renameInstructions,
      live: true,
      reason: null,
    };
  }

  // (2) Not live — neon branch provisioning stays where it is (only under the
  // `neon` capability, unchanged): create idempotently and rewrite the worktree's
  // .env.local, BEFORE deciding whether a start is already in flight or must be
  // handed back — either way the model's `dobby dev` needs the branch's
  // connection string already in place. NOT CI-tested (needs real neonctl).
  if (context.neon !== null) {
    const failure = provisionNeonBranch(context);
    if (failure !== null) {
      return {
        exitCode: 1,
        failure,
        instructions: [],
        live: false,
        reason: "neon-branch-failed",
      };
    }
  }

  // (3) Is a start already in flight? A live, OWNED `.dobby/dev.pid` means the
  // model's `bunx dobby dev` is already booting, so `up` re-probes instead of
  // handing the start over a second time — the EXISTING retry loop, unchanged.
  const inFlightPid = liveRegisteredPid(context.workroot);
  if (inFlightPid !== null) {
    if (
      context.devUrl !== null &&
      waitForLiveness(context.workroot, context.devUrl)
    ) {
      return {
        exitCode: 0,
        failure: null,
        instructions: renameInstructions,
        live: true,
        reason: null,
      };
    }
    return {
      exitCode: 1,
      failure:
        "the app never became reachable — check that the portless daemon is running and the local CA is trusted (`portless trust`)",
      instructions: [],
      live: false,
      reason: "liveness-timeout",
    };
  }

  // (4) Nothing starting — hand the rename (when cmux) and the start back to the
  // model IMMEDIATELY. No pidfile is written here: whoever RUNS the instruction
  // owns the registry (`dobby dev` registers its own, on startup).
  return {
    exitCode: 0,
    failure: null,
    instructions: applicableInstructions(
      context.environment,
      ["rename", "start"],
      instructionCtx
    ),
    live: false,
    reason: null,
  };
}

// A single liveness probe: `curl -sf --max-time 5 <url>` (HTTP 200 → alive).
function probeLiveness(workroot: string, url: string): boolean {
  const result = runCapture(
    "curl",
    ["-sf", "--max-time", String(LIVENESS_MAX_TIME_SEC), url],
    {
      root: workroot,
    }
  );
  return !result.error && result.status === 0;
}

// Probe up to `livenessRetries()` times, LIVENESS_INTERVAL_SEC apart (a blocking wait
// via Atomics — the executor is synchronous, mirroring the sibling action runners).
function waitForLiveness(workroot: string, url: string): boolean {
  const retries = livenessRetries();
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (probeLiveness(workroot, url)) {
      return true;
    }
    if (attempt < retries - 1) {
      sleepSync(LIVENESS_INTERVAL_SEC * 1000);
    }
  }
  return false;
}

// A synchronous sleep (no busy-wait): block the thread on an Atomics wait against a
// never-notified buffer for `ms` milliseconds. node-only, no dependency.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Neon branch provisioning (up) — creates `dobby/<slug>` and rewrites .env.local.
// ---------------------------------------------------------------------------

// Create the isolation branch idempotently (branch-exists → fetch its connection
// string instead) and rewrite the worktree's DATABASE_URL* lines. Returns null on
// success or a message on hard failure. NOT CI-tested (needs real neonctl).
function provisionNeonBranch(context: UpContext): string | null {
  const { neon } = context;
  if (neon === null) {
    return null;
  }
  const branch = `dobby/${context.slug}`;
  const env = { ...process.env, NEON_API_KEY: neon.apiKey };

  const created = runCapture(
    "bunx",
    [
      "neonctl",
      "branches",
      "create",
      "--name",
      branch,
      "--project-id",
      neon.projectId,
      "--output",
      "json",
    ],
    { env, root: context.workroot }
  );
  if (created.error) {
    return `could not run neonctl: ${created.error.message}`;
  }

  let connectionUri: string | null = null;
  if (created.status === 0) {
    connectionUri = parseNeonConnectionUri(created.stdout);
  } else {
    // Branch already exists (idempotent) → fetch its connection string instead.
    const existing = runCapture(
      "bunx",
      ["neonctl", "connection-string", branch, "--project-id", neon.projectId],
      { env, root: context.workroot }
    );
    if (existing.status !== 0) {
      return `neonctl branches create failed: ${created.stderr.trim() || `exit ${created.status}`}`;
    }
    connectionUri = existing.stdout.trim() || null;
  }

  if (connectionUri !== null) {
    rewriteDatabaseUrls(context.workroot, connectionUri);
  }
  return null;
}

// The pooled connection URI from a `neonctl branches create --output json` payload
// (`connection_uris[0].connection_uri`), or null when the shape is unexpected.
function parseNeonConnectionUri(stdout: string): string | null {
  try {
    const data = JSON.parse(stdout) as {
      connection_uris?: Array<{ connection_uri?: string }>;
    };
    const uri = data.connection_uris?.[0]?.connection_uri;
    return typeof uri === "string" && uri !== "" ? uri : null;
  } catch {
    return null;
  }
}

// Rewrite the worktree's .env.local DATABASE_URL / DATABASE_URL_UNPOOLED lines from
// the branch connection string. Best-effort (missing file → skip). The unpooled
// counterpart drops Neon's `-pooler` host suffix, the pooled adds it.
function rewriteDatabaseUrls(workroot: string, connectionUri: string): void {
  const path = join(workroot, ".env.local");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const pooled = togglePooler(connectionUri, true);
  const unpooled = togglePooler(connectionUri, false);
  const rewritten = raw
    .split("\n")
    .map((line) => {
      if (DATABASE_URL_LINE_RE.test(line)) {
        return `DATABASE_URL=${pooled}`;
      }
      if (DATABASE_URL_UNPOOLED_LINE_RE.test(line)) {
        return `DATABASE_URL_UNPOOLED=${unpooled}`;
      }
      return line;
    })
    .join("\n");
  writeFileSync(path, rewritten);
}

// Toggle Neon's pooled-endpoint `-pooler` host suffix on a connection URI.
function togglePooler(uri: string, pooled: boolean): string {
  try {
    const url = new URL(uri);
    const hasPooler = url.hostname.includes("-pooler.");
    if (pooled && !hasPooler) {
      url.hostname = url.hostname.replace(POOLER_HOST_RE, "$1-pooler.");
    } else if (!pooled && hasPooler) {
      url.hostname = url.hostname.replace("-pooler.", ".");
    }
    return url.toString();
  } catch {
    return uri;
  }
}

// ---------------------------------------------------------------------------
// `dobby down` — teardown: kill the detached run, delete the neon branch, run
// teardown[] extras. Since TASK 7 `down` no longer closes a cmux surface itself —
// the close comes back as the `stop` INSTRUCTION (discovered, never executed here;
// see environment.ts / adapters/cmux.ts's `cmuxStopInstruction`).
// ---------------------------------------------------------------------------

// One planned `down` action. `run.ts` renders each; `executeDown` performs it.
export type DownAction =
  | { kind: "kill-pidfile"; pidRel: string }
  | { kind: "neon-delete"; branch: string; projectId: string }
  | { kind: "extra"; run: string };

// The ordered `down` plan for `--dry-run`: down's own actions (kill pidfile →
// delete neon branch → teardown extras), plus the INSTRUCTIONS the run would hand
// over to the model (the `stop` topic, applicable only when a kit pane is
// discovered) — same shape as `DownFacts.instructions`, quoted by `run.ts`'s
// `formatDownPlan` under an `agent:` hand-over, never rendered as one of down's own
// action lines.
export interface DownPlan {
  actions: DownAction[];
  instructions: Instruction[];
  slug: string;
  workroot: string;
}

// WHY `down` failed (or `null` on success), as a CLOSED enum — mirrors `UpReason`.
//   not-a-git-repo        — the workroot precondition (requireWorkroot threw).
//   teardown-extra-failed — a config `teardown[]` extra exited nonzero.
//   neon-delete-failed    — reserved for a failed `neonctl branches delete`; the
//                           delete stays BEST-EFFORT (unchanged behaviour — task
//                           constraint), so this member is not yet produced by any
//                           path. Kept in the enum because the spec names it.
type DownReason =
  | "not-a-git-repo"
  | "neon-delete-failed"
  | "teardown-extra-failed";

// The machine-readable `down` report: flat, `UpFacts`-style (explicit nulls, never
// omitted keys). Decided HERE (data); `run.ts` renders it as the sole stdout of
// `down --json`.
interface DownFacts {
  // The CMUX_WORKSPACE_ID value, or null outside cmux.
  cmux: string | null;
  // What the MODEL must do next — ONLY the applicable ones: the `stop` topic when a
  // kit pane was discovered, else empty. Each entry is exactly what
  // `environment.instruction("stop", ctx)` returns — never duplicated text here.
  instructions: Instruction[];
  // Whether `down` succeeded. FALSE always pairs with a nonzero exit code.
  ok: boolean;
  // Null on success; the enum member on failure — never prose.
  reason: DownReason | null;
  // The goal slug (workroot basename), or null when no workroot resolved.
  slug: string | null;
  // The absolute workroot; the directory `down` ran in when none resolved
  // (not-a-git-repo).
  workroot: string;
}

// The outcome of `dobby down`:
//   - `{ ok: false, error }`  — outside a git repo (fail hard).
//   - `{ ok: true, kind: "plan", plan }` — `--dry-run`: the plan to render.
//   - `{ ok: true, kind: "ran", exitCode, failure, childOutput }` — a real
//     teardown executed (nothing to clean → exit 0 no-op). `childOutput` is a
//     teardown extra's captured stdout+stderr under `--json` (empty otherwise —
//     a plain `down` streams it straight to the terminal instead); see
//     `executeDown`.
// EVERY arm also carries `facts` — the same outcome as the flat machine report
// (`down --json`), mirroring `UpReport`.
export type DownReport =
  | { ok: false; error: string; facts: DownFacts }
  | { ok: true; kind: "plan"; plan: DownPlan; facts: DownFacts }
  | {
      ok: true;
      kind: "ran";
      childOutput: string;
      exitCode: number;
      failure: string | null;
      facts: DownFacts;
    };

// The decisions a real `down` needs (the neon API key for the delete). Derived
// once, shared with the plan.
interface DownContext {
  neonApiKey: string | null;
  slug: string;
  workroot: string;
}

// Assemble the machine report from what the caller resolved — the `down` sibling of
// `upFacts`.
function downFacts(parts: {
  cmux: string | null;
  instructions: Instruction[];
  reason: DownReason | null;
  slug: string | null;
  workroot: string;
}): DownFacts {
  return {
    cmux: parts.cmux,
    instructions: parts.instructions,
    ok: parts.reason === null,
    reason: parts.reason,
    slug: parts.slug,
    workroot: parts.workroot,
  };
}

// Resolve `down` for the git worktree enclosing `cwd`, then either PLAN
// (`--dry-run`) or execute the teardown. Fails hard outside a git repo. Nothing to
// clean → exit 0 no-op.
//
// `machineReport` (set by `down --json`) changes NO decision — only one mechanic:
// teardown extras stream their stdout to fd 2 instead of fd 1, so stdout stays the
// sole JSON object. Pane discovery for `instructions` is NOT gated on
// `machineReport` — a plain text `down` and `--dry-run` both need to quote the
// `stop` instruction too, so it runs whenever cmux is present, one `list-panes`
// call, independent of dryRun/machineReport.
export function runDown(
  cwd: string,
  opts: { dryRun: boolean; machineReport?: boolean }
): DownReport {
  const machineReport = opts.machineReport === true;
  // Resolved ONCE — the single CMUX_WORKSPACE_ID read this command makes.
  const environment = detectEnvironment();
  const { cmux } = environment;

  let workroot: string;
  try {
    workroot = requireWorkroot(cwd);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      facts: downFacts({
        cmux,
        instructions: [],
        reason: "not-a-git-repo",
        slug: null,
        workroot: cwd,
      }),
      ok: false,
    };
  }

  const slug = basename(workroot);
  const capabilities = detectCapabilities(cwd);
  const loaded = loadConfig(cwd);
  const config = loaded?.ok ? loaded.config : null;
  const neonCreds = capabilities.includes("neon")
    ? readNeonCreds(workroot)
    : null;

  // The `stop` instruction — applicable only when a kit pane is discovered (see
  // `cmuxStopInstruction`); terminal never applies. Computed ONCE, shared by the
  // plan, the machine report and a real run alike.
  const instructions = applicableInstructions(environment, ["stop"], {
    devUrl: null,
    slug,
    workroot,
  });

  const actions: DownAction[] = [];

  // (1) The detached-run pidfile — kill the group, or clean a stale file.
  if (existsSync(join(workroot, ".dobby", "dev.pid"))) {
    actions.push({ kind: "kill-pidfile", pidRel: ".dobby/dev.pid" });
  }
  // (1b) Every reclaim sidecar (`.dobby/dev.pid.stale.*`) a `dev` registration
  // race left behind — one may hold ANOTHER run's live, owned pid that its own
  // restore never landed (review round 3, greptile P1). Swept with the exact
  // same mechanic as `dev.pid` itself: `killFromPidfile` below applies the
  // identical ownership check per sidecar and removes it regardless of outcome.
  for (const pidRel of listStaleSidecars(workroot)) {
    actions.push({ kind: "kill-pidfile", pidRel });
  }
  // (2) Neon branch delete (capability + BOTH creds present; missing → skip).
  if (
    neonCreds !== null &&
    neonCreds.apiKey !== null &&
    neonCreds.projectId !== null
  ) {
    actions.push({
      branch: `dobby/${slug}`,
      kind: "neon-delete",
      projectId: neonCreds.projectId,
    });
  }
  // (3) Config teardown[] extras, sequentially.
  for (const extra of config?.teardown ?? []) {
    actions.push({ kind: "extra", run: extra });
  }

  if (opts.dryRun) {
    return {
      facts: downFacts({ cmux, instructions, reason: null, slug, workroot }),
      kind: "plan",
      ok: true,
      plan: { actions, instructions, slug, workroot },
    };
  }
  const context: DownContext = {
    neonApiKey: neonCreds?.apiKey ?? null,
    slug,
    workroot,
  };
  const outcome = executeDown(context, actions, machineReport);
  return {
    childOutput: outcome.childOutput,
    exitCode: outcome.exitCode,
    facts: downFacts({
      cmux,
      instructions,
      reason: outcome.reason,
      slug,
      workroot,
    }),
    failure: outcome.failure,
    kind: "ran",
    ok: true,
  };
}

// Execute a real `down` teardown, best-effort (a failing cleanup step never blocks
// the rest). Only a failing config `teardown[]` extra surfaces in the exit code /
// reason today (the neon delete stays best-effort — see `DownReason`). The
// kill / neon-delete real work is NOT CI-tested.
//
// `childOutputToStderr` (set by `runDown`'s `machineReport`) changes HOW a
// teardown extra is run: a plain `down` still INHERITS the child's stdio (streams
// straight to the terminal, unchanged); under `--json` the extra is CAPTURED
// instead (never fd-inherited) and its combined stdout+stderr is accumulated into
// `childOutput`, for `run.ts`'s `renderDownJson` to write on the SEAM's own stderr
// string — a fd-inherited child would bypass the in-process capture seam entirely
// (see downjson.test.ts's "keeps a succeeding teardown extra's output off stdout"
// SEAM LIMIT comment, which spells out that this capture-and-forward is exactly
// what the `--json` contract asks for, not a limitation to leave unaddressed).
function executeDown(
  context: DownContext,
  actions: DownAction[],
  childOutputToStderr: boolean
): {
  childOutput: string;
  exitCode: number;
  failure: string | null;
  reason: DownReason | null;
} {
  let exitCode = 0;
  let failure: string | null = null;
  let reason: DownReason | null = null;
  const childOutputParts: string[] = [];

  for (const action of actions) {
    switch (action.kind) {
      case "kill-pidfile":
        // NOT gated on the current environment — a stale pidfile from an earlier
        // terminal run must still be cleaned up even under a cmux `down` (see
        // environment.ts's `killFromPidfile` for why this stays a direct call).
        killFromPidfile(
          join(context.workroot, action.pidRel),
          context.workroot
        );
        break;
      case "neon-delete":
        deleteNeonBranch(context, action.branch, action.projectId);
        break;
      case "extra": {
        const code = childOutputToStderr
          ? runCapturedExtra(action.run, context.workroot, childOutputParts)
          : runInherit("sh", ["-c", action.run], { root: context.workroot });
        if (code !== 0 && reason === null) {
          exitCode = code;
          failure = `teardown extra failed (exit ${code}): ${action.run}`;
          reason = "teardown-extra-failed";
        }
        break;
      }
      default:
        break;
    }
  }
  return { childOutput: childOutputParts.join(""), exitCode, failure, reason };
}

// Run one teardown extra CAPTURED (never fd-inherited), appending its combined
// stdout+stderr to `parts` (in order) and returning its exit code (1 on a spawn
// error, mirroring `runInherit`'s own fallback).
function runCapturedExtra(run: string, root: string, parts: string[]): number {
  const result = runCapture("sh", ["-c", run], { root });
  const text = `${result.stdout}${result.stderr}`;
  if (text !== "") {
    parts.push(text);
  }
  if (result.error) {
    return 1;
  }
  return result.status ?? 1;
}

// Delete the neon isolation branch (a missing branch is idempotently fine). NOT
// CI-tested (needs real neonctl). Best-effort, unchanged (task constraint): the
// result is never inspected, so a failed delete never surfaces as
// `neon-delete-failed` today — `runCapture` never touches the parent's own stdout,
// so this needs no `childOutputToStderr` thread to keep `--json`'s stdout clean.
function deleteNeonBranch(
  context: DownContext,
  branch: string,
  projectId: string
): void {
  runCapture(
    "bunx",
    ["neonctl", "branches", "delete", branch, "--project-id", projectId],
    {
      env: { ...process.env, NEON_API_KEY: context.neonApiKey ?? "" },
      root: context.workroot,
    }
  );
}

// Read the neon creds (NEON_API_KEY + NEON_PROJECT_ID) from <workroot>/.env.local
// — each dev copies .env.local, so the project id is no longer committed. Either
// missing → null (up fails hard, down skips). Tolerant of an absent/odd file.
function readNeonCreds(workroot: string): {
  apiKey: string | null;
  projectId: string | null;
} {
  const env = parseEnvFile(join(workroot, ".env.local"));
  return {
    apiKey: env.get("NEON_API_KEY") ?? null,
    projectId: env.get("NEON_PROJECT_ID") ?? null,
  };
}

// Parse a `.env`-style file into a KEY→value map (drop blanks/`#` comments, split
// on the first `=`, strip surrounding quotes). Tolerant: an unreadable file → empty.
function parseEnvFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return map;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}
