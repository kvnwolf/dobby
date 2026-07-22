# PR reviewers cannot see inside a bundled preset

**Friction** — a PR that DELETES a tool config file (e.g. `drizzle.config.ts`) in favor of dobby's default draws an advisory review finding, because the reviewer (Greptile, and any bot or human reading the diff) cannot verify what the bundled preset in `node_modules/@kvnwolf/dobby` actually delivers. The deletion looks like a dropped config, not a swap onto an equivalent default, so the reviewer flags a possible regression it has no way to confirm or deny.

**Decision: discarded** (2026-07-22, `/dobby:learn` from the solraci/vonda migration session).

**Why** — the opacity is INHERENT to the bundled-toolchain architecture (ADR-0011) and the config-less-by-default stance (ADR-0015): the whole point is that a delta-less repo carries no tool config and dobby passes its shipped preset through the tool's native config flag, so "the config is gone from the diff" is the intended end state, not a defect to engineer away. And it's already mitigated: every preset is a plain committed file in the dobby repo (the biome presets are FLAT vendored — ultracite core/react verbatim + dobby's mods; the drizzle/vite/vitest presets are dobby-authored), so the exact config a deletion falls back to IS reviewable — in the dobby repo itself (the preset files live at the `cli/` package root: `cli/biome/*.jsonc`, `cli/tsconfig.*.json`, and the `cli/*.base.*` / `cli/*.tanstack.*` / `cli/*.react.*` presets for vite/vitest/drizzle), not in the consumer's diff. Adding kit machinery to re-surface preset contents into every consumer PR would fight the architecture to answer a question the source already answers. The reviewer response is a one-line reply pointing at the preset, not a kit change.

**Reconsider if** — dobby gains a way to emit a per-repo "what the defaults resolve to" artifact cheaply (e.g. `dobby check` writing a resolved-config snapshot a reviewer could diff against), turning the advisory into something self-serve. At that point surfacing the effective config is a real reviewer affordance rather than a re-implementation of the bundled toolchain.

## Prior occurrences

- 2026-07-22 session (solraci/vonda migration — `drizzle.config.ts` deletion in favor of dobby's default drizzle preset) — Greptile advisory: cannot verify the deleted config matches the bundled default, flagged as a possible regression
