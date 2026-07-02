# HTML report — scaffold, CDNs, diagram patterns

The architecture review renders as a **single self-contained HTML file** in the OS temp directory — nothing lands in the repo. Tailwind and Mermaid both come from CDNs. Mermaid handles graph-shaped diagrams reliably; hand-built `<div>`s and inline SVG handle the more editorial visuals (mass diagrams, cross-sections). Mix the two — don't lean on Mermaid for everything, it starts to look generic.

The `dobby:implementor` writes this file; `/dobby:improve-architecture` hands it the findings + this reference. Path: `${TMPDIR:-/tmp}/architecture-review-<timestamp>.html` (fall back to `/tmp`; `%TEMP%\architecture-review-<timestamp>.html` on Windows). After writing, auto-open it (`open` macOS · `xdg-open` Linux · `start` Windows) and echo the absolute path.

## Scaffold (MODERN CDNs — do not copy the stale ones)

Tailwind **v4** ships a browser build at `@tailwindcss/browser@4` — NOT the old `cdn.tailwindcss.com` (v3). v4 is CSS-first: theme with `<style type="text/tailwindcss">@theme{…}</style>`, not the removed `tailwind.config = {}` JS global. Mermaid **11** is ESM-only and renders async — it MUST be `type="module"`; there is no UMD global.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <style type="text/tailwindcss">
      @theme {
        --color-leak: #dc2626;   /* red — leakage across a seam */
        --color-deep: #0f172a;   /* dark — a deep module */
      }
    </style>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
    </script>
    <style>
      /* small custom layer for things Tailwind doesn't cover cleanly:
         dashed seam lines, hand-drawn-feeling arrow heads, etc. */
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

No Subresource-Integrity attributes: the version-range CDN URLs (`@4`, `@11`) resolve to different files over time, so a pinned `integrity` hash would break on the next patch release — SRI is omitted by design. Offline (no network under `file://`) the report renders unstyled; that's acceptable.

## Header

Repo name, date, and a compact legend: solid box = module, dashed line = seam, red arrow = leakage, thick dark box = deep module. No introduction paragraph — straight into the candidates.

## Candidate card

The diagrams carry the weight. Prose is sparse, plain, and uses the vocabulary from `skills/spec/references/architecture-vocab.md` without ceremony. Each candidate is one `<article>`:

- **Title** — short, names the deepening (e.g. "Collapse the Order intake pipeline").
- **Badge row** — recommendation strength (`Strong` = emerald · `Worth exploring` = amber · `Speculative` = slate), plus a dependency-category tag (`in-process` · `local-substitutable` · `ports & adapters` · `mock`).
- **Files** — monospaced list, `font-mono text-sm`.
- **Before / After diagram** — the centerpiece. Two columns, side by side. See patterns below.
- **Problem** — one sentence. What hurts.
- **Solution** — one sentence. What changes.
- **Wins** — bullets, ≤6 words each, named in glossary terms: "locality: bugs concentrate in one module", "leverage: one interface, N call sites", "interface shrinks; implementation absorbs the wrappers". NEVER "easier to maintain" / "cleaner code" — those aren't in the glossary and don't earn their place.
- **ADR callout** (if applicable) — one line in an amber-tinted box.

No paragraphs of explanation. If the diagram needs a paragraph to be understood, redraw the diagram.

### Badges (Tailwind classes)

```html
<span class="rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium px-2.5 py-0.5">Strong</span>
<span class="rounded-full bg-amber-100  text-amber-800  text-xs font-medium px-2.5 py-0.5">Worth exploring</span>
<span class="rounded-full bg-slate-100  text-slate-700  text-xs font-medium px-2.5 py-0.5">Speculative</span>
```

### ADR callout (amber, only when the friction is real)

ADRs in `docs/adr/` record decisions this pass must not re-litigate (`docs/adr/0001` — Conductor as execution host — already exists; `/dobby:wrap` and `/dobby:address-review` both write further sequential ADRs). Surface a conflict ONLY when the friction warrants reopening the ADR — don't list every refactor an ADR theoretically forbids.

```html
<div class="rounded-md border-l-4 border-amber-400 bg-amber-50 px-4 py-2 text-sm text-amber-900">
  Contradicts ADR-0001 — worth reopening because {{the real friction}}.
</div>
```

## Diagram patterns

Pick the pattern that fits the candidate. Mix them — variety is part of the point. Keep each diagram ~320px tall so before/after sits side by side without scrolling. Use `text-xs uppercase tracking-wider` for module labels inside diagrams so they read as schematic, not as UI.

### 1. Mermaid graph (the workhorse for dependencies / call flow)

Use a Mermaid `flowchart`/`graph` when the point is "X calls Y calls Z, and look at the mess." Wrap it in a Tailwind card so it doesn't feel parachuted in. `classDef` + `class` colour leakage edges red and the deep module dark. Sequence diagrams work for "before: 6 round-trips; after: 1."

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### 2. Hand-built boxes-and-arrows (when Mermaid's layout weight is wrong)

Modules as `<div>`s with borders and labels; arrows as inline SVG `<line>`/`<path>` positioned absolutely over a `relative` container. Reach for this when the "after" should feel like one thick-bordered **deep** module with greyed-out internals — Mermaid won't render that weight.

```html
<div class="relative h-[320px]">
  <div class="deep absolute inset-6 rounded-xl border-2 border-slate-900 text-stone-100 p-4">
    <span class="text-xs uppercase tracking-wider">Order intake</span>
    <div class="opacity-40 mt-3 space-y-1 text-xs">validate · price · persist</div>
  </div>
  <svg class="absolute inset-0 h-full w-full" fill="none">
    <line x1="10" y1="60" x2="120" y2="60" class="leak" stroke-width="2" />
  </svg>
</div>
```

### 3. Cross-section (good for layered shallowness)

Stack horizontal bands (`h-12 border-l-4`) to show the layers a call passes through. Before: 6 thin layers each doing nothing. After: 1 thick band labelled with the consolidated responsibility.

```html
<div class="space-y-1">
  <div class="h-12 border-l-4 border-slate-300 bg-white pl-3 flex items-center text-xs">Handler</div>
  <div class="h-12 border-l-4 border-slate-300 bg-white pl-3 flex items-center text-xs">Validator</div>
  <div class="h-12 border-l-4 border-slate-300 bg-white pl-3 flex items-center text-xs">Mapper</div>
  <!-- after: one thick band -->
  <div class="h-24 border-l-4 border-emerald-500 bg-emerald-50 pl-3 flex items-center text-xs">Order intake (deep)</div>
</div>
```

### 4. Mass diagram (good for "interface as wide as implementation")

Two rectangles per module — interface surface area vs implementation surface area. Before: interface rectangle nearly as tall as implementation (shallow). After: interface short, implementation tall (deep).

```html
<div class="flex items-end gap-2 h-[320px]">
  <div class="w-16 bg-slate-400 h-40" title="interface"></div>
  <div class="w-16 bg-slate-700 h-44" title="implementation"></div>
  <!-- after -->
  <div class="w-16 bg-slate-400 h-10" title="interface"></div>
  <div class="w-16 bg-slate-900 h-64" title="implementation"></div>
</div>
```

### 5. Call-graph collapse (good for "many shallow calls become one deep module")

Before: a tree of function calls as nested boxes. After: the same tree collapsed into one box, the now-internal calls faded inside it.

```html
<!-- after -->
<div class="rounded-lg border-2 border-slate-900 p-4">
  <span class="text-xs uppercase tracking-wider">Order intake</span>
  <div class="mt-2 opacity-30 space-y-1 text-xs">
    <div class="rounded border px-2 py-1">validateOrder()</div>
    <div class="rounded border px-2 py-1">priceOrder()</div>
    <div class="rounded border px-2 py-1">persistOrder()</div>
  </div>
</div>
```

## Style guidance

- Lean editorial, not corporate-dashboard. Generous whitespace. Serif optional for headings (`font-serif` reads well with stone/slate).
- Colour sparingly: one accent (emerald or indigo) plus red for leakage and amber for warnings.
- The only scripts are the Tailwind v4 browser build and the Mermaid 11 ESM import. Otherwise static — no app code, no interactivity beyond Mermaid's own rendering.

## Top recommendation section

One larger card: candidate name, one sentence on why, an anchor link to its card. That's it.

## Vocabulary (locked to `architecture-vocab.md`)

Architecture nouns and verbs come straight from `skills/spec/references/architecture-vocab.md`; domain nouns come from the project's `CONTEXT.md`. Concision is not an excuse to drift.

**Use exactly:** module · interface · implementation · depth · deep · shallow · seam · adapter · leverage · locality.

**Never substitute:** component / service / unit (for module) · API / signature (for interface) · boundary (for seam) · layer / wrapper (for module, when you mean module).

**Phrasings that fit:**

- "Order intake module is shallow — interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

No hedging, no throat-clearing, no "it's worth noting that…". If a sentence could be a bullet, make it a bullet. If a bullet could be cut, cut it. If a term isn't in `architecture-vocab.md`, reach for one that is before inventing a new one.

---

_Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `improve-codebase-architecture/HTML-REPORT.md` — CDNs modernized (Tailwind v4 browser build + Mermaid 11 ESM), vocabulary re-anchored to dobby's `architecture-vocab.md`._
