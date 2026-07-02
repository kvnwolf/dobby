# Testing Decisions

Decide where and what to test, and which tasks are test-first. This section becomes part of the `## Spec` and feeds `/dobby:execute`'s per-task test-author gate.

Adapted from mattpocock/skills (`to-prd`).

## Seam minimization

A **seam** is a place where you can substitute behavior to observe it under test (an interface, a boundary, an injection point). Every seam is surface the codebase has to carry and keep honest, so choose them deliberately:

- **Prefer existing seams** over new ones — don't carve a boundary just to test through it.
- **Use the highest seam possible** — test at the outermost point where the behavior is still observable, so the test exercises the real integrated path rather than an internal detail.
- **Fewer is better; the ideal number is ONE.** If new seams are unavoidable, propose them at the highest point and keep the count minimal.
- **Confirm the seams with the user BEFORE writing the plan.** Seams are an architectural commitment — the user approves them here, executors don't improvise them (same discipline as module boundaries).

One adapter is a hypothetical seam; two is a real one. Don't introduce a seam unless something actually varies across it.

## What makes a good test

State this in the Testing Decisions so the executor and the `dobby:test-author` agent share the standard:

- **Test external behavior, not implementation details.** A test that breaks when you rename an internal function or refactor without changing behavior is testing the wrong thing.
- **Name which modules will be tested** and the **prior art** (similar existing tests in the codebase to mirror).
- Expected values come from an **independent source** (a known-good literal, a worked example, the spec) — never recomputed the way the code computes them.

## Test-first marker (feeds the test-author gate)

`/dobby:execute`'s build loop runs a `dobby:test-author` step **only** for tasks the spec marks test-first, and **only** when the repo has a test suite. So:

1. **Detect whether the repo has a test suite** (with a researcher if needed). No suite → the build loop runs the classic implement→review→verify path; no task is test-first; you can omit the marker.
2. **If a suite exists, mark each task test-first or not.** Test-first = tasks with real logic or seams. Not test-first = trivial config, pure-prose, or scaffolding with no behavior to pin down.
3. **Carry the marker into the task table** — add a `Test-first` column (`yes`/`no`) per `references/task-decomposition.md`. That column IS the flag the test-author gate reads; a task with no marker is treated as not test-first.

The test-author writes tests from the spec and this section ONLY — never from the implementation — so what you decide here is the independent source of truth the tests are built against.
