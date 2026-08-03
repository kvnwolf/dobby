---
name: wrap
description: Close out a work session — final human smoke test, doc/ADR reconciliation, optional skill packaging, then dispose the ephemeral STATE.md and hand off to /dobby:commit. Use when finishing a feature or session, or wrapping up before committing.
argument-hint: ""
---

Turn a finished work session into durable project memory, confirm it works and the user understands it, then clean up. Read `STATE.md` (goal, findings, spec, work log) to know what shipped.

## Step 1: Final human smoke test

From `STATE.md`'s spec (user flow, goals, edge cases) and anything the executors/verifiers flagged as needing human judgment, build a SHORT list of user-facing behaviors the machine layers couldn't fully prove — cross-task end-to-end flows, subjective UX. Present them one at a time with AskUserQuestion (Pass / Fail / Skip). On Fail, dispatch the `implementor` agent (Agent tool, `subagent_type: "dobby:implementor"`; no commits) to fix it, then re-present. Don't re-run the per-task verification the workflow already did.

**Push right — present a decision-ready brief, not raw output.** For each behavior, the user should be able to judge in seconds: give them a compact Brief — **what to test** (the exact flow/steps to exercise), **what to decide** (the pass/fail question in their terms), and **what's needed from you** (any credential, seed data, or environment they must supply). Do the reduction work yourself; never dump logs, diffs, or a wall of raw output and ask the user to interpret it. If a behavior needs setup they alone can do, that goes in "what's needed from you" so nothing stalls silently.

## Step 2: Reconcile project docs

Start from the inventory — it answers "what did this session actually touch?" before you decide anything:

```bash
bash scripts/wrap-inventory.sh
```

Keep the cwd in the work session's worktree — spell the script by its absolute path under this skill's base directory rather than `cd`-ing to it, since it resolves the git workroot from the cwd (`--root <dir>` when that isn't possible). It reports the changed files grouped by module, which changed modules carry no `CONTEXT.md`, the highest number currently in `docs/adr/`, and the `STATE.md` sections still `_pending_`. It is read-only: it decides nothing and writes nothing, and its ADR line is orientation only — the next number is still allocated by `bunx dobby adr new` below.

Then update only what the work changed:

- **Root `CONTEXT.md`** — add or sharpen the domain terms resolved during the session. Before writing, read `references/context-format.md` for the format and the admission rules (domain-unique terms only — general programming concepts don't belong). Create it lazily if absent.
  - **Purity: it is a glossary and NOTHING else.** Not a spec, not a scratch pad, not a home for decisions (those become ADRs). If a line describes HOW something works rather than what a term MEANS, it doesn't belong here.
- **Module `CONTEXT.md`** — for each module the work created or changed, create/update its own `CONTEXT.md` (purpose · Files · Interface · Invariants · What's NOT here) so it reflects the module's current interface, invariants, and contents. (Executors keep this current as they build; here you reconcile anything left.)
  - **Cross-reference invariants with the code — don't just transcribe.** When you record or carry forward an invariant, verify it against what the code actually does. If they contradict, surface it rather than writing the stale claim: "the `CONTEXT` says Orders cancel whole, but the code cancels line items — which is right?" A reconciled doc that quietly disagrees with the code is worse than no doc.
- **CLAUDE.md** — if a new top-level convention emerged, or a new module belongs in the **module map** (one line + a link to the module's `CONTEXT.md`).
- **docs/adr/** — for each decision flagged as an ADR candidate (in `STATE.md`'s `## Findings (interview)`) that meets the three criteria in `references/adr-format.md` (hard to reverse · surprising without context · real trade-off), offer to write the ADR. The user approves before you write. Create the approved file with **`bunx dobby adr new "<title>" --json`** — never pick the number yourself: the command allocates it (scanning the local `docs/adr/` **and** `origin/HEAD:docs/adr`, so a sibling worktree's already-pushed ADR can't hand you a duplicate, and re-checking the directory before each write so two sessions can't mint the same number), writes the skeleton, and answers `{number, slug, path}`. The body it writes is a placeholder ON PURPOSE — the record itself is yours to author at that path, in `references/adr-format.md`'s shape.
  - **Where the command and the reference disagree, the command wins.** `references/adr-format.md` governs the **body**: the three admission criteria, what qualifies, the one-paragraph template, the optional sections. It does NOT govern numbering or the H1 — its "Numbering" section (scan `docs/adr/` for the highest number) no longer applies, and the file `adr new` created already carries the numbered H1 (`# NNNN. <title>`). Keep that H1 exactly as written rather than the reference's bare `# {Short title}`, and author only what goes under it.

## Step 3: Evaluate a reusable skill

If the work surfaced a replicable project pattern, convention, or gotcha a future task would repeat, evaluate distilling it into a skill (project scope) via `/dobby:create-skill`. Offer it; the user approves before you create. Skip if it already fits an existing skill, CLAUDE.md, or CONTEXT.md.

**Consult the durable knowledge bases before offering**, so nothing already rejected gets re-litigated: `bunx dobby kb list --kind learn-discarded` (frictions `/dobby:learn` judged not worth a skill edit) and `bunx dobby kb list --kind out-of-scope` (concepts `/dobby:triage` rejected). Each answers one record per concept with its prior entries; a knowledge base nothing has been recorded into yet is simply an empty list. **The consult is read-only** — both knowledge bases belong to the skills that own them (`/dobby:learn` and `/dobby:triage` write them); wrap reads and never records. A candidate the user rejects here is simply not packaged; if it keeps coming back, the friction belongs to `/dobby:learn`.

## Step 4: Dispose and hand off

The durable bits now live in CONTEXT.md / CLAUDE.md / docs/adr/. Dispose of the ephemeral `STATE.md`:

```bash
bash scripts/wrap-dispose.sh
```

Same invocation rule as the inventory: cwd in the worktree, script by absolute path (or `--root <dir>`). It refuses (exit 1) while `STATE.md` still carries a `_pending_` section (a body that IS the marker) or a `needs-human` marker, printing each one with its line — finish or resolve what it names and re-run, rather than deleting the session's memory on top of unfinished work. `--force` disposes anyway; that is a deliberate waiver, not the default. It also asserts HEAD didn't move while it ran (nothing should be committing mid-wrap), and is idempotent — a second run just reports there is nothing to dispose.

Present a final summary (what shipped, decisions, docs updated, deferred items). Do NOT commit — hand off to `/dobby:commit` when the user is ready.

## Next step

The session is wrapped. Present the next stage as an **AskUserQuestion** — one question that restates wrap just finished — with the options below (recommended first, then Stop here). On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn (commit later).

- **`/dobby:commit`** *(Recommended)* — sync docs, commit, push, open the PR.
- **Stop here** — commit later.

## Language

Interact with the user in their language. Write docs / ADRs / CONTEXT in English; keep domain glossary terms in their real-world form and user-facing UI strings in the product's language.

## Acceptance checklist

- [ ] Final human smoke test run as decision-ready Briefs (what to test · what to decide · what's needed from the user), never raw output
- [ ] Doc reconcile opened on `bash scripts/wrap-inventory.sh` — changed modules, missing `CONTEXT.md`s and `_pending_` sections read off the report, not guessed
- [ ] CONTEXT.md / CLAUDE.md updated where the work changed them — glossary kept pure (domain-only, no implementation detail), invariants cross-referenced against the code
- [ ] ADR candidates offered + written (with approval) for decisions meeting the 3 criteria; each file created via `bunx dobby adr new` (numbering never hand-picked, its `# NNNN. <title>` H1 kept as written) and only the BODY authored per `references/adr-format.md`
- [ ] Reusable-skill packaging evaluated and offered if warranted, after a **read-only** consult of both knowledge bases (`bunx dobby kb list --kind learn-discarded|out-of-scope`) so nothing already rejected is re-proposed — wrap records nothing into them
- [ ] `STATE.md` disposed via `bash scripts/wrap-dispose.sh` — a refusal resolved (or waived with `--force` on purpose), never worked around by deleting the file by hand; final summary presented; no commits (handed to `/dobby:commit`)
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, Stop here); chosen route invoked via the Skill tool
