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
export default defineConfig({
	test: {
		// vitest-under-bun's module runner mangles zod v4's dual export map
		// (z.enum → undefined); inlining lets Vite resolve it instead.
		server: { deps: { inline: ["zod"] } },
		// .claude/ holds full worktree copies whose tests would be double-discovered.
		exclude: [...configDefaults.exclude, ".claude/**"],
	},
});
