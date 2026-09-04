---
name: learn
description: Mine a marked session (a /dobby:mark indicator, or a raw path to a session .jsonl from any project) into concrete edits to dobby's skills, from how they actually behaved in the field. Use in the dobby repo when you have a session pointer to mine.
argument-hint: "[indicator block or .jsonl path] — which skill/area to improve"
---

This is **kit self-improvement tooling**. You work in the dobby repo and improve a kit skill using evidence from a real session run in some *other* project. You are the architect: you delegate the transcript digest to a `dobby:researcher`, then turn its findings into skill edits via a worker. You do NOT read the multi-MB transcript yourself.

## Step 1: Resolve the pointer

Hand `$ARGUMENTS` — the whole `dobby-session` block, or a bare `…/<uuid>.jsonl` path — to the resolver, which walks the ladder and answers a path that exists on disk:

```bash
bash scripts/resolve-session.sh "<$ARGUMENTS>"
```

Spell the script by its absolute path under this skill's base directory rather than `cd`-ing to it: `/dobby:learn` runs with the cwd at the dobby repo root, which has no `scripts/` dir, so the literal relative form above just fails. Nothing else about the call depends on the cwd — the pointer comes in as the argument (or on stdin).

It prints the resolved transcript on stdout and its reasoning on stderr; **exit 1 means the pointer is dead** — say so and stop, don't hunt for a substitute session. The ladder it walks (so you can read its stderr): the `transcript:` line first, else the first bare `.jsonl` path in the input → `test -f` → **moved-transcript fallback**. That fallback matters because Claude Code relocates a live session's transcript when the session enters a worktree (entering one changes the cwd, which changes the project slug dir), so an indicator emitted BEFORE entering points at a path that no longer exists; the `.jsonl` basename is the immutable session uuid, so the file is recovered by searching `~/.claude/projects` for it, taking the largest/newest match (the live one keeps accreting).

Also note the user's improvement intent — which skill or area (the `note:` field, or what they typed). If the target skill is ambiguous, ask once; otherwise proceed.

If the block carries a `state:` path, `test -f` it: a live `STATE.md` is the richest context (goal, decisions, plan, work-log). It's ephemeral — `/dobby:wrap` deletes it and the worktree at `cwd:` may be archived — so treat both as best-effort. When `STATE.md` is gone, its content is still embedded in the transcript; the digest recovers it there.

**Consult the discarded-frictions KB first.** Read `docs/learn-discarded/*.md` (if the directory exists — it's created lazily, so its absence just means nothing's been discarded yet). These are frictions a past `/dobby:learn` session deliberately decided NOT to turn into skill edits, with durable reasons. Match the user's improvement intent against them **by concept, not keyword**. If a rejected concept covers this session's friction, tell the maintainer — "this resembles `docs/learn-discarded/<concept>.md`, declined before because [reason] — still holds?" — and don't re-propose the rejected edit unless they say the context has changed. When a match surfaces, read `references/discarded-frictions-kb.md` for the reconsider/dedup flow.

## Step 2: Delegate the digest

Dispatch one `dobby:researcher` (Agent tool, `subagent_type: "dobby:researcher"`). Tell it:
- The transcript path, and to work it through the digest script — **never** Read the transcript (it can be megabytes). Give the script by ABSOLUTE path (this skill's base directory + `scripts/digest-transcript.py`), since the agent doesn't inherit this skill's directory:
  - `python3 …/scripts/digest-transcript.py <transcript>` — the turn index: one line per turn (`index<TAB>kind<TAB>preview`), the kind tally, and the `/dobby:*` skills the session launched, read off the skill-launch banner.
  - `--grep '<regex>'` — the turn indexes whose text matches (`-i` for case-insensitive). This is how a friction gets ANCHORED: the index is the citation.
  - `--show 12,40-44` — the full text of those turns, which is where the literal quote comes from.
  - The script already does the discrimination that trips hand-rolled passes — human vs `tool_result` (both arrive as `type=user`), the slash-command echoes Claude Code injects as `meta`, and the host bookkeeping it hides by default (`--all` to include). The researcher reads its output; it does not re-implement the parse.
- The `STATE.md` path if it's still on disk — read it directly for the plan/decisions/work-log; otherwise reconstruct that spine from the transcript's tool-result reads of `STATE.md` (`--grep 'STATE\.md'`).
- What to extract, scoped to the target skill/area: friction and rework, the user's literal corrections ("no, mejor así" / "siempre haz X"), where the recipe failed, and which `/dobby:*` skills ran (the digest header answers the last one).
- To return short **literal quotes** + why each matters — findings, not solutions.
- **Verify the claim, don't just report it.** For each friction it surfaces, the researcher must confirm it is actually *reproducible in this transcript* — cite the concrete turns (a message index or the paired tool_use/tool_result) where the friction happened, not a paraphrase or an impression. A friction it can't anchor to specific turns is a **`unverified`** finding and must be labelled so — it carries no weight in the proposal.

## Step 3: Synthesize the edit proposal

You own this call. Map findings → concrete changes, each backed by the user's own words:
- Which skill file(s) to touch (`skills/<name>/SKILL.md` or its `references/`).
- For each: what to add/change, and the quote that justifies it.
- Flag if the signal argues for a **new** skill rather than editing an existing one.

**Cross-reference with the skill's CURRENT text before proposing an edit.** A verified friction (Step 2) tells you the session *behaved* badly; it does not tell you the skill's wording *caused* it. Open the target `skills/<name>/SKILL.md` (or its `references/`) and confirm the current text actually produces the cited friction — the recipe is genuinely ambiguous / missing the step / says the wrong thing. Only skip anchored findings, never this check. If the skill already says the right thing and the session ignored it, the fix is not a wording edit (it may be a stronger context-pointer, an agent-prompt change, or nothing) — say so instead of piling redundant text onto a skill that was already correct.

**When a verified friction should NOT become an edit, discard it on the record.** Some frictions are real and reproduced but still don't warrant a skill change — a consumer-project preference rather than a kit-methodology change, a remedy that already lives in another `/dobby:<skill>`, or a cost that every future session pays to serve a one-off. Don't silently drop these: with the maintainer's agreement, record the discard in `docs/learn-discarded/` (one kebab-case concept file, durable reason, deduped by concept — full flow in `references/discarded-frictions-kb.md`) so the same friction isn't re-litigated next session, and note in the proposal that it was recorded, not forgotten. Only *verified* frictions that were *declined* go here — a friction that failed Step 2 or the cross-reference check has nothing to discard.

Present the proposal — proposed edits, and any discards with their reasons — and get approval before writing.

## Step 4: Apply via a worker

Hand the approved edits to a `dobby:implementor` (or `/dobby:dispatch`), pointing it at the exact files **by cwd-relative path** (`skills/<name>/SKILL.md`) — never anchor to this skill's plugin-install path. When dobby is dogfooded from a Conductor worktree, the cwd IS the dobby checkout on the work branch, and that's where edits must land so the change flows branch → PR → `main` (with `autoUpdate` carrying it back to the global plugin clone). Editing the global install directly skips the branch and the PR. Stay the architect — review what comes back; don't edit the skills yourself. New skills go through `/dobby:create-skill`. Keep the README/decision-table sync in mind (the `/dobby:commit` doc-sync contract enforces it).

Any discard the maintainer approved in Step 3 is a file too — hand the worker the `docs/learn-discarded/<concept>.md` write (new concept file, or an appended "Prior occurrences" line on an existing one) in the same dispatch, by the same cwd-relative path rule. The architect doesn't write it directly either.

When calling the implementor directly, validate its `{status, workLog, blocker}` envelope before claiming the learning landed (when routing through `/dobby:dispatch`, that skill owns the same gate):

- `{status: "completed", workLog: <non-empty>, blocker: ""}` → integrate the accounting, review the diff ONLY at the exact approved cwd-relative paths, and confirm each approved edit/discard is present before reporting success.
- `{status: "blocked", workLog: <non-empty>, blocker: <non-empty>}` → report BOTH the blocker and file accounting, return `needs-human`, and STOP without claiming the proposal was applied or offering a downstream handoff.
- Null, a bare work log, empty required fields, or an incoherent envelope → inspect only the approved paths with `git status --short -- <paths>`, `git diff -- <paths>`, and Read every expected target (including untracked new skill/KB files). Report the mechanical accounting and return `needs-human`; do not infer completion from partial text and do not repair it in the architect thread.

## Privacy
The researcher extracts **method and pattern** signal — how the agent should *work*, never what it was building. A kit skill must never carry a client's domain specifics.

## Language
User-facing output in the user's language; skill edits in English (the kit is all-English).

## Acceptance checklist

- [ ] Pointer resolved with `bash scripts/resolve-session.sh` — a dead pointer (exit 1) reported and the run stopped, never substituted with another session
- [ ] Discarded-frictions KB consulted by CONCEPT before proposing; a prior rejection surfaced to the maintainer instead of re-proposed
- [ ] Digest delegated to a `dobby:researcher` driving `scripts/digest-transcript.py` (index → `--grep` → `--show`); the transcript never Read, the parse never re-implemented
- [ ] Every friction anchored to concrete turn indexes; anything unanchored labelled `unverified` and carrying no weight
- [ ] Each proposed edit cross-referenced against the skill's CURRENT text — no redundant wording piled onto a skill that already said the right thing
- [ ] Declined-but-verified frictions recorded in `docs/learn-discarded/` with the maintainer's agreement, and named in the proposal
- [ ] Proposal approved before any write; edits applied by a worker at cwd-relative paths — the architect edited nothing
- [ ] Direct implementor envelope handled fail-closed: completed work reviewed only at approved paths; blocked stopped with blocker + work-log accounting; null/malformed triggered scoped status/diff/Read inspection and `needs-human`, never a false “learning applied”
- [ ] Findings carry method/pattern signal only, never the consumer project's domain specifics
