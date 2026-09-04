---
name: finish
description: Closes the goal end-to-end — merges the goal's PR when it is still open (gated, on your explicit selection), then tears the run down. Use when the current goal's PR is merged OR merge-ready and you want to clean up and return to the default branch.
---

The end of a work session, closed end-to-end. If the goal's PR is still OPEN, `/dobby:finish` offers to **merge it first** — always as an explicit selection at the gate in Step 1, never automatically. Once it is merged, tear down the run: run `bunx dobby down --json` to kill it and run the project's cleanup, carry out any `stop` instruction it hands back (closing the now-empty kit cmux panes). Then, **only when the session stands inside a linked worktree** — whoever made it: `claude --worktree`, an IDE, a bare `git worktree add` — offer to remove that worktree and its branch. On a plain checkout there is no worktree to remove: return to `defaultBranch`, delete the goal's branch, and pull — closing the goal so the tree is ready for the next one.

**One session per goal.** Each goal's work happens in its own session; parallel goals run in parallel sessions (one per cmux pane/session — legitimate and encouraged, whether or not each stands in its own worktree). `/dobby:finish` closes THIS goal — it does not touch other goals' worktrees or checkouts. Run it (typed, manually) when the PR is merged, or when it is merge-ready and you want finish to merge it.

**The verdict is the CLI's; every destructive gate is yours.** `bunx dobby finish --preflight` computes what the teardown would destroy and whether it is safe; nothing about it removes anything. You branch on the verdict, ask the user at every gate, and perform the removal.

## Step 1: Preflight — never blind-destroy

```bash
bunx dobby finish --preflight --json
```

One call, run from wherever the session already stands, reports where that is (`inWorktree`, `worktreePath`, `mainRoot`), the branch (`branch`), the repository's own trunk (`defaultBranch: string | null` — resolved by an ordered cascade: remote head (only while the ref it names still exists — a stale/dangling `origin/HEAD` counts as unset and falls through), then remote-tracking `main`/`master`, then local `main`/`master`, else `null` when nothing names one; Step 3 switches to it, never to a hard-coded `main`), the PR (`pr.state` / `pr.mergedAt` / `pr.url`, via `gh`), the uncommitted work a teardown would lose (`dirty.count` / `dirty.files`, untracked included), the contract (`dobbyInstalled`), and the mechanic Step 3 reads (`branchDeleteSafe`). Branch on `verdict`:

- **`blocked`** — `dobbyInstalled: false`: `dobby down` is the mandatory pre-removal teardown and has no fallback. **STOP** and point the user at `/dobby:onboard` (or `/dobby:migrate-config` for a repo moving off an old contract). This is the ONLY blocking condition.
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

   Run it where the session stands — the current branch's own PR answers for it. If the watch refuses because several adapters matched, run `bunx dobby review fetch --json`, ask which adapter is the gate, and re-run with `--adapter <chosen id>`. When several adapters are required gates, run every one in turn and retain every `merge-ready` payload: they are valid as a set ONLY when all `pr.headRefOid` values are the same. A mismatch means a push landed between gates—discard the entire set and restart from the first adapter until every gate validates one common SHA. Merge on verdict **`merge-ready`** from every required adapter and on nothing else. Retain that common exact SHA as the validated SHA; never re-derive it later. For Greptile, the verdict proves BOTH that its status check passed on that commit and that the summary footer's `Last reviewed commit` SHA exactly matches it. For CodeRabbit, it proves the commit-scoped CodeRabbit check passed; an old summary without that check is unreviewed. Stale/missing evidence ends as `open-unreviewed`; report `reason` and `summary.reviewedHeadOid` when present, and do NOT substitute an old clean summary or bot silence for review. On any other verdict, report it and do NOT merge: `feedback-present` → invoke **`/dobby:address-review`** via the Skill tool (it owns triage, the fixes, thread resolution and the re-trigger); `ci-failed` / `ci-pending` / `open-unreviewed` / `skipped` → report the verdict as it is and stop, nothing torn down. A nonzero exit means the watch could not produce an unambiguous observation (gh failure or missing adapter selection) — surface stderr and stop; an unreadable or ambiguous pipeline is never a merge.

2. Merge it **squashed** — the kit's convention, and the reason `branchDeleteSafe` / `-D` exist in Step 3:

   ```bash
   gh pr merge <pr.url> --match-head-commit <validated pr.headRefOid> --squash
   ```

   `--match-head-commit` closes the gap between watch and merge: if another push changed HEAD after validation, gh refuses instead of merging unreviewed bytes. On that refusal, report the drift and stop; re-run the watch before offering another merge. If gh refuses for branch protection, a merge conflict, or missing permissions, likewise report its words and stop — nothing is torn down.

3. Re-run the preflight exactly as you ran it above (same cwd). It now reads the PR as MERGED and answers `safe`: continue to Step 2 with no further prompts. If it answers anything else, show what it says and stop.

Do not proceed to teardown on anything but `safe` — either read straight from the preflight, or re-read after the gated merge — or an explicit "destroy anyway".

## Step 2: Tear down the run — `bunx dobby down --json`

Run `bunx dobby down --json` from the workroot the session already stands in (see `../execute/references/bring-up.md`'s "Tearing down" section) to tear the run down. Its mechanics already ran by the time it returns: killing the detached run by pidfile, deleting the per-worktree Neon branch, and running the project's `teardown[]` extras from `dobby.config.json`. You NEVER hunt for a background job by hand — `dobby down` owns all of it. Read `ok`/`reason` from the payload, then carry out `instructions[]` yourself: a non-empty `stop` entry (present only when a kit pane was discovered under cmux) names the now-empty kit panes to close — carry it out same as you would `up`'s `start`/`rename`. A no-app project (no run script, no panes, no `teardown` extras) no-ops cleanly, with an empty `instructions[]`.

If `dobby down` reports a failure (`ok: false`, `reason`), report it and let the user decide whether to continue with removal — a half-cleaned resource is the user's call, not an auto-force.

## Step 3: Return to the default branch — remove the worktree only if you're standing in one

Branch on the preflight's `inWorktree`.

**`branchDeleteSafe` is true exactly when the PR is MERGED — that, not git's ancestry check, is the authoritative signal.** Most repos **squash-merge**: after a squash the feature branch tip is a different commit (new SHA/tree) that is NOT an ancestor of the default branch, so git's own "is this branch merged?" test (`git branch -d`) reports a legitimately-merged branch as **unmerged**. Following `-d` would strand the user on every normal finish, which is why the force delete below is the default path and not an escape hatch.

- **`inWorktree: true`** — try native **`ExitWorktree`** with `remove` first: it deletes the worktree directory and its branch AND restores the cwd to the main checkout (this is why native is tried first — raw git leaves you stranded inside a directory it just deleted). Pass `discard_changes: true` ONLY if the user explicitly confirmed "destroy anyway" over uncommitted changes in Step 1; on the `safe` path, no discard. Two distinct refusals fall back to raw git, run **from `mainRoot`** (never from inside the worktree — you'd be removing the ground under your feet):
  - **No active worktree session** (this session did not enter it — an IDE or a bare `git worktree add` did): the directory is still there, so run both lines below.

    ```bash
    git worktree remove <worktreePath>   # add --force ONLY if the user confirmed destroying a dirty tree in Step 1
    git branch -D <branch>               # force-delete: after a squash-merge, -d always refuses a legitimately-merged branch
    ```
  - **Branch refused as unmerged** (the squash-merge case above, which does NOT contradict `branchDeleteSafe`): `ExitWorktree` already removed the directory and restored the cwd — only the branch is left. Run the `-D` line ONLY; running `git worktree remove` here would target a path that's already gone.

    ```bash
    git branch -D <branch>               # force-delete: after a squash-merge, -d always refuses a legitimately-merged branch
    ```

- **`inWorktree: false`** — a plain checkout has no worktree to remove; read `defaultBranch` before switching:
  - **a string** — return to it and delete the goal's branch:

    ```bash
    git switch <defaultBranch>
    git branch -D <branch>               # force-delete: after a squash-merge, -d always refuses a legitimately-merged branch
    ```
  - **`null`** — do NOT guess: the preflight could not determine the trunk (`origin/HEAD` is unset and neither `main` nor `master` exists). STOP the teardown here — no `AskUserQuestion`, just a plain-text note naming exactly what the operator runs once they know the trunk name:

    ```
    git switch <trunk>
    git branch -D <branch>
    git pull
    ```

    End the stage there: the PR is merged and the run is torn down — nothing here is half-way, only the branch cleanup is left for the operator to finish by hand.

`-D` is deliberate in both cases: `branchDeleteSafe: true` IS the safe-to-delete signal. When it is false, the only thing authorizing the delete is the user's explicit "destroy anyway" from Step 1 — carry that acceptance forward, and if they cancelled, nothing here runs at all.

## Step 4: Update the default branch

Bring `mainRoot` up to date with the merge:

```bash
git pull        # on mainRoot
```

On a plain checkout where Step 3 switched `mainRoot` onto a known `defaultBranch`, this pulls that branch. When Step 3 stopped for an unknown `defaultBranch` (`null`), there was no switch to follow — Step 4 does not run; the operator's own `git pull`, named in Step 3's note, closes it once they've picked a trunk. Inside a linked worktree, `mainRoot` was never switched — this pulls whatever branch the main checkout already has checked out.

On a conflict or divergence (the pull doesn't fast-forward cleanly), **report it and stop — never force.** Show what git said and let the user reconcile; `/dobby:finish` does not rebase, reset, or force-pull.

## Next step — terminal

The goal is closed: the run is down, the worktree (if any) and its branch are gone, and the default branch is current. `/dobby:finish` is **terminal** — there is no next stage to hand off to.

Note the goal is done, then present an **AskUserQuestion** (one question) that restates the goal is closed and offers:

- **Start the next goal (`/dobby:scope`)** *(Recommended)* — begin the next goal in a fresh session (per one-session-per-goal); invoke `/dobby:scope` via the Skill tool.
- **Stop here** — end the turn.

## Language

Interact with the user in their language. Write any note you persist in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] `bunx dobby finish --preflight --json` run FIRST, from wherever the session stands; no fact re-derived by hand (no separate `gh pr view`, `git status`, or install probe)
- [ ] `blocked` (`dobbyInstalled: false`, the only cause) → STOPPED pointing at `/dobby:onboard` / `/dobby:migrate-config`
- [ ] `safe` proceeded without a prompt; `confirm-required` showed the exact state (`reasons[]`, PR state + url, `dirty.files`) and got explicit confirmation via AskUserQuestion (Merge & finish only when offered / Cancel / Destroy anyway) before anything was merged or destroyed
- [ ] The **Merge & finish** option offered ONLY on an OPEN PR with an otherwise-clean tree (open PR the only `reasons[]` entry, `dirty.count: 0`) — never on a closed/absent PR or a dirty tree
- [ ] The PR merged ONLY on the user's explicit "Merge & finish" selection, and only after `bunx dobby pr watch [--adapter <selected id>] --await-review --deadline 60 --json` answered `merge-ready` with commit-scoped evidence (multi-adapter ambiguity selected mechanically; every required adapter validated the SAME `pr.headRefOid`, with the whole set restarted on mismatch; Greptile: passing review check AND `summary.reviewedHeadOid == pr.headRefOid`; CodeRabbit: passing current-commit review check; stale/missing evidence remained `open-unreviewed`, never review-by-silence); any other verdict reported and NOT merged, `feedback-present` routed to `/dobby:address-review`; squash merge pinned to the common validated SHA (`gh pr merge <pr.url> --match-head-commit <pr.headRefOid> --squash`)
- [ ] After the merge, the preflight re-run (same cwd) and read as MERGED / `safe` before Step 2 — never assumed
- [ ] `bunx dobby down --json` run before removal, from the workroot the session stands in; kills the detached run, deletes the Neon branch, runs `teardown[]` extras; `ok`/`reason` read and any `instructions[]` (`stop`) carried out to close the now-empty kit panes; a no-app project no-ops cleanly; a reported failure surfaced for the user's call, not auto-forced
- [ ] Branched on `inWorktree`: TRUE → native `ExitWorktree(remove)` tried first (cwd restored to main; `discard_changes` only after the explicit Step 1 confirmation); on "no active worktree session" fell back to raw `git worktree remove <worktreePath>` + `git branch -D <branch>` from `mainRoot`; on "branch refused as unmerged" (the directory is already gone) fell back to `git branch -D <branch>` ONLY, never `git worktree remove` on a path ExitWorktree already deleted; FALSE → read `defaultBranch`: a string → `git switch <defaultBranch>` then `git branch -D <branch>`; `null` → STOPPED with a plain-text note (no AskUserQuestion) naming `git switch <trunk>` / `git branch -D <branch>` / `git pull` for the operator, ending the stage with the PR merged and the run torn down — `-D` in every completed case because `branchDeleteSafe` (gh MERGED), not git ancestry, is the safe-to-delete signal
- [ ] `git pull` on `mainRoot` run ONLY when a switch happened — the branch Step 3 left it on (`defaultBranch` on a plain checkout, unchanged inside a linked worktree); skipped when Step 3 stopped for a `null` `defaultBranch`; on conflict/divergence reported and stopped — never forced
- [ ] Ended with an AskUserQuestion gate (goal closed; start the next goal via `/dobby:scope` recommended, or stop here); `/dobby:scope` invoked through the Skill tool on selection
