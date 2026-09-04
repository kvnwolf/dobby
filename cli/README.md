# @kvnwolf/dobby

A **zero-config toolchain + environment-aware run lifecycle** for Bun + Vite/TanStack apps — the mechanical layer of the [dobby](https://github.com/kvnwolf/dobby) kit.

`@kvnwolf/dobby` is a single dev dependency that gives a project a strict, opinionated toolchain (biome, tsc, knip) and a set of environment-aware lifecycle commands (`dev`, `build`, `up`, `down`, `db:*`) — all inferred from what the repo actually declares. You install one package and get a consistent quality gate and run lifecycle with **no per-project wiring** — dobby ships every tool config as a default, so a delta-less repo carries only `package.json`, `tsconfig.json`, and (optionally) `dobby.config.json`.

On top of that it mechanizes the ceremonies a project repeats forever — committing (`ship`), releasing (`release`), reviewing a PR (`review` / `pr watch`), and the session bookkeeping the [dobby](https://github.com/kvnwolf/dobby) kit runs on (`state`, `build-plan`, the preflights, the tracker/KB/ADR writers, the artifact linters). Each is one call with a JSON answer, so the rules those steps carry live in the command instead of in a runbook.

The kit's skills (agents, hooks, workflows) call this CLI; you can also run it directly.

## Install

```sh
bun add -d @kvnwolf/dobby
```

That is the whole install — a single devDependency. The bundled toolchain (biome, tsc via `typescript`, knip, taze, portless, ultracite) ships transitively, so consumers install nothing else.

## Config-less by default (override by presence)

For every tool **only dobby invokes** — biome, knip, vitest, vite, drizzle-kit — dobby passes its shipped preset through the tool's native config flag **when you have no config file of your own**. You never pass config paths; dobby resolves them. A config file, when present, is a **total override** (never merged): the tool's own discovery finds it and dobby stays out of the way. So you write a tool config **only for deltas** — creating the file instantly overrides the default, deleting it restores it.

| Tool | Your override file (any of) | dobby's default when absent |
| --- | --- | --- |
| biome | `biome.json` / `biome.jsonc` | `@kvnwolf/dobby/biome/react` (react apps) or `/biome/core` |
| knip | `knip.json` / `knip.jsonc` / `knip.ts` / `package.json#knip` | `@kvnwolf/dobby`'s `knip.base.jsonc` |
| vitest | `vitest.config.{ts,mts,cts,js,mjs,cjs}` | `@kvnwolf/dobby/vitest/react` (react apps) or `/vitest` |
| vite | `vite.config.{ts,mts,js,mjs}` | `@kvnwolf/dobby/vite/tanstack-start` (tanstack apps) or `/vite` |
| drizzle-kit | `drizzle.config.{ts,mts,js,mjs}` | `@kvnwolf/dobby/drizzle` |

`dobby check` prints a `configs:` note naming which defaults were active (`configs: biome=default(react) · knip=default`), and the `dev` / `build` / `db:*` `--dry-run` plans render the resolved `--config <path>` — so override-by-presence is always visible, never silent.

**The one file that always stays is `tsconfig.json`** — not for editors, but because other tools read it directly (vite's `resolve.tsconfigPaths`, `tsc`) and it carries genuinely per-project `paths`. Extend the central base:

`tsconfig.json`

```json
{ "extends": "@kvnwolf/dobby/tsconfig" }
```

## Presets (for when you DO have deltas)

When you need deltas, `extends` (tsconfig/biome) or `mergeConfig`/re-export (vite/vitest/drizzle) the central presets:

| Import | What it is |
| --- | --- |
| `@kvnwolf/dobby/tsconfig` | The strict bundler TypeScript base (`strict`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`, `allowImportingTsExtensions`, `noEmit`, `module: preserve`, `moduleResolution: bundler`, …). |
| `@kvnwolf/dobby/tsconfig/vite` | The vite-app tsconfig variant — extends the base and adds `types: ["vite/client"]`. |
| `@kvnwolf/dobby/biome/core` | Flat Biome preset — ultracite's core config vendored verbatim + dobby's mods (framework-agnostic). |
| `@kvnwolf/dobby/biome/react` | Flat Biome preset — ultracite's react config vendored + dobby's mods, including a **built-in `src/routes/**` override** for TanStack Router (relaxes `useFilenamingConvention` + `useSortedKeys`, which the router's route-file shapes and `head()`/`loader` order require) that you no longer hand-write, plus the **house convention rules** (see below). React apps extend BOTH core and react (biome's `extends` is one-level / non-transitive, so each preset is flat and stands alone). The **GritQL structural rules** are the one part that does NOT travel through `extends` — see below. |
| `@kvnwolf/dobby/vite` | The universal Vite app config — native tsconfig path aliases (`resolve.tsconfigPaths`, vite@8) + `server.allowedHosts: true` (portless serves through per-worktree custom hostnames). No plugins — you merge yours on top. |
| `@kvnwolf/dobby/vitest` | The universal Vitest base — inlines `zod` (so vitest-under-bun can't mangle its export map) and excludes `.claude/**`. A default-exported config you merge your app-specific bits onto. |
| `@kvnwolf/dobby/vitest/react` | The React-app Vitest variant — the base plus `@vitejs/plugin-react`, native tsconfig paths, and import-time env loading (`loadEnv`). Lives apart from the base so the base stays importable without Vite. |
| `@kvnwolf/dobby/drizzle` | The house drizzle-kit config — unpooled URL for DDL, `postgresql` dialect, migrations out at `./drizzle`, schema globbed from co-located `src/**/schema.ts` + `schema.gen.ts`. |

The tsconfig and Biome presets are `extends` targets; the Vite/Vitest/drizzle presets are config objects you re-export or merge onto.

**`tsconfig.json`** (a Vite app) — extend the vite variant, keeping only your `paths`/`include`:

```json
{ "extends": "@kvnwolf/dobby/tsconfig/vite", "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }
```

**`biome.jsonc`** — only when you need lint/format deltas. Biome's `extends` is **one-level (non-transitive)**, so the presets ship flat (ultracite vendored in, not re-extended) and a **React app extends BOTH**; a non-React app extends just core:

```jsonc
{ "extends": ["@kvnwolf/dobby/biome/core", "@kvnwolf/dobby/biome/react"] }
```

The react preset already ships the TanStack Router `src/routes/**` override (relaxing `useFilenamingConvention` + `useSortedKeys` where the router owns the file shapes and `head()`/`loader` order) — it travels through `extends`, so you don't hand-write it. The preset also turns off a small house set of rules whose cost exceeds their value for AI-written code (`noUnnecessaryConditions`, `noVoid`, `noNamespaceImport`, `noAwaitInLoops`, `noArrayIndexKey`, `noJsxPropsBind`) and excludes `**/*.css` (biome's CSS parser rejects Tailwind 4 `@apply`/`@theme`).

**House convention rules (react preset only).** The react preset also enforces the house stack's own conventions as native Biome rules, each failing with the house alternative rather than a bare ban — so a non-React consumer (core only) never sees them:

| Rule | What it enforces | Where it's lifted |
| --- | --- | --- |
| `noProcessEnv` (on; core ships it off) | App code reads validated env from `@/shared/env`. | The env module itself (`src/shared/env.ts` / `src/lib/env.ts`) plus `src/router.tsx`, `drizzle.config.ts`, `src/emails/**/*.tsx` — the three files that load outside Vite. |
| `noRestrictedImports` → `@tanstack/react-form` | Forms use `useAppForm`, never the raw hooks. | `src/shared/**` (the module that wraps them). |
| `noRestrictedImports` → `@tanstack/react-db` | Collection reads go through `<LiveQuery>`, never `useLiveQuery`/`useLiveSuspenseQuery`. | `src/shared/**`. |
| `noRestrictedImports` → `@/shared/db.server` | Only the `db` instance comes out of it; tables are imported from their owner module. | — (in `src/routes/**` the module is banned outright). |
| `noRestrictedImports` → `getDb`/`getAuth`/`getResend` | Eager, never lazy — there is no accessor to import. | — |
| `noRestrictedImports` under `src/routes/**` | Route files own page UI only: no `*.server` module, `@/shared/db.server`, `drizzle-orm`, `better-auth`, `pg` or `@neondatabase/serverless`. | — |

A Biome override **replaces** a rule's options rather than merging them, so the `src/shared/**` and `src/routes/**` scopes restate every ban that still applies there — keep that in mind if you override `noRestrictedImports` in your own `biome.jsonc` (yours replaces the preset's options wholesale).

**Structural convention rules (GritQL plugins).** Conventions no native Biome rule can express — the `field.Root`/`Label`/`Control`/`ErrorMessage` anatomy, a `form.Root` nested inside `DialogContent` instead of its `render` prop, a raw `useLiveQuery` **call** outside `src/shared`, an eager server instance outside a `.server` file, a `.browser` file value-importing a `.server` module, a bare `@/module` barrel import, … — ship as GritQL plugins in `@kvnwolf/dobby`'s `grit/` directory. They are **on by default for a config-less React app** (dobby points `--config-path` at its own wrapper, which declares them), and each reports at `error` severity with the house alternative in the message.

They are **not** carried by `extends`: Biome resolves a plugin path relative to the **root** config — *your* `biome.jsonc` — not to the preset that declares it, so a preset-declared relative path would miss from your project root and abort your whole Biome run. If you ship your own `biome.jsonc` and want them, declare them yourself (paths relative to your config, and adjust for your install layout):

```jsonc
{
  "extends": ["@kvnwolf/dobby/biome/core", "@kvnwolf/dobby/biome/react"],
  "plugins": [
    // the path-scoped ones need their scope restated; the rest are bare paths
    { "path": "node_modules/@kvnwolf/dobby/grit/c15-raw-live-query-hooks.grit", "includes": ["**", "!**/src/shared/**"] },
    "node_modules/@kvnwolf/dobby/grit/c20-incomplete-field-anatomy.grit",
    "node_modules/@kvnwolf/dobby/grit/c21-dialog-form-not-rendered-as-form.grit"
  ]
}
```

The full list, each rule's scope, and the conventions that were deliberately **not** mechanized (with the reason) are in `grit/CONTEXT.md` inside the package.

**Layout convention checks (the `conventions` gate step).** Some conventions are facts about the **filesystem**, not about a file's syntax — a barrel, a generic filename, a type-based bucket directory, a table declared away from its module, a collection with no server function. Biome and the GritQL plugins each see one file's syntax and nothing else, so `dobby check` runs these itself as an extra findings group, `conventions`, alongside biome/tsc/knip. Like the rules above it is **capability-gated** — a `react` or `tanstack-start` project only; a plain library or CLI never sees it — and it has **no config**: the rules ARE the house convention.

| Id | What it flags |
| --- | --- |
| `B1` | An `index.ts`/`index.tsx` barrel under `src/` (`src/routes/**` exempt — a route index is not a barrel). |
| `B2` | A generic, role-less filename: `service` · `db` · `lib` · `api` · `actions` · `handlers` · `hooks` · `utils` · `models` · `tables` · `entities`. (Matched on the whole basename, so `db.server.ts` is fine.) |
| `B3` | A `*.client.ts(x)` file — it reads like the mirror of `.server` but nothing enforces it; use `*.browser.ts`. |
| `B4` | A type-based bucket directory: `src/{components,services,hooks,lib,utils}/` or any `-components/`. `src/shared/` is blessed. Full-gate only — the edit hook never blocks an edit on its directory's pre-existing debt. |
| `B5` | A `pgTable(…)` outside its module's `schema.ts`/`schema.gen.ts`, or inside a central `src/schema/` · `src/db/schema/`. |
| `B6` | A `collection.browser.ts` with no sibling `functions.ts` — half the data-fetching recipe. |
| `B7` | A **new** file reading `process.env`/`import.meta.env`, beyond the same exception set `noProcessEnv` lifts for. Comments are stripped first — prose that names the API is not a read. |
| `B8` | A server-only symbol (`betterAuth(`, `new Pool(`, `drizzle(`, `new Resend(`, `neonConfig`) in the built client bundle. Runs only when `.output/public` exists; otherwise the step reports a skip note. It reads the output on disk — on the full gate that is the build this run just made, but if the build step was skipped (no vite) or failed, an older build is what gets scanned. |
| `B9` | A module directory (one holding a role file) with no `CONTEXT.md`. |
| `B10` | A react-email template outside `src/emails/`. |
| `C2` | A `createMiddleware(…)` declared in a `*.server.ts` — server fns and their middlewares live in `functions.ts`. |
| `C3` | A `createServerFn(…)` chain in `functions.ts` with no `.middleware(…)` call at all — a server fn is a public HTTP endpoint and a route guard does not protect it. A deliberately public endpoint is blessed per chain (see the escape hatch below). |
| `C12` | A collection whose `.pick({…})` keys differ from its server fn's `.select({…})` keys. A `db.select(<identifier>)` is resolved to its same-file hoisted `const <identifier> = {…}` projection. |

Findings render as `path:0 B1: …` in the `conventions` group and fail the gate exactly like a lint finding; the edit-time hook reports the ones about the file you just edited (exit 2 on stderr). None is auto-fixable — `dobby check --fix` never rewrites convention code. When a check cannot run (no build output for `B8`, an unreadable projection for `C12`) it reports a **skip note**, never a finding. **Vendored trees are exempt**: nothing under `src/shadcn/**` (or the legacy `src/components/ui/**`) is judged by any of these rules, on the full gate or the edit hook — the same exclusion the biome preset ships. Vendored shadcn code answers to upstream (`src/shadcn/utils.ts` is `components.json`'s own contract), so it needs no `dobby-allow`.

**The escape hatch** — a deliberate exception is annotated at the site with `// dobby-allow <RULE-ID>: <non-empty reason>` (an empty reason is not honored): anywhere in the judged file for a per-file rule, in the comment run directly above the `createServerFn` chain for `C3` (per chain — blessing one public endpoint never covers its neighbour), in the directory's `CONTEXT.md` for `B4`. The full gate counts honored allows in a note so they stay visible. (Biome-tier rules use `// biome-ignore` instead — `lint/<group>/<rule>` for native rules, `lint/plugin/<grit-file-stem>` for the GritQL plugins.)

For a **progressive migration**, use a **denylist**: biome unions `files.includes` across `extends`, so the preset's `**` always applies — you subtract paths to opt out (an allowlist can't survive it, since `"!**"` would exclude everything):

```jsonc
{
  "extends": ["@kvnwolf/dobby/biome/core", "@kvnwolf/dobby/biome/react"],
  "files": { "includes": ["!legacy/**"] }
}
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

> The `dobby` help output is **capability-filtered per repo**: `dobby` (no args) prints only the commands that apply to the current project's detected capabilities (a repo with no vite capability hides `dev`/`up`/`down`; a repo with no database capability hides `db:*`). The [session commands](#session-commands) are never filtered — they are methodology, not stack — except `release`, which is **config-gated** and appears only when `dobby.config.json` declares a `release` key. This README documents the **full** surface; the live help shows only the applicable subset.

### `dobby env`

Print a snapshot of the working environment — worktree root, branch, cmux workspace, kit pane refs, detected capabilities, config presence, inferred `db:*` task names (`dbTasks`), and dev URL. Every fact is resolved locally (no network), and `env` always exits 0.

```sh
dobby env             # key: value text
dobby env --json      # the same facts as one JSON object
```

The JSON object carries `branch`, `browserPane`, `capabilities`, `cmux`, `config`, `dbTasks`, `devUrl`, `runPane`, and `worktree` — nine keys. Every field folds to `null` / `false` / `[]` rather than throwing when its underlying tool or context is absent (no vite capability → `devUrl: null`; no cmux workspace → `browserPane`/`runPane`/`cmux: null`), which is why `env` always exits 0. Agent model/effort/reasoning live in each worker agent's own frontmatter (`plugin/agents/*.md`), not in this payload — there is no fixed recipe object to resolve here. `env` no longer carries a UI-verification field — see `dobby instructions browser` below.

### `dobby instructions <topic>`

The **instruction catalogue** half of the environment seam: for the detected environment (cmux, terminal, Claude Desktop, or t3 code), print what the *model* must do for one topic, because dobby cannot act there on its own behalf. dobby only ever prints the instruction — it never carries it out. `--help` advertises it as a universal command, never capability-filtered.

```sh
dobby instructions start --json     # how to start the dev server here
dobby instructions stop             # how to stop it (text form)
dobby instructions browser --json   # how to drive the UI here
dobby instructions rename           # how to rename the workspace (cmux only)
```

Four topics: `start`, `stop`, `browser`, `rename`. `start`/`stop`/`rename` fail hard outside a git repo (same as every action command); `browser` does not — it degrades to an empty workroot/slug/devUrl and still answers, since QA and a manual-setup gate may need it from outside a resolved worktree. An unknown or missing topic exits 1.

```json
{
  "applies": true,
  "environment": "terminal",
  "text": "Run `bunx dobby dev` from /path/to/worktree as a background task of the host: use Claude Code's Bash tool with the `run_in_background` option set to true. Read the command's early output to confirm the server is booting — a failed command shows its error right there — before re-invoking `bunx dobby up --json` to confirm the app is live. Once confirmed live, the app is reachable at the devUrl `dobby env` reports.",
  "topic": "start"
}
```

`applies: false` means the topic is a valid answer, not an error — nothing here for the model to do (a plain terminal has no workspace to `rename`, and `dobby down` kills the registered process itself, so `stop` never applies there). The text form prints the instruction text and a trailing newline when `applies` is true, and `not applicable in <environment>: <topic> has nothing for the model to do here` at exit 0 otherwise. See [`bring-up.md`](../plugin/skills/execute/references/bring-up.md) for the two-step protocol that consumes `start`/`rename`, and the same file's teardown section for `stop`.

### `dobby check [file...]`

Run the quality gate. With no arguments it runs the full pipeline: biome, tsc, knip, a capability-gated build (vite), the layout convention checks (react / tanstack-start only — the rules are tabled under *Layout convention checks* in [Presets](#presets-for-when-you-do-have-deltas); they come after the build so the bundle check reads what the build just wrote), a capability-gated test (vitest), then any `checks[]` extras. Selective flags subset the pipeline (the conventions step has no flag of its own, so it runs on the full gate only); file arguments run a fast path over just those files — biome plus the convention rules that judge them.

```sh
dobby check                    # full gate
dobby check --fix              # apply biome's safe fixes first, then run the gate
dobby check --lint             # biome only
dobby check --types            # tsc only
dobby check --unused           # knip only
dobby check --build --test     # only the build + test steps
dobby check src/app.tsx        # biome-only fast path over one file
dobby check src/app.tsx --fix  # fix just that file, then report
dobby check --no-cache         # ignore the gate cache — run every step
dobby check --hook             # edit-time PostToolUse mode (payload on stdin)
dobby check --pre-push         # git pre-push backstop mode (ref lines on stdin)
```

`--fix` applies biome's **safe** fixes across the whole tree first (`biome check --write` — never the unsafe rewrites), then runs the selected pipeline and reports whatever remains. It composes with the selective flags (`--fix --lint` = fix then lint-report) and, with file arguments, fixes just those files.

**`dobby check --fix` IS the pre-commit gate**, and [`dobby ship`](#dobby-ship) is the ceremony that runs it for you — in-process, between staging and the commit, so nothing red is ever committed. A human or a script that commits outside `ship` runs `bunx dobby check --fix` before committing; [`check --pre-push`](#dobby-check-file) is the backstop that catches whoever didn't.

**Re-running the gate on an unchanged tree is free.** A project-wide run keys the working tree's non-inert files and, when that exact input set already cleared a full green gate under this dobby version and this `dobby.config.json`, prints

```
gate skipped: inputs unchanged since last green (a1b2c3d4 @ 2026-08-03T09:41:12.004Z)
```

and skips biome/tsc/knip/build/conventions/test — your `checks[]` extras still run (they are arbitrary shell and may read anything), and their verdict is the exit code.

The key is **one content hash over the whole working tree minus a fixed inert set** — tracked plus untracked-but-unignored files, each path paired with its content, taken after `--fix` has rewritten what it is going to rewrite. The inert set is prose and host state only, the files no gate step ever reads: `**/*.md` outside fixture directories, `docs/`, and `.claude/`. Editing one of those never invalidates a green entry; every other file does, `package.json` / lockfile / `.gitignore` included, as do a dobby upgrade and any edit to `dobby.config.json`. Recording is **all or nothing**: only a full gate that actually ran and came out green is remembered (a green `--lint` proves nothing about tsc), and the **last five** green input sets are kept — so flipping between two branches, or reverting an experiment, still hits. A selective flag run is served by a full-green entry but never records one, the per-file fast path and `--hook` never consult it, and **`--no-cache`** ignores an entry and runs everything (a green full gate is still recorded). A repository whose working tree holds something git cannot hand over as a plain file — a checked-out **submodule**, an embedded repository, or a **symlink** — gets no key at all, so the cache is simply off there: git enumerates the link rather than what is behind it, and dobby would rather run the whole gate than vouch for code it could not see. The cache lives in `.dobby/gate-cache.json`, which dobby keeps out of git for you — through `.git/info/exclude`, your repository's own private ignore file, so a check never edits (or creates) a `.gitignore` you would then have to commit. Running the gate leaves your working tree byte for byte as it found it.

**Known limitation:** the key only sees what git can enumerate, so **gitignored env files are invisible to it** — editing `.env.local` (or any other ignored file your build or tests read) does not invalidate a green entry. Re-run with `dobby check --no-cache` after changing one.

`--hook` reads a PostToolUse payload from stdin, applies biome's safe auto-fixes to the edited file in place, and surfaces only unfixable findings (exit 2, findings on stderr). This is what the plugin's edit hook invokes.

`--pre-push` is the **backstop** the git `pre-push` hook (installed by [`dobby up`](#dobby-up--dobby-down)) runs: it reads git's ref lines from stdin, skips deletions, and — unless the pushed tree was already gated green (the cache `dobby ship` writes) — runs the gate over the working tree and refuses the push on findings, printing **all** of them. It never modifies your files (no `--fix` there), and `git push --no-verify` bypasses it.

The **test step runs your vitest under `node`** whenever a usable `node` is on the machine (falling back to the current runtime otherwise), so a `bunx dobby check` doesn't run your suite under bun — bun's module runner can mis-resolve some dependencies' export maps (e.g. `zod`), which the [`@kvnwolf/dobby/vitest`](#presets-for-when-you-do-have-deltas) preset also guards against by inlining `zod`. Only the vitest spawn is affected; a failure under the fallback runtime is annotated with the runtime it used.

### `dobby dev`

Run the app: the `vite dev` server wrapped in `portless run`, plus concurrent secondaries (`email dev --dir src/emails` for a react-email project). Listed only for a repo with the vite capability.

```sh
dobby dev
dobby dev --dry-run       # print the resolved plan without spawning
```

The app runs **local-only**, on the stable portless URL (`dobby env` reports it as `devUrl`). On startup a live `dobby dev` registers itself at `<workroot>/.dobby/dev.pid`, which is what lets `up` find an in-flight start and wait it out instead of handing back another `start` instruction, and what `down` signals to tear the run down; a `dev` that finds a live twin already registered there refuses instead of starting a second server — `already running (pid N) — \`dobby down\` stops it`, exit 1.

### `dobby build`

Build the app: the consumer-local `vite build` (plus the config-less default `--config` when you have no `vite.config`). Listed only for a repo with the vite capability; a repo with no app exits 1 with `nothing to build`.

```sh
dobby build
dobby build --dry-run     # print the resolved plan without spawning
```

**Point your builder at dobby.** `dobby build` is the inferred build command, so external builders build **through** dobby — set your Vercel **Build Command** to:

```
bunx dobby build
```

Building through dobby (rather than a raw framework CLI) means the config-less default and any future build-time niceties apply centrally, with no per-project buildCommand edits.

### `dobby up` / `dobby down`

**`dobby up` prepares the workspace and probes it — it no longer starts anything itself.** It runs a **setup phase** first — `bun install`, then installing the [pre-push backstop](#dobby-check-file) hook (idempotently, into the repository's shared hooks directory, so one install covers every worktree; a `pre-push` hook dobby did not write is reported and left alone), then (in a linked git worktree) re-materializing files listed in `.worktreeinclude` from the main checkout, then any `setup[]` extras (fail-fast) — and only once that succeeds does it **run** the check, in this order: a single liveness probe against the dev URL FIRST — already live → `live: true`, nothing more to do; not live → it provisions an isolated Neon branch when the repo has the neon capability, THEN checks for a start already in flight (a registered `.dobby/dev.pid`) — found → waits it out in the liveness loop; none found → hands back `instructions[]` — the applicable subset of `rename` (cmux only) and `start` — for the **model** to carry out itself and re-invoke `up` with. This two-step protocol is documented in full at [`bring-up.md`](../plugin/skills/execute/references/bring-up.md); every skill and agent that brings a worktree up follows it. A repo with no app to run (no vite capability) still runs the full setup phase, then reports `no app to run` and exits 0 — `phase: "noop"` still carries a `rename` instruction under cmux, since the workspace identity is independent of whether there's an app.

`dobby down` is the counterpart teardown: its own mechanics (killing the registered pidfile process, deleting the Neon branch, running `teardown[]` extras) already ran by the time it returns — the only thing left for the model is `instructions[]`, the `stop` topic, present only when a kit pane was discovered under cmux. Both are listed only for a repo with the vite capability.

```sh
dobby up                  # prepare (setup phase) + probe the workspace
dobby up --dry-run        # print the FULL ordered plan (setup phase + run phase)
dobby up --json           # one JSON object as the only stdout (for scripts/agents)
dobby down
dobby down --json
dobby down --dry-run
```

**`dobby up --json`** answers with ONE flat JSON object as the *only* thing on stdout — everything human (the failure message, and every setup child's output) goes to stderr — so a script never parses prose:

```json
{
  "browserPane": null,
  "cmux": null,
  "degradedCommand": null,
  "devUrl": "https://my-goal.local.dev",
  "instructions": [
    {
      "applies": true,
      "text": "Run `bunx dobby dev` from /path/to/worktree as a background task of the host: use Claude Code's Bash tool with the `run_in_background` option set to true. Read the command's early output to confirm the server is booting — a failed command shows its error right there — before re-invoking `bunx dobby up --json` to confirm the app is live. Once confirmed live, the app is reachable at https://my-goal.local.dev.",
      "topic": "start"
    }
  ],
  "live": false,
  "ok": true,
  "phase": "run",
  "reason": null,
  "slug": "my-goal",
  "verifyMode": "url",
  "workroot": "/path/to/worktree"
}
```

`reason` is a fixed set — `not-a-git-repo`, `config-unreadable`, `install-failed`, `worktree-copy-failed`, `setup-extra-failed`, `neon-creds-missing`, `neon-branch-failed`, `liveness-timeout` — and is `null` on success; there is no member for a failed start, since `up` starts nothing itself anymore — a failed start is something the model that ran the `start` instruction sees in its own stderr. `phase` is where it stopped (`setup`, `run`, or `noop` = nothing to run); `live` is whether the devUrl answered this probe (it pairs with an `ok: true` "please start it" report just as often as with a timeout — it says nothing about success alone); `instructions` is always present, possibly empty, ordered `rename` then `start`; `verifyMode` is `url` when there is a `devUrl` to hit and `programmatic` otherwise; `degradedCommand` is offered only for an install-phase failure. The exit code always agrees with the payload: 0 when `ok` is true, nonzero when it is false.

**`dobby down --json`** answers a smaller, flat object — `{cmux, instructions, ok, reason, slug, workroot}` — `reason` a fixed set (`not-a-git-repo`, `neon-delete-failed`, `teardown-extra-failed`, or `null` on success; the Neon delete stays best-effort, so `neon-delete-failed` is reserved for a future path rather than produced today), and `instructions` carrying the `stop` topic only when a kit pane was discovered.

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

## Session commands

Everything above is stack machinery, inferred per repo. The commands below are the **ceremonies** — they apply to every repo, so they are never capability-filtered (except `release`, which exists only when the config declares a `release` key). Every one of them:

- **answers with JSON** under `--json` — one payload as the *only* thing on stdout, so a caller parses data instead of prose (human messages and refusals go to stderr);
- **fails hard outside a git repository** and pins every child process's cwd to the workroot, never the ambient directory (the [artifact linters](#artifact-linters) are the exception: they judge a file, which may legitimately live outside the repo — a handoff document belongs in the temp dir);
- **plans before it executes** where a `--dry-run` exists: the same decisions, zero side effects;
- **stops rather than guessing**. When a command reaches a judgment a machine must not make alone it exits nonzero having touched **nothing**, with a payload naming the decision plus the context to decide it (`needsDecision`); the caller asks a human and re-invokes with the answering flag. The CLI itself never prompts.

### `dobby ship`

The commit ceremony in one call: stage → run the gate **in-process** (`check --fix`) → re-stage → `git commit -F <message-file>` → push — always pinned to **origin** (`-u origin HEAD` when there is no upstream; a branch tracking another remote is still pushed to origin, said out loud via `pushNote`, its tracking config untouched) → `gh pr create --body-file`, which happens only from a non-trunk branch (never on `main`/`master`) and only when no PR exists for it yet.

```sh
dobby ship --message-file /tmp/msg.txt
dobby ship --message-file /tmp/msg.txt --pr-body-file /tmp/pr.md --json
```

`--message-file` is required and is validated **before anything is touched** — a ceremony that can't produce a message leaves the tree exactly as it found it. A pull request is opened only when you pass `--pr-body-file` too (the body is yours to author); an existing PR for the branch is reported rather than duplicated, and a PR gh could not open is a note, not a failure — the commit already landed.

**The exit code decides.** A red gate prints every finding whole and ends the ceremony with the gate's own exit code — nothing committed, nothing pushed, no cache written for a tree that never passed. Write the message and PR-body files **outside the repository**: ship stages the whole tree, so a message file inside it would land in the commit it describes.

A green gate writes the **gate cache** at `.dobby/gate-cache.json` — the staged tree hash, the dobby version, the hash of `dobby.config.json`, and the verdict — which is what lets `check --pre-push` skip re-running a gate that already passed on exactly this tree, and only on this tree. It shares that file with the per-check cache above: ship records its tree without disturbing the green input sets `check` remembers there, and its own in-process gate is served from them like any other run — a ship over a tree you just checked skips straight to the commit.

`--json` answers `{cacheNote, cacheWritten, committed, gateExitCode, gateNote, prNote, prUrl, pushNote, pushed, sha}`. The four notes exist so a caller can tell "skipped by policy" from "could not be done": `cacheNote` says why no cache entry was written, `gateNote` carries the `gate skipped: inputs unchanged since last green (…)` line when the ceremony's gate was served from the cache (null when it really ran), `prNote` why a requested PR has no URL (gh absent, expired auth, an API error), `pushNote` that the push went to origin instead of the branch's non-origin upstream. Ship refuses a detached HEAD before touching anything — the ceremony needs a named branch.

### `dobby release`

Cut **one** release through the target adapter that `dobby.config.json`'s `release.type` selects. Without a `release` key the command does not exist at all — nothing in a repo infers a release target.

```sh
dobby release --dry-run            # the version + changelog it WOULD cut; touches nothing
dobby release --json               # cut it
dobby release --bump minor --json  # answer a needsDecision stop
dobby release --notes-file /tmp/notes.md --json   # resume with the authored notes
```

The phases, each recorded in the `phases[]` payload: **preflight** (main checkout only, on `main`, clean tree, `git pull --ff-only`, CI green on the commit being released, then the adapter's own preflight) → **version** (inferred from the commits since the last `v*` tag) → **bump** (indentation-preserving manifest rewrite plus every lockstep surface, the gate over the bumped tree, a *local* `release: v<version>` commit) → **changelog** → **publish** (the adapter's pack gate → publish → tag → push → `gh release create` → smoke).

It stops in exactly three places, all with exit **1** so none can read as a finished release:

| Stop | Payload | What to do |
| --- | --- | --- |
| A version question a machine must not answer | `{needsDecision: "first-release" \| "0x-major", context: {currentVersion, commits}}` — nothing touched | Ask the human, re-run with `--bump patch\|minor\|major` |
| Nothing to release | `nothing to release` (the last tag is already on HEAD) | — |
| The notes are yours to write | `{needsNotes: true, version, changelog: {groupedBy, groups, since}}` — everything mechanical done, the bump commit **local**, nothing pushed | Author the notes in a file **outside the repo**, re-run with `--notes-file` |

A completed release exits 0 with `{changelog, phases[], published: true, tag, version}`. The push is **publish-gated**: the tag is created and pushed only after the publish succeeded, and a failed publish rolls the local bump commit back while it is still the unpushed HEAD — a pushed tag for a version that never shipped burns that number for good.

**The adapters.** The spine knows the phases; everything channel-specific lives behind the adapter seam:

| `release.type` | Extra config | What the adapter owns |
| --- | --- | --- |
| `"npm"` | `dir` (the publishable package dir, when it isn't the repo root) · `smoke` (an argv **array**, e.g. `["bun", "install", "-g", "@scope/pkg@latest"]`) | the `npm whoami` preflight (whose message carries the granular-token fix, because `whoami` passing does **not** prove publish rights — an interactive-login token dies at publish with `EOTP`), the `bun pm pack` deny gate (a tarball carrying `**/*.test.ts`, `**/__fixtures__/**`, `dist/**`, or nothing at all is refused), `npm publish --access public` (never `bun publish`), then the smoke once the registry serves the new version |
| `"homebrew-cask"` | `tap` (the tap **repository**, e.g. `kvnwolf/homebrew-tap`) · `cask` (the cask token — the `Casks/<cask>.rb` it writes) · `notaryProfile` (**optional** — see below) | the non-JSON lockstep bump, the tap checkout + cask rewrite (version, url, sha256) after the GitHub release, and a smoke that **reports** the `brew install --cask` command for a human to run rather than installing anything |

Two `release` keys are shared: `lockstep` (other version-carrying files moved with the release) and `surfaces` (a display name → glob map that groups the changelog **by surface** instead of by commit type).

**Notarization (homebrew-cask, optional).** One key turns it on:

| Key | Type | What it does |
| --- | --- | --- |
| `notaryProfile` | optional string — the name of a **notarytool keychain profile** | Adds the notarization gates. **Preflight**: a `Developer ID Application` certificate is installed (`security find-identity`) and the profile authenticates (`xcrun notarytool history`). **Pack gate**, after the bundled-version check and still before any tag: `xcrun notarytool submit <dmg> --keychain-profile <p> --wait` must report `status: Accepted`, `xcrun stapler staple <dmg>` must succeed, and `spctl -a -t open --context context:primary-signature -vv <dmg>` must assess it as `Notarized Developer ID` — any refusal quotes the tool's full output. **Smoke**: the install note is the `brew install --cask` line alone, with no quarantine caveat. Omit the key entirely to release un-notarized — an empty string is a config mistake and is refused, never read as "no". |

The profile is created **once**, by hand: `xcrun notarytool store-credentials <profile> --apple-id <apple-id> --team-id <team-id>` (it prompts for an app-specific password and stores it in the login keychain). That profile name is the only credential dobby ever sees — there is deliberately **no** `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` environment path, because an app-specific password in the environment is inherited by every child process and lands in shell history and CI logs. Signing itself stays tauri's: the identity lives in `tauri.conf.json`'s `signingIdentity`.

Leave the key out and nothing changes: the release ships an unsigned dmg exactly as before, and the smoke note carries the `xattr -dr com.apple.quarantine` caveat its users will need.

```json
{
  "release": {
    "type": "npm",
    "dir": "cli",
    "lockstep": ["package.json"],
    "surfaces": { "CLI": "cli/**", "Plugin": "plugin/**" },
    "smoke": ["bun", "install", "-g", "@kvnwolf/dobby@latest"]
  }
}
```

### `dobby state`

The `STATE.md` engine — the session document at the workroot, with seven canonical sections in fixed order (`## Goal`, `## Source`, `## Exploration`, `## Findings (interview)`, `## Research`, `## Spec`, `## Work log`).

```sh
dobby state init --goal "add CSV export" --source "#42" --json
dobby state set Research --file /tmp/brief.md --json
dobby state set "Findings (interview)" --file /tmp/findings.md --json   # quote a multi-word section
cat brief.md | dobby state set Research --stdin --json
dobby state append-worklog --task 3 --file /tmp/worklog.md --json
dobby state lint --json
```

`init` writes the skeleton plus the `.gitignore` entry and refuses an existing document. `set` replaces **one** section body and preserves every other byte (unknown sections included); `## Goal` / `## Source` are write-once, `## Work log` is never settable — that is what `append-worklog` is for, and it demotes the entry's own `##` headings to `###` so the document keeps one heading level per depth. `lint` reports the structure (H1, the seven required sections present, canonical sections in order and unduplicated, gitignored). A legacy `## Execution profile` is an unknown section: Dobby tolerates and preserves it byte-for-byte, but `init` no longer creates it and nothing reads it.

### `dobby build-plan`

Derive the build plan from a spec's task table — mechanically, so the task list and preconditions are never eyeballed.

```sh
dobby build-plan --json                       # from STATE.md's ## Spec
dobby build-plan --file docs/plan.md --json   # from another document
dobby build-plan --task /tmp/one-task.json --json   # one ad-hoc task, no STATE.md
```

The table is found by its **header row** (`#` / `Task` / `Depends on` / `Affected areas` / `Verify recipe`, with `Description`, `Test-first` and `Destructive` optional), so a non-task table inside the spec is skipped. The answer carries `tasks[]` — the per-task instruction data verbatim (`id`, `title`, `spec`, `decisions`, `constraints`, `areas[]`, `verifyRecipe`, `testFirst`, `destructive`, `dependsOn[]`), the exact shape `build-protocol.md` consumes — plus `hasTestSuite` (`{value, specSays, disagreement}`, the repo's own `vitest` capability against what the spec claims), `manualVerifySetup`, `preconditions` (`{missing, danglingDeps, cycles, ok}`), and `workRoot`. There is no wave grouping: `dependsOn` carries each row's dependency ids unchanged, so a task can start the moment its own dependencies are done, and a `destructive` task is flagged rather than isolated — the coordinator serializes it at dispatch time. **Failing preconditions exit 1 with the payload still on stdout**, so the caller can show exactly which task and which cell.

### `dobby finish --preflight` · `dobby migrate`

The read-only verdicts a destructive or planning step asks for **before** it acts. Neither creates, enters, or removes anything — they compute the predicate, the decision stays with the caller.

```sh
dobby finish --preflight --json
dobby migrate preflight --json
dobby migrate verify --json
```

`finish --preflight` answers the teardown verdict for one goal, resolved from wherever the session stands: `safe` (a **merged** PR and a clean tree), `blocked` (dobby is not installed **at the workroot the session stands in** — the mandatory `dobby down` cannot run — that outranks every other signal), else `confirm-required`; it also reports whether the session stands in a linked worktree at all (`inWorktree`, `worktreePath`, `mainRoot`), the repository's own default branch (`defaultBranch: string | null`, resolved at `mainRoot` by an ordered cascade — `origin/HEAD`, then remote-tracking `main`/`master`, then local `main`/`master`, else `null` when nothing names one), and whether the branch is safe to delete.

`dobby migrate preflight` says whether a repo still needs the config migration (naming each legacy signal and snapshotting what the migration must carry across); `dobby migrate verify` runs the gate in-process and reports the environment read back plus whatever was left behind. Both **exit 0 with a payload for every verdict** — they inform, they never refuse.

### `dobby repro`

The red/green capture harness: run a command deterministically, capture it whole, and answer whether it reproduced.

```sh
dobby repro --expect red -- bun test src/thing.test.ts
dobby repro --expect red --repeat 20 --json -- bun test src/flaky.test.ts
dobby repro --bench --json -- bun run build
```

Everything after `--` is the command. One run answers `{invocation, exitCode, stdout, stderr, durationMs, verdict, matched, reproId}` — `verdict` is red on any nonzero exit, and the exit code is **1 only on a mismatch** with `--expect` (a failing command with no `--expect` exits 0: the harness reports an exit code, it never inherits one). Output is never truncated.

`--repeat N` turns it into a reproduction-rate probe (`redCount`, `reproductionRate`, `deterministic`, `firstDivergent`) — the answer to "is this loop red-capable?". `--bench` adds timing stats plus the `delta` against the previous bench of the same loop. Each run persists a record at `.dobby/repro/<reproId>.json`, keyed by the workroot + the command only, so every run of one loop keys the same record.

### `dobby review` · `dobby pr watch`

The `gh` surface of a PR review, mechanized. These commands move **data**; every judgment (is this finding valid, what is the fix, may we merge) stays with the caller.

```sh
dobby review fetch [--adapter greptile] --json  # the PR, selected bot, open threads, summary
dobby review apply --plan /tmp/plan.json [--adapter greptile] --json # reply + resolve, then re-trigger
dobby review apply --stdin --dry-run --json
dobby pr watch --json                           # CI to a verdict
dobby pr watch [--adapter greptile] --await-review --deadline 600 --json
```

`review fetch` returns `{pr, adapter, candidates, threads, summary}` — the review threads over GraphQL (drained with gh's `$endCursor` pagination contract, each thread carrying its last comments so a re-run sees its own prior replies) and the bot's summary comment over REST. Bot authors are exact-matched after stripping `[bot]`; substring lookalikes do not count. When `candidates` names several bots, re-run with `--adapter <id>` and carry that flag through apply/watch; ambiguous writes and watches fail instead of silently taking registry order. If several adapters are required gates, the caller must retain every final payload and require one common `pr.headRefOid`, restarting the whole set on mismatch. Greptile summaries include parsed `reviewedHeadOid` evidence from the documented `Last reviewed commit` footer.

`review apply` consumes a disposition plan — `{pr, reTrigger, plan: [{threadId, disposition: "fix" | "dismiss" | "outdated" | "defer", reply}]}` — replies, resolves (`defer` deliberately does **not** resolve: a deferred finding stays open), skips threads already answered, and then re-triggers if asked. Idempotent by construction.

`pr watch` owns its own polling loop and derives the verdict from check **bucket counts**, because `gh pr checks --json` always exits 0 and `--watch --json` is a hard error. Verdicts: `ci-failed`, `ci-green`, `ci-pending`, `merge-ready`, `feedback-present`, `open-unreviewed`, `skipped`. It re-reads `headRefOid` after checks and after each review snapshot; a concurrent push discards both and restarts from CI. Greptile `merge-ready` requires its named current-commit check to pass and its footer SHA to equal HEAD. CodeRabbit requires its named current-commit passing check; an old summary without it fails closed. Stale or missing evidence remains `open-unreviewed`, with `reviewFresh` and a diagnostic `reason` in JSON. `--deadline` (default 300s) budgets **each** wait phase separately — CI first, then review — so slow CI never consumes the review wait. There is no merge path.

### `dobby tracker` · `dobby claim` · `dobby goal parse`

One backend-agnostic issue-tracker contract over three backends, selected by `dobby.config.json`'s `tracker` key: **GitHub Issues** (the default), **Linear**, or a local `BACKLOG.md`.

```sh
dobby tracker info --json
dobby tracker search "csv export" --json
dobby tracker create --title "Export is slow" --body-file /tmp/body.md --label bug --json
dobby tracker close 42 --rejected --json
dobby claim 42 --json
dobby goal parse "#42" --json
```

`info` reports `{available, degradedTo, reason, team, type}` — GitHub probes `gh auth status` and degrades to local when it can't authenticate; Linear reports `available: null` (reachability is MCP-side) and spawns nothing. The Linear backend returns a **delegation descriptor** (`{delegate: "mcp", op, args}`) rather than calling anything itself. `close --rejected` is the only close this CLI does — a completed goal is closed by its merged PR.

`goal parse` turns a goal reference into `{hardStop, id, lifecycleLink, slug, slugCollision, source, url}`. The pattern set is gated by the configured tracker (GitHub reads `#42`, Linear reads `VON-123` — never each other's), anything unmatched is free-text, and `lifecycleLink` (`Closes #42` / `Fixes VON-123`) is emitted here so no skill re-derives it.

### `dobby kb` · `dobby adr new`

The durable-artifact writers — `docs/` is where decisions outlive a session.

```sh
dobby kb list --kind out-of-scope --json
dobby kb record --kind learn-discarded --concept flaky-verify \
  --title "Flaky verify retries" --reason-file /tmp/why.md --entry "2026-07-24 — asked again" --json
dobby adr new "Single terminal host" --status accepted --json
```

`kb` owns the two knowledge bases (`docs/out-of-scope/`, `docs/learn-discarded/`), one file per concept: `list` returns each concept with its title, statement and prior entries (an absent directory is `[]`, never an error), and `record` appends a bullet to an existing concept — the rationale written the first time wins — or creates the file with the canonical skeleton. It never judges whether a concept belongs there, and it never dedups the *entries* — the same bullet recorded twice appears twice; that is the caller's call. Dedup **by concept** is structural, though: the concept is the filename, so a concept is never split across two files.

`adr new` allocates the next ADR number and writes the skeleton at `docs/adr/NNNN-<slug>.md`. Numbering scans the local directory **and** `origin/HEAD` (a sibling worktree's ADR is pushed long before it lands here), and the number is claimed at write time with `O_EXCL` — an existing `NNNN-` prefix, whatever its slug, moves to the next number rather than truncating someone's ADR. The body is deliberately not the CLI's to write.

### Artifact linters

The **mechanical** subset of the kit's document conventions: a heading that must exist, a cell that must be filled, an edge that must point backwards, a frontmatter key that must be real. Whether a decision is *right* is not linted.

```sh
dobby spec lint --json                        # STATE.md's ## Spec by default
dobby map next --json                         # the newest docs/maps/*.md
dobby map claim <ticket-slug> --json
dobby map lint --json
dobby skill lint plugin/skills/commit --json
dobby wizard verify scripts/setup-wizard.sh --json
dobby arch-report verify docs/arch-report.md --json
dobby handoff finalize /tmp/handoff.md --focus "csv export" --json
dobby brief lint --issue 42 --json
```

One report contract for all of them: findings print one per line as `<where>: <message>`, any finding exits 1, a clean run prints `ok` and exits 0, and `--json` answers `{ok, findings: [{check, message, where}], notes}`. A check that could not **run** (shellcheck absent, a repo with no workflows) is a **note** — never a finding and never an exit code — so a caller can tell a checked artifact from an unchecked one. An unresolvable target (a missing file, a slug the map never had, a failed `gh` call) is a hard error, never a clean verdict.

`wizard verify` compares a generated wizard against the wizard template **vendored inside this package** (`wizard/template.sh`): the library region — everything from the library marker down to the stages marker — must be byte-for-byte the template, with the stages authored below it. The template is vendored rather than read from the plugin directory for the reason every kit asset here is: `dobby` runs in consumer repos, where `plugin/` does not exist, and a check that silently no-ops in the field is worse than no check. `map next` answers which ticket is claimable (and writes nothing); `map claim` is the one command in this family that **writes** — it rewrites that ticket's `Status:` line in place.

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
  ],
  "tracker": { "type": "linear", "team": "VON" },
  "release": { "type": "npm", "dir": "cli" }
}
```

| Field | Purpose |
| --- | --- |
| `files` | Doc-sync rules — which docs to review when matched paths change (skill-consumed). |
| `setup` | Extra commands appended after `bun install` in `dobby up`'s setup phase. |
| `teardown` | Extra commands run by `dobby down`. |
| `checks` | Extra shell checks appended to the full `dobby check` gate. |
| `tracker` | The issue backend for [`tracker` / `claim` / `goal parse`](#dobby-tracker--dobby-claim--dobby-goal-parse): `{ "type": "github" }` (the default when the key is absent), `{ "type": "linear", "team": "VON" }` (Linear has no repo-derivable team), or `{ "type": "local" }` (a plain `BACKLOG.md`). |
| `release` | The release target — its presence is what makes [`dobby release`](#dobby-release) exist. `type` is required (`"npm"` or `"homebrew-cask"`); the rest is per-channel: `dir`, `smoke` (npm), `tap`, `cask`, `notaryProfile` (homebrew-cask), plus the shared `lockstep` and `surfaces`. |

`tracker` and `release` are validated when the config is read. Agent model/effort/reasoning are not project config — they live in each worker agent's own frontmatter (`plugin/agents/*.md`), not in `dobby.config.json`.

## Inferred defaults per capability

The command surface is inferred from what the repo declares (`dependencies ∪ devDependencies`). Detected capabilities drive the defaults:

| Capability | Signal | Enables |
| --- | --- | --- |
| `vite` | `vite` | `dobby dev` / `build` / `up` / `down`; the `check` build step |
| `vitest` | `vitest` | the `check` test step |
| `drizzle` | `drizzle-orm` / `drizzle-kit` | `db:*` drizzle-kit tasks |
| `neon` | `@neondatabase/serverless` | `up`/`down` Neon branch-per-worktree isolation |
| `react-email` | `react-email` / `@react-email/*` | `email dev --dir src/emails` secondary in `dobby dev` |

Run `dobby env` to see the capabilities detected for your repo.

## License

MIT
