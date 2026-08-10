# Claude-Native Workflow Restoration and Fixed-Recipe Experiment Plan

> Status: mechanically complete — main-thread Architect restored, normal execute reviewer removed, live Workflow + external-review smoke pending
> Written: 2026-08-08
> Last updated: 2026-08-10
> Repository root: `/Users/kvnwolf/Developer/github.com/kvnwolf/dobby`
> Current branch: `feat/native-workflow-budgets`
> Recovery baseline: `14e5fba` (`main`, `origin/main`, `v0.11.0`)
> Important: the dual-host implementation has been removed. The profile-based budget implementation recorded below is useful history but has been superseded by the approved `baseline-v1` experiment in Section 0. No commit, push, or PR has been made.

## 0. Superseding decision — main-thread Architect, fixed worker recipe, and external PR review (approved 2026-08-09)

The user approved a one-week evidence-gathering experiment before investing in a configurable budget feature, then reversed the separate persistent-planning-agent experiment and removed the normal per-task code-review pass from execute. This section supersedes every profile-selection/configuration, persistent-architect, and normal-review-loop requirement later in this document; the restoration record and rationale below remain intact as history.

### Fixed recipe

There is exactly one Claude-native worker recipe, reported as `workflowRecipe.id: baseline-v1` by `dobby env` in human and JSON forms:

| Role | Model | Reasoning |
| --- | --- | --- |
| researcher | `claude-sonnet-5` | `medium` |
| test-author | `claude-opus-5` | `high` |
| implementor | `claude-sonnet-5` | `high` |
| reviewer | `claude-opus-5` | `high` |
| verifier | `claude-sonnet-5` | `medium` |

The recipe fixes `maxOuter = 2`, `maxConcurrency = 2`, and `verification = mechanical-first`. Its deterministic `fnv1a32:32afa935` fingerprint binds `baseline-v1` to the five ordered worker-role policies, both limits, and verification posture; the build run recomputes it before launching any Agent. The concurrency cap applies inside the Workflow and to every direct Agent fan-out (research, dispatch, address-review, improve-architecture, resolve-conflicts), which resolves the recipe and runs sequential batches no larger than two. There are no Economical/Standard/Critical profiles, user choices, project/global config keys, environment overrides, per-session overrides, or CLI flags. Full model ids are deliberate for this experiment. `cli/src/workflow-recipe.ts` is the worker model/effort/limit source of truth; the five agent frontmatter entries are direct-call mirrors protected by drift tests, while prompt bodies remain the role-behavior source of truth.

The build still runs as one native Workflow. The normal hot path is optional test-author → implementor → verifier. On the first verification failure, the same task may receive one implementor fix only because a second verifier attempt remains; a final verification failure stops `needs-human` with no terminal fix. The reviewer remains registered and pinned for explicit review dispatch and the exceptional missing-work-log safety review, but normal execute does not invoke it. Static PR review moves to the repository's external reviewer (currently Greptile) after commit/push; review silence or a result for an older HEAD is never merge-ready.

### Main-thread Architect

Planning returns to the original ownership model: the interactive main thread is the Architect across scope → interview → research → spec. The user chooses that session's model/effort manually for the task. The Architect owns the design tree, questions, research synthesis, completeness audit, and spec; it also owns worktrees, `AskUserQuestion`, worker launches, CLI/state writes, lint, routing, cancellation, and approval. It delegates hands-on exploration and implementation instead of spending main-thread context on them.

No `dobby:architect` agent, Fable policy, message relay, host handle, or reconstruction protocol remains. Scope, interview, research, and spec are ordinary main-thread skills backed by durable `STATE.md`; a fresh session in the same worktree reconstructs planning context from Goal, Source, Exploration, Findings, Research, and Spec rather than an old subagent transcript.

The subagent communication field test remains useful evidence for a future feature, but it does not justify permanent complexity now. A tested capability is not automatically an architectural requirement.

### State and experiment boundary

`STATE.md` returns to seven canonical sections: Goal, Source, Exploration, Findings (interview), Research, Spec, and Work log. New sessions never create `## Execution profile`. An older document that already has that heading remains valid and byte-preserved as an unknown section, but no runtime reads or automatically deletes it.

Run `baseline-v1` unchanged for seven days of real work, starting with the first successful live run. At the end, compare attempts, retries, first-attempt success, exhausted caps, outcomes, and mechanical-versus-model verification by role/task. Only then decide whether profiles, automatic task-intelligence recommendations, or a revised fixed recipe earn their complexity.

### Acceptance delta

In addition to the still-applicable Claude-native restoration checks below, the follow-up must prove:

1. `dobby env --json` returns the exact immutable `workflowRecipe`, fingerprint `fnv1a32:32afa935`, five roles, and `maxOuter=2` / `maxConcurrency=2` with no profile/state/config/override source; the build run rejects an absent, stale, or role-drifted recipe before Agents.
2. All five agent mirrors match the recipe; no architect agent, Fable policy, or old generic model alias remains.
3. New state has seven sections; legacy `## Execution profile` content is accepted and preserved but never created or read.
4. Scope, interview, research, and spec keep planning in the interactive main thread and resume from durable state without a persistent subagent handle.
5. Normal execute launches no reviewer and exposes no `maxReview`; every implementor fix has a later verifier attempt, while explicit reviewer dispatch and missing-work-log safety review remain available.
6. External PR review is required on the current HEAD before merge readiness; stale summaries and review silence fail closed. Greptile requires its passing commit check plus a matching footer SHA, every required adapter must validate one common SHA, and finish pins that SHA with `--match-head-commit`.
7. Focused tests, typecheck, lint, full `dobby check --no-cache`, `git diff --check`, and manifests pass before handoff.

## 1. Decision and desired outcome

Dobby will return to being a **Claude Code-native plugin**. Claude Code remains the harness, session owner, tool runtime, hook runtime, worktree owner, and workflow engine.

The build path must remain:

```text
interactive Claude Code session
  -> Dobby skill (scope / execute / ...)
  -> native Claude Code Workflow tool
  -> native Dobby custom agents
  -> Claude Code tools, hooks, worktrees, and workflow persistence
```

Hard constraints:

1. Never orchestrate Dobby by spawning `claude -p`.
2. Never orchestrate Dobby by spawning `codex exec` or another headless agent CLI.
3. Preserve one native Workflow invocation for the entire approved build plan.
4. Preserve waves, independent implementor/verifier roles, the optional test-author, `STATE.md`, native worktrees, native Workflow resume, typed returns, and serial work-log persistence. Keep the reviewer available outside normal execute.
5. Restore every existing Claude skill, agent, command, hook, manifest, lifecycle contract, and document before applying budget changes.
6. Remove the Codex host adapter, Codex manifests, process executor, cross-host state layer, and dual-host documentation.
7. Retain only consumption improvements that can be implemented without replacing the native Workflow architecture.
8. An execute fix may never run unless a later verifier attempt is still available.
9. `critical` must never be the default budget profile.
10. Do not commit, push, open a PR, or delete the recovery archive unless the user explicitly requests it.
11. Do not modify or remove the existing locked worktree `.claude/worktrees/issue-24-de-slop-skill`.
12. Preserve `PLAN.md` throughout the rollback.

## 2. Harness versus inference transport

These are separate layers:

```text
HARNESS / ORCHESTRATION                         INFERENCE TRANSPORT
Claude Code                                    Direct Anthropic subscription/API
- interactive session                 +        or
- Dobby plugin                                  local Anthropic-compatible bridge
- slash commands                                -> OpenAI/Codex-backed inference
- Workflow tool
- custom agents
- PostToolUse hooks
- EnterWorktree / ExitWorktree
- workflow run journal and resume
```

Changing the inference transport must not change the harness. If a local bridge is evaluated later, it must be configured **before launching a real interactive `claude` process**. Dobby still invokes the native Workflow tool from that interactive session. It does not launch another Claude or Codex process per task, role, wave, or retry.

This distinction is load-bearing:

- `claude -p` is a new headless Claude invocation. It is not the active interactive Workflow and may have different billing/session behavior.
- A local Anthropic-compatible bridge changes where Claude Code sends model requests, while Claude Code continues to own tools and orchestration.
- The bridge is optional transport infrastructure, not a second Dobby host and not part of Dobby Core.
- Direct Anthropic mode must continue to work without the bridge.
- A bridge must not be adopted until its authentication, credential storage, network binding, traffic logging, tool-call compatibility, and account/billing behavior have been audited and smoke-tested.

## 3. Repository state at handoff

The repository was clean before the dual-host work began. The migration has no commits; all migration changes are recoverable from the current working tree, while the original implementation remains at `HEAD` (`14e5fba`).

At the time this plan was written:

- Branch at recovery time: `feat/dual-host-codex` (later renamed to `feat/native-workflow-budgets` once the dual-host work was gone).
- HEAD: `14e5fba`.
- The branch contains no commits ahead of `main`.
- The tracked migration diff affects 80 files.
- The migration also added untracked Codex/core/adapter files.
- `PLAN.md` did not previously exist.
- The pre-migration quality gate passed with `bunx dobby check --no-cache`.
- A separate Claude worktree exists at `.claude/worktrees/issue-24-de-slop-skill`; it is outside this rollback.

The original Claude implementation at `HEAD` has these contracts:

- `/dobby:scope` creates and enters `.claude/worktrees/<slug>/` with the native `EnterWorktree` tool.
- `/dobby:execute` invokes one native Workflow for the whole plan.
- The Workflow dispatches `dobby:test-author`, `dobby:implementor`, `dobby:reviewer`, and `dobby:verifier` with `agentType`.
- Waves execute sequentially; independent tasks inside a wave execute in parallel.
- A dead/empty Workflow is resumed with `resumeFromRunId`, preserving completed agent calls.
- Workflow workers return work logs; the interactive coordinator appends them to `STATE.md` serially.
- The `PostToolUse` hook matches `Edit|Write` and runs local `dobby check --hook`. The CLI extracts the edited path from the hook payload, so the check remains scoped to the edited file.

### Known bug in the original Workflow

The original review loop can dispatch a code or test fix after the final failed review attempt and then return `needs-human`. That leaves a terminal fix with no re-review. The rollback must restore the baseline first, and the first behavior correction afterward must enforce:

```text
review failed
  -> another review slot exists? yes -> apply fix -> re-review
  -> another review slot exists? no  -> needs-human, with NO fix
```

## 4. Scope: remove versus retain

### Remove completely

- `.codex/`, `AGENTS.md`, and Codex plugin manifests.
- Codex agent TOML/rendered files.
- `docs/dual-host/`, ADR 0022, the dual-host inventory, and the host contract.
- Host detection and `DOBBY_HOST` behavior.
- Anthropic/OpenAI provider maps inside Dobby.
- The process-based `execute` implementation.
- `claude -p`, `codex exec`, and subprocess agent adapters.
- Cross-host session, thread, worktree, journal, and resume adapters.
- Codex-specific hook payload parsing.
- Generated canonical skill/agent structures introduced solely for two hosts.
- CI, packaging, docs, ADR, skill, and agent changes that describe dual-host behavior.

Do not preserve dual-host code merely because one of its ideas is useful. Restore first, then reimplement useful behavior in the native Claude Workflow.

### Retain by reimplementing on the Claude-native baseline

- Economical, standard, and critical consumption profiles where the native runtime can honor them.
- Lower-cost default role assignments; frontier use should be exceptional rather than universal.
- Central reporting of effective budget configuration through `dobby env` in human and JSON forms.
- Explicit retry and concurrency limits.
- The no-terminal-fix invariant.
- Mechanical checks before model judgment wherever native Workflow can do this without a subprocess host adapter.
- A cheap verifier path for mechanical work when a model is still required by native Workflow constraints.
- Evidence-based escalation with a recorded reason.
- Smaller task packets and reuse of already-produced artifacts.
- Telemetry that the native Claude/Workflow runtime actually exposes; unavailable token fields must be `unknown`, not fabricated.

### Do not promise unsupported behavior

Before designing runtime model overrides or same-role thread reuse, verify the actual Workflow API available in Claude Code. If `agent()` cannot override a custom agent's model/effort or resume a particular role thread, document that limitation and use the smallest Claude-native alternative. Do not reintroduce subprocess orchestration to simulate it.

## 5. Execution phases

Each phase is a checkpoint. Run focused tests after every material block and keep `git status` visible. Do not continue through an unexpected user change.

### Phase 0 — Safety and provenance

1. Detect the root instead of trusting the ambient directory: `git rev-parse --show-toplevel`.
2. Inspect `git branch --show-current`, `git rev-parse HEAD`, `git status --short --branch`, and `git worktree list --porcelain`.
3. Verify that HEAD is still `14e5fba` and dirty paths match Appendix A plus `PLAN.md`. If additional paths or materially different diffs exist, classify them before restoring anything and preserve later user edits.
4. Create a recoverable archive outside the repository:

   ```sh
   DOBBY_RECOVERY_DIR="$(mktemp -d /tmp/dobby-claude-restore.XXXXXX)"
   git diff --binary --output="$DOBBY_RECOVERY_DIR/tracked-migration.patch" HEAD
   ```

5. Archive the exact untracked migration paths from Appendix A. Exclude `PLAN.md` and the existing Claude worktree. Report the recovery directory and do not delete it at task end.
6. Inspect the patch/archive before any restore. They are a safety net, not a new source of truth.

Checkpoint: nothing has been restored and the recovery location has been reported.

### Phase 1 — Restore the exact Claude-only baseline

1. Restore only tracked migration paths in Appendix A from `HEAD`. Do not use `git reset --hard`, `git checkout -- .`, or broad `git clean`.
2. Move exact untracked migration paths from Appendix A into the recovery directory while preserving relative paths. Do not remove `PLAN.md`; do not touch `.claude/worktrees/issue-24-de-slop-skill`.
3. Verify that the resulting diff contains only `PLAN.md`.
4. Run `bunx dobby check --no-cache`.
5. Discover and run the restored repository's authoritative tests. Record pre-existing failures separately.
6. Confirm that:

   - Original `plugin/skills/execute/references/build-workflow.md` is restored.
   - Original comprehensive `cli/src/build-workflow.test.ts` is restored; the small retirement guard is gone.
   - `plugin/hooks/hooks.json` contains the Claude `PostToolUse` hook.
   - `scope` requires native `EnterWorktree`.
   - `execute` requires Workflow and `resumeFromRunId`.
   - All 30 original skills and all 5 original agents are restored.
   - Claude plugin and marketplace manifests parse.

Checkpoint: Dobby is byte-for-byte Claude-only again, except for `PLAN.md`, and baseline checks pass.

### Phase 2 — Establish a Claude-native budget contract

Add a small budget policy without introducing a host abstraction.

| Profile | Ad-hoc fallback? | Intent | Posture |
| --- | --- | --- | --- |
| `economical` | no | Minimum routine consumption | Lowest safe retries/concurrency; fast/standard roles |
| `standard` | yes | Daily development | Bounded retries; frontier only with evidence |
| `critical` | no | High-risk work | Stronger review/reasoning; still bounded |

The policy should cover, to the extent native Claude Code supports it:

- Role model tier or Claude alias (`haiku`, `sonnet`, `opus`).
- Role reasoning effort.
- `maxOuter`, `maxReview`, and `maxConcurrency`.
- Whether model judgment is required after mechanical checks.
- Escalation permissions and accepted reasons.

Recommended posture:

- Research: Sonnet/medium — grounding and contradiction detection need judgment.
- Routine mechanical verification: fast/cheap.
- Test author, implementor, and reviewer: standard by default.
- Architect/frontier: architecture, security, irreversible changes, repeated failure, concurrency hazards, data migrations, or non-reproducible behavior.
- Critical: explicit opt-in only.

Profile ownership:

- After codebase exploration, `/dobby:scope` recommends `economical`, `standard`, or `critical` from the evidence and asks the user.
- Persist the confirmed choice in `STATE.md`'s `## Execution profile`; this work session is the ownership boundary.
- Do not expose project/global JSON, environment, session, or CLI budget overrides.
- A legacy scoped session without the section is prompted once when execute resumes it. An ad-hoc path with no `STATE.md` uses bounded Standard.
- A future analyzer may produce the recommendation and evidence, but the user remains the decision gate and `STATE.md` remains authoritative.

`dobby env` should report an effective `workflowBudget` in human and JSON output, including whether the profile came from session state or the ad-hoc default. It must not report a host adapter, Codex executable, or cross-host session state.

Example, not a required exact schema:

```json
{
  "workflowBudget": {
    "profile": "standard",
    "roles": {
      "implementor": {
        "tier": "standard",
        "model": "sonnet",
        "reasoning": "high"
      }
    },
    "limits": {
      "maxOuter": 2,
      "maxReview": 2,
      "maxConcurrency": 2
    }
  }
}
```

#### Native model-control capability gate

Original custom agents use static `model` and `effort` frontmatter. Before implementing profiles, prove one path in a real Claude Code session:

1. Preferred: native Workflow `agent()` accepts effective model/effort while retaining `agentType` instructions.
2. Acceptable: Claude Code provides a documented native mechanism to resolve them at launch/install time.
3. Fallback: keep cheaper static frontmatter defaults and let profiles control retries, concurrency, escalation policy, and verifier use. Report runtime model overrides as unsupported rather than pretending they applied.

Do not generate multiple editable copies of an agent prompt. Agent bodies remain authoritative for role behavior. If only frontmatter fields are generated or validated, mark those fields and add a drift test; do not mark the prompt body generated.

Checkpoint: policy resolution is tested and `dobby env --json` tells the truth.

### Phase 3 — Apply limits inside the native build Workflow

Modify the existing Workflow template; do not replace it with a TypeScript process executor.

1. Pass resolved limits in existing Workflow `args`, alongside `waves`, `devUrl`, `hasTestSuite`, and `workRoot`.
2. Validate limits before spawning an agent; an explicitly unready session starts zero agents, while missing defensive Workflow args use bounded Standard values.
3. Replace fixed `MAX_OUTER = 3` and `MAX_REVIEW = 3` with validated args.
4. Enforce `maxConcurrency` while preserving wave order and destructive-task isolation. Chunk only inside a wave; never flatten/regroup waves.
5. Fix the terminal-review bug: after failure, check for another review slot **before** dispatching `test-fix` or `fix`.
6. Preserve `test-author != implementor != reviewer != verifier`.
7. Preserve one Workflow per plan and `resumeFromRunId`.
8. Log profile, attempts, limit exhaustion, and escalation reasons in existing progress/final results without transcript noise.

Required deterministic tests:

- `maxReview = 1`: failed review dispatches zero fixes.
- `maxReview = 2`: first failure may dispatch a fix and one re-review; second failure dispatches no fix.
- Test-contract fixes obey the same rule as code fixes.
- Every dispatched fix has a later reviewer call.
- Outer retries stop at `maxOuter`.
- Active tasks never exceed `maxConcurrency`.
- Wave boundaries and dependency blocking are unchanged.

Checkpoint: native Workflow remains the executor and its bounded state machine passes.

### Phase 4 — Reduce token amplification without changing harnesses

1. Keep task context compact: title, spec, relevant decisions/constraints, affected areas, fixed test contract, and current findings. Do not resend all `STATE.md` to every role.
2. Reuse scope/interview/research/spec artifacts; do not make each worker rediscover the repository broadly.
3. Keep re-review scoped to prior findings and regressions caused by the fix.
4. Record why a role escalates to frontier. A profile alone is not an escalation reason.
5. Prefer the cheapest role capable of mechanical/read-only work.
6. Verify native same-role thread reuse. Use it if supported; otherwise document the limitation and never emulate it with `claude -p`.

Mechanical verification gate:

- If Workflow exposes a native shell/tool primitive, run deterministic recipes first and invoke `dobby:verifier` only for judgment, visual interaction, interpretation, or diagnosis.
- If Workflow executes tools only through an agent, retain a separate verifier but use the cheapest adequate model and an exact reproducible command.
- Do not move orchestration into a local executor merely to skip a verifier call.
- Distinguish “mechanically proven”, “model-judged”, and “not available” in output/telemetry.

Checkpoint: reductions do not alter native Workflow/session semantics.

### Phase 5 — Add honest native telemetry

Capture only data exposed by interactive Claude/Workflow: `runId`, `taskId`, stage, role, model/alias when known, reasoning when known, profile, attempt, duration, outcome, and escalation reason. Report input/cached/output token fields as `unknown` if Claude Code does not expose them.

Prefer existing Workflow run data/final return plus `STATE.md`; do not recreate the removed cross-host journal or scrape private transcript formats. At minimum summarize attempts, retries, first-attempt success, limit exhaustion, escalations, and mechanical versus model-based verification. Estimate cost only from trustworthy runtime data.

Checkpoint: telemetry is useful without fabricated values or new session-storage coupling.

### Phase 6 — Verify Claude behavior end to end

Run a real interactive Claude Code smoke with the local plugin, never `claude -p`:

1. `/dobby:scope` invokes `EnterWorktree`, creates the expected branch/directory, runs setup, and initializes `STATE.md` there.
2. An `Edit`/`Write` event triggers `dobby check --hook` for only the edited file.
3. `/dobby:execute` opens one native Workflow for a small two-task plan.
4. Waves and concurrency limits are honored.
5. Implementor, reviewer, and verifier are distinct agents.
6. Failed review follows fix -> re-review; final failure produces no unreviewed fix.
7. Interruption resumes with `resumeFromRunId`; completed calls are not recreated.
8. Returned work logs append to `STATE.md` serially.
9. Direct Anthropic mode works as before.

Use a disposable fixture/repository for lifecycle smoke tests. Never use the unrelated locked worktree.

Checkpoint: Dobby is productive through native Claude Code with budget controls.

### Phase 7 — Optional Codex-subscription transport spike

This is optional and separate from Dobby architecture. Do not begin until Phases 0–6 are green. Never silently install/authenticate a third-party bridge.

1. Audit source, releases, license, maintenance, credential handling, local storage, network destinations, logging, proxy binding, streaming, tool use, and Claude Code compatibility.
2. Bind only to loopback and disable traffic capture by default.
3. Keep model mapping in bridge/launch configuration, not Dobby skills or agents. Conceptually: `haiku -> economical`, `sonnet -> standard`, `opus -> frontier` Codex model.
4. Document two explicit launch modes: direct Anthropic and loopback bridge. Both launch real interactive `claude`; neither uses `-p`.
5. Use a fresh process when changing modes because endpoint/auth state is selected at launch.
6. Repeat all Phase 6 tests through the bridge using the exact same plugin, Workflow, agents, hooks, worktree behavior, and `STATE.md`.
7. Confirm expected subscription consumption and absence of unintended metered API charges.
8. If fidelity is incomplete, document the incompatibility and keep bridge mode experimental. Never fall back silently to process orchestration.

Checkpoint: if successful, Codex is only an inference backend behind Claude Code—not a Dobby host.

### Phase 8 — Documentation and final gate

Update restored docs to state the final truth:

- `CLAUDE.md`: Claude is the harness, Workflow is mandatory, and budget ownership/edit rules.
- `CONTEXT.md`: profile, escalation, mechanical verification, and budget vocabulary.
- `README.md`: profiles, `dobby env`, native Workflow, and optional bridge only if validated.
- CLI docs: exact state contract, output, profile semantics, and limitations.
- ADRs: preserve single terminal host and single build run; add a focused budget ADR only if warranted.
- Agent docs: say precisely whether model/effort fields are authoritative, validated, or generated. Never forbid prompt-body edits unless another canonical prompt really exists.

Final gate:

- Restored and new tests pass.
- `bunx dobby check --no-cache` and `git diff --check` pass.
- Manifests parse.
- No production invocation of `claude -p` or `codex exec` exists.
- No Codex host manifest/adapter or dual-host contract remains.
- `critical` is not default.
- Live Workflow and single-file PostToolUse smokes pass.
- Status contains only deliberate plan/budget/native-Workflow changes.
- No commit, push, or PR was made.

## 6. Acceptance criteria

- Dobby runs entirely inside interactive Claude Code.
- Scope creates a native Claude worktree.
- Execute uses one native Workflow for the whole plan.
- No per-agent subprocess harness exists.
- Original skills, agents, commands, hooks, and plugin behavior remain supported.
- PostToolUse still runs local single-file checks.
- Budget profiles/limits are centrally and truthfully reported.
- Default consumption is lower; critical is opt-in.
- Frontier escalation requires recorded evidence.
- Retries/concurrency are bounded.
- No terminal fix escapes without re-review.
- Mechanical verification comes first wherever native Workflow supports it; limitations are explicit.
- Workflow resume and `STATE.md` continuity remain native.
- Direct Anthropic operation is not regressed.
- Any Codex-subscription bridge is optional, audited, interactive, and invisible to Dobby orchestration.
- No PR exists until the user asks.

## 7. Fresh-session kickoff

Use this as the first instruction in the new session:

> Read `PLAN.md` completely before taking action. Detect the Git root, inspect status/HEAD/worktrees, and execute Phase 0 onward in small tested increments. First restore the exact Claude-only baseline, preserving `PLAN.md` and the unrelated locked worktree. Then reimplement only budget/consumption improvements inside the native Claude Code Workflow. Never invoke `claude -p` or `codex exec`, never replace Workflow with a process executor, and do not commit, push, or open a PR until I explicitly ask. Stop only for unexpected user changes, credentials/account risk, or another genuinely destructive ambiguity.

## 8. Execution record

Executed on 2026-08-08 from Git root `/Users/kvnwolf/Developer/github.com/kvnwolf/dobby`.

- **Phase 0 — complete.** Captured the tracked migration as `/tmp/dobby-claude-restore.wRI1OF/tracked-migration.patch` (SHA-256 `9d9213659671e8db829fa0e365c8dee6f8e77c5dea4e8350918d4bce9d304dae`) and the untracked migration as `/tmp/dobby-claude-restore.wRI1OF/untracked-migration.tar` (SHA-256 `8f683c73a6fb43bd7cfe7feddddc4109bdfd362995d7a098bccce9366e368541`). The archive remains outside the repository and has not been deleted.
- **Phase 1 — complete.** Restored the exact Claude-only baseline before reimplementation. Removed the Codex host, generated Codex surfaces, process executor, cross-host state, and dual-host documentation. The unrelated locked worktree `.claude/worktrees/issue-24-de-slop-skill` was not changed.
- **Phases 2–3 — complete.** Added the canonical native budget resolver, three profiles, per-work-session selection persisted in `STATE.md`, escalation evidence, `dobby env` human/JSON reporting, native per-invocation model/effort, concurrency/retry enforcement, and the no-terminal-fix invariant. Project/global JSON, environment, session, and CLI budget overrides were deliberately removed. The executor remains one Claude Workflow and never launches another agent CLI.
- **Phases 4–5 — complete.** Added no-action amplification cuts, mechanical-first verification instructions, and honest per-invocation/summary telemetry. Unsupported token, duration, provider, and run-id fields remain explicitly `unknown`; same-role thread reuse is reported unsupported rather than emulated.
- **Phase 6 — partially complete, externally blocked.** Static/runtime capability inspection passed. A disposable plugin fixture proved that the `PostToolUse` `Edit|Write` hook runs `dobby check --hook` against only the edited file. A real interactive `claude --plugin-dir .../plugin` session was launched without `-p`, but Claude rejected `/dobby:scope` immediately because the account's weekly quota was exhausted, before any tool or worktree action ran. Therefore the live scope/worktree, Workflow, resume, and `STATE.md` smoke checklist remains pending; no false pass is recorded.
- **Phase 7 — intentionally skipped.** The optional inference-transport bridge was not authorized or needed for the Claude-native restoration, and its prerequisite live Phase 6 smoke is not yet green.
- **Phase 8 — mechanically complete at that now-superseded checkpoint.** Documentation and ADRs described the restored Claude-only ownership model and edit rules. Focused tests passed (161 budget/config/Workflow tests; 104 `env` tests), typecheck and lint passed, and `bunx dobby check --no-cache` passed. `git diff --check` passed; all three plugin/hook JSON manifests parsed; the then-current inventory was 30 skills and 5 agents; `critical` was not the default; no production `claude -p`, `codex exec`, Codex manifest/adapter, or dual-host contract existed. Section 0 and the final record below replace its temporary budget policy.
- **Follow-up cleanup — complete.** Removed the ineffective `Monitor` relay from `/dobby:execute`; the native Workflow run is now the only live-status surface, while its final typed result remains authoritative for `STATE.md` and telemetry. Narrowed dynamic `workflowBudget` roles to the four agents actually launched by that Workflow. Direct-call researchers are explicitly fixed at `sonnet`/`medium`, so research retains adequate judgment without advertising a partially inert profile override. Scope now recommends a profile after exploration, asks the user, and persists the answer in the new `## Execution profile`; legacy seven-section sessions are upgraded mechanically on first resume. On 2026-08-09, 137 focused state/budget/Workflow/config tests passed, TypeScript/Biome/Knip passed, and `bunx dobby check --no-cache` passed over the complete tree after the simplified state-owned profile contract landed.
- **Superseding fixed-recipe follow-up — superseded again by the final simplification (2026-08-09; verified 2026-08-10).** The fixed `workflowRecipe: baseline-v1`, seven-section state skeleton, fan-out cap, honest telemetry, and removal of the ineffective Monitor relay remain. The persistent Fable architect and its protocol were removed; planning belongs to the manually tuned main thread. The normal execute reviewer and `maxReview` were removed; execute is optional test-author → implementor → verifier, with at most one actionable code/test-contract correction followed by another verifier attempt. Environment/human failures stop without a writer, incoherent verdicts fail closed, and direct implementor consumers honor completed/blocked/invalid results. The reviewer remains available for explicit dispatch and the exceptional missing-work-log safety review. PR-level static review moves to an external current-HEAD boundary: Greptile requires a passing check plus matching footer SHA; HEAD drift restarts CI/review; multiple required adapters must validate one common SHA; finish pins it with `--match-head-commit`. The recipe fingerprints five worker policies plus 2 / 2 outer/concurrency limits as `fnv1a32:32afa935`.
- **Final mechanical verification — complete (2026-08-10).** The exact focused suite passed 648 tests across workflow-recipe, build-workflow, review, state, run, and registry. TypeScript and Biome passed; all 17 changed skill directories linted with zero findings; the plugin manifest parsed; `git diff --check` passed; and the full `node_modules/.bin/dobby check --no-cache` gate exited 0 (`build` intentionally skipped because this repo has no Vite capability). Independent read-only reviews found no remaining release-blocking contract issue after the common-SHA multi-adapter race was closed.
- **Repository state.** HEAD remains `14e5fba06bb15441bf4bccc25df2ba8cdda9bda8` on `feat/native-workflow-budgets`. The local branch was renamed from its obsolete dual-host name after the rollback. No commit, push, PR, or worktree mutation was performed.

The only remaining non-mechanical acceptance is a real native Workflow run and a live external-review round on a consumer PR (including a post-fix current-HEAD Greptile gate). Those operations were not launched from this Codex session because they consume external model/review capacity and mutate remote PR state. The implementation is mechanically green; live end-to-end acceptance remains explicitly pending rather than recorded as a false pass.

## Appendix A — rollback inventory

This inventory was captured immediately before `PLAN.md`. Recompute and compare it in Phase 0; it is not permission to overwrite a later user change.

### Tracked migration paths to restore from `HEAD`

```text
.claude-plugin/marketplace.json
.github/workflows/ci.yml
CLAUDE.md
CONTEXT.md
README.md
cli/CONTEXT.md
cli/README.md
cli/package.json
cli/src/artifact-lint-b.test.ts
cli/src/artifact-lint.ts
cli/src/build-workflow.test.ts
cli/src/buildplan.ts
cli/src/check.ts
cli/src/config-schema.test.ts
cli/src/config.ts
cli/src/envinfo.ts
cli/src/release.test.ts
cli/src/release.ts
cli/src/run.test.ts
cli/src/run.ts
cli/src/runner.ts
cli/src/ship.test.ts
cli/src/ship.ts
cli/src/tasks.ts
dobby.config.json
docs/adr/0002-build-loop-four-step.md
docs/adr/0004-session-level-model-effort.md
docs/adr/0010-single-terminal-host.md
docs/adr/0017-mechanical-enforcement-of-the-gate-ship-and-the-pre-push-backstop.md
docs/adr/0021-single-build-run-per-plan.md
plugin/.claude-plugin/plugin.json
plugin/agents/implementor.md
plugin/agents/researcher.md
plugin/agents/reviewer.md
plugin/agents/test-author.md
plugin/agents/verifier.md
plugin/hooks/hooks.json
plugin/skills/address-review/SKILL.md
plugin/skills/backlog/SKILL.md
plugin/skills/commit/SKILL.md
plugin/skills/create-skill/SKILL.md
plugin/skills/create-skill/references/frontmatter.md
plugin/skills/data-fetching/SKILL.md
plugin/skills/data-processing/SKILL.md
plugin/skills/diagnose/SKILL.md
plugin/skills/dispatch/SKILL.md
plugin/skills/execute/SKILL.md
plugin/skills/execute/references/build-workflow.md
plugin/skills/finish/SKILL.md
plugin/skills/handoff/SKILL.md
plugin/skills/improve-architecture/SKILL.md
plugin/skills/improve-architecture/references/html-report.md
plugin/skills/interview/SKILL.md
plugin/skills/learn/SKILL.md
plugin/skills/learn/scripts/digest-transcript.py
plugin/skills/learn/scripts/resolve-session.sh
plugin/skills/map/SKILL.md
plugin/skills/mark/SKILL.md
plugin/skills/mark/scripts/mark.sh
plugin/skills/migrate-config/SKILL.md
plugin/skills/module-conventions/SKILL.md
plugin/skills/onboard/SKILL.md
plugin/skills/onboard/references/dobby-config.md
plugin/skills/prototype/SKILL.md
plugin/skills/prototype/references/logic.md
plugin/skills/prototype/references/ui.md
plugin/skills/release/SKILL.md
plugin/skills/research/SKILL.md
plugin/skills/resolve-conflicts/SKILL.md
plugin/skills/scope/SKILL.md
plugin/skills/spec/SKILL.md
plugin/skills/spec/references/architecture-vocab.md
plugin/skills/spec/references/task-decomposition.md
plugin/skills/spec/references/testing-decisions.md
plugin/skills/teach/SKILL.md
plugin/skills/triage/SKILL.md
plugin/skills/upgrade/SKILL.md
plugin/skills/wizard/SKILL.md
plugin/skills/wrap/SKILL.md
scripts/dev-link.sh
```

### Untracked migration paths to archive and remove

```text
.codex/
AGENTS.md
cli/core/
cli/src/adapters.test.ts
cli/src/adapters.ts
cli/src/dual-host-inventory.test.ts
cli/src/execute-cli.test.ts
cli/src/execute.test.ts
cli/src/execute.ts
cli/src/host-adapter.test.ts
cli/src/host-adapter.ts
cli/src/journal.test.ts
cli/src/journal.ts
cli/src/model-policy.test.ts
cli/src/model-policy.ts
cli/src/policy-types.ts
cli/src/session.test.ts
cli/src/session.ts
cli/src/telemetry.test.ts
cli/src/telemetry.ts
cli/src/worktree.test.ts
cli/src/worktree.ts
docs/adr/0022-dual-host-canonical-core.md
docs/dual-host/
plugin/.codex-plugin/
plugin/references/
```

### Paths that rollback must preserve

```text
PLAN.md
.claude/worktrees/issue-24-de-slop-skill
```
