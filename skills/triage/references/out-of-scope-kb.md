# The out-of-scope knowledge base

`docs/out-of-scope/` stores durable, git-tracked records of **rejected enhancement requests**. It serves two purposes:

1. **Institutional memory** — why a feature was rejected, so the reasoning survives the issue being closed.
2. **Deduplication** — when a matching request returns, triage surfaces the prior decision instead of re-litigating it.

The directory is created lazily on the first rejection — don't commit an empty `docs/out-of-scope/`.

## Directory structure

```
docs/out-of-scope/
├── dark-mode.md
├── plugin-system.md
└── graphql-api.md
```

One file per **concept**, not per issue. Every issue requesting the same thing groups under one concept file.

## File format

Write it in a relaxed, readable style — closer to a short design note than a database row. Use paragraphs, code samples, and examples so the reasoning is clear to someone meeting it for the first time.

```markdown
# Dark Mode

This project does not support dark mode or user-facing theming.

## Why this is out of scope

The rendering pipeline assumes a single color palette defined in `ThemeConfig`.
Supporting multiple themes would require a theme context provider wrapping the
whole tree, per-component theme-aware style resolution, and a persistence layer
for user preferences. That's a significant architectural change that doesn't
align with the project's focus on content authoring — theming is a downstream
concern for consumers who embed or redistribute the output.

## Prior requests

- #42 — "Add dark mode support"
- #87 — "Night theme for accessibility"
- #134 — "Dark theme option"
```

### Naming the file

A short, descriptive **kebab-case** concept name: `dark-mode.md`, `plugin-system.md`, `graphql-api.md`. Someone browsing the directory should understand what was rejected without opening the file.

### Writing the reason

The reason must be substantive — not "we don't want this" but *why*. Good reasons reference:

- **Project scope / philosophy** — "This project focuses on X; theming is a downstream concern."
- **Technical constraints** — "Supporting this needs Y, which conflicts with our Z architecture."
- **Strategic decisions** — "We chose A over B because…"

The reason must be **durable**. Avoid temporary circumstances ("we're too busy right now") — those are deferrals, not rejections, and don't belong here.

## Dedup by concept, not keyword

When triage reads these records (Step 1), it matches an incoming request against them by **concept similarity, not keyword overlap** — "night theme" matches `dark-mode.md`. The maintainer confirms the match:

- **Confirm** — append the new issue to that file's "Prior requests" list, then close.
- **Reconsider** — delete or update the record; the issue proceeds through normal triage.
- **Distinct** — related but genuinely different concept; proceed with normal triage (possibly a new concept file later).

## When to write here — and when NOT to

**Write only when an *enhancement* is rejected as wontfix.** This applies to a rejected enhancement PR exactly as to an issue — a rejected PR is recorded so the same request doesn't return as fresh code.

**Never write here for an already-implemented outcome.** When something is closed because the feature *already exists*, it's a built feature, not a rejected one — recording it would poison the dedup checks with a false rejection, causing triage to wave off a legitimate request later. The closing comment points to where the feature already lives instead.

**Never write here for a rejected bug.** The KB is enhancements only.

| Outcome | Write to `docs/out-of-scope/`? |
|---|---|
| Rejected enhancement (wontfix) | **Yes** — one concept file |
| Already implemented | **No** — comment pointing to where it lives |
| Rejected bug | No |

## The write flow (rejected enhancement)

1. The maintainer decides the enhancement is out of scope.
2. Check whether a matching concept file already exists (by concept, not keyword).
3. **Match** → append the new issue to its "Prior requests" list.
4. **No match** → create a new kebab-case concept file with the concept heading, the "Why this is out of scope" reason, and the first prior request.
5. Post a comment on the issue (AI disclaimer first) explaining the decision and linking the record.
6. Close the issue.

## Reconsidering later

If the maintainer changes their mind about a rejected concept:

- Delete the concept file.
- No need to reopen old issues — they're historical records.
- The new issue that triggered the reconsideration proceeds through normal triage.

---

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `engineering/triage` `OUT-OF-SCOPE.md` (KB relocated to `docs/out-of-scope/`).*
