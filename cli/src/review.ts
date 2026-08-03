import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandContext, CommandResult } from "./command.ts";
import { type RunResult, requireWorkroot, runCapture } from "./runner.ts";

// `dobby review fetch|apply` + `dobby pr watch` — everything the address-review
// stage reads and writes through `gh`, mechanized.
//
//   - `review fetch` — the PR + adapter (+ candidates), the open review THREADS
//     (GraphQL-only, drained with the `$endCursor` pagination contract, each
//     carrying `comments(last: 5)` so a re-run can see its own prior replies), and
//     the summary comment (REST `issues/{n}/comments`, sorted by `updated_at`, bot
//     matched by BARE slug).
//   - `review apply` — consumes a disposition plan (`--plan <file>` / `--stdin`),
//     batching the resolve mutations and skipping already-answered threads, then
//     re-triggers as asked. Idempotent by construction.
//   - `pr watch` — its OWN polling loop over `gh pr checks --json`, deriving the
//     verdict from bucket counts (`ci-failed|ci-green|ci-pending|merge-ready|
//     feedback-present|open-unreviewed|skipped`) because gh's JSON mode always
//     exits 0. NO merge path.
//
// TWO deliberate deviations from the spec's verdict list, both about the WAIT:
//   - `ci-pending` is the CI wait's timeout answer. The spec's CI loop is
//     unbounded ("poll until terminal"), which would let `pr watch` hang forever
//     on a queued run — unacceptable for a command a skill shells out to — so the
//     CI wait is budgeted too and its expiry gets its OWN verdict rather than
//     being folded into a green or a red one.
//   - `--deadline` is therefore the budget for EACH wait PHASE (CI, then review),
//     each starting a fresh clock, never one shared ceiling: a shared clock spent
//     on a slow CI run would leave `--await-review` a single poll and answer
//     `open-unreviewed` without ever having waited for the review.
//
// The DIVISION OF LABOUR: these commands only move DATA. Every judgment the stage
// makes — is this finding valid, what is the fix brief, may we merge — stays in
// `/dobby:address-review`. The CLI's job is to make the mechanics unmissable.
//
// FOUR gh INCOMPATIBILITIES are baked in here (researched against gh 2.95.0 +
// cli/cli source); each is the difference between working and silently wrong:
//
//  1. `gh api graphql --paginate` REQUIRES the cursor variable to be named
//     literally `$endCursor` (plus `pageInfo { hasNextPage endCursor }`). The old
//     hand-loop recipe used `$cursor` — incompatible: gh cannot drive it, so the
//     command reads page 1 and reports a truncated thread list as complete.
//  2. `gh pr checks --watch --json` is a HARD ERROR (a source guard), and in
//     `--json` mode gh never signals the CHECKS' state through its exit code (the
//     1/8 exits live in the non-JSON path only) — so `pr watch` owns its polling
//     loop and derives every verdict from BUCKET COUNTS. What a nonzero exit DOES
//     mean there is "gh could not report at all", which is a failure to surface,
//     never an empty check list to call green (the one exception being gh's own
//     "no checks reported on the '<branch>' branch").
//  3. `reviewThreads` exists ONLY in GraphQL (`gh pr view --json` has no such
//     field), while the summary comment must be read over REST — gh's `comments`
//     JSON carries no `updatedAt`, and the bot EDITS one comment in place, so the
//     freshest body is only findable by sorting on `updated_at`.
//  4. Bot logins differ by API: GraphQL returns `greptile-apps`, REST returns
//     `greptile-apps[bot]`. Matching therefore strips a trailing `[bot]` on BOTH
//     sides. (The predecessor bug: `test("greptile-apps[bot]")` treats `[bot]` as a
//     regex character class, never matches the literal login, and detection
//     silently falls through to `human_or_unknown`.)
//
// Every gh call goes out as an ARGV ARRAY through `runner.runCapture` with the cwd
// pinned to the workroot — no shell string is ever built, so a reply body carrying
// quotes, newlines or a `$(…)` reaches gh as ONE argument and the shell-hardening
// prose the skills used to carry becomes structurally unnecessary.
//
// `node:*` only (ADR-0008), and the handler seam is SYNCHRONOUS (`run.ts`
// dispatches `(context) => CommandResult`), hence the spawnSync-based runner and
// the `Atomics.wait` sleep in the polling loops (the `lifecycle.ts` precedent).

// ---------------------------------------------------------------------------
// THE ADAPTER REGISTRY — data, not code.
//
// The ONE tool-specific surface in the whole review path: adding a review tool is
// ONE entry here and nothing else (the skills' `references/adapters.md` is the
// same table in prose). `botLogins` are BARE slugs — the `[bot]` suffix is
// stripped at comparison time, never stored.
// ---------------------------------------------------------------------------

interface AdapterSpec {
  botLogins: readonly string[];
  // How the tool reports a numeric confidence: `dashboard-only` (Greptile keeps
  // the 0–5 threshold off the check payload) or `none`.
  confidence: string;
  id: string;
  // The mention shape a rationale reply uses so the tool learns not to re-flag.
  intentionalReply: string;
  // The comment body that re-runs the review; null = nothing to trigger.
  reTrigger: string | null;
}

const ADAPTERS: readonly AdapterSpec[] = [
  {
    botLogins: ["greptile-apps", "greptile-apps-staging"],
    confidence: "dashboard-only",
    id: "greptile",
    intentionalReply: "@greptileai <reason>",
    reTrigger: "@greptileai review",
  },
  {
    botLogins: ["coderabbitai"],
    confidence: "none",
    id: "coderabbit",
    intentionalReply: "@coderabbitai <reason>",
    reTrigger: "@coderabbitai review",
  },
];

// The fallback: a human reviewer, or a bot the registry has never heard of. The
// whole fetch → triage → address → resolve loop still applies; only the
// re-trigger is impossible, which is exactly what `reTrigger: null` says.
const HUMAN_ADAPTER: AdapterSpec = {
  botLogins: [],
  confidence: "none",
  id: "human_or_unknown",
  intentionalReply: "@<reviewer> <reason>",
  reTrigger: null,
};

// ---------------------------------------------------------------------------
// The payload vocabulary (flat, explicit nulls — the `EnvSnapshot` convention).
// ---------------------------------------------------------------------------

// One registry entry as the SKILLS see it: the spec minus `botLogins`, plus the
// logins that actually matched on this PR.
interface Adapter {
  confidence: string;
  id: string;
  intentionalReply: string;
  matchedLogins: string[];
  reTrigger: string | null;
}

interface RepoIdentity {
  name: string;
  owner: string;
}

interface PullRequest {
  headRefName: string;
  headRefOid: string;
  number: number;
  url: string;
}

// A comment inside a review thread. `author` is the BARE login string (not a
// nested object) and `databaseId` is the REST id a reply targets via
// `in_reply_to` — the one bridge between the GraphQL and REST halves.
interface ReviewComment {
  author: string;
  body: string;
  databaseId: number | null;
}

interface ReviewThread {
  comments: ReviewComment[];
  id: string;
  isOutdated: boolean;
  line: number | null;
  path: string;
}

// The bot's summary: ONE issue comment it EDITS every cycle (never appends).
interface Summary {
  author: string;
  body: string;
  confidence: number | null;
  updatedAt: string | null;
}

// One `gh pr checks --json name,state,bucket,link` row.
interface CheckRun {
  bucket: string;
  link: string;
  name: string;
  state: string;
}

// Everything one look at the PR yields — shared by `review fetch`, `review apply`
// (which needs the threads for idempotency and the adapter for the re-trigger)
// and `pr watch --await-review` (which polls it until something is posted).
interface ReviewSnapshot {
  adapter: Adapter;
  candidates: Adapter[] | null;
  pr: PullRequest;
  summary: Summary | null;
  threads: ReviewThread[];
}

// A read that can fail with a message worth showing the user. gh failures are
// DATA here (runCapture never throws), so every reader returns one of these and
// the command decides whether it is fatal.
type Reading<T> = { error: string; ok: false } | { ok: true; value: T };

// ---------------------------------------------------------------------------
// gh plumbing
// ---------------------------------------------------------------------------

function gh(args: string[], root: string): RunResult {
  return runCapture("gh", args, { root });
}

function ghFailed(result: RunResult): boolean {
  return result.error !== undefined || result.status !== 0;
}

// gh's own words when it has them (its stderr is written for humans), else the
// spawn error, else the bare exit status — so a failure is never anonymous.
function ghError(action: string, result: RunResult): string {
  const stderr = result.stderr.trim();
  if (stderr !== "") {
    return `${action}: ${stderr}`;
  }
  if (result.error !== undefined) {
    return `${action}: ${result.error.message}`;
  }
  return `${action}: gh exited ${String(result.status)}`;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

// The repository identity — DERIVED, never hardcoded: every REST path below is
// built from it (`gh api` REST placeholders would work, but the GraphQL query
// text takes none, so one resolved identity serves both halves).
function readRepo(root: string): Reading<RepoIdentity> {
  const result = gh(["repo", "view", "--json", "owner,name"], root);
  if (ghFailed(result)) {
    return { error: ghError("gh repo view", result), ok: false };
  }
  const data = parseJson<{ name?: unknown; owner?: { login?: unknown } }>(
    result.stdout
  );
  const owner = asString(data?.owner?.login);
  const name = asString(data?.name);
  if (owner === "" || name === "") {
    return {
      error: "gh repo view: could not read the repository owner and name",
      ok: false,
    };
  }
  return { ok: true, value: { name, owner } };
}

// The PR under review: the explicitly numbered one, else the current branch's.
// gh exits nonzero ("no pull requests found for branch") when there is none —
// `pr watch` turns that into `skipped`, `review fetch|apply` into a hard error.
function readPullRequest(
  root: string,
  prNumber: number | null
): Reading<PullRequest> {
  const args = ["pr", "view"];
  if (prNumber !== null) {
    args.push(String(prNumber));
  }
  args.push("--json", "number,headRefName,headRefOid,url");
  const result = gh(args, root);
  if (ghFailed(result)) {
    return { error: ghError("gh pr view", result), ok: false };
  }
  const data = parseJson<{
    headRefName?: unknown;
    headRefOid?: unknown;
    number?: unknown;
    url?: unknown;
  }>(result.stdout);
  if (typeof data?.number !== "number") {
    return {
      error: "gh pr view: no pull request number in the answer",
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      headRefName: asString(data.headRefName),
      headRefOid: asString(data.headRefOid),
      number: data.number,
      url: asString(data.url),
    },
  };
}

// ---------------------------------------------------------------------------
// The review threads (GraphQL only)
// ---------------------------------------------------------------------------

// The cursor variable is named `$endCursor` because `gh api graphql --paginate`
// requires EXACTLY that name (plus the `pageInfo` selection) to drive pagination
// itself — see incompatibility 1 in the header. `comments(last: 5)` (never
// `first: 1`) is what makes `review apply` idempotent: the prior rationale reply
// sits at the END of a thread, so a first-comment-only selection cannot see it and
// the command would post the same reply on every cycle.
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(last: 5) {
            nodes { databaseId author { login } body }
          }
        }
      }
    }
  }
}`;

// The OPEN review threads, every page of them. `--paginate` walks the pages and
// `--slurp` hands them back as ONE array of page responses (without it the pages
// arrive as concatenated JSON objects that no parser can read as a whole).
//
// `isResolved` is filtered CLIENT-SIDE: the GraphQL API offers no server-side
// filter for it, and asking for resolved threads too is what lets a re-run tell
// "already resolved" from "gone".
function readThreads(
  root: string,
  repo: RepoIdentity,
  number: number
): Reading<ReviewThread[]> {
  const result = gh(
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
      "-F",
      `number=${String(number)}`,
      "-f",
      `query=${THREADS_QUERY}`,
    ],
    root
  );
  if (ghFailed(result)) {
    return {
      error: ghError("gh api graphql (reviewThreads)", result),
      ok: false,
    };
  }
  const parsed = parseJson<unknown>(result.stdout);
  if (parsed === null) {
    return {
      error: "gh api graphql (reviewThreads): the answer was not JSON",
      ok: false,
    };
  }
  // `--slurp` yields an array of page responses; a single un-slurped response is
  // accepted too so the reader never depends on how gh chose to frame one page.
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const threads = pages
    .flatMap((page) => threadNodesOf(page))
    .map((node) => toThread(node))
    .filter(isPresent);
  return { ok: true, value: threads };
}

interface ThreadsPage {
  data?: {
    repository?: {
      pullRequest?: { reviewThreads?: { nodes?: unknown[] } } | null;
    } | null;
  };
}

function threadNodesOf(page: unknown): unknown[] {
  const nodes = (page as ThreadsPage).data?.repository?.pullRequest
    ?.reviewThreads?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

// One `reviewThreads` node, or null when it is resolved (the client-side filter)
// or carries no id at all.
function toThread(node: unknown): ReviewThread | null {
  const raw = node as {
    comments?: { nodes?: unknown[] } | null;
    id?: unknown;
    isOutdated?: unknown;
    isResolved?: unknown;
    line?: unknown;
    path?: unknown;
  };
  if (typeof raw.id !== "string" || raw.isResolved === true) {
    return null;
  }
  const nodes = raw.comments?.nodes;
  return {
    comments: (Array.isArray(nodes) ? nodes : []).map((comment) =>
      toReviewComment(comment)
    ),
    id: raw.id,
    isOutdated: raw.isOutdated === true,
    // A thread on a file-level comment (or on code GitHub can no longer place)
    // reports no line at all — null, never a fabricated 0.
    line: typeof raw.line === "number" ? raw.line : null,
    path: asString(raw.path),
  };
}

// The author is FLATTENED to its bare login string (the same shape
// `adapter.matchedLogins` uses); a deleted account has no author at all, which
// reads as an empty login rather than a crash.
function toReviewComment(node: unknown): ReviewComment {
  const raw = node as {
    author?: { login?: unknown } | null;
    body?: unknown;
    databaseId?: unknown;
  };
  return {
    author: asString(raw.author?.login),
    body: asString(raw.body),
    databaseId: typeof raw.databaseId === "number" ? raw.databaseId : null,
  };
}

// ---------------------------------------------------------------------------
// The summary comment (REST — see incompatibility 3)
// ---------------------------------------------------------------------------

interface IssueComment {
  author: string;
  body: string;
  updatedAt: string;
}

const PER_PAGE = 100;

// Every issue comment on the PR. REST (not `gh pr view --json comments`) because
// the bot EDITS one comment in place and gh's comments JSON carries no
// `updatedAt` — without it the freshest summary body is unfindable.
function readIssueComments(
  root: string,
  repo: RepoIdentity,
  number: number
): Reading<IssueComment[]> {
  const path = `repos/${repo.owner}/${repo.name}/issues/${String(number)}/comments?per_page=${String(PER_PAGE)}`;
  const result = gh(["api", "--paginate", "--slurp", path], root);
  if (ghFailed(result)) {
    return { error: ghError(`gh api ${path}`, result), ok: false };
  }
  const parsed = parseJson<unknown>(result.stdout);
  // `--slurp` wraps each PAGE's array, so the answer is an array of arrays; a
  // single flat page array flattens to itself, which keeps the reader honest
  // whichever framing gh used.
  const pages: unknown[] = Array.isArray(parsed) ? parsed : [];
  const comments = pages
    .flat()
    .map((item) => toIssueComment(item))
    .filter(isPresent);
  return { ok: true, value: comments };
}

function toIssueComment(node: unknown): IssueComment | null {
  const raw = node as {
    body?: unknown;
    updated_at?: unknown;
    user?: { login?: unknown } | null;
  };
  const author = asString(raw.user?.login);
  if (author === "") {
    return null;
  }
  return {
    author,
    body: asString(raw.body),
    updatedAt: asString(raw.updated_at),
  };
}

// A confidence score anywhere in the summary body — deliberately LOOSE (`4/5`,
// `Confidence: 4/5`, `**Confidence score: 4/5**` all read the same), because the
// header wording is dashboard-configurable and no format is guaranteed.
const CONFIDENCE_RE = /(\d)\s*\/\s*5/;

// The FRESHEST summary the detected tool posted: bot-authored comments only
// (matched on the bare slug, which substring-matches the REST `…[bot]` login),
// sorted by `updated_at`, last one wins. Null when the tool posted none — which
// is what `pr watch --await-review` reads as "the review has not landed yet".
function pickSummary(
  comments: IssueComment[],
  adapter: Adapter
): Summary | null {
  if (adapter.matchedLogins.length === 0) {
    return null;
  }
  const mine = comments.filter((comment) =>
    adapter.matchedLogins.some((slug) =>
      comment.author.toLowerCase().includes(slug)
    )
  );
  const newest = [...mine]
    .sort((a, b) => timeOf(a.updatedAt) - timeOf(b.updatedAt))
    .at(-1);
  if (newest === undefined) {
    return null;
  }
  const score = CONFIDENCE_RE.exec(newest.body)?.[1];
  return {
    author: newest.author,
    body: newest.body,
    confidence: score === undefined ? null : Number(score),
    updatedAt: newest.updatedAt === "" ? null : newest.updatedAt,
  };
}

// An unparseable timestamp sorts oldest rather than poisoning the comparison
// with NaN (which would make the sort order implementation-defined).
function timeOf(stamp: string): number {
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ---------------------------------------------------------------------------
// Adapter detection
// ---------------------------------------------------------------------------

const BOT_SUFFIX_RE = /\[bot\]$/i;

// The normalization that makes the two APIs comparable: GraphQL says
// `coderabbitai`, REST says `coderabbitai[bot]`. Stripping the suffix on BOTH
// sides is why this is a plain string operation and never a regex `test()` — see
// incompatibility 4.
function bareLogin(login: string): string {
  return login.replace(BOT_SUFFIX_RE, "").toLowerCase();
}

// Every registry entry whose logins appear among `logins`, in registry order.
// `matchedLogins` carries the registry's CANONICAL bare slugs (not the observed
// spellings), so the summary filter and the payload speak one vocabulary.
function matchAdapters(logins: string[]): Adapter[] {
  const seen = new Set(logins.map((login) => bareLogin(login)));
  const matched: Adapter[] = [];
  for (const spec of ADAPTERS) {
    const hits = spec.botLogins.filter((login) => seen.has(bareLogin(login)));
    if (hits.length > 0) {
      matched.push(toAdapter(spec, hits));
    }
  }
  return matched;
}

function toAdapter(
  spec: AdapterSpec,
  matchedLogins: readonly string[]
): Adapter {
  return {
    confidence: spec.confidence,
    id: spec.id,
    intentionalReply: spec.intentionalReply,
    matchedLogins: [...matchedLogins],
    reTrigger: spec.reTrigger,
  };
}

// Which tool reviewed this PR. The OPEN-THREAD authors are the primary signal (a
// tool that left findings is unambiguously the tool in play). Only when they name
// nobody does the ISSUE-COMMENT authors act as a fallback — a CLEAN review posts a
// summary and NO threads, and without that fallback `pr watch --await-review`
// could never tell "the tool ran and found nothing" (merge-ready) from "the tool
// never ran" (open-unreviewed). The order matters: with both signals available the
// threads win, so a PR whose summary came from tool A and whose findings came from
// tool B is answered with B, the tool the stage has work from.
function detectAdapters(
  threads: ReviewThread[],
  comments: IssueComment[]
): Adapter[] {
  const threadAuthors = threads.flatMap((thread) =>
    thread.comments.map((comment) => comment.author)
  );
  const fromThreads = matchAdapters(threadAuthors);
  if (fromThreads.length > 0) {
    return fromThreads;
  }
  return matchAdapters(comments.map((comment) => comment.author));
}

// ---------------------------------------------------------------------------
// One look at the PR
// ---------------------------------------------------------------------------

function collectReview(
  root: string,
  repo: RepoIdentity,
  pr: PullRequest
): Reading<ReviewSnapshot> {
  const threads = readThreads(root, repo, pr.number);
  if (!threads.ok) {
    return threads;
  }
  // A failed thread read is NEVER degraded to an empty list: "no open threads" is
  // the stage's green light, so inventing it out of a broken gh call would tell
  // the kit to merge work nobody reviewed.
  const comments = readIssueComments(root, repo, pr.number);
  if (!comments.ok) {
    return comments;
  }
  const matched = detectAdapters(threads.value, comments.value);
  const [first] = matched;
  const adapter = first ?? toAdapter(HUMAN_ADAPTER, []);
  return {
    ok: true,
    value: {
      adapter,
      // Several tools reviewed the same PR: the stage asks which to run. Null (not
      // absent) when there is nothing to choose between — the payload's shape never
      // depends on the answer.
      candidates: matched.length > 1 ? matched : null,
      pr,
      summary: pickSummary(comments.value, adapter),
      threads: threads.value,
    },
  };
}

// ---------------------------------------------------------------------------
// `dobby review fetch|apply`
// ---------------------------------------------------------------------------

/**
 * `dobby review fetch|apply` — the read and the write half of the address-review
 * mechanics. The subcommand token is already validated by the registry in
 * `run.ts`, so `fetch` is the only alternative to `apply`.
 *
 * @public — the domain entry point dispatched from `run.ts`.
 */
export function runReview(context: CommandContext): CommandResult {
  try {
    const root = requireWorkroot(context.cwd);
    const [subcommand] = context.positionals;
    return subcommand === "apply"
      ? applyReview(context, root)
      : fetchReview(context, root);
  } catch (error) {
    // `requireWorkroot` throws outside a git repo and `readFileSync` can throw on
    // an unreadable plan. `run()` does not catch handler exceptions, so a raw
    // stack would reach the user; fold both into the CLI's ordinary hard error.
    return { error: `${context.command}: ${messageOf(error)}`, exitCode: 1 };
  }
}

function fetchReview(context: CommandContext, root: string): CommandResult {
  const label = "review fetch";
  const prNumber = readPrOption(context);
  if (!prNumber.ok) {
    return failure(label, prNumber.error);
  }
  const pr = readPullRequest(root, prNumber.value);
  if (!pr.ok) {
    return failure(label, pr.error);
  }
  const repo = readRepo(root);
  if (!repo.ok) {
    return failure(label, repo.error);
  }
  const snapshot = collectReview(root, repo.value, pr.value);
  if (!snapshot.ok) {
    return failure(label, snapshot.error);
  }
  // A PR with nothing left to address is an ANSWER, not an error: `threads: []`
  // and exit 0, which is what lets the stage report "clean" without branching on
  // an error path. The SNAPSHOT is the payload — one look at the PR yields exactly
  // the five fields `review fetch` reports, so it is emitted as-is.
  const payload = snapshot.value;
  return context.options.json === true
    ? { exitCode: 0, json: payload }
    : { exitCode: 0, text: formatFetch(payload) };
}

// ---------------------------------------------------------------------------
// The disposition plan
// ---------------------------------------------------------------------------

type Disposition = "defer" | "dismiss" | "fix" | "outdated";

// The dispositions that RESOLVE their thread. `defer` is absent ON PURPOSE: a
// deferred finding stays open (that is what deferring means) and is closed out
// with a rationale reply instead.
const RESOLVING_DISPOSITIONS: ReadonlySet<string> = new Set([
  "dismiss",
  "fix",
  "outdated",
]);

const DISPOSITIONS: ReadonlySet<string> = new Set([
  "defer",
  "dismiss",
  "fix",
  "outdated",
]);

interface PlanEntry {
  disposition: Disposition;
  reply: string | null;
  threadId: string;
}

interface ApplyPlan {
  plan: PlanEntry[];
  pr: number | null;
  reTrigger: boolean;
}

interface ApplyFailure {
  action: "reply" | "resolve" | "retrigger";
  error: string;
  threadId: string | null;
}

interface ApplyOutcome {
  failures: ApplyFailure[];
  replied: string[];
  resolved: string[];
  retriggered: boolean;
  skipped: string[];
}

// What every write needs: where to run, who to talk to, and whether this is a
// rehearsal (`--dry-run` — the CLI-wide plan-then-execute preview: the same
// decisions, zero side effects).
interface ExecContext {
  adapter: Adapter;
  dryRun: boolean;
  number: number;
  repo: RepoIdentity;
  root: string;
}

function applyReview(context: CommandContext, root: string): CommandResult {
  const label = "review apply";
  const plan = readPlan(context);
  if (!plan.ok) {
    return failure(label, plan.error);
  }
  const prOption = readPrOption(context);
  if (!prOption.ok) {
    return failure(label, prOption.error);
  }
  // The plan names its own PR (it was produced against one); `--pr` and the
  // current branch are the fallbacks, in that order.
  const pr = readPullRequest(root, plan.value.pr ?? prOption.value);
  if (!pr.ok) {
    return failure(label, pr.error);
  }
  const repo = readRepo(root);
  if (!repo.ok) {
    return failure(label, repo.error);
  }
  const snapshot = collectReview(root, repo.value, pr.value);
  if (!snapshot.ok) {
    return failure(label, snapshot.error);
  }
  const dryRun = context.options["dry-run"] === true;
  const outcome = executePlan(
    {
      adapter: snapshot.value.adapter,
      dryRun,
      number: pr.value.number,
      repo: repo.value,
      root,
    },
    snapshot.value.threads,
    plan.value
  );
  const payload = { ...outcome, dryRun };
  // A write that did not land is a hard error even though the payload is
  // complete: the exit code is what stops a skill from reading a partial apply as
  // a finished one (the `up --json` convention — nonzero AND the full payload).
  const failed = outcome.failures.length;
  const asJson = context.options.json === true;
  return {
    error:
      failed === 0 ? undefined : `${label}: ${String(failed)} action(s) failed`,
    exitCode: failed === 0 ? 0 : 1,
    json: asJson ? payload : undefined,
    text: asJson ? undefined : formatApply(payload),
  };
}

// Walk the plan: reply where a rationale was written, collect what may be
// resolved, then resolve it in ONE batched mutation and re-trigger if asked.
function executePlan(
  ctx: ExecContext,
  threads: ReviewThread[],
  plan: ApplyPlan
): ApplyOutcome {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const outcome: ApplyOutcome = {
    failures: [],
    replied: [],
    resolved: [],
    retriggered: false,
    skipped: [],
  };
  const toResolve: string[] = [];

  for (const entry of plan.plan) {
    const thread = byId.get(entry.threadId);
    // Not among the OPEN threads: already resolved (a re-run of the same plan) or
    // gone. Skipping is what makes `review apply` re-runnable — the second run of
    // a plan is a no-op instead of a wall of gh errors.
    if (thread === undefined) {
      outcome.skipped.push(entry.threadId);
      continue;
    }
    if (
      deliverReply(ctx, entry, thread, outcome) &&
      RESOLVING_DISPOSITIONS.has(entry.disposition)
    ) {
      toResolve.push(thread.id);
    }
  }

  resolveBatch(ctx, toResolve, outcome);
  retrigger(ctx, plan, outcome);
  return outcome;
}

// Post the entry's rationale reply (when it has one), returning whether the
// thread may now be resolved. A reply that FAILED blocks the resolve: closing the
// thread would bury the finding with no answer on it — the one case where a
// partial failure must not cascade into a silent dismissal.
function deliverReply(
  ctx: ExecContext,
  entry: PlanEntry,
  thread: ReviewThread,
  outcome: ApplyOutcome
): boolean {
  if (entry.reply === null) {
    return true;
  }
  // IDEMPOTENCY: the same reply is never posted twice. This is why the fetch asks
  // for `comments(last: 5)` — the prior reply sits at the end of the thread.
  if (alreadyReplied(thread, entry.reply)) {
    outcome.skipped.push(thread.id);
    return true;
  }
  if (ctx.dryRun) {
    outcome.replied.push(thread.id);
    return true;
  }
  const posted = postReply(ctx, thread, entry.reply);
  if (posted.ok) {
    outcome.replied.push(thread.id);
    return true;
  }
  outcome.failures.push({
    action: "reply",
    error: posted.error,
    threadId: thread.id,
  });
  return false;
}

const WHITESPACE_RE = /\s+/g;

// Whether this thread already carries the planned reply. Compared on
// whitespace-normalized CONTAINMENT so a reply GitHub re-wrapped, or one quoted
// inside a longer follow-up, still counts as said — the failure mode worth
// avoiding is the duplicate post, not the missed one.
function alreadyReplied(thread: ReviewThread, reply: string): boolean {
  const needle = normalizeText(reply);
  if (needle === "") {
    return false;
  }
  return thread.comments.some((comment) =>
    normalizeText(comment.body).includes(needle)
  );
}

function normalizeText(text: string): string {
  return text.replace(WHITESPACE_RE, " ").trim();
}

// REST, replying to the thread's FIRST comment by its `databaseId` (GraphQL has
// no reply mutation for review threads). `-f body=…` / `-F in_reply_to=…` are two
// argv elements, so the body reaches gh verbatim however it is punctuated.
function postReply(
  ctx: ExecContext,
  thread: ReviewThread,
  reply: string
): { error: string; ok: false } | { ok: true } {
  const target = thread.comments.find(
    (comment) => comment.databaseId !== null
  )?.databaseId;
  if (target === undefined || target === null) {
    return {
      error: "the thread carries no comment id to reply to",
      ok: false,
    };
  }
  const result = gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${ctx.repo.owner}/${ctx.repo.name}/pulls/${String(ctx.number)}/comments`,
      "-f",
      `body=${reply}`,
      "-F",
      `in_reply_to=${String(target)}`,
    ],
    ctx.root
  );
  return ghFailed(result)
    ? { error: ghError("gh api (reply)", result), ok: false }
    : { ok: true };
}

// ONE mutation for the whole resolve set, threads carried as GraphQL ALIASES
// (`t1:`, `t2:`, …) — n round trips collapse into one, and a partial failure is
// reported as one failure per thread rather than guessed at. Ids are embedded
// through `JSON.stringify`, whose escaping IS GraphQL's for the ASCII node ids
// GitHub mints.
function resolveBatch(
  ctx: ExecContext,
  threadIds: string[],
  outcome: ApplyOutcome
): void {
  if (threadIds.length === 0) {
    return;
  }
  if (ctx.dryRun) {
    outcome.resolved.push(...threadIds);
    return;
  }
  const fields = threadIds
    .map(
      (id, index) =>
        `  t${String(index + 1)}: resolveReviewThread(input: {threadId: ${JSON.stringify(id)}}) { thread { isResolved } }`
    )
    .join("\n");
  const result = gh(
    ["api", "graphql", "-f", `query=mutation {\n${fields}\n}`],
    ctx.root
  );
  const error = mutationError(result);
  if (error === null) {
    outcome.resolved.push(...threadIds);
    return;
  }
  for (const id of threadIds) {
    outcome.failures.push({ action: "resolve", error, threadId: id });
  }
}

// A GraphQL mutation can fail TWICE over: at the transport (nonzero exit) and
// inside a 200 response carrying an `errors` array. Both are failures here.
function mutationError(result: RunResult): string | null {
  if (ghFailed(result)) {
    return ghError("gh api graphql (resolveReviewThread)", result);
  }
  const data = parseJson<{ errors?: { message?: unknown }[] }>(result.stdout);
  const [first] = data?.errors ?? [];
  if (first === undefined) {
    return null;
  }
  return `gh api graphql (resolveReviewThread): ${asString(first.message)}`;
}

// The re-trigger: one issue comment carrying the adapter's trigger phrase. A
// human reviewer has none (`reTrigger: null`) — there is nothing to re-run, so
// the plan asking for it is honored by doing nothing, never by an error.
function retrigger(
  ctx: ExecContext,
  plan: ApplyPlan,
  outcome: ApplyOutcome
): void {
  const phrase = ctx.adapter.reTrigger;
  if (!plan.reTrigger || phrase === null) {
    return;
  }
  if (ctx.dryRun) {
    outcome.retriggered = true;
    return;
  }
  const result = gh(
    ["pr", "comment", String(ctx.number), "--body", phrase],
    ctx.root
  );
  if (ghFailed(result)) {
    outcome.failures.push({
      action: "retrigger",
      error: ghError("gh pr comment", result),
      threadId: null,
    });
    return;
  }
  outcome.retriggered = true;
}

// The plan document: `--plan <file>` (resolved against the CALLER's cwd, so a
// relative path means what the caller typed) or `--stdin`. Every shape error is
// reported BEFORE anything is written — a half-applied plan is the one outcome
// worth engineering against.
function readPlan(context: CommandContext): Reading<ApplyPlan> {
  const raw = readPlanText(context);
  if (!raw.ok) {
    return raw;
  }
  const data = parseJson<{ plan?: unknown; pr?: unknown; reTrigger?: unknown }>(
    raw.value
  );
  if (data === null) {
    return { error: "the disposition plan is not valid JSON", ok: false };
  }
  if (!Array.isArray(data.plan)) {
    return {
      error:
        "the disposition plan needs a `plan` array of {threadId, disposition, reply?}",
      ok: false,
    };
  }
  const entries: PlanEntry[] = [];
  for (const item of data.plan) {
    const entry = toPlanEntry(item);
    if (!entry.ok) {
      return entry;
    }
    entries.push(entry.value);
  }
  return {
    ok: true,
    value: {
      plan: entries,
      pr: typeof data.pr === "number" ? data.pr : null,
      reTrigger: data.reTrigger === true,
    },
  };
}

function toPlanEntry(item: unknown): Reading<PlanEntry> {
  const raw = item as {
    disposition?: unknown;
    reply?: unknown;
    threadId?: unknown;
  };
  if (typeof raw.threadId !== "string" || raw.threadId === "") {
    return {
      error: "every plan entry needs a `threadId` (the PRRT_… thread node id)",
      ok: false,
    };
  }
  if (!isDisposition(raw.disposition)) {
    return {
      error: `unknown disposition \`${String(raw.disposition)}\` for ${raw.threadId} — expected one of: defer, dismiss, fix, outdated`,
      ok: false,
    };
  }
  const reply =
    typeof raw.reply === "string" && raw.reply.trim() !== "" ? raw.reply : null;
  return {
    ok: true,
    value: { disposition: raw.disposition, reply, threadId: raw.threadId },
  };
}

function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && DISPOSITIONS.has(value);
}

function readPlanText(context: CommandContext): Reading<string> {
  const file = stringOption(context, "plan");
  if (file !== undefined) {
    const path = resolve(context.cwd, file);
    if (!existsSync(path)) {
      return { error: `--plan not found: ${path}`, ok: false };
    }
    return { ok: true, value: readFileSync(path, "utf8") };
  }
  if (context.options.stdin === true) {
    const piped = context.stdin ?? "";
    return piped.trim() === ""
      ? {
          error:
            "--stdin carried no plan — pipe the disposition plan in (`… | dobby review apply --stdin`)",
          ok: false,
        }
      : { ok: true, value: piped };
  }
  return {
    error: "no disposition plan — pass --plan <file> or --stdin",
    ok: false,
  };
}

// ---------------------------------------------------------------------------
// `dobby pr watch`
// ---------------------------------------------------------------------------

// The seven answers `pr watch` can give. Five are the spec's; `ci-green` is the
// spec's own terminal CI state named in prose; `ci-pending` is the ONE addition —
// the CI wait's timeout answer (see the deviation note in the module header).
// A verdict is always an OBSERVATION: a gh call that could not be made is NOT a
// verdict, it is a hard error (nothing was observed, so nothing may be reported).
type Verdict =
  | "ci-failed"
  | "ci-green"
  | "ci-pending"
  | "feedback-present"
  | "merge-ready"
  | "open-unreviewed"
  | "skipped";

interface FailingCheck {
  link: string;
  name: string;
}

interface WatchPayload {
  awaitedReview: boolean;
  checks: CheckRun[];
  deadlineSec: number;
  failing: FailingCheck[];
  openThreads: number | null;
  pr: PullRequest | null;
  reason: string | null;
  summary: Summary | null;
  verdict: Verdict;
}

// The buckets that are NEVER a green light. `fail` is the spec's rule; `cancel`
// joins it because a cancelled required check blocks the merge exactly like a
// failed one — reporting it as green would hand the finish gate a false pass.
const FAILING_BUCKETS: ReadonlySet<string> = new Set(["cancel", "fail"]);
const PENDING_BUCKET = "pending";

const DEFAULT_DEADLINE_SEC = 300;
const POLL_INTERVAL_MS = 10_000;
const MS_PER_SEC = 1000;

// The documented TEST SEAM for both polling loops (the sibling of
// `DOBBY_LIVENESS_RETRIES`): `DOBBY_POLL_INTERVAL_MS=<n>` caps the wait between
// polls so a test exercises the loop without sitting through ~10s sleeps.
// Test-only; never set in production. 0 is a VALID value (poll as fast as gh
// answers), which is why the guard is `>= 0` and not `> 0`.
const POLL_INTERVAL_ENV = "DOBBY_POLL_INTERVAL_MS";

function pollIntervalMs(): number {
  const raw = process.env[POLL_INTERVAL_ENV];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : POLL_INTERVAL_MS;
}

// A synchronous sleep (no busy-wait): block the thread on an Atomics wait against
// a private buffer nobody notifies — the handler seam is synchronous, so this is
// the same mechanism `lifecycle.ts` uses for its liveness wait.
function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `dobby pr watch` — wait for CI (and optionally for the review) and answer with
 * ONE verdict. There is NO merge path in this module, structurally: the kit never
 * merges, it reports whether merging is defensible.
 *
 * @public — the domain entry point dispatched from `run.ts`.
 */
export function runPr(context: CommandContext): CommandResult {
  try {
    return watchPr(context, requireWorkroot(context.cwd));
  } catch (error) {
    return { error: `${context.command}: ${messageOf(error)}`, exitCode: 1 };
  }
}

function watchPr(context: CommandContext, root: string): CommandResult {
  const label = "pr watch";
  const prOption = readPrOption(context);
  if (!prOption.ok) {
    return failure(label, prOption.error);
  }
  const deadlineSec = readDeadline(context);
  if (!deadlineSec.ok) {
    return failure(label, deadlineSec.error);
  }
  const awaitedReview = context.options["await-review"] === true;
  const base: WatchPayload = {
    awaitedReview,
    checks: [],
    deadlineSec: deadlineSec.value,
    failing: [],
    openThreads: null,
    pr: null,
    reason: null,
    summary: null,
    verdict: "skipped",
  };

  const pr = readPullRequest(root, prOption.value);
  // On main, or on a branch nobody opened a PR for, there is simply nothing to
  // watch: `skipped` and exit 0 — the kit's graceful-no-op convention (`up`'s "no
  // app to run"), never an error the caller has to special-case.
  if (!pr.ok) {
    return render(context, { ...base, reason: pr.error });
  }

  // The budget is PER PHASE, each phase starting its own clock: a single ceiling
  // shared with the CI wait is what would let a ~300s CI run eat the whole
  // `--deadline 300` and leave the review poll one attempt (see the module
  // header). A gh call that FAILED is never turned into a verdict here — the read
  // errors out and `pr watch` fails with it.
  const budgetMs = deadlineSec.value * MS_PER_SEC;
  const ci = watchChecks(root, pr.value.number, Date.now() + budgetMs);
  if (!ci.ok) {
    return failure(label, ci.error);
  }
  const afterCi: WatchPayload = {
    ...base,
    checks: ci.value.checks,
    failing: ci.value.failing,
    pr: pr.value,
    verdict: ci.value.verdict,
  };
  // A red (or still-running) build is TERMINAL: waiting for a review of code that
  // does not build wastes the deadline and the reviewer's cycle.
  if (!awaitedReview || ci.value.verdict !== "ci-green") {
    return render(context, afterCi);
  }

  const repo = readRepo(root);
  if (!repo.ok) {
    return failure(label, repo.error);
  }
  const review = watchReview(root, repo.value, pr.value, Date.now() + budgetMs);
  if (!review.ok) {
    return failure(label, review.error);
  }
  return render(context, { ...afterCi, ...review.value });
}

interface CiOutcome {
  checks: CheckRun[];
  failing: FailingCheck[];
  verdict: Verdict;
}

// Poll `gh pr checks --json` until the checks are terminal or the budget passes.
// The verdict comes ONLY from bucket counts: gh's `--json` mode always exits 0
// for the CHECKS' own state (incompatibility 2), so an exit code here says
// nothing about CI — but a read that FAILED is propagated, never polled past.
function watchChecks(
  root: string,
  number: number,
  deadlineAt: number
): Reading<CiOutcome> {
  const interval = pollIntervalMs();
  for (;;) {
    const reading = readChecks(root, number);
    if (!reading.ok) {
      return reading;
    }
    const checks = reading.value;
    const failing = checks
      .filter((check) => FAILING_BUCKETS.has(check.bucket))
      .map((check) => ({ link: check.link, name: check.name }));
    if (failing.length > 0) {
      return { ok: true, value: { checks, failing, verdict: "ci-failed" } };
    }
    if (!checks.some((check) => check.bucket === PENDING_BUCKET)) {
      // No pending bucket left — including the no-checks-at-all case, where there
      // is nothing to wait for.
      return {
        ok: true,
        value: { checks, failing: [], verdict: "ci-green" },
      };
    }
    if (Date.now() >= deadlineAt) {
      // Still running when the clock ran out. Not green (nothing was proven) and
      // not failed (nothing broke) — the caller decides whether to wait again.
      return {
        ok: true,
        value: { checks, failing: [], verdict: "ci-pending" },
      };
    }
    sleepSync(interval);
  }
}

// gh's ONE legitimate nonzero in `--json` mode: a PR whose branch has no checks
// at all ("no checks reported on the 'x' branch"). Everything else nonzero — an
// expired token, a rate limit, a network error — is gh saying it could not look.
const NO_CHECKS_RE = /no checks reported/i;

// One `gh pr checks` poll. A nonzero exit is NOT a CI failure, but it is not a
// green light either: only the no-checks-at-all message reads as an empty (and
// therefore green) check list; every other failure is surfaced, because inventing
// "no checks" out of a broken gh would hand the finish gate a false pass —
// exactly the reasoning `collectReview` applies to a failed thread read.
function readChecks(root: string, number: number): Reading<CheckRun[]> {
  const result = gh(
    ["pr", "checks", String(number), "--json", "name,state,bucket,link"],
    root
  );
  if (ghFailed(result)) {
    return NO_CHECKS_RE.test(result.stderr)
      ? { ok: true, value: [] }
      : { error: ghError("gh pr checks", result), ok: false };
  }
  const parsed = parseJson<unknown>(result.stdout);
  if (!Array.isArray(parsed)) {
    return {
      error: "gh pr checks: the answer was not a JSON list of checks",
      ok: false,
    };
  }
  return { ok: true, value: parsed.map((item) => toCheckRun(item)) };
}

function toCheckRun(node: unknown): CheckRun {
  const raw = node as {
    bucket?: unknown;
    link?: unknown;
    name?: unknown;
    state?: unknown;
  };
  return {
    bucket: asString(raw.bucket),
    link: asString(raw.link),
    name: asString(raw.name),
    state: asString(raw.state),
  };
}

// Poll the review itself until the tool posts SOMETHING (a summary, or open
// threads) or the deadline passes. Open threads outrank a clean summary: the
// summary lags the threads, so feedback on the table wins.
function watchReview(
  root: string,
  repo: RepoIdentity,
  pr: PullRequest,
  deadlineAt: number
): Reading<Pick<WatchPayload, "openThreads" | "summary" | "verdict">> {
  const interval = pollIntervalMs();
  for (;;) {
    const snapshot = collectReview(root, repo, pr);
    if (!snapshot.ok) {
      return snapshot;
    }
    const { summary, threads } = snapshot.value;
    if (threads.length > 0) {
      return {
        ok: true,
        value: {
          openThreads: threads.length,
          summary,
          verdict: "feedback-present",
        },
      };
    }
    if (summary !== null) {
      return {
        ok: true,
        value: { openThreads: 0, summary, verdict: "merge-ready" },
      };
    }
    if (Date.now() >= deadlineAt) {
      // Nobody reviewed it in time. The PR is fine — it is just UNREVIEWED, which
      // is a different answer from "reviewed and clean" and must never read as one.
      return {
        ok: true,
        value: { openThreads: 0, summary: null, verdict: "open-unreviewed" },
      };
    }
    sleepSync(interval);
  }
}

function render(context: CommandContext, payload: WatchPayload): CommandResult {
  // Every verdict is a successful OBSERVATION, so `pr watch` reports an outcome
  // and never inherits one: the verdict is the answer, exit 0 (the `repro`
  // precedent — the harness judges, the caller reads). A gh call that could not be
  // made never reaches here: it exits nonzero with the error, so "green" is only
  // ever printed about checks that were actually read.
  return context.options.json === true
    ? { exitCode: 0, json: payload }
    : { exitCode: 0, text: formatWatch(payload) };
}

// ---------------------------------------------------------------------------
// Shared option plumbing
// ---------------------------------------------------------------------------

const INTEGER_RE = /^\d+$/;

function stringOption(
  context: CommandContext,
  name: string
): string | undefined {
  const value = context.options[name];
  return typeof value === "string" ? value : undefined;
}

// `--pr N` — validated HERE so a typo is a dobby error naming the flag, never an
// opaque gh one about an argument dobby chose to pass on.
function readPrOption(context: CommandContext): Reading<number | null> {
  const raw = stringOption(context, "pr");
  if (raw === undefined) {
    return { ok: true, value: null };
  }
  if (!INTEGER_RE.test(raw) || Number(raw) < 1) {
    return {
      error: `--pr must be a pull request number (got \`${raw}\`)`,
      ok: false,
    };
  }
  return { ok: true, value: Number(raw) };
}

// `--deadline <seconds>` — the budget for EACH wait phase (the CI wait, then the
// review wait), defaulting to 300s; the phases do NOT share one clock (module
// header). 0 is valid: it means "one poll, then answer".
function readDeadline(context: CommandContext): Reading<number> {
  const raw = stringOption(context, "deadline");
  if (raw === undefined) {
    return { ok: true, value: DEFAULT_DEADLINE_SEC };
  }
  if (!INTEGER_RE.test(raw)) {
    return {
      error: `--deadline must be a number of seconds (got \`${raw}\`)`,
      ok: false,
    };
  }
  return { ok: true, value: Number(raw) };
}

function failure(label: string, error: string): CommandResult {
  return { error: `${label}: ${error}`, exitCode: 1 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The human renders (the `--json` payload is the machine surface; these are the
// fallback a person reads in a terminal)
// ---------------------------------------------------------------------------

const PREVIEW_CHARS = 96;

function formatFetch(payload: ReviewSnapshot): string {
  const { adapter, candidates, pr, summary, threads } = payload;
  const lines = [
    `pr:        #${String(pr.number)} ${pr.headRefName} (${pr.url})`,
    `adapter:   ${adapter.id}${adapter.matchedLogins.length === 0 ? "" : ` (${adapter.matchedLogins.join(", ")})`}`,
  ];
  if (candidates !== null) {
    lines.push(
      `candidates: ${candidates.map((candidate) => candidate.id).join(", ")}`
    );
  }
  lines.push(
    `summary:   ${summary === null ? "none" : `${summary.author}${summary.confidence === null ? "" : ` — confidence ${String(summary.confidence)}/5`}`}`,
    `threads:   ${String(threads.length)} open`
  );
  for (const thread of threads) {
    lines.push(
      `  ${thread.id}  ${thread.path}:${thread.line === null ? "?" : String(thread.line)}${thread.isOutdated ? " (outdated)" : ""}`,
      `    ${preview(thread.comments[0]?.body ?? "")}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatApply(payload: ApplyOutcome & { dryRun: boolean }): string {
  const lines = [
    payload.dryRun ? "dry run — nothing was written" : "applied",
    `resolved:    ${list(payload.resolved)}`,
    `replied:     ${list(payload.replied)}`,
    `skipped:     ${list(payload.skipped)}`,
    `retriggered: ${payload.retriggered ? "yes" : "no"}`,
  ];
  for (const item of payload.failures) {
    lines.push(
      `failed (${item.action}): ${item.threadId ?? "-"} — ${item.error}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatWatch(payload: WatchPayload): string {
  const lines = [`verdict:  ${payload.verdict}`];
  if (payload.pr !== null) {
    lines.push(`pr:       #${String(payload.pr.number)} ${payload.pr.url}`);
  }
  if (payload.reason !== null) {
    lines.push(`reason:   ${payload.reason}`);
  }
  for (const check of payload.failing) {
    lines.push(`failing:  ${check.name} ${check.link}`);
  }
  if (payload.openThreads !== null) {
    lines.push(`threads:  ${String(payload.openThreads)} open`);
  }
  if (payload.summary !== null) {
    lines.push(
      `summary:  ${payload.summary.author}${payload.summary.confidence === null ? "" : ` — confidence ${String(payload.summary.confidence)}/5`}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function list(ids: string[]): string {
  return ids.length === 0 ? "-" : `${String(ids.length)} (${ids.join(", ")})`;
}

// One line of a comment body, capped — the render is a map of the review, not a
// copy of it (`--json` carries every byte).
function preview(body: string): string {
  const line = normalizeText(body);
  return line.length <= PREVIEW_CHARS
    ? line
    : `${line.slice(0, PREVIEW_CHARS)}…`;
}
