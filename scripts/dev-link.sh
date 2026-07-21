#!/usr/bin/env bash
set -euo pipefail

# dev-link.sh — point the CURRENT project at THIS dobby worktree for smoke testing.
#
# Lives inside the dobby worktree, so running a given worktree's copy links that
# worktree — different target repos can point at different dobby worktrees at
# the same time (the global `bun link` registry is keyed by package name, so it
# can't do this; a path-based `file:` dependency can).
#
# Run FROM the target project's root:
#   <dobby-worktree>/scripts/dev-link.sh          # link this worktree + disable the global plugin
#   <dobby-worktree>/scripts/dev-link.sh --undo   # restore the npm version + re-enable the plugin
#
# What it does:
#   1. .claude/settings.local.json — disable the user-scope `dobby@dobby` plugin
#      (it collides with --plugin-dir).
#   2. package.json — devDependency `@kvnwolf/dobby` → `file:<this-worktree>/cli`.
#      Bun COPIES a file: dep (its `link:` protocol only resolves the name-keyed
#      global registry, verified 2026-07 — no path symlinks), so the spec survives
#      `bun install` (incl. `dobby up`'s setup phase) but CLI edits in the worktree
#      need a RE-RUN of this script to re-copy (~fast). Skills need no re-run:
#      --plugin-dir reads the worktree live.
#   3. `bun install` (dobby's bundled toolchain lands in the target, like a real
#      npm install), then print the `claude --plugin-dir` command.
#
# package.json + lockfile stay dirty ON PURPOSE while testing — run --undo before committing.

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$PWD"

[ -f "$TARGET/package.json" ] || { echo "error: no package.json here — run from the target project's root" >&2; exit 1; }
[ "$TARGET" != "$WORKTREE" ] || { echo "error: target IS the dobby worktree — run from a consumer project" >&2; exit 1; }

SETTINGS="$TARGET/.claude/settings.local.json"

if [ "${1:-}" = "--undo" ]; then
	# Re-enable the global plugin (drop the override; empty enabledPlugins is dropped too).
	if [ -f "$SETTINGS" ]; then
		SETTINGS="$SETTINGS" bun -e '
			const p = process.env.SETTINGS;
			const s = JSON.parse(require("fs").readFileSync(p, "utf8"));
			if (s.enabledPlugins) {
				delete s.enabledPlugins["dobby@dobby"];
				if (Object.keys(s.enabledPlugins).length === 0) delete s.enabledPlugins;
			}
			require("fs").writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
		'
	fi
	bun remove @kvnwolf/dobby >/dev/null 2>&1 || true
	bun add -d @kvnwolf/dobby
	echo "undone: @kvnwolf/dobby back on npm, global dobby plugin re-enabled"
	exit 0
fi

# 1. Disable the user-scope plugin for this project.
mkdir -p "$TARGET/.claude"
SETTINGS="$SETTINGS" bun -e '
	const fs = require("fs");
	const p = process.env.SETTINGS;
	const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
	s.enabledPlugins = { ...s.enabledPlugins, "dobby@dobby": false };
	fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
'

# 2. Point the devDependency at this worktree's cli via the file: protocol.
WORKTREE="$WORKTREE" bun -e '
	const fs = require("fs");
	const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
	pkg.devDependencies = { ...pkg.devDependencies, "@kvnwolf/dobby": `file:${process.env.WORKTREE}/cli` };
	fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'

# 3. Materialize the copy + bin (drop any stale copy first so re-runs pick up CLI edits).
rm -rf node_modules/@kvnwolf/dobby
bun install

echo ""
echo "linked: @kvnwolf/dobby $(./node_modules/.bin/dobby --version 2>/dev/null || echo '(bin not resolving!)') -> $WORKTREE/cli"
echo "(package.json/lockfile are dirty on purpose — '$0 --undo' before committing)"
echo ""

# 4. Environment snapshot, then hand the terminal to Claude pointing at this worktree's plugin.
./node_modules/.bin/dobby env
echo ""
exec claude --plugin-dir "$WORKTREE/plugin"
