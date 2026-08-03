import { configDefaults, defineConfig } from "vitest/config";

// Shipped as plain .mjs, never .ts: a consumer's vitest config re-exports this
// preset and Node loads the file at runtime — but Node ≥23 refuses to type-strip
// .ts files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
// which would break every preset-consuming repo under `dobby check` (the gate now
// runs vitest under node-if-present). .mjs loads natively everywhere.
//
// Universal dobby test wiring. Consumers merge app-specific bits on top:
//   import { defineConfig, mergeConfig } from "vitest/config";
//   import dobbyVitest from "@kvnwolf/dobby/vitest";
//   export default mergeConfig(dobbyVitest, defineConfig({ plugins: [...], test: { env: ... } }));
//
// Kept data-minimal on purpose: NO plugins, NO env loading, NO resolve options —
// those are consumer-specific and belong in the merged-on config, not here.
// `vitest/config` resolves from the CONSUMER's tree (dobby lives inside the
// consumer's node_modules); vitest is NEVER a dobby dependency (dual-Vite invariant).

// The per-test and per-hook ceilings, raised from vitest's defaults (5s / 10s).
// A dobby-ecosystem test routinely SPAWNS real tools — git, biome, tsc, the CLI
// itself — inside a scratch repo it builds in a `beforeAll`, and the gate runs
// every such suite in PARALLEL across the machine's cores: under that contention
// a spawn-heavy case that finishes in under a second on its own can sit for tens
// of seconds waiting for a core, and vitest's default would kill it and report a
// stack-trace error that looks like a product bug. This is a CEILING, not a
// target — a test that legitimately needs two minutes is a broken test; the
// number exists so the gate reports REAL failures instead of scheduling noise.
const SPAWN_TIMEOUT_MS = 120_000;

export default defineConfig({
  test: {
    // .claude/ holds full worktree copies whose tests would be double-discovered.
    exclude: [...configDefaults.exclude, ".claude/**"],
    hookTimeout: SPAWN_TIMEOUT_MS,
    // vitest-under-bun's module runner mangles zod v4's dual export map
    // (z.enum → undefined); inlining lets Vite resolve it instead.
    server: { deps: { inline: ["zod"] } },
    testTimeout: SPAWN_TIMEOUT_MS,
  },
});
