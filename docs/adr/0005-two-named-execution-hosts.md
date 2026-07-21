# Two named execution hosts (Conductor + terminal)

**Status:** superseded by [ADR-0010](./0010-single-terminal-host.md) — **supersedes [ADR-0001](./0001-conductor-execution-host.md).**

ADR-0001 made Conductor the kit's only execution host and explicitly rejected a dual path "for a portability we don't use." The user now runs real remote and cmux sessions, so that portability IS used — we replace the Conductor-only model with **two NAMED hosts, detected by env var**: (1) **Conductor** (`CONDUCTOR_WORKSPACE_PATH` present) — the host creates the workspace worktree and auto-runs the app (`auto_run_after_setup`); (2) **terminal** (that var absent — a plain `claude` session, including ssh) — the KIT owns the worktree + run lifecycle: `/dobby:scope` creates and enters the per-goal worktree (native `EnterWorktree`), the app runs lazily at `/dobby:execute` Step 2, and the new `/dobby:finish` tears down post-merge. **cmux enrichment** layers onto the terminal host when `CMUX_WORKSPACE_ID` is set (named run/browser panes + the cmux-browser UI driver), degrading gracefully to a background job otherwise. The enabler is that **portless was verified standalone** — branch-prefixed dev URLs in linked worktrees are portless's own behavior, not Conductor's — so the `portless get` + curl recipe is IDENTICAL on both hosts; the only host difference is who starts the run.

## Considered options

- **Two named hosts, env-detected (chosen)** — Conductor and terminal (with cmux enrichment), each a concrete named path with host-gated steps, no adapter layer. The dual maintenance ADR-0001 feared is bounded because the app-reachability recipe (`portless get` + curl) is shared verbatim; only run-start and worktree-lifecycle branch.
- **Stay Conductor-only (ADR-0001's status quo)** — rejected: its sole rationale was that the second path bought portability nobody used; the user now runs remote/cmux sessions daily, so the premise no longer holds.
- **A generic N-host abstraction** — still rejected, on the same anti-speculation grounds ADR-0001 used: there are exactly two hosts we run on, each named and env-detected. No pluggable host interface, no adapter registry — that would trade concrete clarity for a flexibility we don't need.

## Consequences

- The "methodology" skill category is redefined from "project-agnostic but assuming Conductor" to "project-agnostic but assuming one of the two NAMED hosts (Conductor | terminal, env-var detected)."
- `/dobby:scope`, `/dobby:execute`, and the new `/dobby:finish` carry host-gated steps: under Conductor the worktree-and-run steps no-op or are skipped (the workspace IS the worktree, Conductor auto-runs); under terminal the kit does the work.
- The verifier drives the UI through a **three-rung ladder** — cmux browser API (when cmux + browser automation are present) → claude-in-chrome (local Chrome) → programmatic curl — instead of the single claude-in-chrome path ADR-0001 assumed.
- **Parallel goals run in parallel worktrees**, one per `claude` session/cmux pane (the cmux value-prop; git supports it fine). Scope guards NESTING and slug collision, not the mere existence of other worktrees.
- The per-project contract that feeds host-gated setup/run/teardown moves to `dobby.config.json` (see [ADR-0006](./0006-dobby-config-json.md)).
- `mark`/`learn` remain coupled to Claude Code session storage — a separate host coupling, unchanged by this decision.
