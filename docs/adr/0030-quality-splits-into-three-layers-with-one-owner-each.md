# 0030. Quality splits into three layers with one owner each

Nothing told the verifier what its job was, so it picked the widest thing available: in a field run it ran the whole gate and then discarded the biome and knip findings by hand, and separately ran a 3130-test suite to triage which reds were its own. Quality now splits into three layers with no overlap — the edit hook plus an **Exit gate** the implementor runs itself (`dobby check --fix --baseline`) close the mechanical layer, **QA** proves behaviour only, and the external PR review judges the finished change. This extends ADR-0017 (the gate is enforced by exit code, not convention) and leaves ADR-0024's PR boundary intact.

## Considered options

**Leave the test suite with QA, just forbid the gate.** Removes the wasted biome/knip triage but keeps QA reasoning about which of 3130 tests are its own. Rejected: the triage was the expensive part, not the gate invocation.

**Move the related tests into the edit hook** — the original request. Measured and rejected: `vitest related` resolves 24-25 of this repo's 29 suites and takes 48s from *any* file, including a leaf module, because the tests import the CLI entry point. Worse, `test-author` writes the contract before implementation, so a task's tests are red by design throughout — a hook running them would return red on every single edit. Type checking moved to the hook instead, where it costs 0.146s (TypeScript 7's native compiler) and closes the real gap: a type error used to survive the entire build loop and surface only at commit.

## Consequences

**The implementor's prohibition is inverted.** `implementor.md` used to say "NEVER run lint / format / typecheck / build / the test suite yourself". It now must run the full gate before handing off. This is consumer-visible and ships in the upgrade note.

**The Exit gate is serialised.** It judges the whole tree, so two implementors racing their gates would have one task's verdict contaminated by a sibling's half-written edit. Only the gate is serialised — implementation, test authoring and QA proof all still run in parallel.

**Type errors are filtered, not scoped.** TypeScript has no per-file mode, so the hook analyses the whole program and filters the *output* to the file that agent just edited. Errors from a neighbour task's in-flight code are dropped rather than reported to someone who cannot act on them.

**A green baseline replaces hand-written exclusions.** Tasks used to carry KNOWN-RED notes in their prose for agents to reason about; one agent cloned main into /tmp to be sure. The gate now compares against a recorded baseline of what was already failing, so only newly-red counts. The existing gate cache could not serve this — it records only *green* verdicts, so a repo with red suites has no entry to reuse.

**The tautology litmus moves to the PR.** QA used to reason about whether a green test would stay green under a behaviour-breaking change. That judgement now belongs to the external review, which sees the complete change. The cost is accepted deliberately: a weak test contract surfaces at the PR rather than at task end.
