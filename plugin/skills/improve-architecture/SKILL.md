---
name: improve-architecture
description: Review the architecture of a module, subsystem, or repo and propose prioritized improvements. Use to assess structural health, find module-boundary smells, or plan a refactor — it reports opportunities, it doesn't change code.
argument-hint: "[module/path/subsystem, or blank for the whole repo]"
---

Assess structural health and propose improvements — you report and prioritize; you do NOT change code (hand a chosen refactor to `/dobby:scope`). The bar is the deep, contained-module ideal: a module owns one feature/domain slice end-to-end, its files named by role and imported by deep path (no barrel).

## Step 1: Scope the target

From `$ARGUMENTS`: a module, a subsystem, or the whole repo. If blank, ask what to assess (or default to the area last worked on). Read the root `CLAUDE.md` / `CONTEXT.md` for the project's own stated conventions — assess against THOSE plus the principles below, not a generic ideal.

## Step 2: Map the structure (researcher)

Dispatch `researcher` agent(s) (Agent tool, `subagent_type: "dobby:researcher"`) to map the target — modules, their public interfaces, the import graph, where logic actually lives. For a whole-repo pass, fan out several researchers over different areas in parallel. They return grounded findings with paths; you don't grep in the main thread.

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

**ADR-respect:** ADRs in `docs/adr/` record decisions this pass must not re-litigate (`docs/adr/0001` — Conductor as execution host — already exists; `/dobby:wrap` and `/dobby:address-review` both write further sequential ADRs). Surface an ADR conflict **only when the friction is real** enough to warrant reopening it — an amber callout in the card (_"contradicts ADR-0001 — worth reopening because…"_). Don't list every refactor an ADR theoretically forbids.

**Vocabulary is locked** to `skills/spec/references/architecture-vocab.md` — its use-exactly and never-substitute lists apply verbatim (`module`, `seam`, `depth`, `leverage`, `locality`, …). Domain nouns come from the project's `CONTEXT.md` (talk about "the Order intake module", not "the FooBarHandler"). Rank cards by leverage (worst boundary / highest-churn first). Be honest about what's fine — don't manufacture refactors. Close with a **Top recommendation** section: which candidate to tackle first, one sentence on why, an anchor link to its card.

## Next step

Present an **AskUserQuestion** restating that the architecture review is done, with the next-step commands as options (recommended first, with why, plus **Stop here**). On selection, invoke the chosen `/dobby:<skill>` via the Skill tool; on **Stop here** end the turn and point to the echoed report path (the HTML file in the OS temp dir — it stands on its own).

- **`/dobby:scope`** *(Recommended)* — start a work session on the top improvement (it becomes the goal).
- **Stop here** — the report stands; act later.

## Language

Interact in the user's language; write the HTML report's prose in English; keep domain terms in their real-world form.
