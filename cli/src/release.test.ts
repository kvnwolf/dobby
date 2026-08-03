import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ReleaseAdapter,
  type ReleaseContext,
  type ReleasePhaseResult,
  registerReleaseAdapter,
  runRelease,
} from "./release.ts";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitEnv,
  gitIn,
  makeScratchRepo,
  mkStubBin,
  mkStubBinDir,
  readStubLog,
  restoreEnv,
  stubLogPath,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// `dobby release` — THE RELEASE SPINE.
//
// One command owning the phases every release target shares: the main-checkout
// preflights, the version inference plus its two `needsDecision` human gates, the
// indentation-preserving manifest bump across the lockstep surfaces, the gate
// re-run over the bumped tree, the changelog DATA the skill authors notes from,
// and — only once the adapter has actually published — the tag push. Everything
// target-specific (npm, homebrew-cask) lives behind the ADAPTER interface this
// suite fakes.
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008): the spine is
// exercised as a command, so its internals can be restructured freely. Two
// exceptions are deliberate and flagged where they occur — the config-gate guard
// (which `run.ts` makes unreachable through the dispatcher) and the adapter
// registration seam.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - The semver arithmetic is done BY HAND from the spec's classification rules
//    ("subject `!` before `:` or body BREAKING CHANGE → major, any feat → minor,
//    else patch"): 1.2.3 + a feat is 1.3.0, 1.2.3 + a breaking change is 2.0.0,
//    1.2.3 + a fix is 1.2.4, 0.4.2 + a feat is 0.5.0. Never recomputed.
//  - Every version, subject, tag, indentation and surface name in a fixture is a
//    LITERAL this file writes into a repo it builds itself, so what the spine
//    reports is checked against a tree whose exact bytes we wrote down.
//  - `needsDecision` / `first-release` / `0x-major` / `needsNotes` / `nothing to
//    release` / `release: v<V>` are the spec's own literals.
//  - What "was published / was pushed" MEANS is read from the OTHER side of the
//    boundary: a real bare git repo standing in for `origin` (so a pushed commit
//    or tag is a fact of another repository, not a claim in a payload) and the
//    stub `gh`'s recorded argv.
//
// Mocked at the boundaries ONLY: `gh` (network) as a stub bin on PATH, and the
// release TARGET (npm / a tap) behind a fake adapter — the seam the spine already
// has, since the per-target adapters are separate modules. `git` is REAL
// throughout (temp repos plus a real bare `origin`), and so is the `check` gate:
// the fixtures carry a real biome/tsc/knip setup, green by default and
// deliberately red in the gate slice.
// ===========================================================================

const scratchDirs: string[] = [];

// --- the fixture repo -------------------------------------------------------
// A releasable repo: a real git repo on `main` tracking a real bare `origin`, a
// manifest whose indentation this file chooses, a `dobby.config.json` carrying
// the `release` key, and a source tree the REAL gate passes (biome + tsc + knip).
// The biome config disables the formatter on purpose: the only thing allowed to
// rewrite a manifest here is the bump, so an indentation assertion can never be
// an artifact of `check --fix` reformatting the file.

const BIOME_CONFIG = JSON.stringify(
  {
    assist: { enabled: false },
    formatter: { enabled: false },
    linter: {
      enabled: true,
      rules: { recommended: false, suspicious: { noDoubleEquals: "error" } },
    },
  },
  null,
  2
);

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: { noEmit: true, skipLibCheck: true, strict: true },
    include: ["src"],
  },
  null,
  2
);

const KNIP_CONFIG = JSON.stringify(
  { entry: ["src/index.ts"], project: ["src/**"] },
  null,
  2
);

const GATE_GREEN_SOURCE = "export const ok = 1;\n";
// `a == b` — the ONE lint rule the fixture's biome config enables, and not
// auto-fixable, so `check --fix` cannot make the finding disappear.
const GATE_RED_SOURCE =
  "export const bad = (a: number, b: number) => a == b;\n";

const TAB = "\t";
const TWO_SPACES = "  ";

// A package manifest written with a CHOSEN indentation — the input to the bug
// this task exists to prevent (v0.5.1 shipped a hardcoded indent that reformatted
// every manifest it touched and turned CI red).
function manifestText(version: string, indent: string): string {
  return `{\n${indent}"name": "scratch-release",\n${indent}"private": true,\n${indent}"version": "${version}"\n}\n`;
}

interface Commit {
  body?: string;
  files?: Record<string, string>;
  subject: string;
}

interface FixtureOptions {
  // Which adapter phase answers `{ok: false}` (none by default).
  adapterFails?: AdapterPhase;
  // What the stub `gh` reports for the last CI run on main. By default: completed
  // + success at whatever HEAD is when it is asked.
  ci?: CiRun;
  commits?: Commit[];
  // The `release` block of dobby.config.json.
  config?: unknown;
  // A source tree the gate REJECTS.
  gateRed?: boolean;
  // The stub `gh` refuses `release create` (a failure AFTER the publish).
  ghReleaseFails?: boolean;
  // The primary manifest's indentation (tab by default).
  indent?: string;
  // Extra manifests (lockstep surfaces, or the `dir` primary), path → file text.
  manifests?: Record<string, string>;
  // The tag on the initial commit; `null` leaves the repo tagless.
  tag?: string | null;
  version?: string;
}

interface Fixture {
  // What the spine drove the adapter through, in order.
  calls: AdapterCall[];
  ghDir: string;
  // The bare repo `origin` points at — the INDEPENDENT witness for "was it
  // pushed?" (a pushed ref is a fact of another repository).
  origin: string;
  root: string;
}

function makeReleaseFixture(options: FixtureOptions = {}): Fixture {
  const version = options.version ?? "0.4.2";
  const root = makeScratchRepo({
    branch: "main",
    config: { files: [], release: options.config ?? { type: "npm" } },
    files: {
      "biome.jsonc": BIOME_CONFIG,
      "knip.json": KNIP_CONFIG,
      "src/index.ts":
        options.gateRed === true ? GATE_RED_SOURCE : GATE_GREEN_SOURCE,
      "tsconfig.json": TSCONFIG,
      ...(options.manifests ?? {}),
    },
    pkg: manifestText(version, options.indent ?? TAB),
    prefix: "dobby-release-",
    track: scratchDirs,
  });

  // `origin` as a real bare repo, wired up by writing the two config stanzas
  // `git remote add` + `git push -u` would have written (git spawns dominate this
  // suite's runtime, so the fixtures buy them back where a file write is exact).
  const origin = realpathSync(mkdtempSync(join(tmpdir(), "dobby-origin-")));
  scratchDirs.push(origin);
  gitIn(root, ["init", "--bare", "-q", origin]);
  writeFileSync(
    join(root, ".git", "config"),
    `${readFileSync(join(root, ".git", "config"), "utf8")}[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`
  );

  const tag = options.tag === undefined ? `v${version}` : options.tag;
  if (tag !== null) {
    gitIn(root, ["tag", tag]);
  }
  for (const commit of options.commits ?? []) {
    addCommit(root, commit);
  }
  // ONE push publishes the branch and the tag: the release starts from a repo
  // whose main is exactly what origin has — the state a real release runs from.
  gitIn(root, ["push", "-q", "origin", "main", ...(tag === null ? [] : [tag])]);

  const fake = fakeAdapter(options.adapterFails);
  registerReleaseAdapter("npm", fake.adapter);

  return {
    calls: fake.calls,
    ghDir: mkGhStub(root, options.ci, options.ghReleaseFails === true),
    origin,
    root,
  };
}

function addCommit(root: string, commit: Commit): void {
  const files = commit.files ?? { "notes.md": `${commit.subject}\n` };
  for (const [relPath, content] of Object.entries(files)) {
    const path = join(root, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  gitIn(root, ["add", "-A"]);
  const message =
    commit.body === undefined
      ? commit.subject
      : `${commit.subject}\n\n${commit.body}`;
  gitIn(root, ["commit", "-q", "-m", message]);
}

// --- the `gh` boundary ------------------------------------------------------
// A stub bin on PATH that RECORDS every argv (so "did we create the GitHub
// release, with which notes file?" is answered by what dobby actually ran) and
// answers `gh run list` with one CI run. gh prints an ARRAY for `--json`, so the
// stub does too. By default the run's `headSha` is resolved AT CALL TIME from the
// repo's HEAD — i.e. "CI is green on exactly this commit" — which is the premise
// every non-CI slice needs; the CI slices pin a foreign sha or a pending status
// instead.

interface CiRun {
  conclusion?: string | null;
  sha?: string;
  status?: string;
}

function mkGhStub(
  root: string,
  ci: CiRun = {},
  releaseCreateFails = false
): string {
  const dir = mkStubBinDir(scratchDirs);
  const payload = JSON.stringify([
    {
      conclusion: ci.conclusion === undefined ? "success" : ci.conclusion,
      headSha: "__SHA__",
      status: ci.status ?? "completed",
    },
  ]);
  const [before, after] = payload.split("__SHA__");
  const shaExpression =
    ci.sha === undefined ? `$(git -C '${root}' rev-parse HEAD)` : `'${ci.sha}'`;
  mkStubBin(
    dir,
    "gh",
    [
      "#!/bin/sh",
      // The recorder preamble `mkRecorderBin` writes (argc line + NUL-terminated
      // args), kept by hand because this stub also needs a COMPUTED answer.
      `{ printf '%s\\n' "$#"; [ "$#" -eq 0 ] || printf '%s\\0' "$@"; } >> '${stubLogPath(dir, "gh")}'`,
      'case "$*" in',
      "  *'run list'*)",
      `    sha=${shaExpression}`,
      `    printf '%s' '${before}'"$sha"'${after}'`,
      "    exit 0",
      "    ;;",
      // A GitHub release that cannot be created — the AFTER-the-publish failure
      // that must never roll anything back (the artifact is already public).
      ...(releaseCreateFails
        ? [
            "  *'release create'*)",
            "    echo 'gh: HTTP 422: a release for v0.5.0 already exists' >&2",
            "    exit 1",
            "    ;;",
          ]
        : []),
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );
  return dir;
}

// --- the release TARGET boundary (the adapter) ------------------------------
// The per-target adapters (npm, homebrew-cask) are separate modules; the spine
// drives whichever one the config's `release.type` selects. This fake stands in
// for one: it records the phases the spine drove it through and can refuse any of
// them. Registering it under `npm` is what proves the registry is keyed on
// `release.type` — the fixtures' configs all say `"type": "npm"`.

type AdapterPhase = "packGate" | "preflight" | "publish" | "smoke";

interface AdapterCall {
  phase: AdapterPhase;
  // Typed OFF the context, so this file never dictates the field's nullability —
  // only that the adapter is told WHICH version it is publishing.
  version: ReleaseContext["version"];
}

function fakeAdapter(fails?: AdapterPhase): {
  adapter: ReleaseAdapter;
  calls: AdapterCall[];
} {
  const calls: AdapterCall[] = [];
  const phase =
    (name: AdapterPhase) =>
    (context: ReleaseContext): ReleasePhaseResult => {
      calls.push({ phase: name, version: context.version });
      return name === fails
        ? { error: `fake adapter: ${name} refused`, ok: false }
        : { ok: true };
    };
  return {
    adapter: {
      id: "fake-target",
      packGate: phase("packGate"),
      preflight: phase("preflight"),
      publish: phase("publish"),
      smoke: phase("smoke"),
    },
    calls,
  };
}

// --- running the command ----------------------------------------------------

interface ChangelogEntry {
  subject: string;
}

interface ReleaseReport {
  changelog?: { groups: Record<string, ChangelogEntry[]> };
  context?: { commits: string[]; currentVersion: string };
  dryRun?: boolean;
  needsDecision?: string;
  needsNotes?: boolean;
  // `note` is where a phase records what it did NOT do (a lockstep file left to
  // the adapter) — the difference between "delegated" and "silently dropped".
  phases?: Array<{ name: string; note?: string; ok: boolean }>;
  // Whether the irreversible step happened. Once it has, NOTHING is rolled back.
  published?: boolean;
  version?: string;
}

interface Outcome {
  exitCode: number;
  report: ReleaseReport;
  stderr: string;
  stdout: string;
}

// `dobby release --json [...]` inside the fixture, with the stub `gh` on PATH.
// `--json` throughout: the machine payload IS the contract the skill consumes.
async function release(
  fixture: Fixture,
  args: string[] = []
): Promise<Outcome> {
  const result = await withStubPath(fixture.ghDir, () =>
    run(["release", "--json", ...args], fixture.root)
  );
  const report =
    result.stdout.trim() === ""
      ? {}
      : (JSON.parse(result.stdout) as ReleaseReport);
  return { ...result, report };
}

// --- reading the tree back (the independent observers) ----------------------

function versionOf(root: string, relPath = "package.json"): string {
  const parsed = JSON.parse(readFileSync(join(root, relPath), "utf8")) as {
    version?: string;
  };
  return parsed.version ?? "";
}

function fileText(root: string, relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}

function subjects(root: string): string[] {
  return gitIn(root, ["log", "--pretty=%s"]).split("\n");
}

// Whether a ref resolves in `root` — used against the bare `origin` too, where a
// resolvable `refs/tags/v0.5.0` means the tag really was pushed.
function refExists(root: string, ref: string): boolean {
  try {
    gitIn(root, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function shaOf(root: string, ref: string): string {
  return gitIn(root, ["rev-parse", ref]);
}

// The gh invocations, as recorded argv vectors.
function ghCalls(fixture: Fixture): string[][] {
  return readStubLog(fixture.ghDir, "gh");
}

// A notes file OUTSIDE the repo: a release stops on a dirty tree, so the
// model-authored notes can never be an uncommitted file inside it.
function writeNotesFile(
  body = "## 🎉 What's new\n\nCSV export, at last.\n"
): string {
  const path = join(notesDir(), "notes.md");
  writeFileSync(path, body);
  return path;
}

// A fresh temp dir for one notes file, outside the repo for the same reason.
function notesDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-notes-")));
  scratchDirs.push(dir);
  return dir;
}

// The changelog group whose NAME matches — the grouping is the behavior, the
// group's exact label is the implementor's presentation choice.
function groupMatching(
  report: ReleaseReport,
  pattern: RegExp
): ChangelogEntry[] {
  const groups = report.changelog?.groups ?? {};
  const key = Object.keys(groups).find((name) => pattern.test(name));
  return key === undefined ? [] : (groups[key] ?? []);
}

function subjectsIn(entries: ChangelogEntry[]): string {
  return entries.map((entry) => entry.subject).join(" | ");
}

// The CLI spawns git ITSELF, inheriting this process's env — so the pinned git
// identity/isolation has to live on the parent, or a developer's global gpg
// signing (or a commit template) would break the spine's own commit.
const savedGitEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const [key, value] of Object.entries(gitEnv())) {
    if (key.startsWith("GIT_") && value !== undefined) {
      savedGitEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  }
});

afterAll(() => {
  for (const [key, value] of savedGitEnv) {
    restoreEnv(key, value);
  }
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// ===========================================================================
// Slice 1 (tracer bullet) — the command is CONFIG-GATED (Decision 2).
//
// Nothing in a repo infers a release target, so `release` exists only where
// `dobby.config.json` carries a `release` key. `run.ts` hides the command
// entirely when the key is absent, which is why the spine's own refusal is
// reached directly here: it is the guard for every caller that is not the
// dispatcher, and the message has to name what is missing.
// ===========================================================================

describe("release — the config gate", () => {
  it("refuses a repo whose dobby.config.json carries no release key", () => {
    const root = makeScratchRepo({
      branch: "main",
      config: { files: [] },
      prefix: "dobby-release-unconfigured-",
      track: scratchDirs,
    });

    const result = runRelease({
      command: "release",
      cwd: root,
      options: {},
      positionals: [],
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("release");
    expect(result.error).toContain("dobby.config.json");
  });
});

// ===========================================================================
// Slice 2 — the PREFLIGHTS. Everything after them is destructive (a commit, a
// publish, a push), so each guard must refuse BEFORE anything moves — and say
// which fact stopped it, since the human reading the refusal is the one who has
// to fix it.
// ===========================================================================

describe("release — preflight refusals", () => {
  it("refuses to release from a linked worktree", async () => {
    const fixture = makeReleaseFixture();
    const worktree = join(fixture.root, ".claude", "worktrees", "some-goal");
    gitIn(fixture.root, [
      "worktree",
      "add",
      "-q",
      "-b",
      "worktree-some-goal",
      worktree,
    ]);

    const result = await withStubPath(fixture.ghDir, () =>
      run(["release", "--json"], worktree)
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("worktree");
  });

  it("refuses to release from a branch other than main", async () => {
    const fixture = makeReleaseFixture();
    gitIn(fixture.root, ["checkout", "-q", "-b", "hotfix-lane"]);

    const outcome = await release(fixture);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("hotfix-lane");
  });

  it("refuses to release with uncommitted changes in the tree", async () => {
    const fixture = makeReleaseFixture();
    writeFileSync(join(fixture.root, "scratch-note.md"), "work in progress\n");

    const outcome = await release(fixture);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr.toLowerCase()).toMatch(/uncommitted|clean|dirty/);
    expect(versionOf(fixture.root)).toBe("0.4.2");
  });

  it("refuses when the last CI run is for a different commit", async () => {
    const fixture = makeReleaseFixture({
      ci: { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      commits: [{ subject: "feat: add csv export" }],
    });

    const outcome = await release(fixture);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toMatch(/\bci\b/i);
  });

  it("refuses while CI is still running on the commit", async () => {
    const fixture = makeReleaseFixture({
      ci: { conclusion: null, status: "in_progress" },
      commits: [{ subject: "feat: add csv export" }],
    });
    const head = shaOf(fixture.root, "HEAD");

    const outcome = await release(fixture);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toMatch(/\bci\b/i);
    // A refusal that already bumped or committed would be a half-release.
    expect({
      head: shaOf(fixture.root, "HEAD"),
      version: versionOf(fixture.root),
    }).toEqual({ head, version: "0.4.2" });
  });

  it("refuses when the target adapter's own preflight refuses", async () => {
    const fixture = makeReleaseFixture({
      adapterFails: "preflight",
      commits: [{ subject: "feat: add csv export" }],
    });

    const outcome = await release(fixture);

    expect(outcome.exitCode).toBe(1);
    expect(fixture.calls.map((call) => call.phase)).toContain("preflight");
    expect(subjects(fixture.root)).not.toContain("release: v0.5.0");
  });
});

// ===========================================================================
// Slice 3 — the `needsDecision` human gates (Decision 3). Two version questions a
// machine must NOT answer alone: the very first release, and a breaking change
// while still on 0.x (where "major" is a judgement, not arithmetic). Both stop
// with the context the skill needs for its AskUserQuestion, having touched
// NOTHING — and the answer comes back as `--bump`.
// ===========================================================================

describe("release — needsDecision: the first release", () => {
  let fixture: Fixture;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
      tag: null,
      version: "0.1.0",
    });
    outcome = await release(fixture);
  });

  it("stops for a human decision when there is no previous release to infer from", () => {
    expect(outcome.report.needsDecision).toBe("first-release");
  });

  it("exits 1 so the skill never mistakes the stop for a release", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("reports the current version as the decision's context", () => {
    expect(outcome.report.context?.currentVersion).toBe("0.1.0");
  });

  it("lists the commit subjects the decision is about", () => {
    expect(outcome.report.context?.commits.join(" | ")).toContain(
      "feat: add csv export"
    );
  });

  it("touches nothing: no bump, no release commit, no tag", () => {
    expect({
      subject: subjects(fixture.root)[0],
      tagged: refExists(fixture.root, "refs/tags/v0.2.0"),
      version: versionOf(fixture.root),
    }).toEqual({
      subject: "feat: add csv export",
      tagged: false,
      version: "0.1.0",
    });
  });

  it("never leaks git's raw failure text for a repo with no tags", () => {
    // `git describe` exits 128 with `fatal: No names found…` — that is a first
    // release, not an error to forward to the user.
    expect(`${outcome.stdout}${outcome.stderr}`).not.toContain("fatal:");
  });

  it("treats a repo whose only tags are non-version tags as a first release too", async () => {
    // `git describe --match v*` fails the SAME way (exit 128) whether there are no
    // tags at all or none that look like a release.
    gitIn(fixture.root, ["tag", "hotfix-1"]);

    const tagged = await release(fixture);

    expect(tagged.report.needsDecision).toBe("first-release");
  });

  it("applies the bump the human chose to the current version", async () => {
    const chosen = await release(fixture, ["--bump", "minor"]);

    expect(chosen.report.version).toBe("0.2.0");
  });
});

describe("release — needsDecision: a breaking change on 0.x", () => {
  let fixture: Fixture;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat!: drop the legacy csv flag" }],
      version: "0.4.2",
    });
    outcome = await release(fixture);
  });

  it("stops for a human decision rather than declaring 1.0.0 by itself", () => {
    expect(outcome.report.needsDecision).toBe("0x-major");
  });

  it("reports the current 0.x version as the decision's context", () => {
    expect(outcome.report.context?.currentVersion).toBe("0.4.2");
  });

  it("lists the breaking commit the decision is about", () => {
    expect(outcome.report.context?.commits.join(" | ")).toContain(
      "drop the legacy csv flag"
    );
  });

  it("touches nothing", () => {
    expect({
      subject: subjects(fixture.root)[0],
      version: versionOf(fixture.root),
    }).toEqual({
      subject: "feat!: drop the legacy csv flag",
      version: "0.4.2",
    });
  });

  it("proceeds with the version the human chose when --bump answers the gate", async () => {
    const answered = await release(fixture, ["--bump", "major"]);

    expect({
      needsDecision: answered.report.needsDecision,
      version: answered.report.version,
    }).toEqual({ needsDecision: undefined, version: "1.0.0" });
  });
});

// ===========================================================================
// Slice 4 — nothing to release: the last tag is already on HEAD, so there is no
// commit range at all. Cutting a release here would republish the same tree under
// a new version.
// ===========================================================================

describe("release — nothing to release", () => {
  let fixture: Fixture;
  let head: string;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture();
    head = shaOf(fixture.root, "HEAD");
    outcome = await release(fixture);
  });

  it("refuses when the last tag is already on HEAD", () => {
    expect(`${outcome.stdout}${outcome.stderr}`.toLowerCase()).toContain(
      "nothing to release"
    );
  });

  it("exits 1", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("touches nothing", () => {
    expect(shaOf(fixture.root, "HEAD")).toBe(head);
  });
});

// ===========================================================================
// Slice 5 — the BUMP and the `needsNotes` stop (Decisions 4 + 5). A release
// without `--notes-file` runs everything mechanical and then STOPS: the notes are
// model-authored, so the CLI hands back the changelog data and keeps the bump
// commit local. Nothing may leave the machine at this point.
//
// 0.4.2 + a `feat` is 0.5.0 (the spec's rule: any feat → minor), by hand.
// ===========================================================================

describe("release — the bump, stopping for model-authored notes", () => {
  let fixture: Fixture;
  let originHead: string;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [
        { subject: "feat: add csv export" },
        { subject: "fix: stop double-counting rows" },
      ],
      indent: TAB,
    });
    originHead = shaOf(fixture.origin, "main");
    outcome = await release(fixture);
  });

  it("stops for the notes the skill has to author", () => {
    expect(outcome.report.needsNotes).toBe(true);
  });

  it("exits 1 so the stop cannot read as a finished release", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("reports the version a feat since the last release earns", () => {
    expect(outcome.report.version).toBe("0.5.0");
  });

  it("writes the new version into the manifest", () => {
    expect(versionOf(fixture.root)).toBe("0.5.0");
  });

  it("keeps the manifest's own indentation instead of reformatting it", () => {
    // The v0.5.1 field bug: a hardcoded indent rewrote every manifest it touched.
    expect(fileText(fixture.root, "package.json")).toContain(
      `${TAB}"version": "0.5.0"`
    );
  });

  it("commits the bump as `release: v<version>`", () => {
    expect(subjects(fixture.root)[0]).toBe("release: v0.5.0");
  });

  it("keeps the bump commit local — origin is untouched", () => {
    expect(shaOf(fixture.origin, "main")).toBe(originHead);
  });

  it("creates no tag before the notes exist", () => {
    expect(refExists(fixture.root, "refs/tags/v0.5.0")).toBe(false);
  });

  it("publishes nothing before the notes exist", () => {
    expect(fixture.calls.map((call) => call.phase)).not.toContain("publish");
  });

  it("groups the feature commit for the notes author", () => {
    expect(subjectsIn(groupMatching(outcome.report, /feat/i))).toContain(
      "add csv export"
    );
  });

  it("groups the fix commit separately from the feature", () => {
    expect(subjectsIn(groupMatching(outcome.report, /fix|bug/i))).toContain(
      "stop double-counting rows"
    );
  });
});

// ===========================================================================
// Slice 6 — LOCKSTEP surfaces. A repo ships several version-carrying manifests
// that must move together, and each keeps its OWN indentation — the exact shape
// of the v0.5.1 incident (a 2-space manifest rewritten with tabs, red CI).
// ===========================================================================

describe("release — the lockstep manifests", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
      config: {
        lockstep: ["plugin/plugin.json", "marketplace.json"],
        type: "npm",
      },
      indent: TWO_SPACES,
      manifests: {
        "marketplace.json": manifestText("0.4.2", TWO_SPACES),
        "plugin/plugin.json": manifestText("0.4.2", TAB),
      },
    });
    await release(fixture);
  });

  it("bumps the primary manifest", () => {
    expect(versionOf(fixture.root)).toBe("0.5.0");
  });

  it("bumps every lockstep manifest to the same version", () => {
    expect({
      marketplace: versionOf(fixture.root, "marketplace.json"),
      plugin: versionOf(fixture.root, "plugin/plugin.json"),
    }).toEqual({ marketplace: "0.5.0", plugin: "0.5.0" });
  });

  it("keeps each manifest's own indentation (tabs stay tabs, spaces stay spaces)", () => {
    expect({
      plugin: fileText(fixture.root, "plugin/plugin.json").includes(
        `${TAB}"version": "0.5.0"`
      ),
      primary: fileText(fixture.root, "package.json").includes(
        `${TWO_SPACES}"version": "0.5.0"`
      ),
    }).toEqual({ plugin: true, primary: true });
  });
});

describe("release — the publishable package lives in a subdirectory", () => {
  it("bumps the manifest under release.dir, not the repo root's", async () => {
    const fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
      config: { dir: "cli", type: "npm" },
      manifests: { "cli/package.json": manifestText("0.4.2", TWO_SPACES) },
      // The root manifest carries an unrelated version nothing may touch.
      version: "9.9.9",
    });

    const outcome = await release(fixture);

    expect({
      cli: versionOf(fixture.root, "cli/package.json"),
      reported: outcome.report.version,
      root: versionOf(fixture.root),
    }).toEqual({ cli: "0.5.0", reported: "0.5.0", root: "9.9.9" });
  });
});

// ===========================================================================
// Slice 7 — the GATE over the bumped tree (Decision 5). The bump edits committed
// files, so the quality gate runs after it and before the commit: a red gate
// leaves the repo exactly as it was found.
// ===========================================================================

describe("release — the gate over the bumped tree", () => {
  let fixture: Fixture;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
      gateRed: true,
    });
    outcome = await release(fixture);
  });

  it("refuses to release when the gate is red", () => {
    expect(outcome.exitCode).not.toBe(0);
  });

  it("surfaces the gate's findings", () => {
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("src/index.ts");
  });

  it("restores the manifest it had already bumped", () => {
    expect(versionOf(fixture.root)).toBe("0.4.2");
  });

  it("leaves no release commit behind", () => {
    expect(subjects(fixture.root)).not.toContain("release: v0.5.0");
  });
});

// ===========================================================================
// Slice 8 — the PUBLISH phase, with the model-authored notes in hand. This is the
// irreversible half: the adapter publishes, and only THEN is anything pushed.
// ===========================================================================

describe("release — publishing with the authored notes", () => {
  let fixture: Fixture;
  let notesFile: string;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
    });
    notesFile = writeNotesFile();
    outcome = await release(fixture, ["--notes-file", notesFile]);
  });

  it("completes the release", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("publishes through the adapter the config's release.type selects", () => {
    const published = fixture.calls.find((call) => call.phase === "publish");
    expect(published?.version).toBe("0.5.0");
  });

  it("gates the artifact before publishing it", () => {
    // Never publish something that was not packed and inspected first.
    const phases = fixture.calls.map((call) => call.phase);
    expect(phases.indexOf("packGate")).toBeLessThan(phases.indexOf("publish"));
  });

  it("smoke-tests what it published", () => {
    expect(fixture.calls.map((call) => call.phase)).toContain("smoke");
  });

  it("tags the release commit", () => {
    expect(shaOf(fixture.root, "refs/tags/v0.5.0")).toBe(
      shaOf(fixture.root, "HEAD")
    );
  });

  it("pushes the release commit to origin", () => {
    // Read from the OTHER repository: origin's main must now be the release
    // commit itself, not merely a sha that happens to match.
    expect(gitIn(fixture.origin, ["log", "-1", "--pretty=%s", "main"])).toBe(
      "release: v0.5.0"
    );
  });

  it("pushes the tag to origin", () => {
    expect(refExists(fixture.origin, "refs/tags/v0.5.0")).toBe(true);
  });

  it("creates the GitHub release from the authored notes file", () => {
    const created = ghCalls(fixture)
      .find((argv) => argv[0] === "release" && argv[1] === "create")
      ?.join(" ");
    expect(created).toContain("v0.5.0 --title v0.5.0");
    expect(created).toContain(`--notes-file ${notesFile}`);
  });

  it("reports the phases it ran", () => {
    const names = outcome.report.phases?.map((entry) => entry.name) ?? [];
    expect(names).toContain("preflight");
    expect(names).toContain("publish");
  });

  it("reports every phase as ok", () => {
    expect(outcome.report.phases?.every((entry) => entry.ok)).toBe(true);
  });
});

// ===========================================================================
// Slice 9 — the PUBLISH-GATED PUSH (a field-proven gotcha). A publish that fails
// must leave no trace: a pushed tag or a pushed `release: v…` commit for a version
// that never shipped burns the version number for good.
// ===========================================================================

describe("release — the publish fails", () => {
  let fixture: Fixture;
  let originHead: string;
  let outcome: Outcome;
  let preReleaseSubject: string;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      adapterFails: "publish",
      commits: [{ subject: "feat: add csv export" }],
    });
    originHead = shaOf(fixture.origin, "main");
    preReleaseSubject = subjects(fixture.root)[0] ?? "";
    outcome = await release(fixture, ["--notes-file", writeNotesFile()]);
  });

  it("fails the release", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("names the phase that failed", () => {
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("publish");
  });

  it("rolls the local bump commit back", () => {
    expect(subjects(fixture.root)[0]).toBe(preReleaseSubject);
  });

  it("restores the manifest version", () => {
    expect(versionOf(fixture.root)).toBe("0.4.2");
  });

  it("pushes nothing to origin", () => {
    expect({
      main: shaOf(fixture.origin, "main"),
      tag: refExists(fixture.origin, "refs/tags/v0.5.0"),
    }).toEqual({ main: originHead, tag: false });
  });

  it("leaves no local tag for the version that never shipped", () => {
    expect(refExists(fixture.root, "refs/tags/v0.5.0")).toBe(false);
  });

  it("creates no GitHub release", () => {
    expect(ghCalls(fixture).filter((argv) => argv[0] === "release")).toEqual(
      []
    );
  });
});

// ===========================================================================
// Slice 10 — the SECOND invocation. The skill authors the notes and re-runs; the
// bump commit from the first run is already sitting there, so the re-run must
// recognize it rather than bumping 0.5.0 to 0.6.0.
//
// The stub `gh` is PINNED here to the sha `origin` has, instead of resolving the
// fixture's HEAD at call time: CI can only ever report a run for a commit that
// was PUSHED, and the commit the re-run finds at HEAD is the local `release:
// v0.5.0` commit the first run deliberately kept off the trunk. A stub that
// vouched for that sha would let the resume pass on a premise production can
// never supply.
// ===========================================================================

describe("release — re-run with the notes the skill authored", () => {
  let fixture: Fixture;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
    });
    fixture.ghDir = mkGhStub(fixture.root, {
      sha: shaOf(fixture.origin, "main"),
    });
    await release(fixture);
    outcome = await release(fixture, ["--notes-file", writeNotesFile()]);
  });

  it("completes the release the first run prepared", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("keeps the version the first run decided", () => {
    expect(versionOf(fixture.root)).toBe("0.5.0");
  });

  it("does not bump a second time", () => {
    expect(
      subjects(fixture.root).filter((subject) =>
        subject.startsWith("release: v")
      )
    ).toEqual(["release: v0.5.0"]);
  });

  it("pushes the release commit and its tag", () => {
    expect({
      main: shaOf(fixture.origin, "main") === shaOf(fixture.root, "HEAD"),
      tag: refExists(fixture.origin, "refs/tags/v0.5.0"),
    }).toEqual({ main: true, tag: true });
  });
});

// ===========================================================================
// Slice 11 — the CLASSIFICATION rules that infer the bump. Every expected version
// is semver arithmetic done by hand from the spec's three rules; the repo sits at
// 1.2.3 so a major is plain arithmetic rather than a `needsDecision`.
// ===========================================================================

async function inferredVersion(commits: Commit[]): Promise<string | undefined> {
  const fixture = makeReleaseFixture({ commits, version: "1.2.3" });
  const outcome = await release(fixture);
  expect(outcome.report.needsNotes, `stderr: ${outcome.stderr}`).toBe(true);
  return outcome.report.version;
}

describe("release — inferring the version from the commits", () => {
  it("reads a `!` before the colon as a breaking change", async () => {
    expect(
      await inferredVersion([
        { subject: "feat!: drop the legacy csv flag" },
        { subject: "fix: stop double-counting rows" },
      ])
    ).toBe("2.0.0");
  });

  it("reads a BREAKING CHANGE footer as a breaking change", async () => {
    expect(
      await inferredVersion([
        {
          body: "BREAKING CHANGE: the csv flag is gone.",
          subject: "refactor: rework the export pipeline",
        },
      ])
    ).toBe("2.0.0");
  });

  it("reads a feature as a minor release", async () => {
    expect(
      await inferredVersion([
        { subject: "fix: stop double-counting rows" },
        { subject: "feat: add csv export" },
      ])
    ).toBe("1.3.0");
  });

  it("reads everything else as a patch release", async () => {
    expect(
      await inferredVersion([
        { subject: "fix: stop double-counting rows" },
        { subject: "chore: bump the lockfile" },
      ])
    ).toBe("1.2.4");
  });

  it("lets an explicit --bump override the inference", async () => {
    const fixture = makeReleaseFixture({
      commits: [{ subject: "fix: stop double-counting rows" }],
      version: "1.2.3",
    });

    const outcome = await release(fixture, ["--bump", "major"]);

    expect(outcome.report.version).toBe("2.0.0");
  });
});

// ===========================================================================
// Slice 12 — SURFACE grouping (ADR-0007's grouping, kept alive as config). With
// `release.surfaces` present the changelog is grouped by WHICH surface each
// commit touched instead of by commit type — the shape the notes author wants for
// a repo that ships several things at once.
// ===========================================================================

describe("release — the changelog grouped by surface", () => {
  let outcome: Outcome;

  beforeAll(async () => {
    const fixture = makeReleaseFixture({
      commits: [
        {
          files: { "plugin/notes.md": "skill\n" },
          subject: "feat: teach the plugin a new skill",
        },
        {
          files: { "cli/notes.md": "flag\n" },
          subject: "fix: stop the cli double-counting rows",
        },
      ],
      config: {
        surfaces: { CLI: "cli/**", Plugin: "plugin/**" },
        type: "npm",
      },
    });
    outcome = await release(fixture);
  });

  it("groups a commit under the surface whose files it touched", () => {
    expect(subjectsIn(groupMatching(outcome.report, /^Plugin$/))).toContain(
      "teach the plugin a new skill"
    );
  });

  it("groups the other commit under its own surface", () => {
    expect(subjectsIn(groupMatching(outcome.report, /^CLI$/))).toContain(
      "stop the cli double-counting rows"
    );
  });
});

// ===========================================================================
// Slice 13 — the adapter REGISTRY. The spine drives whichever target
// `release.type` names, and `release.type` is a CLOSED set the config validator
// owns (`config-schema.test.ts` covers a value outside it). Both of its members
// are registered by the spine itself, so what is reachable here is the other
// half of the registry contract: a config naming the OTHER target is driven by
// THAT target's adapter — the production wiring, asserted from the CLI's own
// entry point rather than from a test that imported the module itself.
// ===========================================================================

describe("release — the target named by release.type", () => {
  it("drives the homebrew-cask adapter, never a no-adapter refusal", async () => {
    // The fixtures register their fake under `npm` — so an outcome that came out
    // of the cask target could not have come from anywhere else. This fixture is
    // NOT a Tauri app, which is what that target refuses first: the release stops
    // on its preflight, in its own words, before anything moves.
    const fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
      config: { cask: "scratch", tap: "acme/tap", type: "homebrew-cask" },
    });

    const outcome = await release(fixture);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("the homebrew-cask target refused");
    // The cask module's own words — the witness that it is in the CLI's graph.
    expect(outcome.stderr).toContain("src-tauri/tauri.conf.json");
    expect(outcome.stderr).not.toContain("no release adapter");
    // A refusal, not a crash — and no version, commit or tag came of it.
    expect({
      subject: subjects(fixture.root)[0],
      version: versionOf(fixture.root),
    }).toEqual({ subject: "feat: add csv export", version: "0.4.2" });
  });
});

// ===========================================================================
// Slice 14 — the FLAG values. `run.ts` checks that a flag is allowed for the
// command; what a flag SAYS is the spine's to validate — and it validates before
// touching anything, so a typo costs a re-run and nothing else.
// ===========================================================================

describe("release — the flag values it refuses", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
    });
  });

  it("rejects a --bump level that is not major, minor or patch", async () => {
    const outcome = await release(fixture, ["--bump", "sideways"]);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("sideways");
    expect(outcome.stderr).toMatch(/major/);
    expect(versionOf(fixture.root)).toBe("0.4.2");
  });

  it("rejects a --notes-file that does not exist", async () => {
    const missing = join(notesDir(), "never-authored.md");

    const outcome = await release(fixture, ["--notes-file", missing]);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain(missing);
    expect(subjects(fixture.root)).not.toContain("release: v0.5.0");
  });

  it("rejects an empty --notes-file rather than shipping a release with no notes", async () => {
    const outcome = await release(fixture, [
      "--notes-file",
      writeNotesFile("   \n"),
    ]);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr.toLowerCase()).toContain("empty");
    expect(subjects(fixture.root)).not.toContain("release: v0.5.0");
  });
});

// ===========================================================================
// Slice 15 — `--dry-run`: the PLAN alone. What version this release would take
// and the changelog it would be written from, with nothing bumped, committed,
// pushed or published — the answer to "what happens if I release now?".
// ===========================================================================

describe("release — --dry-run", () => {
  let fixture: Fixture;
  let head: string;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
    });
    head = shaOf(fixture.root, "HEAD");
    outcome = await release(fixture, ["--dry-run"]);
  });

  it("succeeds — a plan is not a refusal", () => {
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0);
  });

  it("says it was a dry run", () => {
    expect(outcome.report.dryRun).toBe(true);
  });

  it("reports the version the release WOULD take", () => {
    expect(outcome.report.version).toBe("0.5.0");
  });

  it("hands back the changelog it would be written from", () => {
    expect(subjectsIn(groupMatching(outcome.report, /feat/i))).toContain(
      "add csv export"
    );
  });

  it("touches nothing: no bump, no commit, no publish", () => {
    expect({
      head: shaOf(fixture.root, "HEAD"),
      published: fixture.calls.map((call) => call.phase).includes("publish"),
      version: versionOf(fixture.root),
    }).toEqual({ head, published: false, version: "0.4.2" });
  });
});

// ===========================================================================
// Slice 16 — a lockstep file the SPINE cannot edit. `release.lockstep` is a list
// of version-carrying files, and not all of them are JSON (a `Cargo.toml` says
// `version =` under `[dependencies]` too, so a blind rewrite would corrupt it).
// Those belong to the target's adapter — and the run has to SAY so, since a
// version-carrying file silently left behind is a broken release.
// ===========================================================================

describe("release — a lockstep file that is not JSON", () => {
  let fixture: Fixture;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
      config: {
        lockstep: ["plugin/plugin.json", "Cargo.toml"],
        type: "npm",
      },
      manifests: {
        "Cargo.toml": '[package]\nname = "scratch"\nversion = "0.4.2"\n',
        "plugin/plugin.json": manifestText("0.4.2", TWO_SPACES),
      },
    });
    outcome = await release(fixture);
  });

  it("still bumps the JSON manifests around it", () => {
    expect({
      plugin: versionOf(fixture.root, "plugin/plugin.json"),
      primary: versionOf(fixture.root),
    }).toEqual({ plugin: "0.5.0", primary: "0.5.0" });
  });

  it("leaves the non-JSON file untouched instead of rewriting it blindly", () => {
    expect(fileText(fixture.root, "Cargo.toml")).toContain('version = "0.4.2"');
  });

  it("reports the file it delegated rather than dropping it silently", () => {
    const notes = (outcome.report.phases ?? [])
      .map((entry) => entry.note ?? "")
      .join(" ");
    expect(notes).toContain("Cargo.toml");
  });
});

// ===========================================================================
// Slice 17 — the PACK GATE refuses. The last look at the artifact before it goes
// out (a tarball carrying tests, a cask with no checksum): refusing there must
// leave exactly as little behind as a failed publish does.
// ===========================================================================

describe("release — the pack gate refuses the artifact", () => {
  let fixture: Fixture;
  let originHead: string;
  let outcome: Outcome;
  let preReleaseSubject: string;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      adapterFails: "packGate",
      commits: [{ subject: "feat: add csv export" }],
    });
    originHead = shaOf(fixture.origin, "main");
    preReleaseSubject = subjects(fixture.root)[0] ?? "";
    outcome = await release(fixture, ["--notes-file", writeNotesFile()]);
  });

  it("fails the release", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("never publishes what the gate rejected", () => {
    expect(fixture.calls.map((call) => call.phase)).not.toContain("publish");
  });

  it("rolls the local bump commit back and restores the manifest", () => {
    expect({
      subject: subjects(fixture.root)[0],
      version: versionOf(fixture.root),
    }).toEqual({ subject: preReleaseSubject, version: "0.4.2" });
  });

  it("pushes nothing to origin", () => {
    expect({
      main: shaOf(fixture.origin, "main"),
      tag: refExists(fixture.origin, "refs/tags/v0.5.0"),
    }).toEqual({ main: originHead, tag: false });
  });
});

// ===========================================================================
// Slice 18 — a failure AFTER the publish. Past the adapter's publish the release
// is PUBLIC, so the rollback that protects an unshipped version becomes the wrong
// move entirely: the run reports what happened, keeps the tag and the pushed
// commit, and says the release IS out.
// ===========================================================================

describe("release — the smoke test fails after publishing", () => {
  let fixture: Fixture;
  let outcome: Outcome;

  beforeAll(async () => {
    fixture = makeReleaseFixture({
      adapterFails: "smoke",
      commits: [{ subject: "feat: add csv export" }],
    });
    outcome = await release(fixture, ["--notes-file", writeNotesFile()]);
  });

  it("reports the failure", () => {
    expect(outcome.exitCode).toBe(1);
  });

  it("still reports the release as published", () => {
    expect(outcome.report.published).toBe(true);
  });

  it("records the phase that failed", () => {
    const failed = (outcome.report.phases ?? [])
      .filter((entry) => !entry.ok)
      .map((entry) => entry.name);
    expect(failed).toContain("smoke");
  });

  it("rolls nothing back — the release commit and its tag stay", () => {
    expect({
      subject: subjects(fixture.root)[0],
      tag: refExists(fixture.root, "refs/tags/v0.5.0"),
    }).toEqual({ subject: "release: v0.5.0", tag: true });
  });

  it("leaves the pushed release on origin", () => {
    expect({
      main: shaOf(fixture.origin, "main") === shaOf(fixture.root, "HEAD"),
      tag: refExists(fixture.origin, "refs/tags/v0.5.0"),
    }).toEqual({ main: true, tag: true });
  });
});

describe("release — the GitHub release cannot be created after publishing", () => {
  it("reports it as published and undoes nothing", async () => {
    const fixture = makeReleaseFixture({
      commits: [{ subject: "feat: add csv export" }],
      ghReleaseFails: true,
    });

    const outcome = await release(fixture, ["--notes-file", writeNotesFile()]);

    expect({
      exitCode: outcome.exitCode,
      published: outcome.report.published,
      pushedTag: refExists(fixture.origin, "refs/tags/v0.5.0"),
      subject: subjects(fixture.root)[0],
    }).toEqual({
      exitCode: 1,
      published: true,
      pushedTag: true,
      subject: "release: v0.5.0",
    });
    // The half that is left to finish by hand has to be nameable.
    expect(outcome.stderr).toContain("gh release create");
  });
});
