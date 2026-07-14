# The repo is a Bun monorepo shipping two surfaces (plugin/ + cli/)

**Status:** accepted

The repo root used to BE the Claude Code plugin (marketplace `source: "./"`). dobby's next step — a CLI (`@kvnwolf/dobby`, bin `dobby`) runnable from any project, auto-detecting capabilities from installed dependencies with no manifest file — is a second product surface, and it needs JS tooling the plugin never had. We restructured the root into a **private Bun monorepo**: all plugin content moved to **`plugin/`** (self-contained), the CLI lives in **`cli/`** (the sole `workspaces` member), and the marketplace manifest **stays at root** `.claude-plugin/marketplace.json` with `plugins[0].source: "./plugin"` (relative subdirectory sources are documented Claude Code behavior; verified against current docs before the move). One brand, one repo, two surfaces — and the surfaces can compound: skills may later invoke the globally-linked `dobby` bin.

## Considered options

- **Same repo, monorepo with `plugin/` + `cli/` (chosen)** — one product with two delivery surfaces; the dev loop becomes `claude --plugin-dir ./plugin`; consumers of the marketplace are unaffected beyond a `/plugin marketplace update`.
- **Root `package.json` cohabiting with the plugin at root** — rejected: mechanically fine (Claude Code ignores unknown root files) but muddles the tree — plugin content and CLI code interleaved at one level.
- **A separate repo for the CLI** — rejected: two repos for one brand splits versioning, docs, and the self-improvement loop (`/dobby:learn` mines sessions to evolve BOTH surfaces).

## Consequences

- **`plugin/` must stay self-contained**: plugins are cache-copied on install, so nothing under `plugin/` may reference `../cli` (or any path outside `plugin/`). If a skill ever needs the CLI, it calls the `dobby` bin on PATH.
- Local install story is unchanged in shape but the registered marketplace needs a one-time `/plugin marketplace update dobby` after this lands on the main checkout.
- Repo-level docs (README, CLAUDE.md, CONTEXT.md, docs/, dobby.config.json) stay at root; `dobby.config.json` check commands were retargeted to the `plugin/` paths.
- The CLI's distribution is `bun link` from the main checkout (live, mirroring the marketplace's live-tree model); npm publish is deferred until CI/other machines need it.
- **The two surfaces version in LOCKSTEP**: one kit version per release, owned by the CLI's npm version (the only number with a hard contract); `plugin/.claude-plugin/plugin.json` mirrors it at release time, and release notes group changes by surface (Plugin / CLI / Kit). Accepted trade-off: a plugin-only release publishes an unchanged CLI under a new number, and the kit's semver is the KIT's contract, not pure CLI semver (a plugin `feat` bumps minor even when the CLI didn't change). Rationale: one number for one product, and future skill↔CLI compatibility is resolved by construction.
