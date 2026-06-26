# dobby — working on this repo

This repo is a Claude Code plugin AND its own marketplace: the root is the plugin. `README.md` is the consumer-facing doc; this file is for evolving the kit itself.

The domain glossary lives in [`CONTEXT.md`](./CONTEXT.md) — use those terms exactly.

## Structure

- `.claude-plugin/` — `plugin.json` (the plugin manifest) + `marketplace.json` (points at `./`, making the repo installable directly).
- `skills/` — the kit's skills, one directory per skill (`SKILL.md` + optional `references/` / `examples/`).
- `agents/` — the four worker agents (`researcher`, `implementor`, `reviewer`, `verifier`).
- `hooks/` — `hooks.json` (auto-loaded when the plugin is enabled) + the scripts it runs via `${CLAUDE_PLUGIN_ROOT}`.
- `README.md` — the FULL consumer doc: install, mental model, lifecycle, first-session walkthrough, decision table, troubleshooting. Behavior changes to skills/agents must keep it in sync.

There is intentionally no `.claude/` self-install in this repo: the plugin is enabled at user scope (global `settings.json` registers this working tree as the `dobby` marketplace with `autoUpdate`), so every project — including this one — consumes it live. A project-level install here would re-register the same marketplace name from a different source.

## Conventions

- **Dogfood the kit**: evolve dobby through its own stages (`/dobby:scope` → … → `/dobby:wrap`) or `/dobby:dispatch` for small fixes. Friction found while doing so is signal — fix the kit, not the workaround.
- **Everything in English.** Three skill categories coexist. (1) The work-session **stage** skills (`scope` → … → `wrap`), the worker agents, and their supporting skills are **methodology** — project-agnostic, no references to any specific codebase. (2) The kit ALSO carries **convention** skills (`forms`, `data-fetching`, `module-conventions`) that encode the user's standard application stack (TanStack Start + Drizzle/Neon + Better Auth, the `@/shared` form/data system) and intentionally reference its module file conventions — deep-path imports and the role-based file taxonomy (`{export}.server.ts` / `functions.ts` / `{descriptor}.browser.ts` / `schema.gen.ts`), no barrels. That coupling is deliberate, not a leak to genericize. (3) **Kit self-improvement tooling** (`mark`, `learn`) couples to the *host* — Claude Code session storage (`~/.claude/projects`, `CLAUDE_CODE_SESSION_ID`) — not to any project, and exists to evolve the kit from how it behaved in real field sessions. That host-coupling is intentional and each such `SKILL.md` must label itself as this category so it isn't mistaken for project-agnostic methodology.
- **Explicit `model:` + `effort:` in EVERY skill and agent frontmatter.** Never rely on session/settings defaults — the asymmetry (architect max, workers tiered) is deliberate and must survive any host config.
- **Namespacing is mandatory**: cross-references between kit pieces are always `/dobby:<skill>` and `dobby:<agent>`. Bare names only for things outside the plugin. After any rename/addition, grep for bare references.
- **The architect never works**: skills must keep delegation explicit (which worker, via which mechanism). A skill that has the main thread grepping or editing is a regression.
- **No interruptions mid-flow**: stages run to completion; gates exist only at stage handoffs (Next-step) and plan approval. No teach-backs.
- **Stage handoffs are TYPED, never auto-invoked**: a stage ends with a plain-text suggestion of the next `/dobby:*` command — no AskUserQuestion gate, no Skill-tool chaining. Typed entry is what applies the next skill's `model`/`effort`; a chained skill rides the current turn's override.
- **Preserve attributions** (e.g. `prototype` is adapted from mattpocock/skills).

## Dev loop

- Test locally: `claude --plugin-dir .` from any project, then exercise the skills there.
- `SKILL.md` edits hot-reload; changes to `agents/` or `hooks/` need `/reload-plugins`.
- Manifest sanity: both JSON files in `.claude-plugin/` must stay parseable; the marketplace `source` stays `./`.

## Workflow config

- **Issue tracker**: none for now — `/dobby:backlog` has no destination in this repo yet; capture follow-ups in conversation until one is chosen.
- **Dev command**: `claude --plugin-dir .` (no dev server or URL — this is a Claude Code plugin, not an app). `/dobby:execute`'s verifier exercises skills through that host session.
- **Commit contract**: `.claude/commit.config.yml` — doc-sync rules (README/CLAUDE/CONTEXT) + pre-commit checks (manifest parse, frontmatter model/effort). Read by `/dobby:commit`.
