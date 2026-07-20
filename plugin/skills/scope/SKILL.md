---
name: scope
description: Start a work session — normalize the goal (free-text prompt or GitHub issue) and ground it in the codebase before interviewing or planning. Use at the start of any feature, fix, or refactor, or when handed a ticket to work on.
argument-hint: "[goal, or GitHub issue #/URL]"
---

The front door of a work session. Normalize the goal, put the session in its own worktree, create the shared work-session doc, and map the relevant code — so every later stage (interview → research → spec → execute → wrap) runs isolated on a goal-named branch with grounding and one place to persist its output.

## Step 1: Normalize the input into a goal

The argument (or conversation) is one of:

- **Free-text prompt** — use it as the goal directly.
- **GitHub issue** (`#123` or a URL) — fetch it via `gh` and use it as the goal. You're starting work on it, so **claim it** — ensure the label exists BEFORE the edit, so on a fresh repo the edit doesn't fail on an unknown label and drop the in-progress signal:

  ```bash
  gh label create status:in-progress 2>/dev/null || true
  gh issue edit <n> --add-assignee @me --add-label status:in-progress
  ```

  This signals "someone's on it" so a parallel session doesn't double-take it, and lets `/dobby:commit` add `Closes #<n>` so the merge closes it.

If the input is empty, ask in plain text (not AskUserQuestion) what the user wants to work on.

## Step 2: Set up the work-session worktree

Before anything else touches the codebase, put the session in its own worktree so the whole goal — every stage after this — runs isolated on a goal-named branch. This step runs entirely before STATE.md is created (STATE.md lands at the worktree root, which becomes the session's repo root once you enter it).

### 2a. One session per goal — guard against nesting, not parallelism

The invariant is **one session per goal**: each `claude` session/pane owns ONE goal and its worktree. It is **not** "one worktree on the machine." **Parallel worktrees for independent goals are fine and expected** — git supports multiple worktrees, and cmux runs one goal per pane, so `.claude/worktrees/` legitimately holds worktrees from OTHER sessions/panes. Do **not** refuse just because other worktrees exist there.

The only thing to block here is **nesting** — the native `EnterWorktree` tool cannot create a worktree while THIS session is already inside one:

- If THIS session is **already inside** a `.claude/worktrees/<slug>/` path (you ran `/dobby:scope` earlier in this same session, so it already owns a goal's worktree), **soft-STOP the stage** with a plain-text note (not AskUserQuestion): this session already owns a goal's worktree and the native tool can't nest — open a **new cmux pane / `claude` session** and run `/dobby:scope <new goal>` there (one goal per pane, no nesting). Do **not** auto-exit, auto-remove, or stack a second worktree.

(The other blocker, slug/branch collision, is checked in 2b once the slug is derived.)

### 2b. Create and enter the worktree

Derive a short **slug** from the normalized goal yourself — a few kebab-case words capturing the goal (e.g. `add-csv-export`). No prompt, no confirmation; just pick a sensible slug.

**Avoid slug collision** — don't clobber another goal's worktree. If branch `worktree-<slug>` already exists (`git show-ref --verify --quiet refs/heads/worktree-<slug>`) or the `.claude/worktrees/<slug>/` dir already exists, pick a different slug (e.g. add a distinguishing word) so this goal gets its own worktree instead of colliding with an existing one.

Then **use the `EnterWorktree` tool** with that (collision-free) slug as its `name` (this native tool must be invoked explicitly — call it, don't shell out to `git worktree add`):

- `EnterWorktree({ name: "<slug>" })` creates and enters `.claude/worktrees/<slug>/` on branch `worktree-<slug>`, based on the default `fresh` ref (`origin/HEAD`). The session's working directory is now the worktree root.

### 2c. Bring the workspace up (blocking)

If `dobby.config.json` exists at the repo root, run **`bunx dobby up`** from the worktree root. This is the single mechanical step that makes the worktree usable — `dobby up` owns it end-to-end: a **setup phase** (installs dependencies via `bun install`, re-materializes the gitignored env/config files a fresh worktree needs — the `.worktreeinclude` set, idempotently, belt-and-suspenders over the native `EnterWorktree` copy — then runs any `setup[]` extras from the config), followed by a **run phase** that starts the app (liveness-first). The worktree comes up **running** — or, for a no-app project (a library / CLI / plugin like dobby itself), `up` finishes the setup phase and reports **'no app to run'**, exiting cleanly. Run it directly (Bash); it blocks until the workspace is up, in parallel with the exploration researcher you dispatch in Step 4. (`up` is idempotent, so `/dobby:execute` Step 2 re-runs it later without double-starting.)

**Bring-up failure blocks the stage** — "worktree usable or nothing." If `bunx dobby up` fails (a non-zero exit — including because `dobby` isn't installed in the repo, meaning it was never onboarded/migrated):

1. Report the failing command and its error. If the failure is a missing local `dobby` bin, point to `/dobby:onboard` (or `/dobby:migrate-config` for a repo moving off an old contract) — the kit assumes `dobby` is installed as the repo's devDependency; there is no fallback.
2. Remove the just-created worktree via the **`ExitWorktree` tool** in `remove` mode (this same session created it and the tree is clean, so removal tears down the dir + branch and restores the original working directory; the tool guards destructive removal via its `discard_changes` flag — set it since there's nothing to keep).
3. **STOP the stage.** The user fixes the underlying problem and re-runs `/dobby:scope` fresh (a clean removal here means no leftover to trip the Step 2a guard).

### 2d. No-config path

If there is **no `dobby.config.json`** (repo never onboarded), skip the bring-up — there's nothing for `dobby` to run — with a plain note that it was skipped and `/dobby:onboard` establishes the contract (and installs `dobby`) for next time. **Continue the stage** (do not stop; the worktree is still valid).

## Step 3: Create the work-session doc

Create an ephemeral `STATE.md` at the repo root with this skeleton — the shared spine every later stage appends to. The "repo root" is the worktree root you entered in Step 2. Add it to `.gitignore` if it isn't already: it's working memory, not a committed artifact (`/dobby:wrap` disposes of it at the end).

```md
# Work session: <goal title>

## Goal
<the goal>

## Source
<prompt | GitHub #123>

## Exploration
_pending_

## Findings (interview)
_pending_

## Research
_pending_

## Spec
_pending_

## Work log
_pending_
```

Fill `## Goal` and `## Source` now.

## Step 4: Explore the codebase

Dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to ground the work — you don't grep in the main thread. Have it map what the goal touches (existing modules, conventions, how similar things are structured, where this fits), read the root `CONTEXT.md` (domain glossary) + the `CONTEXT.md` of any module the goal touches (each has its own — they're not auto-loaded), and skim `docs/adr/` if present, reporting any constraints. Respect the project's structure (deep, feature/domain modules per `/dobby:spec`'s `references/architecture-vocab.md`; don't assume type-based folders). On a greenfield repo there may be little to find — that's fine. The researcher returns a grounded findings report.

**Cross-reference the goal against the code — don't just map files.** Instruct the researcher to validate the goal's claims against what the code actually does and to report every contradiction as a finding (e.g. "you said cancellation is per-line, but the code cancels whole Orders — which is right?") so the checkpoint can resolve it before it propagates into the interview and spec. The goal is often written from an outdated mental model; the code is the ground truth. A wrong premise caught here is cheap; caught at execute it is expensive.

**Context-budget the digest.** The exploration output shares one architect window with the interview and spec. If the goal touches a large surface, tell the researcher to return a COMPRESSED digest (the load-bearing modules, conventions, constraints, and contradictions — named, not dumped) rather than an exhaustive file-by-file transcript. If a full map is genuinely needed, have the researcher write it to a path and return a pointer plus the digest.

## Step 5: Checkpoint and record

Present a concise summary to the user (relevant code areas, patterns, how the goal fits) so they can correct misunderstandings early. Write that summary into the doc's `## Exploration` section.

## Next step

Scope is done (the exploration is written to `STATE.md`). Present the next stage as an **AskUserQuestion** — one question that restates scope just finished — whose options are the routes below. On the user's selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn (point to where this stage's output lives, e.g. `STATE.md`).

**Route by goal shape — don't always recommend `/dobby:interview`.** Read the goal (and what the exploration surfaced) and recommend the branch that fits the WORK, not a fixed default:

- **Bug / something is broken** (a reproducible failure, a red test, a regression) → recommend **`/dobby:diagnose`**. Grilling requirements is the wrong tool for a defect; the loop needs a red-capable command, not an interview.
- **Refactor / structural change** (reshape without changing behavior — extract a module, fix a leaky seam, reduce sprawl) → recommend **`/dobby:improve-architecture`**. The design questions are about structure, not product requirements.
- **Feature / new or changed behavior** (the shape of what to build is still open) → recommend **`/dobby:interview`** to align on details before planning.
- **Already well-understood** (any shape) → the task may be ready to plan directly — offer `/dobby:spec` as the fast path.

In the AskUserQuestion, make the branch that fits the goal shape you detected the FIRST option and mark it *(Recommended)* — keyed to the shape, with why in the option — and list the others as alternatives, plus `/dobby:research` (if the goal leans on external tech you'd want current docs for first) and a final **Stop here** option. When the goal is mixed or the shape is genuinely ambiguous, say so and default the recommendation to `/dobby:interview` to disambiguate.

## Language

Interact with the user in their language. Write what you persist — `STATE.md` and any docs — in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Goal normalized (prompt / GitHub); asked if empty
- [ ] If the goal is a GitHub issue: claimed it (`--add-assignee @me --add-label status:in-progress`, label created lazily)
- [ ] One-session-per-goal enforced as anti-NESTING only — soft-stopped ("open a new pane") if THIS session is already inside a worktree; parallel worktrees from other sessions allowed (not refused); slug collision avoided
- [ ] Worktree created + entered via the `EnterWorktree` tool (auto-slug from the goal, made collision-free → branch `worktree-<slug>`, `.claude/worktrees/<slug>/`)
- [ ] `bunx dobby up` run (blocking) when `dobby.config.json` exists — the worktree comes up running (or 'no app to run' for a lib/plugin repo); on failure, reported (missing bin → `/dobby:onboard` / `/dobby:migrate-config`) → `ExitWorktree(remove)` → stopped; no `dobby.config.json` → skipped with an `/dobby:onboard` note and continued
- [ ] `STATE.md` created at the repo root (the worktree root) and gitignored, with the skeleton; `## Goal` + `## Source` filled
- [ ] Codebase explored with a `researcher` agent; `CONTEXT.md` + ADRs read if present
- [ ] Researcher cross-referenced the goal's claims against the code and surfaced contradictions (not just a file map)
- [ ] Exploration returned as a compressed, context-budgeted digest (depth on what matters; pointer for a full map if needed)
- [ ] Exploration summary shown to the user and written into `## Exploration`
- [ ] Next step routed by goal shape (bug→`/dobby:diagnose`, refactor→`/dobby:improve-architecture`, feature/ambiguous→`/dobby:interview`), not a fixed default
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
