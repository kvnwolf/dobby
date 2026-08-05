import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeCodeHash,
  consultGreenInputs,
  recordGreenInput,
  writeShipRecord,
} from "./gate-cache.ts";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitEnv,
  gitIn,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real git spawns inside scratch repos, under full-suite parallelism: the
// config-independent budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// THE GATE CACHE MODULE — the single owner of `.dobby/gate-cache.json`, behind
// four verbs:
//
//   computeCodeHash(root)                 the index-neutral CODE HASH of the
//                                         non-inert tree
//   consultGreenInputs(root, hash)        was this exact input set already
//                                         proven green?
//   recordGreenInput(root, hash)          remember it (LRU of 5)
//   writeShipRecord(root, tree, exit)     ship's flat record, greenInputs kept
//
// WHERE EVERY EXPECTED VALUE COMES FROM (never from the module under test):
//  - The INERT SET is the spec's own list (`**/*.md`, `docs/**`, `.claude/**`,
//    minus the `**/{__fixtures__,fixtures}/**` markdown exception), so every
//    "changes"/"unchanged" expectation below is read straight off the spec — the
//    tests never recompute a hash the way the module computes it, they only
//    state which edits a gate step could possibly notice.
//  - Blob identity across a RENAME and a content SWAP is asserted with an
//    INDEPENDENT `git hash-object` invocation, so "only the pairing changed" is
//    git's claim, not dobby's.
//  - The index is observed through git itself (`git diff --staged`,
//    `git ls-files -s`, `git status --porcelain`) before and after a hash, and
//    the one mutation that must NOT move the key — staging — is performed by
//    `git add -A` rather than by anything dobby owns.
//  - `configHash` is the sha256 of the fixture's `dobby.config.json` BYTES,
//    computed out of band with `shasum -a 256` (an independent tool, matching
//    the literal `hook.test.ts` already pins) and pasted here as a literal.
//  - `dobbyVersion` is read from `dobby --version` — an unrelated public surface
//    of the same CLI, never the constant the module reads.
//  - Cache contents are read back as the file's LITERAL BYTES and JSON-parsed by
//    the test; the LRU order, the cap of 5 and the eviction from the tail are
//    literal arrays the spec dictates.
//  - Ignored-ness of `.dobby/` is asked of `git check-ignore`, which is the tool
//    that actually decides it.
//  - A fixture holding a SUBMODULE or a SYMLINK is certified by git's own account
//    of the entry (`git ls-files -s`: mode 160000 is a gitlink, 120000 a symlink),
//    so those slices can never pass over a fixture that quietly became an
//    ordinary file or an ordinary directory.
//
// MOCKED BOUNDARIES: none. git is REAL throughout (throwaway repos under a
// pinned git env), the filesystem is real, and the clock is only ever asserted
// against a wide window — nothing internal is stubbed, so the whole file
// survives any restructuring behind the four verbs.
//
// FOURTEEN tests are GREEN before the module exists, deliberately: they are
// "must NOT" guards whose whole content is a side effect that must never happen
// (hashing must not stage anything, a mismatching cache must not be rewritten, a
// pre-upgrade record's verdict and a project's own `.gitignore` rules must
// survive, an unreadable cache must not throw, a path git cannot hand over
// verbatim must never yield a key). Each sits in a describe whose
// sibling assertion FAILS until the behaviour exists, so none of them can pass
// vacuously for long; every other assertion in this file fails today.
// ===========================================================================

const scratchDirs: string[] = [];

// --- The fixture project ----------------------------------------------------

const PACKAGE_JSON =
  '{\n  "name": "gate-cache-fixture",\n  "private": true\n}\n';

// A capability-relevant edit: `package.json` drives detection and preset choice,
// which is exactly why the spec keeps it OUT of the inert set.
const PACKAGE_JSON_WITH_DEP =
  '{\n  "name": "gate-cache-fixture",\n  "private": true,\n  "devDependencies": {\n    "vitest": "^4.0.0"\n  }\n}\n';

// The kit's per-project contract. Its EXACT bytes are the input to the cache's
// `configHash`, so they are pinned here and hashed out of band.
const DOBBY_CONFIG = '{\n\t"files": []\n}\n';

// `printf '{\n\t"files": []\n}\n' | shasum -a 256` — an independent tool, not a
// value recomputed the way the module computes it.
const DOBBY_CONFIG_SHA256 =
  "b35a5c252e345c216527bfa100d0b1d19988398d06fdb7838c756b6c80aaa9de";

const SOURCE_FILE = "src/app.ts";
const README = "README.md";
const GITIGNORE = ".gitignore";

const BASE_FILES: Record<string, string> = {
  // A project that ALREADY ignores `.dobby/` — the ordinary case. The fixtures
  // that need the opposite (a project with no `.gitignore` at all) ask for it
  // with `noGitignore`, and NOTHING dobby does may put one there.
  [GITIGNORE]: ".dobby/\nnode_modules/\n",
  [README]: "# fixture\n",
  [SOURCE_FILE]: "export const answer = 42;\n",
  "bun.lock": '{\n  "lockfileVersion": 1\n}\n',
  "docs/adr/0001-thing.md": "# 0001 — a decision\n",
  "src/module/CONTEXT.md": "# module\n",
};

// The fixture file set minus one entry — how a repo is asked for WITHOUT the
// file whose absence is the point (no `delete` on a shared constant).
function without(
  files: Record<string, string>,
  omitted: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).filter(([name]) => name !== omitted)
  );
}

function makeRepo(
  opts: {
    files?: Record<string, string>;
    noConfig?: boolean;
    noGitignore?: boolean;
  } = {}
): string {
  const base =
    opts.noGitignore === true ? without(BASE_FILES, GITIGNORE) : BASE_FILES;
  return makeScratchRepo({
    branch: "worktree-gate-cache",
    config: opts.noConfig === true ? undefined : DOBBY_CONFIG,
    files: { ...base, ...(opts.files ?? {}) },
    pkg: PACKAGE_JSON,
    prefix: "dobby-gatecache-",
    track: scratchDirs,
  });
}

// --- Repo mutation ----------------------------------------------------------

function writeInRepo(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function appendInRepo(root: string, relPath: string, extra: string): void {
  const path = join(root, relPath);
  writeInRepo(root, relPath, readFileSync(path, "utf8") + extra);
}

// --- Trees holding something other than plain files --------------------------

// Check a SECOND repository out inside `root` as a real submodule at `relPath`.
//
// `protocol.file.allow=always` is what modern git requires before it will clone
// over a local path, and it is passed with `-c` — it propagates to the clone git
// runs for itself — rather than written into a config file the pinned scratch env
// deliberately empties.
function addSubmodule(root: string, relPath: string): void {
  const inner = makeScratchRepo({
    files: { "lib/inner.ts": "export const inner = 1;\n" },
    prefix: "dobby-gatecache-sub-",
    track: scratchDirs,
  });
  gitIn(root, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    inner,
    relPath,
  ]);
}

// A TRACKED symlink at `relPath` pointing at `target` (relative to the link's own
// directory, or absolute for a target outside the repository), committed — the
// shape a repository's own symlinks have.
function trackSymlink(root: string, relPath: string, target: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-q", "-m", "link"]);
}

const OUTSIDE_FILE = "lib/outside.ts";

// A plain directory OUTSIDE any repository, holding one source file: what a
// directory symlink can point at while git sees nothing but the link.
function makeOutsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dobby-gatecache-outside-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, OUTSIDE_FILE), "export const outside = 1;\n");
  return dir;
}

// git's OWN account of one index entry (`<mode> <oid> <stage>\t<path>`): mode
// 160000 is a gitlink, 120000 a symlink, 100644 an ordinary file.
function indexMode(root: string, relPath: string): string {
  return gitIn(root, ["ls-files", "-s", relPath]).split(" ")[0] ?? "";
}

// --- Independent observers ---------------------------------------------------

// git's OWN content hash of a worktree file — the oracle for "these bytes did
// not change, only where they live".
function blobOid(root: string, relPath: string): string {
  return gitIn(root, ["hash-object", relPath]);
}

function headTree(root: string): string {
  return gitIn(root, ["rev-parse", "HEAD^{tree}"]);
}

// Whether git considers a path ignored — asked of the tool that decides it.
function isIgnored(root: string, relPath: string): boolean {
  return (
    spawnSync("git", ["check-ignore", "-q", relPath], {
      cwd: root,
      env: gitEnv(),
      stdio: "ignore",
    }).status === 0
  );
}

// --- The cache file, read as bytes -------------------------------------------

interface GreenInput {
  at: string;
  hash: string;
}

// Read-side view: every field optional, because the point of most assertions is
// what the module DID or DID NOT put in the file.
interface CacheFile {
  at?: string;
  configHash?: string | null;
  dobbyVersion?: string;
  exitCode?: number;
  greenInputs?: GreenInput[];
  treeHash?: string;
}

const CACHE_DIR = ".dobby";
const CACHE_FILE = "gate-cache.json";

function cachePath(root: string): string {
  return join(root, CACHE_DIR, CACHE_FILE);
}

function cacheBytes(root: string): string {
  return readFileSync(cachePath(root), "utf8");
}

function readCache(root: string): CacheFile {
  return JSON.parse(cacheBytes(root)) as CacheFile;
}

// The cache as it stands, or an EMPTY record when nothing was written — for the
// `beforeAll` blocks, where a raw ENOENT would skip the whole suite instead of
// failing the assertion that noticed the file is missing.
function readCacheOrEmpty(root: string): CacheFile {
  return existsSync(cachePath(root)) ? readCache(root) : {};
}

function greenEntries(root: string): GreenInput[] {
  return readCache(root).greenInputs ?? [];
}

function greenHashes(root: string): string[] {
  return greenEntries(root).map((entry) => entry.hash);
}

// A cache file the TEST wrote, byte by byte — the fixture for every "the module
// reads what someone else left behind" slice.
function seedCacheFile(root: string, cache: unknown): void {
  mkdirSync(join(root, CACHE_DIR), { recursive: true });
  writeFileSync(cachePath(root), `${JSON.stringify(cache, null, 2)}\n`);
}

// --- Hash fixtures -----------------------------------------------------------
// Code hashes are opaque strings to every verb but `computeCodeHash`, so the
// cache slices use literal sha256-shaped values: the LRU is then observable
// without the hasher being involved at all.

function fakeHash(seed: string): string {
  return seed.repeat(32);
}

const HASH_A = fakeHash("a1");
const HASH_B = fakeHash("b2");
const HASH_C = fakeHash("c3");
const HASH_D = fakeHash("d4");
const HASH_E = fakeHash("e5");
const HASH_F = fakeHash("f6");
const UNKNOWN_HASH = fakeHash("09");

const SHA256_HEX = /^[0-9a-f]{64}$/;

// "There IS a code hash here" — the anti-vacuity anchor every relational
// assertion needs, since `null` (the degraded, no-key answer) would otherwise
// satisfy "unchanged" and any "leaves git alone" guard.
function expectCodeHash(value: string | null): void {
  expect(value).toEqual(expect.stringMatching(SHA256_HEX));
}

// A wall-clock window wide enough for any machine, narrow enough that a stamp
// copied from a fixture (or left at the epoch) fails.
const CLOCK_WINDOW_MS = 5 * 60 * 1000;

function isRecent(stamp: string | undefined): boolean {
  if (stamp === undefined) {
    return false;
  }
  const parsed = Date.parse(stamp);
  return (
    Number.isFinite(parsed) && Math.abs(Date.now() - parsed) < CLOCK_WINDOW_MS
  );
}

// The running CLI's version, read through `dobby --version` (an unrelated public
// surface) so a hand-written cache can claim to have been written by THIS dobby.
let dobbyVersion = "";

beforeAll(async () => {
  dobbyVersion = (await run(["--version"], makeRepo())).stdout.trim();
});

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// ===========================================================================
// Slice 1 (tracer bullet) — there IS a code hash.
//
// The smallest thing that proves the seam: a real repository answers with a
// sha256, the same tree answers the same way twice, and a directory that is not
// a repository answers with nothing at all (the degraded state that must read as
// "run everything", never as a failure).
// ===========================================================================

describe("the code hash of a working tree", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeRepo();
  });

  it("is a sha256", () => {
    expectCodeHash(computeCodeHash(repo));
  });

  it("is the same for a tree nothing has touched", () => {
    const first = computeCodeHash(repo);
    expectCodeHash(first);
    expect(computeCodeHash(repo)).toBe(first);
  });

  it("does not exist outside a git repository", () => {
    const outside = makeRepo();
    // Anchor first: this very directory HAS a hash while it is a repository, so
    // the null below is git's absence and not a module that never answers.
    expectCodeHash(computeCodeHash(outside));
    rmSync(join(outside, ".git"), { force: true, recursive: true });
    expect(computeCodeHash(outside)).toBeNull();
  });
});

// ===========================================================================
// Slice 2 — hashing must leave the developer's git state alone.
//
// The load-bearing constraint (ADR-0017, index-neutral): `check` and the
// pre-push backstop compute this hash on every run, so anything that staged,
// wrote to the index, or otherwise mutated git would silently rewrite what the
// developer is about to commit. The fixture carries an UNTRACKED file, the one
// thing a naive `git add`-based implementation would swallow.
// ===========================================================================

describe("computing the code hash of a tree with untracked files", () => {
  const FRESH = "src/fresh.ts";
  let repo: string;
  let hash: string | null;
  let indexBefore: string;
  let statusBefore: string;

  beforeAll(() => {
    repo = makeRepo();
    writeInRepo(repo, FRESH, "export const fresh = 1;\n");
    indexBefore = gitIn(repo, ["ls-files", "-s"]);
    statusBefore = gitIn(repo, ["status", "--porcelain"]);
    hash = computeCodeHash(repo);
  });

  it("still answers with a hash", () => {
    // Anti-vacuity: an implementation that does nothing at all would pass every
    // "leaves git alone" assertion below.
    expectCodeHash(hash);
  });

  it("stages nothing", () => {
    expect(gitIn(repo, ["diff", "--staged"])).toBe("");
  });

  it("leaves the index byte-identical", () => {
    expect(gitIn(repo, ["ls-files", "-s"])).toBe(indexBefore);
  });

  it("leaves the untracked file untracked", () => {
    expect(gitIn(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(statusBefore).toContain(FRESH);
  });
});

// ===========================================================================
// Slice 2b — the OTHER half of "index-neutral": staging must not move the KEY.
//
// Slice 2 proves dobby never touches the index; this proves the index never
// touches the key. A developer who `git add`s mid-session (or runs `git add -p`,
// or whose editor stages for them) has changed nothing a gate step could see —
// the same bytes sit in the same paths — so a key that moved would throw away a
// green verdict for a purely clerical act, and "index-neutral" would be a name
// with nothing behind it. All three shapes an index can hold are in play at
// once: a modified tracked file, a new untracked file, a deleted tracked file.
// ===========================================================================

describe("staging the work in progress", () => {
  const FRESH = "src/fresh.ts";
  const DOOMED = "src/doomed.ts";
  let repo: string;
  let before: string | null;
  let after: string | null;
  let staged: string[];

  beforeAll(() => {
    repo = makeRepo({ files: { [DOOMED]: "export const doomed = 1;\n" } });
    appendInRepo(repo, SOURCE_FILE, "export const five = 5;\n");
    writeInRepo(repo, FRESH, "export const fresh = 1;\n");
    rmSync(join(repo, DOOMED));

    before = computeCodeHash(repo);
    // The independent mutation: git itself moves the work into the index.
    gitIn(repo, ["add", "-A"]);
    staged = gitIn(repo, ["diff", "--staged", "--name-only"])
      .split("\n")
      .sort();
    after = computeCodeHash(repo);
  });

  it("puts every kind of change into the index", () => {
    // Control: git's own account of what it staged, so the assertion below is
    // about a key surviving a REAL modification, addition and deletion.
    expect(staged).toEqual([DOOMED, FRESH, SOURCE_FILE].sort());
  });

  it("leaves the code hash exactly where it was", () => {
    expectCodeHash(before);
    expect(after).toBe(before);
  });
});

// ===========================================================================
// Slice 3 — WHAT the hash covers: the inert set.
//
// The whole point of the feature: an edit no gate step could possibly notice
// must not invalidate a green verdict, and an edit any step COULD notice must.
// Every expectation here is the spec's inert list read literally — never a
// re-derivation of what the module computes.
// ===========================================================================

interface Mutation {
  apply: (root: string) => void;
  name: string;
}

const INERT_EDITS: Mutation[] = [
  {
    apply: (root) => appendInRepo(root, README, "\nMore prose.\n"),
    name: "prose is added to the root README.md",
  },
  {
    apply: (root) =>
      writeInRepo(root, "plugin/skills/scope/SKILL.md", "# scope\n"),
    name: "a markdown file is added deep in the tree",
  },
  {
    apply: (root) => writeInRepo(root, "docs/adr/0002-next.md", "# 0002\n"),
    name: "an ADR is added under docs/",
  },
  {
    apply: (root) => writeInRepo(root, "docs/maps/plan.json", '{"a": 1}\n'),
    name: "a non-markdown file is added under docs/",
  },
  {
    apply: (root) => writeInRepo(root, ".claude/settings.json", '{"a": 1}\n'),
    name: "a file is added under .claude/",
  },
  {
    apply: (root) =>
      writeInRepo(root, "node_modules/pkg/index.js", "module.exports = 1;\n"),
    name: "a gitignored dependency is installed",
  },
  {
    apply: (root) =>
      seedCacheFile(root, {
        at: "2026-01-01T00:00:00.000Z",
        configHash: DOBBY_CONFIG_SHA256,
        dobbyVersion: "0.0.0-fixture",
        exitCode: 0,
        treeHash: "0".repeat(40),
      }),
    name: "dobby writes its own gate cache",
  },
];

const MATERIAL_EDITS: Mutation[] = [
  {
    apply: (root) => appendInRepo(root, SOURCE_FILE, "export const two = 2;\n"),
    name: "a tracked source file is edited",
  },
  {
    apply: (root) =>
      writeInRepo(root, "src/new.ts", "export const three = 3;\n"),
    name: "an untracked source file is added",
  },
  {
    apply: (root) => writeInRepo(root, "package.json", PACKAGE_JSON_WITH_DEP),
    name: "package.json declares a new dependency",
  },
  {
    apply: (root) =>
      writeInRepo(root, "bun.lock", '{\n  "lockfileVersion": 2\n}\n'),
    name: "bun.lock changes",
  },
  {
    apply: (root) => appendInRepo(root, ".gitignore", "*.log\n"),
    name: ".gitignore changes what counts as an input",
  },
  {
    apply: (root) =>
      writeInRepo(root, "src/__fixtures__/sample.md", "# fixture input\n"),
    name: "a markdown fixture is added under __fixtures__/",
  },
  {
    apply: (root) =>
      writeInRepo(root, "cli/fixtures/sample.md", "# fixture input\n"),
    name: "a markdown fixture is added under fixtures/",
  },
  {
    apply: (root) => rmSync(join(root, SOURCE_FILE)),
    name: "a tracked source file is deleted from the worktree",
  },
];

describe("the code hash — edits no gate step can see", () => {
  it.each(INERT_EDITS)("is unchanged when $name", ({ apply }) => {
    const repo = makeRepo();
    const before = computeCodeHash(repo);
    apply(repo);
    expectCodeHash(before);
    expect(computeCodeHash(repo)).toBe(before);
  });
});

describe("the code hash — edits a gate step can see", () => {
  it.each(MATERIAL_EDITS)("changes when $name", ({ apply }) => {
    const repo = makeRepo();
    const before = computeCodeHash(repo);
    apply(repo);
    const after = computeCodeHash(repo);
    expectCodeHash(before);
    // A deleted file must still leave a usable key — "excluded from the pair
    // set", never an enumeration failure that degrades the whole hash to null.
    expectCodeHash(after);
    expect(after).not.toBe(before);
  });
});

// ===========================================================================
// Slice 4 — the hash is over (path, blob) PAIRS.
//
// Two edits that leave the set of blob contents byte-identical — a rename and a
// swap — must still change the key. git itself certifies the blobs are the same,
// so a failure here means the pairing (or the path) fell out of the key.
// ===========================================================================

describe("the code hash — moving bytes around the tree", () => {
  it("changes when a file is renamed, though its bytes are untouched", () => {
    const repo = makeRepo();
    const before = computeCodeHash(repo);
    const oidBefore = blobOid(repo, SOURCE_FILE);
    renameSync(join(repo, SOURCE_FILE), join(repo, "src/renamed.ts"));

    // git's own verdict: the content did not change, only where it lives.
    expect(blobOid(repo, "src/renamed.ts")).toBe(oidBefore);
    expect(computeCodeHash(repo)).not.toBe(before);
  });

  it("changes when two files swap contents", () => {
    const first = "export const first = 1;\n";
    const second = "export const second = 2;\n";
    const repo = makeRepo({
      files: { "src/first.ts": first, "src/second.ts": second },
    });
    const before = computeCodeHash(repo);
    const oidsBefore = [
      blobOid(repo, "src/first.ts"),
      blobOid(repo, "src/second.ts"),
    ].sort();

    writeInRepo(repo, "src/first.ts", second);
    writeInRepo(repo, "src/second.ts", first);

    // Same paths, same blobs — only which blob sits at which path changed.
    expect(
      [blobOid(repo, "src/first.ts"), blobOid(repo, "src/second.ts")].sort()
    ).toEqual(oidsBefore);
    expect(computeCodeHash(repo)).not.toBe(before);
  });
});

// ===========================================================================
// Slice 4b — a path name git does not hand over verbatim.
//
// git prints a path holding a quote (or a newline, or a control byte) in its
// C-quoted form, and the same bytes are NOT a path any longer. The only two
// honest answers are "the real path, hashed" and "no key at all"; the dangerous
// third answer is a key that quietly DROPPED the file, because that key sits
// still while the file's bytes move — a green verdict served over code the gate
// never saw. `null` is the answer the module already gives for a path it cannot
// pass through (the newline case): every caller reads it as "nothing is known
// about this tree", which only ever costs a gate run.
// ===========================================================================

describe("a tree holding a file whose name starts with a quote", () => {
  const QUOTED = '"quoted.ts';

  it("has no code hash", () => {
    // Anchor: the very same fixture without that file DOES answer, so the null
    // below is about the path name and not a module that never answers.
    expectCodeHash(computeCodeHash(makeRepo()));
    const repo = makeRepo({
      files: { [QUOTED]: "export const quoted = 1;\n" },
    });
    expect(computeCodeHash(repo)).toBeNull();
  });

  it("has no code hash once that file is rewritten either", () => {
    // The failure this refuses: a key that survived this rewrite would be a
    // stale green over changed code.
    const repo = makeRepo({
      files: { [QUOTED]: "export const quoted = 1;\n" },
    });
    writeInRepo(repo, QUOTED, "export const quoted = 2;\n");
    expect(computeCodeHash(repo)).toBeNull();
  });
});

// ===========================================================================
// Slice 4c — a tree holding something git does not hand over as a plain file.
//
// `git ls-files` enumerates a checked-out SUBMODULE as its gitlink path and a
// SYMLINK as the link itself — never the files beneath or behind either, which
// the gate tools nonetheless read straight through. A key built from the
// survivors alone would therefore sit STILL while code under a submodule (or
// behind a directory symlink) changed: a later `check` would take a hit on a tree
// it never gated, which is the one failure this module exists to prevent.
//
// The only safe answer is NO KEY AT ALL — the same `null` the module already
// gives for a tree it cannot enumerate, which every caller reads as "run
// everything, record nothing". The cache is simply OFF in such a repository, and
// says nothing about it.
//
// The rule is "every input is a REGULAR FILE", so a symlink to a FILE — whose
// bytes `git hash-object` would in fact follow and hash — is unkeyable too:
// deciding per target kind would mean re-deriving soundness for each of them
// (dangling, looping, out-of-tree, retargeted between two questions about it),
// and the price of the stricter rule is only a full gate run.
// ===========================================================================

const SUBMODULE_PATH = "vendor/inner";
const LINKED_DIR = "vendor/linked";
const LINKED_FILE = "src/alias.ts";

describe("a tree holding a checked-out submodule", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeRepo();
    // Anchor: this very fixture HAS a key while it is an ordinary tree, so every
    // null below is the submodule speaking and not a module that stopped
    // answering.
    expectCodeHash(computeCodeHash(repo));
    addSubmodule(repo, SUBMODULE_PATH);
  });

  it("really holds a gitlink", () => {
    // git's own account of the entry: mode 160000 is a reference to another
    // repository, not a directory of files the enumeration could have reached.
    expect(indexMode(repo, SUBMODULE_PATH)).toBe("160000");
  });

  it("has no code hash", () => {
    expect(computeCodeHash(repo)).toBeNull();
  });

  it("still has none once the code inside the submodule changes", () => {
    // The stale green this refuses: the enumeration cannot see the submodule's
    // own files, so a key that survived this edit would freeze against
    // everything under here.
    writeInRepo(
      repo,
      `${SUBMODULE_PATH}/lib/inner.ts`,
      "export const inner = 2;\n"
    );
    expect(computeCodeHash(repo)).toBeNull();
  });
});

describe("a tree holding a symlink to a directory", () => {
  let repo: string;
  let outside: string;

  beforeAll(() => {
    repo = makeRepo();
    expectCodeHash(computeCodeHash(repo));
    outside = makeOutsideDir();
    trackSymlink(repo, LINKED_DIR, outside);
  });

  it("really holds a symlink", () => {
    // Mode 120000 — git tracked the LINK, not a copy of what it points at.
    expect(indexMode(repo, LINKED_DIR)).toBe("120000");
  });

  it("has no code hash", () => {
    expect(computeCodeHash(repo)).toBeNull();
  });

  it("still has none once the code behind the link changes", () => {
    writeFileSync(join(outside, OUTSIDE_FILE), "export const outside = 2;\n");
    expect(computeCodeHash(repo)).toBeNull();
  });
});

describe("a tree holding a symlink to a file", () => {
  it("has no code hash either", () => {
    // Control first: the same fixture without the link answers, so the null is
    // the symlink and nothing else.
    expectCodeHash(computeCodeHash(makeRepo()));
    const repo = makeRepo();
    trackSymlink(repo, LINKED_FILE, "app.ts");
    expect(indexMode(repo, LINKED_FILE)).toBe("120000");
    expect(computeCodeHash(repo)).toBeNull();
  });
});

describe("a tree holding an ordinary nested directory of files", () => {
  it("still has a code hash", () => {
    // The anti-vacuity control for all of Slice 4c: the SAME paths, filled with
    // plain files instead of a gitlink and a symlink, are keyed as usual — so
    // what costs the key above is what git could not hand over, never depth, a
    // vendor directory, or a module that gave up on nested trees.
    const repo = makeRepo({
      files: {
        [`${LINKED_DIR}/lib/outside.ts`]: "export const outside = 1;\n",
        [`${SUBMODULE_PATH}/lib/inner.ts`]: "export const inner = 1;\n",
      },
    });
    expect(indexMode(repo, `${SUBMODULE_PATH}/lib/inner.ts`)).toBe("100644");
    expectCodeHash(computeCodeHash(repo));
  });
});

// ===========================================================================
// Slice 5 — the hash describes CONTENT, not a place or a commit.
//
// Two repositories built independently (different temp dirs, different commits)
// whose non-inert files match must share a key. This is what makes the cache a
// statement about inputs rather than about one checkout's history.
// ===========================================================================

describe("two repositories whose non-inert files match", () => {
  it("share a code hash", () => {
    const first = makeRepo({ files: { "docs/only-here.md": "notes\n" } });
    const second = makeRepo({
      files: {
        ".claude/settings.json": '{"a": 1}\n',
        [README]: "# an entirely different readme\n",
      },
    });
    const hash = computeCodeHash(first);
    expectCodeHash(hash);
    expect(computeCodeHash(second)).toBe(hash);
  });
});

// ===========================================================================
// Slice 6 — the reason the module exists: remember a green tree, recognise it
// later. This is the round trip `check` will compose in T2.
// ===========================================================================

describe("a tree recorded green", () => {
  let repo: string;
  let note: string | null;
  let result: { at: string | null; hit: boolean };

  beforeAll(() => {
    repo = makeRepo();
    note = recordGreenInput(repo, HASH_A);
    result = consultGreenInputs(repo, HASH_A);
  });

  it("is recognised on the next consult", () => {
    expect(result.hit).toBe(true);
  });

  it("reports when it was proven green", () => {
    // The stamp the file actually holds — read back as bytes by the test.
    expect(result.at).toBe(greenEntries(repo)[0]?.at);
    expect(isRecent(result.at ?? undefined)).toBe(true);
  });

  it("records the hash itself", () => {
    expect(greenHashes(repo)).toEqual([HASH_A]);
  });

  it("reports no failure", () => {
    expect(note).toBeNull();
  });
});

describe("a tree that was never recorded", () => {
  it("is a miss with nothing to report", () => {
    const repo = makeRepo();
    recordGreenInput(repo, HASH_A);
    // Control: this cache DOES answer for the tree it knows, so the miss below
    // is about this hash and not about a cache that never answers at all.
    expect(consultGreenInputs(repo, HASH_A).hit).toBe(true);
    expect(consultGreenInputs(repo, UNKNOWN_HASH)).toEqual({
      at: null,
      hit: false,
    });
  });
});

describe("a tree recorded before other trees", () => {
  it("is still recognised from further down the list", () => {
    const repo = makeRepo();
    recordGreenInput(repo, HASH_A);
    recordGreenInput(repo, HASH_B);
    recordGreenInput(repo, HASH_C);
    expect(consultGreenInputs(repo, HASH_A).hit).toBe(true);
  });
});

describe("the hash of a real tree", () => {
  it("is recognised after the tree is recorded, and only until it changes", () => {
    const repo = makeRepo();
    const green = computeCodeHash(repo);
    expectCodeHash(green);
    recordGreenInput(repo, green ?? "");
    expect(consultGreenInputs(repo, green ?? "").hit).toBe(true);

    appendInRepo(repo, SOURCE_FILE, "export const four = 4;\n");
    const changed = computeCodeHash(repo);
    expect(consultGreenInputs(repo, changed ?? "").hit).toBe(false);
  });
});

// ===========================================================================
// Slice 7 — the LRU of five. Branch switching and reverts return to trees that
// were already proven green; keeping only the latest would lose those hits.
// ===========================================================================

describe("recording more green trees than the cache holds", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeRepo();
    for (const hash of [HASH_A, HASH_B, HASH_C, HASH_D, HASH_E, HASH_F]) {
      recordGreenInput(repo, hash);
    }
  });

  it("keeps the five most recent, most recent first", () => {
    expect(greenHashes(repo)).toEqual([HASH_F, HASH_E, HASH_D, HASH_C, HASH_B]);
  });

  it("forgets the oldest one", () => {
    // Control: the sixth-oldest's neighbour is still known, so the miss is
    // eviction rather than a cache that forgot everything.
    expect(consultGreenInputs(repo, HASH_B).hit).toBe(true);
    expect(consultGreenInputs(repo, HASH_A).hit).toBe(false);
  });

  it("still recognises the survivors", () => {
    const recognised = [HASH_B, HASH_C, HASH_D, HASH_E, HASH_F].filter(
      (hash) => consultGreenInputs(repo, hash).hit
    );
    expect(recognised).toEqual([HASH_B, HASH_C, HASH_D, HASH_E, HASH_F]);
  });
});

describe("recording a tree the cache already knows", () => {
  it("moves it to the front instead of duplicating it", () => {
    const repo = makeRepo();
    for (const hash of [HASH_A, HASH_B, HASH_C, HASH_D, HASH_E]) {
      recordGreenInput(repo, hash);
    }
    recordGreenInput(repo, HASH_C);
    expect(greenHashes(repo)).toEqual([HASH_C, HASH_E, HASH_D, HASH_B, HASH_A]);
  });
});

// ===========================================================================
// Slice 8 — GLOBAL INVALIDATION. `dobbyVersion` and `configHash` are file-level:
// either one moving changes what the gate DOES to an unchanged tree, so every
// remembered green becomes meaningless at once.
// ===========================================================================

function seedGreen(root: string, overrides: Partial<CacheFile>): void {
  seedCacheFile(root, {
    at: "2026-01-01T00:00:00.000Z",
    configHash: DOBBY_CONFIG_SHA256,
    dobbyVersion,
    exitCode: 0,
    greenInputs: [{ at: "2026-01-01T00:00:00.000Z", hash: HASH_A }],
    treeHash: "0".repeat(40),
    ...overrides,
  });
}

// Consult a repository whose cache the TEST wrote: one line per condition, so
// every negative case can state its own positive control.
function consultSeeded(
  overrides: Partial<CacheFile>,
  opts: { noConfig?: boolean } = {}
): { at: string | null; hit: boolean } {
  const repo = makeRepo(opts);
  seedGreen(repo, overrides);
  return consultGreenInputs(repo, HASH_A);
}

describe("a cache written under different conditions", () => {
  it("is honoured when the version and the config both still match", () => {
    // The positive control, also inlined in every miss below: without it, a miss
    // could be the module refusing hand-written files rather than noticing the
    // mismatch.
    expect(consultSeeded({}).hit).toBe(true);
  });

  it("is ignored when another dobby version wrote it", () => {
    expect(consultSeeded({}).hit).toBe(true);
    expect(consultSeeded({ dobbyVersion: "0.0.0-stale" })).toEqual({
      at: null,
      hit: false,
    });
  });

  it("is ignored when dobby.config.json changed since", () => {
    expect(consultSeeded({}).hit).toBe(true);
    expect(consultSeeded({ configHash: "0".repeat(64) })).toEqual({
      at: null,
      hit: false,
    });
  });

  it("is left exactly as it was found", () => {
    const repo = makeRepo();
    seedGreen(repo, { dobbyVersion: "0.0.0-stale" });
    const before = cacheBytes(repo);
    consultGreenInputs(repo, HASH_A);
    expect(cacheBytes(repo)).toBe(before);
  });
});

describe("a project with no dobby.config.json", () => {
  it("honours a cache that recorded no config either", () => {
    expect(consultSeeded({ configHash: null }, { noConfig: true }).hit).toBe(
      true
    );
  });

  it("ignores a cache written while a config still existed", () => {
    expect(consultSeeded({ configHash: null }, { noConfig: true }).hit).toBe(
      true
    );
    expect(
      consultSeeded({ configHash: DOBBY_CONFIG_SHA256 }, { noConfig: true }).hit
    ).toBe(false);
  });
});

// ===========================================================================
// Slice 8b — global invalidation on the WRITE path, which is where it can do
// real damage. Slice 8 proves a stale-stamped cache is not BELIEVED; this proves
// it is not CARRIED. A read-modify-write that merged the new entry into the old
// file would re-stamp it with the running dobby and the config in force — and
// every verdict the previous dobby recorded would come back to life wearing this
// one's name, for both the remembered green trees and the flat record the
// pre-push backstop trusts.
// ===========================================================================

describe("recording a green tree over a cache another dobby version wrote", () => {
  const STALE_TREE = "2".repeat(40);
  let repo: string;

  beforeAll(() => {
    repo = makeRepo();
    seedGreen(repo, { dobbyVersion: "0.0.0-stale", treeHash: STALE_TREE });
    recordGreenInput(repo, HASH_B);
  });

  it("keeps only the tree this dobby just proved", () => {
    expect(greenHashes(repo)).toEqual([HASH_B]);
  });

  it("never brings the older dobby's green back to life", () => {
    // Control: the file DOES answer for what this dobby recorded, so the miss is
    // the discarded entry and not a cache nobody can read.
    expect(consultGreenInputs(repo, HASH_B).hit).toBe(true);
    expect(consultGreenInputs(repo, HASH_A).hit).toBe(false);
  });

  it("does not hand the pre-push backstop the older dobby's verdict", () => {
    expect(readCache(repo).treeHash ?? null).not.toBe(STALE_TREE);
  });
});

describe("recording a green tree over a cache a different dobby.config.json wrote", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeRepo();
    seedGreen(repo, { configHash: "0".repeat(64) });
    recordGreenInput(repo, HASH_B);
  });

  it("keeps only the tree this config just proved", () => {
    expect(greenHashes(repo)).toEqual([HASH_B]);
  });

  it("re-stamps the file with the config in force now", () => {
    // Behavioural proof the stamp moved with the rewrite: the entry it just
    // wrote is honoured on the next consult.
    expect(consultGreenInputs(repo, HASH_B).hit).toBe(true);
  });
});

describe("ship's record written over a cache another dobby version wrote", () => {
  let repo: string;
  let tree: string;

  beforeAll(() => {
    repo = makeRepo();
    seedGreen(repo, { dobbyVersion: "0.0.0-stale", treeHash: "3".repeat(40) });
    tree = headTree(repo);
    writeShipRecord(repo, tree, 0);
  });

  it("keeps none of the older dobby's green trees", () => {
    // `writeShipRecord` preserves greenInputs — but only ones this dobby, under
    // this config, actually proved.
    expect(greenHashes(repo)).toEqual([]);
  });

  it("records this dobby's verdict on the tree it was given", () => {
    // Anchor: the write really happened, so the empty list above is a discard
    // rather than a no-op.
    expect(readCache(repo).treeHash).toBe(tree);
    expect(readCache(repo).dobbyVersion).toBe(dobbyVersion);
  });
});

// ===========================================================================
// Slice 9 — a cache that cannot be trusted is simply ABSENT. Every degraded
// state must read as "nothing is known about this tree", never as an error: the
// caller's answer to a miss is to run the gate, which is always safe.
// ===========================================================================

describe("a cache that cannot be read", () => {
  it("is a miss when the file was never written", () => {
    const repo = makeRepo();
    expect(existsSync(cachePath(repo))).toBe(false);
    expect(consultGreenInputs(repo, HASH_A)).toEqual({ at: null, hit: false });
  });

  it("is a miss when the file is not valid JSON", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, CACHE_DIR), { recursive: true });
    writeFileSync(cachePath(repo), "{ this is not json\n");
    expect(consultGreenInputs(repo, HASH_A)).toEqual({ at: null, hit: false });
  });

  it("is replaced by the next green tree recorded over it", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, CACHE_DIR), { recursive: true });
    writeFileSync(cachePath(repo), "{ this is not json\n");
    recordGreenInput(repo, HASH_A);
    expect(consultGreenInputs(repo, HASH_A).hit).toBe(true);
  });

  it("is a miss when the file is a pre-upgrade flat record", () => {
    const repo = makeRepo();
    seedCacheFile(repo, {
      at: "2026-01-01T00:00:00.000Z",
      configHash: DOBBY_CONFIG_SHA256,
      dobbyVersion,
      exitCode: 0,
      treeHash: "0".repeat(40),
    });
    expect(consultGreenInputs(repo, HASH_A)).toEqual({ at: null, hit: false });
  });
});

describe("the first green input recorded over a pre-upgrade flat record", () => {
  const LEGACY_TREE = "1".repeat(40);
  let repo: string;

  beforeAll(() => {
    repo = makeRepo();
    seedCacheFile(repo, {
      at: "2026-01-01T00:00:00.000Z",
      configHash: DOBBY_CONFIG_SHA256,
      dobbyVersion,
      exitCode: 0,
      treeHash: LEGACY_TREE,
    });
    recordGreenInput(repo, HASH_A);
  });

  it("is remembered", () => {
    expect(greenHashes(repo)).toEqual([HASH_A]);
  });

  it("leaves the pre-push fast path's verdict intact", () => {
    // The flat record is the backstop's contract and belongs to `ship`; adding a
    // green input must never revoke a tree it already cleared.
    expect(readCache(repo).treeHash).toBe(LEGACY_TREE);
    expect(readCache(repo).exitCode).toBe(0);
  });
});

// ===========================================================================
// Slice 10 — the file the module leaves on disk. `.dobby/` holds dobby's own
// bookkeeping: it must be invisible to git (an un-ignored cache would change the
// inputs it is keyed on, and would end up committed), and a write must not leave
// its own scratch files behind.
//
// Ignored-ness is a PROPERTY, asked of `git check-ignore` — never a mechanism.
// WHERE the rule lives is the module's business; that it holds, and that getting
// it to hold cost the developer's tree NOTHING, is what these tests state.
// ===========================================================================

describe("writing the cache in a project that does not ignore .dobby/", () => {
  const OTHER_RULES = "node_modules/\n*.log\n";
  let repo: string;

  beforeAll(() => {
    repo = makeRepo({ files: { ".gitignore": OTHER_RULES } });
    recordGreenInput(repo, HASH_A);
  });

  it("makes git ignore the cache", () => {
    expect(isIgnored(repo, join(CACHE_DIR, CACHE_FILE))).toBe(true);
  });

  it("keeps the rules that were already there", () => {
    const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("*.log");
  });
});

describe("writing ship's record in a project that does not ignore .dobby/", () => {
  it("makes git ignore the cache", () => {
    const repo = makeRepo({ files: { ".gitignore": "node_modules/\n" } });
    writeShipRecord(repo, headTree(repo), 0);
    expect(isIgnored(repo, join(CACHE_DIR, CACHE_FILE))).toBe(true);
  });
});

// ===========================================================================
// Slice 10b — BOOKKEEPING MUST NOT DIRTY THE TREE. The field bug this pins: a
// GREEN gate left the working tree modified, because making `.dobby/` ignored
// meant appending to (or creating) `.gitignore` — a VERSIONED file. Every caller
// that composes `check()` in process inherits that dirt, and one of them
// (`release`) refuses to run on a dirty tree at all, so a green gate broke the
// release it was clearing.
//
// The fixture is the worst case: a project with NO `.gitignore` whatsoever, where
// the old mechanism had to CREATE one. Both write paths run, and the whole
// verdict is `git status --porcelain` — asked of git, and read for EMPTINESS, so
// it covers not just the file we know about but anything else a write might leave
// behind. The ignore guarantee is asserted alongside it: this is a tree that is
// clean AND a cache git will never see, not a cache that was simply never written.
// ===========================================================================

describe("recording in a project with no .gitignore at all", () => {
  let repo: string;
  let recordNote: string | null;
  let shipNote: string | null;

  beforeAll(() => {
    repo = makeRepo({ noGitignore: true });
    // Anti-vacuity anchor: the fixture really has no ignore file of its own, so
    // the clean tree below cannot come from a rule that was already there.
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(gitIn(repo, ["status", "--porcelain"])).toBe("");
    recordNote = recordGreenInput(repo, HASH_A);
    shipNote = writeShipRecord(repo, headTree(repo), 0);
  });

  it("writes the cache to disk", () => {
    // The writes really happened — every "left nothing behind" assertion below
    // would pass for a module that did nothing at all.
    expect(recordNote).toBeNull();
    expect(shipNote).toBeNull();
    expect(existsSync(cachePath(repo))).toBe(true);
  });

  it("still makes git ignore the cache", () => {
    expect(isIgnored(repo, join(CACHE_DIR, CACHE_FILE))).toBe(true);
  });

  it("leaves the working tree exactly as clean as it found it", () => {
    // The whole property, in git's own words: no `?? .gitignore` (a versioned
    // file dobby created), no `?? .dobby/` (an un-ignored cache), nothing.
    expect(gitIn(repo, ["status", "--porcelain"])).toBe("");
  });

  it("never creates a .gitignore of its own", () => {
    // Spelled out separately from the porcelain check, because THIS is the
    // regression: bookkeeping may not author a versioned file.
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("leaves a repository whose green input is still recognised", () => {
    // A clean tree bought by never recording anything would be worthless.
    expect(consultGreenInputs(repo, HASH_A).hit).toBe(true);
  });
});

describe("recording where the ignore rule cannot be placed at all", () => {
  it("still records, and still reports no failure", () => {
    // No git, so there is no ignore rule to write anywhere — the degraded state
    // this module answers everywhere else with a miss, never an error. The RECORD
    // is bookkeeping's product; making the cache invisible is a courtesy that must
    // never hold it hostage.
    const outside = makeRepo();
    rmSync(join(outside, ".git"), { force: true, recursive: true });
    expect(recordGreenInput(outside, HASH_A)).toBeNull();
    expect(consultGreenInputs(outside, HASH_A).hit).toBe(true);
  });
});

describe("the state directory after a write", () => {
  it("holds the cache and nothing else", () => {
    const repo = makeRepo();
    recordGreenInput(repo, HASH_A);
    writeShipRecord(repo, headTree(repo), 0);
    recordGreenInput(repo, HASH_B);
    expect(readdirSync(join(repo, CACHE_DIR))).toEqual([CACHE_FILE]);
  });
});

describe("recording a green input", () => {
  it("never claims the repository's committed tree passed the gate", () => {
    // The flat record is `ship`'s alone, written only after a green gate over a
    // staged tree. `check` runs over a WORKING tree that may differ from HEAD, so
    // filling in a tree hash here would hand the pre-push backstop a free pass on
    // a tree nothing ever gated.
    const repo = makeRepo();
    recordGreenInput(repo, HASH_A);
    expect(readCache(repo).treeHash ?? null).not.toBe(headTree(repo));
  });
});

// ===========================================================================
// Slice 11 — ship's FLAT RECORD, the pre-push backstop's fast-path contract.
// The module writes it; `hook-install.ts`'s independent reader consumes it.
// ===========================================================================

describe("ship's record of a gated tree", () => {
  let repo: string;
  let tree: string;
  let note: string | null;
  let cache: CacheFile;

  beforeAll(() => {
    repo = makeRepo();
    tree = headTree(repo);
    note = writeShipRecord(repo, tree, 0);
    cache = readCacheOrEmpty(repo);
  });

  it("reports no failure", () => {
    expect(note).toBeNull();
  });

  it("names the tree it was given", () => {
    expect(cache.treeHash).toBe(tree);
  });

  it("records the verdict it was given", () => {
    expect(cache.exitCode).toBe(0);
  });

  it("records the running dobby's version", () => {
    expect(cache.dobbyVersion).toBe(dobbyVersion);
  });

  it("records the hash of dobby.config.json's bytes", () => {
    expect(cache.configHash).toBe(DOBBY_CONFIG_SHA256);
  });

  it("says when it was written", () => {
    expect(isRecent(cache.at)).toBe(true);
  });
});

describe("ship's record of a tree that failed", () => {
  it("records the failing verdict rather than assuming green", () => {
    const repo = makeRepo();
    writeShipRecord(repo, headTree(repo), 1);
    expect(readCache(repo).exitCode).toBe(1);
  });
});

describe("ship's record in a project with no dobby.config.json", () => {
  it("records that there was no config to hash", () => {
    const repo = makeRepo({ noConfig: true });
    writeShipRecord(repo, headTree(repo), 0);
    expect(readCache(repo).configHash).toBeNull();
  });
});

describe("ship's record written over remembered green trees", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeRepo();
    recordGreenInput(repo, HASH_A);
    recordGreenInput(repo, HASH_B);
    writeShipRecord(repo, headTree(repo), 0);
  });

  it("keeps every remembered tree", () => {
    expect(greenHashes(repo)).toEqual([HASH_B, HASH_A]);
  });

  it("still recognises them afterwards", () => {
    expect(consultGreenInputs(repo, HASH_A).hit).toBe(true);
  });

  it("still carries the flat record", () => {
    expect(readCache(repo).treeHash).toBe(headTree(repo));
  });
});

// ===========================================================================
// Slice 12 — a cache that cannot be WRITTEN is a note, never a crash. The gate's
// verdict must not depend on dobby's bookkeeping succeeding.
// ===========================================================================

describe("a state directory that cannot be created", () => {
  // `.dobby` occupied by a plain FILE: the directory can never be made.
  function blockedRepo(): string {
    const repo = makeRepo();
    writeFileSync(join(repo, CACHE_DIR), "not a directory\n");
    return repo;
  }

  it("turns a failed green record into a note", () => {
    const note = recordGreenInput(blockedRepo(), HASH_A);
    expect(note).toMatch(/cache/i);
  });

  it("turns a failed ship record into a note", () => {
    const repo = blockedRepo();
    const note = writeShipRecord(repo, headTree(repo), 0);
    expect(note).toMatch(/cache/i);
  });

  it("still answers a consult with a miss", () => {
    const repo = blockedRepo();
    expect(consultGreenInputs(repo, HASH_A)).toEqual({ at: null, hit: false });
  });
});
