import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { type CheckGroup, type CheckNote, check } from "./check.ts";
import type { CommandContext, CommandResult } from "./command.ts";
import { type RunResult, requireWorkroot, runCapture } from "./runner.ts";

// `dobby ship` — the commit ceremony, mechanized: stage-if-nothing-staged →
// the in-process gate (`check(fix: true)`; a nonzero gate prints the FULL findings
// and commits NOTHING) → re-stage → `git commit -F <message-file>` → push (`-u
// origin HEAD` when there is no upstream) → `gh pr create --body-file` off main
// only, and only when no PR exists yet. Writes the gate cache the pre-push
// backstop reads (`.dobby/gate-cache.json`, keyed by the post-`git add -A` tree
// hash + the dobby version + the config hash) and answers with the JSON payload
// `{committed, sha, pushed, prUrl, gateExitCode, cacheWritten}` plus the two notes
// (`cacheNote` / `prNote`) that say why a step did NOT happen.
//
// THE EXIT CODE DECIDES. ship never interprets findings: it composes `check()`
// IN-PROCESS (the same data path `dobby check --fix` takes — never a `dobby`
// subprocess), and a nonzero verdict ends the ceremony with that same code, the
// findings surfaced WHOLE on stderr. Nothing is committed, nothing is pushed, and
// no cache entry is written for a tree that never passed.
//
// Every child process goes through `runner.ts` with its cwd pinned to the workroot
// (`requireWorkroot` — running outside a git repository is a hard error, never a
// silent ambient-cwd fallback). `gh` is spawned BARE, resolved through PATH like
// the CLI's other system tools (git, curl, cmux) — never an absolute path.
//
// node:*-only (ADR-0008) — vitest imports this under Node, Bun runs it in prod.

// The command's machine-readable answer (the `--json` payload): flat, alphabetized,
// explicit nulls — the `EnvSnapshot` convention.
//   - `cacheNote` — why the gate cache was NOT written, or null. The only case in
//     practice is an unmerged index (`git write-tree` exits 128), where there is no
//     single tree to key on.
//   - `prNote` — why a REQUESTED pull request has no URL, or null. Without it a gh
//     that failed (absent, expired auth, an API error) would be byte-identical to
//     "no PR was asked for": both `prUrl: null`. A caller must be able to tell
//     "skipped by policy" from "could not be opened".
//   - `sha` — the commit ship created, or null when it created none.
interface ShipPayload {
  cacheNote: string | null;
  cacheWritten: boolean;
  committed: boolean;
  gateExitCode: number;
  prNote: string | null;
  prUrl: string | null;
  pushed: boolean;
  sha: string | null;
}

// The gate cache the pre-push backstop reads to skip a re-run: a COMPOSITE key
// (spec Decision 8 / open question O2), because a tree hash alone would serve a
// stale pass across a dobby upgrade or a `dobby.config.json` edit — both of which
// change what the gate DOES to an unchanged tree.
interface GateCache {
  // When the gate ran (ISO 8601), so a backstop can bound how stale a pass may be.
  at: string;
  // sha256 of the project's `dobby.config.json` BYTES, or null when it has none.
  configHash: string | null;
  dobbyVersion: string;
  // The gate's verdict for that tree. Only a green (0) verdict is ever cached.
  exitCode: number;
  treeHash: string;
}

// The branches a pull request has nowhere to go FROM: shipping on the trunk
// commits and pushes, and opens nothing.
const TRUNK_BRANCHES: readonly string[] = ["main", "master"];

// `git write-tree`'s exit status for an unmerged index — the one state with no
// single tree to hash (a conflicted merge in progress).
const UNMERGED_INDEX_STATUS = 128;

/**
 * Run the commit ceremony. Returns the outcome as DATA (`run.ts` renders it):
 * the JSON payload under `--json`, a token-lean human summary otherwise, and any
 * gate findings / hard error on `error` (stderr) — which under `--json` is the
 * ONLY channel left, since the payload owns stdout.
 *
 * @public — the `ship` command's domain entry, dispatched by the registry in run.ts.
 */
export function runShip(context: CommandContext): CommandResult {
  // The message file is validated BEFORE anything is touched: a ceremony that
  // cannot produce a commit message must leave the tree exactly as it found it —
  // unstaged, un-formatted, un-gated.
  const message = readMessageFile(context);
  if ("error" in message) {
    return { error: message.error, exitCode: 1 };
  }
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
  return performShip(context, root, message);
}

// The validated commit message: the file path handed to `git commit -F`, plus its
// first non-empty line — the subject, reused as the pull request's title.
interface CommitMessage {
  path: string;
  subject: string;
}

// Resolve + validate `--message-file`: present, readable, and non-empty. The path
// is resolved against the CALLER's cwd (every spawn below is pinned to the
// workroot, so a relative path would otherwise silently change meaning).
// Whitespace-only counts as empty — `git commit -F` would reject it anyway, and
// failing here keeps the "before any mutation" guarantee.
function readMessageFile(
  context: CommandContext
): CommitMessage | { error: string } {
  const flag = context.options["message-file"];
  if (typeof flag !== "string" || flag === "") {
    return {
      error: "ship requires --message-file <path> (the commit message)",
    };
  }
  const path = resolve(context.cwd, flag);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {
      error: `--message-file: cannot read the commit message file ${path}`,
    };
  }
  if (content.trim() === "") {
    return {
      error: `--message-file: the commit message file ${path} is empty`,
    };
  }
  const subject = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return { path, subject: subject ?? "" };
}

// The ceremony itself, on a resolved workroot with a validated message file.
function performShip(
  context: CommandContext,
  root: string,
  message: CommitMessage
): CommandResult {
  // 1. Stage when nothing is staged. A caller-staged subset is respected HERE —
  // but only until the gate has spoken: step 3 re-stages the whole tree, because
  // the gate judges the WORKING TREE, and committing a subset of it would record
  // (and cache) a green verdict for a tree that was never checked.
  if (nothingStaged(root)) {
    stageAll(root);
  }

  // 2. The GATE — `check()` composed IN-PROCESS with fix=true: exactly the data
  // path `dobby check --fix` takes (biome's SAFE fixes applied first, then the
  // full pipeline reports whatever remains).
  const report = check([], root, {}, true);
  if (!report.ok) {
    return { error: report.error, exitCode: 1 };
  }
  if (report.exitCode !== 0) {
    return render(
      context,
      {
        cacheNote: null,
        cacheWritten: false,
        committed: false,
        gateExitCode: report.exitCode,
        prNote: null,
        prUrl: null,
        pushed: false,
        sha: null,
      },
      // The exit code decides; the findings are the human's to read — WHOLE, never
      // the per-tool sample `dobby check` prints.
      { error: formatFindings(report.groups, report.notes, report.exitCode) }
    );
  }

  // 3. Re-stage: the gate's own `--fix` rewrites must land in the commit. The
  // machine-state home is ensured gitignored FIRST — before the sweep, so a
  // `.gitignore` this run had to write is itself committed and the tree is left
  // clean, and before step 4 writes `.dobby/gate-cache.json` into it.
  ensureGitignored(root);
  stageAll(root);

  // 4. The gate cache, keyed on the tree that just passed.
  const cache = writeGateCache(root);

  // 5. Commit.
  const commit = runCapture("git", ["commit", "-F", message.path], { root });
  if (commit.status !== 0) {
    return render(
      context,
      {
        ...cache,
        committed: false,
        gateExitCode: 0,
        prNote: null,
        prUrl: null,
        pushed: false,
        sha: null,
      },
      { error: gitFailure("commit", commit.stderr, commit.stdout) }
    );
  }
  const sha = gitFact(root, ["rev-parse", "HEAD"]);

  // 6 + 7. Push, then the pull request.
  const published = publish(context, root, message);
  return render(
    context,
    {
      ...cache,
      committed: true,
      gateExitCode: 0,
      prNote: published.prNote,
      prUrl: published.prUrl,
      pushed: published.pushed,
      sha,
    },
    // A PR that could not be opened is a NOTE, not a failure: the commit is made
    // and pushed, and re-running ship would only re-do work that already landed.
    { error: published.error, note: published.prNote }
  );
}

// What the publish half of the ceremony produced. `prNote` explains a REQUESTED
// pull request that has no URL; it stays null when none was asked for.
interface Published {
  error?: string;
  prNote: string | null;
  prUrl: string | null;
  pushed: boolean;
}

// Steps 6 + 7: push the commit, then open (or find) the pull request. A failed
// push short-circuits the PR — there is no branch on the remote to open one from.
function publish(
  context: CommandContext,
  root: string,
  message: CommitMessage
): Published {
  // `git push` needs an upstream; a branch that tracks nothing gets one created.
  // The upstream is READ first (a side-effect-free `rev-parse`) rather than
  // discovered by letting a bare push fail.
  const tracked =
    runCapture(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { root }
    ).status === 0;
  const push = runCapture(
    "git",
    tracked ? ["push"] : ["push", "-u", "origin", "HEAD"],
    { root }
  );
  if (push.status !== 0) {
    return {
      error: gitFailure("push", push.stderr, push.stdout),
      prNote: null,
      prUrl: null,
      pushed: false,
    };
  }

  const bodyFile = context.options["pr-body-file"];
  const branch = gitFact(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // A PR is opened only when there is somewhere to open it FROM (off the trunk)
  // and something to open it WITH (a body file the caller authored).
  if (typeof bodyFile !== "string" || TRUNK_BRANCHES.includes(branch)) {
    return { prNote: null, prUrl: null, pushed: true };
  }
  const existing = existingPullRequest(root, branch);
  if (existing !== null) {
    // The push above already updated it — noting the URL is the whole answer.
    return { prNote: null, prUrl: existing, pushed: true };
  }
  const created = createPullRequest(
    root,
    resolve(context.cwd, bodyFile),
    message.subject
  );
  return { prNote: created.note, prUrl: created.url, pushed: true };
}

// The branch's pull request URL via `gh pr view <branch> --json url`, or null when
// gh cannot answer: no PR (gh exits 1 with "no pull requests found"), no gh on
// PATH, no remote, an unparseable payload. Every one of those reads as "none yet",
// which is what makes the create path reachable.
function existingPullRequest(root: string, branch: string): string | null {
  const result = runCapture("gh", ["pr", "view", branch, "--json", "url"], {
    root,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  try {
    const data = JSON.parse(result.stdout) as { url?: unknown };
    return typeof data.url === "string" && data.url !== "" ? data.url : null;
  } catch {
    return null;
  }
}

// Open the pull request and pass gh's own answer (the new PR's URL) straight
// through. A gh that could NOT open it (not on PATH, expired auth, an API error)
// yields a NOTE carrying gh's own words instead: the commit is already pushed so
// the ceremony stands, but "the caller asked for a PR and there is none" must never
// read the same as "no PR was asked for" — both are `prUrl: null` otherwise.
//
// `--title` is NOT decoration: gh REQUIRES a title (or `--fill`) when it is not
// attached to a TTY, which is exactly how ship runs. The subject line of the
// commit message the caller authored IS that title — nothing new is invented.
function createPullRequest(
  root: string,
  bodyFile: string,
  title: string
): { note: string | null; url: string | null } {
  const args = ["pr", "create", "--body-file", bodyFile];
  if (title !== "") {
    args.push("--title", title);
  }
  const result = runCapture("gh", args, { root });
  if (result.error || result.status !== 0) {
    return {
      note: `pull request NOT opened: ${ghFailure(result)}`,
      url: null,
    };
  }
  const url = result.stdout.trim();
  return url === ""
    ? {
        note: "pull request NOT opened: gh reported no URL",
        url: null,
      }
    : { note: null, url };
}

// gh's own account of a failed call, as one presentable line: the spawn error
// first (a gh that is not on PATH at all never speaks), then its stderr, then its
// stdout — and a bare exit status when it said nothing.
function ghFailure(result: RunResult): string {
  if (result.error !== undefined) {
    return `gh could not be run (${result.error.message})`;
  }
  const detail = (result.stderr.trim() === "" ? result.stdout : result.stderr)
    .trim()
    .split("\n")
    .join(" ");
  return detail === "" ? `gh exited ${result.status}` : `gh: ${detail}`;
}

// --- the gate cache ---------------------------------------------------------

// The cache fields of the payload — what `writeGateCache` reports back.
interface CacheOutcome {
  cacheNote: string | null;
  cacheWritten: boolean;
}

// Write `.dobby/gate-cache.json` for the tree that just passed.
//
// `git write-tree` MUST run AFTER `git add -A` (step 3): untracked-but-not-ignored
// files are invisible to the tree otherwise, while biome/tsc/knip DO see them — a
// key describing a different tree than the one the gate judged is cache POISONING.
// Staged-first, the hash is byte-identical to the resulting commit's `HEAD^{tree}`.
//
// An unmerged index (exit 128) has no single tree: the cache is skipped and the
// reason travels in the payload, never as a failure — the commit is unaffected.
//
// The caller has already ensured `.dobby/` is gitignored (step 3, before the
// sweep): the cache is written AFTER `git add -A`, so an un-ignored one would be
// swept into the NEXT ship's commit — and the tree hash it keys on would then
// include the cache file it is about to rewrite, a key that can never match again
// (the very cache poisoning this step exists to prevent).
function writeGateCache(root: string): CacheOutcome {
  const tree = runCapture("git", ["write-tree"], { root });
  if (tree.status !== 0) {
    return {
      cacheNote:
        tree.status === UNMERGED_INDEX_STATUS
          ? "gate cache skipped: the index is unmerged, so there is no single tree to key on"
          : `gate cache skipped: git write-tree failed (${tree.stderr.trim()})`,
      cacheWritten: false,
    };
  }
  const cache: GateCache = {
    at: new Date().toISOString(),
    configHash: configHash(root),
    dobbyVersion: pkg.version,
    exitCode: 0,
    treeHash: tree.stdout.trim(),
  };
  try {
    mkdirSync(join(root, ".dobby"), { recursive: true });
    writeFileSync(
      join(root, ".dobby", "gate-cache.json"),
      `${JSON.stringify(cache, null, 2)}\n`
    );
  } catch (error) {
    return {
      cacheNote: `gate cache skipped: ${error instanceof Error ? error.message : String(error)}`,
      cacheWritten: false,
    };
  }
  return { cacheNote: null, cacheWritten: true };
}

// Keep the machine-state home out of the consumer's index — the same guarantee
// `up` makes for its detached-run pidfile and `repro` for its records, repeated
// here (rather than shared) because the commit ceremony must not depend on the run
// lifecycle. Idempotent and best-effort: an unwritable `.gitignore` costs nothing —
// the cache is a convenience, and the commit that follows is unaffected.
function ensureGitignored(root: string): void {
  const path = join(root, ".gitignore");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No .gitignore yet — appending below creates it.
  }
  const present = raw
    .split("\n")
    .some((line) => line.trim() === ".dobby/" || line.trim() === ".dobby");
  if (present) {
    return;
  }
  try {
    const prefix = raw === "" || raw.endsWith("\n") ? "" : "\n";
    appendFileSync(path, `${prefix}.dobby/\n`);
  } catch {
    // Best-effort: an unwritable .gitignore never fails the ceremony.
  }
}

// sha256 of the project's `dobby.config.json` BYTES (never a re-serialization —
// the file's own bytes are what a later run compares against), or null when the
// project ships none.
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

// --- git plumbing -----------------------------------------------------------

// Whether the index holds nothing staged: `git diff --staged --quiet` exits 0 when
// the index matches HEAD. A git call that fails outright reads as "something is
// staged" — step 3's unconditional re-stage converges either way.
function nothingStaged(root: string): boolean {
  return (
    runCapture("git", ["diff", "--staged", "--quiet"], { root }).status === 0
  );
}

// Stage the WHOLE tree (untracked-but-not-ignored work included — the gate sees it,
// so the commit must contain it).
function stageAll(root: string): void {
  runCapture("git", ["add", "-A"], { root });
}

// A single git fact as trimmed stdout (empty string when git could not answer).
function gitFact(root: string, args: string[]): string {
  return runCapture("git", args, { root }).stdout.trim();
}

// A failed git step as one caller-presentable message: what failed, then git's own
// output (stderr first — where git speaks — falling back to stdout).
function gitFailure(step: string, stderr: string, stdout: string): string {
  const detail = (stderr.trim() === "" ? stdout : stderr).trim();
  return detail === "" ? `git ${step} failed` : `git ${step} failed: ${detail}`;
}

// --- rendering --------------------------------------------------------------

// Render the outcome per the `--json` contract: with `--json` the payload is the
// ONLY stdout; without it, a token-lean human summary. Gate findings and hard
// errors always travel on `error` (stderr) — under `--json` that is the only
// channel left, and keeping it uniform means both forms surface the same text.
//
// A `note` rides the SAME stderr channel but does NOT fail the run: it explains a
// step that did not happen (an un-openable pull request) after a commit that DID.
function render(
  context: CommandContext,
  payload: ShipPayload,
  outcome: { error?: string; note?: string | null } = {}
): CommandResult {
  const exitCode = shipExitCode(payload, outcome.error);
  const result: CommandResult = { exitCode };
  const spoken = [outcome.error, outcome.note].filter(
    (part): part is string => typeof part === "string" && part !== ""
  );
  if (spoken.length > 0) {
    result.error = spoken.join("\n\n");
  }
  if (context.options.json === true) {
    result.json = payload;
  } else {
    result.text = formatShip(payload);
  }
  return result;
}

// The process exit code: the GATE's own code whenever the gate failed (ship never
// reinterprets it), 1 for any other failure that carried an error, else 0.
function shipExitCode(payload: ShipPayload, error: string | undefined): number {
  if (payload.gateExitCode !== 0) {
    return payload.gateExitCode;
  }
  return error === undefined ? 0 : 1;
}

// The human form: one fact per line, in ceremony order.
function formatShip(payload: ShipPayload): string {
  const lines = [
    payload.committed
      ? `committed ${payload.sha}`
      : `not committed (gate exit ${payload.gateExitCode})`,
    `pushed: ${payload.pushed ? "yes" : "no"}`,
    `pull request: ${payload.prUrl ?? "none"}`,
  ];
  if (payload.prNote !== null) {
    lines.push(payload.prNote);
  }
  if (payload.cacheNote !== null) {
    lines.push(payload.cacheNote);
  }
  return `${lines.join("\n")}\n`;
}

// The gate's findings, WHOLE — one `file:line message` line per finding, grouped
// and labelled per tool, then the step notes (a crashed tool's raw tail beneath
// its note). Deliberately NOT `run.ts`'s `formatCheck`: that one is private to the
// dispatcher (importing it would close an import cycle) and CAPS each tool at 50
// findings — a sample is right for a `check` run a human re-runs at will, wrong for
// the one report explaining why a commit did not happen.
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
