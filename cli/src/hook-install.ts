import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { type CheckGroup, type CheckNote, check } from "./check.ts";
import { requireWorkroot, runCapture } from "./runner.ts";

// The PRE-PUSH BACKSTOP — the last mechanical stop between a red gate and the
// remote (spec Decisions 7 + 8; the evidence is the v0.5.1 incident, where a
// summary was read as the whole truth and a broken release was pushed).
//
// THREE pieces, all owned here so the shell script stays dumb:
//
//  1. `prePushCheck(cwd, stdin)` — the `dobby check --pre-push` mode. It reads
//     git's pre-push stdin contract, consults the GATE CACHE `ship` wrote, and
//     either lets the push through or runs the gate IN-PROCESS and blocks.
//  2. The generated HOOK SHIM — a `/bin/sh` script carrying nothing but the
//     ADR-0012 double guard and an `exec` of the project's LOCAL dobby. All the
//     judgment lives in (1), where `run(argv, cwd, stdin)` makes it testable.
//  3. The INSTALL, planned + executed as a `SetupAction` of `up`'s setup phase
//     (`lifecycle.ts`) — which runs even for a no-app project, which is how the
//     backstop reaches EVERY consumer (Decision 7: all consumers, not opt-in).
//
// Every git fact comes from git plumbing, never from a hardcoded path:
// `--git-path hooks` resolves to the COMMON dir from any linked worktree AND
// honors `core.hooksPath`, so one install covers every worktree of a repository.
//
// node:* + the shared runner only (ADR-0008) — vitest imports this under Node,
// Bun runs it in production.

// Top-level regexes (biome useTopLevelRegex — a literal inside a function is
// recompiled per call). Named by what they match.
//
// git spells "no object" as all zeros: 40 of them in a SHA-1 repository, 64 in a
// SHA-256 one — hence the open-ended `0+` rather than a fixed width.
const ZERO_SHA_RE = /^0+$/;
const WHITESPACE_RE = /\s+/;
// A peeled tree, as git prints it: lowercase hex, SHA-1 (40) through SHA-256 (64).
const OBJECT_NAME_RE = /^[0-9a-f]{40,64}$/;

// Line 2 of every shim dobby generates, and THE identity test on install: a
// pre-push hook carrying this marker is ours to upgrade in place, one without it
// is someone else's and is never touched (the refuse-and-report policy).
//
// Prior art rejected, deliberately: lefthook's fingerprint file (a second state
// file to keep in sync) and husky's `core.hooksPath` (repo-GLOBAL — pointing it
// at a dobby directory would disable every other hook the repo has, which is a
// far bigger footprint than the one file this backstop needs).
const PRE_PUSH_MARKER = "# dobby-managed pre-push backstop";

// The generated shim — a DUMB script by design: a guard and an exec, no parsing,
// no decisions. Every behaviour worth testing lives in `prePushCheck`, reachable
// in-process; a shell script is reachable only through a real `git push`.
//
// The double guard is the shape `plugin/hooks/hooks.json` established (ADR-0012):
// run only in a dobby project (the config marker) whose LOCAL dobby is installed
// and executable — a network-resolved `dobby` would fetch the unrelated npm
// package of that name, so the hook only ever runs what is already on disk.
// Anything else is a SILENT exit 0: a backstop that broke `git push` in a fresh
// clone would be worse than the red push it exists to prevent.
//
// git runs a hook with the pushed worktree as its cwd (verified in a linked
// worktree), so both relative paths address the tree being pushed. `exec` hands
// stdin — git's ref lines — straight through, and the CLI's exit code becomes the
// hook's, which is what aborts the push. Documented bypass: `git push --no-verify`.
const PRE_PUSH_SHIM = [
  "#!/bin/sh",
  `${PRE_PUSH_MARKER} — do not edit`,
  "# Runs the dobby quality gate over what is about to be pushed and refuses the",
  "# push when it is red. Bypass with `git push --no-verify`.",
  "[ -f dobby.config.json ] && [ -x node_modules/.bin/dobby ] || exit 0",
  "exec node_modules/.bin/dobby check --pre-push",
  "",
].join("\n");

/**
 * The setup-phase action that installs the backstop. `path` is git's OWN answer
 * for where the pre-push hook belongs (absolute, common-dir, `core.hooksPath`
 * honored); `foreign` marks a hook that exists and does NOT carry dobby's marker
 * — planned so `up --dry-run` can name the file it will refuse to overwrite.
 *
 * @public — a member of `lifecycle.ts`'s `SetupAction` union.
 */
export interface PrePushHookAction {
  foreign: boolean;
  kind: "hook";
  path: string;
}

/**
 * Plan the pre-push hook install for `root`, or null when git cannot say where
 * hooks live (nothing to install into — never a failure).
 *
 * @public — called by `lifecycle.ts`'s `buildSetupPlan`.
 */
export function planPrePushHook(root: string): PrePushHookAction | null {
  const path = prePushHookPath(root);
  if (path === null) {
    return null;
  }
  return { foreign: isForeignHook(path), kind: "hook", path };
}

/**
 * Execute a planned hook install: write the shim and make it executable (git only
 * runs a hook it can execute). Idempotent — the shim is a constant, so a re-run
 * rewrites identical bytes, and a marker-carrying hook from an older dobby is
 * UPGRADED in place. A FOREIGN hook is left exactly as it is (refuse-and-report:
 * the plan already named it).
 *
 * Best-effort: an unwritable hooks directory must never fail `up`. The backstop is
 * a convenience for the maintainer's own repository, not a precondition for
 * bringing a workspace up, and there is no honest `UpReason` for it.
 *
 * @public — called by `lifecycle.ts`'s `executeSetup`.
 */
export function installPrePushHook(action: PrePushHookAction): void {
  if (action.foreign) {
    return;
  }
  try {
    mkdirSync(dirname(action.path), { recursive: true });
    writeFileSync(action.path, PRE_PUSH_SHIM);
    chmodSync(action.path, 0o755);
  } catch {
    // Best-effort by contract (see above).
  }
}

// Where git says this repository's pre-push hook belongs. `--git-path hooks`
// resolves to the COMMON git dir from a linked worktree (so ONE install covers
// every worktree) and honors `core.hooksPath`; `--path-format=absolute` makes the
// answer independent of the cwd the plan is later rendered or executed from.
function prePushHookPath(root: string): string | null {
  const result = runCapture(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    { root }
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const dir = result.stdout.trim();
  return dir === "" ? null : join(dir, "pre-push");
}

// Whether an EXISTING pre-push hook belongs to somebody else. Absent = ours to
// write. Present but unreadable counts as foreign: a file that cannot be
// identified must never be overwritten.
function isForeignHook(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return !readFileSync(path, "utf8").includes(PRE_PUSH_MARKER);
  } catch {
    return true;
  }
}

// --- `dobby check --pre-push` ------------------------------------------------

// The process outcome as data — the same shape `run()` returns, so the dispatcher
// hands it straight back.
interface PrePushOutcome {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * The pre-push gate. Reads git's ref lines from `stdin`, and:
 *  - nothing being pushed (EMPTY stdin, or only deletions) → exit 0, no gate. A
 *    deletion carries no tree, so gating the working tree would judge something
 *    the push does not contain.
 *  - every pushed tree already covered by a matching gate-cache entry → exit 0
 *    with `gate cache hit (<tree>)` on stderr, WITHOUT running the gate.
 *  - otherwise the gate runs IN-PROCESS with fix=false (a hook must never rewrite
 *    the developer's files behind their back — those bytes are what is being
 *    pushed) and a nonzero verdict blocks the push, findings printed WHOLE.
 *
 * @public — the `check --pre-push` mode, dispatched by run.ts.
 */
export function prePushCheck(
  cwd: string,
  stdin: string | undefined
): PrePushOutcome {
  const pushed = parsePushedShas(stdin);
  if (pushed.length === 0) {
    return { exitCode: 0, stderr: "", stdout: "" };
  }

  let root: string;
  try {
    root = requireWorkroot(cwd);
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      stdout: "",
    };
  }

  const cached = cacheHit(root, peelTrees(root, pushed));
  if (cached !== null) {
    return { exitCode: 0, stderr: `gate cache hit (${cached})\n`, stdout: "" };
  }

  // fix=false: `--fix` is the COMMIT gate's business. Rewriting files during a
  // push would change the working tree after the pushed commits were made.
  const report = check([], root, {}, false);
  if (!report.ok) {
    return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
  }
  if (report.exitCode === 0) {
    return { exitCode: 0, stderr: "", stdout: "" };
  }
  return {
    exitCode: report.exitCode,
    stderr: `${formatFindings(report.groups, report.notes, report.exitCode)}\n`,
    stdout: "",
  };
}

// The shas this push would put on the remote, from git's pre-push stdin contract:
// one line per ref, `<local-ref> <local-sha> <remote-ref> <remote-sha>`.
//
// FIELD 2 IS THE ONLY ONE READ. Field 1 is not a ref in general — git writes the
// literal `(delete)` when a branch is being deleted, and a raw object name for a
// `git push <sha>:<ref>` — so parsing it would misidentify what is being pushed.
// An all-zeros field 2 IS the deletion marker: nothing is being pushed on that
// line, and it is skipped. Empty / malformed lines contribute nothing.
function parsePushedShas(stdin: string | undefined): string[] {
  if (stdin === undefined) {
    return [];
  }
  const shas: string[] = [];
  for (const line of stdin.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const [, sha] = trimmed.split(WHITESPACE_RE);
    if (sha === undefined || ZERO_SHA_RE.test(sha)) {
      continue;
    }
    shas.push(sha);
  }
  return shas;
}

// The TREE each pushed sha carries — the gate cache's key, since two commits with
// different messages over identical content deserve the same verdict. `^{tree}`
// also peels an annotated tag through to its commit's tree.
//
// null = NO KEY: `git rev-parse <sha>^{tree}` exits 128 for an object this
// repository does not have (verified out of band), and a push whose content
// cannot be identified must be gated rather than waved through on a cache entry
// that describes something else.
function peelTrees(root: string, shas: string[]): string[] | null {
  const trees: string[] = [];
  for (const sha of shas) {
    const result = runCapture("git", ["rev-parse", `${sha}^{tree}`], { root });
    const tree = result.stdout.trim();
    if (result.error || result.status !== 0 || !OBJECT_NAME_RE.test(tree)) {
      return null;
    }
    trees.push(tree);
  }
  return trees;
}

// --- the gate cache ----------------------------------------------------------

// The gate cache as `ship` writes it (`.dobby/gate-cache.json`) — a CROSS-MODULE
// DATA CONTRACT, restated here rather than imported so the backstop never depends
// on the commit ceremony. `at` (the ISO timestamp ship records) is deliberately
// unread: v1 bounds staleness by the KEY, not by age.
interface GateCache {
  configHash: string | null;
  dobbyVersion: string;
  exitCode: number;
  treeHash: string;
}

// The cached tree when the cache ANSWERS for this push, else null.
//
// The key is COMPOSITE (spec Decision 8): a tree hash alone would serve a stale
// pass across a dobby upgrade (new rules, new tools) or a `dobby.config.json` edit
// (new `checks[]` extras) — both change what the gate DOES to an unchanged tree.
// And only a GREEN verdict is an answer: a cached red says nothing about a tree
// whose findings may since have been fixed, so it falls through to a real run.
function cacheHit(root: string, trees: string[] | null): string | null {
  if (trees === null || trees.length === 0) {
    return null;
  }
  const cache = readGateCache(root);
  if (cache === null || cache.exitCode !== 0) {
    return null;
  }
  if (cache.dobbyVersion !== pkg.version) {
    return null;
  }
  if (cache.configHash !== configHash(root)) {
    return null;
  }
  // EVERY pushed tree must be covered — a push carrying one cached commit and one
  // uncached one is not a cached push.
  return trees.every((tree) => tree === cache.treeHash) ? cache.treeHash : null;
}

// Read + validate `.dobby/gate-cache.json`. Every failure (absent, unreadable,
// unparseable, wrongly typed) is null = no cache, which costs one gate run — the
// safe direction for a file this module does not write.
function readGateCache(root: string): GateCache | null {
  let raw: string;
  try {
    raw = readFileSync(join(root, ".dobby", "gate-cache.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { configHash: cachedConfig, dobbyVersion, exitCode, treeHash } = record;
  if (
    typeof treeHash !== "string" ||
    typeof dobbyVersion !== "string" ||
    typeof exitCode !== "number"
  ) {
    return null;
  }
  // `configHash` is legitimately null (a project with no `dobby.config.json`);
  // anything else typed is a cache this dobby cannot read.
  if (cachedConfig !== null && typeof cachedConfig !== "string") {
    return null;
  }
  return { configHash: cachedConfig, dobbyVersion, exitCode, treeHash };
}

// sha256 of the project's `dobby.config.json` BYTES (never a re-serialization),
// or null when it ships none — the same computation `ship` caches, so the two
// agree byte for byte.
function configHash(root: string): string | null {
  const path = join(root, "dobby.config.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

// --- rendering ---------------------------------------------------------------

// The gate's findings, WHOLE — one `file:line message` line per finding, grouped
// and labelled per tool, then the step notes (a crashed tool's raw tail beneath
// its note).
//
// UNCAPPED ON PURPOSE, and deliberately NOT `run.ts`'s `formatCheck`, which keeps
// only 50 findings per tool: a sample is right for a `check` a human re-runs at
// will, and wrong for the one report explaining why a push was refused — the
// v0.5.1 incident was exactly a summary being mistaken for the whole truth.
// (`ship.ts` renders the same way for the same reason; its copy is private, and
// the backstop importing the commit ceremony would be a worse coupling than these
// twenty lines.)
function formatFindings(
  groups: CheckGroup[],
  notes: CheckNote[],
  exitCode: number
): string {
  const blocks: string[] = [];
  for (const group of groups) {
    if (group.findings.length === 0) {
      continue;
    }
    const lines = [`${group.tool} (${group.findings.length}):`];
    for (const finding of group.findings) {
      lines.push(
        `  ${finding.file}:${finding.line} ${finding.message}`.trimEnd()
      );
    }
    blocks.push(lines.join("\n"));
  }
  for (const note of notes) {
    blocks.push(renderNote(note));
  }
  if (blocks.length === 0) {
    return `the gate failed (exit ${exitCode}) without reporting findings`;
  }
  return blocks.join("\n\n");
}

// A step note as one block: its line, plus — when the step CRASHED (a findingless
// nonzero exit) — the labelled, indented tail of the tool's raw output.
function renderNote(note: CheckNote): string {
  if (note.raw === null) {
    return note.text;
  }
  const body = note.raw
    .split("\n")
    .map((line) => `    ${line}`.trimEnd())
    .join("\n");
  return `${note.text}\n  raw output (tail):\n${body}`;
}
