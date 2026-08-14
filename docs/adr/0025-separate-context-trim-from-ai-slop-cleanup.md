# 0025. Separate context trim from AI-slop cleanup

Repository text carries two unrelated costs — it can be expensive to load into a model's context, and it can read as generic AI voice — and a single sweep would have to weigh both against one another on every unit. We ship them as two inference-only skills instead: `/dobby:trim-context` asks whether text earns its context load and owns every code comment, while `/dobby:anti-slop` asks whether rhetoric or formatting fabricates significance and never touches comments. A combined skill lost because the two criteria disagree constantly — a deliberate em dash is load-bearing voice to one and noise to the other — and because only trim-context can honestly report token savings, so merging them would force one metric to lie.

## Consequences

Each skill certifies its own coverage independently, so a file may be swept by one and stale for the other; the recommended order is trim first, then anti-slop. Running trim first can leave anti-slop nothing to judge, because prose that is pure filler is also prose that fails the context-load test — observed in a smoke test where trim reduced two documents to their headings and the following anti-slop run found zero candidates. That is the intended outcome, not a defect: the text is gone either way.
