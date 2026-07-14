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

**Coordinator Bash discipline — bind to the absolute worktree root, always.** Before running any Bash in this step, compute the worktree root ONCE and operate only from it: `WORKROOT="$(git rev-parse --show-toplevel)"`, then `cd "$WORKROOT"` (or use absolute paths under `$WORKROOT`) for every command — including your own final verification. NEVER trust `pwd`: on the terminal host the session's worktree is nested under the main checkout, so a stray `cd` silently lands you in main and returns a misleading-empty "worktree" git status. This is the same trap the build-workflow subagents hit (`references/build-workflow.md` fixes their side); this note fixes the coordinator's own Bash.

First, get the `devUrl`. The **URL-resolution recipe is IDENTICAL on both execution hosts** — `portless get` + `curl` liveness (branch-prefixed URLs are portless-native, so parallel worktrees get distinct URLs with no Conductor). The ONLY host difference is **who starts the run**: under Conductor it is already running; on the terminal host you ensure it first. Detect the host by env var — **`CONDUCTOR_WORKSPACE_PATH` set → Conductor; unset → terminal host** — and:

**Conductor host** — do NOT start anything (`auto_run_after_setup` already launched the run script) and do NOT read any terminal output. Go straight to *Resolve the URL* below.

**Terminal host — LIVENESS-CHECK FIRST, then start the run if needed** (nothing auto-ran it here):
1. Resolve the URL (the recipe below) and try one liveness curl. **If it responds, the run is already up — do NOT start a second one** (idempotent; a re-entered execute must never double-start).
2. If it's not alive, start the `run` command from `dobby.config.json` (the `run` key). NEVER start it as a Claude background job when cmux is present.
   - **cmux enrichment** (`CMUX_WORKSPACE_ID` set) — start `run` in a DEDICATED terminal pane for `dobby-run-<slug>`, where `<slug>` is the session's worktree dir name (the worktree name). **Target pane layout** (both the run pane here and the browser pane in bullet 4): Claude Code keeps the LEFT half; the new panes go on the RIGHT half, split vertically — **browser pane 80% height on top, dev-server/run terminal 20% height on the bottom**. Achieve this by opening the browser pane with `--direction right` (bullet 4) and nesting this run terminal as a down-split BELOW it. Steps: (1) `cmux new-pane --workspace "$CMUX_WORKSPACE_ID" --type terminal --direction right` — creates the pane (opened at the worktree cwd) and prints its surface ref (parse the output; refs look like `surface:N`); (2) `cmux rename-tab --surface <that-surface> "dobby-run-<slug>"` — titles the pane so `/dobby:finish` can rediscover it by title (the title is a positional argument; `new-pane` has no `--command`); (3) `cmux send --surface <that-surface> "<run>\n"` — launches the command inside it. **Exact 80/20 sizing at runtime is best-effort, NOT confirmed-supported** — do NOT invent a percentage flag: attempt `cmux resize-pane` toward the target ONLY if `cmux resize-pane --help` confirms the verb exists (and note even then it is relative, not percentage), otherwise accept the default split. The ONLY confirmed way to pin exact ratios is a `cmux.json` workspace `layout` JSON (`"split": 0.8`, nested children) — but that spawns a NEW workspace and does not retrofit the already-running Claude pane, so it is an option only if the user wants a dedicated launch workspace, not a runtime retrofit here. `/dobby:finish` rediscovers this pane by title `dobby-run-<slug>` and/or by its `cwd`/`type` (the worktree path) via the CMUX PANE-DISCOVERY RECIPE below. The **confirmed-available fallback** (own workspace instead of a pane) is `cmux new-workspace --cwd <worktree> --command '<run>'` then `cmux rename-workspace --workspace <that-workspace> "dobby-run-<slug>"` (`new-workspace` has no naming flag; `rename-workspace` sets the title as a positional argument). Either way the run lives in cmux, **never as a Claude background job**.
   - **plain terminal** (no `CMUX_WORKSPACE_ID`) — a background Bash job is the only option (the fallback): start `run` as a background Bash job.
3. Re-poll `curl` for liveness (bounds below) until the freshly-started run answers.
4. **cmux only, after liveness** — open the browser pane for `dobby-browser-<slug>` at the resolved URL, on the RIGHT half ABOVE the run terminal (target layout in bullet 2: browser 80% top, run terminal 20% bottom). **Idempotent** — first discover existing surfaces using the CMUX PANE-DISCOVERY RECIPE below (NOT a bare `cmux list-pane-surfaces --workspace ...`, which defaults to the FOCUSED pane only and silently under-reports), then skip if a browser surface for this worktree is already open. Otherwise `cmux new-pane --workspace "$CMUX_WORKSPACE_ID" --type browser --url <devUrl> --direction right` — creates the browser pane on the right at the worktree cwd and prints its surface ref (`surface:N`) — then `cmux rename-tab --surface <that-surface> "dobby-browser-<slug>"` to title it. Both panes carry the `dobby-*-<slug>` title and live at the worktree `cwd`, which is what lets `/dobby:finish` rediscover and close them later (it runs the same PANE-DISCOVERY RECIPE and matches by title or `cwd`/`type` — no persisted state).

**CMUX PANE-DISCOVERY RECIPE** (use wherever Step 2 discovers panes). Re-read the workspace id FRESH in the current turn — it changes between turns, never trust a cached value:
```bash
WS="$CMUX_WORKSPACE_ID"
cmux list-panes --workspace "$WS"                 # every pane ref (pane:1, pane:2, …)
# list-pane-surfaces defaults to the FOCUSED pane only — you MUST iterate every pane:
for p in <each pane ref from list-panes>; do
  cmux list-pane-surfaces --workspace "$WS" --pane "$p"   # surfaces + titles for THAT pane
done
```
Match surfaces by title (`dobby-run-<slug>` / `dobby-browser-<slug>`, set via `rename-tab`) and/or `cwd`=worktree path. Refs look like `surface:N`.

**Resolve the URL** (both hosts, identical):

1. `portless get <NAME>`, where `NAME` is the package.json `name` with any leading `@scope/` stripped:
   ```
   portless get "$(node -p "require('./package.json').name.replace(/^@[^/]+\//, '')")"
   ```
   If a `portless.json` or a `portless` key in `package.json` overrides the name, use that instead. `portless get` prints the exact branch-prefixed `https://<branch>.<name>.localhost` WITHOUT starting the server. If the command errors nonzero because `get` is unknown, portless is too old → surface it as **"needs portless >= 0.12"** rather than falling back to any other method.
2. **Confirm the run is alive** by polling `curl`: `curl -sf --max-time 5 <devUrl>`, up to **6 attempts, 5s apart** (~30s bound). If it never responds, surface a clear error rather than proceeding.

Verifiers check against this single shared server and must NOT each start their own (parallel starts collide on the port).

**No run script?** A library / CLI / plugin (like dobby itself) has no `run` key in `dobby.config.json`, so there's nothing serving and no dev URL — on BOTH hosts skip `portless get`/`curl` (and any run-start / pane step) and set `devUrl = null`. The verifier then verifies programmatically instead of against a URL.

**Manual-setup gate — the LAST sub-step of Step 2, after liveness (and after the cmux browser pane is open), BEFORE launching the build workflow below.** Verifiers can't log themselves in or seed state, so this deterministic gate guarantees they never hit an auth wall or missing seed. Read the spec's **Manual verify setup** field from the Testing Decisions in `STATE.md`:
- **`none` or absent** → skip SILENTLY. No prompt, no interruption (the common case — public/backend-only plans, plugins/CLIs).
- **Concrete steps present** → present them to the user via `AskUserQuestion` — an in-stage environment gate (the same precedent as `/dobby:finish`'s destructive confirm, NOT a stage handoff) — and WAIT for confirmation that the setup is done before the build workflow (authored below) launches. No verifier may run before the gate passes. **The gate must direct auth into the ONE surface the verifier will actually drive** — not an ambiguous "browser pane OR Chrome" (in the field the user authenticated in the cmux pane but the verifier drove claude-in-chrome, a DIFFERENT browser with no shared session, and hit `/login`). Decide the surface by a **capability probe**: run `cmux capabilities` (or `cmux browser --help`) — **IF** cmux is present AND it exposes browser-driving verbs (get/snapshot/click/eval on a surface), the verifier will drive the already-open `dobby-browser-<slug>` cmux pane, so tell the user to authenticate THERE; **ELSE** the verifier uses claude-in-chrome, so tell the user to authenticate in that local Chrome at `devUrl`. State it as this deterministic either/or — never an ambiguous "or". (The `dobby:verifier` agent independently runs the same probe, so they converge on the same surface.) List the numbered steps verbatim; offer **Setup done — verify** (proceed) and **Cancel** (stop; don't launch). Applies on BOTH hosts.

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
- [ ] Build loop ran as a workflow; test-author (when gated in) / implement / review / verify done by SEPARATE agents (via `agentType`)
- [ ] Test-author gated correctly: runs ONLY when `hasTestSuite` AND the task is test-first, once per task; otherwise the loop is the classic 3-step
- [ ] State machine respected: (test-author →) review gates before verify; verify-fail restarts implement→review→verify (with a cap), always against the same authored tests
- [ ] Manual-setup gate honored at end of Step 2: `none`/absent skips silently; concrete steps prompt (AskUserQuestion, in-stage) and block the workflow until the user confirms setup in the verification surface
- [ ] Tasks parallelized only across non-overlapping areas; shared-state verification serialized
- [ ] Each task's work-log entry appended to `STATE.md` by the coordinator (serially, single writer)
- [ ] `needs-human` tasks surfaced; final smoke items handed to the user (for `/dobby:wrap`)
- [ ] No commits by any agent
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
