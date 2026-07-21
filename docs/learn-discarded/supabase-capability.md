# Supabase capability in dobby's task inference

**Friction** — a hybrid Supabase+Drizzle consumer loses the Supabase CLI surface (`db:*` wrapping, and `dev`'s `db:start` `dependsOn`) after migrating onto dobby: the capability detector infers only `drizzle`, so nothing wraps the local Supabase instance the repo still depends on mid-migration.

**Decision: discarded** (2026-07-20, `/dobby:learn` from the vonda migration session).

**Why** — Supabase support was deliberately REMOVED from the kit (the maintainer is migrating all projects off Supabase/Convex; STATE finding #30 of the zero-config CLI session). Re-adding a Supabase capability to serve a purely transitional state would rebuild exactly what was just torn out — the kind of churn this KB exists to prevent. The bridge for hybrid repos is already documented: the `setup[]` escape hatch (`"setup": ["supabase start"]`, idempotent) plus the Supabase CLI commands kept MANUAL until each repo's migration to Drizzle/Neon completes — see `/dobby:migrate-config` Step 7.

**Reconsider if** — a consumer adopts Supabase as a PERMANENT backend (not a migration source). At that point it's a real, durable capability rather than a transitional bridge, and inference support would carry its weight.

## Prior occurrences

- 2026-07-20 session (vonda migration — hybrid TanStack Start + Supabase+Drizzle, mid-migration) — "migrating onto dobby drops the Supabase `db:*` tasks the repo still uses"
