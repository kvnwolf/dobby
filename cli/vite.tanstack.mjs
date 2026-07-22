import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, mergeConfig } from "vite";
import dobbyVite from "./vite.base.mjs";

// The house TanStack Start app stack (@kvnwolf/dobby/vite/tanstack-start), layered
// on the universal vite base. A no-delta consumer needs NO vite.config.ts AT ALL:
// `dobby dev` / `dobby build` / `dobby check` pass `--config` pointing at this
// preset when the consumer's file is absent (wired by the CLI). A consumer WITH
// deltas writes its own vite.config.ts with mergeConfig on top:
//   import { defineConfig, mergeConfig } from "vite";
//   import dobbyTanstack from "@kvnwolf/dobby/vite/tanstack-start";
//   export default mergeConfig(dobbyTanstack, defineConfig({ /* app deltas */ }));
//
// Shipped as plain .mjs, never .ts (Node ≥23 refuses to type-strip .ts under
// node_modules — the same reason the other preset .mjs files carry a sibling
// .d.mts). Every plugin package resolves from the CONSUMER's tree at config-load
// time — same rule as vitest.react.mjs; NONE is a dobby dependency (the dual-Vite
// invariant). `routeFileIgnorePattern` encodes the house test-co-location
// convention: `*.test.*` files live beside routes and must not be treated as ones.
export default mergeConfig(
	dobbyVite,
	defineConfig({
		plugins: [
			devtools(),
			tailwindcss(),
			tanstackStart({ router: { routeFileIgnorePattern: "\\.test\\." } }),
			nitro(),
			viteReact(),
		],
	}),
);
