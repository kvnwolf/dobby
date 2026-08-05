---
name: interview
description: Interview the user relentlessly to reach a complete, shared understanding of a task before it's planned or built. Use before planning a feature, change, or refactor; to stress-test a design; to resolve ambiguity; or when the user says "interview me" / "grill me".
argument-hint: "[what you want to build or decide]"
---

Reach a complete, shared understanding of the task before any code is planned. Misalignment is the most common failure mode — close the gap by interrogating, not assuming. ZERO remaining ambiguity by the end.

## Step 1: Frame the task

Take the task from `$ARGUMENTS` or the conversation. If it's empty, ask in plain text what the user wants to do (NOT AskUserQuestion) and wait. Don't start interrogating until you know the rough shape.

## Step 2: Read the domain language (if present)

If the project has a domain glossary — `CONTEXT.md` at the repo root, or wherever the project's config points — read it and use those terms exactly. Skim `docs/adr/` (if present) for decisions that constrain the approach; don't re-litigate them. If there's no glossary, proceed anyway; just note terms worth defining later.

## Step 3: Explore before asking — via a researcher

Before interrogating, dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to map the code the task touches — how the relevant pieces actually work, what's already there. It returns findings that YOU hold: the reading is offloaded so your context stays clean, but the findings stay in YOUR context so you can ask informed, specific questions (never generic ones), drive the interview, and follow up.

**Facts are YOUR job, never the user's — and fact-finding never blocks the interview.** Mid-interview, when a claim needs checking against the code, delegate it: anything substantial goes to a `researcher`, never to the user — the codebase can answer it, and the reading stays off your context. Then keep going: a pending dispatch is just an unsettled prerequisite in the design tree, so ONLY the questions downstream of that fact wait for the report — the rest of the frontier is asked right now (Step 4). Fold the findings in when they land, and open the questions they unblock in the next round.

## Step 4: Interview — frontier rounds

The interview is a **design tree**: every open decision hangs off the answers it depends on. The **frontier** is every open decision whose prerequisites are already settled — everything you could ask RIGHT NOW without guessing. A **round** is the batch of frontier questions ONE turn carries — one vehicle, popup capped at 4 — asked, then waited on. A frontier that fits one vehicle and that cap is asked in a single round; one that mixes vehicles or runs wider DRAINS across consecutive rounds — popup round(s) first, then the text round, per the rules below. Answers reshape the tree after every round: recompute the frontier and continue.

A question whose premise depends on an answer still open is NOT on the frontier — it belongs to a later round. When every remaining question hangs off the last answer, the frontier is one question wide and the round IS a single question: the old one-at-a-time interview is the degenerate case of this mechanism, not a separate mode.

**Rounds are homogeneous by vehicle.** Never mix a popup and text questions in the same turn: the AskUserQuestion popup renders OVER the turn's message text and hides it, so text questions asked alongside a popup are simply never read.

- **Popup round — first.** Questions with anticipatable options go in ONE AskUserQuestion call, AT MOST 4 per call (the tool's hard cap). Order them most load-bearing first; a frontier wider than 4 splits into consecutive popup rounds of ≤4, and the first tranche's answers may refine the ones still to come.
- **Text round — after.** Questions too open-ended for options form their own plain-text round, numbered so the user can answer several in one typed message:

  ```
  ❓ **Q1** - **<question title>**: <question body>

  ➡️ <your recommended answer>
  ```

- Every question carries your recommended answer — as the marked option in the popup, as the `➡️` line in text.
- **Self-contained questions** — EVERY question in a round restates its own context (1–3 lines: what we're deciding and why it's on the table now) INSIDE the question itself — inside the AskUserQuestion `question` field, NEVER in the surrounding turn text, which the popup covers — and covers a SINGLE topic. Batching independent questions never bundles topics into one question: a round of four is four self-contained questions, never one general "how should X work overall?". Never bundle multiple skills, files, or decisions into a single question. The user context-switches across many projects and can lose the thread between turns; a question that assumes they still hold the prior three answers in their head will get a guessed answer. Each question must stand on its own so a reader dropping in cold could answer it. (This rule is itself a dogfood outcome of the session that authored it.)
- Let each round's answers guide the next; pursue every follow-up they raise before changing topic.
- When an answer changes a previous decision, immediately explore the implications.
- **Intra-round invalidation — discard and re-ask.** When one answer in a round invalidates the premise of another question answered in that SAME round, the second answer is orphaned. Say so explicitly, DISCARD it, and re-ask the question in the next round with the corrected premise. Never record a decision whose premise changed underneath it.

Rounds govern the interviewing in this step only: the closing gate (Step 6) and the Next-step handoff stay SINGLE-question — they are handoffs, not interviews.

Cover every dimension: behavior, edge cases, error/empty/loading states, entity states (created / active / inactive / deleted), roles and permissions, routes (authed / unauthed / authorized / unauthorized), validation rules, data shape, interactions with existing code, constraints, trade-offs, and how new pieces connect to existing UI.

## Step 5: Grilling techniques

Apply these against the glossary and the codebase while interviewing:

- **Challenge against the glossary** — call out a term that conflicts with the project's domain language and resolve it.
- **Sharpen fuzzy language** — when a word is vague or overloaded, propose a precise canonical term.
- **Stress-test with concrete scenarios** — probe edge boundaries with specific cases, not abstractions.
- **Cross-reference with code** — when the user states how something works, check the code agrees (per Step 3, a `researcher` for anything substantial); surface contradictions. Your OWN assumptions about a shared primitive are claims too — a shared component's props, a hook's submit/disabled lifecycle, whether two primitives compose (one dialog nested over another). The moment a decision rests on how a reused primitive behaves, dispatch a `researcher` to confirm it against code BEFORE locking the decision, not after. "I'm pretty sure that prop/hook/nesting works that way" is the trigger to verify, never a reason to skip.
- **Note, don't write** — flag new domain terms and ADR candidates as you resolve them; never edit files mid-interview. Hold the resolved terms so you can OFFER them as `CONTEXT.md` candidates at the handoff (see Step 6) — the note is where the offer comes from, not a substitute for it.

If a decision genuinely can't be resolved verbally ("how does this state machine feel?", "which UI variant do we like?"), pause and have the user run **`/dobby:prototype`** to settle it empirically — the user plays with a throwaway prototype and the captured answer lands in `STATE.md` — then resume the interview where it left off.

## Step 6: Stop condition + handoff

Stop only when **the frontier is empty** — no open decision left whose prerequisites are settled, every ambiguity resolved, all states / edge cases / roles / routes considered, and you could implement without guessing. THEN present a final all-clear **AskUserQuestion** gate — is everything clear, or does the user want to keep going? Three options:

- **"Todo claro — cerrar la entrevista"** — proceed to the domain-term offer and handoff below.
- **"Tengo más que aclarar / sigue preguntando"** — loop back into frontier-round interviewing (Steps 4–5) and re-run this gate afterward.
- **"Auto-audita la cobertura antes de cerrar"** — don't take "it's clear" at face value: run a rigorous **completeness self-audit** before deciding. Actively re-scan for anything still uncovered — every edge case, the happy path, entity states (created / active / inactive / deleted), roles / permissions, routes (authed / unauthed / authorized / unauthorized), error / empty / loading states, validation rules, and any decision still resting on an unverified shared-primitive assumption. This option ACTIVATES the closing litmus test and the infra-assumption gate below on demand. If the audit surfaces ANY gap or unasked question, the interview does NOT close — the gaps it finds ARE a new frontier: resume frontier-round interviewing (Steps 4–5) on them, then return to this gate. Only when the audit genuinely finds nothing left to ask do you proceed to the domain-term offer and handoff.

This is a gate, not an escape hatch — reach it only after the litmus test and infra-assumption gate below pass.

**The closing litmus test:** before declaring the interview complete, scan your own closing message. If it contains ANY side-note, "by the way" observation, parenthetical offer, or "I could also do X, unless you'd rather not" — that item IS an unresolved question wearing a disguise. Demoting a question to a side-note is how interviews end prematurely: if it was worth mentioning, it's worth its own focused question. Promote it, ask it, and keep going — the interview is NOT over. Only a closing message with zero new items qualifies as the close.

**The infra-assumption gate:** before declaring zero open questions, scan your Decisions for any that assume how a shared primitive behaves — a prop exists, a button enables, two dialogs compose, a hook fires — without a code check behind it. Those are unverified assumptions wearing the disguise of settled decisions, exactly the ones that turn out wrong once the build starts. Verify each against code (a `researcher`) before you close: a decision built on an unverified primitive assumption is not a decision, it's a guess — and a guess is an open question. Do this on your own initiative — if the user has to ask "are you SURE you checked everything?", the gate already failed.

**Offer the domain-term candidates (offer-then-approve).** When a term got resolved during the interview — a fuzzy word sharpened to a canonical, a new domain concept named, an overloaded word collapsed to one meaning — don't defer ALL glossary capture to `/dobby:wrap`. At the handoff, LIST those resolved terms as `CONTEXT.md` candidates (each: the canonical term · its one-line meaning · the alias it replaces, if any) and ask the user which to capture. This is offer-then-approve, not silent write: you still edit no file mid-interview (the "note, don't write" rule holds) — you surface the candidates now so the decision is made while the reasoning is fresh. Terms the user defers or rejects stay noted for `/dobby:wrap` to reconsider.

Produce a tight **Decisions** summary the next step can consume verbatim: each entry = decision · rejected alternative · why · is it an ADR candidate? Include the new-term and ADR-candidate flags here — and mark the CONTEXT.md candidates the user approved above as capture-ready for the next stage to write.

**Persist it through the state engine, never by hand-editing the document.** If a work-session doc exists (from `/dobby:scope`, the repo-root `STATE.md`), write the summary to a scratch file outside the repo (the OS temp dir — e.g. `${TMPDIR:-/tmp}/dobby-findings-<timestamp>.md`, never a file inside the worktree) and hand that file to the engine:

```bash
bunx dobby state set 'Findings (interview)' --file <scratch-file>
```

(`--stdin` pipes a short body instead of a file.) The engine replaces that ONE section body and leaves every other byte — sections it has never heard of included — untouched, so later stages and subagents read a document nobody has to re-format. Because `set` REPLACES, a second interview pass writes the COMPLETE summary (the decisions already recorded plus the new ones), never just the delta. A refusal goes to stderr with a nonzero exit: no `STATE.md` means there is no work session to write into (creating it is `/dobby:scope`'s job), so the summary simply stays in the conversation.

## Anti-patterns

- Never batch DEPENDENT questions — a question whose premise depends on an answer still open belongs to a LATER round, not this one. (Independent questions travelling together is the point of a round; questions that hang off each other are not.)
- Never mix vehicles in one round: an AskUserQuestion popup hides the same turn's text, so ❓/➡️ questions go in their own turn after it — and a popup round never exceeds 4 questions.
- Never stop early because the user seems impatient — thoroughness now prevents rework later.
- Never present a recap and ask "shall I proceed?" if you can think of ONE more question.
- Never demote a genuine question to a side-note, recap line, or "micro-note in passing" ("I can also clean up X, unless…"). A side-note in your closing message is an unresolved branch — ask it as its own question instead. (Real failure: an interview closed with an alias cleanup as a "micro-nota de pasada"; it turned out to be a full decision requiring research.)
- Never record a decision that rests on how a shared primitive behaves without verifying that behavior against code first — such statements are claims, not facts. (Real failure: an interview closed a multi-decision recap with two decisions built on unchecked primitive behavior — a shared form hook's submit button that's permanently dead when the form has no fields, and a modal-over-modal nesting the codebase had never actually proven; both were wrong and only surfaced after the user pushed twice for a verification pass.)
- Never modify the glossary or any file mid-interview.

## Next step

End with an **AskUserQuestion** gate that restates the interview just finished and presents the next step. Recommend `/dobby:research` when the task will touch external tech (libraries/SDKs/APIs), otherwise recommend `/dobby:spec`; list the recommended command first and mark it. On selection, invoke the chosen `/dobby:<skill>` via the Skill tool. On "Stop here", point to where this stage's output lives (e.g. `STATE.md`).

- **`/dobby:research`** *(Recommended when the task touches external tech)* — fetch current docs for the libraries/SDKs the task will touch.
- **`/dobby:spec`** *(Recommended when there's no external tech worth researching)* — go straight to planning.
- **Stop here.**

## Language

Interview in the user's language. Write the Decisions summary (and anything persisted to `STATE.md`) in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Task framed (asked in plain text if `$ARGUMENTS` was empty)
- [ ] Domain glossary read (if present) and used; conflicts challenged
- [ ] Code explored via a `researcher` (findings held in your context) to ask informed, specific questions
- [ ] Every ambiguity, entity state, role, route, and edge case resolved — the frontier is empty
- [ ] Each turn asked ONE round, homogeneous by vehicle (popup round of ≤4 first, open-ended ❓/➡️ text round after), with consecutive rounds until the frontier drained — independent questions together, dependent ones deferred to a later round
- [ ] Every question was self-contained (its own context restated INSIDE the question, single topic) — no bundled/general multi-decision questions
- [ ] Any answer orphaned by a same-round sibling was discarded out loud and re-asked next round with the corrected premise
- [ ] Mid-interview facts went to a `researcher` without stalling the interview — only downstream questions waited
- [ ] Every decision resting on a shared-primitive behavior verified against code before close (proactively, not user-forced)
- [ ] Resolved domain terms offered as `CONTEXT.md` candidates at handoff (offer-then-approve); approved ones flagged in the Decisions summary
- [ ] Decisions summary produced, with new-term / ADR-candidate flags
- [ ] Summary persisted to `## Findings (interview)` via `bunx dobby state set` (complete summary, never a hand edit) when a work-session doc exists
- [ ] No files modified mid-interview — the `state set` handoff above is the only write
- [ ] Closing gate offered all three options, including the completeness self-audit that activates the litmus test + infra-assumption gate on demand and resumes interviewing on any gap it surfaces
- [ ] Next step handed off via an AskUserQuestion gate (recommended command marked; chosen skill invoked via the Skill tool)

---
*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `productivity/grilling` (partial port: AskUserQuestion remains the vehicle for anticipatable options and dobby's closing machinery is kept).*
