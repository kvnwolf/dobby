---
name: wrap
description: Close out a work session — final human smoke test, doc/ADR reconciliation, optional skill packaging, then dispose the ephemeral STATE.md and hand off to /dobby:commit. Use when finishing a feature or session, or wrapping up before committing.
argument-hint: ""
model: opus
effort: high
---

Turn a finished work session into durable project memory, confirm it works and the user understands it, then clean up. Read `STATE.md` (goal, findings, spec, work log) to know what shipped.

## Step 1: Final human smoke test

From `STATE.md`'s spec (user flow, goals, edge cases) and anything the executors/verifiers flagged as needing human judgment, build a SHORT list of user-facing behaviors the machine layers couldn't fully prove — cross-task end-to-end flows, subjective UX. Present them one at a time with AskUserQuestion (Pass / Fail / Skip). On Fail, dispatch the `implementor` agent (Agent tool, `subagent_type: "dobby:implementor"`; no commits) to fix it, then re-present. Don't re-run the per-task verification the workflow already did.

**Push right — present a decision-ready brief, not raw output.** For each behavior, the user should be able to judge in seconds: give them a compact Brief — **what to test** (the exact flow/steps to exercise), **what to decide** (the pass/fail question in their terms), and **what's needed from you** (any credential, seed data, or environment they must supply). Do the reduction work yourself; never dump logs, diffs, or a wall of raw output and ask the user to interpret it. If a behavior needs setup they alone can do, that goes in "what's needed from you" so nothing stalls silently.

## Step 2: Reconcile project docs

Update only what the work changed:

- **Root `CONTEXT.md`** — add or sharpen the domain terms resolved during the session. Before writing, read `references/context-format.md` for the format and the admission rules (domain-unique terms only — general programming concepts don't belong). Create it lazily if absent.
  - **Purity: it is a glossary and NOTHING else.** Not a spec, not a scratch pad, not a home for decisions (those become ADRs). If a line describes HOW something works rather than what a term MEANS, it doesn't belong here.
- **Module `CONTEXT.md`** — for each module the work created or changed, create/update its own `CONTEXT.md` (purpose · Files · Interface · Invariants · What's NOT here) so it reflects the module's current interface, invariants, and contents. (Executors keep this current as they build; here you reconcile anything left.)
  - **Cross-reference invariants with the code — don't just transcribe.** When you record or carry forward an invariant, verify it against what the code actually does. If they contradict, surface it rather than writing the stale claim: "the `CONTEXT` says Orders cancel whole, but the code cancels line items — which is right?" A reconciled doc that quietly disagrees with the code is worse than no doc.
- **CLAUDE.md** — if a new top-level convention emerged, or a new module belongs in the **module map** (one line + a link to the module's `CONTEXT.md`).
- **docs/adr/** — for each decision flagged as an ADR candidate (in `STATE.md`'s findings) that meets the three criteria in `references/adr-format.md` (hard to reverse · surprising without context · real trade-off), offer to write the ADR. The user approves before you write. Number sequentially: rescan `docs/adr/` for the highest existing number rather than assuming one — `/dobby:address-review` also writes sequential ADRs into this directory (`0001` = the Conductor execution host).

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

- [ ] Final human smoke test run as decision-ready Briefs (what to test · what to decide · what's needed from the user), never raw output
- [ ] CONTEXT.md / CLAUDE.md updated where the work changed them — glossary kept pure (domain-only, no implementation detail), invariants cross-referenced against the code
- [ ] ADR candidates offered + written (with approval) for decisions meeting the 3 criteria
- [ ] Reusable-skill packaging evaluated and offered if warranted
- [ ] `STATE.md` disposed; final summary presented; no commits (handed to `/dobby:commit`)
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
