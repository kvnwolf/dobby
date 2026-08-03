#!/usr/bin/env bash
# wrap-dispose.sh — dispose the ephemeral STATE.md at the end of /dobby:wrap.
#
# usage: bash scripts/wrap-dispose.sh [--root <dir>] [--force]
#
# STATE.md is ephemeral by design: once the durable bits live in CONTEXT.md /
# CLAUDE.md / docs/adr/, it goes. What must NOT go with it is unfinished work —
# so this refuses (exit 1) while the file still carries:
#   * a `_pending_` section — a stage that never filled its section, or
#   * a `needs-human` marker — something the machine layers handed back.
# It PRINTS them (section + line) rather than summarizing: the gap is named, so
# it can be finished or consciously waived with --force.
#
# It also asserts HEAD did not move while it ran. Disposal is the last step
# before /dobby:commit; a commit landing mid-run means something else is writing
# the tree, and deleting the session's memory under it would be blind.
#
# Exit 0 = disposed, or nothing to dispose (idempotent — a second run is safe).
# Exit 1 = refused (unfinished markers, or HEAD moved).
#
# Portability: BSD (macOS) userland first — no `sed -E` with `+?`.

set -u

ROOT=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      if [ $# -lt 2 ]; then
        echo "wrap-dispose.sh: --root needs a directory" >&2
        exit 1
      fi
      ROOT="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h | --help)
      grep '^# ' "$0" | cut -c3-
      exit 0
      ;;
    *)
      echo "wrap-dispose.sh: unexpected argument: $1 (usage: wrap-dispose.sh [--root <dir>] [--force])" >&2
      exit 1
      ;;
  esac
done

if [ -n "$ROOT" ] && ! cd "$ROOT" 2>/dev/null; then
  echo "wrap-dispose.sh: not a directory: $ROOT" >&2
  exit 1
fi

if ! WORKROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "wrap-dispose.sh: not inside a git repository (cwd: $PWD) — run it from the work session's worktree, or pass --root <dir>" >&2
  exit 1
fi
cd "$WORKROOT" || exit 1

HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "(no commits)")
STATE="$WORKROOT/STATE.md"

if [ ! -f "$STATE" ]; then
  echo "nothing to dispose — no STATE.md at $STATE"
  exit 0
fi

# --- the refusal ------------------------------------------------------------
# `_pending_` is the state engine's WHOLE-BODY replace-marker: a section is
# pending when its body, trimmed, IS that word — a section whose prose merely
# mentions the marker (STATE.md documents it) is FILLED and must not block
# disposal. `### ` never opens a section, matching the engine's splitting rules.
# wrap-inventory.sh carries the same rule and the two must stay in sync.
PENDING=$(awk '
  function flush() { if (s != "" && nonblank == 1 && only == "_pending_") printf "    STATE.md:%d  ## %s\n", start, s }
  /^## / { flush(); s = substr($0, 4); start = NR; nonblank = 0; only = ""; next }
  { if (s != "") { line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line); if (line != "") { nonblank++; if (nonblank == 1) only = line } } }
  END { flush() }
' "$STATE")
NEEDS_HUMAN=$(grep -n -i 'needs-human' "$STATE" | sed 's#^#    STATE.md:#')

if [ -n "$PENDING" ] || [ -n "$NEEDS_HUMAN" ]; then
  if [ "$FORCE" -eq 0 ]; then
    echo "wrap-dispose.sh: refusing to dispose $STATE — it still carries unfinished work:" >&2
    if [ -n "$PENDING" ]; then
      echo "  _pending_ sections:" >&2
      printf '%s\n' "$PENDING" >&2
    fi
    if [ -n "$NEEDS_HUMAN" ]; then
      echo "  needs-human markers:" >&2
      printf '%s\n' "$NEEDS_HUMAN" >&2
    fi
    echo "  Finish or resolve them, then re-run — or re-run with --force to dispose anyway." >&2
    exit 1
  fi
  echo "--force: disposing despite unfinished markers:"
  [ -n "$PENDING" ] && printf '%s\n' "$PENDING"
  [ -n "$NEEDS_HUMAN" ] && printf '%s\n' "$NEEDS_HUMAN"
fi

# --- the HEAD assertion, then the deletion ----------------------------------
HEAD_NOW=$(git rev-parse HEAD 2>/dev/null || echo "(no commits)")
if [ "$HEAD_NOW" != "$HEAD_BEFORE" ]; then
  echo "wrap-dispose.sh: HEAD moved while this ran ($HEAD_BEFORE → $HEAD_NOW) — refusing to delete $STATE" >&2
  exit 1
fi

LINES=$(wc -l < "$STATE" | tr -d '[:space:]')
# `cut -c4-` drops the `## `, not `sed` — a `#` delimiter cannot carry a literal
# `#` in its pattern, and BSD sed rejects the escape.
SECTIONS=$(grep '^## ' "$STATE" | cut -c4- | awk 'BEGIN{ORS=""} {if (NR>1) printf ", "; print}')

if ! rm -f "$STATE"; then
  echo "wrap-dispose.sh: could not delete $STATE" >&2
  exit 1
fi

echo "disposed STATE.md — $LINES lines"
echo "  path:     $STATE"
echo "  sections: ${SECTIONS:-(none)}"

HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null || echo "(no commits)")
if [ "$HEAD_AFTER" != "$HEAD_BEFORE" ]; then
  echo "wrap-dispose.sh: HEAD moved during disposal ($HEAD_BEFORE → $HEAD_AFTER) — STATE.md is already deleted; check what committed mid-wrap before continuing" >&2
  exit 1
fi
echo "  HEAD:     $HEAD_BEFORE (unchanged)"
