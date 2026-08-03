import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ReleaseContext } from "./release.ts";
import { createNpmAdapter, npmAdapter } from "./release-npm.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  mkStubBin,
  mkStubBinDir,
  readStubLog,
  stubLogPath,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// The NPM release TARGET — the adapter behind the release spine's four moments.
//
// The spine (release.ts) owns everything true of EVERY release; this module owns
// the four that are true only of npm: whether the CHANNEL is usable
// (`preflight` — npm auth), whether the ARTIFACT is shippable (`packGate` — the
// tarball's file list), the irreversible `publish`, and the `smoke` that proves
// the published version is actually servable from the registry.
//
// THE SEAM THIS SUITE EXERCISES (the module's public surface):
//   export const npmAdapter: ReleaseAdapter          // the default instance,
//                                                    // registered under "npm"
//   export function createNpmAdapter(options?: {
//     attempts?: number;   // how many `npm view` polls the smoke makes
//     delayMs?: number;    // the wait between polls
//   }): ReleaseAdapter
// The factory exists so the smoke's retry loop is INJECTABLE: production waits
// minutes for registry propagation, tests must not. Every method takes the
// spine's `ReleaseContext` and returns DATA (`{ok, error?, notes?}`) — never
// throws, never prints.
//
// Mocked at the BOUNDARY only: `npm` and `bun` are stub bins on PATH (both are
// spawned BARE through runner.ts, like git/gh), recording their full argv AND
// their working directory. Nothing internal is mocked — the adapter is called
// through its own exported interface.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - The COMMANDS are the spec's literals: `npm whoami`, `bun pm pack --dry-run
//    --ignore-scripts`, `npm publish --access public`, `npm view <name> version`.
//  - The DENY globs are the spec's literals: `**/*.test.ts`, `**/__fixtures__/**`,
//    `dist/**`. Every file list in this suite is a literal written here, so what
//    the gate refuses is checked against bytes we chose.
//  - The stub OUTPUT is real-tool shaped, captured out of band: the `packed <size>
//    <path>` / `Total files: N` listing is bun 1.3.10's actual `bun pm pack
//    --dry-run` stdout; `npm error code ENEEDAUTH …` is npm 11.16.0's actual
//    stderr when no auth is configured; the EOTP / E403 / E404 blocks follow the
//    same `npm error code <CODE>` shape.
//  - The version arithmetic is nobody's: 0.5.0 is the version this release is
//    publishing (a literal), 0.4.2 the one the registry still serves.
// ===========================================================================

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
});

// The package under release: the name the smoke asks the registry about, and the
// version this release is publishing.
const PACKAGE_NAME = "@scratch/release-probe";
const RELEASED_VERSION = "0.5.0";
const PREVIOUS_VERSION = "0.4.2";

// npm 11.16.0's actual stderr for `npm whoami` with no registry auth configured.
const ENEEDAUTH_STDERR = [
  "npm error code ENEEDAUTH",
  "npm error need auth This command requires you to be logged in.",
  "npm error need auth You need to authorize this machine using `npm adduser`",
  "",
].join("\n");

// The one-time-password refusal an INTERACTIVE-LOGIN token hits at publish time —
// the field-proven failure `npm whoami` cannot predict (whoami passes, publish
// does not). The fix is a granular access token in ~/.npmrc, which is what the
// adapter's error has to say.
const EOTP_STDERR = [
  "npm error code EOTP",
  "npm error This operation requires a one-time password from your authenticator.",
  "npm error You can provide a one-time password by passing --otp=<code> to the command you ran.",
  "",
].join("\n");

const FORBIDDEN_STDERR = [
  "npm error code E403",
  `npm error 403 Forbidden - PUT https://registry.npmjs.org/${PACKAGE_NAME} - You cannot publish over the previously published versions: ${RELEASED_VERSION}.`,
  "",
].join("\n");

// What the registry answers while a FIRST publish is still propagating.
const NOT_FOUND_STDERR = [
  "npm error code E404",
  `npm error 404 '${PACKAGE_NAME}@latest' is not in this registry.`,
  "",
].join("\n");

// --- the package + the context ---------------------------------------------

// A publishable package on disk. `relDir` puts it in a SUBDIRECTORY (dobby's own
// `release.dir` is "cli"), which is what the release dir must mean to every spawn.
function makePackage(relDir?: string): { dir: string; root: string } {
  const manifest = `${JSON.stringify(
    { name: PACKAGE_NAME, private: false, version: RELEASED_VERSION },
    null,
    2
  )}\n`;
  const root = makeScratchRepo({
    files: relDir === undefined ? {} : { [`${relDir}/package.json`]: manifest },
    pkg: manifest,
    prefix: "dobby-release-npm-",
    track: scratchDirs,
  });
  return { dir: relDir === undefined ? root : join(root, relDir), root };
}

// The spine's view of one release, as the adapter receives it: version/tag are
// already decided (the spine fills them in before packGate), `dir` is the
// publishable package's directory.
function makeContext(
  pkg: { dir: string; root: string },
  overrides: Partial<ReleaseContext> = {}
): ReleaseContext {
  return {
    currentVersion: PREVIOUS_VERSION,
    dir: pkg.dir,
    notesFile: null,
    release: { type: "npm" },
    root: pkg.root,
    tag: `v${RELEASED_VERSION}`,
    version: RELEASED_VERSION,
    ...overrides,
  };
}

// --- the npm / bun boundary -------------------------------------------------
// A stub bin that answers a DIFFERENT canned step per invocation (the last step
// repeats for every call beyond the list) — the "404, then the version" registry
// sequence a propagation retry has to survive, which the argv-matching
// `mkRecorderBin` cannot express. It records argv (readStubLog) AND the directory
// it was run in (readStubCwds), because "in the release dir" is part of the
// contract: publishing the workroot instead of `release.dir` ships the wrong tree.

interface StubStep {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}

function stubBins(spec: Record<string, StubStep[]>): string {
  const dir = mkStubBinDir(scratchDirs);
  for (const [name, steps] of Object.entries(spec)) {
    mkStubBin(dir, name, stepScript(dir, name, steps));
  }
  return dir;
}

function stepScript(dir: string, name: string, steps: StubStep[]): string {
  const log = shQuote(stubLogPath(dir, name));
  const cwdLog = shQuote(cwdLogPath(dir, name));
  const counter = shQuote(join(dir, `${name}.count`));
  const lines = [
    "#!/bin/sh",
    `{ printf '%s\\n' "$#"; [ "$#" -eq 0 ] || printf '%s\\0' "$@"; } >> ${log}`,
    `pwd -P >> ${cwdLog}`,
    `n=$(cat ${counter} 2>/dev/null || printf 0)`,
    "n=$((n + 1))",
    `printf '%s' "$n" > ${counter}`,
  ];
  let index = 0;
  for (const step of steps) {
    index += 1;
    lines.push(`[ "$n" -eq ${index} ] && ${stepBody(step)}`);
  }
  const last = steps.at(-1);
  if (last !== undefined) {
    lines.push(stepBody(last));
  }
  lines.push("exit 0", "");
  return lines.join("\n");
}

function stepBody(step: StubStep): string {
  const parts: string[] = [];
  if (step.stdout !== undefined) {
    parts.push(`printf '%s' ${shQuote(step.stdout)}`);
  }
  if (step.stderr !== undefined) {
    parts.push(`printf '%s' ${shQuote(step.stderr)} >&2`);
  }
  parts.push(`exit ${Math.trunc(step.exitCode ?? 0)}`);
  return `{ ${parts.join("; ")}; }`;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cwdLogPath(dir: string, name: string): string {
  return join(dir, `${name}.cwd`);
}

// The directories a stub bin was invoked in, one per invocation, in order.
function readStubCwds(dir: string, name: string): string[] {
  const path = cwdLogPath(dir, name);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

// `bun pm pack --dry-run --ignore-scripts` stdout, in bun 1.3.10's actual shape:
// a banner, one `packed <size> <path>` line per file (paths relative to the
// package root — bun prints no `package/` prefix), the tarball name, the totals.
function packListing(paths: string[]): string {
  return [
    "bun pack v1.3.10 (30e609e0)",
    "",
    ...paths.map((path) => `packed 1.2KB ${path}`),
    "",
    `release-probe-${RELEASED_VERSION}.tgz`,
    "",
    `Total files: ${paths.length}`,
    "Unpacked size: 12.3KB",
    "",
  ].join("\n");
}

// ===========================================================================
// Slice 1 — PREFLIGHT: is the CHANNEL usable at all?
//
// It runs inside the spine's preflight phase, where a refusal costs nothing: no
// version decided, no file touched. So this is the cheapest place to discover
// that npm has no idea who we are.
// ===========================================================================

describe("npm target — preflight", () => {
  it("accepts the channel when npm can say who we are", async () => {
    const bins = stubBins({ npm: [{ stdout: "kvnwolf\n" }] });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.preflight(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
    expect(readStubLog(bins, "npm")).toEqual([["whoami"]]);
  });

  it("refuses the channel in npm's own words when there is no auth", async () => {
    const bins = stubBins({
      npm: [{ exitCode: 1, stderr: ENEEDAUTH_STDERR }],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.preflight(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("ENEEDAUTH");
  });
});

// ===========================================================================
// Slice 2 — PACK GATE: is the ARTIFACT shippable?
//
// The last chance to refuse before the irreversible step. A tarball carrying
// tests, fixtures or build output is a published mistake that can never be
// unpublished, so any hit on a DENY glob stops the release and names the files.
// ===========================================================================

describe("npm target — pack gate", () => {
  it("accepts a tarball that carries only shippable files", async () => {
    const bins = stubBins({
      bun: [
        { stdout: packListing(["package.json", "src/index.ts", "README.md"]) },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
  });

  it("packs a dry run that writes no tarball and runs no scripts", async () => {
    const bins = stubBins({
      bun: [{ stdout: packListing(["package.json", "src/index.ts"]) }],
    });

    await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(readStubLog(bins, "bun")).toEqual([
      ["pm", "pack", "--dry-run", "--ignore-scripts"],
    ]);
  });

  it("inspects the package in the release dir, not the workroot", async () => {
    const pkg = makePackage("cli");
    const bins = stubBins({
      bun: [{ stdout: packListing(["package.json", "src/index.ts"]) }],
    });

    await withStubPath(bins, () => npmAdapter.packGate(makeContext(pkg)));

    expect(readStubCwds(bins, "bun")).toEqual([join(pkg.root, "cli")]);
  });

  it("records how many files the tarball carries", async () => {
    const bins = stubBins({
      bun: [
        { stdout: packListing(["package.json", "src/index.ts", "README.md"]) },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    // 3 — the three paths this test wrote into the listing.
    expect(verdict.notes ?? "").toMatch(/\b3\b/);
  });

  it("refuses a tarball that carries test files", async () => {
    const bins = stubBins({
      bun: [
        {
          stdout: packListing([
            "package.json",
            "src/index.ts",
            "src/release.test.ts",
          ]),
        },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("src/release.test.ts");
  });

  it("refuses a tarball that carries test fixtures", async () => {
    const bins = stubBins({
      bun: [
        {
          stdout: packListing([
            "package.json",
            "src/__fixtures__/payload.json",
          ]),
        },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("src/__fixtures__/payload.json");
  });

  it("refuses a tarball that carries build output", async () => {
    const bins = stubBins({
      bun: [{ stdout: packListing(["package.json", "dist/index.js"]) }],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("dist/index.js");
  });

  it("refuses a test file sitting at the package root", async () => {
    // The DENY globs lead with `**/`, which has to mean ZERO or more directories:
    // a package whose sources live at the root ships `index.test.ts` next to
    // `index.ts`. A `**/` that demanded at least one directory would let this
    // through — and a published tarball can never be unpublished.
    const bins = stubBins({
      bun: [
        { stdout: packListing(["package.json", "index.ts", "index.test.ts"]) },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("index.test.ts");
  });

  it("refuses a fixtures directory sitting at the package root", async () => {
    const bins = stubBins({
      bun: [
        { stdout: packListing(["package.json", "__fixtures__/user.json"]) },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("__fixtures__/user.json");
  });

  it("names every denied file, not just the first", async () => {
    const bins = stubBins({
      bun: [
        {
          stdout: packListing([
            "package.json",
            "src/index.test.ts",
            "src/__fixtures__/user.json",
            "dist/index.js",
          ]),
        },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.error).toContain("src/index.test.ts");
    expect(verdict.error).toContain("src/__fixtures__/user.json");
    expect(verdict.error).toContain("dist/index.js");
  });

  it("ships files whose names merely resemble the denied ones", async () => {
    // `latest.ts` ENDS WITH the bytes "test.ts", `fixtures/` is not
    // `__fixtures__/`, and `distribute.ts` is not inside `dist/` — a substring
    // match would refuse all three and no release would ever pass this gate.
    const bins = stubBins({
      bun: [
        {
          stdout: packListing([
            "package.json",
            "src/latest.ts",
            "src/fixtures/sample.json",
            "distribute.ts",
          ]),
        },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
  });

  it("ships a source directory that merely happens to be named dist", async () => {
    // `dist/**` is the BUILD OUTPUT at the package root, and only there: a
    // `src/dist/` is ordinary source (a module named "dist" — distribution,
    // registry entries, whatever the project means by it). Widening the glob to
    // `**/dist/**` would refuse a legitimate release forever.
    const bins = stubBins({
      bun: [
        {
          stdout: packListing([
            "package.json",
            "src/index.ts",
            "src/dist/registry.ts",
          ]),
        },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
  });

  it("refuses a tarball with no files at all", async () => {
    const bins = stubBins({ bun: [{ stdout: packListing([]) }] });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error?.toLowerCase()).toMatch(/empty|no files/);
  });

  it("quotes the packer's own listing when it can parse no files from it", async () => {
    // "Zero files" has two causes with opposite fixes: an allowlist that really
    // ships nothing, or a packer whose listing shape drifted away from the
    // `packed <size> <path>` lines this gate parses. The refusal cannot tell them
    // apart, so it hands the human what the packer actually printed.
    const drifted = [
      "bun pack v9.9.9 (deadbeef)",
      "",
      "  1.2KB package.json",
      "  2.4KB src/index.ts",
      "",
      "Total files: 2",
      "",
    ].join("\n");
    const bins = stubBins({ bun: [{ stdout: drifted }] });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("src/index.ts");
    expect(verdict.error).toContain("Total files: 2");
  });

  it("refuses when the packer itself fails", async () => {
    const bins = stubBins({
      bun: [
        {
          exitCode: 1,
          stderr: "error: package.json not found in the release dir\n",
        },
      ],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.packGate(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("package.json not found");
  });
});

// ===========================================================================
// Slice 3 — PUBLISH: the irreversible step.
//
// Everything the spine does after it (tag, push, the GitHub release) is gated on
// it, and a version number that ships is burned forever — so the two things that
// matter here are WHICH command runs (never `bun publish`, always `--access
// public`) and that an EOTP refusal comes back with the fix, not just the code.
// ===========================================================================

describe("npm target — publish", () => {
  it("publishes a scoped package with public access", async () => {
    const bins = stubBins({ npm: [{ stdout: `+ ${PACKAGE_NAME}@0.5.0\n` }] });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.publish(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
    expect(readStubLog(bins, "npm")).toEqual([
      ["publish", "--access", "public"],
    ]);
  });

  it("publishes from the release dir, not the workroot", async () => {
    const pkg = makePackage("cli");
    const bins = stubBins({ npm: [{ stdout: `+ ${PACKAGE_NAME}@0.5.0\n` }] });

    await withStubPath(bins, () => npmAdapter.publish(makeContext(pkg)));

    expect(readStubCwds(bins, "npm")).toEqual([join(pkg.root, "cli")]);
  });

  it("never publishes through bun", async () => {
    // bun 1.3.x ignores ~/.npmrc's `_authToken`, so `bun publish` fails to
    // authenticate exactly where a release cannot afford it (field-hit v0.1.0).
    const bins = stubBins({
      bun: [],
      npm: [{ stdout: `+ ${PACKAGE_NAME}@0.5.0\n` }],
    });

    await withStubPath(bins, () =>
      npmAdapter.publish(makeContext(makePackage()))
    );

    expect(readStubLog(bins, "bun")).toEqual([]);
  });

  it("answers a one-time-password refusal with the granular-token fix", async () => {
    const bins = stubBins({
      npm: [{ exitCode: 1, stderr: EOTP_STDERR }],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.publish(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("EOTP");
    expect(verdict.error?.toLowerCase()).toContain("granular");
    expect(verdict.error).toContain(".npmrc");
  });

  it("surfaces npm's own words when the registry rejects the publish", async () => {
    const bins = stubBins({
      npm: [{ exitCode: 1, stderr: FORBIDDEN_STDERR }],
    });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.publish(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("403");
  });
});

// ===========================================================================
// Slice 4 — SMOKE: does the published thing actually exist?
//
// It runs LAST and gates nothing (the artifact is already public), which is
// precisely why it may RETRY: propagation can lag minutes on a first publish, so
// a 404 right after `+ pkg@V` printed is not a failure — only an exhausted poll
// budget is.
// ===========================================================================

describe("npm target — smoke", () => {
  it("passes as soon as the registry serves the published version", async () => {
    const bins = stubBins({ npm: [{ stdout: `${RELEASED_VERSION}\n` }] });

    const verdict = await withStubPath(bins, () =>
      npmAdapter.smoke(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
    expect(readStubLog(bins, "npm")).toEqual([
      ["view", PACKAGE_NAME, "version"],
    ]);
  });

  it("keeps polling while the registry still 404s on a first publish", async () => {
    const bins = stubBins({
      npm: [
        { exitCode: 1, stderr: NOT_FOUND_STDERR },
        { stdout: `${RELEASED_VERSION}\n` },
      ],
    });
    const adapter = createNpmAdapter({ attempts: 3, delayMs: 0 });

    const verdict = await withStubPath(bins, () =>
      adapter.smoke(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
    expect(readStubLog(bins, "npm")).toHaveLength(2);
  });

  it("keeps polling while the registry still serves the previous version", async () => {
    const bins = stubBins({
      npm: [
        { stdout: `${PREVIOUS_VERSION}\n` },
        { stdout: `${RELEASED_VERSION}\n` },
      ],
    });
    const adapter = createNpmAdapter({ attempts: 3, delayMs: 0 });

    const verdict = await withStubPath(bins, () =>
      adapter.smoke(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(true);
  });

  it("gives up after the configured number of polls", async () => {
    const bins = stubBins({
      npm: [{ exitCode: 1, stderr: NOT_FOUND_STDERR }],
    });
    const adapter = createNpmAdapter({ attempts: 3, delayMs: 0 });

    const verdict = await withStubPath(bins, () =>
      adapter.smoke(makeContext(makePackage()))
    );

    expect(verdict.ok).toBe(false);
    expect(readStubLog(bins, "npm")).toHaveLength(3);
  });

  it("says which version never showed up when it gives up", async () => {
    const bins = stubBins({ npm: [{ stdout: `${PREVIOUS_VERSION}\n` }] });
    const adapter = createNpmAdapter({ attempts: 2, delayMs: 0 });

    const verdict = await withStubPath(bins, () =>
      adapter.smoke(makeContext(makePackage()))
    );

    expect(verdict.error).toContain(PACKAGE_NAME);
    expect(verdict.error).toContain(RELEASED_VERSION);
  });

  it("runs the project's own smoke command once the version is live", async () => {
    const bins = stubBins({
      "dobby-smoke-probe": [{ stdout: "release-probe 0.5.0\n" }],
      npm: [{ stdout: `${RELEASED_VERSION}\n` }],
    });
    const context = makeContext(makePackage(), {
      release: {
        smoke: ["dobby-smoke-probe", "--version", PACKAGE_NAME],
        type: "npm",
      },
    });

    const verdict = await withStubPath(bins, () => npmAdapter.smoke(context));

    expect(verdict.ok).toBe(true);
    expect(readStubLog(bins, "dobby-smoke-probe")).toEqual([
      ["--version", PACKAGE_NAME],
    ]);
  });

  it("fails when the project's own smoke command fails", async () => {
    const bins = stubBins({
      "dobby-smoke-probe": [
        { exitCode: 1, stderr: "release-probe: command not found\n" },
      ],
      npm: [{ stdout: `${RELEASED_VERSION}\n` }],
    });
    const context = makeContext(makePackage(), {
      release: {
        smoke: ["dobby-smoke-probe", "--version", PACKAGE_NAME],
        type: "npm",
      },
    });

    const verdict = await withStubPath(bins, () => npmAdapter.smoke(context));

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("command not found");
  });

  it("never runs the project's smoke command for a version that never appeared", async () => {
    const bins = stubBins({
      "dobby-smoke-probe": [],
      npm: [{ exitCode: 1, stderr: NOT_FOUND_STDERR }],
    });
    const adapter = createNpmAdapter({ attempts: 2, delayMs: 0 });
    const context = makeContext(makePackage(), {
      release: {
        smoke: ["dobby-smoke-probe", "--version", PACKAGE_NAME],
        type: "npm",
      },
    });

    const verdict = await withStubPath(bins, () => adapter.smoke(context));

    expect(verdict.ok).toBe(false);
    expect(readStubLog(bins, "dobby-smoke-probe")).toEqual([]);
  });
});

// ===========================================================================
// Slice 5 — REGISTRATION: the adapter has to be REACHABLE.
//
// An adapter that no production module imports is dead code: `dobby release` in
// an npm-configured repo would answer "no release adapter for release.type npm"
// while every test above passes. So this slice asks the question through the
// CLI's own entry (`run(argv, cwd)` — ADR-0008) in a FRESH module graph, where
// nothing has imported release-npm.ts except whatever production wiring does.
// ===========================================================================

describe("npm target — registration", () => {
  it("answers for release.type npm without a test importing the adapter", async () => {
    const root = makeScratchRepo({
      branch: "hotfix-lane",
      config: { files: [], release: { type: "npm" } },
      pkg: { name: PACKAGE_NAME, version: PREVIOUS_VERSION },
      prefix: "dobby-release-npm-wiring-",
      track: scratchDirs,
    });

    vi.resetModules();
    const { run } = await import("./run.ts");
    const result = await run(["release", "--json"], root);

    // The release got PAST adapter resolution and died on the spine's own
    // branch preflight — which is only reachable when "npm" resolves.
    expect(result.stderr).toContain("hotfix-lane");
    expect(result.stderr).not.toContain("no release adapter");
  });
});
