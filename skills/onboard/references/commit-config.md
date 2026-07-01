# Commit Config Setup

Creates `.claude/commit.config.yml` — the contract `/dobby:commit` reads: which docs to keep in sync and which pre-commit checks gate the commit. Run as part of `/dobby:onboard`; skip if the file already exists.

## Discover

Launch a subagent (`subagent_type: "dobby:researcher"`) to map two things:

**Documentation files:**

- Find all `*.md` files that could be documentation for humans or agents (excluding node_modules, .git, dist, skills)
- Read each file and analyze content
- For each file, determine what condition should trigger an update
- Return mapping of files to detected update conditions

**Pre-commit checks:**

- Inspect the project's toolchain for validation commands: `package.json` scripts (lint, typecheck, test, build), task runners (turbo, vpr, just, make), and the commands CI runs.
- Inspect existing git pre-commit hooks (husky, simple-git-hooks, lefthook, `.git/hooks`) — whatever they run is a candidate to migrate into `checks`.
- Return the candidate commands, ordered fast-to-slow (typecheck/lint before tests).

## Confirm

Present both lists to the user with `AskUserQuestion` — the inferred documentation files AND the proposed checks. Allow the user to add, remove, or modify entries. If git hooks were found, note that `checks` replaces them for harness-driven commits (the user may want to remove the hook manager afterwards).

## Write Config

Create `.claude/commit.config.yml`:

```yaml
files:
  - path: <file>
    update_when:
      - <condition>

checks:
  - name: <label>
    run: <command>
```

Example:

```yaml
files:
  - path: README.md
    update_when:
      - When API endpoints are added, changed, or removed
      - When environment variables change
  - path: docs/ARCHITECTURE.md
    update_when:
      - When new modules are introduced or existing ones are restructured
  - path: CHANGELOG.md
    update_when:
      - Every commit

checks:
  - name: typecheck
    run: bun run types
  - name: lint
    run: bun run lint
  - name: test
    run: bun test
```

**The `checks` contract:** run in listed order, every command must exit 0, any failure aborts the commit. Prefer validators over mutators — a formatter belongs here in check mode (fail on diff), not write mode. These run only when the harness commits; manual `git commit` bypasses them, so CI remains the backstop.

Show generated config to user for final confirmation.
