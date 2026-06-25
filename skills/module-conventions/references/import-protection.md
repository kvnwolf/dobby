# TanStack Start import-protection — why the file taxonomy exists

The file roles are not stylistic — they are the shape the compiler allows. TanStack Start ships an import-protection plugin (default-on) that turns the `.server.*` / `.client.*` filename globs into **compile boundaries**: a `**/*.server.*` file reachable from the client graph is a build error (mocked in dev); a `**/*.client.*` file reachable from the server is a build error. Three findings, each empirically forced by `vp build`, drove the taxonomy.

## 1. A middleware in a `.server.ts` file leaks to the client

`createServerFn().handler(fn)` strips the handler BODY from the client bundle — but a middleware referenced via `.middleware([X])` is **not** stripped (the reference is retained so the client can invoke the endpoint). If `X` lives in — or imports — a `.server.ts` file, the whole file is dragged into the client graph → import-protection build error.

⇒ Middlewares and the server fns that use them live in **`functions.ts`** (isomorphic, no suffix). They import the eager instance as a VALUE — which IS DCE'd, because it's only touched inside `.handler()` / `.server()` callbacks. The instance itself stays in `{descriptor}.server.ts`.

## 2. `.client.ts` is the wrong suffix for a browser SDK in an SSR app

A browser SDK (the Better Auth client, a TanStack DB collection) is imported by SSR-rendered route modules — which are **server-graph**. `.client.*` rejects ANY server import, so the build breaks the moment an SSR route imports it.

⇒ Browser code that SSR routes import lives in **`{descriptor}.browser.ts`** (NO enforcement), and any server import in it is `import type` only. (The `.browser` instinct is right — just not as a guard.)

## 3. `typeof X` over a value-import retains the import

With `verbatimModuleSyntax`, `import { auth }` followed by a later `typeof auth` keeps the runtime import even when the value use is otherwise stripped — pulling the server instance into the client bundle.

⇒ Type-only uses of a server instance must use `import type { auth }`.

## Verify the boundaries hold

After `vp build`, the eager server payload must be absent from the client chunks:

```
grep -rE "betterAuth\(|new Pool\(|drizzle\(|neonConfig|new Resend\(" .output/public
```

Zero hits = the boundaries hold. Any hit = a server instance leaked into the client — almost always one of the three cases above (a middleware pulled in a `.server.ts`, a `.client.ts` mislabel, or a `typeof` value-import). Env-shim getter names (e.g. the string `BETTER_AUTH_SECRET`) can appear and are benign — they are not the instance.
