---
name: module-conventions
description: Per-module file-type convention for this stack (TanStack Start + Drizzle/Neon + Better Auth) — which role file each piece of code belongs in (.server.ts · functions.ts · .browser.ts · schema.gen.ts), deep-path imports (no barrels), eager instances, env as single source. Use when creating or refactoring a module or feature slice, deciding where a piece of code goes (a server function, a server-only instance, a browser client), or co-locating a Drizzle schema.
---

Every module is a deep, contained folder reached by **deep path** — there is NO `index.ts` barrel. Files are named by their ROLE, so the layout is identical across modules and **the filename is the interface**. The `.server.ts`/`.browser.ts` suffixes are framework-enforced compile boundaries, not naming habits.

## What the Gate now enforces

Rules below tagged `(enforced: Gate <id>)` are checked mechanically by `dobby check` on the stack path. The id is the convention inventory's ROW number, not a claim about the mechanism: `A*` rows mostly ship as native Biome rules, `B*` rows as the `conventions` filesystem scanner, `C*` rows as GritQL structural plugins — but a few rows moved tier without being renumbered (**A2** ships as a GritQL plugin; the cross-file **C2 / C3 / C12** ship as scanner checks).

- They surface **at edit time** (the PostToolUse hook reports findings on the file you just wrote) and again **at push** (the pre-push backstop refuses a red gate; `git push --no-verify` is the bypass).
- Every one is `error` severity, and the convention rules dobby ADDS carry no rewrite — `dobby check --fix` never rewrites convention code on their account. The already-enabled native Biome rules they ride alongside do apply their safe fix (A8 `useImportType` is corrected in place, at edit time too — the hook runs with `--write`).
- **Untagged rules are judgment.** Nothing checks them, so they hold only if you and review hold them. The conventions deliberately left unmechanized, each with its reason, are listed in `grit/CONTEXT.md` inside the `@kvnwolf/dobby` package — that list is the tier-(c) view, so it also names C2 / C3 / C12, which were re-landed as cross-file checks in the tier-(b) scanner (`src/conventions.ts` in the same package).

## Quick start — the file taxonomy

| Role | File | Boundary | Examples |
|------|------|----------|----------|
| Server-only eager instance / server-only logic | `{descriptor}.server.ts` — _Avoid_: `service.ts`, `db.ts`, `lib.ts` (no boundary; drags Pool/secrets into the client bundle) _(enforced: Gate C4 for the instance, B2 for the names)_ | `.server.*` ENFORCED — a client import is a **build error** | `auth/auth.server.ts`, `shared/db.server.ts`, `notifications/send.server.ts` |
| Server functions (`createServerFn`) + their middlewares | `functions.ts` — _Avoid_: `api.ts`, `actions.ts`, `handlers.ts` (obscures the isomorphic-DCE contract) _(enforced: Gate C1 for the server fn, C2 — a tier-(b) scanner check — for the middleware, B2 for the names)_ | isomorphic (no suffix) | `auth/functions.ts`, `users/functions.ts` |
| Browser-only code that SSR routes import | `{descriptor}.browser.ts` — _Avoid_: `{descriptor}.client.ts` (looks like a boundary suffix but TanStack Start enforces none — a false compile guarantee), `hooks.ts`, `utils.ts` _(enforced: Gate B3 for `.client.ts`, B2 for the names)_ | none — **NOT `.client.ts`** | `auth/client.browser.ts`, `users/collection.browser.ts` |
| Drizzle tables (hand-written / generated) | `schema.ts` / `schema.gen.ts` — _Avoid_: `models.ts`, `tables.ts`, `entities.ts` (the drizzle-kit glob only finds `schema*`) _(enforced: Gate C6+B5 for the table, B2 for the names)_ | co-located, found by a drizzle-kit glob | `auth/schema.gen.ts` |
| Components | `{component}.tsx` — _Avoid_: `index.tsx` (a barrel by another name) _(enforced: Gate B1+A7)_, a shared `components/` bucket _(enforced: Gate B4)_ | — | — |
| Barrel re-export | — | — | **Never.** _Avoid_: `index.ts`, `index.tsx` — there is no barrel; import the role file by deep path _(enforced: Gate B1+A7 for the file, C31 for a bare `@/module` import)_ |

Routes in `src/routes/` own page UI; they delegate all logic to modules by deep path _(enforced: Gate A5 — under `src/routes/` the whole server graph is banned: any `*.server` module, `@/shared/db.server`, `drizzle-orm`, `better-auth`, `pg`, `@neondatabase/serverless`)_.

## Which file does this code go in?

- **Runs only on the server AND no client file imports it** — a heavy eager instance (`betterAuth(...)`, `drizzle(new Pool(...))`, `new Resend(...)`) or server-only logic → **`{descriptor}.server.ts`**. Write the bare eager export: `export const auth = betterAuth(...)`. The file boundary keeps it out of the client bundle (build error if violated) — no lazy guard needed _(enforced: Gate C4 — an eager instance outside a `.server` file; C5 — a `??=` memoizing one inside it)_.
- **A `createServerFn` the client invokes, or a middleware** → **`functions.ts`** _(enforced: Gate C1)_. Import the `.server.ts` instance as a VALUE — it gets DCE'd from the client bundle because it's only touched inside `.handler()`/`.server()` callbacks. Any session-requiring server fn guards itself with the shared `requireAuth` middleware (server fns are public HTTP endpoints; route guards don't protect them) _(enforced: Gate C3 — the tier-(b) scanner check: a `createServerFn` chain in `functions.ts` with no `.middleware(…)` at all; WHICH middleware, and whether the endpoint is legitimately public, stays your call)_.
- **Browser-only code that SSR-rendered routes import** (a Better Auth client, a TanStack DB collection) → **`{descriptor}.browser.ts`**. Server imports here are `import type` only _(enforced: Gate C32)_.

If unsure why a suffix is required, read `references/import-protection.md` — the three TanStack Start findings the compiler forced.

## Hard rules

- **No barrels.** No `index.ts` _(enforced: Gate B1+A7)_. Cross-module imports use the deep path `@/module/file` — a bare `@/module` import is a barrel by another name _(enforced: Gate C31)_; intra-module imports stay relative (`./file`). The filename is the public surface — name it descriptively by content, never generic `lib.*`/`utils.*` _(enforced: Gate B2)_.
- **Eager, never lazy.** No `??=` singletons, no `getX()` init wrappers _(enforced: Gate C5 for the `??=`, A10 for importing a `getDb`/`getAuth`/`getResend` accessor)_. The `.server.ts` boundary (not laziness) is what keeps server payloads out of the client. `new Pool(...)` doesn't connect at construction; a TanStack DB collection doesn't fetch until its first subscriber (`startSync` defaults to `false`), so constructing it in SSR module-eval does nothing.
- **`env` is the single source.** App/runtime code reads the validated `env` from `@/shared/env` — never `process.env` / `import.meta.env` ad hoc, INCLUDING the Better Auth CLI-chain files (`auth.server.ts`, `db.server.ts`, `send.server.ts`) _(enforced: Gate A1 for `process.env`, A2 — the GritQL plugin — for `import.meta.env`, B7 for both)_. With barrels gone, a deep `import { env } from "@/shared/env"` pulls only `env.ts`, not a whole module graph, onto the CLI-eval path. Exactly three blessed exceptions remain, each because it loads **outside Vite** — and the Gate's allowlist is those three PLUS the env module itself at either house path (`src/shared/env.ts` · `src/lib/env.ts`), since that is the file that validates `process.env`:
  1. `src/router.tsx` — `import.meta.env.DEV`, a Vite compile-time DCE flag not modelable by t3-env.
  2. `drizzle.config.ts` — drizzle-kit / Vercel build; does its own `process.loadEnvFile(".env.local")` in the module body (an `import { env }` would hoist above it).
  3. `src/emails/*.tsx` — `process.env.APP_URL`; loads in React Email's dev preview AND the CLI chain, where `@/` and `import.meta.env` don't resolve.
- **Every module documents itself.** A directory holding a role file carries its own `CONTEXT.md` — purpose, one line per file, the public surface, the invariants, and what is deliberately NOT there _(enforced: Gate B9)_.

## Should this module exist? — the deletion test

Before you carve out a module (or defend one in review), imagine **deleting it** and inlining its body at every call site:

- If the complexity **reappears across N callers** — the same guard, the same eager-instance wiring, the same query shape copied N times — it was **earning its keep**: a deep module (a lot of behaviour behind one deep-path file). Keep it.
- If the complexity **vanishes** — the "module" was a one-line re-export, a rename, a thin pass-through that every caller could inline without loss — it was a **shallow module**: pure interface tax. Fold it back into its single caller.

Corollaries for seams:
- **One adapter is a hypothetical seam; two adapters make it real.** Don't split a module behind an interface for a variation that doesn't yet exist — no `notifications/send.server.ts` + `notifications/send-sms.server.ts` fork until a second channel actually ships (contrast the additive template pattern below, which stays in ONE file until a channel is real).
- **The interface is the test surface.** A module is tested THROUGH its deep-path file, not past it. If a test has to reach around the filename to a private helper, the seam is in the wrong place — reshape the module, don't punch through it.

## Rejected framings

- **Barrels (`index.ts` re-exports).** Rejected _(enforced: Gate B1+A7, C31)_. A barrel makes the *folder* the interface and hides which file a symbol lives in, so a single `@/module` import can drag an entire module graph — including a `.server.ts` Pool or secret — onto a client or CLI-eval path.
- **Lazy singletons (`??=`, `getX()` init wrappers).** Rejected _(enforced: Gate C5+A10)_. Laziness is a *runtime* guard bolted on to compensate for a missing *compile* boundary — `.server.ts` already IS that boundary, so the lazy wrapper buys only indirection.
- **`.client.ts` as a boundary suffix.** Rejected _(enforced: Gate B3)_. It *reads* like the mirror of `.server.ts`, but TanStack Start enforces nothing on it — a false compile guarantee that lulls you into importing server code from it. Browser-only code uses the honestly named **`.browser.ts`**.
- **Type-based buckets (`components/`, `services/`, `hooks/`, `lib/`, `utils/`).** Rejected _(enforced: Gate B4 — `src/{components,services,hooks,lib,utils}/` and any `-components/`; `src/shared/` is the blessed cross-cutting one)_. Grouping by *kind* scatters one feature across six folders and lets anything import anything. Group by feature/domain slice; a one-off sub-piece stays inline in its role file until a second caller earns it its own file.
- **Depth measured as lines-of-implementation ÷ lines-of-interface.** Rejected (it rewards padding the body). Depth here means **leverage**: how much behaviour a caller gets per unit of interface they must learn — see the deletion test above.

## Schema co-location

Tables live in their OWNER module — `{module}/schema.ts` (hand-written) or `schema.gen.ts` (generated, lint-excluded) _(enforced: Gate C6 for a table declared elsewhere, B5 for a central `src/schema/` · `src/db/schema/` bucket)_. `drizzle.config.ts` discovers them by glob — no central schema list:

```ts
schema: ["./src/**/schema.ts", "./src/**/schema.gen.ts"],
```

The `db` instance aggregates per-module namespaces so `db.query.*` stays typed and extensible _(enforced: Gate C7 — a `drizzle({ client })` in `db.server.ts` with no aggregated `schema:`)_:

```ts
// shared/db.server.ts
import * as authSchema from "@/auth/schema.gen";
export const db = drizzle({ client: pool, schema: { ...authSchema } }); // add ...clientsSchema later
```

A consumer that needs a table imports it directly (`import { user } from "@/auth/schema.gen"`) — never through the `db` instance file, so a client module never drags in the Pool _(enforced: Gate A6 — only `db` may be imported from `@/shared/db.server`)_.

## Multi-channel notification templates

React Email templates live at **`src/emails/`** _(enforced: Gate B10 — a react-email template outside that directory; it is also the third out-of-Vite `env` exception above)_. A template exports ONE value per channel, so a new channel is additive:

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
- [ ] No `index.ts` barrel; cross-module imports are deep paths (`@/module/file`), intra-module imports are relative _(enforced: Gate B1+A7, C31)_
- [ ] Server-only eager instances/logic live in `{descriptor}.server.ts` (bare eager export, no lazy init) _(enforced: Gate C4+C5)_
- [ ] Server fns + middlewares live in `functions.ts` and import the instance as a value _(enforced: Gate C1, C2 — the latter a tier-(b) scanner check)_
- [ ] Browser code that SSR routes import lives in `{descriptor}.browser.ts` (NOT `.client.ts`); server imports there are `import type` _(enforced: Gate B3, C32)_
- [ ] Drizzle tables co-located in the owner module, found by the drizzle-kit glob; the `db` instance aggregates them _(enforced: Gate C6+B5, C7)_
- [ ] All app/runtime code reads `env` from `@/shared/env`; only the three blessed out-of-Vite exceptions — plus the env module itself — touch `process.env`/`import.meta.env` _(enforced: Gate A1+B7, and A2 as a GritQL plugin)_
- [ ] The module carries its own `CONTEXT.md` _(enforced: Gate B9)_
- [ ] After `vp build`, the client bundle is clean (see `references/import-protection.md` verify step) _(enforced: Gate B8)_
