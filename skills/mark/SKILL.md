---
name: mark
description: Emit a portable pointer ("indicator") to the CURRENT Claude Code session so it can be mined later from the dobby repo to improve the kit. Use when you hit friction with a dobby skill while working in a consumer project and want to flag this session for /dobby:learn — not fix the kit now.
argument-hint: "[one line: what was rough / what to improve]"
model: haiku
effort: low
---

This is **kit self-improvement tooling**, not methodology or convention — it deliberately couples to the host (`~/.claude/projects`, `CLAUDE_CODE_SESSION_ID`). It runs in a *consumer* project: you used a dobby skill here, it was rough, and you want to capture *this* session so you can later improve the skill from the dobby repo with `/dobby:learn`. It captures a pointer; it changes nothing.

## Step 1: Resolve this session's transcript

Claude Code writes the live transcript to `~/.claude/projects/<slug>/<session-id>.jsonl`, where the slug is the cwd with `/` and `.` replaced by `-`, and the id is in `$CLAUDE_CODE_SESSION_ID`. Compute the path and confirm it exists:

```bash
SLUG=$(pwd | sed 's#[/.]#-#g')
TX="$HOME/.claude/projects/$SLUG/$CLAUDE_CODE_SESSION_ID.jsonl"
test -f "$TX" && echo "$TX" || echo "NOT FOUND: $TX"
```

If it reports NOT FOUND, stop and say so — don't guess another file. (Ceiling: assumes the live session writes to its own id-named file, which is the documented layout. If Claude Code ever changes that, this breaks loudly, not silently.)

## Step 2: Enrich (best-effort, never fail the whole thing)

```bash
REPO=$(git remote get-url origin 2>/dev/null | sed 's#\.git$##' | awk -F'[/:]' 'NF>1{print $(NF-1)"/"$NF}'); REPO=${REPO:-$(basename "$(pwd)")}
WHEN=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$TX")
SKILLS=$(grep -oE 'Base directory for this skill: .*/dobby/skills/[a-z-]+' "$TX" | sed 's#.*/#/dobby:#' | sort -u | tr '\n' ' ')
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
STATE="$ROOT/STATE.md"; test -f "$STATE" || STATE="(absent — disposed at /dobby:wrap or never created; recover from transcript)"
echo "repo=$REPO when=$WHEN skills=$SKILLS"; echo "root=$ROOT"; echo "state=$STATE"
```

`SKILLS` is the list of `/dobby:*` skills this session actually invoked — keyed off each skill's launch banner, not incidental mentions — so future-you knows which internal skill to open. (BSD-safe: `awk -F` splits the remote URL, no lazy regex; `sed -E +?` does not work on macOS.)

`ROOT` is the worktree root — the durable anchor for *where* this ran (it may be a Conductor worktree). `STATE` points at dobby's ephemeral `STATE.md` (repo root, gitignored: the goal + decisions + plan + work-log). It's **best-effort**: `/dobby:wrap` deletes it, so it's only on disk if you mark mid-session. Either way `learn` can recover its content from the transcript.

## Step 3: Pick a suggested skill to audit (optional hint)

`SKILLS` lists *every* `/dobby:*` skill the session touched; `/dobby:learn` still has to guess *which one* the friction is about. If `$ARGUMENTS` (the note) or the session clearly points at ONE skill, emit it as `suggested:` — a single `/dobby:<skill>` that pre-orients `learn` on which skill to audit first, so it doesn't have to re-derive the target or ask. This is a **hint, not a verdict**: `learn` mines the evidence and may land elsewhere. Rules:

- Prefer the skill named or implied in the `note:`. Otherwise, if exactly one skill in `SKILLS` was where the friction happened, suggest that one.
- Must be one of the `SKILLS` values (never invent a skill the session didn't run).
- Genuinely unsure, or the friction spans several skills? Omit the line — never guess. An absent `suggested:` is correct and expected; a wrong one mis-orients `learn`.

## Step 4: Print the indicator

Print one copy-pasteable block. The `transcript:` line is the only thing `/dobby:learn` strictly needs; the rest is for the human. Fold `$ARGUMENTS` into `note:` (this is the most valuable field — it's the intent that would otherwise be buried in a huge transcript). Include `suggested:` only when Step 3 produced one — omit the whole line otherwise:

```
dobby-session v1
  transcript: <TX>
  repo: <REPO>   when: <WHEN>
  cwd: <ROOT>
  state: <STATE>
  skills: <SKILLS>
  suggested: <one /dobby:<skill> from SKILLS to audit first — omit if unsure>
  note: <$ARGUMENTS — what was rough / what to improve>
```

Then stop. Tell the user: paste this into the dobby repo and run `/dobby:learn <paste>`.

## Language
User-facing output in the user's language; the indicator block stays as-is (it's data).
