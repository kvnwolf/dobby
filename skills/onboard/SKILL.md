---
name: onboard
description: Initialize a project so the work skills can run in it — interview the user about the project, scaffold the base files (CONTEXT.md, CLAUDE.md, docs/adr/, .gitignore), set the workflow config (issue tracker, dev command), and configure Conductor setup (write .conductor/settings.toml + setup.sh/archive.sh stubs so each workspace installs and auto-runs). Use once at the start of a new (greenfield) project, or to set up an existing repo for the work skills.
disable-model-invocation: true
argument-hint: "[project idea, if greenfield]"
model: opus
effort: max
---

Set up a project so `/dobby:scope → /dobby:interview → /dobby:research → /dobby:spec → /dobby:execute → /dobby:wrap` can run in it. Run once. This lays down the adapter the generic skills read from.

## Step 1: Interview about the project

One question at a time (AskUserQuestion where the options are anticipatable; plain text otherwise). Establish:

- What the project is and who it's for (the product in 1-2 sentences).
- The core domain terms — the start of the ubiquitous language.
- The stack (language, framework, data layer, key services). Use `/find-docs` to confirm the CURRENT setup commands for the chosen stack — don't rely on memory.
- **The `run_mode`** — does the stack rely on shared singletons (one local DB, fixed ports, e.g. a local Supabase / Postgres you can only run once per machine)? **Yes → `nonconcurrent`** (a new Conductor workspace stops any other active run so they don't fight over the singleton). **No → `concurrent`** (each workspace runs its own dev server on its own per-workspace port). This decides Step 2's `settings.toml`.
- The issue tracker (GitHub / Linear / local markdown).
- Greenfield or existing repo? If greenfield, the first slice you'll build.

## Step 2: Make it runnable via Conductor

Don't reinvent scaffolding — for a greenfield repo, use the stack's OWN create command (the framework's `create` CLI) to lay down a runnable starter. If the repo already runs, skip the scaffold. Don't verify a Node floor from memory; if a tool needs a minimum Node, confirm it before writing it into `engines`/docs.

The project runs through **Conductor**: every workspace runs `.conductor/setup.sh` once, then Conductor's `run` script (auto-started when `auto_run_after_setup` is on). That's what `/dobby:execute` health-checks with `curl` before launching the workflow. The dev command runs through **portless** (`portless run <dev command>`, e.g. `portless run vite dev`) — portless gives each worktree a branch-prefixed `https://<branch>.<name>.localhost`, so concurrent workspaces never collide over the dev URL WITHOUT needing `$CONDUCTOR_PORT`. Write these three files (never a run skill):

**`.conductor/settings.toml`** — the repo-level Conductor config (checked in). Pick the template by the `run_mode` decided in Step 1, and set BOTH `run_mode` and `auto_run_after_setup` **explicitly** — neither has a documented default, so an omitted key is undefined behavior, not a safe fallback.

Concurrent — no shared singletons; each workspace gets its own dev server, and **portless** isolates the URL per worktree (branch-prefixed), so nothing collides and no `$CONDUCTOR_PORT` is needed. The run command wraps the dev command with `portless run`:

```toml
# concurrent (portless-isolated URLs per worktree, no singletons)
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"
[scripts]
setup = "./.conductor/setup.sh"
run_mode = "concurrent"
auto_run_after_setup = true
archive = "./.conductor/archive.sh"
[scripts.run.dev]
command = "portless run vite dev"
default = true
icon = "play"
```

Nonconcurrent — a shared DB/port singleton (e.g. local Supabase / a fixed local Postgres you can only run once per machine). The run command still wraps the dev command with `portless run` (so the URL stays branch-prefixed), but `run_mode = "nonconcurrent"` makes Conductor stop any other active run so two workspaces never fight over the singleton:

```toml
# nonconcurrent (shared DB/port singleton, e.g. local Supabase)
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"
[scripts]
setup = "./.conductor/setup.sh"
# nonconcurrent + auto_run: each new workspace steals the shared dev server from the previous one.
run_mode = "nonconcurrent"
auto_run_after_setup = true
archive = "./.conductor/archive.sh"
[scripts.run.dev]
command = "pnpm supabase start && portless run pnpm dev"
default = true
icon = "play"
```

`auto_run_after_setup × run_mode` interaction — **write the two keys together and leave a comment**: with `nonconcurrent + auto_run_after_setup = true`, every newly-created workspace auto-starts the run, which (being nonconcurrent) STEALS the shared singleton from whatever workspace was running it. That may be exactly what you want (the newest workspace is the active one), but it's surprising — so state it in a comment right above the keys, e.g. `# nonconcurrent + auto_run: each new workspace steals the shared dev server from the previous one.`

Copy gitignored files each workspace needs (env, local config) with **`file_include_globs`** — a **multi-line string, one glob per line** (NOT a TOML array):

```toml
file_include_globs = """
.env.local
.env.*.local
"""
```

**Secrets never go in `settings.toml`** (it's checked in). Put API keys / DB URLs in `.conductor/settings.local.toml` (same directory, machine-local, gitignored in Step 3) under `[environment_variables]`; non-secret env can stay in `settings.toml`'s `[environment_variables]`. **NEVER write a `[models]` table to the repo `settings.toml`** — the repo schema doesn't accept model tiers there (those live in `~/.conductor/settings.toml`); it would fail validation.

**`.conductor/setup.sh`** — a minimal, executable install stub the workspace runs once. Start with just dependency install; leave stack-specific setup (DB branch/seed, migrations) as a commented TODO:

```sh
#!/usr/bin/env bash
set -euo pipefail
pnpm install
# TODO: stack-specific setup (e.g. DB branch/seed, migrations) goes here.
```

**`.conductor/archive.sh`** — a minimal, executable cleanup stub run when a workspace is archived. Start empty (a no-op comment) unless the nonconcurrent stack needs teardown (e.g. `pnpm supabase stop`):

```sh
#!/usr/bin/env bash
set -euo pipefail
# TODO: cleanup on archive (e.g. stop a shared DB) goes here.
```

`chmod +x .conductor/setup.sh .conductor/archive.sh` so Conductor can run them.

**No-dev-server project** (a library, CLI, or plugin — like dobby itself, which has no app to serve): write `settings.toml` with **no `[scripts] run`** at all (keep `setup`, `run_mode`, `archive`). With no run target, **`auto_run_after_setup = false`** (or omit it entirely) — NEVER leave it `true` when there's nothing to run. There's no dev URL to read, so `/dobby:execute`'s verifier runs the verify recipe programmatically instead of driving a browser.

## Step 3: Scaffold the base files

- **`CONTEXT.md`** (repo root) — the domain glossary. Format: `# {Project}` + a 1-2 sentence description, then `## Language` (each term as `**Term**:` + a one-sentence definition + `_Avoid_:` aliases, grouped under subheadings when clusters emerge), `## Relationships` (bold terms + cardinality), and `## Flagged ambiguities`. Opinionated, tight, domain-only — start small with the Step 1 terms; it grows via `/dobby:interview` and `/dobby:wrap`.
- **`CLAUDE.md`** (repo root) — the agent config, with these sections:
  - **Product** — what it is + who it's for.
  - **Stack** — language, framework, data layer, key services, plus a short **Dev** note: the app runs via **Conductor** (`.conductor/settings.toml`; `auto_run_after_setup` auto-starts the run script in each workspace), and the run command wraps the dev command with **portless**. Do NOT pin a `npm run dev` command or a hardcoded dev URL here — the URL is branch-prefixed, so it is NOT hardcodable; `/dobby:execute`'s verifier obtains it via `portless get <name>` (deterministic, branch-prefixed).
  - **Module map** — one line per top-level feature/domain module, each linking to that module's own `CONTEXT.md`, e.g. `- [src/<area>/<module>/](src/<area>/<module>/CONTEXT.md) — what it owns`.
  - **Conventions** — encode deep, contained modules: organize by feature/domain (NO type-based `components/`/`services/`/`lib/` buckets); NO barrels — callers import by deep path, each file named by its role (the filename is the interface); co-locate the slice; inline by default; **each module carries its own `CONTEXT.md`** (purpose · Files · Interface · Invariants · What's NOT here). "What works for humans is also great for AI."
  - **Workflow config** — the issue tracker (GitHub / Linear / local) and how the app runs: **via Conductor** (`.conductor/settings.toml`, `auto_run_after_setup`), with the run command wrapping the dev command in **portless**. Do NOT pin a hardcoded dev URL — `/dobby:execute`'s verifier obtains it via `portless get <name>` (deterministic, branch-prefixed via the worktree, so it is NOT hardcodable). For a no-dev-server project, say so (there's no run script → no dev URL; the verifier verifies programmatically).
- **docs/adr/** — create the directory (add `0001-...` only if the stack choice meets the three ADR criteria: hard to reverse · surprising · real trade-off).
- **.gitignore** — ensure `STATE.md` is ignored (the ephemeral work-session doc) and `.conductor/settings.local.toml` is ignored (machine-local Conductor secrets), plus the stack's standard ignores. Note: `.conductor/settings.toml`, `setup.sh`, and `archive.sh` ARE checked in — only `settings.local.toml` is ignored.

Don't scaffold per-module `CONTEXT.md` files now — each module gets its own when `/dobby:execute` builds it.

## Step 4: Set the commit contract

Create `.claude/commit.config.yml` following `references/commit-config.md` — discovery (docs to sync + pre-commit checks, via a `dobby:researcher`), user confirmation, write. On a greenfield repo the doc list starts with the files just scaffolded and the checks come from the stack's own toolchain (typecheck/lint/test). This is the contract `/dobby:commit` reads — without it, commits skip doc-sync and checks.

## Step 5: Hand off

Setup is done. End with a plain-text handoff: suggest the user TYPE `/dobby:scope <first goal>` (ask for the goal first if not already clear) — NO AskUserQuestion, NO Skill-tool auto-invoke; typed entry applies `/dobby:scope`'s own `model`/`effort`. Or stop here — they'll start a work session later.

- **`/dobby:scope <first goal>`** *(Recommended)* — start the first work session.
- **Stop here.**

## Language

Interview in the user's language. **Write all generated docs and code — CLAUDE.md, CONTEXT.md, ADRs, `.conductor/` config + scripts, code, comments — in English**, regardless of the product's market or UI language. Two carve-outs: domain glossary **terms** keep their real-world form (a Spanish-market product legitimately has terms like `Estuche` / `Sucursal` — keep the headword, write the definition in English), and user-facing **UI strings / content** stay in the product's language. Conversation with the user stays in their language. Don't infer the doc language from the product's market.

## Acceptance checklist

- [ ] Interviewed: product, domain terms, stack (docs confirmed via /find-docs), `run_mode` (singletons? → concurrent/nonconcurrent), tracker, greenfield-or-existing
- [ ] Conductor configured: `.conductor/settings.toml` written from the right template (`run_mode` AND `auto_run_after_setup` explicit); the `[scripts] run` command wraps the dev command with `portless run` (branch-prefixed URL, no `$CONDUCTOR_PORT`); `nonconcurrent + auto_run` interaction noted in a comment; no `[models]` table
- [ ] No-dev-server project (lib/CLI/plugin): NO `[scripts] run`, and `auto_run_after_setup = false` (or omitted) — never `true` with no run target
- [ ] `.conductor/setup.sh` + `.conductor/archive.sh` stubs written and `chmod +x`; `file_include_globs` (multi-line string) copies gitignored env files; secrets go in gitignored `.conductor/settings.local.toml`, not `settings.toml`
- [ ] CONTEXT.md scaffolded (initial glossary) — in English; domain terms keep their real-world form
- [ ] CLAUDE.md scaffolded (product, stack, module map, deep-module conventions, workflow config) — in English; Dev/Workflow note says the app runs via Conductor with the run command wrapping the dev command in portless, and the verifier obtains the dev URL via `portless get <name>` (no hardcoded URL)
- [ ] docs/adr/ created; `.gitignore` ignores `STATE.md` and `.conductor/settings.local.toml`
- [ ] `.claude/commit.config.yml` created (docs to sync + pre-commit checks, user-confirmed)
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
