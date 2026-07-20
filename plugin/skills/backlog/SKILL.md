---
name: backlog
description: Quick-capture a follow-up, bug, or tech-debt item to the project tracker (GitHub Issues, Linear, or local). Use when you spot something worth tracking mid-work and want it logged, not triaged now.
argument-hint: "[the item to capture]"
---

This is quick-capture, NOT triage — log the item, then stop.

## Step 1: Dedup by concept

Before writing anything, check whether this is already tracked. Match by **domain concept, not keyword** — "night theme" and "dark mode" are the same item; a request to "not double-charge on retry" and one about "idempotent payments" are the same concept. Scan the obvious surfaces: the configured tracker's open items, and — if the project runs triage — `docs/out-of-scope/*.md` for a matching *rejected* concept.

Which tracker, and how to search it, comes from `references/trackers.md`: read the `tracker` key from `dobby.config.json` at the repo root (with the Read tool; **absent → github**), then run the **dedup / search** recipe for that backend (github via `gh`, linear via the Linear MCP, local via `BACKLOG.md`). That reference owns the mechanics — including the shell-hardening for the github path.

If a live item already covers the concept, say so and stop (don't file a near-duplicate). If it matches a concept in `docs/out-of-scope/`, surface that it was previously rejected and ask once whether to file anyway — don't silently re-open a settled decision. Only when nothing matches do you proceed to capture.

## Step 2: Capture the item

Take the item from `$ARGUMENTS`, or from what was just spotted in the conversation. Write a clear title + a short body that a future reader can absorb in **30 seconds**, and make it **behavioral, not procedural** — describe the interfaces/contracts and the desired behavior, so it survives the code moving underneath it:

- **Do** name the type, function signature, config shape, or endpoint the change concerns, and state what it should do (the contract), what's wrong or missing now, and why it matters.
- **Don't** cite file paths or line numbers — they go stale; the actor picking this up will explore the code fresh. (A commit SHA or PR/issue URL is fine — those are stable anchors, not code locations.)
- **Good:** "The `SkillConfig` type should accept an optional `schedule` (a cron expression); today there's no way to defer a skill, so scheduled runs silently no-op."
- **Bad:** "Add a `schedule` field to the config type on line 42 of the skill loader."

Don't over-describe — enough to act on later, not a full spec (that's `/dobby:scope`'s job). If it grows past a paragraph or two, it's really a task, not a quick-capture.

## Step 3: Pick the label

Apply exactly **one role label** matching what the item *is*: `bug` (broken), `feature` (new capability), `chore` (maintenance/deps/config), or `docs` (docs only). These four role labels are the **same across every backend** (`references/trackers.md` creates the label lazily if the tracker doesn't have it yet). One stable vocabulary is what lets a later reader dedup by concept. Skip priority/assignee — don't interrogate.

## Step 4: Create the issue

Create the item on the configured tracker (from Step 1) with the role label from Step 3, using the **create + role-label** recipe for that backend in `references/trackers.md`. That reference owns every mechanical detail: the github path writes the body out-of-band via `--body-file` and keeps the shell-hardening (title single-quoted, no heredoc), linear passes structured MCP args, and local appends a checklist line to `BACKLOG.md`. If the configured backend's tool is unavailable, `references/trackers.md` degrades gracefully to the `local` recipe — say which you used.

## Step 5: Confirm

Show what was created — issue title + URL, or the `BACKLOG.md` line. One line. Then return to what you were doing; don't expand into planning the item.

## Language

Interact in the user's language; write the issue title/body in the project's convention (English for code-facing items; domain terms in their real-world form).
