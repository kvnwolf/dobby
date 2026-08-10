# 0023. Run a fixed baseline Workflow recipe before adding budgets

**Status:** accepted — supersedes [ADR-0022](./0022-native-workflow-budget-policy.md)'s selectable profiles, escalation policy, and `STATE.md` execution-profile section.

ADR-0022 proved that Claude Code's native Workflow can apply model and effort per `agent()` invocation, bound loops and concurrency, and return honest telemetry without `claude -p`. Its three-profile selection system had not yet earned its operational surface, however. Project/global/session configuration, precedence, profile selection, and escalation rules would make every task carry policy ceremony before field data showed that more than one recipe was useful.

We will run one deterministic worker recipe for seven days. `cli/src/workflow-recipe.ts` is its sole policy source, `dobby env` exposes it as `workflowRecipe` in human and JSON output, and every Workflow consumer passes the complete object verbatim. Its id is `baseline-v1`; a deterministic fingerprint over the id, five ordered worker-role policies, both limits, and verification posture binds that label to the exact baseline. The build run recomputes and validates it before launching any Agent. The recipe is:

| Role | Model | Reasoning |
| --- | --- | --- |
| researcher | `claude-sonnet-5` | medium |
| test-author | `claude-opus-5` | high |
| implementor | `claude-sonnet-5` | high |
| reviewer | `claude-opus-5` | high |
| verifier | `claude-sonnet-5` | medium |

The build limits are `maxOuter=2` and `maxConcurrency=2`; verification is mechanical-first. There is no `maxReview`: reviewer remains a policy role for direct dispatch and missing-work-log safety review, not the normal execute loop. The concurrency cap is global to Dobby-owned fan-out: the build Workflow chunks tasks internally, and every skill that launches multiple direct Agents resolves the recipe first and runs sequential batches no larger than two. The recipe has no profile, per-task selection, dynamic escalation, Dobby config file, Dobby environment override, or CLI flag. Skills still inherit the interactive session; the user chooses the main-thread Architect's model/effort manually for the task, and it is deliberately not a recipe role. Claude Code's own operator control remains outside this contract: `CLAUDE_CODE_SUBAGENT_MODEL` can override subagent model pins, so an experimental run using it must be identified as such.

Agent prompt bodies remain authoritative in `plugin/agents/*.md`. Their frontmatter mirrors the recipe for direct Agent calls, while the native build Workflow applies build-role model/effort per invocation and retains `agentType`; tests reject drift across all five definitions. A behavioral prompt change edits its agent once. A policy change starts in `workflow-recipe.ts` and updates only the mechanically checked mirrors—never a second prompt.

`STATE.md` returns to seven canonical sections: Goal, Source, Exploration, Findings (interview), Research, Spec, and Work log. The retired `## Execution profile` is unknown legacy data: `dobby state lint` tolerates it and every state mutation preserves it byte-for-byte, but Dobby neither creates, reads, migrates, nor deletes it automatically.

The single build run keeps the parts of ADR-0022 that reduced amplification: waves execute once in order; concurrency is bounded; test-author, implementor, and verifier remain independent; mechanical recipes precede model judgment; retries stop at their caps; and a fix is legal only when another verifier attempt exists. Therefore no terminal code/test change can escape without later verification. Normal execute does not invoke a per-task reviewer; ADR-0024 puts holistic static review at the external PR boundary. A test-author, implementor, or fixer that returns no non-empty work log may already have mutated the shared tree, so the task consumes an independent safety review of the current scoped diff and then remains `needs-human`; absence of a result can never drift into a false `done` or leave a possible mutation unaudited. The Workflow progress view is the only live reporting surface—main does not invoke `Monitor`—and Dobby never substitutes `claude -p` or another harness.

Telemetry records one event per native agent call: task, stage, role, requested model/reasoning/recipe, attempt, outcome, verification source, and `escalationReason: null`. Its summary includes attempts, retries, first-attempt success, cap exhaustion, and verification-source counts. Runtime data the Workflow does not expose—provider, token counts, cache hits, duration, and its internal run id—stays explicitly `unknown`; cost is not fabricated.

## Experiment and review gate

For seven active days, do not tune role models ad hoc. Review quantitative evidence—first-attempt success, retries, cap exhaustion, outcomes, verification-source mix, and calls by role—alongside qualitative misses: inadequate architecture or research, external-review findings local verification should have caught, false verifier failures, and cases where a higher tier added no value. Host-level model overrides must be annotated. At the end, keep the baseline, revise it as a new recipe id, or design a smaller configuration surface only if repeated task evidence requires one.

## Considered options

- **Keep Economical / Standard / Critical** — rejected for now: it adds user ceremony and hidden experimental variance before one stable baseline has been observed.
- **Make Opus the default everywhere** — rejected: implementation and mechanical verification do not justify frontier cost by default.
- **Make Haiku the default for research or verification** — rejected: both roles interpret evidence that directly gates downstream correctness; Sonnet is the minimum baseline for this experiment.
- **Put model choices only in agent frontmatter** — rejected: the native build Workflow still needs one validated args contract for model/effort, limits, verification posture, and diagnostics.
- **Launch workers through `claude -p` or another CLI** — rejected: it changes billing/session semantics and loses native Workflow persistence, hooks, tools, and resume behavior.

## Consequences

- Every scoped and ad-hoc task uses the same observable recipe; there is nothing to select or persist.
- A malformed, absent, or fingerprint-mismatched `workflowRecipe` stops before any agent. Consumers never reconstruct the values by eye.
- The experiment favors comparability over per-task optimization. A pathological task can be paused or handled explicitly, but does not silently mutate the recipe.
- If evidence later earns profiles or an analyzer, that becomes a new decision; ADR-0022 is history, not dormant configuration.
