---
name: dispatch
description: Dispatch a scoped, ad-hoc task to a worker agent (or a few in parallel) and review what comes back — without the full /dobby:execute plan-and-waves ceremony. Use for a small fix or change, or a bounded investigation, when you don't need a STATE.md spec.
argument-hint: "[what to dispatch]"
---

You are the coordinator/architect. You do NOT do the work yourself — you write a crisp instruction, dispatch the right worker agent(s), and review what comes back. This is the lightweight counterpart to `/dobby:execute`: no `STATE.md` spec, no waves — just a scoped task handed to a worker, then you integrate.

## Pick the worker
- **`researcher`** — investigate / locate / understand a subsystem / fetch docs. Returns findings; makes NO changes.
- **`implementor`** — make a scoped code change or fix. Returns a work-log entry.
- **`reviewer`** — review a diff you already have. Returns a verdict.
- **A change that must be proven** — run the **build loop** (implement → review → verify) with a SINGLE task: the "change that needs rigor" path in Step 2.

## Step 1: Scope the task
Write a self-contained instruction the worker can act on without guessing:
- **What** — the exact change or question, concretely.
- **Where** — the relevant module(s) and their `CONTEXT.md`. Point the worker straight at them; don't make it hunt.
- **Constraints / decisions** — anything that bounds the approach.
- **Done means** — what a correct result looks like; for a fix, the verify recipe.

## Step 2: Dispatch
- **Investigation** → dispatch one or more `researcher` agents (Agent tool, `subagent_type: "dobby:researcher"`), in parallel when the questions are independent.
- **Quick, low-risk change** → dispatch one `implementor` (`subagent_type: "dobby:implementor"`).
- **Change that needs rigor** → run the build loop, in three commands:
  1. **`bunx dobby up --json`** — brings the workspace up (idempotent, liveness-first: it starts the run only if it isn't already up) and reports the environment in one payload. No `dobby.config.json` / no local `node_modules/.bin/dobby` → the project was never onboarded: stop and point the user at `/dobby:onboard`. `ok:false` → STOP and report the `reason` (plus `degradedCommand` when it offers one); don't dispatch against a workspace that never came up. Take `devUrl` (null for a library / CLI / plugin like dobby with no run script), `verifyMode` (`url` / `programmatic` — when it's `programmatic` the verifier verifies programmatically instead of against a URL), and `workroot`.
  2. **`bunx dobby build-plan --task <task.json> --json`** — write your Step 1 instruction to a scratch JSON file outside the repo (`{"id","title","spec","areas","verifyRecipe"}`, plus `decisions` / `constraints` / `testFirst` / `destructive` when they apply) and let build-plan normalize it into the same payload `/dobby:execute` gets: one `tasks[]` entry, one wave, `hasTestSuite`, `workRoot`. No `STATE.md` is read.
  3. Author the **build-loop Workflow** from `../execute/references/build-workflow.md` (the shared build-loop component), script VERBATIM, `args` = that single-element `tasks` array + `devUrl` + `hasTestSuite` + `workRoot`. The implement→review→verify loop applies in full.
- Parallel workers must touch **non-overlapping areas** (same rule as `/dobby:execute` waves). Serialize anything that mutates shared backend state.

## Step 3: Review what came back
You are the architect — the workers did the mechanical work; you make the call.
- **Researcher findings** → read them; decide the next move.
- **Implementor work-log** → review the diff yourself, or dispatch a `reviewer` (`subagent_type: "dobby:reviewer"`) if it warrants it (or use the build-loop path from the start). When you scale up to a `reviewer`, its verdict comes back on **two axes — Standards (repo conventions) and Spec (did it build what you asked)**. Read them as independent gates: a clean Spec result does not excuse a Standards finding, and vice versa.
- **Build-loop result** → check each task's `status`; surface any `needs-human`. If a session doc is in play, append the returned `workLog` with `bunx dobby state append-worklog --task <id> --file <f>` (write the entry to a scratch file first; you are the single writer and `STATE.md` is never hand-edited); otherwise summarize inline.
- **Don't re-review what the build loop already verified** — review + verify both passing IS the review; don't dispatch a second `reviewer` over the same diff. Reserve the standalone `reviewer` for changes that skipped the loop (a bare `implementor` work-log you want a second opinion on).

## Rules
- No commits — no agent commits, and you don't either unless the user asks.
- Stay the architect: delegate the work, own the decisions and the integration.

## Language
User-facing output in the user's language; code, comments, and docs in English; domain terms in their real-world form.

## Acceptance checklist

- [ ] Instruction is self-contained (what / where / constraints / done means) before any dispatch
- [ ] The right worker picked: researcher (investigate) · implementor (scoped change) · reviewer (existing diff) · the build loop (a change that must be proven)
- [ ] Rigor path used `bunx dobby up --json` (STOPping on `ok:false`, taking `devUrl` / `verifyMode` / `workroot`) and `bunx dobby build-plan --task <task.json> --json` — the devUrl never hand-derived and the run never started by hand
- [ ] Build-loop workflow authored VERBATIM from `../execute/references/build-workflow.md`, `args` only (single-task list, devUrl, hasTestSuite, workRoot)
- [ ] Parallel workers touched non-overlapping areas; anything mutating shared backend state serialized
- [ ] Results integrated by you (the architect): findings read, work-log reviewed, `needs-human` surfaced; no second review over what the build loop already verified
- [ ] Work-log entries appended with `bunx dobby state append-worklog` when a session doc is in play (STATE.md never hand-edited)
- [ ] No commits by any agent, and none by you unless the user asked
