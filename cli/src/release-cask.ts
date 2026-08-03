import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  ReleaseAdapter,
  ReleaseContext,
  ReleasePhaseResult,
} from "./release.ts";
import { type RunResult, runCapture } from "./runner.ts";

// The HOMEBREW-CASK release TARGET — the adapter behind `release.type:
// "homebrew-cask"`. The SPINE (`release.ts`) owns everything true of EVERY
// release (git state, the version arithmetic, the changelog, the tag, the GitHub
// release); THIS module owns only what is true of a Tauri macOS app shipped
// through a Homebrew tap:
//
//   preflight   — is the CHANNEL usable? (a Tauri project, BOTH universal
//                 toolchain targets, gh auth, a configured tap + cask — plus,
//                 when `release.notaryProfile` is set, the Developer ID
//                 certificate and the keychain profile itself)
//   bumpExtras  — the lockstep file the spine cannot edit: `Cargo.toml`'s
//                 `[package]` version, plus the `cargo check` that reconciles
//                 `Cargo.lock` — inside the bump phase, so it rides in the
//                 `release: v<V>` commit.
//   packGate    — is the ARTIFACT shippable? (build the universal dmg, exactly
//                 ONE of them, and the version BAKED INTO the app bundle is the
//                 version being released — and then, when a notary profile is
//                 configured, Apple's own verdict: submit, staple, and let
//                 Gatekeeper assess the file that is about to be uploaded)
//   publish     — a NO-OP: the dmg is a LOCAL file until the tag exists.
//   postRelease — the release as a user experiences it: the dmg uploaded to the
//                 GitHub release, then the tap's cask moved to the new version +
//                 checksum and pushed.
//   smoke       — REPORT-ONLY: `brew install --cask` downloads a real dmg and
//                 asks for a password, so it is a human step and this phase
//                 hands back the command instead of running it (with the
//                 quarantine caveat only when nothing was notarized).
//
// Each method returns DATA (`{ok, error?, notes?}`) — never throws, never prints
// — so the spine can record it as a phase and decide what to roll back. Every
// child goes through `runner.ts` with its cwd pinned; `bun`, `cargo`, `rustup`,
// `gh`, `git`, `shasum`, `ruby` — and the notarization trio `security`, `xcrun`,
// `spctl` — are spawned BARE (PATH), like the rest of the CLI's system tools, so
// they are the same tools the user's own shell would run (and, structurally, so
// they can be intercepted at all: an absolute `/usr/bin/xcrun` could not be).
//
// node:*-only (ADR-0008) — vitest imports this under Node, Bun runs it in prod.
//
// ---------------------------------------------------------------------------
// THE HOMEBREW HALF OF THE FIELD CATALOG (the npm half lives in
// `release-npm.ts`; both were paid for by releases that went wrong).
//
//  - TWO WAYS TO SHIP, and the config picks one. UNSIGNED is the CONFIG-LESS
//    DEFAULT (no `release.notaryProfile`): every user then clears the Gatekeeper
//    quarantine themselves — recorded VERBATIM from the release skill this target
//    absorbed, because it is the one thing a user hits that no code can fix:
//    "users clear the Gatekeeper quarantine themselves (`xattr -dr
//    com.apple.quarantine`, or System Settings → Privacy & Security → Open
//    Anyway) since Homebrew 6 quarantines casks with no opt-out —
//    `--no-quarantine` is gone; the `xattr` clears it so the unsigned app opens".
//    That caveat travels in the smoke phase's notes, where the human doing the
//    install will read it — CONDITIONALLY, because next to a notarized build it
//    is simply a lie.
//    NOTARIZED is the RECOMMENDED path for a project whose owner has an Apple
//    Developer Program membership: set `release.notaryProfile` and the dmg is
//    submitted to Apple, stapled and assessed by Gatekeeper BEFORE any tag
//    exists, and the install note becomes the one `brew install` line. (This is
//    unrelated to the App Store — an app using private APIs stays barred from it
//    either way; notarization is only what stops Gatekeeper from calling a
//    downloaded dmg damaged.)
//  - THE `[package]` TRAP — `version = ` appears in `Cargo.toml` BOTH under
//    `[package]` (the app's version) and under `[dependencies]` /
//    `[dependencies.<crate>]` (a dependency's, at the start of a line in the
//    latter). A whole-file regex bumps the wrong one, so the edit is SCOPED to
//    the `[package]` section (see `withPackageVersion`).
//  - THE VERSION BAKED INTO THE BUNDLE — a dmg built before the bump carries the
//    OLD `CFBundleShortVersionString`, and nothing downstream would notice: the
//    cask would advertise a version the app does not report. It is asserted in
//    `packGate`, the last phase that can still refuse without burning a tag.
//  - GITHUB SANITIZES ASSET NAMES — a dmg named `Mad Eye_0.5.0_universal.dmg` is
//    SERVED as `Mad.Eye_0.5.0_universal.dmg`; a scaffolded cask url that used the
//    raw filename would 404 (see `assetTemplate`).
//
// ---------------------------------------------------------------------------
// REGISTRATION — the SPINE registers this adapter
// (`registerReleaseAdapter("homebrew-cask", caskAdapter)` in `release.ts`),
// exactly as it does the npm one. This module therefore imports only TYPES from
// `release.ts`, which erase: there is NO runtime cycle, and the target is
// reachable from `run.ts`'s import graph through the spine it is registered by.
// The other direction (self-registering here, spine-side side-effect import)
// creates a real cycle in which this module's body runs FIRST, while the spine's
// registry const is still in its temporal dead zone — `ReferenceError: Cannot
// access 'releaseAdapters' before initialization` at import time.
// ---------------------------------------------------------------------------

// Where a Tauri project keeps its rust half. Every path this target reads hangs
// off it: the manifest that proves the project IS one, the crate whose version
// moves in lockstep, and the directory the build leaves its bundle in.
const TAURI_DIR = "src-tauri";
const TAURI_CONF = "tauri.conf.json";
const CARGO_MANIFEST = "Cargo.toml";

// The fat-binary triple the build is asked for, and the two toolchain targets it
// is built FROM (Apple Silicon + Intel). Both must be installed or the build
// dies halfway through.
const UNIVERSAL_TARGET = "universal-apple-darwin";
const MAC_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"] as const;

// The ONE bundle format this target ships (`--bundles dmg`) — and, because the
// bundler names its output directory after the format, also that directory.
const DMG_BUNDLE = "dmg";

// Where `bun tauri build` leaves its output, relative to the tauri dir.
const BUNDLE_SEGMENTS = ["target", UNIVERSAL_TARGET, "release", "bundle"];
const APP_DIR = "macos";
const DMG_EXT = ".dmg";
const APP_EXT = ".app";

// The bundled version, and the tool that reads it. PlistBuddy lives in
// `/usr/libexec`, which is NOT on a normal PATH — so it is named BARE and
// `/usr/libexec` is APPENDED to the child's PATH instead of being spawned by
// absolute path. Two reasons, one of them structural: an absolute spawn cannot
// be intercepted at all (a test's stub bin lives on PATH), and appending keeps
// the real tool winning in production while never shadowing a PATH-resolvable
// one.
const PLIST_BUDDY = "PlistBuddy";
const PLIST_BUDDY_DIR = "/usr/libexec";
const BUNDLE_VERSION_KEY = "CFBundleShortVersionString";

// The three verdicts notarization is read out of — each the TEXT a tool prints,
// never its exit code (see the NOTARIZATION section: `security find-identity`
// and `xcrun notarytool submit` both exit 0 while saying no, and `spctl` exits 0
// for a signed-but-un-notarized build). Matched CASE-SENSITIVELY: Gatekeeper's
// own refusal reads `source=Unnotarized Developer ID`, which differs from the
// pass by exactly one capital letter.
const DEVELOPER_ID_CERT = "Developer ID Application";
const NOTARY_ACCEPTED = "status: Accepted";
const GATEKEEPER_NOTARIZED = "Notarized Developer ID";

// Homebrew's own naming rule: a tap repository `<user>/homebrew-<name>` is
// REFERRED TO as `<user>/<name>`, which is the form `brew install` takes.
const TAP_PREFIX = "homebrew-";

// Where the cask file lives inside a tap.
const CASKS_DIR = "Casks";

// The `[package]` section header, at a line start (a trailing comment allowed).
const PACKAGE_HEADER = /^\[package\][^\n]*$/m;

// The NEXT section header — where the `[package]` section ENDS. Anything past it
// (`[dependencies]`, `[dependencies.tokio]`, …) is off limits to the bump.
const SECTION_HEADER = /^\[/m;

// `version = "…"` at a line start, capturing everything up to the value so the
// line's own spacing survives the rewrite.
const PACKAGE_VERSION = /^([^\S\n]*version[^\S\n]*=[^\S\n]*)"[^"]*"/m;

// A cask's two moving lines. The leading whitespace is CAPTURED (never assumed):
// the rest of the line is replaced wholesale — the same edit the hand-run `sed`
// made — so a `sha256 :no_check` placeholder is rewritten too.
const CASK_VERSION_LINE = /^([ \t]*)version[ \t].*$/m;
const CASK_SHA256_LINE = /^([ \t]*)sha256[ \t].*$/m;

// What `shasum -a 256` must have answered: 64 hex digits. A drifted output shape
// would otherwise put garbage in the tap, where every `brew install` reads it.
const SHA256 = /^[0-9a-f]{64}$/;

// The field separator in `shasum`'s `<sha>  <file>` line.
const WHITESPACE = /\s+/;

// Every character GitHub replaces with a dot in a release asset's filename.
const ASSET_UNSAFE = /[^A-Za-z0-9._-]/g;

// The FIRST-RELEASE scaffold. Only `version` + `sha256` move on later releases,
// which is why the `url` templates `#{version}` (Homebrew's own interpolation)
// rather than baking the number in: a concrete version there goes stale on the
// next release, which rewrites two lines and nothing else. Everything a machine
// cannot know (desc, zap paths, caveats, minimum macOS) is deliberately absent —
// a scaffold a human finishes beats a guess that ships.
const CASK_TEMPLATE = `# scaffolded by \`dobby release\` — add desc/zap/caveats by hand
cask "__TOKEN__" do
  version "__VERSION__"
  sha256 "__SHA256__"

  url "__URL__"
  name "__NAME__"
  homepage "__HOMEPAGE__"

  app "__APP__"
end
`;

/**
 * The homebrew-cask target — the adapter the release spine drives for a Tauri
 * macOS app shipped through a Homebrew tap.
 *
 * @public — the spine registers it under `release.type: "homebrew-cask"`.
 */
export const caskAdapter: ReleaseAdapter = {
  bumpExtras,
  id: "homebrew-cask",
  packGate,
  postRelease,
  preflight,
  // Nothing leaves the machine before the tag: the dmg `packGate` just built is
  // a local file, and the only place it can be published TO is the GitHub
  // release the spine creates AFTER this. So the irreversible step is empty here
  // and the real work lives in `postRelease` — which is also what keeps the
  // spine's publish-gated-push invariant honest from this side: there is nothing
  // this phase could half-publish and then fail to roll back.
  publish: () => ({
    notes: "nothing to publish before the tag — the dmg is still a local file",
    ok: true,
  }),
  smoke,
};

// ---------------------------------------------------------------------------
// preflight — is the CHANNEL usable at all?
//
// It runs inside the spine's preflight phase, so a refusal costs nothing: no
// version has been decided and no file has been touched. `context.version` is
// NULL here by contract — every check below is about the machine and the config,
// never about the number being released.
// ---------------------------------------------------------------------------

function preflight(context: ReleaseContext): ReleasePhaseResult {
  const conf = join(tauriDir(context), TAURI_CONF);
  if (!existsSync(conf)) {
    return {
      error: `this is not a Tauri app — ${TAURI_DIR}/${TAURI_CONF} does not exist (looked for ${conf}). The homebrew-cask target ships a macOS app bundle a Tauri build produces; check release.dir in dobby.config.json.`,
      ok: false,
    };
  }

  const missing = missingMacTargets(context);
  if (typeof missing === "string") {
    return { error: missing, ok: false };
  }
  if (missing.length > 0) {
    return {
      error: `the universal build needs BOTH mac targets and rustup has no ${missing.join(", ")} — install and re-run: rustup target add ${missing.join(" ")}`,
      ok: false,
    };
  }

  // Everything this target does past the tag goes through gh: the asset upload,
  // and (on a first release) creating the tap repository itself.
  const auth = runCapture("gh", ["auth", "status"], { root: context.dir });
  if (failed(auth)) {
    return {
      error: `gh is not authenticated — \`gh auth status\` failed: ${detailOf(auth)}. Run \`gh auth login\` before releasing.`,
      ok: false,
    };
  }

  const { cask, tap } = context.release;
  if (tap === undefined || tap === "") {
    return {
      error: `release.tap is not configured — the homebrew-cask target needs the tap REPOSITORY it pushes the cask to (e.g. "kvnwolf/homebrew-tap"); add it to dobby.config.json`,
      ok: false,
    };
  }
  if (cask === undefined || cask === "") {
    return {
      error: `release.cask is not configured — the homebrew-cask target needs the cask TOKEN it writes (${CASKS_DIR}/<cask>.rb in the tap, e.g. "mad-eye"); add it to dobby.config.json`,
      ok: false,
    };
  }

  // OPT-IN, by the PRESENCE of the key: a project that configures no notary
  // profile is not asked one Apple question here — the whole block is skipped,
  // not answered leniently. A key that is present but EMPTY is a config error,
  // and this is the phase that names it (see `notaryProfileOf`).
  const profile = notaryProfileOf(context);
  if (profile !== null && typeof profile !== "string") {
    return { error: profile.error, ok: false };
  }
  if (profile !== null) {
    const refused = notaryPreflight(context, profile);
    if (refused !== null) {
      return { error: refused, ok: false };
    }
  }

  const notarization =
    profile === null
      ? ""
      : `; notarized through the ${profile} keychain profile`;
  return {
    notes: `${MAC_TARGETS.join(" + ")} installed; ${cask} ships to ${tap}${notarization}`,
    ok: true,
  };
}

// Which of the two mac targets rustup does NOT have installed — or, as a string,
// why the question could not be answered at all.
function missingMacTargets(context: ReleaseContext): string[] | string {
  const listed = runCapture("rustup", ["target", "list", "--installed"], {
    root: context.dir,
  });
  if (failed(listed)) {
    return `rustup could not list the installed targets — \`rustup target list --installed\` failed: ${detailOf(listed)}. A universal build needs ${MAC_TARGETS.join(" and ")}.`;
  }
  const installed = new Set(
    listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
  );
  return MAC_TARGETS.filter((target) => !installed.has(target));
}

// ---------------------------------------------------------------------------
// bumpExtras — the lockstep file the SPINE cannot edit.
//
// The spine rewrites JSON manifests only, and reports everything else as
// delegated. `src-tauri/Cargo.toml` is that everything else: bumping it needs
// target knowledge (the `[package]` trap above), and `cargo check` afterwards is
// what reconciles `Cargo.lock` — whose stale version would otherwise ride along
// in the release commit and turn CI red on the release itself.
//
// It runs INSIDE the bump phase, before the gate and before the commit, so what
// it writes is judged by the gate and lands in the `release: v<V>` commit.
// ---------------------------------------------------------------------------

function bumpExtras(
  context: ReleaseContext,
  version: string
): ReleasePhaseResult {
  const crate = tauriDir(context);
  const manifest = join(crate, CARGO_MANIFEST);
  let raw: string;
  try {
    raw = readFileSync(manifest, "utf8");
  } catch {
    return {
      error: `could not read ${manifest} — the crate version moves in lockstep with the release`,
      ok: false,
    };
  }

  const rewritten = withPackageVersion(raw, version);
  if (typeof rewritten !== "string") {
    return { error: rewritten.error, ok: false };
  }
  try {
    writeFileSync(manifest, rewritten);
  } catch (error) {
    return {
      error: `could not write ${manifest}: ${messageOf(error)}`,
      ok: false,
    };
  }

  // ANY cargo command reconciles `Cargo.lock`'s entry for the local crate, and a
  // green `check` is a cheap pre-build gate besides — it fails in seconds where
  // `tauri build` would fail in minutes.
  const checked = runCapture("cargo", ["check"], { root: crate });
  if (failed(checked)) {
    return {
      error: `cargo check failed in ${crate} after the version bump — ${detailOf(checked)}`,
      ok: false,
    };
  }
  return {
    notes: `${TAURI_DIR}/${CARGO_MANIFEST} → ${version}, Cargo.lock reconciled by cargo check`,
    ok: true,
  };
}

// The manifest with the `[package]` version rewritten — or why it could not be.
//
// SCOPED, byte-surgically: the section runs from the `[package]` header to the
// NEXT `[section]` header, and only the version VALUE inside that window is
// replaced (the line's own spacing is captured and re-emitted). A `version = `
// under `[dependencies.tokio]` sits at the start of a line exactly like the
// package's own, so a whole-file regex would bump a dependency instead.
function withPackageVersion(
  raw: string,
  version: string
): string | { error: string } {
  const header = PACKAGE_HEADER.exec(raw);
  if (header === null) {
    return {
      error: `${CARGO_MANIFEST} carries no [package] section — there is no crate version to bump`,
    };
  }
  const start = header.index + header[0].length;
  const rest = raw.slice(start);
  const next = SECTION_HEADER.exec(rest);
  const end = next === null ? raw.length : start + next.index;

  const found = PACKAGE_VERSION.exec(raw.slice(start, end));
  if (found === null) {
    return {
      error: `${CARGO_MANIFEST}'s [package] section carries no \`version = "…"\` line`,
    };
  }
  // Everything up to the value (`version = `), re-emitted as it was found.
  const prefix = found[1] ?? "";
  const at = start + found.index;
  return `${raw.slice(0, at)}${prefix}"${version}"${raw.slice(at + found[0].length)}`;
}

// ---------------------------------------------------------------------------
// packGate — is the ARTIFACT shippable?
//
// The last phase that can refuse for free: after it the spine publishes, tags
// and pushes. Two facts are asserted — the same two the hand-run release gated
// on: exactly ONE dmg exists (with a stale second one, "the artifact" is
// whichever the glob happened to answer), and the version BAKED INTO the app
// bundle is the version being released (a bundle built before the bump ships an
// app that reports the old number while the cask advertises the new one).
// ---------------------------------------------------------------------------

function packGate(context: ReleaseContext): ReleasePhaseResult {
  // The long one — minutes, with a `vite build` in front of the rust compile.
  // CAPTURED rather than inherited: `dobby release --json` owns stdout, and a
  // failed build's own words are the only useful thing to report.
  const built = runCapture(
    "bun",
    ["tauri", "build", "--bundles", DMG_BUNDLE, "--target", UNIVERSAL_TARGET],
    { root: context.dir }
  );
  if (failed(built)) {
    return {
      error: `\`bun tauri build --bundles ${DMG_BUNDLE} --target ${UNIVERSAL_TARGET}\` failed in ${context.dir} — ${detailOf(built)}`,
      ok: false,
    };
  }

  const dmg = findDmg(context);
  if (typeof dmg !== "string") {
    return { error: dmg.error, ok: false };
  }

  const bundled = bundledVersion(context);
  if (typeof bundled !== "string") {
    return { error: bundled.error, ok: false };
  }
  const wanted = context.version ?? "";
  if (bundled !== wanted) {
    return {
      error: `the built app reports ${BUNDLE_VERSION_KEY} ${bundled}, but this release is ${wanted} — the bundle predates the version bump; nothing was tagged, so re-run the build`,
      ok: false,
    };
  }

  // LAST, and deliberately so: notarization is an Apple round trip measured in
  // minutes, and a bundle that predates the bump must never cost one. Still
  // BEFORE the tag, though — this is the last phase that can refuse for free.
  const profile = notaryProfileOf(context);
  if (profile !== null && typeof profile !== "string") {
    return { error: profile.error, ok: false };
  }
  if (profile !== null) {
    const refused = notarize(context, dmg, profile);
    if (refused !== null) {
      return { error: refused, ok: false };
    }
  }

  const notarization =
    profile === null
      ? ""
      : `, notarized and stapled through the ${profile} keychain profile`;
  return {
    notes: `${basename(dmg)} carries ${wanted}${notarization}`,
    ok: true,
  };
}

// The ONE dmg the build produced — or why it is not one. Zero and many are
// different failures with different fixes, so they are refused separately.
function findDmg(context: ReleaseContext): string | { error: string } {
  const dir = join(bundleDir(context), DMG_BUNDLE);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return {
      error: `the build produced no dmg — ${dir} does not exist`,
    };
  }
  const dmgs = entries.filter((entry) => entry.endsWith(DMG_EXT)).sort();
  const [only] = dmgs;
  if (only === undefined) {
    return { error: `the build produced no dmg in ${dir}` };
  }
  if (dmgs.length > 1) {
    return {
      error: `${dmgs.length} dmg files in ${dir} (${dmgs.join(", ")}) — exactly one universal dmg must be shippable; delete the stale ones (or the whole target dir) and re-run`,
    };
  }
  return join(dir, only);
}

// The version BAKED INTO the built app bundle, read the way the platform reads
// it — or why it could not be read.
function bundledVersion(context: ReleaseContext): string | { error: string } {
  const app = findApp(context);
  if (typeof app !== "string") {
    return app;
  }
  const plist = join(app, "Contents", "Info.plist");
  const printed = runCapture(
    PLIST_BUDDY,
    ["-c", `Print :${BUNDLE_VERSION_KEY}`, plist],
    { env: plistEnv(), root: context.dir }
  );
  if (failed(printed)) {
    return {
      error: `could not read ${BUNDLE_VERSION_KEY} from ${plist} — ${detailOf(printed)}`,
    };
  }
  return printed.stdout.trim();
}

// The built `.app` bundle — tauri names it `<productName>.app` and leaves it
// beside the dmg. Exactly one must be there; more than one is ambiguous and is
// refused rather than guessed at.
function findApp(context: ReleaseContext): string | { error: string } {
  const dir = join(bundleDir(context), APP_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return {
      error: `the build produced no app bundle — ${dir} does not exist`,
    };
  }
  const apps = entries.filter((entry) => entry.endsWith(APP_EXT)).sort();
  const [only] = apps;
  if (only === undefined) {
    return { error: `no ${APP_EXT} bundle in ${dir}` };
  }
  if (apps.length > 1) {
    return {
      error: `${apps.length} app bundles in ${dir} (${apps.join(", ")}) — cannot tell which one this release ships`,
    };
  }
  return join(dir, only);
}

// PATH with `/usr/libexec` APPENDED, for the PlistBuddy spawn (see PLIST_BUDDY).
// The whole env is passed through: `runCapture`'s `env` REPLACES the child's
// environment, so anything dropped here is dropped from the child.
function plistEnv(): NodeJS.ProcessEnv {
  const current = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: current === "" ? PLIST_BUDDY_DIR : `${current}:${PLIST_BUDDY_DIR}`,
  };
}

// ---------------------------------------------------------------------------
// NOTARIZATION — OPTIONAL, and opted into by the PRESENCE of
// `release.notaryProfile`. Two moments: the PREFLIGHT asks whether this machine
// could notarize at all (a one-time human setup, worth refusing before a
// 20-minute build), and `packGate` does it — submit, staple, assess — after the
// bundled-version gate and before any tag.
//
// THE CREDENTIALS LIVE IN THE KEYCHAIN, NEVER IN THE ENVIRONMENT. `notaryProfile`
// is the NAME of a notarytool keychain profile a human created ONCE (`xcrun
// notarytool store-credentials <profile> --apple-id <id> --team-id <team>`, which
// prompts for the app-specific password and stores it in the login keychain);
// that name is the only credential fact dobby ever holds. There is deliberately
// NO env-var path — no APPLE_ID, no APPLE_PASSWORD, no APPLE_TEAM_ID (mad-eye's
// ADR 0005): an app-specific password in the environment is inherited by every
// child process, lands in shell history and CI logs, and a release is exactly
// where that leak costs the most. Adding "just an env fallback" is the change
// this comment exists to stop.
//
// SIGNING IS NOT DOBBY'S JOB. The Developer ID identity the app is signed WITH is
// `tauri.conf.json`'s `signingIdentity` (tauri hands it to codesign during the
// build). All this module does is refuse EARLY when the certificate is absent,
// and prove AFTERWARDS that the artifact really is notarized.
//
// EVERY VERDICT IS TEXT, NEVER AN EXIT CODE — because that is what the real tools
// do: `security find-identity` exits 0 while listing no Developer ID certificate,
// `notarytool submit --wait` exits 0 on a REJECTED submission, and `spctl` exits
// 0 for a signed-but-un-notarized build. And the text can arrive on either stream
// (`spctl -vv` writes its assessment to stderr, notarytool logs to stdout), so
// both are read — see `outputOf`.
// ---------------------------------------------------------------------------

// The keychain profile this release notarizes through: null when the project
// configured none, the profile name when it did, and a REFUSAL when it configured
// an empty one. The ABSENT key IS the opt-out: every step below is then skipped
// whole — not softened, not warned about — and no Apple tool is spawned.
//
// An empty string is NOT absent. It is a key someone started wiring up and left
// blank, and reading it as "no notarization" would take a config that ASKS to be
// notarized and quietly ship an unsigned dmg — past preflight, past packGate,
// past the tag, with the install note reverting to the quarantine caveat and no
// error anywhere. So it is refused by name, exactly as an empty `release.tap` or
// `release.cask` is refused a few lines up.
function notaryProfileOf(
  context: ReleaseContext
): string | null | { error: string } {
  const profile = context.release.notaryProfile;
  if (profile === undefined) {
    return null;
  }
  if (profile === "") {
    return {
      error: `release.notaryProfile is configured but EMPTY — it must NAME a notarytool keychain profile (e.g. "mad-eye-notary", stored once with \`xcrun notarytool store-credentials\`). Remove the key entirely to release WITHOUT notarization; an empty one is never read as "no".`,
    };
  }
  return profile;
}

// Whether this MACHINE can notarize — null when it can, else the refusal, which
// names the one-time human setup that fixes it (both checks are setup, not state:
// a certificate is installed once and a keychain profile is stored once).
function notaryPreflight(
  context: ReleaseContext,
  profile: string
): string | null {
  const identities = runCapture(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    { root: context.dir }
  );
  const listed = outputOf(identities);
  if (!listed.includes(DEVELOPER_ID_CERT)) {
    // What the tool ANSWERED travels back whole — a keychain listing a
    // development certificate only, or (when it said nothing at all) why the
    // spawn itself came back empty (`saidBy`).
    return `no "${DEVELOPER_ID_CERT}" certificate is installed, so a notarizable build cannot be signed — create one in Xcode → Settings → Accounts → your Apple Developer Program team → Manage Certificates → + → ${DEVELOPER_ID_CERT}, and name it in ${TAURI_CONF}'s signingIdentity (SIGNING is tauri's, never dobby's). \`security find-identity -v -p codesigning\` listed:\n${saidBy(identities)}`;
  }

  // The cheapest call that proves the PROFILE exists and its stored credentials
  // still authenticate — it asks Apple for this account's submission history and
  // says nothing about any artifact.
  const probe = runCapture(
    "xcrun",
    ["notarytool", "history", "--keychain-profile", profile],
    { root: context.dir }
  );
  if (failed(probe)) {
    return `the notarytool keychain profile "${profile}" (release.notaryProfile) is not usable — ${detailOf(probe)}. Store it once, by hand: xcrun notarytool store-credentials ${profile} --apple-id <your-apple-id> --team-id <your-team-id> (it prompts for an app-specific password and keeps it in the keychain — dobby never reads Apple credentials from the environment).`;
  }
  return null;
}

// The dmg, notarized END TO END — submitted, stapled, then assessed by
// Gatekeeper. Returns null when Apple and Gatekeeper both said yes, else the
// refusal. Each step gates the next: a submission Apple rejected is never
// stapled, and a dmg that would not staple is never assessed — a later step's
// answer would only describe the earlier failure.
function notarize(
  context: ReleaseContext,
  dmg: string,
  profile: string
): string | null {
  const submitted = runCapture(
    "xcrun",
    ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait"],
    { root: context.dir }
  );
  // The FULL log, never truncated: notarytool's own words are the only account
  // of why Apple refused (a rejection carries an issues URL and the offending
  // path), and a human cannot re-derive them locally. A submission that failed
  // SILENTLY quotes the exit/spawn detail instead — never an empty log.
  const log = outputOf(submitted);
  if (failed(submitted) || !log.includes(NOTARY_ACCEPTED)) {
    return `the Apple notary service did not accept ${basename(dmg)} — looked for "${NOTARY_ACCEPTED}" and nothing was tagged. notarytool said:\n${saidBy(submitted)}`;
  }

  // The TICKET, written into the dmg itself: without it Gatekeeper has to ask
  // Apple at open time, so a stapled artifact is the one that works offline and
  // survives the notary service being unreachable.
  const stapled = runCapture("xcrun", ["stapler", "staple", dmg], {
    root: context.dir,
  });
  if (failed(stapled)) {
    return `the notarization ticket could not be stapled onto ${basename(dmg)} — nothing was tagged. \`xcrun stapler staple\` said:\n${saidBy(stapled)}`;
  }

  // Gatekeeper's own opinion of the exact file that is about to be uploaded —
  // the only check that judges the ARTIFACT rather than the process, and the one
  // that would have caught a staple that "succeeded" onto the wrong file.
  const assessed = runCapture(
    "spctl",
    ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmg],
    { root: context.dir }
  );
  const assessment = outputOf(assessed);
  if (failed(assessed) || !assessment.includes(GATEKEEPER_NOTARIZED)) {
    return `Gatekeeper does not see ${basename(dmg)} as a "${GATEKEEPER_NOTARIZED}" build — nothing was tagged. \`spctl -a -t open --context context:primary-signature -vv\` said:\n${saidBy(assessed)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// postRelease — the dmg reaches the GitHub release, and the TAP moves.
//
// This is the release as far as a user is concerned: `brew upgrade` sees a new
// version only once the tap's cask carries the new version AND the checksum of
// the artifact that was actually uploaded. It runs AFTER `gh release create`
// (there is nothing to upload to before that), which means it runs PAST the
// spine's publish line: a failure here is REPORTED, never rolled back.
// ---------------------------------------------------------------------------

function postRelease(context: ReleaseContext): ReleasePhaseResult {
  const { cask, tap } = context.release;
  if (tap === undefined || cask === undefined) {
    return {
      error:
        "release.tap and release.cask are both required by the homebrew-cask target",
      ok: false,
    };
  }
  const tag = context.tag ?? "";
  const version = context.version ?? "";

  // The artifact `packGate` accepted, still where the build left it.
  const dmg = findDmg(context);
  if (typeof dmg !== "string") {
    return { error: dmg.error, ok: false };
  }

  const uploaded = runCapture("gh", ["release", "upload", tag, dmg], {
    root: context.dir,
  });
  if (failed(uploaded)) {
    return {
      error: `gh release upload ${tag} failed for ${dmg} — ${detailOf(uploaded)}. The release IS published; attach the dmg by hand and bump the tap.`,
      ok: false,
    };
  }

  // The checksum of the file that was JUST uploaded — computed from the artifact
  // itself, never from a build log, because it is what every `brew install`
  // verifies the download against.
  const sha256 = shaOf(context, dmg);
  if (typeof sha256 !== "string") {
    return { error: sha256.error, ok: false };
  }

  return updateTap({ cask, context, dmg, sha256, tag, tap, version });
}

// The dmg's sha256, as `shasum` answered it.
function shaOf(
  context: ReleaseContext,
  dmg: string
): string | { error: string } {
  const result = runCapture("shasum", ["-a", "256", dmg], {
    root: context.dir,
  });
  if (failed(result)) {
    return { error: `shasum -a 256 failed on ${dmg} — ${detailOf(result)}` };
  }
  const sha = result.stdout.trim().split(WHITESPACE)[0] ?? "";
  if (!SHA256.test(sha)) {
    return {
      error: `shasum -a 256 did not answer a sha256 for ${dmg} — it said: ${result.stdout.trim()}`,
    };
  }
  return sha;
}

// Everything one tap update needs to know.
interface TapUpdate {
  cask: string;
  context: ReleaseContext;
  dmg: string;
  sha256: string;
  tag: string;
  tap: string;
  version: string;
}

// Clone the tap, move (or scaffold) the cask, prove it parses, commit and push.
function updateTap(update: TapUpdate): ReleasePhaseResult {
  const checkout = cloneTap(update);
  if (typeof checkout !== "string") {
    return { error: checkout.error, ok: false };
  }

  const relPath = join(CASKS_DIR, `${update.cask}.rb`);
  const caskPath = join(checkout, relPath);
  const next = nextCask(update, caskPath);
  if (typeof next !== "string") {
    return { error: next.error, ok: false };
  }
  try {
    mkdirSync(join(checkout, CASKS_DIR), { recursive: true });
    writeFileSync(caskPath, next);
  } catch (error) {
    return {
      error: `could not write ${caskPath}: ${messageOf(error)}`,
      ok: false,
    };
  }

  // BEFORE the commit: a cask that does not parse is one `brew` cannot even read
  // an error out of, and the tap is the one place this release cannot take
  // anything back from.
  const ruby = rubyVerdict(caskPath, checkout);
  if (ruby.error !== undefined) {
    return {
      error: `${ruby.error} — ${caskPath} was NOT pushed to ${update.tap}`,
      ok: false,
    };
  }

  const pushed = pushTap(checkout, relPath, `${update.cask} ${update.version}`);
  if (pushed !== null) {
    return { error: `${pushed} (the tap checkout is ${checkout})`, ok: false };
  }

  const skipped = ruby.skipped
    ? "; ruby is not on PATH, so the cask was never syntax-checked"
    : "";
  return {
    notes: `${update.tap} ${relPath} → ${update.version} (sha256 ${update.sha256}); ${basename(update.dmg)} attached to ${update.tag}${skipped}`,
    ok: true,
  };
}

// The tap, cloned into a throwaway directory — CREATING the repository first
// when it does not exist yet (the first release of a project whose tap has never
// been made). The clone is attempted before the create rather than probing with
// `gh repo view`: the answer either way is a clone, and a failed one is the
// cheapest possible probe.
function cloneTap(update: TapUpdate): string | { error: string } {
  const { context, tap } = update;
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "dobby-tap-"));
  } catch (error) {
    return {
      error: `could not make a scratch dir for ${tap}: ${messageOf(error)}`,
    };
  }

  const first = runCapture("gh", ["repo", "clone", tap, dir], {
    root: context.dir,
  });
  if (!failed(first)) {
    return dir;
  }

  const created = runCapture("gh", ["repo", "create", tap, "--public"], {
    root: context.dir,
  });
  if (failed(created)) {
    return {
      error: `the tap ${tap} could not be cloned (${detailOf(first)}) and could not be created either (${detailOf(created)})`,
    };
  }
  const second = runCapture("gh", ["repo", "clone", tap, dir], {
    root: context.dir,
  });
  if (failed(second)) {
    return {
      error: `the tap ${tap} was created but could not be cloned — ${detailOf(second)}`,
    };
  }
  return dir;
}

// The cask file this release should leave behind: the existing one with its two
// moving lines rewritten, or a fresh scaffold when the tap carries none.
function nextCask(
  update: TapUpdate,
  caskPath: string
): string | { error: string } {
  let current: string;
  try {
    current = readFileSync(caskPath, "utf8");
  } catch {
    return scaffoldCask(update);
  }

  const versioned = replaceLine(
    current,
    CASK_VERSION_LINE,
    "version",
    update.version
  );
  if (typeof versioned !== "string") {
    return versioned;
  }
  return replaceLine(versioned, CASK_SHA256_LINE, "sha256", update.sha256);
}

// One `<field> "<value>"` line of a cask, replaced in place — the whole line,
// the way the hand-run `sed` did it, but with the file's OWN indentation kept.
// A cask that carries no such line is refused rather than silently pushed
// unchanged: an unchanged cask is a release nobody can install.
function replaceLine(
  text: string,
  pattern: RegExp,
  field: string,
  value: string
): string | { error: string } {
  if (!pattern.test(text)) {
    return {
      error: `the tap's cask carries no \`${field}\` line — it cannot be bumped in place; fix it by hand`,
    };
  }
  return text.replace(pattern, `$1${field} "${value}"`);
}

// The first-release scaffold, filled from what the project itself states.
function scaffoldCask(update: TapUpdate): string {
  const { cask, context, sha256, tap, version } = update;
  const product = productName(context);
  const name = product === "" ? cask : product;
  const slug = repoSlug(context, tap, cask);
  const asset = assetTemplate(update.dmg, version);
  return CASK_TEMPLATE.replaceAll("__TOKEN__", cask)
    .replaceAll("__VERSION__", version)
    .replaceAll("__SHA256__", sha256)
    .replaceAll(
      "__URL__",
      `https://github.com/${slug}/releases/download/v#{version}/${asset}`
    )
    .replaceAll("__NAME__", name)
    .replaceAll("__HOMEPAGE__", `https://github.com/${slug}`)
    .replaceAll("__APP__", `${name}${APP_EXT}`);
}

// The app's display name — `tauri.conf.json`'s `productName`, which is also the
// `.app` basename tauri writes. Empty when it cannot be read.
function productName(context: ReleaseContext): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(tauriDir(context), TAURI_CONF), "utf8")
    );
  } catch {
    return "";
  }
  const { productName: product } = parsed as { productName?: unknown };
  return typeof product === "string" ? product : "";
}

// The `<owner>/<repo>` the release lives in, for the scaffolded url. Asked of gh
// (which reads the repo's own remote); the fallback — the TAP's owner plus the
// cask token — is what a conventional layout means, and a scaffold is reviewed
// by a human before the first `brew install` either way.
function repoSlug(context: ReleaseContext, tap: string, cask: string): string {
  const viewed = runCapture(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { root: context.dir }
  );
  const slug = viewed.stdout.trim();
  if (!failed(viewed) && slug.includes("/")) {
    return slug;
  }
  return `${tap.split("/")[0] ?? ""}/${cask}`;
}

// The dmg's filename as the cask's `url` must spell it: SANITIZED the way GitHub
// serves it (every character outside `[A-Za-z0-9._-]` becomes a dot — `Mad
// Eye_0.5.0_universal.dmg` is downloaded as `Mad.Eye_0.5.0_universal.dmg`), with
// the version turned back into Homebrew's `#{version}` interpolation so later
// releases only ever move the version and sha256 lines.
function assetTemplate(dmg: string, version: string): string {
  const asset = basename(dmg).replaceAll(ASSET_UNSAFE, ".");
  return version === "" ? asset : asset.replaceAll(version, "#{version}");
}

// Whether ruby accepts the cask — and, separately, whether ruby was there at all
// (`ruby -c` is a parse check, not a `brew audit`; an absent ruby is a note, not
// a failure, since nothing about the release depends on this machine having one).
function rubyVerdict(
  caskPath: string,
  dir: string
): { error?: string; skipped: boolean } {
  const result = runCapture("ruby", ["-c", caskPath], { root: dir });
  if (result.error !== undefined) {
    return { skipped: true };
  }
  if (result.status !== 0) {
    return {
      error: `ruby rejected the cask: ${detailOf(result)}`,
      skipped: false,
    };
  }
  return { skipped: false };
}

// Commit the cask and push the tap — the moment `brew` can see the new version.
// Returns null on success, else what went wrong. `-u origin HEAD` covers the
// first release too, where the tap was created empty and has no upstream yet.
function pushTap(dir: string, relPath: string, message: string): string | null {
  const added = runCapture("git", ["add", relPath], { root: dir });
  if (failed(added)) {
    return `git add ${relPath} failed in the tap — ${detailOf(added)}`;
  }
  const committed = runCapture("git", ["commit", "-m", message], { root: dir });
  if (failed(committed)) {
    return `git commit failed in the tap — ${detailOf(committed)}`;
  }
  const pushed = runCapture("git", ["push", "-u", "origin", "HEAD"], {
    root: dir,
  });
  if (failed(pushed)) {
    return `the tap could not be pushed — ${detailOf(pushed)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// smoke — REPORT-ONLY.
//
// Installing the cask downloads a real dmg, writes to /Applications and asks for
// a password: that is a human's to run, not a release command's. So this phase
// runs NOTHING and hands back the exact command — plus, ONLY when this release
// was not notarized, the quarantine caveat the human will need the moment they
// open the app (see the field catalog above). Next to a notarized build that
// caveat is a lie, and a lie in an install note costs a support round trip.
// ---------------------------------------------------------------------------

function smoke(context: ReleaseContext): ReleasePhaseResult {
  const cask = context.release.cask ?? "";
  const tap = context.release.tap ?? "";
  const install = `verify by hand: \`brew install --cask ${shortTap(tap)}/${cask}\``;

  // Only a REAL profile name earns the notarized note: an absent key never
  // notarized, and an empty one was refused long before this phase could run.
  if (typeof notaryProfileOf(context) === "string") {
    return {
      notes: `${install}, then launch it — the dmg is notarized and the ticket is stapled to it, so Gatekeeper opens it with nothing else to type`,
      ok: true,
    };
  }

  const product = productName(context);
  const app = product === "" ? cask : product;
  return {
    notes: `${install}, then launch it — and because this dmg is unsigned/un-notarized (no release.notaryProfile), Homebrew's quarantine has to be cleared first: \`xattr -dr com.apple.quarantine "/Applications/${app}${APP_EXT}"\` (Homebrew 6 quarantines casks with no opt-out — \`--no-quarantine\` is gone)`,
    ok: true,
  };
}

// A tap as `brew` refers to it: `<user>/homebrew-<name>` is `<user>/<name>`, and
// a repository that carries no `homebrew-` prefix is left exactly as it is.
function shortTap(tap: string): string {
  const [owner, repo] = tap.split("/");
  if (owner === undefined || repo === undefined) {
    return tap;
  }
  return `${owner}/${repo.startsWith(TAP_PREFIX) ? repo.slice(TAP_PREFIX.length) : repo}`;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// The app's own directory — `release.dir` resolved against the workroot, or the
// workroot itself. Every path this target reads hangs off `<dir>/src-tauri`.
function tauriDir(context: ReleaseContext): string {
  return join(context.dir, TAURI_DIR);
}

function bundleDir(context: ReleaseContext): string {
  return join(tauriDir(context), ...BUNDLE_SEGMENTS);
}

// Whether a spawn did not succeed — a nonzero exit OR a process that never
// started (a missing `cargo`/`ruby` comes back as `error`, never a throw).
// (release-npm.ts keeps its own copy; both are private to their target.)
function failed(result: RunResult): boolean {
  return result.error !== undefined || result.status !== 0;
}

// A failed child as one caller-presentable detail: its own output (stderr first
// — where these tools speak — falling back to stdout), else the spawn error /
// exit. The tool's own words are what the human needs, so they travel VERBATIM.
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

// EVERYTHING a child said, BOTH streams, joined in the order a terminal would
// have shown them. `detailOf` picks ONE stream for a short caller-facing detail;
// the notarization tools need the other rule — `spctl -vv` writes its assessment
// to STDERR while `notarytool` logs to STDOUT, and the verdict is read out of
// that text — so a stream-picking read would judge an empty string and refuse
// every notarized build. Empty streams drop out, so nothing is padded with blank
// lines; nothing else is dropped, because a quoted tool log is only useful whole.
function outputOf(result: RunResult): string {
  return [result.stdout, result.stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream !== "")
    .join("\n");
}

// What a tool SAID, for quoting back at a human: everything it printed, or —
// when it printed NOTHING — why (a silent nonzero exit, or a spawn that never
// happened at all, which is how `spctl` looks on a machine that has none: it is
// never probed in the preflight the way `security`/`xcrun` are). A refusal that
// quotes an empty log is a refusal nobody can act on, so the detail travels
// instead. `outputOf` is the verdict-reading rule; this is the quoting one.
function saidBy(result: RunResult): string {
  const said = outputOf(result);
  return said === "" ? detailOf(result) : said;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
