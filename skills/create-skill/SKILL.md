---
name: create-skill
description: Creates or modifies agent skills, single- or multi-workflow (orchestrator). Use when the user wants a skill created, edited, or migrated between single and multi-workflow.
---

A skill exists to wrangle determinism out of a stochastic system; **predictability** — the agent taking the same _process_ every run, not producing the same output — is the root virtue, and every rule below is a lever on it. The craft vocabulary that names those levers lives in `references/craft-glossary.md`; reach for it when a review or a dispute turns on what a term means.

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

**Choosing invocation — the two loads.** Keeping a `description` makes the skill **model-invoked**: the agent can fire it autonomously and other skills can reach it, but it pays a **context load** — the description sits in the window every turn. Stripping it (`disable-model-invocation: true`) makes the skill **user-invoked**: zero context load, but it spends **cognitive load** — _you_ become the index that must remember it exists. Keep the description only when the agent must reach the skill on its own, or another skill must; if it only ever fires by hand, make it user-invoked and pay no context load. When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each.
- `argument-hint` / `arguments` — autocomplete hint and `$name` substitution in the body.
- `allowed-tools` / `disallowed-tools` — pre-approve or remove tools while the skill is active.
- `model` / `effort` — optional overrides, usually omitted; the skill runs on the session's model/effort unless you pin one deliberately (`effort` values: `low|medium|high|xhigh|max`).
- `paths` — globs that limit auto-activation to matching files; `context: fork` (+ `agent`) runs it in an isolated subagent.

Not skill fields: `version`, `license`, `metadata`, `min-version` belong to a plugin's `plugin.json`, not `SKILL.md`.

### Description rules

- Third person always — "Generates X", never "I help" or "You can use"
- First sentence = capability, second = "Use when [triggers]" — and front-load the skill's **leading word**; the description is where it does its invocation work
- **One trigger per branch.** Synonyms that rename a single branch are duplication ("create, write, author, scaffold" is one branch written four times) — collapse them; keep only genuinely distinct branches
- Cut identity that's already in the body — keep the description to triggers, plus any "when another skill needs…" reach clause
- Optionally add "Do not use for [X]" to reduce false positives
- <200 chars ideal, 1024 max
- **User-invoked skills** (`disable-model-invocation: true`): the description never enters the agent's context — write it human-facing, a one-line summary for the `/` menu, trigger lists stripped

```yaml
# Good — one trigger per branch
description: Generates conventional commit messages from staged changes. Use when committing or preparing a release.

# Bad — synonyms renaming one branch
description: Generates commit messages. Use when committing, writing a commit message, making a commit, or crafting commit text.

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
- **Sharp completion criteria** — every step ends on the condition that tells the agent it's done. Make it both _checkable_ (can the agent tell done from not-done?) and, where it matters, _exhaustive_ ("every modified model accounted for", not "produce a change list"). A vague bound invites premature completion — the agent slips to the next step before the work is genuinely finished.

### Progressive disclosure (3 levels)

Content loads lazily — put each thing at the cheapest level:
1. **Metadata** (`name` + `description`) — always preloaded for every skill (~100 tokens). This is what triggers loading.
2. **SKILL.md body** — loads only when the skill triggers; keep it under ~5k tokens. The recipe, not the encyclopedia.
3. **Resources** (`references/`, `scripts/`, `examples/`) — loaded only when the body points to them; effectively free until accessed. One level deep — never reference a reference.

A **context pointer** is the phrase that points the body at a resource, and its _wording_ — not its target — decides when and how reliably the agent reaches the material. A must-have target behind a weakly-worded pointer is a variance bug: name the trigger condition sharply ("when a dispute turns on what a term means, read X") rather than gesturing ("see X for details"). If a must-have still fires unreliably, sharpen the wording first and inline the material only if that fails.

**Branching is the cleanest disclosure test**: each distinct way the skill is used is a **branch** — different runs taking different paths. Inline what every branch needs; push behind a pointer what only some branches reach. And where the ladder decides how far _down_ a piece sits, **co-location** decides what sits _beside_ it: keep a concept's definition, rules, and caveats under one heading rather than scattered, so reading one part brings its neighbours with it.

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

### Leading words

A **leading word** is a compact concept already living in the model's pretraining that the agent thinks with while running the skill (e.g. _lesson_, _fog of war_, _tracer bullets_, _red_). Repeated as a token throughout the text (though a strong one may only need a single appearance), it accumulates a distributed definition and anchors a whole region of behaviour in the fewest tokens — recruiting priors the model already holds. It serves predictability twice: in the body it anchors _execution_ (the agent reaches for the same behaviour every time the word appears), and in the description it anchors _invocation_ (when the same word lives in your prompts, docs, and code, the agent links that shared language to the skill and fires it more reliably).

- **Prefer an existing pretrained word over a coined one.** A made-up term recruits no priors — you pay in definition tokens what a pretrained word gives free. Coin your own only when no pretrained word fits, and then define it clearly.
- **Hunt for restatements a leading word retires.** A quality spelled out three ways ("fast, deterministic, low-overhead") collapses into one pretrained word (a _tight_ loop); a fuzzy gate ("a loop you believe in") sharpens into a binary observable (the loop goes _red_, or it doesn't). Fewer tokens _and_ a sharper hook.

### The no-op test

Hunt no-ops sentence by sentence, not just line by line. For each sentence in isolation: **does it change behaviour versus the model's default? If not, delete the WHOLE sentence** — don't trim words from it. Be aggressive; most prose that fails the test should go, not be rewritten. This is model-relative, not reader-relative: if two people disagree over whether a line is a no-op, they disagree about the model's default — **settle it by running the skill, not by debating.** A weak leading word (_be thorough_ when the agent is already thorough-ish) is itself a no-op; the fix is a stronger word (_relentless_), not a different technique.

## Step 4: Organize the directory

### Single-workflow vs multi-workflow skills

Most skills are **single-workflow** — one SKILL.md covers one concern. Use this by default.

A **multi-workflow skill** is needed when a single domain has multiple distinct procedures that share a description trigger. SKILL.md becomes a router that dispatches to internal flows based on the task. Each flow is a self-contained mini-skill inside `flows/`.

**Any split must earn one of the two loads.** Split **by invocation** only when the piece has a distinct leading word that should trigger it on its own, or another skill must reach it — the new always-loaded description costs context load. Split **by sequence** when the steps still ahead (post-completion steps) tempt the agent to rush the one in front of it — hiding them buys legwork on the current task.

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

## Step 6: Audit for failure modes

Before finishing, scan the skill for the five named failure modes. Each has a defence — apply it:

- **Premature completion** — a step ends before it's genuinely done because attention slips to _being done_. Sharpen the completion criterion first (cheap, local); only if it's irreducibly fuzzy _and_ you observe the rush, hide the later steps by splitting the sequence.
- **Duplication** — the same meaning in more than one place. Costs maintenance and tokens, and inflates that meaning's rank past its real weight. Keep each meaning in a single source of truth. (Distinct from a leading word, which repeats a _token_ on purpose, never the meaning.)
- **Sediment** — stale layers that settle because adding feels safe and removing feels risky. The default fate of any skill without a pruning discipline; core down and clear it.
- **Sprawl** — the skill is simply too long, even when every line is live and unique. Cure with the disclosure ladder: push reference behind a context pointer, and split by branch or sequence so each path carries only what it needs.
- **No-op** — a line the model already obeys by default, so you pay load to say nothing. Run the no-op test (above) sentence by sentence and delete what fails.

## Acceptance checklist

- [ ] Description: third person, one trigger per branch (synonyms collapsed), leading word front-loaded; human-facing one-liner if user-invoked
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
- [ ] Audited for the five failure modes (premature completion, duplication, sediment, sprawl, no-op)
- [ ] Every sentence passes the no-op test (changes behaviour vs the model's default)

---

*Predictability framing, craft glossary, leading words, the no-op test, and the failure-mode catalog adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `productivity/writing-great-skills`.*
