# @kvnwolf/dobby

A **zero-config toolchain + environment-aware run lifecycle** for Bun + Vite/TanStack apps — the mechanical layer of the [dobby](https://github.com/kvnwolf/dobby) kit.

`@kvnwolf/dobby` is a single dev dependency that gives a project a strict, opinionated toolchain (biome, tsc, knip) and a set of environment-aware lifecycle commands (`dev`, `up`, `down`, `db:*`) — all inferred from what the repo actually declares. You install one package, extend two thin config files, and get a consistent quality gate and run lifecycle with no per-project wiring.

The kit's skills (agents, hooks, workflows) call this CLI; you can also run it directly.

## Install

```sh
bun add -d @kvnwolf/dobby
```

That is the whole install — a single devDependency. The bundled toolchain (biome, tsc via `typescript`, knip, taze, portless, ultracite) ships transitively, so consumers install nothing else.

## Thin config

Two small config files `extends` the central presets — you get centralized rules plus native editor support (your editor reads the same tsconfig/biome your gate does):

`tsconfig.json`

```json
{ "extends": "@kvnwolf/dobby/tsconfig" }
```

`biome.jsonc`

```jsonc
{ "extends": ["@kvnwolf/dobby/biome/react"] }
```

The exported presets:

| Import | What it is |
| --- | --- |
| `@kvnwolf/dobby/tsconfig` | The strict bundler TypeScript base (`strict`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`, `allowImportingTsExtensions`, `noEmit`, `module: preserve`, `moduleResolution: bundler`, …). |
| `@kvnwolf/dobby/tsconfig/vite` | The vite-app tsconfig variant — extends the base and adds `types: ["vite/client"]`. |
| `@kvnwolf/dobby/biome/core` | Biome preset extending `ultracite/biome/core` (framework-agnostic). |
| `@kvnwolf/dobby/biome/react` | Biome preset extending both `ultracite/biome/core` and `ultracite/biome/react`. |
| `@kvnwolf/dobby/vite` | The universal Vite app config — native tsconfig path aliases (`resolve.tsconfigPaths`, vite@8) + `server.allowedHosts: true` (portless serves through per-worktree custom hostnames). No plugins — you merge yours on top. |
| `@kvnwolf/dobby/vitest` | The universal Vitest base — inlines `zod` (so vitest-under-bun can't mangle its export map) and excludes `.claude/**`. A default-exported config you merge your app-specific bits onto. |
| `@kvnwolf/dobby/vitest/react` | The React-app Vitest variant — the base plus `@vitejs/plugin-react`, native tsconfig paths, and import-time env loading (`loadEnv`). Lives apart from the base so the base stays importable without Vite. |
| `@kvnwolf/dobby/drizzle` | The house drizzle-kit config — unpooled URL for DDL, `postgresql` dialect, migrations out at `./drizzle`, schema globbed from co-located `src/**/schema.ts` + `schema.gen.ts`. |

The tsconfig and Biome presets are `extends` targets; the Vite/Vitest/drizzle presets are config objects you re-export or merge onto.

**`tsconfig.json`** (a Vite app) — extend the vite variant, keeping only your `paths`/`include`:

```json
{ "extends": "@kvnwolf/dobby/tsconfig/vite", "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }
```

**`vite.config.ts`** — merge your app plugins onto the dobby base:

```ts
import { defineConfig, mergeConfig } from "vite";
import dobbyVite from "@kvnwolf/dobby/vite";

export default mergeConfig(dobbyVite, defineConfig({ plugins: [/* app plugins */] }));
```

**`vitest.config.ts`** — a config object, so you merge (never `extends`). A React app with no extra deltas is one line:

```ts
export { default } from "@kvnwolf/dobby/vitest/react";
```

Reach for `mergeConfig` only when you have real deltas (non-React apps merge onto `@kvnwolf/dobby/vitest`, the base):

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import dobbyVitest from "@kvnwolf/dobby/vitest";

export default mergeConfig(
  dobbyVitest,
  defineConfig({
    // your app-specific plugins / test.env / resolve go here
  }),
);
```

**`drizzle.config.ts`** — re-export when your repo matches the house convention (unpooled env names + co-located schema globs); spread-and-override for deltas:

```ts
export { default } from "@kvnwolf/dobby/drizzle";
```

## Commands

> The `dobby` help output is **capability-filtered per repo**: `dobby` (no args) prints only the commands that apply to the current project's detected capabilities (a repo with no vite capability hides `dev`/`up`/`down`; a repo with no database capability hides `db:*`). This README documents the **full** surface; the live help shows only the applicable subset.

### `dobby env`

Print a snapshot of the working environment — worktree root, branch, cmux workspace, detected capabilities, config presence, dev URL, and kit pane refs. Every fact is resolved locally (no network) and `env` never fails.

```sh
dobby env             # key: value text
dobby env --json      # the same facts as one JSON object
```

### `dobby check [file...]`

Run the quality gate. With no arguments it runs the full pipeline: biome, tsc, knip, then a capability-gated build (vite) and test (vitest), then any `checks[]` extras. Selective flags subset the pipeline; file arguments run a biome-only fast path over just those files.

```sh
dobby check                    # full gate
dobby check --fix              # apply biome's safe fixes first, then run the gate
dobby check --lint             # biome only
dobby check --types            # tsc only
dobby check --unused           # knip only
dobby check --build --test     # only the build + test steps
dobby check src/app.tsx        # biome-only fast path over one file
dobby check src/app.tsx --fix  # fix just that file, then report
dobby check --hook             # edit-time PostToolUse mode (payload on stdin)
```

`--fix` applies biome's **safe** fixes across the whole tree first (`biome check --write` — never the unsafe rewrites), then runs the selected pipeline and reports whatever remains. It composes with the selective flags (`--fix --lint` = fix then lint-report) and, with file arguments, fixes just those files.

**Run `bunx dobby check --fix` before committing — it IS the pre-commit gate.** dobby ships no `commit` command: the pre-commit standard in every project is to run the quality gate first (with `--fix`, so formatting the edit hook never reached is applied automatically), and whoever commits — a human, a script, or the kit's own `/dobby:commit` skill — runs it before the git/gh ceremony.

`--hook` reads a PostToolUse payload from stdin, applies biome's safe auto-fixes to the edited file in place, and surfaces only unfixable findings (exit 2, findings on stderr). This is what the plugin's edit hook invokes.

The **test step runs your vitest under `node`** whenever a usable `node` is on the machine (falling back to the current runtime otherwise), so a `bunx dobby check` doesn't run your suite under bun — bun's module runner can mis-resolve some dependencies' export maps (e.g. `zod`), which the [`@kvnwolf/dobby/vitest`](#thin-config) preset also guards against by inlining `zod`. Only the vitest spawn is affected; a failure under the fallback runtime is annotated with the runtime it used.

### `dobby dev`

Run the app: the `vite dev` server wrapped in `portless run`, plus concurrent secondaries (`email dev --dir src/emails` for a react-email project). Listed only for a repo with the vite capability.

```sh
dobby dev
dobby dev --dry-run       # print the resolved plan without spawning
```

### `dobby up` / `dobby down`

**`dobby up` is the single lifecycle entry point — it prepares and runs the workspace, idempotently.** It runs a **setup phase** first — `bun install`, then (in a linked git worktree) re-materializing files listed in `.worktreeinclude` from the main checkout, then any `setup[]` extras (fail-fast) — and only once that succeeds does it **run** the app: provisioning an isolated Neon branch when the repo has the neon capability, starting the run (cmux panes or a detached background run), and waiting for liveness. Under cmux, `up` also renames the **cmux workspace** to the goal slug (the workspace title becomes the goal identity, distinct from the `dobby-`prefixed pane names) so you can tell at a glance which workspace belongs to which goal — this happens whenever cmux is present, even for a repo with no app to run. Because the run is liveness-first, re-running `up` on an already-live workspace is a no-op — idempotent. A repo with no app to run (no vite capability) still runs the full setup phase, then reports `no app to run` and exits 0.

`dobby down` is the counterpart teardown: it closes the panes, kills the run, deletes the Neon branch, and runs `teardown[]` extras. Both are listed only for a repo with the vite capability.

```sh
dobby up                  # prepare (setup phase) + run the workspace
dobby up --dry-run        # print the FULL ordered plan (setup phase + run phase)
dobby down
dobby down --dry-run
```

### `dobby db:*`

Inferred database tasks, listed only when the repo has the `drizzle` capability. drizzle is the one database tool, so the short names always map to `drizzle-kit`: `dobby db:generate`, `dobby db:migrate`, `dobby db:push`, `dobby db:check`, `dobby db:studio`.

```sh
dobby db:push
dobby db:studio
dobby db:push --dry-run   # print the resolved command without spawning
```

### `dobby update`

Update dependencies interactively (`taze --interactive`).

```sh
dobby update
```

## Conventions

`@kvnwolf/dobby` fixes canonical paths rather than taking per-project arguments:

- **React email templates** live in `src/emails` (`dobby dev` starts `email dev --dir src/emails`).
- **Neon credentials** are read from `.env.local`: both `NEON_API_KEY` and `NEON_PROJECT_ID` must be present for a repo with the neon capability, or `dobby up` fails hard (there is no silent fallback to the main database).

## `dobby.config.json`

An optional file at the repo root. Every field is optional — its presence marks the repo as a dobby project. It carries doc-sync rules plus extras that run **in addition to** the inferred defaults:

```json
{
  "files": [
    { "path": "README.md", "update_when": ["cli/src/**"] }
  ],
  "setup": ["bun run build:wasm"],
  "teardown": ["docker compose down"],
  "checks": [
    { "name": "spec", "run": "bun run spec" }
  ]
}
```

| Field | Purpose |
| --- | --- |
| `files` | Doc-sync rules — which docs to review when matched paths change (skill-consumed). |
| `setup` | Extra commands appended after `bun install` in `dobby up`'s setup phase. |
| `teardown` | Extra commands run by `dobby down`. |
| `checks` | Extra shell checks appended to the full `dobby check` gate. |

## Inferred defaults per capability

The command surface is inferred from what the repo declares (`dependencies ∪ devDependencies`). Detected capabilities drive the defaults:

| Capability | Signal | Enables |
| --- | --- | --- |
| `vite` | `vite` | `dobby dev` / `up` / `down`; the `check` build step |
| `vitest` | `vitest` | the `check` test step |
| `drizzle` | `drizzle-orm` / `drizzle-kit` | `db:*` drizzle-kit tasks |
| `neon` | `@neondatabase/serverless` | `up`/`down` Neon branch-per-worktree isolation |
| `react-email` | `react-email` / `@react-email/*` | `email dev --dir src/emails` secondary in `dobby dev` |

Run `dobby env` to see the capabilities detected for your repo.

## License

MIT
