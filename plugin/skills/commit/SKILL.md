---
name: commit
description: Syncs documentation, authors the commit message + PR body, then runs the ceremony through `dobby ship` (gate → commit → push → PR) and monitors the PR to a verdict with `dobby pr watch`. Use when committing code, finishing a task, pushing changes, or creating a PR.
allowed-tools: Bash(git *), Bash(bunx dobby *), Write
---

# Commit

The skill owns **judgment** — which docs to sync, what the message says, whether a PR is opened. The **mechanics** belong to the CLI: `bunx dobby ship` performs the whole ceremony (stage → gate → re-stage → commit → push → PR) in one call, and `bunx dobby pr watch` runs the post-push watch. Opening the PR is **not** the finish line: the skill stays on watch — CI to green, review to a verdict — and only hands off once the PR is merge-ready (it never merges).

**The exit code decides.** `ship` composes the gate in-process and prints every finding itself; never re-read, re-run, or re-interpret gate output — read the JSON verdict and act.

## Step 1: Require the commit config

Check if `dobby.config.json` exists. If it exists, continue to step 2.

If not, the project hasn't been set up for harness-driven commits — that config (the doc-sync rules) is created by `/dobby:onboard`, which can't be auto-invoked. Offer with AskUserQuestion:

- **Set up the project first** *(Recommended)* — stop here and have the user type `/dobby:onboard` (it installs `dobby` and creates the config), then re-run `/dobby:commit`.
- **Commit once without the contract** — proceed with a bare `git commit` for this commit only, skipping doc-sync (step 3) and `ship` (step 5). Don't create the config ad hoc.

`ship` needs `dobby` installed as the repo's devDependency. If `dobby.config.json` exists but `bunx dobby` fails as not installed, STOP and point to `/dobby:onboard` (or `/dobby:migrate-config` for a repo moving off an old contract) — the kit assumes `dobby` is the repo's single devDependency; there is no fallback.

## Step 2: Gather context

Run each command separately to author the message (and PR body, if opening a PR):

1. `git diff --staged`
2. Only if step 1 had NO output: `git diff`
3. `git log --oneline`
4. `git branch --show-current`

## Step 3: Sync documentation

Which DOCS to update is judgment the skill owns, from `dobby.config.json`'s `files`:

1. Read `files` from `dobby.config.json`.
2. Find changed `*.md` files not in the config that could be documentation (excluding `skills/`), detect their update condition, register them.
3. For each tracked file, evaluate whether `update_when` is met by the changes.
4. Read and update every file whose condition is met.
5. If new files were registered in step 2, persist the updated config.

Leave the updated docs unstaged — `ship` stages the whole tree, so these edits are picked up with everything else.

## Step 4: Author the commit message (and PR body)

Write both to temp files with the `Write` tool, **outside the repository** (`ship` stages the whole tree, so a message file inside it would land in the commit that describes it).

**Subject:** semantic commit format (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `perf:`, `style:`, `build:`). Lowercase imperative, no period, max 70 chars. Use a scope when it adds clarity. `ship` reads the first non-empty line of the message file as the subject and reuses it as the PR title.

**Body:** explain **why** — motivation, trade-offs, decisions. State breaking changes explicitly.

**Lifecycle link:** if the session traces to a tracked goal — its id from `## Source` in `STATE.md` if it still exists (`/dobby:wrap` disposes of it), else evident from the conversation — run `bunx dobby goal parse "<the goal reference>" --json` and put its `lifecycleLink` on its own line at the end of the body. That field IS the tracker's magic word, already resolved against the configured tracker (`Closes #<n>` for github, `Fixes VON-123` for linear, `null` for local and for free-text goals — omit the line entirely then). Make **no** MCP call: for linear, the magic word text is the entire responsibility; its native GitHub integration drives In Review on PR-open and Done on merge. Don't fabricate an id you can't source. Background on the per-tracker semantics lives in `../backlog/references/trackers.md`.

**PR body:** off `main`, also author a rich body — a `## Summary` (bullets from the commit analysis) + a `## Test plan` checklist, and the same `lifecycleLink` line when the session traces to a tracked goal (the body is the reliable close-on-merge anchor, surviving a squash-merge unlike a per-commit trailer). Pass it as `--pr-body-file` in step 5. The branch guard is `ship`'s: it opens a PR off a trunk branch only, so authoring the body on `main` is wasted work, not a hazard.

## Step 5: Ship

ONE call performs the whole ceremony — stage-if-nothing-staged, the gate (`check --fix`), re-stage, commit, push (`-u origin HEAD` when there's no upstream), and `gh pr create` off a non-trunk branch when a PR body was passed and no PR exists yet:

```bash
bunx dobby ship --message-file <message-path> [--pr-body-file <pr-body-path>] --json
```

Act on the JSON payload — never on the raw output:

- **`committed: false` with `gateExitCode` ≠ 0** — the gate is red. `ship` already printed every finding on stderr and exited with the gate's own code. Report those findings **verbatim**, state that nothing was committed or pushed, and STOP: fixing the failure is the user's call (or the calling stage's). Don't re-run the gate to "see for yourself".
- **`committed: false` with `gateExitCode: 0`** — the gate PASSED and `git commit` itself failed; the stderr text is git's own, not findings. The usual cause is nothing to commit (the tree was already clean and doc-sync changed nothing); a repo-local `commit-msg`/`pre-commit` hook rejecting the message is the other. Report git's words as they are — never re-label them a gate failure — and stop.
- **`committed: true` with `pushed: false`** — the commit exists **locally only**: `git push` failed, `ship` exited nonzero with git's own stderr (no remote or upstream, a rejected non-fast-forward, expired credentials, no network) and never reached the PR step. Report `sha`, surface git's push text verbatim, and state plainly that nothing reached the remote and no PR was opened. STOP there: skip step 6 (there is nothing to watch) and don't re-run `ship` to "try again" — the push is the user's to fix (pull/rebase, add the remote, re-auth), and re-shipping a clean tree only produces a git failure with nothing to commit.
- **`committed: true` with `pushed: true`** — report `sha` and `prUrl` (a PR that already existed was updated by the push; `ship` opens no second one). A non-null `prNote` says why a requested PR has no URL (gh absent, auth expired, an API error) — surface it; the commit still stands.

## Step 6: Monitor the PR to a verdict

A green local gate proves only the TREE, not the PIPELINE (deploys run steps the gate can't: external builders' own typechecks, envless CI runners) — which is why this step watches the PR instead of trusting green. **Skip it entirely** in the two cases where there is no pipeline to watch:

- `pushed: false` — the run already ended at step 5. A local-only commit has no remote branch and no PR, so `pr watch` would answer `skipped`; reading that as "nothing to watch → hand off" would report a landed, monitored PR that does not exist. Don't run it, and don't reach the Next step.
- `prUrl` is null and you committed on a trunk branch — nothing was opened, by policy. Go straight to the Next step.

```bash
bunx dobby pr watch --await-review --deadline 300 --json
```

It owns the polling (CI to terminal, then the review round, each phase on its own deadline) and answers with ONE `verdict`. Branch on it:

| `verdict` | What it means | Do |
|---|---|---|
| `merge-ready` | CI green, review posted, no open threads | State plainly that the PR is merge-ready. **NEVER merge it yourself — merging is always the user's call.** |
| `feedback-present` | Open review threads (`openThreads` > 0) | Invoke **`/dobby:address-review`** via the Skill tool. It owns triage (with its human gate), the fixes, thread resolution and the re-trigger — don't reimplement any of it here. |
| `open-unreviewed` | Nothing posted before the deadline | Report the PR as open + unreviewed and end. Never poll again for a bot that may not exist. |
| `ci-failed` | A check went red (`failing[]` names each one + its `link`) | Route those check names and links to a worker — **never** an inline edit. After the worker's fix, re-run step 5 (a fix is a commit) and then this step. |
| `ci-pending` | Checks still running when the deadline expired | Report that, or re-run the command with a longer `--deadline`. |
| `skipped` | No PR on this branch (`reason` says why) | Nothing to watch — go to the Next step. |

**Confidence never moves the verdict**: `pr watch` decides on open THREADS alone, so a posted summary with no open threads is `merge-ready` whatever its score. When the payload's `summary.confidence` is non-null, state it alongside the verdict and let the user confirm the bar — the confidence-driven judgment (including the dashboard-only case) belongs to `/dobby:address-review`.

A **nonzero exit** means gh could not report at all (auth, network, rate limit) — surface its stderr and stop; an unreadable pipeline is never a green light.

## Next step

Reached only once the commit is **on the remote**: a red gate, a failed `git commit` and a failed push all end the run inside step 5, with what went wrong as the last word — no handoff, no next stage. Otherwise the commit landed, and — off `main` — the monitor has run to its verdict. Present the next stage as an **AskUserQuestion** — one question that restates where things landed (the PR is monitored and waiting on **your** merge; the skill never merges) — with the options below (recommended first, then Stop here). On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn.

- **`/dobby:finish`** *(Recommended, after you merge the PR)* — the kit created a worktree for this goal at `/dobby:scope`; tear down the worktree: close the dev server, remove the worktree + branch, and pull main up to date.
- **Stop here** — the PR still needs your merge first (or is waiting on review); come back to `/dobby:finish` once it's merged.

## Acceptance checklist

- [ ] Commit config exists at `dobby.config.json` (or the user explicitly chose a one-off contract-less commit; `/dobby:onboard` suggested); missing local `dobby` bin → stopped, pointed to `/dobby:onboard` / `/dobby:migrate-config`
- [ ] Documentation synced with the changes per `files` (doc-sync is the skill's judgment); updated docs left unstaged for `ship` to sweep
- [ ] Commit message authored in semantic format with a why-body, written to a temp file OUTSIDE the repository; the lifecycle link taken from `bunx dobby goal parse`'s `lifecycleLink` (never re-derived per tracker, no MCP call) when the session traces to a tracked goal
- [ ] Off a trunk branch: a PR body authored (`## Summary` + `## Test plan` + the lifecycle link) and passed as `--pr-body-file`
- [ ] Ceremony run as ONE `bunx dobby ship --message-file <f> [--pr-body-file <f>] --json` — no hand-run gate, no hand-run `git commit`/`git push`/`gh pr create`
- [ ] `committed: false` read through `gateExitCode` — ≠ 0 → the gate findings reported verbatim; `0` → git's own failure text reported as such (never re-labelled a gate failure); either way the commit abandoned. `committed: true` → `sha` / `prUrl` reported, plus `prNote` when a requested PR has no URL
- [ ] `pushed: false` on a made commit treated as a STOP, not a success: git's push stderr surfaced, the commit stated as local-only with no PR, step 6 and the Next-step handoff skipped
- [ ] PR monitored via `bunx dobby pr watch --await-review --deadline 300 --json` and routed by its verdict (`ci-failed` → a worker, never an inline edit, then re-ship + re-watch; `feedback-present` → `/dobby:address-review`; `merge-ready` / `open-unreviewed` reported, with `summary.confidence` stated when present); a nonzero exit surfaced instead of read as green
- [ ] The skill NEVER merged the PR (merging is the user's call)
