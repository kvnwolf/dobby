---
name: anti-slop
description: Contextually sweeps repository prose and user-facing copy for generic AI-writing patterns without judging authorship.
disable-model-invocation: true
---

Run an **inference-only** whole-workroot sweep. Find contextual writing patterns, never an author, score, or banned occurrence. You are the architect: workers inspect, write, and review; you never edit, stage, or commit — except the single narrow ledger exception in Step 5. Read `../trim-context/references/sweep-contract.md` before the first dispatch. It supplies the shared whole-workroot, approval, disjoint ownership, independent-review, final-byte, and partial-outcome process; this skill owns the overrides below.

## Step 1: Set the boundary

If `/dobby:trim-context` is also requested, run it first and begin this sweep only after its outcome is known. `/dobby:anti-slop` never inventories, proposes, or edits comments; `/dobby:trim-context` remains their sole owner.

Inventory every tracked eligible unit in the Git workroot, not a requested subtree or diff:

- prose documents, instructions, READMEs, ADRs, and `CONTEXT.md` files;
- user-facing app copy, including UI text, empty states, errors, onboarding, and notifications.

Exclude executable code, identifiers, non-user-facing strings, data, generated/vendor files, licenses, lockfiles, the sweep ledger, and all comments. Treat each eligible unit as a candidate, retain, or defer decision. Preserve claims, facts, domain terms, safety language, legal text, accessibility meaning, voice, and product intent.

## Step 2: Judge patterns in context

Dispatch `dobby:researcher` workers to inventory disjoint eligible file sets and read the ledger's `anti-slop` sub-key wherever it appears — never `trim-context`'s sub-key, which belongs to that other skill alone. Size the fan-out yourself: partition independent researchers into deterministic sequential batches you judge safe to run together, launch one batch in parallel, await all its results, then launch the next; retries and replacement Agents consume a slot. Give each worker `references/pattern-taxonomy.md` and require multilingual, contextual judgment:

- A pattern is evidence only when it weakens this unit's clarity, specificity, voice, or purpose. A word, construction, punctuation mark, or repeated shape is never a violation by itself.
- Judge in the text's own language and locale. Translate neither the prose nor the taxonomy mechanically; identify the equivalent rhetorical effect, preserve established terminology, and retain a form that is natural, intentional, or needed for the audience.
- Do not infer whether AI or a person wrote the text. Do not rank authors, assign a slop score, or set occurrence quotas.

Every candidate finding contains the taxonomy pattern, an exact citation (`path:line-range` plus the smallest useful excerpt), why it is weak in this context, and the minimum fix. A retain names the contextual reason the apparent pattern earns its place. A defer names what evidence or decision is missing.

## Step 3: Keep an independent ledger

Use the shared tracked ledger at `.dobby/sweeps.json`, per the contract's per-file, per-skill schema: own only the `anti-slop` sub-key inside each file's entry, plus this skill's own `metrics` sub-key; never read, alter, or certify `trim-context`'s sub-key or treat its presence as corruption. This skill's slice of the shared shape is:

```json
{
  "files": {
    "relative/path.md": {
      "anti-slop": { "contentHash": "sha256:<exact-final-byte-hash>", "rulesVersion": "contextual-slop-v1" }
    }
  },
  "metrics": {
    "anti-slop": {
      "byPatternCategory": {
        "category-name": { "findings": 0, "changed": 0, "retained": 0 }
      }
    }
  }
}
```

Each `files["<path>"].anti-slop.contentHash` is this skill's own exact final-byte SHA-256 hash; it does not reuse or overwrite `trim-context`'s sibling sub-key for the same path. `metrics.anti-slop` records resolved findings by taxonomy category, not a quality score or occurrence ban. Keep `files` keys and sub-keys, and `metrics` sub-keys, lexically sorted.

Apply the shared contract's first-full-sweep and incremental rules to the `anti-slop` sub-key alone: no ledger file, or no `anti-slop` sub-key anywhere yet, requires a whole-workroot first full sweep; a matching `rulesVersion` with a matching hash is already covered; an absent or changed `anti-slop` sub-key or hash needs a new decision; a malformed `anti-slop` sub-key fails closed before writes for this skill only — a malformed `trim-context` sub-key is not this skill's problem and does not block it. A valid `trim-context` sub-key for a path is neither coverage nor an error for this skill's own decision on that path. `.dobby/` is gitignored; see Step 5 for the coordinator's one-time tracking step when the file is brand new.

## Step 4: Obtain approval and apply minimum fixes

Turn the inventory into tiered, disjoint approval batches using the shared contract's tiers. Each proposed change includes its findings with citation and minimum fix, the exact file set, preservation rules, before bytes, projected byte/token savings, and category metrics. Approval follows the shared contract's policy-approval model: one explicit approval of scope and aggressiveness before any write, not per batch. Rejected candidates become explicit retains. Deferred units prevent completed coverage.

After approval, dispatch `dobby:implementor` workers over disjoint file sets. Size the fan-out yourself: partition independent implementors into deterministic sequential batches you judge safe to run together, launch one batch in parallel, await all its results, then launch the next; retries and replacement Agents consume a slot. Their brief permits only the approved human-text changes and requires the smallest edit that resolves the cited contextual weakness. They must not alter comments, behavior, code, the ledger, unstated copy, or another worker's files; they must not stage or commit.

Validate each writer's `{status, workLog, blocker}` envelope. A blocked or malformed result follows the shared partial-outcome rule: stop later writes, preserve prior ledger finality, and report every affected unit without repairing or reverting in the architect thread.

## Step 5: Review, finalize, and report

Dispatch an independent `dobby:reviewer` for every complete batch. Partition independent reviewers into deterministic sequential batches you judge safe to run together: launch one batch in parallel, await all its results, then launch the next; retries and replacement Agents consume a slot. The reviewer checks final bytes against the approval, citation, minimum-fix boundary, multilingual/voice preservation, comment exclusion, and behavior boundary. Return findings only to the owning implementor, then obtain another independent review.

After all approved batches pass, dispatch a separate `dobby:implementor` to stage this skill's ledger increment: it builds the full proposed ledger — current canonical `.dobby/sweeps.json` content plus this skill's resolved `anti-slop` sub-key per file and its own `metrics.anti-slop`, from reviewed final bytes and resolved category metrics — and writes it to `.dobby/sweeps.json.pending`, never to the canonical file; every `trim-context` sub-key passes through byte-for-byte untouched. An independent reviewer validates that staging file alone — this skill's rules version, sorted keys, exact hashes, metrics, and that no `trim-context` sub-key changed — never the canonical file. Only once that review passes does the coordinator — never a worker — promote the staging file onto `.dobby/sweeps.json` with a mechanical move; this is the same narrow coordinator-owned exception the shared contract carries, not authorship. If `.dobby/sweeps.json` is not yet tracked by Git — check with a Git query against the path (e.g. `git ls-files --error-unmatch -- .dobby/sweeps.json`), never by whether the file exists on disk, since an earlier run's unreviewed or interrupted write can leave it sitting there untracked — the coordinator runs the contract's one-time `git add -f -- .dobby/sweeps.json` once, immediately after that FIRST promotion; skip this if the path is already tracked. A failed or interrupted write or review promotes nothing: the canonical ledger stays untouched, and at most a stale `.dobby/sweeps.json.pending` remains — never committed, since `.dobby/` is gitignored and only `.dobby/sweeps.json` itself is ever force-added — which the next attempt overwrites.

Report eligible and changed files/units; approved, rejected, retained, and deferred counts; before/final bytes and estimated tokens by tier and total; resolved findings by pattern category; comment files changed (`0`); this skill's `anti-slop` ledger state and rules version; and incomplete coverage or blockers. Interact with the user in their language; keep inventory, approvals, worker briefs, ledger data, and repository text in English unless the repository establishes another language.

## Acceptance checklist

- [ ] `../trim-context/references/sweep-contract.md` governed shared sweep mechanics without duplicated contract text or new CLI, check, detector, config, or helper code
- [ ] The whole Git workroot was inventoried; comments were excluded, and `/dobby:trim-context` ran first when both sweeps were requested
- [ ] Every finding has a pattern, exact citation, contextual reason, and minimum fix; no authorship judgment, score, quota, or occurrence ban was used
- [ ] Multilingual and locale-specific judgment preserved voice, domain terms, and product intent
- [ ] Every write had explicit approval, disjoint ownership, independent review, and no behavior or comment change
- [ ] Every direct Agent fan-out (researcher batches, implementor batches, reviewer batches, the final ledger writer/reviewer) ran in sequential batches sized by your own judgment; retries/replacements consumed a slot
- [ ] Only this skill's `anti-slop` sub-key (per file) and its own `metrics.anti-slop` used `contextual-slop-v1`, its own final-byte hashes, and category metrics; `trim-context`'s sub-keys were left untouched and never treated as this skill's coverage or corruption
- [ ] The ledger writer staged this skill's resolved sub-keys and `metrics.anti-slop` to `.dobby/sweeps.json.pending` only, never the canonical file; the independent reviewer validated that staging file alone; the coordinator — never a worker — promoted it onto `.dobby/sweeps.json` only after that review passed, then ran the one-time `git add -f` (only when untracked) immediately after that first promotion
- [ ] A partial, deferred, malformed, or blocked run promoted nothing onto the canonical ledger, left this skill's sub-keys unfinalized as at most a stale, uncommitted `.dobby/sweeps.json.pending`, and reported incomplete coverage, without disturbing `trim-context`'s entries
