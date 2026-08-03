#!/usr/bin/env bash
# resolve-session.sh — turn a /dobby:mark pointer into a transcript path that
# exists on disk, walking the whole resolution ladder.
#
# usage: bash scripts/resolve-session.sh "<indicator block or /path/<uuid>.jsonl>"
#        pbpaste | bash scripts/resolve-session.sh          (same input on stdin)
#
# The ladder:
#   1. take the `transcript:` line of a `dobby-session` block, else the first
#      bare …/<uuid>.jsonl path in the input;
#   2. if that file exists, answer it;
#   3. moved-transcript fallback — Claude Code RELOCATES a live transcript when
#      the session enters a worktree (the cwd changes, so the project slug dir
#      changes), so an indicator emitted before entering points at a path that
#      no longer exists. The `.jsonl` basename IS the immutable session uuid:
#      search ~/.claude/projects for it and take the largest (tie-break: newest)
#      match — the live file keeps accreting.
#   4. nothing found → the pointer is dead.
#
# Host-coupled on purpose (~/.claude/projects is Claude Code's own storage),
# which is why this lives in the skill and not in the `dobby` CLI.
#
# STDOUT is the resolved path and NOTHING else, so it can be captured; every
# note goes to stderr. Exit 1 = no path in the input, or pointer dead.
#
# Portability: BSD (macOS) userland first — no `sed -E` with `+?`.

set -u

case "${1:-}" in
  -h | --help)
    grep '^# ' "$0" | cut -c3-
    exit 0
    ;;
esac

INPUT="${1:-}"
if [ -z "$INPUT" ]; then
  INPUT=$(cat)
fi

# 1. extract the pointer
TX=$(printf '%s\n' "$INPUT" | grep '^[[:space:]]*transcript:' | head -n 1 | sed 's#^[[:space:]]*transcript:[[:space:]]*##;s#[[:space:]]*$##')
if [ -z "$TX" ]; then
  TX=$(printf '%s\n' "$INPUT" | grep -o '[^[:space:]]*\.jsonl' | head -n 1)
fi
if [ -z "$TX" ]; then
  echo "resolve-session.sh: no transcript in the input — expected a \`transcript:\` line of a dobby-session block, or a bare …/<uuid>.jsonl path" >&2
  exit 1
fi

# 2. the happy path
if [ -f "$TX" ]; then
  printf '%s\n' "$TX"
  exit 0
fi

# 3. moved-transcript fallback, by the immutable uuid basename
UUID=$(basename "$TX")
echo "resolve-session.sh: $TX is gone — recovering by session id ($UUID); a session that entered a worktree moves its transcript" >&2

BEST=""
BEST_SIZE=-1
BEST_MTIME=-1
MATCHES=0
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  MATCHES=$((MATCHES + 1))
  size=$(wc -c < "$candidate" 2>/dev/null | tr -d '[:space:]')
  mtime=$(stat -f '%m' "$candidate" 2>/dev/null || stat -c '%Y' "$candidate" 2>/dev/null)
  size=${size:-0}
  mtime=${mtime:-0}
  if [ "$size" -gt "$BEST_SIZE" ] ||
    { [ "$size" -eq "$BEST_SIZE" ] && [ "$mtime" -gt "$BEST_MTIME" ]; }; then
    BEST="$candidate"
    BEST_SIZE="$size"
    BEST_MTIME="$mtime"
  fi
done < <(find "$HOME/.claude/projects" -maxdepth 2 -name "$UUID" 2>/dev/null)

# 4. verdict
if [ -z "$BEST" ]; then
  echo "resolve-session.sh: pointer dead — no $UUID anywhere under $HOME/.claude/projects" >&2
  exit 1
fi
if [ "$MATCHES" -gt 1 ]; then
  echo "resolve-session.sh: $MATCHES copies found — taking the largest ($BEST_SIZE bytes)" >&2
fi
printf '%s\n' "$BEST"
