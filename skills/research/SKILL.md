---
name: research
description: Gather the technical context a plan needs before building — fetch current docs for the libraries/SDKs/CLIs/services a task will touch, find existing skills/modules to reuse, and resolve technical unknowns. Use after aligning on a task and before planning it, or when asked to research the tech or approach for an upcoming change. (For a one-off doc lookup, use find-docs directly.)
argument-hint: "[technologies or questions to research]"
model: opus
effort: high
---

Give the planning step everything it needs to design without guessing. Research gathers knowledge — current docs, reusable tooling, resolved unknowns — it does NOT write code or plan. Training data lags, so everything gets verified against current docs. You orchestrate `researcher` agents and synthesize what they return; you don't do the digging in the main thread.

## Step 1: Enumerate what to research (you)

From the task and any interview decisions (or `$ARGUMENTS`), list:

- Every library, framework, SDK, CLI tool, cloud service, and API the work will touch — even well-known ones (their APIs change between versions).
- Technical unknowns the interview surfaced ("how does X's webhook retry work?", "which approach for Y?").
- The domain or topic, if it needs background.
- Applicable **skills** to reuse — scan the available skills in your system prompt (a forms skill for a form, a listing-page skill for an admin table, a component skill for UI, etc.) and note which apply. You have this list; the researchers don't, so capture it here.

If nothing is uncertain and no external tech is involved, say so and stop — don't manufacture research.

## Step 2: Dispatch researchers (parallel)

Hand each independent research item to a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`), in parallel — each one fetches current docs (via `ctx7`), traces the codebase, and returns grounded findings. Don't fetch docs or grep in the main thread; that's what the researchers are for. Group sensibly — one per technology, or per cluster of related unknowns:

- **Per technology** → "fetch current docs for `<lib>` and report the exact signatures / config keys / version gotchas this task needs: `<specifics>`".
- **Codebase reuse** → "find existing modules/patterns in this repo that already do `<X>`; report paths + how callers use them".
- **Bounded unknown** → "resolve `<question>` against the docs/code and report the answer with evidence".

For BROAD or open web questions (architecture comparisons, "how do teams do X", cross-approach trade-offs), delegate to **`deep-research`** instead — its multi-source, fact-checked report is the right tool, not a single `researcher`. For a question only answerable empirically ("does this actually work / feel right?", "which variant do we like?"), don't research it to death — send the user to TYPE **`/dobby:prototype`** (logic or UI branch; do NOT auto-invoke it — typed entry applies its own `model`/`effort`) and fold the captured answer into the brief, or flag it as Open for the plan if it can wait.

## Step 3: Synthesize the brief (you)

From the researchers' findings, write a tight brief the planning step can consume verbatim:

- **Per technology** — the key facts the task relies on (signatures, config, version/gotcha), each with its doc source.
- **Reuse** — applicable skills and existing modules, and what each is for.
- **Resolved** — each answered question + the answer + why.
- **Open** — what still needs a spike or a decision, flagged clearly.

Keep it to what the task needs. Don't paste raw docs. If a work-session doc exists (the repo-root `STATE.md` from `/dobby:scope`), write this brief into its `## Research` section.

## Next step

End with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke. The next stage must be TYPED by the user: typed entry applies the next skill's own `model`/`effort`; an auto-invoked skill rides the current turn's override instead. State the recommended command first (with why), then the alternatives; on stop, point to where this stage's output lives (e.g. `STATE.md`).

- **`/dobby:spec`** *(Recommended)* — turn the decisions + this brief into a build plan.
- `/dobby:interview` — if the research opened new questions that need aligning.
- **Stop here.**

## Language

Interact with the user in their language. Write the research brief in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Every technology and unknown enumerated; applicable skills noted by you (you hold the list)
- [ ] Docs / codebase / unknowns researched by `researcher` agents (not dug in the main thread); current docs via ctx7, not training data
- [ ] Broad/open web questions sent to `deep-research`; empirical questions sent to `/dobby:prototype` or flagged as Open
- [ ] Concise research brief synthesized from the findings; no code written, no plan made
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
