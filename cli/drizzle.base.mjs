import { defineConfig } from "drizzle-kit";

// Shipped as plain .mjs, never .ts: a consumer's drizzle config re-exports this
// preset and Node loads the file at runtime — but Node ≥23 refuses to type-strip
// .ts files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). .mjs
// loads natively everywhere (node, bun, esbuild loaders).
//
// The house drizzle-kit config (@kvnwolf/dobby/drizzle). A consumer whose repo
// matches the house convention re-exports it in one line:
//   export { default } from "@kvnwolf/dobby/drizzle";
// and spread-and-overrides for deltas. `drizzle-kit` resolves from the CONSUMER's
// tree — it is NEVER a dobby dependency.

// drizzle-kit runs DDL (migrations), which must go through an UNPOOLED
// connection: DDL through PgBouncer breaks migration tooling, so drizzle uses the
// non-pooled URL while the app RUNTIME uses the pooled DATABASE_URL.
function resolveUnpooledUrl() {
  let url =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING;
  if (!url) {
    try {
      // Local dev keeps creds in .env.local; CI/Vercel have no such file (the
      // vars come from the environment), so a missing file is never an error.
      process.loadEnvFile(".env.local");
    } catch {
      // No .env.local — fall through to the environment vars / CI guard below.
    }
    url =
      process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING;
  }
  return url;
}

const url = resolveUnpooledUrl();

// Static analysis + CI load this config just to READ `schema` (never to run DDL),
// so a missing URL must not hard-fail there — only fail locally.
if (!(url || process.env.CI)) {
  throw new Error(
    "Missing DATABASE_URL_UNPOOLED (or POSTGRES_URL_NON_POOLING) — add it to .env.local."
  );
}

export default defineConfig({
  dbCredentials: { url: url ?? "" },
  dialect: "postgresql",
  out: "./drizzle",
  // House convention: each module CO-LOCATES its own tables, so schema is a glob
  // across modules — hand-written schema.ts plus generated schema.gen.ts.
  schema: ["./src/**/schema.ts", "./src/**/schema.gen.ts"],
});
