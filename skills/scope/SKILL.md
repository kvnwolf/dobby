---
name: scope
description: Start a work session — take the goal (a free-text prompt, a Linear ticket, or a GitHub issue), create the shared work-session doc, and explore the codebase so the work is grounded before interviewing or planning. Use at the start of any feature, fix, or refactor, or when handed a ticket to work on.
argument-hint: "[goal, Linear ticket id/URL, or GitHub issue]"
model: opus
effort: high
---

The front door of a work session. Normalize the goal, create the shared work-session doc, and map the relevant code — so every later stage (interview → research → spec → execute → wrap) has grounding and one place to persist its output.

## Step 1: Normalize the input into a goal

The argument (or conversation) is one of:

- **Free-text prompt** — use it as the goal directly.
- **Linear ticket** (an id like `ABC-123` or a Linear URL) — fetch it via the Linear MCP (authenticate if needed) and use its title + description as the goal.
- **GitHub issue** (`#123` or a URL) — fetch it via `gh` and use it as the goal.

If the input is empty, ask in plain text (not AskUserQuestion) what the user wants to work on.

## Step 2: Create the work-session doc

Create an ephemeral `STATE.md` at the repo root with this skeleton — the shared spine every later stage appends to. Add it to `.gitignore` if it isn't already: it's working memory, not a committed artifact (`/dobby:wrap` disposes of it at the end).

```md
# Work session: <goal title>

## Goal
<the goal>

## Source
<prompt | Linear ABC-123 | GitHub #123>

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

## Step 3: Explore the codebase

Dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to ground the work — you don't grep in the main thread. Have it map what the goal touches (existing modules, conventions, how similar things are structured, where this fits), read the root `CONTEXT.md` (domain glossary) + the `CONTEXT.md` of any module the goal touches (each has its own — they're not auto-loaded), and skim `docs/adr/` if present, reporting any constraints. Respect the project's structure (deep, feature/domain modules — see the architecture vocabulary; don't assume type-based folders). On a greenfield repo there may be little to find — that's fine. The researcher returns a grounded findings report.

## Step 4: Checkpoint and record

Present a concise summary to the user (relevant code areas, patterns, how the goal fits) so they can correct misunderstandings early. Write that summary into the doc's `## Exploration` section.

## Next step

End with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke. The next stage must be TYPED by the user: typed entry applies the next skill's own `model`/`effort`; an auto-invoked skill rides the current turn's override instead. State the recommended command first (with why), then the alternatives; on stop, point to where this stage's output lives (e.g. `STATE.md`).

- **`/dobby:interview`** *(Recommended)* — align on the details before planning.
- `/dobby:research` — if the goal leans on external tech you'd want current docs for first.
- `/dobby:spec` — skip ahead to planning if the task is already well-understood.
- **Stop here.**

## Language

Interact with the user in their language. Write what you persist — `STATE.md` and any docs — in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Goal normalized (prompt / Linear / GitHub); asked if empty
- [ ] `STATE.md` created at the repo root (and gitignored) with the skeleton; `## Goal` + `## Source` filled
- [ ] Codebase explored with a `researcher` agent; `CONTEXT.md` + ADRs read if present
- [ ] Exploration summary shown to the user and written into `## Exploration`
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
