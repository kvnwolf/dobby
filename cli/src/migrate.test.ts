import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitIn,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// The MIGRATION commands — `dobby migrate preflight` and `dobby migrate verify`.
//
// `preflight` is the mechanized Step 0 of `/dobby:migrate-config`: it detects the
// legacy (vite-plus era) signals, snapshots the facts the migration must carry
// across, and returns ONE verdict — `already-migrated` or `migration-needed`. It
// is READ-ONLY: the skill's own words are "say so plainly and stop — do not touch
// anything", so a preflight that mutated the tree would be a bug, and it never
// REFUSES either (both verdicts exit 0; the branch is the caller's).
//
// `verify` is the mechanized Step 10: run the gate, read the environment back,
// and report what the migration left behind.
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008): the domain
// module is never imported directly, so its internals can be restructured freely
// without touching this file.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - Every legacy signal's literal — `.claude/commit.config.yml`, an old-era
//    `dobby.config.json` with a `run` key or `vp`/`vpr` extras, `vite-plus` in
//    devDependencies, the `"vite": "npm:@voidzero-dev/vite-plus-core"` /
//    `"vitest": "npm:@voidzero-dev/vite-plus-test"` overrides, `.vite-hooks/`,
//    a `vp`/`vpr` task table in `vite.config.ts`, a `prepare` script, `.conductor/`
//    — is quoted VERBATIM from the task spec and from `migrate-config/SKILL.md`
//    Step 0 (its own field-case list).
//  - The verdict rule (`already-migrated` = no vite-plus signal AND the config is
//    new-schema AND `tsconfig.json` extends `@kvnwolf/dobby`) is the spec's and the
//    skill's literal wording; each fixture below violates exactly ONE clause of it,
//    so a passing verdict can never be explained by a second, accidental signal.
//  - Every snapshot fact is a fixture WE wrote: which toolchain deps are declared
//    (`taze` deliberately ABSENT), which package.json keys are preserved, which
//    workflow file carries a `vp` line and which does not, which tool configs exist.
//    Nothing here is recomputed the way the implementation computes it.
//  - The five inferred db task names come from `cli/README.md` ("Inferred database
//    tasks": db:generate, db:migrate, db:push, db:check, db:studio), NOT from the
//    map in tasks.ts.
//  - `check`'s outcome is a fact of hand-written sources: `lintbad.ts` has `a == b`
//    on line 2 (biome `noDoubleEquals`, enabled by the fixture's own biome.jsonc)
//    and `typebad.ts` assigns a string to a number on line 1 (tsc TS2322) — the
//    same two-tool isolation `run.test.ts` uses — so "biome and tsc failed" is
//    something we authored, not something we read back out of the tool.
//  - "dobby must run inside a git repository" is the CLI's established hard-error
//    literal for an action command outside a repo.
//
// NOTHING is mocked. git is real (throwaway repos), and `verify` runs the REAL
// gate (biome + tsc + knip) against tiny fixtures whose sources we wrote — the
// only honest way to assert on an exit code the command merely passes through.
//
// PATH CONVENTION (a pinned contract decision, see the work log): every path the
// payload reports is REPO-RELATIVE, following the spec's own parenthetical
// (`legacyYaml: path|null (.claude/commit.config.yml)`).
// ===========================================================================

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// --- Fixture content -------------------------------------------------------

// The vite-plus era app config: the task table lived HERE (`vp`/`vpr`), which is
// why those repos have no package.json scripts worth the name.
const VITE_CONFIG_WITH_VP_TASKS = `import { defineConfig } from "vite";

export default defineConfig({
  tasks: {
    dev: { run: "vpr dev" },
    validate: { run: "vpr validate" },
  },
});
`;

// A vite.config.ts with NO vp/vpr anywhere — the discriminator that keeps
// "vpTaskTable" from degrading into "a vite.config.ts exists".
const VITE_CONFIG_WITHOUT_VP_TASKS = `import { defineConfig } from "vite";

export default defineConfig({ server: { port: 3000 } });
`;

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({ test: { globals: true } });
`;

const DRIZZLE_CONFIG = `export default { dialect: "postgresql", out: "./drizzle" };
`;

// The legacy commit contract (`.claude/commit.config.yml`) — doc-sync rules in
// the pre-JSON shape.
const LEGACY_COMMIT_YAML = `files:
  - path: README.md
    update_when:
      - the public API changes
`;

// A workflow that still runs the vite-plus gate.
const CI_WITH_VP = `name: ci
on: [push]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - run: vp install
      - run: vpr validate
`;

// A workflow with NO vp/vpr line — it must NOT be listed. (Deliberately free of
// the substring "vp" anywhere, so only a real per-line scan excludes it.)
const CI_WITHOUT_VP = `name: deploy
on: [push]
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: bun run deploy
`;

// The fat, pre-migration tsconfig: everything spelled out, no dobby extends.
const TSCONFIG_FAT = `{
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "preserve",
    "moduleResolution": "bundler",
    "noEmit": true,
    "paths": { "@/*": ["./src/*"] },
    "strict": true
  },
  "include": ["src"]
}
`;

// The thin, post-migration tsconfig (migrate-config Step 2's literal shape).
const TSCONFIG_THIN = `{
  "extends": "@kvnwolf/dobby/tsconfig/vite",
  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },
  "include": ["src"]
}
`;

// A self-contained tsconfig for the check-running fixtures: `verify` never reads
// the extends chain, and a real `extends` would need node_modules on disk.
const TSCONFIG_STANDALONE = `{
  "compilerOptions": { "noEmit": true, "skipLibCheck": true, "strict": true },
  "include": ["src"]
}
`;

// The check-running fixtures carry their OWN biome.jsonc: formatter off, ONE
// linter rule on. That makes the gate's outcome a fact of the sources we wrote
// (`a == b` fires, everything else cannot), instead of a fact of whichever house
// preset is vendored this week.
const BIOME_DELTA_CONFIG = `{
  "assist": { "enabled": false },
  "formatter": { "enabled": false },
  "linter": {
    "enabled": true,
    "rules": { "recommended": false, "suspicious": { "noDoubleEquals": "error" } }
  }
}
`;

// Hand-written sources, each isolating ONE tool's finding (the run.test.ts
// pattern): `==` on line 2 → biome only; a string into a number on line 1 → tsc
// only; clean.ts → neither.
const LINTBAD =
  "export function eq(a: number, b: number): boolean {\n  return a == b;\n}\n";
const TYPEBAD = 'export const wrong: number = "not a number";\n';
const CLEAN =
  "export function ok(a: number, b: number): number {\n  return a + b;\n}\n";

const DOC_SYNC_FILES = [
  { path: "README.md", update_when: ["the public API changes"] },
];

// --- Fixtures --------------------------------------------------------------

// A vite-plus repo carrying EVERY legacy signal at once (the vonda/admin field
// cases fused): old-era dobby.config.json, legacy YAML, vite-plus dep + aliases,
// .vite-hooks/, a vp task table, a prepare script, .conductor/.
function makeViteplusRepo(): string {
  return makeScratchRepo({
    branch: "main",
    config: {
      checks: ["vpr validate"],
      files: DOC_SYNC_FILES,
      run: "vp dev",
      setup: ["vp install"],
      teardown: ["docker compose down"],
      tracker: { type: "linear" },
    },
    files: {
      ".claude/commit.config.yml": LEGACY_COMMIT_YAML,
      ".conductor/setup.sh": "#!/bin/sh\nneonctl branches create\n",
      ".github/workflows/ci.yml": CI_WITH_VP,
      ".github/workflows/deploy.yml": CI_WITHOUT_VP,
      ".vite-hooks/pre-commit": "#!/bin/sh\nvpr validate\n",
      "drizzle.config.ts": DRIZZLE_CONFIG,
      "README.md": "vonda\n",
      "tsconfig.json": TSCONFIG_FAT,
      "vercel.json": '{ "buildCommand": "vp build" }\n',
      "vite.config.ts": VITE_CONFIG_WITH_VP_TASKS,
      "vitest.config.ts": VITEST_CONFIG,
    },
    pkg: {
      devDependencies: {
        "drizzle-kit": "^0.30.0",
        knip: "^5.30.0",
        oxlint: "^0.15.0",
        portless: "^0.4.0",
        ultracite: "^5.0.0",
        vite: "^7.0.0",
        "vite-plus": "^1.0.0",
        vitest: "^3.0.0",
      },
      name: "vonda",
      overrides: {
        vite: "npm:@voidzero-dev/vite-plus-core",
        vitest: "npm:@voidzero-dev/vite-plus-test",
      },
      portless: "vonda.example",
      private: true,
      scripts: { prepare: "vp install", typecheck: "vp exec tsc --noEmit" },
      trustedDependencies: ["esbuild"],
    },
    prefix: "dobby-migrate-viteplus-",
    track: scratchDirs,
  });
}

// The canonical MIGRATED repo (migrate-config's target state): package.json, a
// thin tsconfig extending the dobby preset, a new-schema dobby.config.json — and
// no tool configs at all, because dobby's capability-picked presets govern.
// `overrides` lets one clause of the verdict rule be broken at a time.
function makeMigratedRepo(
  overrides: {
    config?: unknown;
    files?: Record<string, string>;
    pkg?: unknown;
    prefix?: string;
  } = {}
): string {
  return makeScratchRepo({
    branch: "main",
    config:
      overrides.config === undefined
        ? { files: DOC_SYNC_FILES, tracker: { type: "github" } }
        : overrides.config,
    files: {
      ".env.test": "DATABASE_URL=postgres://placeholder\n",
      ".worktreeinclude": ".env.local\n",
      README: "clean\n",
      "src/index.ts": CLEAN,
      "tsconfig.json": TSCONFIG_THIN,
      ...overrides.files,
    },
    pkg: overrides.pkg ?? {
      devDependencies: { "@kvnwolf/dobby": "^0.5.0" },
      name: "clean-app",
      portless: "clean-app.example",
      private: true,
    },
    prefix: overrides.prefix ?? "dobby-migrate-clean-",
    track: scratchDirs,
  });
}

// A HEALTHY migrated repo the real gate passes: no legacy leftovers, a complete
// tracker, and one deliberately KEPT delta config (biome.jsonc).
function makeHealthyRepo(): string {
  return makeScratchRepo({
    branch: "main",
    config: { files: DOC_SYNC_FILES, tracker: { type: "github" } },
    files: {
      ".env.test": "DATABASE_URL=postgres://placeholder\n",
      ".worktreeinclude": ".env.local\n",
      "biome.jsonc": BIOME_DELTA_CONFIG,
      "README.md": "healthy\n",
      "src/index.ts": CLEAN,
      "tsconfig.json": TSCONFIG_STANDALONE,
    },
    pkg: {
      name: "healthy-app",
      portless: "healthy-app.example",
      private: true,
    },
    prefix: "dobby-migrate-healthy-",
    track: scratchDirs,
  });
}

// A half-migrated repo: the gate FAILS (one lint error + one type error), three
// legacy artifacts were never deleted, and the tracker is a Linear line whose
// `team` was deferred.
function makeUnhealthyRepo(): string {
  return makeScratchRepo({
    branch: "main",
    config: { files: DOC_SYNC_FILES, tracker: { type: "linear" } },
    files: {
      ".claude/commit.config.yml": LEGACY_COMMIT_YAML,
      ".conductor/setup.sh": "#!/bin/sh\nneonctl branches create\n",
      ".vite-hooks/pre-commit": "#!/bin/sh\nvpr validate\n",
      "biome.jsonc": BIOME_DELTA_CONFIG,
      "README.md": "half\n",
      "src/lintbad.ts": LINTBAD,
      "src/typebad.ts": TYPEBAD,
      "tsconfig.json": TSCONFIG_STANDALONE,
    },
    pkg: {
      devDependencies: { "drizzle-kit": "^0.30.0" },
      name: "half-app",
      private: true,
    },
    prefix: "dobby-migrate-unhealthy-",
    track: scratchDirs,
  });
}

// --- The payload shapes (the spec's field list, nothing more) ---------------

interface MigrateSignals {
  aliases: string[];
  conductor: boolean;
  legacyYaml: string | null;
  oldEraConfig: { hasRun: boolean; path: string; vpExtras: string[] } | null;
  prepareScript: boolean;
  viteHooks: boolean;
  viteplusDep: boolean;
  vpTaskTable: boolean;
}

interface MigrateSnapshot {
  ci: string[];
  envTest: boolean;
  preservedKeys: string[];
  scripts: string[];
  toolConfigs: {
    biome: string | null;
    drizzle: string | null;
    vite: string | null;
    vitest: string | null;
  };
  toolchainDeps: string[];
  tracker: { source: string; team: string | null; type: string | null };
  vercelJson: boolean;
  worktreeinclude: boolean;
}

interface MigratePreflight {
  signals: MigrateSignals;
  snapshot: MigrateSnapshot;
  verdict: string;
}

interface MigrateVerify {
  check: { exitCode: number; failingSteps: string[] };
  env: {
    capabilities: string[];
    config: boolean;
    dbTasks: string[];
    devUrl: string | null;
  };
  ok: boolean;
  residual: {
    deltaConfigsKept: string[];
    legacyFilesRemaining: string[];
    trackerIncomplete: boolean;
  };
}

// A preflight is informational, never a refusal: BOTH verdicts exit 0, so the
// helper asserts that once for every slice.
async function migratePreflight(cwd: string): Promise<MigratePreflight> {
  const result = await run(["migrate", "preflight", "--json"], cwd);
  expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as MigratePreflight;
}

// `verify`'s exit code is deliberately NOT asserted here (see the work log: the
// unhealthy-exit convention is left open) — the payload is the contract.
async function migrateVerify(cwd: string): Promise<MigrateVerify> {
  const result = await run(["migrate", "verify", "--json"], cwd);
  expect(
    result.stdout,
    `no JSON on stdout — stderr: ${result.stderr}`
  ).not.toBe("");
  return JSON.parse(result.stdout) as MigrateVerify;
}

// A throwaway directory that is NOT a git repository (and not inside one — the
// OS temp root never is), for the hard-precondition slice.
function makeNonGitDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-migrate-nogit-")));
  scratchDirs.push(dir);
  return dir;
}

// A directory entry compares equal whether or not the payload decorates it with a
// trailing slash.
function withoutTrailingSlash(paths: string[]): string[] {
  return paths.map((path) => path.replace(/\/$/, ""));
}

// ===========================================================================
// Slice 1 (tracer bullet) — the verdict on an ALREADY-MIGRATED repo.
//
// The first thing `/dobby:migrate-config` Step 0 needs: is there anything to do
// at all? A repo in the target state (no vite-plus signal, a new-schema
// dobby.config.json, a tsconfig extending @kvnwolf/dobby) must be recognized and
// left alone. This proves the command is wired, the verdict rule is applied, and
// the signal block is projected.
// ===========================================================================

describe("migrate preflight — a repo that is already migrated", () => {
  let root: string;

  beforeAll(() => {
    root = makeMigratedRepo();
  });

  it("returns the already-migrated verdict", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.verdict).toBe("already-migrated");
  });

  it("finds no legacy commit contract", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.legacyYaml).toBeNull();
  });

  it("reports the new-schema dobby.config.json as no old-era config", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.oldEraConfig).toBeNull();
  });

  it("finds no vite-plus dependency", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.viteplusDep).toBe(false);
  });

  it("finds no vite-plus aliases", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.aliases).toEqual([]);
  });

  it("finds none of the supporting legacy signals", async () => {
    const preflight = await migratePreflight(root);
    expect([
      preflight.signals.conductor,
      preflight.signals.prepareScript,
      preflight.signals.viteHooks,
      preflight.signals.vpTaskTable,
    ]).toEqual([false, false, false, false]);
  });

  it("leaves the repo untouched — a preflight only reads", async () => {
    await migratePreflight(root);
    expect(gitIn(root, ["status", "--porcelain"])).toBe("");
  });

  it("names the verdict on stdout without --json too", async () => {
    const result = await run(["migrate", "preflight"], root);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("already-migrated");
  });
});

// ===========================================================================
// Slice 2 — the verdict on a vite-plus repo, and every legacy signal it carries.
//
// The mirror image: a repo with the full legacy surface must come back
// `migration-needed` with each signal NAMED, because Step 0's job is to record
// the starting state so Step 10 can report the diff.
// ===========================================================================

describe("migrate preflight — a vite-plus repo's legacy signals", () => {
  let root: string;

  beforeAll(() => {
    root = makeViteplusRepo();
  });

  it("returns the migration-needed verdict", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.verdict).toBe("migration-needed");
  });

  it("points at the legacy commit contract at .claude/commit.config.yml", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.legacyYaml).toBe(".claude/commit.config.yml");
  });

  it("points at the old-era dobby.config.json", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.oldEraConfig?.path).toBe("dobby.config.json");
  });

  it("reports the old-era config's run key", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.oldEraConfig?.hasRun).toBe(true);
  });

  it("lists the setup and checks extras that shell out to vp/vpr", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.oldEraConfig?.vpExtras).toEqual(
      expect.arrayContaining(["vp install", "vpr validate"])
    );
  });

  it("leaves an extra that does NOT shell out to vp/vpr off the list", async () => {
    // `teardown: ["docker compose down"]` is a genuine project need, not vite-plus
    // residue — listing it would make the signal meaningless.
    const preflight = await migratePreflight(root);
    expect(preflight.signals.oldEraConfig?.vpExtras).not.toContain(
      "docker compose down"
    );
  });

  it("detects the vite-plus dependency", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.viteplusDep).toBe(true);
  });

  it("names both packages aliased onto vite-plus in package.json overrides", async () => {
    const preflight = await migratePreflight(root);
    expect([...preflight.signals.aliases].sort()).toEqual(["vite", "vitest"]);
  });

  it("detects the .vite-hooks directory", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.viteHooks).toBe(true);
  });

  it("detects the vp task table in vite.config.ts", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.vpTaskTable).toBe(true);
  });

  it("detects the prepare script", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.prepareScript).toBe(true);
  });

  it("detects the .conductor directory", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.signals.conductor).toBe(true);
  });

  it("leaves the repo untouched — a preflight only reads", async () => {
    await migratePreflight(root);
    expect(gitIn(root, ["status", "--porcelain"])).toBe("");
  });
});

// ===========================================================================
// Slice 3 — the verdict rule, one clause at a time.
//
// `already-migrated` = no vite-plus signal AND a new-schema config AND a tsconfig
// extending @kvnwolf/dobby. Each repo below is the migrated fixture with EXACTLY
// ONE clause broken, so the verdict can only be explained by that clause.
// ===========================================================================

describe("migrate preflight — the already-migrated rule needs all three clauses", () => {
  it("calls a repo with a vite-plus dependency migration-needed, everything else migrated", async () => {
    const root = makeMigratedRepo({
      pkg: {
        devDependencies: { "@kvnwolf/dobby": "^0.5.0", "vite-plus": "^1.0.0" },
        name: "clean-app",
        portless: "clean-app.example",
        private: true,
      },
      prefix: "dobby-migrate-dep-",
    });
    const preflight = await migratePreflight(root);
    expect([preflight.verdict, preflight.signals.viteplusDep]).toEqual([
      "migration-needed",
      true,
    ]);
  });

  it("calls a repo still on the legacy YAML migration-needed (no dobby.config.json at all)", async () => {
    // The admin field case: no vite-plus signal anywhere, a thin tsconfig — but the
    // commit contract never moved, so there is no new-schema config.
    const root = makeScratchRepo({
      branch: "main",
      files: {
        ".claude/commit.config.yml": LEGACY_COMMIT_YAML,
        README: "admin\n",
        "tsconfig.json": TSCONFIG_THIN,
      },
      pkg: {
        devDependencies: { "@kvnwolf/dobby": "^0.5.0" },
        name: "admin",
        private: true,
      },
      prefix: "dobby-migrate-yaml-",
      track: scratchDirs,
    });
    const preflight = await migratePreflight(root);
    expect([preflight.verdict, preflight.signals.viteplusDep]).toEqual([
      "migration-needed",
      false,
    ]);
  });

  it("calls a repo whose tsconfig does not extend @kvnwolf/dobby migration-needed", async () => {
    const root = makeMigratedRepo({
      files: { "tsconfig.json": TSCONFIG_FAT },
      prefix: "dobby-migrate-tsconfig-",
    });
    const preflight = await migratePreflight(root);
    expect([
      preflight.verdict,
      preflight.signals.legacyYaml,
      preflight.signals.oldEraConfig,
    ]).toEqual(["migration-needed", null, null]);
  });

  it("calls a config with no run key but a vpr check extra an old-era config", async () => {
    // The `run` key is only ONE arm of the old-era test — extras shelling out to
    // vp/vpr are the other, and they are a vite-plus signal in their own right.
    const root = makeMigratedRepo({
      config: { checks: ["vpr validate"], files: DOC_SYNC_FILES },
      prefix: "dobby-migrate-extras-",
    });
    const preflight = await migratePreflight(root);
    expect([
      preflight.verdict,
      preflight.signals.oldEraConfig?.hasRun,
      preflight.signals.oldEraConfig?.vpExtras,
    ]).toEqual(["migration-needed", false, ["vpr validate"]]);
  });
});

// ===========================================================================
// Slice 4 — the SNAPSHOT: the facts the migration has to carry across.
//
// Step 1 preserves package keys and swaps deps, Step 2/3 decide per tool config,
// Step 6 creates `.worktreeinclude`, Step 9 rewires CI + Vercel, Step 10 reports
// the diff. Everything asserted here is a fixture we wrote — including what is
// deliberately ABSENT (`taze`, a second workflow with no vp line).
// ===========================================================================

describe("migrate preflight — the snapshot of a vite-plus repo", () => {
  let root: string;

  beforeAll(() => {
    root = makeViteplusRepo();
  });

  it("names the bundled-toolchain deps the repo still declares", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.toolchainDeps).toEqual(
      expect.arrayContaining(["knip", "oxlint", "portless", "ultracite"])
    );
  });

  it("never claims a toolchain dep the repo does not declare", async () => {
    // `taze` is deliberately absent from the fixture's devDependencies.
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.toolchainDeps).not.toContain("taze");
  });

  it("keeps genuine build dependencies out of the toolchain list", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.toolchainDeps).not.toContain("drizzle-kit");
  });

  it("names the project-specific package.json keys to preserve", async () => {
    const preflight = await migratePreflight(root);
    expect([...preflight.snapshot.preservedKeys].sort()).toEqual([
      "portless",
      "trustedDependencies",
    ]);
  });

  it("reports a missing .worktreeinclude", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.worktreeinclude).toBe(false);
  });

  it("lists the package.json script names", async () => {
    const preflight = await migratePreflight(root);
    expect([...preflight.snapshot.scripts].sort()).toEqual([
      "prepare",
      "typecheck",
    ]);
  });

  it("locates each tool config that exists, and nulls the one that does not", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.toolConfigs).toEqual({
      biome: null,
      drizzle: "drizzle.config.ts",
      vite: "vite.config.ts",
      vitest: "vitest.config.ts",
    });
  });

  it("reports a missing .env.test", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.envTest).toBe(false);
  });

  it("lists only the workflow files carrying a vp/vpr line", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.ci).toEqual([".github/workflows/ci.yml"]);
  });

  it("reports the vercel.json", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.vercelJson).toBe(true);
  });

  it("carries the declared tracker type across", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.tracker.type).toBe("linear");
  });

  it("never fabricates a Linear team the source did not declare", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.tracker.team).toBeNull();
  });

  it("names where the tracker declaration was found", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.tracker.source).toContain("dobby.config.json");
  });
});

describe("migrate preflight — the snapshot of a migrated repo", () => {
  let root: string;

  beforeAll(() => {
    root = makeMigratedRepo();
  });

  it("reports no toolchain deps left to remove", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.toolchainDeps).toEqual([]);
  });

  it("names only the project keys the repo actually carries", async () => {
    // portless stays (dobby dev/up still resolve through it); this repo declares
    // no trustedDependencies, so the list must not offer one.
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.preservedKeys).toEqual(["portless"]);
  });

  it("reports the .worktreeinclude as present", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.worktreeinclude).toBe(true);
  });

  it("reports no package.json scripts", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.scripts).toEqual([]);
  });

  it("nulls every tool config in a config-less repo", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.toolConfigs).toEqual({
      biome: null,
      drizzle: null,
      vite: null,
      vitest: null,
    });
  });

  it("reports the committed .env.test", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.envTest).toBe(true);
  });

  it("lists no CI workflow to rewire", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.ci).toEqual([]);
  });

  it("reports no vercel.json", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.vercelJson).toBe(false);
  });

  it("carries the github tracker across", async () => {
    const preflight = await migratePreflight(root);
    expect(preflight.snapshot.tracker.type).toBe("github");
  });
});

// A vite.config.ts with no vp/vpr in it is NOT a task-table signal — the
// discriminator that keeps the signal from degrading into file presence.
describe("migrate preflight — a vite.config.ts without vp tasks", () => {
  it("reports no vp task table while still locating the config", async () => {
    const root = makeMigratedRepo({
      files: { "vite.config.ts": VITE_CONFIG_WITHOUT_VP_TASKS },
      prefix: "dobby-migrate-vitecfg-",
    });
    const preflight = await migratePreflight(root);
    expect([
      preflight.signals.vpTaskTable,
      preflight.snapshot.toolConfigs.vite,
    ]).toEqual([false, "vite.config.ts"]);
  });
});

// ===========================================================================
// Slice 5 — `verify` on a HEALTHY migrated repo (the Step 10 green path).
//
// The gate runs for REAL against sources we wrote clean, and the env snapshot is
// read back through the same facts `dobby env` reports. One kept delta config
// (biome.jsonc) is present on purpose: keeping a config for a real delta is a
// legitimate migration outcome, so it is REPORTED, not held against the repo.
// ===========================================================================

describe("migrate verify — a healthy migrated repo", () => {
  let payload: MigrateVerify;
  let exitCode: number;

  beforeAll(async () => {
    const root = makeHealthyRepo();
    const {
      exitCode: code,
      stderr,
      stdout,
    } = await run(["migrate", "verify", "--json"], root);
    exitCode = code;
    expect(stdout, `no JSON on stdout — stderr: ${stderr}`).not.toBe("");
    payload = JSON.parse(stdout) as MigrateVerify;
  }, 120_000);

  it("declares the migration healthy", () => {
    expect(payload.ok).toBe(true);
  });

  it("exits 0", () => {
    expect(exitCode).toBe(0);
  });

  it("reports the gate as green", () => {
    expect(payload.check.exitCode).toBe(0);
  });

  it("names no failing gate step", () => {
    expect(payload.check.failingSteps).toEqual([]);
  });

  it("reports the parseable dobby.config.json", () => {
    expect(payload.env.config).toBe(true);
  });

  it("reports no devUrl for a project with no app", () => {
    expect(payload.env.devUrl).toBeNull();
  });

  it("infers no database tasks without a database capability", () => {
    expect(payload.env.dbTasks).toEqual([]);
  });

  it("finds no legacy file left behind", () => {
    expect(payload.residual.legacyFilesRemaining).toEqual([]);
  });

  it("reports the one tool config kept for a delta", () => {
    expect(payload.residual.deltaConfigsKept).toEqual(["biome.jsonc"]);
  });

  it("reports the tracker as complete", () => {
    expect(payload.residual.trackerIncomplete).toBe(false);
  });
});

// ===========================================================================
// Slice 6 — `verify` on a HALF-MIGRATED repo (the Step 10 red path).
//
// The gate fails on sources we broke on purpose, three legacy artifacts were
// never deleted, and the Linear tracker's `team` was deferred — the three things
// Step 10 must flag before anyone calls the migration done.
// ===========================================================================

describe("migrate verify — a half-migrated repo", () => {
  let payload: MigrateVerify;

  beforeAll(async () => {
    const root = makeUnhealthyRepo();
    payload = await migrateVerify(root);
  }, 120_000);

  it("declares the migration not healthy", () => {
    expect(payload.ok).toBe(false);
  });

  it("passes the gate's failing exit code through", () => {
    expect(payload.check.exitCode).not.toBe(0);
  });

  it("names biome as a failing gate step", () => {
    expect(payload.check.failingSteps).toContain("biome");
  });

  it("names tsc as a failing gate step", () => {
    expect(payload.check.failingSteps).toContain("tsc");
  });

  it("reports the detected drizzle capability", () => {
    expect(payload.env.capabilities).toContain("drizzle");
  });

  it("reports the inferred db task names a drizzle repo resolves", () => {
    // The five documented in cli/README.md's "Inferred database tasks".
    expect([...payload.env.dbTasks].sort()).toEqual([
      "db:check",
      "db:generate",
      "db:migrate",
      "db:push",
      "db:studio",
    ]);
  });

  it("lists the legacy commit contract as still present", () => {
    expect(
      withoutTrailingSlash(payload.residual.legacyFilesRemaining)
    ).toContain(".claude/commit.config.yml");
  });

  it("lists the undeleted .conductor directory", () => {
    expect(
      withoutTrailingSlash(payload.residual.legacyFilesRemaining)
    ).toContain(".conductor");
  });

  it("lists the undeleted .vite-hooks directory", () => {
    expect(
      withoutTrailingSlash(payload.residual.legacyFilesRemaining)
    ).toContain(".vite-hooks");
  });

  it("flags the Linear tracker whose team was never pinned", () => {
    expect(payload.residual.trackerIncomplete).toBe(true);
  });
});

// ===========================================================================
// Slice 7 — both migrate arms fail HARD outside a git repository (the
// action-command contract): there is no repo to reason about, so they never
// answer with a degraded verdict a skill might act on.
// ===========================================================================

describe("the migrate commands outside a git repository", () => {
  it("fails migrate preflight with the git-repository error", async () => {
    const result = await run(
      ["migrate", "preflight", "--json"],
      makeNonGitDir()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git repository");
  });

  it("fails migrate verify with the git-repository error", async () => {
    const result = await run(["migrate", "verify", "--json"], makeNonGitDir());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git repository");
  });
});
