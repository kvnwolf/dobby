---
name: bootstrap
description: Initialize a project so the work skills can run in it — interview the user about the project, scaffold the base files (CONTEXT.md, CLAUDE.md, docs/adr/, .gitignore), set the workflow config (issue tracker, dev command), make it runnable via portless, and offer to generate the project's run skill. Use once at the start of a new (greenfield) project, or to set up an existing repo for the work skills.
disable-model-invocation: true
argument-hint: "[project idea, if greenfield]"
model: claude-fable-5[1m]
effort: max
---

Set up a project so `/dobby:scope → /dobby:interview → /dobby:research → /dobby:spec → /dobby:execute → /dobby:wrap` can run in it. Run once. This lays down the adapter the generic skills read from.

## Step 1: Interview about the project

One question at a time (AskUserQuestion where the options are anticipatable; plain text otherwise). Establish:

- What the project is and who it's for (the product in 1-2 sentences).
- The core domain terms — the start of the ubiquitous language.
- The stack (language, framework, data layer, key services). Use `/find-docs` to confirm the CURRENT setup commands for the chosen stack — don't rely on memory.
- The issue tracker (GitHub / Linear / local markdown).
- Greenfield or existing repo? If greenfield, the first slice you'll build.

## Step 2: Make it runnable

Don't reinvent scaffolding — for a greenfield repo, use the stack's OWN create command (the framework's `create` CLI) to lay down a runnable starter. If the repo already runs, skip the scaffold.

Then wire up **portless** as the dev runner — every project uses it. It replaces the dev port with a stable named HTTPS URL, which is what `/dobby:execute`'s verifier targets and what makes git worktrees collision-free:

- Add it as a dev dependency (`npm install -D portless`, or the stack's equivalent).
- Point the dev script at it: `"dev": "portless run <dev command>"` (e.g. `portless run astro dev`, `portless run next dev`, `portless run vite dev`).
- portless infers the app slug from the **`package.json` `name`** (falling back to git root / directory) — **no `portless.json` needed**. That slug becomes the URL host, so make sure `package.json`'s `name` is the slug you want. Add a `portless.json` (or a `portless` key in `package.json`) only to override the host with something different from the package name.
- It serves the app at **`https://<name>.localhost`** (HTTPS, no port). In a git worktree portless prefixes the branch automatically → `https://<branch>.<name>.localhost`, and it injects `PORTLESS_URL` into the dev process.

**Pin the canonical dev command + URL now** — `npm run dev` → `https://<app-slug>.localhost` — and reuse that exact pair verbatim in CLAUDE.md (Step 3) and the run skill (Step 4). Don't verify a Node floor from memory; if a tool needs a minimum Node, confirm it before writing it into `engines`/docs.

portless trusts its local CA once per machine — a one-time setup already done on this machine — so `npm run dev` just works: no `sudo`, no per-project trust step, no fallback. Confirm the app starts.

## Step 3: Scaffold the base files

- **`CONTEXT.md`** (repo root) — the domain glossary. Format: `# {Project}` + a 1-2 sentence description, then `## Language` (each term as `**Term**:` + a one-sentence definition + `_Avoid_:` aliases, grouped under subheadings when clusters emerge), `## Relationships` (bold terms + cardinality), and `## Flagged ambiguities`. Opinionated, tight, domain-only — start small with the Step 1 terms; it grows via `/dobby:interview` and `/dobby:wrap`.
- **`CLAUDE.md`** (repo root) — the agent config, with these sections:
  - **Product** — what it is + who it's for.
  - **Stack** — language, framework, data layer, key services, plus a short **Dev** note: `npm run dev` → `https://<app-slug>.localhost` (portless), with the no-portless fallback. Use the canonical pair pinned in Step 2.
  - **Module map** — one line per top-level feature/domain module, each linking to that module's own `CONTEXT.md`, e.g. `- [src/<area>/<module>/](src/<area>/<module>/CONTEXT.md) — what it owns`.
  - **Conventions** — encode deep, contained modules: organize by feature/domain (NO type-based `components/`/`services/`/`lib/` buckets); one public interface per module; co-locate the slice; inline by default; **each module carries its own `CONTEXT.md`** (purpose · Files · Interface · Invariants · What's NOT here). "What works for humans is also great for AI."
  - **Workflow config** — the issue tracker (GitHub / Linear / local) and the dev command **with the URL it serves on**, identical to the Stack/Dev note and the run skill. `/dobby:execute`'s verifier reads this field, so never pair `npm run dev` with a different URL (e.g. the portless host vs. a fallback port) — one canonical command+URL pair, everywhere.
- **docs/adr/** — create the directory (add `0001-...` only if the stack choice meets the three ADR criteria: hard to reverse · surprising · real trade-off).
- **.gitignore** — ensure `STATE.md` is ignored (the ephemeral work-session doc), plus the stack's standard ignores.

Don't scaffold per-module `CONTEXT.md` files now — each module gets its own when `/dobby:execute` builds it.

## Step 4: Set the commit contract

Create `.claude/commit.config.yml` following `references/commit-config.md` — discovery (docs to sync + pre-commit checks, via a `dobby:researcher`), user confirmation, write. On a greenfield repo the doc list starts with the files just scaffolded and the checks come from the stack's own toolchain (typecheck/lint/test). This is the contract `/dobby:commit` reads — without it, commits skip doc-sync and checks.

## Step 5: Offer the run skill

Offer to generate a project run skill via `/run-skill-generator` so `/dobby:execute`'s verifier can launch and drive the app reliably. It captures the real build/run recipe: the dev command (`npm run dev`) and the canonical `https://<app-slug>.localhost` URL it serves on. Keep it simple — `npm run dev` just works. Do NOT add `sudo` notes or alternate/fallback run paths: the verifier must ALWAYS start the real dev server, and a documented fallback only tempts it to skip that. Recommended for anything with a dev server, database, or env setup.

## Step 6: Hand off

Setup is done. End with a plain-text handoff: suggest the user TYPE `/dobby:scope <first goal>` (ask for the goal first if not already clear) — NO AskUserQuestion, NO Skill-tool auto-invoke; typed entry applies `/dobby:scope`'s own `model`/`effort`. Or stop here — they'll start a work session later.

- **`/dobby:scope <first goal>`** *(Recommended)* — start the first work session.
- **Stop here.**

## Language

Interview in the user's language. **Write all generated docs and code — CLAUDE.md, CONTEXT.md, ADRs, the run skill, code, comments — in English**, regardless of the product's market or UI language. Two carve-outs: domain glossary **terms** keep their real-world form (a Spanish-market product legitimately has terms like `Estuche` / `Sucursal` — keep the headword, write the definition in English), and user-facing **UI strings / content** stay in the product's language. Conversation with the user stays in their language. Don't infer the doc language from the product's market.

## Acceptance checklist

- [ ] Interviewed: product, domain terms, stack (docs confirmed via /find-docs), tracker, greenfield-or-existing
- [ ] Project runs; portless wired (`dev` script → `portless run …`, slug from `package.json` `name`); canonical `npm run dev` → `https://<name>.localhost` pinned
- [ ] CONTEXT.md scaffolded (initial glossary) — in English; domain terms keep their real-world form
- [ ] CLAUDE.md scaffolded (product, stack, module map, deep-module conventions, workflow config) — in English
- [ ] Dev command + URL identical across the Stack/Dev note, Workflow config, and the run skill (one canonical pair)
- [ ] docs/adr/ created; `.gitignore` ignores `STATE.md`
- [ ] `.claude/commit.config.yml` created (docs to sync + pre-commit checks, user-confirmed)
- [ ] Run skill offered via `/run-skill-generator` (captures portless runbook + fallback)
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
