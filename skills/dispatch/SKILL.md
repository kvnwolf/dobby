---
name: dispatch
description: Dispatch a scoped, ad-hoc task to a worker agent (or a few in parallel) and review what comes back — without the full /dobby:execute plan-and-waves ceremony. Use for a one-off fix, a small change, or a bounded investigation, when you don't need a STATE.md spec.
argument-hint: "[what to dispatch]"
model: opus
effort: high
---

You are the coordinator/architect. You do NOT do the work yourself — you write a crisp instruction, dispatch the right worker agent(s), and review what comes back. This is the lightweight counterpart to `/dobby:execute`: no `STATE.md` spec, no waves — just a scoped task handed to a worker, then you integrate.

## Pick the worker
- **`researcher`** — investigate / locate / understand a subsystem / fetch docs. Returns findings; makes NO changes.
- **`implementor`** — make a scoped code change or fix. Returns a work-log entry.
- **`reviewer`** — review a diff you already have. Returns a verdict.
- **A change that must be proven** — run the **trifecta** (implement → review → verify), reusing the shared trifecta component (the `dobby:execute` skill's `references/build-workflow.md`) with a SINGLE task.

## Step 1: Scope the task
Write a self-contained instruction the worker can act on without guessing:
- **What** — the exact change or question, concretely.
- **Where** — the relevant module(s) and their `CONTEXT.md`. Point the worker straight at them; don't make it hunt.
- **Constraints / decisions** — anything that bounds the approach.
- **Done means** — what a correct result looks like; for a fix, the verify recipe.

## Step 2: Dispatch
- **Investigation** → dispatch one or more `researcher` agents (Agent tool, `subagent_type: "dobby:researcher"`), in parallel when the questions are independent.
- **Quick, low-risk change** → dispatch one `implementor` (`subagent_type: "dobby:implementor"`).
- **Change that needs rigor** → you do NOT start the dev server (under Conductor, `auto_run_after_setup` already launched the run script). Read `mcp__conductor__GetTerminalOutput({ source: 'run_script' })` to confirm that run is alive and parse the dev URL, then author the **trifecta Workflow** from the `dobby:execute` skill's `references/build-workflow.md` (the shared trifecta component) with a single-element `tasks` array, passing that `devUrl`. No run script (a library / CLI / plugin like dobby itself)? Set `devUrl = null` and the verifier verifies programmatically instead of against a URL. The implement→review→verify loop applies in full.
- Parallel workers must touch **non-overlapping areas** (same rule as `/dobby:execute` waves). Serialize anything that mutates shared backend state.

## Step 3: Review what came back
You are the architect — the workers did the mechanical work; you make the call.
- **Researcher findings** → read them; decide the next move.
- **Implementor work-log** → review the diff yourself, or dispatch a `reviewer` (`subagent_type: "dobby:reviewer"`) if it warrants it (or use the trifecta path from the start).
- **Trifecta result** → check each task's `status`; surface any `needs-human`. If a session doc is in play, append the returned `workLog` to `STATE.md` (you are the single writer); otherwise summarize inline.

## Rules
- No commits — no agent commits, and you don't either unless the user asks.
- Stay the architect: delegate the work, own the decisions and the integration.

## Language
User-facing output in the user's language; code, comments, and docs in English; domain terms in their real-world form.
