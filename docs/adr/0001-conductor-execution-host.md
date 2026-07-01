# Conductor as the execution host

**Status:** accepted

The kit originally reached the running app through a generic, host-agnostic path: `bootstrap` wired **portless** directly and generated a per-project "run skill"; `execute`/`dispatch` started the dev server and passed a URL; the verifier hit that URL. We replaced this with a **Conductor-only** model: `onboard` (renamed from `bootstrap`) writes `.conductor/settings.toml`, Conductor auto-runs the app (`auto_run_after_setup`), and the coordinator + verifier reach the running app through Conductor's run-script terminal (`GetTerminalOutput(source:"run_script")` for the alive-check and dev-URL, plus browser verification via claude-in-chrome). We chose this because the user runs every project inside Conductor, and the old URL-pinning was in fact wrong for real repos (portless branch-prefixes the host in a worktree and can be name-overridden, so the URL is not computable — it must be read from the terminal).

## Considered options

- **Conductor-only (chosen)** — one code path, no dual maintenance; the execution model becomes host-coupled (the "methodology" skill category is redefined as project-agnostic *but* assuming the Conductor host).
- **Dual (detect `.conductor/` → Conductor, else the portless/run-skill path)** — rejected: it doubles the surface of `onboard`, `execute`, `dispatch`, `prototype`, and the verifier with two branches to maintain and test, for a portability we don't use.

## Consequences

- No fallback path for non-Conductor hosts. Running the kit outside Conductor is out of scope by design.
- The verifier is coupled to two host MCP servers (`mcp__conductor__*`, `mcp__claude-in-chrome__*`); an empirical probe confirmed a plugin subagent can call them.
- Projects with no dev server (a library, CLI, or plugin — dobby itself) are first-class: no `[scripts] run` → `devUrl=null` → the verify recipe runs programmatically.
- `mark`/`learn` remain coupled to Claude Code session storage, a separate host coupling from this one.
