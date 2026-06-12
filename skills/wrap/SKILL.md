---
name: wrap
description: Close out a work session — reconcile project docs (CONTEXT.md, CLAUDE.md), write any ADRs the work earned, optionally package a reusable skill, run a final human smoke test, then dispose the ephemeral STATE.md and hand off to commit. Use when finishing a feature or session, or to wrap up before committing.
argument-hint: ""
model: opus
effort: high
---

Turn a finished work session into durable project memory, confirm it works and the user understands it, then clean up. Read `STATE.md` (goal, findings, spec, work log) to know what shipped.

## Step 1: Final human smoke test

From `STATE.md`'s spec (user flow, goals, edge cases) and anything the executors/verifiers flagged as needing human judgment, build a SHORT list of user-facing behaviors the machine layers couldn't fully prove — cross-task end-to-end flows, subjective UX. Present them one at a time with AskUserQuestion (Pass / Fail / Skip). On Fail, dispatch the `implementor` agent (Agent tool, `subagent_type: "dobby:implementor"`; no commits) to fix it, then re-present. Don't re-run the per-task verification the workflow already did.

## Step 2: Reconcile project docs

Update only what the work changed:

- **Root `CONTEXT.md`** — add or sharpen the domain terms resolved during the session (see `references/context-format.md`). Create it lazily if absent. Domain language only, no implementation detail.
- **Module `CONTEXT.md`** — for each module the work created or changed, create/update its own `CONTEXT.md` (purpose · Files · Interface · Invariants · What's NOT here) so it reflects the module's current interface, invariants, and contents. (Executors keep this current as they build; here you reconcile anything left.)
- **CLAUDE.md** — if a new top-level convention emerged, or a new module belongs in the **module map** (one line + a link to the module's `CONTEXT.md`).
- **docs/adr/** — for each decision flagged as an ADR candidate (in `STATE.md`'s findings) that meets the three criteria in `references/adr-format.md` (hard to reverse · surprising without context · real trade-off), offer to write the ADR. The user approves before you write. Number sequentially.

## Step 3: Evaluate a reusable skill

If the work surfaced a replicable project pattern, convention, or gotcha a future task would repeat, evaluate distilling it into a skill (project scope) via `/dobby:create-skill`. Offer it; the user approves before you create. Skip if it already fits an existing skill, CLAUDE.md, or CONTEXT.md.

## Step 4: Dispose and hand off

The durable bits now live in CONTEXT.md / CLAUDE.md / docs/adr/. Delete the ephemeral `STATE.md`. Present a final summary (what shipped, decisions, docs updated, deferred items). Do NOT commit — hand off to `/dobby:commit` when the user is ready.

## Next step

The session is wrapped. End with a plain-text handoff: suggest the user TYPE `/dobby:commit` — NO AskUserQuestion, NO Skill-tool auto-invoke; typed entry applies `/dobby:commit`'s own `model`/`effort`. Or stop here.

- **`/dobby:commit`** *(Recommended)* — sync docs, commit, push, open the PR.
- **Stop here** — commit later.

## Language

Interact with the user in their language. Write docs / ADRs / CONTEXT in English; keep domain glossary terms in their real-world form and user-facing UI strings in the product's language.

## Acceptance checklist

- [ ] Final human smoke test run on the behaviors the machine layers couldn't prove
- [ ] CONTEXT.md / CLAUDE.md updated where the work changed them
- [ ] ADR candidates offered + written (with approval) for decisions meeting the 3 criteria
- [ ] Reusable-skill packaging evaluated and offered if warranted
- [ ] `STATE.md` disposed; final summary presented; no commits (handed to `/dobby:commit`)
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
