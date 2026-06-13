# Domain glossary

The vocabulary of the dobby kit. Use these terms exactly — in skills, agents, docs, and conversation.

- **Architect** — the main thread. It frames the work, decides, and reviews what comes back. It NEVER writes code; that asymmetry (expensive cognition at the top, hands-on work delegated) is the kit's core design.
- **Worker** — one of the four custom agents that do the hands-on work: `researcher`, `implementor`, `reviewer`, `verifier`. Each has a fixed role, toolset, model, and effort.
- **Work session** — one end-to-end run over a single goal, moving through stages: scope → interview → research → spec → execute → wrap.
- **Stage** — one step of a work session. Each stage is a skill that does its job and ends by handing the user the next command to type — handoffs are typed, never auto-invoked, so each stage runs on its own declared model/effort.
- **Convention skill** — a skill that encodes the user's standard application stack (TanStack Start + Drizzle/Neon + Better Auth, the `@/shared` form/data system) rather than methodology: `forms` and `data-fetching`. It auto-activates while building, intentionally references the consuming project's module barrels, and is NOT a work-session stage.
- **STATE.md** — the ephemeral session doc at the target repo's root, created by `/dobby:scope`. Accumulates `## Exploration`, `## Findings (interview)`, `## Research`, `## Spec`, `## Work log`. Disposed at wrap — it is never committed.
- **Trifecta** — the implement → code-review → verify loop, one SEPARATE agent per role, looping until review and verify both pass. Encoded once in the `dobby:execute` skill's `references/build-workflow.md` and reused by `/dobby:dispatch`.
- **Wave** — a batch of area-disjoint tasks the trifecta workflow runs in parallel. Overlapping areas serialize; shared-state verification never overlaps.
- **Work log** — the per-task implementation record (diff summary, decisions, deviations) an implementor RETURNS (it never writes `STATE.md`); the architect appends entries serially as the single writer.
- **Verify recipe** — the per-task steps a verifier executes against the already-running app to prove the task works. Written at spec time, consumed at execute time.
- **needs-human** — terminal task status when review or verify never passed within the retry caps. The workflow doesn't thrash; it escalates.
- **Dispatch** — the lightweight ad-hoc path: a scoped task handed to one worker (or the single-task trifecta), no `STATE.md`, no waves.
- **Prototype** — throwaway code that answers ONE design question, then dies. Two branches: **logic** (a minimal TUI over a pure, portable module) and **UI** (3-5 radically different variants on one route with a floating switcher).
- **Namespacing** — inside the plugin, every cross-reference is fully qualified: `/dobby:<skill>` for skills, `dobby:<agent>` for `subagent_type`/`agentType`. Bare names are reserved for things OUTSIDE the plugin (`deep-research`, `find-docs`, built-in `Plan`/`Explore`).
