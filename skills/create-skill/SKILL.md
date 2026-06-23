---
name: create-skill
description: Creates or modifies agent skills, including single-workflow and multi-workflow (orchestrator) skills. Use when the user wants to create, write, author, scaffold, edit, update, fix, or refactor a skill, or migrate a skill from single to multi-workflow.
model: opus
effort: max
---

## Step 1: Gather context

Ask the user what the skill should do, when it should activate, and any conventions it should follow.

## Step 2: Write the frontmatter

Only `name` and `description` loaded at startup — agent decides whether to load the skill based on description alone.

```yaml
---
name: kebab-case-name
description: [What it does, third person]. Use when [activation triggers].
---
```

`name` and `description` are the only required fields. Many optional fields control invocation, tools, model, effort, and activation — see `references/frontmatter.md` for the full verified set. Most common:

- `disable-model-invocation: true` — only the user can invoke (`/name`); use for side-effect or deliberate skills.
- `user-invocable: false` — hidden from the `/` menu; only the model invokes it (background knowledge).
- `argument-hint` / `arguments` — autocomplete hint and `$name` substitution in the body.
- `allowed-tools` / `disallowed-tools` — pre-approve or remove tools while the skill is active.
- `model` / `effort` — override model or reasoning effort (`low|medium|high|xhigh|max`) for the skill's turn.
- `paths` — globs that limit auto-activation to matching files; `context: fork` (+ `agent`) runs it in an isolated subagent.

Not skill fields: `version`, `license`, `metadata`, `min-version` belong to a plugin's `plugin.json`, not `SKILL.md`.

### Description rules

- Third person always — "Generates X", never "I help" or "You can use"
- First sentence = capability, second = "Use when [triggers]"
- Include synonyms and colloquial phrasing to maximize activation surface
- Optionally add "Do not use for [X]" to reduce false positives
- <200 chars ideal, 1024 max

```yaml
# Good
description: Generates conventional commit messages from staged changes. Use when committing code, writing commit messages, or preparing a release.

# Bad — vague
description: Helps with git stuff.

# Bad — first person
description: I can help you write commit messages.
```

## Step 3: Write the body

Sacrifice grammar for concision and scannability. Every line must justify its token cost — only include what the agent doesn't already know.

### Principles

- **Freedom matching** — prescriptive for fragile ops, flexible for open-ended tasks
- **Examples over rules** — concrete input/output pairs teach better than abstract descriptions
- **No over-explaining** — the agent knows what PDFs are, how imports work, etc.

### Progressive disclosure (3 levels)

Content loads lazily — put each thing at the cheapest level:
1. **Metadata** (`name` + `description`) — always preloaded for every skill (~100 tokens). This is what triggers loading.
2. **SKILL.md body** — loads only when the skill triggers; keep it under ~5k tokens. The recipe, not the encyclopedia.
3. **Resources** (`references/`, `scripts/`, `examples/`) — loaded only when the body points to them; effectively free until accessed. One level deep — never reference a reference.

### Format

- `##` headings for steps or sections
- Procedural skills: `## Step N: [Action]`
- Reference skills: `## Quick Start` → `## Patterns` → `## Advanced`
- Before/after examples for transformations
- Tables for quick-reference lookups
- Checklists for complex multi-step workflows
- Always end with `## Acceptance checklist` — agent verifies all steps completed before finishing
- Consistent terminology — one term per concept
- No time-sensitive info
- Reference paths as inline code: `references/foo.md`, never markdown links

See `examples/` for complete skill examples by type:

| Example | When to use |
|---------|-------------|
| `examples/minimal.md` | Simple single-file skill, no folders |
| `examples/procedural.md` | Defined steps, defined outputs |
| `examples/open-ended-with-examples.md` | Output varies by use case |
| `examples/with-scripts.md` | Deterministic operations |
| `examples/with-references.md` | Conditional/alternate flows |
| `examples/reference-style.md` | Knowledge base, no steps |
| `examples/combined.md` | Scripts + examples + references |

## Step 4: Organize the directory

### Single-workflow vs multi-workflow skills

Most skills are **single-workflow** — one SKILL.md covers one concern. Use this by default.

A **multi-workflow skill** is needed when a single domain has multiple distinct procedures that share a description trigger. SKILL.md becomes a router that dispatches to internal flows based on the task. Each flow is a self-contained mini-skill inside `flows/`.

Use multi-workflow when:
- The domain has 3+ distinct procedures (e.g., setup, create route, data fetching)
- Procedures are independent — running one doesn't require another
- A single description can't cover all procedures without being vague

Migrate from single to multi when:
- SKILL.md exceeds 500 lines even after splitting into references
- The skill covers multiple unrelated procedures under one domain

**Keep the description in sync** — when flows are added, modified, or removed, update SKILL.md's description to reflect current capabilities.

For full structure and conventions, see `references/orchestrator.md`.

### Single-workflow structure

```
skill-name/
├── SKILL.md           # Required — ≤500 lines (keep it tight)
├── scripts/           # Optional — deterministic executable code
│   └── setup.ts
├── examples/          # Optional — sample output per use case
│   ├── bug-fix.md
│   └── refactor.md
└── references/        # Optional — conditional flows, on-demand
    └── advanced.md
```

### scripts/

Deterministic, repeatable operations (validation, scaffolding, setup). Executed, not read — code never enters context, only output.

- Run with `bun`: `bun scripts/setup.ts`
- Name by function: `validate_form.ts`, `scaffold.ts`
- Handle errors explicitly — never delegate to agent

### examples/

Sample files for open-ended output not fully defined in SKILL.md. One file per use case.

- NOT needed for closed procedures where output is specified in steps
- Reference: "See `examples/` for sample outputs"

### references/

Conditional flows, alternate paths, domain knowledge not always needed. Loaded on-demand — zero tokens until needed.

- One level deep — never reference a reference
- TOC for files >100 lines

## Step 5: Place and scope the skill

Where the directory lives determines reach:

- **Personal** — `~/.claude/skills/<name>/SKILL.md`: available across all your projects.
- **Project** — `.claude/skills/<name>/SKILL.md`: shared with the repo via git.
- **Plugin** — `<plugin>/skills/<name>/`: namespaced as `/plugin-name:skill-name`, can't collide.

The **directory name** is the command name (`~/.claude/skills/deploy-staging/` → `/deploy-staging`); the frontmatter `name` only sets the display label for directory-based skills. On name conflicts, precedence is enterprise > personal > project; plugins are namespaced so they never conflict. Edits under these directories are picked up **in the current session** (live reload); run `/reload-skills` to force a re-scan, or `/reload-plugins` for a plugin's non-`SKILL.md` files (hooks, MCP, agents).

## Acceptance checklist

- [ ] Description: third person, specific, activation triggers
- [ ] Frontmatter uses only valid skill fields (see `references/frontmatter.md`); no plugin-only fields (version/license/metadata)
- [ ] Only info the agent doesn't already know
- [ ] Concise, scannable, no unnecessary prose
- [ ] Concrete examples, consistent terminology
- [ ] No time-sensitive info
- [ ] <200 lines or split into references/examples
- [ ] scripts/ run with `bun`, handle errors
- [ ] examples/ only for open-ended output
- [ ] references/ only for conditional flows
- [ ] Paths as inline code, no markdown links
- [ ] Ends with `## Acceptance checklist`
- [ ] Multi-workflow: description reflects all current flows
