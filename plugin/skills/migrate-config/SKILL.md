---
name: migrate-config
description: One-pass migration of a consumer repo off vite-plus onto @kvnwolf/dobby — swap deps, thin `tsconfig.json` and delete the now-default tool configs (biome/vite/vitest/drizzle, kept only for real deltas), move files to canonical paths, regenerate dobby.config.json, drop .conductor, rewire CI + Vercel build, verify with `dobby check`. Run in a consumer repo, once, after updating the dobby plugin.
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

Snapshot what you're migrating from, and decide whether there's anything to do. Detect the legacy signals:

- `.claude/commit.config.yml` present → legacy commit contract (admin's case).
- `dobby.config.json` present but **old-era** — it carries a `run` key, or `setup`/`teardown`/`checks` extras that shell out to `vp`/`vpr` (vonda's case).
- `vite-plus` in `devDependencies`, and/or the aliases `"vite": "npm:@voidzero-dev/vite-plus-core"` / `"vitest": "npm:@voidzero-dev/vite-plus-test"` in `package.json` `overrides` — the core signal that this is a vite-plus repo.
- Supporting signals: a `.vite-hooks/` directory, `vp`/`vpr` task tables in `vite.config.ts`, a `prepare` script, a `.conductor/` directory.

**Branch on what you find:**

- **No vite-plus signal AND `dobby.config.json` is already new-schema** (no `run` key, and the always-present `tsconfig.json` already `extends` `@kvnwolf/dobby/*`) → the repo is **already migrated**. Say so plainly and **stop** — do not touch anything.
- **Any legacy signal present** → this is a real migration. Record the starting state (which deps, which config source, which files) so Step 10 can report the diff, and continue.

Announce the plan (the ordered steps below, flagging the two human gates) before you start executing.

## Step 1: Swap the dependencies

The toolchain is now bundled inside dobby; the consumer keeps only real build-time deps.

- **Add dobby:** `bun add -d @kvnwolf/dobby` — the project's single new dev dependency (the slot `vite-plus` used to occupy).
- **Remove the now-bundled tools** — only whichever are actually present: `bun remove vite-plus ultracite knip taze oxlint portless` (drop the names the repo doesn't have from the command). These all ship transitively inside dobby now.
- **Drop the vite-plus aliases:** remove `"vite": "npm:@voidzero-dev/vite-plus-core"` and `"vitest": "npm:@voidzero-dev/vite-plus-test"` from `package.json` `overrides`/`resolutions` (delete the `overrides` block entirely if that's all it held).
- **Restore the REAL packages:** `bun add -d vite` (and `bun add -d vitest` **only if the repo has tests** — `vitest` stays a consumer dep, detected as a capability; it is never bundled). Keep the repo's real vite plugins (`@vitejs/plugin-react`, `@tanstack/*`, nitro, react-compiler, …), `drizzle-kit`, `typescript` types, and `@types/*` — those are build-time, not toolchain.
- **Preserve project-specific config keys in `package.json`.** The `portless` config key (admin's `admin.logikpeak`) STAYS — portless is still used by `dobby dev`/`up` to resolve the branch-prefixed URL; only the portless *dependency* is removed (it's bundled). Likewise keep `trustedDependencies` and any other genuine project config.

## Step 2: Thin the config files

The migration WRITES exactly one config file — a thin `tsconfig.json`. Every other tool config (`biome.jsonc`, `vite.config.ts`, `vitest.config.ts`, `drizzle.config.ts`) is now **dobby-internal by default**: dobby passes its shipped, capability-picked preset through the tool's native config flag whenever the consumer has NO file of its own, so you author (or keep) one of those files ONLY to carry a real delta — creating it is a **total override**, deleting it restores the default (**override by presence**, ADR-0015). `tsconfig.json` is the one that always stays, because `tsc` and vite's `resolve.tsconfigPaths` read it directly and it holds genuinely per-project `paths`.

**`tsconfig.json`** → extend the base (the **vite variant** for a Vite app), preserving only the project's own fields:

```json
{ "extends": "@kvnwolf/dobby/tsconfig/vite", "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }
```

A **Vite app** extends `@kvnwolf/dobby/tsconfig/vite` (the base plus `types: ["vite/client"]`); a non-Vite project extends `@kvnwolf/dobby/tsconfig`. Carry over the project-specific `compilerOptions.paths`, `include`, `types`, and any genuinely project-local option; **drop** everything the base already sets (`strict`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`, `allowImportingTsExtensions`, `module`, `moduleResolution`, `noEmit`, `jsx`, …) — and on the vite variant drop `types: ["vite/client"]` too — so the thin file only holds deltas.

**Mid-migration escape hatch.** Unlike Biome, `tsc` has NO per-path allowlist — it checks the whole import graph, so base strictness like `noUnusedLocals`/`noUnusedParameters` fires on legacy/unmigrated paths the lint allowlist deliberately skips. A progressively-migrating repo MAY set them `false` in its thin file — a DELIBERATE deviation, not preset noise — with a rationale comment and a "revisit when fully migrated" flag; Step 10's summary must list any such deviation as debt.

**`biome.jsonc`** → create it **ONLY when the repo carries real lint/format deltas**. A repo whose style already matches the house rules writes NO `biome.jsonc` at all — dobby's capability-picked preset (`@kvnwolf/dobby/biome/react` for a React app, `@kvnwolf/dobby/biome/core` otherwise) governs BOTH the gate and the edit hook by default. When you DO have deltas, the file `extends` that preset and carries only the deltas:

```jsonc
{ "extends": ["@kvnwolf/dobby/biome/react"] }
```

The deltas a migration typically carries are the load-bearing bits of the OLD `vite.config.ts` `fmt`/`lint` blocks, translated into Biome form (Biome 2 syntax):

- **Old `ignorePatterns` → `files.includes` with `!` negation.** In Biome 2 the include list **must start with `"**"`** (include everything) and then negate; `"!path"` force-ignores from linting (still indexed — use for generated dirs), `"!!path"` force-excludes from indexing too (use for build output like `dist/`). Example — old `ignorePatterns: ["src/routeTree.gen.ts", "dist"]` becomes:

  ```jsonc
  { "extends": ["@kvnwolf/dobby/biome/react"], "files": { "includes": ["**", "!src/routeTree.gen.ts", "!!dist"] } }
  ```

- **Allowlist (progressive migration) `ignorePatterns` → POSITIVE `files.includes`.** This IS a real delta, so a progressively-migrating repo always writes its own `biome.jsonc` for it. A vite-plus `ignorePatterns` of the shape `["**/*.*", "!pathA", "!pathB", …]` is not a denylist but a progressive-migration ALLOWLIST — ignore everything, re-include only the migrated paths. It inverts to a POSITIVE include list: list exactly the previously-negated paths with the `!` prefixes dropped, and NO leading `"**"` (a positive include list = Biome handles ONLY matching paths). Example — old `ignorePatterns: ["**/*.*", "!src/lib", "!src/routes"]` becomes:

  ```jsonc
  { "extends": ["@kvnwolf/dobby/biome/react"], "files": { "includes": ["src/lib", "src/routes"] } }
  ```

  **Maintenance rule (field trap):** any config file CREATED later in this same migration (e.g. a new `vitest.config.ts`) must be hand-added to the allowlist, or Biome never sees it.

- **Old per-path lint `rules` → `overrides`.** Each old rule override maps to an entry in the `overrides` array keyed by glob:

  ```jsonc
  { "overrides": [ { "includes": ["**/*.test.ts"], "linter": { "rules": { "suspicious": { "noExplicitAny": "off" } } } } ] }
  ```

Only carry the rules the project genuinely deviates on — the preset already sets the house style; a rule that merely re-states a preset default is noise.

- **The swap is a re-lint, not a rename.** The gate now lints the whole tree under the dobby preset — whether that's dobby's default or your delta `biome.jsonc` — so files that were clean under oxlint surface NEW findings (field case: findings from rules like `complexity/useOptionalChain`, `correctness/useExhaustiveDependencies`, `a11y/noStaticElementInteractions` on already-migrated files; note the house preset now turns `suspicious/noArrayIndexKey` OFF, so it never fires). Each is a human fix-vs-suppress call: fix what's cheap (optional chains), suppress the deliberate ones with `// biome-ignore lint/<group>/<rule>: <reason>` (JSX form `{/* biome-ignore … */}` inside markup), folding any existing prose justification into the reason string. Also remove DEAD suppressions Biome reports as "Suppression comment has no effect".

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

## Step 4: Remove the dead hook + script machinery

Git hooks and package scripts die with vite-plus — the gate now lives in `dobby check` (`dobby check --fix` is the pre-commit gate).

- `rm -rf .vite-hooks` — the git-hook shims (`vp config` wrote them) are dead; the edit-time gate is the PostToolUse `dobby check --hook`, the pre-commit gate is `bunx dobby check --fix`.
- Remove the `prepare` script and **every** `package.json#scripts` entry — tasks are inferred from capabilities now, so the field is dead weight (in both field cases there was **no `scripts` field at all** — tasks lived in `vite.config.ts`; if the repo likewise has none, there's simply nothing to remove here).

## Step 5: Move files to canonical paths + rewrite imports — HUMAN GATE

dobby imposes fixed canonical paths instead of per-project args. One move may apply:

- **React-email templates → `src/emails/`** (`dobby dev` runs `email dev --dir src/emails`).

If it applies (skip when the source doesn't exist or is already at the canonical path): **grep the whole repo for every import of the old path** and prepare the rewrite so no import dangles.

> **HUMAN GATE — this is destructive.** Present the exact plan first: which files move where, and every import that will be rewritten (old → new). Move and rewrite **only on the user's approval**. Do the file move and the import rewrites together, in one atomic step, so the tree never has a broken import.

## Step 6: Ensure `.worktreeinclude` exists

A fresh git worktree needs the gitignored env/config files copied in, and `dobby up`'s setup phase re-materializes them from `.worktreeinclude`. If the file is **missing**, create it at the repo root (gitignore syntax, one glob per line) — at minimum `.env.local`, plus any other gitignored file the app needs to boot (discover from `.gitignore` + the repo's `.env*` set). If it already exists, leave it. (admin had none — its env copy was Conductor-only, so a terminal-host worktree booted without creds and hard-failed; creating `.worktreeinclude` is the fix.)

## Step 7: Regenerate `dobby.config.json` + delete the legacy YAML

Rewrite the config to the shrunken schema (`../onboard/references/dobby-config.md`): `files` (doc-sync, always) plus **only truly-custom** `setup`/`teardown`/`checks` extras.

- **`files[]` — preserve the doc-sync rules.** When the source is `.claude/commit.config.yml` (admin), convert its `files` (`{ path, update_when[] }`) to JSON **verbatim** — carry every path and every `update_when` string across unchanged. When the source is an old `dobby.config.json` (vonda), keep its existing `files[]`.
- **DROP `run`** and anything now inferred. The old `setup: ["vp install"]` goes (the default is `bun install`); any old local-DB-stop `teardown` goes (Neon teardown is inferred by `dobby down`); `checks: ["vpr validate"]` goes (`dobby check` IS the gate). Keep an extra **only** if it's a genuine project need the inference does not cover — an unusual install step, a real cleanup dobby can't infer, a project-specific check. A hybrid mid-migration database is exactly such a need — e.g. local Supabase still in use while the repo moves to Drizzle/Neon: `"setup": ["supabase start"]` (idempotent) replaces the old dev task's `dependsOn: db:start`; the Supabase CLI commands (`db push/reset/new`, `gen types`, `lint/diff/status`) stay MANUAL (transitional state, not inferred); NEVER wire an auto-stop (local Supabase is a machine-wide singleton shared across repos). Most migrated repos end up with `files` only.
- **No-clobber caution:** if a hand-authored new-schema `dobby.config.json` already exists, merge the `files[]` additively and show the diff rather than overwriting it.
- **`tracker` — mechanize the issue-tracker line, don't drop it.** Scan the legacy source (`.claude/commit.config.yml` and/or CLAUDE.md prose) for an issue-tracker declaration and carry it into `dobby.config.json`'s top-level `tracker` key — `{ "type": "github" | "linear" | "local" }` (see `../backlog/references/trackers.md`). Defer a Linear `team` to `/dobby:onboard` when it isn't trivially derivable from the source; **never fabricate a `team`** — a deferred `team` is flagged in Step 10, a wrong one silently misroutes work.
- **Delete `.claude/commit.config.yml`** once its `files[]` (and any `tracker` line) are carried across. Leave the rest of `.claude/` (host-owned settings/commands/agents/hooks) untouched.

## Step 8: Delete `.conductor/` — HUMAN GATE

The kit **dropped Conductor support** — one execution host remains (terminal, with cmux enrichment). Everything `.conductor/` did is now absorbed elsewhere: workspace-as-worktree and the env-file copy are handled by native `EnterWorktree` + `dobby up`'s setup phase; `auto_run_after_setup` and the run lifecycle are `dobby up`/`down`; the Neon branch-per-worktree provisioning (admin's `setup.sh`/`archive.sh` `neonctl` glue) now lives in `dobby up`/`down`, reading `NEON_API_KEY` + `NEON_PROJECT_ID` from `.env.local`.

> **HUMAN GATE — this is destructive and irreversible.** Note the rationale (Conductor removal is recorded in the kit's Conductor-removal ADR, which supersedes ADR-0005 — everything Conductor did is documented there for a possible future re-add) and confirm before running `rm -rf .conductor`. Running the kit under Conductor becomes unsupported after this.

## Step 9: Rewire the CI workflow

In the repo's CI (`.github/workflows/*`), replace the vite-plus install + gate with dobby's:

- `vp install` (or a vite-plus setup action) → `bun install`.
- `vpr validate` / `vp check` (and any separate `vp build`/`vp test` gate step) → **`bunx dobby check`** — the single full gate (biome, tsc, knip, capability-gated build + vitest, plus any `checks[]` extras).
- **Vercel (or any external builder) — point the build at dobby.** If the repo deploys on Vercel, set the **Build Command** to `bunx dobby build` (in `vercel.json`'s `buildCommand`, or the project dashboard) so external builds go THROUGH dobby too — the config-less vite default (and any future build-time niceties) apply centrally, with no per-project buildCommand drift.

Leave the rest of the workflow (checkout, Bun setup, caching, deploy) as it is.

## Step 10: Verify + report the summary

Prove the migration landed, one pass:

- **`bunx dobby check`** runs **green** from the repo root — the full inferred gate passes against the migrated tree.
- **`bunx dobby env`** is **sane** — capabilities detected (vite, drizzle/neon, react-email if present), `config: present`, and a `devUrl` for a vite repo.

Then report the **migration summary** in plain buckets:

- **Swapped** — dobby added; which toolchain deps removed; vite/vitest de-aliased and restored real; which `package.json` keys preserved (e.g. the portless key).
- **Config surface** — `tsconfig.json` written thin (`extends` the base, only project deltas kept). Then, for each of `biome.jsonc` / `vite.config.ts` / `vitest.config.ts` / `drizzle.config.ts`, report whether it was **DELETED as now-default** (dobby's capability-picked preset governs via override-by-presence) or **KEPT for a real delta** — naming the delta (a progressive-migration allowlist in `biome.jsonc`, an `ssr.noExternal` in `vite.config.ts`, a spread-override in `drizzle.config.ts`, …).
- **Removed** — `.vite-hooks/`, `prepare` + scripts, `.claude/commit.config.yml`, `.conductor/`.
- **Moved** — which files went to `src/emails/` and how many imports were rewritten (or "none applied").
- **Config** — the new `dobby.config.json` (`files` count; any extras kept and why); `.worktreeinclude` created or already present; CI rewired (and, if the repo deploys on Vercel, the buildCommand pointed at `bunx dobby build`).

Flag any follow-ups the migration surfaced — e.g. a `setup[]`/`teardown[]`/`checks[]` extra the inference doesn't cover, or a stale README the swap left behind. Run `bunx dobby env` to confirm the resolved capabilities and the inferred `db:*` task names. **Also flag a deferred/incomplete `tracker`** — if Step 7 mechanized an issue-tracker line whose value wasn't fully specified (a Linear line without a trivially-derivable `team`, or any tracker not fully pinned), say so and tell the user to run `/dobby:onboard` to complete the `tracker` key (especially the Linear `team`) **before using the work skills** — otherwise the project has no usable tracker selection and new work would be recorded against the default GitHub backend.

## Next step

The migration is done. End by presenting an **AskUserQuestion** (one question) that restates the cutover to the dobby world is complete and offers:

- `/dobby:commit` *(Recommended)* — commit the migration (added dep, thin `tsconfig.json`, the now-default tool configs deleted/kept-for-deltas, removed machinery, deleted `.conductor/` + legacy YAML, moved files, new `dobby.config.json`, CI rewire); its `bunx dobby check --fix` gate runs green, proving the move end-to-end.
- `/dobby:onboard` — first, if Step 10 flagged an incomplete `tracker` (e.g. a Linear line whose `team` was deferred) to complete before using the work skills.
- **Stop here** — end the turn (e.g. to eyeball the moved files or the CI diff first).

On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool (chaining runs on the session's current model/effort). "Stop here" ends the turn.

## Language

Interact with the user in their language. Write the migrated `dobby.config.json`, the thin config files, and any code/import edits in English; keep domain terms and file paths in their real-world form, and preserve the user's own prose verbatim when it's kept.

## Acceptance checklist

- [ ] Preflight ran first: legacy signals detected (`.claude/commit.config.yml`, old-era `dobby.config.json` with `run`, vite-plus/aliases, `.vite-hooks`/`.conductor`); an already-migrated repo was reported and left untouched; the plan (with the two gates flagged) was announced
- [ ] Deps swapped: `@kvnwolf/dobby` added; present toolchain deps removed (`vite-plus`/`ultracite`/`knip`/`taze`/`oxlint`/`portless`); vite/vitest aliases dropped; real `vite` (and `vitest` if tests) restored; project keys preserved (portless key, `trustedDependencies`)
- [ ] `tsconfig.json` written thin (the one config file that ALWAYS stays): `extends @kvnwolf/dobby/tsconfig` (or `/tsconfig/vite` for a Vite app) keeping only project deltas (paths/include/types), absorbed options dropped (`allowImportingTsExtensions`/`noUncheckedSideEffectImports`)
- [ ] Override-by-presence honored on the other tool configs: `biome.jsonc` / `vite.config.ts` / `vitest.config.ts` / `drizzle.config.ts` DELETED when delta-less (dobby's capability-picked default governs the gate + edit hook); a file KEPT only for a real delta — `biome.jsonc` `extends @kvnwolf/dobby/biome/{react|core}` carrying the allowlist/`overrides` (old `ignorePatterns`→`files.includes`, `**` first + `!`/`!!` negation; old rules→`overrides`); `vite.config.ts` a `mergeConfig` onto `@kvnwolf/dobby/vite/tanstack-start` (e.g. `ssr.noExternal`); `vitest.config.ts` a `mergeConfig` onto `@kvnwolf/dobby/vitest/react` (real delta only); `drizzle.config.ts` a spread-override onto `@kvnwolf/dobby/drizzle`
- [ ] `.vite-hooks/` removed; `prepare` + every `package.json#scripts` entry removed
- [ ] HUMAN GATE honored before file moves; the canonical-path move done with all imports rewritten atomically (react-email → `src/emails/`); skipped cleanly when N/A
- [ ] `.worktreeinclude` created (at least `.env.local`) if missing; left as-is if present
- [ ] `dobby.config.json` regenerated to the shrunken schema: `files[]` preserved/converted verbatim; `run` and inferred `setup`/`teardown`/`checks` dropped; only truly-custom extras kept; no-clobber on an existing hand-authored config; `.claude/commit.config.yml` deleted, rest of `.claude/` untouched
- [ ] Legacy issue-tracker line (naming Linear/local/github, from `.claude/commit.config.yml` or CLAUDE.md) MECHANIZED into `dobby.config.json`'s top-level `tracker` key (`{ "type": ... }`), NOT deleted — Linear `team` key deferred to `/dobby:onboard` when not trivially derivable, never fabricated; an incomplete `tracker` flagged in the summary
- [ ] HUMAN GATE honored before deleting `.conductor/`; ADR rationale (Conductor removal, supersedes ADR-0005) noted
- [ ] CI rewired: `vp install`→`bun install`, `vpr validate`/`vp check`→`bunx dobby check`; Vercel buildCommand pointed at `bunx dobby build` if the repo deploys there; rest of the workflow left intact
- [ ] Verified: `bunx dobby check` green + `bunx dobby env` sane; migration summary reported (swapped / config surface [deleted-as-default vs kept-for-deltas] / removed / moved / config)
- [ ] Ended with the AskUserQuestion gate (`/dobby:commit` recommended, `/dobby:onboard` first if `tracker` incomplete, or stop here); the chosen `/dobby:<skill>` invoked through the Skill tool
