import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";
import dobbyVitest from "./vitest.base.mjs";

// Shipped as plain .mjs, never .ts: a consumer's vitest config re-exports this
// preset and Node loads the file at runtime — but Node ≥23 refuses to type-strip
// .ts files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). .mjs
// loads natively everywhere (node, bun, esbuild loaders).
//
// The react-app vitest variant (@kvnwolf/dobby/vitest/react), layered on the
// universal base. A react-app consumer with no extra deltas writes ONE line:
//   export { default } from "@kvnwolf/dobby/vitest/react";
// and only reaches for mergeConfig when it has REAL deltas (e.g. a mid-migration
// server.deps.inline addition):
//   import { defineConfig, mergeConfig } from "vitest/config";
//   import dobbyVitestReact from "@kvnwolf/dobby/vitest/react";
//   export default mergeConfig(dobbyVitestReact, defineConfig({ test: { … } }));
//
// This lives in a SEPARATE file from vitest.base.mjs precisely because it imports
// vite / @vitejs packages: vitest.base.mjs must stay importable in repos WITHOUT
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
  })
);
