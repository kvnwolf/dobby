#!/usr/bin/env bash
# wrap-inventory.sh — the read-only inventory /dobby:wrap Step 2 starts from.
#
# usage: bash scripts/wrap-inventory.sh [--root <dir>] [--base <ref>]
#
# Answers, for this work session, the four questions the doc reconcile opens on:
#   1. WHAT CHANGED — files changed against the merge-base with origin/HEAD
#      (tracked + untracked), grouped by module.
#   2. WHICH MODULES HAVE NO CONTEXT.md — a changed directory with no CONTEXT.md
#      anywhere up its chain is a module doc that does not exist yet.
#   3. ADRs — the highest number currently in docs/adr/. This is orientation
#      ONLY: the next number is allocated by `bunx dobby adr new` at write time,
#      never read off this report (a sibling worktree may already own max + 1).
#   4. STATE.md — the sections still marked `_pending_`.
#
# Grouping rule: a file's module is the nearest ANCESTOR directory carrying a
# CONTEXT.md; with none, its top-level directory (reported as `no`), and files at
# the repo root group under `(root)` (they belong to no module). The repo root's
# own CONTEXT.md is deliberately not a module doc — it is the glossary.
#
# It writes nothing, deletes nothing and decides nothing: the ADR/CONTEXT calls
# stay with the architect.
#
# Portability: BSD (macOS) userland first — no `sed -E` with `+?`; `awk -F` does
# the splitting. Exit 1 only when there is no repository to inventory.

set -u

ROOT=""
BASE_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      if [ $# -lt 2 ]; then
        echo "wrap-inventory.sh: --root needs a directory" >&2
        exit 1
      fi
      ROOT="$2"
      shift 2
      ;;
    --base)
      if [ $# -lt 2 ]; then
        echo "wrap-inventory.sh: --base needs a git ref" >&2
        exit 1
      fi
      BASE_OVERRIDE="$2"
      shift 2
      ;;
    -h | --help)
      grep '^# ' "$0" | cut -c3-
      exit 0
      ;;
    *)
      echo "wrap-inventory.sh: unexpected argument: $1 (usage: wrap-inventory.sh [--root <dir>] [--base <ref>])" >&2
      exit 1
      ;;
  esac
done

if [ -n "$ROOT" ] && ! cd "$ROOT" 2>/dev/null; then
  echo "wrap-inventory.sh: not a directory: $ROOT" >&2
  exit 1
fi

if ! WORKROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "wrap-inventory.sh: not inside a git repository (cwd: $PWD) — run it from the work session's worktree, or pass --root <dir>" >&2
  exit 1
fi
cd "$WORKROOT" || exit 1

# --- the comparison base ----------------------------------------------------
git fetch -q origin 2>/dev/null || true

BASE=""
BASE_SOURCE=""
if [ -n "$BASE_OVERRIDE" ]; then
  # `--verify --quiet` resolves to a sha or answers NOTHING — plain `rev-parse`
  # echoes the unresolvable ref back and would hand us a bogus base.
  if ! BASE=$(git rev-parse --verify --quiet "$BASE_OVERRIDE^{commit}"); then
    echo "wrap-inventory.sh: --base $BASE_OVERRIDE is not a commit in this repository" >&2
    exit 1
  fi
  BASE_SOURCE="--base $BASE_OVERRIDE"
else
  BASE=$(git merge-base origin/HEAD HEAD 2>/dev/null || true)
  if [ -n "$BASE" ]; then
    BASE_SOURCE="merge-base with origin/HEAD"
  else
    BASE=$(git rev-parse --verify --quiet HEAD~10 || true)
    if [ -n "$BASE" ]; then
      BASE_SOURCE="HEAD~10 (no origin/HEAD to merge-base against)"
    else
      BASE_SOURCE="none — uncommitted work only (no origin/HEAD, history shorter than 10)"
    fi
  fi
fi
DIFF_REF=${BASE:-HEAD}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/wrap-inventory.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM
PAIRS="$TMP/pairs"
: > "$PAIRS"

# --- 1. what changed, grouped by module -------------------------------------
{
  git diff --name-only "$DIFF_REF" -- 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
} | sort -u > "$TMP/files"

CHANGED=$(wc -l < "$TMP/files" | tr -d '[:space:]')

while IFS= read -r file; do
  [ -n "$file" ] || continue
  dir=$(dirname "$file")
  group=""
  ctx=""
  probe="$dir"
  while [ "$probe" != "." ] && [ "$probe" != "/" ]; do
    if [ -f "$probe/CONTEXT.md" ]; then
      group="$probe"
      ctx="yes"
      break
    fi
    probe=$(dirname "$probe")
  done
  if [ -z "$group" ]; then
    if [ "$dir" = "." ]; then
      group="(root)"
      ctx="n/a"
    else
      group=${file%%/*}
      ctx="no"
    fi
  fi
  printf '%s\t%s\t%s\n' "$group" "$ctx" "$file" >> "$PAIRS"
done < "$TMP/files"

echo "== wrap inventory =="
echo "workroot: $WORKROOT"
echo "head:     $(git rev-parse --short HEAD 2>/dev/null || echo '(no commits)')  branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "base:     $(git rev-parse --short "$BASE" 2>/dev/null || echo "${BASE:-(none)}")  [$BASE_SOURCE]"
echo
echo "-- changed files by module ($CHANGED total) --"
if [ "$CHANGED" -eq 0 ]; then
  echo "  (nothing changed against the base — is this the right worktree?)"
else
  cut -f1 "$PAIRS" | sort -u | while IFS= read -r group; do
    count=$(awk -F'\t' -v g="$group" '$1==g{c++} END{print c+0}' "$PAIRS")
    ctx=$(awk -F'\t' -v g="$group" '$1==g{print $2; exit}' "$PAIRS")
    printf '  %-38s %4s file(s)   CONTEXT.md: %s\n' "$group" "$count" "$ctx"
    awk -F'\t' -v g="$group" '$1==g{print "      " $3}' "$PAIRS" | head -n 6
    if [ "$count" -gt 6 ]; then
      printf '      … +%s more\n' "$((count - 6))"
    fi
  done
fi

# --- 2. changed modules with no CONTEXT.md ----------------------------------
echo
echo "-- changed modules with NO CONTEXT.md --"
MISSING=$(awk -F'\t' '$2=="no"{print "  " $1}' "$PAIRS" | sort -u)
if [ -n "$MISSING" ]; then
  printf '%s\n' "$MISSING"
  echo "  (each needs one: purpose · Files · Interface · Invariants · What's NOT here)"
else
  echo "  (none — every changed module already carries one)"
fi

# --- 3. ADRs ----------------------------------------------------------------
echo
echo "-- docs/adr --"
if [ -d docs/adr ]; then
  # `sort -n` on the basenames, so an unpadded 9- still ranks below 0013-.
  LATEST=$(for adr in docs/adr/[0-9]*; do [ -f "$adr" ] && basename "$adr"; done | sort -n | tail -n 1)
  if [ -n "$LATEST" ]; then
    echo "  current max: docs/adr/$LATEST"
  else
    echo "  present but empty"
  fi
else
  echo "  docs/adr/ does not exist yet"
fi
echo "  next number: allocated by \`bunx dobby adr new\` at write time — never picked from this report"

# --- 4. STATE.md ------------------------------------------------------------
echo
echo "-- STATE.md sections still _pending_ --"
if [ -f STATE.md ]; then
  # `_pending_` is the state engine's WHOLE-BODY replace-marker: a section is
  # pending when its body, trimmed, IS that word — not when its prose happens to
  # mention it (STATE.md documents the marker, so a substring scan reports the
  # sections that merely talk about it). `### ` never opens a section, matching
  # the engine's own splitting rules. wrap-dispose.sh carries the same rule and
  # the two must stay in sync.
  PENDING=$(awk '
    function flush() { if (s != "" && nonblank == 1 && only == "_pending_") printf "  ## %s (line %d)\n", s, start }
    /^## / { flush(); s = substr($0, 4); start = NR; nonblank = 0; only = ""; next }
    { if (s != "") { line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line); if (line != "") { nonblank++; if (nonblank == 1) only = line } } }
    END { flush() }
  ' STATE.md)
  if [ -n "$PENDING" ]; then
    printf '%s\n' "$PENDING"
  else
    echo "  (none — every section is filled)"
  fi
else
  echo "  (no STATE.md at $WORKROOT — nothing to reconcile from)"
fi
