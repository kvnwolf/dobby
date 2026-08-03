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
import { caskAdapter } from "./release-cask.ts";
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
// THE HOMEBREW-CASK RELEASE TARGET (`release.type: "homebrew-cask"`).
//
// The spine (`release.ts`) owns everything true of EVERY release; this adapter
// owns the six moments true only of a Tauri app shipped through a Homebrew tap:
// is the CHANNEL ready (`preflight`), the non-JSON lockstep edit the spine
// cannot make (`bumpExtras` — Cargo.toml's `[package]` version), is the ARTIFACT
// shippable (`packGate` — one universal dmg whose bundled version IS the release
// version), the pre-tag `publish` (a NO-OP here: the artifact is local), the tap
// update once the GitHub release exists (`postRelease`), and the `smoke` (a
// REPORT: `brew install` is a human step).
//
// The seam is the ADAPTER ITSELF — `caskAdapter`, the object the module registers
// under `homebrew-cask` — driven exactly as the spine drives it: a
// `ReleaseContext` in, a `ReleasePhaseResult` out. Nothing here reaches inside
// the module.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (all INDEPENDENT of the code):
//  - Every fixture document (Cargo.toml, the cask ruby file, Info.plist,
//    tauri.conf.json) is a LITERAL this file writes, and the expected document is
//    the SAME literal with only the values the spec says move — so a phase that
//    rewrites one byte too many fails on the diff.
//  - `0.4.2` → `0.5.0`, `v0.5.0`, `mad-eye 0.5.0`, `rustup target add`,
//    `--bundles dmg --target universal-apple-darwin`,
//    `Print :CFBundleShortVersionString` are the SPEC's own literals.
//  - The sha256 is what the `shasum` boundary ANSWERED (this file chose it), never
//    a checksum recomputed here the way the adapter computes it.
//  - `brew install --cask kvnwolf/tap/mad-eye` is Homebrew's own naming rule: a
//    tap repository `<user>/homebrew-<name>` is referred to as `<user>/<name>`.
//  - The NOTARIZATION literals — `Developer ID Application`, `status: Accepted`,
//    `Notarized Developer ID`, `xcrun notarytool submit … --keychain-profile …
//    --wait`, `xcrun stapler staple`, `spctl -a -t open --context
//    context:primary-signature -vv`, `xcrun notarytool store-credentials …
//    --apple-id … --team-id …`, `xattr -dr com.apple.quarantine` — are all the
//    SPEC's own. Each canned tool output below is a hand-written fixture
//    reproducing what the real tool prints, INCLUDING which stream it prints on
//    and which exit code it pairs with it (both load-bearing, see the constants).
//
// MOCKED AT THE BOUNDARIES ONLY — every external tool is a STUB BIN on PATH
// (`test-helpers`), recording its argv and answering the way the real tool would:
// `rustup`, `bun` (the tauri build MATERIALIZES a bundle, so a packGate verdict
// is always about a tree the build really produced), `cargo`, `gh`, `git` (the
// TAP's git, never this repo's), `shasum`, `ruby`, `PlistBuddy`, and — for the
// optional notarization — `security`, `xcrun`, `spctl`. PATH is pinned to the stub
// dir FIRST, so a real `gh repo create` / `cargo` / `bun tauri build` / Apple
// notary submission can never escape into the developer's machine.
// ===========================================================================

const scratchDirs: string[] = [];

// --- the release under test -------------------------------------------------
// One release of one Tauri app, stated once: 0.4.2 is what the repo carries,
// 0.5.0 is what this release cuts (the spine decided it; the adapter is told).

const CURRENT_VERSION = "0.4.2";
const NEXT_VERSION = "0.5.0";
const TAG = `v${NEXT_VERSION}`;

// The tap repository as a project configures it, and the cask token inside it.
const TAP = "kvnwolf/homebrew-tap";
const CASK = "mad-eye";

// The app bundle's name — `tauri.conf.json`'s `productName`, which is also the
// `.app` basename tauri writes. The SPACE is deliberate: every tool call carries
// this path, and an argv built by string concatenation mangles it.
const PRODUCT = "Mad Eye";

// Where `bun tauri build --bundles dmg --target universal-apple-darwin` leaves
// its output (the spec's own path).
const BUNDLE_REL = "src-tauri/target/universal-apple-darwin/release/bundle";
const DMG_NAME = `${PRODUCT}_${NEXT_VERSION}_universal.dmg`;

// The two toolchain targets a universal binary needs.
const AARCH64 = "aarch64-apple-darwin";
const X86_64 = "x86_64-apple-darwin";

// What the `shasum` boundary ANSWERS for the dmg — chosen here, so the checksum
// that ends up in the cask is traceable to the tool that produced it and to
// nothing this file recomputed.
const DMG_SHA256 =
  "4d1f8a2c9b7e60531fa4c8d29e0b73615c8e2a7d04b9f31685cd2e7a09f4b6d1";

// The checksum the tap's cask carried for the PREVIOUS release.
const STALE_SHA256 =
  "0000000000000000000000000000000000000000000000000000000000000000";

// The stub bins this suite sanctions. Anything the adapter spawns that is NOT
// here fails to resolve — which is the point: the boundary list is the contract.
const STUB_NAMES = [
  "PlistBuddy",
  "bun",
  "cargo",
  "gh",
  "git",
  "ruby",
  "rustup",
  "security",
  "shasum",
  "spctl",
  "xcrun",
] as const;

// --- notarization ------------------------------------------------------------
// OPTIONAL, and optional BY CONFIG PRESENCE: `release.notaryProfile` names a
// notarytool KEYCHAIN PROFILE (`xcrun notarytool store-credentials <p>` put the
// Apple ID + app-specific password there ONCE, by hand). There is deliberately no
// env-var path — no APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID — so the profile
// NAME is the only credential fact this suite ever states.

const NOTARY_PROFILE = "mad-eye-notary";

// The three tools notarization adds. A release with NO notaryProfile must spawn
// none of them — that is the byte-compatibility contract, and this list is how it
// is observed.
const NOTARIZATION_TOOLS = ["security", "spctl", "xcrun"] as const;

// `security find-identity -v -p codesigning`, as the real tool prints it. It
// exits 0 EITHER WAY: the certificate question is answered by the OUTPUT, never
// by the status.
const IDENTITIES_WITH_DEVELOPER_ID = `  1) 8A2B7C1D0E4F5061728394A5B6C7D8E9FA0B1C2D "Apple Development: Kevin Wolf (9ABCDEF123)"
  2) F1E2D3C4B5A697887766554433221100FFEEDDCC "Developer ID Application: Kevin Wolf (TEAMID1234)"
     2 valid identities found
`;

// The NEAR MISS: a machine carrying only a development certificate. The word
// "Developer" is there and `find-identity` still exits 0 — only the
// `Developer ID Application` certificate a notarizable build needs is missing.
const IDENTITIES_DEVELOPMENT_ONLY = `  1) 8A2B7C1D0E4F5061728394A5B6C7D8E9FA0B1C2D "Apple Development: Kevin Wolf (9ABCDEF123)"
     1 valid identities found
`;

const SUBMISSION_ID = "7f1c0d3e-2b4a-4c8d-9e6f-1a2b3c4d5e6f";

// `xcrun notarytool history --keychain-profile <p>` on a profile that exists.
const NOTARY_HISTORY = `Successfully received submission history.
  history
    --------------------------------------------------
    createdDate: 2026-07-29T18:04:11.203Z
    id: ${SUBMISSION_ID}
    status: Accepted
`;

// …and on one that does not: notarytool's own words, on stderr, exit 1.
const NOTARY_UNKNOWN_PROFILE = `Error: No Keychain password item found for profile: ${NOTARY_PROFILE}
`;

// `xcrun notarytool submit <dmg> --keychain-profile <p> --wait`, as the real tool
// prints it. TWO facts this fixture pins deliberately:
//  - the verdict is the `status:` line of STDOUT, and it is the LAST line — every
//    line above it is what "the FULL output, never truncated" means;
//  - the process exits 0 EVEN WHEN the submission was rejected, which is exactly
//    why the spec gates on the text and not on the status.
function notaryOutput(status: "Accepted" | "Invalid"): string {
  const waiting = status === "Accepted" ? "Accepted" : "In Progress";
  return `Conducting pre-submission checks for ${DMG_NAME} and initiating connection to the Apple notary service...
Submission ID received
  id: ${SUBMISSION_ID}
Upload progress: 100.00% (14.2 MB of 14.2 MB)
Successfully uploaded file
  id: ${SUBMISSION_ID}
  path: ${DMG_NAME}
Waiting for processing to complete.
Current status: ${waiting}.......
Processing complete
  id: ${SUBMISSION_ID}
  status: ${status}
`;
}

const STAPLE_OK = `Processing: ${DMG_NAME}
The staple and validate action worked!
`;

const STAPLE_FAILED = `Processing: ${DMG_NAME}
CloudKit query for ${DMG_NAME} failed. Error: 65
The staple and validate action failed! Error 65.
`;

// What `spctl -a -t open --context context:primary-signature -vv <dmg>` assesses.
// The three cases a release can actually meet:
//  - `notarized`   — the pass: a stapled, notarized Developer ID build.
//  - `rejected`    — Gatekeeper says no. Note `Unnotarized Developer ID`, which
//    contains the expected phrase in every respect but its CAPITAL N: a
//    case-insensitive verdict check would read this refusal as a pass.
//  - `unnotarized` — Gatekeeper says ACCEPTED (exit 0) for a signed-but-not-
//    notarized build, so the status code alone can never be the verdict.
const ASSESSMENTS = {
  notarized: {
    exitCode: 0,
    source: "Notarized Developer ID",
    verdict: "accepted",
  },
  rejected: {
    exitCode: 3,
    source: "Unnotarized Developer ID",
    verdict: "rejected",
  },
  unnotarized: { exitCode: 0, source: "Developer ID", verdict: "accepted" },
} as const;

const ASSESSMENT_ORIGIN =
  "origin=Developer ID Application: Kevin Wolf (TEAMID1234)";

// --- the fixture documents --------------------------------------------------

// `src-tauri/Cargo.toml`, with the ONE version that is allowed to move as the
// parameter. Everything else — including the `[dependencies.tokio]` block, whose
// `version = ` sits at the START of a line exactly like `[package]`'s — is fixed
// text, so `cargoToml(NEXT_VERSION)` states the contract precisely: the package
// version moves and NOTHING else does.
function cargoToml(packageVersion: string): string {
  return `[package]
name = "mad-eye"
version = "${packageVersion}"
description = "Watches your screens"
edition = "2021"

[lib]
name = "mad_eye_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.0.0", features = [] }

[dependencies]
serde = { version = "1.0.203", features = ["derive"] }
tauri = { version = "2.1.0", features = [] }

[dependencies.tokio]
version = "1.38.0"
features = ["full"]
`;
}

// The tap's `Casks/mad-eye.rb`, with the TWO values a release moves as
// parameters. The `url` interpolates `#{version}` — Homebrew's own templating —
// so a release only ever has to rewrite these two lines.
function caskText(version: string, sha256: string): string {
  return `cask "${CASK}" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/kvnwolf/mad-eye/releases/download/v#{version}/Mad.Eye_#{version}_universal.dmg"
  name "${PRODUCT}"
  desc "Watches your screens"
  homepage "https://github.com/kvnwolf/mad-eye"

  app "${PRODUCT}.app"
end
`;
}

// The bundled `Info.plist`. `CFBundleName` deliberately comes FIRST, so reading
// "the first <string>" answers the app's NAME, not its version.
function plistText(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${PRODUCT}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
</dict>
</plist>
`;
}

// `src-tauri/tauri.conf.json` — TAB-indented, as tauri writes it.
const TAURI_CONF = `{
\t"productName": "${PRODUCT}",
\t"version": "${CURRENT_VERSION}",
\t"identifier": "com.kvnwolf.mad-eye"
}
`;

// --- the fixture ------------------------------------------------------------

// What a build (or a previous one) left on disk under the bundle directory.
interface BundleSpec {
  dmgs: string[];
  plistVersion: string;
}

interface CaskFixtureOptions {
  // What `bun tauri build` PRODUCES; null = a build that yields no bundle.
  build?: BundleSpec | null;
  // What is ALREADY on disk under the bundle dir (postRelease works from the
  // artifact packGate accepted); null = nothing built yet.
  bundle?: BundleSpec | null;
  cargoFails?: boolean;
  // `release.cask`; null = the key is absent.
  cask?: string | null;
  // The cask file the tap ALREADY carries; null = a tap without one.
  caskInTap?: string | null;
  ghAuthFails?: boolean;
  // What `security find-identity -v -p codesigning` lists.
  identities?: string;
  // Whether `xcrun notarytool history --keychain-profile <p>` finds the profile.
  notaryHistory?: "ok" | "unknown-profile";
  // `release.notaryProfile`. ABSENT (the default) is today's un-notarized flow —
  // the key's PRESENCE is the whole opt-in.
  notaryProfile?: string;
  // What `xcrun notarytool submit … --wait` reports on stdout.
  notaryStatus?: "accepted" | "invalid";
  ruby?: "absent" | "ok" | "rejects";
  // What Gatekeeper assesses the stapled dmg as.
  spctl?: keyof typeof ASSESSMENTS;
  // Whether `xcrun stapler staple <dmg>` succeeds.
  stapler?: "fails" | "ok";
  // `release.tap`; null = the key is absent.
  tap?: string | null;
  // Whether the tap repository exists on GitHub yet.
  tapExists?: boolean;
  targets?: string[];
  tauriConf?: boolean;
}

interface CaskFixture {
  // Where the stub bins and their logs live.
  binDir: string;
  context: ReleaseContext;
  // PATH for the code under test: the stubs FIRST, so no real tool can run.
  path: string;
  root: string;
  // Where the stub `git` copies the tap's cask AT COMMIT TIME — the independent
  // witness for "what did we actually publish to the tap?".
  tapCapture: string;
}

function makeCaskFixture(options: CaskFixtureOptions = {}): CaskFixture {
  const files: Record<string, string> = {
    "src-tauri/Cargo.toml": cargoToml(CURRENT_VERSION),
  };
  if (options.tauriConf !== false) {
    files["src-tauri/tauri.conf.json"] = TAURI_CONF;
  }
  const root = makeScratchRepo({
    branch: "main",
    config: {
      files: [],
      release: { cask: CASK, tap: TAP, type: "homebrew-cask" },
    },
    files,
    pkg: { name: "mad-eye", private: true, version: CURRENT_VERSION },
    prefix: "dobby-cask-",
    track: scratchDirs,
  });

  const binDir = mkStubBinDir(scratchDirs);
  const tapCapture = mkTempDir("dobby-cask-tap-");
  const tapSeed = mkTempDir("dobby-cask-seed-");
  if (typeof options.caskInTap === "string") {
    writeFile(join(tapSeed, "Casks", `${CASK}.rb`), options.caskInTap);
  }

  const build = options.build === undefined ? defaultBundle() : options.build;
  if (build !== null) {
    writeBundle(join(binDir, "staged-bundle"), build);
  }
  if (options.bundle !== undefined && options.bundle !== null) {
    writeBundle(join(root, BUNDLE_REL), options.bundle);
  }

  const tapMarker = join(binDir, "tap-exists");
  if (options.tapExists !== false) {
    writeFile(tapMarker, "");
  }

  writeStubs({
    binDir,
    build,
    cargoFails: options.cargoFails === true,
    ghAuthFails: options.ghAuthFails === true,
    identities: options.identities ?? IDENTITIES_WITH_DEVELOPER_ID,
    notaryHistory: options.notaryHistory ?? "ok",
    notaryStatus: options.notaryStatus ?? "accepted",
    root,
    ruby: options.ruby ?? "ok",
    spctl: options.spctl ?? "notarized",
    stapler: options.stapler ?? "ok",
    tapCapture,
    tapMarker,
    tapSeed,
    targets: options.targets ?? [AARCH64, X86_64, "wasm32-unknown-unknown"],
  });

  const release: ReleaseContext["release"] = { type: "homebrew-cask" };
  if (options.tap !== null) {
    release.tap = options.tap ?? TAP;
  }
  if (options.cask !== null) {
    release.cask = options.cask ?? CASK;
  }
  if (options.notaryProfile !== undefined) {
    release.notaryProfile = options.notaryProfile;
  }

  return {
    binDir,
    context: {
      currentVersion: CURRENT_VERSION,
      dir: root,
      notesFile: null,
      release,
      root,
      tag: TAG,
      version: NEXT_VERSION,
    },
    // `/usr/bin:/bin` stays REACHABLE for ordinary utilities, but the stub dir is
    // FIRST — every tool the adapter names resolves to a stub. The one exception
    // is the `ruby: "absent"` fixture, which pins PATH to the stub dir alone.
    path: options.ruby === "absent" ? binDir : `${binDir}:/usr/bin:/bin`,
    root,
    tapCapture,
  };
}

function defaultBundle(): BundleSpec {
  return { dmgs: [DMG_NAME], plistVersion: NEXT_VERSION };
}

// The layout `bun tauri build` produces, written ONCE here and used both to seed
// a build's output and to stand in for a previous build's.
function writeBundle(bundleDir: string, spec: BundleSpec): void {
  for (const name of spec.dmgs) {
    writeFile(join(bundleDir, "dmg", name), "not a real disk image\n");
  }
  writeFile(
    join(bundleDir, "macos", `${PRODUCT}.app`, "Contents", "Info.plist"),
    plistText(spec.plistVersion)
  );
}

// --- the stub bins ----------------------------------------------------------
// Each stub RECORDS its argv (via the same append-only log format
// `mkRecorderBin` writes, so `readStubLog` reads it back) and then behaves the
// way the real tool would. Line 2 of every stub pins the stub's OWN PATH, so its
// shell utilities keep resolving even while the code under test runs with PATH
// narrowed to the stub dir.

interface StubSpec {
  binDir: string;
  build: BundleSpec | null;
  cargoFails: boolean;
  ghAuthFails: boolean;
  identities: string;
  notaryHistory: "ok" | "unknown-profile";
  notaryStatus: "accepted" | "invalid";
  root: string;
  ruby: "absent" | "ok" | "rejects";
  spctl: keyof typeof ASSESSMENTS;
  stapler: "fails" | "ok";
  tapCapture: string;
  tapMarker: string;
  tapSeed: string;
  targets: string[];
}

function writeStubs(spec: StubSpec): void {
  const { binDir } = spec;

  stub(binDir, "rustup", [
    ...recorder(binDir, "rustup"),
    `case "$*" in *'target list'*) printf '%s\\n' ${spec.targets.map(sq).join(" ")} ;; esac`,
    "exit 0",
    "",
  ]);

  stub(binDir, "gh", [
    ...recorder(binDir, "gh"),
    'case "$*" in',
    `  *'auth status'*) ${spec.ghAuthFails ? `printf '%s\\n' 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.' >&2; exit 1` : `printf '%s\\n' 'Logged in to github.com'; exit 0`} ;;`,
    // Creating the tap is what makes the NEXT clone succeed.
    `  *'repo create'*) : > ${sq(spec.tapMarker)}; exit 0 ;;`,
    "  *'repo clone'*)",
    `    if [ -f ${sq(spec.tapMarker)} ]; then`,
    // Both clone forms: an explicit destination, or the default `<cwd>/<repo>`.
    '      dest="$4"',
    '      [ -n "$dest" ] || dest="$(pwd)/$(basename "$3")"',
    '      mkdir -p "$dest"',
    `      cp -R ${sq(`${spec.tapSeed}/.`)} "$dest/"`,
    "      exit 0",
    "    fi",
    `    printf '%s\\n' 'GraphQL: Could not resolve to a Repository with the name ${TAP}.' >&2`,
    "    exit 1",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ]);

  // The TAP's git. It captures the cask AT COMMIT TIME — the bytes that leave
  // for the tap — from wherever the commit was run (`-C <dir>` or a pinned cwd).
  stub(binDir, "git", [
    ...recorder(binDir, "git"),
    'dir="$(pwd)"',
    '[ "$1" = "-C" ] && dir="$2"',
    'case "$*" in',
    `  *commit*) mkdir -p ${sq(spec.tapCapture)}; cp "$dir"/Casks/*.rb ${sq(spec.tapCapture)}/ 2>/dev/null ;;`,
    "esac",
    "exit 0",
    "",
  ]);

  stub(binDir, "shasum", [
    ...recorder(binDir, "shasum"),
    'for arg in "$@"; do file="$arg"; done',
    `printf '%s  %s\\n' ${sq(DMG_SHA256)} "$file"`,
    "exit 0",
    "",
  ]);

  stub(binDir, "cargo", [
    ...recorder(binDir, "cargo"),
    `printf '%s\\n' "$(pwd)" >> ${sq(join(binDir, "cargo.cwd"))}`,
    spec.cargoFails
      ? `printf '%s\\n' 'error: failed to select a version for the requirement' >&2; exit 101`
      : `printf '%s\\n' '    Finished dev [unoptimized] target(s)' >&2; exit 0`,
    "",
  ]);

  stub(binDir, "bun", [
    ...recorder(binDir, "bun"),
    'case "$*" in',
    "  *'tauri build'*)",
    `    rm -rf ${sq(join(spec.root, BUNDLE_REL))}`,
    `    mkdir -p ${sq(dirname(join(spec.root, BUNDLE_REL)))}`,
    ...(spec.build === null
      ? []
      : [
          `    cp -R ${sq(join(spec.binDir, "staged-bundle"))} ${sq(join(spec.root, BUNDLE_REL))}`,
        ]),
    "    ;;",
    "esac",
    "exit 0",
    "",
  ]);

  // PlistBuddy answers `Print :CFBundleShortVersionString` by READING the plist
  // it was handed — the same file the real tool would read — so the expected
  // value stays the one this file wrote into the bundle.
  stub(binDir, "PlistBuddy", [
    ...recorder(binDir, "PlistBuddy"),
    'for arg in "$@"; do plist="$arg"; done',
    `[ -f "$plist" ] || { printf '%s\\n' "File Doesn't Exist: $plist" >&2; exit 1; }`,
    `awk '/<key>CFBundleShortVersionString<\\/key>/ { getline; sub(/^[[:space:]]*<string>/, ""); sub(/<\\/string>[[:space:]]*$/, ""); print; exit }' "$plist"`,
    "exit 0",
    "",
  ]);

  // The codesigning keychain. It exits 0 whatever it lists — the certificate is
  // a fact about the OUTPUT.
  stub(binDir, "security", [
    ...recorder(binDir, "security"),
    `printf '%s' ${sq(spec.identities)}`,
    "exit 0",
    "",
  ]);

  // Apple's notarization front door: the credential probe (`notarytool history`),
  // the submission (`notarytool submit --wait`) and the ticket (`stapler staple`).
  stub(binDir, "xcrun", [
    ...recorder(binDir, "xcrun"),
    ...dmgArgGuard(),
    'case "$*" in',
    `  *'notarytool history'*) ${
      spec.notaryHistory === "ok"
        ? `printf '%s' ${sq(NOTARY_HISTORY)}; exit 0`
        : `printf '%s' ${sq(NOTARY_UNKNOWN_PROFILE)} >&2; exit 1`
    } ;;`,
    // Exit 0 EITHER WAY — the real tool's behavior, and the reason the verdict is
    // the `status:` line rather than the status code.
    `  *'notarytool submit'*) printf '%s' ${sq(notaryOutput(spec.notaryStatus === "accepted" ? "Accepted" : "Invalid"))}; exit 0 ;;`,
    `  *'stapler staple'*) ${
      spec.stapler === "ok"
        ? `printf '%s' ${sq(STAPLE_OK)}; exit 0`
        : `printf '%s' ${sq(STAPLE_FAILED)} >&2; exit 65`
    } ;;`,
    "esac",
    "exit 0",
    "",
  ]);

  // Gatekeeper. `spctl -vv` writes its assessment to STDERR (this is what the
  // real tool does), so a gate reading stdout alone sees an EMPTY verdict.
  stub(binDir, "spctl", [
    ...recorder(binDir, "spctl"),
    ...dmgArgGuard(),
    'for arg in "$@"; do file="$arg"; done',
    `printf '%s: %s\\n' "$file" ${sq(ASSESSMENTS[spec.spctl].verdict)} >&2`,
    `printf '%s\\n' ${sq(`source=${ASSESSMENTS[spec.spctl].source}`)} ${sq(ASSESSMENT_ORIGIN)} >&2`,
    `exit ${ASSESSMENTS[spec.spctl].exitCode}`,
    "",
  ]);

  if (spec.ruby !== "absent") {
    stub(binDir, "ruby", [
      ...recorder(binDir, "ruby"),
      spec.ruby === "rejects"
        ? `printf '%s\\n' 'Casks/${CASK}.rb:2: syntax error, unexpected string literal' >&2; exit 1`
        : `printf '%s\\n' 'Syntax OK'; exit 0`,
      "",
    ]);
  }
}

// The guard every stub handed the ARTIFACT shares: whichever argument is the
// `.dmg`, it has to RESOLVE from the child's own working directory. The real
// tools open that file, so a path that is relative to the wrong directory fails
// here exactly as it would at a real Apple submission — which is what lets the
// argv assertions pin the SHAPE of a command without pinning a path form.
function dmgArgGuard(): string[] {
  return [
    'dmg=""',
    'for arg in "$@"; do case "$arg" in *.dmg) dmg="$arg" ;; esac; done',
    `if [ -n "$dmg" ] && [ ! -f "$dmg" ]; then printf '%s\\n' "Error: the file could not be opened: $dmg" >&2; exit 1; fi`,
  ];
}

// The recorder preamble every stub shares: the argv log `readStubLog` parses,
// plus the stub's own PATH.
function recorder(binDir: string, name: string): string[] {
  return [
    "#!/bin/sh",
    "PATH=/usr/bin:/bin; export PATH",
    `{ printf '%s\\n' "$#"; [ "$#" -eq 0 ] || printf '%s\\0' "$@"; } >> ${sq(stubLogPath(binDir, name))}`,
  ];
}

// One stub bin, written from its script LINES.
function stub(binDir: string, name: string, lines: string[]): void {
  mkStubBin(binDir, name, lines.join("\n"));
}

function sq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// --- driving the adapter ----------------------------------------------------

// Run one adapter phase with the stub bins on PATH. Every external tool the
// adapter names resolves inside `fixture.binDir`, so nothing real ever runs.
function withStubs<T>(fixture: CaskFixture, fn: () => T): T {
  const original = process.env.PATH;
  process.env.PATH = fixture.path;
  try {
    return fn();
  } finally {
    restoreEnv("PATH", original);
  }
}

// The context as the spine hands it to `preflight`: BEFORE the version is
// decided, so an adapter that quietly depended on it would break in production.
function preflightContext(fixture: CaskFixture): ReleaseContext {
  return { ...fixture.context, tag: null, version: null };
}

// The two ADDITIVE hooks, narrowed. They are optional on the interface (existing
// adapters are unaffected); the cask adapter must define both.
function bumpExtras(
  context: ReleaseContext,
  version: string
): ReleasePhaseResult {
  const hook = caskAdapter.bumpExtras;
  if (hook === undefined) {
    throw new Error("the homebrew-cask adapter must define bumpExtras");
  }
  return hook(context, version);
}

function postRelease(context: ReleaseContext): ReleasePhaseResult {
  const hook = caskAdapter.postRelease;
  if (hook === undefined) {
    throw new Error("the homebrew-cask adapter must define postRelease");
  }
  return hook(context);
}

// --- reading the boundaries back --------------------------------------------

// A phase's REFUSAL, as text — so a test that expected a refusal and got an
// acceptance says so instead of matching against an empty string.
function refusal(result: ReleasePhaseResult): string {
  if (result.ok) {
    return "<the phase ACCEPTED — no refusal was made>";
  }
  return result.error ?? "<refused without naming a reason>";
}

// A phase's verdict, with the reason attached — so a failing acceptance test
// shows WHY the adapter refused.
function verdict(result: ReleasePhaseResult): { error?: string; ok: boolean } {
  return { error: result.error, ok: result.ok };
}

function calls(fixture: CaskFixture, name: string): string[][] {
  return readStubLog(fixture.binDir, name);
}

// Which sanctioned tools ran at all.
function toolsInvoked(fixture: CaskFixture): string[] {
  return STUB_NAMES.filter((name) => calls(fixture, name).length > 0);
}

// Which of the NOTARIZATION tools ran — the observation behind "a release that
// configures no notaryProfile spawns none of them".
function notarizationToolsInvoked(fixture: CaskFixture): string[] {
  return NOTARIZATION_TOOLS.filter((name) => calls(fixture, name).length > 0);
}

// The one `xcrun` invocation carrying `verb` (`history` / `submit` / `staple`),
// or undefined when the adapter never made it.
function xcrunCall(fixture: CaskFixture, verb: string): string[] | undefined {
  return calls(fixture, "xcrun").find((argv) => argv.includes(verb));
}

// The artifact argument, matched by NAME: the built dmg is the only one there is
// (packGate's own exactly-one-dmg guard), and the stubs additionally refuse a
// path that does not open — so the vector assertions pin the command's shape
// while leaving the path form to the adapter.
const THE_BUILT_DMG = expect.stringContaining(DMG_NAME);

// The cask file as it stood when the tap was committed.
function committedCask(fixture: CaskFixture): string {
  return readFileSync(join(fixture.tapCapture, `${CASK}.rb`), "utf8");
}

// One `field "value"` line of a cask, read back from the ruby text.
function caskField(text: string, field: string): string {
  const match = new RegExp(`^\\s*${field} "([^"]*)"`, "m").exec(text);
  return match?.[1] ?? "";
}

function caskLine(text: string, field: string): string {
  return (
    text.split("\n").find((line) => line.trim().startsWith(`${field} `)) ?? ""
  );
}

function cwdsOf(fixture: CaskFixture, logName: string): string[] {
  try {
    return readFileSync(join(fixture.binDir, logName), "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

// --- small file helpers -----------------------------------------------------

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function mkTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

// The CLI spawns git itself, inheriting this process's env — so the pinned git
// identity has to live on the parent (a developer's gpg signing would otherwise
// break the spine's own release commit).
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
// Slice 1 (tracer bullet) — PREFLIGHT: is the CHANNEL usable at all?
//
// It runs inside the spine's preflight phase, so a refusal costs nothing: no
// version has been decided and no file has been touched. Every refusal NAMES the
// fact that stopped it, because the human reading it is the one who has to fix
// it.
// ===========================================================================

describe("homebrew-cask preflight", () => {
  it("accepts a tauri project with both apple targets, gh auth and a configured tap", () => {
    const fixture = makeCaskFixture();

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect(verdict(result)).toEqual({ ok: true });
  });

  it("refuses a project with no src-tauri/tauri.conf.json, naming the file", () => {
    const fixture = makeCaskFixture({ tauriConf: false });

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect(refusal(result)).toContain("tauri.conf.json");
  });

  it("refuses when a mac target is missing, with the rustup target add hint", () => {
    const fixture = makeCaskFixture({ targets: [X86_64] });

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect(refusal(result)).toContain(`rustup target add ${AARCH64}`);
  });

  it("refuses when gh is not authenticated", () => {
    const fixture = makeCaskFixture({ ghAuthFails: true });

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect(refusal(result).toLowerCase()).toContain("auth");
  });

  it("refuses when the release config declares no tap", () => {
    const fixture = makeCaskFixture({ tap: null });

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect(refusal(result)).toContain("tap");
  });

  it("refuses when the release config declares no cask", () => {
    const fixture = makeCaskFixture({ cask: null });

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect(refusal(result)).toContain("cask");
  });
});

// ===========================================================================
// Slice 2 — BUMPEXTRAS: the lockstep file the spine cannot edit.
//
// The spine rewrites JSON manifests only. `src-tauri/Cargo.toml` needs target
// knowledge: `version = ` appears BOTH under `[package]` (the app's version) and
// under a `[dependencies.<crate>]` block (a dependency's), so the edit is scoped
// to the `[package]` section — and `cargo check` afterwards is what reconciles
// Cargo.lock, whose stale version would otherwise ride along in the release
// commit.
// ===========================================================================

describe("homebrew-cask bumpExtras", () => {
  it("moves the [package] version and leaves every dependency version alone", () => {
    const fixture = makeCaskFixture();

    withStubs(fixture, () => bumpExtras(fixture.context, NEXT_VERSION));

    expect(
      readFileSync(join(fixture.root, "src-tauri/Cargo.toml"), "utf8")
    ).toBe(cargoToml(NEXT_VERSION));
  });

  it("reconciles Cargo.lock by running cargo check over the src-tauri crate", () => {
    const fixture = makeCaskFixture();

    withStubs(fixture, () => bumpExtras(fixture.context, NEXT_VERSION));

    const argv = calls(fixture, "cargo")[0] ?? [];
    const crateDir = join(fixture.root, "src-tauri");
    expect({
      crate:
        cwdsOf(fixture, "cargo.cwd").includes(crateDir) ||
        argv.some((arg) => arg.includes(join(crateDir, "Cargo.toml"))),
      subcommand: argv[0],
    }).toEqual({ crate: true, subcommand: "check" });
  });

  it("fails the bump when cargo cannot check the crate", () => {
    const fixture = makeCaskFixture({ cargoFails: true });

    const result = withStubs(fixture, () =>
      bumpExtras(fixture.context, NEXT_VERSION)
    );

    expect(refusal(result)).toContain("cargo");
  });
});

// ===========================================================================
// Slice 3 — PACKGATE: is the ARTIFACT shippable?
//
// The last chance to refuse before anything irreversible: exactly ONE universal
// dmg has to exist, and the version BAKED INTO the app bundle has to be the
// version being released — a mismatch means the build predates the bump, and it
// must be caught before a tag exists.
// ===========================================================================

describe("homebrew-cask packGate", () => {
  it("builds a universal dmg through tauri", () => {
    const fixture = makeCaskFixture();

    withStubs(fixture, () => caskAdapter.packGate(fixture.context));

    expect(calls(fixture, "bun")[0]).toEqual([
      "tauri",
      "build",
      "--bundles",
      "dmg",
      "--target",
      "universal-apple-darwin",
    ]);
  });

  it("accepts the one dmg the build produced when its bundled version is the release version", () => {
    const fixture = makeCaskFixture();

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect(verdict(result)).toEqual({ ok: true });
  });

  it("refuses when the build produced no dmg", () => {
    const fixture = makeCaskFixture({ build: null });

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect(refusal(result)).toContain("dmg");
  });

  it("refuses when the build produced more than one dmg", () => {
    const fixture = makeCaskFixture({
      build: {
        dmgs: [DMG_NAME, `${PRODUCT}_${NEXT_VERSION}_aarch64.dmg`],
        plistVersion: NEXT_VERSION,
      },
    });

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect(refusal(result)).toContain("dmg");
  });

  it("refuses when the bundled app carries a different version than the release", () => {
    const fixture = makeCaskFixture({
      build: { dmgs: [DMG_NAME], plistVersion: "0.4.9" },
    });

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect(refusal(result)).toContain("0.4.9");
  });
});

// ===========================================================================
// Slice 4 — PUBLISH: the cask target has nothing to do before the tag.
//
// The artifact is a LOCAL file until the GitHub release exists, so the
// irreversible step is a no-op here and everything real happens in
// `postRelease`. A publish that touched anything would break the spine's
// publish-gated-push invariant from the other side.
// ===========================================================================

describe("homebrew-cask publish", () => {
  it("does nothing before the tag: the artifact is still local", () => {
    const fixture = makeCaskFixture({ bundle: defaultBundle() });

    const result = withStubs(fixture, () =>
      caskAdapter.publish(fixture.context)
    );

    expect({ ok: result.ok, ran: toolsInvoked(fixture) }).toEqual({
      ok: true,
      ran: [],
    });
  });
});

// ===========================================================================
// Slice 5 — POSTRELEASE: the dmg reaches the GitHub release and the TAP moves.
//
// This is the release, as far as a user is concerned: `brew upgrade` sees a new
// version only once the tap's cask carries the new version AND the checksum of
// the artifact that was actually uploaded.
// ===========================================================================

describe("homebrew-cask postRelease", () => {
  it("uploads the built dmg to the GitHub release", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: caskText(CURRENT_VERSION, STALE_SHA256),
    });

    withStubs(fixture, () => postRelease(fixture.context));

    const upload = calls(fixture, "gh").find(
      (argv) => argv[0] === "release" && argv[1] === "upload"
    );
    expect({
      dmg: (upload ?? []).some((arg) => arg.endsWith(DMG_NAME)),
      tag: (upload ?? [])[2],
    }).toEqual({ dmg: true, tag: TAG });
  });

  it("moves the cask's version and sha256 lines and nothing else", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: caskText(CURRENT_VERSION, STALE_SHA256),
    });

    withStubs(fixture, () => postRelease(fixture.context));

    expect(committedCask(fixture)).toBe(caskText(NEXT_VERSION, DMG_SHA256));
  });

  it("scaffolds the cask from the template when the tap carries none", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: null,
    });

    withStubs(fixture, () => postRelease(fixture.context));

    const scaffolded = committedCask(fixture);
    expect({
      sha256: caskField(scaffolded, "sha256"),
      token: /^cask "([^"]+)" do/m.exec(scaffolded)?.[1],
      version: caskField(scaffolded, "version"),
    }).toEqual({ sha256: DMG_SHA256, token: CASK, version: NEXT_VERSION });
  });

  it("templates the version into the scaffolded url, so later releases only move two lines", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: null,
    });

    withStubs(fixture, () => postRelease(fixture.context));

    // A url carrying the CONCRETE version would go stale on the next release,
    // which rewrites only the version and sha256 lines.
    expect(caskLine(committedCask(fixture), "url")).toContain("#{version}");
  });

  it("creates the tap repository when it does not exist yet", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: null,
      tapExists: false,
    });

    const result = withStubs(fixture, () => postRelease(fixture.context));

    expect({
      created: calls(fixture, "gh").some(
        (argv) => argv[0] === "repo" && argv[1] === "create" && argv[2] === TAP
      ),
      ok: result.ok,
    }).toEqual({ created: true, ok: true });
  });

  it("commits the tap under the cask token and the released version", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: caskText(CURRENT_VERSION, STALE_SHA256),
    });

    withStubs(fixture, () => postRelease(fixture.context));

    const commit = calls(fixture, "git").find((argv) =>
      argv.includes("commit")
    );
    expect(commit ?? []).toContain(`${CASK} ${NEXT_VERSION}`);
  });

  it("pushes the tap, so brew can see the new cask", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: caskText(CURRENT_VERSION, STALE_SHA256),
    });

    withStubs(fixture, () => postRelease(fixture.context));

    expect(calls(fixture, "git").some((argv) => argv.includes("push"))).toBe(
      true
    );
  });

  it("fails when ruby rejects the cask it wrote", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: caskText(CURRENT_VERSION, STALE_SHA256),
      ruby: "rejects",
    });

    const result = withStubs(fixture, () => postRelease(fixture.context));

    expect(refusal(result).toLowerCase()).toContain("syntax");
  });

  it("reports that the cask went unchecked when ruby is not on PATH", () => {
    const fixture = makeCaskFixture({
      bundle: defaultBundle(),
      caskInTap: caskText(CURRENT_VERSION, STALE_SHA256),
      ruby: "absent",
    });

    const result = withStubs(fixture, () => postRelease(fixture.context));

    expect({ note: (result.notes ?? "").toLowerCase(), ok: result.ok }).toEqual(
      {
        note: expect.stringContaining("ruby"),
        ok: true,
      }
    );
  });
});

// ===========================================================================
// Slice 6 — SMOKE: report-only.
//
// Installing a cask is a human step (it downloads a real dmg and asks for a
// password), so the adapter's smoke RUNS nothing and instead hands back the one
// command a human has to type. The tap's SHORT name is Homebrew's own rule:
// `<user>/homebrew-<name>` is referred to as `<user>/<name>`.
// ===========================================================================

describe("homebrew-cask smoke", () => {
  it("hands back the brew install command under the tap's short name", () => {
    const fixture = makeCaskFixture();

    const result = withStubs(fixture, () => caskAdapter.smoke(fixture.context));

    expect(result.notes ?? "").toContain(
      `brew install --cask kvnwolf/tap/${CASK}`
    );
  });

  it("leaves a tap that carries no homebrew- prefix as it is", () => {
    const fixture = makeCaskFixture({ tap: "acme/tap" });

    const result = withStubs(fixture, () => caskAdapter.smoke(fixture.context));

    expect(result.notes ?? "").toContain(
      `brew install --cask acme/tap/${CASK}`
    );
  });

  it("runs nothing: the brew install smoke is a human step", () => {
    const fixture = makeCaskFixture();

    const result = withStubs(fixture, () => caskAdapter.smoke(fixture.context));

    expect({ ok: result.ok, ran: toolsInvoked(fixture) }).toEqual({
      ok: true,
      ran: [],
    });
  });
});

// ===========================================================================
// Slice 7 — the REGISTRY. A target nobody registers is a target `dobby release`
// refuses, however complete the module is.
// ===========================================================================

describe("the homebrew-cask target", () => {
  it("answers to release.type homebrew-cask", () => {
    const root = makeScratchRepo({
      branch: "main",
      config: {
        files: [],
        release: { cask: CASK, tap: TAP, type: "homebrew-cask" },
      },
      pkg: { name: "mad-eye", private: true, version: CURRENT_VERSION },
      prefix: "dobby-cask-registry-",
      track: scratchDirs,
    });

    const result = runRelease({
      command: "release",
      cwd: root,
      options: {},
      positionals: [],
    });

    // The spine refuses an unclaimed type BEFORE any phase runs, naming it; this
    // release stops later (on its own preflights), never for want of an adapter.
    expect(result.error ?? "").not.toContain("no release adapter");
  });
});

// ===========================================================================
// Slice 8 — the TWO ADDITIVE HOOKS, driven by the spine.
//
// `bumpExtras` and `postRelease` are OPTIONAL on the adapter interface (the npm
// target defines neither and is unaffected), and their whole contract is WHEN
// they run: `bumpExtras` inside the bump phase — early enough that its edits land
// in the `release: v<V>` commit — and `postRelease` after the GitHub release
// exists (there is nothing to upload to before that) and before the smoke (which
// tells a human to install what the tap now carries).
//
// A FAKE adapter stands in for a target here, registered under `npm`: what is
// under test is the SPINE's sequencing, and a fake is the only way to observe it
// without a real tap.
// ===========================================================================

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

// The non-JSON lockstep file the spine delegates — the reason `bumpExtras`
// exists. The fake adapter rewrites it, exactly as the cask adapter rewrites
// Cargo.toml.
const LOCKSTEP_FILE = "VERSION.txt";

interface SpineFixture {
  ghDir: string;
  // What the fake was driven through, in order.
  order: string[];
  // The gh invocations that had already happened when postRelease was called.
  postReleaseSawGh: string[][];
  root: string;
}

function makeSpineFixture(options: { postReleaseFails?: boolean } = {}): {
  fixture: SpineFixture;
  notesFile: string;
} {
  const root = makeScratchRepo({
    branch: "main",
    config: {
      files: [],
      release: { lockstep: [LOCKSTEP_FILE], type: "npm" },
    },
    files: {
      "biome.jsonc": BIOME_CONFIG,
      "knip.json": KNIP_CONFIG,
      "src/index.ts": "export const ok = 1;\n",
      "tsconfig.json": TSCONFIG,
      [LOCKSTEP_FILE]: `${CURRENT_VERSION}\n`,
    },
    pkg: { name: "scratch-release", private: true, version: CURRENT_VERSION },
    prefix: "dobby-cask-spine-",
    track: scratchDirs,
  });

  const origin = mkTempDir("dobby-cask-origin-");
  gitIn(root, ["init", "--bare", "-q", origin]);
  writeFileSync(
    join(root, ".git", "config"),
    `${readFileSync(join(root, ".git", "config"), "utf8")}[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`
  );
  gitIn(root, ["tag", `v${CURRENT_VERSION}`]);
  writeFile(join(root, "notes.md"), "csv export\n");
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-q", "-m", "feat: add csv export"]);
  gitIn(root, ["push", "-q", "origin", "main", `v${CURRENT_VERSION}`]);

  const ghDir = mkStubBinDir(scratchDirs);
  mkStubBin(
    ghDir,
    "gh",
    [
      "#!/bin/sh",
      "PATH=/usr/bin:/bin; export PATH",
      `{ printf '%s\\n' "$#"; [ "$#" -eq 0 ] || printf '%s\\0' "$@"; } >> ${sq(stubLogPath(ghDir, "gh"))}`,
      'case "$*" in',
      "  *'run list'*)",
      `    printf '%s' '[{"conclusion":"success","headSha":"'"$(git -C ${sq(root)} rev-parse HEAD)"'","status":"completed"}]'`,
      "    exit 0",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );

  const fixture: SpineFixture = {
    ghDir,
    order: [],
    postReleaseSawGh: [],
    root,
  };

  const record = (phase: string) => (): ReleasePhaseResult => {
    fixture.order.push(phase);
    return { ok: true };
  };

  const adapter: ReleaseAdapter = {
    bumpExtras: (context, version) => {
      fixture.order.push("bumpExtras");
      writeFileSync(join(context.root, LOCKSTEP_FILE), `${version}\n`);
      return { ok: true };
    },
    id: "fake-target",
    packGate: record("packGate"),
    postRelease: () => {
      fixture.order.push("postRelease");
      fixture.postReleaseSawGh = readStubLog(ghDir, "gh");
      return options.postReleaseFails === true
        ? { error: "fake target: the tap push was rejected", ok: false }
        : { ok: true };
    },
    preflight: record("preflight"),
    publish: record("publish"),
    smoke: record("smoke"),
  };
  registerReleaseAdapter("npm", adapter);

  const notesFile = join(mkTempDir("dobby-cask-notes-"), "notes.md");
  writeFileSync(notesFile, "## What's new\n\nCSV export, at last.\n");
  return { fixture, notesFile };
}

interface SpineOutcome {
  exitCode: number;
  published?: boolean;
  root: string;
}

async function releaseThrough(
  built: ReturnType<typeof makeSpineFixture>
): Promise<SpineOutcome> {
  const { fixture, notesFile } = built;
  const result = await withStubPath(fixture.ghDir, () =>
    run(["release", "--json", "--notes-file", notesFile], fixture.root)
  );
  const report =
    result.stdout.trim() === ""
      ? {}
      : (JSON.parse(result.stdout) as { published?: boolean });
  return {
    exitCode: result.exitCode,
    published: report.published,
    root: fixture.root,
  };
}

describe("the release spine — the additive adapter hooks", () => {
  let built: ReturnType<typeof makeSpineFixture>;
  let outcome: SpineOutcome;

  beforeAll(async () => {
    built = makeSpineFixture();
    outcome = await releaseThrough(built);
  }, 180_000);

  it("released the version the commits imply", () => {
    expect({
      exitCode: outcome.exitCode,
      published: outcome.published,
    }).toEqual({ exitCode: 0, published: true });
  });

  it("runs bumpExtras early enough that its edit lands in the release commit", () => {
    // Read out of the COMMIT, not the worktree: a lockstep file bumped after the
    // commit is a release whose tag does not carry the version it claims.
    expect(gitIn(outcome.root, ["show", `HEAD:${LOCKSTEP_FILE}`])).toBe(
      NEXT_VERSION
    );
  });

  it("runs postRelease only once the GitHub release exists to upload to", () => {
    expect(
      built.fixture.postReleaseSawGh.some(
        (argv) => argv[0] === "release" && argv[1] === "create"
      )
    ).toBe(true);
  });

  it("drives the adapter through every phase, postRelease before the smoke", () => {
    expect(built.fixture.order).toEqual([
      "preflight",
      "bumpExtras",
      "packGate",
      "publish",
      "postRelease",
      "smoke",
    ]);
  });
});

// ===========================================================================
// Slice 9 — NOTARIZATION PREFLIGHT: is the MACHINE able to notarize at all?
//
// Notarization is OPTIONAL and opts in BY CONFIG PRESENCE: `release.notaryProfile`
// names a notarytool KEYCHAIN PROFILE, and that name is the only credential fact
// dobby ever holds — the Apple ID and its app-specific password live in the
// keychain, put there once by hand with `xcrun notarytool store-credentials`.
// There is deliberately NO env-var path.
//
// Both checks belong in the preflight for the same reason every other one does: a
// missing certificate or an unknown profile costs a 20-minute build and an Apple
// round trip to discover at packGate time, and both are one-time human setup.
// ===========================================================================

describe("homebrew-cask preflight — notarization prerequisites", () => {
  it("reads the installed codesigning identities through security find-identity", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    withStubs(fixture, () => caskAdapter.preflight(preflightContext(fixture)));

    expect(calls(fixture, "security")[0]).toEqual([
      "find-identity",
      "-v",
      "-p",
      "codesigning",
    ]);
  });

  it("refuses when no Developer ID Application certificate is installed, naming the certificate and where it is made", () => {
    // `find-identity` EXITS 0 on this machine — it simply lists a development
    // certificate instead. Signing itself is tauri.conf.json's `signingIdentity`,
    // never dobby's job; what dobby can do is refuse before the build.
    const fixture = makeCaskFixture({
      identities: IDENTITIES_DEVELOPMENT_ONLY,
      notaryProfile: NOTARY_PROFILE,
    });

    const message = refusal(
      withStubs(fixture, () => caskAdapter.preflight(preflightContext(fixture)))
    );

    expect({
      certificate: message.includes("Developer ID Application"),
      where: /xcode/i.test(message),
    }).toEqual({ certificate: true, where: true });
  });

  it("verifies the keychain profile through notarytool history", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    withStubs(fixture, () => caskAdapter.preflight(preflightContext(fixture)));

    expect(xcrunCall(fixture, "history")).toEqual([
      "notarytool",
      "history",
      "--keychain-profile",
      NOTARY_PROFILE,
    ]);
  });

  it("refuses an unknown keychain profile with the one-time store-credentials setup line", () => {
    const fixture = makeCaskFixture({
      notaryHistory: "unknown-profile",
      notaryProfile: NOTARY_PROFILE,
    });

    const message = refusal(
      withStubs(fixture, () => caskAdapter.preflight(preflightContext(fixture)))
    );

    // The fix is a single command the human runs ONCE, and it needs both ids.
    expect({
      appleId: message.includes("--apple-id"),
      hint: message.includes(
        `xcrun notarytool store-credentials ${NOTARY_PROFILE}`
      ),
      teamId: message.includes("--team-id"),
    }).toEqual({ appleId: true, hint: true, teamId: true });
  });

  it("accepts a machine carrying the certificate and a known keychain profile", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect(verdict(result)).toEqual({ ok: true });
  });
});

// ===========================================================================
// Slice 10 — NOTARIZING THE ARTIFACT (packGate).
//
// Where it sits is the whole point: AFTER the bundled-version gate (a stale
// bundle must never cost an Apple round trip) and still BEFORE any tag — the last
// place a release can be refused for free. Three steps, each with its own
// verdict: SUBMIT (whose answer is the `status:` line, never the exit code),
// STAPLE (so the ticket travels with the dmg, and `brew install` works offline),
// and ASSESS (Gatekeeper's own opinion of the file that is about to be uploaded —
// the only check that judges the ARTIFACT rather than the process).
//
// A refusal quotes the tool's FULL output: this is the one failure a human cannot
// re-derive locally, and a truncated notarytool log is a support ticket.
// ===========================================================================

describe("homebrew-cask packGate — notarizing the dmg", () => {
  it("submits the built dmg under the keychain profile and waits for the verdict", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    withStubs(fixture, () => caskAdapter.packGate(fixture.context));

    expect(xcrunCall(fixture, "submit")).toEqual([
      "notarytool",
      "submit",
      THE_BUILT_DMG,
      "--keychain-profile",
      NOTARY_PROFILE,
      "--wait",
    ]);
  });

  it("staples the notarization ticket onto the dmg it submitted", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    withStubs(fixture, () => caskAdapter.packGate(fixture.context));

    expect(xcrunCall(fixture, "staple")).toEqual([
      "stapler",
      "staple",
      THE_BUILT_DMG,
    ]);
  });

  it("asks Gatekeeper to assess the stapled dmg under its primary signature", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    withStubs(fixture, () => caskAdapter.packGate(fixture.context));

    expect(calls(fixture, "spctl")[0]).toEqual([
      "-a",
      "-t",
      "open",
      "--context",
      "context:primary-signature",
      "-vv",
      THE_BUILT_DMG,
    ]);
  });

  it("accepts a dmg the notary service accepted, stapled and Gatekeeper calls notarized", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect(verdict(result)).toEqual({ ok: true });
  });

  it("refuses when the notary service did not accept the submission, quoting the whole notarytool output", () => {
    // notarytool exits 0 here — the verdict is the `status:` line, and the FULL
    // log is what a human needs to find out why (the head names the file, the
    // tail names the status; a truncated middle is a truncated log).
    const fixture = makeCaskFixture({
      notaryProfile: NOTARY_PROFILE,
      notaryStatus: "invalid",
    });

    const message = refusal(
      withStubs(fixture, () => caskAdapter.packGate(fixture.context))
    );

    expect({
      head: message.includes("Conducting pre-submission checks"),
      middle: message.includes("Upload progress: 100.00%"),
      tail: message.includes("status: Invalid"),
    }).toEqual({ head: true, middle: true, tail: true });
  });

  it("does not staple a submission the notary service did not accept", () => {
    const fixture = makeCaskFixture({
      notaryProfile: NOTARY_PROFILE,
      notaryStatus: "invalid",
    });

    withStubs(fixture, () => caskAdapter.packGate(fixture.context));

    expect(xcrunCall(fixture, "staple")).toBeUndefined();
  });

  it("refuses when the notarization ticket cannot be stapled", () => {
    const fixture = makeCaskFixture({
      notaryProfile: NOTARY_PROFILE,
      stapler: "fails",
    });

    const message = refusal(
      withStubs(fixture, () => caskAdapter.packGate(fixture.context))
    );

    expect(message.toLowerCase()).toContain("staple");
  });

  it("does not ask Gatekeeper about a dmg it could not staple", () => {
    const fixture = makeCaskFixture({
      notaryProfile: NOTARY_PROFILE,
      stapler: "fails",
    });

    withStubs(fixture, () => caskAdapter.packGate(fixture.context));

    expect(calls(fixture, "spctl")).toEqual([]);
  });

  it("refuses when Gatekeeper rejects the dmg, quoting the whole assessment", () => {
    const fixture = makeCaskFixture({
      notaryProfile: NOTARY_PROFILE,
      spctl: "rejected",
    });

    const message = refusal(
      withStubs(fixture, () => caskAdapter.packGate(fixture.context))
    );

    expect({
      source: message.includes("source=Unnotarized Developer ID"),
      verdict: message.includes("rejected"),
    }).toEqual({ source: true, verdict: true });
  });

  it("refuses a dmg Gatekeeper accepts without a notarized origin", () => {
    // spctl EXITS 0 for a signed-but-un-notarized build (`source=Developer ID`),
    // so the assessment text is the verdict — the status code cannot be.
    const fixture = makeCaskFixture({
      notaryProfile: NOTARY_PROFILE,
      spctl: "unnotarized",
    });

    const message = refusal(
      withStubs(fixture, () => caskAdapter.packGate(fixture.context))
    );

    expect(message).toContain("source=Developer ID");
  });

  it("gates the bundled version first: a build that predates the bump never reaches Apple", () => {
    const fixture = makeCaskFixture({
      build: { dmgs: [DMG_NAME], plistVersion: "0.4.9" },
      notaryProfile: NOTARY_PROFILE,
    });

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect({
      notarization: notarizationToolsInvoked(fixture),
      refused: refusal(result).includes("0.4.9"),
    }).toEqual({ notarization: [], refused: true });
  });
});

// ===========================================================================
// Slice 11 — THE INSTALL NOTE. What the smoke hands a human depends on what the
// release actually did: a notarized dmg installs with one command, while an
// un-notarized one is quarantined by Gatekeeper on download and needs the xattr
// escape — a caveat that is a LIE next to a notarized build.
// ===========================================================================

describe("homebrew-cask smoke — the install note", () => {
  it("hands back the brew install command alone when the release was notarized", () => {
    const fixture = makeCaskFixture({ notaryProfile: NOTARY_PROFILE });

    const notes =
      withStubs(fixture, () => caskAdapter.smoke(fixture.context)).notes ?? "";

    expect({
      install: notes.includes(`brew install --cask kvnwolf/tap/${CASK}`),
      quarantine: notes.includes("xattr"),
    }).toEqual({ install: true, quarantine: false });
  });

  it("keeps the quarantine caveat, named as the conditional it is, when nothing was notarized", () => {
    const fixture = makeCaskFixture();

    const notes =
      withStubs(fixture, () => caskAdapter.smoke(fixture.context)).notes ?? "";

    expect({
      condition: /unsigned|un-?notarized/i.test(notes),
      fix: notes.includes("xattr -dr com.apple.quarantine"),
    }).toEqual({ condition: true, fix: true });
  });
});

// ===========================================================================
// Slice 12 — THE UN-NOTARIZED DEFAULT stays byte-compatible.
//
// Notarization is opt-in by the PRESENCE of `release.notaryProfile`. A project
// that never configured one — every project that releases through this target
// today — must go through the identical flow it went through before: not a
// skipped step, not a warning, but literally not one Apple tool spawned.
// ===========================================================================

describe("homebrew-cask without a notaryProfile", () => {
  it("runs no notarization tool during preflight", () => {
    const fixture = makeCaskFixture();

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect({
      notarization: notarizationToolsInvoked(fixture),
      ok: result.ok,
    }).toEqual({ notarization: [], ok: true });
  });

  it("gates the dmg without ever contacting Apple", () => {
    const fixture = makeCaskFixture();

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect({
      notarization: notarizationToolsInvoked(fixture),
      ok: result.ok,
    }).toEqual({ notarization: [], ok: true });
  });
});

// ===========================================================================
// Slice 13 — A CONFIGURED-BUT-EMPTY notaryProfile is a MISTAKE, not an opt-out.
//
// The opt-out is the ABSENT key (slice 12). An empty one is a key someone
// started wiring up and left blank — reading it as "no notarization" would take
// a config that ASKS to be notarized and quietly ship an unsigned dmg through
// every phase and the tag, with the install note reverting to the quarantine
// caveat and no error anywhere. It is refused by name, exactly as an empty
// `release.tap` / `release.cask` is (slices 1-2).
// ===========================================================================

describe("homebrew-cask with an EMPTY notaryProfile", () => {
  it("refuses in preflight, naming the key, without asking Apple anything", () => {
    const fixture = makeCaskFixture({ notaryProfile: "" });

    const result = withStubs(fixture, () =>
      caskAdapter.preflight(preflightContext(fixture))
    );

    expect({
      named: refusal(result).includes("release.notaryProfile"),
      notarization: notarizationToolsInvoked(fixture),
      ok: result.ok,
    }).toEqual({ named: true, notarization: [], ok: false });
  });

  it("refuses at the gate too, rather than gating a dmg nobody notarized", () => {
    const fixture = makeCaskFixture({ notaryProfile: "" });

    const result = withStubs(fixture, () =>
      caskAdapter.packGate(fixture.context)
    );

    expect({
      named: refusal(result).includes("release.notaryProfile"),
      notarization: notarizationToolsInvoked(fixture),
      ok: result.ok,
    }).toEqual({ named: true, notarization: [], ok: false });
  });
});

describe("the release spine — a failing postRelease", () => {
  it("reports it without undoing the release that is already public", async () => {
    const built = makeSpineFixture({ postReleaseFails: true });

    const outcome = await releaseThrough(built);

    expect({
      exitCode: outcome.exitCode,
      published: outcome.published,
      tagged: gitIn(outcome.root, ["tag", "--list", TAG]),
    }).toEqual({ exitCode: 1, published: true, tagged: TAG });
  }, 180_000);
});
