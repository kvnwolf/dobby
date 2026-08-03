---
name: spec
description: Turn an aligned task and its research into a concrete build plan with a vertical-slice task table and per-task verify recipes. Use after interviewing/researching a task, or to plan a feature and break it into tasks. No plan mode.
argument-hint: "[task to plan]"
---

Produce a plan detailed enough to execute with zero prior context. Work from the shared understanding (interview decisions) and the research brief already in context — don't re-interview or re-research here.

## Step 1: Gather inputs

Use the interview Decisions and the research brief from the conversation (or `$ARGUMENTS`). If there's no shared understanding yet, stop and recommend running the interview first (and research, if external tech is involved).

## Step 2: Write the plan

Write it yourself from the in-context decisions — this preserves the interview's nuance, which is lossy to re-serialize. For a large or unfamiliar task you MAY delegate to a Plan subagent (`subagent_type: "Plan"`), passing the full context.

**The plan's shape is fixed: `###` sub-headings under `## Spec`, spelled exactly as below.** This is not cosmetic — `bunx dobby spec lint` (Step 3) checks this inventory, and `bunx dobby build-plan` reads the task table and the Testing Decisions straight out of it for `/dobby:execute`. Extra sub-headings are free; the spellings below are required; `### User flow` is the ONE optional heading.

- **`### Overview`** — problem + proposed solution (2-4 sentences).
- **`### User flow`** *(optional)* — ordered steps the user goes through (omit for backend-only / refactoring tasks).
- **`### Goals`** — what it achieves.
- **`### Non-goals`** — what's explicitly out of scope.
- **`### Constraints`** — technical or business.
- **`### Decisions`** — key technical decisions from the interview, including any flagged as ADR candidates (these are written at wrap-up, not here). Prose, not code — file paths and snippets go stale. **Snippet exception:** if a decision is encoded more tightly by a snippet than by prose — a state machine, reducer, schema, or type shape — inline it *within* that decision, trimmed to the decision-rich parts (not a working demo, just the bits that pin the decision down), and note where it came from (e.g. a prototype). This is the ONLY sub-heading where a fenced block belongs; a fence anywhere else in the spec is a lint finding.
- **`### Testing Decisions`** — where and what to test, what makes a good test here, and which tasks are **test-first**; decide all of it per `references/testing-decisions.md`, and confirm the seams with the user before writing the plan. It also records the literal **`Manual verify setup:`** line (auth session / seed data / feature flags a human must prepare before verification, or `none`) that `/dobby:execute` gates on — that line is machine-read, so write it verbatim. This section feeds `/dobby:execute`'s per-task test-author gate and its pre-verification setup gate.
- **`### Edge cases`** — each edge case + how it's handled.
- **`### Module structure`** — for each module the work creates or changes: its name, location, and **file surface** (which files callers import by deep path, and what each exposes), and why it's shaped that way (this is what the module's own `CONTEXT.md` will record). Module boundaries are an architectural decision the user approves HERE — executors don't improvise them. Shape each module's file surface and boundary around the plan-shaping dictates the research brief's Reuse section surfaced from the applicable convention/design skills (the project's module/file-role taxonomy, its data/mutation patterns, its design direction) — not just the generic vocabulary. The structure the user approves here must already conform to those conventions, so the plan comes out convention-correct rather than leaving it to build-time auto-activation. Also keep it consistent with the "Module structure" section of `references/architecture-vocab.md`. Decide the module and its interface; leave intra-module implementation to the executor.
- **`### Tasks`** — exactly ONE markdown table, built per `references/task-decomposition.md` (prefactor slices, the column layout, the `Test-first` / `Destructive` columns, and the `action → observable` verify-recipe format all live there); the affected-areas column references the modules decided above, and the test-first markers come from Testing Decisions. **`Test-first` is required whenever the repo has a runnable test suite** — `spec lint` fails without it there — while `Destructive` is genuinely optional (add it only when some task's verify mutates shared state).

**Verify recipes verify BEHAVIOR, never code quality.** A verify recipe must NOT run lint / format / typecheck / build / the test suite — those belong to the edit-time PostToolUse hook (which checks every edited file) and to the pre-commit gate (`dobby check --fix`, run once), NOT to verification. Each verify recipe fires a seam or drives the UI and observes an EFFECT, written as `action → observable` (see `references/task-decomposition.md`). This mirrors the implementor rule: no one runs the quality gate during a task; it runs once at commit.

**Mandate nothing structural.** Default to the minimal plan. Do NOT add extra waves, parallelism, checks, or agents unless the plan itself *proves* they're needed (a real dependency, a real seam, a real risk). Parallelism in particular is not yours to hand-assign: `dobby build-plan` derives the waves from `Depends on` + `Affected areas` + `Destructive`.

When naming or structuring code in the plan, use the vocabulary in `references/architecture-vocab.md` (module / interface / depth / seam / leverage / locality / adapter) consistently, and match the project's domain language from its glossary.

## Step 3: Write the spec into the work-session doc, then lint it

The `## Spec` section of the work-session doc (the repo-root `STATE.md`, created by `/dobby:scope`) is the durable contract AND the shared context `/dobby:execute`'s subagents read. **Never hand-edit `STATE.md`** — the section engine owns those bytes:

1. Write the plan body (the `###` sub-headings — no `## Spec` heading of its own) to a scratch file OUTSIDE the repo, e.g. `"$TMPDIR/spec-<slug>.md"`. It's ephemeral working memory, never a committed artifact.
2. **`bunx dobby state set Spec --file <that file>`** — it replaces that one section body and preserves every other byte of the document. `## Spec` is re-settable, so a revision is just another `set`. No `STATE.md` at all (spec run standalone)? Run `bunx dobby state init --goal "<the goal>"` first, then `set`.
3. **`bunx dobby spec lint`** — it reads `<workroot>/STATE.md`'s `## Spec` and checks the sub-heading inventory, the task table (required columns — including `Test-first` when the repo has a runnable suite — non-empty `Task` / `Affected areas` / `Verify recipe` cells, dependencies pointing backwards only), banned quality-gate commands in verify recipes, the `Manual verify setup:` line, and fenced blocks outside `### Decisions`. **Exit 0 is required before the Step 4 approval gate.** Findings → fix the plan, re-run `state set Spec`, lint again; never present a spec the linter rejects.
4. **Paste the lint output into the conversation** — the clean `ok` line (and, if you had to repair anything, what you fixed). The user approves a plan that is already machine-clean.

Executors append what they did to the doc's `## Work log` (change, decisions/deviations, verify evidence) as tasks complete, via `dobby state append-worklog`. ADRs still go to `docs/adr/` at wrap-up, not here.

## Step 4: Approval gate (no plan mode)

**Print the FULL plan as message text in the conversation first.** A plan that lives only in your reasoning or in `STATE.md` has NOT been presented — the user can only approve what they can read on screen. (Real failure: spec once jumped straight to an Approve/Revise dialog without ever printing the plan; the user had nothing to approve.) The dialog comes AFTER the full plan is on screen, never instead of it — this is non-negotiable.

Then take approval with **one AskUserQuestion** so the user approves with a single tap instead of typing — restate the context in the question (which plan), one topic. Options: **Aprobar** (proceed to the hand-off below) and **Ajustar** (describe changes — free-form, via the dialog's own text field). On **Ajustar**: regenerate the plan with that feedback, re-run Step 3 (`state set Spec` + `spec lint`, both again), and re-present — before anyone executes. Do NOT enter plan mode. This gate is internal to the spec stage — separate from the Next-step handoff below (which is its own AskUserQuestion gate).

## Next step

Once the plan is approved and written to `## Spec`, present the next stage as an **AskUserQuestion** — one question that restates spec just finished — with the options below (recommended first, then revise, then Stop here). On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn (note `STATE.md` holds the approved plan).

- **`/dobby:execute`** *(Recommended)* — build the approved task plan.
- `/dobby:spec` again — to revise the plan further.
- **Stop here.**

## Language

Interact with the user in their language. Write all plan content in English; keep domain terms in their real-world form and any UI-string examples in the product's language.

## Acceptance checklist

- [ ] Built on a real shared understanding (interview/research), not assumptions
- [ ] Plan written as the mandated `###` sub-headings under `## Spec` (Overview, Goals, Non-goals, Constraints, Decisions, Testing Decisions, Edge cases, Module structure, Tasks; User flow when the work has one)
- [ ] Decisions are prose; any snippet present encodes a decision more tightly than prose (state machine / reducer / schema / type), trimmed to the decision-rich parts, and lives under `### Decisions`
- [ ] Testing Decisions written: seams minimized per testing-decisions.md and confirmed with the user; test-first tasks marked when the repo has a suite; the literal `Manual verify setup:` line present (`none` or numbered steps)
- [ ] Module structure decided (names, locations, file surfaces) and approved by the user — not left to executors
- [ ] Task table follows task-decomposition.md: vertical slices, atomic, affected areas, backwards-only dependencies, `action → observable` verify recipe per task; any prefactor scheduled as its own slice first; `Test-first` column present whenever the repo has a suite (lint enforces it); `Destructive` marked on any task whose verify mutates shared state
- [ ] Verify recipes observe behavior (a seam/UI effect) — none runs lint/format/typecheck/build/the test suite (those are the edit-time hook's and the pre-commit gate's job)
- [ ] Nothing structural mandated beyond what the plan proves it needs (no extra waves / parallelism / checks / agents — waves are derived by `dobby build-plan`)
- [ ] Architecture vocabulary used consistently
- [ ] Spec written into `## Spec` with `bunx dobby state set Spec --file <f>` (STATE.md never hand-edited; `state init` first when there's no doc)
- [ ] `bunx dobby spec lint` run and exiting 0 BEFORE the approval gate, with its output pasted into the conversation
- [ ] Full plan printed in the conversation BEFORE the approval ask; approval taken via a single AskUserQuestion (Aprobar / Ajustar); plan approved by the user (no plan mode); no code written
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
