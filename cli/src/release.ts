import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CheckGroup, type CheckNote, check } from "./check.ts";
import type { CommandContext, CommandResult } from "./command.ts";
import { type DobbyConfig, loadConfig } from "./config.ts";
import { linkedWorktreeMain } from "./lifecycle.ts";
import { caskAdapter } from "./release-cask.ts";
import { npmAdapter } from "./release-npm.ts";
import { type RunResult, requireWorkroot, runCapture } from "./runner.ts";

// `dobby release` — the ONE release command, config-gated: it exists (and is
// advertised in the help) only when `dobby.config.json` carries a `release` key,
// because nothing in a repo infers a release target. THIS module is the SPINE —
// the phases every release target shares — while everything target-specific
// (npm, homebrew-cask) lives behind the `ReleaseAdapter` interface below, in its
// own module, registered under the config's `release.type`.
//
// THE TWO-PHASE INVOCATION is the shape to hold on to. A release stops TWICE for
// a human/model, and both stops are DATA, never a prompt (the CLI never reads
// stdin, so every stop is testable and every answer arrives as a flag):
//
//   1. `needsDecision` (Decision 3) — the two version questions a machine must
//      not answer alone (a first release, and a breaking change while still on
//      0.x). The command exits 1 with `{needsDecision, context}` having touched
//      NOTHING; the skill asks and re-runs with `--bump <level>`.
//   2. `needsNotes` (Decision 4) — release notes are MODEL-authored, so a run
//      without `--notes-file` does everything mechanical (preflights, version,
//      the manifest bump, the gate, the local `release: v<V>` commit) and then
//      STOPS with the changelog DATA, exit 1, nothing pushed and nothing
//      published. The skill authors the notes and re-runs with `--notes-file`;
//      the re-run RECOGNIZES the local bump commit and never bumps twice.
//
// PHASE ORDER (each phase emits a record; `--json` answers with ONE payload
// carrying `phases[]`):
//   1. preflight — main checkout only, on `main`, clean tree, `git pull
//      --ff-only`, CI green ON THIS COMMIT, then `adapter.preflight`.
//   2. version   — the last `v*` tag, the "nothing to release" guard, the
//      NUL-delimited commit classification, the `needsDecision` gates.
//   3. bump      — the indentation-PRESERVING manifest rewrite across the
//      lockstep surfaces, `adapter.bumpExtras` for the surfaces that are not
//      JSON, the gate over the bumped tree, the local commit.
//   4. changelog — the grouped commit data the notes author consumes.
//   5. publish   — `adapter.packGate` → `adapter.publish` → tag → push → the
//      GitHub release → `adapter.postRelease` → `adapter.smoke`, with the
//      PUBLISH-GATED PUSH invariant.
//
// PUBLISH-GATED PUSH (field-proven): nothing leaves the machine until the
// adapter has actually published. A pushed tag (or a pushed `release: v…`
// commit) for a version that never shipped burns that version number for good,
// so the tag is created AFTER the publish and a failed publish rolls the local
// bump commit back (`git reset --hard HEAD~1`) while it is still unpushed.
//
// Every child process goes through `runner.ts` with its cwd pinned to the
// workroot (`requireWorkroot` — running outside a git repository is a hard
// error, never a silent ambient-cwd fallback). `git` and `gh` are spawned BARE,
// resolved through PATH like the CLI's other system tools.
//
// node:*-only (ADR-0008) — vitest imports this under Node, Bun runs it in prod.

// The trunk a release is cut from. Stated ONCE: the branch preflight, the push
// and the CI query all mean the same branch.
const MAIN_BRANCH = "main";

// The subject the bump commit lands under — and, on a re-run, the SIGNAL that a
// previous planning run already prepared this release.
const RELEASE_SUBJECT_PREFIX = "release: v";

// The changelog group for a commit no surface glob claims (and the type-group
// for everything that is neither a feature nor a fix).
const OTHER_GROUP = "Other";
const BREAKING_GROUP = "Breaking changes";
const FEATURE_GROUP = "Features";
const FIX_GROUP = "Fixes";

// The conventional-commit type that earns a MINOR release.
const FEATURE_TYPE = "feat";
const FIX_TYPE = "fix";

// The bump levels, as `--bump` accepts them and as the classifier infers them.
const BUMP_LEVELS = ["major", "minor", "patch"] as const;
type BumpLevel = (typeof BUMP_LEVELS)[number];

// The version this release would be crossing INTO if a 0.x major were applied
// mechanically — the judgement call `needsDecision: "0x-major"` hands back.
const FIRST_STABLE_MAJOR = 1;

// `major.minor.patch` at the head of a version string (a prerelease/build
// suffix is deliberately not modelled: the spine bumps release versions).
const SEMVER = /^(\d+)\.(\d+)\.(\d+)/;

// The conventional-commit head: `type(scope)!: description`. The `!` capture IS
// the breaking-change marker the spec's first rule reads.
const CONVENTIONAL_SUBJECT = /^([a-zA-Z]+)(?:\([^)]*\))?(!)?:/;

// The breaking-change footer, in both spellings the convention allows.
const BREAKING_FOOTER = /BREAKING[ -]CHANGE/;

// The first INDENTED line of a JSON document — its one indentation unit.
const INDENTED_LINE = /^([ \t]+)\S/;

// The indentation assumed for a manifest that carries none (a single-line JSON
// document). NEVER used for a manifest that HAS an indentation — that hardcoded
// assumption is exactly the v0.5.1 field bug this module exists to prevent.
const FALLBACK_INDENT = "  ";

// The regex metacharacters a glob's literal bytes must be escaped as.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex metacharacters, not an interpolation
const REGEX_SPECIALS = ".+^${}()|[]\\";

// ---------------------------------------------------------------------------
// The ADAPTER interface — the seam between the spine and one release TARGET.
//
// The spine owns everything that is true of EVERY release (git state, the
// version, the changelog, the tag, the GitHub release); an adapter owns the four
// moments that are true only of its channel: whether the channel is ready
// (`preflight` — npm auth, the tap checkout), whether the ARTIFACT is shippable
// (`packGate` — the tarball's file list, the cask's checksum), the irreversible
// `publish` itself, and the `smoke` that proves the published thing installs.
// Two OPTIONAL moments extend it for a target the four do not describe:
// `bumpExtras` (a version-carrying file the spine's JSON-only bump cannot edit)
// and `postRelease` (work that can only happen once the GitHub release exists).
// Each returns DATA (never throws, never prints) so the spine can record it as a
// phase and decide what to roll back.
// ---------------------------------------------------------------------------

export interface ReleasePhaseResult {
  // Why the phase refused, when it did. Surfaced VERBATIM to the caller — an
  // adapter's own words are what the human needs (an `EOTP` from npm, a 403
  // from the tap).
  error?: string;
  // Anything the phase wants recorded alongside its verdict (the published
  // tarball's file count, the cask's sha256) — informational, never a gate.
  notes?: string;
  ok: boolean;
}

export interface ReleaseContext {
  // The version currently in the primary manifest, BEFORE the bump.
  currentVersion: string;
  // The publishable package's directory (absolute): `release.dir` resolved
  // against the workroot, or the workroot itself.
  dir: string;
  // The model-authored notes file (absolute), or null on a planning run — the
  // run that stops at `needsNotes` before anything is published.
  notesFile: string | null;
  // The `release` block of dobby.config.json, verbatim (the adapter reads its
  // own non-inferables from it: `tap`/`cask` for homebrew, `dir` for npm).
  release: ReleaseConfig;
  // The workroot — the MAIN checkout, guaranteed by the preflight.
  root: string;
  // `v<version>`, or null for as long as `version` is.
  tag: string | null;
  // The version being released. NULL during `preflight`: the preflights run
  // BEFORE the version is inferred (an adapter's preflight asks whether the
  // channel is usable at all, which never depends on the number), and carries a
  // concrete version from `packGate` onwards.
  version: string | null;
}

export interface ReleaseAdapter {
  // The version-carrying files the spine's own bump CANNOT edit — it rewrites
  // JSON manifests only, and a non-JSON lockstep surface (a `Cargo.toml`, whose
  // `version =` also appears under `[dependencies]`) needs target knowledge.
  // Runs INSIDE the bump phase: after the JSON manifests, BEFORE the gate and
  // the `release: v<V>` commit, so whatever it writes is gated and committed
  // with the rest of the bump. Optional — a target with nothing else to bump
  // (npm) simply omits it.
  bumpExtras?: (context: ReleaseContext, version: string) => ReleasePhaseResult;
  // The target's name, for the messages the spine writes about it.
  id: string;
  // Is the ARTIFACT shippable? Runs immediately before `publish` and is the last
  // chance to refuse — a tarball carrying tests, a cask with no checksum.
  packGate: (context: ReleaseContext) => ReleasePhaseResult;
  // The target's own work AFTER the release is public: uploading the built
  // artifact to the GitHub release (which cannot exist any earlier), moving a
  // Homebrew tap. Runs after `gh release create` and before `smoke` — PAST the
  // publish line, so a failure here is REPORTED with what is left to do by hand,
  // never rolled back. Optional — a target that publishes to a registry (npm)
  // has nothing left to do and omits it.
  postRelease?: (context: ReleaseContext) => ReleasePhaseResult;
  // Is the CHANNEL ready? Runs inside the spine's preflight phase, so a refusal
  // costs nothing: no version has been decided and no file has been touched.
  preflight: (context: ReleaseContext) => ReleasePhaseResult;
  // Where the version lives for this target, when it is NOT `<dir>/package.json`
  // (the npm default the spine assumes). Absolute path.
  primaryManifest?: (root: string, release: ReleaseConfig) => string;
  // The irreversible step. Everything the spine does AFTER this (tag, push, the
  // GitHub release) is gated on it having succeeded.
  publish: (context: ReleaseContext) => ReleasePhaseResult;
  // Does the published thing actually work? A failure here is REPORTED, never
  // rolled back — the artifact is already public.
  smoke: (context: ReleaseContext) => ReleasePhaseResult;
}

// The `release` block, taken from the schema `config.ts` owns — never
// re-declared here, so a second copy can never drift from the validator.
type ReleaseConfig = NonNullable<DobbyConfig["release"]>;

// The adapters, keyed by `dobby.config.json#release.type`. A MUTABLE registry
// (rather than a `switch`) is what lets a target be swapped at runtime: the
// per-target modules (`release-npm.ts`, `release-cask.ts`) own everything about
// their channel, and a test registers a fake under the same key. It is
// deliberately NOT a lazy `await import()` — `run.ts` dispatches handlers
// SYNCHRONOUSLY.
const releaseAdapters = new Map<string, ReleaseAdapter>();

/**
 * Register the adapter that drives one release target (`npm`,
 * `homebrew-cask`, …). Keyed by the value a project puts in
 * `dobby.config.json#release.type`; registering the same key twice replaces the
 * adapter, which is what lets a test substitute a fake target.
 *
 * @public — the adapter seam, consumed by the per-target modules.
 */
export function registerReleaseAdapter(
  type: string,
  adapter: ReleaseAdapter
): void {
  releaseAdapters.set(type, adapter);
}

// The BUILT-IN targets, registered HERE rather than self-registering from their
// own modules — the one thing about this seam that is not free choice. A target
// module that called `registerReleaseAdapter` at ITS top level would need a
// side-effect `import "./release-cask.ts"` here to be reachable from `run.ts`'s
// graph at all, and in that cycle the target's body runs BEFORE this module's,
// so `releaseAdapters` is still in its temporal dead zone: `ReferenceError:
// Cannot access 'releaseAdapters' before initialization` at import time
// (verified). Registering from the spine, AFTER the registry exists, inverts the
// evaluation order — the target modules then import only TYPES from here, so no
// runtime cycle exists at all. The spine still knows nothing about npm or
// homebrew: it holds one line each, and everything about a channel lives in its
// target module.
//
// These two lines are ALSO the whole production wiring: `run.ts` imports this
// module, so both targets are reachable from the CLI's graph — and, because
// `release.type` is a closed set (`npm | homebrew-cask`, validated in
// `config.ts`), every value a config can legally carry now has an adapter behind
// it. `noAdapterMessage` below is what a THIRD target would hit before its own
// line lands here.
registerReleaseAdapter("homebrew-cask", caskAdapter);
registerReleaseAdapter("npm", npmAdapter);

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

// The flags this command reads, already validated (the registry in run.ts has
// checked the allowlist; the VALUES are validated here).
interface ReleaseFlags {
  bump: BumpLevel | null;
  dryRun: boolean;
  json: boolean;
  notesFile: string | null;
}

// One phase, as the `--json` payload reports it. `note` carries whatever the
// phase wants remembered (an adapter's `notes`, a skipped re-bump).
interface PhaseRecord {
  name: string;
  note?: string;
  ok: boolean;
}

// One classified commit in the release range — and, unchanged, one changelog
// entry: the body is read for its BREAKING CHANGE footer and then dropped, since
// the notes author works from subjects.
interface CommitRecord {
  breaking: boolean;
  sha: string;
  subject: string;
  // The conventional-commit type (`feat`, `fix`, `chore`, …), or null for a
  // subject that does not follow the convention.
  type: string | null;
}

// The changelog DATA the skill authors notes from. `groups` is grouped by
// SURFACE when `release.surfaces` is configured, else by commit TYPE.
interface Changelog {
  groupedBy: "surface" | "type";
  groups: Record<string, CommitRecord[]>;
  // The tag the range started at, or null for a first release.
  since: string | null;
}

// Everything one invocation carries through the phases. `context` is the
// adapter-facing view of it (its `version`/`tag` fill in as they are decided).
interface Run {
  adapter: ReleaseAdapter;
  context: ReleaseContext;
  flags: ReleaseFlags;
  phases: PhaseRecord[];
  // The manifest that OWNS the version number (every other manifest mirrors it).
  primary: string;
  root: string;
}

// What the version phase decided, or the refusal that ended the release.
type VersionOutcome =
  | {
      alreadyBumped: boolean;
      commits: CommitRecord[];
      since: string | null;
      version: string;
    }
  | { result: CommandResult };

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Cut ONE release. Returns the outcome as DATA (`run.ts` renders it): the JSON
 * payload under `--json`, a token-lean human summary otherwise, and any refusal
 * on `error` (stderr) — which under `--json` is the only channel left, since the
 * payload owns stdout.
 *
 * @public — the `release` command's domain entry, dispatched by the registry in
 * run.ts.
 */
export function runRelease(context: CommandContext): CommandResult {
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return { error: messageOf(error), exitCode: 1 };
  }

  // The CONFIG GATE (Decision 2). `run.ts` hides the command entirely when the
  // key is absent, so this is unreachable through the dispatcher — it is the
  // guard for every OTHER caller, and defense in depth for the day the gate in
  // run.ts moves.
  const load = loadConfig(root);
  const release = load?.ok === true ? load.config.release : undefined;
  if (release === undefined) {
    return {
      error:
        "release requires a release key in dobby.config.json — nothing in a repo infers a release target (declare at least `release.type`)",
      exitCode: 1,
    };
  }

  const adapter = releaseAdapters.get(release.type);
  if (adapter === undefined) {
    return { error: noAdapterMessage(release.type), exitCode: 1 };
  }

  const flags = readFlags(context);
  if ("error" in flags) {
    return { error: flags.error, exitCode: 1 };
  }

  const dir = release.dir === undefined ? root : join(root, release.dir);
  const primary =
    adapter.primaryManifest?.(root, release) ?? join(dir, "package.json");
  const currentVersion = readManifestVersion(primary);
  if (typeof currentVersion !== "string") {
    return { error: currentVersion.error, exitCode: 1 };
  }

  return performRelease({
    adapter,
    context: {
      currentVersion,
      dir,
      notesFile: flags.notesFile,
      release,
      root,
      tag: null,
      version: null,
    },
    flags,
    phases: [],
    primary,
    root,
  });
}

// The phases, in order. Each helper either REFUSES (returning the finished
// CommandResult) or advances the run — so this reads as the release itself.
function performRelease(run: Run): CommandResult {
  // Detected FIRST, ahead of every phase: whether a previous planning run already
  // prepared this release changes what the PREFLIGHTS mean (the CI assertion has
  // to know that HEAD is a local commit CI can never have seen — see `ciTarget`),
  // not just whether the bump phase re-bumps.
  const pending = pendingRelease(run);

  const refusal = preflightPhase(run, pending);
  if (refusal !== null) {
    return refusal;
  }

  const decided = versionPhase(run, pending);
  if ("result" in decided) {
    return decided.result;
  }
  run.context.version = decided.version;
  run.context.tag = `v${decided.version}`;

  // `--dry-run` answers with the PLAN — the version this release would take and
  // the changelog it would be written from — having touched nothing.
  if (run.flags.dryRun) {
    return dryRunResult(run, changelogPhase(run, decided));
  }

  if (decided.alreadyBumped) {
    // The re-run after a `needsNotes` stop: the bump commit is already sitting
    // there, unpushed. Bumping again would take 0.5.0 to 0.6.0 for a release
    // that was already decided.
    run.phases.push({
      name: "bump",
      note: `already bumped by a previous run (${RELEASE_SUBJECT_PREFIX}${decided.version} is the local HEAD)`,
      ok: true,
    });
  } else {
    const bumpRefusal = bumpPhase(run);
    if (bumpRefusal !== null) {
      return bumpRefusal;
    }
  }

  const changelog = changelogPhase(run, decided);

  // The `needsNotes` STOP (Decision 4). Everything mechanical is done and the
  // bump commit is local; the notes are the model's to write.
  if (run.context.notesFile === null) {
    return needsNotesResult(run, changelog);
  }

  return publishPhase(run, changelog);
}

// ---------------------------------------------------------------------------
// Phase 1 — the preflights
//
// Everything after them is destructive (a commit, a publish, a push), so each
// guard refuses BEFORE anything moves and NAMES the fact that stopped it: the
// human reading the refusal is the one who has to fix it.
// ---------------------------------------------------------------------------

function preflightPhase(
  run: Run,
  pending: string | null
): CommandResult | null {
  const { root } = run;

  // MAIN CHECKOUT ONLY (field-proven). A release cut from a linked worktree
  // tags and pushes the goal's branch, not the trunk.
  const main = linkedWorktreeMain(root);
  if (main !== null) {
    return refuse(
      run,
      "preflight",
      `release must run from the MAIN checkout — ${root} is a linked worktree of ${main}; cd there and re-run`
    );
  }

  // `--show-current` (never `rev-parse --abbrev-ref HEAD`, which is `fatal:` on
  // an unborn branch): an empty answer means a detached HEAD, which is equally
  // not a branch to release from.
  const branch = gitFact(root, ["branch", "--show-current"]);
  if (branch !== MAIN_BRANCH) {
    return refuse(
      run,
      "preflight",
      `release must run on ${MAIN_BRANCH} — HEAD is on ${branch === "" ? "a detached HEAD" : branch}`
    );
  }

  const dirty = gitFact(root, ["status", "--porcelain"]);
  if (dirty !== "") {
    return refuse(
      run,
      "preflight",
      `release needs a clean tree — uncommitted changes:\n${dirty}`
    );
  }

  const pull = runCapture("git", ["pull", "--ff-only"], { root });
  if (pull.status !== 0) {
    return refuse(
      run,
      "preflight",
      `git pull --ff-only failed — ${detailOf(pull)}`
    );
  }

  const ci = ciRefusal(run, pending);
  if (ci !== null) {
    return refuse(run, "preflight", ci);
  }

  const adapterVerdict = run.adapter.preflight(run.context);
  if (!adapterVerdict.ok) {
    return refuse(
      run,
      "preflight",
      `the ${run.adapter.id} target refused the release: ${adapterVerdict.error ?? "no reason given"}`
    );
  }

  run.phases.push({ name: "preflight", ok: true, ...noteOf(adapterVerdict) });
  return null;
}

// The CI verdict, ASSERTED IN CODE rather than left to a human eyeballing a
// dashboard: the last run on main must be completed + successful AND be for
// EXACTLY the commit this release is cut from. A green run for some OTHER commit
// says nothing about the tree about to be published — the field failure this
// closes.
function ciRefusal(run: Run, pending: string | null): string | null {
  const { root } = run;
  const target = ciTarget(run, pending);
  const result = runCapture(
    "gh",
    [
      "run",
      "list",
      "--branch",
      MAIN_BRANCH,
      "--limit",
      "1",
      "--json",
      "headSha,status,conclusion",
    ],
    { root }
  );
  if (result.error || result.status !== 0) {
    return `CI could not be read — \`gh run list --branch ${MAIN_BRANCH}\` failed: ${detailOf(result)}`;
  }

  // gh prints an ARRAY for `--json`, even with `--limit 1`.
  let runs: unknown;
  try {
    runs = JSON.parse(result.stdout);
  } catch {
    return "CI could not be read — gh answered with unparseable JSON";
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return `CI has never run on ${MAIN_BRANCH} — nothing proves this commit is green`;
  }

  const last = runs[0] as {
    conclusion?: unknown;
    headSha?: unknown;
    status?: unknown;
  };
  if (last.status !== "completed") {
    return `CI is still running on ${MAIN_BRANCH} (status: ${String(last.status)}) — wait for it (\`gh run watch\`) and re-run`;
  }
  if (last.conclusion !== "success") {
    return `CI is ${String(last.conclusion)} on ${MAIN_BRANCH} — a release only ever ships a green commit`;
  }
  if (last.headSha !== target.sha) {
    return `the last CI run on ${MAIN_BRANCH} is for ${String(last.headSha)}, not ${target.label} (${target.sha}) — push and let CI finish first`;
  }
  return null;
}

// WHICH commit CI has to be green on, and how to NAME it in a refusal.
//
// Normally HEAD. But on the RESUME run of the two-phase flow (`--notes-file`,
// after a `needsNotes` stop) HEAD is the `release: v<V>` commit the planning run
// made LOCALLY and deliberately never pushed — so no CI run can EVER name that
// sha. Asserting against it would make the resume unreachable in production, and
// the only advice the refusal could give ("push and let CI finish first") would
// itself break the PUBLISH-GATED PUSH invariant by putting a release commit on
// the trunk for a version that has not shipped.
//
// What CI could have judged is that commit's PARENT — the tree the planning run
// started from, which is exactly what the first run already asserted green — and
// the bump commit's own tree was re-gated in-process (Decision 5) before it was
// committed. A release commit that IS pushed (nothing ahead of upstream) is a
// commit CI can have run on, so that case keeps asserting against HEAD.
function ciTarget(
  run: Run,
  pending: string | null
): { label: string; sha: string } {
  const head = { label: "HEAD", sha: gitFact(run.root, ["rev-parse", "HEAD"]) };
  if (pending === null || aheadOfUpstream(run.root) === false) {
    return head;
  }
  const parent = gitFact(run.root, ["rev-parse", "HEAD~1"]);
  return parent === ""
    ? head
    : {
        label: `the commit the local ${RELEASE_SUBJECT_PREFIX}${pending} commit sits on (HEAD~1)`,
        sha: parent,
      };
}

// ---------------------------------------------------------------------------
// Phase 2 — the version
// ---------------------------------------------------------------------------

function versionPhase(run: Run, pending: string | null): VersionOutcome {
  const { root } = run;
  const since = lastVersionTag(root);
  // The release commit itself is never part of its own changelog (and on a
  // re-run it sits INSIDE the range).
  const commits = commitsSince(root, since).filter(
    (commit) => !commit.subject.startsWith(RELEASE_SUBJECT_PREFIX)
  );

  if (pending !== null) {
    run.phases.push({
      name: "version",
      note: `resuming the release prepared locally for v${pending}`,
      ok: true,
    });
    return { alreadyBumped: true, commits, since, version: pending };
  }

  // NOTHING TO RELEASE: the last tag is already on HEAD, so there is no range
  // at all — cutting a release here republishes the same tree under a new
  // number.
  if (since !== null && countCommits(run.root, `${since}..HEAD`) === 0) {
    return {
      result: refuse(
        run,
        "version",
        `nothing to release — ${since} is already on HEAD`
      ),
    };
  }

  const { currentVersion } = run.context;
  const inferred = inferLevel(commits);
  const decision =
    run.flags.bump === null
      ? needsDecisionKind(since, inferred, currentVersion)
      : null;
  if (decision !== null) {
    return { result: needsDecisionResult(run, decision, commits) };
  }

  const version = applyBump(currentVersion, run.flags.bump ?? inferred);
  if (version === null) {
    return {
      result: refuse(
        run,
        "version",
        `cannot bump "${currentVersion}" — the manifest's version is not major.minor.patch`
      ),
    };
  }
  run.phases.push({ name: "version", ok: true });
  return { alreadyBumped: false, commits, since, version };
}

// The last RELEASE tag, or null when there is none — which is a FIRST RELEASE,
// not an error. `git describe` exits 128 both for a repo with no tags at all and
// for one whose tags simply do not match `v*`, so both land here; its stderr
// (`fatal: No names found…`) is captured and dropped rather than forwarded, as
// it describes neither problem the user has.
function lastVersionTag(root: string): string | null {
  const result = runCapture(
    "git",
    ["describe", "--tags", "--abbrev=0", "--match", "v*"],
    { root }
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const tag = result.stdout.trim();
  if (tag === "") {
    return null;
  }
  // A tag `describe` named must still RESOLVE before it can anchor a range.
  const verified = runCapture(
    "git",
    ["rev-parse", "--verify", "--quiet", tag],
    {
      root,
    }
  );
  return verified.status === 0 ? tag : null;
}

// The commits in the range, classified. ONE `git log` with NUL-delimited fields:
// a commit body legally contains newlines, so a line-oriented parse would split
// records apart.
//
// `-z` + `--pretty=format:` (NOT `tformat:`) means the separator is inserted
// only BETWEEN entries — so the payload is a flat NUL-separated list of 3 fields
// per commit with NO trailing NUL, and chunking by 3 is exact.
function commitsSince(root: string, since: string | null): CommitRecord[] {
  const range = since === null ? "HEAD" : `${since}..HEAD`;
  const result = runCapture(
    "git",
    ["log", range, "-z", "--pretty=format:%H%x00%s%x00%B"],
    { root }
  );
  if (result.error || result.status !== 0 || result.stdout === "") {
    return [];
  }

  const fields = result.stdout.split("\0");
  const commits: CommitRecord[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index] ?? "";
    const subject = fields[index + 1] ?? "";
    const body = fields[index + 2] ?? "";
    const head = CONVENTIONAL_SUBJECT.exec(subject);
    commits.push({
      // Either the `!` before the colon or a BREAKING CHANGE footer. `%B` is the
      // RAW body (subject line included), which is deliberate: a subject that
      // spells the footer out is stating the same intent.
      breaking: head?.[2] === "!" || BREAKING_FOOTER.test(body),
      sha,
      subject,
      type: head?.[1] ?? null,
    });
  }
  return commits;
}

// How many commits the range holds (0 = nothing to release).
function countCommits(root: string, range: string): number {
  const result = runCapture("git", ["rev-list", "--count", range], { root });
  if (result.status !== 0) {
    return 0;
  }
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? 0 : count;
}

// The bump the commits imply, first rule wins: any breaking change → major, any
// feature → minor, everything else → patch.
function inferLevel(commits: CommitRecord[]): BumpLevel {
  if (commits.some((commit) => commit.breaking)) {
    return "major";
  }
  return commits.some((commit) => commit.type === FEATURE_TYPE)
    ? "minor"
    : "patch";
}

// Which version question a machine must NOT answer alone (Decision 3), or null
// when the arithmetic is unambiguous:
//   - FIRST RELEASE — there is no previous release to infer from at all.
//   - 0x-MAJOR — a breaking change while still below 1.0.0, where "major" is a
//     judgement (a true 1.0.0 vs the 0.x convention of shipping breaking as a
//     minor), never arithmetic.
function needsDecisionKind(
  since: string | null,
  inferred: BumpLevel,
  currentVersion: string
): string | null {
  if (since === null) {
    return "first-release";
  }
  const major = SEMVER.exec(currentVersion)?.[1];
  const preStable =
    major !== undefined && Number.parseInt(major, 10) < FIRST_STABLE_MAJOR;
  return inferred === "major" && preStable ? "0x-major" : null;
}

// Apply a level to a version. Null when the version is not `major.minor.patch`.
function applyBump(current: string, level: BumpLevel): string | null {
  const parsed = SEMVER.exec(current);
  if (parsed === null) {
    return null;
  }
  const major = Number.parseInt(parsed[1] ?? "0", 10);
  const minor = Number.parseInt(parsed[2] ?? "0", 10);
  const patch = Number.parseInt(parsed[3] ?? "0", 10);
  if (level === "major") {
    return `${major + 1}.0.0`;
  }
  return level === "minor"
    ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;
}

// The version a PREVIOUS planning run already prepared, or null. Three facts
// must agree, so a hand-written commit message can never be mistaken for one:
// HEAD is a `release: v<V>` commit, the primary manifest really says `<V>`, and
// no `v<V>` tag exists yet (a tag would mean that release COMPLETED — and then
// the "nothing to release" guard is the right answer, not a resume).
function pendingRelease(run: Run): string | null {
  const subject = gitFact(run.root, ["log", "-1", "--pretty=%s"]);
  if (!subject.startsWith(RELEASE_SUBJECT_PREFIX)) {
    return null;
  }
  const version = subject.slice(RELEASE_SUBJECT_PREFIX.length).trim();
  if (version === "" || version !== run.context.currentVersion) {
    return null;
  }
  return refExists(run.root, `refs/tags/v${version}`) ? null : version;
}

// ---------------------------------------------------------------------------
// Phase 3 — the bump
// ---------------------------------------------------------------------------

function bumpPhase(run: Run): CommandResult | null {
  const version = run.context.version ?? "";
  const targets = bumpTargets(run);

  const written: string[] = [];
  for (const path of targets.manifests) {
    const problem = writeVersion(path, version);
    if (problem !== null) {
      restore(run, written);
      return refuse(run, "bump", problem);
    }
    written.push(path);
  }

  // The TARGET's half of the bump — the version-carrying files this spine cannot
  // edit (see `bumpTargets`). It runs HERE, between the manifests and the gate,
  // for two reasons: the gate must judge the tree that is about to be committed
  // (a stale `Cargo.lock` would turn CI red on the release commit itself), and
  // the commit below must CARRY the edit — a lockstep file bumped after it is a
  // tag that does not hold the version it claims.
  const extras = run.adapter.bumpExtras?.(run.context, version);
  if (extras !== undefined && !extras.ok) {
    restore(run, written);
    return refuse(
      run,
      "bump",
      `the ${run.adapter.id} target could not bump its own lockstep files: ${extras.error ?? "no reason given"}; the JSON manifests were restored, but anything that target already wrote is still in your tree`
    );
  }

  // THE GATE, over the BUMPED tree and before the commit (Decision 5): the bump
  // edits committed files, so the tree that is about to be tagged is not the
  // tree CI judged. `check()` is composed IN-PROCESS with fix=true — exactly the
  // data path `dobby check --fix` takes — never a `dobby` subprocess.
  const report = check([], run.root, {}, true);
  if (!report.ok) {
    restore(run, written);
    return refuse(run, "bump", report.error);
  }
  if (report.exitCode !== 0) {
    restore(run, written);
    return refuse(
      run,
      "bump",
      `the gate is red over the bumped tree — nothing was committed and the manifests were restored (any SAFE fixes the gate applied are still in your tree):\n\n${formatFindings(report.groups, report.notes, report.exitCode)}`,
      report.exitCode
    );
  }

  // Stage TRACKED modifications only: the bump plus whatever the gate's `--fix`
  // rewrote. An untracked file some tool dropped is never part of a release
  // commit — and the preflight already proved the tree was clean, so there is
  // nothing else of the user's to sweep up.
  runCapture("git", ["add", "-u"], { root: run.root });
  const commit = runCapture(
    "git",
    ["commit", "-m", `${RELEASE_SUBJECT_PREFIX}${version}`],
    { root: run.root }
  );
  if (commit.status !== 0) {
    restore(run, written);
    return refuse(run, "bump", `git commit failed — ${detailOf(commit)}`);
  }

  run.phases.push({
    name: "bump",
    ok: true,
    ...bumpNote(targets.delegated, extras),
  });
  return null;
}

// The bump phase's note: the files the spine left to the adapter, plus whatever
// the adapter said about them. Both when both exist — once a target really
// handles them (`bumpExtras`), the delegated list alone reads as "dropped".
function bumpNote(
  delegated: string[],
  extras: ReleasePhaseResult | undefined
): { note?: string } {
  const parts = [skippedNote(delegated).note, extras?.notes].filter(
    (part): part is string => part !== undefined && part !== ""
  );
  return parts.length === 0 ? {} : { note: parts.join("; ") };
}

// The manifests the bump rewrites: the PRIMARY (the one that owns the number)
// plus every `release.lockstep` entry — repo-relative FILE paths of the other
// version-carrying manifests that must move together.
//
// JSON only. A non-JSON lockstep file (mad-eye's `Cargo.toml`, where `version =`
// also appears under `[dependencies]`) needs a target-specific editor and is
// left to the adapter; it is reported, never silently dropped.
function bumpTargets(run: Run): { delegated: string[]; manifests: string[] } {
  const manifests = [run.primary];
  const delegated: string[] = [];
  for (const entry of run.context.release.lockstep ?? []) {
    const path = join(run.root, entry);
    if (entry.endsWith(".json")) {
      if (!manifests.includes(path)) {
        manifests.push(path);
      }
    } else {
      delegated.push(entry);
    }
  }
  return { delegated, manifests };
}

// Write `version` into ONE manifest, PRESERVING its own formatting.
//
// The v0.5.1 field bug: the release skill re-serialized every manifest it
// touched with a hardcoded `"\t"` indent, so the 2-space files came back
// reformatted head to toe and CI went red on the release commit itself. The
// indentation is therefore MEASURED from the file (its first indented line) and
// only the version VALUE is rewritten — a byte-surgical edit that cannot touch
// anything else. Re-serialization survives only as the fallback for a manifest
// whose version line is not in the canonical form, and even then it uses the
// measured indent.
function writeVersion(path: string, version: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return `could not read the version manifest ${path}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `could not parse the version manifest ${path}`;
  }
  const current = (parsed as { version?: unknown }).version;
  if (typeof current !== "string") {
    return `${path} carries no string "version" field`;
  }
  if (current === version) {
    return null;
  }

  const indent = detectIndent(raw);
  // Anchored to a line start so a NESTED `"version"` (a dependency's, indented
  // deeper) can never be the one that moves.
  const needle = `\n${indent}"version": "${current}"`;
  const at = raw.indexOf(needle);
  const next =
    at === -1
      ? `${JSON.stringify({ ...(parsed as object), version }, null, indent)}\n`
      : `${raw.slice(0, at)}\n${indent}"version": "${version}"${raw.slice(at + needle.length)}`;
  try {
    writeFileSync(path, next);
  } catch (error) {
    return `could not write ${path}: ${messageOf(error)}`;
  }
  return null;
}

// A document's ONE indentation unit — the leading whitespace of its first
// indented line. NEVER a constant: see writeVersion.
function detectIndent(raw: string): string {
  for (const line of raw.split("\n")) {
    const match = INDENTED_LINE.exec(line);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return FALLBACK_INDENT;
}

// Put the manifests back the way they were found. `git checkout --` is safe HERE
// and only here: the release is a single-writer ceremony whose preflight already
// proved the tree clean, and this runs BEFORE any commit — so the only thing
// these paths can hold is the bump this run just wrote.
function restore(run: Run, paths: string[]): void {
  if (paths.length > 0) {
    runCapture("git", ["checkout", "--", ...paths], { root: run.root });
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — the changelog DATA
//
// The CLI supplies the mechanics (the range, the classification, the grouping);
// the NOTES themselves are model-authored (Decision 4) — a mechanically
// generated changelog is exactly what this replaces.
// ---------------------------------------------------------------------------

function changelogPhase(
  run: Run,
  decided: { commits: CommitRecord[]; since: string | null }
): Changelog {
  const { surfaces } = run.context.release;
  const grouped =
    surfaces === undefined || Object.keys(surfaces).length === 0
      ? { groupedBy: "type" as const, groups: groupByType(decided.commits) }
      : {
          groupedBy: "surface" as const,
          groups: groupBySurface(run.root, decided.commits, surfaces),
        };
  run.phases.push({ name: "changelog", ok: true });
  return { ...grouped, since: decided.since };
}

// The no-config default: grouped by what each commit IS.
function groupByType(commits: CommitRecord[]): Record<string, CommitRecord[]> {
  const groups: Record<string, CommitRecord[]> = {};
  for (const name of [BREAKING_GROUP, FEATURE_GROUP, FIX_GROUP, OTHER_GROUP]) {
    const members = commits.filter((commit) => typeGroupOf(commit) === name);
    if (members.length > 0) {
      groups[name] = members;
    }
  }
  return groups;
}

function typeGroupOf(commit: CommitRecord): string {
  if (commit.breaking) {
    return BREAKING_GROUP;
  }
  if (commit.type === FEATURE_TYPE) {
    return FEATURE_GROUP;
  }
  return commit.type === FIX_TYPE ? FIX_GROUP : OTHER_GROUP;
}

// ADR-0007's surface grouping, kept alive as CONFIG: `release.surfaces` maps a
// display name to a glob, and a commit lands in every surface whose glob one of
// its files matched. Every surface it touched, deliberately: a commit that spans
// two surfaces is half of each story, and hiding it under the first match would
// silently drop the other half from the notes.
function groupBySurface(
  root: string,
  commits: CommitRecord[],
  surfaces: Record<string, string>
): Record<string, CommitRecord[]> {
  const matchers = Object.entries(surfaces).map(([name, glob]) => ({
    name,
    pattern: globToRegExp(glob),
  }));
  const groups: Record<string, CommitRecord[]> = {};
  for (const commit of commits) {
    const files = commitFiles(root, commit.sha);
    const hits = matchers
      .filter((matcher) => files.some((file) => matcher.pattern.test(file)))
      .map((matcher) => matcher.name);
    for (const name of hits.length === 0 ? [OTHER_GROUP] : hits) {
      const bucket = groups[name] ?? [];
      bucket.push(commit);
      groups[name] = bucket;
    }
  }
  return groups;
}

// The repo-relative paths one commit touched.
function commitFiles(root: string, sha: string): string[] {
  const result = runCapture(
    "git",
    ["show", "--name-only", "--pretty=format:", sha],
    { root }
  );
  if (result.error || result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// Translate a glob to an anchored RegExp: `**` matches across path separators,
// `*` within one segment, `?` a single non-separator character. (lifecycle.ts
// carries its own copy for `.worktreeinclude`; both are private to their module
// and neither is the other's home.)
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char !== undefined && REGEX_SPECIALS.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

// ---------------------------------------------------------------------------
// Phase 5 — publish
// ---------------------------------------------------------------------------

function publishPhase(run: Run, changelog: Changelog): CommandResult {
  const { context: releaseContext, root } = run;
  const notesFile = releaseContext.notesFile ?? "";
  const tag = releaseContext.tag ?? "";

  const packed = run.adapter.packGate(releaseContext);
  if (!packed.ok) {
    return rollback(
      run,
      "pack-gate",
      `the ${run.adapter.id} pack gate refused the artifact: ${packed.error ?? "no reason given"}`
    );
  }
  run.phases.push({ name: "pack-gate", ok: true, ...noteOf(packed) });

  const published = run.adapter.publish(releaseContext);
  if (!published.ok) {
    return rollback(
      run,
      "publish",
      `the publish failed on the ${run.adapter.id} target: ${published.error ?? "no reason given"}`
    );
  }
  run.phases.push({ name: "publish", ok: true, ...noteOf(published) });

  // PAST THIS LINE THE RELEASE IS PUBLIC. Nothing below rolls anything back —
  // the artifact is out — so every remaining failure is REPORTED with what is
  // left to do by hand.
  const tagged = runCapture("git", ["tag", tag], { root });
  if (tagged.status !== 0) {
    return reportAfterPublish(
      run,
      "tag",
      `git tag ${tag} failed — ${detailOf(tagged)}`,
      changelog
    );
  }
  run.phases.push({ name: "tag", ok: true });

  const pushed = runCapture("git", ["push", "origin", MAIN_BRANCH, tag], {
    root,
  });
  if (pushed.status !== 0) {
    return reportAfterPublish(
      run,
      "push",
      `git push origin ${MAIN_BRANCH} ${tag} failed — ${detailOf(pushed)}`,
      changelog
    );
  }
  run.phases.push({ name: "push", ok: true });

  const created = runCapture(
    "gh",
    ["release", "create", tag, "--title", tag, "--notes-file", notesFile],
    { root }
  );
  if (created.status !== 0) {
    return reportAfterPublish(
      run,
      "github-release",
      `gh release create ${tag} failed — ${detailOf(created)}`,
      changelog
    );
  }
  run.phases.push({ name: "github-release", ok: true });

  // The target's own work AFTER the release exists: there is nothing to upload
  // an artifact TO before this point, so a target whose channel is fed from the
  // GitHub release (a Homebrew tap) does it here — before the smoke, which tells
  // a human to install what the tap now carries. It is past the publish line, so
  // a failure is reported with the remaining steps, never rolled back.
  const after = run.adapter.postRelease?.(releaseContext);
  if (after !== undefined) {
    if (!after.ok) {
      return reportAfterPublish(
        run,
        "post-release",
        `the ${run.adapter.id} target failed after the release was published: ${after.error ?? "no reason given"} — ${tag} IS public; finish the remaining steps by hand`,
        changelog
      );
    }
    run.phases.push({ name: "post-release", ok: true, ...noteOf(after) });
  }

  // The smoke runs LAST and never gates anything: a fresh publish can take
  // MINUTES to propagate, so an adapter's smoke is expected to retry and its
  // failure is a report, not a rollback.
  const smoked = run.adapter.smoke(releaseContext);
  if (!smoked.ok) {
    return reportAfterPublish(
      run,
      "smoke",
      `the ${run.adapter.id} smoke test failed: ${smoked.error ?? "no reason given"} — the release IS published; investigate before announcing it`,
      changelog
    );
  }
  run.phases.push({ name: "smoke", ok: true, ...noteOf(smoked) });

  return answer(
    run,
    {
      changelog,
      phases: run.phases,
      published: true,
      tag,
      version: releaseContext.version,
    },
    `released ${tag} on ${run.adapter.id}\n`,
    { exitCode: 0 }
  );
}

// A pre-publish failure: undo the local bump commit while it is still ours to
// undo, so the version number is not burned.
function rollback(run: Run, phase: string, message: string): CommandResult {
  const undone = undoBumpCommit(run);
  return refuse(
    run,
    phase,
    undone
      ? `${message}; the local release commit was rolled back (git reset --hard HEAD~1) and nothing was pushed`
      : `${message}; the release commit was left in place (it is no longer this run's to undo) — nothing was pushed`
  );
}

// Whether the bump commit is the UNPUSHED HEAD — the only state in which
// `git reset --hard HEAD~1` destroys nothing but this run's own work.
function undoBumpCommit(run: Run): boolean {
  const expected = `${RELEASE_SUBJECT_PREFIX}${run.context.version ?? ""}`;
  if (gitFact(run.root, ["log", "-1", "--pretty=%s"]) !== expected) {
    return false;
  }
  const local =
    aheadOfUpstream(run.root) ??
    // No upstream to compare against: the ABSENT tag is the remaining evidence
    // that nothing of this release has left the machine.
    !refExists(run.root, `refs/tags/v${run.context.version ?? ""}`);
  if (!local) {
    return false;
  }
  return (
    runCapture("git", ["reset", "--hard", "HEAD~1"], { root: run.root })
      .status === 0
  );
}

// A failure AFTER the publish: the phase is recorded red, NOTHING is undone (the
// artifact is public — a rollback here would only hide it), and the payload still
// reports `published: true` so the skill tells the user what did happen and what
// is left to finish by hand.
function reportAfterPublish(
  run: Run,
  phase: string,
  message: string,
  changelog: Changelog
): CommandResult {
  run.phases.push({ name: phase, ok: false });
  return answer(
    run,
    {
      changelog,
      phases: run.phases,
      published: true,
      tag: run.context.tag,
      version: run.context.version,
    },
    "",
    { error: message, exitCode: 1 }
  );
}

// ---------------------------------------------------------------------------
// The three stops + rendering
// ---------------------------------------------------------------------------

// `needsDecision` (Decision 3): exit 1 with the context the skill's
// AskUserQuestion needs, having touched NOTHING.
function needsDecisionResult(
  run: Run,
  kind: string,
  commits: CommitRecord[]
): CommandResult {
  const subjects = commits.map((commit) => commit.subject);
  const { currentVersion } = run.context;
  run.phases.push({ name: "version", note: kind, ok: false });
  const lines = [
    `release needs a human decision: ${kind}`,
    `  current version: ${currentVersion}`,
    ...subjects.map((subject) => `  - ${subject}`),
  ];
  return answer(
    run,
    {
      context: { commits: subjects, currentVersion },
      needsDecision: kind,
      phases: run.phases,
      version: null,
    },
    `${lines.join("\n")}\n`,
    {
      error: `release stopped for a version decision (${kind}) — nothing was touched; re-run with --bump patch|minor|major`,
      exitCode: 1,
    }
  );
}

// `needsNotes` (Decision 4): the mechanical half is done and committed LOCALLY;
// the notes are the model's to author.
function needsNotesResult(run: Run, changelog: Changelog): CommandResult {
  const tag = run.context.tag ?? "";
  return answer(
    run,
    {
      changelog,
      needsNotes: true,
      phases: run.phases,
      version: run.context.version,
    },
    "",
    {
      error: `${tag} is prepared locally (version bumped, gate green, commit made) — nothing was pushed or published. Author the release notes and re-run with --notes-file <path>; keep that file OUTSIDE the repo, since a release refuses a dirty tree.`,
      exitCode: 1,
    }
  );
}

// `--dry-run`: what this release WOULD be, having touched nothing.
function dryRunResult(run: Run, changelog: Changelog): CommandResult {
  return answer(
    run,
    {
      changelog,
      dryRun: true,
      phases: run.phases,
      version: run.context.version,
    },
    `release (dry-run): would cut ${run.context.tag} on ${run.adapter.id}\n`,
    { exitCode: 0 }
  );
}

// A refusal: record the phase red and answer with the error on stderr. Under
// `--json` the payload still travels, so a skill parsing stdout always finds one.
function refuse(
  run: Run,
  phase: string,
  error: string,
  exitCode = 1
): CommandResult {
  run.phases.push({ name: phase, ok: false });
  return answer(run, { phases: run.phases, version: run.context.version }, "", {
    error,
    exitCode,
  });
}

// The `--json` contract: with `--json` the payload is the ONLY stdout; without
// it the human `text` prints instead. Errors always travel on stderr — under
// `--json` that is the only channel left, and keeping it uniform means both
// forms surface the same words.
function answer(
  run: Run,
  payload: unknown,
  text: string,
  outcome: { error?: string; exitCode: number }
): CommandResult {
  const result: CommandResult = { exitCode: outcome.exitCode };
  if (outcome.error !== undefined) {
    result.error = outcome.error;
  }
  if (run.flags.json) {
    result.json = payload;
  } else {
    result.text = text;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Flags, manifests, git plumbing
// ---------------------------------------------------------------------------

function readFlags(context: CommandContext): ReleaseFlags | { error: string } {
  const requested = context.options.bump;
  let bump: BumpLevel | null = null;
  if (typeof requested === "string") {
    if (!(BUMP_LEVELS as readonly string[]).includes(requested)) {
      return {
        error: `--bump must be one of: ${BUMP_LEVELS.join(", ")} (got "${requested}")`,
      };
    }
    bump = requested as BumpLevel;
  }

  // The notes file is validated BEFORE anything is touched (ship's precedent): a
  // release that cannot produce notes must leave the tree exactly as it found
  // it. Resolved against the CALLER's cwd — every spawn below is pinned to the
  // workroot, so a relative path would otherwise change meaning.
  const requestedNotes = context.options["notes-file"];
  let notesFile: string | null = null;
  if (typeof requestedNotes === "string" && requestedNotes !== "") {
    notesFile = resolve(context.cwd, requestedNotes);
    let body: string;
    try {
      body = readFileSync(notesFile, "utf8");
    } catch {
      return { error: `--notes-file: cannot read the notes file ${notesFile}` };
    }
    if (body.trim() === "") {
      return { error: `--notes-file: the notes file ${notesFile} is empty` };
    }
  }

  return {
    bump,
    dryRun: context.options["dry-run"] === true,
    json: context.options.json === true,
    notesFile,
  };
}

// The version a manifest currently declares, or the problem with reading it.
function readManifestVersion(path: string): string | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {
      error: `release cannot read the version manifest ${path} — check release.dir in dobby.config.json`,
    };
  }
  const { version } = parsed as { version?: unknown };
  return typeof version === "string" && version !== ""
    ? version
    : { error: `${path} carries no "version" — there is nothing to bump` };
}

// A single git fact as trimmed stdout (empty when git could not answer).
function gitFact(root: string, args: string[]): string {
  return runCapture("git", args, { root }).stdout.trim();
}

// Whether the branch carries commits its upstream does not — i.e. work that has
// NOT left the machine. Null when there is no upstream to compare against, which
// is a different answer from "no": each caller decides what to make of it.
function aheadOfUpstream(root: string): boolean | null {
  const ahead = runCapture("git", ["rev-list", "--count", "@{u}..HEAD"], {
    root,
  });
  return ahead.status === 0
    ? Number.parseInt(ahead.stdout.trim(), 10) > 0
    : null;
}

// Whether a ref resolves in the repo.
function refExists(root: string, ref: string): boolean {
  return (
    runCapture("git", ["rev-parse", "--verify", "--quiet", ref], { root })
      .status === 0
  );
}

// A failed child as one caller-presentable detail: its own output (stderr first
// — where tools speak — falling back to stdout), else the spawn error / exit.
function detailOf(result: RunResult): string {
  const detail = (
    result.stderr.trim() === "" ? result.stdout : result.stderr
  ).trim();
  if (detail !== "") {
    return detail;
  }
  return result.error === undefined
    ? `exit ${String(result.status)}`
    : result.error.message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// An adapter's `notes` folded into its phase record (absent when it said none).
function noteOf(result: ReleasePhaseResult): { note?: string } {
  return result.notes === undefined ? {} : { note: result.notes };
}

// The lockstep files the spine did NOT edit, recorded on the bump phase.
function skippedNote(delegated: string[]): { note?: string } {
  return delegated.length === 0
    ? {}
    : {
        note: `left to the adapter (not JSON): ${delegated.join(", ")}`,
      };
}

// The message for a `release.type` no adapter answers to. Names what IS
// registered, so a typo and a missing build are told apart. Unreachable TODAY
// (both members of the closed `release.type` set are registered above, and
// `config.ts` refuses anything outside it) — it is the landing pad for the next
// target, between the day its type joins the schema and the day its adapter is
// registered.
function noAdapterMessage(type: string): string {
  const known = [...releaseAdapters.keys()];
  return known.length === 0
    ? `no release adapter is registered for release.type "${type}" — this dobby build ships none`
    : `no release adapter for release.type "${type}" — registered targets: ${known.join(", ")}`;
}

// The gate's findings, WHOLE — one `file:line message` line per finding, grouped
// per tool, then the step notes. Deliberately NOT `run.ts`'s `formatCheck`
// (private to the dispatcher, and it CAPS each tool at 50): a sample is right
// for a `check` a human re-runs at will, wrong for the one report explaining why
// a release did not happen. `ship.ts` keeps its own copy for the same reason.
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
    blocks.push(note.raw === null ? note.text : `${note.text}\n${note.raw}`);
  }
  return blocks.length === 0
    ? `the gate failed (exit ${exitCode}) without reporting findings`
    : blocks.join("\n\n");
}
