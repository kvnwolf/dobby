# The adapter seam

The ONLY tool-specific surface. A small registry keyed by bot author; everything else is generic GitHub (`github-api.md`). Adding a review tool = one entry here, nothing else.

## Registry

```yaml
greptile:
  botLogins: ["greptile-apps[bot]", "greptile-apps-staging[bot]"]
  reTrigger: "@greptileai review"
  intentionalReply: "@greptileai <reason>"   # trains it not to re-flag
  confidence: dashboard-only                 # numeric 0–5 threshold not in the check payload

coderabbit:
  botLogins: ["coderabbitai[bot]"]
  reTrigger: "@coderabbitai review"
  intentionalReply: "@coderabbitai <reason>"
  confidence: none

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

The loop is identical for human reviewers — only the re-trigger differs.

## Greptile setup (config-as-code) — reference only

Surface this as a per-project checklist only if the user asks for review-tool setup; it's not part of the address loop.

Config-as-code (`greptile.json` or `.greptile/config.json`, read from the PR's SOURCE branch, OVERRIDES the dashboard) controls review BEHAVIOR: `strictness`, `commentTypes`, `fileChangeLimit`, `triggerOnUpdates`/`triggerOnDrafts`/`skipReview`, PR filters (`labels`/`disabledLabels`/`include`/`excludeAuthors`/`excludeBranches`/`excludeKeywords`), `ignorePatterns`, output (`shouldUpdateDescription`/`updateSummaryOnly`/`fixWithAI`/`hideFooter`), summary section objects, `statusCheck`/`statusCommentsEnabled`, `instructions`, structured `rules`, plus `files.json`, `rules.md`, `context.repos`.

**Dashboard-only (NOT config-as-code, verified):** the status-check confidence THRESHOLD (0–5), the comment header text, auto-approve, and the "Fix with your Agent" buttons. These stay a manual per-project checklist — a `/dobby:onboard`-style step could surface them.
