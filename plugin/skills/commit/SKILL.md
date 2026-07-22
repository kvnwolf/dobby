---
name: commit
description: Syncs documentation, authors the commit message + PR body, runs the gate and performs the git/gh ceremony directly (stage → `dobby check --fix` → commit → push → PR), then monitors the PR to a verdict. Use when committing code, finishing a task, pushing changes, or creating a PR.
allowed-tools: Bash(git *), Bash(gh *), Bash(bunx dobby check *), Write
---

# Commit

The skill owns **judgment** — which docs to sync, what the message says, whether a PR is opened — AND performs the git/gh **mechanics** directly: stage, run the gate, commit, push, and open the PR. `bunx dobby check --fix` is the standardized pre-commit gate (project-wide safe fixes first, then the full quality gate); everything around it is plain `git`/`gh`. Opening the PR is **not** the finish line: the skill then stays on watch — CI to green, review to a verdict — and only hands off once the PR is merge-ready (it never merges).

## Step 1: Require the commit config

Check if `dobby.config.json` exists. If it exists, continue to step 2.

If not, the project hasn't been set up for harness-driven commits — that config (the doc-sync rules) is created by `/dobby:onboard`, which can't be auto-invoked. Offer with AskUserQuestion:

- **Set up the project first** *(Recommended)* — stop here and have the user type `/dobby:onboard` (it installs `dobby` and creates the config), then re-run `/dobby:commit`.
- **Commit once without the contract** — proceed with a bare `git commit` for this commit only, skipping doc-sync (step 3) and the `dobby check --fix` gate (step 5). Don't create the config ad hoc.

The gate `bunx dobby check --fix` needs `dobby` installed as the repo's devDependency. If `dobby.config.json` exists but `bunx dobby` fails as not installed, STOP and point to `/dobby:onboard` (or `/dobby:migrate-config` for a repo moving off an old contract) — the kit assumes `dobby` is the repo's single devDependency; there is no fallback.

## Step 2: Gather context

Run each command separately to author the message (and PR body, if opening a PR):

1. `git diff --staged`
2. Only if step 1 had NO output: `git diff`
3. `git log --oneline`

## Step 3: Sync documentation

Which DOCS to update is judgment the skill owns, from `dobby.config.json`'s `files`:

1. Read `files` from `dobby.config.json`.
2. Find changed `*.md` files not in the config that could be documentation (excluding `skills/`), detect their update condition, register them.
3. For each tracked file, evaluate whether `update_when` is met by the changes.
4. Read and update every file whose condition is met.
5. If new files were registered in step 2, persist the updated config.

Leave the updated docs unstaged for now — step 5 stages the tree (`git add -A` when nothing is staged yet), so these edits are picked up with everything else.

## Step 4: Author the commit message (and PR body)

**Subject:** semantic commit format (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `perf:`, `style:`, `build:`). Lowercase imperative, no period, max 70 chars. Use a scope when it adds clarity.

**Body:** explain **why** — motivation, trade-offs, decisions. State breaking changes explicitly. If the session traces to a tracked goal — its id from `## Source` in `STATE.md` if it still exists (`/dobby:wrap` disposes of it), else evident from the conversation — add the tracker's **lifecycle-link** magic word on its own line, using the recipe in [`../backlog/references/trackers.md`](../backlog/references/trackers.md). Read the `tracker` key from `dobby.config.json` narratively (absent → `github`): `Closes #<n>` for github, `Fixes VON-123` for linear (Linear's native GitHub integration drives In Review on PR-open and Done on merge — make **no** MCP call; the magic word text is the entire linear responsibility), nothing for local. Don't fabricate an id you can't source.

**Branch guard — decide whether to open a PR:** run `git branch`. On `main`, commit without opening a PR. On any other branch, author a rich PR body and open one.

**PR body (only off `main`):** write the PR body to a temp file with the `Write` tool — a `## Summary` (bullets from the commit analysis) + a `## Test plan` checklist, and the tracker's lifecycle-link magic word in the **body** when the session traces to a tracked goal (per the same `trackers.md` recipe — the body is the reliable close-on-merge anchor, surviving a squash-merge unlike a per-commit trailer). Pass that file to `gh pr create --body-file` in Step 5.

## Step 5: Run the gate, then commit, push, and open the PR

Perform the ceremony directly, in order. `bunx dobby check --fix` is the ONE gate — never run the individual checks (biome/tsc/knip/build/vitest) yourself.

1. **Stage.** If nothing is staged yet (`git diff --staged --quiet` exits 0), stage the whole tree: `git add -A` (this picks up the doc updates from step 3). If the caller already staged a subset, respect it.
2. **Gate — `bunx dobby check --fix`.** It applies project-wide safe Biome fixes first, then runs the full quality gate (biome, tsc, knip, capability-gated build + vitest). If it reports findings (non-zero exit), STOP: report its output verbatim and abort the commit — fixing the failure is the user's call (or the calling stage's).
3. **Re-stage if `--fix` mutated files.** After a green gate, `git add -A` again so any files the formatter rewrote land in the commit.
4. **Commit.** Write the full message (subject + blank line + body + `Closes #<n>`) verbatim. Use a here-doc or `git commit -F -` so the multi-line body survives intact:

   ```bash
   git commit -F - <<'EOF'
   feat: subject line describing what changed

   Body explaining why this change was made.

   <lifecycle-link magic word for the configured tracker — Closes #<n> (github) / Fixes VON-123 (linear) / nothing (local); omit the line entirely when there's no linkage or the session didn't start from a tracked goal>
   EOF
   ```

5. **Push.** `git push`; if the branch has no upstream, `git push -u origin HEAD`.
6. **PR (off `main` only).** Open it with the body authored in step 4:

   ```bash
   gh pr create --body-file <path> [--title "<title>"]
   ```

   If a PR already exists on the branch, the push in step 5 already updated it — note that and finish (don't try to re-create it).

## Step 6: Monitor the PR to a verdict

Opening the PR is not the finish line — and a green local gate proves only the TREE, not the PIPELINE (deploys can run steps the gate can't: external builders' own typechecks, envless CI runners), which is exactly why this step watches the PR to a verdict instead of trusting green. Stay on watch until it reaches a verdict. **Skip this whole step when you committed on `main`** (no PR was opened): go straight to the Next step.

1. **Watch CI to green.** Watch the newest run on the PR branch to completion — `gh pr checks --watch` (or `gh run watch` on the branch's latest run id). On **CI failure**, diagnose from the failing step's log — `bunx dobby check` now prints a raw stderr tail when a tool fails without producing findings, so read that tail — and route the fix through the normal delegation rules: a worker, **never** an inline edit. Push the fix and re-watch. Loop until CI is green.
2. **Wait for the review round — only when a review bot is configured.** A few minutes after CI lands, detect a bot by fetching the PR's review threads + the edited-in-place bot summary comment. Don't duplicate those mechanics here — they live in `/dobby:address-review`'s references: the thread fetch + summary read in [`../address-review/references/github-api.md`](../address-review/references/github-api.md), the bot registry in [`../address-review/references/adapters.md`](../address-review/references/adapters.md). **Bound the wait:** if nothing is posted ~5 min after CI goes green, report the PR as **open + unreviewed** and end — never poll forever.
3. **Feedback present → hand to `/dobby:address-review`.** Unresolved threads or a below-gate confidence → invoke **`/dobby:address-review`** via the Skill tool. It owns triage (with its human gate), the fixes, thread resolution, and the re-trigger; don't reimplement any of that here.
4. **Clean → report MERGE-READY.** CI green and no unresolved feedback → state plainly that the PR is merge-ready. **NEVER merge it yourself — merging is always the user's call.**

## Next step

The commit landed, and — off `main` — the monitor has run to its verdict (CI watched to green, feedback routed to `/dobby:address-review`, or the PR reported merge-ready / open + unreviewed). Present the next stage as an **AskUserQuestion** — one question that restates where things landed (the PR is monitored and waiting on **your** merge; the skill never merges) — with the options below (recommended first, then Stop here). On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn.

- **`/dobby:finish`** *(Recommended, after you merge the PR)* — the kit created a worktree for this goal at `/dobby:scope`; tear down the worktree: close the dev server, remove the worktree + branch, and pull main up to date.
- **Stop here** — the PR still needs your merge first (or is waiting on review); come back to `/dobby:finish` once it's merged.

## Acceptance checklist

- [ ] Commit config exists at `dobby.config.json` (or the user explicitly chose a one-off contract-less commit; `/dobby:onboard` suggested); missing local `dobby` bin → stopped, pointed to `/dobby:onboard` / `/dobby:migrate-config`
- [ ] Documentation synced with the changes per `files` (doc-sync is the skill's judgment); updated docs left unstaged so step 5's `git add -A` picks them up
- [ ] Commit message authored in semantic format with a why-body; the tracker's lifecycle-link magic word in the commit body/PR body per [`../backlog/references/trackers.md`](../backlog/references/trackers.md) — `Closes #<n>` (github) / `Fixes VON-123` (linear) / nothing (local), and no MCP call — when the session traces to a tracked goal
- [ ] Branch guard applied: on `main` → no PR; off `main` → `gh pr create --body-file` with the authored PR body
- [ ] Ceremony performed directly in order: staged (`git add -A` if nothing staged) → `bunx dobby check --fix` gate → re-stage mutated files → `git commit` → `git push` (`-u origin HEAD` if no upstream) → PR; the gate is `dobby check --fix` alone (never the individual checks); gate failure reported verbatim and commit aborted
- [ ] Off `main`: PR monitored to a verdict — CI watched to green (any failure diagnosed from the log's raw stderr tail and fixed via a worker, never inline, then re-watched); a configured review bot's feedback routed to `/dobby:address-review` (detection pointed at that skill's references, not duplicated), or the PR reported merge-ready / open + unreviewed after a bounded ~5-min wait; the skill NEVER merged the PR (merging is the user's call)
