---
name: address-review
description: Triage and address external code-review findings on the current PR (Greptile, CodeRabbit, or human reviewers), then close the loop — fix, reply, resolve threads, re-trigger review, and report merge-readiness. Use when a review bot or reviewer left comments on a PR and you want to address the feedback, resolve threads, rebut a stale finding, or get the review to green. Decoupled from any one review tool via a thin adapter.
argument-hint: "[PR number (optional)]"
allowed-tools: Bash(gh *), Bash(git add *), Bash(git commit *), Bash(git push *), Bash(git diff *), Bash(git log *)
model: opus
effort: high
---

You are the coordinator/architect. You run the PR mechanics (`gh`/`git`) yourself, but you NEVER edit code — every fix goes to a worker. Take the review findings on the current PR from "posted" to "addressed + threads resolved + re-reviewed", with a human triage gate. The tool-specific surface is one adapter (`references/adapters.md`); everything else is generic GitHub (`references/github-api.md`).

## Step 1: Intake

Identify the PR (use the argument, else `gh pr view --json number,headRefName,url`). Then, per `references/github-api.md`:

- Fetch OPEN review threads (`reviewThreads`, keep `isResolved=false`). Grab each first comment's `databaseId`, `author.login`, `path`, `line`, `body`, plus the thread's `isOutdated` — `isOutdated=true` means a newer push already changed the annotated lines (GitHub collapses these).
- **Auto-detect the tool**: intersect the open-thread authors with the adapter registry (`references/adapters.md`), matching by bot slug (ignore any `[bot]` suffix). One match → that adapter · several → ask which (or handle all) · none → generic/human mode (resolve + push, no re-trigger).
- Read the bot's **summary + confidence** — it lives in ONE issue comment the bot EDITS IN PLACE, so select the bot-authored comment by `updated_at`, not `created_at`.

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

For every `fix`, delegate (the architect never works):

- **Small / scoped** (most review fixes) → spawn `dobby:implementor` (Agent tool, `subagent_type: "dobby:implementor"`). Batch several trivial fixes into ONE implementor call. Parallel implementors only on **non-overlapping** areas (same rule as `/dobby:execute` waves).
- **A fix that must be proven** → run the **build loop** (implement → review → verify) via the `dobby:execute` skill's `references/build-workflow.md` with a single-task array.
- **Feature-sized finding** (rare) → don't force it through here. Suggest, as plain text, that the user TYPE `/dobby:scope → … → /dobby:execute`; leave it for them to enter.

Implementors keep the tree green (build/type/lint); they do NOT commit.

## Step 4: ADR candidates

For each accepted or deferred **decision** (not every fix), evaluate the three criteria — hard to reverse · surprising without context · a real trade-off (mirrors `/dobby:wrap`). Review-driven decisions earn posterity; routine fixes don't. Offer to write the ADR; the user approves; you write it to `docs/adr/`, numbered sequentially. Typical from reviews: "defer the FK index (YAGNI at this scale)", "coerce a stale FK to null at the server seam instead of a cross-module refetch".

## Step 5: Close the loop

Per `references/github-api.md`, and using the detected adapter:

1. **Commit + push** the addressed fixes to the PR branch. It's an existing PR — no new PR, keep the message review-scoped (e.g. `fix: address review feedback`).
2. **Resolve EXPLICITLY.** Pushing does NOT auto-resolve or outdate threads — confirmed: lines changed by a fix still read `isResolved=false`. Call `resolveReviewThread` (batch with GraphQL aliases) on the `fix`, `dismiss`, and `outdated` threads: `fix` → resolve once the change lands, `dismiss` → resolve with the one-line why, `outdated` → resolve after verifying the newer code covers it. Only `defer` threads stay open (deferred) — close them out with a reply (item 3) instead.
3. **Reply with the rationale** on `deferred` threads (and on any `dismiss` where the why is worth stating to the bot) — REST, `in_reply_to=<databaseId>`, `@`-mentioning the bot via `adapter.intentionalReply` so it learns not to re-flag.
4. **Re-trigger** the review via `adapter.reTrigger` (skip for human/unknown — nothing to trigger).
5. **Re-fetch and reconcile.** Confirm thread state AND re-read the UPDATED summary/confidence. **The summary lags the threads**: it can still list an addressed concern as open even after a valid fix + a resolved thread. Decide per residual concern — accept it, **rebut** it (a clarifying reply + one more re-trigger to move the summary), or do more work.

## Step 6: Gate check

If the tool posts a confidence-gated status check, read the current confidence against the threshold and report merge-readiness plainly: "4/5, gate needs 4 → good to merge" / "2/5, needs 3 → address X first". For Greptile the numeric threshold is dashboard-only (see `references/adapters.md`), so state the confidence and let the user confirm the bar.

## Next step

Plain-text handoff — no AskUserQuestion, no Skill-tool auto-invoke:

- **More fixes needed** → loop back to Step 2, re-triaging ONLY the NEW residual concerns from the bot's UPDATED summary — not every open thread. Deferred threads stay `isResolved=false` on purpose; don't re-present a decision the user already made.
- **Gate met** → ready to merge.
- **Part of a larger session** → suggest the user TYPE `/dobby:wrap` to reconcile docs and write any ADRs.

## Language

Interact with the user in their language. Code, comments, commit messages, ADRs, and thread replies in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] PR identified; open unresolved threads fetched; review tool auto-detected via the adapter registry
- [ ] Summary + confidence read from the edited-in-place bot comment (by `updated_at`)
- [ ] Every comment triaged (fix / defer / dismiss / outdated) and confirmed at the human gate — nothing auto-fixed
- [ ] Fixes delegated to `dobby:implementor` (or build loop / scope→execute); architect edited no code
- [ ] Decision-grade findings evaluated for ADRs; offered and written on approval
- [ ] Fixes committed + pushed; `fix` / `dismiss` / `outdated` threads resolved EXPLICITLY; `deferred` threads left open and replied with rationale + bot @-mention
- [ ] Review re-triggered (unless human/unknown); thread state AND summary reconciled; stale summary rebutted where warranted
- [ ] Merge-readiness reported against the confidence gate; next step handed off in plain text
