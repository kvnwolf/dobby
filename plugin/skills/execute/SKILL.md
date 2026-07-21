---
name: execute
description: Build an approved plan's tasks — per task, separate agents implement → code-review → verify in a loop until both pass. Use to execute a task plan, standalone or as the execute stage after /dobby:spec.
argument-hint: "[plan or STATE.md]"
---

You are strictly a coordinator. You NEVER implement, review, or verify yourself — you orchestrate a workflow that does. Implementation, code review, and verification are ALWAYS done by SEPARATE agents — never the same agent in two roles.

## Step 1: Load the plan and context

Read `STATE.md` (from `/dobby:scope` + `/dobby:spec`): the `## Spec` task table plus `## Findings`, `## Research`, `## Exploration`. If there's no `STATE.md`, use the plan in the conversation or `$ARGUMENTS`. Per task you need: description, decisions, constraints, affected areas, dependencies, and its verify recipe.

**Fail-fast preconditions — check BEFORE launching wave 1.** A missing piece surfaces as a needs-human flag halfway through a wave, after you've already burned agent turns; catch it now instead.
- The spec exists and every task has the fields above (a task with no verify recipe or no affected areas can't be run — stop and route back to `/dobby:spec`).
- **Testing gate is resolved for the whole run:** from the spec's Testing Decisions, know whether the repo has a runnable test suite (`hasTestSuite`) and, if so, which tasks are marked test-first. No suite (a lib / CLI / plugin like dobby) → `hasTestSuite = false`.
- Dependencies form a runnable wave order (no task depends on something not in the plan).
If any precondition fails, STOP and say what's missing — do not launch a partial run.

## Step 2: Launch the build workflow (always)

**Coordinator Bash discipline — bind to the absolute worktree root, always.** Before running any Bash in this step, compute the worktree root ONCE and operate only from it: `WORKROOT="$(git rev-parse --show-toplevel)"`, then `cd "$WORKROOT"` (or use absolute paths under `$WORKROOT`) for every command — including your own final verification. NEVER trust `pwd`: the session's worktree is nested under the main checkout, so a stray `cd` silently lands you in main and returns a misleading-empty "worktree" git status. This is the same trap the build-workflow subagents hit (`references/build-workflow.md` fixes their side); this note fixes the coordinator's own Bash.

**Confirm dobby is installed** before anything else: `[ -f dobby.config.json ] && [ -x node_modules/.bin/dobby ]`. If either is missing, STOP and point the user to `/dobby:onboard` (this project was never onboarded) or `/dobby:migrate-config` (a legacy vite-plus project not yet migrated) — there is no fallback; the run lifecycle lives entirely in the local `dobby` bin.

**Bring the workspace up: `bunx dobby up`.** It runs a **setup phase** (`bun install` + `.worktreeinclude` re-materialization + any `setup[]` extras) then a **run phase**, both idempotent and liveness-first — `/dobby:scope` already ran `up` when it entered the worktree, so here the setup phase is a fast no-op and the run phase starts the dev server only if it isn't already up (a re-entered execute never double-starts). Under cmux it opens the kit panes (browser + dev-terminal), plain terminal spawns a detached process, and it waits for liveness before returning. A no-app project (a library / CLI / plugin like dobby itself, with no run script) finishes the setup phase and no-ops the run cleanly. You NEVER start a server yourself and you NEVER create, size, or discover panes by hand — `dobby up` owns all of it.

**Read the environment: `bunx dobby env --json`.** It never fails (unresolvable facts are null). Take from it:
- `devUrl` — the resolved dev URL, worktree-aware (null for a no-app project). Pass it to the build workflow as the verifiers' single shared URL; when null, verifiers verify programmatically.
- `browserPane` — the kit's cmux browser pane ref, null when cmux is absent. It decides the manual-setup auth surface below (and the `dobby:verifier` reads the same field, so they converge).

Verifiers check against this single shared `devUrl` and must NOT each start their own (parallel starts collide on the port).

**Manual-setup gate — the LAST sub-step of Step 2, after `dobby up` and `dobby env`, BEFORE launching the build workflow below.** Verifiers can't log themselves in or seed state, so this deterministic gate guarantees they never hit an auth wall or missing seed. Read the spec's **Manual verify setup** field from the Testing Decisions in `STATE.md`:
- **`none` or absent** → skip SILENTLY. No prompt, no interruption (the common case — public/backend-only plans, plugins/CLIs).
- **Concrete steps present** → present them to the user via `AskUserQuestion` — an in-stage environment gate (the same precedent as `/dobby:finish`'s destructive confirm, NOT a stage handoff) — and WAIT for confirmation that the setup is done before the build workflow (authored below) launches. No verifier may run before the gate passes. **The gate must direct auth into the ONE surface the verifier will actually drive** — not an ambiguous "browser pane OR Chrome" (in the field the user authenticated in the cmux pane but the verifier drove claude-in-chrome, a DIFFERENT browser with no shared session, and hit `/login`). Decide the surface by `env`'s `browserPane`: **present** (cmux opened the kit browser pane at `devUrl`) → the verifier will drive that `dobby-browser-<slug>` pane, so tell the user to authenticate THERE; **absent/null** (no cmux) → the verifier uses claude-in-chrome, so tell the user to authenticate in that local Chrome at `devUrl`. State it as this deterministic either/or — never an ambiguous "or". (The `dobby:verifier` agent reads the same `browserPane` from `env`, so they converge on the same surface.) List the numbered steps verbatim; offer **Setup done — verify** (proceed) and **Cancel** (stop; don't launch).

(`/dobby:dispatch` follows this Step 2 and so inherits the gate.)

Always run the build loop as a **Workflow** (the Workflow tool) — author it from `references/build-workflow.md` (the reusable build loop), passing only the task list, the dev URL, and `hasTestSuite` as `args`. The per-task agents are the custom subagents **`dobby:test-author` (conditional) / `dobby:implementor` / `dobby:reviewer` / `dobby:verifier`**, dispatched via `agentType` — their role instructions live in the agent definitions, NOT passed as args. The workflow runs this per-task state machine, a SEPARATE agent per role:

```
[test-author] → implement → code review → (findings? fix → re-review) → verify → (fail? back to implement → review → verify) → done
```

The leading **test-author** step is gated: it runs ONLY when `hasTestSuite` is true AND the task is marked test-first, writes the tests from the spec alone (once, as the fixed contract), and hands the reviewer/verifier a combined tests+code diff. When the gate is closed — no suite (dobby is a plugin with none), or a task that isn't test-first — the loop is byte-for-byte the classic 3-step. This is orthogonal to the `devUrl` branch: the test suite (green) and dynamic litmus are part of the programmatic verify path, exactly the path a `devUrl = null` plugin already uses.

**Refactor only in green.** When a task has a test contract, the implementor changes behavior to make red tests green, then refactors ONLY while the suite is green — never restructuring code while a test is red (a red test during a refactor can't tell you whether the refactor or the pending behavior broke it). This is the implementor's discipline (it lives in `dobby:implementor` / `dobby:test-author`), but the coordinator relies on it: the outer loop's re-implement steps assume the tests are a stable green/red signal, not noise from mid-refactor breakage.

Group tasks into waves by **non-overlapping affected areas** (overlapping areas serialize). Because the local backend is shared, verification that mutates shared state must be serialized — never two destructive verifies at once.

## Step 3: Record the work log

The workflow returns each task's accumulated `workLog` — the implementors RETURN their entries because the workflow can't write files. Append each task's `## Work log` entry to `STATE.md` yourself, serially: you are the single writer, so there's no parallel-append race (the trap that used to drop every entry but the first).

## Step 4: Status and handback

Show a status table. Surface any tasks the workflow flagged `needs-human` (review/verify never passed within the cap). Report what remains for a final human smoke test — only what the machine layers couldn't prove — noting that smoke test happens at `/dobby:wrap`, not here.

## Next step

The build loop is done. Present the next stage as an **AskUserQuestion** — one question that restates execute just finished — with the options below (recommended first, then the alternative, then Stop here). State why in the recommended option. On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn (point to where this stage's output lives, e.g. `STATE.md`).

- **`/dobby:wrap`** *(Recommended)* — final smoke test, reconcile docs/ADRs, dispose `STATE.md`, hand to commit.
- `/dobby:diagnose` — if a task came back `needs-human` or something's broken.
- **Stop here.**

## Language

User-facing output (status) in the user's language. Write all code, comments, docs, and the work log in English; keep domain terms in their real-world form and user-facing UI strings in the product's language.

## Acceptance checklist

- [ ] Plan + context loaded from `STATE.md` (or conversation); fail-fast preconditions checked (complete spec, resolved testing gate, runnable wave order) before wave 1
- [ ] Dobby install confirmed (`dobby.config.json` + local bin) — missing STOPs pointing to `/dobby:onboard` / `/dobby:migrate-config`; run started via `bunx dobby up`; `devUrl` + `browserPane` read from `bunx dobby env --json` (never started or discovered by hand)
- [ ] Build loop ran as a workflow; test-author (when gated in) / implement / review / verify done by SEPARATE agents (via `agentType`)
- [ ] Test-author gated correctly: runs ONLY when `hasTestSuite` AND the task is test-first, once per task; otherwise the loop is the classic 3-step
- [ ] State machine respected: (test-author →) review gates before verify; verify-fail restarts implement→review→verify (with a cap), always against the same authored tests
- [ ] Manual-setup gate honored at end of Step 2: `none`/absent skips silently; concrete steps prompt (AskUserQuestion, in-stage) and block the workflow until the user confirms setup in the verification surface
- [ ] Tasks parallelized only across non-overlapping areas; shared-state verification serialized
- [ ] Each task's work-log entry appended to `STATE.md` by the coordinator (serially, single writer)
- [ ] `needs-human` tasks surfaced; final smoke items handed to the user (for `/dobby:wrap`)
- [ ] No commits by any agent
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
