---
name: execute
description: Build an approved plan's tasks — per task, separate agents implement → verify in a bounded loop; code review happens later on the PR. Use standalone or after /dobby:spec.
argument-hint: "[plan or STATE.md]"
---

You are strictly a coordinator. You NEVER implement or verify yourself — you orchestrate a workflow that does. Implementation and verification are ALWAYS done by SEPARATE agents. The normal build loop deliberately has no code-review agent; holistic review happens on the PR.

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

**`bunx dobby up --json`** — one call does the bring-up and reports the runtime surfaces. It is idempotent and liveness-first: `/dobby:scope` already ran `up`, so the setup phase is a fast no-op and the run phase starts the dev server only if it isn't already up. You NEVER start a server yourself and you NEVER create, size, or discover panes by hand. Its JSON is the sole stdout; branch on these fields:

- **`ok: false`** → the workspace is NOT up. STOP and report the `reason` (a closed enum: `not-a-git-repo` · `config-unreadable` · `install-failed` · `worktree-copy-failed` · `setup-extra-failed` · `neon-creds-missing` · `dev-start-failed` · `liveness-timeout`) with the human message dobby put on stderr. If `degradedCommand` is non-null (an install-phase failure), offer it as the one mechanical retry — otherwise there is nothing to retry blindly. Launch no workflow against a workspace that never came up.
- **`devUrl`** — the resolved, worktree-aware dev URL (null for a no-app project: a library / CLI / plugin like dobby itself). Pass it to the build workflow as the verifiers' single shared URL. Verifiers check against this ONE URL and must NOT each start their own (parallel starts collide on the port).
- **`verifyMode`** — `url` or `programmatic`, derived from `devUrl`. It's the same branch, pre-decided: `programmatic` means the verify prompt says "no dev server — verify programmatically".
- **`browserPane`** — the kit's cmux browser pane ref, null when cmux is absent. It decides the manual-setup auth surface below (`dobby:verifier` reads the same field, so they converge).
- **`workroot`** — the absolute worktree root: the root you pinned above, now confirmed by dobby. Use it for every remaining Bash command in this stage, and pass it into the workflow as `args.workRoot` (it matches `build-plan`'s `workRoot`; if they differ, you ran Step 1 from the wrong directory — re-run it from `workroot` before launching anything).

Then run **`bunx dobby env --json`** from that exact `workroot`. It is the authoritative source for the fixed Claude-native **`workflowRecipe`**. Take the complete object verbatim—`id: baseline-v1`, its `fingerprint`, all five worker model/effort pairs, `maxOuter`, `maxConcurrency`, capabilities, and mechanical-first posture—and pass it unchanged as `args.workflowRecipe` in Step 3. The fingerprint is the integrity seal over the recipe id, the five roles in canonical order, the limits, and the verification posture; the build run validates both the supplied fingerprint and a fresh fingerprint computed from those fields against the exact baseline before launching any agent. If the object or fingerprint is missing or malformed, STOP before launching any agent; never reconstruct the values by eye.

There are intentionally no profiles, prompts, project/global files, environment variables, or CLI flags for selecting Dobby's recipe during this experiment. `STATE.md` carries work, not model policy. The canonical table is `cli/src/workflow-recipe.ts`; agent frontmatter mirrors it for direct calls and drift tests enforce equality. Claude Code itself may still honor an operator-level `CLAUDE_CODE_SUBAGENT_MODEL` override outside Dobby's control, so report that fact if observed rather than silently claiming the requested model ran.

**Manual-setup gate — the LAST sub-step of Step 2, after `up --json`, BEFORE launching the build workflow below.** Verifiers can't log themselves in or seed state, so this deterministic gate guarantees they never hit an auth wall or missing seed. Read `manualVerifySetup` from Step 1's `build-plan` payload:
- **`none`** → skip SILENTLY. No prompt, no interruption (the common case — public/backend-only plans, plugins/CLIs).
- **Steps present** → present them to the user via `AskUserQuestion` — an in-stage environment gate (the same precedent as `/dobby:finish`'s destructive confirm, NOT a stage handoff) — and WAIT for confirmation that the setup is done before the build workflow (authored below) launches. No verifier may run before the gate passes. **The gate must direct auth into the ONE surface the verifier will actually drive** — not an ambiguous "browser pane OR Chrome" (in the field the user authenticated in the cmux pane but the verifier drove claude-in-chrome, a DIFFERENT browser with no shared session, and hit `/login`). Decide the surface by `up`'s `browserPane`: **present** (cmux opened the kit browser pane at `devUrl`) → the verifier will drive that `dobby-browser-<slug>` pane, so tell the user to authenticate THERE; **null** (no cmux) → the verifier uses claude-in-chrome, so tell the user to authenticate in that local Chrome at `devUrl`. State it as this deterministic either/or — never an ambiguous "or". List the steps verbatim; offer **Setup done — verify** (proceed) and **Cancel** (stop; don't launch).

(`/dobby:dispatch` reaches the same lifecycle and recipe authorities through the same `up --json` and `env --json` calls.)

## Step 3: Run the build run (always)

The WHOLE plan goes into **ONE Workflow invocation** — the **build run** (`meta.name: 'build-run'`). Author it from `references/build-workflow.md` (the reusable build loop), using the script VERBATIM and filling in only `args`:

- **`waves`** — `build-plan`'s `waves[][]`, **zipped into FULL task objects**. `build-plan` reports each wave as an array of task *ids* next to a separate `tasks[]`, so map every id to its `tasks[]` entry: each wave entry must be the whole object (`{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst, dependsOn}`). Merge into each task the plan-level `decisions` / `constraints` you judged relevant (they come back EMPTY by contract — that distribution is your judgment, not a table cell), and keep the entry's `dependsOn` intact: the script reads it to skip the dependents of a task that ended badly. A wave of bare ids makes the run THROW immediately, by design — before a single agent burns tokens.
- **`devUrl`** (Step 2's, or null), **`hasTestSuite`** (from `hasTestSuite.value`), **`workRoot`** (Step 2's `workroot`), **`workflowRecipe`** (the complete `baseline-v1` object from `dobby env --json`, unchanged).

`hasTestSuite` and `workRoot` are REQUIRED mechanical inputs, not optional hints: pass `hasTestSuite.value` as a literal boolean (never the enclosing object or an inferred value), and pass `workroot` as a non-empty absolute path that agrees with Step 1's `workRoot`. The script rejects either missing/malformed input—and any missing, altered, or internally inconsistent recipe fingerprint—before the first agent call.

The normal per-task agents are **`dobby:test-author` (conditional) / `dobby:implementor` / `dobby:verifier`**, dispatched via `agentType` — their role instructions live in the agent definitions, NOT passed as args. The run puts every task through this state machine, a SEPARATE agent per role:

```
[test-author] → implement → verify → (actionable failure and another slot? optional test-contract extension → implement → verify) → done
```

The leading **test-author** step is gated: it runs ONLY when `hasTestSuite` is true AND the task is marked test-first, writes tests from the spec alone as the fixed contract, and hands the verifier a combined tests+code diff. It is re-dispatched only when a verifier reports `testFindings` and another complete implement→verify slot remains. When the gate is closed — no suite, or a task that isn't test-first — the loop is implement→verify. This is orthogonal to `devUrl`: the suite and non-mutating tautology litmus belong to the programmatic verify path.

**A null or malformed writer result is not proof that nothing changed.** Every test-author/implementor result must coherently declare `completed` or `blocked`, carry a non-empty accounting `workLog`, and carry a blocker only for `blocked`. A coherent blocker stops `needs-human` and preserves its accounting. Anything else dispatches one exceptional task-scoped reviewer in the `safety-review` stage to inspect the current diff for unlogged mutations. That reviewer audits only and never fixes; the task remains `needs-human` regardless of its verdict. This is the only reviewer in `execute`, not a normal quality gate.

**No terminal or misrouted fix.** A verifier failure may trigger writers only when another verifier call remains AND it classifies the failure as actionable code or test-contract work. Environment/auth/setup failures, missing proof surfaces, and human-judgment gates stop without a writer. A final verifier failure stops `needs-human`; it never leaves a mutation without later verification. A successful `done` requires coherent non-empty evidence, a usable mechanical/model-judged proof source, and no findings; it means **locally verified; PR code review is still pending**.

**Refactor only in green.** When a task has a test contract, the implementor changes behavior to make red tests green, then refactors ONLY while the suite is green — never restructuring code while a test is red (a red test during a refactor can't tell you whether the refactor or the pending behavior broke it). This is the implementor's discipline (it lives in `dobby:implementor` / `dobby:test-author`), but the coordinator relies on it: the outer loop's re-implement steps assume the tests are a stable green/red signal, not noise from mid-refactor breakage.

**Waves come from `build-plan`, in order, never regrouped or merged — and they run INSIDE the single build run.** The script sequences them itself (wave after wave, the tasks inside a wave at once), so the safety the plan encoded survives as that internal structure: non-overlapping affected areas within a wave (overlapping areas serialize into later waves) and a `destructive` task alone in its own wave, because the local backend is shared and two destructive verifies must never overlap. Don't re-cut the waves, don't flatten them into one list, and don't launch one workflow per wave.

**What the user sees while it runs.** The run narrates itself with `log()` — a line as each wave opens, ONE terminal line per task (`✓ verified` / `✗ needs-human` / `⊘ blocked — depends on <id>`), a line per verify retry, a wave summary, and every subsequent milestone of a task after its first verification failure. Those lines render inside the Workflow run's progress widget, the ONLY live-status surface. Do NOT invoke `Monitor`, poll `journal.jsonl`, read the run output, or echo progress into chat while active.

**The run's final return is the record.** Terminal statuses, `blockedBy`, `loops`, telemetry summaries, and wave summaries are assembled inside the run and exist in its final return. The AUTHORITATIVE record is ALWAYS that single return (`{results, telemetry}`): Step 4's work logs, Step 5's status table, and the consumption summary come from it and NEVER from live narration or the journal.

**If the run dies — or comes back empty — RESUME it; never rebuild blind.** A crash, a kill, or a lost session ends the run with no return; a run that *completes* but hands back an empty/null result leaves you in the same place. Both have the SAME primary remedy: re-invoke the Workflow with `resumeFromRunId` set to that run's id, plus the SAME script and the SAME `args`. Every `agent()` call that already completed comes back from cache instantly, so nothing finished is re-done AND the script re-derives every terminal state — statuses, `blockedBy`, `loops`, the wave summaries — handing you a complete, authoritative return. Reading that run's `journal.jsonl` (the per-agent return log in the workflow's transcript directory) is the FORENSIC fallback, for when a resume is impossible: it recovers the agents' raw outputs and nothing else — no terminal statuses, no `blockedBy`, no `loops`, no trace of a task that was blocked — so anything rebuilt from it is partial by construction, and you say so when you report it.

## Step 4: Record the work log

The single return carries EVERY task's accumulated `workLog` — the implementors RETURN their entries because the workflow can't write files. You are the single writer, so append them SERIALLY, task by task (this is the trap that used to drop every entry but the first), and never by hand-editing `STATE.md`: for each task, write its returned entry to a scratch file outside the repo (`"$TMPDIR/worklog-<id>.md"`) and run **`bunx dobby state append-worklog --task <id> --file <that file>`**. It appends under `## Work log` as `### Task <id>`, demoting the entry's own headings so nothing breaks the document's section structure.

Tasks that came back **`blocked` have NO work-log entry** — no agent ever ran for them. Skip them entirely; never append an empty section for a task that did nothing.

## Step 5: Status and handback

Show a status table — one row per PLANNED task, in wave order, with the status the run returned:

- **`done`** — locally verified; PR code review is still pending.
- **`needs-human`** — verification never passed within the cap, a writer could not be accounted for, or the task crashed. Surface each one with its `reason`.
- **`blocked`** — a dependency didn't pass, so the task was skipped without spawning an agent. Name its `blockedBy` in the row, so the user sees the chain (unblocking the blocker is what makes these runnable).

Then report the returned `telemetry.summary`: attempts, retries, first-attempt successes/rate, limit exhaustions, and verification-source counts. The launch result's Workflow run id may be shown alongside this summary, but do not rewrite `telemetry.events` or invent usage: their `runId`, provider, token, and duration fields remain `unknown` where the script could not observe them. Do not estimate cost from missing tokens and do not scrape the host transcript to fill gaps.

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
- [ ] Fixed `workflowRecipe` loaded separately with `bunx dobby env --json` and passed verbatim, fingerprint included; the supplied and independently recomputed fingerprints matched exact `baseline-v1`; missing/malformed/drifted recipe STOPped before agents; no model/limit value reconstructed by eye
- [ ] Manual-setup gate honored at end of Step 2: `none` skips silently; steps prompt (AskUserQuestion, in-stage) and block the workflow until the user confirms setup in the ONE surface `browserPane` selects
- [ ] Build loop ran as a workflow authored VERBATIM from `references/build-workflow.md`, `args` only; test-author (when gated in) / implement / verify done by SEPARATE agents (via `agentType`), with no normal reviewer call
- [ ] `args.waves` zipped from `build-plan`'s id arrays against `tasks[]` — full objects, `dependsOn` intact, the relevant plan-level decisions/constraints merged into each task (never bare ids)
- [ ] Test-author gated correctly: runs only when `hasTestSuite` AND the task is test-first; later calls require verifier `testFindings` plus another full implement→verify slot
- [ ] State machine respected: (test-author →) implement → verify; actionable failure may extend tests then restarts implement→verify, always against the accumulated fixed contract
- [ ] Retry/concurrency limits came from `workflowRecipe`; no writer ran after the final available verifier slot, so every applied fix received later verification
- [ ] Verifier verdicts were coherent: pass required non-empty evidence + mechanical/model-judged proof + no findings; only `code` / `test-contract` failures could reach a writer, while environment / needs-human stopped without one
- [ ] A coherent blocked writer stopped `needs-human` with its accounting; a null/malformed writer or empty `workLog` triggered a task-scoped reviewer `safety-review`, which never fixed and never changed the terminal result
- [ ] `done` reported as locally verified with external PR code review still pending
- [ ] ONE build run for the whole plan — waves passed in `build-plan`'s order and sequenced INSIDE it, not regrouped, not merged, not one workflow per wave; destructive verifies never overlap
- [ ] Workflow run used as the ONLY live-status surface — no `Monitor`, `journal.jsonl` polling, run-output polling, or progress echo into chat while active
- [ ] Step 4/5 records taken from the run's final `{results, telemetry}`, never reconstructed from live narration or the journal
- [ ] Returned telemetry summary reported honestly and events carried the recipe fingerprint; unavailable run-id/provider/token/duration fields stayed `unknown`, no cost was fabricated, and no private transcript was scraped to fill them
- [ ] A dead run — or one that returned empty/null — RESUMED with `resumeFromRunId` + the SAME script/args (never rebuilt from scratch); `journal.jsonl` read ONLY as the forensic fallback when a resume was impossible, and its partiality (no terminal statuses / `blockedBy` / `loops`) stated when reporting
- [ ] Each task's work-log entry appended with `bunx dobby state append-worklog --task <id> --file <f>`, serially by the coordinator (single writer, STATE.md never hand-edited); `blocked` tasks skipped — no empty sections
- [ ] `needs-human` tasks surfaced with their reason and `blocked` tasks with their `blockedBy`; final smoke items handed to the user (for `/dobby:wrap`)
- [ ] No commits by any agent
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
