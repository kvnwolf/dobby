---
name: spec
description: Turn an aligned task and its research into a concrete build plan with a vertical-slice task table and per-task verify recipes. Use after interviewing/researching a task, or to plan a feature and break it into tasks. No plan mode.
argument-hint: "[task to plan]"
---

Produce a plan detailed enough to execute with zero prior context. Work from the shared understanding (interview decisions) and the research brief already in context — don't re-interview or re-research here.

## Step 1: Gather inputs

Use the interview Decisions and the research brief from the conversation (or `$ARGUMENTS`). If there's no shared understanding yet, stop and recommend running the interview first (and research, if external tech is involved).

## Step 2: Write the plan

Write it yourself from the in-context decisions — this preserves the interview's nuance, which is lossy to re-serialize. For a large or unfamiliar task you MAY delegate to a Plan subagent (`subagent_type: "Plan"`), passing the full context. Sections:

- **Overview** — problem + proposed solution (2-4 sentences).
- **User flow** — ordered steps the user goes through (omit for backend-only / refactoring tasks).
- **Goals** / **Non-goals** — what it achieves; what's explicitly out of scope.
- **Constraints** — technical or business.
- **Decisions** — key technical decisions from the interview, including any flagged as ADR candidates (these are written at wrap-up, not here). Prose, not code — file paths and snippets go stale. **Snippet exception:** if a decision is encoded more tightly by a snippet than by prose — a state machine, reducer, schema, or type shape — inline it *within* that decision, trimmed to the decision-rich parts (not a working demo, just the bits that pin the decision down), and note where it came from (e.g. a prototype).
- **Testing Decisions** — where and what to test, what makes a good test here, and which tasks are **test-first**; decide all of it per `references/testing-decisions.md`, and confirm the seams with the user before writing the plan. It also records the **Manual verify setup** (auth session / seed data / feature flags a human must prepare before verification, or `none`) that `/dobby:execute` gates on. This section feeds `/dobby:execute`'s per-task test-author gate and its pre-verification setup gate.
- **Edge cases** — each edge case + how it's handled.
- **Module structure** — for each module the work creates or changes: its name, location, and **file surface** (which files callers import by deep path, and what each exposes), and why it's shaped that way (this is what the module's own `CONTEXT.md` will record). Module boundaries are an architectural decision the user approves HERE — executors don't improvise them. Shape each module's file surface and boundary around the plan-shaping dictates the research brief's Reuse section surfaced from the applicable convention/design skills (the project's module/file-role taxonomy, its data/mutation patterns, its design direction) — not just the generic vocabulary. The structure the user approves here must already conform to those conventions, so the plan comes out convention-correct rather than leaving it to build-time auto-activation. Also keep it consistent with the "Module structure" section of `references/architecture-vocab.md`. Decide the module and its interface; leave intra-module implementation to the executor.
- **Tasks** — build the table per `references/task-decomposition.md` (prefactor slices, test-first markers, and the column layout all live there); the affected-areas column references the modules decided above, and the test-first markers come from Testing Decisions.

**Verify recipes verify BEHAVIOR, never code quality.** A verify recipe must NOT run lint / format / typecheck / build / the test suite — those belong to the edit-time PostToolUse hook (which checks every edited file) and to the pre-commit gate (`dobby check --fix`, run once), NOT to verification. Each verify recipe fires a seam or drives the UI and observes an EFFECT (see `references/task-decomposition.md`). This mirrors the implementor rule: no one runs the quality gate during a task; it runs once at commit.

**Mandate nothing structural.** Default to the minimal plan. Do NOT add extra waves, parallelism, checks, or agents unless the plan itself *proves* they're needed (a real dependency, a real seam, a real risk).

When naming or structuring code in the plan, use the vocabulary in `references/architecture-vocab.md` (module / interface / depth / seam / leverage / locality / adapter) consistently, and match the project's domain language from its glossary.

## Step 3: Approval gate (no plan mode)

**Print the FULL plan as message text in the conversation first.** A plan that lives only in your reasoning or in `STATE.md` has NOT been presented — the user can only approve what they can read on screen. (Real failure: spec once jumped straight to an Approve/Revise dialog without ever printing the plan; the user had nothing to approve.) The dialog comes AFTER the full plan is on screen, never instead of it — this is non-negotiable.

Then take approval with **one AskUserQuestion** so the user approves with a single tap instead of typing — restate the context in the question (which plan), one topic. Options: **Aprobar** (proceed to write the spec and hand off) and **Ajustar** (describe changes — free-form, via the dialog's own text field; regenerate with that feedback before anyone executes). Do NOT enter plan mode. This gate is internal to the spec stage — separate from the Next-step handoff below (which is its own AskUserQuestion gate).

## Step 4: Write the spec into the work-session doc

Write the approved plan into the `## Spec` section of the work-session doc (the repo-root `STATE.md`, created by `/dobby:scope`). If there's no `STATE.md` (spec run standalone), create one and put the spec in it.

That doc is the durable contract AND the shared context `/dobby:execute`'s subagents read; executors append what they did to its `## Work log` (change, decisions/deviations, verify evidence) as tasks complete. ADRs still go to `docs/adr/` at wrap-up, not here.

## Next step

Once the plan is approved and written to `## Spec`, present the next stage as an **AskUserQuestion** — one question that restates spec just finished — with the options below (recommended first, then revise, then Stop here). On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn (note `STATE.md` holds the approved plan).

- **`/dobby:execute`** *(Recommended)* — build the approved task plan.
- `/dobby:spec` again — to revise the plan further.
- **Stop here.**

## Language

Interact with the user in their language. Write all plan content in English; keep domain terms in their real-world form and any UI-string examples in the product's language.

## Acceptance checklist

- [ ] Built on a real shared understanding (interview/research), not assumptions
- [ ] Plan has overview, goals/non-goals, constraints, decisions (ADR candidates flagged), edge cases
- [ ] Decisions are prose; any snippet present encodes a decision more tightly than prose (state machine / reducer / schema / type), trimmed to the decision-rich parts
- [ ] Testing Decisions written: seams minimized per testing-decisions.md and confirmed with the user; test-first tasks marked when the repo has a suite
- [ ] Module structure decided (names, locations, file surfaces) and approved by the user — not left to executors
- [ ] Task table follows task-decomposition.md: vertical slices, atomic, affected areas, dependencies, verify recipe per task; any prefactor scheduled as its own slice first
- [ ] Verify recipes observe behavior (a seam/UI effect) — none runs lint/format/typecheck/build/the test suite (those are the edit-time hook's and the pre-commit gate's job)
- [ ] Nothing structural mandated beyond what the plan proves it needs (no extra waves / parallelism / checks / agents)
- [ ] Architecture vocabulary used consistently
- [ ] Full plan printed in the conversation BEFORE the approval ask; approval taken via a single AskUserQuestion (Aprobar / Ajustar); plan approved by the user (no plan mode); no code written
- [ ] Approved plan written into the work-session doc's `## Spec` section (`STATE.md`)
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
