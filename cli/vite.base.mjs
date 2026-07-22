import { defineConfig } from "vite";

// Shipped as plain .mjs, never .ts: a consumer's vite config re-exports this
// preset and Node loads the file at runtime — but Node ≥23 refuses to type-strip
// .ts files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
// which would break every preset-consuming repo under `dobby check`. .mjs loads
// natively everywhere (node, bun, esbuild loaders).
//
// Universal dobby vite-app config (@kvnwolf/dobby/vite). Consumers merge their
// own plugins on top — plugins are consumer-owned AND version-coupled, so they
// never live here:
//   import { defineConfig, mergeConfig } from "vite";
//   import dobbyVite from "@kvnwolf/dobby/vite";
//   export default mergeConfig(dobbyVite, defineConfig({ plugins: [/* app plugins */] }));
//
// `vite` resolves from the CONSUMER's tree at config-load time (dobby lives
// inside the consumer's node_modules); vite is NEVER a dobby dependency (the
// dual-Vite invariant — a bundled second copy would clash with the consumer's
// plugins).
export default defineConfig({
  // vite@8 resolves tsconfig path aliases natively — never the
  // vite-tsconfig-paths plugin (vitest itself warns to remove it).
  resolve: { tsconfigPaths: true },
  // portless serves the app through per-worktree custom hostnames; vite must
  // accept them. This key is dobby-lifecycle-coupled — that is WHY it's preset,
  // not a consumer delta.
  server: { allowedHosts: true },
});
