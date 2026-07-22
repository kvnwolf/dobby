---
name: release
description: Cut an npm release of @kvnwolf/dobby from the main checkout — inferred bump, raw-TS tarball gate, publish, tag, GitHub release with changelog.
disable-model-invocation: true
argument-hint: "[patch|minor|major]"
---

Cut ONE release of `@kvnwolf/dobby` (the `cli/` workspace) to npm. Every step ends on a gate — a checkable condition; stop and report at the first gate that fails. The why behind the mechanics (raw-TS publish — `bin` → `src/index.ts`, no bundle, no flip — and main-only releases) lives in `docs/adr/0008-zero-framework-portable-cli.md` and `docs/adr/0014-publish-all-typescript.md` — don't re-derive or "simplify" them.

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
- Apply the bump with a **direct JSON edit** of `cli/package.json`'s `version` — NOT `npm version`. `npm version` walks the surrounding workspace and dies with `EUNSUPPORTEDPROTOCOL catalog:` (it wrote the bump but exited 1 and killed the command chain — field-hit on v0.2.0). One-liner that computes the increment, preserves the tab indentation, and prints the new version as `V`:
  ```sh
  V=$(bun --eval '
    const p = "cli/package.json";
    const j = await Bun.file(p).json();
    const [maj, min, pat] = j.version.split(".").map(Number);
    const bump = process.argv[1];
    j.version = bump === "major" ? `${maj + 1}.0.0`
      : bump === "minor" ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;
    await Bun.write(p, JSON.stringify(j, null, "\t") + "\n");
    console.log(j.version);
  ' <bump>)
  ```
- **Lockstep mirror**: write the same `<V>` into `plugin/.claude-plugin/plugin.json`'s `version` — the kit versions in lockstep; the CLI's npm version owns the number, plugin.json mirrors it (ADR-0007).
- `git add cli/package.json plugin/.claude-plugin/plugin.json && git commit -m "release: v<V>"`. Do NOT push — pushing gates on a successful publish (Step 5). A failed publish is undone with `git reset --hard HEAD~1` while the commit is still local.

## Step 3: Gate on the tarball

- `cd cli && bun pm pack` and read the printed file list.
- Gate — the tarball IS the raw-TS publish shape (no bundle, no flip); assert ALL:
  - **Present**: `src/index.ts` (the Bun-shebang bin) and the preset assets — `biome/*`, `tsconfig*.json`, the `*.mjs` presets, their `*.d.mts` type siblings, and `knip.base.jsonc`.
  - **Absent**: `src/run.test.ts` and `__fixtures__` (tests never ship).
  - **No** `dist/` anywhere in the list.
- Any test file, any `__fixtures__`, or any `dist/` → stop, do not publish.

## Step 4: Publish

- `cd cli && npm publish --access public` (scoped package needs public access; add `--tag next` for a prerelease). Plain `npm` — NOT `bun publish`: bun 1.3.x does not read `~/.npmrc`'s `_authToken` for publish and dies with "missing authentication" (field-hit on v0.1.0). `npm` is on PATH via the bundled toolchain.
- Gate: `npm view @kvnwolf/dobby version` → `<V>`. Propagation can lag MINUTES on a first publish — the package may 404 even authenticated while npm processes it (it shows on the npmjs.com web page first). Don't panic on the 404 if `npm publish` printed `+ @kvnwolf/dobby@<V>`; Step 7's global install is the definitive smoke.

## Step 5: Tag and push

- No package.json to restore — the repo already IS the publish shape (bin → `src/index.ts`, `files` allowlist), so the tree is clean apart from the pack tarball.
- `find cli -maxdepth 1 -name '*.tgz' -delete` (find, not a bare glob — zsh aborts the whole command when `cli/*.tgz` has no match).
- `git tag v<V> && git push origin main v<V>`
- Gate: `git status --porcelain` → empty.

## Step 6: GitHub release with changelog

- Build the notes from the SAME commit range used for the bump inference (single source for bump + changelog). Classify each commit by the SURFACE its touched paths hit (`git show --name-only --pretty=format: <sha>`): only `cli/**` → **CLI**; only `plugin/**` → **Plugin**; anything else or both → **Kit**. Sections in this order, empty sections/groups omitted, each line `- <subject> (<short-sha>)`:
  - `### Plugin`, `### CLI`, `### Kit` — and inside each: `#### Breaking changes` (commits that matched the major rule), `#### Features` (`feat`), `#### Fixes` (`fix`), `#### Other` (the rest).
  - First release (no prior tag): notes are just `Initial release.`
- `gh release create v<V> --title "v<V>" --notes "<notes>"`
- Gate: `gh release view v<V>` exits 0.

## Step 7: Reinstall the global bin + smoke

- `bun install -g @kvnwolf/dobby@<V>` — refresh this machine's global `dobby` to the just-published version (the machine runs the latest release; `bun link` is only for hacking on the CLI itself). On a fresh publish the registry may still 404 — retry every ~20s for a few minutes before declaring failure.
- Gate: `dobby --version` → prints `<V>`. This is the definitive proof that the **raw-TS bin runs via its Bun shebang** end-to-end from the consumer install path. Plain-**node** execution of the published bin is NOT supported — it requires Bun on PATH (the whole fleet is Bun — ADR-0014); don't smoke it under node.
- Report to the user: version published, inferred bump + reasoning, tarball contents, tag + GitHub release links, global-install smoke result.

## Acceptance checklist

- [ ] All 5 preflight gates passed (main checkout + branch, clean + current, CI green, npm auth, registry sanity)
- [ ] Bump inferred from the commit range (or taken from the argument); reasoning reported; 0.x-major and first-release cases asked, never assumed
- [ ] Version bumped via the direct JSON edit of `cli/package.json` (never `npm version` — the `catalog:` trap), with plugin.json mirrored to the same version (lockstep); committed as `release: v<V>`; nothing pushed before the publish succeeded
- [ ] Tarball inspected: `src/index.ts` + preset assets (`biome/*`, `tsconfig*.json`, `*.mjs`, `*.d.mts`, `knip.base.jsonc`) present; `src/run.test.ts` and `__fixtures__` absent; no `dist/`
- [ ] Published with plain `npm publish --access public` (never `bun publish`); registry shows `<V>` (first-publish propagation can take minutes)
- [ ] `v<V>` tag pushed with main; pack tarball cleaned; tree clean (no flip to restore — the repo IS the publish shape)
- [ ] GitHub release `v<V>` created with the changelog grouped by surface (Plugin/CLI/Kit) from the same commit range as the bump
- [ ] Global bin refreshed with `bun install -g @kvnwolf/dobby@<V>` and `dobby --version` printed `<V>` (proves the raw-TS Bun-shebang bin runs; plain-node unsupported)
