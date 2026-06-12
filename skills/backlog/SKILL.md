---
name: backlog
description: Quick-capture a follow-up, bug, or tech-debt item to the project tracker (Linear) without breaking your flow. Use when you spot something worth tracking mid-work and want it logged and out of your head, not triaged now.
argument-hint: "[the item to capture]"
model: sonnet
effort: medium
---

Capture a backlog item fast and get back to work. This is quick-capture, NOT triage — get it logged with enough context to act on later, then stop.

## Step 1: Capture the item

Take the item from `$ARGUMENTS`, or from what was just spotted in the conversation. Write a clear title + a one-paragraph body: what it is, why it matters, and a pointer (`file:line`, the task it came up in) so future-you isn't lost. Don't over-describe — enough to act on later.

## Step 2: Pick the target

- If the project documents a default Linear team/project (in `CLAUDE.md`'s workflow config or similar), use it.
- Otherwise ask once (plain text or AskUserQuestion) which team/project, and reuse that for the rest of the session.

Add labels/priority only if obvious; don't interrogate.

## Step 3: Create the issue

Create the issue via the Linear MCP (authenticate if needed). If Linear isn't available, fall back to appending the item to a `BACKLOG.md` at the repo root (create it lazily) and say which you used.

## Step 4: Confirm

Show what was created — issue title + URL, or the `BACKLOG.md` line. One line. Then return to what you were doing; don't expand into planning the item.

## Language

Interact in the user's language; write the issue title/body in the project's convention (English for code-facing items; domain terms in their real-world form).
