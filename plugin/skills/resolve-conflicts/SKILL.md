---
name: resolve-conflicts
description: Resolve an in-progress merge, rebase, or cherry-pick conflict by recovering each side's intent from history and PRs, then reconciling every hunk without losing either side's behaviour.
disable-model-invocation: true
---

You are the coordinator/architect. You run the git/`gh` mechanics yourself and you synthesize each side's intent from history (reading-for-synthesis is allowed), but you NEVER edit conflicted files — every hunk resolution goes to a worker. Take an in-progress conflict from "unmerged paths" to "resolved, checks green, merge/rebase finished."

Two guardrails hold across every step:

- **Never invent behaviour.** A resolution may only combine or choose between what the two sides already do. If neither side does something, the merge doesn't either — inventing a third behaviour is out of scope and belongs in a follow-up, not here.
- **Always resolve; never `--abort`.** Aborting throws away the reconciliation work and the intent you recovered. Push through to a finished merge/rebase. If you truly can't reconcile a hunk, stop and ask the user — do not abort.

## Step 1: See the current state

Establish what operation is in flight and which files conflict — never guess.

```bash
git status                                   # MERGING / REBASING / CHERRY-PICKING + unmerged paths
git diff --name-only --diff-filter=U         # exactly the conflicting files
git log --oneline -5 HEAD MERGE_HEAD 2>/dev/null   # both tips (MERGE_HEAD only during a merge)
```

For a rebase, `git status` names the commit being replayed; `git log --oneline -5 REBASE_HEAD` shows it. Note the **merge goal** — the stated reason for the merge/rebase (the branch name, the PR title, or ask the user). It's the tie-breaker in Step 3.

## Step 2: Recover the INTENT per hunk

For every conflicting hunk, understand *why* each side made its change — the intent, not just the diff. Never resolve a hunk whose purpose you can't state in one sentence per side.

- `git log --oneline -L <start>,<end>:<file>` or `git log -p --follow -- <file>` — the commits that produced each side of the hunk, with their messages.
- `git log --merge -p -- <file>` — only the commits that differ between the two sides for that file (the ones actually in conflict).
- PRs and issues carry the *why* the commit message compresses out. Per `../address-review/references/github-api.md`: `gh pr list --search "<commit-sha>" --state all`, then `gh pr view <N> --comments --json title,body,comments,reviews` for the discussion. For the ticket the PR closes, read it via the **view goal** recipe in `../backlog/references/trackers.md` (github: `gh issue view <N> --comments`; linear: the MCP tool that fetches the issue by identifier; local: the matching `BACKLOG.md` line) — so a Linear project recovers intent from Linear issues via the MCP.

Write down, per hunk: **their intent**, **our intent**, and whether the two are **compatible** (both can hold) or **incompatible** (only one can).

## Step 3: Resolve each hunk — delegate, never edit inline

The architect does not edit conflicted files. Dispatch `dobby:implementor` (Agent tool, `subagent_type: "dobby:implementor"`) with, per hunk: the file + marker location, **both recovered intents**, and the resolution rule below. Batch all hunks in one file (and trivially-related files) into ONE implementor call; parallel implementors only on **non-overlapping** files (same rule as `/dobby:execute` waves).

The resolution rule the implementor applies to each hunk:

- **Compatible** → preserve BOTH intents in the merged code. This is the default and the common case.
- **Incompatible** → pick the side matching the **merge goal** from Step 1, and record the trade-off (what the other side wanted, and why it lost) for the commit body and any ADR.
- **Never invent behaviour** — the merged code does only what one side or the other already did; no new third path.

The implementor removes every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`), keeps the tree green (build/type/lint), and does NOT stage or commit. If it believes a hunk can't be reconciled without inventing behaviour, it flags that in its work-log rather than guessing — you bring that back to the user.

## Step 4: Run the project's discovered checks

The resolution is validated by the project's own gate, not by eyeballing. Read `checks` from `dobby.config.json` and run each `run` command in order from the repo root — typically typecheck → tests → format. This is the same authority `/dobby:commit` uses.

- Any check fails → the merge broke something. Send the failure (command + output verbatim) back to `dobby:implementor` to fix, then re-run the checks. Never weaken or skip a check to make it pass.
- No `dobby.config.json` → the project has no discovered gate. Fall back to whatever the repo documents (its `package.json` scripts, `justfile`, CI config) and say plainly which checks you ran; suggest the user TYPE `/dobby:onboard` to establish the contract for next time.

## Step 5: Finish the merge/rebase

Only after Step 4 is green. Stage the resolved files, then hand the actual commit to `/dobby:commit` (it re-runs the checks, syncs docs, and writes the message) — you do NOT commit here.

- **Merge:** `git add <resolved-files>`, then suggest the user TYPE `/dobby:commit` to complete the merge commit.
- **Rebase:** stage the resolved files, then `git rebase --continue`. This replays the NEXT commit — which may raise a fresh conflict. Loop back to Step 1 for each one until `git status` reports the rebase is done. Then suggest `/dobby:commit` for any follow-up.
- **Cherry-pick:** `git add <resolved-files>`, then `git cherry-pick --continue`.

## Next step

Present an **AskUserQuestion** restating where conflict resolution landed, with the applicable next-step routes as options (recommended first, plus **Stop here**). On selection, invoke the chosen `/dobby:<skill>` via the Skill tool; **Stop here** ends the turn.

- **Rebase still replaying** → loop back to Step 1 for the next conflicted commit; don't stop until `git status` says the rebase is complete. Stop here.
- **Resolved and staged** → **`/dobby:commit`** *(Recommended)* to finish the commit and open/update the PR.
- **An incompatible hunk forced a trade-off (Step 3)** → it's an ADR candidate; **`/dobby:wrap`** captures it (hard-to-reverse ∧ surprising ∧ real trade-off).

## Language

Interact with the user in their language. Code, comments, commit messages, and ADRs in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Current state established: operation in flight (`git status`) and the exact conflicting files (`--diff-filter=U`) identified — never guessed
- [ ] Per hunk, BOTH sides' intent recovered from commits/PRs/issues and stated in one sentence each; nothing resolved whose purpose is unclear
- [ ] Every hunk resolved by `dobby:implementor` (architect edited no conflicted file): compatible → both intents preserved; incompatible → merge-goal side chosen and trade-off recorded; no invented behaviour
- [ ] Project's discovered checks (`dobby.config.json`) run green; failures fixed via implementor, never weakened or skipped
- [ ] Merge/rebase NOT aborted; resolved files staged; commit handed to `/dobby:commit`; rebases looped to completion
- [ ] Any incompatible-hunk trade-off surfaced as an ADR candidate for `/dobby:wrap`

<!-- Adapted from mattpocock/skills (engineering/resolving-merge-conflicts). -->
