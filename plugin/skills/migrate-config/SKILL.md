---
name: migrate-config
description: One-pass migration of a consumer repo off vite-plus onto @kvnwolf/dobby — swap deps, thin `tsconfig.json` and delete the now-default tool configs (biome/vite/vitest/drizzle, kept only for real deltas), move files to canonical paths, regenerate dobby.config.json, drop .conductor, rewire CI + Vercel build, verify with `dobby migrate verify`. Run in a consumer repo, once, after updating the dobby plugin.
---

The one-pass migration from the **vite-plus world** to the **dobby world**. The kit used to lean on `vite-plus` (`vp`/`vpr`) for the toolchain and run lifecycle, keep its commit contract at `.claude/commit.config.yml`, and rely on Conductor glue (`.conductor/`). All of that is gone: the toolchain (Biome, TypeScript, knip, taze, portless) is now **bundled inside `@kvnwolf/dobby`** and inferred from the repo's detected capabilities (zero-config à la Vercel); the run lifecycle lives in `dobby up`/`down`/`dev`; the per-project contract shrank to a thin `dobby.config.json`; and Conductor support was removed. Run this **manually, once per consumer repo**, after updating the dobby plugin.

**This skill IS the migration path — a clean cut.** The work skills (`/dobby:scope`, `/dobby:execute`, `/dobby:commit`, `/dobby:finish`) and the edit-time hook assume `@kvnwolf/dobby` is installed and `dobby.config.json` exists; none of them fall back to `vp`/`vpr`, the legacy `.claude/commit.config.yml`, or Conductor. A repo that hasn't been migrated silently loses its gate, its run lifecycle, and its worktree setup. So run this before relying on the kit in an existing vite-plus repo — that is the whole reason the skill exists.

This is **project-agnostic methodology**: it detects state and acts on what it finds, it does not hardcode any one repo. Two real field cases appear below as **examples** of what the migration encounters — never as branching logic:

- **vonda** (TanStack Start + Drizzle/Neon, Bun): has a `dobby.config.json` from the old era (`run` key + `vp`-based `setup`/`teardown`/`checks`), **no `package.json#scripts`** (tasks lived in `vite.config.ts`), and `.worktreeinclude` already present.
- **admin** (TanStack Start + Drizzle/Neon + Better Auth, Bun): still on legacy `.claude/commit.config.yml` (**no `dobby.config.json` yet**), **no `.worktreeinclude`** (its env copy was Conductor-only), and a **portless key** (`admin.logikpeak`) in `package.json`.

The authoritative config schema lives at `../onboard/references/dobby-config.md` (the shrunken `files` + optional `setup`/`teardown`/`checks` contract — **no `run` key**). Full command surface and the canonical-path conventions are documented in the CLI's own README (`@kvnwolf/dobby`).

**Human gates before destructive steps.** The whole migration runs as ONE pass, verified at the end — but two steps are irreversible and get an explicit gate first: **moving files** (Step 5) and **deleting `.conductor/`** (Step 8). Everything else runs straight through.

---

## Step 0: Preflight — detect the legacy state

```bash
bunx dobby migrate preflight --json
```

One read-only call detects every legacy signal and snapshots the facts the migration has to carry across. Nothing in this step is yours to re-derive by hand.

**`signals`** — `legacyYaml` (`.claude/commit.config.yml`, admin's case), `oldEraConfig` (a `dobby.config.json` carrying a `run` key or `setup`/`teardown`/`checks` extras that shell out to `vp`/`vpr` — vonda's case; `vpExtras` holds the offending command strings), `viteplusDep`, `aliases` (the packages aliased onto vite-plus in `overrides`/`resolutions`), `viteHooks`, `vpTaskTable`, `prepareScript`, `conductor`.

**`snapshot`** — what the later steps consume, each already resolved: `toolchainDeps` (which now-bundled tools this repo actually has → Step 1), `preservedKeys` (`portless` / `trustedDependencies` → Step 1 keeps them), `scripts` (→ Step 4), `toolConfigs` (where `biome`/`vite`/`vitest`/`drizzle` configs live today, from the same specs override-by-presence resolves → Steps 2-3), `envTest` (→ Step 3), `worktreeinclude` (→ Step 6), `tracker` (→ Step 7), `ci` (the workflow files still running a vp/vpr line) and `vercelJson` (→ Step 9).

**Branch on `verdict`:**

- **`already-migrated`** — no legacy signal, the config is new-schema, and `tsconfig.json` already extends a dobby preset. Say so plainly and **stop** — do not touch anything.
- **`migration-needed`** — this is a real migration. Keep the payload: it IS the recorded starting state Step 10 reports the diff against.

Announce the plan (the ordered steps below, flagging the two human gates) before you start executing.

## Step 1: Swap the dependencies

The toolchain is now bundled inside dobby; the consumer keeps only real build-time deps.

- **Add dobby:** `bun add -d @kvnwolf/dobby` — the project's single new dev dependency (the slot `vite-plus` used to occupy).
- **Remove the now-bundled tools** — exactly the names in `snapshot.toolchainDeps` (plus `vite-plus` itself when `signals.viteplusDep`): `bun remove …`. These all ship transitively inside dobby now; never guess at a name the preflight didn't report.
- **Drop the vite-plus aliases:** remove each package in `signals.aliases` (the `"vite": "npm:@voidzero-dev/vite-plus-core"` / `"vitest": "npm:@voidzero-dev/vite-plus-test"` entries) from `package.json` `overrides`/`resolutions` (delete the `overrides` block entirely if that's all it held).
- **Restore the REAL packages:** `bun add -d vite` (and `bun add -d vitest` **only if the repo has tests** — `vitest` stays a consumer dep, detected as a capability; it is never bundled). Keep the repo's real vite plugins (`@vitejs/plugin-react`, `@tanstack/*`, nitro, react-compiler, …), `drizzle-kit`, `typescript` types, and `@types/*` — those are build-time, not toolchain.
- **Preserve project-specific config keys in `package.json`** — `snapshot.preservedKeys` names the ones this repo has. The `portless` config key (admin's `admin.logikpeak`) STAYS — portless is still used by `dobby dev`/`up` to resolve the branch-prefixed URL; only the portless *dependency* is removed (it's bundled). Likewise keep `trustedDependencies` and any other genuine project config.

## Step 2: Thin the config files

The migration WRITES exactly one config file — a thin `tsconfig.json`. Every other tool config (`biome.jsonc`, `vite.config.ts`, `vitest.config.ts`, `drizzle.config.ts`) is now **dobby-internal by default**: dobby passes its shipped, capability-picked preset through the tool's native config flag whenever the consumer has NO file of its own, so you author (or keep) one of those files ONLY to carry a real delta — creating it is a **total override**, deleting it restores the default (**override by presence**, ADR-0015). `tsconfig.json` is the one that always stays, because `tsc` and vite's `resolve.tsconfigPaths` read it directly and it holds genuinely per-project `paths`. `snapshot.toolConfigs` already named which of the four this repo carries — those, and only those, currently override a dobby default.

**`tsconfig.json`** → extend the base (the **vite variant** for a Vite app), preserving only the project's own fields:

```json
{ "extends": "@kvnwolf/dobby/tsconfig/vite", "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }
```

A **Vite app** extends `@kvnwolf/dobby/tsconfig/vite` (the base plus `types: ["vite/client"]`); a non-Vite project extends `@kvnwolf/dobby/tsconfig`. Carry over the project-specific `compilerOptions.paths`, `include`, `types`, and any genuinely project-local option; **drop** everything the base already sets (`strict`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`, `allowImportingTsExtensions`, `module`, `moduleResolution`, `noEmit`, `jsx`, …) — and on the vite variant drop `types: ["vite/client"]` too — so the thin file only holds deltas.

**Mid-migration escape hatch.** Unlike Biome, `tsc` has NO per-path scoping — it checks the whole import graph, so base strictness like `noUnusedLocals`/`noUnusedParameters` fires on legacy/unmigrated paths the lint denylist deliberately skips. A progressively-migrating repo MAY set them `false` in its thin file — a DELIBERATE deviation, not preset noise — with a rationale comment and a "revisit when fully migrated" flag; Step 10's summary must list any such deviation as debt.

**`biome.jsonc`** → create it **ONLY when the repo carries real lint/format deltas**. A repo whose style already matches the house rules writes NO `biome.jsonc` at all — config-less, dobby passes its capability-picked internal config (`@kvnwolf/dobby/biome/react` for a React app, `@kvnwolf/dobby/biome/core` otherwise) through biome's `--config-path`, governing BOTH the gate and the edit hook by default. When you DO have deltas, the file `extends` the dobby presets and carries only the deltas — a **React app extends BOTH flat presets** (`biome/core` then `biome/react`), a non-React repo extends `biome/core` alone:

```jsonc
{ "extends": ["@kvnwolf/dobby/biome/core", "@kvnwolf/dobby/biome/react"] }
```

> **Extend the flat presets DIRECTLY — never through a wrapper.** Biome's `extends` is **one-level / non-transitive**: it does not recurse through a preset's own `extends`. dobby ships its presets FLAT (ultracite core/react vendored verbatim + dobby's mods) precisely so this composes, which is why a React app must list BOTH files — `biome/react` does not pull in `biome/core` for you. Never wrap the presets in an intermediate config that itself `extends` them: biome ignores the second level, silently delivering its bare defaults instead of the house rules.

The deltas a migration typically carries are the load-bearing bits of the OLD `vite.config.ts` `fmt`/`lint` blocks, translated into Biome form (Biome 2 syntax):

- **Old `ignorePatterns` → `files.includes` with `!` negation.** In Biome 2 the include list **must start with `"**"`** (include everything) and then negate; `"!path"` force-ignores from linting (still indexed — use for generated dirs), `"!!path"` force-excludes from indexing too (use for build output like `dist/`). Example — old `ignorePatterns: ["src/routeTree.gen.ts", "dist"]` becomes:

  ```jsonc
  { "extends": ["@kvnwolf/dobby/biome/core", "@kvnwolf/dobby/biome/react"], "files": { "includes": ["**", "!src/routeTree.gen.ts", "!!dist"] } }
  ```

- **Progressive migration = DENYLIST, never an allowlist.** This IS a real delta, so a progressively-migrating repo always writes its own `biome.jsonc`. Carry the **not-yet-migrated** paths as negation globs on top of the preset's `"**"` — force-ignore each legacy area (`"!src/legacy/**"`, `"!src/old-api/**"`) and shrink the list as each area is cleaned up; when the last negation goes, DELETE `biome.jsonc` and fall back to config-less. Example:

  ```jsonc
  { "extends": ["@kvnwolf/dobby/biome/core", "@kvnwolf/dobby/biome/react"], "files": { "includes": ["**", "!src/legacy/**", "!src/old-api/**"] } }
  ```

  **Why not an allowlist?** Biome UNIONS `files.includes` across `extends` (a file is linted iff it matches ANY positive glob AND no negative one, order-independent), so a positive allowlist of migrated paths is annulled by the preset's own `"**"` — every file already matches it — and prefixing `"!**"` to defeat that excludes the whole tree. Only per-path negation composes with the preset, so a denylist is the only progressive-migration shape that works.

- **Old per-path lint `rules` → `overrides`.** Each old rule override maps to an entry in the `overrides` array keyed by glob:

  ```jsonc
  { "overrides": [ { "includes": ["**/*.test.ts"], "linter": { "rules": { "suspicious": { "noExplicitAny": "off" } } } } ] }
  ```

Only carry the rules the project genuinely deviates on — the preset already sets the house style; a rule that merely re-states a preset default is noise. In particular, `@kvnwolf/dobby/biome/react` now ships the TanStack route overrides built in (`src/routes/**`: `useFilenamingConvention` off + `useSortedKeys` off), so a TanStack Start app must NOT hand-write them into its `overrides` array — re-declaring them is exactly the "re-states a preset default" noise to drop.

- **The swap is a re-lint, not a rename.** The gate now lints the whole tree under the dobby preset — whether that's dobby's default or your delta `biome.jsonc` — so files that were clean under oxlint surface NEW findings (field case: findings from rules like `complexity/useOptionalChain`, `correctness/useExhaustiveDependencies`, `a11y/noStaticElementInteractions` on already-migrated files; note the house preset now turns `suspicious/noArrayIndexKey` OFF, so it never fires). Each is a human fix-vs-suppress call: fix what's cheap (optional chains), suppress the deliberate ones with `// biome-ignore lint/<group>/<rule>: <reason>` (JSX form `{/* biome-ignore … */}` inside markup), folding any existing prose justification into the reason string. Also remove DEAD suppressions Biome reports as "Suppression comment has no effect".

> **TROUBLESHOOTING — lint scope suddenly explodes?** If the gate starts linting `node_modules/` or generated dirs, reports tens of thousands of findings, or `dobby check` dies with a buffer overflow (ENOBUFS), the cause is almost always a **stale `@kvnwolf/dobby` in `node_modules`** delivering old/broken presets — incremental `bun add`s over a long session can leave a dirty tree where the old wrapper presets deliver nothing. Fix it with `rm -rf node_modules && bun install`; that restores the presets and their excludes. Do **NOT** start re-declaring the preset's excludes in your `biome.jsonc` — on a healthy install the preset's `!!` force-excludes survive a consumer's `files.includes` (any shape), so re-declaring them is dead weight that only hides the real problem.

**`drizzle.config.ts`** (when the repo uses Drizzle) → **DELETE it when the repo matches the house convention** — unpooled env-var names (`DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING`) and co-located schema globs (`src/**/schema.ts` + `schema.gen.ts`): dobby's default IS that config (passed to drizzle-kit through its `--config` flag), so a matching file is dead weight. Keep a file ONLY if the repo genuinely deviates (different env-var names, a single-file schema, another dialect), and make it a **spread-and-override** onto the base, carrying only the differing keys:

```ts
import dobbyDrizzle from "@kvnwolf/dobby/drizzle";

export default { ...dobbyDrizzle, /* only the differing keys */ };
```

The preset carries the whole house config — the unpooled URL resolution (DDL must NOT go through PgBouncer), the guarded `.env.local` load, the CI-safe missing-URL guard, `dialect: "postgresql"`, `out: "./drizzle"`, and the co-located schema globs — so a house-convention repo needs none of it on disk.

## Step 3: Delete `vite.config.ts` and `vitest.config.ts` when delta-less

The vite-plus task machinery is gone, and dobby now supplies the vite AND vitest configs by default (override by presence), so the target state is usually **no `vite.config.ts` and no `vitest.config.ts` at all**:

- **`vite.config.ts` — DELETE it when the app has zero deltas beyond the house tanstack-start stack.** `dobby dev` / `build` / `check` pass `@kvnwolf/dobby/vite/tanstack-start` automatically — the tanstack-start plugin stack plus `resolve.tsconfigPaths: true` (vite@8 native path aliases — do NOT add the `vite-tsconfig-paths` plugin; vitest itself warns to remove it, field case: added then reverted) AND `server.allowedHosts: true` (portless's per-worktree hostnames) — so a delta-less app carries nothing. Definitely delete the vite-plus additions — the `run`/`tasks` table, the `fmt`/`lint` blocks (their content moved to `biome.jsonc` in Step 2 IF it was a real delta), and any `staged` block. Keep a `vite.config.ts` ONLY for a genuine per-project delta (e.g. an `ssr.noExternal` entry, an extra plugin) — and because a present file is a TOTAL override, it must reconstruct the full stack by `mergeConfig`-ing onto the tanstack-start preset, not the bare base:

  ```ts
  import { defineConfig, mergeConfig } from "vite";
  import dobbyVite from "@kvnwolf/dobby/vite/tanstack-start";

  export default mergeConfig(dobbyVite, defineConfig({ ssr: { noExternal: ["some-dep"] } }));
  ```

- **`vitest.config.ts` — DELETE it when delta-less.** dobby's capability-picked default (`@kvnwolf/dobby/vitest/react` for a React app, `@kvnwolf/dobby/vitest` otherwise) is passed to vitest via `--config`, so the test step runs the preset directly. This ALSO defuses the old SSR-hang trap by construction: a tanstack-start/nitro app must never let vitest auto-discover the app's `vite.config.ts` — its SSR plugins start servers that never tear down, so vitest exits nonzero even with every test green — and the passed `--config` means vitest never discovers it. If the OLD `vite.config.ts` carried an embedded `test` block (vite-plus era), MOVE that block into a dedicated `vitest.config.ts` (`mergeConfig` on the preset) or drop it when the defaults already cover it — override-by-presence counts ONLY a dedicated `vitest.config.*` as the vitest override, so a `test` block left inside a kept-for-deltas `vite.config.ts` is silently ignored in favor of dobby's default (the deliberate stance, ADR-0015). Keep a `vitest.config.ts` ONLY for a real delta (e.g. a mid-migration `server.deps.inline` addition), and then `mergeConfig` onto the preset:

  ```ts
  import { defineConfig, mergeConfig } from "vitest/config";
  import dobbyVitestReact from "@kvnwolf/dobby/vitest/react";

  export default mergeConfig(dobbyVitestReact, defineConfig({ test: { server: { deps: { inline: ["some-esm-only-dep"] } } } }));
  ```

  The `vitest/react` variant already carries both the base universal wiring (`server.deps.inline: ["zod"]` — vitest-under-bun mangles zod v4's dual export map — and excluding `.claude/**` from discovery) AND the react layer (`@vitejs/plugin-react`, `resolve.tsconfigPaths`, `test.env: loadEnv("test", cwd, "")` — the `""` prefix loads EVERY var for import-time env validation), so a delta-less repo inherits all of it with no file. A non-React SSR app's delta file merges onto the base `@kvnwolf/dobby/vitest` instead and adds its own plugin.

**Hermetic test env — commit a placeholder `.env.test`** (`snapshot.envTest` says whether one already exists). When the app validates its env AT IMPORT — the house pattern is a `src/lib/env.ts` calling `@t3-oss/env-core`'s `createEnv`, so ANY suite that transitively imports it fails to even LOAD without env — the migration MUST commit a placeholder `.env.test` at the repo root: dummy-but-shaped values for EVERY validated var (dummy URLs, `test-*` strings). The vitest preset's `loadEnv("test", cwd, "")` picks it up automatically, and a developer's `.env.local` still wins locally. WHY (field): the legacy gate never ran vitest, so CI running the suite envless is a NEW failure surface the migration itself creates — not a pre-existing one.

## Step 4: Remove the dead hook + script machinery

Git hooks and package scripts die with vite-plus — the gate now lives in `dobby check` (`dobby check --fix` is the pre-commit gate).

- `rm -rf .vite-hooks` when `signals.viteHooks` — the git-hook shims (`vp config` wrote them) are dead; the edit-time gate is the PostToolUse `dobby check --hook`, the pre-commit gate is `bunx dobby check --fix`.
- Remove the `prepare` script and **every** `package.json#scripts` entry — `snapshot.scripts` lists them, and tasks are inferred from capabilities now, so the field is dead weight (in both field cases the list was **empty** — tasks lived in `vite.config.ts`; an empty list means there's simply nothing to remove here).

## Step 5: Move files to canonical paths + rewrite imports — HUMAN GATE

dobby imposes fixed canonical paths instead of per-project args. One move may apply:

- **React-email templates → `src/emails/`** (`dobby dev` runs `email dev --dir src/emails`).

If it applies (skip when the source doesn't exist or is already at the canonical path): **grep the whole repo for every import of the old path** and prepare the rewrite so no import dangles.

> **HUMAN GATE — this is destructive.** Present the exact plan first: which files move where, and every import that will be rewritten (old → new). Move and rewrite **only on the user's approval**. Do the file move and the import rewrites together, in one atomic step, so the tree never has a broken import.

## Step 6: Ensure `.worktreeinclude` exists

A fresh git worktree needs the gitignored env/config files copied in, and `dobby up`'s setup phase re-materializes them from `.worktreeinclude`. If `snapshot.worktreeinclude` is **false**, create the file at the repo root (gitignore syntax, one glob per line) — at minimum `.env.local`, plus any other gitignored file the app needs to boot (discover from `.gitignore` + the repo's `.env*` set). If it already exists, leave it. (admin had none — its env copy was Conductor-only, so a terminal-host worktree booted without creds and hard-failed; creating `.worktreeinclude` is the fix.)

## Step 7: Regenerate `dobby.config.json` + delete the legacy YAML

Rewrite the config to the shrunken schema (`../onboard/references/dobby-config.md`): `files` (doc-sync, always) plus **only truly-custom** `setup`/`teardown`/`checks` extras.

- **`files[]` — preserve the doc-sync rules.** When the source is `.claude/commit.config.yml` (admin), convert its `files` (`{ path, update_when[] }`) to JSON **verbatim** — carry every path and every `update_when` string across unchanged. When the source is an old `dobby.config.json` (vonda), keep its existing `files[]`.
- **DROP `run`** and anything now inferred. The old `setup: ["vp install"]` goes (the default is `bun install`); any old local-DB-stop `teardown` goes (Neon teardown is inferred by `dobby down`); `checks: ["vpr validate"]` goes (`dobby check` IS the gate). Keep an extra **only** if it's a genuine project need the inference does not cover — an unusual install step, a real cleanup dobby can't infer, a project-specific check. A hybrid mid-migration database is exactly such a need — e.g. local Supabase still in use while the repo moves to Drizzle/Neon: `"setup": ["supabase start"]` (idempotent) replaces the old dev task's `dependsOn: db:start`; the Supabase CLI commands (`db push/reset/new`, `gen types`, `lint/diff/status`) stay MANUAL (transitional state, not inferred); NEVER wire an auto-stop (local Supabase is a machine-wide singleton shared across repos). Most migrated repos end up with `files` only.
- **No-clobber caution:** if a hand-authored new-schema `dobby.config.json` already exists, merge the `files[]` additively and show the diff rather than overwriting it.
- **`tracker` — mechanize the issue-tracker line, don't drop it.** `snapshot.tracker` reports what `dobby.config.json` already declares (`type`, `team`, `source`) — the mechanical half. The rest is judgment: scan the legacy source (`.claude/commit.config.yml` and/or CLAUDE.md prose) for an issue-tracker declaration and carry it into `dobby.config.json`'s top-level `tracker` key — `{ "type": "github" | "linear" | "local" }` (see `../backlog/references/trackers.md`). Defer a Linear `team` to `/dobby:onboard` when it isn't trivially derivable from the source; **never fabricate a `team`** — a deferred `team` is flagged in Step 10, a wrong one silently misroutes work.
- **Delete `.claude/commit.config.yml`** once its `files[]` (and any `tracker` line) are carried across. Leave the rest of `.claude/` (host-owned settings/commands/agents/hooks) untouched.

## Step 8: Delete `.conductor/` — HUMAN GATE

The kit **dropped Conductor support** — one execution host remains (terminal, with cmux enrichment). Everything `.conductor/` did is now absorbed elsewhere: workspace-as-worktree and the env-file copy are handled by native `EnterWorktree` + `dobby up`'s setup phase; `auto_run_after_setup` and the run lifecycle are `dobby up`/`down`; the Neon branch-per-worktree provisioning (admin's `setup.sh`/`archive.sh` `neonctl` glue) now lives in `dobby up`/`down`, reading `NEON_API_KEY` + `NEON_PROJECT_ID` from `.env.local`.

> **HUMAN GATE — this is destructive and irreversible.** Note the rationale (Conductor removal is recorded in the kit's Conductor-removal ADR, which supersedes ADR-0005 — everything Conductor did is documented there for a possible future re-add) and confirm before running `rm -rf .conductor`. Running the kit under Conductor becomes unsupported after this.

## Step 9: Rewire the CI workflow

In the workflow files `snapshot.ci` named (the ones still carrying a `vp`/`vpr` line), replace the vite-plus install + gate with dobby's:

- `vp install` (or a vite-plus setup action) → `bun install`.
- `vpr validate` / `vp check` (and any separate `vp build`/`vp test` gate step) → **`bunx dobby check`** — the single full gate (biome, tsc, knip, capability-gated build + vitest, plus any `checks[]` extras).
- **Vercel (or any external builder) — point the build at dobby.** If the repo deploys on Vercel (`snapshot.vercelJson` says whether it already carries a `vercel.json`), set the **Build Command** to `bunx dobby build` (in `vercel.json`'s `buildCommand`, or the project dashboard) so external builds go THROUGH dobby too — the config-less vite default (and any future build-time niceties) apply centrally, with no per-project buildCommand drift. **Before you author or normalize `vercel.json`, run `vercel pull` and inspect the project's dashboard-level settings.** The existing Build Command may live in the Vercel dashboard, NOT in `package.json`, so a fresh `vercel.json` that sets `buildCommand` can silently DROP a real build step (field case: a `convex deploy` prebuild nearly lost this way). Preserve any dashboard command in the emitted config — chain dobby into it rather than replacing it (e.g. `convex deploy --cmd 'bunx dobby build'`).
- **The gate mirrors `bunx dobby check` — not third-party deploy pipelines.** Pointing the build at dobby routes the *build* through the gate, but an external deploy wrapper can still run steps the gate NEVER does — field case: a deploy tool type-checking a dir the app's `tsconfig.json` EXCLUDES, using its own `tsconfig`; and after the dep-tree swap, such excluded-dir tsconfigs may lose `@types/*` auto-discovery, so they may need the package added back as an explicit dev-dep AND an explicit `types: [...]` entry. So after migrating, **trigger the deploy pipeline ONCE and treat its failures as migration work, not flakes** — a green local gate does not prove the pipeline green.

Leave the rest of the workflow (checkout, Bun setup, caching, deploy) as it is.

## Step 10: Verify + report the summary

Prove the migration landed, one pass:

```bash
bunx dobby migrate verify --json
```

It runs the full inferred gate in-process and reads the environment back — one call in place of a separate `dobby check` + `dobby env`:

- **`ok`** — the migration's pass/fail: the gate is green, no legacy file survived, and the tracker is fully pinned.
- **`check.exitCode` / `check.failingSteps`** — which gate steps are red, by name (`biome`, `tsc`, `knip`, `build`, `test`, or a `checks[]` extra's own name). Each is migration work: fix it and re-run `verify`.
- **`env.capabilities` / `env.config` / `env.dbTasks` / `env.devUrl`** — the environment as dobby now resolves it: the detected capabilities (vite, drizzle/neon, react-email if present), the config present, the inferred `db:*` task names, and a `devUrl` for a vite repo.
- **`residual.legacyFilesRemaining`** — `.claude/commit.config.yml` / `.vite-hooks` / `.conductor` still on disk. Unfinished migration, not a warning.
- **`residual.deltaConfigsKept`** — the tool configs still present. A kept config is a legitimate outcome (a real delta), never a defect — the summary below names the delta for each.
- **`residual.trackerIncomplete`** — no tracker declared, or a Linear line whose `team` is still deferred.

Then report the **migration summary** in plain buckets:

- **Swapped** — dobby added; which toolchain deps removed; vite/vitest de-aliased and restored real; which `package.json` keys preserved (e.g. the portless key).
- **Config surface** — `tsconfig.json` written thin (`extends` the base, only project deltas kept). Then, for each of `biome.jsonc` / `vite.config.ts` / `vitest.config.ts` / `drizzle.config.ts`, report whether it was **DELETED as now-default** (dobby's capability-picked preset governs via override-by-presence) or **KEPT for a real delta** — naming the delta (a progressive-migration denylist in `biome.jsonc`, an `ssr.noExternal` in `vite.config.ts`, a spread-override in `drizzle.config.ts`, …).
- **Removed** — `.vite-hooks/`, `prepare` + scripts, `.claude/commit.config.yml`, `.conductor/`.
- **Moved** — which files went to `src/emails/` and how many imports were rewritten (or "none applied").
- **Config** — the new `dobby.config.json` (`files` count; any extras kept and why); `.worktreeinclude` created or already present; CI rewired (and, if the repo deploys on Vercel, the buildCommand pointed at `bunx dobby build`).

Flag any follow-ups the migration surfaced — e.g. a `setup[]`/`teardown[]`/`checks[]` extra the inference doesn't cover, or a stale README the swap left behind; `env.capabilities` + `env.dbTasks` from the verify payload are the resolved capabilities and inferred `db:*` task names to state. **Also flag a deferred/incomplete `tracker`** — when `residual.trackerIncomplete` is true (a Linear line without a trivially-derivable `team`, or any tracker not fully pinned), say so and tell the user to run `/dobby:onboard` to complete the `tracker` key (especially the Linear `team`) **before using the work skills** — otherwise the project has no usable tracker selection and new work would be recorded against the default GitHub backend.

## Next step

The migration is done. End by presenting an **AskUserQuestion** (one question) that restates the cutover to the dobby world is complete and offers:

- `/dobby:commit` *(Recommended)* — commit the migration (added dep, thin `tsconfig.json`, the now-default tool configs deleted/kept-for-deltas, removed machinery, deleted `.conductor/` + legacy YAML, moved files, new `dobby.config.json`, CI rewire); its `bunx dobby check --fix` gate runs green, proving the move end-to-end.
- `/dobby:onboard` — first, if Step 10 flagged an incomplete `tracker` (e.g. a Linear line whose `team` was deferred) to complete before using the work skills.
- **Stop here** — end the turn (e.g. to eyeball the moved files or the CI diff first).

On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool (chaining runs on the session's current model/effort). "Stop here" ends the turn.

## Language

Interact with the user in their language. Write the migrated `dobby.config.json`, the thin config files, and any code/import edits in English; keep domain terms and file paths in their real-world form, and preserve the user's own prose verbatim when it's kept.

## Acceptance checklist

- [ ] `bunx dobby migrate preflight --json` ran FIRST (no legacy signal re-detected by hand); `verdict: already-migrated` reported plainly and the repo left untouched; on `migration-needed` the `signals`/`snapshot` payload kept as the starting state, and the plan (with the two gates flagged) announced
- [ ] Deps swapped off the preflight: `@kvnwolf/dobby` added; exactly `snapshot.toolchainDeps` (+ `vite-plus`) removed; every `signals.aliases` entry dropped; real `vite` (and `vitest` if tests) restored; `snapshot.preservedKeys` preserved (portless key, `trustedDependencies`)
- [ ] `tsconfig.json` written thin (the one config file that ALWAYS stays): `extends @kvnwolf/dobby/tsconfig` (or `/tsconfig/vite` for a Vite app) keeping only project deltas (paths/include/types), absorbed options dropped (`allowImportingTsExtensions`/`noUncheckedSideEffectImports`)
- [ ] Override-by-presence honored on the other tool configs: `biome.jsonc` / `vite.config.ts` / `vitest.config.ts` / `drizzle.config.ts` DELETED when delta-less (dobby's capability-picked default governs the gate + edit hook); a file KEPT only for a real delta — `biome.jsonc` `extends` dobby's FLAT presets DIRECTLY (a React app both `@kvnwolf/dobby/biome/core` + `@kvnwolf/dobby/biome/react`, else `biome/core` alone; `extends` is one-level/non-transitive) carrying the deltas/`overrides` (old `ignorePatterns`→`files.includes`, `**` first + `!`/`!!` negation; progressive migration = per-path DENYLIST, never an allowlist; old rules→`overrides`); `vite.config.ts` a `mergeConfig` onto `@kvnwolf/dobby/vite/tanstack-start` (e.g. `ssr.noExternal`); `vitest.config.ts` a `mergeConfig` onto `@kvnwolf/dobby/vitest/react` (real delta only); `drizzle.config.ts` a spread-override onto `@kvnwolf/dobby/drizzle`
- [ ] Hermetic test env: when the app validates env at import (`src/lib/env.ts` → `@t3-oss/env-core` `createEnv`), a placeholder `.env.test` committed at the repo root (dummy/`test-*` values for EVERY validated var) so CI can run the suite envless without import-load failures — the vitest preset's `loadEnv("test", …)` loads it, `.env.local` still wins locally
- [ ] `.vite-hooks/` removed; `prepare` + every `package.json#scripts` entry removed
- [ ] HUMAN GATE honored before file moves; the canonical-path move done with all imports rewritten atomically (react-email → `src/emails/`); skipped cleanly when N/A
- [ ] `.worktreeinclude` created (at least `.env.local`) if missing; left as-is if present
- [ ] `dobby.config.json` regenerated to the shrunken schema: `files[]` preserved/converted verbatim; `run` and inferred `setup`/`teardown`/`checks` dropped; only truly-custom extras kept; no-clobber on an existing hand-authored config; `.claude/commit.config.yml` deleted, rest of `.claude/` untouched
- [ ] Legacy issue-tracker line (naming Linear/local/github, from `.claude/commit.config.yml` or CLAUDE.md) MECHANIZED into `dobby.config.json`'s top-level `tracker` key (`{ "type": ... }`), NOT deleted — Linear `team` key deferred to `/dobby:onboard` when not trivially derivable, never fabricated; an incomplete `tracker` flagged in the summary
- [ ] HUMAN GATE honored before deleting `.conductor/`; ADR rationale (Conductor removal, supersedes ADR-0005) noted
- [ ] CI rewired: `vp install`→`bun install`, `vpr validate`/`vp check`→`bunx dobby check`; Vercel buildCommand pointed at `bunx dobby build` if the repo deploys there — but only after `vercel pull` + inspecting the dashboard, preserving any dashboard-level build step (chain dobby into it, don't drop it); rest of the workflow left intact
- [ ] Deploy pipeline triggered ONCE post-migration and its failures treated as migration work, not flakes — the gate mirrors `bunx dobby check`, so an external builder's own typechecks (e.g. an app-tsconfig-EXCLUDED dir with its own `tsconfig`, which may now need the `@types/*` dev-dep AND an explicit `types: [...]`) are the migration's job, not the gate's
- [ ] Verified with `bunx dobby migrate verify --json`: `ok: true` (or every `check.failingSteps` entry and `residual.legacyFilesRemaining` treated as migration work and re-verified); `env` read back from the payload; migration summary reported (swapped / config surface [deleted-as-default vs kept-for-deltas, per `residual.deltaConfigsKept`] / removed / moved / config), with `residual.trackerIncomplete` flagged when true
- [ ] Ended with the AskUserQuestion gate (`/dobby:commit` recommended, `/dobby:onboard` first if `tracker` incomplete, or stop here); the chosen `/dobby:<skill>` invoked through the Skill tool
