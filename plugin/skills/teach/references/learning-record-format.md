# Learning record format

Learning records are the **evidence ledger** — they capture non-obvious lessons, key insights, and stated prior knowledge that steer future sessions. They are the teaching equivalent of an ADR: a durable note of what is now known and *why* it changes what to teach next. Use them to calculate the zone of proximal development — what to teach next sits just past the current floor.

Write one only when the user has *demonstrated* understanding, not when material was merely covered. In the light flow you'll often just remember this in conversation; write a record when the user wants learning to persist across sessions. When you do, number sequentially: `0001-slug.md`, `0002-slug.md`. Create the directory lazily — only when the first record is written.

## Template

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

That is the whole format. A record can be a single paragraph. The value is recording *that* this is now known and *why* it changes what to teach next — not filling out sections.

## Optional sections

Include only when they add genuine value — most records won't need them.

- **Status** (`active | superseded by 0007`) — when an earlier understanding is later replaced.
- **Evidence** — how the user demonstrated it (a question answered under retrieval, a task completed, prior experience cited). Useful when the claim might be revisited.
- **Implications** — what this unlocks or rules out next. Worth recording when non-obvious.

## When to write one

Write a record when any of these is true:

1. **The user demonstrated genuine understanding of something non-trivial** — not exposure, but evidence they can use the concept correctly (e.g. answered a recall quiz, completed a task). This sets a new floor.
2. **The user disclosed prior knowledge** — "I already know X." Record it, and the *depth* claimed, so future sessions don't re-teach it.
3. **A misconception was corrected** — the user believed something wrong and now sees why. High-value: these predict future stumbling blocks in related topics.
4. **The mission shifted in response to learning** — the user discovered they care about something different. Update the mission and cross-link.

## What does NOT qualify

- **Material that was merely covered.** Coverage is not learning — wait for evidence of retrieval.
- **Anything already captured as a glossary term.** Don't duplicate the glossary.
- **Session activity logs.** Learning records are decision-grade insights, not a journal.

## Supersession

When a later record contradicts an earlier one (understanding deepened or corrected), mark the old one `Status: superseded by 000N` rather than deleting it. The history of how understanding evolved is itself useful signal.
