# The discarded-frictions knowledge base

`docs/learn-discarded/` stores durable, git-tracked records of **field frictions that were deliberately NOT turned into skill edits**. It serves two purposes:

1. **Institutional memory** — why a real friction from a marked session was rejected as a skill change, so the reasoning survives the transcript being archived.
2. **Deduplication** — when the same friction resurfaces in a later `/dobby:learn` session, you surface the prior decision instead of re-litigating it from scratch.

The directory is created lazily on the first discard — don't commit an empty `docs/learn-discarded/`.

## Why a KB and not just "decide again each time"

A friction that felt compelling in one session can look compelling again in the next, because the transcript that produced it is gone and the intent that argued against the edit went with it. Without a record, `/dobby:learn` re-proposes the same rejected edit every few sessions — churn that the maintainer has to bat down repeatedly. The KB makes a *no* durable: the reasoning is written once, keyed by concept, and consulted at the start of every future session.

## Directory structure

```
docs/learn-discarded/
├── verbose-step-numbering.md
├── inline-repro-in-mark.md
└── auto-open-report.md
```

One file per **concept**, not per session. Every marked session that surfaces the same friction groups under one concept file.

## File format

Write it in a relaxed, readable style — closer to a short design note than a database row. Use paragraphs and examples so the reasoning is clear to someone meeting it for the first time.

```markdown
# Auto-open the review report

Rejected: making `/dobby:learn` open a rendered report of its proposal automatically.

## Why this was NOT turned into a skill edit

A field session found the text proposal "hard to skim" and suggested `learn`
render an HTML summary and `open` it, mirroring `/dobby:improve-architecture`.
This was rejected: `learn` runs in the dobby repo where the maintainer is
already reading the proposal inline before approving edits — an auto-opened
report adds a browser round-trip and a file to clean up for zero decision value.
The friction is real (long proposals are hard to skim) but the remedy belongs in
how the proposal is *structured* (grouped by skill, quote-first), not in a
separate rendered artifact.

## Prior occurrences

- 2026-05-02 session (repo acme/checkout) — "the learn proposal was a wall of text"
- 2026-06-11 session (repo acme/billing) — "can we get a visual summary?"
```

### Naming the file

A short, descriptive **kebab-case** concept name: `auto-open-report.md`, `verbose-step-numbering.md`. Someone browsing the directory should understand which friction was discarded without opening the file.

### Writing the reason

The reason must be **durable** — the property that makes the *no* survive a session it can no longer see. State it in terms that outlast the transcript:

- **Kit philosophy** — "the architect never works; this friction argued for the skill grepping directly."
- **Category mismatch** — "this is a consumer-project preference, not a kit-methodology change — a kit skill must never carry a client's domain specifics."
- **Already-solved-elsewhere** — "the remedy already lives in `/dobby:<skill>`; folding it here would duplicate."
- **Cost/benefit** — "the fix adds a step every session pays for to serve a friction that showed once."

Avoid temporary circumstances ("didn't have time to design it right") — those are deferrals, not discards, and belong in conversation, not here.

## Dedup by concept, not keyword

When `/dobby:learn` reads these records at the start of a session (Step 1), it matches an incoming friction against them by **concept similarity, not keyword overlap** — "wall of text proposal" matches `auto-open-report.md`. Present the match to the maintainer:

- **Still holds** — append the new occurrence to that file's "Prior occurrences" list; drop the friction from this session's proposal.
- **Reconsider** — the context has changed enough that the old *no* no longer applies; delete or update the record and let the friction proceed to a proposed edit.
- **Distinct** — related but genuinely a different friction; proceed normally (possibly a new concept file later).

## When to write here — and when NOT to

**Write only when a real, verified friction is deliberately rejected as a skill edit.** The friction must have cleared verify-the-claim (it genuinely happened in the marked transcript) — you record why the *remedy* was declined, not a friction you couldn't even confirm.

**Never write here for a friction that was actioned.** If the friction produced a skill edit, the edit IS the record — the git history and the skill's changed text carry it. A discard file for an actioned friction would falsely wave off the same signal next time.

**Never write here for a friction that failed verify-the-claim.** If the researcher couldn't reproduce the friction in the transcript, or cross-reference-with-code showed the skill's current text doesn't produce it, there's nothing to discard — the claim simply didn't hold. Recording it would poison dedup with a phantom.

| Outcome | Write to `docs/learn-discarded/`? |
|---|---|
| Verified friction, edit deliberately declined | **Yes** — one concept file |
| Friction actioned (produced a skill edit) | **No** — the edit is the record |
| Friction failed verify-the-claim / not reproduced | **No** — nothing to discard |

## The write flow (declined friction)

1. The maintainer decides a verified friction should NOT become a skill edit.
2. Check whether a matching concept file already exists (by concept, not keyword).
3. **Match** → append the new occurrence to its "Prior occurrences" list.
4. **No match** → create a new kebab-case concept file with the concept heading, the "Why this was NOT turned into a skill edit" reason, and the first occurrence.
5. Note it in the session's proposal summary so the maintainer sees the *no* was recorded, not silently dropped.

## Reconsidering later

If the maintainer changes their mind about a discarded friction:

- Delete the concept file.
- No old sessions to reopen — the KB entries are historical records.
- The friction that triggered the reconsideration proceeds to a proposed edit through normal `/dobby:learn` flow.

---

*The discarded-frictions KB mirrors `/dobby:triage`'s out-of-scope KB (`docs/out-of-scope/`, `../../triage/references/out-of-scope-kb.md`): one durable concept file per rejected item, deduped by concept, created lazily. Same shape, different domain — rejected skill-edits here, rejected enhancement requests there.*
