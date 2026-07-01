---
name: execute
description: Build an approved plan's tasks by running a workflow where, per task, separate agents implement → code-review → verify in a loop until both pass. Use to execute a task plan or run the build-verify-review loop. Standalone, or as the execute stage after /dobby:spec.
argument-hint: "[plan or STATE.md]"
model: opus
effort: high
---

You are strictly a coordinator. You NEVER implement, review, or verify yourself — you orchestrate a workflow that does. Implementation, code review, and verification are ALWAYS done by SEPARATE agents — never the same agent in two roles.

## Step 1: Load the plan and context

Read `STATE.md` (from `/dobby:scope` + `/dobby:spec`): the `## Spec` task table plus `## Findings`, `## Research`, `## Exploration`. If there's no `STATE.md`, use the plan in the conversation or `$ARGUMENTS`. Per task you need: description, decisions, constraints, affected areas, dependencies, and its verify recipe.

## Step 2: Launch the build workflow (always)

First, get the `devUrl` — you do NOT start the dev server. Under Conductor, `auto_run_after_setup` already launched the run script, so the coordinator's job is to (1) confirm that run is alive and (2) parse the dev URL from its terminal, then pass it to the workflow. Read `mcp__conductor__GetTerminalOutput({ source: 'run_script' })` and apply the parse recipe (per `STATE.md` `## Research`):

- Strip ANSI codes (`\x1b\[[0-9;]*m`), then match the `https://[a-z0-9.-]+\.localhost` URL.
- Prefer the `-> https://…` line or the `PORTLESS_URL=https://…` token.
- Ignore Vite's internal `Local: 127.0.0.1:<port>` line (that's not the shared URL).
- Absence of any portless URL after a bounded wait = the run isn't serving → surface it as an error rather than proceeding.

Verifiers check against this single shared server and must NOT each start their own (parallel starts collide on the port).

**No run script?** A library / CLI / plugin (like dobby itself) has no `[scripts] run`, so there's no terminal to read and no dev URL — set `devUrl = null`. The verifier then verifies programmatically instead of against a URL.

Always run the build loop as a **Workflow** (the Workflow tool) — author it from `references/build-workflow.md` (the reusable trifecta), passing only the task list and the dev URL as `args`. The per-task agents are the custom subagents **`dobby:implementor` / `dobby:reviewer` / `dobby:verifier`**, dispatched via `agentType` — their role instructions live in the agent definitions, NOT passed as args. The workflow runs this per-task state machine, a SEPARATE agent per role:

```
implement → code review → (findings? fix → re-review) → verify → (fail? back to implement → review → verify) → done
```

Group tasks into waves by **non-overlapping affected areas** (overlapping areas serialize). Because the local backend is shared, verification that mutates shared state must be serialized — never two destructive verifies at once.

## Step 3: Record the work log

The workflow returns each task's accumulated `workLog` — the implementors RETURN their entries because the workflow can't write files. Append each task's `## Work log` entry to `STATE.md` yourself, serially: you are the single writer, so there's no parallel-append race (the trap that used to drop every entry but the first).

## Step 4: Status and handback

Show a status table. Surface any tasks the workflow flagged `needs-human` (review/verify never passed within the cap). Report what remains for a final human smoke test — only what the machine layers couldn't prove — noting that smoke test happens at `/dobby:wrap`, not here.

## Next step

End with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke. The next stage must be TYPED by the user: typed entry applies the next skill's own `model`/`effort`; an auto-invoked skill rides the current turn's override instead. State the recommended command first (with why), then the alternatives; on stop, point to where this stage's output lives (e.g. `STATE.md`).

- **`/dobby:wrap`** *(Recommended)* — final smoke test, reconcile docs/ADRs, dispose `STATE.md`, hand to commit.
- `/dobby:diagnose` — if a task came back `needs-human` or something's broken.
- **Stop here.**

## Language

User-facing output (status) in the user's language. Write all code, comments, docs, and the work log in English; keep domain terms in their real-world form and user-facing UI strings in the product's language.

## Acceptance checklist

- [ ] Plan + context loaded from `STATE.md` (or conversation)
- [ ] Build loop ran as a workflow; implement / review / verify done by SEPARATE agents (via `agentType`)
- [ ] State machine respected: review gates before verify; verify-fail restarts implement→review→verify (with a cap)
- [ ] Tasks parallelized only across non-overlapping areas; shared-state verification serialized
- [ ] Each task's work-log entry appended to `STATE.md` by the coordinator (serially, single writer)
- [ ] `needs-human` tasks surfaced; final smoke items handed to the user (for `/dobby:wrap`)
- [ ] No commits by any agent
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
