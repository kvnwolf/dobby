---
name: spec
description: Turn an aligned task and its research into a concrete build plan — overview, decisions, edge cases, and a vertical-slice task table with a per-task verify recipe. Use after interviewing/researching a task, or to plan a feature and break it into tasks. No plan mode.
argument-hint: "[task to plan]"
model: claude-fable-5[1m]
effort: max
---

Produce a plan detailed enough to execute with zero prior context. Work from the shared understanding (interview decisions) and the research brief already in context — don't re-interview or re-research here.

## Step 1: Gather inputs

Use the interview Decisions and the research brief from the conversation (or `$ARGUMENTS`). If there's no shared understanding yet, stop and recommend running the interview first (and research, if external tech is involved). A plan built on ambiguity just encodes the ambiguity.

## Step 2: Write the plan

Write it yourself from the in-context decisions — this preserves the interview's nuance, which is lossy to re-serialize. For a large or unfamiliar task you MAY delegate to a Plan subagent (`subagent_type: "Plan"`), passing the full context. Sections:

- **Overview** — problem + proposed solution (2-4 sentences).
- **User flow** — ordered steps the user goes through (omit for backend-only / refactoring tasks).
- **Goals** / **Non-goals** — what it achieves; what's explicitly out of scope.
- **Constraints** — technical or business.
- **Decisions** — key technical decisions from the interview, including any flagged as ADR candidates (these are written at wrap-up, not here). Prose, not code — file paths and snippets go stale. **Snippet exception:** if a decision is encoded more tightly by a snippet than by prose — a state machine, reducer, schema, or type shape — inline it *within* that decision, trimmed to the decision-rich parts (not a working demo, just the bits that pin the decision down), and note where it came from (e.g. a prototype).
- **Testing Decisions** — where and what to test, decided per `references/testing-decisions.md`. Minimize seams (prefer existing, use the highest, fewer is better, ideal is ONE), state what makes a good test here, and — for a repo that has a test suite — mark which tasks are **test-first**. Confirm the seams with the user before writing the plan. This section feeds `/dobby:execute`'s per-task test-author gate.
- **Edge cases** — each edge case + how it's handled.
- **Module structure** — for each module the work creates or changes: its name, location, and **file surface** (which files callers import by deep path, and what each exposes), and why it's shaped that way (this is what the module's own `CONTEXT.md` will record). Module boundaries are an architectural decision the user approves HERE — executors don't improvise them. Apply `references/architecture-vocab.md` (deep, feature/domain modules; no barrels — deep-path imports; co-located; inline by default; no type-based folders; each module carries a `CONTEXT.md`). Decide the module and its interface; leave intra-module implementation to the executor.
- **Tasks** — build the table per `references/task-decomposition.md`; the affected-areas column references the modules decided above. If the plan needs a **prefactor** — a change that makes the feature change easy ("make the change easy, then make the easy change") — schedule it as its own slice *before* the feature slices that depend on it. When the repo has a test suite, carry a **test-first** marker on each task (from Testing Decisions above) — this is the flag `/dobby:execute`'s test-author gate reads.

**Mandate nothing structural.** Default to the minimal plan. Do NOT add extra waves, parallelism, checks, or agents unless the plan itself *proves* they're needed (a real dependency, a real seam, a real risk). Structure the plan justifies, nothing the plan merely permits — added machinery is cost the executor pays whether or not it earns its keep.

When naming or structuring code in the plan, use the vocabulary in `references/architecture-vocab.md` (module / interface / depth / seam / leverage / locality / adapter) consistently, and match the project's domain language from its glossary.

## Step 3: Approval gate (no plan mode)

**Print the FULL plan as message text in the conversation first.** A plan that lives only in your reasoning or in `STATE.md` has NOT been presented — the user can only approve what they can read on screen. (Real failure: spec once jumped straight to an Approve/Revise dialog without ever printing the plan; the user had nothing to approve.) The dialog comes AFTER the full plan is on screen, never instead of it — this is non-negotiable.

Then take approval with **one AskUserQuestion** so the user approves with a single tap instead of typing — restate the context in the question (which plan), one topic. Options: **Aprobar** (proceed to write the spec and hand off) and **Ajustar** (describe changes — free-form, via the dialog's own text field; regenerate with that feedback before anyone executes). Do NOT enter plan mode. This gate is internal to the spec stage — it is NOT the Next-step handoff, so a dialog here is fine (the handoff below must stay typed). The approved plan is the contract `/dobby:execute` runs against.

## Step 4: Write the spec into the work-session doc

Write the approved plan into the `## Spec` section of the work-session doc (the repo-root `STATE.md`, created by `/dobby:scope`). If there's no `STATE.md` (spec run standalone), create one and put the spec in it.

That doc is the durable contract AND the shared context `/dobby:execute`'s subagents read; executors append what they did to its `## Work log` (change, decisions/deviations, verify evidence) as tasks complete. ADRs still go to `docs/adr/` at wrap-up, not here.

## Next step

Once the plan is approved and written to `## Spec`, end with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke: the next stage must be TYPED by the user (typed entry applies its own `model`/`effort`). Recommend `/dobby:execute`; on stop, note `STATE.md` holds the approved plan.

- **`/dobby:execute`** *(Recommended)* — build the approved task plan.
- `/dobby:spec` again — to revise the plan further.
- **Stop here.**

## Language

Interact with the user in their language. Write all plan content in English; keep domain terms in their real-world form and any UI-string examples in the product's language.

## Acceptance checklist

- [ ] Built on a real shared understanding (interview/research), not assumptions
- [ ] Plan has overview, goals/non-goals, constraints, decisions (ADR candidates flagged), edge cases
- [ ] Decisions are prose; any snippet present encodes a decision more tightly than prose (state machine / reducer / schema / type), trimmed to the decision-rich parts
- [ ] Testing Decisions written: seams minimized (prefer existing / highest / fewest — ideal ONE) and confirmed with the user; test-first tasks marked when the repo has a suite
- [ ] Module structure decided (names, locations, file surfaces) and approved by the user — not left to executors
- [ ] Task table follows task-decomposition.md: vertical slices, atomic, affected areas, dependencies, verify recipe per task; any prefactor scheduled as its own slice first
- [ ] Nothing structural mandated beyond what the plan proves it needs (no extra waves / parallelism / checks / agents)
- [ ] Architecture vocabulary used consistently
- [ ] Full plan printed in the conversation BEFORE the approval ask; approval taken via a single AskUserQuestion (Aprobar / Ajustar), never instead of printing the plan; plan approved by the user (no plan mode); no code written
- [ ] Approved plan written into the work-session doc's `## Spec` section (`STATE.md`)
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
