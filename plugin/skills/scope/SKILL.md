---
name: scope
description: Start a work session — normalize the goal (free-text prompt, or the configured tracker's issue — a GitHub `#123`/URL or a Linear `VON-123`/URL) and ground it in the codebase before interviewing or planning. Use at the start of any feature, fix, or refactor, or when handed a ticket to work on.
argument-hint: "[goal, or tracker issue — GitHub #/URL or Linear VON-123]"
---

The front door of a work session. Normalize the goal, put the session in its own worktree (on the terminal host — Conductor already provides one), create the shared work-session doc, and map the relevant code — so every later stage (interview → research → spec → execute → wrap) runs isolated on a goal-named branch with grounding and one place to persist its output.

## Step 1: Normalize the input into a goal

**Which issue pattern counts as a goal source depends on the configured tracker.** Read the optional `tracker` key from `dobby.config.json` at the repo root — with the Read tool, narratively (never `jq`/`cat`); **absent → github**. Free-text is always a goal source; on top of it, scope recognizes ONLY the configured tracker's issue pattern — a github project parses `#123`/URLs (never `VON-123`), a linear project parses `VON-123`/linear.app URLs (never `#123`) — so there's no cross-pattern ambiguity. The fetch-and-claim mechanics for each tracker live in `../backlog/references/trackers.md`; scope carries the intent and delegates the recipe.

The argument (or conversation) is one of:

- **Free-text prompt** — use it as the goal directly.
- **GitHub issue** (`#123` or a URL) — fetch it via `gh` and use it as the goal. You're starting work on it, so **claim it** — ensure the label exists BEFORE the edit, so on a fresh repo the edit doesn't fail on an unknown label and drop the in-progress signal:

  ```bash
  gh label create status:in-progress 2>/dev/null || true
  gh issue edit <n> --add-assignee @me --add-label status:in-progress
  ```

  This signals "someone's on it" so a parallel session doesn't double-take it, and lets `/dobby:commit` add `Closes #<n>` so the merge closes it.

- **Linear issue** (`VON-123` or a linear.app issue URL) — *only when `tracker.type == linear`.* Fetch it and, since you're starting work on it, **claim it** — assignee = me, state = **In Progress** — by following the **view goal** then **claim** recipes for the linear backend in `../backlog/references/trackers.md` (that reference owns the mechanics; the executing agent resolves the actual MCP tool via ToolSearch — never hardcode a tool name). **This claim is the kit's one and only Linear-MCP write point.** The later In Review (on PR open) and Done (on merge) transitions are driven by Linear's native GitHub integration off the PR body's `Fixes VON-123` — the kit never pushes them via the MCP. Graceful degradation (D8): if the goal IS a Linear issue you cannot read (the Linear MCP is unavailable), **STOP the stage** and report — this is the read-a-specific-issue hard-stop, with no free-text equivalent to fall back to. (A free-text goal always continues.)

If the input is empty, ask in plain text (not AskUserQuestion) what the user wants to work on.

## Step 2: Set up the work-session worktree (host-gated)

Before anything else touches the codebase, put the session in its own worktree so the whole goal — every stage after this — runs isolated on a goal-named branch. This step is **host-dependent** and runs entirely before STATE.md is created (STATE.md lands at the worktree root, which becomes the session's repo root once you enter it).

### 2a. Detect the execution host

Check the environment for `CONDUCTOR_WORKSPACE_PATH`:

```bash
[ -n "$CONDUCTOR_WORKSPACE_PATH" ] && echo conductor || echo terminal
```

- **`CONDUCTOR_WORKSPACE_PATH` present → Conductor host.** The Conductor workspace *is* the worktree and Conductor already ran setup. **SKIP this entire step** — do nothing here and go straight to Step 3. All of 2b–2f are terminal-host only.
- **Absent → terminal host.** You (the kit) own the worktree lifecycle for this goal. Continue with 2b.

### 2b. One session per goal — guard against nesting, not parallelism

The invariant is **one session per goal**: each `claude` session/pane owns ONE goal and its worktree. It is **not** "one worktree on the machine." **Parallel worktrees for independent goals are fine and expected** — git supports multiple worktrees, and cmux runs one goal per pane, so `.claude/worktrees/` legitimately holds worktrees from OTHER sessions/panes. Do **not** refuse just because other worktrees exist there.

The only thing to block here is **nesting** — the native `EnterWorktree` tool cannot create a worktree while THIS session is already inside one:

- If THIS session is **already inside** a `.claude/worktrees/<slug>/` path (you ran `/dobby:scope` earlier in this same session, so it already owns a goal's worktree), **soft-STOP the stage** with a plain-text note (not AskUserQuestion): this session already owns a goal's worktree and the native tool can't nest — open a **new cmux pane / `claude` session** and run `/dobby:scope <new goal>` there (one goal per pane, no nesting). Do **not** auto-exit, auto-remove, or stack a second worktree.

(The other blocker, slug/branch collision, is checked in 2c once the slug is derived.)

### 2c. Create and enter the worktree

Derive a short **slug** from the normalized goal yourself — a few kebab-case words capturing the goal (e.g. `add-csv-export`). No prompt, no confirmation; just pick a sensible slug.

**Avoid slug collision** — don't clobber another goal's worktree. If branch `worktree-<slug>` already exists (`git show-ref --verify --quiet refs/heads/worktree-<slug>`) or the `.claude/worktrees/<slug>/` dir already exists, pick a different slug (e.g. add a distinguishing word) so this goal gets its own worktree instead of colliding with an existing one.

Then **use the `EnterWorktree` tool** with that (collision-free) slug as its `name` (this native tool must be invoked explicitly — call it, don't shell out to `git worktree add`):

- `EnterWorktree({ name: "<slug>" })` creates and enters `.claude/worktrees/<slug>/` on branch `worktree-<slug>`, based on the default `fresh` ref (`origin/HEAD`). The session's working directory is now the worktree root.

### 2d. Re-materialize env files (belt-and-suspenders)

If a `.worktreeinclude` exists in the repo, the native `.worktreeinclude` copy on the `EnterWorktree` path is ambiguous in the docs — it may or may not have run. Make it idempotently correct: for each gitignored file the `.worktreeinclude` patterns match (e.g. `.env`), verify it exists in the fresh worktree and, if missing, copy it from the main checkout. This is a no-op when the native copy already ran, and fills the gap when it didn't. Skip silently if there is no `.worktreeinclude`.

### 2e. Run setup (blocking)

If `dobby.config.json` exists at the (main-checkout) repo root and carries a `setup` array, run each `setup` command in order from the worktree root — this materializes what the fresh worktree needs (dependencies, etc.), in parallel with the exploration researcher you dispatch in Step 4. These are coordination one-liners; run them directly (Bash).

**Setup failure blocks the stage** — "worktree usable or nothing." If any `setup` command fails:

1. Report the failing command and its error.
2. Remove the just-created worktree via the **`ExitWorktree` tool** in `remove` mode (this same session created it and the tree is clean, so removal tears down the dir + branch and restores the original working directory; the tool guards destructive removal via its `discard_changes` flag — set it since there's nothing to keep).
3. **STOP the stage.** The user fixes the underlying problem and re-runs `/dobby:scope` fresh (a clean removal here means no leftover to trip the Step 2b guard).

### 2f. No-config path

If there is **no `dobby.config.json`** (repo never onboarded), skip setup — there's nothing to run — with a plain note that setup was skipped and `/dobby:onboard` establishes the contract (setup/run/teardown) for next time. **Continue the stage** (do not stop; the worktree is still valid). Same when `dobby.config.json` exists but has no `setup` key (a no-app project like a library or plugin): nothing to run, continue.

## Step 3: Create the work-session doc

Create an ephemeral `STATE.md` at the repo root with this skeleton — the shared spine every later stage appends to. On the terminal host the "repo root" is the worktree root you entered in Step 2; under Conductor it's the workspace root. Add it to `.gitignore` if it isn't already: it's working memory, not a committed artifact (`/dobby:wrap` disposes of it at the end).

```md
# Work session: <goal title>

## Goal
<the goal>

## Source
<prompt | GitHub #123 | Linear VON-123>

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

- [ ] `tracker` read from `dobby.config.json` (Read tool, narratively; absent → github); scope recognized ONLY that tracker's issue pattern alongside free-text (github `#123`/URL, or linear `VON-123`/linear.app URL) — no cross-pattern ambiguity
- [ ] Goal normalized (free-text, or the configured tracker's issue); asked if empty
- [ ] If the goal is a tracker issue: claimed it via the **claim** recipe in `../backlog/references/trackers.md` — github (`--add-assignee @me --add-label status:in-progress`, label created lazily), or linear (assignee = me, state = In Progress) as the kit's only Linear-MCP write point (In Review / Done are Linear-native, never pushed by the kit)
- [ ] If the goal is a Linear issue that cannot be read (MCP unavailable): stage hard-stopped (D8); a free-text goal always continues
- [ ] Execution host detected via `CONDUCTOR_WORKSPACE_PATH` (Conductor → Step 2 skipped entirely; terminal → worktree lifecycle run)
- [ ] Terminal host: one-session-per-goal enforced as anti-NESTING only — soft-stopped ("open a new pane") if THIS session is already inside a worktree; parallel worktrees from other sessions allowed (not refused); slug collision avoided
- [ ] Terminal host: worktree created + entered via the `EnterWorktree` tool (auto-slug from the goal, made collision-free → branch `worktree-<slug>`, `.claude/worktrees/<slug>/`)
- [ ] Terminal host: `.worktreeinclude`-matched gitignored files verified/copied into the fresh worktree (belt-and-suspenders)
- [ ] Terminal host: `dobby.config.json` `setup` run (blocking) — on failure, reported → `ExitWorktree(remove)` → stopped; no `dobby.config.json`/no `setup` → skipped with an `/dobby:onboard` note and continued
- [ ] `STATE.md` created at the repo root — the worktree root on the terminal host — (and gitignored) with the skeleton; `## Goal` + `## Source` filled
- [ ] Codebase explored with a `researcher` agent; `CONTEXT.md` + ADRs read if present
- [ ] Researcher cross-referenced the goal's claims against the code and surfaced contradictions (not just a file map)
- [ ] Exploration returned as a compressed, context-budgeted digest (depth on what matters; pointer for a full map if needed)
- [ ] Exploration summary shown to the user and written into `## Exploration`
- [ ] Next step routed by goal shape (bug→`/dobby:diagnose`, refactor→`/dobby:improve-architecture`, feature/ambiguous→`/dobby:interview`), not a fixed default
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
