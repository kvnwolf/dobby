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
- **Decisions** — key technical decisions from the interview, including any flagged as ADR candidates (these are written at wrap-up, not here).
- **Edge cases** — each edge case + how it's handled.
- **Module structure** — for each module the work creates or changes: its name, location, and **public interface** (what callers may use), and why it's shaped that way (this is what the module's own `CONTEXT.md` will record). Module boundaries are an architectural decision the user approves HERE — executors don't improvise them. Apply `references/architecture-vocab.md` (deep, feature/domain modules; one public interface; co-located; inline by default; no type-based folders; each module carries a `CONTEXT.md`). Decide the module and its interface; leave intra-module implementation to the executor.
- **Tasks** — build the table per `references/task-decomposition.md`; the affected-areas column references the modules decided above.

When naming or structuring code in the plan, use the vocabulary in `references/architecture-vocab.md` (module / interface / depth / seam / leverage / locality / adapter) consistently, and match the project's domain language from its glossary.

## Step 3: Approval gate (no plan mode)

**Print the FULL plan as message text in the conversation first.** A plan that lives only in your reasoning or in `STATE.md` has NOT been presented — the user can only approve what they can read on screen. (Real failure: spec once jumped straight to an Approve/Revise dialog without ever printing the plan; the user had nothing to approve.)

Then ask for approval **in plain text at the end of that same message** ("¿apruebo, o qué ajusto?"). Do NOT use AskUserQuestion for this gate — a dialog rendered right after a long plan buries it, and revision feedback is free-form anyway. Do NOT enter plan mode. If the user asks for changes, regenerate with their feedback before anyone executes. The approved plan is the contract `/dobby:execute` runs against.

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
- [ ] Module structure decided (names, locations, public interfaces) and approved by the user — not left to executors
- [ ] Task table follows task-decomposition.md: vertical slices, atomic, affected areas, dependencies, verify recipe per task
- [ ] Architecture vocabulary used consistently
- [ ] Full plan printed in the conversation BEFORE the approval ask (plain-text question, not a dialog); plan approved by the user (no plan mode); no code written
- [ ] Approved plan written into the work-session doc's `## Spec` section (`STATE.md`)
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
