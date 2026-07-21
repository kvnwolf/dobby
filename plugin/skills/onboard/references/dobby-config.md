# dobby.config.json — the kit-owned per-project contract

Creates `dobby.config.json` at the **consumer repo root** (JSON — NOT in `.dobby/`, NOT in `.claude/`). This is the single kit-owned contract, and its **presence** is the marker that a repo is a "dobby project" (the edit-time hook and the work skills guard on it). Since `dobby` infers most tasks from the project's detected capabilities (zero-config à la Vercel), the config shrank to one required section plus optional overrides.

**Format is JSON.** Readers: `/dobby:commit` (`files`, doc-sync), plus `dobby` itself (`setup` / `teardown` / `checks` extras, layered onto the inferred defaults); the optional `tracker` key is read by the backlog skills — `/dobby:backlog`, `/dobby:scope`, `/dobby:commit`, `/dobby:triage`, `/dobby:resolve-conflicts`. Writer: `/dobby:onboard`.

## The sections

| Section | Type | Read by | Meaning |
|---|---|---|---|
| `files` | array of `{ path, update_when[] }` | commit (doc-sync) | docs to keep in sync + the conditions that should trigger an update |
| `setup` | array of commands (optional) | `dobby up` (setup phase) | EXTRA setup commands, run AFTER the inferred default (`bun install` + `.worktreeinclude` re-materialization) |
| `teardown` | array of commands (optional) | `dobby down` | EXTRA cleanup commands, run during teardown |
| `checks` | array of `{ name, run }` (optional) | `dobby check` | EXTRA checks, run IN ADDITION to the inferred gate (biome, tsc, knip, build, vitest-if-capability) |

`files` is the only always-present section. `setup` / `teardown` / `checks` are OPTIONAL overrides — omit them entirely for a repo whose capabilities `dobby` already infers correctly (the common case). There is **no `run` key** — the dev/up/down lifecycle is inferred from the detected capabilities, never configured here.

## The optional `tracker` key

`tracker` is an **optional top-level key** — a sibling of the five sections, not nested inside them — that selects which issue tracker the backlog skills talk to. Shape:

```json
{ "type": "github" | "linear" | "local", "team"?: "<KEY>" }
```

- **ABSENT → `github`** — the zero-config default (the repo `gh` is authenticated against). Most projects never write this key; dobby itself omits it.
- `team` is required **only for `linear`**: the human team **key** (e.g. `VON`), not a UUID — the Linear MCP resolves key → id. Omit `team` for `github` and `local`.
- It is **independent of `files` / `checks` / `setup` / `teardown`** — it says nothing about how docs sync, checks run, or the app installs/tears down; it only names the backlog backend.

The full per-backend operation recipes (dedup, create, view, claim, close, PR-link) live in the backlog skill's `references/trackers.md`; this key just selects the column. Read by `/dobby:backlog`, `/dobby:scope`, `/dobby:commit`, `/dobby:triage`, and `/dobby:resolve-conflicts`.

## Discover

Launch a subagent (`subagent_type: "dobby:researcher"`) to map:

**Documentation files (`files`):**

- Find all `*.md` files that could be documentation for humans or agents (excluding node_modules, .git, dist, skills).
- Read each file and determine what condition should trigger an update.
- Return the mapping of files to detected update conditions.

**Optional extras (`setup` / `teardown` / `checks`):**

- Propose these ONLY when the repo has a real need the inference does NOT already cover — an unusual install step, a cleanup `dobby` can't infer, or a project-specific check (e.g. a monorepo's explicit `checks[]` exception). Most repos need none — leave them out.

## Confirm

Present the lists to the user with `AskUserQuestion` — the inferred documentation files, and any proposed extras. Allow the user to add, remove, or modify entries.

## Write config (no-clobber)

**No-clobber rule — never overwrite an existing `dobby.config.json` the user already has.** If it does NOT exist, write it fresh. If it DOES exist, read it, merge only the missing entries additively, show the diff, and get approval before writing — never blow away the user's config.

Common case (capabilities cover everything — `files` only):

```json
{
  "files": [
    {
      "path": "README.md",
      "update_when": [
        "When commands or environment variables change"
      ]
    }
  ]
}
```

With optional overrides:

```json
{
  "files": [
    { "path": "README.md", "update_when": ["<condition>"] }
  ],
  "setup": ["<extra setup command>"],
  "teardown": ["<extra cleanup command>"],
  "checks": [
    { "name": "<label>", "run": "<command>" }
  ]
}
```

**The `checks` extras contract:** run after the inferred gate, in listed order; every command must exit 0; any failure fails the gate (`dobby check` runs them; `dobby check --fix` is the pre-commit gate, so a failure aborts the commit). Prefer validators over mutators.

Show the generated config to the user for final confirmation.
