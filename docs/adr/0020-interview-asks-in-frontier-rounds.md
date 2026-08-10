# 0020. Interview asks in frontier rounds

**Status:** accepted

`/dobby:interview` deliberately asked one question per turn (self-contained questions, one topic each — the user context-switches across projects), which was thorough but slow when open questions were mutually independent (issue #28). We adopted the frontier-round mechanism from mattpocock/skills `productivity/grilling` as the SINGLE mode of the interview: the interview models a design tree, each turn asks the whole frontier (every open decision whose prerequisites are settled), and dependent questions wait for a later round — so a dependent chain degrades to rounds of size 1 and the old sequential behavior survives as the degenerate case, not a second mode. The one-question-per-turn rule was not a mistake being fixed; batching is safe only because every question stays self-contained, and rounds stay homogeneous by vehicle (an AskUserQuestion batch of ≤4 first, open-ended ❓/➡️ text rounds after) because the popup renders over same-turn text and would hide anything load-bearing outside its own fields.

## Considered Options

- **Opportunistic batching** (keep one-per-turn as the default, batch only when independence is obvious) — rejected: two modes to maintain in the skill text, and the frontier definition already encodes "batch only mutually-independent questions".
- **Upstream fidelity** (unlimited plain-text rounds, no AskUserQuestion) — rejected: the options+Other UI is better UX exactly on the heaviest rounds; a frontier wider than 4 splits into consecutive popup rounds instead.

## Consequences

Frontier rounds govern only the interviewing step: stage handoffs and the interview's closing gate remain single-question gates, and the closing machinery (litmus test, infra-assumption gate, term offer, persistence) is unchanged. Mid-interview fact-finding is now non-blocking — a researcher dispatch is an unsettled prerequisite and only downstream questions wait. `frontier`, `round`, and `design tree` entered the root glossary; the skill carries the `productivity/grilling` attribution (the upstream skill was renamed from `batch-grill-me`; the issue's `grill-me-batch` never existed).
