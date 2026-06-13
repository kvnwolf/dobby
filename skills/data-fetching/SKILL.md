---
name: data-fetching
description: Recipe for client-side data fetching with TanStack DB — session-guarded server function, query collection derived from the Drizzle schema, consumed via the LiveQuery component. Use when adding data fetching, a new collection, a list or table view, or wiring server data into the UI.
model: opus
effort: medium
---

## Quick start

Three files per module, in this order:

1. `module/server.ts` — session-guarded server function returning plain rows
2. `module/collection.ts` — TanStack DB query collection + lazy accessor
3. The route — renders `<LiveQuery>` from `@/shared`

Read-only by design: collections carry NO persistence handlers (`onInsert`/`onUpdate`/`onDelete`). Mutations are not part of this recipe yet — see What's NOT covered.

## Step 1: Server function (`module/server.ts`)

```tsx
import { createServerFn } from "@tanstack/react-start";
import { asc } from "drizzle-orm";

import { requireAuth } from "@/auth";
import { book, getDb } from "@/db";

export const listBooks = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () =>
    getDb()
      .select({ id: book.id, title: book.title, createdAt: book.createdAt })
      .from(book)
      .orderBy(asc(book.title))
  );
```

- `requireAuth` is MANDATORY: server functions are publicly invokable HTTP endpoints — route guards do NOT protect them.
- Select ONLY the columns the UI needs; the collection schema must match this projection exactly.

## Step 2: Collection (`module/collection.ts`)

```tsx
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { QueryClient } from "@tanstack/react-query";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import { book } from "@/db";

import { listBooks } from "./server";

// Server fns serialize Date → ISO string on the wire; coerce restores Dates.
const bookRowSchema = createSelectSchema(book, {
  createdAt: z.coerce.date(),
}).pick({ createdAt: true, id: true, title: true });

const buildBooksCollection = () =>
  createCollection(
    queryCollectionOptions({
      getKey: (row) => row.id,
      queryClient: new QueryClient(),
      queryFn: () => listBooks(),
      queryKey: ["books"],
      schema: bookRowSchema,
    })
  );

let collection: ReturnType<typeof buildBooksCollection> | undefined;

// Lazy module singleton: NOTHING constructs at import time, so SSR never
// touches it — callers only invoke this in the browser (inside <LiveQuery>).
export const getBooksCollection = () => (collection ??= buildBooksCollection());
```

Export the accessor through the module barrel.

## Step 3: Consume with `<LiveQuery>`

```tsx
import { LiveQuery } from "@/shared";
import { getBooksCollection } from "@/books";

<LiveQuery
  fallback={skeleton}
  query={(q) =>
    q.from({ book: getBooksCollection() })
      .orderBy(({ book }) => book.title, "asc")
  }
  retry={() => getBooksCollection().utils.clearError()}
>
  {(rows) =>
    rows.length === 0 ? <p>Empty-state copy.</p> : rows.map(/* … */)
  }
</LiveQuery>
```

- `fallback` serves BOTH SSR (ClientOnly) and loading (Suspense) — build the skeleton to mirror the final layout (row count, line heights, paddings) so data arrival causes no layout shift.
- `children` receives `data` typed from the query and ALWAYS defined — no ready/loading checks.
- Page UI lives in the route file; the module exports only the data slice (server fn + collection accessor).

## Gotchas

| Gotcha | Rule |
|--------|------|
| Dates over the wire | Server fns serialize `Date` → ISO string; override every timestamp column with `z.coerce.date()` or schema validation fails at runtime |
| SSR safety | Collection + its QueryClient construct lazily on first accessor call — NEVER at module import |
| Auth | `requireAuth` middleware on every data server fn — they're public endpoints |
| Retry | `retry` must clear the collection's error (`utils.clearError()`) BEFORE the boundary resets, or the stored error rethrows in a loop |
| Conditional queries | `useLiveSuspenseQuery` (inside LiveQuery) rejects disabled queries — gate with conditional RENDERING in the parent, never a query returning `undefined` |
| Alias shadowing | The query source alias (`q.from({ book: … })`) lives in the callback scope — avoid names that shadow route-scope variables |

## Realtime seam

Collections are adapter-swappable: realtime later means replacing `queryCollectionOptions` with an ElectricSQL adapter (`electricCollectionOptions`) in `collection.ts` — `<LiveQuery>` consumers don't change.

## What's NOT covered

Mutations / optimistic writes — no pattern exists yet. Extend this skill when the first write lands; until then collections stay read-only and writes go through server functions directly.

## Acceptance checklist

- [ ] Server fn in `module/server.ts` with `requireAuth` middleware, selecting only needed columns
- [ ] Collection in `module/collection.ts`: drizzle-zod schema with `z.coerce.date()` on timestamps, `.pick()` matching the server fn projection
- [ ] Lazy singleton accessor (`getXCollection()`) — nothing constructs at import
- [ ] No persistence handlers (read-only)
- [ ] Accessor exported via the module barrel; route consumes through `<LiveQuery>` from `@/shared`
- [ ] `fallback` skeleton mirrors the final layout (no layout shift)
- [ ] `retry={() => getXCollection().utils.clearError()}`
- [ ] Empty state handled in `children`
