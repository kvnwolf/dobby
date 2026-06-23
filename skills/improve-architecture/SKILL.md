---
name: improve-architecture
description: Review the architecture of a module, subsystem, or repo against deep-contained-module principles, and propose prioritized improvements. Use to assess structural health, find module-boundary smells, or plan a refactor — it reports opportunities, it doesn't change code.
argument-hint: "[module/path/subsystem, or blank for the whole repo]"
model: opus
effort: max
---

Assess structural health and propose improvements — you report and prioritize; you do NOT change code (hand a chosen refactor to `/dobby:scope`). The bar is the deep, contained-module ideal: a module owns one feature/domain slice end-to-end behind one public interface.

## Step 1: Scope the target

From `$ARGUMENTS`: a module, a subsystem, or the whole repo. If blank, ask what to assess (or default to the area last worked on). Read the root `CLAUDE.md` / `CONTEXT.md` for the project's own stated conventions — assess against THOSE plus the principles below, not a generic ideal.

## Step 2: Map the structure (researcher)

Dispatch `researcher` agent(s) (Agent tool, `subagent_type: "dobby:researcher"`) to map the target — modules, their public interfaces, the import graph, where logic actually lives. For a whole-repo pass, fan out several researchers over different areas in parallel. They return grounded findings with paths; you don't grep in the main thread.

## Step 3: Assess against the principles

From the findings, judge against:

- **Group by domain, not type** — flag top-level `components/` / `services/` / `utils/` / `hooks/` buckets that everything imports from.
- **One public interface** — flag modules callers reach into past their entry point.
- **Deep, not shallow** — flag interfaces nearly as complex as their implementation (the boundary isn't earning its keep).
- **Co-location** — flag a feature's pieces scattered across the tree.
- **Inline-by-default** — flag premature `-components/` scatter folders for single-use pieces.
- **Stale docs** — flag a module `CONTEXT.md` that no longer matches the code (or is missing).

## Step 4: Report — prioritized

Output a tight report: each finding = what's wrong · where (paths) · why it matters · the proposed move · rough effort. Rank by leverage (worst boundary / highest-churn area first). Be honest about what's fine — don't manufacture refactors.

## Next step

End with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke. The next stage must be TYPED by the user: typed entry applies the next skill's own `model`/`effort`; an auto-invoked skill rides the current turn's override instead. State the recommended command first (with why), then the alternatives; on stop, point to where this stage's output lives (e.g. `STATE.md`).

- **`/dobby:scope`** *(Recommended)* — start a work session on the top improvement (it becomes the goal).
- **Stop here** — the report stands; act later.

## Language

Interact in the user's language; write the report in English; keep domain terms in their real-world form.
