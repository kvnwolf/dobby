# 0024. Put holistic code review at the external PR boundary

**Status:** accepted

The normal execute loop sent every task through an internal `dobby:reviewer` before verification. Repeating that static review task by task consumed an expensive model, produced fix/re-review bounce, and still lacked the complete cross-task diff that the repository's PR reviewer sees. Repositories in the current fleet already use a strong external reviewer—Greptile in the motivating case—after push.

Normal execute is therefore:

```text
optional test-author → implementor → mechanical-first verifier
                                      ↓ failure, only if another attempt remains
                                 implementor fix → verifier
```

`maxOuter=2` bounds implementation/verification attempts, `maxConcurrency=2` bounds fan-out, and `maxReview` is removed. A fix is legal only while another verifier attempt remains; the last failed verification returns `needs-human` without changing code again. The verifier proves the task's specified behavior and runs the mechanical suite. It does not silently become a style reviewer.

The `dobby:reviewer` agent remains registered and pinned for two explicit exceptional paths: a user-requested review through dispatch, and the safety review used when a write-capable worker returns no usable work log after it may have mutated the shared tree. That safety review never turns the task into success; it audits the uncertain diff and returns `needs-human`.

Holistic static-quality review moves to the PR boundary. `/dobby:commit` pushes the complete change and waits through `dobby pr watch`; `/dobby:finish` may call a PR merge-ready only when the configured external reviewer has reviewed the current HEAD. The watch binds checks, threads, and summary to one immutable `headRefOid`: it re-reads the PR after checks and after every review snapshot, discards both phases on drift, and restarts from CI. `/dobby:finish` then passes that validated SHA to `gh pr merge --match-head-commit`, closing the final watch-to-merge race.

For Greptile, both its passing current-commit status check and a summary footer SHA matching HEAD are required; either missing, a summary for an older commit, or no review is `open-unreviewed`, never success. Consumer repositories that use Greptile for this boundary must keep its current-HEAD evidence visible and automatic: `triggerOnUpdates: true`, `statusCheck: true`, `statusCommentsEnabled: true`, `shouldUpdateDescription: false`, and `hideFooter: false`; GitHub branch protection must require the Greptile check. CodeRabbit has no footer SHA in this adapter, so its named current-commit passing check is mandatory; an old walkthrough without that evidence fails closed. When multiple bots match, the operator chooses mechanically with `--adapter <id>` and carries that selection through fetch/apply/watch; ambiguous writes and watches refuse to run. If several adapters are required gates, every final `merge-ready` payload must identify one common `pr.headRefOid`; any mismatch invalidates and restarts the entire set, and only that shared SHA may be passed to `--match-head-commit`. A fix from `/dobby:address-review` must receive a fresh external review of the resulting HEAD before merge.

## Considered options

- **Keep internal task review and external PR review** — rejected: this is the duplicate cost and bounce the decision removes, and the task reviewer has less context than the PR reviewer.
- **Delete the reviewer agent entirely** — rejected: explicit review dispatch remains useful, and a missing work log needs an independent audit because mutation may already have happened.
- **Treat green tests as sufficient for merge** — rejected: mechanical checks prove reproducible behavior and structure, not holistic design, maintainability, or cross-task regressions.
- **Accept any existing review summary** — rejected: after a new push, a stale summary can describe a different tree. Freshness is part of the review contract, not an optional signal.

## Consequences

- Execute becomes cheaper and less prone to task-level review thrash.
- Independent local verification stays before `done`; holistic static review happens later with the complete PR context.
- Review feedback may arrive later than before, so commit/finish must fail closed on silence and stale reviews.
- A concurrent push invalidates the whole observation and restarts the watch; the merge command refuses if HEAD changes after the final verdict.
- Repositories using more than one review bot must select and complete each required adapter explicitly against one common HEAD rather than letting registry order—or approvals from different commits—choose silently.
- The worker recipe still includes reviewer model/effort because direct and safety calls need deterministic policy, but normal build telemetry should show no reviewer call unless the safety path fired.
- ADR-0002's ordinary reviewer step and ADR-0022's `maxReview` policy are superseded. ADR-0023 remains the fixed recipe decision with two limits rather than three.
