import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckGroup, type CheckNote, check } from "./check.ts";
import type {
  CommandContext,
  CommandOptions,
  CommandResult,
} from "./command.ts";
import { loadConfig } from "./config.ts";
import { type CapabilityScan, scanCapabilities } from "./detect.ts";
import { collectEnv } from "./envinfo.ts";
import { linkedWorktreeMain } from "./lifecycle.ts";
import { requireWorkroot, runCapture } from "./runner.ts";
import {
  biomeConfigSpec,
  drizzleConfigSpec,
  viteConfigSpec,
  vitestConfigSpec,
} from "./tasks.ts";

// The PREFLIGHTS — the read-only verdicts a destructive or planning stage asks
// for BEFORE it acts. Each returns FACTS plus a verdict; every AskUserQuestion
// gate stays in the SKILL, so a preflight never creates, enters, or removes
// anything itself (it only computes the predicate the skill gates on).
//
//   - `finish --preflight` — the teardown verdict for the goal the session
//     CURRENTLY stands on: `safe` (MERGED PR + clean tree), `blocked` (dobby is
//     not installed, so the mandatory `dobby down` cannot run — it outranks
//     every other signal), else `confirm-required`. It also reports whether the
//     session stands inside a linked worktree (`inWorktree`, whoever made it)
//     and whether the branch is safe to force-delete. The worktree belongs to
//     the OPERATOR — this preflight never creates, names, or targets one by
//     slug; it only reports where the session already stands.
//   - `migrate preflight|verify` — whether a repo still needs the config
//     migration (naming each legacy signal and snapshotting the facts the
//     migration must carry across), and whether a migrated repo is healthy (the
//     gate's verdict + the environment read back + what was left behind).
//
// EVERY preflight here is an ACTION command: it fails HARD outside a git
// repository (`requireWorkroot`) rather than answering with a degraded verdict a
// skill might act on. Every child process goes through `runner.ts` with its cwd
// pinned to the workroot.
//
// node:*-only (ADR-0008) — vitest imports this under Node, Bun runs it in prod.

// The two `git status --porcelain` status columns plus their trailing space: the
// path starts at index 3 of every line.
const PORCELAIN_PATH_OFFSET = 3;

// The `gh pr view` answer, projected to the three fields the skills read. Passed
// THROUGH unchanged — the preflight never re-derives a merge verdict from git.
interface PullRequest {
  mergedAt: string | null;
  state: string;
  url: string;
}

// The uncommitted work a teardown would destroy: `git status --porcelain` lines,
// UNTRACKED files included (losing those is exactly what the gate protects).
interface DirtyTree {
  count: number;
  files: string[];
}

type Verdict = "blocked" | "confirm-required" | "safe";

interface FinishPreflight {
  branch: string;
  branchDeleteSafe: boolean;
  // The repository's own trunk — `refs/remotes/origin/HEAD`, resolved at
  // `mainRoot` — never the goal branch the session stands on. Falls back to the
  // constant `"main"` when there is no remote head to read.
  defaultBranch: string;
  dirty: DirtyTree;
  dobbyInstalled: boolean;
  // True iff the session's workroot is a LINKED worktree (git's own definition,
  // via `linkedWorktreeMain`) — whoever made it: `claude --worktree`, an IDE, a
  // bare `git worktree add`. The kit no longer makes or names worktrees itself.
  inWorktree: boolean;
  mainRoot: string;
  pr: PullRequest | null;
  reasons: string[];
  verdict: Verdict;
  worktreePath: string | null;
}

// The hard-error result for a thrown precondition (outside a git repo).
function hardError(error: unknown): CommandResult {
  return {
    error: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  };
}

// The `--json` contract: the payload is the only stdout when `--json` is passed,
// otherwise the human `text` fallback (which run.ts prints verbatim).
function rendered<T>(
  payload: T,
  options: CommandOptions,
  text: (value: T) => string
): CommandResult {
  return options.json === true
    ? { exitCode: 0, json: payload }
    : { exitCode: 0, text: text(payload) };
}

// Whether the repo at `root` carries a LOCAL dobby install — the finish skill's
// own probe (`[ -x node_modules/.bin/dobby ]`). The kit has no fallback for a
// missing dobby, so this is a contract signal, not a nicety.
function dobbyInstalledAt(root: string): boolean {
  return existsSync(join(root, "node_modules", ".bin", "dobby"));
}

// The branch HEAD is on, or "HEAD" when it is DETACHED — pointing straight at a
// commit, with no branch to move. `git symbolic-ref --quiet HEAD` asks exactly
// that question: it exits nonzero precisely when HEAD is not a symbolic ref —
// unlike `rev-parse --abbrev-ref HEAD` (answers the literal string "HEAD") or
// `branch --show-current` (answers an empty line), which both answer a detached
// HEAD with something branch-shaped.
function currentBranch(root: string): string {
  const result = runCapture(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { root }
  );
  const name = result.stdout.trim();
  return result.status === 0 && name !== "" && name !== "HEAD" ? name : "HEAD";
}

// The repository's own trunk — the fallback the finish skill switches to
// before it force-deletes a goal branch. `"main"` is an assumption, not a
// fact, so this reads the repo's own remote head (`refs/remotes/origin/HEAD`,
// which `git symbolic-ref` answers as `origin/<name>`) and strips the
// `origin/` prefix. Any failure — no remote, no remote head set — falls back
// to the constant below, never to the LOCAL trunk (which may not exist, or
// may not even be the repo's real trunk).
const DEFAULT_BRANCH_FALLBACK = "main";
const REMOTE_HEAD_PREFIX = "origin/";

function defaultBranchAt(root: string): string {
  const result = runCapture(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { root }
  );
  const ref = result.stdout.trim();
  if (result.status !== 0 || !ref.startsWith(REMOTE_HEAD_PREFIX)) {
    return DEFAULT_BRANCH_FALLBACK;
  }
  return ref.slice(REMOTE_HEAD_PREFIX.length);
}

// ---------------------------------------------------------------------------
// `dobby finish --preflight`
// ---------------------------------------------------------------------------

export function runFinishPreflight(context: CommandContext): CommandResult {
  let workroot: string;
  try {
    workroot = requireWorkroot(context.cwd);
  } catch (error) {
    return hardError(error);
  }

  if (context.options.preflight !== true) {
    return {
      error:
        "finish takes --preflight — the CLI computes the teardown verdict; the removal itself stays in the skill (native ExitWorktree when the session entered the worktree, or raw git otherwise)",
      exitCode: 1,
    };
  }

  // A LINKED worktree (git's own definition — its git dir differs from the
  // common git dir) puts the session INSIDE a goal; `mainRoot` is the checkout
  // it hangs off. A plain checkout is its own main root, with nothing to tear
  // down but the branch.
  const linkedMain = linkedWorktreeMain(workroot);
  const inWorktree = linkedMain !== null;
  const mainRoot = linkedMain ?? workroot;
  const worktreePath = inWorktree ? workroot : null;

  const branch = currentBranch(workroot);
  const pr = readPullRequest(workroot, branch);
  const dirty = readDirtyTree(workroot);
  // Per-tree, not per-checkout: `node_modules/` is gitignored, so a linked
  // worktree and its main checkout are installed INDEPENDENTLY of each other.
  const dobbyInstalled = dobbyInstalledAt(workroot);
  const defaultBranch = defaultBranchAt(mainRoot);

  const { reasons, verdict } = judgeTeardown({
    branch,
    dirty,
    dobbyInstalled,
    pr,
  });

  const payload: FinishPreflight = {
    branch,
    // Squash-merge rationale: after a squash the branch tip is a NEW commit that
    // is not an ancestor of main, so git's own ancestry test (`git branch -d`)
    // calls a legitimately-merged branch unmerged. gh's MERGED verdict is the
    // authoritative signal — which is why this is derived from `pr.state` and
    // never from git, and why the skill force-deletes (`-D`) once it holds.
    branchDeleteSafe: pr?.state === "MERGED",
    defaultBranch,
    dirty,
    dobbyInstalled,
    inWorktree,
    mainRoot,
    pr,
    reasons,
    verdict,
    worktreePath,
  };

  return rendered(payload, context.options, formatFinishText);
}

// The verdict + the reasons behind it — exactly the three spec rules, nothing
// widened:
//   - BLOCKED on ONE thing only: dobby is not installed, so the mandatory
//     `dobby down` pre-removal teardown cannot run and has no fallback. It
//     outranks every other signal (even a MERGED PR over a clean tree).
//   - SAFE is the ONLY reason-less outcome: a MERGED PR and a clean tree.
//   - CONFIRM-REQUIRED otherwise, each reason naming exactly what the skill must
//     show at its destructive-action gate.
function judgeTeardown(input: {
  branch: string;
  dirty: DirtyTree;
  dobbyInstalled: boolean;
  pr: PullRequest | null;
}): { reasons: string[]; verdict: Verdict } {
  if (!input.dobbyInstalled) {
    return {
      reasons: [
        "dobby is not installed here (node_modules/.bin/dobby is missing) — `dobby down` is the mandatory pre-removal teardown and has no fallback; onboard or migrate the repo first",
      ],
      verdict: "blocked",
    };
  }

  const reasons: string[] = [];
  if (input.pr === null) {
    reasons.push(
      `no pull request found for ${input.branch} — an absent PR is never a merge signal`
    );
  } else if (input.pr.state !== "MERGED") {
    reasons.push(
      `the pull request is ${input.pr.state}, not MERGED (${input.pr.url})`
    );
  }
  if (input.dirty.count > 0) {
    reasons.push(
      `${input.dirty.count} uncommitted change(s) in the worktree would be lost: ${input.dirty.files.join(", ")}`
    );
  }

  return reasons.length === 0
    ? { reasons: [], verdict: "safe" }
    : { reasons, verdict: "confirm-required" };
}

// The branch's pull request via `gh pr view <branch> --json state,mergedAt,url`
// (finish/SKILL.md's own call). NULL whenever gh cannot answer — no gh on PATH,
// no repo remote, or gh's "no pull requests found" exit 1 — because an ABSENT PR
// must read as "unknown", never as a merge signal. The three fields are passed
// through as gh reported them; nothing here re-derives merge state from git.
function readPullRequest(root: string, branch: string): PullRequest | null {
  const result = runCapture(
    "gh",
    ["pr", "view", branch, "--json", "state,mergedAt,url"],
    { root }
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  try {
    const data = JSON.parse(result.stdout) as {
      mergedAt?: unknown;
      state?: unknown;
      url?: unknown;
    };
    if (typeof data.state !== "string") {
      return null;
    }
    return {
      // gh reports `mergedAt: null` for anything not merged.
      mergedAt: typeof data.mergedAt === "string" ? data.mergedAt : null,
      state: data.state,
      url: typeof data.url === "string" ? data.url : "",
    };
  } catch {
    return null;
  }
}

// The session's uncommitted work: bare `git status --porcelain` at the workroot
// itself (the finish skill's literal), so UNTRACKED files count too — losing
// those is exactly what the destructive gate protects against. Tolerant: a
// failed git call reads as clean.
function readDirtyTree(root: string): DirtyTree {
  const result = runCapture("git", ["status", "--porcelain"], { root });
  if (result.error || result.status !== 0) {
    return { count: 0, files: [] };
  }
  const files = result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(porcelainPath);
  return { count: files.length, files };
}

// The path out of one porcelain line (`XY <path>`); a rename prints
// `<old> -> <new>`, and the NEW path is the one on disk.
function porcelainPath(line: string): string {
  const raw = line.slice(PORCELAIN_PATH_OFFSET).trim();
  const arrow = raw.lastIndexOf(" -> ");
  return arrow === -1 ? raw : raw.slice(arrow + " -> ".length);
}

function formatFinishText(payload: FinishPreflight): string {
  const pr =
    payload.pr === null
      ? "none"
      : `${payload.pr.state} (${payload.pr.url}${payload.pr.mergedAt === null ? "" : `, merged ${payload.pr.mergedAt}`})`;
  const lines = [
    `verdict:         ${payload.verdict}`,
    `inWorktree:      ${payload.inWorktree}`,
    `branch:          ${payload.branch}`,
    `defaultBranch:   ${payload.defaultBranch}`,
    `worktreePath:    ${payload.worktreePath ?? "-"}`,
    `mainRoot:        ${payload.mainRoot}`,
    `pr:              ${pr}`,
    `dirty:           ${payload.dirty.count}${payload.dirty.count === 0 ? "" : ` (${payload.dirty.files.join(", ")})`}`,
    `dobbyInstalled:  ${payload.dobbyInstalled}`,
    `branchDeleteSafe:${payload.branchDeleteSafe}`,
  ];
  for (const reason of payload.reasons) {
    lines.push(`  - ${reason}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// `dobby migrate preflight` / `dobby migrate verify`
//
// The mechanized ends of `/dobby:migrate-config`: Step 0 — detect the legacy
// (vite-plus era) signals and snapshot the facts the migration has to carry
// across — and Step 10 — run the gate, read the environment back, and report
// what the migration left behind.
//
// PATH CONVENTION: every path either payload reports is REPO-RELATIVE with
// POSIX separators (`.claude/commit.config.yml`, `vite.config.ts`,
// `.github/workflows/ci.yml`), so a payload reads the way the skill's own prose
// names those files.
//
// Both arms are READ-ONLY and INFORMATIONAL: they exit 0 with their payload for
// EVERY verdict — `migration-needed` is not a refusal, and an unhealthy repo is
// precisely the answer `verify` was asked for — reserving exit 1 for the two
// situations where there is no answer at all: outside a git repository, and a
// gate that could not start. Every branch and every human gate stays in the
// skill; nothing here creates, moves or deletes a file.
// ---------------------------------------------------------------------------

// The legacy artifacts, spelled the way migrate-config Step 0 and Step 10's
// "Removed" bucket spell them. These are the ONE place this module states them:
// the same three drive the preflight signals AND `verify`'s residual list.
const LEGACY_YAML = ".claude/commit.config.yml";
const VITE_HOOKS_DIR = ".vite-hooks";
const CONDUCTOR_DIR = ".conductor";
const CONFIG_FILE = "dobby.config.json";
const WORKFLOWS_DIR = ".github/workflows";

// A `vp`/`vpr` invocation as a WHOLE token — the vite-plus era's two binaries.
// It must start at a command boundary (string/line start, whitespace, a shell
// separator, or a quote — a task table spells it `run: "vpr dev"`) and end at
// one, so a genuine project need like `docker compose down` never lands on the
// list and a package named `vp-something` is not mistaken for the binary. `m`
// makes the anchors line-wise, since the same regex scans whole files (a CI
// workflow, a vite config) as well as single command strings.
const VP_COMMAND = /(?:^|[\s;&|(`"'])vpr?(?=[\s"'`;&|)]|$)/m;

// A GitHub Actions workflow file (only these are scanned for a vp/vpr line).
const WORKFLOW_FILE = /\.ya?ml$/;

// A `tsconfig.json` that extends a dobby preset, in EITHER form biome/tsc allow
// (a single specifier or an array of them). Matched against the RAW text rather
// than a parse: a tsconfig legally carries comments and trailing commas, and the
// only question here is whether the dobby base is in the extends chain at all.
const TSCONFIG_EXTENDS_DOBBY =
  /"extends"\s*:\s*(?:"[^"]*@kvnwolf\/dobby[^"]*"|\[[^\]]*@kvnwolf\/dobby[^\]]*\])/;

// A package aliased ONTO vite-plus in `overrides`/`resolutions` — the field
// spelling is `"vite": "npm:@voidzero-dev/vite-plus-core"`, so the alias TARGET
// is what identifies it (the key is just `vite`/`vitest`).
const VITEPLUS_ALIAS = /vite-plus/;

// The toolchain packages dobby now BUNDLES (migrate-config Step 1's removal
// list). `vite-plus` is deliberately NOT here: it has its own dedicated signal
// (`viteplusDep`), and reporting the loudest fact twice would only blur it.
const TOOLCHAIN_PACKAGES = [
  "ultracite",
  "knip",
  "taze",
  "oxlint",
  "portless",
] as const;

// The package.json keys that are PROJECT config rather than toolchain residue,
// so the migration must carry them across untouched (Step 1's literal pair: the
// `portless` key still resolves `dobby dev`/`up`'s URL even though the portless
// DEPENDENCY is bundled away, and `trustedDependencies` is the project's own).
const PRESERVED_PACKAGE_KEYS = ["portless", "trustedDependencies"] as const;

// The vite-plus dependency itself — the core "this is a vite-plus repo" signal.
const VITEPLUS_PACKAGE = "vite-plus";

type MigrateVerdict = "already-migrated" | "migration-needed";

// The legacy signals Step 0 enumerates. Every one is a FACT about the tree; the
// verdict below is the only judgement.
interface MigrateSignals {
  // The packages aliased onto vite-plus in package.json `overrides`/`resolutions`
  // — the alias TARGETS are the era's, so the names (`vite`, `vitest`) are what
  // Step 1 has to de-alias.
  aliases: string[];
  conductor: boolean;
  legacyYaml: string | null;
  // The old-era `dobby.config.json`: it carries a `run` key, or `setup`/
  // `teardown`/`checks` extras that shell out to vp/vpr. `vpExtras` holds the
  // offending command STRINGS (the shape the old schema used for all three
  // lists), never the extras that are genuine project needs.
  oldEraConfig: { hasRun: boolean; path: string; vpExtras: string[] } | null;
  prepareScript: boolean;
  viteHooks: boolean;
  viteplusDep: boolean;
  vpTaskTable: boolean;
}

// What the migration must CARRY ACROSS — read once, before anything moves.
interface MigrateSnapshot {
  // Workflow files carrying a vp/vpr line (Step 9 rewires exactly these).
  ci: string[];
  envTest: boolean;
  preservedKeys: string[];
  scripts: string[];
  // Where each tool config lives today, or null — the SAME filename sets
  // override-by-presence counts (ADR-0015), so "present" here means exactly
  // "this file would override dobby's default".
  toolConfigs: {
    biome: string | null;
    drizzle: string | null;
    vite: string | null;
    vitest: string | null;
  };
  toolchainDeps: string[];
  tracker: { source: string; team: string | null; type: string | null };
  vercelJson: boolean;
  worktreeinclude: boolean;
}

interface MigratePreflight {
  signals: MigrateSignals;
  snapshot: MigrateSnapshot;
  verdict: MigrateVerdict;
}

interface MigrateVerify {
  check: { exitCode: number; failingSteps: string[] };
  env: {
    capabilities: string[];
    config: boolean;
    dbTasks: string[];
    devUrl: string | null;
  };
  ok: boolean;
  residual: {
    deltaConfigsKept: string[];
    legacyFilesRemaining: string[];
    trackerIncomplete: boolean;
  };
}

export function runMigrate(context: CommandContext): CommandResult {
  // The registry has already validated the token against `{preflight, verify}`,
  // so there is no third case to reject here.
  return context.positionals[0] === "verify"
    ? runMigrateVerify(context)
    : runMigratePreflight(context);
}

function runMigratePreflight(context: CommandContext): CommandResult {
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return hardError(error);
  }

  // The reads every fact below is derived from, done ONCE each: the raw
  // manifest, the capability scan, the config, and where the tool configs live.
  const manifest = readJsonObject(join(root, "package.json"));
  const scan = scanCapabilities(root);
  const config = readRawConfig(root);
  const toolConfigs = locateToolConfigs(root, scan);
  const signals = detectSignals(root, manifest, scan, config, toolConfigs);

  const payload: MigratePreflight = {
    signals,
    snapshot: snapshotFacts(root, manifest, scan, config, toolConfigs),
    // The rule, verbatim: no vite-plus signal AND the config is new-schema AND
    // tsconfig.json already extends a dobby preset. Each clause is necessary —
    // the field cases break exactly one apiece (a leftover dep, a repo still on
    // the legacy YAML with no config at all, a fat tsconfig).
    verdict:
      noLegacySignal(signals) &&
      config.newSchema &&
      extendsDobby(root, "tsconfig.json")
        ? "already-migrated"
        : "migration-needed",
  };

  return rendered(payload, context.options, formatMigratePreflightText);
}

function runMigrateVerify(context: CommandContext): CommandResult {
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return hardError(error);
  }

  // The gate runs IN-PROCESS (never `bunx dobby check` re-entered as a child):
  // one composed pipeline, its findings already reduced to data.
  const report = check([], root, {}, false);
  if (!report.ok) {
    // The gate could not START (not a git repo, a bundled tool unresolvable) —
    // there is no health verdict to report, so this is the one hard error the
    // command has besides the git precondition.
    return { error: report.error, exitCode: 1 };
  }

  const config = readRawConfig(root);
  const environment = collectEnv(root);
  const legacyFilesRemaining = [
    LEGACY_YAML,
    VITE_HOOKS_DIR,
    CONDUCTOR_DIR,
  ].filter((rel) => existsSync(join(root, rel)));
  // A KEPT tool config is a legitimate migration outcome (Step 10's "KEPT for a
  // real delta" bucket), so it is REPORTED and never held against the repo.
  const deltaConfigsKept = Object.values(
    locateToolConfigs(root, scanCapabilities(root))
  ).filter((path): path is string => path !== null);
  const trackerIncomplete = isTrackerIncomplete(config.tracker);

  const payload: MigrateVerify = {
    check: {
      exitCode: report.exitCode,
      failingSteps: failingSteps(report.groups, report.notes, report.exitCode),
    },
    env: {
      capabilities: environment.capabilities,
      config: environment.config,
      dbTasks: environment.dbTasks,
      devUrl: environment.devUrl,
    },
    // Healthy = the gate is green, nothing legacy survived, and the tracker is
    // fully pinned. Deliberately NOT a function of `deltaConfigsKept`.
    ok:
      report.exitCode === 0 &&
      legacyFilesRemaining.length === 0 &&
      !trackerIncomplete,
    residual: { deltaConfigsKept, legacyFilesRemaining, trackerIncomplete },
  };

  return rendered(payload, context.options, formatMigrateVerifyText);
}

// The `dobby.config.json` facts both arms read, resolved ONCE through the sole
// config reader (`config.ts`). A config that exists but does not PARSE is not
// new-schema — it cannot be — yet it carries no detectable old-era marker
// either, so it reports no `oldEraConfig` and lets the verdict clause speak.
interface ConfigFacts {
  newSchema: boolean;
  oldEra: MigrateSignals["oldEraConfig"];
  tracker: { source: string; team: string | null; type: string | null };
}

function readRawConfig(root: string): ConfigFacts {
  const load = loadConfig(root);
  const raw =
    load?.ok === true ? (load.config as Record<string, unknown>) : null;
  if (raw === null) {
    return { newSchema: false, oldEra: null, tracker: readTracker(null) };
  }
  const hasRun = raw.run !== undefined;
  const vpExtras = extraCommands(raw).filter((command) =>
    VP_COMMAND.test(command)
  );
  const oldEra =
    hasRun || vpExtras.length > 0
      ? { hasRun, path: CONFIG_FILE, vpExtras }
      : null;
  return { newSchema: oldEra === null, oldEra, tracker: readTracker(raw) };
}

// Every `setup`/`teardown`/`checks` extra as a COMMAND STRING: the old era used
// plain string arrays for all three, the new schema uses `{name, run}` objects
// for `checks` — both are read, so a half-migrated config is still judged on
// what it would actually run.
function extraCommands(raw: Record<string, unknown>): string[] {
  const commands: string[] = [];
  for (const key of ["setup", "teardown", "checks"]) {
    const value = raw[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        commands.push(entry);
      } else if (typeof (entry as { run?: unknown })?.run === "string") {
        commands.push((entry as { run: string }).run);
      }
    }
  }
  return commands;
}

// The tracker line as the migration must carry it (Step 7). Read from
// `dobby.config.json` ONLY: the legacy YAML / CLAUDE.md prose scan the skill
// also allows is a JUDGEMENT (prose, not a field), so the CLI reports the
// mechanical fact and never fabricates a type — least of all a Linear `team`.
function readTracker(
  raw: Record<string, unknown> | null
): MigrateSnapshot["tracker"] {
  const tracker = raw?.tracker;
  if (typeof tracker !== "object" || tracker === null) {
    return { source: "none", team: null, type: null };
  }
  const { team, type } = tracker as { team?: unknown; type?: unknown };
  return {
    source: CONFIG_FILE,
    team: typeof team === "string" && team !== "" ? team : null,
    type: typeof type === "string" && type !== "" ? type : null,
  };
}

// Whether the tracker still needs `/dobby:onboard` (Step 10's flag): no tracker
// declared at all, or a Linear line whose `team` was deferred. A wrong team
// silently misroutes work, so "not pinned" always reads as incomplete.
function isTrackerIncomplete(tracker: MigrateSnapshot["tracker"]): boolean {
  if (tracker.type === null) {
    return true;
  }
  return tracker.type === "linear" && tracker.team === null;
}

function detectSignals(
  root: string,
  manifest: Record<string, unknown> | null,
  scan: CapabilityScan,
  config: ConfigFacts,
  toolConfigs: MigrateSnapshot["toolConfigs"]
): MigrateSignals {
  const viteConfig = toolConfigs.vite;
  return {
    aliases: viteplusAliases(manifest),
    conductor: existsSync(join(root, CONDUCTOR_DIR)),
    legacyYaml: existsSync(join(root, LEGACY_YAML)) ? LEGACY_YAML : null,
    oldEraConfig: config.oldEra,
    prepareScript: Object.hasOwn(objectField(manifest, "scripts"), "prepare"),
    viteHooks: existsSync(join(root, VITE_HOOKS_DIR)),
    viteplusDep: scan.dependencies.has(VITEPLUS_PACKAGE),
    // A vite config is only a TASK-TABLE signal when it actually names vp/vpr —
    // otherwise the signal would degrade into "a vite.config.ts exists", which
    // every vite app has.
    vpTaskTable:
      viteConfig !== null &&
      VP_COMMAND.test(readTextFile(join(root, viteConfig)) ?? ""),
  };
}

// Whether NO legacy signal fired — Step 0's "any legacy signal present → this is
// a real migration", inverted so it reads as the verdict clause it feeds.
function noLegacySignal(signals: MigrateSignals): boolean {
  return (
    signals.legacyYaml === null &&
    signals.oldEraConfig === null &&
    !(
      signals.viteplusDep ||
      signals.viteHooks ||
      signals.vpTaskTable ||
      signals.prepareScript ||
      signals.conductor
    ) &&
    signals.aliases.length === 0
  );
}

function snapshotFacts(
  root: string,
  manifest: Record<string, unknown> | null,
  scan: CapabilityScan,
  config: ConfigFacts,
  toolConfigs: MigrateSnapshot["toolConfigs"]
): MigrateSnapshot {
  return {
    ci: legacyWorkflows(root),
    envTest: existsSync(join(root, ".env.test")),
    preservedKeys: PRESERVED_PACKAGE_KEYS.filter(
      (key) => manifest?.[key] !== undefined
    ),
    scripts: Object.keys(objectField(manifest, "scripts")),
    toolConfigs,
    toolchainDeps: TOOLCHAIN_PACKAGES.filter((name) =>
      scan.dependencies.has(name)
    ),
    tracker: config.tracker,
    vercelJson: existsSync(join(root, "vercel.json")),
    worktreeinclude: existsSync(join(root, ".worktreeinclude")),
  };
}

// The packages aliased onto vite-plus, in declaration order. Both `overrides`
// (bun/npm) and `resolutions` (yarn) are read — Step 1 names both.
function viteplusAliases(manifest: Record<string, unknown> | null): string[] {
  const aliases: string[] = [];
  for (const field of ["overrides", "resolutions"]) {
    for (const [name, target] of Object.entries(objectField(manifest, field))) {
      if (typeof target === "string" && VITEPLUS_ALIAS.test(target)) {
        aliases.push(name);
      }
    }
  }
  return aliases;
}

// Where each tool config lives today. The candidate filenames come from the
// SAME pure specs `check`/`dev`/`build` resolve override-by-presence through
// (tasks.ts), so this can never drift from what actually overrides a default.
function locateToolConfigs(
  root: string,
  { capabilities, dependencies }: CapabilityScan
): MigrateSnapshot["toolConfigs"] {
  const vite = viteConfigSpec(capabilities, dependencies);
  return {
    biome: firstPresent(root, biomeConfigSpec(capabilities).ownFiles),
    drizzle: firstPresent(root, drizzleConfigSpec().ownFiles),
    // Both selection arms carry the same own-file set (a present consumer config
    // overrides even the BLOCKED verdict), so either shape answers this.
    vite: firstPresent(
      root,
      vite.kind === "blocked" ? vite.ownFiles : vite.spec.ownFiles
    ),
    vitest: firstPresent(
      root,
      vitestConfigSpec(capabilities, dependencies).ownFiles
    ),
  };
}

// The first candidate filename that exists at the root, or null.
function firstPresent(root: string, candidates: string[]): string | null {
  return candidates.find((name) => existsSync(join(root, name))) ?? null;
}

// The workflow files that still run the vite-plus gate (Step 9's targets), as
// repo-relative paths in a stable order. A workflow with NO vp/vpr line is left
// off — the list is what the migration must REWRITE, not an inventory of CI.
function legacyWorkflows(root: string): string[] {
  const dir = join(root, WORKFLOWS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const workflows: string[] = [];
  for (const name of names) {
    if (!WORKFLOW_FILE.test(name)) {
      continue;
    }
    const content = readTextFile(join(dir, name));
    if (content !== null && VP_COMMAND.test(content)) {
      workflows.push(`${WORKFLOWS_DIR}/${name}`);
    }
  }
  return workflows.sort((left, right) => left.localeCompare(right));
}

// Whether `<root>/<rel>` extends a dobby preset (the tsconfig clause).
function extendsDobby(root: string, rel: string): boolean {
  const raw = readTextFile(join(root, rel));
  return raw !== null && TSCONFIG_EXTENDS_DOBBY.test(raw);
}

// A config `checks[]` extra that FAILED, as check.ts renders it — the capture
// is the extra's own `name`.
const EXTRA_FAILURE_NOTE = /^check '(.+)' failed \(exit \d+\)$/;

// A TOOL step that failed, as check.ts renders it: `<tool>: failed (exit N)`
// (the crashed-tool case) and `test: N suite(s) failed — …` (the parsed vitest
// summary, whose header is the note's first line). Skips (`build: skipped …`),
// the `configs:` line and the advisory hermeticity notes carry no `failed` and
// are correctly ignored.
const TOOL_FAILURE_NOTE = /^([a-z]+):\s.*\bfailed\b/;

// The BLOCKED build (ADR-0015), as check.ts renders it: a config-less
// tanstack-start app missing packages the default vite config imports fails the
// gate through a bare sentence that names no step and never says "failed". It is
// the `build` step — and it is EXACTLY the state a half-finished migration lands
// in (Step 2 deletes `vite.config.ts` before the deps are settled), so it must
// be nameable rather than fall through to the catch-all below.
const BLOCKED_BUILD_NOTE = /^tanstack-start app is missing packages\b/;
const BLOCKED_BUILD_STEP = "build";

// The label a red gate falls back to when no note named a step. The failure
// channel is TOTAL by construction: a nonzero exit that names nothing is the
// undiagnosable failure `check`'s raw tail exists to kill, so an unrecognized
// note shape degrades to "the gate itself" instead of to silence.
const UNNAMED_STEP = "check";

// Which gate steps failed, by the LABEL `check` prints for each: a findings tool
// is named by its group (biome/tsc/knip), a build/test/extra by its failure
// note. Deduped, in pipeline order, and never empty for a nonzero gate.
function failingSteps(
  groups: CheckGroup[],
  notes: CheckNote[],
  exitCode: number
): string[] {
  const steps = new Set<string>();
  for (const group of groups) {
    if (group.findings.length > 0) {
      steps.add(group.tool);
    }
  }
  for (const note of notes) {
    const extra = EXTRA_FAILURE_NOTE.exec(note.text);
    if (extra?.[1] !== undefined) {
      steps.add(extra[1]);
      continue;
    }
    const tool = TOOL_FAILURE_NOTE.exec(note.text);
    if (tool?.[1] !== undefined) {
      steps.add(tool[1]);
      continue;
    }
    if (BLOCKED_BUILD_NOTE.test(note.text)) {
      steps.add(BLOCKED_BUILD_STEP);
    }
  }
  if (exitCode !== 0 && steps.size === 0) {
    steps.add(UNNAMED_STEP);
  }
  return [...steps];
}

// A tolerant text read: null on any read failure (a missing file, a directory).
function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// A tolerant JSON-object read: null when the file is missing, unparseable, or
// does not hold a plain object. package.json is read HERE rather than through a
// typed loader because the migration cares about keys no schema declares
// (`overrides`, `resolutions`, `portless`, `trustedDependencies`).
function readJsonObject(path: string): Record<string, unknown> | null {
  const raw = readTextFile(path);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// One nested object field (`scripts`, `overrides`), or an empty object when the
// key is absent or holds anything else.
function objectField(
  source: Record<string, unknown> | null,
  key: string
): Record<string, unknown> {
  const value = source?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatMigratePreflightText(payload: MigratePreflight): string {
  const { signals: s, snapshot: n } = payload;
  const oldEra =
    s.oldEraConfig === null
      ? "-"
      : `${s.oldEraConfig.path} (run=${s.oldEraConfig.hasRun}${s.oldEraConfig.vpExtras.length === 0 ? "" : `, extras: ${s.oldEraConfig.vpExtras.join(", ")}`})`;
  const configs = Object.entries(n.toolConfigs)
    .map(([tool, path]) => `${tool}=${path ?? "-"}`)
    .join(" · ");
  return `${[
    `verdict:          ${payload.verdict}`,
    `legacyYaml:       ${s.legacyYaml ?? "-"}`,
    `oldEraConfig:     ${oldEra}`,
    `viteplusDep:      ${s.viteplusDep}`,
    `aliases:          ${listOrDash(s.aliases)}`,
    `viteHooks:        ${s.viteHooks}`,
    `vpTaskTable:      ${s.vpTaskTable}`,
    `prepareScript:    ${s.prepareScript}`,
    `conductor:        ${s.conductor}`,
    `toolchainDeps:    ${listOrDash(n.toolchainDeps)}`,
    `preservedKeys:    ${listOrDash(n.preservedKeys)}`,
    `scripts:          ${listOrDash(n.scripts)}`,
    `toolConfigs:      ${configs}`,
    `worktreeinclude:  ${n.worktreeinclude}`,
    `envTest:          ${n.envTest}`,
    `vercelJson:       ${n.vercelJson}`,
    `ci:               ${listOrDash(n.ci)}`,
    `tracker:          ${n.tracker.type ?? "-"} (team ${n.tracker.team ?? "-"}, from ${n.tracker.source})`,
  ].join("\n")}\n`;
}

function formatMigrateVerifyText(payload: MigrateVerify): string {
  return `${[
    `ok:                 ${payload.ok}`,
    `check:              exit ${payload.check.exitCode}`,
    `failingSteps:       ${listOrDash(payload.check.failingSteps)}`,
    `capabilities:       ${listOrDash(payload.env.capabilities)}`,
    `config:             ${payload.env.config}`,
    `dbTasks:            ${listOrDash(payload.env.dbTasks)}`,
    `devUrl:             ${payload.env.devUrl ?? "-"}`,
    `legacyFiles:        ${listOrDash(payload.residual.legacyFilesRemaining)}`,
    `deltaConfigsKept:   ${listOrDash(payload.residual.deltaConfigsKept)}`,
    `trackerIncomplete:  ${payload.residual.trackerIncomplete}`,
  ].join("\n")}\n`;
}

// A list field for text output: its members, or a dash when empty.
function listOrDash(values: readonly string[]): string {
  return values.length === 0 ? "-" : values.join(", ");
}
