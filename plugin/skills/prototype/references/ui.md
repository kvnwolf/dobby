# UI Prototype

Generate **several radically different UI variations** on a single route, switchable from a floating bottom bar. The user flips between variants in the browser, picks one (or steals bits from each), then throws the rest away.

If the question is about logic/state rather than what something looks like — wrong branch. Use `logic.md`.

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Two sub-shapes — strongly prefer sub-shape A

A UI prototype is much easier to judge when it's **butting up against the rest of the app** — real header, real sidebar, real data, real density. A throwaway route on its own is a vacuum: every variant looks fine in isolation.

### Sub-shape A — adjustment to an existing page (preferred)

The route already exists. Variants render **on the same route**, gated by a `?variant=` URL search param. The existing data fetching, params, and auth all stay — only the rendering swaps. If the thing being prototyped doesn't have a page yet but *would naturally live inside one* (a new dashboard section, a new card, a new step in an existing flow) — still sub-shape A: mount the variants inside the host page.

### Sub-shape B — a new page (last resort)

Only when the thing genuinely has no existing page to live inside (an entirely new top-level surface). Create a **throwaway route** following the project's existing routing convention — obviously named as a prototype (e.g. `prototype` in the path). Same `?variant=` pattern. Before committing to B, sanity-check: is there really no page this could be embedded in? An empty route hides design problems a populated one would expose.

## Process (the architect specs this; the implementor builds it)

### 1. State the question and pick N

Default to **3 variants**; cap at 5 (beyond that it stops being radically different and starts being noise). Write the plan in one line at the prototype's location:

> "Three variants of the settings page, switchable via `?variant=`, on the existing `/settings` route."

### 2. Generate radically different variants

Hold each variant to: the page's purpose and available data · the project's component library / styling system · a clear exported name (`VariantA`, `VariantB`, `VariantC`).

Variants must be **structurally different** — different layout, different information hierarchy, different primary affordance, not just different colours. Three slightly-tweaked card grids isn't a UI prototype, it's wallpaper. If two drafts come out too similar, redo one with explicit "do not use a card grid"-style guidance.

### 3. Wire them together

A single switcher on the route:

```tsx
// pseudo-code — adapt to the project's framework
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A','B','C']} current={variant} />
  </>
);
```

Sub-shape A: existing data fetching stays above the switcher; only the rendered subtree changes. Sub-shape B: the throwaway route mounts the same switcher.

### 4. Build the floating switcher

A small fixed-position bar at the bottom-centre:

- **Left arrow** — previous variant (wraps) · **variant label** (`B — Sidebar layout`) · **right arrow** — next (wraps).
- Arrows update the URL search param via the framework's router (`router.replace` / `navigate`) so the variant is shareable and reload-stable.
- Keyboard `←`/`→` also cycle — but never when an `<input>`, `<textarea>`, or `[contenteditable]` is focused.
- Visually distinct from the page (high-contrast pill, subtle shadow) so it's obviously not part of the design being evaluated.
- **Hidden in production builds** — gate on `process.env.NODE_ENV !== 'production'` or equivalent, so a stray merge can't ship the bar.

One shared switcher component, located wherever shared UI lives, so both sub-shapes reuse it.

### 5. Hand it over

Surface the URL **on the already-running dev server** — resolve it the way `/dobby:execute` Step 2 does (`bunx dobby up` ensures the run is up, then read `devUrl` from `bunx dobby env`); never start a second one — + the `?variant=` keys. The user flips through at their pace. The interesting feedback is usually **"I want the header from B with the sidebar from C"** — that's the actual design they want. Apply adjustments through the implementor; add a variant D if asked.

### 6. Capture the answer and clean up

Once a variant wins, capture which and why — see the SKILL's Step 4 (STATE.md / NOTES.md). Then:

- **Sub-shape A** — delete the losing variants and the switcher; fold the winner into the existing page.
- **Sub-shape B** — promote the winner to a real route; delete the throwaway route and the switcher.

Don't leave variant components or the switcher lying around — they rot fast and confuse the next reader.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype. Real variants disagree about structure.
- **Sharing too much code between variants.** A shared `<Header>` is fine; a shared `<Layout>` defeats the point — each variant must be free to throw out the layout.
- **Wiring variants to real mutations.** Read-only is fine; if a variant needs to mutate, point it at a stub. The question is "what should this look like", not "does the backend work".
- **Promoting prototype code directly to production.** It was written under prototype constraints (no tests, minimal error handling) — rewrite it properly when folding it in.
