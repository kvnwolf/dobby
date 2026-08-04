---
name: execute
description: Build an approved plan's tasks — per task, separate agents implement → code-review → verify in a loop until both pass. Use to execute a task plan, standalone or as the execute stage after /dobby:spec.
argument-hint: "[plan or STATE.md]"
---

You are strictly a coordinator. You NEVER implement, review, or verify yourself — you orchestrate a workflow that does. Implementation, code review, and verification are ALWAYS done by SEPARATE agents — never the same agent in two roles.

**Coordinator Bash discipline — pin the root BEFORE the first command.** Every Bash command in this stage — starting with Step 1's, and including your own final checks — must run against THIS session's worktree (the one `/dobby:scope` created and you are working in). Never trust `pwd`: that worktree is nested under the main checkout, so a stray relative path silently lands in main — and `dobby` commands resolve their root from the process cwd, so a mis-rooted `build-plan` would plan MAIN's `STATE.md`, a different plan entirely. `cd` to the session worktree root for the first commands (or pass `build-plan` an absolute `--file`); from `bunx dobby up --json` onward use the `workroot` it reports as that absolute root (it matches `build-plan`'s `workRoot`).

**Confirm dobby is installed before the FIRST `bunx dobby` command** (Step 1's): `[ -f dobby.config.json ] && [ -x node_modules/.bin/dobby ]`, from that worktree root. If either is missing, STOP and point the user to `/dobby:onboard` (this project was never onboarded) or `/dobby:migrate-config` (a legacy vite-plus project not yet migrated) — there is no fallback: both the plan and the run lifecycle live entirely in the local `dobby` bin, and a bare `bunx dobby` on a project without it fetches the UNRELATED npm `dobby` package and fails obscurely.

## Step 1: Load the plan

**`bunx dobby build-plan --json`** turns the spec into the build plan mechanically — you never read the task table by eye, and you never invent waves. It reads `<workroot>/STATE.md`'s `## Spec` by default (`--file <doc>` for a plan that lives elsewhere) and answers:

- `tasks[]` — `{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst, destructive}`, the build-workflow `args` verbatim. `decisions` / `constraints` come back EMPTY by contract: plan-level decisions are yours to distribute per task when you author the workflow (Step 3), because which decision binds which task is judgment, not a table cell.
- `waves[][]` — the parallel batches, already topological over `Depends on`, area-disjoint within a wave, and destructive tasks alone. Run them in order; do not regroup.
- `preconditions` — `{ok, missing[], danglingDeps[], cycles[]}`.
- `hasTestSuite` — `{value, specSays, disagreement}`: what the repo can actually run, what the spec claims, and whether they contradict.
- `manualVerifySetup` — `none` or the developer steps the Step 2 gate waits on.
- `workRoot` — the absolute worktree root.

**Fail-fast, before wave 1:**
- `preconditions.ok === false` → **STOP and route back to `/dobby:spec`**, quoting the payload: each `missing[]` entry as "task `<taskId>` has no `<field>`", plus any `danglingDeps` / `cycles`. Never launch a partial run — a spec gap surfaces mid-wave as `needs-human` only after you've burned agent turns. (Exit is nonzero on a refusal, with the payload still on stdout.)
- `hasTestSuite.disagreement === true` → the spec plans test-first work in a repo with no runnable suite (or the reverse). Say so and settle it before launching; `hasTestSuite.value` is the fact you pass to the workflow.
- No `STATE.md` / no `## Spec` at all (execute run standalone) → `build-plan` errors out. Do NOT fall back to reading the plan by eye: write the plan from the conversation or `$ARGUMENTS` to a scratch doc OUTSIDE the repo (`"$TMPDIR/plan-<slug>.md"`) under a `## Spec` heading, with the task table `../spec/references/task-decomposition.md` describes, and run **`bunx dobby build-plan --file "$TMPDIR/plan-<slug>.md" --json`**. Same payload, same contract — the fields above are never hand-derived, and the waves are still dobby's.

Also read the rest of the doc for context the agents inherit — `## Findings (interview)`, `## Research`, `## Exploration`.

## Step 2: Bring the workspace up (always)

**`bunx dobby up --json`** — one call does the bring-up AND reports the environment (it replaces the old `up` + `env --json` pair). It is idempotent and liveness-first: `/dobby:scope` already ran `up`, so the setup phase is a fast no-op and the run phase starts the dev server only if it isn't already up. You NEVER start a server yourself and you NEVER create, size, or discover panes by hand. Its JSON is the sole stdout; branch on these fields:

- **`ok: false`** → the workspace is NOT up. STOP and report the `reason` (a closed enum: `not-a-git-repo` · `config-unreadable` · `install-failed` · `worktree-copy-failed` · `setup-extra-failed` · `neon-creds-missing` · `dev-start-failed` · `liveness-timeout`) with the human message dobby put on stderr. If `degradedCommand` is non-null (an install-phase failure), offer it as the one mechanical retry — otherwise there is nothing to retry blindly. Launch no workflow against a workspace that never came up.
- **`devUrl`** — the resolved, worktree-aware dev URL (null for a no-app project: a library / CLI / plugin like dobby itself). Pass it to the build workflow as the verifiers' single shared URL. Verifiers check against this ONE URL and must NOT each start their own (parallel starts collide on the port).
- **`verifyMode`** — `url` or `programmatic`, derived from `devUrl`. It's the same branch, pre-decided: `programmatic` means the verify prompt says "no dev server — verify programmatically".
- **`browserPane`** — the kit's cmux browser pane ref, null when cmux is absent. It decides the manual-setup auth surface below (`dobby:verifier` reads the same field, so they converge).
- **`workroot`** — the absolute worktree root: the root you pinned above, now confirmed by dobby. Use it for every remaining Bash command in this stage, and pass it into the workflow as `args.workRoot` (it matches `build-plan`'s `workRoot`; if they differ, you ran Step 1 from the wrong directory — re-run it from `workroot` before launching anything).

**Manual-setup gate — the LAST sub-step of Step 2, after `up --json`, BEFORE launching the build workflow below.** Verifiers can't log themselves in or seed state, so this deterministic gate guarantees they never hit an auth wall or missing seed. Read `manualVerifySetup` from Step 1's `build-plan` payload:
- **`none`** → skip SILENTLY. No prompt, no interruption (the common case — public/backend-only plans, plugins/CLIs).
- **Steps present** → present them to the user via `AskUserQuestion` — an in-stage environment gate (the same precedent as `/dobby:finish`'s destructive confirm, NOT a stage handoff) — and WAIT for confirmation that the setup is done before the build workflow (authored below) launches. No verifier may run before the gate passes. **The gate must direct auth into the ONE surface the verifier will actually drive** — not an ambiguous "browser pane OR Chrome" (in the field the user authenticated in the cmux pane but the verifier drove claude-in-chrome, a DIFFERENT browser with no shared session, and hit `/login`). Decide the surface by `up`'s `browserPane`: **present** (cmux opened the kit browser pane at `devUrl`) → the verifier will drive that `dobby-browser-<slug>` pane, so tell the user to authenticate THERE; **null** (no cmux) → the verifier uses claude-in-chrome, so tell the user to authenticate in that local Chrome at `devUrl`. State it as this deterministic either/or — never an ambiguous "or". List the steps verbatim; offer **Setup done — verify** (proceed) and **Cancel** (stop; don't launch).

(`/dobby:dispatch` reaches the same surfaces through the same two commands.)

## Step 3: Run the build workflow (always)

Always run the build loop as a **Workflow** (the Workflow tool) — author it from `references/build-workflow.md` (the reusable build loop), using the script VERBATIM and filling in only `args`: `tasks` (one wave's entries from `build-plan`, each with the plan-level `decisions` / `constraints` you judged relevant merged in), `devUrl`, `hasTestSuite` (from `hasTestSuite.value`), and `workRoot`. The per-task agents are the custom subagents **`dobby:test-author` (conditional) / `dobby:implementor` / `dobby:reviewer` / `dobby:verifier`**, dispatched via `agentType` — their role instructions live in the agent definitions, NOT passed as args. The workflow runs this per-task state machine, a SEPARATE agent per role:

```
[test-author] → implement → code review → (findings? fix → re-review) → verify → (fail? back to implement → review → verify) → done
```

The leading **test-author** step is gated: it runs ONLY when `hasTestSuite` is true AND the task is marked test-first, writes the tests from the spec alone (once, as the fixed contract — re-dispatched only for the reviewer's `testFindings`, the arbiter extending the contract), and hands the reviewer/verifier a combined tests+code diff. When the gate is closed — no suite (dobby is a plugin with none), or a task that isn't test-first — the loop is byte-for-byte the classic 3-step. This is orthogonal to the `devUrl` branch: the test suite (green) and dynamic litmus are part of the programmatic verify path, exactly the path a `devUrl = null` plugin already uses.

**Refactor only in green.** When a task has a test contract, the implementor changes behavior to make red tests green, then refactors ONLY while the suite is green — never restructuring code while a test is red (a red test during a refactor can't tell you whether the refactor or the pending behavior broke it). This is the implementor's discipline (it lives in `dobby:implementor` / `dobby:test-author`), but the coordinator relies on it: the outer loop's re-implement steps assume the tests are a stable green/red signal, not noise from mid-refactor breakage.

**Waves come from `build-plan`, one workflow run per wave, in order.** They already encode non-overlapping affected areas (overlapping areas serialize) and give a `destructive` task a wave to itself, because the local backend is shared and two destructive verifies must never overlap. Don't merge waves to "save a run".

## Step 4: Record the work log

The workflow returns each task's accumulated `workLog` — the implementors RETURN their entries because the workflow can't write files. You are the single writer, so append them SERIALLY (this is the trap that used to drop every entry but the first), and never by hand-editing `STATE.md`: for each task, write its returned entry to a scratch file outside the repo (`"$TMPDIR/worklog-<id>.md"`) and run **`bunx dobby state append-worklog --task <id> --file <that file>`**. It appends under `## Work log` as `### Task <id>`, demoting the entry's own headings so nothing breaks the document's section structure.

## Step 5: Status and handback

Show a status table. Surface any tasks the workflow flagged `needs-human` (review/verify never passed within the cap). Report what remains for a final human smoke test — only what the machine layers couldn't prove — noting that smoke test happens at `/dobby:wrap`, not here.

## Next step

The build loop is done. Present the next stage as an **AskUserQuestion** — one question that restates execute just finished — with the options below (recommended first, then the alternative, then Stop here). State why in the recommended option. On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn (point to where this stage's output lives, e.g. `STATE.md`).

- **`/dobby:wrap`** *(Recommended)* — final smoke test, reconcile docs/ADRs, dispose `STATE.md`, hand to commit.
- `/dobby:diagnose` — if a task came back `needs-human` or something's broken.
- **Stop here.**

## Language

User-facing output (status) in the user's language. Write all code, comments, docs, and the work log in English; keep domain terms in their real-world form and user-facing UI strings in the product's language.

## Acceptance checklist

- [ ] Dobby install confirmed (`dobby.config.json` + local bin) BEFORE the first `bunx dobby` command — missing STOPs pointing to `/dobby:onboard` / `/dobby:migrate-config`
- [ ] Every Bash command run from the session worktree root (pinned before Step 1, then `up`'s `workroot`) — never a relative path trusted to `pwd`
- [ ] Plan loaded via `bunx dobby build-plan --json` (tasks/waves/preconditions/hasTestSuite/manualVerifySetup/workRoot) — never by reading the task table by eye; a standalone run wrote the conversation plan to a scratch `## Spec` doc and used `--file`
- [ ] `preconditions.ok === false` → STOPPED and routed back to `/dobby:spec`, quoting `missing[]` (+ dangling deps / cycles); `hasTestSuite.disagreement` surfaced
- [ ] Workspace brought up with `bunx dobby up --json`; `ok:false` STOPped naming the `reason` (+ `degradedCommand` when offered); `devUrl` / `verifyMode` / `browserPane` / `workroot` taken from that payload (nothing started or discovered by hand)
- [ ] Manual-setup gate honored at end of Step 2: `none` skips silently; steps prompt (AskUserQuestion, in-stage) and block the workflow until the user confirms setup in the ONE surface `browserPane` selects
- [ ] Build loop ran as a workflow authored VERBATIM from `references/build-workflow.md`, `args` only (tasks, devUrl, hasTestSuite, workRoot); test-author (when gated in) / implement / review / verify done by SEPARATE agents (via `agentType`)
- [ ] Test-author gated correctly: runs ONLY when `hasTestSuite` AND the task is test-first, once per task (plus reviewer-`testFindings` contract extensions, never implementor-initiated); otherwise the loop is the classic 3-step
- [ ] State machine respected: (test-author →) review gates before verify; verify-fail restarts implement→review→verify (with a cap), always against the same authored tests
- [ ] Waves run in `build-plan`'s order, one workflow run per wave — not regrouped, not merged; destructive verifies never overlap
- [ ] Each task's work-log entry appended with `bunx dobby state append-worklog --task <id> --file <f>`, serially by the coordinator (single writer, STATE.md never hand-edited)
- [ ] `needs-human` tasks surfaced; final smoke items handed to the user (for `/dobby:wrap`)
- [ ] No commits by any agent
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
