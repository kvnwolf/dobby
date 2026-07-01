# Glossary format

A **glossary** is the canonical language for a topic. When the topic has its own nomenclature, maintaining a tight glossary is itself part of learning — compressing a concept into a one-sentence definition is *evidence* the user understands it. All explainers, retrieval tasks, and learning records should adhere to its terminology.

This is the same discipline a project's `CONTEXT.md` domain glossary uses — it **dovetails** with it: pick ONE opinionated canonical term per concept, keep definitions tight, and list every rejected synonym under `_Avoid_`. If you're teaching a topic that maps onto a project's domain, reuse the project's `CONTEXT.md` terms rather than inventing parallel ones.

Write a glossary only when the topic has real nomenclature and the user is accumulating terms. In the light flow, a single canonical term stated inline is often enough — reach for a file when the vocabulary grows.

## Structure

```md
# {Topic} Glossary

{One or two sentences: what this topic covers.}

## Terms

**Progressive overload**:
Systematically increasing the demand on a muscle over time — via load, volume, or intensity.
_Avoid_: Pushing harder, levelling up

**RPE (Rate of Perceived Exertion)**:
A 1-10 self-rating of how hard a set felt, where 10 is failure and 8 means two reps left in the tank.
_Avoid_: Effort score, intensity rating
```

## Rules

- **Add a term only when the user understands it.** The glossary is a record of compressed understanding, not a dictionary the user reads to learn. Just introduced a concept? Wait until the user can use it correctly before promoting it.
- **Be opinionated — the `_Avoid_` discipline.** When several words exist for one concept, pick the best and list the rest under `_Avoid_`. This is how language compresses. An entry without an `_Avoid_` line is fine only when the concept genuinely has one name.
- **Keep definitions tight.** One or two sentences. Define what the term IS, not how to do it.
- **Use the glossary's own terms inside definitions.** Once a term is in, prefer it everywhere — including inside other definitions. This is what makes complex terms easier to grasp later.
- **Flag ambiguities explicitly.** If a term is used loosely in the wider field, note the resolution: "here, 'set' always means a working set — warm-ups are tracked separately."
- **Revise as understanding deepens.** A definition from week one may be wrong by week six. Update in place; don't leave stale entries.
