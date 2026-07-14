# The kit-owned per-project contract lives in `dobby.config.json`

**Status:** accepted

The kit's per-project contract was a YAML file squatting in the host's namespace — `.claude/commit.config.yml`, carrying `files` (doc-sync rules) + `checks` (pre-commit gates). The two-host work ([ADR-0005](./0005-two-named-execution-hosts.md)) needs the kit to own setup/run/teardown on the terminal host, so the contract grew and had to move somewhere honest. We moved it to **`dobby.config.json` at the repo ROOT** (JSON), gaining `setup`/`run`/`teardown` alongside `files`/`checks`. We chose the root over `.claude/` because `.claude/` is Claude Code's RESERVED namespace (the host reads `settings.json`/commands/agents/skills/hooks there — the kit was squatting), and root-level `<tool>.config.json` (next.config.js, etc.) is the ecosystem convention for a tool's own config. JSON over YAML because the future hook/dispatcher path already parses JSON with `jq`; YAML would ship a new `yq` dependency for nothing. This is **consistent with, not contradictory to, [ADR-0003](./0003-docs-durable-artifacts.md)**: 0003 rejected a `.dobby/` directory for artifacts that are really *about the project* (the decision-map, the out-of-scope KB) — but a per-project *kit-mechanic contract* is exactly the kind of kit-owned thing a kit-owned location should hold.

## Considered options

- **`dobby.config.json` at the repo root, JSON (chosen)** — kit-owned, out of the host's namespace, follows the `<tool>.config.*` convention, parse-able by the existing `jq` toolchain with zero new deps.
- **Keep `.claude/commit.config.yml`** — rejected: it squats in the host's reserved namespace and its name ("commit") no longer describes a file that also carries setup/run/teardown.
- **A namespaced `.dobby/config.yml` dir** — rejected: the extra directory buys nothing over a single root file for one config, and YAML would force a new parser dependency onto the hook path.

## Consequences

- Readers of the contract are `commit` and `resolve-conflicts` (existing, retargeted) plus `scope` (setup), `execute` (run), and `finish` (teardown) — the new host-gated stages. Writer is `onboard`; migrator is `migrate-config`.
- **Run-command duplication is accepted**: `.conductor/settings.toml [scripts] run` (Conductor-read, for its auto-run) and `dobby.config.json run` (kit-read, for the terminal host) both carry the portless-wrapped command. `onboard` writes both and adds an `update_when` sync rule in the config itself, rather than a shell-shim indirection or a single source that would lose Conductor's auto-run.
- Migration is a **CLEAN CUT** via the dedicated `/dobby:migrate-config` skill: it converts YAML→JSON, deletes the legacy file, and cleans the mechanizable kit-workflow prose out of the consumer's CLAUDE.md (each edit proposed as a diff for per-change approval, leaving a single pointer line). Readers do NOT detect or fall back to the legacy path.
- **Accepted risk**: in a consumer repo that has not yet run `/dobby:migrate-config`, readers silently hit their no-config fallback instead of gating on the stranded `.claude/commit.config.yml`. The maintainer explicitly declined a one-line legacy-detection reader guard, accepting the silent-no-gate risk in exchange for the clean cut.
- No-app projects (a library, CLI, or plugin — dobby itself) omit `setup`/`run`/`teardown` entirely, and the existing `devUrl=null` convention holds.
