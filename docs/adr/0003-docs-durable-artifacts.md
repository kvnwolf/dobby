# Durable kit artifacts live under `docs/`

**Status:** accepted

Three new skills produce artifacts that must survive across sessions (unlike the ephemeral, gitignored `STATE.md`): `/dobby:map`'s decision-map (a multi-session planning file resolved one ticket at a time), `/dobby:triage`'s out-of-scope KB (rejected-scope memory, one file per concept), and `/dobby:learn`'s discarded-frictions KB (why a field-friction did not warrant a skill edit). We decided these committed, durable artifacts live under **`docs/`** — `docs/maps/`, `docs/out-of-scope/`, `docs/learn-discarded/` — created lazily by the skills, alongside the existing `docs/adr/`. We chose `docs/` over a namespaced `.dobby/` directory because the decision-map and out-of-scope KB are *about the project* (a migration, a rejected feature), so they belong with the project's documentation, and reusing an existing convention adds zero new surface. ADRs stay in `docs/adr/` and `STATE.md` stays ephemeral at the repo root — neither moves.

## Considered options

- **`docs/` (chosen)** — reuse the existing docs convention; no new top-level directory; the artifacts are largely project-owned, so `docs/` is the honest home.
- **A `.dobby/` umbrella** — rejected: it namespaces kit mechanics cleanly, but two of the three artifacts (map, out-of-scope) are really about the project, not the kit, so a kit-namespaced dir mis-frames them; and it introduces new surface for no gain.
- **Matt-style loose top-level dirs** (`.out-of-scope/`, a root-level map) — rejected: no common umbrella, scatters the artifacts.

## Consequences

- `ADR`s (`docs/adr/`) and the project glossary (`CONTEXT.md`) remain project-owned and untouched by this convention; `STATE.md` remains ephemeral/gitignored at the repo root.
- The three KB directories are created lazily by their skills — no empty directories are committed.
- The distinction is kit-mechanics-that-are-project-content (→ `docs/`) versus session working memory (→ ephemeral `STATE.md`). `mark`/`learn` host coupling is orthogonal (Claude Code session storage, not repo files).
