---
name: data-fetching
description: Recipe for client-side data fetching with TanStack DB — server function → Drizzle-derived query collection → LiveQuery. Use when adding data fetching, a new collection, or a list/table view.
---

## What the Gate now enforces

Rules below tagged `(enforced: Gate <id>)` are checked mechanically by `dobby check` on the stack path. The id is the convention inventory's ROW number, not a claim about the mechanism: `A*` rows mostly ship as native Biome rules, `B*` rows as the `conventions` filesystem scanner, `C*` rows as GritQL structural plugins — but a few rows moved tier without being renumbered (**A2** ships as a GritQL plugin; the cross-file **C2 / C3 / C12** ship as scanner checks).

- They surface **at edit time** (the PostToolUse hook reports findings on the file you just wrote) and again **at push** (the pre-push backstop refuses a red gate; `git push --no-verify` is the bypass).
- Every one is `error` severity, and the convention rules dobby ADDS carry no rewrite — `dobby check --fix` never rewrites convention code on their account. The already-enabled native Biome rules they ride alongside do apply their safe fix (A8 `useImportType` is corrected in place, at edit time too — the hook runs with `--write`).
- **Untagged rules are judgment.** Nothing checks them, so they hold only if you and review hold them. The conventions deliberately left unmechanized, each with its reason, are listed in `grit/CONTEXT.md` inside the `@kvnwolf/dobby` package — that list is the tier-(c) view, so it also names C2 / C3 / C12, which were re-landed as cross-file checks in the tier-(b) scanner (`src/conventions.ts` in the same package).

## Quick start

Three files per module, named by role (the taxonomy is in `/dobby:module-conventions`):

1. `module/functions.ts` — session-guarded server function returning plain rows
2. `module/collection.browser.ts` — eager TanStack DB query collection
3. The route — renders `<LiveQuery>` from `@/shared/live-query`

The first two are a PAIR — a `collection.browser.ts` with no sibling `functions.ts` is half a recipe _(enforced: Gate B6)_.

Writes ride the SAME pair: the collection's persistence handlers (`onInsert`/`onUpdate`/`onDelete`) call the module's server functions — the handler is the client-side calling convention for the server fn, adding optimistic apply + rollback-on-throw (see Step 4). What a handler must NEVER do is write storage directly (a client SDK, a raw `fetch`): the server fn IS the write path.

## Step 1: Server function (`module/functions.ts`)

```tsx
import { createServerFn } from "@tanstack/react-start";
import { asc } from "drizzle-orm";

import { requireAuth } from "@/auth/functions";
import { db } from "@/shared/db.server";

import { book } from "./schema";

export const listBooks = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () =>
    db
      .select({ id: book.id, title: book.title, createdAt: book.createdAt })
      .from(book)
      .orderBy(asc(book.title))
  );
```

- `requireAuth` is MANDATORY: server functions are publicly invokable HTTP endpoints — route guards do NOT protect them _(enforced: Gate C3 — the tier-(b) scanner check: a `createServerFn` chain in `functions.ts` with no `.middleware(…)` at all; which middleware it is stays your call)_. An endpoint that is public BY DESIGN (an anonymous intake read, a landing-page form) is blessed per chain: put `// dobby-allow C3: <why it is public>` in the comment block directly above the declaration — the annotation covers that chain only, never its neighbours.
- `db` is the eager instance from `@/shared/db.server` (no `getDb()` accessor) _(enforced: Gate A10; A6 — only `db` may be imported from that module)_. It's safe to import here because `functions.ts` only touches it inside the `.handler()` callback, which is DCE'd from the client bundle.
- The table comes from the owner module's co-located `schema.ts` / `schema.gen.ts` by relative path (`./schema`) — intra-module imports stay relative.
- Select ONLY the columns the UI needs; the collection schema must match this projection exactly _(enforced: Gate C12 — the tier-(b) cross-file check comparing the collection's `.pick({…})` keys with this `.select({…})`)_.

## Step 2: Collection (`module/collection.browser.ts`)

```tsx
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { QueryClient } from "@tanstack/react-query";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import { book } from "./schema";

import { listBooks } from "./functions";

// Server fns serialize Date → ISO string on the wire; coerce restores Dates.
const bookRowSchema = createSelectSchema(book, {
  createdAt: z.coerce.date(),
}).pick({ createdAt: true, id: true, title: true });

// Eager: TanStack DB's startSync defaults to false, so the query doesn't fetch
// until the first <LiveQuery> subscriber — constructing this in SSR is inert.
export const booksCollection = createCollection(
  queryCollectionOptions({
    getKey: (row) => row.id,
    queryClient: new QueryClient(),
    queryFn: () => listBooks(),
    queryKey: ["books"],
    schema: bookRowSchema,
  })
);
```

The collection is an eager `export const` initializer — no factory, no accessor _(enforced: Gate C10)_. It lives in a `.browser.ts` file because SSR-rendered routes import it. A value import of the server fn (`listBooks`) is fine; a server-only *instance* would need `import type` _(enforced: Gate C32)_. Callers import `booksCollection` by deep path — no barrel _(enforced: Gate C31)_.

### Input-scoped reads: the memoized per-input factory

When the server fn takes an input that scopes the rows (an `organizationId`, a parent id), the module-scope singleton is WRONG — it would have to fetch every scope the caller can see and filter client-side, and for a privileged caller that ships every tenant's rows into one browser to render one page. The input is a property of the read, so an input-taking fn needs a collection PER input value — memoized, because `<LiveQuery>` needs the SAME instance for the same input across renders or it would rebuild and resubscribe every render:

```tsx
const perOrg = new Map<string, ReturnType<typeof buildFor>>();

const buildFor = (organizationId: string) =>
  // biome-ignore lint/plugin/c10-collection-not-eager: per-org factory — a singleton would ship every org's rows to a privileged caller
  createCollection(
    queryCollectionOptions({
      getKey: (row: PersonRow) => row.personId,
      queryClient: new QueryClient(),
      queryFn: () => listPeople({ data: { organizationId } }),
      queryKey: ["people", organizationId],
      schema: personRowSchema,
    })
  );

export const peopleCollection = (organizationId: string) => {
  const hit = perOrg.get(organizationId);
  if (hit !== undefined) return hit;
  const built = buildFor(organizationId);
  perOrg.set(organizationId, built);
  return built;
};
```

This is NOT lazy-init-to-dodge-bundling (the shape Gate C10 rejects): `createCollection` doesn't fetch until a subscriber mounts, so an unvisited input's collection is inert. Gate C10 cannot tell the two shapes apart, so the sanctioned factory carries the named suppression shown above — with the reason, at the `createCollection` site. Never ship the factory WITHOUT the memo.

## Step 3: Consume with `<LiveQuery>`

```tsx
import { LiveQuery } from "@/shared/live-query";
import { booksCollection } from "@/books/collection.browser";

<LiveQuery
  fallback={skeleton}
  query={(q) =>
    q.from({ book: booksCollection })
      .orderBy(({ book }) => book.title, "asc")
  }
  retry={() => booksCollection.utils.clearError()}
>
  {(rows) =>
    rows.length === 0 ? <p>Empty-state copy.</p> : rows.map(/* … */)
  }
</LiveQuery>
```

- The four-part shape is mandatory: `fallback`, `query`, `retry`, and a children render _(enforced: Gate C13)_.
- `fallback` serves BOTH SSR (ClientOnly) and loading (Suspense) — build the skeleton to mirror the final layout (row count, line heights, paddings) so data arrival causes no layout shift.
- `children` receives `data` typed from the query and ALWAYS defined — no ready/loading checks.
- Page UI lives in the route file; the module exports only the data slice (server fn + collection) _(enforced: Gate A5 — a route file may not import the server graph)_.
- **`<LiveQuery>` is the boundary for EVERY read — even a single value in one cell.** ALWAYS consume collection data through the `<LiveQuery>` component, not just for full lists/tables. To render ONE derived value (e.g. looking up a related record's name for a cell or section), render a `<LiveQuery>` whose `children` returns that one value — empty/loading handled exactly the same way. Do NOT call the underlying `useLiveQuery` / `useLiveSuspenseQuery` hook directly in a component _(enforced: Gate A4+C15 — A4 bans the import, C15 the call, both outside `src/shared`)_: the component boundary is what handles SSR (ClientOnly), loading (Suspense `fallback`), empty, and error/retry; the raw hook bypasses all of that and produces stuck-skeleton / error-loop / 404 render bugs.

## Step 4: Writes — write-through persistence handlers

Mutations go through the collection, and the collection routes them to the module's server functions. The handler is the client-side calling convention for the server fn — nothing bypasses the server-fn path:

```tsx
export const booksCollection = createCollection(
  queryCollectionOptions({
    getKey: (row) => row.id,
    onInsert: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        const { title } = m.modified;
        // `id`/`createdAt` on the optimistic row are synthetic placeholders —
        // the post-handler refetch replaces them with the server-assigned row.
        await createBook({ data: { title } });
      }
    },
    onUpdate: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        // A single-field toggle (m.changes.active set) routes through its
        // minimal server fn; the full-field edit through the general one —
        // one onUpdate, two write paths, decided by the mutation's shape.
        const { active, id, title } = m.modified;
        if (m.changes.active !== undefined) {
          await setBookActive({ data: { active, id } });
          continue;
        }
        await updateBook({ data: { id, title } });
      }
    },
    queryClient: new QueryClient(),
    queryFn: () => listBooks(),
    queryKey: ["books"],
    schema: bookRowSchema,
  })
);
```

- The CALLER applies the write optimistically — `booksCollection.insert(row)` / `.update(id, …)` from the dialog or toggle — and the handler persists it by awaiting the server fn. A throw (validation, duplicate key) auto-rolls-back the optimistic row and rejects the transaction, so the form surfaces the error on its field.
- The handler returns nothing → the default post-handler refetch reconciles the optimistic row with the server-assigned one (real id, server timestamps).
- The write server fns live in the same `functions.ts` _(enforced: Gate C1)_, session-guarded _(enforced: Gate C3)_, and return the module's row projection — the write-model changes nothing about the module taxonomy.
- A handler that writes storage DIRECTLY (a client SDK, a raw `fetch`) is the shape to reject in review: it bypasses the server-fn path and its middleware.
- The form/dialog side of the write (validation, submit-validated dialogs, toasts) is `/dobby:data-processing`'s recipe — this skill owns the collection half.

## The collection is a wide interface — state its whole contract

A collection (plus its backing server fn) is the module's public data surface: every `<LiveQuery>` caller depends on it and NONE of them can see inside it. Treat it as a **wide interface** — a small surface (`xCollection`, imported by deep path) that hides a lot of behavior. Before shipping one, write down everything a caller must know so nobody has to read `functions.ts` to use it correctly:

- **Row shape** — the exact projection. It is fixed by the server fn's `.select({...})` and MUST match the collection's `.pick(...)` schema exactly _(enforced: Gate C12 — the tier-(b) cross-file key comparison)_; the row type IS the contract. Adding/removing a column is an interface change (every caller's `children` may break) — treat it as one.
- **Ordering** — whether rows arrive sorted, and by what. The server fn's `.orderBy(...)` is the source order; the `<LiveQuery>` `.orderBy(...)` re-sorts at the consumer. State which order callers can rely on so nobody re-sorts redundantly or assumes an order that isn't guaranteed.
- **Write surface** — read-only, or write-through (which of `onInsert`/`onUpdate`/`onDelete` exist, which server fn each routes to, and any shape-routed variant like the toggle branch). A caller must know whether `collection.insert(…)` persists or throws.
- **Invariants** — every row already passed `requireAuth` (never returns another tenant's/user's rows — the auth scope is part of the contract); timestamps are real `Date`s (already coerced from the wire), not ISO strings; keyed by `getKey` (unique, stable).
- **Error modes** — the fetch can fail (network / server-fn throw / schema-validation mismatch). The error surfaces at the `<LiveQuery>` boundary, and recovery is `utils.clearError()` via `retry` _(enforced: Gate C13 for the missing prop, C14 for an INLINE `retry` handler that never calls `.utils.clearError()`)_ — say so, because a caller who doesn't wire `retry` gets a stuck error loop.
- **Loading / empty** — empty is `rows.length === 0`, never `null`/`undefined`. Callers handle empty in `children`; loading is the `fallback`.

If naming this contract is nearly as much work as the implementation, the seam is too shallow.

## Gotchas

| Gotcha | Rule |
|--------|------|
| Dates over the wire | Server fns serialize `Date` → ISO string; override every timestamp column with `z.coerce.date()` or schema validation fails at runtime |
| Retry | `retry` must clear the collection's error (`utils.clearError()`) BEFORE the boundary resets, or the stored error rethrows in a loop _(enforced: Gate C14 — inline handlers only; a hoisted `retry={retryBooks}` is not checked)_ |
| Conditional queries | `useLiveSuspenseQuery` (inside LiveQuery) rejects disabled queries — gate with conditional RENDERING in the parent, never a query returning `undefined` |
| Alias shadowing | The query source alias (`q.from({ book: … })`) lives in the callback scope — avoid names that shadow route-scope variables |

## Realtime seam — hypothetical until a 2nd adapter lands

There is exactly ONE adapter today (`queryCollectionOptions`). A seam with one implementation is a guess about the future, not a real seam — do NOT build for the swap: no adapter-selection layer, no factory, no wrapper around `createCollection`. Write the collection against `queryCollectionOptions` directly, as Step 2 shows.

When a second adapter actually lands (e.g. ElectricSQL's `electricCollectionOptions`), the swap stays cheap because the interface above is the contract: replacing the adapter in `collection.browser.ts` changes nothing for `<LiveQuery>` consumers — row shape, ordering, invariants, and error modes hold, and the adapter lives entirely behind them. Introduce the seam then, and extend this skill at that point.

## Acceptance checklist

- [ ] Server fn in `module/functions.ts` _(enforced: Gate C1)_ with `requireAuth` middleware _(enforced: Gate C3, the tier-(b) check)_, selecting only needed columns, using the eager `db` from `@/shared/db.server` _(enforced: Gate A6+A10)_
- [ ] Collection in `module/collection.browser.ts` beside its `functions.ts` _(enforced: Gate B6)_: drizzle-zod schema with `z.coerce.date()` on timestamps, `.pick()` matching the server fn projection _(enforced: Gate C12, the tier-(b) check)_
- [ ] Eager collection (`export const xCollection = createCollection(...)`) — no lazy accessor; `startSync` default keeps SSR inert _(enforced: Gate C10; the memoized per-input factory is the one sanctioned exception, carrying the named suppression)_
- [ ] Writes (if any) go through persistence handlers that await the module's server fns — optimistic apply, rollback on throw, refetch reconcile; never a direct storage write from a handler
- [ ] Collection imported by deep path (`@/<module>/collection.browser`) _(enforced: Gate C31)_; route consumes through `<LiveQuery>` from `@/shared/live-query` _(enforced: Gate A4+C15)_
- [ ] `fallback` skeleton mirrors the final layout (no layout shift) — the prop's presence is checked _(enforced: Gate C13)_, the mirroring is not
- [ ] `retry={() => xCollection.utils.clearError()}` _(enforced: Gate C13+C14)_
- [ ] Empty state handled in `children`
