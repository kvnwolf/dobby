# Architecture Vocabulary

Shared vocabulary for plans, dispatch prompts, and discussions about code structure. Use these terms exactly — don't substitute "component", "service", "API", or "boundary". Consistent language is the whole point.

## Terms

**Module**
Anything with an interface and an implementation. Deliberately scale-agnostic — applies equally to a function, class, package, or tier-spanning slice.
_Avoid_: unit, component, service.

**Interface**
Everything a caller must know to use the module correctly. Includes the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics.
_Avoid_: API, signature (too narrow — those refer only to the type-level surface).

**Implementation**
What's inside a module — its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth**
Leverage at the interface — the amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface. A module is **shallow** when the interface is nearly as complex as the implementation.

**Seam** _(from Michael Feathers)_
A place where you can alter behaviour without editing in that place. The *location* at which a module's interface lives. Choosing where to put the seam is its own design decision, distinct from what goes behind it.
_Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter**
A concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside).

**Leverage**
What callers get from depth. More capability per unit of interface they have to learn. One implementation pays back across N call sites.

**Locality**
What maintainers get from depth. Change, bugs, knowledge, and verification concentrate at one place rather than spreading across callers. Fix once, fixed everywhere.

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, mockable, swappable parts — they just aren't part of the interface. A module can have **internal seams** (private to its implementation) as well as the **external seam** at its interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, the module wasn't hiding anything (it was a pass-through). If complexity reappears across N callers, the module was earning its keep.
- **The interface is the test surface.** Callers and verifications cross the same seam. If you want to verify *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it.

## Relationships

- A **Module** has exactly one **Interface** (the surface it presents to callers).
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.

## Module structure (organize for depth)

Make depth visible in the file tree — this is what makes a codebase navigable for humans AND AI agents. Apply from the plan's module boundaries through to implementation.

- **Organize by feature/domain, never by type.** No top-level `components/`, `services/`, `lib/`, `utils/` buckets that everything imports from — they produce a flat web of shallow modules with no groupings or relationships. Group by what the software *does*.
- **Each module is a self-contained folder** owning its slice end-to-end (UI, logic, types, tests co-located behind the module boundary).
- **Each module carries its own `CONTEXT.md`** — read on demand (not auto-loaded), it's the "interface at the top that explains the module": a one-line purpose, **Files** (one line each — intent, not implementation), **Interface** (the public surface in plain language), **Invariants** (load-bearing rules that must NOT change without thinking), and **What's intentionally NOT here** (every deferral). The root `CLAUDE.md`'s module map links to each module's `CONTEXT.md`.
- **No barrel — callers import by deep path.** A module exposes no single `index` entry point; each file is named by its role and imported directly, so the filename is the interface. (What a caller must know — the conceptual **Interface** above — still sits at the top of the module's `CONTEXT.md`.)
- **Inline by default.** Don't split a one-off sub-piece into its own file/folder until it's reused — keep it local. Avoid `-components/`-style scatter folders for single-use pieces.
- **~7-8 top-level chunks**, not hundreds of interrelated modules — the working-memory limit for navigating the system.
- **Grey-box rule:** you own the interface, the agent owns the implementation, tests keep it honest — once the behavior at the interface is verified, internals are free to change.

"What works for humans is also great for AI."
