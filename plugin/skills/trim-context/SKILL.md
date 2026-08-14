---
name: trim-context
description: Sweeps repository prose and comments for lower context cost without changing behavior.
disable-model-invocation: true
---

Run an **inference-only** sweep: derive candidates from the whole Git workroot, never accept a path-limited request or add runtime/config/tooling work. You are the architect: workers inspect, write, and review; you never edit, stage, or commit — except the single narrow ledger exception in Step 4. Read `references/sweep-contract.md` before the first dispatch — it is the shared contract for inventory, approval, review, and `.dobby/sweeps.json`, whose per-file `trim-context`/`anti-slop` sub-keys let this skill and `/dobby:anti-slop` share the ledger without either one owning or invalidating the other's coverage.

## Step 1: Inventory the workroot

First delegate execution of the read-only, deterministic mechanical extractor `scripts/comment-inventory.mjs` from any directory in the workroot. It walks each supported file's real syntax tree with a vendored, self-contained Tree-sitter parser (never a text/regex heuristic) and emits stable JSON for tracked files only, with comment byte ranges, kinds, totals, and `parsed`, `unsupported`, or `parse-error` coverage. It makes no candidate/retain judgment. A `parse-error` row is incomplete coverage: stop before ledger finality and report it. An `unsupported` row for a file type outside the extractor's parser surface (prose, data, lockfiles, and other non-code text the researcher reads in full) or a deliberate symlink/path-traversal exclusion is the extractor's normal, expected result and does not by itself block ledger finality. This inventory is not a repository check or Gate.

Before the first Agent dispatch, require BOTH local onboarding markers at the current workroot: `dobby.config.json` and `node_modules/.bin/dobby`. If either is absent, STOP, point to `/dobby:onboard`, and do not run `bunx dobby`; remote package resolution is forbidden. Only then run `bunx dobby env --json`, require the complete `workflowRecipe`, and validate its positive-integer `limits.maxConcurrency`. Missing/malformed data means STOP with zero Agents; never guess a cap from prose or frontmatter. Retain the limit for every later direct Agent call in this sweep — implementor batches (Step 3), reviewer batches (Step 4), and the final ledger writer/reviewer — each of which also counts against it.

Only after that mechanical record exists, dispatch a `dobby:researcher` to inventory every eligible human-text unit in the Git workroot and read the ledger's `trim-context` sub-key wherever it appears — never `anti-slop`'s sub-key or `metrics`, which belong to that other skill alone. Require the contract's path exclusions, cost tiers, candidate/retain reasons, exact byte counts, and ledger verdict. No ledger file, or none of this skill's sub-keys yet, starts the contract's full first sweep; a malformed shared container or a malformed `trim-context` sub-key stops before writes.

Turn the inventory into tiered approval batches. Each batch names every file/unit, what would be removed or condensed, what must remain, estimated byte/token savings, and the implementor-owned file set. Do not silently discard low-value candidates: mark them retain or defer with a reason.

## Step 2: Obtain human approval

Present the batches in cost-tier order and ask for explicit approval before any worker writes. Approval may accept, reject, or revise each batch; a material revision returns to this step. Rejected/deferred files remain out of the sweep manifest. On a first sweep, follow the contract's first-full-sweep rule before calling coverage complete.

## Step 3: Apply approved batches

Dispatch `dobby:implementor` workers only after approval. Give each worker one disjoint file set, the approved unit-level intent, the comment and `CONTEXT.md` rules, and these limits: change human text only, do not stage/commit, do not alter behavior, and do not write the ledger. Partition independent implementors into deterministic sequential batches of at most `workflowRecipe.limits.maxConcurrency`: launch one batch in parallel, await all its results, then launch the next. Retries and replacement Agents consume a slot.

Validate every writer's `{status, workLog, blocker}` envelope. A blocked or malformed result stops the sweep's ledger finality; account for any changed files, do not repair or revert in the architect thread, and follow the partial/error contract.

## Step 4: Review, finalize, and report

For every fully written batch, dispatch an independent `dobby:reviewer` that did not author any reviewed file. Partition independent reviewers into the same deterministic sequential batches of at most `workflowRecipe.limits.maxConcurrency`: launch one batch in parallel, await all its results, then launch the next; retries and replacement Agents consume a slot. It checks the final bytes against the approved intent, preservation rules, and behavior boundary. Route findings only to the implementor that owns the affected disjoint set, then re-review independently.

Only after every approved batch passes independent review, dispatch a separate `dobby:implementor` to write this skill's own `trim-context` sub-key inside `.dobby/sweeps.json`, prescribed by the contract; it never touches `anti-slop`'s sub-key or `metrics`, and never stages or commits. Review that write independently before treating the sweep as complete. If `.dobby/sweeps.json` is not yet tracked by Git — check with a Git query against the path (e.g. `git ls-files --error-unmatch -- .dobby/sweeps.json`), never by whether the file exists on disk, since an earlier run's unreviewed or interrupted write can leave it sitting there untracked — follow the contract's "Getting a new ledger tracked" step yourself once review passes: `.dobby/` is gitignored, so as coordinator you run `git add -f -- .dobby/sweeps.json` exactly once to bring it under tracking — the one narrow exception to never staging; skip this if the path is already tracked (e.g. `/dobby:anti-slop` or an earlier run got it tracked first). Never finalize it after a partial/error outcome.

Report the contract's savings summary: eligible and changed files, approved/rejected/deferred counts, before/after bytes and estimated tokens by tier and total, comments/`CONTEXT.md` changed, retained/deferred rationale, this skill's `trim-context` ledger rules version, and any incomplete coverage or blockers.

## Language

Interact with the user in their language. Inventory, approvals, worker briefs, ledger data, and repository text are in English; preserve established domain terms verbatim.

## Acceptance checklist

- [ ] `references/sweep-contract.md` governed the run; no CLI/config/check/helper module was added
- [ ] Both local markers (`dobby.config.json` + `node_modules/.bin/dobby`) existed before `bunx`; either missing STOPped at `/dobby:onboard` without remote resolution or Agent launch
- [ ] `bunx dobby env --json` resolved a complete `workflowRecipe` and valid `limits.maxConcurrency` before the first Agent; missing/malformed data launched zero Agents
- [ ] The read-only, deterministic `scripts/comment-inventory.mjs` recorded tracked-file comment coverage before any inferential researcher dispatch; a `parse-error` row on a supported extension kept ledger finality incomplete, while `unsupported` rows outside the parser surface did not
- [ ] Whole-Git-workroot eligible human text was inventoried and tiered; a missing ledger or a missing `trim-context` sub-key triggered a full first sweep, a malformed shared container or `trim-context` sub-key stopped before writes
- [ ] Every batch had explicit human approval before writes; all workers owned disjoint files and never staged or committed
- [ ] Every direct Agent fan-out (implementor batches, reviewer batches, the final ledger writer/reviewer) ran in sequential batches no larger than `workflowRecipe.limits.maxConcurrency`; retries/replacements consumed a slot
- [ ] Comments changed only by this sweep and `CONTEXT.md`/preservation rules held
- [ ] Every approved write passed review by an independent non-author before ledger finality
- [ ] Only this skill's `trim-context` sub-key (per file) was written, from reviewed final bytes with its own rules version; `anti-slop`'s sub-keys and `metrics` were left untouched, or the whole write remained unchanged after partial/error
- [ ] Savings and incomplete-coverage report accounted for every approved, rejected, retained, and deferred unit
