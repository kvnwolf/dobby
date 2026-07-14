---
name: migrate-config
description: Migrate a consumer repo's legacy .claude/commit.config.yml to the kit-owned dobby.config.json and clean the mechanizable kit-workflow prose out of CLAUDE.md. Use in a consumer repo after updating the dobby plugin, once per repo.
---

The one-shot migration from the kit's OLD per-project config home to the new one. The kit used to keep its commit contract at `.claude/commit.config.yml` (a kit file squatting in Claude Code's reserved `.claude/` namespace) and scatter dev/run/setup prose across the consumer's `CLAUDE.md`. Both now live in a single kit-owned **`dobby.config.json`** at the repo root. Run this **manually, once per consumer repo**, after updating the dobby plugin.

**This skill IS the migration path — a clean cut.** The work skills (`/dobby:commit`, `/dobby:resolve-conflicts`, `/dobby:scope`, `/dobby:execute`, `/dobby:finish`) read ONLY `dobby.config.json`; none of them detect the legacy `.claude/commit.config.yml` any more. A repo that hasn't been migrated silently loses its commit gate (the readers hit their no-config fallback). So run this before relying on the kit in an existing repo — that risk is the whole reason the skill exists.

The authoritative schema lives in the plugin at `../onboard/references/dobby-config.md` — the FULL five-section contract (`files` / `checks` / `setup` / `run` / `teardown`). **This migration only carries over `files` + `checks`** from the legacy YAML; it does NOT invent `setup` / `run` / `teardown` (those describe how an app installs, runs, and tears down — discovering them is `/dobby:onboard`'s job). For an app project, suggest running `/dobby:onboard` afterwards to fill them in.

## Step 1: Precondition — locate the legacy config

Look for `.claude/commit.config.yml` at the repo root, and check whether `dobby.config.json` already exists. Branch on what you find:

- **Legacy file present** → this is a real migration. Continue to Step 2.
- **No legacy file, but `dobby.config.json` already exists** → the repo is **already migrated**. Say so plainly ("`dobby.config.json` is already in place and there's no legacy `.claude/commit.config.yml` to migrate — nothing to do.") and **stop**. Do not touch anything.
- **Neither file exists** → the repo was never set up for the kit's commit contract. Migration has nothing to convert. Suggest the user TYPE `/dobby:onboard` (it creates `dobby.config.json` from scratch as part of project setup) and **stop**.

## Step 2: Convert YAML → JSON (no-clobber)

**No-clobber on an existing `dobby.config.json`.** If `dobby.config.json` already exists AND a legacy `.claude/commit.config.yml` also exists (a partial/interrupted migration, or a hand-written config), do NOT overwrite it. Stop and report both files, show the user what each contains, and let them reconcile — never blow away a config the user may have already authored. (Only proceed to write when there is no `dobby.config.json` yet.)

Otherwise, read `.claude/commit.config.yml` and translate it to JSON, preserving `files` and `checks` **verbatim**:

- `files` — array of `{ path, update_when[] }`. Carry every path and every `update_when` string across unchanged.
- `checks` — array of `{ name, run }` (and `scope` if present). Carry every check's `name` and `run` command across **exactly** — the shell in `run` is load-bearing; a whitespace or quoting change can flip a check's verdict. When YAML block scalars, embedded tabs, or escapes are involved, make sure the JSON string produces the byte-identical command the YAML did.

Write the result as `dobby.config.json` at the **repo root** (next.config.js style — NOT in `.claude/`, NOT in `.dobby/`). Include only `files` + `checks` — see the authoritative schema at `../onboard/references/dobby-config.md`; this migration does not fabricate `setup` / `run` / `teardown`.

## Step 3: Delete the legacy file

Remove `.claude/commit.config.yml` — the readers no longer look there, so leaving it is dead weight and a trap (someone edits the stale file expecting it to take effect). Delete only that file; leave everything else in `.claude/` (host-owned: settings, commands, agents, hooks) untouched.

## Step 4: Clean the kit-workflow prose out of CLAUDE.md

The consumer's `CLAUDE.md` typically carries a "Workflow config" section (or scattered lines) that `/dobby:onboard` wrote in the old era: a commit-contract pointer, dev/run commands, setup instructions, textual pre-commit checks or doc-sync rules, and dead kit config. This prose is now either mechanizable (it maps to a `dobby.config.json` field) or dead (nothing reads it). **User-authored prose that is genuinely project knowledge stays — CLAUDE.md is the user's file.**

Scan `CLAUDE.md` for kit-workflow prose and **classify each hit**:

- **MECHANIZE** — content that maps to a config field: dev/run commands, setup instructions, textual pre-commit checks, doc-sync rules, or the old commit-contract pointer (e.g. "read by `/dobby:commit`" / a `.claude/commit.config.yml` reference). → Propose moving it into the matching `dobby.config.json` field (`run` / `setup` / `checks` / `files`). If it's a `run`/`setup` field this migration doesn't own (Step 2 only carried `files`+`checks`), note it belongs in the config and defer the actual discovery to `/dobby:onboard` rather than fabricating a value.
- **DELETE** — dead kit config that nothing reads any more. The canonical example is an **"Issue tracker" line** (e.g. naming Linear or a project board): the kit standardized on **GitHub Issues** repo-wide, so `/dobby:backlog` and `/dobby:triage` always use the `gh`-authenticated repo and nothing reads a configured tracker. → Propose removing it outright.
- **KEEP** — anything that is genuine project knowledge (product description, module map, stack conventions, architecture notes). Leave it exactly as the user wrote it. When in doubt, KEEP — deleting the user's prose is the costly mistake.

**Every proposed CLAUDE.md edit is shown as a diff for explicit user approval before applying.** This is an in-stage gate (not a stage handoff), so `AskUserQuestion` per group of related edits — or free-text approval — is fine. Present the exact before/after so the user sees what leaves and what stays; never rewrite CLAUDE.md silently. Apply only the edits the user approves.

After the approved removals, leave a **single pointer line** in `CLAUDE.md` so the file still tells the reader where the workflow contract lives — e.g. in a short "Workflow config" section:

```markdown
## Workflow config

The kit's per-project contract (doc-sync rules, pre-commit checks, and — for app projects — setup/run/teardown) lives in [`dobby.config.json`](./dobby.config.json), read by the `/dobby:*` work skills.
```

## Step 5: Verify the gate survived the move

Prove the migration didn't break the commit gate:

- `jq . dobby.config.json` parses (valid JSON).
- Run each `checks[].run` command from `dobby.config.json`, in order, from the repo root — they must exit 0, exactly as they did from the legacy YAML. This confirms the checks came across byte-identical and the gate still holds. (If a check now fails but passed before, the conversion mangled its `run` command — fix the JSON string, don't weaken the check.)

## Step 6: Report the summary

Report what happened, in three plain buckets:

- **Moved** — `files` + `checks` migrated into `dobby.config.json` (counts); which CLAUDE.md prose was mechanized into which config field.
- **Deleted** — `.claude/commit.config.yml` removed; which dead CLAUDE.md lines (e.g. the issue-tracker line) were dropped.
- **Left** — the CLAUDE.md project knowledge kept untouched; the single pointer line added.

Note whether this is an **app project that still needs `setup` / `run` / `teardown`** — if so, tell the user those weren't fabricated and suggest `/dobby:onboard` to discover them.

## Next step

The migration is done. End by presenting an **AskUserQuestion** (one question) that restates the config cutover is complete and offers:

- `/dobby:commit` *(Recommended)* — commit the cutover (the new `dobby.config.json`, the deleted legacy file, and the CLAUDE.md edits); its own checks run green against the migrated config, proving the move end-to-end.
- `/dobby:onboard` — first, if the summary flagged missing `setup`/`run`/`teardown`.
- **Stop here** — end the turn.

On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool (chaining runs on the session's current model/effort). "Stop here" ends the turn.

## Language

Interact with the user in their language. Write the migrated `dobby.config.json` and any CLAUDE.md edits in English; keep domain terms in their real-world form and preserve the user's own prose verbatim when it's kept.

## Acceptance checklist

- [ ] Precondition checked first: legacy `.claude/commit.config.yml` located; if absent-but-`dobby.config.json`-present → reported already-migrated and stopped; if neither → suggested `/dobby:onboard` and stopped
- [ ] No-clobber respected: an existing `dobby.config.json` was NEVER overwritten — on a collision, stopped and reported instead
- [ ] `files` + `checks` converted YAML → JSON verbatim (paths, `update_when` strings, and every `run` command byte-identical); `setup`/`run`/`teardown` NOT fabricated; schema per `../onboard/references/dobby-config.md`
- [ ] `dobby.config.json` written at the repo ROOT (not `.claude/`, not `.dobby/`)
- [ ] Legacy `.claude/commit.config.yml` deleted; the rest of `.claude/` left untouched
- [ ] CLAUDE.md scanned; each hit classified MECHANIZE / DELETE / KEEP; genuine project knowledge kept; the dead issue-tracker line (GitHub-Issues standardization) removed
- [ ] Every CLAUDE.md edit shown as a diff and applied only on explicit user approval (in-stage gate); a single pointer line to `dobby.config.json` remains
- [ ] Verified: `jq .` parses `dobby.config.json`; every `checks[].run` command runs green from it, proving the gate survived
- [ ] Summary reported (moved / deleted / left); app projects still needing `setup`/`run`/`teardown` were told to run `/dobby:onboard`
- [ ] Ended with an AskUserQuestion gate (`/dobby:commit` recommended, `/dobby:onboard` first if `setup`/`run`/`teardown` missing, or stop here); the chosen `/dobby:<skill>` invoked through the Skill tool
