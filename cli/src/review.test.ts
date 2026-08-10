import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  mkStubBin,
  mkStubBinDir,
  mkStubBins,
  readStubLog,
  restoreEnv,
  type StubResponse,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// THE REVIEW DOMAIN — `dobby review fetch|apply` + `dobby pr watch`.
//
// Everything the address-review stage reads and writes through `gh`, mechanized:
// the PR + adapter + open review threads + the bot summary (`review fetch`), the
// disposition plan (`review apply`), and the CI/review wait (`pr watch`). The
// JUDGMENT — is this finding valid, what is the fix brief, may we merge — stays
// in the skills; these commands only move DATA.
//
// The seam is the in-process `run(argv, cwd) -> {exitCode, stdout, stderr}`
// contract (ADR-0008): `review.ts` is never imported directly, so the module can
// be restructured freely as long as the COMMANDS behave. The ONE mocked boundary
// is `gh` (a network API that cannot run for real in CI), stubbed as an
// executable on PATH — the repo's established stub-bin seam. `git` stays REAL.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (all INDEPENDENT of the code):
//  - The adapter registry values (`greptile` / `@greptileai review` /
//    `@greptileai <reason>` / `dashboard-only`, `coderabbit` /
//    `@coderabbitai review`, the `human_or_unknown` fallback with NO re-trigger)
//    are LITERALS of the task spec and of `plugin/skills/address-review/
//    references/adapters.md`.
//  - The verdict tokens (`ci-failed`, `ci-green`, `merge-ready`,
//    `feedback-present`, `open-unreviewed`, `skipped`), the dispositions
//    (`fix|defer|dismiss|outdated`), the payload key lists and "clean PR ->
//    threads: [], exit 0" are the spec's own literals.
//  - Every PR number, thread id, comment body, login, bucket and timestamp is a
//    literal WE wrote into the `gh` fixtures — so "which thread survives the
//    isResolved filter", "which comment is newest by updated_at" and "which check
//    is in the fail bucket" are facts of data we authored, never values
//    recomputed the way the code computes them.
//  - The `gh` invocation contracts asserted below (`--paginate --slurp` with the
//    cursor variable literally named `$endCursor`, `comments(last: 5)`, ONE
//    batched mutation with `t1:`/`t2:` aliases, REST `in_reply_to`, REST
//    `issues/{n}/comments` for the summary) are the four gh incompatibilities the
//    research recorded (STATE.md "## Research" review bullets) — they are the
//    CONTRACT WITH AN EXTERNAL SYSTEM, not internal structure: get them wrong and
//    the command silently reads one page / re-posts / never re-triggers.
//
// PINNED BY THIS FILE (the spec names the field but not its shape — the
// implementor follows these, and a later ADR may widen them):
//  - `threads[].comments` is a FLAT array (the GraphQL `nodes` unwrapped), each
//    comment `{author, body, databaseId}` with `author` the BARE LOGIN STRING —
//    the CLI's flat, EnvSnapshot-style payload convention, and the same string
//    shape `adapter.matchedLogins` uses.
//  - `adapter` is always present (never null); with no bot match it IS the
//    `human_or_unknown` entry with `matchedLogins: []` and `reTrigger: null`.
//  - `candidates` is an array of adapter objects of the SAME shape, present when
//    several adapters match.
//  - `review apply`'s `resolved` / `replied` / `skipped` are arrays of THREAD IDS
//    (not counts) and `retriggered` is a boolean.
//  - `pr watch` exits 0 when it skips (no PR / on main) — the kit's established
//    graceful-no-op convention (`up`'s "no app to run").
//  - `DOBBY_POLL_INTERVAL_MS` is the documented TEST SEAM capping the wait
//    between polls (the sibling of `DOBBY_LIVENESS_RETRIES`), so the polling
//    loops are exercised without ~10s sleeps.
//
// NOTE for the implementor: `run.ts`'s handler contract is SYNCHRONOUS
// (`(context: CommandContext) => CommandResult`) and run.ts is off-limits for
// this task, so `pr watch`'s loop must sleep synchronously (the `sleepSync` /
// `Atomics.wait` precedent in `lifecycle.ts`).
// ===========================================================================

const POLL_INTERVAL = "DOBBY_POLL_INTERVAL_MS";

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// --- the `gh` fixtures ------------------------------------------------------
// Hand-written answers for the exact `gh` calls the recipe makes. Nothing here is
// derived: every id, login, body and timestamp is a literal chosen for this file.

// `gh repo view --json owner,name` — gh nests the owner as an object.
const REPO_VIEW = JSON.stringify({ name: "scratch", owner: { login: "acme" } });

// `gh pr view --json number,headRefName,headRefOid,url` — the goal's PR.
const PR_42 = {
  headRefName: "worktree-mechanize-kit",
  headRefOid: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
  number: 42,
  url: "https://github.com/acme/scratch/pull/42",
};

const PR_42_NEXT = {
  ...PR_42,
  headRefOid: "abcdef0123456789abcdef0123456789abcdef01",
};

// A DIFFERENT PR, answered only when the argv names 7 — so `--pr 7` reaching (or
// not reaching) gh is visible in the payload rather than in a spy.
const PR_7 = {
  headRefName: "worktree-other-goal",
  headRefOid: "99887766554433221100aabbccddeeff00112233",
  number: 7,
  url: "https://github.com/acme/scratch/pull/7",
};

const GREPTILE_LOGIN = "greptile-apps";
const CODERABBIT_LOGIN_BOT = "coderabbitai[bot]";
const HUMAN_LOGIN = "kvnwolf";

interface FixtureComment {
  body: string;
  databaseId: number;
  login: string;
}

// One `reviewThreads` node exactly as the GraphQL selection returns it.
function ghThread(
  id: string,
  opts: {
    comments: FixtureComment[];
    isOutdated?: boolean;
    isResolved?: boolean;
    line?: number;
    path?: string;
  }
): unknown {
  return {
    comments: {
      nodes: opts.comments.map((comment) => ({
        author: { login: comment.login },
        body: comment.body,
        databaseId: comment.databaseId,
      })),
    },
    id,
    isOutdated: opts.isOutdated ?? false,
    isResolved: opts.isResolved ?? false,
    line: opts.line ?? 1,
    path: opts.path ?? "cli/src/review.ts",
  };
}

// ONE `gh api graphql` response page. `--paginate --slurp` emits an ARRAY of
// these, which is what makes the two-page fixture below a real pagination test.
function ghPage(nodes: unknown[], hasNextPage: boolean): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes,
            pageInfo: {
              endCursor: hasNextPage ? "Y3Vyc29yOjE=" : null,
              hasNextPage,
            },
          },
        },
      },
    },
  };
}

function ghPages(pages: unknown[]): string {
  return JSON.stringify(pages);
}

const NAMING_FINDING = "Rename `x` to `threadId` for clarity.";
const NAMING_ANSWER = "Fixed in 0f1e2d3.";
const OUTDATED_FINDING = "This file must not change.";

// PAGE 1 carries one RESOLVED thread (must be filtered out) and one open thread
// with two comments; PAGE 2 carries a second open thread. Draining both pages and
// dropping the resolved one leaves exactly PRRT_naming + PRRT_outdated.
const THREAD_PAGES_GREPTILE = ghPages([
  ghPage(
    [
      ghThread("PRRT_resolved", {
        comments: [
          { body: "Already handled.", databaseId: 900, login: GREPTILE_LOGIN },
        ],
        isResolved: true,
        line: 3,
        path: "cli/src/old.ts",
      }),
      ghThread("PRRT_naming", {
        comments: [
          { body: NAMING_FINDING, databaseId: 1001, login: GREPTILE_LOGIN },
          { body: NAMING_ANSWER, databaseId: 1002, login: HUMAN_LOGIN },
        ],
        line: 42,
        path: "cli/src/review.ts",
      }),
    ],
    true
  ),
  ghPage(
    [
      ghThread("PRRT_outdated", {
        comments: [
          { body: OUTDATED_FINDING, databaseId: 1003, login: GREPTILE_LOGIN },
        ],
        isOutdated: true,
        line: 7,
        path: "cli/src/run.ts",
      }),
    ],
    false
  ),
]);

const NO_THREADS = ghPages([ghPage([], false)]);

// Greptile documents this footer as the source of truth for the most recent
// commit it reviewed. The real body uses the full GitHub commit URL, not a short
// display SHA, so the fixture does too.
const BOT_SUMMARY_BODY = [
  "## Greptile summary",
  "",
  "Confidence score: 4/5",
  "",
  "One unresolved concern remains.",
  "",
  `<sub>Reviews (2): Last reviewed commit: ["Current head"](https://github.com/acme/scratch/commit/${PR_42.headRefOid}) | [Re-trigger Greptile](https://app.greptile.com/api/retrigger?id=42)</sub>`,
].join("\n");

const BOT_SUMMARY_BODY_NEXT = BOT_SUMMARY_BODY.replace(
  PR_42.headRefOid,
  PR_42_NEXT.headRefOid
);

const STALE_REVIEWED_HEAD = "1111222233334444555566667777888899990000";

function greptileComments(body: string): string {
  return JSON.stringify([
    {
      body,
      updated_at: "2026-07-24T11:30:00Z",
      user: { login: "greptile-apps[bot]" },
    },
  ]);
}

const ISSUE_COMMENTS_STALE_REVIEW = greptileComments(
  [
    "## Greptile summary",
    "",
    "Confidence score: 5/5",
    "",
    `<sub>Reviews (1): Last reviewed commit: ["Old head"](https://github.com/acme/scratch/commit/${STALE_REVIEWED_HEAD})</sub>`,
  ].join("\n")
);

// An unrelated current-commit link must not count: freshness comes specifically
// from Greptile's `Last reviewed commit` footer contract.
const ISSUE_COMMENTS_MISSING_REVIEWED_HEAD = greptileComments(
  `## Greptile summary\n\nNo blocking issues. See https://github.com/acme/scratch/commit/${PR_42.headRefOid}.`
);

const ISSUE_COMMENTS_CODERABBIT = JSON.stringify([
  {
    body: "## CodeRabbit summary\n\nNo actionable findings.",
    updated_at: "2026-07-24T11:30:00Z",
    user: { login: CODERABBIT_LOGIN_BOT },
  },
]);

// The REST `issues/{n}/comments` fixture, deliberately hostile to two shortcuts:
// the NEWEST comment overall is a HUMAN one (so an unfiltered read picks the
// wrong body), and the bot comments are ordered NEWEST-FIRST in the array (so
// "take the last element" picks the STALE body instead of the freshest).
const ISSUE_COMMENTS = JSON.stringify([
  {
    body: "Looks good to me — confidence 1/5 is a joke, ship it.",
    updated_at: "2026-07-24T12:00:00Z",
    user: { login: HUMAN_LOGIN },
  },
  {
    body: BOT_SUMMARY_BODY,
    updated_at: "2026-07-24T11:30:00Z",
    user: { login: "greptile-apps[bot]" },
  },
  {
    body: "## Greptile summary\n\nConfidence score: 2/5\n\nSTALE — superseded.",
    updated_at: "2026-07-24T09:00:00Z",
    user: { login: "greptile-apps[bot]" },
  },
]);

const ISSUE_COMMENTS_HUMAN_ONLY = JSON.stringify([
  {
    body: "Nice work.",
    updated_at: "2026-07-24T12:00:00Z",
    user: { login: HUMAN_LOGIN },
  },
]);

const ISSUE_COMMENTS_NO_SCORE = JSON.stringify([
  {
    body: "## Greptile summary\n\nNo blocking issues found.",
    updated_at: "2026-07-24T11:30:00Z",
    user: { login: "greptile-apps[bot]" },
  },
]);

const MUTATION_OK = JSON.stringify({
  data: { t1: { thread: { isResolved: true } } },
});

const REPLY_CREATED = JSON.stringify({ id: 5001 });

const FAILED_RUN_URL = "https://github.com/acme/scratch/actions/runs/12";

const CHECKS_GREEN = JSON.stringify([
  {
    bucket: "pass",
    link: "https://github.com/acme/scratch/actions/runs/11",
    name: "check",
    state: "SUCCESS",
  },
  {
    bucket: "pass",
    link: "https://github.com/acme/scratch/runs/greptile",
    name: "Greptile review",
    state: "SUCCESS",
  },
]);

const CHECKS_GREEN_WITHOUT_REVIEW = JSON.stringify([
  {
    bucket: "pass",
    link: "https://github.com/acme/scratch/actions/runs/11",
    name: "check",
    state: "SUCCESS",
  },
]);

const CHECKS_GREEN_CODERABBIT = JSON.stringify([
  {
    bucket: "pass",
    link: "https://github.com/acme/scratch/actions/runs/11",
    name: "check",
    state: "SUCCESS",
  },
  {
    bucket: "pass",
    link: "https://github.com/acme/scratch/runs/coderabbit",
    name: "CodeRabbit review",
    state: "SUCCESS",
  },
]);

const CHECKS_PENDING = JSON.stringify([
  {
    bucket: "pending",
    link: "https://github.com/acme/scratch/actions/runs/11",
    name: "check",
    state: "IN_PROGRESS",
  },
]);

const CHECKS_FAILED = JSON.stringify([
  { bucket: "fail", link: FAILED_RUN_URL, name: "build", state: "FAILURE" },
  {
    bucket: "pass",
    link: "https://github.com/acme/scratch/actions/runs/13",
    name: "lint",
    state: "SUCCESS",
  },
]);

// The base answer set: repo identity, both PRs, the mutation, the thread pages,
// the summary comments, the reply POST, the checks and the re-trigger comment.
// Matching is a LITERAL substring of the joined argv, FIRST WINS — so the
// `pr view 7` entry must precede the catch-all `pr view`, and the mutation
// (`resolveReviewThread`) must precede the query (`reviewThreads`; the two share
// no substring, the capital T in the mutation name being the difference). The
// REST patterns are PR-NUMBER-AGNOSTIC so the `--pr 7` slice is answered too.
function ghAnswers(
  overrides: { checks?: string; comments?: string; threads?: string } = {}
): StubResponse[] {
  return [
    { match: "repo view", stdout: REPO_VIEW },
    { match: ["pr view", "7"], stdout: JSON.stringify(PR_7) },
    { match: "pr view", stdout: JSON.stringify(PR_42) },
    { match: "pr checks", stdout: overrides.checks ?? CHECKS_GREEN },
    { match: "pr comment", stdout: `${PR_42.url}#issuecomment-1` },
    { match: "resolveReviewThread", stdout: MUTATION_OK },
    {
      match: "reviewThreads",
      stdout: overrides.threads ?? THREAD_PAGES_GREPTILE,
    },
    {
      match: "/issues/",
      stdout: overrides.comments ?? ISSUE_COMMENTS,
    },
    { match: "/pulls/", stdout: REPLY_CREATED },
  ];
}

// --- the harness ------------------------------------------------------------

interface Harness {
  calls: () => string[][];
  repo: string;
  // `stdin` is the third argument of the `run(argv, cwd, stdin)` seam — what the
  // bin drains for `--stdin`; omitted, nothing is piped.
  run: (
    argv: string[],
    stdin?: string
  ) => Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>;
}

// A throwaway repo on the goal's branch plus a stub `gh` on PATH. The stub dir
// holds ONLY `gh`, so every `git` spawn still resolves to the real binary.
function harness(responses: StubResponse[]): Harness {
  const repo = makeScratchRepo({
    branch: PR_42.headRefName,
    commit: false,
    prefix: "dobby-review-",
    track: scratchDirs,
  });
  const binDir = mkStubBins({ gh: responses }, scratchDirs);
  return {
    calls: () => readStubLog(binDir, "gh"),
    repo,
    run: (argv: string[], stdin?: string) =>
      withStubPath(binDir, () => run(argv, repo, stdin)),
  };
}

// Parse a `--json` payload: it renders as ONE JSON line and is the only stdout
// (the CLI's established `--json` contract), so a parse failure means the command
// produced no payload at all.
function payloadOf<T>(result: {
  exitCode: number;
  stderr: string;
  stdout: string;
}): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      `no --json payload — exit ${result.exitCode}, stdout: ${JSON.stringify(result.stdout)}, stderr: ${result.stderr.trim()}`,
      { cause: error }
    );
  }
}

function callsMatching(calls: string[][], needle: string): string[][] {
  return calls.filter((argv) => argv.join(" ").includes(needle));
}

// The ONE gh invocation containing `needle` — throwing (with the whole log) when
// there is none or more than one, so a batching regression reads as a real
// failure instead of an undefined-property crash.
function oneCall(calls: string[][], needle: string): string[] {
  const found = callsMatching(calls, needle);
  const [first] = found;
  if (first === undefined || found.length !== 1) {
    throw new Error(
      `expected exactly 1 gh call containing ${needle}, got ${found.length} — log: ${JSON.stringify(calls)}`
    );
  }
  return first;
}

// --- the payload shapes (the spec's field list, nothing more) ---------------

interface ReviewComment {
  author: string;
  body: string;
  databaseId: number;
}

interface ReviewThread {
  comments: ReviewComment[];
  id: string;
  isOutdated: boolean;
  line: number | null;
  path: string;
}

interface ReviewAdapter {
  confidence: string;
  id: string;
  intentionalReply: string;
  matchedLogins: string[];
  reTrigger: string | null;
}

interface FetchPayload {
  adapter: ReviewAdapter;
  candidates?: ReviewAdapter[];
  pr: {
    headRefName: string;
    headRefOid: string;
    number: number;
    url: string;
  };
  summary: {
    author: string;
    body: string;
    confidence: number | null;
    reviewedHeadOid: string | null;
  } | null;
  threads: ReviewThread[];
}

interface ApplyPayload {
  failures: unknown[];
  replied: string[];
  resolved: string[];
  retriggered: boolean;
  skipped: string[];
}

interface WatchPayload {
  failing?: { link: string; name: string }[];
  reason?: string | null;
  reviewFresh?: boolean | null;
  summary?: {
    reviewedHeadOid: string | null;
  } | null;
  verdict: string;
}

function threadAt(payload: FetchPayload, index: number): ReviewThread {
  const thread = payload.threads[index];
  if (thread === undefined) {
    throw new Error(
      `no thread at index ${index} — threads: ${JSON.stringify(payload.threads)}`
    );
  }
  return thread;
}

// ===========================================================================
// `review fetch` — the PR the stage is about
// ===========================================================================

describe("review fetch — identifying the pull request", () => {
  let payload: FetchPayload;
  let calls: string[][];

  beforeAll(async () => {
    const kit = harness(ghAnswers());
    payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
    calls = kit.calls();
  });

  it("reports the PR of the current branch when no number is given", () => {
    expect(payload.pr).toMatchObject(PR_42);
  });

  it("derives the repository owner and name from gh, hardcoding neither", () => {
    const rest = oneCall(calls, "issues/42/comments");
    expect(rest.join(" ")).toContain("repos/acme/scratch/issues/42/comments");
  });

  it("reads the summary comment through the REST issues endpoint", () => {
    // `gh pr view --json comments` carries no `updatedAt`, so the recipe's
    // sort-by-updated_at is only possible over REST.
    expect(oneCall(calls, "issues/42/comments")).toContain("--paginate");
  });
});

describe("review fetch — an explicitly numbered pull request", () => {
  it("reports the PR named by --pr, not the one on the current branch", async () => {
    const kit = harness(ghAnswers());
    const payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--pr", "7", "--json"])
    );
    expect(payload.pr).toMatchObject(PR_7);
  });

  it("rejects an unknown adapter before reading GitHub", async () => {
    const kit = harness(ghAnswers());
    const result = await kit.run([
      "review",
      "fetch",
      "--adapter",
      "imaginary",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown adapter `imaginary`");
    expect(kit.calls()).toEqual([]);
  });
});

// ===========================================================================
// `review fetch` — the open review threads
// ===========================================================================

describe("review fetch — the open review threads", () => {
  let payload: FetchPayload;
  let calls: string[][];

  beforeAll(async () => {
    const kit = harness(ghAnswers());
    payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
    calls = kit.calls();
  });

  it("drains every page of review threads, not just the first", () => {
    // PRRT_outdated lives on page 2 of the fixture; PRRT_resolved (page 1) is
    // resolved and must not survive the client-side filter.
    expect(payload.threads.map((thread) => thread.id)).toEqual([
      "PRRT_naming",
      "PRRT_outdated",
    ]);
  });

  it("keeps the file and line each thread hangs on", () => {
    expect(threadAt(payload, 0)).toMatchObject({
      line: 42,
      path: "cli/src/review.ts",
    });
  });

  it("marks a thread whose code has moved on as outdated", () => {
    expect(threadAt(payload, 1).isOutdated).toBe(true);
  });

  it("carries each thread's comments with their authors and reply ids", () => {
    expect(threadAt(payload, 0).comments).toEqual([
      {
        author: GREPTILE_LOGIN,
        body: NAMING_FINDING,
        databaseId: 1001,
      },
      { author: HUMAN_LOGIN, body: NAMING_ANSWER, databaseId: 1002 },
    ]);
  });

  it("asks gh to paginate the thread query with the $endCursor variable", () => {
    // `gh api graphql --paginate` REQUIRES the cursor variable to be named
    // literally `$endCursor`; the old hand-loop `$cursor` recipe is incompatible
    // and silently returns page 1 only.
    const query = oneCall(calls, "reviewThreads").join("\n");
    expect(query).toContain("$endCursor");
    expect(query).not.toContain("$cursor");
  });

  it("slurps the paginated graphql pages into one response", () => {
    const graphql = oneCall(calls, "reviewThreads");
    expect(graphql).toContain("--paginate");
    expect(graphql).toContain("--slurp");
  });

  it("requests the last five comments of each thread, not just the first", () => {
    // Prior rationale replies must be visible or `review apply` cannot be
    // idempotent (it would re-post a reply it already made).
    expect(oneCall(calls, "reviewThreads").join("\n")).toMatch(
      /comments\s*\(\s*last:\s*5/
    );
  });
});

describe("review fetch — a pull request with nothing left to address", () => {
  let payload: FetchPayload;
  let exitCode: number;

  beforeAll(async () => {
    const kit = harness(
      ghAnswers({
        comments: ISSUE_COMMENTS_HUMAN_ONLY,
        threads: NO_THREADS,
      })
    );
    const result = await kit.run(["review", "fetch", "--json"]);
    ({ exitCode } = result);
    payload = payloadOf<FetchPayload>(result);
  });

  it("reports no open threads", () => {
    expect(payload.threads).toEqual([]);
  });

  it("succeeds — a clean PR is an answer, not an error", () => {
    expect(exitCode).toBe(0);
  });

  it("falls back to the human_or_unknown adapter when no bot reviewed", () => {
    expect(payload.adapter).toMatchObject({
      id: "human_or_unknown",
      matchedLogins: [],
      reTrigger: null,
    });
  });

  it("reports no summary when no review tool posted one", () => {
    expect(payload.summary).toBeNull();
  });
});

// ===========================================================================
// `review fetch` — adapter detection (the registry is DATA)
// ===========================================================================

describe("review fetch — detecting the review tool", () => {
  it("identifies greptile from the logins that authored the open threads", async () => {
    const kit = harness(ghAnswers());
    const payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
    expect(payload.adapter).toEqual({
      confidence: "dashboard-only",
      id: "greptile",
      intentionalReply: "@greptileai <reason>",
      matchedLogins: [GREPTILE_LOGIN],
      reTrigger: "@greptileai review",
    });
  });

  it("matches a bot login that carries the trailing [bot] suffix", async () => {
    // GraphQL returns `coderabbitai`, REST returns `coderabbitai[bot]`: the
    // comparison must strip the suffix on BOTH sides or detection wrongly falls
    // through to human_or_unknown.
    const kit = harness(
      ghAnswers({
        threads: ghPages([
          ghPage(
            [
              ghThread("PRRT_rabbit", {
                comments: [
                  {
                    body: "Consider extracting this helper.",
                    databaseId: 2001,
                    login: CODERABBIT_LOGIN_BOT,
                  },
                ],
              }),
            ],
            false
          ),
        ]),
      })
    );
    const payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
    expect(payload.adapter).toMatchObject({
      id: "coderabbit",
      reTrigger: "@coderabbitai review",
    });
  });

  it("falls back to human_or_unknown when only humans commented", async () => {
    const kit = harness(
      ghAnswers({
        comments: ISSUE_COMMENTS_HUMAN_ONLY,
        threads: ghPages([
          ghPage(
            [
              ghThread("PRRT_human", {
                comments: [
                  {
                    body: "This needs a test.",
                    databaseId: 3001,
                    login: HUMAN_LOGIN,
                  },
                ],
              }),
            ],
            false
          ),
        ]),
      })
    );
    const payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
    expect(payload.adapter).toMatchObject({
      id: "human_or_unknown",
      matchedLogins: [],
      reTrigger: null,
    });
  });
});

const DUAL_ADAPTER_THREADS = ghPages([
  ghPage(
    [
      ghThread("PRRT_naming", {
        comments: [
          {
            body: NAMING_FINDING,
            databaseId: 1001,
            login: GREPTILE_LOGIN,
          },
        ],
      }),
      ghThread("PRRT_rabbit", {
        comments: [
          {
            body: "Consider extracting this helper.",
            databaseId: 2001,
            login: CODERABBIT_LOGIN_BOT,
          },
        ],
      }),
    ],
    false
  ),
]);

describe("review fetch — two review tools on the same pull request", () => {
  let payload: FetchPayload;

  beforeAll(async () => {
    const kit = harness(
      ghAnswers({
        threads: DUAL_ADAPTER_THREADS,
      })
    );
    payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
  });

  it("lists every adapter that matched so the stage can ask which to run", () => {
    const ids = (payload.candidates ?? []).map((candidate) => candidate.id);
    expect([...ids].sort()).toEqual(["coderabbit", "greptile"]);
  });

  it("still names one adapter, drawn from the candidates", () => {
    const ids = (payload.candidates ?? []).map((candidate) => candidate.id);
    expect(ids).toContain(payload.adapter.id);
  });

  it("selects one adapter mechanically and returns only its threads", async () => {
    const comments = JSON.stringify([
      {
        body: BOT_SUMMARY_BODY,
        updated_at: "2026-07-24T11:30:00Z",
        user: { login: "greptile-apps[bot]" },
      },
      {
        body: "## CodeRabbit summary\n\nNo actionable findings.",
        updated_at: "2026-07-24T11:35:00Z",
        user: { login: CODERABBIT_LOGIN_BOT },
      },
    ]);
    const kit = harness(ghAnswers({ comments, threads: DUAL_ADAPTER_THREADS }));
    const selected = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--adapter", "coderabbit", "--json"])
    );

    expect(selected.adapter.id).toBe("coderabbit");
    expect(selected.threads.map((thread) => thread.id)).toEqual([
      "PRRT_rabbit",
    ]);
    expect(selected.summary?.author).toBe(CODERABBIT_LOGIN_BOT);
  });
});

// ===========================================================================
// `review fetch` — the summary comment
// ===========================================================================

describe("review fetch — the review tool's summary comment", () => {
  let payload: FetchPayload;

  beforeAll(async () => {
    const kit = harness(ghAnswers());
    payload = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
  });

  it("reads the freshest bot summary, sorting by updated_at", () => {
    // The fixture lists the newest bot comment BEFORE the stale one, so taking
    // the last array element would read "STALE — superseded".
    expect(payload.summary?.body).toBe(BOT_SUMMARY_BODY);
  });

  it("ignores comments a human posted", () => {
    // The newest comment overall is the human's; an unfiltered read picks it up.
    expect(payload.summary?.author).toContain(GREPTILE_LOGIN);
  });

  it("matches the summary author by exact bare login, never by substring", async () => {
    const comments = JSON.stringify([
      {
        body: `Last reviewed commit: https://github.com/acme/scratch/commit/${STALE_REVIEWED_HEAD}`,
        updated_at: "2026-07-24T12:30:00Z",
        user: { login: "greptile-apps-proxy[bot]" },
      },
      {
        body: BOT_SUMMARY_BODY,
        updated_at: "2026-07-24T11:30:00Z",
        user: { login: "greptile-apps[bot]" },
      },
    ]);
    const kit = harness(ghAnswers({ comments, threads: NO_THREADS }));
    const exact = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--adapter", "greptile", "--json"])
    );

    expect(exact.summary?.author).toBe("greptile-apps[bot]");
    expect(exact.summary?.reviewedHeadOid).toBe(PR_42.headRefOid);
  });

  it("parses the confidence score out of the summary body", () => {
    expect(payload.summary?.confidence).toBe(4);
  });

  it("extracts Greptile's last reviewed commit from its documented footer", () => {
    expect(payload.summary?.reviewedHeadOid).toBe(PR_42.headRefOid);
  });

  it("reports a null confidence when the summary carries no score", async () => {
    const kit = harness(ghAnswers({ comments: ISSUE_COMMENTS_NO_SCORE }));
    const noScore = payloadOf<FetchPayload>(
      await kit.run(["review", "fetch", "--json"])
    );
    expect(noScore.summary?.confidence).toBeNull();
  });
});

// ===========================================================================
// `review fetch` — a read gh could not answer
//
// The module's most dangerous failure mode: "no open threads" is the stage's
// GREEN LIGHT, so a broken gh call must never be degraded into a clean PR. The
// payload is the thing to guard — an exit code nobody reads plus a `threads: []`
// on stdout would still tell the kit to merge work nobody reviewed.
// ===========================================================================

describe("review fetch — gh cannot read the review threads", () => {
  let result: { exitCode: number; stderr: string; stdout: string };

  beforeAll(async () => {
    const kit = harness([
      // An expired token / a rate limit / a network blip on the ONE call that
      // carries the findings. Must precede the generic graphql answer.
      {
        exitCode: 1,
        match: "reviewThreads",
        stderr: "gh: Bad credentials (HTTP 401)\n",
      },
      ...ghAnswers(),
    ]);
    result = await kit.run(["review", "fetch", "--json"]);
  });

  it("fails instead of reporting a clean pull request", () => {
    expect(result.exitCode).not.toBe(0);
  });

  it("emits no payload a caller could read as no open threads", () => {
    expect(result.stdout).toBe("");
  });

  it("says what gh refused", () => {
    expect(result.stderr).toContain("Bad credentials");
  });
});

describe("review fetch — gh cannot read the summary comments", () => {
  let result: { exitCode: number; stderr: string; stdout: string };

  beforeAll(async () => {
    const kit = harness([
      {
        exitCode: 1,
        match: "/issues/",
        stderr: "gh: API rate limit exceeded\n",
      },
      ...ghAnswers(),
    ]);
    result = await kit.run(["review", "fetch", "--json"]);
  });

  it("fails instead of reporting the pull request unreviewed", () => {
    expect(result.exitCode).not.toBe(0);
  });

  it("emits no payload at all", () => {
    expect(result.stdout).toBe("");
  });
});

// ===========================================================================
// `review apply` — resolving the addressed threads
// ===========================================================================

const APPLY_THREADS = ghPages([
  ghPage(
    [
      ghThread("PRRT_naming", {
        comments: [
          { body: NAMING_FINDING, databaseId: 1001, login: GREPTILE_LOGIN },
        ],
      }),
      ghThread("PRRT_outdated", {
        comments: [
          { body: OUTDATED_FINDING, databaseId: 1003, login: GREPTILE_LOGIN },
        ],
        isOutdated: true,
      }),
      ghThread("PRRT_defer", {
        comments: [
          {
            body: "Extract this into a helper.",
            databaseId: 1004,
            login: GREPTILE_LOGIN,
          },
        ],
      }),
      ghThread("PRRT_dismiss", {
        comments: [
          {
            body: "Remove the redundant guard.",
            databaseId: 1005,
            login: GREPTILE_LOGIN,
          },
        ],
      }),
    ],
    false
  ),
]);

const DEFER_REPLY = "@greptileai deferred — tracked in #99";
const DISMISS_REPLY = "@greptileai intentional — the guard is required by tsc";

// Write a disposition plan into the repo and return its absolute path.
function writePlan(repo: string, plan: unknown): string {
  const path = join(repo, "review-plan.json");
  writeFileSync(path, JSON.stringify(plan, null, 2));
  return path;
}

describe("review apply — resolving the addressed threads", () => {
  let payload: ApplyPayload;
  let calls: string[][];

  beforeAll(async () => {
    const kit = harness(ghAnswers({ threads: APPLY_THREADS }));
    const plan = writePlan(kit.repo, {
      plan: [
        { disposition: "fix", threadId: "PRRT_naming" },
        { disposition: "outdated", threadId: "PRRT_outdated" },
        { disposition: "defer", reply: DEFER_REPLY, threadId: "PRRT_defer" },
        {
          disposition: "dismiss",
          reply: DISMISS_REPLY,
          threadId: "PRRT_dismiss",
        },
      ],
      pr: 42,
      reTrigger: false,
    });
    payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--json"])
    );
    calls = kit.calls();
  });

  it("resolves every fixed, dismissed and outdated thread", () => {
    expect([...payload.resolved].sort()).toEqual([
      "PRRT_dismiss",
      "PRRT_naming",
      "PRRT_outdated",
    ]);
  });

  it("leaves a deferred thread unresolved on purpose", () => {
    expect(payload.resolved).not.toContain("PRRT_defer");
  });

  it("batches the whole resolve set into ONE aliased mutation", () => {
    const mutation = oneCall(calls, "resolveReviewThread").join("\n");
    expect(mutation).toMatch(/\bt1:\s*resolveReviewThread/);
    expect(mutation).toMatch(/\bt2:\s*resolveReviewThread/);
  });

  it("never sends a deferred thread to the resolve mutation", () => {
    expect(oneCall(calls, "resolveReviewThread").join("\n")).not.toContain(
      "PRRT_defer"
    );
  });
});

// ===========================================================================
// `review apply` — replying to the threads that carry a rationale
// ===========================================================================

describe("review apply — replying with the rationale", () => {
  let payload: ApplyPayload;
  let calls: string[][];

  beforeAll(async () => {
    const kit = harness(ghAnswers({ threads: APPLY_THREADS }));
    const plan = writePlan(kit.repo, {
      plan: [
        { disposition: "defer", reply: DEFER_REPLY, threadId: "PRRT_defer" },
        {
          disposition: "dismiss",
          reply: DISMISS_REPLY,
          threadId: "PRRT_dismiss",
        },
      ],
      pr: 42,
      reTrigger: false,
    });
    payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--json"])
    );
    calls = kit.calls();
  });

  it("reports the threads it replied to", () => {
    expect([...payload.replied].sort()).toEqual(["PRRT_defer", "PRRT_dismiss"]);
  });

  it("posts each reply against the thread's own first comment", () => {
    const replies = callsMatching(calls, "pulls/42/comments");
    expect(replies.map((argv) => argv.join(" ")).join("\n")).toContain(
      "in_reply_to=1004"
    );
  });

  it("passes the reply body through as a single unmangled argument", () => {
    const replies = callsMatching(calls, "in_reply_to=1004");
    expect(
      replies.some((argv) => argv.some((arg) => arg.includes(DEFER_REPLY)))
    ).toBe(true);
  });
});

describe("review apply — a reply that is already there", () => {
  let payload: ApplyPayload;
  let calls: string[][];

  const ALREADY_SAID = "@greptileai deferred — already answered last cycle";

  beforeAll(async () => {
    const kit = harness(
      ghAnswers({
        threads: ghPages([
          ghPage(
            [
              // The matching reply sits THIRD of five, so reading only the last
              // comment misses it and re-posts a duplicate.
              ghThread("PRRT_answered", {
                comments: [
                  {
                    body: "Extract this into a helper.",
                    databaseId: 4001,
                    login: GREPTILE_LOGIN,
                  },
                  {
                    body: "Why not?",
                    databaseId: 4002,
                    login: GREPTILE_LOGIN,
                  },
                  { body: ALREADY_SAID, databaseId: 4003, login: HUMAN_LOGIN },
                  {
                    body: "Understood.",
                    databaseId: 4004,
                    login: GREPTILE_LOGIN,
                  },
                  {
                    body: "Keeping this open for now.",
                    databaseId: 4005,
                    login: GREPTILE_LOGIN,
                  },
                ],
              }),
              ghThread("PRRT_defer", {
                comments: [
                  {
                    body: "Extract this into a helper.",
                    databaseId: 1004,
                    login: GREPTILE_LOGIN,
                  },
                ],
              }),
            ],
            false
          ),
        ]),
      })
    );
    const plan = writePlan(kit.repo, {
      plan: [
        {
          disposition: "defer",
          reply: ALREADY_SAID,
          threadId: "PRRT_answered",
        },
        { disposition: "defer", reply: DEFER_REPLY, threadId: "PRRT_defer" },
      ],
      pr: 42,
      reTrigger: false,
    });
    payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--json"])
    );
    calls = kit.calls();
  });

  it("skips the thread whose reply was already posted", () => {
    expect(payload.skipped).toContain("PRRT_answered");
  });

  it("never posts the duplicate reply a second time", () => {
    const posted = callsMatching(calls, "pulls/42/comments")
      .map((argv) => argv.join(" "))
      .join("\n");
    expect(posted).not.toContain(ALREADY_SAID);
  });

  it("still replies to the thread that has no such reply yet", () => {
    expect(payload.replied).toEqual(["PRRT_defer"]);
  });
});

describe("review apply — a reply gh refuses to post", () => {
  let payload: ApplyPayload;

  beforeAll(async () => {
    const kit = harness([
      // The 404 answer must precede the generic reply answer (first wins).
      {
        exitCode: 1,
        match: "in_reply_to=1005",
        stderr: "gh: Not Found (HTTP 404)\n",
      },
      ...ghAnswers({ threads: APPLY_THREADS }),
    ]);
    const plan = writePlan(kit.repo, {
      plan: [
        { disposition: "defer", reply: DEFER_REPLY, threadId: "PRRT_defer" },
        {
          disposition: "dismiss",
          reply: DISMISS_REPLY,
          threadId: "PRRT_dismiss",
        },
      ],
      pr: 42,
      reTrigger: false,
    });
    payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--json"])
    );
  });

  it("reports the refused reply as a failure", () => {
    expect(payload.failures).toHaveLength(1);
    expect(JSON.stringify(payload.failures)).toContain("PRRT_dismiss");
  });

  it("never counts a refused reply as replied", () => {
    expect(payload.replied).not.toContain("PRRT_dismiss");
  });

  it("still replies to the threads that did work", () => {
    expect(payload.replied).toContain("PRRT_defer");
  });
});

// ===========================================================================
// `review apply` — re-triggering the review tool
// ===========================================================================

describe("review apply — re-triggering the review", () => {
  it("comments the adapter's trigger phrase on the PR when asked", async () => {
    const kit = harness(ghAnswers({ threads: APPLY_THREADS }));
    const plan = writePlan(kit.repo, {
      plan: [{ disposition: "fix", threadId: "PRRT_naming" }],
      pr: 42,
      reTrigger: true,
    });
    const payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--json"])
    );
    expect(payload.retriggered).toBe(true);
    expect(oneCall(kit.calls(), "pr comment")).toContain("@greptileai review");
  });

  it("never re-triggers when the plan does not ask for it", async () => {
    const kit = harness(ghAnswers({ threads: APPLY_THREADS }));
    const plan = writePlan(kit.repo, {
      plan: [{ disposition: "fix", threadId: "PRRT_naming" }],
      pr: 42,
      reTrigger: false,
    });
    const payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--json"])
    );
    expect(payload.retriggered).toBe(false);
    expect(callsMatching(kit.calls(), "pr comment")).toEqual([]);
  });

  it("never re-triggers a human reviewer, who has no trigger phrase", async () => {
    const kit = harness(
      ghAnswers({
        comments: ISSUE_COMMENTS_HUMAN_ONLY,
        threads: ghPages([
          ghPage(
            [
              ghThread("PRRT_human", {
                comments: [
                  {
                    body: "This needs a test.",
                    databaseId: 3001,
                    login: HUMAN_LOGIN,
                  },
                ],
              }),
            ],
            false
          ),
        ]),
      })
    );
    const plan = writePlan(kit.repo, {
      plan: [{ disposition: "fix", threadId: "PRRT_human" }],
      pr: 42,
      reTrigger: true,
    });
    const payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--json"])
    );
    expect(payload.retriggered).toBe(false);
    expect(callsMatching(kit.calls(), "pr comment")).toEqual([]);
  });
});

describe("review apply — selecting between two review adapters", () => {
  it("refuses an ambiguous write when --adapter is omitted", async () => {
    const kit = harness(ghAnswers({ threads: DUAL_ADAPTER_THREADS }));
    const plan = writePlan(kit.repo, {
      plan: [{ disposition: "fix", threadId: "PRRT_rabbit" }],
      pr: 42,
      reTrigger: true,
    });
    const result = await kit.run(["review", "apply", "--plan", plan, "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("multiple review adapters matched");
    expect(callsMatching(kit.calls(), "resolveReviewThread")).toEqual([]);
    expect(callsMatching(kit.calls(), "pr comment")).toEqual([]);
  });

  it("applies and re-triggers only the selected CodeRabbit adapter", async () => {
    const kit = harness(ghAnswers({ threads: DUAL_ADAPTER_THREADS }));
    const plan = writePlan(kit.repo, {
      plan: [{ disposition: "fix", threadId: "PRRT_rabbit" }],
      pr: 42,
      reTrigger: true,
    });
    const payload = payloadOf<ApplyPayload>(
      await kit.run([
        "review",
        "apply",
        "--plan",
        plan,
        "--adapter",
        "coderabbit",
        "--json",
      ])
    );

    expect(payload.resolved).toEqual(["PRRT_rabbit"]);
    expect(payload.retriggered).toBe(true);
    expect(oneCall(kit.calls(), "pr comment")).toContain(
      "@coderabbitai review"
    );
  });
});

// ===========================================================================
// `review apply --dry-run` — the rehearsal
//
// The CLI-wide plan-then-execute preview, and the one worth pinning hardest on a
// command that MUTATES GitHub: a rehearsal that actually writes is unrecoverable
// (a resolved thread, a posted reply and a re-triggered review cannot be taken
// back). The reads still happen — only the three WRITE calls must be absent.
// ===========================================================================

describe("review apply --dry-run — deciding everything, writing nothing", () => {
  let payload: ApplyPayload;
  let calls: string[][];

  beforeAll(async () => {
    const kit = harness(ghAnswers({ threads: APPLY_THREADS }));
    const plan = writePlan(kit.repo, {
      plan: [
        { disposition: "fix", threadId: "PRRT_naming" },
        {
          disposition: "dismiss",
          reply: DISMISS_REPLY,
          threadId: "PRRT_dismiss",
        },
      ],
      pr: 42,
      reTrigger: true,
    });
    payload = payloadOf<ApplyPayload>(
      await kit.run(["review", "apply", "--plan", plan, "--dry-run", "--json"])
    );
    calls = kit.calls();
  });

  it("reports the threads it would resolve", () => {
    expect([...payload.resolved].sort()).toEqual([
      "PRRT_dismiss",
      "PRRT_naming",
    ]);
  });

  it("reports the reply it would post", () => {
    expect(payload.replied).toEqual(["PRRT_dismiss"]);
  });

  it("reports the re-trigger it would leave", () => {
    expect(payload.retriggered).toBe(true);
  });

  it("resolves no thread for real", () => {
    expect(callsMatching(calls, "resolveReviewThread")).toEqual([]);
  });

  it("posts no reply for real", () => {
    expect(callsMatching(calls, "pulls/42/comments")).toEqual([]);
  });

  it("leaves no re-trigger comment for real", () => {
    expect(callsMatching(calls, "pr comment")).toEqual([]);
  });
});

// ===========================================================================
// `review apply --stdin` — the plan arriving on a pipe
// ===========================================================================

describe("review apply --stdin — the piped disposition plan", () => {
  let payload: ApplyPayload;
  let calls: string[][];

  beforeAll(async () => {
    const kit = harness(ghAnswers({ threads: APPLY_THREADS }));
    payload = payloadOf<ApplyPayload>(
      await kit.run(
        ["review", "apply", "--stdin", "--json"],
        JSON.stringify({
          plan: [
            {
              disposition: "defer",
              reply: DEFER_REPLY,
              threadId: "PRRT_defer",
            },
            { disposition: "fix", threadId: "PRRT_naming" },
          ],
          pr: 42,
          reTrigger: false,
        })
      )
    );
    calls = kit.calls();
  });

  it("applies the piped plan exactly as it would a --plan file", () => {
    expect(payload.resolved).toEqual(["PRRT_naming"]);
    expect(payload.replied).toEqual(["PRRT_defer"]);
  });

  it("posts the piped rationale against the thread it names", () => {
    expect(callsMatching(calls, "in_reply_to=1004")).toHaveLength(1);
  });
});

describe("review apply --stdin — nothing on the pipe", () => {
  it("refuses rather than reporting an empty apply as done", async () => {
    const kit = harness(ghAnswers({ threads: APPLY_THREADS }));
    const result = await kit.run(["review", "apply", "--stdin", "--json"], "");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--stdin");
  });
});

// ===========================================================================
// `pr watch` — the CI verdict
// ===========================================================================

// Run `fn` with the poll-interval test seam set, restoring it afterwards.
async function withPollInterval<T>(
  ms: number,
  fn: () => Promise<T> | T
): Promise<T> {
  const original = process.env[POLL_INTERVAL];
  process.env[POLL_INTERVAL] = String(ms);
  try {
    return await fn();
  } finally {
    restoreEnv(POLL_INTERVAL, original);
  }
}

describe("pr watch — a red build", () => {
  let payload: WatchPayload;

  beforeAll(async () => {
    const kit = harness(ghAnswers({ checks: CHECKS_FAILED }));
    payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run(["pr", "watch", "--pr", "42", "--json"])
      )
    );
  });

  it("verdicts the run ci-failed when any check sits in the fail bucket", () => {
    // gh's `--json` mode always exits 0, so the verdict can only come from the
    // bucket counts.
    expect(payload.verdict).toBe("ci-failed");
  });

  it("names the failing checks with a link to their logs", () => {
    expect(payload.failing).toEqual([{ link: FAILED_RUN_URL, name: "build" }]);
  });
});

describe("pr watch — checks that are still running", () => {
  it("keeps polling until the checks leave the pending bucket", async () => {
    const binDir = mkStubBinDir(scratchDirs);
    const counter = join(binDir, "poll-count");
    const pending = join(binDir, "checks-pending.json");
    const green = join(binDir, "checks-green.json");
    writeFileSync(pending, CHECKS_PENDING);
    writeFileSync(green, CHECKS_GREEN);
    // A STATEFUL gh: the first two `pr checks` polls answer "pending", the third
    // answers "pass" — so only a command that runs its OWN polling loop can ever
    // reach a ci-green verdict.
    mkStubBin(
      binDir,
      "gh",
      [
        "#!/bin/sh",
        'case "$*" in',
        "  *'pr checks'*)",
        `    count=$(cat ${counter} 2>/dev/null || echo 0)`,
        "    count=$((count + 1))",
        `    printf '%s' "$count" > ${counter}`,
        `    if [ "$count" -lt 3 ]; then cat ${pending}; else cat ${green}; fi`,
        "    exit 0",
        "    ;;",
        `  *'repo view'*) printf '%s' '${REPO_VIEW}' ;;`,
        `  *) printf '%s' '${JSON.stringify(PR_42)}' ;;`,
        "esac",
        "exit 0",
      ].join("\n")
    );
    const repo = makeScratchRepo({
      branch: PR_42.headRefName,
      commit: false,
      prefix: "dobby-review-",
      track: scratchDirs,
    });
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        withStubPath(binDir, () =>
          run(["pr", "watch", "--pr", "42", "--json"], repo)
        )
      )
    );
    expect(payload.verdict).toBe("ci-green");
  });
});

describe("pr watch — checks still running when the clock runs out", () => {
  it("verdicts ci-pending: nothing was proven and nothing broke", async () => {
    // `--deadline 0` = one poll, then answer. The checks never leave the pending
    // bucket, so the only honest answers are "still running" or a wait forever.
    const kit = harness(ghAnswers({ checks: CHECKS_PENDING }));
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run(["pr", "watch", "--pr", "42", "--deadline", "0", "--json"])
      )
    );
    expect(payload.verdict).toBe("ci-pending");
  });
});

describe("pr watch — gh cannot report the checks at all", () => {
  let result: { exitCode: number; stderr: string; stdout: string };

  beforeAll(async () => {
    const kit = harness([
      // An expired token, a rate limit, a network blip: gh answers NOTHING about
      // the checks. An empty check list read as green would hand the finish gate a
      // false pass on a build nobody looked at.
      {
        exitCode: 1,
        match: "pr checks",
        stderr: "gh: Bad credentials (HTTP 401)\n",
      },
      ...ghAnswers(),
    ]);
    result = await withPollInterval(0, () =>
      kit.run(["pr", "watch", "--pr", "42", "--json"])
    );
  });

  it("never answers ci-green about checks it could not read", () => {
    expect(result.stdout).not.toContain("ci-green");
  });

  it("fails, saying what gh refused", () => {
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Bad credentials");
  });
});

describe("pr watch — a branch nobody reported checks for", () => {
  it("verdicts ci-green: gh's own no-checks answer is nothing to wait for", async () => {
    // gh exits nonzero with THIS message when a PR has no checks at all — the one
    // nonzero that legitimately means an empty check list.
    const kit = harness([
      {
        exitCode: 1,
        match: "pr checks",
        stderr: `no checks reported on the '${PR_42.headRefName}' branch\n`,
      },
      ...ghAnswers(),
    ]);
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run(["pr", "watch", "--pr", "42", "--json"])
      )
    );
    expect(payload.verdict).toBe("ci-green");
  });
});

describe("pr watch — green checks, no review wait asked for", () => {
  it("verdicts the run ci-green and stops there", async () => {
    const kit = harness(ghAnswers());
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run(["pr", "watch", "--pr", "42", "--json"])
      )
    );
    expect(payload.verdict).toBe("ci-green");
  });
});

// ===========================================================================
// `pr watch --await-review` — waiting for the review tool
// ===========================================================================

describe("pr watch --await-review — the review already landed", () => {
  it("verdicts merge-ready when Greptile reviewed the current head and left no open threads", async () => {
    const kit = harness(ghAnswers({ threads: NO_THREADS }));
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "5",
          "--json",
        ])
      )
    );
    expect(payload.verdict).toBe("merge-ready");
    expect(payload.reviewFresh).toBe(true);
    expect(payload.summary?.reviewedHeadOid).toBe(PR_42.headRefOid);
  });

  it("verdicts feedback-present when open threads are waiting", async () => {
    const kit = harness(ghAnswers());
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "5",
          "--json",
        ])
      )
    );
    expect(payload.verdict).toBe("feedback-present");
  });

  it("refuses a dual-bot watch until the adapter is selected", async () => {
    const kit = harness(
      ghAnswers({
        checks: CHECKS_GREEN_CODERABBIT,
        threads: DUAL_ADAPTER_THREADS,
      })
    );
    const result = await withPollInterval(0, () =>
      kit.run([
        "pr",
        "watch",
        "--pr",
        "42",
        "--await-review",
        "--deadline",
        "0",
        "--json",
      ])
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("multiple review adapters matched");
  });

  it("watches only the selected adapter on a dual-bot PR", async () => {
    const kit = harness(
      ghAnswers({
        checks: CHECKS_GREEN_CODERABBIT,
        threads: DUAL_ADAPTER_THREADS,
      })
    );
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--adapter",
          "coderabbit",
          "--await-review",
          "--deadline",
          "0",
          "--json",
        ])
      )
    );

    expect(payload.verdict).toBe("feedback-present");
  });
});

describe("pr watch --await-review — Greptile freshness", () => {
  it("keeps a summary for an older head open-unreviewed", async () => {
    const kit = harness(
      ghAnswers({
        comments: ISSUE_COMMENTS_STALE_REVIEW,
        threads: NO_THREADS,
      })
    );
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "0",
          "--json",
        ])
      )
    );

    expect(payload.verdict).toBe("open-unreviewed");
    expect(payload.reviewFresh).toBe(false);
    expect(payload.summary?.reviewedHeadOid).toBe(STALE_REVIEWED_HEAD);
    expect(payload.reason).toContain(PR_42.headRefOid);
    expect(payload.reason).toContain(STALE_REVIEWED_HEAD);
  });

  it("fails closed when a Greptile summary omits the reviewed-commit footer", async () => {
    const kit = harness(
      ghAnswers({
        comments: ISSUE_COMMENTS_MISSING_REVIEWED_HEAD,
        threads: NO_THREADS,
      })
    );
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "0",
          "--json",
        ])
      )
    );

    expect(payload.verdict).toBe("open-unreviewed");
    expect(payload.reviewFresh).toBe(false);
    expect(payload.summary?.reviewedHeadOid).toBeNull();
    expect(payload.reason).toContain("does not identify");
  });

  it("fails closed when the Greptile review check is absent", async () => {
    const kit = harness(
      ghAnswers({
        checks: CHECKS_GREEN_WITHOUT_REVIEW,
        threads: NO_THREADS,
      })
    );
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "0",
          "--json",
        ])
      )
    );

    expect(payload.verdict).toBe("open-unreviewed");
    expect(payload.reviewFresh).toBe(false);
    expect(payload.reason).toContain("greptile review check");
    expect(payload.reason).toContain("observed checks: check");
  });

  it("fails closed when the Greptile review check is present but not passing", async () => {
    const checks = JSON.stringify([
      {
        bucket: "skipping",
        link: "https://github.com/acme/scratch/runs/greptile",
        name: "Greptile review",
        state: "SKIPPED",
      },
    ]);
    const kit = harness(ghAnswers({ checks, threads: NO_THREADS }));
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "0",
          "--json",
        ])
      )
    );

    expect(payload.verdict).toBe("open-unreviewed");
    expect(payload.reviewFresh).toBe(false);
    expect(payload.reason).toContain("Greptile review=skipping");
  });

  it("fails closed for CodeRabbit when no commit-scoped review check exists", async () => {
    const kit = harness(
      ghAnswers({
        checks: CHECKS_GREEN_WITHOUT_REVIEW,
        comments: ISSUE_COMMENTS_CODERABBIT,
        threads: NO_THREADS,
      })
    );
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "0",
          "--json",
        ])
      )
    );

    expect(payload.verdict).toBe("open-unreviewed");
    expect(payload.reviewFresh).toBe(false);
    expect(payload.reason).toContain("coderabbit review check");
  });

  it("accepts CodeRabbit only when its current-commit check passed", async () => {
    const kit = harness(
      ghAnswers({
        checks: CHECKS_GREEN_CODERABBIT,
        comments: ISSUE_COMMENTS_CODERABBIT,
        threads: NO_THREADS,
      })
    );
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--adapter",
          "coderabbit",
          "--await-review",
          "--deadline",
          "0",
          "--json",
        ])
      )
    );

    expect(payload.verdict).toBe("merge-ready");
    expect(payload.reviewFresh).toBe(true);
    expect(payload.summary?.reviewedHeadOid).toBeNull();
  });
});

describe("pr watch --await-review — HEAD changes while polling", () => {
  it("discards old checks and review evidence, then restarts on the new HEAD", async () => {
    const binDir = mkStubBinDir(scratchDirs);
    const prCount = join(binDir, "pr-view-count");
    const checksCount = join(binDir, "checks-count");
    const commentsCount = join(binDir, "comments-count");
    const prA = join(binDir, "pr-a.json");
    const prB = join(binDir, "pr-b.json");
    const checks = join(binDir, "checks.json");
    const threads = join(binDir, "threads.json");
    const commentsA = join(binDir, "comments-a.json");
    const commentsB = join(binDir, "comments-b.json");
    writeFileSync(prA, JSON.stringify(PR_42));
    writeFileSync(prB, JSON.stringify(PR_42_NEXT));
    writeFileSync(checks, CHECKS_GREEN);
    writeFileSync(threads, NO_THREADS);
    writeFileSync(commentsA, greptileComments(BOT_SUMMARY_BODY));
    writeFileSync(commentsB, greptileComments(BOT_SUMMARY_BODY_NEXT));
    mkStubBin(
      binDir,
      "gh",
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *'repo view'*) printf '%s' '${REPO_VIEW}'; exit 0 ;;`,
        "  *'pr view'*)",
        `    count=$(cat ${prCount} 2>/dev/null || echo 0)`,
        "    count=$((count + 1))",
        `    printf '%s' "$count" > ${prCount}`,
        `    if [ "$count" -le 2 ]; then cat ${prA}; else cat ${prB}; fi`,
        "    exit 0",
        "    ;;",
        "  *'pr checks'*)",
        `    count=$(cat ${checksCount} 2>/dev/null || echo 0)`,
        "    count=$((count + 1))",
        `    printf '%s' "$count" > ${checksCount}`,
        `    cat ${checks}`,
        "    exit 0",
        "    ;;",
        `  *'reviewThreads'*) cat ${threads}; exit 0 ;;`,
        "  *'/issues/'*)",
        `    count=$(cat ${commentsCount} 2>/dev/null || echo 0)`,
        "    count=$((count + 1))",
        `    printf '%s' "$count" > ${commentsCount}`,
        `    if [ "$count" -eq 1 ]; then cat ${commentsA}; else cat ${commentsB}; fi`,
        "    exit 0",
        "    ;;",
        "esac",
        "printf '%s\\n' \"unexpected gh call: $*\" >&2",
        "exit 1",
      ].join("\n")
    );
    const repo = makeScratchRepo({
      branch: PR_42.headRefName,
      commit: false,
      prefix: "dobby-review-",
      track: scratchDirs,
    });
    const payload = payloadOf<WatchPayload & { pr: typeof PR_42 }>(
      await withPollInterval(0, () =>
        withStubPath(binDir, () =>
          run(
            [
              "pr",
              "watch",
              "--pr",
              "42",
              "--adapter",
              "greptile",
              "--await-review",
              "--deadline",
              "5",
              "--json",
            ],
            repo
          )
        )
      )
    );

    expect(payload.verdict).toBe("merge-ready");
    expect(payload.pr.headRefOid).toBe(PR_42_NEXT.headRefOid);
    expect(payload.summary?.reviewedHeadOid).toBe(PR_42_NEXT.headRefOid);
    expect(readFileSync(checksCount, "utf8")).toBe("2");
  });
});

describe("pr watch --await-review — nothing posted before the deadline", () => {
  it("verdicts open-unreviewed rather than waiting forever", async () => {
    const kit = harness(
      ghAnswers({
        comments: ISSUE_COMMENTS_HUMAN_ONLY,
        threads: NO_THREADS,
      })
    );
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(250, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "1",
          "--json",
        ])
      )
    );
    expect(payload.verdict).toBe("open-unreviewed");
  });
});

describe("pr watch --await-review — the build broke first", () => {
  it("stops at ci-failed instead of waiting for a review", async () => {
    const kit = harness(ghAnswers({ checks: CHECKS_FAILED }));
    const payload = payloadOf<WatchPayload>(
      await withPollInterval(0, () =>
        kit.run([
          "pr",
          "watch",
          "--pr",
          "42",
          "--await-review",
          "--deadline",
          "5",
          "--json",
        ])
      )
    );
    expect(payload.verdict).toBe("ci-failed");
  });
});

// ===========================================================================
// `pr watch` — nothing to watch
// ===========================================================================

describe("pr watch — a branch with no pull request", () => {
  let payload: WatchPayload;
  let exitCode: number;

  beforeAll(async () => {
    const kit = harness([
      { match: "repo view", stdout: REPO_VIEW },
      // gh's real answer on main / on a branch that has no PR.
      { exitCode: 1, stderr: "no pull requests found for branch\n" },
    ]);
    const result = await withPollInterval(0, () =>
      kit.run(["pr", "watch", "--json"])
    );
    ({ exitCode } = result);
    payload = payloadOf<WatchPayload>(result);
  });

  it("verdicts the watch skipped", () => {
    expect(payload.verdict).toBe("skipped");
  });

  it("succeeds — there is simply nothing to watch", () => {
    expect(exitCode).toBe(0);
  });
});
