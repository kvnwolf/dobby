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

- `tasks[]` — `{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst, dependsOn, destructive}`, the full task objects the build run consumes (Step 3 puts them into `args.waves` — carry every field through, `dependsOn` included: it is what lets the run skip a failed task's dependents). `decisions` / `constraints` come back EMPTY by contract: plan-level decisions are yours to distribute per task when you author the workflow (Step 3), because which decision binds which task is judgment, not a table cell.
- `waves[][]` — the parallel batches as arrays of task *ids*, already topological over `Depends on`, area-disjoint within a wave, and destructive tasks alone. Step 3 zips each id against `tasks[]` and hands the waves — in this order — to the single build run; never regroup them.
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

## Step 3: Run the build run (always)

The WHOLE plan goes into **ONE Workflow invocation** — the **build run** (`meta.name: 'build-run'`). Author it from `references/build-workflow.md` (the reusable build loop), using the script VERBATIM and filling in only `args`:

- **`waves`** — `build-plan`'s `waves[][]`, **zipped into FULL task objects**. `build-plan` reports each wave as an array of task *ids* next to a separate `tasks[]`, so map every id to its `tasks[]` entry: each wave entry must be the whole object (`{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst, dependsOn}`). Merge into each task the plan-level `decisions` / `constraints` you judged relevant (they come back EMPTY by contract — that distribution is your judgment, not a table cell), and keep the entry's `dependsOn` intact: the script reads it to skip the dependents of a task that ended badly. A wave of bare ids makes the run THROW immediately, by design — before a single agent burns tokens.
- **`devUrl`** (Step 2's, or null), **`hasTestSuite`** (from `hasTestSuite.value`), **`workRoot`** (Step 2's `workroot`).

The per-task agents are the custom subagents **`dobby:test-author` (conditional) / `dobby:implementor` / `dobby:reviewer` / `dobby:verifier`**, dispatched via `agentType` — their role instructions live in the agent definitions, NOT passed as args. The run puts every task through this state machine, a SEPARATE agent per role:

```
[test-author] → implement → code review → (findings? fix → re-review) → verify → (fail? back to implement → review → verify) → done
```

The leading **test-author** step is gated: it runs ONLY when `hasTestSuite` is true AND the task is marked test-first, writes the tests from the spec alone (once, as the fixed contract — re-dispatched only for the reviewer's `testFindings`, the arbiter extending the contract), and hands the reviewer/verifier a combined tests+code diff. When the gate is closed — no suite (dobby is a plugin with none), or a task that isn't test-first — the loop is byte-for-byte the classic 3-step. This is orthogonal to the `devUrl` branch: the test suite (green) and dynamic litmus are part of the programmatic verify path, exactly the path a `devUrl = null` plugin already uses.

**Refactor only in green.** When a task has a test contract, the implementor changes behavior to make red tests green, then refactors ONLY while the suite is green — never restructuring code while a test is red (a red test during a refactor can't tell you whether the refactor or the pending behavior broke it). This is the implementor's discipline (it lives in `dobby:implementor` / `dobby:test-author`), but the coordinator relies on it: the outer loop's re-implement steps assume the tests are a stable green/red signal, not noise from mid-refactor breakage.

**Waves come from `build-plan`, in order, never regrouped or merged — and they run INSIDE the single build run.** The script sequences them itself (wave after wave, the tasks inside a wave at once), so the safety the plan encoded survives as that internal structure: non-overlapping affected areas within a wave (overlapping areas serialize into later waves) and a `destructive` task alone in its own wave, because the local backend is shared and two destructive verifies must never overlap. Don't re-cut the waves, don't flatten them into one list, and don't launch one workflow per wave.

**What the user sees while it runs.** The run narrates itself with `log()` — a line as each wave opens, ONE terminal line per task the moment it lands (`✓ verified` / `✗ needs-human` / `⊘ blocked — depends on <id>`), a line per review/verify retry, a wave summary line, and — for any task that failed a review or a verify — every subsequent milestone of THAT task (adaptive verbosity: the detail appears exactly where the trouble is, and never de-escalates). Those lines are English, and they render ONLY inside the run's progress widget: ephemeral UI the user has to open to see, and nothing of them survives into the chat. That is why you relay.

**Relay the run in BATCHES — do NOT idle until it returns, and do NOT wake on every line.** Launching is not the end of your turn. The launch result names the run's transcript directory, which holds its `journal.jsonl` (one JSON line per agent as it completes) while the run's task output accumulates the emitted `log()` lines. Set up ONE quiet background watcher over that journal, polling on a ~20–30s interval — the Monitor tool in an until-loop when you have it, otherwise short repeated reads on that interval, never a busy-loop and NEVER a per-journal-line event stream (a wakeup per line floods the chat with empty notifications). The watcher wakes you ONLY when something TERMINAL has appeared: a task landed (its verifier's result is in), a wave closed, or the run ended.

**One message per wakeup, carrying everything new.** On each wakeup write ONE chat message holding ALL the terminal outcomes accumulated since your last message — one short line each, in the USER'S language (`T3 ✓ verificada — resumen (2 loops)` / `T5 ✗ needs-human — razón` / `Wave 1/3 cerrada: 2 ✓ · 1 ✗`). If a wakeup finds nothing terminal — only implement or review results so far — re-arm the watcher SILENTLY: no filler message, no "still waiting…" line, ever. Those chat lines are what survives into the chat (the widget's `log()` narration is ephemeral UI that doesn't) — but they are progress reporting, not the record you persist from. Stop watching when the run completes, then go to Step 4.

**The relay is a BEST-EFFORT live view; the run's final return is the record.** The journal holds ONLY per-agent returns, so everything you read off it is INFERRED — a task's landing from its verifier's result, and nothing more. Facts the SCRIPT derives never appear there: a `blocked` task spawns no agent at all (so it leaves no journal record), and terminal statuses, `blockedBy`, `loops` and the wave summaries are assembled inside the run and exist only in its final return. An outcome may therefore only become visible at the wave close or at the very end — that lag is expected and acceptable, and you never stall the relay waiting on a task the journal will never mention. The AUTHORITATIVE record is ALWAYS the single return (`{results}`): Step 4's work logs and Step 5's status table come from it and NEVER from the journal, and where the two disagree the return wins.

The relay is REPORTING ONLY. You still never implement, review, or verify — you are reading a log, not participating in it — and you never interrupt the run: no `AskUserQuestion` mid-run, no intervention in a task that is struggling. A task in trouble gets relayed like any other and is dealt with at Step 5.

**If the run dies — or comes back empty — RESUME it; never rebuild blind.** A crash, a kill, or a lost session ends the run with no return; a run that *completes* but hands back an empty/null result leaves you in the same place. Both have the SAME primary remedy: re-invoke the Workflow with `resumeFromRunId` set to that run's id, plus the SAME script and the SAME `args`. Every `agent()` call that already completed comes back from cache instantly, so nothing finished is re-done AND the script re-derives every terminal state — statuses, `blockedBy`, `loops`, the wave summaries — handing you a complete, authoritative return. Reading that run's `journal.jsonl` (the per-agent return log in the workflow's transcript directory) is the FORENSIC fallback, for when a resume is impossible: it recovers the agents' raw outputs and nothing else — no terminal statuses, no `blockedBy`, no `loops`, no trace of a task that was blocked — so anything rebuilt from it is partial by construction, and you say so when you report it.

## Step 4: Record the work log

The single return carries EVERY task's accumulated `workLog` — the implementors RETURN their entries because the workflow can't write files. You are the single writer, so append them SERIALLY, task by task (this is the trap that used to drop every entry but the first), and never by hand-editing `STATE.md`: for each task, write its returned entry to a scratch file outside the repo (`"$TMPDIR/worklog-<id>.md"`) and run **`bunx dobby state append-worklog --task <id> --file <that file>`**. It appends under `## Work log` as `### Task <id>`, demoting the entry's own headings so nothing breaks the document's section structure.

Tasks that came back **`blocked` have NO work-log entry** — no agent ever ran for them. Skip them entirely; never append an empty section for a task that did nothing.

## Step 5: Status and handback

Show a status table — one row per PLANNED task, in wave order, with the status the run returned:

- **`done`** — verified (that's the machine status in `results`; the narration said "verified").
- **`needs-human`** — the task didn't get through the loop: review or verify never passed within the cap, or the task crashed inside the run. Surface each one with its `reason`.
- **`blocked`** — a dependency didn't pass, so the task was skipped without spawning an agent. Name its `blockedBy` in the row, so the user sees the chain (unblocking the blocker is what makes these runnable).

Report what remains for a final human smoke test — only what the machine layers couldn't prove — noting that smoke test happens at `/dobby:wrap`, not here.

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
- [ ] Build loop ran as a workflow authored VERBATIM from `references/build-workflow.md`, `args` only (waves of FULL task objects, devUrl, hasTestSuite, workRoot); test-author (when gated in) / implement / review / verify done by SEPARATE agents (via `agentType`)
- [ ] `args.waves` zipped from `build-plan`'s id arrays against `tasks[]` — full objects, `dependsOn` intact, the relevant plan-level decisions/constraints merged into each task (never bare ids)
- [ ] Test-author gated correctly: runs ONLY when `hasTestSuite` AND the task is test-first, once per task (plus reviewer-`testFindings` contract extensions, never implementor-initiated); otherwise the loop is the classic 3-step
- [ ] State machine respected: (test-author →) review gates before verify; verify-fail restarts implement→review→verify (with a cap), always against the same authored tests
- [ ] ONE build run for the whole plan — waves passed in `build-plan`'s order and sequenced INSIDE it, not regrouped, not merged, not one workflow per wave; destructive verifies never overlap
- [ ] Run RELAYED in BATCHES — ONE quiet ~20–30s watcher over the run's `journal.jsonl` / output (never a per-line event stream), waking only on new terminal outcomes (task landed / wave closed / run ended), ONE chat message per wakeup carrying everything new in the user's language, silent re-arm when nothing terminal (no filler lines); reporting only, never an interruption
- [ ] The relay treated as a BEST-EFFORT inferred view (a `blocked` task leaves no journal record; statuses / `blockedBy` / `loops` / wave summaries live only in the return, so late visibility was accepted, not chased) — Step 4's work logs and Step 5's table taken from the run's final `{results}`, never from the journal
- [ ] A dead run — or one that returned empty/null — RESUMED with `resumeFromRunId` + the SAME script/args (never rebuilt from scratch); `journal.jsonl` read ONLY as the forensic fallback when a resume was impossible, and its partiality (no terminal statuses / `blockedBy` / `loops`) stated when reporting
- [ ] Each task's work-log entry appended with `bunx dobby state append-worklog --task <id> --file <f>`, serially by the coordinator (single writer, STATE.md never hand-edited); `blocked` tasks skipped — no empty sections
- [ ] `needs-human` tasks surfaced with their reason and `blocked` tasks with their `blockedBy`; final smoke items handed to the user (for `/dobby:wrap`)
- [ ] No commits by any agent
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
