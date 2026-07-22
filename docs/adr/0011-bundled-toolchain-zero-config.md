# The CLI bundles the toolchain and infers the tasks (zero-config)

**Status:** accepted — **supersedes both pillars of [ADR-0008](./0008-zero-framework-portable-cli.md)** (zero-dependency; no long-running commands). ADR-0008's other decisions stand: the `node:*`-portable core, the `run(argv, cwd)` test seam, releases from the main checkout. The editor-support rationale for thin consumer config files is superseded by [ADR-0015](./0015-configless-defaults.md) (configless override-by-presence).

ADR-0008 fixed a one-command CLI at zero dependencies and deferred long-running commands. This session the CLI became the kit's whole mechanical layer, and both constraints were deliberately dropped: `@kvnwolf/dobby` now **bundles the toolchain as runtime dependencies** — Biome via ultracite's Biome provider, TypeScript 7 (the Go-native `tsc`), knip, taze, portless — and **owns long-running commands** (`dev`, `up`/`down`) via a streaming split: `run()` stays the synchronous capture seam (plans, `--dry-run`), while the bin intercepts live `dev` and manages the detached process group. On top of the bundle sits **zero-config task inference à la Vercel**: capabilities detected from the consumer's regular deps infer the check pipeline, the `dev` composition, and the `db:*` set — no `package.json#scripts`, no task table, no `run` key (amending [ADR-0006](./0006-dobby-config-json.md)'s schema down to `files[]` + optional `setup[]`/`teardown[]`/`checks[]` extras). Consumers keep two thin config files (`tsconfig.json`, `biome.jsonc`) extending the exported presets (`@kvnwolf/dobby/tsconfig`, `/biome/core`, `/biome/react` — multi-level, so react apps extend one line), which preserves native editor support — the reason full config generation was rejected.

## Considered options

- **Bundle + infer (chosen)** — one devDependency updates every consumer's entire toolchain; proven core ported from lalibreta's `packages/devtools` (detectCapabilities → compose tasks).
- **Keep consumers' toolchains + orchestrate only** — rejected: version skew across repos was the standing pain (vite-plus pinning); centralizing the tools is the point.
- **oxlint/oxfmt instead of Biome** — rejected: user standardizes on Biome; ultracite v7 is multi-provider so the door stays open.
- **In-process tool APIs** — rejected: TS7 has NO JS API (parse `tsc --pretty false`), Biome's js-api is WASM and slower; everything shells out with machine reporters (JSON) and dobby reduces to token-lean output.

## Consequences

- **vitest is NOT bundled** — a bundled vite/vitest risks dual-Vite-instance breakage with the consumer's plugins; vite/vitest/drizzle-kit/email resolve consumer-local, bundled tools resolve from dobby's own tree, PATH is last-resort everywhere (`runner.resolveBin` — the `devUrl: null` field bug was a bare PATH spawn).
- No task caching in v1 (TS7/Biome are fast; measure first) and no monorepo inference (single-package consumers; this repo covers `cli/` via explicit root configs as the documented exception).
- The npm package is heavier by design; consumers get the whole toolchain transitively and `bun update @kvnwolf/dobby` moves everything at once.
