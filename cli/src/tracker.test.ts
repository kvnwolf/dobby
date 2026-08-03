import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitIn,
  makeScratchRepo,
  mkStubBins,
  readStubLog,
  type StubResponse,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// The TRACKER surface — `dobby tracker info|search|create|close`, `dobby claim`
// and `dobby goal parse`: one backend-agnostic contract over three backends
// (`github` via the `gh` CLI, `linear` via a delegation descriptor, `local` via
// a `BACKLOG.md`), selected by `dobby.config.json#tracker` (absent → github).
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008): `tracker.ts`
// is never imported directly, so the module can be restructured freely as long
// as the COMMANDS behave.
//
// The ONE mocked boundary is `gh` (an external, network-bound CLI), stubbed as
// an executable on PATH — the repo's established stub-bin seam, which records
// every invocation's argv NUL-delimited and therefore byte-faithfully. `git` is
// REAL throughout (scratch repos), and `BACKLOG.md` is a REAL file in a scratch
// repo: the local backend has no boundary to mock.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - The `info` payload keys + values, the three backend names, the D8 rule
//    ("gh unavailable → degrade to local"), the exact `gh` invocations
//    (`issue list --state open --search <concept> --json number,title,url,
//    state,labels`, `issue create --title --label --body-file`, `issue close
//    <n> --reason "not planned"`, `issue edit <n> --add-assignee @me
//    --add-label status:in-progress`, `label create <role>` first), the local
//    line format `- [ ] <title> — <body> (<role>)`, the Linear descriptor ops
//    (`search`, `setState`+`Canceled`, `claim`+`In Progress`), the local claim
//    answer `{claimed:false, reason:'local'}` and the lifecycle links
//    `Closes #<n>` / `Fixes <team>-<n>` are SPEC LITERALS — the task spec and
//    `plugin/skills/backlog/references/trackers.md`, which the CLI mechanizes
//    verbatim.
//  - `add-csv-export` is the kit's own canonical slug example (scope
//    SKILL.md: "a few kebab-case words capturing the goal (e.g.
//    `add-csv-export`)"), and `worktree-<slug>` / `.claude/worktrees/<slug>/`
//    are the kit's literal collision surfaces (same file). Every colliding
//    branch/dir in these fixtures is one WE created with real git.
//  - Every issue payload a `gh` stub prints is the BOUNDARY's answer, written
//    here as a literal: the assertions say the CLI passes it through unchanged,
//    never that it recomputes it.
//  - The injection-shaped concept/title are literals we type; the recorded argv
//    is the shell's own evidence. A command built by string concatenation could
//    not reproduce them as ONE argv element — which is the whole point.
//
// PINNED BY THIS FILE (the spec names the payload's fields but not their exact
// shape; these tests fix the contract — see the test-author work log):
//  - `search` answers with a `results` ARRAY on the github/local backends.
//  - `create` answers `{number, url}` with `number` as a NUMBER (matching gh's
//    own `--json number` type), parsed off the issue URL gh prints.
//  - `goal parse` `id` is a STRING with no sigil (`"42"`, `"VON-123"`) — the
//    one shape both backends can carry.
//  - On the local backend a `close` id is matched against the line's TITLE
//    (local items have no ids), and marking = `- [ ]` → `- [x]`, rest verbatim.
//  - An ISSUE goal's slug starts from `issue-<n>` (github) / the kebab key
//    (linear) — a slug becomes a branch and a directory name, so a bare id
//    cannot stand in for one.
//  - `--body-file` is resolved against the CALLER's cwd (the CLI's path-flag
//    convention) and gh receives that ABSOLUTE path.
// ===========================================================================

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// --- Fixtures ---------------------------------------------------------------

// A throwaway repo carrying a `dobby.config.json` with (or without) a `tracker`
// key — the ONLY thing that selects the backend.
function makeRepo(
  tracker?: { team?: string; type: string },
  files?: Record<string, string>
): string {
  return makeScratchRepo({
    branch: "main",
    config: tracker === undefined ? { files: [] } : { files: [], tracker },
    files,
    prefix: "dobby-tracker-",
    track: scratchDirs,
  });
}

const GITHUB_TRACKER = { type: "github" };
const LINEAR_TRACKER = { team: "VON", type: "linear" };
const LOCAL_TRACKER = { type: "local" };

// The local backlog every "already has items" fixture starts from — written by
// hand in the format the spec mandates (`- [ ] <title> — <body> (<role>)`), so
// nothing here is derived the way the code derives it.
const SEEDED_BACKLOG = `- [ ] Export the reports table as CSV — Analysts ask for it weekly. (feature)
- [ ] Fix the login redirect loop — Sessions bounce on Safari. (bug)
- [x] Bump the Biome preset — Shipped last week. (chore)
`;

// The seeded item a concept search must find and a close must mark — its title
// is the whole line up to the em dash.
const SEEDED_TITLE = "Export the reports table as CSV";
const SEEDED_LINE =
  "- [ ] Export the reports table as CSV — Analysts ask for it weekly. (feature)";

// The backlog as its non-empty lines — the local backend's whole observable
// state, read back through the file the kit itself documents.
function backlogLines(repo: string): string[] {
  return readFileSync(join(repo, "BACKLOG.md"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

// --- The `gh` boundary ------------------------------------------------------
// Canned answers, matched FIRST-WINS on a literal substring of the joined argv.
// `issue create` sits ahead of `label create` so the two never cross-match.

// What `gh issue list --json number,title,url,state,labels` prints: the
// boundary's answer, verbatim.
const GH_ISSUES = [
  {
    labels: [{ name: "feature" }],
    number: 7,
    state: "OPEN",
    title: "CSV export is missing",
    url: "https://github.com/acme/scratch/issues/7",
  },
  {
    labels: [],
    number: 9,
    state: "OPEN",
    title: "Reports page is slow",
    url: "https://github.com/acme/scratch/issues/9",
  },
];

// `gh issue create` prints the new issue's URL on stdout — the only place its
// number can come from.
const CREATED_ISSUE_URL = "https://github.com/acme/scratch/issues/42";
const CREATED_ISSUE_NUMBER = 42;

const GH_AUTH_OK: StubResponse = {
  match: "auth status",
  stderr: "github.com\n  ✓ Logged in to github.com account dobby-test\n",
};

const GH_AUTH_FAILING: StubResponse = {
  exitCode: 1,
  match: "auth status",
  stderr:
    "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
};

// Everything except the auth probe. `label create` answers gh's REAL
// non-idempotent failure for an existing label (the case the command must
// swallow); `issue close`/`issue edit` fall through to the silent catch-all.
const GH_OPERATIONS: StubResponse[] = [
  { match: "issue list", stdout: JSON.stringify(GH_ISSUES) },
  { match: "issue create", stdout: `${CREATED_ISSUE_URL}\n` },
  {
    match: "issue view",
    stdout: JSON.stringify({
      number: 42,
      state: "OPEN",
      title: "CSV export is missing",
      url: CREATED_ISSUE_URL,
    }),
  },
  {
    match: "repo view",
    stdout: JSON.stringify({
      nameWithOwner: "acme/scratch",
      url: "https://github.com/acme/scratch",
    }),
  },
  {
    exitCode: 1,
    match: "label create",
    stderr: "GraphQL: Name has already been taken (createLabel)\n",
  },
];

const GH_AVAILABLE: StubResponse[] = [GH_AUTH_OK, ...GH_OPERATIONS];
const GH_UNAVAILABLE: StubResponse[] = [GH_AUTH_FAILING, ...GH_OPERATIONS];

// --- The command seam -------------------------------------------------------

interface CommandRun {
  exitCode: number;
  ghArgv: string[][];
  stderr: string;
  stdout: string;
}

// Run one command with a FRESH `gh` stub (so its log holds only this
// invocation's calls) and hand back both the outcome and what `gh` was asked.
async function trackerRun(
  repo: string,
  argv: string[],
  gh: StubResponse[] = GH_AVAILABLE
): Promise<CommandRun> {
  const binDir = mkStubBins({ gh }, scratchDirs);
  const result = await withStubPath(binDir, () => run(argv, repo));
  return { ...result, ghArgv: readStubLog(binDir, "gh") };
}

// The same, parsing the `--json` payload: one JSON line is the ONLY stdout (the
// CLI's established `--json` contract), so a parse failure means it never came.
async function trackerJson<T>(
  repo: string,
  argv: string[],
  gh: StubResponse[] = GH_AVAILABLE
): Promise<{ exitCode: number; ghArgv: string[][]; payload: T }> {
  const result = await trackerRun(repo, argv, gh);
  let payload: T;
  try {
    payload = JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      `${argv.join(" ")} produced no --json payload — stdout: ${JSON.stringify(result.stdout)}, stderr: ${result.stderr.trim()}`,
      { cause: error }
    );
  }
  return { exitCode: result.exitCode, ghArgv: result.ghArgv, payload };
}

// The FIRST recorded `gh` invocation starting with `head` (an availability
// probe may legitimately precede any of them, so nothing keys on position).
function ghCall(log: string[][], head: string[]): string[] | undefined {
  const index = ghCallIndex(log, head);
  return index === -1 ? undefined : log[index];
}

function ghCallIndex(log: string[][], head: string[]): number {
  return log.findIndex((argv) =>
    head.every((token, position) => argv[position] === token)
  );
}

// --- The payload shapes (the spec's field lists, nothing more) --------------

interface TrackerInfo {
  available: boolean | null;
  degradedTo: string | null;
  reason: string | null;
  team: string | null;
  type: string;
}

interface TrackerSearch {
  args?: { query?: string; team?: string };
  delegate?: string;
  op?: string;
  results?: unknown[];
}

interface TrackerCreate {
  number: number | null;
  url: string | null;
}

interface GoalParse {
  hardStop: string | null;
  id: string | null;
  lifecycleLink: string | null;
  slug: string;
  slugCollision: boolean;
  source: string;
  url: string | null;
}

type Descriptor = Record<string, unknown>;

// A degradation reason has to say WHICH tool could not be reached — that is the
// whole point of reporting one.
const GH_MENTION = /gh|github/i;

// ===========================================================================
// Slice 1 (tracer bullet) — `tracker info` resolves the backend from config.
//
// Everything else in this surface branches on the answer this command reports,
// so it comes first: read `dobby.config.json#tracker`, name the backend, and
// say whether it can be reached.
// ===========================================================================

describe("tracker info — the configured backend", () => {
  it("defaults to github when the config carries no tracker key", async () => {
    const { payload } = await trackerJson<TrackerInfo>(
      makeRepo(),
      ["tracker", "info", "--json"],
      GH_AVAILABLE
    );
    expect(payload).toEqual({
      available: true,
      degradedTo: null,
      reason: null,
      team: null,
      type: "github",
    });
  });

  it("degrades to local when gh is not authenticated (D8)", async () => {
    const { payload } = await trackerJson<TrackerInfo>(
      makeRepo(GITHUB_TRACKER),
      ["tracker", "info", "--json"],
      GH_UNAVAILABLE
    );
    expect(payload).toMatchObject({
      available: false,
      degradedTo: "local",
      type: "github",
    });
    expect(payload.reason).toMatch(GH_MENTION);
  });

  it("reports the linear team with availability unknown (it is MCP-side)", async () => {
    const { payload, ghArgv } = await trackerJson<TrackerInfo>(
      makeRepo(LINEAR_TRACKER),
      ["tracker", "info", "--json"]
    );
    expect(payload).toEqual({
      available: null,
      degradedTo: null,
      reason: null,
      team: "VON",
      type: "linear",
    });
    // A linear backend never spawns a tool — not even to answer `info`.
    expect(ghArgv).toEqual([]);
  });

  it("reports local as always available", async () => {
    const { payload } = await trackerJson<TrackerInfo>(
      makeRepo(LOCAL_TRACKER),
      ["tracker", "info", "--json"]
    );
    expect(payload).toEqual({
      available: true,
      degradedTo: null,
      reason: null,
      team: null,
      type: "local",
    });
  });
});

// ===========================================================================
// Slice 2 — `tracker search` carries the concept to the backend as DATA.
//
// The concept is user-derived text. Spawning gh with an ARGV ARRAY (no shell)
// is what retires the whole shell-hardening class: the concept lands as ONE
// argv element, whatever bytes it holds.
// ===========================================================================

// A concept carrying every metacharacter the old single-quote-binding prose
// existed to defend against: a quote that would close a binding, a command
// substitution, a backtick, a chained `&&`, and a trailing comment.
const INJECTION_CONCEPT = `csv export'; rm -rf "$HOME"; $(whoami) \`id\` && echo pwned #`;

const GH_SEARCH_ARGV = [
  "issue",
  "list",
  "--state",
  "open",
  "--search",
  "csv export",
  "--json",
  "number,title,url,state,labels",
];

describe("tracker search — the concept reaches the backend", () => {
  it("asks gh for open issues matching the concept", async () => {
    const { ghArgv } = await trackerJson<TrackerSearch>(makeRepo(), [
      "tracker",
      "search",
      "csv export",
      "--json",
    ]);
    expect(ghCall(ghArgv, ["issue", "list"])).toEqual(GH_SEARCH_ARGV);
  });

  it("passes an injection-shaped concept through as ONE argv element", async () => {
    const { ghArgv } = await trackerJson<TrackerSearch>(makeRepo(), [
      "tracker",
      "search",
      INJECTION_CONCEPT,
      "--json",
    ]);
    expect(ghCall(ghArgv, ["issue", "list"])).toEqual([
      ...GH_SEARCH_ARGV.slice(0, 5),
      INJECTION_CONCEPT,
      ...GH_SEARCH_ARGV.slice(6),
    ]);
  });

  it("answers with the issues gh returned, unchanged", async () => {
    const { payload } = await trackerJson<TrackerSearch>(makeRepo(), [
      "tracker",
      "search",
      "csv export",
      "--json",
    ]);
    expect(payload.results).toEqual(GH_ISSUES);
  });

  it("delegates a linear search to the MCP instead of spawning anything", async () => {
    const { payload, ghArgv } = await trackerJson<TrackerSearch>(
      makeRepo(LINEAR_TRACKER),
      ["tracker", "search", "csv export", "--json"]
    );
    expect(payload).toMatchObject({
      args: { query: "csv export", team: "VON" },
      delegate: "mcp",
      op: "search",
    });
    expect(ghArgv).toEqual([]);
  });

  it("scans BACKLOG.md for the concept on the local backend", async () => {
    const repo = makeRepo(LOCAL_TRACKER, { "BACKLOG.md": SEEDED_BACKLOG });
    const { payload } = await trackerJson<TrackerSearch>(repo, [
      "tracker",
      "search",
      "CSV",
      "--json",
    ]);
    expect(payload.results).toHaveLength(1);
    expect(JSON.stringify(payload.results)).toContain(SEEDED_TITLE);
  });

  it("finds nothing when the local backlog does not exist yet", async () => {
    const { payload } = await trackerJson<TrackerSearch>(
      makeRepo(LOCAL_TRACKER),
      ["tracker", "search", "CSV", "--json"]
    );
    expect(payload.results).toEqual([]);
  });
});

// ===========================================================================
// Slice 3 — `tracker create` opens a role-labelled item.
//
// The role labels (`bug`/`feature`/`chore`/`docs`) are the same on every
// backend, and github needs the label to EXIST before the issue references it.
// The body never passes through a shell: it is handed over as a FILE.
// ===========================================================================

const CREATE_TITLE = "Add CSV export";
const CREATE_BODY =
  "Users need a CSV download on the reports page.\nSecond paragraph, not part of the local line.\n";
const CREATE_LINE =
  "- [ ] Add CSV export — Users need a CSV download on the reports page. (feature)";

// A title carrying the same metacharacters as the injection concept: a title is
// user-derived text too, and it must reach gh as one argv element.
const INJECTION_TITLE = `Add CSV export'; rm -rf "$HOME" && echo pwned #`;

// A repo whose body file is on disk, plus that file's absolute path.
function makeCreateRepo(tracker?: { team?: string; type: string }): {
  bodyFile: string;
  repo: string;
} {
  const repo = makeRepo(tracker, { "body.md": CREATE_BODY });
  return { bodyFile: join(repo, "body.md"), repo };
}

function createArgv(bodyFile: string, title = CREATE_TITLE): string[] {
  return [
    "tracker",
    "create",
    "--title",
    title,
    "--body-file",
    bodyFile,
    "--label",
    "feature",
    "--json",
  ];
}

describe("tracker create — the role-labelled item", () => {
  it("ensures the role label before creating the issue", async () => {
    const { bodyFile, repo } = makeCreateRepo();
    const { ghArgv } = await trackerJson<TrackerCreate>(
      repo,
      createArgv(bodyFile)
    );
    const labelAt = ghCallIndex(ghArgv, ["label", "create", "feature"]);
    const createAt = ghCallIndex(ghArgv, ["issue", "create"]);
    expect(labelAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(labelAt);
  });

  it("succeeds although `gh label create` fails on the existing label", async () => {
    const { bodyFile, repo } = makeCreateRepo();
    const { exitCode, payload } = await trackerJson<TrackerCreate>(
      repo,
      createArgv(bodyFile)
    );
    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      number: CREATED_ISSUE_NUMBER,
      url: CREATED_ISSUE_URL,
    });
  });

  it("hands gh the title verbatim and the body out-of-band as a file", async () => {
    const { bodyFile, repo } = makeCreateRepo();
    const { ghArgv } = await trackerJson<TrackerCreate>(
      repo,
      createArgv(bodyFile, INJECTION_TITLE)
    );
    expect(ghCall(ghArgv, ["issue", "create"])).toEqual([
      "issue",
      "create",
      "--title",
      INJECTION_TITLE,
      "--label",
      "feature",
      "--body-file",
      bodyFile,
    ]);
  });

  it("delegates a linear create to the MCP instead of spawning anything", async () => {
    const { bodyFile, repo } = makeCreateRepo(LINEAR_TRACKER);
    const { payload, ghArgv } = await trackerJson<Descriptor>(
      repo,
      createArgv(bodyFile)
    );
    expect(payload).toMatchObject({ delegate: "mcp", op: "create" });
    expect(JSON.stringify(payload)).toContain(CREATE_TITLE);
    expect(ghArgv).toEqual([]);
  });

  it("appends the checklist line to a lazily created BACKLOG.md", async () => {
    const { bodyFile, repo } = makeCreateRepo(LOCAL_TRACKER);
    expect(existsSync(join(repo, "BACKLOG.md"))).toBe(false);
    await trackerJson<Descriptor>(repo, createArgv(bodyFile));
    expect(backlogLines(repo)).toContain(CREATE_LINE);
  });

  it("keeps the local backlog's existing items when appending", async () => {
    const repo = makeRepo(LOCAL_TRACKER, {
      "BACKLOG.md": SEEDED_BACKLOG,
      "body.md": CREATE_BODY,
    });
    await trackerJson<Descriptor>(repo, createArgv(join(repo, "body.md")));
    const lines = backlogLines(repo);
    expect(lines.slice(0, 3)).toEqual(SEEDED_BACKLOG.trim().split("\n"));
    expect(lines.at(-1)).toBe(CREATE_LINE);
  });
});

// `--body-file` is a PATH FLAG, and every path flag in this CLI means what the
// CALLER meant by it: it is resolved against the caller's directory (the
// `ship --message-file` / `kb record --reason-file` convention), not against the
// workroot every spawn is pinned to. The two only differ when dobby runs from a
// subdirectory — which is exactly when reading the wrong file would open an
// issue from content nobody wrote.
describe("tracker create — a relative --body-file", () => {
  it("hands gh the caller's file, resolved to an absolute path", async () => {
    const repo = makeRepo(undefined, { "body.md": CREATE_BODY });
    const { ghArgv } = await trackerJson<TrackerCreate>(
      repo,
      createArgv("body.md")
    );
    expect(ghCall(ghArgv, ["issue", "create"])).toEqual([
      "issue",
      "create",
      "--title",
      CREATE_TITLE,
      "--label",
      "feature",
      "--body-file",
      join(repo, "body.md"),
    ]);
  });

  it("reads it from the subdirectory the caller ran in", async () => {
    // The body file exists ONLY under `sub/`, so an item carrying its first
    // line proves the read followed the caller — while the backlog itself still
    // lands at the WORKROOT, which is what storage is pinned to.
    const repo = makeRepo(LOCAL_TRACKER, { "sub/body.md": CREATE_BODY });
    const { exitCode } = await trackerJson<TrackerCreate>(
      join(repo, "sub"),
      createArgv("body.md")
    );
    expect(exitCode).toBe(0);
    expect(backlogLines(repo)).toContain(CREATE_LINE);
  });
});

// ===========================================================================
// Slice 4 — `tracker close --rejected` rejects a goal without building it.
// ===========================================================================

describe("tracker close — rejecting a goal", () => {
  it("closes the github issue as not planned", async () => {
    const { ghArgv } = await trackerJson<Descriptor>(makeRepo(), [
      "tracker",
      "close",
      "42",
      "--rejected",
      "--json",
    ]);
    expect(ghCall(ghArgv, ["issue", "close"])).toEqual([
      "issue",
      "close",
      "42",
      "--reason",
      "not planned",
    ]);
  });

  it("delegates a linear rejection as a Canceled state change", async () => {
    const { payload, ghArgv } = await trackerJson<Descriptor>(
      makeRepo(LINEAR_TRACKER),
      ["tracker", "close", "VON-123", "--rejected", "--json"]
    );
    expect(payload).toMatchObject({ delegate: "mcp", op: "setState" });
    const descriptor = JSON.stringify(payload);
    expect(descriptor).toContain("Canceled");
    expect(descriptor).toContain("VON-123");
    expect(ghArgv).toEqual([]);
  });

  it("marks the matching local backlog line done, leaving the rest verbatim", async () => {
    const repo = makeRepo(LOCAL_TRACKER, { "BACKLOG.md": SEEDED_BACKLOG });
    await trackerJson<Descriptor>(repo, [
      "tracker",
      "close",
      SEEDED_TITLE,
      "--rejected",
      "--json",
    ]);
    const [, second, third] = SEEDED_BACKLOG.trim().split("\n");
    // The closed item keeps every byte but its checkbox; its neighbours are
    // untouched — a rejection may never rewrite the rest of the backlog.
    expect(backlogLines(repo)).toEqual([
      SEEDED_LINE.replace("- [ ]", "- [x]"),
      second,
      third,
    ]);
  });
});

// `--rejected` is REQUIRED, not decorative: this command only ever closes an
// issue AS REJECTED (a completed goal is closed by its merged PR's lifecycle
// link). Accepting the close without it would be the silently-dropped-flag
// footgun — so the refusal is part of the contract, and it closes NOTHING.
describe("tracker close — the refusals", () => {
  it("refuses a close without --rejected, closing nothing", async () => {
    const result = await trackerRun(makeRepo(), [
      "tracker",
      "close",
      "42",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/--rejected/);
    expect(ghCall(result.ghArgv, ["issue", "close"])).toBeUndefined();
  });

  it("refuses a local close when there is no BACKLOG.md at all", async () => {
    const repo = makeRepo(LOCAL_TRACKER);
    const result = await trackerRun(repo, [
      "tracker",
      "close",
      SEEDED_TITLE,
      "--rejected",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/BACKLOG\.md/);
    // A refusal never leaves the storage it refused to touch behind.
    expect(existsSync(join(repo, "BACKLOG.md"))).toBe(false);
  });

  it("refuses a local close when no open item matches, leaving the file byte-identical", async () => {
    const repo = makeRepo(LOCAL_TRACKER, { "BACKLOG.md": SEEDED_BACKLOG });
    const result = await trackerRun(repo, [
      "tracker",
      "close",
      "Rewrite the billing engine",
      "--rejected",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(readFileSync(join(repo, "BACKLOG.md"), "utf8")).toBe(SEEDED_BACKLOG);
  });
});

// ===========================================================================
// Slice 5 — `claim`: the backlog → work handshake.
//
// On github the label must EXIST before the edit references it: on a fresh repo
// an unknown label makes `gh issue edit` fail outright and the in-progress
// signal is silently lost. On linear this is the kit's ONLY state write besides
// Canceled. Local has no state machine at all.
// ===========================================================================

describe("claim — taking an issue", () => {
  it("creates the status label before assigning the github issue", async () => {
    const { ghArgv } = await trackerJson<Descriptor>(makeRepo(), [
      "claim",
      "42",
      "--json",
    ]);
    const labelAt = ghCallIndex(ghArgv, [
      "label",
      "create",
      "status:in-progress",
    ]);
    const editAt = ghCallIndex(ghArgv, ["issue", "edit"]);
    expect(labelAt).toBeGreaterThanOrEqual(0);
    expect(editAt).toBeGreaterThan(labelAt);
  });

  it("assigns the github issue to me and labels it in progress", async () => {
    const { ghArgv } = await trackerJson<Descriptor>(makeRepo(), [
      "claim",
      "42",
      "--json",
    ]);
    expect(ghCall(ghArgv, ["issue", "edit"])).toEqual([
      "issue",
      "edit",
      "42",
      "--add-assignee",
      "@me",
      "--add-label",
      "status:in-progress",
    ]);
  });

  it("delegates a linear claim as assignee + In Progress", async () => {
    const { payload, ghArgv } = await trackerJson<Descriptor>(
      makeRepo(LINEAR_TRACKER),
      ["claim", "VON-123", "--json"]
    );
    expect(payload).toMatchObject({
      assignee: "me",
      delegate: "mcp",
      op: "claim",
      state: "In Progress",
    });
    expect(ghArgv).toEqual([]);
  });

  it("is a no-op on the local backend, which has no state machine", async () => {
    const { exitCode, payload, ghArgv } = await trackerJson<Descriptor>(
      makeRepo(LOCAL_TRACKER),
      ["claim", "Add CSV export", "--json"]
    );
    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({ claimed: false, reason: "local" });
    expect(ghArgv).toEqual([]);
  });
});

// ===========================================================================
// Cross-cutting — a gh call that FAILS.
//
// "Degradation is REPORTED, never performed" only holds if a broken backend is
// a failure: an answer of `results: []` / `{number:null}` / `{closed:true}`
// would read to every caller as "nothing tracked" / "done", and a silent
// re-route into a BACKLOG.md write nobody asked for is the other half of the
// same bug. So: exit 1, NOTHING on stdout, and gh's own words carried through.
// (This is a different failure from the label-create nonzero the create/claim
// paths deliberately swallow — that one is gh's non-idempotent success.)
// ===========================================================================

// What gh says when a call fails for real — a boundary answer, written here as
// a literal.
const GH_API_ERROR = "HTTP 502: Bad gateway (https://api.github.com/graphql)\n";
const GH_API_ERROR_CODE = "502";

// The gh boundary with ONE operation broken: first-wins matching puts the
// failure ahead of the canned success for the same verb, so everything else
// (the auth probe included) still answers normally.
function ghBroken(operation: string): StubResponse[] {
  return [
    GH_AUTH_OK,
    { exitCode: 1, match: operation, stderr: GH_API_ERROR },
    ...GH_OPERATIONS,
  ];
}

describe("a failing gh call — never a successful empty answer", () => {
  it("fails the search instead of reporting nothing tracked", async () => {
    const repo = makeRepo();
    const result = await trackerRun(
      repo,
      ["tracker", "search", "csv export", "--json"],
      ghBroken("issue list")
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(GH_API_ERROR_CODE);
    // …and never quietly falls back to the local recipe.
    expect(existsSync(join(repo, "BACKLOG.md"))).toBe(false);
  });

  it("fails the create instead of answering a null issue", async () => {
    const { bodyFile, repo } = makeCreateRepo();
    const result = await trackerRun(
      repo,
      createArgv(bodyFile),
      ghBroken("issue create")
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(GH_API_ERROR_CODE);
    expect(existsSync(join(repo, "BACKLOG.md"))).toBe(false);
  });

  it("fails the close instead of reporting the issue closed", async () => {
    const result = await trackerRun(
      makeRepo(),
      ["tracker", "close", "42", "--rejected", "--json"],
      ghBroken("issue close")
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(GH_API_ERROR_CODE);
  });

  it("fails the claim instead of reporting the issue claimed", async () => {
    const result = await trackerRun(
      makeRepo(),
      ["claim", "42", "--json"],
      ghBroken("issue edit")
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(GH_API_ERROR_CODE);
  });
});

// ===========================================================================
// Slice 6 — `goal parse`: what kind of goal is this, and what will close it.
//
// The pattern set is GATED by the configured tracker, so there is never a
// cross-pattern ambiguity: a github project reads `#42` and never `VON-123`, a
// linear project reads `VON-123` and never `#42`, and anything else is a free
// -text prompt. The lifecycle link is emitted HERE so commit/scope never
// re-derive it.
// ===========================================================================

const GITHUB_ISSUE_URL = "https://github.com/acme/scratch/issues/42";
const LINEAR_ISSUE_URL =
  "https://linear.app/acme/issue/VON-123/csv-export-is-missing";

async function goalParse(
  repo: string,
  argument: string,
  gh: StubResponse[] = GH_AVAILABLE
): Promise<GoalParse> {
  const { exitCode, payload } = await trackerJson<GoalParse>(
    repo,
    ["goal", "parse", argument, "--json"],
    gh
  );
  expect(exitCode).toBe(0);
  return payload;
}

describe("goal parse — a free-text goal", () => {
  it("reads free text as a prompt goal with a kebab slug and no lifecycle link", async () => {
    const payload = await goalParse(makeRepo(), "add CSV export");
    expect(payload).toEqual({
      hardStop: null,
      id: null,
      lifecycleLink: null,
      slug: "add-csv-export",
      slugCollision: false,
      source: "prompt",
      url: null,
    });
  });

  it("normalizes case and punctuation into the slug", async () => {
    const payload = await goalParse(makeRepo(), "Add CSV export!");
    expect(payload.slug).toBe("add-csv-export");
  });

  it("flags a slug collision when the goal's branch already exists", async () => {
    const repo = makeRepo();
    gitIn(repo, ["branch", "worktree-add-csv-export"]);
    const payload = await goalParse(repo, "add CSV export");
    expect(payload.slugCollision).toBe(true);
  });

  it("flags a slug collision when the goal's worktree directory already exists", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".claude", "worktrees", "add-csv-export"), {
      recursive: true,
    });
    const payload = await goalParse(repo, "add CSV export");
    expect(payload.slugCollision).toBe(true);
  });
});

describe("goal parse — the configured tracker's issue patterns", () => {
  it("reads #42 as a github issue and emits its closing keyword", async () => {
    const payload = await goalParse(makeRepo(GITHUB_TRACKER), "#42");
    expect(payload).toMatchObject({
      hardStop: null,
      id: "42",
      lifecycleLink: "Closes #42",
      source: "github",
    });
  });

  it("reads a github issue URL as that issue", async () => {
    const payload = await goalParse(makeRepo(), GITHUB_ISSUE_URL);
    expect(payload).toMatchObject({
      id: "42",
      lifecycleLink: "Closes #42",
      source: "github",
      url: GITHUB_ISSUE_URL,
    });
  });

  it("never reads a Linear key on a github project", async () => {
    const payload = await goalParse(makeRepo(GITHUB_TRACKER), "VON-123");
    expect(payload).toMatchObject({ lifecycleLink: null, source: "prompt" });
  });

  it("reads VON-123 as a linear issue and emits its fixing keyword", async () => {
    const payload = await goalParse(makeRepo(LINEAR_TRACKER), "VON-123");
    expect(payload).toMatchObject({
      hardStop: null,
      id: "VON-123",
      lifecycleLink: "Fixes VON-123",
      source: "linear",
    });
  });

  it("reads a linear.app issue URL as that issue", async () => {
    const payload = await goalParse(makeRepo(LINEAR_TRACKER), LINEAR_ISSUE_URL);
    expect(payload).toMatchObject({
      id: "VON-123",
      lifecycleLink: "Fixes VON-123",
      source: "linear",
      url: LINEAR_ISSUE_URL,
    });
  });

  it("never reads a #number on a linear project", async () => {
    const payload = await goalParse(makeRepo(LINEAR_TRACKER), "#42");
    expect(payload).toMatchObject({ lifecycleLink: null, source: "prompt" });
  });

  it("has no issue pattern at all on the local backend", async () => {
    const payload = await goalParse(makeRepo(LOCAL_TRACKER), "#42");
    expect(payload).toMatchObject({ lifecycleLink: null, source: "prompt" });
  });
});

// The slug becomes a BRANCH name (`worktree-<slug>`) and a DIRECTORY name, so an
// issue goal cannot start from its bare id: a github goal starts from
// `issue-<n>` and a linear goal from its key, kebab-cased like every other slug
// (the contract cli/CONTEXT.md states for `goal parse`).
describe("goal parse — the slug an issue goal starts from", () => {
  it("starts a github issue goal from issue-<n>", async () => {
    const payload = await goalParse(makeRepo(GITHUB_TRACKER), "#42");
    expect(payload.slug).toBe("issue-42");
  });

  it("starts a github issue URL goal from that same issue-<n>", async () => {
    const payload = await goalParse(makeRepo(), GITHUB_ISSUE_URL);
    expect(payload.slug).toBe("issue-42");
  });

  it("starts a linear issue goal from its kebab key", async () => {
    const payload = await goalParse(makeRepo(LINEAR_TRACKER), "VON-123");
    expect(payload.slug).toBe("von-123");
  });

  it("starts a linear issue URL goal from that same key", async () => {
    const payload = await goalParse(makeRepo(LINEAR_TRACKER), LINEAR_ISSUE_URL);
    expect(payload.slug).toBe("von-123");
  });
});

describe("goal parse — an issue that cannot be read (D8)", () => {
  it("hard-stops on a github issue goal while gh is unavailable", async () => {
    const payload = await goalParse(
      makeRepo(GITHUB_TRACKER),
      "#42",
      GH_UNAVAILABLE
    );
    expect(payload.hardStop).toBeTruthy();
  });

  it("still parses a free-text goal while gh is unavailable", async () => {
    const payload = await goalParse(
      makeRepo(GITHUB_TRACKER),
      "add CSV export",
      GH_UNAVAILABLE
    );
    expect(payload).toMatchObject({
      hardStop: null,
      slug: "add-csv-export",
      source: "prompt",
    });
  });
});

// ===========================================================================
// Slice 7 — the operand every one of these commands needs.
//
// Each of them acts ON something (a concept, an issue id, a goal). Missing it
// is a caller error, not an empty answer: exit 1, NOTHING on stdout (so no
// consumer can mistake silence for a result), and a message that NAMES what is
// missing — the CLI's established rejection style, which names the offending
// flag and the command rather than just failing.
// ===========================================================================

const MENTIONS_CONCEPT = /concept/i;
const MENTIONS_ISSUE_ID = /issue|\bid\b/i;
// `goal` alone is the command's own name — the message has to say more than
// that: which operation wants an operand, or what kind of goal it wanted.
const MENTIONS_GOAL = /goal parse|reference|prompt/i;
const MENTIONS_TITLE = /--title/;
const MENTIONS_BODY_FILE = /--body-file|body file/i;

const missingOperand = [
  {
    argv: ["tracker", "search", "--json"],
    label: "tracker search",
    mentions: MENTIONS_CONCEPT,
  },
  {
    argv: ["tracker", "close", "--rejected", "--json"],
    label: "tracker close",
    mentions: MENTIONS_ISSUE_ID,
  },
  { argv: ["claim", "--json"], label: "claim", mentions: MENTIONS_ISSUE_ID },
  {
    argv: ["goal", "parse", "--json"],
    label: "goal parse",
    mentions: MENTIONS_GOAL,
  },
];

describe("the required operand", () => {
  it.each(missingOperand)(
    "$label without its operand fails, naming what is missing",
    async ({ argv, mentions }) => {
      const result = await trackerRun(makeRepo(), argv);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(mentions);
    }
  );
});

// `tracker create` states its operands as flags — a missing `--title` is the
// same caller error, and nothing may be opened without one.
describe("tracker create — the required title", () => {
  it("fails without --title, creating no backlog item", async () => {
    const repo = makeRepo(LOCAL_TRACKER, { "body.md": CREATE_BODY });
    const result = await trackerRun(repo, [
      "tracker",
      "create",
      "--body-file",
      join(repo, "body.md"),
      "--label",
      "feature",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(MENTIONS_TITLE);
    expect(existsSync(join(repo, "BACKLOG.md"))).toBe(false);
  });
});

// A body file the caller named but never wrote is likewise a caller error, not
// an item opened with an empty body.
describe("tracker create — an unreadable body file", () => {
  it("fails when --body-file does not exist, creating no backlog item", async () => {
    const repo = makeRepo(LOCAL_TRACKER);
    const result = await trackerRun(
      repo,
      createArgv(join(repo, "missing-body.md"))
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(MENTIONS_BODY_FILE);
    expect(existsSync(join(repo, "BACKLOG.md"))).toBe(false);
  });
});
