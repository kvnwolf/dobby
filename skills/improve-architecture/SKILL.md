---
name: improve-architecture
description: Review the architecture of a module, subsystem, or repo against deep-contained-module principles, and propose prioritized improvements. Use to assess structural health, find module-boundary smells, or plan a refactor — it reports opportunities, it doesn't change code.
argument-hint: "[module/path/subsystem, or blank for the whole repo]"
model: claude-fable-5[1m]
effort: max
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

The deliverable is a **self-contained visual HTML report** — the diagrams carry the argument, prose is sparse. Have a `dobby:implementor` write it (the architect never writes files); hand it the findings, the card contract, and the diagram patterns below. See `skills/improve-architecture/references/html-report.md` for the full scaffold, modern-CDN wiring, and per-pattern markup.

**Where it lands (NEVER in the repo):** write to `${TMPDIR:-/tmp}/architecture-review-<timestamp>.html` (on Windows, `%TEMP%\architecture-review-<timestamp>.html`) — a fresh file per run. After writing, auto-open it (`open <path>` on macOS · `xdg-open <path>` on Linux · `start <path>` on Windows) and **echo the absolute path** so the user always has it.

**Modern CDNs only** (Matt's source is stale — do NOT copy `cdn.tailwindcss.com`):
- Tailwind v4 browser build — `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`. In-page theme via `<style type="text/tailwindcss">@theme{ --color-…:… }</style>` (v4 is CSS-first; the v3 `tailwind.config = {}` JS global is gone).
- Mermaid 11 ESM — `<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });</script>`. v11 is ESM-only and renders async — it MUST be `type="module"`, there is no UMD global.

**Each candidate = one card** (deepening named in its title): **Files** (monospaced) · **Problem** (ONE sentence — what hurts) · **Solution** (ONE sentence — what changes) · **Wins** (bullets, ≤6 words, named in glossary terms — `locality`, `leverage`, `depth`; NEVER "cleaner" / "easier" / "maintainable") · **before/after diagram** (the centerpiece) · a **recommendation-strength badge** · an optional **ADR callout**. If a diagram needs a paragraph to be understood, redraw the diagram.

**Recommendation-strength badges:** `Strong` = emerald · `Worth exploring` = amber · `Speculative` = slate (plus a dependency-category tag: `in-process` / `local-substitutable` / `ports & adapters` / `mock`).

**Five diagram patterns — mix them, don't make every diagram look the same:**
1. **Mermaid graph** — the workhorse for dependencies / call flow (`flowchart`/`graph`); `classDef` + `class` to colour leakage edges red and the deep module dark.
2. **Hand-built boxes-and-arrows** — `<div>`s with borders + inline SVG `<line>`/`<path>` arrows, when Mermaid's layout weight is wrong (e.g. one thick-bordered deep module with greyed internals).
3. **Cross-section** — stacked horizontal bands (`h-12 border-l-4`) for layered shallowness: before = 6 thin layers each doing nothing; after = 1 thick consolidated band.
4. **Mass diagram** — two rectangles per module (interface surface vs implementation surface): before = interface nearly as tall as implementation (shallow); after = short interface, tall implementation (deep).
5. **Call-graph collapse** — a tree of nested call boxes; after = collapsed into one box with the now-internal calls faded inside it.

**ADR-respect:** ADRs in `docs/adr/` record decisions this pass must not re-litigate (`docs/adr/0001` — Conductor as execution host — already exists; `/dobby:wrap` and `/dobby:address-review` both write further sequential ADRs). Surface an ADR conflict **only when the friction is real** enough to warrant reopening it — an amber callout in the card (_"contradicts ADR-0001 — worth reopening because…"_). Don't list every refactor an ADR theoretically forbids.

**Vocabulary is locked** to `skills/spec/references/architecture-vocab.md` — use `module`, `interface`, `implementation`, `depth` / `deep` / `shallow`, `seam`, `adapter`, `leverage`, `locality` exactly; never substitute `component` / `service` / `unit` (for module), `API` / `signature` (for interface), `boundary` (for seam), or `layer` / `wrapper` (for module). Domain nouns come from the project's `CONTEXT.md` (talk about "the Order intake module", not "the FooBarHandler"). Rank cards by leverage (worst boundary / highest-churn first). Be honest about what's fine — don't manufacture refactors. Close with a **Top recommendation** section: which candidate to tackle first, one sentence on why, an anchor link to its card.

## Next step

End with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke. The next stage must be TYPED by the user: typed entry applies the next skill's own `model`/`effort`; an auto-invoked skill rides the current turn's override instead. State the recommended command first (with why), then the alternatives; on stop, point to the echoed report path (the HTML file in the OS temp dir — it stands on its own).

- **`/dobby:scope`** *(Recommended)* — start a work session on the top improvement (it becomes the goal).
- **Stop here** — the report stands; act later.

## Language

Interact in the user's language; write the HTML report's prose in English; keep domain terms in their real-world form.
