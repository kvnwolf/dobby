import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitIn,
  makeScratchRepo,
  mkStubBins,
  restoreEnv,
  type StubResponse,
  stubPath,
} from "./test-helpers.ts";

// ===========================================================================
// The SESSION PREFLIGHTS — `dobby scope preflight --slug <s>` and
// `dobby finish --preflight`.
//
// Both are READ-ONLY verdicts a stage asks for BEFORE it acts: they compute the
// predicate, and every destructive AskUserQuestion gate stays in the SKILL. A
// preflight therefore never creates, removes, or enters anything — these tests
// assert facts about a tree they built themselves, and the tree must survive.
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008): the domain
// module is never imported directly, so its internals can be restructured freely
// without touching this file.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - `worktree-<slug>` (the branch) and `.claude/worktrees/<slug>/` (the path) are
//    the kit's literal naming, stated verbatim in the task spec and in the scope /
//    finish SKILL.md ("branch `worktree-<slug>`", "path `.claude/worktrees/<slug>/`").
//  - Every slug in the fixtures is a literal WE choose, and every worktree/branch
//    that exists is one WE created with real `git worktree add` — so collision,
//    nesting, and the parallel-worktree listing are all facts of a tree whose exact
//    contents we wrote down, never facts recomputed the way the code computes them.
//  - The `pr` payload is exactly what our stub `gh` printed (the external boundary's
//    answer): the assertion is that the CLI passes the boundary's answer THROUGH
//    unchanged, keyed on the branch it asked about.
//  - The verdict rules (`safe` = MERGED + clean, `blocked` = dobby not installed,
//    else `confirm-required`), `branchDeleteSafe` = (pr.state === "MERGED"), the
//    `same-session|orphan` modes and their `ExitWorktree|raw-git` mechanisms are the
//    spec's / the finish SKILL.md's literal wording.
//  - "dobby must run inside a git repository" is the CLI's established hard-error
//    literal for an action command outside a repo.
//
// The ONE boundary that is mocked is `gh` (an external API over the network),
// stubbed as an executable on PATH — the repo's established stub-bin seam. `git` is
// REAL throughout: temp repos + real `git worktree add` fixtures are what make the
// nesting/collision/candidate facts trustworthy.
// ===========================================================================

// The shared seams (`test-helpers.ts`) supply everything generic here: the pinned
// git env + `gitIn` observer (so fixtures build identically on any machine,
// whatever the developer's signing/hooks/templates config), the scratch-repo
// maker, and the stub-bin-on-PATH seam. Only the KIT-SHAPED fixture helpers below
// (a worktree at `.claude/worktrees/<slug>`, a local dobby install) are local —
// they encode this domain's layout, not generic plumbing.
//
// The stub dir prepended to PATH holds ONLY `gh`, so every `git` spawn — the
// fixtures' and the CLI's alike — still resolves to the real binary.

// A trailing `/` on a returned path is presentational — normalized away before an
// absolute-path comparison (top-level per the repo's useTopLevelRegex convention).
const TRAILING_SLASH = /\/$/;

const scratchDirs: string[] = [];

// The kit's worktree location for a slug — the literal `.claude/worktrees/<slug>`
// under the main checkout (scope SKILL.md), used to BUILD the fixtures.
function worktreePathFor(mainRoot: string, slug: string): string {
  return join(mainRoot, ".claude", "worktrees", slug);
}

// Mark a root as carrying a local dobby install, the way the finish skill probes it
// (`node_modules/.bin/dobby` executable) AND the way a manifest reader would
// (`@kvnwolf/dobby` in devDependencies) — both signals agree in every fixture, so no
// assertion here depends on which one the implementation reads.
function installDobby(root: string): void {
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "dobby");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
}

// A throwaway MAIN checkout: a real git repo on `main` whose tracked tree is
// COMMITTED up front (README, .gitignore, package.json, and — when asked — a
// dobby.config.json), so every worktree cut from it starts CLEAN. node_modules/ and
// .claude/ are gitignored, so the local dobby install and the kit worktrees we add
// under `.claude/worktrees/` never register as uncommitted changes.
function makeMainCheckout(opts: { config?: boolean; dobby?: boolean }): string {
  const dir = makeScratchRepo({
    branch: "main",
    config: opts.config === true ? { files: [] } : undefined,
    files: {
      ".gitignore": "node_modules/\n.claude/\n",
      README: "scratch\n",
    },
    pkg: {
      devDependencies:
        opts.dobby === true ? { "@kvnwolf/dobby": "workspace:*" } : undefined,
      name: "scratch-preflight",
    },
    prefix: "dobby-preflight-",
    track: scratchDirs,
  });
  if (opts.dobby === true) {
    installDobby(dir);
  }
  return dir;
}

// Add a real kit worktree: branch `worktree-<slug>` checked out at
// `<main>/.claude/worktrees/<slug>` — the exact shape the native EnterWorktree
// creates. Returns its absolute path.
function addKitWorktree(
  mainRoot: string,
  slug: string,
  opts: { dobby?: boolean } = {}
): string {
  mkdirSync(join(mainRoot, ".claude", "worktrees"), { recursive: true });
  const path = worktreePathFor(mainRoot, slug);
  gitIn(mainRoot, ["worktree", "add", "-q", "-b", `worktree-${slug}`, path]);
  if (opts.dobby) {
    installDobby(path);
  }
  return path;
}

// A plain temp dir that is NOT a git repo — the "outside a repo" case.
function makeNonGitDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "dobby-preflight-plain-"))
  );
  scratchDirs.push(dir);
  return dir;
}

// --- The `gh` boundary ------------------------------------------------------
// The ONLY mocked dependency: an executable `gh` on PATH answering
// `gh pr view <branch> --json state,mergedAt,url` for the branches this suite
// creates, and exiting 1 (gh's "no pull requests found") for every other branch —
// which is precisely what a branch with no PR looks like. Keyed on the branch so a
// preflight that asked about the WRONG branch gets a different (or no) answer.

const PR_SHIP_IT = {
  mergedAt: "2026-07-20T10:00:00Z",
  state: "MERGED",
  url: "https://github.com/acme/scratch/pull/7",
};
const PR_WIP_GOAL = {
  mergedAt: null,
  state: "OPEN",
  url: "https://github.com/acme/scratch/pull/8",
};
const PR_ORPHAN_GOAL = {
  mergedAt: "2026-07-21T11:30:00Z",
  state: "MERGED",
  url: "https://github.com/acme/scratch/pull/9",
};
const PR_NO_DOBBY = {
  mergedAt: "2026-07-22T08:15:00Z",
  state: "MERGED",
  url: "https://github.com/acme/scratch/pull/10",
};

// Matching is a literal substring of the joined argv, first-wins in order: each
// branch answers with its own PR, and the trailing catch-all is gh's real
// behavior for a branch with no pull request (exit 1 on stderr).
const GH_ANSWERS: StubResponse[] = [
  { match: "worktree-no-dobby", stdout: JSON.stringify(PR_NO_DOBBY) },
  { match: "worktree-orphan-goal", stdout: JSON.stringify(PR_ORPHAN_GOAL) },
  { match: "worktree-ship-it", stdout: JSON.stringify(PR_SHIP_IT) },
  { match: "worktree-wip-goal", stdout: JSON.stringify(PR_WIP_GOAL) },
  { exitCode: 1, stderr: "no pull requests found for branch\n" },
];

let originalPath: string | undefined;

beforeAll(() => {
  const dir = mkStubBins({ gh: GH_ANSWERS }, scratchDirs);
  originalPath = process.env.PATH;
  process.env.PATH = stubPath(dir);
});

afterAll(() => {
  restoreEnv("PATH", originalPath);
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// --- The payload shapes (the spec's field list, nothing more) ---------------

interface WorktreeRef {
  branch: string;
  path: string;
  slug: string;
}

interface ScopePreflight {
  branch: string;
  collision: { branchExists: boolean; dirExists: boolean };
  configPresent: boolean;
  dobbyInstalled: boolean;
  existingWorktrees: WorktreeRef[];
  mainRoot: string;
  nested: {
    currentSlug: string | null;
    insideWorktree: boolean;
    worktreeRoot: string | null;
  };
  path: string;
  slug: string;
  suggestedSlug: string | null;
}

interface FinishPreflight {
  branch: string;
  branchDeleteSafe: boolean;
  candidates: WorktreeRef[];
  dirty: { count: number; files: string[] };
  dobbyInstalled: boolean;
  mainRoot: string;
  mode: string;
  pr: { mergedAt: string | null; state: string; url: string } | null;
  reasons: string[];
  removeMechanism: string;
  slug: string;
  verdict: string;
  worktreePath: string;
}

async function scopePreflight(
  cwd: string,
  slug: string
): Promise<ScopePreflight> {
  const result = await run(
    ["scope", "preflight", "--slug", slug, "--json"],
    cwd
  );
  expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as ScopePreflight;
}

async function finishPreflight(
  cwd: string,
  slug?: string
): Promise<FinishPreflight> {
  const argv = ["finish", "--preflight", "--json"];
  if (slug !== undefined) {
    argv.push("--slug", slug);
  }
  const result = await run(argv, cwd);
  expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as FinishPreflight;
}

// ===========================================================================
// Slice 1 (tracer bullet) — `scope preflight` projects the goal's identity.
//
// The very first thing scope needs before it calls the native EnterWorktree: for
// slug `add-csv-export`, WHICH branch and WHICH directory this goal would take,
// whether either already exists, and where the main checkout is. Run from a clean
// main checkout that has NO worktrees at all.
// ===========================================================================

describe("scope preflight — the goal's branch and worktree path", () => {
  let mainRoot: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
  });

  it("names the branch the goal would take as worktree-<slug>", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.branch).toBe("worktree-add-csv-export");
  });

  it("echoes the requested slug", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.slug).toBe("add-csv-export");
  });

  it("names the worktree path the goal would take under .claude/worktrees", async () => {
    // The spec's literal, trailing slash included: `.claude/worktrees/<s>/`
    // (relative to mainRoot, which the payload also carries).
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.path).toBe(".claude/worktrees/add-csv-export/");
  });

  it("reports the main checkout root", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.mainRoot).toBe(mainRoot);
  });

  it("reports no collision for a slug no branch or directory uses", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.collision).toEqual({
      branchExists: false,
      dirExists: false,
    });
  });

  it("suggests no alternative slug when there is no collision", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.suggestedSlug).toBe(null);
  });

  it("reports no nesting when run from the main checkout", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.nested).toEqual({
      currentSlug: null,
      insideWorktree: false,
      worktreeRoot: null,
    });
  });

  it("reports the dobby contract as present (config file + local install)", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect({
      configPresent: preflight.configPresent,
      dobbyInstalled: preflight.dobbyInstalled,
    }).toEqual({ configPresent: true, dobbyInstalled: true });
  });

  it("lists no existing kit worktrees in a repo that has none", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect(preflight.existingWorktrees).toEqual([]);
  });
});

describe("scope preflight — a repo that was never onboarded", () => {
  let mainRoot: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: false, dobby: false });
  });

  it("reports the dobby contract as absent (no config file, no local install)", async () => {
    const preflight = await scopePreflight(mainRoot, "add-csv-export");
    expect({
      configPresent: preflight.configPresent,
      dobbyInstalled: preflight.dobbyInstalled,
    }).toEqual({ configPresent: false, dobbyInstalled: false });
  });
});

// ===========================================================================
// Slice 2 — collision: the guard that keeps a new goal from clobbering another's
// worktree. `collide-me` is a slug we ALREADY spent on a real worktree (branch
// `worktree-collide-me` + `.claude/worktrees/collide-me/`); `ghost` is a branch we
// created WITHOUT a worktree — the case only `git show-ref` can see.
// ===========================================================================

describe("scope preflight — slug collision", () => {
  let mainRoot: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
    addKitWorktree(mainRoot, "collide-me");
    gitIn(mainRoot, ["branch", "worktree-ghost"]);
  });

  it("reports both the branch and the directory as taken for a slug already in use", async () => {
    const preflight = await scopePreflight(mainRoot, "collide-me");
    expect(preflight.collision).toEqual({
      branchExists: true,
      dirExists: true,
    });
  });

  it("reports a branch-only collision when the branch exists without a worktree directory", async () => {
    const preflight = await scopePreflight(mainRoot, "ghost");
    expect(preflight.collision).toEqual({
      branchExists: true,
      dirExists: false,
    });
  });

  it("suggests a collision-free variant of the colliding slug", async () => {
    const preflight = await scopePreflight(mainRoot, "collide-me");
    const suggested = preflight.suggestedSlug;
    // The only kit branch/dir in this fixture is `collide-me`, so "collision-free"
    // is checkable outright: anything else is free, and its directory must not exist.
    expect(suggested).not.toBe(null);
    expect(suggested).not.toBe("collide-me");
    expect(suggested).toContain("collide-me");
    expect(existsSync(worktreePathFor(mainRoot, suggested ?? ""))).toBe(false);
  });
});

// ===========================================================================
// Slice 3 — nesting + parallelism. A session already inside a kit worktree cannot
// create another (the native tool can't nest), so scope must SEE that it is inside
// `.claude/worktrees/<x>/` and which goal owns it. Parallel worktrees are normal —
// they are reported as information, never as a refusal (exit stays 0).
// ===========================================================================

describe("scope preflight — run from inside another goal's worktree", () => {
  let mainRoot: string;
  let otherWorktree: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
    otherWorktree = addKitWorktree(mainRoot, "other-goal");
  });

  it("detects that the session is already inside a kit worktree and names its goal", async () => {
    const preflight = await scopePreflight(otherWorktree, "new-goal");
    expect(preflight.nested).toEqual({
      currentSlug: "other-goal",
      insideWorktree: true,
      worktreeRoot: otherWorktree,
    });
  });

  it("detects nesting from a subdirectory of the worktree, reporting the worktree ROOT", async () => {
    const nested = join(otherWorktree, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const preflight = await scopePreflight(nested, "new-goal");
    expect(preflight.nested).toEqual({
      currentSlug: "other-goal",
      insideWorktree: true,
      worktreeRoot: otherWorktree,
    });
  });

  it("reports the MAIN checkout root, not the worktree, from inside a worktree", async () => {
    const preflight = await scopePreflight(otherWorktree, "new-goal");
    expect(preflight.mainRoot).toBe(mainRoot);
  });

  it("lists the other goal's worktree as information (parallel worktrees are normal)", async () => {
    const preflight = await scopePreflight(mainRoot, "new-goal");
    expect(preflight.existingWorktrees).toHaveLength(1);
    const [entry] = preflight.existingWorktrees;
    expect({ branch: entry?.branch, slug: entry?.slug }).toEqual({
      branch: "worktree-other-goal",
      slug: "other-goal",
    });
    expect(entry?.path).toContain(join(".claude", "worktrees", "other-goal"));
  });

  it("never refuses over an existing parallel worktree (exit 0)", async () => {
    const result = await run(
      ["scope", "preflight", "--slug", "new-goal", "--json"],
      mainRoot
    );
    expect(result.exitCode).toBe(0);
  });
});

// ===========================================================================
// Slice 4 — `finish --preflight`, same-session, the clean happy path: the PR
// merged and the worktree has nothing uncommitted, so teardown is SAFE and the
// skill can proceed without a destructive-action prompt.
// ===========================================================================

describe("finish --preflight — merged PR, clean worktree (same session)", () => {
  let mainRoot: string;
  let worktree: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
    worktree = addKitWorktree(mainRoot, "ship-it", { dobby: true });
  });

  it("verdicts the teardown safe", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.verdict).toBe("safe");
  });

  it("carries no reasons on the safe path", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.reasons).toEqual([]);
  });

  it("identifies the target from the current worktree as same-session", async () => {
    const preflight = await finishPreflight(worktree);
    expect({
      branch: preflight.branch,
      mode: preflight.mode,
      slug: preflight.slug,
    }).toEqual({
      branch: "worktree-ship-it",
      mode: "same-session",
      slug: "ship-it",
    });
  });

  it("resolves the target worktree path and the main checkout root", async () => {
    const preflight = await finishPreflight(worktree);
    expect({
      mainRoot: preflight.mainRoot,
      worktreePath: preflight.worktreePath.replace(TRAILING_SLASH, ""),
    }).toEqual({ mainRoot, worktreePath: worktree });
  });

  it("removes a same-session worktree through the native ExitWorktree", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.removeMechanism).toBe("ExitWorktree");
  });

  it("passes the PR state through for the goal's branch", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.pr).toEqual(PR_SHIP_IT);
  });

  it("declares the branch safe to force-delete once the PR is MERGED", async () => {
    // Squash-merge rationale: after a squash the branch tip is NOT an ancestor of
    // main, so git's own ancestry check calls a legitimately-merged branch
    // unmerged. gh's MERGED verdict is the authoritative signal, not git.
    const preflight = await finishPreflight(worktree);
    expect(preflight.branchDeleteSafe).toBe(true);
  });

  it("reports a clean worktree as no uncommitted changes", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.dirty).toEqual({ count: 0, files: [] });
  });
});

// ===========================================================================
// Slice 5 — `finish --preflight` over work that is NOT safe to destroy: the PR is
// still OPEN and the worktree carries uncommitted changes (one modified tracked
// file + one untracked file). Both are things the user would lose, so the verdict
// must route the skill to its destructive-action confirmation.
// ===========================================================================

describe("finish --preflight — open PR and a dirty worktree", () => {
  let worktree: string;

  beforeAll(() => {
    const mainRoot = makeMainCheckout({ config: true, dobby: true });
    worktree = addKitWorktree(mainRoot, "wip-goal", { dobby: true });
    writeFileSync(join(worktree, "README"), "scratch — edited, uncommitted\n");
    writeFileSync(join(worktree, "notes.txt"), "untracked work\n");
  });

  it("requires confirmation rather than verdicting safe", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.verdict).toBe("confirm-required");
  });

  it("refuses to call the branch safe to delete while the PR is OPEN", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.branchDeleteSafe).toBe(false);
  });

  it("passes the OPEN PR state through", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.pr).toEqual(PR_WIP_GOAL);
  });

  it("counts the uncommitted changes, tracked and untracked alike", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.dirty.count).toBe(2);
  });

  it("names the uncommitted files so the skill can show them", async () => {
    const preflight = await finishPreflight(worktree);
    const listed = preflight.dirty.files.join("\n");
    expect(listed).toContain("README");
    expect(listed).toContain("notes.txt");
  });

  it("states why confirmation is required", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.reasons.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Slice 6 — no PR at all for the branch (our stub gh exits 1, exactly as gh does
// when it finds no pull request). An absent PR is never a merge signal.
// ===========================================================================

describe("finish --preflight — no PR for the branch", () => {
  let worktree: string;

  beforeAll(() => {
    const mainRoot = makeMainCheckout({ config: true, dobby: true });
    worktree = addKitWorktree(mainRoot, "no-pr", { dobby: true });
  });

  it("reports no PR rather than failing", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.pr).toBe(null);
  });

  it("requires confirmation when there is no PR to merge-check", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.verdict).toBe("confirm-required");
  });

  it("refuses to call the branch safe to delete with no PR", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.branchDeleteSafe).toBe(false);
  });
});

// ===========================================================================
// Slice 7 — dobby is not installed in the repo. `dobby down` is the mandatory
// pre-removal teardown and there is no fallback, so this BLOCKS — even over a
// merged PR and a clean tree, which would otherwise be the safest possible case.
// ===========================================================================

describe("finish --preflight — dobby not installed", () => {
  let worktree: string;

  beforeAll(() => {
    const mainRoot = makeMainCheckout({ config: false, dobby: false });
    worktree = addKitWorktree(mainRoot, "no-dobby");
  });

  it("blocks even though the PR is merged and the worktree is clean", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.verdict).toBe("blocked");
  });

  it("reports dobby as not installed", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.dobbyInstalled).toBe(false);
  });

  it("names dobby in the reason it is blocked", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.reasons.join(" ").toLowerCase()).toContain("dobby");
  });
});

// ===========================================================================
// Slice 8 — orphan mode: the session that created the worktree is gone and finish
// runs from the MAIN checkout against a named slug. Native ExitWorktree only
// removes worktrees the CURRENT session made, so teardown falls back to raw git —
// and the candidate list is what lets the skill confirm the target with the user.
// ===========================================================================

describe("finish --preflight — from the main checkout (orphan mode)", () => {
  let mainRoot: string;
  let worktree: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
    worktree = addKitWorktree(mainRoot, "orphan-goal", { dobby: true });
  });

  it("identifies the mode as orphan when the session is not inside the worktree", async () => {
    const preflight = await finishPreflight(mainRoot, "orphan-goal");
    expect(preflight.mode).toBe("orphan");
  });

  it("falls back to raw git for removal in orphan mode", async () => {
    const preflight = await finishPreflight(mainRoot, "orphan-goal");
    expect(preflight.removeMechanism).toBe("raw-git");
  });

  it("resolves the named slug to its branch and worktree path", async () => {
    const preflight = await finishPreflight(mainRoot, "orphan-goal");
    expect({
      branch: preflight.branch,
      slug: preflight.slug,
      worktreePath: preflight.worktreePath.replace(TRAILING_SLASH, ""),
    }).toEqual({
      branch: "worktree-orphan-goal",
      slug: "orphan-goal",
      worktreePath: worktree,
    });
  });

  it("lists the kit worktrees as candidates for the user to confirm", async () => {
    const preflight = await finishPreflight(mainRoot, "orphan-goal");
    expect(preflight.candidates).toHaveLength(1);
    const [candidate] = preflight.candidates;
    expect({ branch: candidate?.branch, slug: candidate?.slug }).toEqual({
      branch: "worktree-orphan-goal",
      slug: "orphan-goal",
    });
  });

  it("still passes the PR state through for the named branch", async () => {
    const preflight = await finishPreflight(mainRoot, "orphan-goal");
    expect(preflight.pr).toEqual(PR_ORPHAN_GOAL);
  });
});

// ===========================================================================
// Slice 8b — the two edges around WHICH goal is being torn down, both reached
// from the main checkout:
//   - NO target at all (no `--slug`, and the session is not inside a worktree):
//     nothing is resolvable, so the preflight refuses to guess and hands back the
//     candidate list the skill can ask the user about.
//   - A target whose worktree DIRECTORY is already gone (a leftover branch from a
//     worktree removed by hand): the only blocker is a missing dobby, so this is
//     NOT blocked — cleaning up the leftover is legitimate and there is no
//     uncommitted work left to lose.
// ===========================================================================

// The no-target payload, whose target fields are the ONLY ones the spec's shape
// allows to be null (a resolved target always names all three).
interface UnresolvedFinishPreflight {
  branch: string | null;
  candidates: WorktreeRef[];
  slug: string | null;
  verdict: string;
  worktreePath: string | null;
}

describe("finish --preflight — no target to resolve", () => {
  let payload: UnresolvedFinishPreflight;

  beforeAll(async () => {
    const mainRoot = makeMainCheckout({ config: true, dobby: true });
    addKitWorktree(mainRoot, "pick-me", { dobby: true });
    const result = await run(["finish", "--preflight", "--json"], mainRoot);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    payload = JSON.parse(result.stdout) as UnresolvedFinishPreflight;
  });

  it("blocks rather than guessing which goal to tear down", () => {
    expect(payload.verdict).toBe("blocked");
  });

  it("leaves every target field empty", () => {
    expect({
      branch: payload.branch,
      slug: payload.slug,
      worktreePath: payload.worktreePath,
    }).toEqual({ branch: null, slug: null, worktreePath: null });
  });

  it("hands back the kit worktrees for the skill to choose from", () => {
    expect(payload.candidates.map((ref) => ref.slug)).toEqual(["pick-me"]);
  });
});

describe("finish --preflight — the worktree directory is already gone", () => {
  let preflight: FinishPreflight;

  beforeAll(async () => {
    const mainRoot = makeMainCheckout({ config: true, dobby: true });
    const worktree = addKitWorktree(mainRoot, "left-over", { dobby: true });
    // Removed by hand, the way a user (or a crashed session) leaves a branch and
    // a stale `git worktree` registration behind.
    rmSync(worktree, { force: true, recursive: true });
    preflight = await finishPreflight(mainRoot, "left-over");
  });

  it("does not block on the missing directory (dobby is the only blocker)", () => {
    expect(preflight.verdict).toBe("confirm-required");
  });

  it("still finds dobby through the main checkout", () => {
    expect(preflight.dobbyInstalled).toBe(true);
  });

  it("reports nothing uncommitted, there being no worktree left", () => {
    expect(preflight.dirty).toEqual({ count: 0, files: [] });
  });
});

// ===========================================================================
// Slice 9 — both preflights fail HARD outside a git repository (the action-command
// contract): there is no worktree to reason about, so they never answer with a
// degraded verdict a skill might act on.
// ===========================================================================

describe("the preflights outside a git repository", () => {
  it("fails scope preflight with the git-repository error", async () => {
    const result = await run(
      ["scope", "preflight", "--slug", "add-csv-export", "--json"],
      makeNonGitDir()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git repository");
  });

  it("fails finish --preflight with the git-repository error", async () => {
    const result = await run(
      ["finish", "--preflight", "--json"],
      makeNonGitDir()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git repository");
  });
});
