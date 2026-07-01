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

**Consult the discarded-frictions KB first.** Read `docs/learn-discarded/*.md` (if the directory exists — it's created lazily, so its absence just means nothing's been discarded yet). These are frictions a past `/dobby:learn` session deliberately decided NOT to turn into skill edits, with durable reasons. Match the user's improvement intent against them **by concept, not keyword**. If a rejected concept covers this session's friction, tell the maintainer — "this resembles `docs/learn-discarded/<concept>.md`, declined before because [reason] — still holds?" — and don't re-propose the rejected edit unless they say the context has changed. This keeps a settled *no* from being re-litigated every few sessions. Full format and the reconsider/dedup flow in `references/discarded-frictions-kb.md`.

## Step 2: Delegate the digest

Dispatch one `dobby:researcher` (Agent tool, `subagent_type: "dobby:researcher"`). Tell it:
- The transcript path, and to parse it with `python3` — **never** Read it (it can be megabytes).
- The `STATE.md` path if it's still on disk — read it directly for the plan/decisions/work-log; otherwise reconstruct that spine from the transcript's tool-result reads of `STATE.md`.
- JSONL shape: one JSON object per line; `type` is `user`/`assistant`/…; `message.content` is a string or an array of blocks (`text`/`tool_use`/`tool_result`). Human messages are `type=user` with string or `text` content and **no** `tool_result` block — tool results also arrive as `type=user` and are NOT the human.
- What to extract, scoped to the target skill/area: friction and rework, the user's literal corrections ("no, mejor así" / "siempre haz X"), where the recipe failed, and which `/dobby:*` skills ran (`grep -oE 'dobby/skills/[a-z-]+'`).
- To return short **literal quotes** + why each matters — findings, not solutions.
- **Verify the claim, don't just report it.** For each friction it surfaces, the researcher must confirm it is actually *reproducible in this transcript* — cite the concrete turns (a message index or the paired tool_use/tool_result) where the friction happened, not a paraphrase or an impression. A friction it can't anchor to specific turns is a **`unverified`** finding and must be labelled so — it carries no weight in the proposal. An asserted-but-unlocated friction is the exact failure this prevents: proposing a skill edit for something the session didn't actually do.

## Step 3: Synthesize the edit proposal

You own this call. Map findings → concrete changes, each backed by the user's own words:
- Which skill file(s) to touch (`skills/<name>/SKILL.md` or its `references/`).
- For each: what to add/change, and the quote that justifies it.
- Flag if the signal argues for a **new** skill rather than editing an existing one.

**Cross-reference with the skill's CURRENT text before proposing an edit.** A verified friction (Step 2) tells you the session *behaved* badly; it does not tell you the skill's wording *caused* it. Open the target `skills/<name>/SKILL.md` (or its `references/`) and confirm the current text actually produces the cited friction — the recipe is genuinely ambiguous / missing the step / says the wrong thing. Only skip anchored findings, never this check. If the skill already says the right thing and the session ignored it, the fix is not a wording edit (it may be a stronger context-pointer, an agent-prompt change, or nothing) — say so instead of piling redundant text onto a skill that was already correct. Editing a skill whose current text does NOT produce the friction is sediment, not a fix.

**When a verified friction should NOT become an edit, discard it on the record.** Some frictions are real and reproduced but still don't warrant a skill change — a consumer-project preference rather than a kit-methodology change, a remedy that already lives in another `/dobby:<skill>`, or a cost that every future session pays to serve a one-off. Don't silently drop these: with the maintainer's agreement, record the discard in `docs/learn-discarded/` (one kebab-case concept file, durable reason, deduped by concept — full flow in `references/discarded-frictions-kb.md`) so the same friction isn't re-litigated next session, and note in the proposal that it was recorded, not forgotten. Only *verified* frictions that were *declined* go here — a friction that failed Step 2 or the cross-reference check has nothing to discard.

Present the proposal — proposed edits, and any discards with their reasons — and get approval before writing.

## Step 4: Apply via a worker

Hand the approved edits to a `dobby:implementor` (or `/dobby:dispatch`), pointing it at the exact files **by cwd-relative path** (`skills/<name>/SKILL.md`) — never anchor to this skill's plugin-install path. When dobby is dogfooded from a Conductor worktree, the cwd IS the dobby checkout on the work branch, and that's where edits must land so the change flows branch → PR → `main` (with `autoUpdate` carrying it back to the global plugin clone). Editing the global install directly skips the branch and the PR. Stay the architect — review what comes back; don't edit the skills yourself. New skills go through `/dobby:create-skill`. Keep the README/decision-table sync in mind (the `/dobby:commit` doc-sync contract enforces it).

Any discard the maintainer approved in Step 3 is a file too — hand the worker the `docs/learn-discarded/<concept>.md` write (new concept file, or an appended "Prior occurrences" line on an existing one) in the same dispatch, by the same cwd-relative path rule. The architect doesn't write it directly either.

## Privacy
The researcher extracts **method and pattern** signal, not the consumer project's business content. A kit skill must never carry a client's domain specifics — keep the digest to how the agent should *work*, not what it was building.

## Language
User-facing output in the user's language; skill edits in English (the kit is all-English).
