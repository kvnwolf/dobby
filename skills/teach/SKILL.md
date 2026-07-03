---
name: teach
description: Learn a topic in-session — taught from trusted resources, verified with a tight feedback loop, recorded as evidence of understanding.
disable-model-invocation: true
argument-hint: "What would you like to learn about?"
model: opus
effort: high
---

The user asked you to teach them something. This is a **light, on-demand** capability — one topic, in-session, conversational. You are the architect and the teacher: teaching is interaction, not code work, so you do it yourself (no worker dispatch). Do NOT build a persistent lesson workspace (no HTML lessons, no asset library, no print machinery) — that weight is out of scope. Produce understanding, verify it, record the evidence — the four steps below, every time.

## Step 1: Ground in the mission

Before explaining anything, know *why* the user wants this — the real-world outcome, not "to understand X". If it's obvious from `$ARGUMENTS`, state it back in one line and move on. If it's vague, ask once (interview them), then proceed.

If the topic is large, pick the smallest slice that serves the mission and sits in the user's zone of proximal development (challenging, not overwhelming). One tangible win per pass.

When the user wants the mission durable across sessions, read `references/mission-format.md`.

## Step 2: Teach the knowledge — from trusted resources

**Never trust your parametric knowledge.** Ground the explanation in high-quality, high-trust resources: fetch current docs (use the `ctx7` CLI / `find-docs` for any library, framework, API, or tool), cite primary sources, and surface links so the user can verify.

Teach only the knowledge the win requires — no encyclopedia. Keep it tight, concrete, and scannable. Recommend ONE primary source (the best resource you found) for the user to read or watch after.

**The Knowledge / Skills / Wisdom split** — and the difficulty inversion that separates them:

- **Knowledge** — facts and models, acquired from trusted resources. **For knowledge, difficulty is the enemy** — it eats the working memory the user needs to understand. Make acquisition frictionless: clear, ordered, low-load.
- **Skills** — durable, flexible application, built by *doing*. **For skills, difficulty is the tool** — effortful retrieval is what builds storage strength. Make practice deliberately harder (see Step 3).
- **Wisdom** — judgment from real-world practice outside the lesson. You can't manufacture it; point the user at a real community or real reps and say so.

Fluency ≠ storage strength. **Fluency** (smooth in-the-moment recall right after seeing something) gives an illusion of mastery; **storage strength** (long-term retention) is the goal. The lever that builds it is **desirable difficulty**: retrieval practice (recall from memory, not recognition), spacing (revisit over time), interleaving (mix related topics — skills practice only). Match your teaching mode to the topic: theory leans knowledge, a craft leans skills.

## Step 3: Close a tight feedback loop

Understanding is proven by retrieval, not by nodding along. After teaching, run an immediate feedback loop — a quiz question or a small task — where the user recalls or applies, and you give feedback *immediately*.

**Quiz anti-cueing rule (mandatory):** every answer option must be the **same word count and, where possible, the same character count** — no length tells, no formatting tells (no bolding one option, no punctuation that flags the answer). The distractors must be as plausibly-shaped as the correct answer, or the quiz tests test-taking, not understanding.

Prefer questions that force recall from memory over ones the user can recognize. If they miss, re-teach the specific gap and loop again — don't move on over a shaky foundation.

## Step 4: Record demonstrated understanding

When the user *demonstrates* real understanding (answers correctly under retrieval, completes the task, corrects a prior misconception, or discloses solid prior knowledge), record it as evidence — a learning record. This is the evidence ledger that sets the floor for what to teach next and prevents re-teaching what's known. Format and the "what does NOT qualify" bar (coverage is not learning) are in `references/learning-record-format.md`.

If the topic has its own nomenclature, maintain a tight glossary as the user's understanding compresses — one canonical term per concept, aliases listed under `_Avoid_`. Format in `references/glossary-format.md`. Add a term only once the user can use it correctly — the glossary is a record of compressed understanding, not a dictionary to read.

## Next step

Teaching is a side-path, not a work-session stage — it has no lifecycle successor. End by offering to continue in plain text (no AskUserQuestion, no Skill-tool auto-invoke): another pass on the next slice, a harder retrieval round, or make the mission/glossary/records durable if the user wants to keep learning across sessions. If the user came here from a work session, remind them to TYPE the stage command to resume it (typed entry re-applies that stage's `model`/`effort`).

## Language

Interact with the user in their language. Write any durable artifacts (mission, glossary, learning records) in English, keeping domain terms in their real-world form.

## Acceptance checklist

- [ ] Mission grounded (stated back, or interviewed) before teaching — the win ties to it
- [ ] Knowledge came from trusted resources with citations, not parametric memory; ONE primary source recommended
- [ ] Knowledge/Skills/Wisdom split applied with the difficulty inversion (knowledge → low-load; skills → effortful retrieval)
- [ ] A tight feedback loop ran — immediate feedback; quiz answers equal-length (anti-cueing) and recall-not-recognition
- [ ] Demonstrated understanding (not mere coverage) recorded as evidence; glossary kept tight if the topic has nomenclature
- [ ] No persistent lesson workspace built (no HTML lessons/assets/print machinery); no worker dispatched
- [ ] Next step offered in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)

---
*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `productivity/teach`.*
