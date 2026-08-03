#!/usr/bin/env bash
# mark.sh — print the `dobby-session v1` indicator for the CURRENT Claude Code
# session: resolve its transcript, enrich it, emit the block.
#
# usage: bash scripts/mark.sh "<note>" [/dobby:<skill>] [--cwd <dir>]
#
#   <note>          what was rough / what to improve — the field /dobby:learn
#                   leans on most (the intent that would otherwise be buried in
#                   a multi-MB transcript).
#   /dobby:<skill>  optional hint for which skill to audit first. It is dropped
#                   with a warning unless the session actually launched it — an
#                   invented skill mis-orients /dobby:learn.
#   --cwd <dir>     the SESSION's working directory (default: the cwd). The
#                   transcript path is DERIVED from it, so never `cd` into the
#                   skill directory to run this — pass --cwd instead.
#
# Host-coupled on purpose: it reads Claude Code's own session storage
# (~/.claude/projects/<slug>/<session-id>.jsonl) and $CLAUDE_CODE_SESSION_ID.
# That is why it lives in this skill rather than in the `dobby` CLI, which ships
# to consumer projects and must know nothing about the host.
#
# Portability: BSD (macOS) userland first — no `sed -E` with `+?` (unsupported
# there), `awk -F` does the splitting. Exit 1 only when the transcript cannot be
# resolved; every enrichment step is best-effort and degrades to a blank field.

set -u

NOTE=""
SUGGESTED=""
CWD="$PWD"
POSITIONAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cwd)
      if [ $# -lt 2 ]; then
        echo "mark.sh: --cwd needs a directory" >&2
        exit 1
      fi
      CWD="$2"
      shift 2
      ;;
    -h | --help)
      grep '^# ' "$0" | cut -c3-
      exit 0
      ;;
    *)
      POSITIONAL=$((POSITIONAL + 1))
      if [ "$POSITIONAL" -eq 1 ]; then
        NOTE="$1"
      elif [ "$POSITIONAL" -eq 2 ]; then
        SUGGESTED="$1"
      else
        echo "mark.sh: unexpected argument: $1 (usage: mark.sh \"<note>\" [/dobby:<skill>] [--cwd <dir>])" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if ! cd "$CWD" 2>/dev/null; then
  echo "mark.sh: not a directory: $CWD" >&2
  exit 1
fi

# --- resolve the transcript -------------------------------------------------
# Claude Code writes the live transcript to
# ~/.claude/projects/<slug>/<session-id>.jsonl, where the slug is the cwd with
# `/` and `.` replaced by `-`.
SLUG=$(pwd | sed 's#[/.]#-#g')
SESSION="${CLAUDE_CODE_SESSION_ID:-}"
if [ -z "$SESSION" ]; then
  echo "mark.sh: \$CLAUDE_CODE_SESSION_ID is unset — cannot name this session's transcript" >&2
  exit 1
fi
TX="$HOME/.claude/projects/$SLUG/$SESSION.jsonl"
if [ ! -f "$TX" ]; then
  echo "NOT FOUND: $TX" >&2
  exit 1
fi

# --- enrich (best-effort: a failed step blanks ONE field, never the run) -----
REPO=$(git remote get-url origin 2>/dev/null | sed 's#\.git$##' | awk -F'[/:]' 'NF>1{print $(NF-1)"/"$NF}')
REPO=${REPO:-$(basename "$(pwd)")}

# BSD `stat` first (the host this recipe was proven on); the GNU form is a pure
# fallback for a Linux host and changes nothing on macOS.
WHEN=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$TX" 2>/dev/null || stat -c '%y' "$TX" 2>/dev/null | cut -c1-16)

# The skills this session actually INVOKED — keyed off each skill's launch
# banner, not incidental mentions. This exact pattern is the one /dobby:learn's
# digest uses; they must stay identical (an indicator and its digest disagreeing
# about what ran is the whole D7 drift).
#
# The segment right before `skills/` is ANCHORED to `dobby` or `plugin`, never
# an open `.*`. The kit moved its skills under `plugin/`, so a live banner reads
# `…/dobby/plugin/skills/<name>` (and `…/dobby/.claude/worktrees/<x>/plugin/
# skills/<name>` from a worktree), while the pre-plugin era read
# `…/dobby/skills/<name>`; both are covered. An open `…/dobby/.*skills/` would
# ALSO swallow `…/dobby/.claude/skills/<name>` — a PROJECT skill of the dobby
# checkout, not a kit skill — and `skills:` must list only the /dobby:* skills
# this session invoked, or the hint check below accepts a skill that isn't ours.
# (Cost of the anchor: the retired conductor layout `…/workspaces/<x>/skills/
# <name>` no longer matches — a wildcard there is exactly the over-match.)
# Greedy `.*` still yields one skill per line, which the `sed` reduces to
# `/dobby:<name>`.
SKILLS=$(grep -oE 'Base directory for this skill: .*/(dobby|plugin)/skills/[a-z-]+' "$TX" 2>/dev/null | sed 's#.*/#/dobby:#' | sort -u | tr '\n' ' ')
SKILLS=$(printf '%s' "$SKILLS" | sed 's#[[:space:]]*$##')

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
STATE="$ROOT/STATE.md"
test -f "$STATE" || STATE="(absent — disposed at /dobby:wrap or never created; recover from transcript)"

if [ -z "$SKILLS" ]; then
  echo "mark.sh: no skill-launch banner found in the transcript — \`skills:\` is empty" >&2
fi

# The hint must be one of the skills the session ran; never emit an invented one.
if [ -n "$SUGGESTED" ]; then
  case " $SKILLS " in
    *" $SUGGESTED "*) : ;;
    *)
      echo "mark.sh: dropping suggested \`$SUGGESTED\` — this session never launched it (skills: ${SKILLS:-none detected})" >&2
      SUGGESTED=""
      ;;
  esac
fi

if [ -z "$NOTE" ]; then
  echo "mark.sh: no note given — it is the field /dobby:learn leans on most" >&2
fi

# --- emit -------------------------------------------------------------------
printf 'dobby-session v1\n'
printf '  transcript: %s\n' "$TX"
printf '  repo: %s   when: %s\n' "$REPO" "$WHEN"
printf '  cwd: %s\n' "$ROOT"
printf '  state: %s\n' "$STATE"
printf '  skills: %s\n' "$SKILLS"
if [ -n "$SUGGESTED" ]; then
  printf '  suggested: %s\n' "$SUGGESTED"
fi
printf '  note: %s\n' "$NOTE"
