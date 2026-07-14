# cli (`@kvnwolf/dobby`)

The `dobby` CLI: run it from any project to auto-detect that project's capabilities from its installed dependencies — no manifest file.

## Files

- `src/index.ts` — the bin adapter (shebang `#!/usr/bin/env bun`). Logic-free: reads `process.argv`/`process.cwd()`, calls `run()`, writes stdout/stderr, exits. Not an import target, not unit-tested.
- `src/run.ts` — **the module's interface**, `run(argv, cwd)`. Parses argv (`node:util` `parseArgs`, strict), dispatches on the first positional, formats output, and returns the process outcome as data.
- `src/detect.ts` — internal detector. `detectProject(cwd)` is the workspace-aware entry (returns a `ProjectDetection` — `single` capability list or `grouped` per-package data); `detectCapabilities(cwd)` is the single-package primitive it reuses per member. Reads `<cwd>/package.json` (+ each member's), maps dependencies to capability names, and expands `workspaces` (literal + `<prefix>/*` dir patterns, array or object form). Exercised only through `run()`.
- `src/run.test.ts` + `__fixtures__/` — the co-located vitest suite (run via `vp test`) and its hand-written sample projects. Tests call `run()` in-process with a fixture path as `cwd`; they never import `detect.ts` directly.
- `package.json` (bin `dobby` → `./src/index.ts`, devDeps only), `vite.config.ts` (minimal, `passWithNoTests`).

## Interface

`run(argv: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>`

- bare (no positional) → usage on stdout, exit 0.
- `--version` / `-v` → package version + newline on stdout, exit 0.
- `capabilities` → detection output on stdout, exit 0.
  - Single package (no `workspaces`, or a workspaces field that expands to zero members): one detected capability name per line (each ending `\n`); zero capabilities → exactly `none\n`.
  - Workspace (a `workspaces` array/object with a non-empty pattern list that expands to ≥1 member): grouped per package. Groups are the root first with header `.` (only if the root itself detects something), then members sorted lexicographically by POSIX relative path; each group is a header line `<relpath>\n` followed by each capability indented two spaces (`  <cap>\n`). Groups that detect nothing (members and root alike) are omitted, no blank lines between groups; if nothing at all detects → exactly `none\n`.
  - Errors (all exit 1, empty stdout): `<cwd>/package.json` missing → stderr names the cwd (`no package.json in <cwd>`); a root OR member package.json that is unparseable → stderr names that file's absolute path; an unsupported workspace pattern → stderr `unsupported workspace pattern: <pattern>`.
- unknown command / malformed flag → error + usage on stderr, exit 1.

The bin is the only reader of `process.cwd()`; every other caller (tests, future subcommands) passes `cwd` explicitly.

## Invariants

- **Runtime-portable core**: `run.ts` and `detect.ts` use `node:*` imports (plus the plain JSON import) only — no `Bun.*` globals, no `bun:` modules — because vitest under `vp test` imports them at Node/Vite runtime while Bun runs them in production.
- **Signals check `dependencies ∪ devDependencies` only** — NEVER `peerDependencies`; missing dependency fields are treated as empty objects.
- **Fixed capability order**: output always follows the declaration order `vite`, `tanstack-start`, `neon`, `expo` — independent of package.json key order and of which dependency field a signal sits in.
- **The detector is pure over its `cwd` argument (and every member path)** — it never reads `process.cwd()`; `run()` owns all output formatting (`detect.ts` returns data, never rendered lines).
- **Deterministic grouped output**: members sorted by POSIX relative path; a dir matched by multiple patterns is deduped (Set); membership = the dir contains a `package.json`.
- **Fail loud on unsupported workspace patterns**: only literal entries and single-star `<prefix>/*` dir patterns are expanded — anything else (`**`, `a/*/b`, bare `*`, `apps/**`) errors rather than silently mis-scanning. The ceiling is marked with a `ponytail:` comment in `detect.ts`.

## What's intentionally NOT here

- **Task execution** (`dobby dev`/`build`/…) — the future capability→tasks arc; only detection exists now.
- **`--json` output** and **printed detection evidence** — capability names only; signals live in code/tests, never printed.
- **Real glob workspace expansion** — only literal + single-star `<prefix>/*` dir patterns (array or object form) are supported. Deeper globs (`**`, nested `*`) fail loud; swapping in `fs.glob`/a glob lib is the deferred upgrade path (marked `ponytail:` in `detect.ts`) for when a real repo needs it.
