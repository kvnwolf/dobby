import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// `dobby ship` — the COMMIT CEREMONY with the in-process gate.
//
// One command performs the whole sequence a human (or `/dobby:commit`) used to
// drive by hand: stage → run the GATE (`check(fix: true)`) → re-stage the gate's
// own fixes → commit from a message file → push → open the PR. The exit code
// decides; ship never interprets findings.
//
// THE SEAM is the in-process `run(argv, cwd)` contract (ADR-0008): `ship.ts` is
// never imported here, so its internals can be restructured freely without
// touching this file. Every assertion reads the OUTCOME — the JSON payload on
// stdout, plus the state of a real git repository observed through `git` itself.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (never from the implementation):
//  - The COMMIT MESSAGE, the fixture sources, and the gate-failing file names are
//    literals THIS file writes; git is then asked, independently, what it
//    recorded (`git log -1 --pretty=%B`, `git ls-tree`, `git show HEAD:<path>`).
//  - `sha` is cross-checked against `git rev-parse HEAD`, and the gate cache's
//    `treeHash` against `git rev-parse HEAD^{tree}` — git computes both, dobby
//    does not. That equality IS the anti-cache-poisoning contract: `git write-tree`
//    only equals the committed tree when it ran AFTER `git add -A`.
//  - `pushed` is cross-checked against the BARE REMOTE's own ref, read out of the
//    remote repository — the effect, not the report.
//  - `dobbyVersion` is cross-checked against `dobby --version`, an unrelated public
//    surface of the same CLI.
//  - `configHash` is the sha256 of the fixture's `dobby.config.json` bytes,
//    computed OUT OF BAND with `shasum -a 256` and pasted here as a literal.
//  - The formatted text `export const sum = (a: number, b: number) => a + b;` is
//    Biome's canonical formatting — the way the line is conventionally written.
//  - `prUrl` is exactly what the stub `gh` printed: the assertion is that the
//    external boundary's answer is passed THROUGH.
//
// MOCKED BOUNDARIES: `gh` only (an external API over the network), stubbed as an
// executable on PATH — the repo's established stub-bin seam. `git` is REAL
// throughout, including a real bare repository standing in for `origin`, so
// "committed" and "pushed" are facts of a repository rather than claims.
// ===========================================================================

const scratchDirs: string[] = [];

// --- The fixture project ----------------------------------------------------
// A minimal repo the inferred gate (biome + tsc + knip) passes cleanly. Every
// manifest is written PRE-FORMATTED in Biome's own style (tab indent, inline
// arrays) so `--fix` is a no-op on them: the ONLY formatter mutation in any
// fixture is the one a test deliberately asks for.

const PACKAGE_JSON = '{\n\t"name": "ship-fixture",\n\t"private": true\n}\n';

const KNIP_JSON =
  '{\n\t"entry": ["src/**/*.ts"],\n\t"project": ["src/**/*.ts"]\n}\n';

const TSCONFIG_JSON =
  '{\n\t"compilerOptions": {\n\t\t"module": "esnext",\n\t\t"moduleResolution": "bundler",\n\t\t"noEmit": true,\n\t\t"skipLibCheck": true,\n\t\t"strict": true,\n\t\t"target": "esnext"\n\t},\n\t"include": ["src"]\n}\n';

// The kit's own per-project contract. Its EXACT bytes are the input to the gate
// cache's `configHash`, so they are pinned here and hashed out of band.
const DOBBY_CONFIG = '{\n\t"files": []\n}\n';

// `printf '{\n\t"files": []\n}\n' | shasum -a 256` — an independent tool, not a
// value recomputed the way the CLI computes it.
const DOBBY_CONFIG_SHA256 =
  "b35a5c252e345c216527bfa100d0b1d19988398d06fdb7838c756b6c80aaa9de";

const BASE_FILES: Record<string, string> = {
  // `.dobby/` is the CLI's machine-state home; the gate cache lands there and must
  // be invisible to git (an un-ignored cache would invalidate its own tree key).
  ".gitignore": ".dobby/\n",
  "knip.json": KNIP_JSON,
  "src/report.ts": "export const answer = 42;\n",
  "tsconfig.json": TSCONFIG_JSON,
};

// The commit message ship must transcribe VERBATIM into the commit.
const COMMIT_MESSAGE =
  "feat(report): add CSV export to the report view\n\nThe report view can now hand its rows to a CSV download.\n";

const PR_BODY = "## Summary\n\nAdds CSV export.\n";

// --- The `gh` boundary ------------------------------------------------------
// The two states GitHub can be in for a branch. `gh pr view` exiting 1 with "no
// pull requests found" is gh's REAL behaviour for a branch that has none; `gh pr
// create` printing the new PR's URL on stdout is gh's real success output.

const PR_URL_CREATED = "https://github.com/acme/scratch/pull/42";
const PR_URL_EXISTING = "https://github.com/acme/scratch/pull/7";

// Nothing on GitHub yet: a view finds no PR, a create succeeds.
const GH_NO_PR: StubResponse[] = [
  { match: "pr create", stdout: `${PR_URL_CREATED}\n` },
  { exitCode: 1, stderr: "no pull requests found for branch\n" },
];

// The branch whose pull request is already open on GitHub.
const EXISTING_PR_BRANCH = "worktree-has-pr";

// A PR is already open for THAT branch: the view answers with it, a view of any
// OTHER branch gets gh's real "no pull requests found", and a create fails the way
// gh really fails when one exists. Keyed on the branch NAME so a ship that asked
// about the wrong branch cannot be handed the right answer — it would fall to the
// no-PR catch-all, try to create, fail, and report `prUrl: null`.
const GH_EXISTING_PR: StubResponse[] = [
  {
    match: ["pr view", EXISTING_PR_BRANCH],
    stdout: `${JSON.stringify({ url: PR_URL_EXISTING })}\n`,
  },
  {
    exitCode: 1,
    match: "pr create",
    stderr: "a pull request for branch already exists\n",
  },
  { exitCode: 1, stderr: "no pull requests found for branch\n" },
];

// --- Fixture plumbing -------------------------------------------------------

interface ShipRepo {
  branch: string;
  // The bare repository standing in for `origin`.
  remote: string;
  root: string;
}

// A file OUTSIDE any repo. Message and PR-body files live outside on purpose:
// ship stages the whole tree, so a message file inside the repo would end up in
// the very commit it describes.
function writeExternalFile(name: string, content: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-ship-files-")));
  scratchDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function writeInRepo(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// A throwaway repo shaped like a real dobby project: the fixture app committed on
// a known branch, a bare `origin`, and REPO-LOCAL git settings (identity, no
// signing, no hooks) — ship's own `git` spawns inherit the ambient environment,
// so the repo itself has to be committable on any machine.
//
// `pending` is written AFTER the baseline commit and left UNSTAGED: a commit
// ceremony with nothing to commit is not a ceremony.
function makeShipRepo(
  opts: {
    branch?: string;
    config?: string;
    pending?: Record<string, string>;
    stage?: string[];
    upstream?: boolean;
  } = {}
): ShipRepo {
  const branch = opts.branch ?? "worktree-add-csv-export";
  const root = makeScratchRepo({
    branch,
    config: opts.config,
    files: BASE_FILES,
    pkg: PACKAGE_JSON,
    prefix: "dobby-ship-",
    track: scratchDirs,
  });
  const settings: Record<string, string> = {
    "commit.gpgsign": "false",
    "core.hooksPath": join(root, ".git", "no-hooks"),
    "push.autoSetupRemote": "false",
    "push.default": "simple",
    "user.email": "test@dobby.invalid",
    "user.name": "dobby-test",
  };
  for (const [key, value] of Object.entries(settings)) {
    gitIn(root, ["config", key, value]);
  }

  const remote = realpathSync(
    mkdtempSync(join(tmpdir(), "dobby-ship-remote-"))
  );
  scratchDirs.push(remote);
  gitIn(remote, ["init", "-q", "--bare"]);
  gitIn(root, ["remote", "add", "origin", remote]);
  if (opts.upstream === true) {
    gitIn(root, ["push", "-q", "-u", "origin", "HEAD"]);
  }

  for (const [relPath, content] of Object.entries(opts.pending ?? {})) {
    writeInRepo(root, relPath, content);
  }
  for (const relPath of opts.stage ?? []) {
    gitIn(root, ["add", relPath]);
  }
  return { branch, remote, root };
}

// --- Independent observers --------------------------------------------------

function headSha(root: string): string {
  return gitIn(root, ["rev-parse", "HEAD"]);
}

function headTree(root: string): string {
  return gitIn(root, ["rev-parse", "HEAD^{tree}"]);
}

function porcelain(root: string): string {
  return gitIn(root, ["status", "--porcelain"]);
}

// What `origin` actually received for the branch — read out of the bare
// repository, never off ship's own report. Null when the branch never arrived.
function remoteSha(repo: ShipRepo): string | null {
  try {
    return gitIn(repo.remote, ["rev-parse", `refs/heads/${repo.branch}`]);
  } catch {
    return null;
  }
}

// The branch's upstream, or null when it tracks nothing yet.
function upstreamOf(root: string): string | null {
  try {
    return gitIn(root, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
  } catch {
    return null;
  }
}

// --- The command under test -------------------------------------------------

interface ShipOutcome {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface ShipPayload {
  cacheWritten: boolean;
  committed: boolean;
  gateExitCode: number;
  prUrl: string | null;
  pushed: boolean;
  sha: string;
}

// The gate cache the pre-push backstop reads.
interface GateCache {
  at: string;
  configHash: string | null;
  dobbyVersion: string;
  exitCode: number;
  treeHash: string;
}

function shipArgs(messagePath: string, extra: string[] = []): string[] {
  return ["ship", "--message-file", messagePath, ...extra, "--json"];
}

// Every ship runs with the stub `gh` first on PATH, so a `gh` spawn can never
// reach the real GitHub — including the paths where ship must NOT touch gh at all.
function shipIn(
  repo: ShipRepo,
  ghDir: string,
  argv: string[]
): Promise<ShipOutcome> {
  return withStubPath(ghDir, () => run(argv, repo.root));
}

// The `--json` contract: the payload is the ONLY thing on stdout. A missing
// payload is reported with the command's own stderr so a red reads as the absent
// behaviour rather than as a parse error.
function shipPayload(outcome: ShipOutcome): ShipPayload {
  if (outcome.stdout.trim() === "") {
    throw new Error(
      `ship printed no JSON payload (exit ${outcome.exitCode}): ${outcome.stderr.trim()}`
    );
  }
  return JSON.parse(outcome.stdout) as ShipPayload;
}

function readGateCache(root: string): GateCache | null {
  const path = join(root, ".dobby", "gate-cache.json");
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as GateCache;
}

// The shared "nothing on GitHub" stub, for every slice that is not about PRs.
let ghNoPrDir: string;
let messageFile: string;
let prBodyFile: string;

beforeAll(() => {
  ghNoPrDir = mkStubBins({ gh: GH_NO_PR }, scratchDirs);
  messageFile = writeExternalFile("message.md", COMMIT_MESSAGE);
  prBodyFile = writeExternalFile("pr-body.md", PR_BODY);
});

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// ===========================================================================
// Slice 1 (tracer bullet) — the ceremony end to end on a green tree.
//
// One uncommitted change, a gate that passes, a message file: the whole point of
// the command is that this single call leaves a pushed commit behind. Everything
// after this slice pins one step of the sequence.
// ===========================================================================

describe("ship — the commit ceremony on a green tree", () => {
  const NEW_REPORT = "export const answer = 42;\nexport const total = 7;\n";
  let repo: ShipRepo;
  let baseline: string;
  let outcome: ShipOutcome;
  let payload: ShipPayload;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": NEW_REPORT },
    });
    baseline = headSha(repo.root);
    outcome = await shipIn(repo, ghNoPrDir, shipArgs(messageFile));
    payload = shipPayload(outcome);
  });

  it("succeeds", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("reports the work as committed", () => {
    expect(payload.committed).toBe(true);
  });

  it("answers with the sha of the commit it created", () => {
    expect(payload.sha).toBe(headSha(repo.root));
  });

  it("moves the branch off the commit it started from", () => {
    expect(headSha(repo.root)).not.toBe(baseline);
  });

  it("writes the message file's text as the commit message", () => {
    expect(gitIn(repo.root, ["log", "-1", "--pretty=%B"])).toBe(
      COMMIT_MESSAGE.trim()
    );
  });

  it("commits the pending change", () => {
    expect(gitIn(repo.root, ["show", "HEAD:src/report.ts"])).toBe(
      NEW_REPORT.trim()
    );
  });

  it("reports the gate as green", () => {
    expect(payload.gateExitCode).toBe(0);
  });

  it("leaves nothing uncommitted behind", () => {
    expect(porcelain(repo.root)).toBe("");
  });
});

// ===========================================================================
// Slice 2 — the GATE decides. Sixty files carrying a lint violation Biome's SAFE
// fixes cannot repair, so `check(fix: true)` still fails after fixing. Nothing may
// be committed, nothing pushed, and the findings must reach the caller WHOLE —
// ship's contract is that the exit code decides and the human reads the findings.
//
// WHY SIXTY and not a handful: "never truncated" is only observable ABOVE the
// per-tool cap the CLI's other check renderer applies (it prints at most 50
// findings per tool and collapses the rest into a `…N more` tail). One tool group
// carrying 60 findings is the smallest fixture in which a capped renderer and an
// uncapped one disagree — under 51 the two are byte-identical and the test would
// pass against either.
// ===========================================================================

// Comfortably past any per-tool sampling cap (50 in the sibling renderer).
const GATE_FAILING_COUNT = 60;

const GATE_FAILING_FILES = Array.from(
  { length: GATE_FAILING_COUNT },
  (_unused, index) => `src/compare${String(index + 1).padStart(2, "0")}.ts`
);

// The tail a capped renderer prints INSTEAD of the findings it dropped ("…10 more"
// / "...10 more"). Its absence is what "never truncated" means in output terms.
const TRUNCATION_TAIL = /(…|\.\.\.)\s*\d+\s*more/;

const GATE_FAILURES: Record<string, string> = Object.fromEntries(
  GATE_FAILING_FILES.map((file, index) => [
    file,
    `export const loose${index} = (a: number, b: number) => a == b;\n`,
  ])
);

describe("ship — a red gate", () => {
  let repo: ShipRepo;
  let baseline: string;
  let outcome: ShipOutcome;
  let payload: ShipPayload;

  beforeAll(async () => {
    repo = makeShipRepo({ config: DOBBY_CONFIG, pending: GATE_FAILURES });
    baseline = headSha(repo.root);
    outcome = await shipIn(repo, ghNoPrDir, shipArgs(messageFile));
    payload = shipPayload(outcome);
  });

  it("commits nothing", () => {
    expect(payload.committed).toBe(false);
  });

  it("leaves the branch exactly where it was", () => {
    expect(headSha(repo.root)).toBe(baseline);
  });

  it("reports the gate as failing", () => {
    expect(payload.gateExitCode).not.toBe(0);
  });

  it("exits with the gate's own exit code", () => {
    expect(outcome.exitCode).toBe(payload.gateExitCode);
  });

  it("prints every finding, never a truncated subset", () => {
    const surfaced = `${outcome.stdout}\n${outcome.stderr}`;
    const missing = GATE_FAILING_FILES.filter(
      (file) => !surfaced.includes(file)
    );
    expect(missing).toEqual([]);
  });

  it("collapses nothing into a '…N more' tail", () => {
    // The 60th finding is only printed by an UNCAPPED renderer; a sampling one
    // stops at 50 and says how many it dropped. Asserting the tail's absence pins
    // the difference even if the file-name assertion above were ever relaxed.
    expect(`${outcome.stdout}\n${outcome.stderr}`).not.toMatch(TRUNCATION_TAIL);
  });

  it("pushes nothing to origin", () => {
    expect(remoteSha(repo)).toBe(null);
  });

  it("writes no gate cache for a tree that never passed", () => {
    expect(readGateCache(repo.root)).toBe(null);
  });
});

// ===========================================================================
// Slice 3 — WHAT gets committed. The gate reads the working tree, so everything
// the gate saw has to end up in the commit: untracked-but-not-ignored work, and
// the mutations `--fix` itself made while the gate ran.
// ===========================================================================

describe("ship — staging when nothing was staged", () => {
  const NEW_REPORT = "export const answer = 42;\nexport const total = 7;\n";
  const NEW_FILE = 'export const header = "id,name";\n';
  let repo: ShipRepo;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/export.ts": NEW_FILE, "src/report.ts": NEW_REPORT },
    });
    await shipIn(repo, ghNoPrDir, shipArgs(messageFile));
  });

  it("sweeps untracked work into the commit", () => {
    expect(
      gitIn(repo.root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
    ).toContain("src/export.ts");
  });

  it("commits the modified tracked file too", () => {
    expect(gitIn(repo.root, ["show", "HEAD:src/report.ts"])).toBe(
      NEW_REPORT.trim()
    );
  });

  it("leaves nothing uncommitted behind", () => {
    expect(porcelain(repo.root)).toBe("");
  });
});

describe("ship — the gate's own fixes", () => {
  // Unformatted on purpose, and fixable by Biome's SAFE fixes: the gate rewrites
  // it while running, and that rewrite is what must reach the commit.
  const UGLY = "export const   sum=(a:number,b:number)=>a+b\n";
  let repo: ShipRepo;
  let payload: ShipPayload;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": UGLY },
    });
    payload = shipPayload(await shipIn(repo, ghNoPrDir, shipArgs(messageFile)));
  });

  it("passes the gate once the fixable violation is fixed", () => {
    expect(payload.gateExitCode).toBe(0);
  });

  it("commits the formatted text, not the text it was handed", () => {
    // Biome's canonical formatting of that line — spaces around `=`, typed params
    // spaced, semicolon terminated.
    expect(gitIn(repo.root, ["show", "HEAD:src/report.ts"])).toBe(
      "export const sum = (a: number, b: number) => a + b;"
    );
  });

  it("leaves no unstaged leftovers from the fix", () => {
    expect(porcelain(repo.root)).toBe("");
  });
});

describe("ship — a partially staged tree", () => {
  const NEW_REPORT = "export const answer = 42;\nexport const total = 7;\n";
  const NEW_FILE = 'export const header = "id,name";\n';
  let repo: ShipRepo;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/export.ts": NEW_FILE, "src/report.ts": NEW_REPORT },
      stage: ["src/report.ts"],
    });
    await shipIn(repo, ghNoPrDir, shipArgs(messageFile));
  });

  it("commits the staged change", () => {
    expect(gitIn(repo.root, ["show", "HEAD:src/report.ts"])).toBe(
      NEW_REPORT.trim()
    );
  });

  // The re-stage before committing is unconditional: the gate judged the WHOLE
  // working tree, so committing a subset of it would record a green verdict for a
  // tree that was never checked (and cache that verdict under the wrong key).
  it("leaves nothing uncommitted behind", () => {
    expect(porcelain(repo.root)).toBe("");
  });
});

// ===========================================================================
// Slice 4 — the GATE CACHE, the artefact the pre-push backstop reads to skip a
// re-run. Its key must describe exactly the tree that passed: `git write-tree`
// equals the committed tree ONLY when it ran after the tree was fully staged.
// ===========================================================================

describe("ship — the gate cache", () => {
  const NEW_FILE = 'export const header = "id,name";\n';
  let repo: ShipRepo;
  let payload: ShipPayload;
  let cache: GateCache;
  let dobbyVersion: string;
  let stampFloor: number;
  let stampCeiling: number;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      // Untracked at invocation: the file the gate SEES but a tree hash taken
      // before staging would miss — the cache-poisoning case.
      pending: { "src/export.ts": NEW_FILE },
    });
    dobbyVersion = (await run(["--version"], repo.root)).stdout.trim();
    stampFloor = Date.now() - 1000;
    payload = shipPayload(await shipIn(repo, ghNoPrDir, shipArgs(messageFile)));
    stampCeiling = Date.now() + 1000;
    const written = readGateCache(repo.root);
    if (written === null) {
      throw new Error("ship wrote no .dobby/gate-cache.json");
    }
    cache = written;
  });

  it("reports the cache as written", () => {
    expect(payload.cacheWritten).toBe(true);
  });

  it("keys the cache on the tree it committed", () => {
    expect(cache.treeHash).toBe(headTree(repo.root));
  });

  it("records the gate's green exit code", () => {
    expect(cache.exitCode).toBe(0);
  });

  it("records the dobby version that ran the gate", () => {
    expect(cache.dobbyVersion).toBe(dobbyVersion);
  });

  it("records the hash of the project's dobby.config.json", () => {
    expect(cache.configHash).toBe(DOBBY_CONFIG_SHA256);
  });

  it("stamps the cache with the time the gate ran", () => {
    const at = Date.parse(cache.at);
    expect(at).toBeGreaterThanOrEqual(stampFloor);
    expect(at).toBeLessThanOrEqual(stampCeiling);
  });
});

describe("ship — the gate cache in a project with no dobby.config.json", () => {
  let cache: GateCache | null;

  beforeAll(async () => {
    const repo = makeShipRepo({
      pending: { "src/report.ts": "export const answer = 43;\n" },
    });
    await shipIn(repo, ghNoPrDir, shipArgs(messageFile));
    cache = readGateCache(repo.root);
  });

  it("records a null config hash", () => {
    expect(cache?.configHash).toBe(null);
  });
});

// ===========================================================================
// Slice 5 — the PUSH. Observed on the bare remote itself: what `origin` holds
// after the ceremony, and whether the branch now tracks it.
// ===========================================================================

describe("ship — pushing a branch that tracks nothing yet", () => {
  let repo: ShipRepo;
  let payload: ShipPayload;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 43;\n" },
    });
    payload = shipPayload(await shipIn(repo, ghNoPrDir, shipArgs(messageFile)));
  });

  it("reports the commit as pushed", () => {
    expect(payload.pushed).toBe(true);
  });

  it("leaves the commit on origin", () => {
    expect(remoteSha(repo)).toBe(payload.sha);
  });

  it("sets the branch up to track origin", () => {
    expect(upstreamOf(repo.root)).toBe(`origin/${repo.branch}`);
  });
});

describe("ship — pushing a branch that already tracks origin", () => {
  let repo: ShipRepo;
  let payload: ShipPayload;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 44;\n" },
      upstream: true,
    });
    payload = shipPayload(await shipIn(repo, ghNoPrDir, shipArgs(messageFile)));
  });

  it("reports the commit as pushed", () => {
    expect(payload.pushed).toBe(true);
  });

  it("advances origin to the new commit", () => {
    expect(remoteSha(repo)).toBe(payload.sha);
  });
});

// ===========================================================================
// Slice 6 — the PULL REQUEST, opened only when there is somewhere to open it:
// off the trunk, with a body file, and only when the branch has no PR yet.
// ===========================================================================

describe("ship — opening the pull request", () => {
  let ghDir: string;
  let payload: ShipPayload;

  beforeAll(async () => {
    ghDir = mkStubBins({ gh: GH_NO_PR }, scratchDirs);
    const repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 45;\n" },
    });
    payload = shipPayload(
      await shipIn(
        repo,
        ghDir,
        shipArgs(messageFile, ["--pr-body-file", prBodyFile])
      )
    );
  });

  it("answers with the URL of the pull request it opened", () => {
    expect(payload.prUrl).toBe(PR_URL_CREATED);
  });

  it("sends the body file to gh", () => {
    // The external boundary's REQUEST — the only place the PR body is observable
    // when GitHub itself is stubbed out.
    const created = readStubLog(ghDir, "gh").filter((argv) =>
      argv.join(" ").includes("pr create")
    );
    expect(created.at(0) ?? []).toEqual(
      expect.arrayContaining(["--body-file", prBodyFile])
    );
  });
});

describe("ship — a branch that already has a pull request", () => {
  let ghDir: string;
  let payload: ShipPayload;

  beforeAll(async () => {
    ghDir = mkStubBins({ gh: GH_EXISTING_PR }, scratchDirs);
    const repo = makeShipRepo({
      branch: EXISTING_PR_BRANCH,
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 46;\n" },
    });
    payload = shipPayload(
      await shipIn(
        repo,
        ghDir,
        shipArgs(messageFile, ["--pr-body-file", prBodyFile])
      )
    );
  });

  it("answers with the existing pull request's URL", () => {
    expect(payload.prUrl).toBe(PR_URL_EXISTING);
  });

  it("asks GitHub about the branch it is shipping", () => {
    // The boundary's REQUEST: a URL reported for someone ELSE's branch is a real
    // bug, and the branch argument is the only place it is observable.
    const viewed = readStubLog(ghDir, "gh").filter((argv) =>
      argv.join(" ").includes("pr view")
    );
    expect(viewed.at(0) ?? []).toEqual(
      expect.arrayContaining([EXISTING_PR_BRANCH])
    );
  });

  it("opens no second pull request", () => {
    const created = readStubLog(ghDir, "gh").filter((argv) =>
      argv.join(" ").includes("pr create")
    );
    expect(created).toEqual([]);
  });

  it("still commits and pushes", () => {
    expect({ committed: payload.committed, pushed: payload.pushed }).toEqual({
      committed: true,
      pushed: true,
    });
  });
});

describe("ship — on the trunk", () => {
  let mainPayload: ShipPayload;
  let masterPayload: ShipPayload;

  beforeAll(async () => {
    const onMain = makeShipRepo({
      branch: "main",
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 47;\n" },
    });
    mainPayload = shipPayload(
      await shipIn(
        onMain,
        ghNoPrDir,
        shipArgs(messageFile, ["--pr-body-file", prBodyFile])
      )
    );
    const onMaster = makeShipRepo({
      branch: "master",
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 48;\n" },
    });
    masterPayload = shipPayload(
      await shipIn(
        onMaster,
        ghNoPrDir,
        shipArgs(messageFile, ["--pr-body-file", prBodyFile])
      )
    );
  });

  it("opens no pull request from main", () => {
    expect(mainPayload.prUrl).toBe(null);
  });

  it("opens no pull request from master", () => {
    expect(masterPayload.prUrl).toBe(null);
  });

  it("still commits from the trunk", () => {
    expect(mainPayload.committed).toBe(true);
  });
});

// GitHub refuses: no PR exists, and the create fails the way gh fails on expired
// credentials. "gh could not open it" must never read like "no PR was asked for" —
// both leave `prUrl: null`, so the difference has to be SAID.
const GH_CREATE_FAILS: StubResponse[] = [
  {
    exitCode: 1,
    match: "pr create",
    stderr: "gh: Bad credentials (HTTP 401)\n",
  },
  { exitCode: 1, stderr: "no pull requests found for branch\n" },
];

describe("ship — a pull request gh could not open", () => {
  let outcome: ShipOutcome;
  let payload: ShipPayload;

  beforeAll(async () => {
    const ghDir = mkStubBins({ gh: GH_CREATE_FAILS }, scratchDirs);
    const repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 50;\n" },
    });
    outcome = await shipIn(
      repo,
      ghDir,
      shipArgs(messageFile, ["--pr-body-file", prBodyFile])
    );
    payload = shipPayload(outcome);
  });

  it("reports no pull request URL", () => {
    expect(payload.prUrl).toBe(null);
  });

  it("passes gh's own refusal on to the caller", () => {
    expect(`${outcome.stdout}\n${outcome.stderr}`).toContain("Bad credentials");
  });

  it("keeps the commit and the push it already made", () => {
    expect({ committed: payload.committed, pushed: payload.pushed }).toEqual({
      committed: true,
      pushed: true,
    });
  });
});

describe("ship — off the trunk without a pull-request body", () => {
  let payload: ShipPayload;

  beforeAll(async () => {
    const repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": "export const answer = 49;\n" },
    });
    payload = shipPayload(await shipIn(repo, ghNoPrDir, shipArgs(messageFile)));
  });

  it("opens no pull request", () => {
    expect(payload.prUrl).toBe(null);
  });
});

// ===========================================================================
// Slice 7 — the guards. The message file is checked BEFORE anything is touched:
// a ceremony that cannot produce a commit message must leave the tree exactly as
// it found it, un-staged and un-formatted.
// ===========================================================================

// Unformatted and uncommitted: if the gate ran, this file would come back
// formatted — which is how "before any mutation" is observable at all.
const UNTOUCHED = "export const   sum=(a:number,b:number)=>a+b\n";

describe("ship — a message file that does not exist", () => {
  let repo: ShipRepo;
  let baseline: string;
  let statusBefore: string;
  let outcome: ShipOutcome;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": UNTOUCHED },
    });
    baseline = headSha(repo.root);
    statusBefore = porcelain(repo.root);
    outcome = await shipIn(
      repo,
      ghNoPrDir,
      shipArgs(join(repo.root, "..", "no-such-message.md"))
    );
  });

  it("fails", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("says what is wrong", () => {
    expect(outcome.stderr.toLowerCase()).toContain("message");
  });

  it("creates no commit", () => {
    expect(headSha(repo.root)).toBe(baseline);
  });

  it("stages nothing", () => {
    expect(porcelain(repo.root)).toBe(statusBefore);
  });

  it("never reaches the gate, so nothing is reformatted", () => {
    expect(readFileSync(join(repo.root, "src/report.ts"), "utf8")).toBe(
      UNTOUCHED
    );
  });
});

describe("ship — an empty message file", () => {
  let repo: ShipRepo;
  let baseline: string;
  let outcome: ShipOutcome;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": UNTOUCHED },
    });
    baseline = headSha(repo.root);
    outcome = await shipIn(
      repo,
      ghNoPrDir,
      shipArgs(writeExternalFile("empty.md", ""))
    );
  });

  it("fails", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("says what is wrong", () => {
    expect(outcome.stderr.toLowerCase()).toContain("message");
  });

  it("creates no commit", () => {
    expect(headSha(repo.root)).toBe(baseline);
  });

  it("never reaches the gate, so nothing is reformatted", () => {
    expect(readFileSync(join(repo.root, "src/report.ts"), "utf8")).toBe(
      UNTOUCHED
    );
  });
});

describe("ship — no message file at all", () => {
  let repo: ShipRepo;
  let baseline: string;
  let outcome: ShipOutcome;

  beforeAll(async () => {
    repo = makeShipRepo({
      config: DOBBY_CONFIG,
      pending: { "src/report.ts": UNTOUCHED },
    });
    baseline = headSha(repo.root);
    outcome = await shipIn(repo, ghNoPrDir, ["ship", "--json"]);
  });

  it("fails", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("names the missing message file in the error", () => {
    expect(outcome.stderr.toLowerCase()).toContain("message");
  });

  it("creates no commit", () => {
    expect(headSha(repo.root)).toBe(baseline);
  });
});

describe("ship — outside a git repository", () => {
  it("fails with the git-repository error", async () => {
    const plain = realpathSync(
      mkdtempSync(join(tmpdir(), "dobby-ship-plain-"))
    );
    scratchDirs.push(plain);
    const outcome = await withStubPath(ghNoPrDir, () =>
      run(shipArgs(messageFile), plain)
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("git repository");
  });
});
