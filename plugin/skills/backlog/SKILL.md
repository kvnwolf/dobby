---
name: backlog
description: Quick-capture a follow-up, bug, or tech-debt item to the project tracker (GitHub Issues, Linear, or local). Use when you spot something worth tracking mid-work and want it logged, not triaged now.
argument-hint: "[the item to capture]"
---

This is quick-capture, NOT triage — log the item, then stop.

Every tracker mechanic runs through `bunx dobby`, which reads the project's backend itself (`dobby.config.json#tracker`, absent → github) — so you name the operation, never the backend. What stays yours: the **concept-level dedup judgment** and the wording of the item.

## Step 1: Dedup by concept

Start with the backend, because the next two commands answer differently on each:

```bash
bunx dobby tracker info --json          # {type, team, available, degradedTo, reason}
```

**Two branches come out of it**, both owned by `references/trackers.md`: `type: "linear"` makes every tracker command answer with a delegation descriptor you execute through the Linear MCP; `degradedTo: "local"` means the configured backend can't be reached (D8) — switch to the local `BACKLOG.md` recipe there and say which you used, rather than running a command that will fail.

Then check whether this is already tracked:

```bash
bunx dobby tracker search "<concept>" --json
bunx dobby kb list --kind out-of-scope --json
```

`tracker search` returns **candidates, not a verdict**. The match is by **domain concept, not keyword** — "night theme" and "dark mode" are the same item; a request to "not double-charge on retry" and one about "idempotent payments" are the same concept. So search the *concept*, not the reporter's phrasing, and try a second wording before concluding nothing is tracked. Deciding whether a candidate IS the same item is your call, and the whole reason this step isn't a single command.

`kb list --kind out-of-scope` lists the concepts a previous triage **rejected** (an empty array when the project doesn't run triage) — each with its one-line statement, so you can match by concept there too.

Then:

- **A live item covers the concept** → say so and stop. Don't file a near-duplicate.
- **A rejected concept covers it** → surface that it was rejected before, with the reason, and ask **once** whether to file anyway. Don't silently re-open a settled decision.
- **Nothing matches** → capture.

## Step 2: Capture the item

Take the item from `$ARGUMENTS`, or from what was just spotted in the conversation. Write a clear title + a short body that a future reader can absorb in **30 seconds**, and make it **behavioral, not procedural** — describe the interfaces/contracts and the desired behavior, so it survives the code moving underneath it:

- **Do** name the type, function signature, config shape, or endpoint the change concerns, and state what it should do (the contract), what's wrong or missing now, and why it matters.
- **Don't** cite file paths or line numbers — they go stale; the actor picking this up will explore the code fresh. (A commit SHA or PR/issue URL is fine — those are stable anchors, not code locations.)
- **Good:** "The `SkillConfig` type should accept an optional `schedule` (a cron expression); today there's no way to defer a skill, so scheduled runs silently no-op."
- **Bad:** "Add a `schedule` field to the config type on line 42 of the skill loader."

Don't over-describe — enough to act on later, not a full spec (that's `/dobby:scope`'s job). If it grows past a paragraph or two, it's really a task, not a quick-capture.

## Step 3: Pick the label

Apply exactly **one role label** matching what the item *is*: `bug` (broken), `feature` (new capability), `chore` (maintenance/deps/config), or `docs` (docs only). These four are the **same on every backend**, and a missing label is created lazily before it's used. One stable vocabulary is what lets a later reader dedup by concept. Skip priority/assignee — don't interrogate.

## Step 4: Create the item

Write the body with the `Write` tool to an absolute path **OUTSIDE the repo** — the OS temp dir, e.g. `/tmp/dobby-item-<timestamp>.md` (`Write` takes a literal path; it does not expand `$TMPDIR`). This skill runs mid-work in the user's own checkout and `bunx dobby ship` stages the whole tree, so a `body.md` dropped at the repo root rides along in their next commit. Then hand the file over:

```bash
bunx dobby tracker create --title "<title>" --body-file <file> --label <role> --json
```

The body travels as a FILE, never as an argument — that is the flag's shape, not a precaution you have to take (see the superseded shell-hardening note in `references/trackers.md`). The answer is `{number, url}` on github; on linear it's the `op:"create"` descriptor to execute; on local the checklist line is appended for you. `rm -f <file>` once the item exists.

If Step 1 reported `degradedTo: "local"`, don't run this against the unreachable backend — append the line by hand in the format `references/trackers.md` fixes, and say that's what you did.

## Step 5: Confirm

Show what was created — issue title + URL, or the `BACKLOG.md` line. One line. Then return to what you were doing; don't expand into planning the item.

## Language

Interact in the user's language; write the issue title/body in the project's convention (English for code-facing items; domain terms in their real-world form).

## Acceptance checklist

- [ ] Dedup run BEFORE writing anything — `bunx dobby tracker search` + `bunx dobby kb list --kind out-of-scope`, matched by **concept** (second wording tried); live match → stopped, prior rejection → surfaced and asked once
- [ ] Item is behavioral, not procedural: interfaces/contracts named, no file paths or line numbers, absorbable in 30 seconds
- [ ] Exactly one role label (`bug` / `feature` / `chore` / `docs`); no priority/assignee interrogation
- [ ] Created with `bunx dobby tracker create --title … --body-file … --label …` (body written first to a temp file **outside the repo**, removed afterwards); a linear descriptor executed per `references/trackers.md`, a `degradedTo: "local"` fallback done by hand and said out loud
- [ ] Confirmed in one line (title + URL, or the `BACKLOG.md` line), then stopped — no planning, no triage
