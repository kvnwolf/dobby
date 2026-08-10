# 0021. Single build run per plan

**Status:** accepted

`/dobby:execute` used to launch one Workflow-tool run per wave, with the chat silent until the final table — N ceremonies per plan and no live signal. We decided the whole approved plan goes into ONE Workflow invocation (the **build run**): the verbatim script in `skills/execute/references/build-workflow.md` sequences the waves itself (`parallel()` inside each wave, preserving area-disjointness and destructive-task isolation), skips dependents of a `needs-human` task as `blocked` (transitively, zero agents spawned, via the `dependsOn` field `build-plan` now exposes), and narrates itself with `log()` — adaptive verbosity: one terminal line per task plus retry lines, escalating to full milestone detail only after a task fails verification.

## Considered Options

- **One workflow per wave (status quo)** — rejected: N launches per plan, no per-task signal, and the inter-run gaps were the only reporting moments, which made reporting per-WAVE at best.
- **Model-authored orchestration per invocation** — rejected: the script stays a PREDEFINED verbatim component (parameterized only via `args`) because the caps, no-terminal-fix rule, single-writer work log, and worktree preamble must survive every run.
- **Persisted chat messages mid-run from the workflow** — impossible: the runtime gives the main thread nothing until the final return; `log()` narrator lines are the run's only live voice, and they render only in the /workflows progress widget (ephemeral UI).

## Consequences

- The Workflow run's progress widget is the sole live-status surface. The coordinator does not invoke `Monitor`, poll `journal.jsonl`/output, or duplicate progress into chat; that relay added tool traffic and noise without improving the authoritative result. Users who want live detail open the run, and the coordinator reports the final table only after the run returns.
- A dead or empty-return run is RESUMED first: `resumeFromRunId` with the same script + args replays completed agents from cache and reconstructs terminal state. `journal.jsonl` is only the forensic fallback when resume is impossible; it cannot reconstruct blocked/status/loop fields by itself.
- The args contract is dual on purpose: `waves[][]` (full task objects, zipped by the coordinator from `build-plan`'s id waves × `tasks[]`) from `/dobby:execute`; legacy `tasks[]` — one wave — from `/dobby:dispatch` and `/dobby:address-review`, whose contracts (including `status: 'done'` for success) did not move.
- The script's behavior is pinned by a committed harness (`cli/src/build-workflow.test.ts`) that extracts the fenced script from the markdown and runs it under stubbed runtime globals — the reference is no longer prose-only.
- The run receives the complete fixed `workflowRecipe` (`baseline-v1`) from `dobby env --json`. It validates that contract before spawning agents, enforces outer/concurrency caps of 2/2, performs mechanical verification first, and never dispatches a fix unless a later verifier attempt remains. Normal per-task review moved to the external PR boundary in ADR-0024; the former selectable budget contract is superseded by ADR-0023.
