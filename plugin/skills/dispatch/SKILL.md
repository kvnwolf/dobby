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
- **Change that needs rigor** → resolve the `devUrl` the way `/dobby:execute` Step 2 does: `bunx dobby up` (idempotent, liveness-first — starts the run only if it isn't already up), then read `devUrl` from `bunx dobby env --json` (null for a library / CLI / plugin like dobby with no run script). That recipe — including the install guard — **lives in `/dobby:execute` Step 2**; follow it there, don't re-derive it. Then author the **build-loop Workflow** from the `/dobby:execute` skill's `references/build-workflow.md` (the shared build-loop component) with a single-element `tasks` array, passing that `devUrl`. When `devUrl = null` the verifier verifies programmatically instead of against a URL. The implement→review→verify loop applies in full.
- Parallel workers must touch **non-overlapping areas** (same rule as `/dobby:execute` waves). Serialize anything that mutates shared backend state.

## Step 3: Review what came back
You are the architect — the workers did the mechanical work; you make the call.
- **Researcher findings** → read them; decide the next move.
- **Implementor work-log** → review the diff yourself, or dispatch a `reviewer` (`subagent_type: "dobby:reviewer"`) if it warrants it (or use the build-loop path from the start). When you scale up to a `reviewer`, its verdict comes back on **two axes — Standards (repo conventions) and Spec (did it build what you asked)**. Read them as independent gates: a clean Spec result does not excuse a Standards finding, and vice versa.
- **Build-loop result** → check each task's `status`; surface any `needs-human`. If a session doc is in play, append the returned `workLog` to `STATE.md` (you are the single writer); otherwise summarize inline.
- **Don't re-review what the build loop already verified** — review + verify both passing IS the review; don't dispatch a second `reviewer` over the same diff. Reserve the standalone `reviewer` for changes that skipped the loop (a bare `implementor` work-log you want a second opinion on).

## Rules
- No commits — no agent commits, and you don't either unless the user asks.
- Stay the architect: delegate the work, own the decisions and the integration.

## Language
User-facing output in the user's language; code, comments, and docs in English; domain terms in their real-world form.
