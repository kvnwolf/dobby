# ADR Format

ADRs live in `docs/adr/` with sequential numbering: `0001-slug.md`, `0002-slug.md`. Create the directory lazily — only when the first ADR is needed.

## When to offer an ADR

All three must be true:

1. **Hard to reverse** — changing your mind later costs something real.
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and one was chosen for specific reasons.

If it's easy to reverse, skip it. If it's not surprising, nobody will wonder. If there was no real alternative, there's nothing to record.

## What qualifies

Architectural shape; integration patterns between contexts; technology choices that carry lock-in; boundary and scope decisions (the explicit no's are as valuable as the yes's); deliberate deviations from the obvious path; constraints not visible in the code; rejected alternatives whose rejection is non-obvious.

## Template

```md
# {Short title of the decision}

{1-3 sentences: the context, what was decided, and why.}
```

That's it — an ADR can be a single paragraph. The value is recording THAT a decision was made and WHY, not filling out sections.

## Optional sections

Only when they add genuine value: `Status` frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`); Considered Options (when the rejected alternatives are worth remembering); Consequences (when non-obvious downstream effects need calling out).

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.
