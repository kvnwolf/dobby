---
name: address-review
description: Address external code-review findings on the current PR — triage with a human gate, delegate fixes, resolve threads, re-trigger review, report merge-readiness. Use when a review bot (Greptile, CodeRabbit) or human reviewer left comments on a PR and you want the feedback addressed and the review green, or to rebut a stale finding.
argument-hint: "[PR number (optional)]"
allowed-tools: Bash(bunx dobby *), Bash(git diff *), Bash(git log *), Write
---

You are the coordinator/architect. You NEVER edit code — every fix goes to a worker — and you run NO `gh` by hand: the fetch, the resolve/reply batch, the re-trigger and the watch are all `bunx dobby` calls. Take the review findings on the current PR from "posted" to "addressed + threads resolved + re-reviewed", with a human triage gate. What stays yours is the judgment: is a finding valid, what is the fix brief, may this merge.

## Step 1: Intake

```bash
bunx dobby review fetch [--pr <number>] --json
```

One call answers `{pr, adapter, candidates, threads, summary}` — it drains the OPEN review threads (GraphQL, fully paginated), auto-detects the review tool by bot slug (the `[bot]` suffix stripped on both sides), and reads the summary from the ONE issue comment the bot EDITS in place (sorted by `updated_at`, never `created_at`). Read it:

- **`threads[]`** — each `{id, path, line, isOutdated, comments[{author, body, databaseId}]}`. `isOutdated: true` means a newer push already changed the annotated lines (GitHub collapses these). An empty array is a clean PR, not a failed read: a gh call that could not be made exits nonzero with gh's own words on stderr and NO payload.
- **`adapter`** — `{id, matchedLogins, reTrigger, intentionalReply, confidence}`, always present. `id: "human_or_unknown"` is generic/human mode: the whole loop still applies, only `reTrigger: null` means there's nothing to re-run.
- **`candidates`** — non-null when two bots reviewed the PR: ask which to run (or run each in turn).
- **`summary`** — `{author, body, confidence, updatedAt}`, or null when nothing has been posted yet.

Present what you found: the tool, the open threads, the summary's residual concerns, current confidence.

## Step 2: Triage — HUMAN GATE

Validity varies (real bug · nitpick · plain wrong) — **never auto-fix everything.** Per comment, classify validity and propose a disposition:

| Disposition | When |
|---|---|
| **fix** | Real defect or worthwhile change |
| **defer** | Valid but out of scope / YAGNI — keep the thread open (deferred), reply with rationale |
| **dismiss** | Wrong or a nitpick you won't take — resolve with a one-line why |
| **outdated** | `isOutdated=true` — the annotated lines already changed |

For an **outdated** thread, verify the newer code already covers the comment, then resolve WITHOUT re-fixing — don't mix it in with current findings.

Present the full triage as a table, then gate with AskUserQuestion: **Apply as proposed** / **Let me adjust**. The user's adjustments win.

## Step 3: Address — delegate, never edit inline

For every `fix`, delegate:

- **Small / scoped** (most review fixes) → spawn `dobby:implementor` (Agent tool, `subagent_type: "dobby:implementor"`). Batch several trivial fixes into ONE implementor call. Parallel implementors only on **non-overlapping** areas (same rule as `/dobby:execute` waves).
- **A fix that must be proven** → run the **build loop** (implement → review → verify) via the `dobby:execute` skill's `../execute/references/build-workflow.md` with a single-task array.
- **Feature-sized finding** (rare) → don't force it through here. Suggest, as plain text, that the user TYPE `/dobby:scope → … → /dobby:execute`; leave it for them to enter.

Implementors keep the tree green (build/type/lint); they do NOT commit.

## Step 4: ADR candidates

For each accepted or deferred **decision** (not every fix), evaluate the three criteria — hard to reverse · surprising without context · a real trade-off (mirrors `/dobby:wrap`). Offer to write the ADR; the user approves; you write it to `docs/adr/`, numbered sequentially. Typical from reviews: "defer the FK index (YAGNI at this scale)", "coerce a stale FK to null at the server seam instead of a cross-module refetch".

## Step 5: Close the loop

1. **Commit + push** the addressed fixes with `bunx dobby ship --message-file <f> --json` (message file written OUTSIDE the repo — ship stages the whole tree). It's an existing PR, so pass no `--pr-body-file`; keep the message review-scoped (e.g. `fix: address review feedback`). Push first, so a thread whose lines the fix changed can outdate before you resolve it. **Skip this sub-step entirely when the round produced no code change** — a triage where every disposition is `defer` / `dismiss` / `outdated` fixes nothing, so there is nothing to ship; say so and go to 5.2. On `committed: false`, split on `gateExitCode`: **≠ 0** is a RED GATE — report its findings verbatim and STOP the round, an unproven fix must not be resolved as done; **`0`** means the gate passed and `git commit` failed on its own terms (nothing to commit, or a local commit hook refused) — report git's words, and treat a nothing-to-commit as the fix-less path above rather than an abort.
2. **Author the disposition plan** — the judgment from step 2, as JSON written to a temp file OUTSIDE the repo:

   ```json
   {
     "pr": 42,
     "reTrigger": true,
     "plan": [
       { "threadId": "PRRT_kwDO…", "disposition": "fix" },
       { "threadId": "PRRT_kwDO…", "disposition": "defer", "reply": "@greptileai deferred — <reason>" },
       { "threadId": "PRRT_kwDO…", "disposition": "dismiss", "reply": "@greptileai <reason>" }
     ]
   }
   ```

   Write a `reply` on every `defer` (that IS how a deferred finding is closed out) and on any `dismiss` whose why is worth stating; mention the bot with the `adapter.intentionalReply` shape so it learns not to re-flag. Set `reTrigger: true` unless the adapter has none.
3. **Apply it** — `bunx dobby review apply --plan <f> --json` (add `--dry-run` first to see the decisions with zero side effects). ONE batched mutation resolves the `fix` / `dismiss` / `outdated` threads; `defer` is excluded BY CONSTRUCTION (a deferred finding stays open — that is what deferring means); replies already posted are skipped, so re-running the same plan is a no-op; a failed reply blocks its own thread's resolve rather than burying the finding. Read `{resolved, replied, skipped, retriggered, failures}` — a non-empty `failures` exits 1 with the payload still on stdout: address those threads, don't declare the round done.
4. **Re-fetch and reconcile** — `bunx dobby review fetch --json` again. **The summary lags the threads**: it can still list an addressed concern as open after a valid fix + a resolved thread. Decide per residual concern — accept it, **rebut** it (a second plan carrying only the clarifying replies plus `reTrigger: true`, which moves the summary), or do more work.

## Step 6: Gate check

```bash
bunx dobby pr watch --await-review --deadline 300 --json
```

Report merge-readiness from its `verdict`: `merge-ready` → say so plainly and stop (**never merge — that is the user's call**); `feedback-present` → a new round, loop back to step 2; `ci-failed` → route `failing[]` to a worker before anything else; `open-unreviewed` / `ci-pending` → the wait expired, say what is still outstanding. Confidence is not in this payload: `pr watch` answers `{awaitedReview, checks, deadlineSec, failing, openThreads, pr, reason, summary, verdict}` and carries no `adapter`. Take `adapter.confidence` from the `review fetch` payload you already read (step 1, or the re-fetch in 5.4) — and when it is `dashboard-only` (Greptile keeps the 0–5 threshold off the check payload — see `references/adapters.md`), state the confidence from that fetch's `summary` and let the user confirm the bar.

## Next step

Present an **AskUserQuestion** restating where the review pass landed, with the applicable next-step routes as options (recommended first, plus **Stop here**). On selection, invoke the chosen `/dobby:<skill>` via the Skill tool; **Stop here** ends the turn.

- **More fixes needed** → loop back to Step 2, re-triaging ONLY the NEW residual concerns from the bot's UPDATED summary — not every open thread. Deferred threads stay unresolved on purpose; don't re-present a decision the user already made.
- **Gate met** → ready to merge. Stop here.
- **Part of a larger session** → **`/dobby:wrap`** to reconcile docs and write any ADRs.

## Language

Interact with the user in their language. Code, comments, commit messages, ADRs, and thread replies in English; keep domain terms in their real-world form.

## Reaching under the CLI

`dobby review` owns every gh call this skill makes. When a payload field needs to be understood at the wire level, or you must extend the mechanics by hand (a query the CLI doesn't expose, a one-off REST read), the raw GraphQL/REST shapes behind it are in `references/github-api.md`; the tool registry the auto-detection is built from is in `references/adapters.md`, which also carries the Greptile config-as-code checklist for a project that asks for review-tool setup.

## Acceptance checklist

- [ ] PR identified and the review state read in ONE `bunx dobby review fetch --json` — no hand-written `gh` call anywhere in the run
- [ ] Tool taken from the payload's `adapter` (`candidates` resolved with the user when two bots matched); summary + confidence read from the same payload
- [ ] Every comment triaged (fix / defer / dismiss / outdated) and confirmed at the human gate — nothing auto-fixed
- [ ] Fixes delegated to `dobby:implementor` (or build loop / scope→execute); architect edited no code
- [ ] Decision-grade findings evaluated for ADRs; offered and written on approval
- [ ] Fixes committed + pushed via `bunx dobby ship --message-file <f> --json` (skipped when the round changed no code); only a RED gate (`gateExitCode` ≠ 0) stopped the round — a `committed: false` with `gateExitCode: 0` was read as git's own outcome, never as unproven fixes
- [ ] Disposition plan authored as JSON (dispositions + rationale replies with the adapter's mention shape, `reTrigger` set) and executed with `bunx dobby review apply --plan <f> --json`; `failures` addressed, not ignored
- [ ] Re-fetched and reconciled: thread state AND the lagging summary; residual concerns accepted, rebutted with a second plan, or reworked
- [ ] Merge-readiness reported from `bunx dobby pr watch`'s verdict (plus, where the adapter is dashboard-only, the confidence read from `review fetch` — `pr watch` carries no `adapter`); the skill never merged; next step handed off via an AskUserQuestion gate
