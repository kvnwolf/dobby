# The adapter seam

The ONLY tool-specific surface. A small registry keyed by bot author; everything else is generic GitHub (`github-api.md`). Adding a review tool = one entry here, nothing else.

## Registry

```yaml
greptile:
  botLogins: ["greptile-apps[bot]", "greptile-apps-staging[bot]"]
  reTrigger: "@greptileai review"
  intentionalReply: "@greptileai <reason>"   # trains it not to re-flag
  confidence: dashboard-only                 # numeric 0–5 threshold not in the check payload
  checkNameContains: greptile                 # current-commit status check must be present + pass
  freshness: footer-and-check                 # footer SHA must equal HEAD too

coderabbit:
  botLogins: ["coderabbitai[bot]"]
  reTrigger: "@coderabbitai review"
  intentionalReply: "@coderabbitai <reason>"
  confidence: none
  checkNameContains: coderabbit               # current-commit status check is freshness evidence
  freshness: check

human_or_unknown:
  botLogins: []           # any non-registry author, or a human reviewer
  reTrigger: null         # no auto re-trigger; resolve + push, optionally @-mention a reviewer
  intentionalReply: "@<reviewer> <reason>"
  confidence: none
```

## Auto-detect

Intersect the OPEN-thread authors (from the `reviewThreads` fetch) with `botLogins` across the registry. **Normalize before comparing: strip any trailing `[bot]` on BOTH sides.** The `reviewThreads` GraphQL query returns the author login WITHOUT the suffix (`greptile-apps`) while REST comment authors include it (`greptile-apps[bot]`) — so match by bare slug or detection wrongly falls through to `human_or_unknown`.

- **exactly one** adapter matches → use it.
- **several** match (two bots reviewed the PR) → ask which to run, or run all sequentially.
- **none** match → `human_or_unknown`: the full fetch → triage → address → resolve → push loop still applies; you just skip the re-trigger (there's no bot to re-run) and optionally `@`-mention the human reviewer on replies.

The loop is identical for human reviewers — only the re-trigger differs. When several adapters match, the initial fetch reports `candidates`; re-run `review fetch --adapter <id>`, then carry that exact flag through `review apply` and `pr watch`. Those commands filter threads/summary to the selected adapter, and the write/watch paths refuse ambiguity when the flag is omitted. Run each adapter in turn when several are required gates, retain every final `merge-ready` payload, and require all of their `pr.headRefOid` values to be identical. A mismatch means HEAD moved between adapters: discard the set and restart every required gate. Only that common SHA may reach finish's `--match-head-commit` merge.

## Greptile freshness contract

Greptile edits one summary comment across review cycles, so the comment's existence and `updated_at` timestamp do **not** prove that it reviewed the latest push. Its footer carries `Last reviewed commit` as a link to `/commit/<full-sha>`. `dobby pr watch --await-review` requires a terminal passing check whose name contains `greptile` (case-insensitive), extracts the footer SHA as `summary.reviewedHeadOid`, and compares it exactly with `pr.headRefOid`:

- Greptile check present + passing + matching SHA + no open threads + all checks green → `merge-ready`, with `reviewFresh: true`;
- missing or non-passing Greptile check → keep waiting with the ordinary checks loop when pending; otherwise `open-unreviewed`, with the observed check names/states in `reason`;
- older SHA → keep waiting; on deadline, `open-unreviewed`, with `reviewFresh: false` and a `reason` naming both SHAs;
- missing or unparseable footer → keep waiting; on deadline, `open-unreviewed`, with `reviewFresh: false` and a diagnostic `reason`;
- open threads always win → `feedback-present`, even when the summary is current.

This is deliberately fail-closed. A confidence score, an old clean summary, resolved old threads, or bot silence is never evidence that the current HEAD was reviewed. The watch re-reads the PR after checks and after each review snapshot; a changed `headRefOid` discards both snapshots and restarts from CI, so evidence from two commits is never combined.

## CodeRabbit freshness contract

CodeRabbit does not expose Greptile's footer SHA through this adapter. Its current-commit status check is therefore the commit-scoped evidence: a terminal passing check whose name contains `coderabbit` (case-insensitive), plus a posted CodeRabbit summary and no selected-adapter threads, may become `merge-ready`. A historical summary with no matching current-commit check is `open-unreviewed`, never success. This matters when incremental reviews are paused or skipped: the old walkthrough can remain visible after a push. Re-trigger with `@coderabbitai review`, then wait for the current commit's check.

Summary authors are matched by exact bare login after stripping a trailing `[bot]`; substring lookalikes never supply review evidence.

## Greptile setup (config-as-code)

When a project relies on Greptile as its PR-boundary code reviewer, the following is part of the review contract rather than optional polish:

This setup is non-negotiable when Greptile replaces the normal per-task model reviewer: verification inside the build loop proves behavior, while Greptile supplies the independent code-review boundary after push.

```json
{
  "triggerOnUpdates": true,
  "statusCheck": true,
  "statusCommentsEnabled": true,
  "shouldUpdateDescription": false,
  "hideFooter": false
}
```

- `triggerOnUpdates: true` makes every pushed commit start a fresh review. Without it, explicitly re-trigger with `@greptileai review`; until the footer advances to the current HEAD, Dobby reports `open-unreviewed`.
- `statusCheck: true` creates a commit-scoped Greptile check. Add that exact Greptile check to GitHub branch protection as a **required** status check; a non-required decorative check is not a merge boundary.
- `statusCommentsEnabled: true` and `shouldUpdateDescription: false` keep the main summary in the issue-comment surface read by `dobby review` / `dobby pr watch`.
- `hideFooter: false` preserves `Last reviewed commit`, the freshness evidence Dobby compares with HEAD. Hiding or changing that footer fails closed as `open-unreviewed`.

These controls are complementary: the required status check proves the current commit's review job completed, while the visible footer lets Dobby prove the summary belongs to the same commit. Require both. Never treat the absence of findings, a missing summary, or a quiet bot as approval.

Config-as-code (`greptile.json` or `.greptile/config.json`, read from the PR's SOURCE branch, OVERRIDES the dashboard) controls review BEHAVIOR: `strictness`, `commentTypes`, `fileChangeLimit`, `triggerOnUpdates`/`triggerOnDrafts`/`skipReview`, PR filters (`labels`/`disabledLabels`/`include`/`excludeAuthors`/`excludeBranches`/`excludeKeywords`), `ignorePatterns`, output (`shouldUpdateDescription`/`updateSummaryOnly`/`fixWithAI`/`hideFooter`), summary section objects, `statusCheck`/`statusCommentsEnabled`, `instructions`, structured `rules`, plus `files.json`, `rules.md`, `context.repos`.

**Dashboard-only (NOT config-as-code, verified):** the status-check confidence THRESHOLD (0–5), the comment header text, auto-approve, and the "Fix with your Agent" buttons. These stay a manual per-project checklist — a `/dobby:onboard`-style step could surface them.
