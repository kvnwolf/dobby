# CONTEXT.md Format

`CONTEXT.md` lives at the repo root and carries the project's domain language (its ubiquitous language). Skills read it to use terms exactly; wrap updates it as terms get resolved.

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple bounded contexts and the map points to where each `CONTEXT.md` lives. Single-context is the common case.

## Structure

```md
# {Context name}

{One or two sentences: what this context is and why it exists.}

## Language

**Order**:
A customer's request to purchase goods.
_Avoid_: purchase, transaction

**Invoice**:
A request for payment sent after delivery.
_Avoid_: bill, payment request

## Relationships

- An **Order** produces one or more **Invoices**

## Flagged ambiguities

- "account" was used for both **Customer** and **User** — resolved: they are distinct concepts.
```

## Rules

- **Be opinionated** — when several words mean the same concept, pick the best and list the rest as aliases to avoid.
- **Flag conflicts** explicitly under "Flagged ambiguities".
- **Tight definitions** — one sentence; define what it IS, not what it does.
- **Domain-only terms** — skip general programming concepts (timeouts, error types, utility patterns). Before adding a term, ask: is this concept unique to this domain?
- **Group under subheadings** when natural clusters emerge; a flat list is fine when there are few terms.
- **Show relationships** with bold term names and cardinality where obvious.

Don't couple CONTEXT.md to implementation detail — the audience is domain experts and future contributors who need vocabulary, not architecture.
