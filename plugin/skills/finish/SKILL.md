---
name: finish
description: Closes the goal end-to-end — merges the goal's PR when it is still open (gated, on your explicit selection), then tears its worktree down. Use when the current goal's PR is merged OR merge-ready and you want to clean up and return to main.
---

The end of a work session, closed end-to-end. If the goal's PR is still OPEN, `/dobby:finish` offers to **merge it first** — always as an explicit selection at the gate in Step 1, never automatically. Once it is merged, tear down its worktree: run `bunx dobby down --json` to kill the run and run the project's cleanup, carry out any `stop` instruction it hands back (closing the now-empty kit cmux panes), then delete the branch and pull the main checkout up to date — closing the goal so the tree is ready for the next one.

**One session per goal.** Each goal gets its own worktree; parallel goals run in parallel worktrees (one per cmux pane/session — legitimate and encouraged). `/dobby:finish` tears down THIS goal's worktree once its PR is merged — it does not touch other goals' worktrees. Run it (typed, manually) when the PR is merged, or when it is merge-ready and you want finish to merge it.

**The verdict is the CLI's; every destructive gate is yours.** `bunx dobby finish --preflight` computes what the teardown would destroy and whether it is safe; nothing about it removes anything. You branch on the verdict, ask the user at every gate, and perform the removal.

## Step 1: Preflight — never blind-destroy

```bash
bunx dobby finish --preflight --json           # from inside the goal's worktree
bunx dobby finish --preflight --slug <slug> --json   # orphan: from the main checkout
```

One call resolves the target (`slug`, plus the kit's naming for it — `branch` = `worktree-<slug>`, `worktreePath` = `<mainRoot>/.claude/worktrees/<slug>/`), the mode (`same-session` when the session is standing in the worktree it owns, `orphan` otherwise), the PR (`pr.state` / `pr.mergedAt` / `pr.url`, via `gh`), the uncommitted work a teardown would lose (`dirty.count` / `dirty.files`, untracked included), the contract (`dobbyInstalled`), and the two mechanics Step 3 reads (`removeMechanism`, `branchDeleteSafe`). Branch on `verdict`:

- **`blocked` with `slug: null`** — no target could be resolved (you're in the main checkout and named none). `candidates[]` holds this repo's kit worktrees: **confirm the target with the user** via an `AskUserQuestion` (one option per candidate, plus a Cancel) — pick the one whose branch matches the merged PR — then re-run the preflight with `--slug <slug>`. Never guess.
- **`blocked` with `dobbyInstalled: false`** — `dobby down` is the mandatory pre-removal teardown and has no fallback. **STOP** and point the user at `/dobby:onboard` (or `/dobby:migrate-config` for a repo moving off an old contract).
- **`safe`** — a MERGED PR and a clean tree. Proceed to Step 2 without a prompt.
- **`confirm-required`** — this is a destructive-action gate. **Show the exact state**: every entry of `reasons[]` (an open/closed/absent PR, uncommitted changes), the PR state + `pr.url`, and the `dirty.files` list. Then require **explicit user confirmation** with an `AskUserQuestion` — an in-stage destructive-action gate, NOT a stage handoff:
  - **Merge & finish** *(Recommended when the PR is open and its checks are green)* — merge the goal's PR right here, then finish (see "Merging inside the gate" below). Offer this option **only** when the PR is OPEN (`pr.state: "OPEN"`) and the tree is otherwise clean — the open PR is the only entry in `reasons[]` and `dirty.count` is `0`. A closed/absent PR or a dirty tree gets the two options below and nothing else.
  - **Cancel — don't destroy** *(Recommended when the PR has open feedback or the tree is dirty)* — stop; nothing is merged and nothing is removed. (The user takes the PR through `/dobby:address-review`, or handles the uncommitted work, then re-runs `/dobby:finish`.)
  - **Destroy anyway** — the user accepts losing an unmerged branch and any uncommitted changes; carry that acceptance forward (it authorizes `discard_changes` / `--force` / the branch force-delete in Step 3). Only pick this on the user's explicit say-so.

**Merging inside the gate.** The selection of "Merge & finish" IS the user's merge decision — the kit never merges without it, and there is no path here that merges on the preflight's word alone:

1. Confirm the PR is actually merge-ready:

   ```bash
   bunx dobby pr watch [--adapter <selected id>] --await-review --deadline 60 --json
   ```

   Run it where the goal's PR resolves: same-session, the worktree's own branch answers for it; in `orphan` mode name the PR explicitly (`--pr <the number ending pr.url>`), because the main checkout's branch has no PR of its own. If the watch refuses because several adapters matched, run `bunx dobby review fetch --json`, ask which adapter is the gate, and re-run with `--adapter <chosen id>`. When several adapters are required gates, run every one in turn and retain every `merge-ready` payload: they are valid as a set ONLY when all `pr.headRefOid` values are the same. A mismatch means a push landed between gates—discard the entire set and restart from the first adapter until every gate validates one common SHA. Merge on verdict **`merge-ready`** from every required adapter and on nothing else. Retain that common exact SHA as the validated SHA; never re-derive it later. For Greptile, the verdict proves BOTH that its status check passed on that commit and that the summary footer's `Last reviewed commit` SHA exactly matches it. For CodeRabbit, it proves the commit-scoped CodeRabbit check passed; an old summary without that check is unreviewed. Stale/missing evidence ends as `open-unreviewed`; report `reason` and `summary.reviewedHeadOid` when present, and do NOT substitute an old clean summary or bot silence for review. On any other verdict, report it and do NOT merge: `feedback-present` → invoke **`/dobby:address-review`** via the Skill tool (it owns triage, the fixes, thread resolution and the re-trigger); `ci-failed` / `ci-pending` / `open-unreviewed` / `skipped` → report the verdict as it is and stop, worktree intact. A nonzero exit means the watch could not produce an unambiguous observation (gh failure or missing adapter selection) — surface stderr and stop; an unreadable or ambiguous pipeline is never a merge.

2. Merge it **squashed** — the kit's convention, and the reason `branchDeleteSafe` / `-D` exist in Step 3:

   ```bash
   gh pr merge <pr.url> --match-head-commit <validated pr.headRefOid> --squash
   ```

   `--match-head-commit` closes the gap between watch and merge: if another push changed HEAD after validation, gh refuses instead of merging unreviewed bytes. On that refusal, report the drift and stop; re-run the watch before offering another merge. If gh refuses for branch protection, a merge conflict, or missing permissions, likewise report its words and stop — nothing is torn down.

3. Re-run the preflight exactly as you ran it above (same `--slug`, same cwd). It now reads the PR as MERGED and answers `safe`: continue to Step 2 with no further prompts. If it answers anything else, show what it says and stop.

Do not proceed to teardown on anything but `safe` — either read straight from the preflight, or re-read after the gated merge — or an explicit "destroy anyway".

## Step 2: Tear down the run — `bunx dobby down --json`

Run `bunx dobby down --json` (see `../execute/references/bring-up.md`'s "Tearing down" section) to tear the run down. Its mechanics already ran by the time it returns: killing the detached run by pidfile, deleting the per-worktree Neon branch, and running the project's `teardown[]` extras from `dobby.config.json`. You NEVER hunt for a background job by hand — `dobby down` owns all of it. Read `ok`/`reason` from the payload, then carry out `instructions[]` yourself: a non-empty `stop` entry (present only when a kit pane was discovered under cmux) names the now-empty kit panes to close — carry it out same as you would `up`'s `start`/`rename`. A no-app project (no run script, no panes, no `teardown` extras) no-ops cleanly, with an empty `instructions[]`.

- `mode: "same-session"` — the cwd is already inside the worktree: run it there.
- `mode: "orphan"` — run it with the preflight's `worktreePath` as the working directory (e.g. `bash -c 'cd <worktreePath> && bunx dobby down --json'`), never from the main checkout.

If `dobby down` reports a failure (`ok: false`, `reason`), report it and let the user decide whether to continue removing the worktree — a half-cleaned resource is the user's call, not an auto-force.

## Step 3: Remove the worktree + branch

The mechanism is the preflight's `removeMechanism`; the safety of the branch delete is its `branchDeleteSafe`.

**`branchDeleteSafe` is true exactly when the PR is MERGED — that, not git's ancestry check, is the authoritative signal.** Most repos **squash-merge**: after a squash the feature branch tip is a different commit (new SHA/tree) that is NOT an ancestor of main, so git's own "is this branch merged?" test (`git branch -d`) reports a legitimately-merged branch as **unmerged**. Following `-d` would strand the user on every normal finish, which is why the force delete below is the default path and not an escape hatch.

- **`removeMechanism: "ExitWorktree"`** (same-session) → native **`ExitWorktree`** with `remove`: it deletes the worktree directory and its branch AND restores the cwd to the main checkout (this is why native is preferred same-session — raw git leaves you stranded inside a directory it just deleted). Pass `discard_changes: true` ONLY if the user explicitly confirmed "destroy anyway" over uncommitted changes in Step 1; on the `safe` path, no discard. If `ExitWorktree(remove)` reports the branch as unmerged and refuses to delete it (the squash-merge case above), that's expected — it does NOT contradict `branchDeleteSafe`; delete the leftover branch with the force delete below.
- **`removeMechanism: "raw-git"`** (orphan) → raw git, run **from the main checkout** (`mainRoot`; never from inside the target worktree — you'd be removing the ground under your feet):

  ```bash
  git worktree remove <worktreePath>   # add --force ONLY if the user confirmed destroying a dirty tree in Step 1
  git branch -D <branch>               # force-delete: after a squash-merge, -d always refuses a legitimately-merged branch
  ```

`-D` is deliberate: `branchDeleteSafe: true` IS the safe-to-delete signal. When it is false, the only thing authorizing the delete is the user's explicit "destroy anyway" from Step 1 — carry that acceptance forward, and if they cancelled, nothing here runs at all.

## Step 4: Update main

Bring the main checkout up to date with the merge:

```bash
git pull        # on the main checkout
```

On a conflict or divergence (the pull doesn't fast-forward cleanly), **report it and stop — never force.** Show what git said and let the user reconcile; `/dobby:finish` does not rebase, reset, or force-pull.

## Next step — terminal

The goal is closed: its worktree and branch are gone, the dev server is down, and main is current. `/dobby:finish` is **terminal** — there is no next stage to hand off to.

Note the goal is done, then present an **AskUserQuestion** (one question) that restates the goal is closed and offers:

- **Start the next goal (`/dobby:scope`)** *(Recommended)* — begin the next goal in a fresh session (per one-session-per-goal); invoke `/dobby:scope` via the Skill tool.
- **Stop here** — end the turn.

## Language

Interact with the user in their language. Write any note you persist in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] `bunx dobby finish --preflight --json` run FIRST (with `--slug` when finishing an orphan from the main checkout); no fact re-derived by hand (no separate `gh pr view`, `git status`, or install probe)
- [ ] `blocked` handled by cause: `slug: null` → target confirmed with the user from `candidates[]` and the preflight re-run with `--slug`; `dobbyInstalled: false` → STOPPED pointing at `/dobby:onboard` / `/dobby:migrate-config`
- [ ] `safe` proceeded without a prompt; `confirm-required` showed the exact state (`reasons[]`, PR state + url, `dirty.files`) and got explicit confirmation via AskUserQuestion (Merge & finish only when offered / Cancel / Destroy anyway) before anything was merged or destroyed
- [ ] The **Merge & finish** option offered ONLY on an OPEN PR with an otherwise-clean tree (open PR the only `reasons[]` entry, `dirty.count: 0`) — never on a closed/absent PR or a dirty tree
- [ ] The PR merged ONLY on the user's explicit "Merge & finish" selection, and only after `bunx dobby pr watch [--adapter <selected id>] --await-review --deadline 60 --json` answered `merge-ready` with commit-scoped evidence (multi-adapter ambiguity selected mechanically; every required adapter validated the SAME `pr.headRefOid`, with the whole set restarted on mismatch; Greptile: passing review check AND `summary.reviewedHeadOid == pr.headRefOid`; CodeRabbit: passing current-commit review check; stale/missing evidence remained `open-unreviewed`, never review-by-silence); any other verdict reported and NOT merged, `feedback-present` routed to `/dobby:address-review`; squash merge pinned to the common validated SHA (`gh pr merge <pr.url> --match-head-commit <pr.headRefOid> --squash`)
- [ ] After the merge, the preflight re-run (same `--slug`/cwd) and read as MERGED / `safe` before Step 2 — never assumed
- [ ] `bunx dobby down --json` run before removal — inside the worktree same-session, with `worktreePath` as cwd for an orphan; kills the detached run, deletes the Neon branch, runs `teardown[]` extras; `ok`/`reason` read and any `instructions[]` (`stop`) carried out to close the now-empty kit panes; a no-app project no-ops cleanly; a reported failure surfaced for the user's call, not auto-forced
- [ ] Worktree + branch removed by `removeMechanism`: `ExitWorktree(remove)` same-session (cwd restored to main; `discard_changes` only after the explicit Step 1 confirmation) / raw `git worktree remove <worktreePath>` + `git branch -D <branch>` for `raw-git`, run from `mainRoot` — `-D` because `branchDeleteSafe` (gh MERGED), not git ancestry, is the safe-to-delete signal
- [ ] `git pull` on the main checkout; on conflict/divergence reported and stopped — never forced
- [ ] Ended with an AskUserQuestion gate (goal closed; start the next goal via `/dobby:scope` recommended, or stop here); `/dobby:scope` invoked through the Skill tool on selection
