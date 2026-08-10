# 0022. Resolve worker budgets centrally and apply them in the native Workflow

**Status:** superseded by [ADR-0023](./0023-fixed-baseline-workflow-recipe.md). Its bounded native-Workflow, mechanical-first, telemetry, and no-subprocess invariants remain; selectable budgets/profiles, escalation, `STATE.md` persistence, and the normal review loop do not. Review ownership is current in [ADR-0024](./0024-external-pr-review-boundary.md).

This ADR is retained as the historical record of the profile design evaluated before the fixed-recipe experiment. The present-tense policy below is no longer the current public contract.

Dobby remains a Claude Code-native plugin. The interactive `claude` session owns tools, hooks, `EnterWorktree`/`ExitWorktree`, custom agents, Workflow persistence/resume, and the single build run from [ADR-0021](./0021-single-build-run-per-plan.md). Consumption had become operationally unsafe, however: every worker was statically expensive, the build loop used fixed retry counts, and there was no authoritative view of the effective policy.

We centralize build-worker consumption policy in `cli/src/workflow-budget.ts` and expose its resolved form through `dobby env` (human and JSON). `/dobby:execute`, `/dobby:dispatch`'s rigorous path, and `/dobby:address-review` pass that complete ready `workflowBudget` into the existing verbatim build Workflow. The Workflow keeps each `agentType` (therefore the one prompt body in `plugin/agents/*.md`) while applying the resolved `model` and `effort` through native per-invocation `agent()` options. This capability was verified against the installed Claude Code 2.1.224 Workflow option schema (`agentType`, `model`, `effort`, `schema`, `isolation`); no subprocess is involved.

Profiles are `economical`, `standard`, and `critical`. They resolve role model/effort, `maxOuter`, `maxReview`, `maxConcurrency`, and verification posture. After scope has grounded the goal in the codebase, it recommends a profile from that evidence, the user confirms it, and the choice is stored in `STATE.md`'s `## Execution profile`. That session artifact is the only profile input: there is no project/global budget config, environment override, or CLI override. An ad-hoc path with no `STATE.md` uses bounded `standard`; a scoped or legacy session with no choice is `ready:false` until the user chooses. Any frontier/Opus role also requires a recorded evidence-based escalation reason, and `critical` is never implicit.

Agent prompt bodies and budget policy have different owners:

- `plugin/agents/*.md` is authoritative for role behavior and tool access.
- `cli/src/workflow-budget.ts` is authoritative for profiles, model/effort, limits, and escalation.
- Build-agent frontmatter model/effort is only the `standard` fallback for a direct Agent-tool call outside the build Workflow. A drift test pins those fields to the canonical standard policy; no prompt body is generated or duplicated.
- `researcher` dispatches happen outside the build Workflow. Dobby keeps one explicit `sonnet`/`medium` researcher frontmatter instead of exposing a partially inert profile override; research is a judgment-heavy grounding stage, not the place to take the profile's cheapest model.

The Workflow also enforces the consumption invariants mechanically: wave order and destructive isolation stay intact; tasks are chunked only inside a wave to honor concurrency; outer/review loops are bounded; scoped re-review receives only prior findings; and a code/test fix is dispatched only when a later review slot exists. Mechanical recipes run first. Because this Workflow surface exposes agent calls but no direct shell primitive, a separate verifier remains and executes the recipe with the cheapest adequate model before applying judgment.

## Considered options

- **Keep static frontmatter only** — rejected: direct Agent calls remain deterministic, but execute could not select profiles or report the session's effective policy and limits centrally.
- **Layer project, global, environment, and CLI overrides** — rejected: the resulting precedence is harder to understand than the three profiles, makes one goal's behavior depend on invisible machine/process state, and is unnecessary when `scope` can ask once and persist the answer beside that goal's other state.
- **Generate multiple agent definitions per profile** — rejected: it duplicates registration surfaces and makes prompt/policy drift likely. Native per-invocation options preserve one agent definition.
- **Run workers through `claude -p`, Codex, or a local process executor** — rejected: that creates new sessions/billing paths and discards native Workflow persistence, tools, hooks, and resume semantics.
- **Emulate same-role retry threads outside Workflow** — rejected: the installed Workflow API does not expose a role-thread resume handle. Dobby reports `sameRoleThreadReuse:false` instead of pretending.
- **Skip the verifier through a local shell executor** — rejected: changing harnesses to save one agent breaks the single native Workflow architecture. Mechanical-first prompting plus a cheaper verifier is the smallest truthful native option.

## Consequences

- `dobby env --json` is the authoritative diagnostic. Invalid or missing scoped selections remain visible in `issues`, resolve to bounded safe values for inspection, and set `ready:false`; execute never silently continues on them.
- The standard worker posture is materially cheaper than the former all-Opus build path; frontier use is exceptional and attributable.
- A build-profile change edits one policy table, not four prompts. A behavioral agent change still edits that agent directly; the fixed direct-call researcher budget is changed in its own frontmatter.
- A future task analyzer can replace scope's human-authored recommendation without changing persistence or execution: it may recommend a profile and cite evidence, but the user still confirms and `STATE.md` remains authoritative.
- Build-run telemetry records each native invocation's task/stage/role, resolved model/effort/profile, attempt/outcome, verification source, and escalation evidence, then summarizes retries, first-attempt success, cap exhaustion, and escalations.
- The Workflow script exposes no clock, token usage, provider identity, or its own run id. Those telemetry fields are the literal `unknown`; cost is not estimated and private transcript formats are not scraped.
- The main-thread Architect remains on the interactive session tier from ADR-0004. Worker profiles do not change the main thread's model.
