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
| `implementor` | Write the code for one scoped task | Opus / xhigh |
| `reviewer` | Code-review a task's diff, pass/fail verdict | Opus / high |
| `verifier` | Prove the task works against the running app | Sonnet / high |

The payoff: your context stays clean for thinking, implementation quality is enforced by independent review, and "done" means *proven against the running app*, not "the code looks right".

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
/dobby:execute      waves of implement → review → verify (the trifecta)
      │
/dobby:wrap         human smoke test, docs/ADRs, STATE.md disposed
      │
/dobby:commit       branch, commit, push, PR
```

Side paths, available at any point:

- `/dobby:prototype` — when a decision can't be settled with words, interview/research hand off to a throwaway prototype you can play with, then resume.
- `/dobby:diagnose` — when something breaks during execute (or any time), a disciplined hypothesis-driven debugging loop.
- `/dobby:dispatch` — the whole architect/worker machinery for a task too small to deserve a session.

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

The architect turns decisions + research into a build plan and **prints it in full in the conversation** — overview, edge cases, and a task table where every task carries its own *verify recipe* (the exact steps that will later prove it works). Approval is asked in plain text at the end of the printed plan; nothing builds until you say so.

**Artifact:** `## Spec` in `STATE.md`.

### 5. Execute

```
/dobby:execute
```

Conductor already auto-ran the app (`auto_run_after_setup`); the coordinator resolves the dev URL with `portless get` and confirms the app is up, then launches the build workflow. Per task, **three separate agents** run a state machine:

```
implement → code review → (findings? fix → re-review) → verify → (fail? restart) → done
```

The implementor never reviews itself; the reviewer never implements; the verifier checks the *running app* (the one Conductor is already serving) against the task's verify recipe. Independent tasks run in parallel waves. A task that exhausts its retries is flagged `needs-human` instead of thrashing forever.

**You'll see:** live workflow progress, then a status table per task, and the work log appended to `STATE.md`.

### 6. Wrap

```
/dobby:wrap
```

The closing pass: a short **human smoke test** (the few cross-task behaviors machines can't prove — you answer Pass/Fail/Skip, failures get dispatched to an implementor and re-presented), project docs reconciled (`CONTEXT.md` glossary terms the work introduced, ADRs the decisions earned), and `STATE.md` disposed — it's ephemeral by design.

Then you type `/dobby:commit`: pre-commit checks, branch, conventional commit, push, PR.

## When to use what

| Situation | Reach for |
| --- | --- |
| A feature, fix, or refactor with real surface area | `/dobby:scope` — the full session |
| A one-off fix, small change, or bounded question | `/dobby:dispatch` |
| Something is broken and the cause isn't obvious | `/dobby:diagnose` |
| A design/UX question words can't settle | `/dobby:prototype` |
| "Is this module structured well?" | `/dobby:improve-architecture` |
| An idea/bug worth tracking, mid-flow | `/dobby:backlog` — capture and keep moving |
| A repeatable workflow worth packaging | `/dobby:create-skill` |
| A brand-new empty repo | `/dobby:onboard` |
| Work is done, ship it | `/dobby:commit` |
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
| Execute re-authored the workflow and lost the loop logic | The trifecta script must be used verbatim | Re-run `/dobby:execute`; the skill's `references/build-workflow.md` is the canonical script |

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
