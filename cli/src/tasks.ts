import type { DobbyConfig } from "./config.ts";

// Pure task inference. Given the detected capabilities, the loaded config, and
// the selective flags, `checkPipeline` returns the ORDERED step plan for
// `dobby check`. It is the most-tested module BECAUSE it is pure: NO spawning,
// NO filesystem, NO process — just data in, plan out. `check.ts` executes the
// plan this returns (running the tools, reducing findings); nothing here shells
// out. node:*-free entirely (no imports but the config type), so vitest and Bun
// both load it identically.

// The selective flags that subset the pipeline. When ANY flag is present, the
// gate runs ONLY the flagged steps (and config `checks[]` extras are excluded);
// with NO flag it runs the full gate plus the extras.
export interface CheckFlags {
  build?: boolean;
  lint?: boolean;
  test?: boolean;
  types?: boolean;
  unused?: boolean;
}

// One step of the check pipeline, discriminated by `kind`:
//   - biome / tsc / knip — the always-available findings tools (bundled in dobby).
//   - build / test       — capability-gated. `skipNote` is null when the gating
//     capability (vite / vitest) is present (the step will run via the CONSUMER's
//     own bin); non-null when it is absent — the single line naming why the step
//     was skipped, which `check.ts` prints verbatim. A skip is NOT a failure.
//   - extra              — a config `checks[]` shell command, run last (full gate
//     only), fail-fast among themselves.
export type CheckStep =
  | { kind: "biome" }
  | { kind: "tsc" }
  | { kind: "knip" }
  | { kind: "build"; skipNote: string | null }
  | { kind: "test"; skipNote: string | null }
  | { kind: "extra"; name: string; run: string };

// The full-gate order (no flags): biome, tsc, knip, then the capability-gated
// build + test, then config `checks[]` extras. Selective flags pick a SUBSET of
// the tool steps in this same order and drop the extras.
//
// Capability gating is decided HERE (pure): `build` needs the `vite` capability,
// `test` needs `vitest`. When the capability is missing the step still appears in
// the plan but carries a `skipNote` — so the gate reports "skipped" rather than
// silently omitting it. The consumer-local bin resolution + actual run of a
// present build/test lives in `check.ts`; this module only decides run-vs-skip.
export function checkPipeline(
  capabilities: string[],
  config: DobbyConfig | null,
  flags: CheckFlags
): CheckStep[] {
  const anyFlag = Boolean(
    flags.lint || flags.types || flags.unused || flags.build || flags.test
  );
  // A tool step is selected if its flag is set (selective mode) or, with no flag
  // at all, always (the full gate).
  const selected = (flag: boolean | undefined): boolean =>
    anyFlag ? Boolean(flag) : true;

  const steps: CheckStep[] = [];

  if (selected(flags.lint)) {
    steps.push({ kind: "biome" });
  }
  if (selected(flags.types)) {
    steps.push({ kind: "tsc" });
  }
  if (selected(flags.unused)) {
    steps.push({ kind: "knip" });
  }
  if (selected(flags.build)) {
    steps.push({
      kind: "build",
      skipNote: capabilities.includes("vite")
        ? null
        : "build: skipped (no vite capability)",
    });
  }
  if (selected(flags.test)) {
    steps.push({
      kind: "test",
      skipNote: capabilities.includes("vitest")
        ? null
        : "test: skipped (no vitest capability)",
    });
  }

  // Config `checks[]` extras run LAST and ONLY on the full gate — a selective
  // flag run is a focused subset and excludes them.
  if (!anyFlag) {
    for (const extra of config?.checks ?? []) {
      steps.push({ kind: "extra", name: extra.name, run: extra.run });
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Config-less defaults (ADR-0015): override-by-presence.
//
// For every tool ONLY dobby invokes (biome, knip, vitest, vite, drizzle-kit),
// dobby SHIPS a preset and points the tool at it through the tool's NATIVE config
// flag — but ONLY when the consumer ships no config of its own at the workroot. A
// consumer config file (or a package.json key, for knip) is a TOTAL override,
// never merged: dobby then spawns bare and the tool's own discovery finds it.
// Default selection is capability-driven (react → the react preset; tanstack-start
// → the tanstack vite preset).
//
// The DECISION is PURE (this module): which own-config files count as an override,
// the tool's flag + argument form, and — from the capabilities — which shipped
// asset the default points at. The PRESENCE check (fs) + asset PATH resolution
// (`resolveAsset`) are IMPURE and live in `runner.configArgs`.
// ---------------------------------------------------------------------------

// The config-less default decision for ONE tool invocation — pure data consumed
// by `runner.configArgs`, which resolves it against the workroot at spawn time.
export interface ConfigDefaultSpec {
  // The shipped preset (relative to dobby's package root) the flag points at when
  // the consumer ships nothing — `resolveAsset` turns it into an absolute path.
  asset: string;
  // Whether the flag takes `--flag=value` (drizzle-kit, biome) vs `--flag value`.
  equals: boolean;
  // The tool's native config flag (biome: --config-path; the rest: --config).
  flag: string;
  // How the `configs:` note names the default source, e.g. "default(react)".
  label: string;
  // Consumer config filenames (relative to the workroot) whose presence is a
  // TOTAL override — ANY present means dobby spawns bare (native discovery).
  ownFiles: string[];
  // A package.json key whose presence ALSO overrides (knip's `#knip`), else absent.
  ownPkgKey?: string;
  // The tool this spec configures (labels the `configs:` note + the docs), e.g.
  // "biome" / "knip" / "vitest" / "vite" / "drizzle".
  tool: string;
  // Biome ONLY: also pass `--vcs-root=<workroot>`. The shipped biome preset
  // extends ultracite, which sets `vcs.useIgnoreFile: true`; without an explicit
  // vcs-root biome resolves the ignore file beside the PRESET (outside the repo)
  // and hard-errors. Rooting it at the workroot honors the consumer's .gitignore
  // (and tolerates its absence). Verified against bundled biome 2.5.4.
  vcsRoot?: boolean;
}

// Biome's default: the react preset when the `react` capability is present, else
// core. Uses `--config-path=<file>` + `--vcs-root=<workroot>` (see `vcsRoot`).
//
// The vendored presets (`biome/core.jsonc`, `biome/react.jsonc`) are FLAT — each is
// ultracite's config inlined verbatim + dobby's modifications — because biome's
// `extends` is ONE-LEVEL / non-transitive. A REACT app needs BOTH, so the config-less
// react default points at the internal ROOT WRAPPER (`biome/configless.react.jsonc`,
// `{ extends: ["./core.jsonc", "./react.jsonc"] }`): biome resolves those extends ONE
// level from the root config, and since both targets are flat, nothing is lost. NON-react
// passes flat `biome/core.jsonc` DIRECTLY (`root: false` works as a `--config-path`
// target — lab-verified against bundled biome 2.5.4). The wrapper is NOT a consumer
// extends target (package.json exports only `./biome/core` + `./biome/react`) — a
// consumer with deltas extends BOTH flat files themselves.
export function biomeConfigSpec(capabilities: string[]): ConfigDefaultSpec {
  const react = capabilities.includes("react");
  return {
    asset: react ? "biome/configless.react.jsonc" : "biome/core.jsonc",
    equals: true,
    flag: "--config-path",
    label: react ? "default(react)" : "default",
    ownFiles: ["biome.json", "biome.jsonc"],
    tool: "biome",
    vcsRoot: true,
  };
}

// Knip's default: dobby's `knip.base.jsonc` (the test-file-as-entry fix). A
// consumer overrides with ANY file in knip's own discovery set OR a package.json
// `#knip` key. `ownFiles` MIRRORS knip@6's `KNIP_CONFIG_LOCATIONS` verbatim (bundled
// knip 6.26.0, `dist/constants.js`) — a config in ANY of these forms is found by
// knip's bare discovery, so listing fewer would let a legal consumer config get
// SILENTLY overridden by dobby's default (the override-by-presence contract).
export function knipConfigSpec(): ConfigDefaultSpec {
  return {
    asset: "knip.base.jsonc",
    equals: false,
    flag: "--config",
    label: "default",
    ownFiles: [
      "knip.json",
      "knip.jsonc",
      ".knip.json",
      ".knip.jsonc",
      "knip.ts",
      "knip.js",
      "knip.config.ts",
      "knip.config.js",
    ],
    ownPkgKey: "knip",
    tool: "knip",
  };
}

// ---------------------------------------------------------------------------
// Require-all-imports guard for MULTI-IMPORT preset selection (ADR-0015).
//
// A capability alone is a WEAK signal for a preset that imports several packages
// UNCONDITIONALLY: those packages are declared as OPTIONAL peers, so the capability
// firing (one of them) does NOT prove the rest are installed. Selecting such a
// preset when a package is missing hands the consumer a default config whose import
// CRASHES dev/build/check. So a multi-import preset is chosen ONLY when the dep set
// declares EVERY package it imports; otherwise dobby falls back to the import-safe
// base preset (which imports only `vite` / `vitest/config`, guaranteed present by
// the gating capability). Single-import presets (biome/react extends a BUNDLED dobby
// dep; drizzle.base imports only `drizzle-kit` = the gating capability) need no guard.

// The CONSUMER packages `vite.tanstack.mjs` imports beyond the vite base — see
// cli/vite.tanstack.mjs, which imports ALL FIVE unconditionally at preset load. The
// `tanstack-start` capability fires on only `@tanstack/react-start`, so the other
// four are unproven; the tanstack default is import-safe ONLY when EVERY one is
// declared. Cross-ref: cli/src/run.test.ts `PRESET_IMPORTED_PACKAGES`.
const VITE_TANSTACK_IMPORTS: readonly string[] = [
  "@tanstack/react-start", // @tanstack/react-start/plugin/vite
  "@tanstack/devtools-vite",
  "@tailwindcss/vite",
  "nitro", // nitro/vite
  "@vitejs/plugin-react",
];

// The CONSUMER packages `vitest.react.mjs` imports beyond the vitest base — see
// cli/vitest.react.mjs: `@vitejs/plugin-react` + `vite`'s `loadEnv`. The `react`
// capability fires on `react` alone, so neither is proven; the react vitest variant
// is import-safe ONLY when BOTH are declared.
const VITEST_REACT_IMPORTS: readonly string[] = [
  "@vitejs/plugin-react",
  "vite",
];

// Whether the dependency set declares EVERY package a multi-import preset imports.
function hasAll(
  dependencies: Set<string>,
  required: readonly string[]
): boolean {
  return required.every((name) => dependencies.has(name));
}

// Vitest's default: the react variant when the `react` capability is present AND the
// consumer declares every package `vitest.react.mjs` imports (`@vitejs/plugin-react`
// + `vite`), else the import-safe base. `--config <file>` — vitest keeps `root = cwd`
// (the pinned workroot), so discovery is unchanged; the flag only supplies the config.
//
// Vitest DEGRADES (falls back to vitest.base) where vite is ALL-OR-ERROR (see
// `viteConfigSpec`): vitest.base is a FUNCTIONALLY-CORRECT fallback — tests still run,
// nothing silently broken — so a missing react-variant import can safely land on it;
// vite.base for a tanstack app has no framework plugins (the app can't serve), so
// there is no safe fallback and the missing-import case fails loud instead.
//
// DELIBERATE STANCE (ADR-0015): `ownFiles` lists ONLY the DEDICATED `vitest.config.*`
// forms — NEVER `vite.config.*`. Vitest natively FALLS BACK to a `test` block inside
// `vite.config.*` when no dedicated vitest config exists, so a bare vitest with a
// vite.config present would read that block. dobby does NOT honor that fallback as a
// consumer override: the house convention is that test wiring lives in
// `vitest.config.*`, and a `vite.config.*` kept only for app-plugin deltas must NOT
// silently disable dobby's vitest default. Only a DEDICATED `vitest.config.*` counts
// as the override — otherwise dobby supplies its shipped vitest preset via `--config`.
export function vitestConfigSpec(
  capabilities: string[],
  dependencies: Set<string>
): ConfigDefaultSpec {
  // The react variant imports @vitejs/plugin-react + vite unconditionally; the
  // react capability alone does not prove them installed, so require both.
  const react =
    capabilities.includes("react") &&
    hasAll(dependencies, VITEST_REACT_IMPORTS);
  return {
    asset: react ? "vitest.react.mjs" : "vitest.base.mjs",
    equals: false,
    flag: "--config",
    label: react ? "default(react)" : "default",
    ownFiles: [
      "vitest.config.ts",
      "vitest.config.mts",
      "vitest.config.cts",
      "vitest.config.js",
      "vitest.config.mjs",
      "vitest.config.cjs",
    ],
    tool: "vitest",
  };
}

// ---------------------------------------------------------------------------
// Vite default selection — ALL-OR-ERROR for tanstack, unlike vitest's DEGRADE.
//
// A `tanstack-start` app's default is `vite.tanstack.mjs`, which imports five
// consumer packages UNCONDITIONALLY. When ANY is missing, dobby has NO import-safe
// fallback that still SERVES the app: `vite.base.mjs` carries NO plugins, so falling
// back to it would run dev/build/check with the FRAMEWORK INTEGRATION ABSENT — the
// app "runs" but cannot actually serve (a silent breakage). So a config-less
// tanstack app missing any import is BLOCKED — a HARD ERROR naming the missing
// packages — never a silent base fallback. `vite.base.mjs` stays the default ONLY
// for a plain vite app (no tanstack), whose sole import (`vite`) is the gating
// capability, so it is always loadable.
//
// This is WHY vite is all-or-error while `vitestConfigSpec` DEGRADES: vitest.base is
// a FUNCTIONALLY-CORRECT fallback (tests still run, nothing silently broken), so a
// missing react-variant import can safely fall back to it; vite.base is NOT
// functionally correct for a tanstack app (no framework plugins), so there is
// nothing safe to fall back to — the only honest move is to fail loud.
// ---------------------------------------------------------------------------

// The result of selecting the config-less vite default (ADR-0015). PURE — the impure
// callers (check build step, planDev/runDev, runBuild) resolve it against the
// workroot via `runner.resolveViteConfig` and turn `blocked` into a hard error
// through their existing failure channels (never a silent base fallback):
//   - `default` — the app is servable with a default: the resolved `ConfigDefaultSpec`
//     (vite.base for a plain vite app, vite.tanstack when all five imports declared).
//   - `blocked` — a config-less tanstack app missing packages the tanstack default
//     imports; `missing` names them and `ownFiles` lets the impure resolver honor a
//     present consumer vite config as an override (which supersedes the block).
export type ViteConfigSelection =
  | { kind: "default"; spec: ConfigDefaultSpec }
  | { kind: "blocked"; missing: string[]; ownFiles: string[] };

// The config filenames whose presence at the workroot is a TOTAL override of the
// vite default — vite@8's `DEFAULT_CONFIG_FILES` verbatim (verified against vite
// 8.1.5, `dist/node/chunks/node.js`), all six extensions vite's bare discovery
// scans, so a legal `vite.config.cjs`/`.cts` is not SILENTLY overridden. A present
// one wins over BOTH the default AND the block.
const VITE_OWN_FILES: readonly string[] = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

// Vite's default selection. A plain vite app (no `tanstack-start`) → the universal
// `vite.base.mjs` (always loadable). A `tanstack-start` app → `vite.tanstack.mjs`
// when the consumer declares EVERY package it imports (the five in
// `VITE_TANSTACK_IMPORTS`), else BLOCKED (fail loud — there is no import-safe
// tanstack fallback that still serves the app; see the block comment above). Shared
// by build, dev, and `check --build` (all three resolve this selection).
export function viteConfigSpec(
  capabilities: string[],
  dependencies: Set<string>
): ViteConfigSelection {
  const spec = (asset: string, label: string): ConfigDefaultSpec => ({
    asset,
    equals: false,
    flag: "--config",
    label,
    ownFiles: [...VITE_OWN_FILES],
    tool: "vite",
  });

  // A plain vite app (no tanstack) → the universal base; never blocked (its only
  // import is `vite`, the gating capability, so it always loads).
  if (!capabilities.includes("tanstack-start")) {
    return { kind: "default", spec: spec("vite.base.mjs", "default") };
  }

  // tanstack-start: the preset imports five consumer packages unconditionally; the
  // capability fires on only @tanstack/react-start, so the other four are unproven.
  // Missing ANY → BLOCKED (no silent base fallback: base has no framework plugins,
  // so the app could not serve). All five declared → the tanstack preset.
  const missing = VITE_TANSTACK_IMPORTS.filter(
    (name) => !dependencies.has(name)
  );
  if (missing.length > 0) {
    return { kind: "blocked", missing, ownFiles: [...VITE_OWN_FILES] };
  }
  return {
    kind: "default",
    spec: spec("vite.tanstack.mjs", "default(tanstack-start)"),
  };
}

// The HARD-ERROR message for a BLOCKED config-less tanstack app (PURE — the impure
// callers surface it through their existing failure channels). Names the exact
// missing packages and BOTH remedies: install them, or write your own vite.config.ts
// (a present config overrides the default). Identical wording across dev/build/check.
export function viteBlockedMessage(missing: string[]): string {
  return `tanstack-start app is missing packages the default vite config imports: ${missing.join(", ")} — install them (bun add -d ${missing.join(" ")}) or write your own vite.config.ts (a present config overrides the default)`;
}

// Drizzle-kit's default: dobby's `drizzle.base.mjs`. drizzle-kit takes the flag in
// the `--config=<file>` form (equals). `ownFiles` MIRRORS drizzle-kit's ACTUAL bare
// discovery set — verified against drizzle-kit 0.31.10 (`bin.cjs` `drizzleConfigFromFile`:
// it tries `drizzle.config.ts`, then `drizzle.config.js`, then `drizzle.config.json`,
// and NO other extension). The earlier `.mts`/`.mjs` entries were removed: drizzle-kit
// does NOT discover them bare, so listing them created a FALSE override (a `.mjs`
// present → dobby spawns bare → drizzle-kit finds nothing → error); `.json` was added
// because it IS a real discovery target that was previously missing.
export function drizzleConfigSpec(): ConfigDefaultSpec {
  return {
    asset: "drizzle.base.mjs",
    equals: true,
    flag: "--config",
    label: "default",
    ownFiles: ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.json"],
    tool: "drizzle",
  };
}

// ---------------------------------------------------------------------------
// db:* task inference
//
// `dbTasks(capabilities)` maps the DETECTED db capability to the concrete `db:*`
// task set — pure data, no spawning. The executor (`lifecycle.ts`) resolves the
// tool bin consumer-local and runs the returned command.
//
// The rule (spec): drizzle is the ONLY db tool, so the SHORT names (`db:push`,
// `db:generate`, …) ALWAYS map to drizzle-kit. No drizzle capability → an empty
// set (mode "none"); the dispatcher reports it.
// ---------------------------------------------------------------------------

// A resolved db command: the tool bin (resolved CONSUMER-local at run time) and
// its argument vector.
export interface DbCommand {
  args: string[];
  tool: string;
}

// The inferred db task set:
//   - `mode` — "none" (no db capability) or "single" (drizzle → short names).
//   - `tasks` — the resolvable task name → its command. Keys are the short
//     `db:*` names, each mapping to drizzle-kit.
export interface DbTaskSet {
  mode: "none" | "single";
  tasks: Map<string, DbCommand>;
}

// The drizzle-kit task suffix → args map. Every command is `drizzle-kit <args>`.
const DRIZZLE_TASKS: Record<string, string[]> = {
  check: ["check"],
  generate: ["generate"],
  migrate: ["migrate"],
  push: ["push"],
  studio: ["studio"],
};

// Infer the db task set from the detected capabilities (pure). `drizzle` fires on
// drizzle-orm/drizzle-kit (see detect.ts) — the ONLY db tool, so the SHORT `db:*`
// names always map to drizzle-kit. No drizzle → an empty set (mode "none").
export function dbTasks(capabilities: string[]): DbTaskSet {
  const tasks = new Map<string, DbCommand>();

  if (capabilities.includes("drizzle")) {
    for (const [name, args] of Object.entries(DRIZZLE_TASKS)) {
      tasks.set(`db:${name}`, { args, tool: "drizzle-kit" });
    }
    return { mode: "single", tasks };
  }

  return { mode: "none", tasks };
}

// The `dobby update` command: taze in interactive mode, resolved from DOBBY's OWN
// dependency tree (taze is bundled, not a consumer dep) and run with inherited
// stdio. The pure part is just the argument vector; `lifecycle.ts` resolves the
// bundled bin and spawns it.
export const UPDATE_ARGS: readonly string[] = ["--interactive"];

// ---------------------------------------------------------------------------
// Capability-aware usage (help) inference
//
// `usageCommands(capabilities)` returns the SUBSET of the `dobby` Commands list
// that applies to a repo — pure data, no rendering (`run.ts` lays it out into the
// aligned help text and the unknown-command error). This is the fix for the field
// report: the static help advertised dev/up/down/db:* in repos that have neither a
// vite nor a db capability. The filter:
//   - UNIVERSAL commands are ALWAYS present: env, check, update. (`setup` is folded
//     into `up`'s setup phase — no standalone command — so it is not advertised.)
//   - dev / up / down / build appear ONLY with the `vite` capability. `up` is the
//     single lifecycle entry point (prepare + run), so its description covers both;
//     `build` is the inferred Vercel buildCommand (`bunx dobby build`).
//   - db:* entries appear ONLY with a db capability, each carrying its ACTUAL
//     resolved task name (the short `db:push` / `db:studio` / … drizzle names) and
//     the concrete shell command it runs — sourced from the SAME `dbTasks` map the
//     executor resolves.
// Order mirrors the pre-filter help: env, check, [dev, up, down], [db:*…], update.
// ---------------------------------------------------------------------------

// One entry in the `dobby` usage Commands list: the command token as the user
// types it plus a one-line description. `run.ts` renders these into aligned
// columns; the capability filter lives in `usageCommands` (this module).
export interface UsageCommand {
  description: string;
  name: string;
}

export function usageCommands(capabilities: string[]): UsageCommand[] {
  const commands: UsageCommand[] = [
    { description: "Print a snapshot of the working environment", name: "env" },
    {
      description:
        "Run the quality gate (biome, tsc, knip, build, test); file args = biome-only fast path",
      name: "check [file...]",
    },
  ];

  // dev / up / down — the run lifecycle, gated on a runnable app (the vite capability).
  if (capabilities.includes("vite")) {
    commands.push(
      {
        description:
          "Run the app: the portless-wrapped dev server + concurrent secondaries",
        name: "dev",
      },
      {
        description:
          "Prepare + run the workspace (idempotent): the setup phase (install, worktree copies, setup[] extras) then a liveness-first run (cmux panes or a detached run, neon branch isolation)",
        name: "up",
      },
      {
        description:
          "Tear the run down: close panes, kill the run, delete the neon branch, teardown[] extras",
        name: "down",
      },
      {
        description:
          "Build the app (vite build) — the inferred Vercel buildCommand (`bunx dobby build`)",
        name: "build",
      }
    );
  }

  // db:* — only when a db capability resolves tasks; the ACTUAL resolved names.
  for (const [name, command] of dbTasks(capabilities).tasks) {
    commands.push({ description: describeDbCommand(command), name });
  }

  commands.push({
    description: "Update dependencies interactively (taze)",
    name: "update",
  });

  return commands;
}

// The concrete shell command a resolved db task runs, as one line. Mirrors
// `run.ts`'s dry-run db plan line, reused here so the help shows exactly what each
// db:* task executes.
function describeDbCommand(command: DbCommand): string {
  return `${command.tool} ${command.args.join(" ")}`.trimEnd();
}

// ---------------------------------------------------------------------------
// Share (ngrok tunnel) decision — PURE (the probe is IMPURE, in lifecycle.ts).
//
// The ngrok tunnel is ON BY DEFAULT (a maintainer decision): `dobby dev`/`dobby up`
// wrap the app in `portless run --ngrok …` so it is reachable from the maintainer's
// phone. `--no-share` opts out. Because share is the DEFAULT, a machine WITHOUT the
// `ngrok` binary must not lose its bring-up: it DEGRADES — dropping `--ngrok` and
// surfacing ONE note — never failing. The ngrok-present fact is discovered by an
// IMPURE probe (`ngrokAvailable`, lifecycle.ts); this decision takes that fact as
// DATA so it stays pure and both branches are deterministically testable.
// ---------------------------------------------------------------------------

// The single note surfaced when share was requested (the default) but the `ngrok`
// binary is missing — dobby degraded to no tunnel. Names the two one-time fixes.
const SHARE_OFF_NOTE =
  "share: off (ngrok not installed — https://ngrok.com/download + ngrok config add-authtoken)";

// The resolved share decision consumed by the dev/up executors:
//   - `ngrok` — whether `--ngrok` is ACTUALLY applied (share requested AND ngrok present).
//   - `note`  — the degrade note when share was requested but ngrok is missing, else null.
export interface ShareDecision {
  ngrok: boolean;
  note: string | null;
}

// Decide the share outcome from the requested intent + the (impurely probed) ngrok
// presence. Opted out (`share=false`) → no tunnel, no note. Requested + ngrok present
// → tunnel on. Requested + ngrok absent → DEGRADE (no tunnel, the one note). Pure.
export function shareDecision(
  share: boolean,
  ngrokPresent: boolean
): ShareDecision {
  if (!share) {
    return { ngrok: false, note: null };
  }
  if (ngrokPresent) {
    return { ngrok: true, note: null };
  }
  return { ngrok: false, note: SHARE_OFF_NOTE };
}

// ---------------------------------------------------------------------------
// `dobby dev` composition inference
//
// `devPlan(capabilities, config)` maps the DETECTED capabilities to the ordered
// `dobby dev` plan — pure data, no spawning. `lifecycle.ts` executes it (main +
// secondaries as one managed process group) and `run.ts` renders it for `--dry-run`.
//
// The composition (spec Decision "one command, one pane"):
//   - `main`        — the app dev server, present ONLY for a vite app (null with no
//     vite → the no-app gate). Its `cacheClears` (`rm -rf node_modules/.vite`,
//     admin's preamble, now inferred for every vite dev) run first, then `command`
//     (`vite dev`) is spawned WRAPPED in `portless run` — portless wraps ONLY the
//     main process (never the secondaries).
//   - `secondaries` — concurrent, spawned alongside the main: `email dev --dir
//     src/emails` for a react-email project (the canonical emails dir is a spec
//     Decision), the only secondary. Consumer-local bins, un-wrapped.
// ---------------------------------------------------------------------------

// One command in the dev plan: a tool + argument vector (mirrors `DbCommand`). In
// the plan these carry LOGICAL tool names (`vite`, `email`, `rm`); `lifecycle.ts`
// resolves the real bin (consumer-local for the app/email tools, DOBBY-bundled for
// portless) at spawn time. `run.ts` renders them for the dry-run plan without ever
// resolving a bin.
export interface DevCommand {
  args: string[];
  tool: string;
}

// The main dev process: the cache-clears that precede it and the app-dev command
// that is spawned wrapped in `portless run`. Internal to `DevPlan` (structural —
// no caller names it), so it stays un-exported.
interface DevMain {
  cacheClears: DevCommand[];
  command: DevCommand;
}

// The ordered `dobby dev` plan. `main` is null for a project with no app (no vite)
// — the executor turns that into the "nothing to run" gate.
export interface DevPlan {
  main: DevMain | null;
  secondaries: DevCommand[];
}

// Infer the `dobby dev` plan from the detected capabilities (pure). `config` is
// part of the signature for forward-compat (per-project dev extras) but v1 has NO
// config-driven dev behavior, so the composition is a pure function of the
// capabilities; the config presence is only echoed back for callers that thread it.
export function devPlan(
  capabilities: string[],
  _config: DobbyConfig | null
): DevPlan {
  // The app main exists ONLY for a vite project. `.vite` cache-clear first, then the
  // vite dev command (wrapped in `portless run` by the renderer/executor).
  const main: DevMain | null = capabilities.includes("vite")
    ? {
        cacheClears: [{ args: ["-rf", "node_modules/.vite"], tool: "rm" }],
        command: { args: ["dev"], tool: "vite" },
      }
    : null;

  const secondaries: DevCommand[] = [];
  if (capabilities.includes("react-email")) {
    secondaries.push({ args: ["dev", "--dir", "src/emails"], tool: "email" });
  }

  return { main, secondaries };
}
