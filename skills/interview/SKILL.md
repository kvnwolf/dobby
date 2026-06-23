---
name: interview
description: Interview the user relentlessly to reach a complete, shared understanding of a task before it's planned or built. Use before planning a feature, change, or refactor; to stress-test a design; to resolve ambiguity; or when the user says "interview me" / "grill me".
argument-hint: "[what you want to build or decide]"
model: opus
effort: max
---

Reach a complete, shared understanding of the task before any code is planned. Misalignment is the most common failure mode — close the gap by interrogating, not assuming. ZERO remaining ambiguity by the end.

## Step 1: Frame the task

Take the task from `$ARGUMENTS` or the conversation. If it's empty, ask in plain text what the user wants to do (NOT AskUserQuestion) and wait. Don't start interrogating until you know the rough shape.

## Step 2: Read the domain language (if present)

If the project has a domain glossary — `CONTEXT.md` at the repo root, or wherever the project's config points — read it and use those terms exactly. Skim `docs/adr/` (if present) for decisions that constrain the approach; don't re-litigate them. If there's no glossary, proceed anyway; just note terms worth defining later.

## Step 3: Explore before asking — via a researcher

Before interrogating, dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to map the code the task touches — how the relevant pieces actually work, what's already there. It returns findings; YOU hold them and use them to ask informed, specific questions (never generic ones). The point: offload the reading so your context stays clean, while keeping the findings in YOUR context so you can drive the interview and follow up. Mid-interview, when a specific claim needs checking against the code, dispatch a quick `researcher` for anything substantial — a one-line peek you can do yourself, so you don't stall the back-and-forth.

## Step 4: Interview — one question at a time

Walk down every branch of the design tree, resolving dependencies between decisions one by one.

- Use AskUserQuestion for questions with anticipatable options; plain text when the answers are too open-ended.
- ONE focused question at a time. Never bundle unrelated topics. For each, offer your recommended answer.
- Let each answer guide the next; pursue every follow-up it raises before changing topic.
- When an answer changes a previous decision, immediately explore the implications.

Cover every dimension: behavior, edge cases, error/empty/loading states, entity states (created / active / inactive / deleted), roles and permissions, routes (authed / unauthed / authorized / unauthorized), validation rules, data shape, interactions with existing code, constraints, trade-offs, and how new pieces connect to existing UI.

## Step 5: Grilling techniques

Apply these against the glossary and the codebase while interviewing:

- **Challenge against the glossary** — call out a term that conflicts with the project's domain language and resolve it.
- **Sharpen fuzzy language** — when a word is vague or overloaded, propose a precise canonical term.
- **Stress-test with concrete scenarios** — probe edge boundaries with specific cases, not abstractions.
- **Cross-reference with code** — when the user states how something works, check the code agrees (dispatch a `researcher` for anything substantial); surface contradictions.
- **Note, don't write** — flag new domain terms and ADR candidates for the planning/wrap stage; never edit files mid-interview.

If a decision genuinely can't be resolved verbally ("how does this state machine feel?", "which UI variant do we like?"), pause and have the user TYPE **`/dobby:prototype`** (do NOT invoke it via the Skill tool — typed entry applies its own `model`/`effort`) to settle it empirically — the user plays with a throwaway prototype and the captured answer lands in `STATE.md` — then resume the interview where it left off.

## Step 6: Stop condition + handoff

Stop only when every ambiguity is resolved, all states / edge cases / roles / routes are considered, and you could implement without guessing. THEN ask one final "anything else to add?" — this is the LAST question, not an escape hatch.

**The closing litmus test:** before declaring the interview complete, scan your own closing message. If it contains ANY side-note, "by the way" observation, parenthetical offer, or "I could also do X, unless you'd rather not" — that item IS an unresolved question wearing a disguise. Demoting a question to a side-note is how interviews end prematurely: if it was worth mentioning, it's worth its own focused question. Promote it, ask it, and keep going — the interview is NOT over. Only a closing message with zero new items qualifies as the close.

Produce a tight **Decisions** summary the next step can consume verbatim: each entry = decision · rejected alternative · why · is it an ADR candidate? Include the new-term and ADR-candidate flags here. If a work-session doc exists (from `/dobby:scope`, the repo-root `STATE.md`), write this summary into its `## Findings (interview)` section so later stages and subagents pick it up.

## Anti-patterns

- Never batch questions (5 questions = 5 turns, not one message).
- Never stop early because the user seems impatient — thoroughness now prevents rework later.
- Never present a recap and ask "shall I proceed?" if you can think of ONE more question.
- Never demote a genuine question to a side-note, recap line, or "micro-note in passing" ("I can also clean up X, unless…"). A side-note in your closing message is an unresolved branch — ask it as its own question instead. (Real failure: an interview closed with an alias cleanup as a "micro-nota de pasada"; it turned out to be a full decision requiring research.)
- Never modify the glossary or any file mid-interview.

## Next step

End with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke. The next stage must be TYPED by the user: typed entry applies the next skill's own `model`/`effort`; an auto-invoked skill rides the current turn's override instead. State the recommended command first (with why), then the alternatives; on stop, point to where this stage's output lives (e.g. `STATE.md`).

- **`/dobby:research`** *(Recommended)* — fetch current docs for the libraries/SDKs the task will touch. *(If the task involves no external tech, recommend `/dobby:spec` instead.)*
- `/dobby:spec` — go straight to planning when there's no external tech worth researching.
- **Stop here.**

## Language

Interview in the user's language. Write the Decisions summary (and anything persisted to `STATE.md`) in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Task framed (asked in plain text if `$ARGUMENTS` was empty)
- [ ] Domain glossary read (if present) and used; conflicts challenged
- [ ] Code explored via a `researcher` (findings held in your context) to ask informed, specific questions
- [ ] Every ambiguity, entity state, role, route, and edge case resolved
- [ ] Decisions summary produced, with new-term / ADR-candidate flags
- [ ] No files modified
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
