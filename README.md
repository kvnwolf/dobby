# dobby

Kevin Wolf's agentic engineering kit for Claude Code, shipped as two surfaces from one repo: the **plugin** (skills + agents + hooks) and the **`@kvnwolf/dobby` CLI**. dobby doesn't make Claude Code smarter — it makes it **disciplined**: the main thread stays an architect that frames, asks, decides, and reviews but never writes code, while five worker agents do the hands-on work. Every task is independently verified before execute calls it done, and the complete change receives holistic external review at the PR boundary.

> **Standing on Matt Pocock's shoulders**: many of dobby's skills and agents are adapted from [mattpocock/skills](https://github.com/mattpocock/skills) — each adapted file credits its exact source in a footer. If you want to get better at working with AI, go visit [aihero.dev](https://aihero.dev/).

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

**Prerequisites**: the [`ctx7` CLI](https://context7.com) (the `researcher` agent fetches current library docs through it). The post-edit check hook needs no global tool — it runs each project's LOCAL `@kvnwolf/dobby` bin (installed by `/dobby:onboard`) and no-ops in repos without it.

### The CLI

The repo also ships **`@kvnwolf/dobby`**, the kit's **mechanical execution layer** — a Bun CLI installed as each project's single devDependency (added by `/dobby:onboard`). It detects a project's capabilities from its dependencies and infers every task zero-config (à la Vercel): the quality gate (`dobby check` — also the edit hook, `dobby check --fix` the pre-commit gate, and `dobby check --pre-push` the git-hook backstop that refuses a red push) and the run lifecycle (`dobby up` / `dobby down` / `dobby dev`), where `dobby up` also brings a fresh worktree up (installs deps, materializes the env files, installs the pre-push hook) and probes it, handing back the instructions to start it (`dobby instructions <topic>`) — the two-step protocol every skill/agent follows. It mechanizes the kit's ceremonies too, so the skills keep the judgment and hand the mechanics over: `dobby ship` (stage → gate in-process → commit → push → PR), `dobby release` (the whole publish spine behind a per-target adapter), `dobby state` (the `STATE.md` engine), `dobby build-plan`, `dobby review` / `dobby pr watch`, the finish/migrate preflights, the tracker + KB + ADR writers, and the artifact linters. It bundles the toolchain (Biome, TypeScript, knip, taze, portless) and ships every tool's config as a default: for biome, vite, vitest, and drizzle-kit, dobby passes its shipped, capability-picked preset through the tool's native config flag when the repo has no file of its own (**override by presence**), so a delta-less project carries only `package.json`, `tsconfig.json`, and `dobby.config.json` — you write a tool config file only to carry a real delta, and deleting it restores the default (a biome delta extends dobby's two FLAT presets, `biome/core` + `biome/react`, directly — biome's `extends` is one-level, so a react consumer lists both; without deltas, no `biome.jsonc` ships at all). External builders go through dobby too: a Vercel project sets its Build Command to `bunx dobby build`. Skills invoke it via `bunx dobby` (the local pinned bin). Full command reference: **[`cli/README.md`](./cli/README.md)** (the npm package front page). Releases are cut with `/dobby:release`, which runs `dobby release` and answers the two judgments it stops for (the version question and the notes).

## The mental model

Two roles, never mixed:

- **The architect** (your main conversation) — interrogates you until the task has zero ambiguity, plans, dispatches workers, reviews what comes back, owns host mechanics, and owns every decision. Skills inherit this interactive session's model/effort; choose its intelligence manually for the task. If you ever see the main thread grepping around, editing files, or implementing code during kit stages, that's a bug in the kit.
- **The workers** (`dobby:<name>`) — five independent agents that research, test, implement, review, and prove behaviour. Each agent prompt has one authoritative file under `plugin/agents/`, and that same file's frontmatter is the sole source of its role's model/effort — there is no external recipe to keep in sync.

| Agent | Role | Model / effort |
| --- | --- | --- |
| `researcher` | Explore code, fetch current docs (ctx7), resolve unknowns | `claude-sonnet-5` / medium |
| `test-author` | Write a task's tests from the spec alone, blind to the implementation | `claude-opus-5` / high |
| `implementor` | Write the code for one scoped task, then run its own Exit gate | `claude-sonnet-5` / high |
| `reviewer` | Explicit ad-hoc or missing-work-log safety review; not the normal execute path | `claude-opus-5` / high |
| `qa` | Prove the task's real behaviour against the running app or artefact | `claude-sonnet-5` / medium |

The payoff: your context stays clean for thinking, execute proves behavior without bouncing tasks through a duplicate review loop, and the external PR reviewer judges the complete diff with cross-task context.

### The dispatch protocol

There is no native Claude Workflow underneath execute — the Architect dispatches the five worker agents directly (the Agent tool, named `subagent_type`) by following `plugin/skills/execute/references/build-protocol.md`: prose it reads and carries out itself, not a script a separate runtime executes. Dobby does **not** launch `claude -p`, Codex, or another subprocess harness. A task starts the moment every task it depends on has reached `done`; there is no fixed batch boundary to wait on, and independent tasks keep moving even while a sibling is mid-fix.

Each task runs the **build loop**: `test-author` (conditional — only when the repo has a test suite and the spec marked the task test-first) writes the tests from the spec alone, `implementor` implements (or fixes) the task and then runs its own **Exit gate** (`bunx dobby check --fix --baseline`, serialised to one implementor at a time across the shared tree — everything else about a task keeps running in parallel with its siblings), and `qa` proves the task's real behaviour and returns a verdict. A genuine defect QA finds opens a **build conversation**: QA reaches back to whichever worker can fix it — the implementor for a code defect, the test-author (describing expected behaviour only, never a code fragment) for a test-contract problem — rather than starting a fresh agent that has to re-read everything. QA numbers every message in the text itself, and the conversation is capped at five rounds; a round-five message that still doesn't produce a pass reports the task `needs-human` instead of retrying further. An environment failure (a dead browser, an expired credential) never enters this conversation — it goes straight to the Architect and costs no round. When a task dies, only its dependents are marked `blocked`; everything independent of it keeps running exactly as if nothing had happened.

There is no normal per-task reviewer loop; the reviewer stays available for explicit dispatch and missing-work-log safety review — a write-capable worker that returns no usable work log gets an independent safety review of the current scoped diff, then stays `needs-human` instead of flowing into a false success. Static holistic review happens at the external PR boundary instead: after commit/push, the repository's external reviewer (currently Greptile) reviews the complete PR, and merge readiness requires a review of the current HEAD rather than a stale summary or silence.

If Greptile is the repository's external review gate, configure it to review every pushed HEAD and leave machine-readable evidence: `triggerOnUpdates: true`, `statusCheck: true`, `statusCommentsEnabled: true`, `shouldUpdateDescription: false`, and `hideFooter: false`; require the Greptile check in GitHub branch protection. `dobby pr watch` compares Greptile's `Last reviewed commit` footer to the current PR HEAD and fails closed as `open-unreviewed` on a stale or missing footer.

Each of the five agent prompt bodies is authoritative in `plugin/agents/`, and each declares its own `model`/`effort` directly in its frontmatter — there is no external recipe to mirror or keep in sync. Claude Code still gives the operator an external escape hatch: `CLAUDE_CODE_SUBAGENT_MODEL` can override subagent model pins at the host level. That is outside Dobby's control and should be noted when interpreting a run.

## Where it runs: the terminal host

dobby runs in a plain `claude` session — your terminal, including over ssh, and inside **cmux** (the manaflow-ai native macOS terminal) — operated inside whatever checkout or worktree you already opened. The kit owns the run lifecycle itself, mechanized by the `@kvnwolf/dobby` CLI:

- `/dobby:scope` grounds the goal wherever the session already stands — a worktree you opened (`claude --worktree`, an IDE, `git worktree add`) or a plain checkout on a branch — brings it up with `bunx dobby up`, then grounds the goal through researchers so the main-thread architect can plan from evidence.
- `/dobby:execute` re-runs `bunx dobby up` — idempotent and liveness-first, so a re-run never double-starts — then dispatches the plan's workers directly, following the shared dispatch protocol.
- `/dobby:finish` merges the goal's PR when it's still open (gated — your explicit call), tears the run down with `bunx dobby down`, and — only when the session stands in a worktree — offers to remove it.

`dobby up` no longer starts anything itself — it prepares the workspace, probes it, and hands back the instructions the model carries out: under **cmux** (`CMUX_WORKSPACE_ID` is set in every cmux pane) that means opening a named run pane and, once the app reports live (never on a booting 404), a named browser pane; on a plain ssh/tmux session it means a background `Bash` job instead. `dobby instructions <topic>` answers the same catalogue directly (`start`, `stop`, `browser`, `rename`), and QA drives the UI by following `dobby instructions browser` — cmux's own browser CLI ladder under cmux, a different guide under Claude Desktop or t3 code.

The coordinator and QA reach the running app the same way everywhere: `bunx dobby env` resolves a stable per-worktree dev URL (via `portless get`) and a curl health-check confirms it's live.

> Earlier versions of dobby also ran under **Conductor** as a second host. That support was removed — the terminal host (with optional cmux enrichment) is now the only one; everything Conductor did is preserved for a possible future re-add.

### Prerequisites

- **Node 24+** — required by `portless`.
- **`portless`** — bundled inside `@kvnwolf/dobby` (your single devDependency, added by `/dobby:onboard`), plus a one-time `portless trust` (it needs sudo once to install a local CA and bind `:443`).
- **Claude Code** recent enough for native worktrees, if you use them to isolate a goal (`claude --worktree`, `ExitWorktree`): **≥ 2.1.72**; transcript relocation (so `/dobby:mark`/`/dobby:learn` still resolve a session after the worktree moves) lands in **≥ 2.1.198**.

## The lifecycle

A work session moves through six stages. Each stage ends by asking which command comes next — the recommended one, the alternatives, and "Stop here" — and **nothing advances until you pick**. That handoff question is the only gate besides plan approval; within a stage the kit runs to completion:

```
/dobby:scope        ground the goal in the codebase, create STATE.md
      │
/dobby:interview    resolve EVERY ambiguity, a round of questions per turn
      │
/dobby:research     current docs + unknowns, via researchers     (skipped when no external tech)
      │
/dobby:spec         the build plan, printed in full — you approve it
      │
/dobby:execute      the build loop, task by task: (test →) implement → verify
      │
/dobby:wrap         human smoke test, docs/ADRs, STATE.md disposed
      │
/dobby:commit       docs synced, message + PR body authored, then `dobby ship`
      │             (gate → commit → push → PR) and the watch to a verdict
      │
/dobby:finish       merge the PR (your call), tear down the run
```

`/dobby:finish` is the closing step: if the PR is still open, it offers to **merge** it first — your explicit selection at its gate, squash-merged, and only once `dobby pr watch` says merge-ready — and then `bunx dobby down` runs the config's teardown, kills the registered run process, deletes the per-worktree Neon branch, and hands back the instruction to close any cmux pane it opened; then, only when the session stands in a worktree, it offers to remove that worktree + branch — otherwise it returns to `main` and deletes the goal's branch — and pulls the main checkout either way. It's gated like every other stage: `/dobby:commit`'s handoff question offers it once the PR is merge-ready, and nothing — the merge included — runs until you pick it.

**The push is guarded twice.** `/dobby:commit` never runs the gate by hand — `dobby ship` composes it in-process, and a red gate commits nothing — and the **pre-push backstop** (the git hook `dobby up` installs) re-runs it on `git push`, so a red tree can't reach the remote even when the commit happened outside the kit. The mechanized half of the convention rules rides the same path: they fire on every Edit/Write through the edit hook and again at push, so conformance no longer depends on a skill having been read.

**Shipping a version** is its own typed step, run from the **main checkout** after the PR merged: `/dobby:release` cuts one release through `dobby release` — preflights, version arithmetic, the manifest bump, the gate, publish, tag, GitHub release, smoke — stopping only for the two judgments a machine must not make alone (which version, and the release notes). Which channel it publishes to (npm or a Homebrew cask) is the `release` key in `dobby.config.json`; without that key the command doesn't exist.

Side paths, available at any point:

- `/dobby:prototype` — when a decision can't be settled with words, interview/research hand off to a throwaway prototype you can play with, then resume.
- `/dobby:diagnose` — when something breaks during execute (or any time), a disciplined hypothesis-driven debugging loop.
- `/dobby:dispatch` — the coordinator/worker machinery for a task too small to deserve a full planning session.
- `/dobby:address-review` — take a review bot's or reviewer's PR comments from posted to addressed + threads resolved + re-reviewed.
- `/dobby:handoff` — compact the session into an ephemeral fork document a fresh session can pick up (see [Context hygiene](#context-hygiene-fork-vs-continue)).
- `/dobby:trim-context` — rank files by weight and, after one up-front approval, reduce repository prose/comment context cost in unattended lots with an independently reviewed sweep ledger.
- `/dobby:anti-slop` — inventory and, after approval, make minimum contextual fixes to generic AI-writing patterns in prose and user-facing copy.

### Context hygiene: fork vs. continue

A long session accumulates dead context — resolved threads, abandoned branches, raw tool output — that quietly crowds out the room the architect needs to think. When context is getting long, the work spans days, or you're about to switch to a distinct sub-goal, don't just keep going: type `/dobby:handoff`. It writes an **ephemeral fork document** (to your OS temp dir) that summarizes where things stand, references the durable artifacts (`STATE.md`, PRDs, ADRs, diffs) by path instead of copying them, redacts secrets, and lists the `/dobby:*` skills to reach for next. Start a fresh session, point it at that document, and continue with a clean slate. The handoff is for **forking**, not durable record-keeping — decisions still land in `CONTEXT.md` / ADRs / commits.

## Your first session — end-to-end walkthrough

One concrete feature, carried through every stage: **adding CSV export to an admin users table**. Follow along to see what each command does, what you'll see, and what it leaves behind.

### 1. Scope

```
/dobby:scope add a CSV export button to the admin users table
```

The architect creates `STATE.md` at your repo root (the session's shared doc) and dispatches `dobby:researcher` to ground the goal: where the users table lives, which conventions the project uses, what the domain glossary and ADRs say. You don't wait on grepping — a worker does it, then the main thread reasons from its report.

**You'll see:** a short grounded summary ("the table is `src/admin/users/`, it uses the shared DataTable, exports don't exist anywhere yet"), then the handoff question: `/dobby:interview` recommended, with research or spec as the alternatives. There is no budget/profile question — every task runs through the same dispatch protocol.

**Artifact:** `STATE.md` with a filled `## Exploration` section.

### 2. Interview

The architect now interrogates you **in rounds**: each turn asks everything that's answerable right now — up to four questions in one popup, with any open-ended ones following as a numbered list you can answer in a single message. Every question is informed by research, restates its own context, and carries a recommended answer. Anything that depends on an answer you haven't given yet waits for the next round:

> Should the export respect the current filters and search, or always dump the full table? *(Recommended: respect filters — that's what the visible data implies.)*

Expect questions about edge cases you hadn't considered: empty results, the 50k-row tenant, who's allowed to export, date formatting, column selection. This is the kit's core bet: **misalignment is the most common failure mode**, so the interview doesn't stop until there's zero ambiguity — and it will refuse to end on a vague "anything else?" if open threads remain.

If a question can't be settled verbally ("which of these two layouts feels right?"), the interview sends you to type `/dobby:prototype` and resumes after you've played with the variants.

**Artifact:** `## Findings (interview)` in `STATE.md` — every decision, with the rejected alternative and the why.

### 3. Research

The architect fans researchers out (sized by its own judgment, not a fixed cap): one fetches current docs for the CSV library candidates (via `ctx7` — never from training data), another checks how streaming downloads work in your framework version, another looks for an existing export pattern in the codebase worth reusing. Their reports return to the main thread for synthesis.

**You'll see:** a tight research brief — key facts with doc sources, what to reuse, open questions flagged.

**Artifact:** `## Research` in `STATE.md`.

### 4. Spec

```
/dobby:spec
```

The architect turns decisions + research into a build plan. In a scoped session it persists into the existing `STATE.md`; for a genuinely standalone, already-understood task, `/dobby:spec` may initialize the same canonical state before writing the plan. Main runs `dobby spec lint`, fixes exact structural findings, and **prints the full plan in the conversation**—overview, edge cases, and a task table where every task carries its own *verify recipe*. Approval is a single tap (Aprobar / Ajustar); nothing builds until you approve.

**Artifact:** `## Spec` in `STATE.md`.

### 5. Execute

```
/dobby:execute
```

The coordinator makes sure the app is up — `/dobby:execute` runs `bunx dobby up --json`, then carries out its `instructions[]` (a named cmux pane, or a background `Bash` job) and re-invokes it to confirm the app is live — idempotent and liveness-first, so a re-run never double-starts — and that final call reports the live dev URL QA will share. The Architect then dispatches the plan's workers directly (the Agent tool, named `subagent_type`), following the shared dispatch protocol (`plugin/skills/execute/references/build-protocol.md`) for the whole approved plan — there is no separate execution engine underneath it, and no Workflow run to hand it to. A task starts the moment every task it depends on has reached `done`; there is no fixed batch boundary to wait on. Per task, **separate agents** run the build loop:

```
(test-author) → implement → Exit gate → QA proves behaviour → (defect? build conversation → re-verify) → done
```

The implementor runs its own **Exit gate** (`bunx dobby check --fix --baseline`) before handing off — the full quality gate, serialised to one implementor at a time across the shared tree — so QA only ever proves real behaviour and never re-runs lint/types/build/the suite. The leading test step is conditional: when the repo has a test suite and the spec marked a task test-first, a `dobby:test-author` writes the failing tests before the implementor touches the code. There is no fixed batch grouping tasks into waves — independent tasks keep running the moment they're ready, and a destructive task (one that mutates shared backend state during its proof) runs alone, with nothing else touching that state at the same time. A genuine defect QA finds opens a **build conversation** with the implementor, or the test-author when the failure traces to the tests rather than the implementation; the conversation is capped at five rounds, after which the task reports `needs-human` instead of retrying further. Every task that depended on a dead one is skipped as `blocked` — no agents spawned, the blocker named in its row — while everything independent of it keeps running. The normal loop deliberately has no per-task reviewer: after commit/push, the repository's external reviewer (currently Greptile) reviews the complete PR, and merge readiness requires a review of the current HEAD rather than a stale summary or silence.

**You'll see:** the Architect narrating the run live as it works — a line when each task starts, one line per task the moment it lands (`✓ verified`, `✗ needs-human`, `⊘ blocked`), a line per build-conversation round, and extra detail for a task in trouble — while `STATE.md` stays current as the run advances, so a compaction or a fresh session can reconstruct exactly where things stand. Once every task in the plan has reached a terminal status, the run closes with one summary table: rounds per task, first-attempt success, what died and why, and wall clock.

### 6. Wrap

```
/dobby:wrap
```

The closing pass: a short **human smoke test** (the few cross-task behaviors machines can't prove — you answer Pass/Fail/Skip, failures get dispatched to an implementor and re-presented), project docs reconciled (`CONTEXT.md` glossary terms the work introduced, ADRs the decisions earned), and `STATE.md` disposed — it's ephemeral by design.

Then comes `/dobby:commit`: it syncs the docs and authors the conventional-commit message + PR body, hands the ceremony to `dobby ship` (stage → gate → commit → push → PR, in one call), and stays on watch until the PR is merge-ready.

### 7. Finish

```
/dobby:finish
```

If the whole session ran inside a worktree you opened for this goal, once your PR is merge-ready one more step merges it and retires that worktree:

```
/dobby:scope … → interview → research → spec → execute → wrap → commit → /dobby:finish (merges, then tears down)
```

`/dobby:finish` confirms the PR is actually **merged** (if it's still open, closed, or the tree is dirty, it shows the state and asks before merging or destroying anything — on an open PR with a clean tree, "Merge & finish" is one of the options: it squash-merges once `dobby pr watch` reports merge-ready, then re-checks and continues), then runs `bunx dobby down` (teardown extras, kills the registered run process, deletes the Neon branch, hands back the instruction to close any cmux pane it opened); if the session stands in a worktree it then offers to remove that worktree and its branch, and if it's an **orphaned** worktree from a session that died before running `/dobby:finish`, it falls back to a raw-git cleanup after verifying the branch was merged and confirming with you — otherwise, on a plain checkout, it returns to `main` and deletes the goal's branch. Either way it pulls your main checkout.

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
| Context in repository docs/comments is bloated or stale | `/dobby:trim-context` — rank the whole workroot by weight, approve scope once, run unattended lots, then independently review the sweep and its ledger |
| Repository prose or user-facing copy sounds generic, vague, or AI-written | `/dobby:anti-slop` — make contextual, minimum fixes without judging authorship; it never changes comments |
| Context is getting long, or you want to branch a fresh session off a clean summary | `/dobby:handoff` — an ephemeral fork document |
| A merge/rebase left conflict markers you need to reconcile without losing either side | `/dobby:resolve-conflicts` |
| A brand-new empty repo | `/dobby:onboard` — scaffolds it and picks the issue tracker (GitHub Issues by default, or Linear / local `BACKLOG.md`) |
| A repo on an older dobby — or still on vite-plus / the legacy `.claude/commit.config.yml` | `/dobby:upgrade` — bumps to the latest and walks the per-version upgrade notes; a legacy repo is routed through `/dobby:migrate-config` (the one-time move onto `@kvnwolf/dobby` + `dobby.config.json`) |
| Work is done, ship it | `/dobby:commit` |
| The PR is merge-ready (or already merged) and the run/worktree needs retiring | `/dobby:finish` — it offers the merge, then cleans up |
| A merged version ready to publish | `/dobby:release` — from the main checkout; npm or a Homebrew cask, per `dobby.config.json`'s `release` key |
| A review bot or reviewer left comments on your PR | `/dobby:address-review` |
| Structuring or refactoring a module's files | `/dobby:module-conventions` (auto-activates) |
| Building a form or wiring a data mutation | `/dobby:data-processing` (auto-activates) |
| Wiring server data into a list/table | `/dobby:data-fetching` (auto-activates) |

Rule of thumb: if getting it wrong would cost you a rework cycle, it deserves a session (`scope`). If you could review the whole change in one glance, `dispatch` it.

### Inference sweeps: context trim and AI slop

`/dobby:trim-context` and `/dobby:anti-slop` are separate **inference-only** skills. They inspect the whole Git workroot, propose tiered batches or weighted lots, and need explicit approval before workers change human text. Neither is a Gate, runs the Gate, changes CLI/config/tooling behavior, stages, or commits; use the normal lifecycle to ship an approved sweep.

Choose `/dobby:trim-context` to reduce the **token/context cost** of repository guidance and comments while preserving their meaning and operational constraints. It is the sole owner of comment changes. Choose `/dobby:anti-slop` to improve **voice** in prose and user-facing copy through the smallest contextual fix; it never judges authorship, uses scores or banned-word quotas, or changes comments. When both apply, always run `/dobby:trim-context` first, then `/dobby:anti-slop` after the trim outcome is known.

Both skills keep their reviewed coverage in the tracked **Sweep ledger**, `.dobby/sweeps.json`. This ledger is the deliberate exception to the normal inference-only boundary: it records each reviewed file's exact final-byte hash and rules version, rather than adding a configurable or executable surface. Coverage is per file, per skill, and incremental — each file's entry can hold a `trim-context` sub-key, an `anti-slop` sub-key, or both; an unresolved file simply carries no sub-key for that skill, so partial coverage is recorded honestly instead of voiding the sweep, and each skill reads and writes only its own so the two sweeps coexist in the same repository without one invalidating the other's coverage.

## Convention skills

Three skills are **not** work-session stages — they're stack-convention guides that **auto-activate** while you build, encoding Kevin's standard application stack (TanStack Start + Drizzle/Neon + Better Auth, the `@/shared` form/data system). You never type them to advance a session; they fire when the work matches and reference the consuming project's module file conventions on purpose (deep-path imports and the role-based file taxonomy — no barrels):

- `/dobby:module-conventions` — the per-module file taxonomy: `{export}.server.ts` (eager server-only instance) · `functions.ts` (server fns + middlewares) · `{descriptor}.browser.ts` (browser code) · co-located `schema.gen.ts`, with the framework-enforced boundaries and env-as-single-source.
- `/dobby:data-processing` — the write side: form conventions (`useAppForm` from `@/shared/use-app-form`, Zod validation, field + dialog anatomy) plus mutation UX (submit-validated by default, optimistic only for in-place row toggles, type-to-confirm, toasts).
- `/dobby:data-fetching` — the read side: the TanStack DB recipe — session-guarded server fn → eager query collection → the `LiveQuery` component.

The half of those conventions a machine can decide is no longer only prose: it ships as **convention rules** in `dobby check` — native Biome rules, the `conventions` gate step (the filesystem facts a linter can't see: barrels, generic filenames, bucket directories, a table away from its module) and GritQL plugins for the structural shapes — all capability-gated to the stack, and firing at edit time through the hook and at push through the backstop. A deliberate exception suppresses per site with a reason (`// biome-ignore` for the Biome tiers, `// dobby-allow <RULE-ID>: <why>` for the `conventions` step), and directory-level findings (bucket dirs) fire on the full gate only — the edit hook never blocks an edit on its neighbourhood's pre-existing debt. Each skill annotates which of its rules are enforced that way; the rest are judgment calls the skill still has to teach.

## The artifacts: STATE.md

Every session writes one shared doc at the target repo's root. It's how stages hand off to each other and how a session survives interruptions:

```
STATE.md
├── ## Goal                   ← scope: the goal as you stated it
├── ## Source                 ← scope: where it came from (an issue, free text)
├── ## Exploration            ← scope: what the codebase says
├── ## Findings (interview)   ← interview: every decision + why
├── ## Research               ← research: the brief the plan consumes
├── ## Spec                   ← spec: the approved task table + verify recipes
└── ## Work log               ← execute: what each implementor actually did
```

Nobody hand-edits it: every write goes through `bunx dobby state` (`init` writes the seven-section skeleton and the `.gitignore` entry, `set <Section>` replaces exactly one body, `append-worklog --task <id>` appends one entry, `lint` checks the structure), so a stage can never clobber a sibling section. Old files with the retired `## Execution profile` remain readable: unknown sections are preserved and tolerated, but Dobby never creates, interprets, or deletes that legacy section automatically.

It is **never committed** — `/dobby:wrap` disposes it after reconciling the durable docs (`CONTEXT.md`, `CLAUDE.md`, ADRs).

## Also ships

- **Edit hook** — after every Edit/Write, runs `dobby check --hook` on the edited file in dobby projects (those with a `dobby.config.json` and a local `dobby` bin): biome's safe fixes are applied in place, plus a type check scoped to the file just edited (TypeScript has no per-file mode, so the hook runs `tsc` over the whole project and reports only the errors that land on this file), and only unfixable findings are surfaced back to the model (no-op everywhere else). The implementor's own Exit gate later runs the full gate on the whole tree before handing a task to QA.
- **Pre-push backstop** — a git `pre-push` hook, installed idempotently by `dobby up`'s setup phase (so it reaches every consumer, and one install covers every worktree). It runs `dobby check --pre-push` over what is being pushed and refuses the push on a red gate, printing every finding; a tree `dobby ship` already gated is skipped through the gate cache. Same double guard as the edit hook (dobby project + local bin, else silent no-op), it never modifies your files, and `git push --no-verify` bypasses it. A pre-push hook dobby did not write is never touched — `dobby up` reports it instead.

## Improving the kit from real sessions

dobby learns from how its own skills behave in the field. Two skills form the loop:

- `/dobby:mark` — run it in **any** consumer project when a dobby skill was rough. It prints a portable **session indicator**: a pointer to that session's transcript, its repo and worktree root, the still-on-disk `STATE.md` if present, the `/dobby:*` skills it invoked, and your note on what to fix.
- `/dobby:learn <indicator>` — run it **in the dobby repo**. It digests that session (via a `researcher`, never reading the multi-MB transcript whole) and turns the friction into concrete edits to the skill that underperformed.

These couple to Claude Code's session storage (`~/.claude/projects`) on purpose — they're kit-maintenance tooling, not part of a normal work session.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Agent type 'dobby:researcher'` (or another `dobby:*` agent) not found | Agents register at session startup | `/reload-plugins`; if that doesn't take, restart the session |
| `/dobby:*` skills don't show up | Plugin not enabled | `/plugin` → enable `dobby@dobby` (or reinstall) |
| Researchers cite stale/odd docs | `ctx7` CLI missing or unauthenticated | Install `ctx7`; set `CONTEXT7_API_KEY` for higher limits |
| Skill edits not picked up (local dev) | Only `SKILL.md` hot-reloads | `/reload-plugins` for agents/hooks changes |
| Post-edit check hook never fires | By design outside dobby projects | Needs `dobby.config.json` at the project root **and** a local `@kvnwolf/dobby` bin (run `/dobby:onboard`) |
| A hook blocked my `git push` | The pre-push backstop found a red gate on the tree being pushed | Read the findings it printed (they're the whole list, not a sample) and fix them — or, when you're pushing a WIP branch on purpose, `git push --no-verify` as a conscious bypass |
| Execute drifted from the loop logic | The dispatch protocol must be followed as written, not paraphrased | Re-run `/dobby:execute`; the skill's `references/build-protocol.md` is the canonical protocol |
| `portless` prompts for sudo / fails to bind `:443` on first run | First-time CA install + privileged port | Run `portless trust` once (surfaced by `/dobby:onboard`); it's a one-time setup, later runs don't need it |
| An old session died and left its worktree behind | The session couldn't run `/dobby:finish` before exiting | Run `/dobby:finish` anyway — it detects the orphan, checks the PR (offering the merge if it's still open), confirms with you, and cleans up via raw git |

## Recovery quick reference

- **Session interrupted during planning?** `STATE.md` is the source of truth. Start a fresh Claude Code session in the same worktree and re-invoke `/dobby:interview`, `/dobby:research`, or `/dobby:spec` as appropriate; the main-thread architect reconstructs the task from Goal, Source, Exploration, Findings, Research, Spec, and project context.
- **Want to revisit a decision?** Re-run `/dobby:interview`; it updates `## Findings` and downstream stages pick up the change.
- **A task came back `needs-human`?** Its build conversation exhausted five rounds without QA passing it (or a write-capable worker returned no usable work log). Read the reason in the status table, then `/dobby:diagnose` or `/dobby:dispatch` the fix.
- **A task came back `blocked`?** Nothing ran for it — one of its dependencies ended `needs-human`, and the run skips a task rather than build on a broken base. The status table names the blocker; fix that one first (`/dobby:diagnose` / `/dobby:dispatch`), and the blocked task becomes buildable again.
- **The session died mid-plan?** There is no separate run id to resume — recovery goes through `STATE.md`, which the dispatch protocol keeps current as the run advances (each task's status and which round of its loop it's on). Start a fresh session in the same worktree and re-run `/dobby:execute`; read `STATE.md` back to see which tasks already finished (their work-log entry is there) and which didn't, and dispatch only the unfinished ones.
- **Abandon a session?** Delete `STATE.md`. Nothing else was written outside the code changes themselves.

## Local development

```
claude --plugin-dir ./plugin
```

Skill edits hot-reload; agents and hooks need `/reload-plugins`.
