---
name: onboard
description: Set up a repo (greenfield or existing) for the work skills — interview, scaffold the base files, write the dobby.config.json contract + the Conductor config. Run once.
disable-model-invocation: true
argument-hint: "[project idea, if greenfield]"
---

Set up a project so `/dobby:scope → /dobby:interview → /dobby:research → /dobby:spec → /dobby:execute → /dobby:wrap` can run in it. Run once. This lays down the adapter the generic skills read from.

## Step 1: Interview about the project

One question at a time (AskUserQuestion where the options are anticipatable; plain text otherwise). Establish:

- What the project is and who it's for (the product in 1-2 sentences).
- The core domain terms — the start of the ubiquitous language.
- The stack (language, framework, data layer, key services). Use `/find-docs` to confirm the CURRENT setup commands for the chosen stack — don't rely on memory.
- **The `run_mode`** — does the stack rely on shared singletons (one local DB, fixed ports, e.g. a local Supabase / Postgres you can only run once per machine)? **Yes → `nonconcurrent`** (a new Conductor workspace stops any other active run so they don't fight over the singleton). **No → `concurrent`** (each workspace runs its own dev server on its own per-workspace port). This decides Step 2's `settings.toml`.
- Greenfield or existing repo? If greenfield, the first slice you'll build.

## Step 2: Make it runnable via Conductor

Don't reinvent scaffolding — for a greenfield repo, use the stack's OWN create command (the framework's `create` CLI) to lay down a runnable starter. If the repo already runs, skip the scaffold. Don't verify a Node floor from memory; if a tool needs a minimum Node, confirm it before writing it into `engines`/docs.

The project runs through **Conductor**: every workspace runs `.conductor/setup.sh` once, then Conductor's `run` script (auto-started when `auto_run_after_setup` is on). That's what `/dobby:execute` health-checks with `curl` before launching the workflow. The dev command runs through **portless** (`portless run <dev command>`, e.g. `portless run vite dev`) — portless gives each worktree a branch-prefixed `https://<branch>.<name>.localhost`, so concurrent workspaces never collide over the dev URL WITHOUT needing `$CONDUCTOR_PORT`. Write these three files (never a run skill):

**`.conductor/settings.toml`** — the repo-level Conductor config (checked in). Pick the template by the `run_mode` decided in Step 1, and set BOTH `run_mode` and `auto_run_after_setup` **explicitly** — neither has a documented default, so an omitted key is undefined behavior, not a safe fallback.

Concurrent — no shared singletons; each workspace runs its own dev server behind its portless URL:

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

Nonconcurrent — a shared DB/port singleton. The run command still wraps the dev command with `portless run`; `run_mode = "nonconcurrent"` makes Conductor stop any other active run:

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

`auto_run_after_setup × run_mode` interaction — **write the two keys together and leave a comment**: with `nonconcurrent + auto_run_after_setup = true`, every newly-created workspace auto-starts the run and STEALS the shared singleton from whatever workspace was running it. That may be exactly what you want, but it's surprising — state it in a comment right above the keys, as in the template.

Copy gitignored files each workspace needs (env, local config) with **`file_include_globs`** — a **multi-line string, one glob per line** (NOT a TOML array):

```toml
file_include_globs = """
.env.local
.env.*.local
"""
```

**Secrets never go in `settings.toml`** (it's checked in). Put API keys / DB URLs in `.conductor/settings.local.toml` (same directory, machine-local, gitignored in Step 3) under `[environment_variables]`; non-secret env can stay in `settings.toml`'s `[environment_variables]`. **NEVER write a `[models]` table to the repo `settings.toml`** — the repo schema doesn't accept model tiers there (those live in `~/.conductor/settings.toml`); it would fail validation.

**If the stack needs manual external-service setup** — creating a database (Neon), configuring auth (Better Auth), setting CI secrets — those values can't be scaffolded, only obtained by a human clicking through provider dashboards. Rather than hand-walk the user each time, **offer to invoke `/dobby:wizard`**: it generates a guided bash wizard that opens each URL, says what to click and copy, captures the values, and writes them to `.conductor/settings.local.toml` / GitHub secrets. Offer it (plain text, don't auto-invoke) whenever Step 1 surfaced services that need one-time human setup; the user types `/dobby:wizard` when ready.

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

**No-clobber rule — never overwrite an existing file the user already wrote.** For each file below (`CONTEXT.md`, `CLAUDE.md`/`AGENTS.md`, `.gitignore`, `dobby.config.json`, `.worktreeinclude`), check whether it already exists first. If it does NOT exist, scaffold it fresh. If it DOES exist, do NOT overwrite it — read it, then *merge additively*: add only the missing sections, and leave the user's existing content untouched. Show the user the diff (or the sections you propose to append) and get approval before writing. An existing repo often already carries a hand-written `CLAUDE.md` or `AGENTS.md`; blindly regenerating it is a data-loss bug, not setup. (Some repos use `AGENTS.md` as the agent-config filename instead of `CLAUDE.md` — if one already exists, extend THAT file; don't create a second, competing one.)

Each scaffolded choice below carries a one-line **why** — say it to the user as you write, so setup teaches the shape of the kit instead of dropping opaque files:

- **`CONTEXT.md`** (repo root) — the domain glossary. Format: `# {Project}` + a 1-2 sentence description, then `## Language` (each term as `**Term**:` + a one-sentence definition + `_Avoid_:` aliases, grouped under subheadings when clusters emerge), `## Relationships` (bold terms + cardinality), and `## Flagged ambiguities`. Opinionated, tight, domain-only — start small with the Step 1 terms; it grows via `/dobby:interview` and `/dobby:wrap`. *Why:* the work skills read the ubiquitous language from here — it's the single place a term is defined, so agents and humans mean the same thing.
- **`CLAUDE.md`** (repo root) — the agent config, with these sections:
  - **Product** — what it is + who it's for.
  - **Stack** — language, framework, data layer, key services, plus a short **Dev** note: the app runs via **Conductor** (`.conductor/settings.toml`; `auto_run_after_setup` auto-starts the run script in each workspace), and the run command wraps the dev command with **portless**. Do NOT pin a `npm run dev` command or a hardcoded dev URL here — the Workflow config section covers how the verifier obtains it.
  - **Module map** — one line per top-level feature/domain module, each linking to that module's own `CONTEXT.md`, e.g. `- [src/<area>/<module>/](src/<area>/<module>/CONTEXT.md) — what it owns`.
  - **Conventions** — encode deep, contained modules: organize by feature/domain (NO type-based `components/`/`services/`/`lib/` buckets); NO barrels — callers import by deep path, each file named by its role (the filename is the interface); co-locate the slice; inline by default; **each module carries its own `CONTEXT.md`** (purpose · Files · Interface · Invariants · What's NOT here). "What works for humans is also great for AI."
  - **Workflow config** — how the app runs: **via Conductor**, run command wrapped in **portless**. Do NOT pin a hardcoded dev URL — `/dobby:execute`'s verifier obtains it via `portless get <name>` (deterministic, branch-prefixed via the worktree, so it is NOT hardcodable). For a no-dev-server project, say so (there's no run script → no dev URL; the verifier verifies programmatically). The issue tracker is not configured here — `/dobby:backlog` and `/dobby:triage` always use the `gh`-authenticated repo.

  *Why:* this is the adapter the generic work skills read from — Product/Stack orient every worker, the Module map + Conventions make the tree navigable to humans and agents alike, and Workflow config tells `/dobby:execute` how to run and verify.
- **docs/adr/** — create the directory (add `0001-...` only if the stack choice meets the three ADR criteria: hard to reverse · surprising · real trade-off). *Why:* durable architecture decisions get a numbered home from day one, so `/dobby:wrap` and `/dobby:improve-architecture` have somewhere to write and something to respect.
- **.gitignore** — ensure `STATE.md` is ignored (the ephemeral work-session doc) and `.conductor/settings.local.toml` is ignored (machine-local Conductor secrets), plus the stack's standard ignores. Note: `.conductor/settings.toml`, `setup.sh`, and `archive.sh` ARE checked in — only `settings.local.toml` is ignored. *Why:* work-session scratch and machine-local secrets must never reach the remote; the checked-in Conductor config must, so every workspace scaffolds identically.

Don't scaffold per-module `CONTEXT.md` files now — each module gets its own when `/dobby:execute` builds it.

## Step 4: Write the dobby.config.json contract

Create `dobby.config.json` at the **repo root** (JSON — NOT `.claude/`, NOT `.dobby/`) following `references/dobby-config.md` — discovery (via a `dobby:researcher`), user confirmation, write. The config carries FIVE sections: `files` (docs to sync) + `checks` (pre-commit checks) always, plus `setup` (worktree install commands, run by `/dobby:scope`), `run` (single dev command wrapping `portless run <name> -- …`, started lazily by `/dobby:execute`), and `teardown` (optional cleanup commands, run by `/dobby:finish`) **for a project with an app**.

- **No-app project** (a library, CLI, or plugin — like dobby itself): OMIT `setup`/`run`/`teardown` entirely (`files` + `checks` only). No `run` → no dev URL → the `devUrl = null` convention holds.
- **App project**: also add a run-sync `files[]` entry for `dobby.config.json` itself — an `update_when` trigger reminding that `.conductor/settings.toml`'s `[scripts.run]` and this `run` carry the SAME `portless` command and must change together (accepted duplication). The recipe file has the exact entry.
- On a greenfield repo the doc list starts with the files just scaffolded and the checks come from the stack's own toolchain (typecheck/lint/test). Step 3's no-clobber rule applies: an existing `dobby.config.json` gets missing entries merged additively with the user's approval, never overwritten.

*Why:* this is the single kit-owned per-project contract — `/dobby:commit` gates every commit on `files`/`checks`, and `/dobby:scope` / `/dobby:execute` / `/dobby:finish` read `setup`/`run`/`teardown` to drive the per-session worktree on the terminal host. It's how doc-sync, pre-commit checks, and the worktree lifecycle stay enforced without a separate hook manager.

### portless devDependency + .worktreeinclude

Two more artifacts for a project with an app (skip both for a no-app project):

- **Pin `portless` as a devDependency** in `package.json` `devDependencies` (not `npx`, not a global install) — the `run` command wraps the dev command with it, and `/dobby:execute` resolves the dev URL via `portless get <name>`. Surface the one-time **`portless trust`** setup in plain text: the first run needs sudo to install a local CA and bind port 443 (once per machine), so the first `/dobby:execute` doesn't fail on it.
- **Scaffold `.worktreeinclude`** at the repo root (gitignore syntax) — one glob per line listing the gitignored env/config files a fresh worktree needs (e.g. `.env`, `.env.local`). Claude Code copies these into each new `EnterWorktree` worktree so the app can run there; `/dobby:scope` re-materializes them if the native copy didn't run. Discover the set the same way as the rest of onboard's discovery (inspect the repo's `.gitignore` + `.env*` files); apply the no-clobber rule if the file already exists. Skip if the project has no gitignored env files.

## Step 5: Hand off

Setup is done. End with an **AskUserQuestion** gate offering "Start a work session — `/dobby:scope <first goal>`" *(Recommended)* (ask for the goal first if not already clear, then invoke `/dobby:scope` via the Skill tool on selection) and "Stop here" (start a session later).

- **`/dobby:scope <first goal>`** *(Recommended)* — start the first work session.
- **`/dobby:wizard`** *(only if Step 1 surfaced services needing one-time human setup)* — generate the guided external-service wizard.
- **Stop here.**

## Language

Interview in the user's language. **Write all generated docs and code — CLAUDE.md, CONTEXT.md, ADRs, `.conductor/` config + scripts, code, comments — in English**, regardless of the product's market or UI language. Two carve-outs: domain glossary **terms** keep their real-world form (a Spanish-market product legitimately has terms like `Estuche` / `Sucursal` — keep the headword, write the definition in English), and user-facing **UI strings / content** stay in the product's language. Conversation with the user stays in their language. Don't infer the doc language from the product's market.

## Acceptance checklist

- [ ] Interviewed: product, domain terms, stack (docs confirmed via /find-docs), `run_mode` (singletons? → concurrent/nonconcurrent), greenfield-or-existing
- [ ] Conductor configured: `.conductor/settings.toml` written from the right template (`run_mode` AND `auto_run_after_setup` explicit); the `[scripts] run` command wraps the dev command with `portless run` (branch-prefixed URL, no `$CONDUCTOR_PORT`); `nonconcurrent + auto_run` interaction noted in a comment; no `[models]` table
- [ ] No-dev-server project (lib/CLI/plugin): NO `[scripts] run`, and `auto_run_after_setup = false` (or omitted) — never `true` with no run target
- [ ] `.conductor/setup.sh` + `.conductor/archive.sh` stubs written and `chmod +x`; `file_include_globs` (multi-line string) copies gitignored env files; secrets go in gitignored `.conductor/settings.local.toml`, not `settings.toml`
- [ ] No-clobber respected: existing `CONTEXT.md` / `CLAUDE.md` / `AGENTS.md` / `.gitignore` / `dobby.config.json` / `.worktreeinclude` were NOT overwritten — merged additively with user approval; an existing `AGENTS.md` was extended, not shadowed by a new `CLAUDE.md`
- [ ] CONTEXT.md scaffolded (initial glossary) — in English; domain terms keep their real-world form
- [ ] CLAUDE.md scaffolded (product, stack, module map, deep-module conventions, workflow config) — in English; each scaffolded choice explained in plain language; Dev/Workflow note says the app runs via Conductor with the run command wrapping the dev command in portless, and the verifier obtains the dev URL via `portless get <name>` (no hardcoded URL)
- [ ] docs/adr/ created; `.gitignore` ignores `STATE.md` and `.conductor/settings.local.toml`
- [ ] `dobby.config.json` created at the repo root (JSON; `files` + `checks` always; `setup`/`run`/`teardown` + the run-sync `files[]` rule for an app project, OMITTED for a no-app lib/CLI/plugin), user-confirmed
- [ ] App project: `portless` pinned as a devDependency (not npx/global); one-time `portless trust` surfaced; `.worktreeinclude` scaffolded with the gitignored env files a fresh worktree needs
- [ ] `/dobby:wizard` offered (plain text, not auto-invoked) if Step 1 surfaced external services needing one-time manual setup (DB/auth/CI secrets)
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
