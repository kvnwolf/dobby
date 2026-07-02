---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions — build a fast deterministic feedback loop, rank falsifiable hypotheses, instrument one variable at a time. Use when something is broken/throwing/failing, a bug is intermittent or non-obvious, or there's a performance regression.
argument-hint: "[the bug or symptom]"
model: opus
effort: max
---

For hard bugs (intermittent, non-obvious, performance regression). For a trivial bug, just fix it. The rule: **don't patch and pray** — the fastest path to a fix is a tight feedback loop, ranked hypotheses, and one-variable-at-a-time instrumentation.

This skill is also the `dobby:verifier`'s named downstream: when verification hits an **opaque 500** (a server error with no actionable message), the verifier hands off here to diagnose it.

## Step 1: Build a feedback loop

**This is the skill.** Everything else is mechanical once you have a fast, deterministic, agent-runnable pass/fail signal for the bug. Be aggressive and creative; try in roughly this order:

1. Failing test at whatever seam reaches the bug.
2. `curl` / HTTP script against a running dev server (the dev URL comes from `portless get`).
3. CLI invocation with a fixture input, diff stdout vs known-good.
4. Headless browser script driving the UI.
5. Replay a captured trace (real request / payload / event log saved to disk) through the code path in isolation.
6. Throwaway harness — minimal subset exercising the bug path with one call.
7. Property / fuzz loop for "sometimes wrong output".
8. Bisection harness if the bug appeared between two known states.

**Treat the loop as a product** — once you have *a* loop, tighten it along three axes:

- **Faster** — cache setup, skip unrelated init, narrow the test scope. A 2-second deterministic loop is a superpower; a 30-second flaky one is barely better than nothing.
- **Sharper signal** — assert on the *specific symptom*, not "didn't crash". A loop that goes green on the wrong reason is worse than none.
- **More deterministic** — pin time, seed RNG, isolate the filesystem, freeze the network.

**Non-deterministic bugs:** don't chase a clean repro, raise the reproduction rate (loop 100×, parallelise, add stress, narrow timing). A 50%-flake is debuggable; 1% is not.

If you genuinely cannot build a loop: stop and say so, list what you tried, and ask for environment access, a captured artifact, or permission to instrument.

### Phase-1 gate — do NOT pass this line without a red-capable command

Before you form a single hypothesis, name **ONE command** — a test invocation, a `curl`, a script path — that you have **already run at least once**. Paste the exact invocation *and* its output. That command must be:

- [ ] **Red-capable** — it drives the actual bug code path and asserts the user's **exact symptom**, so it goes red on *this* bug and green once fixed. Not "runs without erroring" — it must be able to *catch this specific bug*.
- [ ] **Deterministic** — same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended (a human in the loop only via a structured HITL script).

If you catch yourself reading code to build a theory before this command exists, **stop — jumping straight to a hypothesis is the exact failure this skill prevents.** No red-capable command, no Phase 2.

## Step 2: Reproduce

Run the loop; watch the bug appear. Confirm it's the failure the user described (not a nearby one), reproducible (or at a high enough rate), with the exact symptom captured.

## Step 3: Hypothesise

First, offload the *understanding*: dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to map the suspect code paths — how the subsystem works, what changed recently, where this failure could originate — and return grounded findings. Keep those findings in your context (you need them to reason); the researcher just spares you the exploratory reading. The hands-on loop — feedback loop, instrumentation, fix — stays with YOU: it's tightly iterative and one-variable-at-a-time, so it can't be handed off.

Then generate **3-5 ranked, falsifiable** hypotheses before testing any — each with a prediction ("if X is the cause, changing Y makes it disappear"). If you can't state the prediction, it's a vibe — sharpen or discard. Show the ranked list to the user (a cheap checkpoint; domain knowledge often re-ranks instantly).

## Step 4: Instrument

Each probe maps to a prediction. **Change one variable at a time.** Prefer a debugger/REPL over logs; never "log everything and grep". **Tag every debug log** with a unique prefix (e.g. `[DEBUG-a4f2]`) so cleanup is one grep.

**Perf branch (measure first, fix second).** For a performance regression, logs are usually the wrong tool. Instead: establish a **baseline measurement** — a timing harness, `performance.now()`, a profiler, or a query plan — then **bisect** toward the hot spot one change at a time. Never optimise before you have a number; a guess-driven perf "fix" that isn't measured against the baseline is patch-and-pray.

## Step 5: Fix

Write the regression test **only at a correct seam** — one where the test exercises the **real bug pattern as it occurs at the call site**. A shallow seam (a single-caller unit test when the bug needs multiple callers, a test that can't replicate the chain that triggered the failure) gives false confidence — a green test that would never have caught this bug.

**The absence of a correct seam is itself a finding.** If the only available seams are too shallow, don't force a weak test — note it: the architecture is preventing this bug from being locked down, and that goes to the post-mortem (Step 6).

If a correct seam exists: turn the minimised repro into a failing test there, watch it fail, apply the fix, re-run the Step 1 loop against the original (un-minimised) scenario, watch it pass.

## Step 6: Cleanup + post-mortem

- Original repro no longer reproduces.
- All `[DEBUG-...]` instrumentation removed (`grep` the prefix).
- Throwaway harnesses deleted or clearly marked.
- The winning hypothesis stated in the handoff / commit message, so the next debugger learns.

**Then, a timed post-mortem (a couple of minutes, not a retro): "what would have prevented this bug?"** Ask it **after** the fix is in — you know far more now than when you started. If the answer is a local hygiene fix (a missing assertion, an unhandled case), note it in the handoff. But if the answer is **architectural** — no correct seam existed (the Step 5 finding), tangled callers, hidden coupling, a shape that keeps producing this class of bug — escalate it: hand off to `/dobby:improve-architecture` with the specifics. This is a typed suggestion, not an auto-invoke; the fix ships first, the architectural recommendation follows separately.

## Acceptance checklist

- [ ] Phase-1 gate cleared: ONE already-run red-capable command named (invocation + output pasted) — deterministic, fast, agent-runnable — before any hypothesis
- [ ] Bug reproduced — the exact symptom, not a nearby one
- [ ] Suspect code understood via a `researcher` (findings held in your context); 3-5 ranked falsifiable hypotheses generated and shown before instrumenting
- [ ] Instrumented one variable at a time; debug logs tagged and removed at the end; perf regressions measured against a baseline before any fix
- [ ] Fix applied; the loop passes; regression test captured at a correct seam (or the absence of one noted as a finding)
- [ ] Winning hypothesis recorded for the next person; timed post-mortem done, architectural root causes escalated to `/dobby:improve-architecture`
