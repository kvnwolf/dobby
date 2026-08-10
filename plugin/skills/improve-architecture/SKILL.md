---
name: improve-architecture
description: Review the architecture of a module, subsystem, or repo and propose prioritized improvements. Use to assess structural health, find module-boundary smells, or plan a refactor — it reports opportunities, it doesn't change code.
argument-hint: "[module/path/subsystem, or blank for the whole repo]"
---

Assess structural health and propose improvements — you report and prioritize; you do NOT change code (hand a chosen refactor to `/dobby:scope`). The bar is the deep, contained-module ideal: a module owns one feature/domain slice end-to-end, its files named by role and imported by deep path (no barrel).

## Step 1: Scope the target

From `$ARGUMENTS`: a module, a subsystem, or the whole repo. If blank, ask what to assess (or default to the area last worked on). Read the root `CLAUDE.md` / `CONTEXT.md` for the project's own stated conventions — assess against THOSE plus the principles below, not a generic ideal.

## Step 2: Map the structure (researcher)

Before `bunx` or the first Agent, require BOTH local onboarding markers at the
current workroot: `dobby.config.json` and `node_modules/.bin/dobby`. If either is
absent, STOP, point to `/dobby:onboard`, and do not run `bunx dobby`; never use
remote resolution as onboarding. Only then run `bunx dobby env --json`, require
the complete `workflowRecipe`, and validate its positive-integer
`limits.maxConcurrency`. Missing/malformed data means STOP with zero Agents;
never infer a fallback.

Dispatch `researcher` agent(s) (Agent tool, `subagent_type: "dobby:researcher"`) to map the target — modules, their public interfaces, the import graph, where logic actually lives. For a whole-repo pass, partition independent areas into deterministic sequential batches of at most `workflowRecipe.limits.maxConcurrency`: launch one batch in parallel, await all its results, then launch the next. Retries and replacement Agents consume a slot. They return grounded findings with paths; you don't grep in the main thread.

## Step 3: Assess against the principles

From the findings, judge against:

- **Group by domain, not type** — flag top-level `components/` / `services/` / `utils/` / `hooks/` buckets that everything imports from.
- **No barrel** — flag a surviving `index.ts` re-export barrel, or a module whose files aren't named by role / aren't importable by deep path.
- **Deep, not shallow** — flag interfaces nearly as complex as their implementation (the boundary isn't earning its keep).
- **Co-location** — flag a feature's pieces scattered across the tree.
- **Inline-by-default** — flag premature `-components/` scatter folders for single-use pieces.
- **Stale docs** — flag a module `CONTEXT.md` that no longer matches the code (or is missing).

## Step 4: Render the visual HTML report

The deliverable is a **self-contained visual HTML report** — the diagrams carry the argument, prose is sparse. Have a `dobby:implementor` write it (the architect never writes files): hand it the findings plus `skills/improve-architecture/references/html-report.md`, the report's full spec — scaffold, modern-CDN wiring (the upstream CDNs it corrects are stale — the implementor must follow the reference, not training-data defaults), candidate-card contract, badges, and the five diagram patterns with markup.

**Where it lands (NEVER in the repo):** `${TMPDIR:-/tmp}/architecture-review-<timestamp>.html` — a fresh file per run, auto-opened after writing, absolute path echoed so the user always has it (per-OS paths and open commands are in the reference).

Treat that exact absolute path as the direct writer's artifact scope and validate its `{status, workLog, blocker}` envelope before opening or handing off the report:

- `{status: "completed", workLog: <non-empty>, blocker: ""}` → integrate the accounting, mechanically require a non-empty file at the exact path (`test -s`) and Read its HTML scaffold/top recommendation anchors, then open/report it.
- `{status: "blocked", workLog: <non-empty>, blocker: <non-empty>}` → report BOTH blocker and report accounting, return `needs-human`, and STOP before opening it or offering `/dobby:scope`.
- Null, a bare work log, empty required fields, or an incoherent envelope → mechanically inspect the exact temp path with `test -e` / `test -s` and Read whatever artifact exists. Report that accounting and return `needs-human`; a plausible partial HTML file is not completion, and no next-step handoff follows.

**ADR-respect:** ADRs in `docs/adr/` record decisions this pass must not re-litigate (`docs/adr/0001` — Conductor as execution host — already exists; `/dobby:wrap` and `/dobby:address-review` both write further sequential ADRs). Surface an ADR conflict **only when the friction is real** enough to warrant reopening it — an amber callout in the card (_"contradicts ADR-0001 — worth reopening because…"_). Don't list every refactor an ADR theoretically forbids.

**Vocabulary is locked** to `skills/spec/references/architecture-vocab.md` — its use-exactly and never-substitute lists apply verbatim (`module`, `seam`, `depth`, `leverage`, `locality`, …). Domain nouns come from the project's `CONTEXT.md` (talk about "the Order intake module", not "the FooBarHandler"). Rank cards by leverage (worst boundary / highest-churn first). Be honest about what's fine — don't manufacture refactors. Close with a **Top recommendation** section: which candidate to tackle first, one sentence on why, an anchor link to its card.

## Next step

Present an **AskUserQuestion** restating that the architecture review is done, with the next-step commands as options (recommended first, with why, plus **Stop here**). On selection, invoke the chosen `/dobby:<skill>` via the Skill tool; on **Stop here** end the turn and point to the echoed report path (the HTML file in the OS temp dir — it stands on its own).

- **`/dobby:scope`** *(Recommended)* — start a work session on the top improvement (it becomes the goal).
- **Stop here** — the report stands; act later.

## Language

Interact in the user's language; write the HTML report's prose in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Both local markers (`dobby.config.json` + `node_modules/.bin/dobby`) existed before `bunx`; either missing STOPped at `/dobby:onboard` without remote resolution or Agent launch
- [ ] `bunx dobby env --json` resolved a complete recipe and valid `limits.maxConcurrency` before the first Agent; malformed/missing data launched zero Agents
- [ ] Researcher fan-out ran in sequential batches no larger than the resolved limit; retries/replacements counted and areas within a batch were independent
- [ ] The report implementor ran only after all research batches completed, so it never overlapped the mapping fan-out
- [ ] Report envelope handled fail-closed before open/handoff: coherent `completed` plus exact-path `test -s`/Read integrated; `blocked` reported blocker + accounting; null/malformed inspected the temp artifact and ended `needs-human` without `/dobby:scope`
