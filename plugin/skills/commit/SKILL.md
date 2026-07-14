---
name: commit
description: Wraps up work by running the project's pre-commit checks, syncing documentation, committing, pushing, and opening a pull request. Use when committing code, finishing a task, pushing changes, or creating a PR.
allowed-tools: Bash(git diff *), Bash(git log *), Bash(git add *), Bash(git branch)
---

# Commit

## Step 1: Require Commit Config

Check if `dobby.config.json` exists. If it exists, continue to step 2.

If not, the project hasn't been set up for harness-driven commits — that config (doc-sync rules + pre-commit checks) is created by `/dobby:onboard`, which can't be auto-invoked. Offer with AskUserQuestion:

- **Set up the project first** *(Recommended)* — stop here and have the user type `/dobby:onboard` (it creates the config along with the rest of the project setup), then re-run `/dobby:commit`.
- **Commit once without the contract** — proceed, skipping doc-sync (step 4-5) and pre-commit checks (step 6) for this commit only. Don't create the config ad hoc.

## Step 2: Gather Context

Run each command separately:

1. `git diff --staged`
2. Only if step 1 had NO output: `git diff`
3. `git log --oneline`

## Step 3: Determine Staging

- If `git diff --staged` has output -> use as-is (user curated manually)
- If empty -> run `git add -A` to stage everything

## Step 4: Sync Documentation

1. Read `files` from `dobby.config.json`
2. Find staged `*.md` files not in the config that could be documentation (excluding `skills/`), detect their update condition, register them
3. For each tracked file, evaluate whether `update_when` is met by staged changes
4. Read and update every file whose condition is met
5. If new files were registered in step 2, persist the updated config

## Step 5: Stage Documentation

```bash
git add <updated-doc-files>
```

## Step 6: Run Pre-commit Checks

The `checks` list in `dobby.config.json` is the project's pre-commit gate — the harness runs it, replacing git pre-commit hooks.

**Check schema.** Each entry has `name`, `run`, and an optional `scope` that classifies *what the check reads*:

- `scope: staged` — the check should only inspect the files being committed. Pass it the staged paths: resolve them with `git diff --staged --name-only` and template that list into the `run` command. Use for per-file tools whose verdict is local to the diff — formatters, linters, per-file validators. This keeps pre-existing violations elsewhere in the tree from blocking an unrelated commit.
- `scope: tree` (the default when `scope` is absent) — the check validates the whole working tree regardless of what's staged. Use for whole-program checks that can break from a staged change even in files you didn't touch — typecheck, build, test suite, cross-file manifest/parse gates.

When in doubt, prefer `tree`: it's the safe default (a passing tree is always commit-safe). Only mark a check `staged` when running it tree-wide would surface noise the current commit isn't responsible for.

1. Read `checks` from the config. If absent or empty, skip this step.
2. Run each check's `run` command sequentially, from the repo root, at its declared `scope` per the schema above.
3. **Any failure aborts the commit.** Report the failing check and its output verbatim, then stop — never commit on top of a red check, and never "pass" it by skipping or weakening it. Fixing the failure is the user's call (or the calling stage's).
4. If a check legitimately modified files (e.g. a formatter in write mode), re-stage only the paths that were already staged, then re-run the checks ONCE. A second mutation round means the check is misconfigured — stop and report.

## Step 7: Generate and Execute Commit

**Subject:** semantic commit format (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `perf:`, `style:`, `build:`). Lowercase imperative, no period, max 70 chars. Use scope when it adds clarity.

**Body:** explain **why** — motivation, trade-offs, decisions. State breaking changes explicitly.

**References:** if the session traces to a GitHub issue — from `## Source` in `STATE.md` if it still exists (`/dobby:wrap` disposes of it), else evident from the conversation — put `Closes #<n>` on its own line. Don't fabricate a number you can't source.

Execute with HEREDOC:

```bash
git commit -m "$(cat <<'EOF'
feat: subject line describing what changed

Body explaining why this change was made.

Closes #issue (if applicable)
EOF
)"
```

## Step 8: Push

```bash
git push -u origin HEAD
```

## Step 9: Pull Request

Only if branch was pushed in step 8.

1. Run `git branch` — if on `main`, stop
2. Generate PR title and body:
   ```bash
   git log <base-branch>..HEAD --oneline
   git diff <base-branch>...HEAD
   ```
3. Create PR. If the session traces to a GitHub issue (same source as step 7), put `Closes #<n>` in the **body** — that's the reliable close-on-merge anchor (it survives a squash-merge, unlike a per-commit trailer):
   ```bash
   gh pr create --title "<title>" --body "$(cat <<'EOF'
   ## Summary
   <bullet points from commit analysis>

   ## Test plan
   <checklist>

   Closes #<n>   <!-- only if the session started from an issue; omit the line otherwise -->
   EOF
   )"
   ```

## Next step

The PR is open. Present the next stage as an **AskUserQuestion** — one question that restates commit just finished (the PR is open, waiting on merge) — with the options below (recommended first, then Stop here). On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn.

- **`/dobby:finish`** *(Recommended, after the PR is merged)* — on the **terminal host** (the kit created a worktree for this goal at `/dobby:scope`), tear down the worktree: close the dev server, remove the worktree + branch, and pull main up to date. Under Conductor there's nothing to tear down (archive the workspace from Conductor instead).
- **Stop here** — the PR still needs to merge first; come back to `/dobby:finish` once it's merged.

## Acceptance checklist

- [ ] Commit config exists at `dobby.config.json` (or the user explicitly chose a one-off contract-less commit; `/dobby:onboard` suggested)
- [ ] Documentation synced with staged changes
- [ ] Pre-commit checks ran green (or none configured), each at its declared `scope`; commit aborted on any failure
- [ ] Commit message follows semantic format with body
- [ ] Changes pushed to remote
- [ ] PR created (if not on main); `Closes #<n>` in the PR body if the session traces to a GitHub issue
