---
name: scope
description: Start a work session — normalize the goal (free-text prompt, or the configured tracker's issue — a GitHub `#123`/URL or a Linear `VON-123`/URL) and ground it in the codebase before interviewing or planning. Use at the start of any feature, fix, or refactor, or when handed a ticket to work on.
argument-hint: "[goal, or tracker issue — GitHub #/URL or Linear VON-123]"
---

The front door of a work session. Normalize the goal, put the session in its own worktree, create the shared work-session doc, and map the relevant code — so every later stage (interview → research → spec → execute → wrap) runs isolated on a goal-named branch with grounding and one place to persist its output.

**The mechanics belong to the CLI; the judgment and every gate belong here.** `bunx dobby goal parse` resolves the goal, `bunx dobby scope preflight` says what the worktree would take, `bunx dobby up` brings it up, `bunx dobby state` owns `STATE.md`. Read each `--json` payload and BRANCH on it — never re-derive a fact one of them already reports.

Each of them runs the repo's **LOCAL** `dobby`. If it isn't installed — `bunx dobby …` can't run, or the preflight reports `dobbyInstalled: false` — every mechanic below is unavailable (`STATE.md` included), so **STOP the stage before creating anything** and point at `/dobby:onboard` (or `/dobby:migrate-config` for a repo moving off an old contract). There is no fallback.

## Step 1: Normalize the input into a goal

If the input is empty, ask in plain text (not AskUserQuestion) what the user wants to work on. Otherwise hand the argument to the CLI verbatim:

```bash
bunx dobby goal parse "<the argument>" --json
```

The payload settles everything this step used to reason about:

- **`source`** — `prompt`, `github` or `linear`. The pattern set is **gated by the configured tracker** (`dobby.config.json#tracker`, absent → github), so there is no config to read yourself and no cross-pattern ambiguity: a github project parses `#123`/github.com issue URLs and never `VON-123`; a linear project parses `VON-123`/linear.app URLs and never `#123`; free text is always a goal.
- **`id` / `url`** — the bare id (`42`, `VON-123`) and the URL when the goal was one.
- **`slug`** — the starting kebab-case slug for the worktree (Step 2), with `slugCollision` as an early warning.
- **`lifecycleLink`** — `Closes #42` / `Fixes VON-123`, the PR-body magic word. Record it in `## Source` next to the backend and id — the id is what makes the session's goal traceable later: `/dobby:commit` sources the goal reference from that line and hands it back to `goal parse` to re-resolve the magic word against the configured tracker. The link itself is there so a human reads `## Source` and lands on the issue.
- **`hardStop`** — non-null means the goal names an issue this session cannot read (D8): **STOP the stage** and report it verbatim. An issue goal has no free-text fallback; a free-text goal always continues.

**An issue goal is fetched, then claimed.** Fetching an issue's body is the one tracker operation the CLI has no verb for: read it per **view goal — the exception** in `../backlog/references/trackers.md` (that reference owns the mechanics). Then claim it — you're starting work on it, so the claim tells a parallel session not to double-take it:

```bash
bunx dobby claim <id> --json
```

- **github** — done when the payload says `claimed: true` (the CLI creates `status:in-progress` before assigning, so a fresh repo never loses the in-progress signal).
- **linear** — the payload is a **delegation descriptor** (`delegate: "mcp"`, `op: "claim"`, `assignee`, `state: "In Progress"`, `team`) instead of an action: execute it through whichever Linear MCP tool ToolSearch resolves, per the `claim` row of the delegation table in `../backlog/references/trackers.md` — never hardcode a tool name. **This claim is the kit's one and only Linear-MCP write point**; In Review (on PR open) and Done (on merge) come from Linear's native GitHub integration off the PR body's `lifecycleLink`, never from the kit. If the MCP cannot read the issue, **STOP the stage** — that is the Linear half of the D8 hard stop, which `goal parse` cannot see from outside the MCP.

## Step 2: Set up the work-session worktree

Before anything else touches the codebase, put the session in its own worktree so the whole goal — every stage after this — runs isolated on a goal-named branch. This step runs entirely before `STATE.md` is created (it lands at the worktree root, which becomes the session's repo root once you enter it).

### 2a. Preflight the slug

Settle the slug first — the worktree dir and the branch are named after it, so it has to read like the goal (no prompt, no confirmation either way):

- **Free-text goal** — take `slug` from Step 1 as-is; it is already a few kebab-case words off the goal text.
- **Issue goal** — Step 1's `slug` is only a STARTING point (github returns `issue-42`, linear `von-123`). Derive the real one from the issue TITLE you fetched in Step 1 — a few kebab-case words capturing it, e.g. `add-csv-export` — and fall back to the parse's `issue-<n>` / `von-123` only when no title was readable.

Then ask what that slug would take:

```bash
bunx dobby scope preflight --slug <slug> --json
```

Branch on the payload in this order:

- **`nested.insideWorktree: true`** — this session already owns a goal's worktree (`nested.currentSlug`), and the native `EnterWorktree` cannot nest. **Soft-STOP the stage** with a plain-text note (not AskUserQuestion): open a **new cmux pane / `claude` session** and run `/dobby:scope <new goal>` there — one goal per pane, no nesting. Do **not** auto-exit, auto-remove, or stack a second worktree.
- **`collision.branchExists` or `collision.dirExists`** — the name belongs to another goal. Re-run the preflight with `suggestedSlug` (or your own distinguishing word) so this goal gets its own worktree instead of clobbering an existing one.
- **`existingWorktrees`** — INFORMATIONAL, never a refusal. The invariant is **one session per goal**, not "one worktree on the machine": parallel worktrees for independent goals are fine and expected (cmux runs one goal per pane), so `.claude/worktrees/` legitimately holds worktrees from OTHER sessions/panes. Do not refuse because the list is non-empty — nesting is the only thing 2a blocks.
- **`configPresent` / `dobbyInstalled`** — the dobby contract, read at the main checkout the worktree is cut from. `dobbyInstalled: false` is the hard stop stated above (nothing has been created yet — stop here, not after a worktree exists); `configPresent` decides 2c vs 2d.

### 2b. Create and enter the worktree

**Use the `EnterWorktree` tool** with the collision-free slug as its `name` (this native tool must be invoked explicitly — call it, don't shell out to `git worktree add`):

- `EnterWorktree({ name: "<slug>" })` creates and enters `.claude/worktrees/<slug>/` on branch `worktree-<slug>` — the `path` and `branch` the preflight reported — based on the default `fresh` ref (`origin/HEAD`). The session's working directory is now the worktree root.

### 2c. Bring the workspace up (blocking)

When the preflight reported **`configPresent: true`**, run from the worktree root:

```bash
bunx dobby up --json
```

This is the single mechanical step that makes the worktree usable — `dobby up` owns it end-to-end: a **setup phase** (installs dependencies, re-materializes the gitignored env/config files a fresh worktree needs — the `.worktreeinclude` set, idempotently — then runs any `setup[]` extras from the config), followed by a **run phase** that starts the app (liveness-first). Under cmux it also renames the workspace to the goal slug, so you can tell at a glance which workspace belongs to which goal. Run it directly (Bash); it blocks until the workspace is up, in parallel with the exploration researcher you dispatch in Step 4. (`up` is idempotent, so `/dobby:execute` Step 2 re-runs it later without double-starting.)

Read the payload:

- **`ok: true`** — the worktree comes up **running** at `devUrl` (`browserPane` names the kit browser pane under cmux, `verifyMode` tells later stages how they will verify). `phase: "noop"` means a no-app project (a library / CLI / plugin like dobby itself): the setup phase ran, there is nothing to serve, and that is a clean success.
- **`ok: false`** — bring-up FAILED. `reason` is the machine-readable cause (`install-failed`, `worktree-copy-failed`, `setup-extra-failed`, `neon-creds-missing`, `dev-start-failed`, `liveness-timeout`, `config-unreadable`, `not-a-git-repo`); the prose is on stderr.

**Bring-up failure blocks the stage** — "worktree usable or nothing." Report the failing command, the `reason`, and its stderr first. Then present an **AskUserQuestion** — legitimate here, not a mid-flow interruption: a bring-up failure BLOCKS the stage, so the gate is the handoff. Two options, and only these two:

- **(a) "Abort & fix" (Recommended)** — the default. Remove the just-created worktree via the **`ExitWorktree` tool** in `remove` mode (this same session created it and the tree is clean, so removal tears down the dir + branch and restores the original working directory; the tool guards destructive removal via its `discard_changes` flag — set it since there's nothing to keep), then **STOP the stage**. The user fixes the underlying problem and re-runs `/dobby:scope` fresh (a clean removal here means no leftover to trip the Step 2a nesting/collision checks).
- **(b) "Continue degraded"** — keep the worktree and proceed WITHOUT the managed run. Name explicitly what is lost: no cmux panes/browser, no liveness wait, no pidfile for `/dobby:finish` to tear down — the app runs only if the user starts it by hand. When the payload carries a non-null `degradedCommand` (install-phase failures only), name it as the mechanical degraded bring-up: it skips just the install; panes/liveness/rename still run.

**Transparency rule (non-negotiable): a degraded bring-up is never silent.** If (b) is chosen, surface it in all three places — record it as an **Environment note** in `STATE.md`, state it plainly in the Step 5 scope checkpoint, AND restate it in the Next-step handoff line — never buried where the user must ask "didn't you say you'd open a browser/server?". Deviating from the abort default WITHOUT the user's explicit (b) selection is a stage violation. The note's home in `STATE.md` is the **`## Exploration` body**, written in Step 5 — see there.

### 2d. No config to run from

**`configPresent: false`** (the repo has `dobby` but was never onboarded) — skip the bring-up; there is nothing for `dobby` to run. Say plainly that it was skipped and that `/dobby:onboard` establishes the contract for next time, then **continue the stage** — the worktree is still valid and `state init` still works.

## Step 3: Create the work-session doc

```bash
bunx dobby state init --goal "<the goal>" --source "<source>"
```

`state init` owns the document end to end: it writes `STATE.md` at the repo root (the worktree root you just entered) with the canonical skeleton — the `# Work session:` title (the `--goal` value verbatim) plus the seven sections every later stage appends to, in fixed order: `## Goal`, `## Source`, `## Exploration`, `## Findings (interview)`, `## Research`, `## Spec`, `## Work log`, each body `_pending_` except the two the flags fill — and it ensures `STATE.md` is in `.gitignore` (working memory, never a committed artifact; `/dobby:wrap` disposes of it at the end). Never hand-write the skeleton, never add the gitignore line yourself, never rename or re-order a section.

`--source` carries what `goal parse` reported: `prompt`, or the backend plus the id and its lifecycle link (e.g. `github #123 — Closes #123`). `## Goal` and `## Source` are **write-once** — fill them here or they stay `_pending_` for the whole session.

`init` REFUSES an existing `STATE.md` rather than overwrite a live session's work. If it refuses, you are standing in a session that already has a work doc: stop and say so.

## Step 4: Explore the codebase

Dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to ground the work — you don't grep in the main thread. Have it map what the goal touches (existing modules, conventions, how similar things are structured, where this fits), read the root `CONTEXT.md` (domain glossary) + the `CONTEXT.md` of any module the goal touches (each has its own — they're not auto-loaded), and skim `docs/adr/` if present, reporting any constraints. Respect the project's structure (deep, feature/domain modules per `/dobby:spec`'s `../spec/references/architecture-vocab.md`; don't assume type-based folders). On a greenfield repo there may be little to find — that's fine. The researcher returns a grounded findings report.

**Cross-reference the goal against the code — don't just map files.** Instruct the researcher to validate the goal's claims against what the code actually does and to report every contradiction as a finding (e.g. "you said cancellation is per-line, but the code cancels whole Orders — which is right?") so the checkpoint can resolve it before it propagates into the interview and spec. The goal is often written from an outdated mental model; the code is the ground truth. A wrong premise caught here is cheap; caught at execute it is expensive.

**Context-budget the digest.** The exploration output shares one architect window with the interview and spec. If the goal touches a large surface, tell the researcher to return a COMPRESSED digest (the load-bearing modules, conventions, constraints, and contradictions — named, not dumped) rather than an exhaustive file-by-file transcript. If a full map is genuinely needed, have the researcher write it to a path and return a pointer plus the digest.

## Step 5: Checkpoint and record

Present a concise summary to the user (relevant code areas, patterns, how the goal fits) so they can correct misunderstandings early — and, if Step 2c ended degraded, what is NOT running. Then write that same summary into the doc:

```bash
bunx dobby state set Exploration --stdin <<'MD'
<the summary>
MD
```

**A degraded bring-up is FOLDED into this section, not given a heading of its own.** The engine's section set is fixed at seven, so the Environment note leads the Exploration body as a bold line — `**Environment note:** the app is NOT running (<reason>); started degraded by the user's explicit choice; <what that costs later stages>.` — with the exploration summary under it. `state set` replaces the whole body, so write note and summary in ONE call.

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

- [ ] Goal normalized via `bunx dobby goal parse "<arg>" --json` (never by reading `dobby.config.json#tracker` or matching issue patterns by hand); asked in plain text if the input was empty
- [ ] `hardStop` honored: non-null → stage STOPPED and reported (D8); a free-text goal always continues
- [ ] If `source` is an issue: fetched per **view goal — the exception** in `../backlog/references/trackers.md`, then claimed with `bunx dobby claim <id> --json` — github when `claimed: true`; linear by executing the returned `{delegate:"mcp", op:"claim"}` descriptor through the ToolSearch-resolved tool (the kit's ONLY Linear-MCP write point; In Review / Done stay Linear-native), stage STOPPED if the MCP cannot read it
- [ ] Slug settled before the preflight: taken as-is from `goal parse` for a free-text goal; derived from the fetched issue TITLE for an issue goal (the parse's `issue-<n>` / `von-123` only as the fallback when no title was readable)
- [ ] `bunx dobby scope preflight --slug <slug> --json` run before touching the tree; `nested.insideWorktree` → soft-STOP ("open a new pane"), collision → retried with `suggestedSlug`, `existingWorktrees` treated as informational (parallel goals never refused)
- [ ] Worktree created + entered via the `EnterWorktree` tool with the collision-free slug (branch `worktree-<slug>`, `.claude/worktrees/<slug>/`)
- [ ] `bunx dobby up --json` run (blocking) when `configPresent`; `ok:true` reported with `devUrl`/`phase` (no-app = clean success); `ok:false` → `reason` + stderr reported, then the two-option AskUserQuestion — **(a) abort (default/recommended)** `ExitWorktree(remove)` → stopped, or **(b) continue degraded** only on the explicit selection, naming `degradedCommand` when non-null
- [ ] Degradation surfaced in all three places (STATE.md Environment note + Step 5 checkpoint + Next-step handoff), the note FOLDED into `## Exploration` as a bold `**Environment note:**` lead — no new heading
- [ ] Missing local `dobby` (`dobbyInstalled:false`) → stage STOPPED before anything was created, pointing at `/dobby:onboard` / `/dobby:migrate-config`; `configPresent:false` → bring-up skipped with an `/dobby:onboard` note and the stage CONTINUED
- [ ] `STATE.md` created with `bunx dobby state init --goal … --source …` (the engine owns the skeleton AND the gitignore entry); `--source` carries the backend, id and lifecycle link; a refusal (existing `STATE.md`) stopped the stage
- [ ] Codebase explored with a `researcher` agent; `CONTEXT.md` + ADRs read if present
- [ ] Researcher cross-referenced the goal's claims against the code and surfaced contradictions (not just a file map)
- [ ] Exploration returned as a compressed, context-budgeted digest (depth on what matters; pointer for a full map if needed)
- [ ] Exploration summary shown to the user and written with `bunx dobby state set Exploration --stdin` (one call, Environment note first when degraded)
- [ ] Next step routed by goal shape (bug→`/dobby:diagnose`, refactor→`/dobby:improve-architecture`, feature/ambiguous→`/dobby:interview`), not a fixed default
- [ ] Next step offered via an AskUserQuestion gate (recommended route first, alternatives + Stop here); chosen route invoked via the Skill tool
