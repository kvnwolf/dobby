# The build loop (four-step, with a separate test-author)

**Status:** accepted

The per-task loop was a three-step "trifecta" — `implementor → reviewer → verifier`, one separate agent per role, encoded once in `skills/execute/references/build-workflow.md` and reused by `/dobby:dispatch`. We expanded it into a **build loop**: a conditional `test-author` step runs at the front, so the loop is `test-author → implementor → reviewer → verifier` (four steps) when the repo has a test suite AND the spec marked the task test-first, and stays the classic three steps otherwise. The `test-author` is a new worker agent (`dobby:test-author`, opus/xhigh) that writes the tests **from the spec alone, never seeing the implementation**; the implementor then makes them pass without editing them, the reviewer judges test quality under its Spec axis, and the verifier runs the suite plus a dynamic tautology litmus. We chose the separate-agent design because it makes the tests **anti-tautological by construction** — the author of the tests is not the author of the code, so expected values come from an independent source rather than being recomputed the way the code computes them. We renamed "trifecta" to **"build loop"** kit-wide because the loop is now 3 *or* 4 steps and a count-based name (tri-) is no longer accurate.

## Considered options

- **Separate `test-author` agent, gated per-repo AND per-task (chosen)** — anti-tautology is structural (who tests ≠ who implements), and the gate keeps prose/no-suite repos (dobby itself) on the classic three-step path.
- **Implementor writes tests in two phases (classic TDD, three roles)** — rejected: anti-tautology would rely on discipline within one agent rather than a structural separation; weaker guarantee.
- **A `/dobby:tdd` skill the implementor invokes** — rejected: with a dedicated `test-author`, an invocable skill is pointless; the discipline is a role must-have and belongs in the agent's system prompt (`agents/test-author.md` for writing, `agents/reviewer.md` for judging), not behind a context-pointer.

## Consequences

- `skills/execute/references/build-workflow.md` was edited at the source (the verbatim rule governs *consumers* of the component, not its evolution). All prior invariants are preserved: `MAX_OUTER`/`MAX_REVIEW` caps, scoped re-review anti-thrash, single-writer work-log, the Coordination guards (never-commit / scope-to-areas / never-revert-siblings), and the Conductor `devUrl`/`portless get` branch.
- The four-step path is **dormant in a repo with no test suite** — dobby has none, so this very session ran the classic three steps with `devUrl=null` programmatic verify. The test-author path is exercised only on a code repo with a suite.
- `CONTEXT.md` now defines `build loop` and `test-author` (five workers, not four); the spec's Testing Decisions section marks which tasks are test-first, feeding the gate.
- There is no `/dobby:tdd` skill; the testing discipline lives inline in `agents/test-author.md` and `agents/reviewer.md`.
