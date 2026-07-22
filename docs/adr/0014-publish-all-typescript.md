# The npm package ships raw TypeScript — no dist build

**Status:** accepted — supersedes the dist-build/publish consequence of [ADR-0008](./0008-zero-framework-portable-cli.md); the portable core and the `run()` seam stand.

ADR-0008's deferred-publish consequence shipped a `bun build --target node` bundle with a Node shebang and a publish-time `bin`→`dist` flip — a path built for machines that don't exist in this ecosystem. The maintainer's fleet is 100% Bun: skills invoke `bunx dobby`, the edit hook calls the consumer's local `node_modules/.bin/dobby`, CI runs on `setup-bun`, Vercel installs with Bun. The Node bundle served nobody, and the build plus the `bin`/`files` flip made `/release` the single most fragile part of the kit (shebang rewrites, tarball-shape flips, git-restore-the-flip). Decision: **publish `bin.dobby = ./src/index.ts` as-is**, keeping its `#!/usr/bin/env bun` shebang; the `files` allowlist ships `src` (minus tests) plus the preset assets. The repo's `package.json` IS the publish shape now — no bundle, no flip, no restore.

The presets stay **`.mjs` with shipped `.d.mts` siblings**, NOT `.ts`: consumer config loaders (vitest, drizzle-kit, vite) run under **Node** — the gate runs vitest under node-if-present per the check-runtime rule — and Node refuses type-stripping for files resolved under `node_modules`; every strict consumer that imported a `.ts` preset hit `TS7016`. Shipping `.mjs` gives Node a runnable module and the `.d.mts` sibling supplies the types.

## Consequences

- Running the published bin under **plain Node is unsupported** — it requires Bun on PATH (that is the whole fleet). The `bun install -g` + `dobby --version` global smoke proves the raw-TS bin runs via its Bun shebang.
- `/release` loses three steps (bundle build, `bin`/`files` flip, restore-the-flip); its tarball gate now asserts `src/index.ts` + preset assets present, tests and `__fixtures__` absent, and no `dist/`.
