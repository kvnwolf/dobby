---
name: module-conventions
description: The per-module file-type convention for this stack (TanStack Start + Drizzle/Neon + Better Auth) — which file each piece of code belongs in (.server.ts instance · functions.ts server fns · .browser.ts browser code · schema.gen.ts · collection.browser.ts), the framework-enforced boundaries, deep-path imports (no barrels), eager instances, env as single source. Use when creating or refactoring a module, deciding where a piece of code goes, adding a server function, a server-only instance, or a browser client, co-locating a Drizzle schema, or structuring a new feature slice.
model: opus
effort: medium
---

Every module is a deep, contained folder reached by **deep path** — there is NO `index.ts` barrel. Files are named by their ROLE, so the layout is identical across modules and **the filename is the interface**. The `.server.ts`/`.browser.ts` suffixes are framework-enforced compile boundaries, not naming habits.

## Quick start — the file taxonomy

| Role | File | Boundary | Examples |
|------|------|----------|----------|
| Server-only eager instance / server-only logic | `{descriptor}.server.ts` — _Avoid_: `service.ts`, `db.ts`, `lib.ts` (no boundary; drags Pool/secrets into the client bundle) | `.server.*` ENFORCED — a client import is a **build error** | `auth/auth.server.ts`, `shared/db.server.ts`, `notifications/send.server.ts` |
| Server functions (`createServerFn`) + their middlewares | `functions.ts` — _Avoid_: `api.ts`, `actions.ts`, `handlers.ts` (obscures the isomorphic-DCE contract) | isomorphic (no suffix) | `auth/functions.ts`, `users/functions.ts` |
| Browser-only code that SSR routes import | `{descriptor}.browser.ts` — _Avoid_: `{descriptor}.client.ts` (looks like a boundary suffix but TanStack Start enforces none — a false compile guarantee), `hooks.ts`, `utils.ts` | none — **NOT `.client.ts`** | `auth/client.browser.ts`, `users/collection.browser.ts` |
| Drizzle tables (hand-written / generated) | `schema.ts` / `schema.gen.ts` — _Avoid_: `models.ts`, `tables.ts`, `entities.ts` (the drizzle-kit glob only finds `schema*`) | co-located, found by a drizzle-kit glob | `auth/schema.gen.ts` |
| Components | `{component}.tsx` — _Avoid_: `index.tsx` (a barrel by another name), a shared `components/` bucket | — | — |
| Barrel re-export | — | — | **Never.** _Avoid_: `index.ts`, `index.tsx` — there is no barrel; import the role file by deep path |

Routes in `src/routes/` own page UI; they delegate all logic to modules by deep path.

## Which file does this code go in?

- **Runs only on the server AND no client file imports it** — a heavy eager instance (`betterAuth(...)`, `drizzle(new Pool(...))`, `new Resend(...)`) or server-only logic → **`{descriptor}.server.ts`**. Write the bare eager export: `export const auth = betterAuth(...)`. The file boundary keeps it out of the client bundle (build error if violated) — no lazy guard needed.
- **A `createServerFn` the client invokes, or a middleware** → **`functions.ts`**. Import the `.server.ts` instance as a VALUE — it gets DCE'd from the client bundle because it's only touched inside `.handler()`/`.server()` callbacks. Any session-requiring server fn guards itself with the shared `requireAuth` middleware (server fns are public HTTP endpoints; route guards don't protect them).
- **Browser-only code that SSR-rendered routes import** (a Better Auth client, a TanStack DB collection) → **`{descriptor}.browser.ts`**. Server imports here are `import type` only.

If unsure why a suffix is required, read `references/import-protection.md` — the three TanStack Start findings the compiler forced.

## Hard rules

- **No barrels.** No `index.ts`. Cross-module imports use the deep path `@/module/file`; intra-module imports stay relative (`./file`). The filename is the public surface — name it descriptively by content, never generic `lib.*`/`utils.*`.
- **Eager, never lazy.** No `??=` singletons, no `getX()` init wrappers. The `.server.ts` boundary (not laziness) is what keeps server payloads out of the client. `new Pool(...)` doesn't connect at construction; a TanStack DB collection doesn't fetch until its first subscriber (`startSync` defaults to `false`), so constructing it in SSR module-eval does nothing.
- **`env` is the single source.** App/runtime code reads the validated `env` from `@/shared/env` — never `process.env` / `import.meta.env` ad hoc, INCLUDING the Better Auth CLI-chain files (`auth.server.ts`, `db.server.ts`, `send.server.ts`). With barrels gone, a deep `import { env } from "@/shared/env"` pulls only `env.ts`, not a whole module graph, onto the CLI-eval path. Exactly three blessed exceptions remain, each because it loads **outside Vite**:
  1. `src/router.tsx` — `import.meta.env.DEV`, a Vite compile-time DCE flag not modelable by t3-env.
  2. `drizzle.config.ts` — drizzle-kit / Vercel build; does its own `process.loadEnvFile(".env.local")` in the module body (an `import { env }` would hoist above it).
  3. `notifications/templates/*.tsx` — `process.env.APP_URL`; loads in React Email's dev preview AND the CLI chain, where `@/` and `import.meta.env` don't resolve.

## Should this module exist? — the deletion test

Before you carve out a module (or defend one in review), imagine **deleting it** and inlining its body at every call site:

- If the complexity **reappears across N callers** — the same guard, the same eager-instance wiring, the same query shape copied N times — it was **earning its keep**: a deep module (a lot of behaviour behind one deep-path file). Keep it.
- If the complexity **vanishes** — the "module" was a one-line re-export, a rename, a thin pass-through that every caller could inline without loss — it was a **shallow module**: pure interface tax. Fold it back into its single caller.

Corollaries for seams:
- **One adapter is a hypothetical seam; two adapters make it real.** Don't split a module behind an interface for a variation that doesn't yet exist — no `notifications/send.server.ts` + `notifications/send-sms.server.ts` fork until a second channel actually ships (contrast the additive template pattern below, which stays in ONE file until a channel is real).
- **The interface is the test surface.** A module is tested THROUGH its deep-path file, not past it. If a test has to reach around the filename to a private helper, the seam is in the wrong place — reshape the module, don't punch through it.

## Rejected framings

Each convention here rejects a common alternative for a concrete, stack-specific reason — not taste. Naming the rejected framing is what keeps the layout predictable across modules.

- **Barrels (`index.ts` re-exports).** Rejected. A barrel makes the *folder* the interface and hides which file a symbol lives in, so a single `@/module` import can drag an entire module graph — including a `.server.ts` Pool or secret — onto a client or CLI-eval path. Deep-path imports make the **filename the interface**: `@/module/file` pulls exactly that file. (This is also why `env` reads stay a deep `@/shared/env` import.)
- **Lazy singletons (`??=`, `getX()` init wrappers).** Rejected. Laziness is a *runtime* guard bolted on to compensate for a missing *compile* boundary. The `.server.ts` suffix already keeps the instance out of the client bundle at build time (a violating import is a build error), so eager `export const x = ...` is both simpler and stronger. `new Pool(...)` doesn't connect at construction and a TanStack DB collection doesn't fetch until its first subscriber, so eager module-eval costs nothing — the lazy wrapper buys only indirection.
- **`.client.ts` as a boundary suffix.** Rejected. It *reads* like the mirror of `.server.ts`, but TanStack Start enforces nothing on `.client.ts` — it's a false compile guarantee that lulls you into importing server code from it. Browser-only code uses the plain-descriptive **`.browser.ts`** (no enforced boundary, honestly named) with `import type`-only references to server modules.
- **Type-based buckets (`components/`, `services/`, `hooks/`, `lib/`, `utils/`).** Rejected. Grouping by *kind* scatters one feature across six folders and lets anything import anything. Group by feature/domain slice; a one-off sub-piece stays inline in its role file until a second caller earns it its own file. `lib.*`/`utils.*` names are rejected outright — name the file by what it does.
- **Depth measured as lines-of-implementation ÷ lines-of-interface.** Rejected (it rewards padding the body). Depth here means **leverage**: how much behaviour a caller gets per unit of interface they must learn — see the deletion test above.

## Schema co-location

Tables live in their OWNER module — `{module}/schema.ts` (hand-written) or `schema.gen.ts` (generated, lint-excluded). `drizzle.config.ts` discovers them by glob — no central schema list:

```ts
schema: ["./src/**/schema.ts", "./src/**/schema.gen.ts"],
```

The `db` instance aggregates per-module namespaces so `db.query.*` stays typed and extensible:

```ts
// shared/db.server.ts
import * as authSchema from "@/auth/schema.gen";
export const db = drizzle({ client: pool, schema: { ...authSchema } }); // add ...clientsSchema later
```

A consumer that needs a table imports it directly (`import { user } from "@/auth/schema.gen"`) — never through the `db` instance file, so a client module never drags in the Pool.

## Multi-channel notification templates

A template under `templates/` exports ONE value per channel, so a new channel is additive:

```tsx
export const subject = "Your code";
export const Email = ({ otp }: Props) => ( /* React Email component */ );
// add later: export const sms = ({ otp }: Props) => `Your code: ${otp}`;
export default Object.assign(Email, { PreviewProps: { otp: "123456" } }); // React Email preview; Email stays an arrow
```

## Related skills

- `/dobby:data-processing` — the write-side recipe: forms (an entity's `schema.ts` is the single source for validation rules + messages) plus mutation UX.
- `/dobby:data-fetching` — the collection recipe (the server fn in `functions.ts` → the eager collection in `collection.browser.ts` → `LiveQuery`).

## Acceptance checklist

- [ ] Passes the deletion test — if the module vanished, its complexity would reappear across N callers (not fold into one)
- [ ] No `index.ts` barrel; cross-module imports are deep paths (`@/module/file`), intra-module imports are relative
- [ ] Server-only eager instances/logic live in `{descriptor}.server.ts` (bare eager export, no lazy init)
- [ ] Server fns + middlewares live in `functions.ts` and import the instance as a value
- [ ] Browser code that SSR routes import lives in `{descriptor}.browser.ts` (NOT `.client.ts`); server imports there are `import type`
- [ ] Drizzle tables co-located in the owner module, found by the drizzle-kit glob; the `db` instance aggregates them
- [ ] All app/runtime code reads `env` from `@/shared/env`; only the three blessed out-of-Vite exceptions touch `process.env`/`import.meta.env`
- [ ] After `vp build`, the client bundle is clean (see `references/import-protection.md` verify step)
