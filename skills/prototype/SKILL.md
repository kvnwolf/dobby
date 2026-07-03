---
name: prototype
description: Build a throwaway prototype to answer a design question before committing — an interactive terminal app for state/business-logic questions, or several UI variants on one route with a switcher. Use when the user wants to prototype something, compare UI variants, or sanity-check a data model or state machine; or when /dobby:interview or /dobby:research hits a question only answerable by playing with it.
argument-hint: "[the question the prototype answers]"
model: opus
effort: high
---

A prototype is **throwaway code that answers a question**. The question decides the shape. You stay the architect: define the question, pick the branch, and spec the variants/actions — the `dobby:implementor` agent writes the code.

Typically invoked mid-stage — from `/dobby:interview` when a decision can't be resolved verbally ("which UI variant do we like?", "does this state machine feel right?"), or from `/dobby:research` when a question is only answerable empirically. Also runs standalone.

## Step 1: State the question, pick the branch

Write down the ONE question this prototype answers (from `$ARGUMENTS` or the conversation) — it goes at the top of the prototype and decides everything after. Then pick:

- **"Does this logic / state model feel right?"** → `references/logic.md`. A tiny interactive terminal app that pushes the state machine through cases that are hard to reason about on paper.
- **"What should this look like?"** → `references/ui.md`. Several radically different UI variations on a single route, switchable via a URL search param and a floating bottom bar.

If genuinely ambiguous, ask the user; if unreachable, default to whichever matches the surrounding code (backend module → logic; page/component → UI) and state the assumption at the top of the prototype.

## Step 2: Dispatch the build

Read the branch reference and turn it into a concrete build instruction: the question, the branch recipe (embed the reference's process — the implementor doesn't have it), the variant/action spec you decided, and where the prototype lives. Dispatch **ONE `implementor`** (Agent tool, `subagent_type: "dobby:implementor"`) — variants share the route and switcher, so parallel writers would collide.

**No build loop.** Prototypes are exempt from review/verify by design; no work-log entry — the captured answer is the deliverable.

## Step 3: Hand it over — the play session

- **Logic branch** → give the user the one run command.
- **UI branch** → give the URL on the **already-running dev server** (the Conductor run — the dev URL comes from `portless get`; never start a second server) + the `?variant=` keys.

The user drives. The interesting moments are "wait, that shouldn't be possible" and "I want the header from B with the sidebar from C" — those are the answer forming. Iterate through the implementor as the user asks for new actions, adjustments, or another variant.

## Step 4: Capture the answer, clean up

The **answer is the only thing worth keeping**. Capture the question + verdict + why:

- If a work-session doc exists (repo-root `STATE.md`), write it into the section of the stage that sent you here (`## Findings (interview)` or `## Research`), flagging it as an ADR candidate if it meets the bar (written at `/dobby:wrap`, not here).
- Standalone → a `NOTES.md` next to the prototype (or the commit message / issue).

Then **delete or absorb** (via the implementor): fold the winning variant or validated logic module into the real code through the normal flow — prototype code was written under prototype constraints, so production-bound pieces get rebuilt properly (the logic branch's pure module is the exception: it's built portable on purpose). Delete the losers, the switcher, and any throwaway route.

## Rules (both branches)

1. **Throwaway from day one, clearly marked.** Locate it close to where it'll be used, named so a casual reader sees it's a prototype. Follow the project's existing routing/task-runner conventions — don't invent new top-level structure.
2. **One command to run** (logic) / **one URL** (UI). The user must start it without thinking.
3. **No persistence by default.** State lives in memory; persistence is what the prototype is *checking*, not a dependency. If the question explicitly involves a DB, use a scratch store with a clear "PROTOTYPE — wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond runnable, no abstractions.
5. **Surface the state.** Print the full relevant state after every action (logic) or render the variant cleanly on every switch (UI).
6. **No commits** unless the user asks.

## Next step

Once the answer is captured, end with a plain-text handoff back to the stage that sent you here: tell the user to TYPE it (e.g. `/dobby:interview`) — NO AskUserQuestion, NO Skill-tool auto-invoke; typed entry re-applies that stage's own `model`/`effort`. If the prototype was standalone, suggest `/dobby:spec` or stopping here.

- **Resume the calling stage** *(Recommended)* — `/dobby:interview` (continue with the answer as a settled decision) or `/dobby:research` (fold it into the brief).
- `/dobby:spec` — if the prototype settled the last open question and the task is ready to plan.
- **Stop here** — the answer is captured; the prototype awaits its cleanup verdict.

## Language

Interact with the user in their language. Write prototype code, comments, and the captured answer in English; keep domain terms in their real-world form and user-facing UI strings in the product's language.

## Acceptance checklist

- [ ] The question stated explicitly, branch picked (logic vs UI) accordingly
- [ ] Built by ONE `implementor` (no build loop, no work-log); throwaway, clearly marked, one command/URL
- [ ] UI branch served from the already-running dev server; variants structurally different, switcher prod-gated
- [ ] User drove the prototype; iterations applied through the implementor
- [ ] Answer captured (STATE.md section of the calling stage, or NOTES.md standalone); ADR candidate flagged if warranted
- [ ] Prototype deleted or absorbed via the normal flow; no rot left behind
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)

---
*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `engineering/prototype`.*
