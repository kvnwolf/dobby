---
name: execute
description: Build an approved plan's tasks — per task, separate agents implement → verify in a bounded loop; code review happens later on the PR. Use standalone or after /dobby:spec.
argument-hint: "[plan or STATE.md]"
---

You are strictly a coordinator — the Architect. You NEVER implement or verify yourself: you dispatch named subagents that do, following `references/build-protocol.md`. Implementation and verification are ALWAYS done by SEPARATE agents. The normal build loop deliberately has no code-review agent; holistic review happens on the PR.

**Coordinator Bash discipline — pin the root BEFORE the first command.** Every Bash command in this stage — starting with Step 1's, and including your own final checks — must run against THIS session's worktree (the one `/dobby:scope` created and you are working in). Never trust `pwd`: that worktree is nested under the main checkout, so a stray relative path silently lands in main — and `dobby` commands resolve their root from the process cwd, so a mis-rooted `build-plan` would plan MAIN's `STATE.md`, a different plan entirely. `cd` to the session worktree root for the first commands (or pass `build-plan` an absolute `--file`); from `bunx dobby up --json` onward use the `workroot` it reports as that absolute root (it matches `build-plan`'s `workRoot`).

**Confirm dobby is installed before the FIRST `bunx dobby` command** (Step 1's): `[ -f dobby.config.json ] && [ -x node_modules/.bin/dobby ]`, from that worktree root. If either is missing, STOP and point the user to `/dobby:onboard` (this project was never onboarded) or `/dobby:migrate-config` (a legacy vite-plus project not yet migrated) — there is no fallback: both the plan and the run lifecycle live entirely in the local `dobby` bin, and a bare `bunx dobby` on a project without it fetches the UNRELATED npm `dobby` package and fails obscurely.

## Step 1: Load the plan

**`bunx dobby build-plan --json`** turns the spec into the build plan mechanically — you never read the task table by eye, and you never invent a dispatch order. It reads `<workroot>/STATE.md`'s `## Spec` by default (`--file <doc>` for a plan that lives elsewhere) and answers:

- `tasks[]` — `{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst, dependsOn, destructive}`, the full task objects Step 3 dispatches. `decisions` / `constraints` come back EMPTY by contract: plan-level decisions are yours to distribute per task when you write each task's instruction, because which decision binds which task is judgment, not a table cell. `dependsOn` is the ONLY thing that says who a task waits for — there is no batching here: a task is ready the moment every id in its `dependsOn` has reached `done` (`references/build-protocol.md`'s scheduling rule). `destructive` flags a task that mutates shared backend state during its proof; you dispatch it alone, with nothing else touching that backend at the same time.
- `preconditions` — `{ok, missing[], danglingDeps[], cycles[]}`.
- `hasTestSuite` — `{value, specSays, disagreement}`: what the repo can actually run, what the spec claims, and whether they contradict.
- `manualVerifySetup` — `none` or the developer steps the Step 2 gate waits on.
- `workRoot` — the absolute worktree root.

**Fail-fast, before dispatching anything:**
- `preconditions.ok === false` → **STOP and route back to `/dobby:spec`**, quoting the payload: each `missing[]` entry as "task `<taskId>` has no `<field>`", plus any `danglingDeps` / `cycles`. Never launch a partial run — a spec gap surfaces mid-run as `needs-human` only after you've burned agent turns. (Exit is nonzero on a refusal, with the payload still on stdout.)
- `hasTestSuite.disagreement === true` → the spec plans test-first work in a repo with no runnable suite (or the reverse). Say so and settle it before launching; `hasTestSuite.value` is the fact every test-author dispatch carries.
- No `STATE.md` / no `## Spec` at all (execute run standalone) → `build-plan` errors out. Do NOT fall back to reading the plan by eye: write the plan from the conversation or `$ARGUMENTS` to a scratch doc OUTSIDE the repo (`"$TMPDIR/plan-<slug>.md"`) under a `## Spec` heading, with the task table `../spec/references/task-decomposition.md` describes, and run **`bunx dobby build-plan --file "$TMPDIR/plan-<slug>.md" --json`**. Same payload, same contract — the fields above are never hand-derived.

Also read the rest of the doc for context the agents inherit — `## Findings (interview)`, `## Research`, `## Exploration`.

## Step 2: Bring the workspace up (always)

Bring the workspace up per **`references/bring-up.md`** — the shared two-step protocol every lifecycle-consuming stage follows. `/dobby:scope` already ran `up` once, so the setup phase is a fast no-op; the run phase may still hand you a `start` instruction to carry out yourself (idempotent either way — `dobby dev` refuses a live twin). You NEVER start a server on your own initiative or start a second one, and you NEVER create, size, or discover panes by hand — you only carry out what `instructions[]` names. Branch on the fields the reference describes:

- **`ok: false`** → the workspace is NOT up. STOP and report the `reason` (the closed enum in the reference: `not-a-git-repo` · `config-unreadable` · `install-failed` · `worktree-copy-failed` · `setup-extra-failed` · `neon-creds-missing` · `neon-branch-failed` · `liveness-timeout`) with the human message dobby put on stderr. If `degradedCommand` is non-null (an install-phase failure), offer it as the one mechanical retry — otherwise there is nothing to retry blindly. Dispatch no one against a workspace that never came up.
- **`instructions[]` non-empty** → follow the reference (`rename` then `start`, in order), then re-run `up --json`; a second call that STILL returns a `start` instruction means the process never registered — stop and report per the reference's stop rule.
- **`devUrl`** — the resolved, worktree-aware dev URL (null for a no-app project: a library / CLI / plugin like dobby itself). Every QA dispatch gets this ONE shared URL. QA workers check against it and must NOT each start their own server (parallel starts collide on the port).
- **`verifyMode`** — `url` or `programmatic`, derived from `devUrl`. It's the same branch, pre-decided: `programmatic` means the QA instruction says "no dev server — verify programmatically".
- **`browserPane`** — the kit's cmux browser pane ref, discovered as a fact; null when cmux is absent or no pane is open (`up` never opens one itself any more).
- **`workroot`** — the absolute worktree root: the root you pinned above, now confirmed by dobby. Use it for every remaining Bash command in this stage, and hand it to every worker whose instruction needs it (it matches `build-plan`'s `workRoot`; if they differ, you ran Step 1 from the wrong directory — re-run it from `workroot` before dispatching anything).

**Manual-setup gate — the LAST sub-step of Step 2, after bring-up, BEFORE dispatching any worker below.** QA workers can't log themselves in or seed state, so this deterministic gate guarantees they never hit an auth wall or missing seed. Read `manualVerifySetup` from Step 1's `build-plan` payload:
- **`none`** → skip SILENTLY. No prompt, no interruption (the common case — public/backend-only plans, plugins/CLIs).
- **Steps present** → FIRST run `bunx dobby instructions browser --json` and carry out its surface step yourself (open or reuse the surface at `devUrl` — see the reference's "Opening the verification surface" section) so there IS a surface for the user to log in to. THEN present the steps to the user via `AskUserQuestion` — an in-stage environment gate (the same precedent as `/dobby:finish`'s destructive confirm, NOT a stage handoff) — and WAIT for confirmation that the setup is done before the first worker (dispatched below) launches. No QA worker may run before the gate passes. **The gate must direct auth into the ONE surface QA will actually drive** — not an ambiguous "browser pane OR Chrome" (in the field the user authenticated in the cmux pane but QA drove claude-in-chrome, a DIFFERENT browser with no shared session, and hit `/login`). The surface is now deterministic from the catalogue call you just made, not inferred from `browserPane`'s presence: name exactly the surface `instructions browser` opened or reused, and tell the user to authenticate THERE. State it as this deterministic either/or — never an ambiguous "or". List the steps verbatim; offer **Setup done — verify** (proceed) and **Cancel** (stop; don't dispatch).

(`/dobby:dispatch` reaches the same lifecycle authority through the same `up --json` call.)

## Step 3: Run the plan (always)

Follow **`references/build-protocol.md`** — the shared build-loop component — for the whole plan's `tasks[]`: it is the full set of instructions for what you do next, not something you author or hand to a tool. Read it now if you have not already; the rest of this step assumes it.

For every task, write a self-contained instruction before dispatching: `TASK: <title>`, `Spec: <spec>`, plus the plan-level `decisions` / `constraints` you judge relevant to THIS task (they came back empty from `build-plan` by contract), and `Affected areas: <areas>`. On a later round of the same task, add the specific QA or test-author feedback being applied — nothing else.

- **Start each task the moment its `dependsOn` are all `done`** — no fixed batch to wait on (`build-protocol.md`'s scheduling rule). A `destructive` task runs alone, nothing else touching the shared backend at the same time.
- **Every dispatch is NAMED** — `dobby:test-author` (conditional: only when `hasTestSuite.value` is true AND the task is marked test-first), `dobby:implementor`, `dobby:qa` — never anonymous; naming is what gives a worker a sibling roster and lets QA reach the implementor (or the implementor reach the test-author) directly instead of a fresh agent re-reading everything.
- **The Exit gate is serialised** — only one implementor runs it against the shared tree at a time; everything else about every task keeps running in parallel. `build-protocol.md` owns the exact turn-taking.
- **A dead task stops only its dependents** — mark them blocked and keep dispatching everything else that is ready; say what died the moment it happens, by task id and terminal status, rather than only at the end.
- **Every worker appends its own record and hands you back a short verdict only** — you never write a worker's work-log entry for it, and you never receive its full reasoning trail.

`hasTestSuite.value` (a literal boolean) and `workRoot` are the two mechanical facts every dispatch needs; take them from Step 1/Step 2 verbatim, never inferred by eye.

**Refactor only in green.** When a task has a test contract, the implementor changes behavior to make red tests green, then refactors ONLY while the suite is green — never restructuring code while a test is red (a red test during a refactor can't tell you whether the refactor or the pending behavior broke it). This is the implementor's discipline (it lives in `dobby:implementor` / `dobby:test-author`), but you rely on it: a task's later rounds assume its tests are a stable green/red signal, not noise from mid-refactor breakage.

**Keep `STATE.md` current as the run advances** — each task's status and which round it is on — so a compaction never loses the run: read `STATE.md` back and the state of the whole plan is reconstructable without replaying the conversation.

## Step 4: Status and handback

Once every task has reached a terminal status, close with the summary table `build-protocol.md` defines — one row per PLANNED task, its rounds, whether it succeeded on the first attempt, what (if anything) died, and its wall clock.

Then show the plan-level status:

- **`done`** — locally verified; PR code review is still pending.
- **`needs-human`** — verification never passed within the loop's rounds, a worker could not be accounted for, or a task crashed. Surface each one with its reason.
- **`blocked`** — a dependency didn't pass, so the task was never dispatched. Name its blocker in the row, so the user sees the chain (unblocking the blocker is what makes these runnable).

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
- [ ] Plan loaded via `bunx dobby build-plan --json` (tasks/preconditions/hasTestSuite/manualVerifySetup/workRoot) — never by reading the task table by eye; a standalone run wrote the conversation plan to a scratch `## Spec` doc and used `--file`
- [ ] `preconditions.ok === false` → STOPPED and routed back to `/dobby:spec`, quoting `missing[]` (+ dangling deps / cycles); `hasTestSuite.disagreement` surfaced
- [ ] Workspace brought up per `references/bring-up.md`; `ok:false` STOPped naming the `reason` (+ `degradedCommand` when offered); non-empty `instructions[]` carried out in order (rename then start) and `up --json` re-run, with the stop rule honored on a repeated `start`; `devUrl` / `verifyMode` / `browserPane` / `workroot` taken from the payload
- [ ] Manual-setup gate honored at end of Step 2: `none` skips silently; steps first run `bunx dobby instructions browser --json` and carry out its surface step, THEN prompt (AskUserQuestion, in-stage) and block every worker until the user confirms setup in that ONE deterministic surface
- [ ] Every task followed `references/build-protocol.md`: named dispatch throughout, a task started the moment its `dependsOn` cleared, the Exit gate serialised to one implementor at a time, a dead task's dependents blocked while independent tasks kept going, and each worker's death was named as it happened
- [ ] Test-author gated correctly: dispatched only when `hasTestSuite.value` AND the task is test-first; the implementor never edits the authored tests, only messages the test-author with a suspected gap
- [ ] `STATE.md` kept current as the run advanced, so progress was reconstructable after a compaction
- [ ] `done` reported as locally verified with external PR code review still pending
- [ ] No commits by any agent
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
