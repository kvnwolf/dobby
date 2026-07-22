# The CLI is zero-framework, zero-dependency, with a Node/Bun-portable core

**Status:** accepted — the zero-dependency and no-long-running pillars are superseded by [ADR-0011](./0011-bundled-toolchain-zero-config.md); the dist-build/publish consequence is superseded by [ADR-0014](./0014-publish-all-typescript.md) (raw-TS publish, no bundle). The portable core, the `run()` seam, and release-from-main stand.

`@kvnwolf/dobby` is a Bun-only CLI (raw TS bin, `#!/usr/bin/env bun`, no build step) — yet its core (`cli/src/run.ts`, `cli/src/detect.ts`) deliberately uses **only `node:*` APIs** (util `parseArgs`, fs, path) and **no `Bun.*` globals or `bun:` imports**. The non-obvious reason: the test suite runs under **vitest via `vp test`** (vite-plus), which executes on a **Node/Vite runtime** where `Bun` does not exist — anything the tests import must be runtime-portable. This same coupling is why the **bunli** framework was evaluated and rejected: its `@bunli/core` hard-depends on Bun-runtime globals (`Bun.stringWidth`, `bun:ffi`), so its test helpers — the main thing it offered us — can't run under our suite; it also carries 9 dependencies and is pre-1.0, against a one-command CLI that needs none. The single test seam is `run(argv, cwd) → { exitCode, stdout, stderr }`; the bin entry (`index.ts`) is a logic-free process adapter and the only Bun-executed-only file.

## Considered options

- **`node:util` parseArgs + hand-rolled dispatch, node:*-only core (chosen)** — zero deps, fully exercisable in-process from vitest with on-disk fixtures.
- **bunli (`@bunli/core` + `@bunli/test`)** — rejected on evidence: Bun-runtime-locked core incompatible with the vitest/vp suite (would need Bun-global shims), ~9 transitive deps + zod for one command, pre-1.0 single-maintainer. Revisit only if the command surface grows large AND tests may move to `bun test`.
- **Testing by spawning the real bin** — rejected: couples the suite to a `bun` binary on the CI runner's PATH (setup-vp does not guarantee one) and is slower than in-process calls.

## Consequences

- The runtime-portability invariant is recorded in `cli/CONTEXT.md` and enforced by review: no `Bun.*`/`bun:` in anything vitest imports.
- The vite-plus toolchain is pinned to the coherent `0.1.24` set (cli devDeps AND root `overrides`): voidzero's `@latest` tags are skewed (`vite-plus-test@latest` ships without the vitest bin and breaks `vp test`). Unpin deliberately, when upstream heals.
- Long-running commands (the future `dobby dev`) do NOT fit the `run()` contract; their streaming/lifecycle interface is designed when the first one exists (two-adapters rule — no speculative seam).
- npm publish (deferred) should ship a `bun build --target node` bundle rather than raw TS: raw TS bins require Bun on the consumer and hit the weak Windows shim path.
- **Releases are cut from the MAIN checkout only, never from a worktree**: worktrees are in-review branches, `npm publish` is irreversible per version, and the local `bun link` model already anchors distribution to main. Flow (manual): merge to main → version bump in `cli/package.json` → `bun build --target node` (+ shebang rewrite to node — bun build preserves the source's bun shebang) → flip `bin`→`dist` + `files:["dist"]` (publishConfig can't override bin) → `bun publish --access public` → git-restore the flip → tag `v<version>`. The procedure is encoded in the project skill `/release` (`.claude/skills/release/`).
