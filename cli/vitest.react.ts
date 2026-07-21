import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";
import dobbyVitest from "./vitest.base.ts";

// The react-app vitest variant (@kvnwolf/dobby/vitest/react), layered on the
// universal base. A react-app consumer with no extra deltas writes ONE line:
//   export { default } from "@kvnwolf/dobby/vitest/react";
// and only reaches for mergeConfig when it has REAL deltas (e.g. a mid-migration
// server.deps.inline addition):
//   import { defineConfig, mergeConfig } from "vitest/config";
//   import dobbyVitestReact from "@kvnwolf/dobby/vitest/react";
//   export default mergeConfig(dobbyVitestReact, defineConfig({ test: { … } }));
//
// This lives in a SEPARATE file from vitest.base.ts precisely because it imports
// vite / @vitejs packages: vitest.base.ts must stay importable in repos WITHOUT
// vite installed (dobby's own repo). All three resolve from the CONSUMER's tree.
export default mergeConfig(
	dobbyVitest,
	defineConfig({
		// Test plugins ≠ app plugins — never the SSR set (which would start
		// servers that never tear down and hang the run).
		plugins: [react()],
		// vite@8 native tsconfig path-alias resolution.
		resolve: { tsconfigPaths: true },
		// "" prefix loads EVERY var: house apps validate the full env at import
		// time (src/lib/env.ts), so the test run needs all of it.
		test: { env: loadEnv("test", process.cwd(), "") },
	}),
);
