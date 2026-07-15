---
name: release
description: Cut an npm release of @kvnwolf/dobby from the main checkout — inferred bump, node bundle, publish, tag, GitHub release with changelog.
disable-model-invocation: true
argument-hint: "[patch|minor|major]"
---

Cut ONE release of `@kvnwolf/dobby` (the `cli/` workspace) to npm. Every step ends on a gate — a checkable condition; stop and report at the first gate that fails. The why behind the mechanics (dual bin, shebang rewrite, main-only releases) lives in `docs/adr/0008-zero-framework-portable-cli.md` — don't re-derive or "simplify" them.

## Step 1: Preflight gates

From the repo root, ALL must pass:

1. **Main checkout, not a worktree**: `[ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]` → true.
2. **On main, clean, current**: `git rev-parse --abbrev-ref HEAD` → `main`; `git status --porcelain` → empty; `git pull --ff-only` succeeds.
3. **CI green on HEAD**: `gh run list --branch main --limit 1` → completed/success (if still running, `gh run watch` it to completion first).
4. **npm auth**: `npm whoami` prints a user. Note `whoami` passing does NOT guarantee publish rights: an interactive-login token fails at publish time with `EOTP` (the account's 2FA demands a per-publish one-time password). The working setup is a **granular access token with write access** in `~/.npmrc` (npmjs.com → Access Tokens → Granular; bypasses the per-publish OTP — field-proven on v0.1.0). If publish later hits `EOTP`, have the user create one and replace the token — theirs to do.
5. **Registry sanity**: `npm view @kvnwolf/dobby version` — note the published version (an E404 means first release; fine).

## Step 2: Infer the bump and apply it

- If the skill argument is `patch`/`minor`/`major` → use it, skip inference.
- Otherwise infer from the commits since the last release:
  - Last tag: `git describe --tags --abbrev=0 --match 'v*'`. **No tag yet** (first release) → nothing to infer from; AskUserQuestion for the bump (or publish the current version as-is if it was never published).
  - Range: `git log <last-tag>..HEAD --pretty=format:'%h %s'` (subjects) and `git log <last-tag>..HEAD --pretty=%B | grep -c 'BREAKING CHANGE'` (bodies).
  - Rules, first match wins: any subject with `!` before the `:` OR any `BREAKING CHANGE` body → **major**; else any `feat` subject → **minor**; else → **patch**.
  - **0.x exception**: inferred major while current version is `<1.0.0` → AskUserQuestion (true `1.0.0` vs the 0.x convention of shipping breaking as minor) — don't cross to 1.0.0 silently.
  - Report the inferred bump AND the commit subjects that justify it before proceeding — the user reads the reasoning, no confirmation gate.
- `cd cli && npm version <bump> --no-git-tag-version` (bun has no bump command). Note the new version as `V`.
- **Lockstep mirror**: write the same `<V>` into `plugin/.claude-plugin/plugin.json`'s `version` — the kit versions in lockstep; the CLI's npm version owns the number, plugin.json mirrors it (ADR-0007).
- `git add cli/package.json plugin/.claude-plugin/plugin.json && git commit -m "release: v<V>"`. Do NOT push — pushing gates on a successful publish (Step 7). A failed publish is undone with `git reset --hard HEAD~1` while the commit is still local.

## Step 3: Build the node bundle

- `cd cli && bun build ./src/index.ts --target node --outfile dist/index.js`
- `sed -i '' '1s|^#!.*|#!/usr/bin/env node|' dist/index.js` — bun build preserves the source's bun shebang verbatim (`--banner` stacks a second one instead of replacing; verified against Bun source).
- Gate: `head -1 dist/index.js` is exactly `#!/usr/bin/env node` AND `node dist/index.js --version` prints `<V>` — the bundle must run under plain Node.

## Step 4: Flip package.json to publish shape

Edit `cli/package.json`: `"bin": { "dobby": "./dist/index.js" }` and add `"files": ["dist"]`. This flip is the supported dual-bin mechanism — `publishConfig` cannot override `bin`, and `prepack`/`postpack` are skipped on the tarball path. The repo state (bin → `src/index.ts`, for the live `bun link`) comes back in Step 7.

## Step 5: Gate on the tarball

- `cd cli && bun pm pack` and read the printed file list.
- Gate: `dist/index.js` and `package.json` present; NO `src/` file in the list. Any `src/` entry → stop, do not publish.

## Step 6: Publish

- `cd cli && npm publish --access public` (scoped package needs public access; add `--tag next` for a prerelease). Plain `npm` — NOT `bun publish`: bun 1.3.x does not read `~/.npmrc`'s `_authToken` for publish and dies with "missing authentication" (field-hit on v0.1.0). `npm` is on PATH via the vite-plus toolchain.
- Gate: `npm view @kvnwolf/dobby version` → `<V>`. Propagation can lag MINUTES on a first publish — the package may 404 even authenticated while npm processes it (it shows on the npmjs.com web page first). Don't panic on the 404 if `npm publish` printed `+ @kvnwolf/dobby@<V>`; Step 9's global install is the definitive smoke.

## Step 7: Restore, tag, push

- `git checkout -- cli/package.json` (reverts the flip; the bump is already committed).
- `rm -rf cli/dist && find cli -maxdepth 1 -name '*.tgz' -delete` (find, not a bare glob — zsh aborts the whole command when `cli/*.tgz` has no match).
- `git tag v<V> && git push origin main v<V>`
- Gate: `git status --porcelain` → empty.

## Step 8: GitHub release with changelog

- Build the notes from the SAME commit range used for the bump inference (single source for bump + changelog). Classify each commit by the SURFACE its touched paths hit (`git show --name-only --pretty=format: <sha>`): only `cli/**` → **CLI**; only `plugin/**` → **Plugin**; anything else or both → **Kit**. Sections in this order, empty sections/groups omitted, each line `- <subject> (<short-sha>)`:
  - `### Plugin`, `### CLI`, `### Kit` — and inside each: `#### Breaking changes` (commits that matched the major rule), `#### Features` (`feat`), `#### Fixes` (`fix`), `#### Other` (the rest).
  - First release (no prior tag): notes are just `Initial release.`
- `gh release create v<V> --title "v<V>" --notes "<notes>"`
- Gate: `gh release view v<V>` exits 0.

## Step 9: Reinstall the global bin + smoke

- `bun install -g @kvnwolf/dobby@<V>` — refresh this machine's global `dobby` to the just-published version (the machine runs the latest release; `bun link` is only for hacking on the CLI itself). On a fresh publish the registry may still 404 — retry every ~20s for a few minutes before declaring failure.
- Gate: `dobby --version` → prints `<V>` (proves the consumer install path end-to-end).
- Report to the user: version published, inferred bump + reasoning, tarball contents, tag + GitHub release links, global-install smoke result.

## Acceptance checklist

- [ ] All 5 preflight gates passed (main checkout + branch, clean + current, CI green, npm auth, registry sanity)
- [ ] Bump inferred from the commit range (or taken from the argument); reasoning reported; 0.x-major and first-release cases asked, never assumed
- [ ] Bump committed as `release: v<V>` with plugin.json mirrored to the same version (lockstep); nothing pushed before the publish succeeded
- [ ] `dist/index.js` line 1 is the node shebang and the bundle runs under plain Node printing `<V>`
- [ ] Tarball inspected: `dist/` shipped, `src/` absent
- [ ] Published with plain `npm publish --access public` (never `bun publish`); registry shows `<V>` (first-publish propagation can take minutes)
- [ ] package.json restored to bin → src, `dist`/tgz cleaned, `v<V>` tag pushed with main, tree clean
- [ ] GitHub release `v<V>` created with the changelog grouped by surface (Plugin/CLI/Kit) from the same commit range as the bump
- [ ] Global bin refreshed with `bun install -g @kvnwolf/dobby@<V>` and `dobby --version` printed `<V>`
