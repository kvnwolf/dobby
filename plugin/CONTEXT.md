# plugin (`dobby`)

The Claude Code plugin itself: the marketplace-installable bundle of skills, agents,
and hooks that implement the kit's methodology. **Self-contained by construction** —
it is cache-copied on install, so nothing here may reach into `../cli` (the CLI
workspace lives alongside it in the monorepo but ships as a separate npm package) or
into a consumer's `node_modules`. Mechanics are delegated to the installed `dobby`
CLI at runtime (`bunx dobby …`), never imported.

## Files

- `.claude-plugin/plugin.json` — the plugin manifest: name, version, description,
  author. What the marketplace and `claude plugin` commands read to install/update.
- `agents/` — the five authoritative worker-agent definitions: `researcher.md`,
  `test-author.md`, `implementor.md`, `reviewer.md`, `qa.md`. Each prompt body is
  edited here exactly once; frontmatter (`model`/`effort`) is the SOLE source of
  that role's model/effort — there is no external recipe to mirror. `implementor.md`
  runs the full quality gate on itself (`bunx dobby check --fix --baseline`, the
  Exit gate) before handing a task off; `qa.md` proves behaviour only — never lint,
  types, build, or the test suite.
- `hooks/hooks.json` — auto-loaded when the plugin is enabled. The PostToolUse
  `Edit|Write` hook invokes the consumer's LOCAL
  `node_modules/.bin/dobby check --hook` behind a `dobby.config.json` guard (never
  `bunx`, which would fetch the foreign npm `dobby`) — silent exit 0 on any missing
  guard, so only unfixable findings ever reach the model.
- `skills/` — one directory per skill (`SKILL.md` + optional `references/` /
  `examples/` / `scripts/`): the work-session stage skills (`scope` → … → `wrap`),
  side-path skills (`handoff`, `triage`, `map`, `resolve-conflicts`, `wizard`,
  `teach`, `upgrade`), convention skills (`data-fetching`, `data-processing`,
  `module-conventions`), and the self-improvement pair (`mark`, `learn`). Two skills
  carry a `scripts/` exception to the "no runtime behavior" default:
  - `skills/mark/scripts/mark.sh` and `skills/learn/scripts/{resolve-session.sh,digest-transcript.py}`
    — host-coupled helpers over Claude Code session storage.
  - `skills/trim-context/scripts/comment-inventory.mjs` — a read-only, deterministic
    mechanical extractor that walks tracked files with real Tree-sitter syntax trees
    (never a text/regex heuristic) to emit comment-unit JSON, now read as the
    per-file weight/targeting input that ranks files into lots rather than an
    exhaustive inventory; a `parse-error` row names a real gap but no longer blocks
    ledger finality (ADR-0028). Its runtime and every grammar live vendored under
    `skills/trim-context/scripts/vendor/` (`web-tree-sitter/` + `grammars/*.wasm`),
    copied unmodified from npm and never fetched at run time;
    `skills/trim-context/scripts/vendor/PROVENANCE.md` records each asset's source
    package/version, license, and SHA-256, plus the re-vendoring steps.
    `skills/trim-context/references/sweep-contract.md` is the shared contract
    `/dobby:trim-context` and `/dobby:anti-slop` both read for ranking/approval,
    disjoint ownership, independent review, and the `.dobby/sweeps.json` ledger
    format (per-file `trim-context`/`anti-slop` sub-keys, coverage accruing
    incrementally, so the two sweeps coexist without one invalidating the other's
    coverage).

## Interface

- **Skills** are invoked as `/dobby:<skill-name>` (the plugin name `dobby` + the
  directory name), matching CLAUDE.md's namespacing rule.
- **Agents** are invoked as `subagent_type: dobby:<agent-name>` from a Task/Agent
  dispatch, named per the dispatch protocol
  (`plugin/skills/execute/references/build-protocol.md`) the Architect follows
  directly for every task.
- **Hooks** need no invocation — `hooks/hooks.json` is auto-loaded whenever the
  plugin is enabled, and fires on every `Edit`/`Write` PostToolUse event.
- Everything else (worktree lifecycle, `dobby check`/`up`/`down`/`dev`, `dobby env`
  for the environment snapshot, `dobby instructions <topic>` for the per-topic
  instruction catalogue a skill or agent carries out itself) is reached through
  `bunx dobby …`, never imported code. The two-step bring-up — `up`, carry out
  its `instructions[]`, `up` again — is written once in
  `plugin/skills/execute/references/bring-up.md` and cited by every skill that
  brings a run up (`execute`, `scope`, `dispatch`, `address-review`, `diagnose`,
  `prototype`, `finish`) and by `agents/qa.md`.

## Invariants

- **Self-contained.** No file under `plugin/` references `../cli` or a consumer's
  `node_modules`, except to name that boundary in prose (the trim-context sweep
  contract and vendor provenance docs describe the constraint, they don't violate
  it) and the edit hook's legitimate `node_modules/.bin/dobby` guard.
- **Skills carry no `model:`/`effort:` in frontmatter** — they inherit the
  interactive session's model/effort (ADR-0004). Only the five agent files under
  `agents/` declare `model`/`effort`, each the sole source for its own role — there
  is no external recipe to mirror.
- **`SKILL.md` stays ≤500 lines** (`skills/create-skill/SKILL.md`'s own limit); the
  largest skill in this plugin today is `data-processing/SKILL.md` at 316 lines.
  Anything larger splits into `references/`.
- **Cross-references stay namespaced**: `/dobby:<skill>` for skills, `dobby:<agent>`
  for agent dispatch. Bare names are reserved for things outside the plugin.
- **Vendored assets carry license + hash provenance.** Any binary or third-party
  source checked into a skill (currently only `trim-context/scripts/vendor/`)
  records its origin package/version, license, and a SHA-256 per file in a
  `PROVENANCE.md` alongside it, and is never fetched over the network at run time.

## What's intentionally NOT here

- **The mechanical layer.** Environment detection, the quality gate (including the
  implementor's Exit gate and the edit hook's type-error scan), and the run
  lifecycle are the `@kvnwolf/dobby` CLI's job (`cli/`), consumed only through
  `bunx dobby …`. This plugin has no build step, no config schema of its own, and
  adds no CLI command, config key, check, or gate — including `trim-context` and
  `anti-slop`, which are inference-only sweeps.
- **Tests.** Plugin behavior is exercised from `cli/src/*.test.ts` against these
  files: the vendored comment extractor, and (`build-protocol.test.ts`) the
  dispatch protocol document's worker-naming, dependency-start, and Exit-gate
  serialisation rules. Agent frontmatter's `model:`/`effort:` presence is checked
  separately, by `dobby.config.json`'s `frontmatter-model-effort` `checks[]` extra.
  There is no test runner or test file under `plugin/` itself.
- **A `dobby.config.json` reader.** That file's mechanical keys (`checks[]`,
  `setup[]`, `teardown[]`, `tracker`, `release`) are read by the CLI, not by
  anything under `plugin/`.
