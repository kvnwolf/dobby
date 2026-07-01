---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions — build a fast deterministic feedback loop, rank falsifiable hypotheses, instrument one variable at a time. Use when something is broken/throwing/failing, a bug is intermittent or non-obvious, or there's a performance regression.
argument-hint: "[the bug or symptom]"
model: opus
effort: max
---

For hard bugs (intermittent, non-obvious, performance regression). For a trivial bug, just fix it. The rule: **don't patch and pray** — the fastest path to a fix is a tight feedback loop, ranked hypotheses, and one-variable-at-a-time instrumentation.

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

**Iterate on the loop itself** — faster, sharper, more deterministic. A 2-second deterministic loop is a superpower; a 30-second flaky one is barely better than nothing.

**Non-deterministic bugs:** don't chase a clean repro, raise the reproduction rate (loop 100×, parallelise, add stress, narrow timing). A 50%-flake is debuggable; 1% is not.

If you genuinely cannot build a loop: stop and say so, list what you tried, and ask for environment access, a captured artifact, or permission to instrument.

## Step 2: Reproduce

Run the loop; watch the bug appear. Confirm it's the failure the user described (not a nearby one), reproducible (or at a high enough rate), with the exact symptom captured.

## Step 3: Hypothesise

First, offload the *understanding*: dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to map the suspect code paths — how the subsystem works, what changed recently, where this failure could originate — and return grounded findings. Keep those findings in your context (you need them to reason); the researcher just spares you the exploratory reading. The hands-on loop — feedback loop, instrumentation, fix — stays with YOU: it's tightly iterative and one-variable-at-a-time, so it can't be handed off.

Then generate **3-5 ranked, falsifiable** hypotheses before testing any — each with a prediction ("if X is the cause, changing Y makes it disappear"). If you can't state the prediction, it's a vibe — sharpen or discard. Show the ranked list to the user (a cheap checkpoint; domain knowledge often re-ranks instantly).

## Step 4: Instrument

Each probe maps to a prediction. **Change one variable at a time.** Prefer a debugger/REPL over logs; never "log everything and grep". **Tag every debug log** with a unique prefix (e.g. `[DEBUG-a4f2]`) so cleanup is one grep. For performance, measure a baseline (profiler / query plan) and bisect — measure first, fix second.

## Step 5: Fix

If a correct seam exists for a regression test (one exercising the real bug pattern at the call site), capture it. If the only seams are too shallow, that itself is the finding — note it. Apply the fix, re-run the Step 1 loop, watch it pass.

## Step 6: Cleanup

- Original repro no longer reproduces.
- All `[DEBUG-...]` instrumentation removed (`grep` the prefix).
- Throwaway harnesses deleted or clearly marked.
- The winning hypothesis stated in the handoff / commit message, so the next debugger learns.

## Acceptance checklist

- [ ] A fast, deterministic, agent-runnable feedback loop exists (or the blocker is reported)
- [ ] Bug reproduced — the exact symptom, not a nearby one
- [ ] Suspect code understood via a `researcher` (findings held in your context); 3-5 ranked falsifiable hypotheses generated and shown before instrumenting
- [ ] Instrumented one variable at a time; debug logs tagged and removed at the end
- [ ] Fix applied; the loop passes; regression test captured (or shallow-seam finding noted)
- [ ] Winning hypothesis recorded for the next person
