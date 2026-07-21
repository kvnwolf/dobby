# One execution host: Conductor support removed

**Status:** accepted — **supersedes [ADR-0005](./0005-two-named-execution-hosts.md)** (and with it the [ADR-0001](./0001-conductor-execution-host.md) lineage).

ADR-0005 kept two named hosts (Conductor | terminal) because the user ran both daily. That premise expired: the user now works almost exclusively in cmux panes, and maintaining Conductor's host-gated branches (scope's host detection, finish's no-op, onboard's `.conductor` templates, the two-host prose in every doc) taxed every skill for a path nobody exercised. We removed Conductor entirely — **the terminal is the single execution host** (a plain `claude` session, incl. ssh; cmux enrichment when `CMUX_WORKSPACE_ID` is set), and the kit's mechanical layer is the `@kvnwolf/dobby` CLI ([ADR-0011](./0011-bundled-toolchain-zero-config.md)). Running the kit under Conductor is now unsupported; `/dobby:migrate-config` deletes consumers' `.conductor/` directories.

## What Conductor did (for a possible future re-add)

Everything the Conductor host provided, and where each duty went:

- **Workspace-as-worktree** — Conductor created a workspace that WAS the git worktree (no `EnterWorktree` step). Now: `/dobby:scope` creates + enters the per-goal worktree natively.
- **`auto_run_after_setup`** — Conductor auto-started the app when the workspace opened. Now: `bunx dobby up` at scope (and idempotently at execute Step 2) — setup phase + liveness-first run.
- **`.conductor/settings.toml`** — per-repo host config (run script, setup script pointers). Now: nothing — tasks are capability-inferred (`dobby.config.json` keeps only `files[]` + optional `setup[]`/`teardown[]`/`checks[]` extras).
- **`file_include_globs`** — gitignored files copied into new workspaces (`.env.local` etc.). Now: `.worktreeinclude` re-materialization inside `up`'s setup phase (glob-compatible, linked-worktree-gated, fills missing files only).
- **`setup.sh` / `archive.sh` glue** — per-repo shell scripts, notably admin's Neon-branch-per-workspace logic (create `dobby/<slug>` branch + rewrite `DATABASE_URL*` on setup, delete on archive). Now: built into `up`/`down` for every neon-capability project, with a hard fail on missing creds (the scripts' silent fallback to the shared DB was the dangerous part).

A re-add would reintroduce a host-detection seam (`CONDUCTOR_WORKSPACE_PATH`) and gate scope/finish steps on it — the CLI layer is host-agnostic and would need no changes.

## Consequences

- The "methodology" skill category is redefined once more: project-agnostic, assuming the single terminal host, delegating environment mechanics to `bunx dobby`.
- `dobby env` has no host field; there is nothing to detect.
- ADR-0005's shared-recipe insight (portless URLs are portless's behavior, not a host's) survives as the reason `dobby env`'s `devUrl` works identically everywhere.
