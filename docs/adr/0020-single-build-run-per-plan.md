# 0020. Single build run per plan

`/dobby:execute` used to launch one Workflow-tool run per wave, with the chat silent until the final table — N ceremonies per plan and no live signal. We decided the whole approved plan goes into ONE Workflow invocation (the **build run**): the verbatim script in `skills/execute/references/build-workflow.md` sequences the waves itself (`parallel()` inside each wave, preserving area-disjointness and destructive-task isolation), skips dependents of a `needs-human` task as `blocked` (transitively, zero agents spawned, via the `dependsOn` field `build-plan` now exposes), and narrates itself with `log()` — adaptive verbosity: one terminal line per task plus retry lines, escalating to full milestone detail only for a task that failed a review or verify.

## Considered Options

- **One workflow per wave (status quo)** — rejected: N launches per plan, no per-task signal, and the inter-run gaps were the only reporting moments, which made reporting per-WAVE at best.
- **Model-authored orchestration per invocation** — rejected: the script stays a PREDEFINED verbatim component (parameterized only via `args`) because the ADR-0002 invariants (caps, scoped re-review, single-writer work log, worktree preamble) must survive every run.
- **Persisted chat messages mid-run from the workflow** — impossible: the runtime gives the main thread nothing until the final return; `log()` narrator lines are the run's only live voice, and they render only in the /workflows progress widget (ephemeral UI).

## Consequences

- The trade-off surfaced by the first real-runtime smoke: `log()` narration is invisible to a user who never opens the /workflows widget. Resolved by the **coordinator relay** — after launching, the coordinator watches the run's `journal.jsonl`/output and echoes each task's terminal outcome into the chat (persisted, user's language) as it lands, ending the watch when the run returns. The relay is reporting only; the coordinator still never implements, reviews, or verifies.
- A dead run is RESUMED, never rebuilt: `resumeFromRunId` with the same script + args replays completed agents from cache; an empty/null return means reading `journal.jsonl` before re-running anything. Work logs are appended only after the run returns, so the journal is the crash-recovery source.
- The args contract is dual on purpose: `waves[][]` (full task objects, zipped by the coordinator from `build-plan`'s id waves × `tasks[]`) from `/dobby:execute`; legacy `tasks[]` — one wave — from `/dobby:dispatch` and `/dobby:address-review`, whose contracts (including `status: 'done'` for success) did not move.
- The script's behavior is pinned by a committed harness (`cli/src/build-workflow.test.ts`) that extracts the fenced script from the markdown and runs it under stubbed runtime globals — the reference is no longer prose-only.
