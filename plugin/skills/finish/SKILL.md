---
name: finish
description: Post-merge worktree teardown — use when the PR of the current goal's worktree is merged and you want to clean up and return to main. Terminal-host command; under Conductor it no-ops (the workspace is Conductor's to archive).
---

The terminal end of a work session. Once the goal's PR is merged, tear down its worktree, close the kit-opened cmux panes (killing the dev server), delete the branch, and pull the main checkout up to date — closing the goal so the tree is ready for the next one.

**One session per goal.** Each goal gets its own worktree; parallel goals run in parallel worktrees (one per cmux pane/session — legitimate and encouraged). `/dobby:finish` tears down THIS goal's worktree after its PR merges — it does not touch other goals' worktrees. Run it (typed, manually) on the **terminal host** after the PR merges.

## Step 0: Host check — Conductor no-ops

`/dobby:finish` owns teardown only on the **terminal host** (plain `claude`, incl. ssh/cmux), where the KIT created the worktree. Detect the host:

- `CONDUCTOR_WORKSPACE_PATH` is set → **Conductor host**. The workspace IS the worktree, and Conductor owns its lifecycle (archival is a Conductor UI action, not a git op). There is nothing for the kit to remove. Say so plainly — "Under Conductor, the worktree is the workspace; archive it from Conductor when the PR is merged. `/dobby:finish` has nothing to tear down here." — and **stop**. Do not run any git/gh/cmux teardown.
- Otherwise → **terminal host**. Continue.

## Step 1: Precondition check — identify the target worktree

Determine which worktree this finish targets and in which mode:

- **Same-session** — this `claude` session created the worktree via `EnterWorktree` during `/dobby:scope`, so the session is still inside it (cwd under `.claude/worktrees/<slug>/`). This is the common path: the goal's slug and branch (`worktree-<slug>`) are known from the current worktree, and teardown will use the native `ExitWorktree`.
- **Orphan mode** — no active kit-worktree session (the session that created it died/was closed, and you're back in the main checkout). List `.claude/worktrees/` (or `git worktree list`) to find candidates, and **confirm the target with the user** before touching anything — pick the one whose branch matches the merged PR. Teardown will use raw git from the main checkout (native `ExitWorktree` only removes worktrees the CURRENT session made).

Resolve the target's **slug**, **branch** (`worktree-<slug>`), and **path** (`.claude/worktrees/<slug>/`) now — every later step keys off them.

## Step 2: Merge check — never blind-destroy

Confirm the PR is merged before destroying anything. For the target branch:

```bash
gh pr view <branch> --json state,mergedAt,url
```

- **`state: "MERGED"`** and the worktree tree is clean → proceed to Step 3 without a prompt.
- **Anything else** — `OPEN`, `CLOSED` (not merged), no PR for the branch, or **uncommitted changes in the worktree** (`git -C <path> status --porcelain` is non-empty) → this is a destructive-action gate, so **show the exact state** (PR state + URL, and the dirty-file list if any) and require **explicit user confirmation** before removing the worktree/branch. Use `AskUserQuestion` here — an in-stage destructive-action gate, NOT a stage handoff:
  - **Cancel — don't destroy** *(Recommended)* — stop; nothing is removed. (The user finishes/merges the PR or handles the uncommitted work first.)
  - **Destroy anyway** — the user accepts losing an unmerged branch and any uncommitted changes; carry that acceptance forward (it authorizes `discard_changes` in Step 5). Only pick this on the user's explicit say-so.

Do not proceed to teardown on anything but a MERGED-clean state or an explicit "destroy anyway".

## Step 3: Teardown commands

Run the `teardown` array from `dobby.config.json` (if the key is present) **from inside the worktree** — these are the project's own pre-removal cleanup commands (stop a container, drop a scratch DB, etc.):

- Same-session: the cwd is already inside the worktree — run them there.
- Orphan mode: run them with the worktree path as the working directory (e.g. `bash -c 'cd <path> && …'`), never from the main checkout.

No `dobby.config.json`, or no `teardown` key (a no-app project like a lib/plugin, or a repo never onboarded) → skip this step silently. If a teardown command fails, report it and let the user decide whether to continue removing — a half-cleaned resource is the user's call, not an auto-force.

## Step 4: cmux pane cleanup

Close the kit-opened cmux panes so the dev server dies with them. Panes carry no persisted state — they're found by where `/dobby:execute` opened them: both panes carry the `dobby-*-<slug>` title (set via `rename-tab`) and live at the worktree `cwd`, and the `new-workspace` fallback carries the workspace title `dobby-run-<slug>`:

- **cmux present** (`CMUX_WORKSPACE_ID` is set) → **enumerate EVERY pane, not just the focused one**, then match by title (`dobby-run-<slug>` / `dobby-browser-<slug>`) and/or `cwd` (= the worktree path). Use this recipe verbatim — re-read the workspace id FRESH in the current (finish) turn — it changes between turns, never trust a value cached from the execute turn:

  ```bash
  WS="$CMUX_WORKSPACE_ID"
  cmux list-panes --workspace "$WS"                 # every pane ref (pane:1, pane:2, …)
  # list-pane-surfaces defaults to the FOCUSED pane only — you MUST iterate every pane:
  for p in <each pane ref from list-panes>; do
    cmux list-pane-surfaces --workspace "$WS" --pane "$p"   # surfaces + titles for THAT pane
  done
  ```

  Match surfaces by title (`dobby-run-<slug>` / `dobby-browser-<slug>`, set via `rename-tab`) and/or `cwd`=worktree path — the run terminal pane and the browser pane; if the `new-workspace` fallback was used, match its workspace title `dobby-run-<slug>` too. Refs look like `surface:N`; close each matched one:

  ```bash
  cmux close-surface --workspace "$WS" --surface <surface-ref>
  ```

  Closing the run terminal pane terminates the dev server it hosts. **Do NOT report panes as closed based on the focused-pane default** — `list-pane-surfaces` without `--pane` shows only the focused pane's surfaces, which will falsely read as "the dobby panes are already gone" while the dev server keeps running. Only report closed the surfaces you actually enumerated (across every pane) and closed with `close-surface`.
- **No cmux** (`CMUX_WORKSPACE_ID` unset) → skip pane cleanup silently. If `/dobby:execute` started `run` as a background Bash job (the non-cmux fallback), kill that job instead so the dev server stops.

## Step 5: Remove the worktree + branch

Now remove the worktree and its branch. The mechanism depends on the mode from Step 1:

The authoritative merge signal is the **Step 2 `gh pr view` = MERGED gate**, not git's branch-ancestry check. This matters because most repos **squash-merge** PRs: after a squash-merge the feature branch tip is a different commit (new SHA/tree) that is NOT an ancestor of main, so git's own "is this branch merged?" test (`git branch -d`) reports it as **unmerged even though the PR is legitimately merged**. Once Step 2 says MERGED, the branch is safe to delete regardless of what `-d` thinks.

- **Same-session** → native **`ExitWorktree`** with `remove`: it deletes the worktree directory and its branch AND restores the cwd to the main checkout (this is why native is preferred same-session — raw git leaves you stranded inside a directory it just deleted). Only pass `discard_changes: true` if the user explicitly confirmed "destroy anyway" in Step 2 over uncommitted changes; on the clean MERGED path, no discard. If `ExitWorktree(remove)` reports the branch as unmerged and refuses to delete it (the squash-merge case above), that's expected — it does NOT contradict the Step 2 MERGED verdict; delete the leftover branch with the force delete below.
- **Orphan mode** → raw git, run **from the main checkout** (never from inside the target worktree — you'd be removing the ground under your feet):

  ```bash
  git worktree remove <path>          # add --force ONLY if the user confirmed destroying a dirty tree in Step 2
  git branch -D worktree-<slug>        # force-delete: after a squash-merge -d always refuses a legitimately-merged branch
  ```

  Use `-D` here on purpose: the Step 2 MERGED gate is the authoritative "safe to delete" signal, and `-d` would refuse a squash-merged branch (its tip isn't an ancestor of main) even though the PR merged cleanly — following `-d` would strand the user on every normal finish. The safety net is Step 2, not git's ancestry check. (If Step 2 was NOT a clean MERGED but the user chose "destroy anyway", `-D` is likewise what carries that acceptance forward.)

## Step 6: Update main

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

- [ ] Host checked first: under Conductor, said so and no-op'd (nothing removed); only the terminal host proceeds
- [ ] Target worktree identified as same-session (inside it) or orphan (confirmed with the user from `.claude/worktrees/`); slug/branch/path resolved
- [ ] Merge check via `gh pr view <branch> --json state,mergedAt,url`: MERGED-and-clean proceeds; anything else (open/closed/no PR/dirty) shows the exact state and gets explicit user confirmation (AskUserQuestion) before destroying
- [ ] `teardown` commands from `dobby.config.json` run from inside the worktree (skipped silently when absent)
- [ ] cmux run/browser panes for `dobby-run-<slug>` / `dobby-browser-<slug>` found by re-reading `CMUX_WORKSPACE_ID` FRESH this turn (it changes between turns) then enumerating EVERY pane — `cmux list-panes --workspace "$WS"`, then `cmux list-pane-surfaces --workspace "$WS" --pane <ref>` per pane (NOT the focused-pane default, which under-reports) — matched by title and/or `cwd`=worktree path, and closed with `cmux close-surface --workspace "$WS" --surface <ref>` — killing the dev server; reported closed ONLY the surfaces actually enumerated and closed; without cmux, skipped silently (bg run job killed if one exists)
- [ ] Worktree + branch removed: `ExitWorktree(remove)` same-session (cwd restored to main; `discard_changes` only after explicit Step 2 confirmation) / raw `git worktree remove` + `git branch -D worktree-<slug>` for orphans, run from the main checkout — `-D` because a squash-merged branch reads as unmerged to `-d`; Step 2 MERGED is the authoritative safe-to-delete signal
- [ ] `git pull` on the main checkout; on conflict/divergence reported and stopped — never forced
- [ ] Ended with an AskUserQuestion gate (goal closed; start the next goal via `/dobby:scope` recommended, or stop here); `/dobby:scope` invoked through the Skill tool on selection
