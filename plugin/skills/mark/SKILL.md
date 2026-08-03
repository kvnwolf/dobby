---
name: mark
description: Emit a portable pointer ("indicator") to the CURRENT Claude Code session. Use when you hit friction with a dobby skill while working in a consumer project and want to flag this session for /dobby:learn — not fix the kit now.
argument-hint: "[one line: what was rough / what to improve]"
---

This is **kit self-improvement tooling**, not methodology or convention — it deliberately couples to the host (`~/.claude/projects`, `CLAUDE_CODE_SESSION_ID`). It captures a pointer for `/dobby:learn`; it changes nothing.

## Step 1: Emit the indicator

One command does the whole mechanical part — resolve this session's transcript, enrich it, print the block:

```bash
bash scripts/mark.sh "<$ARGUMENTS — what was rough / what to improve>"
```

Leave the cwd where the **session** is — spell the script by its absolute path under this skill's base directory rather than `cd`-ing into that directory, because the transcript path is derived from the cwd (`~/.claude/projects/<slug>/$CLAUDE_CODE_SESSION_ID.jsonl`, slug = the cwd with `/` and `.` replaced by `-`). If you had to run it from somewhere else, pass `--cwd <session cwd>`.

**If it prints `NOT FOUND: <path>`, stop and say so** — don't guess another file. (Ceiling: it assumes the live session writes to its own id-named file, which is the documented layout. If Claude Code ever changes that, this breaks loudly, not silently.)

What the fields mean, and which of them carry weight:

- `transcript:` — **the load-bearing field**; the only thing `/dobby:learn` strictly needs. The path is correct AT EMISSION, but if the session later enters a worktree (`EnterWorktree` changes the cwd → new slug dir) the transcript MOVES there. The indicator stays valid anyway: `learn` recovers it by the immutable `.jsonl` uuid basename, not by this slug-derived path.
- `skills:` — the `/dobby:*` skills this session actually invoked, keyed off each skill's launch banner rather than incidental mentions, so future-you knows which internal skill to open. The banner pattern lives in `scripts/mark.sh` and is shared verbatim with `/dobby:learn`'s digest — one definition, so an indicator and its digest can't disagree about what ran.
- `cwd:` — the worktree root, the durable anchor for *where* this ran. `state:` points at dobby's ephemeral `STATE.md` (repo root, gitignored: goal + decisions + plan + work-log) and is **best-effort** — `/dobby:wrap` deletes it, so it's only on disk if you mark mid-session. Either way `learn` can recover its content from the transcript.
- `note:` — your `$ARGUMENTS`. The most valuable field: the intent that would otherwise be buried in a huge transcript.

## Step 2: Add a suggested skill (optional hint)

`/dobby:learn` still has to guess *which* skill in `skills:` the friction is about. If the note or the session clearly points at ONE, re-run the script with it as the second argument — `bash scripts/mark.sh "<note>" /dobby:<skill>` — and the block gains a `suggested:` line that pre-orients `learn` on which skill to audit first. This is a **hint, not a verdict**: `learn` mines the evidence and may land elsewhere. Rules:

- Prefer the skill named or implied in the note. Otherwise, if exactly one skill in `skills:` is where the friction happened, suggest that one.
- It must be one of the `skills:` values — the script drops (with a warning on stderr) any skill the session never launched, so a hint can never invent one.
- Genuinely unsure, or the friction spans several skills? Don't pass one. An absent `suggested:` is correct and expected; a wrong one mis-orients `learn`.

## Step 3: Hand the block over

Print the block exactly as the script emitted it — one copy-pasteable `dobby-session v1` block, nothing rewritten. Then stop. Tell the user: paste this into the dobby repo and run `/dobby:learn <paste>`.

## Language

User-facing output in the user's language; the indicator block stays as-is (it's data).

## Acceptance checklist

- [ ] `bash scripts/mark.sh "<note>"` run from the SESSION's cwd (or with `--cwd`), never after `cd`-ing into the skill directory
- [ ] A `NOT FOUND` result stopped the run and was reported — no alternative file guessed
- [ ] `suggested:` present only when one skill in `skills:` clearly owns the friction; omitted when unsure
- [ ] The `dobby-session v1` block handed over verbatim, with the `/dobby:learn <paste>` instruction
- [ ] Nothing else changed — mark captures a pointer and never edits the kit
