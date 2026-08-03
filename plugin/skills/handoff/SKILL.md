---
name: handoff
description: Compact the current session into an ephemeral fork document a fresh Claude Code session can pick up.
argument-hint: "What will the next session focus on?"
disable-model-invocation: true
---

Write a handoff document a fresh Claude Code session can start from. This is a **side-path**, not a lifecycle stage — it never chains a Next-step and never disposes `STATE.md`.

**Context hygiene — fork, don't continue.** A long session accumulates dead ends, superseded plans, and stale reasoning that a fresh session shouldn't pay for. The handoff is the compacted seam between the two sessions: enough to resume, none of the sediment. It is **ephemeral** — discarded once the next session has absorbed it. Durable memory belongs in `CONTEXT.md`, ADRs, and commits, not here.

Reading the session for synthesis is the architect's own work here (like `/dobby:learn`) — you are compacting what you already hold, not dispatching a worker.

## Step 1: Gather the state (reference, don't copy)

Pull the resumable state from what already exists. **Reference each artifact by path or URL — never paste its contents.** Copying re-introduces the sediment you are trying to shed and goes stale the moment the source changes.

- `STATE.md` (repo root, if present) — goal, findings, spec, work log. The spine of the handoff; point at it.
- Durable docs the work touched — `CONTEXT.md`, `docs/adr/*`, module `CONTEXT.md`s.
- Version-control state — current branch, recent commits (`git log --oneline -10`), uncommitted diff (`git status --short`), the PR if one is open.
- Any tracker issue / PRD the session was working from.

If the session references an open PR, use `skills/address-review/references/github-api.md` for the `gh` mechanics (identify the PR, read its state) — don't re-author `gh` recipes.

## Step 2: Write the fork doc to the OS temp dir

Write to `${TMPDIR:-/tmp}/dobby-handoff-<timestamp>.md` (e.g. `dobby-handoff-20260701-1432.md`) — **the OS temp dir, NOT the workspace.** It must not land in the repo or in git. Compute the path and write the file; Step 3 validates it and prints the absolute path you hand to the next session.

Structure — these five ARE the sections the Step 3 gate checks for, so each must be a **top-level `## ` heading** carrying the name below (bold bullets or `###` sub-headings are not sections and fail the gate with one finding each). The gate matches by name **prefix**, so a heading that says more than the minimum — `## Open questions / next moves` — is fine.

- `## Focus` — one line: what the next session is for. If `$ARGUMENTS` is set, that IS the focus; tailor everything to it. Otherwise infer from the session's current thread.
- `## Where we are` — 3-6 lines of current state: what's done, what's in flight, what's blocked. Prose, not a transcript replay.
- `## Artifacts` — the reference list from Step 1, each as `path/URL — one line on what it holds`. No pasted bodies.
- `## Open questions` (e.g. `## Open questions / next moves`) — the decisions still live and the concrete next actions, so the fresh session doesn't re-derive them.
- `## Suggested skills` — the `/dobby:*` commands the next session should run, most-likely first, each with a one-line why.

Example of the suggested-skills section:

```markdown
## Suggested skills
- `/dobby:execute` — resume the plan in STATE.md; waves 2-3 remain
- `/dobby:diagnose` — if the flaky auth test from wave 1 resurfaces
- `/dobby:wrap` — once the last wave lands, to reconcile docs + commit
```

## Step 3: Redact, then finalize

**Redact what only judgment catches** — PII and identifying detail: private emails, personal names beyond what the work needs, customer or client identifiers. Reference where a secret lives (`.env`, the secret manager) rather than its value. When unsure, redact.

**Then let the gate judge the finished file:**

```bash
bunx dobby handoff finalize <path> --focus "<the focus this handoff was asked for>"
```

Pass `--focus` — `$ARGUMENTS` verbatim — whenever the skill was invoked with one; the gate then checks the `## Focus` line is actually about it. It judges the five sections, the one-line Focus, the no-fenced-block rule (a handoff references by path or URL, never pastes), every local artifact reference resolving against the workroot, every `/dobby:<skill>` suggestion naming a skill the plugin carries, the ephemeral location (a doc inside the repo or in git is a finding), and the **secret scan** — API keys, GitHub/Slack tokens, AWS access key ids, credential-carrying connection strings, inlined private keys, and bare `token = …` assignments.

**The secret scan fails closed**: a plausible token is a finding AND a nonzero exit, because a false positive costs one rewording while a miss costs a rotation. Any finding means the handoff is NOT ready — report the findings **verbatim** to the user (one per line, `path:line: message`), fix the document, and re-run until it comes back clean. Never hand off a document the gate rejected, and never paraphrase a finding away.

A clean run prints the document's **absolute path** — that printed path is the one you echo in the Next step.

## Next step

This is a side-path — there is **no lifecycle Next-step**. Tell the user the handoff is written and echo the absolute path `handoff finalize` printed, then present an **AskUserQuestion** (one question) that restates the handoff is complete and offers:

- **Open in a fresh session** *(Recommended)* — start a fresh Claude Code session and open the handoff (e.g. by passing the path to the new session); explain this is a manual step the user does in their own terminal, then stop.
- **Stop here** — end the turn.

Both selections end the turn — the handoff hands off to a *new* session, so there is no `/dobby:*` skill to chain into.

## Language

Interact with the user in their language. Write the handoff doc in English; keep artifact paths, branch names, and glossary terms in their real-world form.

## Acceptance checklist

- [ ] Doc written to `${TMPDIR:-/tmp}/dobby-handoff-<timestamp>.md` — NOT in the workspace / repo / git
- [ ] `bunx dobby handoff finalize <path> [--focus …]` run over the finished doc and CLEAN — any finding reported verbatim, fixed in the doc, and the gate re-run (never handed off with findings)
- [ ] Absolute path echoed for the user — the one `handoff finalize` printed
- [ ] Focus line reflects `$ARGUMENTS` when passed (`--focus` given to the gate)
- [ ] Artifacts referenced by path/URL only — nothing copied in
- [ ] "Suggested skills" section lists `/dobby:*` next commands with a one-line why each
- [ ] PII redacted by judgment; credential shapes cleared by the fail-closed secret scan
- [ ] No lifecycle Next-step chained; `STATE.md` left intact

---

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `productivity/handoff`.*
