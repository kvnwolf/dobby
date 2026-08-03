---
name: finish
description: Post-merge worktree teardown — use when the PR of the current goal's worktree is merged and you want to clean up and return to main.
---

The end of a work session. Once the goal's PR is merged, tear down its worktree: run `bunx dobby down` to close the kit-opened cmux panes (killing the dev server) and run the project's cleanup, then delete the branch and pull the main checkout up to date — closing the goal so the tree is ready for the next one.

**One session per goal.** Each goal gets its own worktree; parallel goals run in parallel worktrees (one per cmux pane/session — legitimate and encouraged). `/dobby:finish` tears down THIS goal's worktree after its PR merges — it does not touch other goals' worktrees. Run it (typed, manually) after the PR merges.

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
  - **Cancel — don't destroy** *(Recommended)* — stop; nothing is removed. (The user finishes/merges the PR or handles the uncommitted work first.)
  - **Destroy anyway** — the user accepts losing an unmerged branch and any uncommitted changes; carry that acceptance forward (it authorizes `discard_changes` / `--force` / the branch force-delete in Step 3). Only pick this on the user's explicit say-so.

Do not proceed to teardown on anything but `safe` or an explicit "destroy anyway".

## Step 2: Tear down the run — `bunx dobby down`

Run `bunx dobby down` to tear the run down. It closes the kit-opened cmux panes (which terminates the dev server they host, or kills the detached background process when cmux is absent), deletes the per-worktree Neon branch, and runs the project's `teardown[]` extras from `dobby.config.json` — all the pre-removal cleanup, mechanized. You NEVER enumerate or close panes by hand and NEVER hunt for a background job — `dobby down` owns all of it. A no-app project (no run script, no panes, no `teardown` extras) no-ops cleanly.

- `mode: "same-session"` — the cwd is already inside the worktree: run it there.
- `mode: "orphan"` — run it with the preflight's `worktreePath` as the working directory (e.g. `bash -c 'cd <worktreePath> && bunx dobby down'`), never from the main checkout.

If `dobby down` reports a failure, report it and let the user decide whether to continue removing the worktree — a half-cleaned resource is the user's call, not an auto-force.

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
- [ ] `safe` proceeded without a prompt; `confirm-required` showed the exact state (`reasons[]`, PR state + url, `dirty.files`) and got explicit confirmation via AskUserQuestion (Cancel recommended / Destroy anyway) before anything was destroyed
- [ ] `bunx dobby down` run before removal — inside the worktree same-session, with `worktreePath` as cwd for an orphan; closes the kit cmux panes / kills the detached run, deletes the Neon branch, runs `teardown[]` extras; a no-app project no-ops cleanly; a reported failure surfaced for the user's call, not auto-forced
- [ ] Worktree + branch removed by `removeMechanism`: `ExitWorktree(remove)` same-session (cwd restored to main; `discard_changes` only after the explicit Step 1 confirmation) / raw `git worktree remove <worktreePath>` + `git branch -D <branch>` for `raw-git`, run from `mainRoot` — `-D` because `branchDeleteSafe` (gh MERGED), not git ancestry, is the safe-to-delete signal
- [ ] `git pull` on the main checkout; on conflict/divergence reported and stopped — never forced
- [ ] Ended with an AskUserQuestion gate (goal closed; start the next goal via `/dobby:scope` recommended, or stop here); `/dobby:scope` invoked through the Skill tool on selection
