# dobby

Kevin Wolf's agentic engineering kit for Claude Code, packaged as a plugin. dobby doesn't make Claude Code smarter — it makes it **disciplined**: the main thread stays an architect that frames, asks, decides, and reviews but never writes code, while four worker agents do the hands-on work. Every change is implemented, code-reviewed, and verified by **separate** agents before it counts as done.

## Install

```
/plugin marketplace add kvnwolf/dobby
/plugin install dobby@dobby
```

Or with [vercel-labs/plugins](https://github.com/vercel-labs/plugins): `npx plugins add kvnwolf/dobby`.

Then start your first session from any project:

```
/dobby:scope <what you want to build>
```

**Prerequisites**: the [`ctx7` CLI](https://context7.com) (the `researcher` agent fetches current library docs through it), and `vp` (vite-plus) on PATH if you want the post-edit check hook to do anything.

## The mental model

Two roles, never mixed:

- **The architect** (your main conversation) — interrogates you until the task has zero ambiguity, plans, dispatches workers, reviews what comes back, and owns every decision. If you ever see the main thread grepping around or editing files during kit stages, that's a bug in the kit.
- **The workers** (custom agents, addressed as `dobby:<name>`) — each runs with its own model and effort, tuned to its job:

| Agent | Role | Model |
| --- | --- | --- |
| `researcher` | Explore code, fetch current docs (ctx7), resolve unknowns | Opus / medium |
| `test-author` | Write a task's tests from the spec alone, blind to the implementation | Opus / xhigh |
| `implementor` | Write the code for one scoped task | Opus / xhigh |
| `reviewer` | Code-review a task's diff, pass/fail verdict | Opus / high |
| `verifier` | Prove the task works against the running app | Sonnet / high |

The payoff: your context stays clean for thinking, implementation quality is enforced by independent review, and "done" means *proven against the running app*, not "the code looks right".

## Where it runs: two execution hosts

dobby runs on one of **two named execution hosts**, and it figures out which by itself — you don't configure it. Detection is by environment variable:

| Host | Detected when | Who owns the worktree | Who runs the app |
| --- | --- | --- | --- |
| **Conductor** | `CONDUCTOR_WORKSPACE_PATH` is set | Conductor (one worktree per workspace) | Conductor auto-runs it (`auto_run_after_setup`) |
| **Terminal** | that env var is absent | dobby — `/dobby:scope` creates it, `/dobby:finish` removes it | dobby starts it lazily at `/dobby:execute` |

The **terminal host** is a plain `claude` session — including over ssh, and inside **cmux** (the manaflow-ai native macOS terminal). It exists so you can run the kit remotely. When it detects **cmux** (`CMUX_WORKSPACE_ID` is set in every cmux pane), it enriches the run: the dev server gets its own named pane, a browser pane opens at the app URL, and the verifier drives the UI through cmux's browser CLI. Plain ssh/tmux (no cmux) degrades gracefully — the app runs as a background job, no panes.

**What changes for you** between the two:

- On **Conductor**, nothing changes from before: the workspace *is* the worktree, the app is already running, and `/dobby:scope`…`/dobby:commit` is the whole cycle. `/dobby:finish` is a no-op (Conductor archives the workspace itself).
- On the **terminal host**, `/dobby:scope` first creates and enters a per-goal git worktree, and after your PR merges you run `/dobby:finish` to tear it down. Everything in between is identical.

On **both** hosts, the coordinator and verifier reach the running app the same way — `portless get <name>` resolves a stable per-worktree dev URL and a curl health-check confirms it's live. The only difference is who starts the app.

### Terminal-host prerequisites

Only needed if you run on the terminal host (Conductor users can skip this):

- **Node 24+** — required by `portless`.
- **`portless`** — added as a pinned devDependency by `/dobby:onboard`, plus a one-time `portless trust` (it needs sudo once to install a local CA and bind `:443`).
- **Claude Code** recent enough for native worktrees: `EnterWorktree`/`ExitWorktree` land in **≥ 2.1.72**; transcript relocation (so `/dobby:mark`/`/dobby:learn` still resolve a session after the worktree moves) lands in **≥ 2.1.198**.

## The lifecycle

A work session moves through six stages. Each stage ends by telling you which command to type next — **nothing advances until you type it**. Handoffs are typed on purpose: typed entry is what applies each stage's own model and effort (an auto-invoked skill would ride the previous stage's override):

```
/dobby:scope        ground the goal in the codebase, create STATE.md
      │
/dobby:interview    resolve EVERY ambiguity, one question at a time
      │
/dobby:research     current docs + unknowns, via researchers     (skipped when no external tech)
      │
/dobby:spec         the build plan, printed in full — you approve it
      │
/dobby:execute      waves of (test →) implement → review → verify (the build loop)
      │
/dobby:wrap         human smoke test, docs/ADRs, STATE.md disposed
      │
/dobby:commit       branch, commit, push, PR
      │
/dobby:finish       (terminal host, after the PR merges) tear down the worktree
```

`/dobby:finish` is the post-merge closing step **on the terminal host**: once your PR is merged, it runs the config's teardown, closes the cmux panes it opened, removes the per-goal worktree + branch, and pulls the main checkout. On Conductor it's a no-op — the host archives the workspace for you. It's typed like every other stage; nothing runs until you type it.

Side paths, available at any point:

- `/dobby:prototype` — when a decision can't be settled with words, interview/research hand off to a throwaway prototype you can play with, then resume.
- `/dobby:diagnose` — when something breaks during execute (or any time), a disciplined hypothesis-driven debugging loop.
- `/dobby:dispatch` — the whole architect/worker machinery for a task too small to deserve a session.
- `/dobby:address-review` — take a review bot's or reviewer's PR comments from posted to addressed + threads resolved + re-reviewed.
- `/dobby:handoff` — compact the session into an ephemeral fork document a fresh session can pick up (see [Context hygiene](#context-hygiene-fork-vs-continue)).

### Context hygiene: fork vs. continue

A long session accumulates dead context — resolved threads, abandoned branches, raw tool output — that quietly crowds out the room the architect needs to think. When context is getting long, the work spans days, or you're about to switch to a distinct sub-goal, don't just keep going: type `/dobby:handoff`. It writes an **ephemeral fork document** (to your OS temp dir) that summarizes where things stand, references the durable artifacts (`STATE.md`, PRDs, ADRs, diffs) by path instead of copying them, redacts secrets, and lists the `/dobby:*` skills to reach for next. Start a fresh session, point it at that document, and continue with a clean slate. It's for **forking**, not durable record-keeping — decisions still land in `CONTEXT.md` / ADRs / commits.

## Your first session — end-to-end walkthrough

One concrete feature, carried through every stage: **adding CSV export to an admin users table**. Follow along to see what each command does, what you'll see, and what it leaves behind.

### 1. Scope

```
/dobby:scope add a CSV export button to the admin users table
```

The architect creates `STATE.md` at your repo root (the session's shared doc) and dispatches a `dobby:researcher` to ground the goal: where the users table lives, which conventions the project uses, what the domain glossary and ADRs say. You don't wait on grepping — a worker does it.

**You'll see:** a short grounded summary ("the table is `src/admin/users/`, it uses the shared DataTable, exports don't exist anywhere yet"), then the suggestion to type `/dobby:interview` next (or jump straight to research or spec).

**Artifact:** `STATE.md` with a filled `## Exploration` section.

### 2. Interview

The architect now interrogates you — **one focused question at a time**, each informed by what the researcher found, each with a recommended answer:

> Should the export respect the current filters and search, or always dump the full table? *(Recommended: respect filters — that's what the visible data implies.)*

Expect questions about edge cases you hadn't considered: empty results, the 50k-row tenant, who's allowed to export, date formatting, column selection. This is the kit's core bet: **misalignment is the most common failure mode**, so the interview doesn't stop until there's zero ambiguity — and it will refuse to end on a vague "anything else?" if open threads remain.

If a question can't be settled verbally ("which of these two layouts feels right?"), the interview sends you to type `/dobby:prototype` and resumes after you've played with the variants.

**Artifact:** `## Findings (interview)` in `STATE.md` — every decision, with the rejected alternative and the why.

### 3. Research

Researchers fan out in parallel: one fetches current docs for the CSV library candidates (via `ctx7` — never from training data), another checks how streaming downloads work in your framework version, another looks for an existing export pattern in the codebase worth reusing.

**You'll see:** a tight research brief — key facts with doc sources, what to reuse, open questions flagged.

**Artifact:** `## Research` in `STATE.md`.

### 4. Spec

```
/dobby:spec
```

The architect turns decisions + research into a build plan and **prints it in full in the conversation** — overview, edge cases, and a task table where every task carries its own *verify recipe* (the exact steps that will later prove it works). Approval is a single tap (Aprobar / Ajustar) right after the printed plan; nothing builds until you say so.

**Artifact:** `## Spec` in `STATE.md`.

### 5. Execute

```
/dobby:execute
```

The coordinator makes sure the app is up — on Conductor it was already auto-run, on the terminal host `/dobby:execute` starts it now (in a named cmux pane, or a background job) — resolves the dev URL with `portless get`, confirms it's live, then launches the build loop. Per task, **separate agents** run a state machine:

```
(test-author) → implement → code review → (findings? fix → re-review) → verify → (fail? restart) → done
```

The implementor never reviews itself; the reviewer never implements; the verifier checks the *running app* against the task's verify recipe. The leading test step is conditional: when the repo has a test suite and the spec marked a task test-first, a `dobby:test-author` writes the failing tests before the implementor touches the code; repos without a suite degrade to the classic three-step loop. Independent tasks run in parallel waves. A task that exhausts its retries is flagged `needs-human` instead of thrashing forever.

**You'll see:** live workflow progress, then a status table per task, and the work log appended to `STATE.md`.

### 6. Wrap

```
/dobby:wrap
```

The closing pass: a short **human smoke test** (the few cross-task behaviors machines can't prove — you answer Pass/Fail/Skip, failures get dispatched to an implementor and re-presented), project docs reconciled (`CONTEXT.md` glossary terms the work introduced, ADRs the decisions earned), and `STATE.md` disposed — it's ephemeral by design.

Then you type `/dobby:commit`: pre-commit checks, branch, conventional commit, push, PR.

### 7. Finish (terminal host only)

```
/dobby:finish
```

On Conductor you're done at commit. **On the terminal host**, the whole session ran inside a per-goal worktree that `/dobby:scope` created — so after your PR merges on GitHub, one more step retires it:

```
/dobby:scope … → interview → research → spec → execute → wrap → commit → (merge on GitHub) → /dobby:finish
```

`/dobby:finish` confirms the PR is actually **merged** (if it's still open, closed, or the tree is dirty, it shows the state and asks before destroying anything), runs the config's teardown commands, closes the cmux panes it opened, removes the worktree and its branch, and pulls your main checkout. If the original session died and left an **orphaned** worktree behind, run `/dobby:finish` anyway — it falls back to a raw-git cleanup after verifying the branch was merged and confirming with you.

## When to use what

| Situation | Reach for |
| --- | --- |
| A feature, fix, or refactor with real surface area | `/dobby:scope` — the full session |
| A one-off fix, small change, or bounded question | `/dobby:dispatch` |
| An idea too big to interview-then-plan in one sitting, with unknowns that block each other | `/dobby:map` — a durable decision-map, resolved one ticket at a time |
| Something is broken and the cause isn't obvious | `/dobby:diagnose` |
| A design/UX question words can't settle | `/dobby:prototype` |
| "Is this module structured well?" | `/dobby:improve-architecture` |
| An idea/bug worth tracking, mid-flow | `/dobby:backlog` — capture and keep moving |
| A repeatable workflow worth packaging | `/dobby:create-skill` |
| An incoming issue or outside PR to evaluate and turn into a brief | `/dobby:triage` |
| A manual setup or A→B procedure worth turning into a guided run | `/dobby:wizard` — generates an interactive bash setup wizard |
| Learn a topic and check you actually got it | `/dobby:teach` |
| Context is getting long, or you want to branch a fresh session off a clean summary | `/dobby:handoff` — an ephemeral fork document |
| A merge/rebase left conflict markers you need to reconcile without losing either side | `/dobby:resolve-conflicts` |
| A brand-new empty repo | `/dobby:onboard` |
| A repo still on the legacy `.claude/commit.config.yml` | `/dobby:migrate-config` — convert it to `dobby.config.json`, one-time |
| Work is done, ship it | `/dobby:commit` |
| Terminal host: the PR merged and the worktree needs retiring | `/dobby:finish` |
| A review bot or reviewer left comments on your PR | `/dobby:address-review` |
| Structuring or refactoring a module's files | `/dobby:module-conventions` (auto-activates) |
| Building a form or wiring a data mutation | `/dobby:data-processing` (auto-activates) |
| Wiring server data into a list/table | `/dobby:data-fetching` (auto-activates) |

Rule of thumb: if getting it wrong would cost you a rework cycle, it deserves a session (`scope`). If you could review the whole change in one glance, `dispatch` it.

## Convention skills

Three skills are **not** work-session stages — they're stack-convention guides that **auto-activate** while you build, encoding Kevin's standard application stack (TanStack Start + Drizzle/Neon + Better Auth, the `@/shared` form/data system). You never type them to advance a session; they fire when the work matches and reference the consuming project's module file conventions on purpose (deep-path imports and the role-based file taxonomy — no barrels):

- `/dobby:module-conventions` — the per-module file taxonomy: `{export}.server.ts` (eager server-only instance) · `functions.ts` (server fns + middlewares) · `{descriptor}.browser.ts` (browser code) · co-located `schema.gen.ts`, with the framework-enforced boundaries and env-as-single-source.
- `/dobby:data-processing` — the write side: form conventions (`useAppForm` from `@/shared/use-app-form`, Zod validation, field + dialog anatomy) plus mutation UX (submit-validated by default, optimistic only for in-place row toggles, type-to-confirm, toasts).
- `/dobby:data-fetching` — the read side: the TanStack DB recipe — session-guarded server fn → eager query collection → the `LiveQuery` component.

## The artifacts: STATE.md

Every session writes one shared doc at the target repo's root. It's how stages hand off to each other and how a session survives interruptions:

```
STATE.md
├── ## Exploration            ← scope: what the codebase says
├── ## Findings (interview)   ← interview: every decision + why
├── ## Research               ← research: the brief the plan consumes
├── ## Spec                   ← spec: the approved task table + verify recipes
└── ## Work log               ← execute: what each implementor actually did
```

It is **never committed** — `/dobby:wrap` disposes it after reconciling the durable docs (`CONTEXT.md`, `CLAUDE.md`, ADRs).

## Also ships

- **Hook `vp-check-changes`** — after every Edit/Write, runs `vp check` in projects that have a `vite.config.ts` (no-op everywhere else).

## Improving the kit from real sessions

dobby learns from how its own skills behave in the field. Two skills form the loop:

- `/dobby:mark` — run it in **any** consumer project when a dobby skill was rough. It prints a portable **session indicator**: a pointer to that session's transcript, its repo and worktree root, the still-on-disk `STATE.md` if present, the `/dobby:*` skills it invoked, and your note on what to fix.
- `/dobby:learn <indicator>` — run it **in the dobby repo**. It digests that session (via a `researcher`, never reading the multi-MB transcript whole) and turns the friction into concrete edits to the skill that underperformed.

These couple to Claude Code's session storage (`~/.claude/projects`) on purpose — they're kit-maintenance tooling, not part of a normal work session.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Agent type 'dobby:researcher' not found` | Agents register at session startup | `/reload-plugins`; if that doesn't take, restart the session |
| `/dobby:*` skills don't show up | Plugin not enabled | `/plugin` → enable `dobby@dobby` (or reinstall) |
| Researchers cite stale/odd docs | `ctx7` CLI missing or unauthenticated | Install `ctx7`; set `CONTEXT7_API_KEY` for higher limits |
| Skill edits not picked up (local dev) | Only `SKILL.md` hot-reloads | `/reload-plugins` for agents/hooks changes |
| Post-edit check hook never fires | By design outside vite-plus projects | Gate = `vite.config.ts` at project root **and** `vp` on PATH |
| Execute re-authored the workflow and lost the loop logic | The build-loop script must be used verbatim | Re-run `/dobby:execute`; the skill's `references/build-workflow.md` is the canonical script |
| `portless` prompts for sudo / fails to bind `:443` on first run (terminal host) | First-time CA install + privileged port | Run `portless trust` once (surfaced by `/dobby:onboard`); it's a one-time setup, later runs don't need it |
| An old session died and left a worktree in `.claude/worktrees/` (terminal host) | The session couldn't run `/dobby:finish` before exiting | Run `/dobby:finish` anyway — it detects the orphan, verifies the branch merged, confirms with you, and cleans up via raw git |
| `/dobby:scope` stops on the terminal host ("open a new pane") | Nesting — THIS session is already inside a worktree, and the native tool can't nest (parallel worktrees from OTHER sessions are fine and don't trigger this) | Open a new cmux pane / `claude` session for the new goal and run `/dobby:scope <goal>` there — one goal per pane, no nesting |

## Recovery quick reference

- **Session interrupted mid-stage?** `STATE.md` is the source of truth. Re-invoke the stage you were in — it reads the doc and continues.
- **Want to revisit a decision?** Re-run `/dobby:interview`; it updates `## Findings` and downstream stages pick up the change.
- **A task came back `needs-human`?** That's the workflow refusing to thrash. Read the reason in the status table, then `/dobby:diagnose` or `/dobby:dispatch` the fix.
- **Abandon a session?** Delete `STATE.md`. Nothing else was written outside the code changes themselves.

## Local development

```
claude --plugin-dir .
```

Skill edits hot-reload; agents and hooks need `/reload-plugins`.

---
*`/dobby:prototype` is adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `engineering/prototype`.*
