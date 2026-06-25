---
name: data-fetching
description: Recipe for client-side data fetching with TanStack DB — session-guarded server function, query collection derived from the Drizzle schema, consumed via the LiveQuery component. Use when adding data fetching, a new collection, a list or table view, or wiring server data into the UI.
model: opus
effort: medium
---

## Quick start

Three files per module, named by role (the taxonomy is in `/dobby:module-conventions`):

1. `module/functions.ts` — session-guarded server function returning plain rows
2. `module/collection.browser.ts` — eager TanStack DB query collection
3. The route — renders `<LiveQuery>` from `@/shared/live-query`

Read-only by design: collections carry NO persistence handlers (`onInsert`/`onUpdate`/`onDelete`). Mutations are not part of this recipe yet — see What's NOT covered.

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

- `requireAuth` is MANDATORY: server functions are publicly invokable HTTP endpoints — route guards do NOT protect them.
- `db` is the eager instance from `@/shared/db.server` (no `getDb()` accessor). It's safe to import here because `functions.ts` only touches it inside the `.handler()` callback, which is DCE'd from the client bundle.
- The table comes from the owner module's co-located `schema.ts` / `schema.gen.ts` by relative path (`./schema`) — intra-module imports stay relative.
- Select ONLY the columns the UI needs; the collection schema must match this projection exactly.

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

It lives in a `.browser.ts` file because SSR-rendered routes import it. A value import of the server fn (`listBooks`) is fine; a server-only *instance* would need `import type`. Callers import `booksCollection` by deep path — no barrel.

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

- `fallback` serves BOTH SSR (ClientOnly) and loading (Suspense) — build the skeleton to mirror the final layout (row count, line heights, paddings) so data arrival causes no layout shift.
- `children` receives `data` typed from the query and ALWAYS defined — no ready/loading checks.
- Page UI lives in the route file; the module exports only the data slice (server fn + collection).

## Gotchas

| Gotcha | Rule |
|--------|------|
| Dates over the wire | Server fns serialize `Date` → ISO string; override every timestamp column with `z.coerce.date()` or schema validation fails at runtime |
| SSR safety | The eager collection is safe — `startSync` defaults to `false`, so it doesn't fetch until the first `<LiveQuery>` subscriber; SSR module-eval constructs nothing live |
| Auth | `requireAuth` middleware on every data server fn — they're public endpoints |
| Retry | `retry` must clear the collection's error (`utils.clearError()`) BEFORE the boundary resets, or the stored error rethrows in a loop |
| Conditional queries | `useLiveSuspenseQuery` (inside LiveQuery) rejects disabled queries — gate with conditional RENDERING in the parent, never a query returning `undefined` |
| Alias shadowing | The query source alias (`q.from({ book: … })`) lives in the callback scope — avoid names that shadow route-scope variables |

## Realtime seam

Collections are adapter-swappable: realtime later means replacing `queryCollectionOptions` with an ElectricSQL adapter (`electricCollectionOptions`) in `collection.browser.ts` — `<LiveQuery>` consumers don't change.

## What's NOT covered

Mutations / optimistic writes — no pattern exists yet. Extend this skill when the first write lands; until then collections stay read-only and writes go through server functions directly.

## Acceptance checklist

- [ ] Server fn in `module/functions.ts` with `requireAuth` middleware, selecting only needed columns, using the eager `db` from `@/shared/db.server`
- [ ] Collection in `module/collection.browser.ts`: drizzle-zod schema with `z.coerce.date()` on timestamps, `.pick()` matching the server fn projection
- [ ] Eager collection (`export const xCollection = createCollection(...)`) — no lazy accessor; `startSync` default keeps SSR inert
- [ ] No persistence handlers (read-only)
- [ ] Collection imported by deep path (`@/<module>/collection.browser`); route consumes through `<LiveQuery>` from `@/shared/live-query`
- [ ] `fallback` skeleton mirrors the final layout (no layout shift)
- [ ] `retry={() => xCollection.utils.clearError()}`
- [ ] Empty state handled in `children`
