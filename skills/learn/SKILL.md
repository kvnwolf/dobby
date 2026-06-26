---
name: learn
description: Mine a marked session (a /dobby:mark indicator, or a raw path to a session .jsonl from any project) to improve dobby's internal skills from how they actually behaved in the field. Use in the dobby repo when you have a session pointer and want to turn its friction into concrete skill edits.
argument-hint: "[indicator block or .jsonl path] — which skill/area to improve"
model: opus
effort: max
---

This is **kit self-improvement tooling**. You work in the dobby repo and improve a kit skill using evidence from a real session run in some *other* project. You are the architect: you delegate the transcript digest to a `dobby:researcher`, then turn its findings into skill edits via a worker. You do NOT read the multi-MB transcript yourself.

## Step 1: Resolve the pointer

From `$ARGUMENTS`, extract the transcript path: the `transcript:` line of a `dobby-session` block, or a bare `…/<uuid>.jsonl` path. Confirm it exists (`test -f`). Also note the user's improvement intent — which skill or area (the `note:` field, or what they typed). If the target skill is ambiguous, ask once; otherwise proceed.

If the block carries a `state:` path, `test -f` it: a live `STATE.md` is the richest context (goal, decisions, plan, work-log). It's ephemeral — `/dobby:wrap` deletes it and the worktree at `cwd:` may be archived — so treat both as best-effort. When `STATE.md` is gone, its content is still embedded in the transcript; the digest recovers it there.

## Step 2: Delegate the digest

Dispatch one `dobby:researcher` (Agent tool, `subagent_type: "dobby:researcher"`). Tell it:
- The transcript path, and to parse it with `python3` — **never** Read it (it can be megabytes).
- The `STATE.md` path if it's still on disk — read it directly for the plan/decisions/work-log; otherwise reconstruct that spine from the transcript's tool-result reads of `STATE.md`.
- JSONL shape: one JSON object per line; `type` is `user`/`assistant`/…; `message.content` is a string or an array of blocks (`text`/`tool_use`/`tool_result`). Human messages are `type=user` with string or `text` content and **no** `tool_result` block — tool results also arrive as `type=user` and are NOT the human.
- What to extract, scoped to the target skill/area: friction and rework, the user's literal corrections ("no, mejor así" / "siempre haz X"), where the recipe failed, and which `/dobby:*` skills ran (`grep -oE 'dobby/skills/[a-z-]+'`).
- To return short **literal quotes** + why each matters — findings, not solutions.

## Step 3: Synthesize the edit proposal

You own this call. Map findings → concrete changes, each backed by the user's own words:
- Which skill file(s) to touch (`skills/<name>/SKILL.md` or its `references/`).
- For each: what to add/change, and the quote that justifies it.
- Flag if the signal argues for a **new** skill rather than editing an existing one.

Present the proposal and get approval before writing.

## Step 4: Apply via a worker

Hand the approved edits to a `dobby:implementor` (or `/dobby:dispatch`), pointing it at the exact files. Stay the architect — review what comes back; don't edit the skills yourself. New skills go through `/dobby:create-skill`. Keep the README/decision-table sync in mind (the `/dobby:commit` doc-sync contract enforces it).

## Privacy
The researcher extracts **method and pattern** signal, not the consumer project's business content. A kit skill must never carry a client's domain specifics — keep the digest to how the agent should *work*, not what it was building.

## Language
User-facing output in the user's language; skill edits in English (the kit is all-English).
