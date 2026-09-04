import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
// The SESSION PREFLIGHT — `dobby finish --preflight` — plus the contract that
// `dobby scope` NO LONGER EXISTS.
//
// The worktree belongs to the OPERATOR. Two consequences pinned here:
//  - dobby never creates, names, enters or preflights one, so `scope preflight`
//    is deleted outright and its invocation is an ordinary unknown command.
//  - finish is SYMMETRIC: it no longer assumes a kit-made `worktree-<slug>` and
//    no longer takes a `--slug` at all. It reports where the session STANDS —
//    inside a linked worktree (whoever made it) or on a plain checkout — and
//    tears a worktree down only in the first case. There is therefore no
//    `candidates[]`, no `mode`, no `removeMechanism` and no `slug` in the
//    payload; a worktree the kit did not make is as valid a subject as one it
//    did, and a plain checkout is a first-class answer rather than an error.
//
// The finish preflight stays READ-ONLY: a verdict the stage asks for BEFORE it
// acts, with every destructive AskUserQuestion gate left in the SKILL. It never
// creates, removes, or enters anything — these tests assert facts about a tree
// they built themselves, and the tree must survive.
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008): the domain
// module is never imported directly, so its internals can be restructured freely
// without touching this file.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - `inWorktree` is checked against fixtures whose nature WE chose: a repo made
//    by `git init` alone (plain checkout — its git dir IS its common dir) versus
//    one added with real `git worktree add` (a LINKED worktree — its git dir is
//    an admin dir under the main checkout's common dir). Git's own definition of
//    a linked worktree, not a rule read off the implementation.
//  - Every branch name is a literal WE pass to `git switch -c` / `worktree add`,
//    and every uncommitted file is one WE wrote — so the branch, the dirty count
//    and the dirty file list are facts of a tree whose exact contents we wrote
//    down, never facts recomputed the way the code computes them.
//  - `worktreePath`/`mainRoot` are the temp dirs WE created, compared
//    realpath-normalized (macOS resolves /tmp through /private/tmp).
//  - The `pr` payload is exactly what our stub `gh` printed (the external
//    boundary's answer): the assertion is that the CLI passes the boundary's
//    answer THROUGH unchanged, keyed on the branch it asked about.
//  - The verdict rules (`safe` = MERGED + clean, `blocked` = dobby not installed
//    and nothing else, else `confirm-required`) and `branchDeleteSafe` =
//    (pr.state === "MERGED") are the spec's literal wording.
//  - "unknown flag --<name>" is the CLI's established literal for a flag a
//    command does not take (the same one `env --baseline` answers with), and
//    "unknown command: <name>" plus its `bun update @kvnwolf/dobby` second line
//    are its literals for a command it does not have.
//  - "dobby must run inside a git repository" is the CLI's established hard-error
//    literal for an action command outside a repo.
//
// The ONE boundary that is mocked is `gh` (an external API over the network),
// stubbed as an executable on PATH — the repo's established stub-bin seam. `git`
// is REAL throughout: temp repos + real `git worktree add` fixtures are what make
// the inWorktree/dirty facts trustworthy.
// ===========================================================================

// The shared seams (`test-helpers.ts`) supply everything generic here: the pinned
// git env + `gitIn` observer (so fixtures build identically on any machine,
// whatever the developer's signing/hooks/templates config), the scratch-repo
// maker, and the stub-bin-on-PATH seam. Only the fixture helpers below (a local
// dobby install, a linked worktree cut to an arbitrary path) are local.
//
// The stub dir prepended to PATH holds ONLY `gh`, so every `git` spawn — the
// fixtures' and the CLI's alike — still resolves to the real binary.

// A trailing `/` on a returned path is presentational — normalized away before an
// absolute-path comparison (top-level per the repo's useTopLevelRegex convention).
const TRAILING_SLASH = /\/$/;

// Text mode prints the same facts as the JSON, in whatever prose the CLI likes:
// `inWorktree`, `in worktree`, `in-worktree` all carry the fact.
const IN_WORKTREE_LABEL = /in.?worktree/i;
const PR_STATE_OPEN = /open/i;
const UNCOMMITTED_WORK = /uncommitted|dirty/i;

// The usage block lists ONE command per line, indented; matching line-anchored is
// what makes "no longer advertised" checkable — a bare substring would also hit
// the word inside another command's description.
const USAGE_SCOPE_LINE = /^\s*scope\b/m;
const USAGE_FINISH_LINE = /^\s*finish\b/m;
const USAGE_MIGRATE_LINE = /^\s*migrate\b/m;

// The four fields the operator-owned worktree deletes outright. A payload that
// still carries any of them is answering the OLD, kit-made-worktree question.
const REMOVED_FIELDS = ["candidates", "mode", "removeMechanism", "slug"];

const scratchDirs: string[] = [];

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
// dobby.config.json), so it starts CLEAN and so does every worktree cut from it.
// node_modules/ is gitignored, so the local dobby install never registers as an
// uncommitted change.
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

// A PLAIN checkout standing on a goal branch: `git init` + a commit + a branch
// the operator switched to by hand. Its git dir IS its common dir, which is what
// makes it NOT a worktree.
function makePlainCheckout(
  branch: string,
  opts: { config?: boolean; dobby?: boolean } = { config: true, dobby: true }
): string {
  const dir = makeMainCheckout(opts);
  gitIn(dir, ["switch", "-q", "-c", branch]);
  return dir;
}

// Add a LINKED worktree with plain git, at a path of the operator's choosing
// OUTSIDE the main checkout — deliberately nothing like the kit's old
// `.claude/worktrees/<slug>` layout, since the kit no longer owns the naming.
// Returns its realpath-normalized absolute path.
function addLinkedWorktree(mainRoot: string, branch: string): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "dobby-preflight-wt-"))
  );
  scratchDirs.push(parent);
  const path = join(parent, "wt");
  gitIn(mainRoot, ["worktree", "add", "-q", "-b", branch, path]);
  installDobby(path);
  return realpathSync(path);
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

const PR_GOAL = {
  mergedAt: "2026-07-20T10:00:00Z",
  state: "MERGED",
  url: "https://github.com/acme/scratch/pull/7",
};
const PR_STILL_OPEN = {
  mergedAt: null,
  state: "OPEN",
  url: "https://github.com/acme/scratch/pull/8",
};
const PR_DIRTY_TREE = {
  mergedAt: "2026-07-21T11:30:00Z",
  state: "MERGED",
  url: "https://github.com/acme/scratch/pull/9",
};
const PR_NO_DOBBY = {
  mergedAt: "2026-07-22T08:15:00Z",
  state: "MERGED",
  url: "https://github.com/acme/scratch/pull/10",
};
const PR_GOAL2 = {
  mergedAt: "2026-07-23T09:45:00Z",
  state: "MERGED",
  url: "https://github.com/acme/scratch/pull/11",
};

// Matching is a literal substring of the joined argv, FIRST-WINS in order — hence
// `goal2` ahead of `goal`, whose name it contains. The trailing catch-all is gh's
// real behavior for a branch with no pull request (exit 1 on stderr).
const GH_ANSWERS: StubResponse[] = [
  { match: "goal2", stdout: JSON.stringify(PR_GOAL2) },
  { match: "still-open", stdout: JSON.stringify(PR_STILL_OPEN) },
  { match: "dirty-tree", stdout: JSON.stringify(PR_DIRTY_TREE) },
  { match: "no-dobby", stdout: JSON.stringify(PR_NO_DOBBY) },
  { match: "goal", stdout: JSON.stringify(PR_GOAL) },
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

// --- The payload shape (the spec's field list, nothing more) ----------------

interface FinishPreflight {
  branch: string;
  branchDeleteSafe: boolean;
  dirty: { count: number; files: string[] };
  dobbyInstalled: boolean;
  inWorktree: boolean;
  mainRoot: string;
  pr: { mergedAt: string | null; state: string; url: string } | null;
  reasons: string[];
  verdict: string;
  worktreePath: string | null;
}

// The preflight ANSWERS (a payload on stdout) for every verdict; only the
// outside-a-repo hard error refuses. A non-safe verdict may carry a nonzero exit
// code, which is why the accepted set is {0, 1} — the exact code per verdict is
// pinned where the spec states it (the safe path) and mirrored between JSON and
// text mode below.
async function finishPreflight(cwd: string): Promise<FinishPreflight> {
  const result = await run(["finish", "--preflight", "--json"], cwd);
  expect([0, 1], `stderr: ${result.stderr}`).toContain(result.exitCode);
  return JSON.parse(result.stdout) as FinishPreflight;
}

// A returned absolute path, comparable against a fixture path on macOS (where
// /tmp resolves through /private/tmp). `null` passes through untouched, so a
// missing path shows up as an assertion DIFF rather than an ENOENT throw.
function normalizePath(path: string | null): string | null {
  return path === null ? null : realpathSync(path.replace(TRAILING_SLASH, ""));
}

// ===========================================================================
// Slice 1 (the tracer bullet) — a PLAIN checkout, PR merged, tree clean. The
// case the operator-owned worktree makes possible at all: the session never
// stood in a worktree, so there is nothing to tear down, and finish still has a
// complete, safe answer — merge done, branch deletable, working tree clean.
// ===========================================================================

describe("finish --preflight — merged PR, clean plain checkout", () => {
  let checkout: string;

  beforeAll(() => {
    checkout = makePlainCheckout("goal");
  });

  it("verdicts the close safe, exiting zero", async () => {
    const result = await run(["finish", "--preflight", "--json"], checkout);
    const payload = JSON.parse(result.stdout) as FinishPreflight;
    expect({ exitCode: result.exitCode, verdict: payload.verdict }).toEqual({
      exitCode: 0,
      verdict: "safe",
    });
  });

  it("carries no reasons on the safe path", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.reasons).toEqual([]);
  });

  it("reports a session standing on a plain checkout, with no worktree", async () => {
    const preflight = await finishPreflight(checkout);
    expect({
      inWorktree: preflight.inWorktree,
      worktreePath: preflight.worktreePath,
    }).toEqual({ inWorktree: false, worktreePath: null });
  });

  it("reports the workroot itself as the main checkout root", async () => {
    const preflight = await finishPreflight(checkout);
    expect(normalizePath(preflight.mainRoot)).toBe(checkout);
  });

  it("names the branch the session stands on", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.branch).toBe("goal");
  });

  it("passes the PR state through for that branch", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.pr).toEqual(PR_GOAL);
  });

  it("declares the branch safe to force-delete once the PR is MERGED", async () => {
    // Squash-merge rationale: after a squash the branch tip is NOT an ancestor of
    // main, so git's own ancestry check calls a legitimately-merged branch
    // unmerged. gh's MERGED verdict is the authoritative signal, not git.
    const preflight = await finishPreflight(checkout);
    expect(preflight.branchDeleteSafe).toBe(true);
  });

  it("reports a clean tree as no uncommitted changes", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.dirty).toEqual({ count: 0, files: [] });
  });

  it("no longer answers the kit-made-worktree question at all", async () => {
    const preflight = await finishPreflight(checkout);
    const present = Object.keys(preflight).filter((key) =>
      REMOVED_FIELDS.includes(key)
    );
    expect(present).toEqual([]);
  });
});

// ===========================================================================
// Slice 2 — the PR is still OPEN. Nothing is destroyed on an unmerged goal
// without the user saying so, and the reason has to name the PR the skill will
// offer to merge, so its confirm gate can show it.
// ===========================================================================

describe("finish --preflight — the PR is still open", () => {
  let checkout: string;

  beforeAll(() => {
    checkout = makePlainCheckout("still-open");
  });

  it("requires confirmation rather than verdicting safe", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.verdict).toBe("confirm-required");
  });

  it("refuses to call the branch safe to delete while the PR is OPEN", async () => {
    const preflight = await finishPreflight(checkout);
    expect({
      branchDeleteSafe: preflight.branchDeleteSafe,
      state: preflight.pr?.state,
    }).toEqual({ branchDeleteSafe: false, state: "OPEN" });
  });

  it("passes the OPEN PR through, mergedAt and url alike", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.pr).toEqual(PR_STILL_OPEN);
  });

  it("states the open PR and its url as the reason", async () => {
    const preflight = await finishPreflight(checkout);
    const naming = preflight.reasons.filter(
      (reason) =>
        PR_STATE_OPEN.test(reason) && reason.includes(PR_STILL_OPEN.url)
    );
    expect(naming).toHaveLength(1);
  });
});

// ===========================================================================
// Slice 3 — merged, but the tree carries work the user has not committed. The
// merge and the tree are INDEPENDENT signals: this asks for confirmation
// (uncommitted work would be lost) while the branch stays safe to delete.
// ===========================================================================

describe("finish --preflight — merged PR over a dirty tree", () => {
  let checkout: string;

  beforeAll(() => {
    checkout = makePlainCheckout("dirty-tree");
    writeFileSync(join(checkout, "notes.txt"), "untracked work\n");
  });

  it("requires confirmation rather than verdicting safe", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.verdict).toBe("confirm-required");
  });

  it("counts the one uncommitted file", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.dirty.count).toBe(1);
  });

  it("names the uncommitted file so the skill can show it", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.dirty.files.join("\n")).toContain("notes.txt");
  });

  it("states the uncommitted work as the reason", async () => {
    const preflight = await finishPreflight(checkout);
    const naming = preflight.reasons.filter((reason) =>
      UNCOMMITTED_WORK.test(reason)
    );
    expect(naming.length).toBeGreaterThan(0);
  });

  it("still calls the branch safe to delete, the PR being MERGED", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.branchDeleteSafe).toBe(true);
  });
});

// ===========================================================================
// Slice 4 — the session stands in a LINKED worktree the OPERATOR made with plain
// git, at a path of their own choosing and on a branch of their own naming.
// Nothing about it follows the kit's old `worktree-<slug>` /
// `.claude/worktrees/<slug>` convention, and it is still a full subject: finish
// recognises it, resolves both roots, and can verdict the close safe.
// ===========================================================================

describe("finish --preflight — inside a worktree plain git made", () => {
  let mainRoot: string;
  let worktree: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
    worktree = addLinkedWorktree(mainRoot, "goal2");
  });

  it("reports the session as standing in a worktree", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.inWorktree).toBe(true);
  });

  it("resolves both the worktree it stands in and the main checkout it hangs off", async () => {
    const preflight = await finishPreflight(worktree);
    expect({
      mainRoot: normalizePath(preflight.mainRoot),
      worktreePath: normalizePath(preflight.worktreePath),
    }).toEqual({ mainRoot, worktreePath: worktree });
  });

  it("names the worktree's own branch, not the main checkout's", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.branch).toBe("goal2");
  });

  it("verdicts the close safe over a merged PR and a clean worktree", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.verdict).toBe("safe");
  });

  it("passes the PR state through for the worktree's branch", async () => {
    const preflight = await finishPreflight(worktree);
    expect(preflight.pr).toEqual(PR_GOAL2);
  });
});

// ===========================================================================
// Slice 5 — `--slug` is GONE. The kit no longer names worktrees, so there is no
// slug to target one by: the flag is refused the way the CLI refuses any flag a
// command does not take, and nothing is answered on stdout.
// ===========================================================================

describe("finish --preflight — the --slug target is removed", () => {
  let checkout: string;

  beforeAll(() => {
    checkout = makePlainCheckout("goal");
  });

  it("rejects --slug as an unknown flag", async () => {
    const result = await run(
      ["finish", "--preflight", "--slug", "x", "--json"],
      checkout
    );
    expect(result.stderr).toContain("unknown flag --slug");
  });

  it("exits 1 when given --slug, the way it does for any unknown flag", async () => {
    const result = await run(
      ["finish", "--preflight", "--slug", "x", "--json"],
      checkout
    );
    expect(result.exitCode).toBe(1);
  });

  it("answers no payload at all for a rejected --slug", async () => {
    const result = await run(
      ["finish", "--preflight", "--slug", "x", "--json"],
      checkout
    );
    expect(result.stdout).toBe("");
  });
});

// ===========================================================================
// Slice 6 — dobby is not installed in the repo. `dobby down` is the mandatory
// pre-close teardown and there is no fallback, so this BLOCKS — even over a
// merged PR and a clean tree, which would otherwise be the safest possible case.
// It is the ONLY blocking condition left.
// ===========================================================================

describe("finish --preflight — dobby not installed", () => {
  let checkout: string;

  beforeAll(() => {
    checkout = makePlainCheckout("no-dobby", { config: false, dobby: false });
  });

  it("blocks even though the PR is merged and the tree is clean", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.verdict).toBe("blocked");
  });

  it("reports dobby as not installed", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.dobbyInstalled).toBe(false);
  });

  it("names dobby in the reason it is blocked", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.reasons.join(" ").toLowerCase()).toContain("dobby");
  });

  it("still reports where the session stands", async () => {
    const preflight = await finishPreflight(checkout);
    expect({
      branch: preflight.branch,
      inWorktree: preflight.inWorktree,
    }).toEqual({ branch: "no-dobby", inWorktree: false });
  });
});

// ===========================================================================
// Slice 7 — no PR at all for the branch (our stub gh exits 1, exactly as gh does
// when it finds no pull request). An absent PR is never a merge signal, so the
// close is never safe — but it is not blocked either: the user may legitimately
// close a goal that never opened one.
// ===========================================================================

describe("finish --preflight — no PR for the branch", () => {
  let checkout: string;

  beforeAll(() => {
    checkout = makePlainCheckout("no-pr");
  });

  it("reports no PR rather than failing", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.pr).toBe(null);
  });

  it("requires confirmation when there is no PR to merge-check", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.verdict).toBe("confirm-required");
  });

  it("refuses to call the branch safe to delete with no PR", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.branchDeleteSafe).toBe(false);
  });

  it("still names the branch it asked about", async () => {
    const preflight = await finishPreflight(checkout);
    expect(preflight.branch).toBe("no-pr");
  });
});

// ===========================================================================
// Slice 8 — TEXT mode. Without `--json` the same facts reach a human reader, and
// the two modes agree on the exit code for one and the same tree (a skill that
// reads the text must never see a different outcome than one that reads the
// JSON). The removed `candidates` list is absent from the prose too.
// ===========================================================================

describe("finish --preflight without --json", () => {
  let safeCheckout: string;
  let openCheckout: string;

  beforeAll(() => {
    // `text-goal` still answers the MERGED stub (the `goal` pattern is a literal
    // substring of it) while being a name no prose could print by accident.
    safeCheckout = makePlainCheckout("text-goal");
    openCheckout = makePlainCheckout("still-open");
  });

  it("exits 0 on the safe path", async () => {
    const result = await run(["finish", "--preflight"], safeCheckout);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
  });

  it("states whether the session stands in a worktree", async () => {
    const result = await run(["finish", "--preflight"], safeCheckout);
    expect(result.stdout).toMatch(IN_WORKTREE_LABEL);
  });

  it("names the branch the session stands on", async () => {
    const result = await run(["finish", "--preflight"], safeCheckout);
    expect(result.stdout).toContain("text-goal");
  });

  it("names the verdict on stdout", async () => {
    const result = await run(["finish", "--preflight"], openCheckout);
    expect(result.stdout).toContain("confirm-required");
  });

  it("offers no candidate list to choose from", async () => {
    const result = await run(["finish", "--preflight"], openCheckout);
    expect(result.stdout).not.toContain("candidates");
  });

  it("reports the same outcome as --json, exit code and verdict alike", async () => {
    const text = await run(["finish", "--preflight"], openCheckout);
    const json = await run(["finish", "--preflight", "--json"], openCheckout);
    const payload = JSON.parse(json.stdout) as FinishPreflight;
    expect({
      exitCode: text.exitCode,
      namesTheVerdict: text.stdout.includes(payload.verdict),
    }).toEqual({ exitCode: json.exitCode, namesTheVerdict: true });
  });
});

// ===========================================================================
// Slice 9 — the finish preflight fails HARD outside a git repository (the
// action-command contract): there is no session to reason about, so it never
// answers with a degraded verdict a skill might act on.
// ===========================================================================

describe("the finish preflight outside a git repository", () => {
  it("fails finish --preflight with the git-repository error", async () => {
    const result = await run(
      ["finish", "--preflight", "--json"],
      makeNonGitDir()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git repository");
  });
});

// ===========================================================================
// Slice 10 — `dobby scope` is GONE. The worktree belongs to the operator: dobby
// never creates, names, enters or preflights one, so the command is deleted
// outright rather than emptied out. Every invocation of it — the full preflight
// form the scope skill used to send, and the bare command — is answered the way
// the CLI answers any command it does not have, and the help block no longer
// advertises it.
//
// Expected values are the CLI's own established literals: `unknown command: <x>`
// plus the `bun update @kvnwolf/dobby` second line (the exact pair the removed
// `capabilities` command answers with), and the usage block's one-command-per-line
// layout. The fixture is a real repo, so a refusal can never be the outside-a-repo
// hard error wearing the same exit code.
// ===========================================================================

describe("scope preflight is removed", () => {
  let mainRoot: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
  });

  it("answers the full scope preflight invocation as an unknown command", async () => {
    const result = await run(
      ["scope", "preflight", "--slug", "x", "--json"],
      mainRoot
    );
    expect(result.stderr).toMatch(/unknown command/i);
  });

  it("names scope as the unknown command rather than failing anonymously", async () => {
    const result = await run(
      ["scope", "preflight", "--slug", "x", "--json"],
      mainRoot
    );
    expect(result.stderr).toContain("unknown command: scope");
  });

  it("exits nonzero on the full scope preflight invocation", async () => {
    const result = await run(
      ["scope", "preflight", "--slug", "x", "--json"],
      mainRoot
    );
    expect(result.exitCode).not.toBe(0);
  });

  it("prints nothing on stdout for the removed scope preflight", async () => {
    const result = await run(
      ["scope", "preflight", "--slug", "x", "--json"],
      mainRoot
    );
    expect(result.stdout).toBe("");
  });

  it("answers the bare `scope` command as an unknown command", async () => {
    const result = await run(["scope"], mainRoot);
    expect(result.stderr).toContain("unknown command: scope");
  });

  it("exits nonzero on the bare `scope` command", async () => {
    const result = await run(["scope"], mainRoot);
    expect(result.exitCode).not.toBe(0);
  });

  it("offers the upgrade hint, the way it does for any command it lacks", async () => {
    const result = await run(["scope"], mainRoot);
    expect(result.stderr).toContain(
      "if this command is expected, run `bun update @kvnwolf/dobby`"
    );
  });
});

describe("the help block after scope is removed", () => {
  let mainRoot: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
  });

  // The CLI's help seam is the BARE invocation (usage on stdout, exit 0) — there
  // is no `--help` flag, and this task adds none.
  it("no longer advertises a scope command", async () => {
    const result = await run([], mainRoot);
    expect(result.stdout).not.toMatch(USAGE_SCOPE_LINE);
  });

  it("still advertises finish", async () => {
    const result = await run([], mainRoot);
    expect(result.stdout).toMatch(USAGE_FINISH_LINE);
  });

  it("still advertises migrate", async () => {
    const result = await run([], mainRoot);
    expect(result.stdout).toMatch(USAGE_MIGRATE_LINE);
  });
});

// ===========================================================================
// Slice 11 — the two preflights that must keep ANSWERING through both of this
// goal's cuts (scope's removal and finish's rewrite). The pin here is
// deliberately shallow: each still answers its own JSON payload, keyed on the
// field that names its verdict. The deep contracts stay in the slices above and
// in `migrate.test.ts`.
// ===========================================================================

describe("the surviving preflights still answer", () => {
  let mainRoot: string;

  beforeAll(() => {
    mainRoot = makeMainCheckout({ config: true, dobby: true });
  });

  it("still answers a finish --preflight verdict payload", async () => {
    const result = await run(["finish", "--preflight", "--json"], mainRoot);
    expect([0, 1]).toContain(result.exitCode);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.hasOwn(payload, "verdict")).toBe(true);
  });

  it("still answers a migrate preflight verdict payload", async () => {
    const result = await run(["migrate", "preflight", "--json"], mainRoot);
    expect([0, 1]).toContain(result.exitCode);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.hasOwn(payload, "verdict")).toBe(true);
  });
});
