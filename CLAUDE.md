# dobby — working on this repo

This repo is a Bun monorepo shipping two surfaces: **`plugin/`** — the Claude Code plugin (skills, agents, hooks) — and **`cli/`** — the `@kvnwolf/dobby` CLI. The repo is ALSO its own marketplace: `.claude-plugin/marketplace.json` stays at root and points at `./plugin`. `README.md` is the consumer-facing doc; this file is for evolving the kit itself.

The domain glossary lives in [`CONTEXT.md`](./CONTEXT.md) — use those terms exactly.

**The kit runs on one of two named execution hosts**, detected by env var — no generic N-host abstraction. (1) **Conductor** (`CONDUCTOR_WORKSPACE_PATH` present): sessions run inside a Conductor workspace; the host creates one git worktree per session and auto-runs the app (`auto_run_after_setup`), and `/dobby:onboard` writes `.conductor/settings.toml`. (2) **Terminal** (env var absent): a plain `claude` session (incl. ssh) where the KIT owns the worktree + run lifecycle — `/dobby:scope` creates+enters the per-goal worktree (native `EnterWorktree`), the app runs lazily at `/dobby:execute` Step 2, and `/dobby:finish` tears down post-merge; **cmux enrichment** (named run/browser panes, cmux-browser UI driver) kicks in when `CMUX_WORKSPACE_ID` is set, degrading gracefully to a background job otherwise. On BOTH hosts the coordinator + verifier reach the running app via the identical `portless get` + curl recipe (dev URL and liveness); the only host difference is who starts the run. (ADR-0001 is superseded by [ADR-0005](./docs/adr/0005-two-named-execution-hosts.md).)

## Structure

- `.claude-plugin/marketplace.json` — the marketplace manifest, kept at root; its `plugins[0].source` is `./plugin`, making the repo installable directly.
- `plugin/` — the Claude Code plugin itself (self-contained; cache-copied on install, so it can never reference `../cli`):
  - `plugin/.claude-plugin/plugin.json` — the plugin manifest.
  - `plugin/skills/` — the kit's skills, one directory per skill (`SKILL.md` + optional `references/` / `examples/`).
  - `plugin/agents/` — the five worker agents (`researcher`, `test-author`, `implementor`, `reviewer`, `verifier`). `test-author` writes tests from the spec only (never seeing the implementation) and runs at the front of the build loop; see [`CONTEXT.md`](./CONTEXT.md) for the build-loop shape.
  - `plugin/hooks/` — `hooks.json` (auto-loaded when the plugin is enabled) + the scripts it runs via `${CLAUDE_PLUGIN_ROOT}`.
- `cli/` — the `@kvnwolf/dobby` Bun CLI workspace (the monorepo's `workspaces` member). Module doc: [`cli/CONTEXT.md`](./cli/CONTEXT.md).
- `docs/` — the kit's **durable artifacts** written by skills as work proceeds: `adr/` (architecture decision records from `/dobby:wrap` + `/dobby:address-review`), `maps/` (decision-maps from `/dobby:map`), `out-of-scope/` (the out-of-scope KB from `/dobby:triage`, one file per concept), `learn-discarded/` (the discarded-frictions KB from `/dobby:learn`). Committed and git-tracked; the KB dirs are created lazily by their skills (no empty dirs committed). STATE.md stays ephemeral at the repo root — it is NOT a durable artifact.
- `README.md` — the FULL consumer doc: install, mental model, lifecycle, first-session walkthrough, decision table, troubleshooting. Behavior changes to skills/agents must keep it in sync.

There is intentionally no `.claude/` self-install in this repo: the plugin is enabled at user scope (global `settings.json` registers this working tree as the `dobby` marketplace with `autoUpdate`), so every project — including this one — consumes it live. A project-level install here would re-register the same marketplace name from a different source.

## Conventions

- **Dogfood the kit**: evolve dobby through its own stages (`/dobby:scope` → … → `/dobby:wrap`) or `/dobby:dispatch` for small fixes. Friction found while doing so is signal — fix the kit, not the workaround.
- **Everything in English.** Three skill categories coexist. (1) The work-session **stage** skills (`scope` → … → `wrap`), the **side-path** skills that plug into the flow on demand (`handoff`, `triage`, `map`, `resolve-conflicts`, `wizard`, `teach`), the worker agents, and their supporting skills are **methodology** — project-agnostic (no references to any specific codebase) but assuming one of the **two named execution hosts** (Conductor | terminal, env-var detected; the kit reaches the running app via the same `portless get` + curl recipe on both, and drives the UI via the cmux-browser → claude-in-chrome → curl ladder; see the statement above). (2) The kit ALSO carries **convention** skills (`data-processing`, `data-fetching`, `module-conventions`) that encode the user's standard application stack (TanStack Start + Drizzle/Neon + Better Auth, the `@/shared` form/data system) and intentionally reference its module file conventions — deep-path imports and the role-based file taxonomy (`{export}.server.ts` / `functions.ts` / `{descriptor}.browser.ts` / `schema.gen.ts`), no barrels. That coupling is deliberate, not a leak to genericize. (3) **Kit self-improvement tooling** (`mark`, `learn`) couples to the *host* — Claude Code session storage (`~/.claude/projects`, `CLAUDE_CODE_SESSION_ID`) — not to any project, and exists to evolve the kit from how it behaved in real field sessions. That host-coupling is intentional and each such `SKILL.md` must label itself as this category so it isn't mistaken for project-agnostic methodology.
- **Skills carry NO `model:`/`effort:`; agents keep them explicit.** Skills inherit the SESSION's model/effort — the maintainer raises the session tier for leverage-heavy work (the artifacts that steer everything downstream — spec, interview, map, diagnose, kit self-improvement) rather than pinning a tier per skill. AGENTS keep explicit `model:` + `effort:` in frontmatter: the worker asymmetry is deliberate and must survive any host config — code is never written by the top tier (a max-intelligence spec/brief executed by a mid-tier worker beats the inverse).
- **Namespacing is mandatory**: cross-references between kit pieces are always `/dobby:<skill>` and `dobby:<agent>`. Bare names only for things outside the plugin. After any rename/addition, grep for bare references.
- **The architect never works**: skills must keep delegation explicit (which worker, via which mechanism). A skill that has the main thread grepping or editing is a regression.
- **No interruptions mid-flow**: stages run to completion; gates exist only at stage handoffs (Next-step) and plan approval. No unsolicited explanations; teaching is opt-in via `/dobby:teach`.
- **Stage handoffs gate on an AskUserQuestion**: a stage ends with an AskUserQuestion at the Next-step — the recommended next `/dobby:*` command plus alternatives and "Stop here" as options; on selection the chosen skill is invoked. Since skills no longer carry their own `model`/`effort`, there is no per-skill tier to preserve by typing — the session's model/effort applies throughout, so invoking the next skill on selection is correct. (This Next-step AskUserQuestion IS the "gates exist only at stage handoffs and plan approval" gate above.)
- **Preserve attributions** (e.g. `prototype` is adapted from mattpocock/skills).

## Dev loop

- Test locally: `claude --plugin-dir ./plugin` from any project, then exercise the skills there.
- `SKILL.md` edits hot-reload; changes to `plugin/agents/` or `plugin/hooks/` need `/reload-plugins`.
- Manifest sanity: root `.claude-plugin/marketplace.json` and `plugin/.claude-plugin/plugin.json` must both stay parseable; the marketplace `source` stays `./plugin`.
- Aggregate gate: `vpr validate` from the repo root (= `vpr check && vpr unused && vpr test` — format/lint/type + knip + vitest, which discovers `cli/`'s tests from the root) is the whole-repo check, mirrored by CI and `/dobby:commit`. The root `vite.config.ts` is the ONLY vp config — `cli/` deliberately has none.

## Workflow config

- **Dev command**: `claude --plugin-dir ./plugin` (no dev server or URL — this is a Claude Code plugin, not an app). `/dobby:execute`'s verifier exercises skills through that host session.
- **Commit contract**: `dobby.config.json` — doc-sync rules (README/CLAUDE/CONTEXT) + pre-commit checks (manifest parse, frontmatter model/effort (agents only)). Read by `/dobby:commit`.
- **Releases**: `/release` (project skill, `.claude/skills/release/`) cuts an npm release of `cli/` — main checkout only, per [ADR-0008](./docs/adr/0008-zero-framework-portable-cli.md).
