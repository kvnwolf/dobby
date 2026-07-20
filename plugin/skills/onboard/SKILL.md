---
name: onboard
description: Set up a repo (greenfield or existing) for the work skills — interview, install @kvnwolf/dobby, scaffold the base files + thin tsconfig/biome, write the dobby.config.json contract. Run once.
disable-model-invocation: true
argument-hint: "[project idea, if greenfield]"
---

Set up a project so `/dobby:scope → /dobby:interview → /dobby:research → /dobby:spec → /dobby:execute → /dobby:wrap` can run in it. Run once. This installs `@kvnwolf/dobby` (the kit's mechanical execution layer) and lays down the adapter the generic skills read from.

## Step 1: Interview about the project

One question at a time (AskUserQuestion where the options are anticipatable; plain text otherwise). Establish:

- What the project is and who it's for (the product in 1-2 sentences).
- The core domain terms — the start of the ubiquitous language.
- The stack (language, framework, data layer, key services). Use `/find-docs` to confirm the CURRENT setup commands for the chosen stack — don't rely on memory.
- Greenfield or existing repo? If greenfield, the first slice you'll build.

## Step 2: Install dobby + write the thin config files

Don't reinvent scaffolding — for a greenfield repo, use the stack's OWN create command (the framework's `create` CLI) to lay down a runnable starter. If the repo already runs, skip the scaffold. Don't verify a Node floor from memory; if a tool needs a minimum Node, confirm it before writing it into `engines`/docs.

**Install `@kvnwolf/dobby` as the project's single dev dependency:**

```bash
bun add -d @kvnwolf/dobby
```

`dobby` is the kit's mechanical execution layer. It owns the quality **gate** (`dobby check`, which also runs as the edit-time PostToolUse hook; `dobby check --fix` is the pre-commit gate) and the run **lifecycle** (`dobby up` / `dobby down` / `dobby dev`), where `dobby up` also brings a fresh worktree up — a setup phase (install deps + materialize the env files) before it starts the app. It **bundles the toolchain** (Biome, TypeScript, knip, taze, portless) and **infers each task from the project's detected capabilities** (zero-config à la Vercel) — so there is nothing to pin here: no dev script, no run command, no per-project task config. Skills invoke it via `bunx dobby`, which resolves the local pinned bin first (per-project version, never a global install).

**Write the thin config files that extend dobby's shared presets** — no-clobber: only if the file does NOT already exist; if it does, leave the user's config and just add the `extends` if it's missing, with approval:

- `tsconfig.json` → `{ "extends": "@kvnwolf/dobby/tsconfig", ... }` with only the project's own `compilerOptions` / `paths` overrides on top.
- `biome.jsonc` → extends `@kvnwolf/dobby/biome/core` (or `@kvnwolf/dobby/biome/react` for a React app) — the per-capability preset variant.

*Why:* dobby ships the canonical TypeScript + Biome rules; the consumer keeps a one-line `extends`, which gives centralized config AND native editor support (the editor resolves the preset through `node_modules`).

## Step 3: Scaffold the base files

**No-clobber rule — never overwrite an existing file the user already wrote.** For each file below (`CONTEXT.md`, `CLAUDE.md`/`AGENTS.md`, `.gitignore`, `dobby.config.json`, `.worktreeinclude`), check whether it already exists first. If it does NOT exist, scaffold it fresh. If it DOES exist, do NOT overwrite it — read it, then *merge additively*: add only the missing sections, and leave the user's existing content untouched. Show the user the diff (or the sections you propose to append) and get approval before writing. An existing repo often already carries a hand-written `CLAUDE.md` or `AGENTS.md`; blindly regenerating it is a data-loss bug, not setup. (Some repos use `AGENTS.md` as the agent-config filename instead of `CLAUDE.md` — if one already exists, extend THAT file; don't create a second, competing one.)

Each scaffolded choice below carries a one-line **why** — say it to the user as you write, so setup teaches the shape of the kit instead of dropping opaque files:

- **`CONTEXT.md`** (repo root) — the domain glossary. Format: `# {Project}` + a 1-2 sentence description, then `## Language` (each term as `**Term**:` + a one-sentence definition + `_Avoid_:` aliases, grouped under subheadings when clusters emerge), `## Relationships` (bold terms + cardinality), and `## Flagged ambiguities`. Opinionated, tight, domain-only — start small with the Step 1 terms; it grows via `/dobby:interview` and `/dobby:wrap`. *Why:* the work skills read the ubiquitous language from here — it's the single place a term is defined, so agents and humans mean the same thing.
- **`CLAUDE.md`** (repo root) — the agent config, with these sections:
  - **Product** — what it is + who it's for.
  - **Stack** — language, framework, data layer, key services, plus a short **Dev** note: the app runs via `dobby up` / `dobby dev` — dobby infers the dev command from the detected capabilities and wraps it in **portless** (branch-prefixed URL), so do NOT pin a `npm run dev` command or a hardcoded dev URL here. The Workflow config section covers how the verifier obtains the URL.
  - **Module map** — one line per top-level feature/domain module, each linking to that module's own `CONTEXT.md`, e.g. `- [src/<area>/<module>/](src/<area>/<module>/CONTEXT.md) — what it owns`.
  - **Conventions** — encode deep, contained modules: organize by feature/domain (NO type-based `components/`/`services/`/`lib/` buckets); NO barrels — callers import by deep path, each file named by its role (the filename is the interface); co-locate the slice; inline by default; **each module carries its own `CONTEXT.md`** (purpose · Files · Interface · Invariants · What's NOT here). "What works for humans is also great for AI."
  - **Workflow config** — how the app runs: `/dobby:execute` runs `bunx dobby up` (inferred from capabilities) and reads the dev URL from `bunx dobby env` (portless-resolved, worktree-aware — NOT hardcodable). Do NOT pin a hardcoded dev URL. For a no-app project (a library, CLI, or plugin), say so (no run target → no dev URL; the verifier verifies programmatically). The issue tracker is not configured here — `/dobby:backlog` and `/dobby:triage` always use the `gh`-authenticated repo.

  *Why:* this is the adapter the generic work skills read from — Product/Stack orient every worker, the Module map + Conventions make the tree navigable to humans and agents alike, and Workflow config tells `/dobby:execute` how to run and verify.
- **docs/adr/** — create the directory (add `0001-...` only if the stack choice meets the three ADR criteria: hard to reverse · surprising · real trade-off). *Why:* durable architecture decisions get a numbered home from day one, so `/dobby:wrap` and `/dobby:improve-architecture` have somewhere to write and something to respect.
- **.gitignore** — ensure `STATE.md` is ignored (the ephemeral work-session doc) plus the stack's standard ignores, including local secrets (`.env.local` and friends). *Why:* work-session scratch and machine-local secrets must never reach the remote.

Don't scaffold per-module `CONTEXT.md` files now — each module gets its own when `/dobby:execute` builds it.

## Step 4: Write the dobby.config.json contract

Create `dobby.config.json` at the **repo root** (JSON — NOT `.claude/`, NOT `.dobby/`) following `references/dobby-config.md` — discovery (via a `dobby:researcher`), user confirmation, write. Because dobby infers most tasks from the detected capabilities, the config shrinks to `files` (docs to sync, always) plus OPTIONAL `setup` / `teardown` / `checks` extras that layer onto the inferred defaults — `setup[]` extras run in `dobby up`'s setup phase, `teardown[]` in `dobby down`, `checks[]` after the inferred gate. There is **no `run` key** — the dev/up/down lifecycle is inferred, never configured.

- **Common case**: capabilities cover everything → `files` only. Most repos need no extras.
- On a greenfield repo the doc list starts with the files just scaffolded. Step 3's no-clobber rule applies: an existing `dobby.config.json` gets missing entries merged additively with the user's approval, never overwritten.

*Why:* this is the single kit-owned per-project contract — its PRESENCE marks the repo as a dobby project (the edit-time hook and the skills guard on it), `/dobby:commit` gates doc-sync on `files`, and `dobby` layers any `setup`/`teardown`/`checks` extras onto what it already infers.

### .worktreeinclude

Scaffold `.worktreeinclude` at the repo root (gitignore syntax) — one glob per line listing the gitignored env/config files a fresh worktree needs (e.g. `.env`, `.env.local`). Claude Code copies these into each new `EnterWorktree` worktree so the app can run there, and `dobby up`'s setup phase re-materializes them if the native copy didn't run. Discover the set the same way as the rest of onboard's discovery (inspect the repo's `.gitignore` + `.env*` files); apply the no-clobber rule if the file already exists. Skip if the project has no gitignored env files.

### External-service setup (offer the wizard)

**If the stack needs manual external-service setup** — creating a database (Neon), configuring auth (Better Auth), setting CI secrets — those values can't be scaffolded, only obtained by a human clicking through provider dashboards. Rather than hand-walk the user each time, **offer to invoke `/dobby:wizard`**: it generates a guided bash wizard that opens each URL, says what to click and copy, captures the values, and writes them to `.env.local` / GitHub secrets. Offer it (plain text, don't auto-invoke) whenever Step 1 surfaced services that need one-time human setup; the user types `/dobby:wizard` when ready.

## Step 5: Hand off

Setup is done. End with an **AskUserQuestion** gate offering "Start a work session — `/dobby:scope <first goal>`" *(Recommended)* (ask for the goal first if not already clear, then invoke `/dobby:scope` via the Skill tool on selection) and "Stop here" (start a session later).

- **`/dobby:scope <first goal>`** *(Recommended)* — start the first work session.
- **`/dobby:wizard`** *(only if Step 1 surfaced services needing one-time human setup)* — generate the guided external-service wizard.
- **Stop here.**

## Language

Interview in the user's language. **Write all generated docs and code — CLAUDE.md, CONTEXT.md, ADRs, config files, code, comments — in English**, regardless of the product's market or UI language. Two carve-outs: domain glossary **terms** keep their real-world form (a Spanish-market product legitimately has terms like `Estuche` / `Sucursal` — keep the headword, write the definition in English), and user-facing **UI strings / content** stay in the product's language. Conversation with the user stays in their language. Don't infer the doc language from the product's market.

## Acceptance checklist

- [ ] Interviewed: product, domain terms, stack (docs confirmed via /find-docs), greenfield-or-existing
- [ ] `@kvnwolf/dobby` installed as the project's single dev dependency (`bun add -d @kvnwolf/dobby`) — never a global install
- [ ] Thin config files written (no-clobber): `tsconfig.json` extends `@kvnwolf/dobby/tsconfig`; `biome.jsonc` extends `@kvnwolf/dobby/biome/{core,react}`
- [ ] No-clobber respected: existing `CONTEXT.md` / `CLAUDE.md` / `AGENTS.md` / `.gitignore` / `dobby.config.json` / `.worktreeinclude` were NOT overwritten — merged additively with user approval; an existing `AGENTS.md` was extended, not shadowed by a new `CLAUDE.md`
- [ ] CONTEXT.md scaffolded (initial glossary) — in English; domain terms keep their real-world form
- [ ] CLAUDE.md scaffolded (product, stack, module map, deep-module conventions, workflow config) — in English; each scaffolded choice explained in plain language; Dev/Workflow note says the app runs via `dobby up`/`dobby dev` (inferred, portless-wrapped) and the verifier obtains the dev URL via `bunx dobby env` (no hardcoded URL)
- [ ] docs/adr/ created; `.gitignore` ignores `STATE.md` and local secrets (`.env.local`)
- [ ] `dobby.config.json` created at the repo root (JSON; `files` always; OPTIONAL `setup`/`teardown`/`checks` extras; NO `run` key), user-confirmed
- [ ] `.worktreeinclude` scaffolded with the gitignored env files a fresh worktree needs (skipped if the project has none)
- [ ] `/dobby:wizard` offered (plain text, not auto-invoked) if Step 1 surfaced external services needing one-time manual setup (DB/auth/CI secrets)
- [ ] Next step handed off via the Step 5 AskUserQuestion gate (`/dobby:scope <first goal>` recommended; `/dobby:scope` invoked through the Skill tool on selection)
