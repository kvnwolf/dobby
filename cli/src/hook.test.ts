import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitEnv,
  gitIn,
  makeScratchRepo,
  restoreEnv,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// The PRE-PUSH BACKSTOP — three pieces of one behaviour: a push must not carry a
// red gate to the remote.
//
//  1. `dobby check --pre-push` — reads git's pre-push stdin contract, consults the
//     GATE CACHE `ship` wrote, and either lets the push through or runs the gate
//     in-process and blocks on findings.
//  2. The generated HOOK SHIM — a dumb `/bin/sh` script carrying the ADR-0012
//     double guard and `exec`ing the project's LOCAL dobby (never `bunx`).
//  3. Its INSTALL from `up`'s setup phase — idempotent for a dobby-managed hook,
//     refuse-and-report for a foreign one.
//
// THE SEAM is the in-process `run(argv, cwd, stdin)` contract (ADR-0008):
// `hook-install.ts` and `lifecycle.ts` are never imported here, so their internals
// can be restructured freely without touching this file. Everything is observed
// through the command's own outcome plus the state of a REAL git repository.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (never from the implementation):
//  - Every pushed SHA and TREE in a stdin fixture is read out of git itself
//    (`git rev-parse HEAD`, `git rev-parse <rev>^{tree}`) — git computes the tree,
//    dobby does not, so a wrong peel cannot agree with the expectation.
//  - The hooks DIRECTORY is asked of git (`git rev-parse --path-format=absolute
//    --git-path hooks`), which is also the plumbing the spec mandates; from a
//    LINKED worktree that answer is the MAIN checkout's `.git/hooks` (verified out
//    of band), which is what "one install covers all worktrees" means.
//  - The stdin line format `<local-ref> <local-sha> <remote-ref> <remote-sha>`,
//    the `(delete)` + all-zeros delete line, and `^{tree}` exiting 128 on an
//    unknown object were all verified OUT OF BAND against a real `git push` into a
//    real bare remote with a recording hook — and the end-to-end slice below
//    re-verifies the line format against git at test time.
//  - `configHash` is the sha256 of the fixture's `dobby.config.json` BYTES,
//    computed out of band with `shasum -a 256` (an independent tool) and pasted as
//    a literal; `dobbyVersion` is read from `dobby --version`, an unrelated public
//    surface of the same CLI.
//  - The gate's verdict is anchored on FIXTURE CONTENT whose red/green status was
//    verified out of band by running `dobby check` on it: `a == b` is a Biome
//    finding SAFE fixes cannot repair (red), `export const answer = 42;` is clean
//    (green).
//  - The truncation tail (`…N more`) is the sibling renderer's OWN summary form,
//    verified out of band to fire at 51+ findings in one tool group — which is why
//    the blocking fixture carries 60.
//
// MOCKED BOUNDARIES: only the project-local `node_modules/.bin/dobby` in the
// end-to-end slice, stubbed as a recording executable — it stands in for a second
// CLI PROCESS (the one git spawns), not for an internal collaborator. `git` is
// REAL throughout, including a real bare repository standing in for `origin`, so
// "blocked" and "pushed" are facts of a repository rather than claims.
//
// SIX tests are GREEN before the implementation exists, deliberately: they are
// "must NOT" guards, whose whole content is a side effect that must never happen
// (the backstop must not rewrite the tree, must not claim a cache hit, `--dry-run`
// must not install, a foreign hook must not be touched or fail the phase) plus one
// precondition (`up` already completes its setup phase). Every other assertion in
// this file fails until the behaviour it describes exists.
// ===========================================================================

const scratchDirs: string[] = [];

// --- The fixture project ----------------------------------------------------
// A minimal repo the inferred gate (biome + tsc + knip) runs cleanly over. Every
// manifest is written PRE-FORMATTED in Biome's own style so the only gate finding
// in any fixture is the one a test deliberately puts there.

const PACKAGE_JSON = '{\n\t"name": "hook-fixture",\n\t"private": true\n}\n';

const KNIP_JSON =
  '{\n\t"entry": ["src/**/*.ts"],\n\t"project": ["src/**/*.ts"]\n}\n';

const TSCONFIG_JSON =
  '{\n\t"compilerOptions": {\n\t\t"module": "esnext",\n\t\t"moduleResolution": "bundler",\n\t\t"noEmit": true,\n\t\t"skipLibCheck": true,\n\t\t"strict": true,\n\t\t"target": "esnext"\n\t},\n\t"include": ["src"]\n}\n';

// The kit's per-project contract. Its EXACT bytes are the input to the gate
// cache's `configHash`, so they are pinned here and hashed out of band.
const DOBBY_CONFIG = '{\n\t"files": []\n}\n';

// `printf '{\n\t"files": []\n}\n' | shasum -a 256` — an independent tool, not a
// value recomputed the way the CLI computes it.
const DOBBY_CONFIG_SHA256 =
  "b35a5c252e345c216527bfa100d0b1d19988398d06fdb7838c756b6c80aaa9de";

const BASE_FILES: Record<string, string> = {
  // `.dobby/` is the CLI's machine-state home (the gate cache lives there) and
  // must be invisible to git — an un-ignored cache would change the very tree it
  // is keyed on.
  ".gitignore": ".dobby/\nnode_modules/\n",
  "knip.json": KNIP_JSON,
  "tsconfig.json": TSCONFIG_JSON,
};

// Verified out of band: `dobby check` over this file exits 0.
const GREEN_SOURCE = "export const answer = 42;\n";

// Verified out of band: `dobby check` over this file exits 1 with one biome
// finding (`Using == may be unsafe…`) that Biome's SAFE fixes cannot repair.
const RED_FILE = "src/loose.ts";
const RED_SOURCE = "export const loose = (a: number, b: number) => a == b;\n";

// Verified out of band: a FORMATTING-only violation — the gate reports it, and
// `--fix` (which the backstop must never apply) is what would rewrite the file.
const UNFORMATTED_SOURCE = "export const messy   =    1;\n";

// --- git's pre-push stdin contract -------------------------------------------
// One line per ref: `<local-ref> <local-sha> <remote-ref> <remote-sha>`. Field 1
// is NOT a ref in general (git writes `(delete)`, or a raw object name), so the
// backstop must key off field 2 alone.

const ZERO_SHA_40 = "0".repeat(40);
// A SHA-256 repository spells the same "no object" as 64 zeros.
const ZERO_SHA_64 = "0".repeat(64);
const REMOTE_REF = "refs/heads/main";

function pushLine(
  localRef: string,
  localSha: string,
  remoteRef: string = REMOTE_REF,
  remoteHead: string = ZERO_SHA_40
): string {
  return `${localRef} ${localSha} ${remoteRef} ${remoteHead}\n`;
}

// --- The gate cache `ship` writes --------------------------------------------

interface GateCache {
  at: string;
  configHash: string | null;
  dobbyVersion: string;
  exitCode: number;
  treeHash: string;
}

// The running CLI's version, read through `dobby --version` (an unrelated public
// surface) so a cache fixture can claim to have been written by THIS dobby.
let dobbyVersion = "";

function writeGateCache(
  root: string,
  overrides: Partial<GateCache> & { treeHash: string }
): void {
  const cache: GateCache = {
    at: new Date().toISOString(),
    configHash: DOBBY_CONFIG_SHA256,
    dobbyVersion,
    exitCode: 0,
    ...overrides,
  };
  mkdirSync(join(root, ".dobby"), { recursive: true });
  writeFileSync(
    join(root, ".dobby", "gate-cache.json"),
    `${JSON.stringify(cache, null, 2)}\n`
  );
}

// --- Fixture plumbing --------------------------------------------------------

function makeHookRepo(
  opts: { config?: string; files?: Record<string, string> } = {}
): string {
  return makeScratchRepo({
    branch: "worktree-backstop",
    config: opts.config ?? DOBBY_CONFIG,
    files: { ...BASE_FILES, ...(opts.files ?? {}) },
    pkg: PACKAGE_JSON,
    prefix: "dobby-hook-",
    track: scratchDirs,
  });
}

function writeInRepo(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function addCommit(root: string, relPath: string, content: string): string {
  writeInRepo(root, relPath, content);
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-q", "-m", `add ${relPath}`]);
  return headSha(root);
}

// --- Independent observers ---------------------------------------------------

function headSha(root: string): string {
  return gitIn(root, ["rev-parse", "HEAD"]);
}

function treeOf(root: string, rev: string): string {
  return gitIn(root, ["rev-parse", `${rev}^{tree}`]);
}

// Where git itself says this repository's hooks live — the COMMON dir from any
// worktree, honouring `core.hooksPath`.
function hooksDir(root: string): string {
  return gitIn(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
}

function hookPath(root: string): string {
  return join(hooksDir(root), "pre-push");
}

function readHook(root: string): string {
  return readFileSync(hookPath(root), "utf8");
}

// --- The commands under test -------------------------------------------------

interface Outcome {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function prePush(root: string, stdin: string): Promise<Outcome> {
  return run(["check", "--pre-push"], root, stdin);
}

function combined(outcome: Outcome): string {
  return `${outcome.stdout}\n${outcome.stderr}`;
}

// "The gate RAN and refused the push" — proven by the red fixture's own finding
// reaching the caller, not merely by a nonzero exit (a rejected flag, a missing
// command or any other early exit is nonzero too, and must never count as a
// blocked push).
function expectGateBlocked(outcome: Outcome): void {
  expect(combined(outcome)).toContain(RED_FILE);
  expect(outcome.exitCode).not.toBe(0);
}

// The precondition of every "the hook stays out of the way" slice: there IS a
// hook to stay out of the way.
function expectHookInstalled(root: string): void {
  expect(existsSync(hookPath(root))).toBe(true);
}

const SKIP_INSTALL = "DOBBY_SKIP_INSTALL";
const CMUX = "CMUX_WORKSPACE_ID";

// `up` with the documented test seam: no real `bun install`, no cmux. The setup
// phase (and therefore the hook install) still runs in full.
async function upIn(root: string, argv: string[] = ["up"]): Promise<Outcome> {
  const originalSkip = process.env[SKIP_INSTALL];
  const originalCmux = process.env[CMUX];
  process.env[SKIP_INSTALL] = "1";
  restoreEnv(CMUX, undefined);
  try {
    return await run(argv, root);
  } finally {
    restoreEnv(SKIP_INSTALL, originalSkip);
    restoreEnv(CMUX, originalCmux);
  }
}

beforeAll(async () => {
  const probe = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
  dobbyVersion = (await run(["--version"], probe)).stdout.trim();
});

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// ===========================================================================
// Slice 1 (tracer bullet) — the backstop EXISTS and an empty push is a no-op.
//
// The smallest thing that proves the whole seam is wired: `check --pre-push` is
// accepted as a flag, reads stdin, and answers "nothing pushed" without running
// the gate. The fixture's gate is RED, so exit 0 can ONLY mean the no-op fired.
// ===========================================================================

describe("pre-push backstop — a push with no refs", () => {
  let repo: string;
  let outcome: Outcome;

  beforeAll(async () => {
    repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    outcome = await prePush(repo, "");
  });

  it("lets the push through", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("is a genuine no-op, not a rejected flag", () => {
    // Anti-tautology guard: an unregistered `--pre-push` ALSO exits nonzero via
    // the flag allowlist — and a `check` that ignored the flag would run the gate
    // over this red tree. Neither may be what produced the exit 0 above.
    expect(outcome.stderr).not.toContain("Usage: dobby");
  });
});

// ===========================================================================
// Slice 2 — a pushed sha with no cache RUNS THE GATE and BLOCKS.
//
// The reason the backstop exists. Sixty files carrying a lint violation Biome's
// SAFE fixes cannot repair: the push must be refused and the human must see EVERY
// finding — the v0.5.1 incident was a summary being read as the whole truth.
//
// WHY SIXTY: "never a summary" is only observable ABOVE the per-tool cap the
// sibling check renderer applies (it prints at most 50 findings per tool and
// collapses the rest into a `…N more` tail, verified out of band). Under 51 a
// capped renderer and an uncapped one are byte-identical.
// ===========================================================================

const GATE_FAILING_COUNT = 60;

const GATE_FAILING_FILES = Array.from(
  { length: GATE_FAILING_COUNT },
  (_unused, index) => `src/compare${String(index + 1).padStart(2, "0")}.ts`
);

const GATE_FAILURES: Record<string, string> = Object.fromEntries(
  GATE_FAILING_FILES.map((file, index) => [
    file,
    `export const loose${index} = (a: number, b: number) => a == b;\n`,
  ])
);

// The last finding of the sixty: present in a full report, dropped by a capped one.
const LAST_FAILING_FILE = `src/compare${GATE_FAILING_COUNT}.ts`;

// The tail a capped renderer prints INSTEAD of the findings it dropped.
const TRUNCATION_TAIL = /(…|\.\.\.)\s*\d+\s*more/;

describe("pre-push backstop — a red tree", () => {
  let repo: string;
  let outcome: Outcome;

  beforeAll(async () => {
    repo = makeHookRepo({ files: GATE_FAILURES });
    outcome = await prePush(
      repo,
      pushLine("refs/heads/main", headSha(repo), REMOTE_REF, ZERO_SHA_40)
    );
  });

  it("blocks the push", () => {
    // Anti-tautology guard: a rejected flag is nonzero too — only a nonzero that
    // is NOT the CLI refusing the invocation counts as a blocked push.
    expect(outcome.stderr).not.toContain("Usage: dobby");
    expect(outcome.exitCode).not.toBe(0);
  });

  it("prints every finding", () => {
    const surfaced = combined(outcome);
    const missing = GATE_FAILING_FILES.filter(
      (file) => !surfaced.includes(file)
    );
    expect(missing).toEqual([]);
  });

  it("prints the tail of the list instead of summarising it", () => {
    const surfaced = combined(outcome);
    expect(surfaced).toContain(LAST_FAILING_FILE);
    expect(surfaced).not.toMatch(TRUNCATION_TAIL);
  });
});

// ===========================================================================
// Slice 3 — a green tree is let through. The counterpart to slice 2: the backstop
// blocks on findings, not on pushes.
// ===========================================================================

describe("pre-push backstop — a green tree", () => {
  it("lets the push through", async () => {
    const repo = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
    const outcome = await prePush(
      repo,
      pushLine("refs/heads/main", headSha(repo))
    );
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });
});

// ===========================================================================
// Slice 4 — a hook must NOT MUTATE the tree. The gate runs with fixing OFF: a push
// that rewrites the developer's files behind their back would change what is about
// to be pushed. The fixture's only violation is one `--fix` WOULD repair.
// ===========================================================================

describe("pre-push backstop — a tree with a fixable violation", () => {
  const MESSY = "src/messy.ts";
  let repo: string;
  let outcome: Outcome;

  beforeAll(async () => {
    repo = makeHookRepo({ files: { [MESSY]: UNFORMATTED_SOURCE } });
    outcome = await prePush(repo, pushLine("refs/heads/main", headSha(repo)));
  });

  it("leaves the file exactly as the developer wrote it", () => {
    expect(readFileSync(join(repo, MESSY), "utf8")).toBe(UNFORMATTED_SOURCE);
  });

  it("still blocks the push", () => {
    // Efficacy anchor: the gate really ran over that file (it is named in the
    // findings), so the untouched bytes above mean "did not fix", not "did not
    // look".
    expect(combined(outcome)).toContain(MESSY);
    expect(outcome.exitCode).not.toBe(0);
  });
});

// ===========================================================================
// Slice 5 — the GATE CACHE short-circuit. `ship` already ran the gate over exactly
// this tree; re-running it on the push is a ~30s tax on every push. The fixture's
// tree is RED, so a green exit can ONLY come from the cache being honoured.
// ===========================================================================

describe("pre-push backstop — a cached green verdict for the pushed tree", () => {
  let repo: string;
  let tree: string;
  let outcome: Outcome;

  beforeAll(async () => {
    repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    tree = treeOf(repo, "HEAD");
    writeGateCache(repo, { treeHash: tree });
    outcome = await prePush(repo, pushLine("refs/heads/main", headSha(repo)));
  });

  it("lets the push through without running the gate", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("says on stderr which tree the cache answered for", () => {
    expect(outcome.stderr).toContain(`gate cache hit (${tree})`);
  });
});

// ===========================================================================
// Slice 6 — the cache key is COMPOSITE (Decision 8): the tree ALONE would serve a
// stale green across a dobby upgrade or a config edit. Every miss below must fall
// back to a real gate run, which the red fixture makes observable as a block.
// ===========================================================================

describe("pre-push backstop — cache misses", () => {
  async function pushRedTreeWith(cache: Partial<GateCache>): Promise<Outcome> {
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    writeGateCache(repo, { treeHash: treeOf(repo, "HEAD"), ...cache });
    return await prePush(repo, pushLine("refs/heads/main", headSha(repo)));
  }

  it("runs the gate when the cache was written by another dobby version", async () => {
    expectGateBlocked(await pushRedTreeWith({ dobbyVersion: "0.0.0-stale" }));
  });

  it("runs the gate when dobby.config.json changed since the cache was written", async () => {
    expectGateBlocked(await pushRedTreeWith({ configHash: "0".repeat(64) }));
  });

  it("runs the gate when the cache describes a different tree", async () => {
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    const pushed = addCommit(repo, "src/extra.ts", GREEN_SOURCE);
    // The cache describes the PARENT's tree; the push carries the child's.
    writeGateCache(repo, { treeHash: treeOf(repo, "HEAD~1") });
    expectGateBlocked(await prePush(repo, pushLine("refs/heads/main", pushed)));
  });

  it("runs the gate when only SOME of the pushed trees are cached", async () => {
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    const parent = headSha(repo);
    const child = addCommit(repo, "src/extra.ts", GREEN_SOURCE);
    // Every pushed tree must be covered: the child is, the parent is not.
    writeGateCache(repo, { treeHash: treeOf(repo, "HEAD") });
    expectGateBlocked(
      await prePush(
        repo,
        pushLine("refs/heads/main", child) +
          pushLine("refs/heads/release", parent, "refs/heads/release")
      )
    );
  });

  it("runs the gate when the pushed sha cannot be peeled to a tree", async () => {
    // `git rev-parse <unknown>^{tree}` exits 128 (verified out of band) — no key,
    // so the gate is the only answer.
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    writeGateCache(repo, { treeHash: treeOf(repo, "HEAD") });
    expectGateBlocked(
      await prePush(repo, pushLine("refs/heads/main", "f".repeat(40)))
    );
  });
});

describe("pre-push backstop — a cached RED verdict for the pushed tree", () => {
  let repo: string;
  let outcome: Outcome;

  beforeAll(async () => {
    // A GREEN tree whose cache records a failure: only a re-run can tell that the
    // tree is fine now, so the cache must not be treated as an answer at all.
    repo = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
    writeGateCache(repo, { exitCode: 1, treeHash: treeOf(repo, "HEAD") });
    outcome = await prePush(repo, pushLine("refs/heads/main", headSha(repo)));
  });

  it("lets the push through on the re-run's own verdict", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("never reports it as a cache hit", () => {
    expect(outcome.stderr).not.toContain("gate cache hit");
  });
});

// ===========================================================================
// Slice 7 — the STDIN CONTRACT. git writes one line per ref, and field 1 is not a
// ref in general: on a delete it is the literal `(delete)`, and a `git push
// <sha>:<ref>` writes a raw object name there. Only field 2 identifies what is
// being pushed, and an all-zeros field 2 means nothing is.
// ===========================================================================

describe("pre-push backstop — the stdin contract", () => {
  it("lets a branch DELETION through (no tree is being pushed)", async () => {
    // Verified out of band: git writes exactly this line when deleting a remote
    // branch. The fixture's gate is red, so exit 0 proves the line was skipped
    // rather than gated — and proves field 1 (`(delete)`) was never parsed as a ref.
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    const outcome = await prePush(
      repo,
      pushLine("(delete)", ZERO_SHA_40, "refs/heads/gone", headSha(repo))
    );
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("recognises the all-zeros sha of a SHA-256 repository too", async () => {
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    const outcome = await prePush(
      repo,
      pushLine("(delete)", ZERO_SHA_64, "refs/heads/gone", ZERO_SHA_64)
    );
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("identifies the pushed commit by the sha field, not by the ref field", async () => {
    // `git push <sha>:refs/heads/x` puts a RAW OBJECT NAME in field 1. Here field 1
    // names the PARENT (whose tree is not cached) while field 2 names the child
    // (whose tree is): honouring the cache is only possible from field 2, and the
    // red fixture turns a fall-through to the gate into a block.
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    const parent = headSha(repo);
    const child = addCommit(repo, "src/extra.ts", GREEN_SOURCE);
    const tree = treeOf(repo, "HEAD");
    writeGateCache(repo, { treeHash: tree });
    const outcome = await prePush(repo, pushLine(parent, child));
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });
});

// ===========================================================================
// Slice 7b — an ANNOTATED TAG. `git push --tags` writes the TAG OBJECT's sha in
// field 2, not a commit's: the backstop must peel it (`<sha>^{tree}` walks tag →
// commit → tree) or it would key the cache on something that has no tree at all.
// git is the oracle for both shas; the fixture's gate is RED, so exit 0 can only
// come from the peel landing on the cached tree.
// ===========================================================================

describe("pre-push backstop — an annotated tag", () => {
  it("peels the tag to its commit's tree and honours the cache", async () => {
    const repo = makeHookRepo({ files: { [RED_FILE]: RED_SOURCE } });
    gitIn(repo, ["tag", "-a", "v1", "-m", "release v1"]);
    const tagSha = gitIn(repo, ["rev-parse", "refs/tags/v1"]);
    // An annotated tag is its own object: the pushed sha is NOT the commit's, so
    // a backstop that only understood commits would find no tree here.
    expect(tagSha).not.toBe(headSha(repo));
    const tree = treeOf(repo, "HEAD");
    writeGateCache(repo, { treeHash: tree });
    const outcome = await prePush(
      repo,
      pushLine("refs/tags/v1", tagSha, "refs/tags/v1")
    );
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
    expect(outcome.stderr).toContain(`gate cache hit (${tree})`);
  });
});

// ===========================================================================
// Slice 8 — the INSTALL, as a setup action of `up`. The setup phase runs even for
// a no-app project, which is how the backstop reaches every consumer.
// ===========================================================================

const HOOK_MARKER = "# dobby-managed pre-push backstop";

describe("up — planning the pre-push hook install", () => {
  let repo: string;
  let outcome: Outcome;

  beforeAll(async () => {
    repo = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
    outcome = await upIn(repo, ["up", "--dry-run"]);
  });

  it("shows the hook install in the plan, after the install step", () => {
    const plan = outcome.stdout;
    expect(plan).toMatch(/bun install/);
    expect(plan.indexOf("bun install")).toBeLessThan(plan.indexOf("pre-push"));
  });

  it("installs nothing while only planning", () => {
    expect(existsSync(hookPath(repo))).toBe(false);
  });
});

describe("up — installing the pre-push hook", () => {
  let repo: string;
  let outcome: Outcome;
  let shim: string;

  beforeAll(async () => {
    repo = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
    outcome = await upIn(repo);
    shim = existsSync(hookPath(repo)) ? readHook(repo) : "";
  });

  it("completes the setup phase", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("writes the hook where git looks for it", () => {
    expect(existsSync(hookPath(repo))).toBe(true);
  });

  it("makes it executable", () => {
    // git only runs a hook it can execute. The permission triple as git sees it.
    expect(statSync(hookPath(repo)).mode.toString(8).slice(-3)).toBe("755");
  });

  it("is a POSIX shell script", () => {
    expect(shim.split("\n")[0]).toBe("#!/bin/sh");
  });

  it("carries the dobby marker on its second line", () => {
    // The marker is what makes the install idempotent and a foreign hook
    // recognisable — it is contract, not decoration.
    expect(shim.split("\n")[1]).toContain(HOOK_MARKER);
  });

  it("runs the project's OWN dobby against the pushed refs", () => {
    expect(shim).toContain("node_modules/.bin/dobby");
    expect(shim).toContain("check --pre-push");
  });

  it("never reaches for a foreign dobby off the network (ADR-0012)", () => {
    // `bunx dobby` would fetch the unrelated npm package `dobby` in a consumer
    // whose install is stale — the hook must only ever run what is on disk.
    expect(shim).toContain("dobby");
    expect(shim).not.toContain("bunx");
  });
});

describe("up — installing from a linked worktree", () => {
  let main: string;
  let worktree: string;

  beforeAll(async () => {
    main = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
    worktree = `${main}-wt`;
    gitIn(main, ["worktree", "add", "-q", "-b", "backstop-wt", worktree]);
    scratchDirs.push(worktree);
    await upIn(realpathSync(worktree));
  });

  it("installs into the repository's common hooks dir, covering every worktree", () => {
    // git resolves the hooks path of a linked worktree to the MAIN checkout's
    // `.git/hooks` (verified out of band), so one install serves them all.
    expect(existsSync(join(hooksDir(main), "pre-push"))).toBe(true);
  });
});

describe("up — a hook this dobby installed earlier", () => {
  const STALE_LINE = "# installed by an older dobby";
  let repo: string;
  let shim: string;
  let secondRun: string;

  beforeAll(async () => {
    repo = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
    writeFileSync(
      hookPath(repo),
      `#!/bin/sh\n${HOOK_MARKER} — do not edit\n${STALE_LINE}\nexit 0\n`
    );
    chmodSync(hookPath(repo), 0o755);
    await upIn(repo);
    shim = readHook(repo);
    await upIn(repo);
    secondRun = readHook(repo);
  });

  it("upgrades it in place", () => {
    expect(shim).not.toContain(STALE_LINE);
    expect(shim).toContain("check --pre-push");
  });

  it("re-running up changes nothing further", () => {
    expect(secondRun).toContain("check --pre-push");
    expect(secondRun).toBe(shim);
  });
});

describe("up — a foreign pre-push hook", () => {
  const FOREIGN = '#!/bin/sh\necho "someone else was here"\nexit 0\n';
  let repo: string;
  let outcome: Outcome;
  let plan: Outcome;

  beforeAll(async () => {
    repo = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
    writeFileSync(hookPath(repo), FOREIGN);
    chmodSync(hookPath(repo), 0o755);
    plan = await upIn(repo, ["up", "--dry-run"]);
    outcome = await upIn(repo);
  });

  it("leaves it untouched", () => {
    expect(readHook(repo)).toBe(FOREIGN);
  });

  it("reports the file it refused to overwrite", () => {
    // "hooks/pre-push" is the tail of the path however it is rendered (absolute or
    // repo-relative): the point is that the human is told WHICH file blocks the
    // install, not how the path is spelled.
    expect(combined(plan)).toContain("hooks/pre-push");
  });

  it("does not fail the setup phase over it", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });
});

// ===========================================================================
// Slice 9 — END TO END through a REAL `git push` into a REAL bare remote. The
// pieces above are each proven in isolation; this is the one test that proves git
// runs the shim, the shim reaches the CLI, and a nonzero answer stops the push.
//
// The project-local `node_modules/.bin/dobby` is a recording stub: it stands in
// for the SECOND PROCESS git spawns (the real CLI's own behaviour is covered
// in-process by the slices above), and its recording is what makes git's stdin
// contract observable at test time.
// ===========================================================================

interface BackstopRepo {
  argvLog: string;
  remote: string;
  root: string;
  stdinLog: string;
}

function makeBackstopRepo(): BackstopRepo {
  const root = makeHookRepo({ files: { "src/report.ts": GREEN_SOURCE } });
  const remote = `${root}-remote.git`;
  scratchDirs.push(remote);
  mkdirSync(remote, { recursive: true });
  gitIn(remote, ["init", "-q", "--bare"]);
  gitIn(root, ["remote", "add", "origin", remote]);
  return {
    // Under `.dobby/` (gitignored), so recording never dirties the pushed tree.
    argvLog: join(root, ".dobby", "backstop-argv.log"),
    remote,
    root,
    stdinLog: join(root, ".dobby", "backstop-stdin.log"),
  };
}

// The project-local dobby the shim execs: records its argv and its whole stdin,
// then answers with `exitCode` (1 = a red gate).
function writeLocalDobby(repo: BackstopRepo, exitCode: number): void {
  const bin = join(repo.root, "node_modules", ".bin", "dobby");
  mkdirSync(dirname(bin), { recursive: true });
  mkdirSync(dirname(repo.argvLog), { recursive: true });
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${repo.argvLog}'`,
      `cat >> '${repo.stdinLog}'`,
      `exit ${exitCode}`,
      "",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
}

function readLog(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function push(root: string, args: string[]): number {
  const result = spawnSync("git", ["push", ...args], {
    cwd: root,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status ?? 1;
}

// What `origin` actually holds — read out of the bare repository, never off the
// pushing side's report.
function remoteSha(repo: BackstopRepo): string | null {
  try {
    return gitIn(repo.remote, ["rev-parse", "refs/heads/main"]);
  } catch {
    return null;
  }
}

const PUSH_REFSPEC = ["origin", "HEAD:refs/heads/main"];

describe("the installed backstop against a real git push", () => {
  let repo: BackstopRepo;
  let blocked: number;
  let bypassed: number;
  let argvWhenBlocked: string[];
  let stdinWhenBlocked: string;
  let argvAfterBypass: string[];
  let shaOnRemoteAfterBlock: string | null;

  beforeAll(async () => {
    repo = makeBackstopRepo();
    await upIn(repo.root);
    writeLocalDobby(repo, 1);

    blocked = push(repo.root, PUSH_REFSPEC);
    shaOnRemoteAfterBlock = remoteSha(repo);
    argvWhenBlocked = readLog(repo.argvLog);
    stdinWhenBlocked = existsSync(repo.stdinLog)
      ? readFileSync(repo.stdinLog, "utf8")
      : "";

    bypassed = push(repo.root, ["--no-verify", ...PUSH_REFSPEC]);
    argvAfterBypass = readLog(repo.argvLog);
  });

  it("refuses the push when the backstop answers nonzero", () => {
    expect(blocked).not.toBe(0);
  });

  it("leaves the remote without the commit", () => {
    expect(shaOnRemoteAfterBlock).toBe(null);
  });

  it("invokes the project's local dobby in pre-push mode", () => {
    expect(argvWhenBlocked).toEqual(["check --pre-push"]);
  });

  it("hands git's own ref line through to it on stdin", () => {
    // The line git actually wrote — which is also the fixture format every
    // in-process slice above feeds `run()`.
    const fields = stdinWhenBlocked.trim().split(/\s+/);
    expect(fields).toHaveLength(4);
    expect(fields[1]).toBe(headSha(repo.root));
  });

  // The documented bypass: the backstop is a backstop, not a lock. Each of the
  // three asserts the hook IS installed first — otherwise "the push went through"
  // would be satisfied by a repo that has no backstop at all.
  it("lets --no-verify through", () => {
    expectHookInstalled(repo.root);
    expect(bypassed).toBe(0);
  });

  it("does not consult the backstop under --no-verify", () => {
    expectHookInstalled(repo.root);
    expect(argvAfterBypass).toEqual(argvWhenBlocked);
  });

  it("lands the commit on the remote under --no-verify", () => {
    expectHookInstalled(repo.root);
    expect(remoteSha(repo)).toBe(headSha(repo.root));
  });
});

// ===========================================================================
// Slice 10 — the DOUBLE GUARD (ADR-0012). The hook lives in the repository, not in
// dobby: it must stay silent in a checkout that is not a dobby project, and in one
// whose dependencies are not installed. Either way the push proceeds.
// ===========================================================================

describe("the installed backstop in a checkout without the dobby contract", () => {
  let repo: BackstopRepo;
  let pushed: number;
  let argv: string[];

  beforeAll(async () => {
    repo = makeBackstopRepo();
    await upIn(repo.root);
    writeLocalDobby(repo, 1);
    // The marker the edit hook and the backstop both guard on, gone.
    gitIn(repo.root, ["rm", "-q", "dobby.config.json"]);
    pushed = push(repo.root, PUSH_REFSPEC);
    argv = readLog(repo.argvLog);
  });

  it("lets the push through", () => {
    expectHookInstalled(repo.root);
    expect(pushed).toBe(0);
  });

  it("never runs dobby", () => {
    expectHookInstalled(repo.root);
    expect(argv).toEqual([]);
  });
});

describe("the installed backstop with dobby not installed locally", () => {
  let repo: BackstopRepo;
  let pushed: number;

  beforeAll(async () => {
    repo = makeBackstopRepo();
    await upIn(repo.root);
    // No node_modules/.bin/dobby at all — a fresh clone before `bun install`.
    pushed = push(repo.root, PUSH_REFSPEC);
  });

  it("lets the push through", () => {
    expectHookInstalled(repo.root);
    expect(pushed).toBe(0);
  });

  it("still leaves the commit on the remote", () => {
    expectHookInstalled(repo.root);
    expect(remoteSha(repo)).toBe(headSha(repo.root));
  });
});
