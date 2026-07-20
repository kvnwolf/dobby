# dobby.config.json — the kit-owned per-project contract

Creates `dobby.config.json` at the **consumer repo root** (next.config.js style — NOT in `.dobby/`, NOT in `.claude/`). This is the single kit-owned contract the work skills read: which docs to keep in sync, which pre-commit checks gate a commit, and — for projects with an app — how to **set up**, **run**, and **tear down** the per-session worktree.

**Format is JSON** (future-proof for jq-parsing hooks). Readers: `/dobby:commit` (`files` + `checks` + `tracker`), `/dobby:resolve-conflicts` (`checks` + `tracker`), `/dobby:scope` (`setup` + `tracker`), `/dobby:execute` (`run`), `/dobby:finish` (`teardown`), `/dobby:backlog` (`tracker`), `/dobby:triage` (`tracker`). Writer: `/dobby:onboard`. Run as part of `/dobby:onboard`.

## The five sections

| Section | Type | Read by | Meaning |
|---|---|---|---|
| `files` | array of `{ path, update_when[] }` | commit | docs to keep in sync + the conditions that should trigger an update |
| `checks` | array of `{ name, run }` | commit, resolve-conflicts | pre-commit checks, run in order, every command must exit 0 |
| `setup` | array of commands | scope | one-time worktree install, run (blocking) right after the worktree is created on the terminal host |
| `run` | single command wrapping `portless run <name> -- …` | execute | the dev-server command the terminal host starts lazily (execute Step 2) |
| `teardown` | array of commands (optional) | finish | cleanup run inside the worktree before it's removed |

**`setup` / `run` / `teardown` are OMITTED for no-app projects** (a library, CLI, or plugin — like dobby itself). With no `run` there is no dev URL, so the `devUrl = null` convention holds: `/dobby:execute`'s verifier verifies programmatically instead of driving a browser, `/dobby:scope` skips setup, and `/dobby:finish` skips teardown. Only `files` + `checks` are authored for those repos.

## The optional `tracker` key

`tracker` is an **optional top-level key** — a sibling of the five sections, not nested inside them — that selects which issue tracker the backlog skills talk to. Shape:

```json
{ "type": "github" | "linear" | "local", "team"?: "<KEY>" }
```

- **ABSENT → `github`** — the zero-config default (the repo `gh` is authenticated against). Most projects never write this key; dobby itself omits it.
- `team` is required **only for `linear`**: the human team **key** (e.g. `VON`), not a UUID — the Linear MCP resolves key → id. Omit `team` for `github` and `local`.
- It is **independent of `files` / `checks` / `setup` / `run` / `teardown`** — it says nothing about how docs sync, checks run, or the app installs/runs/tears down; it only names the backlog backend.

The full per-backend operation recipes (dedup, create, view, claim, close, PR-link) live in the backlog skill's `references/trackers.md`; this key just selects the column. Read by `/dobby:backlog`, `/dobby:scope`, `/dobby:commit`, `/dobby:triage`, and `/dobby:resolve-conflicts`.

## Discover

Launch a subagent (`subagent_type: "dobby:researcher"`) to map:

**Documentation files (`files`):**

- Find all `*.md` files that could be documentation for humans or agents (excluding node_modules, .git, dist, skills)
- Read each file and analyze content
- For each file, determine what condition should trigger an update
- Return the mapping of files to detected update conditions

**Pre-commit checks (`checks`):**

- Inspect the project's toolchain for validation commands: `package.json` scripts (lint, typecheck, test, build), task runners (turbo, vpr, just, make), and the commands CI runs.
- Inspect existing git pre-commit hooks (husky, simple-git-hooks, lefthook, `.git/hooks`) — whatever they run is a candidate to migrate into `checks`.
- Return the candidate commands, ordered fast-to-slow (typecheck/lint before tests).

**Setup / run / teardown (only for a project with an app):**

- `setup`: the install/migration commands a fresh worktree needs before the app can run (the same work `.conductor/setup.sh` does — e.g. `pnpm install`, DB branch/seed, migrations).
- `run`: the dev command wrapped in `portless run` — **the SAME command written into `.conductor/settings.toml`'s `[scripts.run]`** (see the sync rule below).
- `teardown`: optional cleanup before the worktree is removed (e.g. stop a shared DB, drop a scratch DB branch). Omit if there's nothing to clean up.

## Confirm

Present the lists to the user with `AskUserQuestion` — the inferred documentation files, the proposed checks, and (for an app project) the setup/run/teardown commands. Allow the user to add, remove, or modify entries. If git hooks were found, note that `checks` replaces them for harness-driven commits (the user may want to remove the hook manager afterwards).

## Write config (no-clobber)

**No-clobber rule — never overwrite an existing `dobby.config.json` the user already has.** If it does NOT exist, write it fresh. If it DOES exist, read it, merge only the missing entries additively, show the diff, and get approval before writing — never blow away the user's config.

Create `dobby.config.json` at the repo root. Full template (app project — all five sections):

```json
{
  "files": [
    {
      "path": "README.md",
      "update_when": [
        "When API endpoints are added, changed, or removed",
        "When environment variables change"
      ]
    },
    {
      "path": "docs/ARCHITECTURE.md",
      "update_when": [
        "When new modules are introduced or existing ones are restructured"
      ]
    },
    {
      "path": "dobby.config.json",
      "update_when": [
        "When the run command changes, update `.conductor/settings.toml` [scripts.run] to match — both carry the same portless command and must change together"
      ]
    }
  ],
  "checks": [
    { "name": "typecheck", "run": "bun run types" },
    { "name": "lint",      "run": "bun run lint" },
    { "name": "test",      "run": "bun test" }
  ],
  "setup": [
    "pnpm install"
  ],
  "run": "portless run vite dev",
  "teardown": []
}
```

No-app project (library / CLI / plugin) — `files` + `checks` only, no `setup`/`run`/`teardown` and no run-sync `files[]` entry:

```json
{
  "files": [
    { "path": "README.md", "update_when": ["<condition>"] }
  ],
  "checks": [
    { "name": "<label>", "run": "<command>" }
  ]
}
```

**The `checks` contract:** run in listed order, every command must exit 0, any failure aborts the commit. Prefer validators over mutators — a formatter belongs here in check mode (fail on diff), not write mode. These run only when the harness commits; manual `git commit` bypasses them, so CI remains the backstop.

## The run-sync rule

`run` intentionally **duplicates** the command in `.conductor/settings.toml`'s `[scripts.run]`: Conductor reads `settings.toml` (auto-starts the app), the kit reads `dobby.config.json`'s `run` on the terminal host (where nothing auto-runs). Both must carry the SAME `portless run <name> -- …` command. This duplication is accepted; guard it with a sync rule inside the config's OWN `files[]` (the `dobby.config.json` entry in the template above), so `/dobby:commit` flags a drift whenever one changes without the other.

Add this `files[]` entry only for an app project (one that has a `run` section). Omit it for a no-app project — there is no `run` to keep in sync.

## portless (app projects)

The `run` command wraps the dev command with **portless** (`portless run <name> -- <dev command>`), which gives each worktree a branch-prefixed `https://<branch>.<name>.localhost` URL — so parallel worktrees never collide over the dev URL, on either host. `/dobby:execute` resolves that URL with `portless get <name>`.

- Add **portless as a PINNED devDependency** in the consumer project (`package.json` `devDependencies`) — not `npx` (network per run), not a global install. Pin the version.
- Surface the one-time `portless trust` setup to the user (plain text): the FIRST run needs `portless trust`, which requires sudo to install a local CA and bind port 443. It's a one-time per-machine step; note it so the first `/dobby:execute` doesn't fail on it.

Show the generated config to the user for final confirmation.
