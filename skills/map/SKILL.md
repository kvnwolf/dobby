---
name: map
description: Turn a loose, multi-session idea into a durable decision-map — a git-tracked file of dependency-linked investigation tickets — then drive it toward a plan one ticket per cycle. Use when an idea is too big to interview-then-plan in one session, when open decisions block each other, or when the user says "map this out", "figure out the unknowns", "we need to research a few things first".
argument-hint: "[loose idea, or path to an existing map (+ optional ticket slug)]"
disable-model-invocation: true
model: opus
effort: max
---

Some ideas are too large to interview-then-plan in one sitting: the open decisions block each other and each needs its own investigation. A **decision-map** makes that tractable — a durable, git-tracked file of dependency-linked tickets you resolve one per cycle, pushing back the fog until the path to a plan is clear. You stay the architect: you build and update the map and synthesize each answer, but you **dispatch the actual investigation** to a worker or a stage — you never do the digging yourself.

Pairs with `/dobby:handoff` for the cross-session boundary: each cycle ends by clearing context and opening a fresh session on the next ticket.

## The decision-map

One compact Markdown file per planning effort, stored at `docs/maps/<effort-slug>.md` (create `docs/maps/` lazily on first write — no empty dir). It is the canonical artifact and git-tracked: the **whole map loads as context every cycle**, so keep it compact. Assets a ticket produces (a research summary, a prototype, a captured answer) are **linked by path, never copied in**.

### Ticket format

Each ticket is a section keyed by a short dash-case slug that reads as a mini-title (`relational-db`, `auth-strategy`, `cache-layer`) — terse, token-efficient, unique within the map.

```markdown
## relational-db: Relational or non-relational database?

Blocked by: <slug>, <slug>
Status: open | in-progress | resolved
Type: Research | Prototype | Grilling

### Question

<the open decision, stated sharply>

### Answer

<recorded when resolved — the verdict + why, with any asset linked by path>
```

The slug is the canonical id, used in every `Blocked by` edge and in prose. A ticket is **unblocked** when every ticket in its `Blocked by` list is `resolved`. Claim a ticket by setting `Status: in-progress` and **saving the map before any work** — so a parallel session skips it. Size each ticket to one focused investigation (~one agent session's worth).

### Ticket types → who investigates

You dispatch; you never investigate yourself. Each type routes to a dobby worker or stage:

| Type | Question it answers | Dispatch |
|------|---------------------|----------|
| **Research** | Needs knowledge outside the working tree — docs, third-party APIs, a knowledge base. Produces a linked markdown summary. | A `dobby:researcher` agent (Agent tool, `subagent_type: "dobby:researcher"`) — the same worker `/dobby:research` orchestrates. |
| **Prototype** | "How should it look / behave?" — answerable only by building throwaway code. | `/dobby:prototype` (state the ONE question; the prototype's captured answer is the asset). |
| **Grilling** | A decision resolvable by conversation. The default case. | `/dobby:interview` (dobby's grilling + domain-modeling), one question at a time. |

## Fog of war

The map is *deliberately* incomplete beyond the frontier — don't try to enumerate every decision up front. Resolve the frontier tickets; each answer reveals what's next. **One ticket per cycle**: resolve it, record it, then push the frontier — add the tickets the answer newly exposed (with correct `Blocked by` edges), and prune or rewrite any the answer invalidated. Repeat until the path to a plan is clear and no tickets remain.

## Two branches

Pick by the argument. Either branch **ends with a Handoff — never resolve more than one ticket per cycle.**

### Build the map (invoked with a loose idea)

1. Run a `/dobby:interview` pass to surface the open decisions (one question at a time). You may also dispatch a `dobby:researcher` for a quick lay-of-the-land if the idea leans on unfamiliar tech.
2. Write a new map at `docs/maps/<effort-slug>.md` — mostly fog: identify the frontier, add the tickets you can see with their `Blocked by` edges and `Type`, and resolve inline only the entries that are trivially decidable now.
3. Handoff. Building the map is one cycle's work — **do NOT also resolve tickets.**

### Work the map (invoked with a path to an existing map, optional ticket slug)

1. **Load the whole map** as context.
2. **Choose the ticket.** If the user named a slug, use it. Otherwise pick the first `open`, unblocked ticket in document order — you pick, not the user. **Claim it**: set `Status: in-progress` and save before any work.
3. **Resolve it** by dispatching per its `Type` (see the table). You synthesize the worker's/stage's return into an answer; you don't investigate in the main thread. If genuinely unsure of the type, treat it as Grilling (`/dobby:interview`).
4. **Record** the answer in the ticket's `### Answer`, link any asset by path, set `Status: resolved`, and save.
5. **Update the edges.** Add tickets the answer newly exposed (correct `Blocked by`); prune or rewrite any it invalidated.
6. Handoff.

Parallel sessions may work other unblocked tickets, so expect the map to have moved — re-read it, and rely on the claim (`in-progress` + save) to avoid collisions.

## Next steps (the Handoff)

Every cycle ends here. Pair with `/dobby:handoff` to clear context, then close with a typed **Next steps** block the user copy-pastes into fresh session(s) — plain text, NO AskUserQuestion, NO Skill-tool auto-invoke (typed entry re-applies this skill's own `model`/`effort`). Two cases:

**Open tickets remain.** List the currently-unblocked tickets, then give a bare command (you pick the next) plus one pinned command per unblocked ticket for running them in parallel — one line per fresh window.

> **Next steps** — 3 tickets unblocked: `auth-strategy`, `cache-layer`, `rate-limits`. Run `/dobby:handoff`, clear the context, then open fresh session(s):
>
> **One session** — resolves the next unblocked ticket:
> ```
> /dobby:map docs/maps/<effort-slug>.md
> ```
>
> **Parallel** — paste one line per window, up to all 3:
> ```
> /dobby:map docs/maps/<effort-slug>.md auth-strategy
> /dobby:map docs/maps/<effort-slug>.md cache-layer
> /dobby:map docs/maps/<effort-slug>.md rate-limits
> ```

**No open tickets remain.** The fog is pushed back — the path to a plan is clear and the map is done. (The initial interview may also surface no fog at all, in which case there was never a map to build.) Hand off to **`/dobby:spec`** to turn the resolved map into a build plan.

> **Next steps** — the map is fully resolved; the path is clear. Run:
> ```
> /dobby:spec
> ```

## Language

Interact with the user in their language. Write the map, tickets, and captured answers in English; keep domain terms in their real-world form.

## Acceptance checklist

- [ ] Correct branch taken (build-the-map for a loose idea; work-the-map for a path)
- [ ] Map lives at `docs/maps/<effort-slug>.md`, compact, assets linked-not-copied; `docs/maps/` created lazily
- [ ] Tickets use the format (`## slug: Title` + `Blocked by` + `Status` + `Type` + `### Question`/`### Answer`)
- [ ] Ticket claimed (`in-progress` + saved) before any work; exactly ONE ticket resolved this cycle
- [ ] Investigation dispatched by `Type` (Research→`dobby:researcher`, Prototype→`/dobby:prototype`, Grilling→`/dobby:interview`); architect synthesized, did NOT dig in the main thread
- [ ] Answer recorded, `Status: resolved`, frontier pushed (new tickets + edges added; invalidated ones pruned)
- [ ] Ended with a typed **Next steps** block (`/dobby:map …`, or `/dobby:spec` when no tickets remain); `/dobby:handoff` referenced for the cross-session boundary

---
*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `in-progress/decision-mapping`.*
