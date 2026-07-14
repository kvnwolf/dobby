# Conductor as the execution host

**Status:** superseded by [0005](./0005-two-named-execution-hosts.md)

The kit originally reached the running app through a generic, host-agnostic path: `bootstrap` wired **portless** directly and generated a per-project "run skill"; `execute`/`dispatch` started the dev server and passed a URL; the verifier hit that URL. We replaced this with a **Conductor-only** model: `onboard` (renamed from `bootstrap`) writes `.conductor/settings.toml`, and Conductor auto-runs the app (`auto_run_after_setup`) via a run script that wraps portless. The coordinator + verifier reach the running app by resolving its dev URL with `portless get <name>` (deterministic — portless branch-prefixes the host in a worktree and can be name-overridden, so `portless get` is the source of truth), confirming liveness with a curl health-check against that URL, and driving the UI via claude-in-chrome. We chose this because the user runs every project inside Conductor, and the old URL-pinning was in fact wrong for real repos (the URL isn't a static constant — but it *is* deterministically resolvable through `portless get`, so no terminal parsing is needed).

## Considered options

- **Conductor-only (chosen)** — one code path, no dual maintenance; the execution model becomes host-coupled (the "methodology" skill category is redefined as project-agnostic *but* assuming the Conductor host).
- **Dual (detect `.conductor/` → Conductor, else the portless/run-skill path)** — rejected: it doubles the surface of `onboard`, `execute`, `dispatch`, `prototype`, and the verifier with two branches to maintain and test, for a portability we don't use.

## Consequences

- No fallback path for non-Conductor hosts. Running the kit outside Conductor is out of scope by design.
- The verifier reaches the app via `portless get` (URL) + curl (liveness) + `mcp__claude-in-chrome__*` (UI) — it does NOT couple to `mcp__conductor__*`. Dropping the run-script-terminal read removes the conductor-MCP dependency; the only host MCP the verifier needs is claude-in-chrome.
- Projects with no dev server (a library, CLI, or plugin — dobby itself) are first-class: no `[scripts] run` → `devUrl=null` → the verify recipe runs programmatically.
- `mark`/`learn` remain coupled to Claude Code session storage, a separate host coupling from this one.
