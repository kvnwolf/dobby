#!/usr/bin/env bash
set -euo pipefail

# dev-link.sh — point the CURRENT project at THIS dobby worktree for smoke testing.
#
# Lives inside the dobby worktree, so running a given worktree's copy links that
# worktree — different target repos can point at different dobby worktrees at
# the same time.
#
# MECHANISM: a bun pm pack TARBALL with a unique per-build filename, installed
# via `bun add -d @kvnwolf/dobby@file:<stamped .tgz>`. Lab-verified (2026-07)
# as the ONLY local-consumption path that satisfies all four constraints:
#   - installs at main AND git worktrees (absolute tarball path in the lockfile;
#     the file:<dir> form hit bun's cache race there — bun issue #28062);
#   - the .mjs/.jsonc presets resolve peer-deps from the CONSUMER's tree
#     (file:<dir> installs symlink each file back to dobby's dep-less source
#     tree, breaking @kvnwolf/dobby/{vite,vitest/react,drizzle}; so do hand
#     symlinks and bun link);
#   - cheap refresh: a NEW filename per pack = new cache key + new integrity
#     (a same-name repack serves bun's STALE cache, or IntegrityCheckFailed);
#   - several worktrees consumable simultaneously (slug-stamped tarballs).
#
# Run FROM the target project's root:
#   <dobby-worktree>/scripts/dev-link.sh            # link this worktree + disable the global plugin
#   <dobby-worktree>/scripts/dev-link.sh --refresh  # repack + repoint after worktree edits (no claude launch)
#   <dobby-worktree>/scripts/dev-link.sh --undo     # restore the npm version + re-enable the plugin
#
# Refreshing WITHOUT leaving the claude session also works — run --refresh in
# its Bash tool (each `bunx dobby` spawns fresh, so the new copy applies
# immediately; skills hot-reload on their own via --plugin-dir; agents/hooks
# need /reload-plugins).
#
# package.json/lockfile stay dirty ON PURPOSE while testing — run --undo before committing.

WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$PWD"
SLUG="$(basename "$WORKTREE")"
TDIR="/tmp/dobby-tarballs"

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

# Pack this worktree's cli into a slug+timestamp-stamped tarball (a unique name
# per build — bun caches tarballs by path+integrity, so reusing a name serves
# stale content). Old stamps for THIS slug are pruned first.
pack() {
	mkdir -p "$TDIR"
	rm -f "$TDIR/kvnwolf-dobby-$SLUG-"*.tgz
	(cd "$WORKTREE/cli" && bun pm pack --destination "$TDIR" >/dev/null)
	TGZ="$TDIR/kvnwolf-dobby-$SLUG-$(date +%s).tgz"
	mv "$TDIR"/kvnwolf-dobby-*.tgz "$TGZ"
	bun add -d "@kvnwolf/dobby@file:$TGZ"
}

if [ "${1:-}" = "--refresh" ]; then
	grep -q '"@kvnwolf/dobby"' package.json || { echo "error: not linked (run without flags first)" >&2; exit 1; }
	pack
	echo "refreshed: @kvnwolf/dobby $(./node_modules/.bin/dobby --version 2>/dev/null || echo '(bin not resolving!)')"
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

# 2+3. Pack + point the devDependency at the stamped tarball.
pack

echo ""
echo "linked: @kvnwolf/dobby $(./node_modules/.bin/dobby --version 2>/dev/null || echo '(bin not resolving!)') -> $WORKTREE (tarball)"
echo "(package.json/lockfile are dirty on purpose — '$0 --undo' before committing)"
echo ""

# 4. Environment snapshot, then hand the terminal to Claude pointing at this worktree's plugin.
./node_modules/.bin/dobby env
echo ""
exec claude --plugin-dir "$WORKTREE/plugin"
