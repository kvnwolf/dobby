---
name: prototype
description: Build a throwaway prototype to answer a design question before committing — an interactive terminal app for state/business-logic questions, or several UI variants on one route with a switcher. Use when the user wants to prototype something, compare UI variants, or sanity-check a data model or state machine; or when /dobby:interview or /dobby:research hits a question only answerable by playing with it.
argument-hint: "[the question the prototype answers]"
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

**No build loop.** Prototypes are exempt from review/verify by design. The implementor still returns the normal `{status, workLog, blocker}` envelope, but here it is CONTROL PLANE only: the prototype artifact and later captured answer are the deliverables, and its `workLog` is NEVER appended to `STATE.md`.

Validate the envelope before handing the prototype to the user:

- `{status: "completed", workLog: <non-empty>, blocker: ""}` → mechanically confirm the named target exists in the exact requested location (and Read the entry file / route registration); then continue to the play session. Do not persist the work log.
- `{status: "blocked", workLog: <non-empty>, blocker: <non-empty>}` → report both the blocker and artifact accounting, return `needs-human`, and STOP before handoff/capture. Do not persist the work log.
- Null, a bare work log, empty required fields, or an incoherent envelope → inspect the exact prototype target mechanically (`test -e` / scoped `git status --short -- <target>` / `git diff -- <target>` as applicable, then Read expected and untracked files), report what exists, and return `needs-human`. Do not launch the play session, capture an answer, or infer success from a partial artifact.

## Step 3: Hand it over — the play session

- **Logic branch** → give the user the one run command.
- **UI branch** → give the URL on the **already-running dev server** (bring the run up per `../execute/references/bring-up.md`, then read `devUrl` from `bunx dobby env`; never start a second server) + the `?variant=` keys.

The user drives. The interesting moments are "wait, that shouldn't be possible" and "I want the header from B with the sidebar from C" — those are the answer forming. Iterate through the implementor as the user asks for new actions, adjustments, or another variant. Every iteration uses the SAME result-envelope gate from Step 2: only `completed` may return to the play session; `blocked` or invalid stops `needs-human` after reporting/mechanical inspection, and no iteration work log is persisted to `STATE.md`.

## Step 4: Capture the answer, clean up

The **answer is the only thing worth keeping**. Capture the question + verdict + why:

- If a work-session doc exists (repo-root `STATE.md`), the capture **appends** to the section of the stage that sent you here — `## Findings (interview)` (from `/dobby:interview`) or `## Research` (from `/dobby:research`) — flagged as an ADR candidate if it meets the bar (written at `/dobby:wrap`, not here).
- Standalone → a `NOTES.md` next to the prototype (or the commit message / issue).

**The append idiom** — the state engine's `set` REPLACES a section body, so an append is a read-modify-write you compose, never a hand edit of the document:

1. **Read** the calling stage's current section body out of `STATE.md` (the Read tool — the engine writes, it doesn't read back).
2. **Compose** the combined body in a scratch file outside the repo (the OS temp dir — e.g. `${TMPDIR:-/tmp}/dobby-prototype-<timestamp>.md`): that existing content verbatim, then the capture under it. **Exception — an unwritten section:** if the body you read is `_pending_` (the engine's "still empty" marker) or blank, the composed body is the **capture alone**. That is the COMMON case here — you are usually invoked mid-stage, before the calling stage has written its section — and carrying `_pending_` through would leave a false unfilled marker sitting inside a filled section.
3. **Set** the combined body: `bunx dobby state set 'Findings (interview)' --file <scratch-file>` (or `Research`).

Over a section that already holds the stage's work, passing the capture ALONE would replace it — step 1 is what makes this an append, and what tells you whether there is anything to preserve.

Then **delete or absorb** (via the implementor): fold the winning variant or validated logic module into the real code through the normal flow — prototype code was written under prototype constraints, so production-bound pieces get rebuilt properly (the logic branch's pure module is the exception: it's built portable on purpose). Delete the losers, the switcher, and any throwaway route. Apply the SAME envelope gate to cleanup: only a coherent `completed` plus mechanical confirmation of the requested removal/absorption may finish; `blocked` or invalid leaves the artifact in place, reports `needs-human`, and skips the Next-step handoff. Never persist this cleanup work log to `STATE.md` either.

## Rules (both branches)

1. **Throwaway from day one, clearly marked.** Locate it close to where it'll be used, named so a casual reader sees it's a prototype. Follow the project's existing routing/task-runner conventions — don't invent new top-level structure.
2. **One command to run** (logic) / **one URL** (UI). The user must start it without thinking.
3. **No persistence by default.** State lives in memory; persistence is what the prototype is *checking*, not a dependency. If the question explicitly involves a DB, use a scratch store with a clear "PROTOTYPE — wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond runnable, no abstractions.
5. **Surface the state.** Print the full relevant state after every action (logic) or render the variant cleanly on every switch (UI).
6. **No commits** unless the user asks.

## Next step

Once the answer is captured, present an **AskUserQuestion** restating that the prototype is done, with the handoff routes back to the stage that sent you here as options (recommended first, plus **Stop here**). On selection, invoke the chosen `/dobby:<skill>` via the Skill tool; **Stop here** ends the turn.

- **Resume the calling stage** *(Recommended)* — `/dobby:interview` (continue with the answer as a settled decision) or `/dobby:research` (fold it into the brief).
- `/dobby:spec` — if the prototype settled the last open question and the task is ready to plan.
- **Stop here** — the answer is captured; the prototype awaits its cleanup verdict.

## Language

Interact with the user in their language. Write prototype code, comments, and the captured answer in English; keep domain terms in their real-world form and user-facing UI strings in the product's language.

## Acceptance checklist

- [ ] The question stated explicitly, branch picked (logic vs UI) accordingly
- [ ] Built by ONE `implementor` (no build loop); its structured envelope controlled progress but its workLog was never persisted to `STATE.md`; throwaway artifact clearly marked, one command/URL
- [ ] Initial build, every iteration, and cleanup handled envelopes fail-closed: only coherent `completed` advanced; `blocked` reported blocker + accounting; null/malformed triggered target-scoped mechanical inspection and `needs-human` before play/capture/next-step
- [ ] UI branch served from the already-running dev server; variants structurally different, switcher prod-gated
- [ ] User drove the prototype; iterations applied through the implementor
- [ ] Answer captured — appended to the calling stage's STATE.md section by read-modify-write through `bunx dobby state set` (existing body preserved, never a hand edit; capture alone when the section still held `_pending_`), or NOTES.md standalone; ADR candidate flagged if warranted
- [ ] Prototype deleted or absorbed via the normal flow; no rot left behind
- [ ] Next step handed off via an AskUserQuestion gate (calling-stage resume / `/dobby:spec` / Stop here)

---
*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `engineering/prototype`.*
