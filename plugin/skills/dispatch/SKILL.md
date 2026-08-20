---
name: dispatch
description: Dispatch a scoped, ad-hoc task to a worker agent (or a few in parallel) and review what comes back — without the full /dobby:execute plan ceremony. Use for a small fix or change, or a bounded investigation, when you don't need a STATE.md spec.
argument-hint: "[what to dispatch]"
---

You are the coordinator/architect for an ad-hoc task. You do NOT do the work yourself — you write a crisp instruction, dispatch the right worker agent(s), and review what comes back. This is the lightweight counterpart to `/dobby:execute`: no `STATE.md` spec — just a scoped task handed to a worker, then you integrate.

## Pick the worker
- **`researcher`** — investigate / locate / understand a subsystem / fetch docs. Returns findings; makes NO changes.
- **`implementor`** — make a scoped code change or fix. Returns the structured writer envelope `{status, workLog, blocker}`; the envelope, not a bare work log, controls whether this dispatch may continue.
- **`reviewer`** — review a diff you already have. Returns a verdict.
- **A change that must be proven** — run the **build loop** (implement → verify) with a SINGLE task: the "change that needs rigor" path in Step 2. Holistic code review still happens on the PR.

## Step 1: Scope the task
Write a self-contained instruction the worker can act on without guessing:
- **What** — the exact change or question, concretely.
- **Where** — the relevant module(s) and their `CONTEXT.md`. Point the worker straight at them; don't make it hunt.
- **Constraints / decisions** — anything that bounds the approach.
- **Done means** — what a correct result looks like; for a fix, the verify recipe.

## Step 2: Dispatch

Before any `bunx dobby` command or Agent on EVERY branch, require BOTH local onboarding markers at the current workroot: `dobby.config.json` and `node_modules/.bin/dobby`. Either missing → STOP, point to `/dobby:onboard`, and do not run `bunx`; remote resolution is forbidden. Size every direct-Agent fan-out in this dispatch yourself, including an optional reviewer in Step 3.

- **Investigation** → dispatch one or more `researcher` agents (Agent tool, `subagent_type: "dobby:researcher"`). Partition independent questions into deterministic sequential batches you judge safe to run together: run one batch in parallel, await all its results, then launch the next.
- **Quick, low-risk change** → dispatch one `implementor` (`subagent_type: "dobby:implementor"`), consuming one direct-Agent slot. Name the exact affected paths in its instruction; they are the mechanical inspection scope if the Agent fails to return a valid envelope.
- **Change that needs rigor** → run the build loop, in three commands:
  1. **`bunx dobby up --json`** — brings the workspace up (idempotent, liveness-first: it starts the run only if it isn't already up) and reports the environment in one payload. No `dobby.config.json` / no local `node_modules/.bin/dobby` → the project was never onboarded: stop and point the user at `/dobby:onboard`. `ok:false` → STOP and report the `reason` (plus `degradedCommand` when it offers one); don't dispatch against a workspace that never came up. Take `devUrl` (null for a library / CLI / plugin like dobby with no run script), `verifyMode` (`url` / `programmatic` — when it's `programmatic` the verifier verifies programmatically instead of against a URL), and `workroot`.
  2. **`bunx dobby build-plan --task <task.json> --json`** — write your Step 1 instruction to a scratch JSON file outside the repo (`{"id","title","spec","areas","verifyRecipe"}`, plus `decisions` / `constraints` / `testFirst` / `destructive` when they apply) and let build-plan normalize it into the same payload `/dobby:execute` gets: one `tasks[]` entry, `hasTestSuite.value`, `workRoot`. No `STATE.md` is read.
  3. Follow **`../execute/references/build-protocol.md`** (the shared build-loop component) for that single-task list, with `devUrl` + `hasTestSuite.value` + `workRoot`. The implement→verify loop applies in full.
- Every direct-Agent fan-out (initial researchers, parallel implementors if the task was split, retry/replacement Agents, or Step 3 reviewers) runs in sequential batches you size yourself. Workers inside one batch must touch **non-overlapping areas** (the same coordination guard `build-protocol.md` requires for concurrent tasks sharing a tree). Serialize anything that mutates shared backend state.

## Step 3: Review what came back
You are the architect — the workers did the mechanical work; you make the call.
- **Researcher findings** → read them; decide the next move.
- **Direct implementor result** → validate the envelope before integrating anything. Exactly `{status: "completed", workLog: <non-empty>, blocker: ""}` may continue: review that work log and the scoped diff; if a session doc is in play, append it with `bunx dobby state append-worklog` from a scratch file; then optionally dispatch a `reviewer` (`subagent_type: "dobby:reviewer"`) if this ad-hoc path warrants an explicit second opinion. `{status: "blocked", workLog: <non-empty>, blocker: <non-empty>}` stops the dispatch: report BOTH the blocker and the work-log accounting, launch no later batch/reviewer/gate, and return `needs-human`. Null, a bare work log, an empty field, or any incoherent combination is invalid and may hide a partial mutation: run `git status --short -- <affected paths>` plus `git diff -- <affected paths>`, Read every expected target (including untracked files, which `git diff` omits), report that mechanical accounting, and return `needs-human`. Never infer completion from the tree or repair an invalid result inline. When a completed result is explicitly reviewed, the verdict's **Standards** and **Spec** axes remain independent gates.
- **Build-loop result** → check each task's `status`; surface any `needs-human`, then report the returned telemetry summary (attempts, retries, first-attempt success, cap exhaustion, verification source). Leave unavailable run-id/provider/token/duration values as `unknown`; never estimate cost from them. If a session doc is in play, append the returned `workLog` with `bunx dobby state append-worklog --task <id> --file <f>` (write the entry to a scratch file first; you are the single writer and `STATE.md` is never hand-edited); otherwise summarize inline.
- **Do not confuse verification with code review.** A passing build loop means the behavior was locally verified; it does not perform holistic code review. Use the standalone `reviewer` only when this ad-hoc path explicitly needs a pre-PR second opinion; otherwise the external PR reviewer owns that gate.

## Rules
- No commits — no agent commits, and you don't either unless the user asks.
- Stay the coordinator: delegate the work, own the ad-hoc decision and integration.

## Language
User-facing output in the user's language; code, comments, and docs in English; domain terms in their real-world form.

## Acceptance checklist

- [ ] Instruction is self-contained (what / where / constraints / done means) before any dispatch
- [ ] The right worker picked: researcher (investigate) · implementor (scoped change) · reviewer (existing diff) · the build loop (a change that must be proven)
- [ ] Both local markers (`dobby.config.json` + `node_modules/.bin/dobby`) existed before any `bunx dobby`; either missing STOPped at `/dobby:onboard` with no remote resolution or Agent launch
- [ ] Rigor path used `bunx dobby up --json` (STOPping on `ok:false`, taking `devUrl` / `verifyMode` / `workroot`), then `bunx dobby build-plan --task <task.json> --json` — no runtime value was hand-derived
- [ ] Build-loop task run per `../execute/references/build-protocol.md` (single-task list, devUrl, hasTestSuite.value, workRoot)
- [ ] Every direct Agent fan-out ran in sequential batches sized by your own judgment; parallel workers touched non-overlapping areas and shared-state mutations were serialized
- [ ] Every direct implementor envelope handled fail-closed: `completed` integrated only with non-empty `workLog` / empty `blocker`; `blocked` stopped with blocker + accounting; null/malformed triggered scoped status/diff/Read inspection and `needs-human`, with no later batch/reviewer/gate
- [ ] Results integrated by you (the architect): findings read, completed work-log reviewed, `needs-human` surfaced; verified work not mislabeled as code-reviewed
- [ ] Work-log entries appended with `bunx dobby state append-worklog` when a session doc is in play (STATE.md never hand-edited)
- [ ] No commits by any agent, and none by you unless the user asked
