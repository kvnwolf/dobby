---
name: scope
description: Start a work session — normalize the goal (free-text prompt or GitHub issue) and ground it in the codebase before interviewing or planning. Use at the start of any feature, fix, or refactor, or when handed a ticket to work on.
argument-hint: "[goal, or GitHub issue #/URL]"
model: opus
effort: high
---

The front door of a work session. Normalize the goal, create the shared work-session doc, and map the relevant code — so every later stage (interview → research → spec → execute → wrap) has grounding and one place to persist its output.

## Step 1: Normalize the input into a goal

The argument (or conversation) is one of:

- **Free-text prompt** — use it as the goal directly.
- **GitHub issue** (`#123` or a URL) — fetch it via `gh` and use it as the goal. You're starting work on it, so **claim it**: `gh issue edit <n> --add-assignee @me --add-label status:in-progress` (create the label lazily if missing: `gh label create status:in-progress 2>/dev/null || true`). This signals "someone's on it" so a parallel session doesn't double-take it, and lets `/dobby:commit` add `Closes #<n>` so the merge closes it.

If the input is empty, ask in plain text (not AskUserQuestion) what the user wants to work on.

## Step 2: Create the work-session doc

Create an ephemeral `STATE.md` at the repo root with this skeleton — the shared spine every later stage appends to. Add it to `.gitignore` if it isn't already: it's working memory, not a committed artifact (`/dobby:wrap` disposes of it at the end).

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

## Step 3: Explore the codebase

Dispatch a `researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) to ground the work — you don't grep in the main thread. Have it map what the goal touches (existing modules, conventions, how similar things are structured, where this fits), read the root `CONTEXT.md` (domain glossary) + the `CONTEXT.md` of any module the goal touches (each has its own — they're not auto-loaded), and skim `docs/adr/` if present, reporting any constraints. Respect the project's structure (deep, feature/domain modules per `/dobby:spec`'s `references/architecture-vocab.md`; don't assume type-based folders). On a greenfield repo there may be little to find — that's fine. The researcher returns a grounded findings report.

**Cross-reference the goal against the code — don't just map files.** Instruct the researcher to validate the goal's claims against what the code actually does and to report every contradiction as a finding (e.g. "you said cancellation is per-line, but the code cancels whole Orders — which is right?") so the checkpoint can resolve it before it propagates into the interview and spec. The goal is often written from an outdated mental model; the code is the ground truth. A wrong premise caught here is cheap; caught at execute it is expensive.

**Context-budget the digest.** The exploration output shares one architect window with the interview and spec. If the goal touches a large surface, tell the researcher to return a COMPRESSED digest (the load-bearing modules, conventions, constraints, and contradictions — named, not dumped) rather than an exhaustive file-by-file transcript. If a full map is genuinely needed, have the researcher write it to a path and return a pointer plus the digest.

## Step 4: Checkpoint and record

Present a concise summary to the user (relevant code areas, patterns, how the goal fits) so they can correct misunderstandings early. Write that summary into the doc's `## Exploration` section.

## Next step

End with a plain-text handoff — NO AskUserQuestion for this gate, NO Skill-tool auto-invoke. The next stage must be TYPED by the user: typed entry applies the next skill's own `model`/`effort`; an auto-invoked skill rides the current turn's override instead. On stop, point to where this stage's output lives (e.g. `STATE.md`).

**Route by goal shape — don't always recommend `/dobby:interview`.** Read the goal (and what the exploration surfaced) and recommend the branch that fits the WORK, not a fixed default:

- **Bug / something is broken** (a reproducible failure, a red test, a regression) → recommend **`/dobby:diagnose`**. Grilling requirements is the wrong tool for a defect; the loop needs a red-capable command, not an interview.
- **Refactor / structural change** (reshape without changing behavior — extract a module, fix a leaky seam, reduce sprawl) → recommend **`/dobby:improve-architecture`**. The design questions are about structure, not product requirements.
- **Feature / new or changed behavior** (the shape of what to build is still open) → recommend **`/dobby:interview`** to align on details before planning.
- **Already well-understood** (any shape) → the task may be ready to plan directly — offer `/dobby:spec` as the fast path.

Recommend ONE branch as the primary (with why, keyed to the goal shape you detected), and list the others as alternatives — plus `/dobby:research` (if the goal leans on external tech you'd want current docs for first) and **Stop here** — the user still types the choice. When the goal is mixed or the shape is genuinely ambiguous, say so and default to `/dobby:interview` to disambiguate.

## Language

Interact with the user in their language. Write what you persist — `STATE.md` and any docs — in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Goal normalized (prompt / GitHub); asked if empty
- [ ] If the goal is a GitHub issue: claimed it (`--add-assignee @me --add-label status:in-progress`, label created lazily)
- [ ] `STATE.md` created at the repo root (and gitignored) with the skeleton; `## Goal` + `## Source` filled
- [ ] Codebase explored with a `researcher` agent; `CONTEXT.md` + ADRs read if present
- [ ] Researcher cross-referenced the goal's claims against the code and surfaced contradictions (not just a file map)
- [ ] Exploration returned as a compressed, context-budgeted digest (depth on what matters; pointer for a full map if needed)
- [ ] Exploration summary shown to the user and written into `## Exploration`
- [ ] Next step routed by goal shape (bug→`/dobby:diagnose`, refactor→`/dobby:improve-architecture`, feature/ambiguous→`/dobby:interview`), not a fixed default
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)
