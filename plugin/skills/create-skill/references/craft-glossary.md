# Craft glossary

The domain model for what makes a skill great. A skill exists to wrangle determinism out of a stochastic system; the root virtue is **predictability**, and every term below is a lever on it. This is the load-bearing subset — the words that recur in reviews and disputes. Each entry ends with an `_Avoid_` list: near-synonyms that blur the term. Collapse an overloaded word to the one canonical name; the alias is a smell, not a synonym.

## Predictability

The degree to which a skill makes the agent behave the same _way_ on every run — the same process, not the same output (a brainstorming skill should _predictably_ diverge; its tokens vary, its behaviour doesn't). The root virtue every other term serves — cost and maintainability are symptoms of it, not rivals.

_Avoid_: consistency, reliability, robustness, output-determinism

## Context load

The cost a **model-invoked** skill imposes on the agent's context window — its `description`, always loaded, spending both tokens and attention. What user-invoked skills escape by having no description, and the brake on splitting into more model-invoked skills.

_Avoid_: token cost, context bloat

## Cognitive load

The cost a **user-invoked** skill imposes on the human — what they must hold in their head: which skills exist and when to reach for each (the human is the index). What model-invocation removes by being agent-discoverable, and the brake on splitting into more user-invoked skills. Not a cost to minimise: it is the price of human agency, the reason some skills stay user-invoked. Spend it where human judgement matters; remove it where it does not.

_Avoid_: human index, burden, overhead

## Completion criterion

The condition that tells the agent a unit of work is done — the target it judges against. Two properties make it a lever, not just a quality. Its **clarity** (can the agent tell done from not-done?) resists **premature completion** — a vague bound ("understanding reached") lets the agent declare done and slip to the next step. Its **demand** (how much it requires) sets how much legwork the agent does — "every modified model accounted for" forces thorough work where "produce a change list" does not — and this axis can bind a body of flat reference too ("every rule applied"). The strongest criteria are both _checkable_ and _exhaustive_.

_Avoid_: done condition, exit condition, stopping rule

## Leading word

A compact concept already living in the model's pretraining that the agent thinks with while running the skill (e.g. _lesson_, _fog of war_, _tracer bullets_, _red_). Repeated as a token — never as a sentence — it accumulates a distributed definition across the skill and anchors a whole region of behaviour in the fewest tokens, by recruiting priors the model already holds. It serves predictability twice: in the body it anchors execution, in the description it anchors invocation. Prefer an existing pretrained word over a coined one — a made-up word recruits no priors, so you pay in definition tokens what a pretrained word gives free.

_Avoid_: keyword, term, motif

## Duplication

_Failure mode._ The same meaning given more than one home. It costs maintenance (change one place, you must change the others), costs tokens, and inflates prominence — repeating a meaning weights it past its real rank. The accidental inverse of a **leading word**, which raises attention on purpose by repeating a _token_, never the meaning.

_Avoid_: repetition, redundancy

## Sediment

_Failure mode._ Layers of old content that settle in a skill and are never cleared, because adding feels safe and removing feels risky — so stale and irrelevant lines accumulate and you must core down through them to find what is still live. The default fate of any skill without a pruning discipline.

_Avoid_: accretion, bloat, cruft, rot

## Sprawl

_Failure mode._ A skill that is simply too long — too many lines — independent of whether they are stale or repeated. Even an all-live, all-unique skill can sprawl. It costs readability, maintainability, and tokens. The cure is the disclosure ladder: push reference behind context pointers, and split by branch or sequence so each path carries only what it needs. Distinct from **sediment** (length from stale accumulation) and **duplication** (length from repeated meaning) — sprawl is length itself, whatever its cause.

_Avoid_: bloat, length, size, verbosity

## No-op

_Failure mode._ An instruction that changes nothing because the model already does it by default — you pay load to tell the agent what it would do anyway. The test: does a line change behaviour versus the default? This is model-relative, not reader-relative: two people disagreeing over whether a line is a no-op disagree about the default, and settle it by running the skill, not by debate. The same priors that make a **leading word** free make a no-op worthless — a leading word too weak to beat the default is itself a no-op.

_Avoid_: redundant instruction, restating the obvious, belaboring

---

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `productivity/writing-great-skills` `GLOSSARY.md` (load-bearing subset; router-skill and external-reference intentionally not ported — dobby covers navigation via `/dobby:dispatch` and its stages).*
