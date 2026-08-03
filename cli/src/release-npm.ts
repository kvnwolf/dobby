import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ReleaseAdapter,
  ReleaseContext,
  ReleasePhaseResult,
} from "./release.ts";
import { type RunResult, runCapture } from "./runner.ts";

// The NPM release TARGET — the adapter behind the release spine's four moments
// (`ReleaseAdapter`, declared in `release.ts`). The SPINE owns everything true of
// EVERY release (the git state, the version arithmetic, the changelog, the tag,
// the GitHub release); THIS module owns only what is true of npm: whether the
// CHANNEL is usable (`preflight` — npm auth), whether the ARTIFACT is shippable
// (`packGate` — the tarball's file list), the irreversible `publish`, and the
// `smoke` that proves the published version is actually servable.
//
// Each method returns DATA (`{ok, error?, notes?}`) — it never throws and never
// prints, so the spine can record it as a phase and decide what to roll back.
// Every child goes through `runner.ts`; `npm` and `bun` are spawned BARE (PATH),
// like `git`/`gh`, with the cwd pinned to the RELEASE DIR (`context.dir` — the
// spine's `release.dir ?? "."` resolved against the workroot). Publishing the
// workroot instead of the release dir ships the wrong tree.
//
// node:*-only (ADR-0008) — vitest imports this under Node, Bun runs it in prod.
//
// ---------------------------------------------------------------------------
// THE FIELD-PROVEN CATALOG. Every rule in this module was paid for by a real
// release that went wrong. They are recorded at the site they govern; the four
// that belong to the SPINE (and are implemented there) are named here so the
// catalog stays whole:
//
//  - PUBLISH-GATED PUSH — nothing leaves the machine until npm has actually
//    published; a pushed tag for a version that never shipped burns that number
//    for good. Implemented in `release.ts` (tag AFTER publish, `git reset --hard
//    HEAD~1` while the bump commit is still the unpushed HEAD).
//  - MAIN CHECKOUT ONLY — a release cut from a linked worktree tags and pushes
//    the goal's branch, not the trunk. Implemented in `release.ts`'s preflight.
//  - NOTES VIA FILE — release notes are model-authored and travel as
//    `--notes-file` (a file OUTSIDE the repo: a release refuses a dirty tree),
//    never as an inline `--notes` string. Implemented in `release.ts`.
//  - THE `catalog:` TRAP — the version bump is a direct, indentation-preserving
//    JSON edit, NEVER `npm version`: `npm version` walks the surrounding
//    workspace and dies with `EUNSUPPORTEDPROTOCOL catalog:` — having ALREADY
//    written the bump — which killed the whole command chain (field-hit on
//    v0.2.0). npm lore, but the edit itself is the spine's (it is true of every
//    target that carries a package.json).
//
// The Homebrew-only items (the `xattr` quarantine dance on a downloaded cask)
// belong to the cask adapter, not here.
// ---------------------------------------------------------------------------

// The tarball's DENY list. A published tarball can never be unpublished, so any
// hit stops the release: tests and fixtures leak the repo's internals to every
// consumer, and a `dist/` in a raw-TS package (ADR-0014) means a stale build got
// swept in. Globs, never substrings — `src/latest.ts` ENDS WITH the bytes
// "test.ts", `src/fixtures/` is not `__fixtures__/`, and a root `distribute.ts`
// is not inside `dist/`; a substring match would refuse all three and no release
// would ever pass this gate.
//
// `dist/**` is rooted at the PACKAGE root (a nested `src/dist/x.js` is NOT
// matched): `dist/` is the build-output convention at the package root, and
// widening it to `**/dist/**` would refuse a legitimate source directory that
// merely happens to be named `dist`.
const DENY_GLOBS = ["**/*.test.ts", "**/__fixtures__/**", "dist/**"] as const;

// The regex metacharacters a glob's literal bytes must be escaped as.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex metacharacters, not an interpolation
const REGEX_SPECIALS = ".+^${}()|[]\\";

const DENY_MATCHERS = DENY_GLOBS.map((glob) => globToRegExp(glob));

// One packed file, in `bun pm pack --dry-run`'s actual listing shape:
// `packed <human size> <path>`, the path RELATIVE to the package root (bun
// prints no `package/` prefix, unlike `npm pack`). Captured from bun 1.3.10.
const PACKED_LINE = /^packed\s+\S+\s+(\S.*)$/;

// The prefix `npm pack` puts on every entry (bun's listing has none) — see
// `normalizePackedPath`.
const NPM_PACK_PREFIX = "package/";

// npm's error code for "this account's 2FA wants a one-time password" — the
// refusal `npm whoami` cannot predict. See GRANULAR_TOKEN_FIX.
const EOTP_CODE = "EOTP";

// The ONE fix for an EOTP, stated wherever an EOTP can surface. Field-proven on
// v0.1.0: an interactive-login token authenticates (`npm whoami` prints the
// user) and then FAILS at publish, because the account's 2FA demands a
// per-publish OTP; a granular access token with write access bypasses it.
const GRANULAR_TOKEN_FIX =
  "the fix is a GRANULAR ACCESS TOKEN with write access in ~/.npmrc (npmjs.com → Access Tokens → Granular) — it bypasses the per-publish one-time password an interactive-login token demands; creating it is the account owner's to do";

// How long the smoke waits for the registry, by default. Propagation can lag
// MINUTES on a first publish (see `smoke`), so the production budget is
// 15 polls × 20s ≈ 5 minutes; tests inject their own through `createNpmAdapter`.
const DEFAULT_SMOKE_ATTEMPTS = 15;
const DEFAULT_SMOKE_DELAY_MS = 20_000;

// The smoke's retry budget — the ONE thing about this adapter that has to be
// injectable: production waits minutes for registry propagation, a test must not.
interface SmokeBudget {
  // How many `npm view` polls the smoke makes IN TOTAL (not "retries after the
  // first"): `attempts: 3` is exactly 3 invocations.
  attempts: number;
  // The wait BETWEEN polls; never paid after the last one.
  delayMs: number;
}

/**
 * Build an npm release adapter with an explicit smoke retry budget. The only
 * reason this factory exists is the smoke's propagation wait: `npmAdapter` (the
 * registered instance) carries the production budget, and a caller that cannot
 * afford minutes — a test — asks for its own.
 *
 * @public — the injectable form of the npm target.
 */
export function createNpmAdapter(
  options: { attempts?: number; delayMs?: number } = {}
): ReleaseAdapter {
  const budget: SmokeBudget = {
    attempts: options.attempts ?? DEFAULT_SMOKE_ATTEMPTS,
    delayMs: options.delayMs ?? DEFAULT_SMOKE_DELAY_MS,
  };
  return {
    id: "npm",
    packGate,
    preflight,
    publish,
    smoke: (context) => smoke(context, budget),
  };
}

/**
 * The npm target, with the production smoke budget — the instance `release.ts`
 * registers under `release.type: "npm"`.
 *
 * @public — the adapter the release spine drives for an npm project.
 */
export const npmAdapter: ReleaseAdapter = createNpmAdapter();

// ---------------------------------------------------------------------------
// preflight — is the CHANNEL usable at all?
//
// It runs inside the spine's preflight phase, where a refusal costs nothing: no
// version decided, no file touched. So this is the cheapest place to discover
// that npm has no idea who we are.
//
// FIELD NOTE (recorded verbatim, because it is the one thing this check does NOT
// prove): "`whoami` passing does NOT guarantee publish rights: an interactive-
// login token fails at publish time with `EOTP` (the account's 2FA demands a
// per-publish one-time password). The working setup is a granular access token
// with write access in `~/.npmrc` (npmjs.com → Access Tokens → Granular;
// bypasses the per-publish OTP — field-proven on v0.1.0). If publish later hits
// `EOTP`, have the user create one and replace the token — theirs to do."
// That is why `publish` carries its own EOTP branch: this preflight can only
// refuse the OBVIOUS failure (no auth at all), never predict the subtle one.
// ---------------------------------------------------------------------------

function preflight(context: ReleaseContext): ReleasePhaseResult {
  const result = runCapture("npm", ["whoami"], { root: context.dir });
  if (failed(result)) {
    return {
      error: `npm does not know who we are — \`npm whoami\` failed: ${detailOf(result)}. Configure npm auth before releasing: ${GRANULAR_TOKEN_FIX}`,
      ok: false,
    };
  }
  return { notes: `npm authenticated as ${result.stdout.trim()}`, ok: true };
}

// ---------------------------------------------------------------------------
// packGate — is the ARTIFACT shippable?
//
// The last chance to refuse before the irreversible step, and the only one that
// reads the tarball rather than trusting the allowlist that built it.
//
// `--dry-run` (nothing is written) + `--ignore-scripts` (a lifecycle script must
// never run as a side effect of INSPECTING a package). The dry run is also why
// this gate leaves no `*.tgz` behind — and the reason that matters: cleaning one
// up must use `find <dir> -maxdepth 1 -name '*.tgz' -delete`, never a bare
// `<dir>/*.tgz` glob, which zsh aborts the WHOLE command on when nothing matches.
//
// Only the DENY half is universal, so only the DENY half lives here: WHICH files
// a given package must CARRY is project knowledge (dobby's own tarball must ship
// `src/index.ts` + the preset assets), and `release.smoke` is where a project
// proves the published artifact actually works.
// ---------------------------------------------------------------------------

function packGate(context: ReleaseContext): ReleasePhaseResult {
  const result = runCapture(
    "bun",
    ["pm", "pack", "--dry-run", "--ignore-scripts"],
    { root: context.dir }
  );
  if (failed(result)) {
    return {
      error: `\`bun pm pack --dry-run\` failed in ${context.dir} — ${detailOf(result)}`,
      ok: false,
    };
  }

  const files = packedFiles(result.stdout);
  if (files.length === 0) {
    // TWO different failures reach this branch and they need different fixes:
    // the allowlist really does ship nothing, OR the packer's listing shape
    // drifted (`PACKED_LINE` is pinned to bun 1.3.10's `packed <size> <path>`;
    // a reworded or colorized line yields zero matches from a perfectly good
    // tarball). This gate cannot tell them apart — so, like every other refusal
    // here, the packer's OWN words travel verbatim and the human does.
    return {
      error: `the tarball is EMPTY — \`bun pm pack --dry-run\` produced no \`packed …\` lines in ${context.dir}. Either the package.json "files" allowlist ships nothing, or the packer's listing shape drifted from the \`packed <size> <path>\` lines this gate parses. The packer said:\n${indented(result.stdout)}`,
      ok: false,
    };
  }

  const denied = files.filter((file) =>
    DENY_MATCHERS.some((pattern) => pattern.test(file))
  );
  if (denied.length > 0) {
    return {
      error: `the tarball carries ${denied.length} file(s) that must never ship: ${denied.join(", ")} — denied by ${DENY_GLOBS.join(", ")}. Fix the package.json "files" allowlist and re-run; a published tarball can never be unpublished.`,
      ok: false,
    };
  }

  return { notes: `${files.length} file(s) in the tarball`, ok: true };
}

// The packed paths, read out of the packer's own listing. Anything that is not a
// `packed …` line (the banner, the tarball name, the totals) is not a file.
function packedFiles(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const path = PACKED_LINE.exec(line.trim())?.[1];
    if (path !== undefined) {
      files.push(normalizePackedPath(path.trim()));
    }
  }
  return files;
}

// A listed path as the DENY globs expect it: relative to the package root, with
// no `./`. The `package/` strip is FAIL-CLOSED tolerance, not a fix for bun:
// bun's listing is already root-relative, but `npm pack` prefixes every entry
// with `package/`, and if the packer ever adopted that shape an unstripped
// `package/dist/index.js` would silently slip past `dist/**`. Refusing a release
// over a package that really does carry a top-level `package/` directory is the
// safe side of that trade.
function normalizePackedPath(path: string): string {
  const relative = path.startsWith("./") ? path.slice(2) : path;
  return relative.startsWith(NPM_PACK_PREFIX)
    ? relative.slice(NPM_PACK_PREFIX.length)
    : relative;
}

// ---------------------------------------------------------------------------
// publish — the irreversible step.
//
// Everything the spine does after it (tag, push, the GitHub release) is gated on
// it, and a version number that ships is burned forever.
//
// TWO field-proven rules, both structural here:
//  1. PLAIN `npm`, NEVER `bun publish` — bun 1.3.x does not read `~/.npmrc`'s
//     `_authToken` for publish and dies with "missing authentication"
//     (field-hit on v0.1.0). This module spawns `bun` for exactly one thing (the
//     pack DRY RUN above) and never for the publish.
//  2. `--access public` — a SCOPED package (`@scope/name`) defaults to
//     restricted and the publish fails without it. (A prerelease would add
//     `--tag next`; the spine has no prerelease flow, so it is not wired.)
// ---------------------------------------------------------------------------

function publish(context: ReleaseContext): ReleasePhaseResult {
  const result = runCapture("npm", ["publish", "--access", "public"], {
    root: context.dir,
  });
  if (failed(result)) {
    const detail = detailOf(result);
    // The EOTP branch the preflight cannot reach: auth was fine, publish rights
    // were not. Answer with the FIX, not just npm's code.
    return {
      error: detail.includes(EOTP_CODE)
        ? `npm publish refused with ${EOTP_CODE} — ${GRANULAR_TOKEN_FIX}. npm said:\n${detail}`
        : `npm publish failed — ${detail}`,
      ok: false,
    };
  }
  return { notes: lastLine(result.stdout) ?? "published", ok: true };
}

// ---------------------------------------------------------------------------
// smoke — does the published thing actually exist?
//
// It runs LAST and gates nothing (the artifact is already public), which is
// precisely why it may RETRY. FIELD NOTE: propagation can lag MINUTES on a first
// publish — the package may 404 even authenticated while npm processes it (it
// shows on the npmjs.com web page first). A 404 right after `npm publish`
// printed `+ pkg@<V>` is NOT a failure; only an exhausted poll budget is.
//
// Two steps, in order: poll `npm view <name> version` until the registry serves
// the version this release published, then — only then — run the project's own
// `release.smoke` argv (an ARGV ARRAY, never a shell string). That second step
// is where a project proves the published ARTIFACT works, which registry
// metadata never does: for dobby that is `bun install -g @kvnwolf/dobby@<V>`
// followed by `dobby --version` — the definitive proof that the raw-TS bin runs
// via its Bun shebang from a consumer install (`bun link` is only for hacking on
// the CLI locally, and plain-NODE execution of the published bin is unsupported
// by design — the fleet is Bun, ADR-0014).
// ---------------------------------------------------------------------------

function smoke(
  context: ReleaseContext,
  budget: SmokeBudget
): ReleasePhaseResult {
  const name = packageName(context.dir);
  if (name === null) {
    return {
      error: `cannot smoke the release — no package name in ${join(context.dir, "package.json")}`,
      ok: false,
    };
  }
  const version = context.version ?? "";

  const served = pollRegistry(context, name, budget);
  if (!served.ok) {
    return {
      error: `the registry never served ${name}@${version} — ${budget.attempts} poll(s) of \`npm view ${name} version\` and the last answer was ${served.last}. If \`npm publish\` printed \`+ ${name}@${version}\`, this is most likely propagation lag; check npmjs.com before assuming the publish failed.`,
      ok: false,
    };
  }

  const command = context.release.smoke ?? [];
  const [program] = command;
  if (program === undefined) {
    return {
      notes: `${name}@${version} is live (${served.polls} poll(s))`,
      ok: true,
    };
  }

  const ran = runCapture(program, command.slice(1), { root: context.dir });
  if (failed(ran)) {
    return {
      error: `the project's own smoke command failed (\`${command.join(" ")}\`) — ${detailOf(ran)}`,
      ok: false,
    };
  }
  return {
    notes: `${name}@${version} is live (${served.polls} poll(s)); \`${command.join(" ")}\` passed`,
    ok: true,
  };
}

// What the registry answered, and how many polls it took. `last` carries the
// final answer (a version, or npm's own refusal) so an exhausted budget can say
// what it DID see — "still 0.4.2" and "still 404" are different problems.
interface RegistryPoll {
  last: string;
  ok: boolean;
  polls: number;
}

function pollRegistry(
  context: ReleaseContext,
  name: string,
  budget: SmokeBudget
): RegistryPoll {
  const wanted = context.version ?? "";
  let last = "nothing";
  for (let poll = 1; poll <= budget.attempts; poll += 1) {
    const result = runCapture("npm", ["view", name, "version"], {
      root: context.dir,
    });
    const served = result.stdout.trim();
    if (!failed(result) && served === wanted) {
      return { last: served, ok: true, polls: poll };
    }
    // A 404 is an ANSWER while a first publish propagates, not an error to
    // report — it just is not the answer we are waiting for.
    last = failed(result) ? detailOf(result) : `"${served}"`;
    if (poll < budget.attempts) {
      sleepSync(budget.delayMs);
    }
  }
  return { last, ok: false, polls: budget.attempts };
}

// The package the registry is asked about: the name in the RELEASE DIR's own
// manifest (the same file the spine bumps), never a guess from the repo name.
function packageName(dir: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const { name } = parsed as { name?: unknown };
  return typeof name === "string" && name !== "" ? name : null;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// Translate a glob to an anchored RegExp. A LEADING `**/` means "zero or more
// directories", so `**/*.test.ts` catches a root-level `index.test.ts` as well as
// a nested one; elsewhere `**` matches across separators, `*` within one segment,
// `?` a single non-separator character. (release.ts and lifecycle.ts each keep
// their own private copy for their own glob dialect; neither is this one's home,
// and this one's zero-segment `**/` is exactly what a DENY list needs.)
function globToRegExp(glob: string): RegExp {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    const atom = globAtom(glob, index);
    source += atom.source;
    index += atom.consumed;
  }
  return new RegExp(`^${source}$`);
}

// ONE glob token as regex source, plus how many characters it consumed.
function globAtom(
  glob: string,
  index: number
): { consumed: number; source: string } {
  const char = glob[index] ?? "";
  if (char === "*") {
    if (glob[index + 1] !== "*") {
      return { consumed: 1, source: "[^/]*" };
    }
    return glob[index + 2] === "/"
      ? { consumed: 3, source: "(?:[^/]*/)*" }
      : { consumed: 2, source: ".*" };
  }
  if (char === "?") {
    return { consumed: 1, source: "[^/]" };
  }
  return {
    consumed: 1,
    source: REGEX_SPECIALS.includes(char) ? `\\${char}` : char,
  };
}

// Whether a spawn did not succeed — a nonzero exit OR a process that never
// started (a missing `npm`/`bun` comes back as `error`, never a throw).
function failed(result: RunResult): boolean {
  return result.error !== undefined || result.status !== 0;
}

// A failed child as one caller-presentable detail: its own output (stderr first
// — where npm speaks — falling back to stdout), else the spawn error / exit.
// npm's own words are what the human needs, so they travel VERBATIM.
// (release.ts keeps its own copy for the same reason; both are private.)
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

// A tool's own output, quoted into an error message: indented so it reads as a
// transcript rather than as this module's prose, and never silently empty — "the
// packer printed nothing at all" is itself the diagnosis in that case.
function indented(output: string): string {
  const body = output.trimEnd();
  if (body.trim() === "") {
    return "  (the packer printed nothing at all)";
  }
  return body
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

// The last non-empty line of a tool's stdout (npm's `+ pkg@version`), or null.
function lastLine(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? null;
}

// A synchronous sleep (no busy-wait): block the thread on an Atomics wait against
// a private buffer nobody notifies — the adapter seam is synchronous (the spine's
// handler is), so this is the same mechanism `lifecycle.ts` and `review.ts` use
// for their own waits. A zero/negative wait returns at once, which is what makes
// an injected `delayMs: 0` instant.
function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
