// Generator + drift source for the VENDORED biome presets (cli/biome/core.jsonc,
// cli/biome/react.jsonc). Biome's `extends` is ONE-LEVEL / non-transitive — a
// config that extends `ultracite/biome/core` gets that file's OWN content but NOT
// the `extends` IT declares. So dobby cannot wrap ultracite; it VENDORS ultracite's
// core + react configs FLAT, verbatim, plus dobby's own modifications.
//
// This is a CHECK, not a build step: the emitted files are COMMITTED. Regenerate
// with `bun cli/scripts/vendor-biome.ts`; the drift guard (src/vendor-biome.test.ts)
// regenerates in-memory and byte-compares against the committed files, so any
// ultracite upgrade (or hand-edit) screams at the gate until someone regenerates.
//
// JSONC parsing: the bundled `typescript` is the v7 native port, which does NOT
// expose the classic JS config parser (`ts.parseConfigFileTextToJson` is undefined),
// so this uses a tiny string-aware JSONC stripper instead — NO new dependency, and
// it runs identically under Bun (the script) and Node/vitest (the drift test).

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireFrom = createRequire(import.meta.url);

// The @biomejs/biome the CLI bundles. Ultracite's own `$schema` is a relative
// node_modules path that will NOT resolve from dobby's biome/ dir, so it is
// replaced with the versioned URL matching the bundled biome.
const SCHEMA_URL = "https://biomejs.dev/schemas/2.5.4/schema.json";

// dobby's common consumer ignores, appended to ultracite's `files.includes` in
// four groups (comments are injected after serialization, so the array stays pure
// strings): (1) TanStack Start / nitro build output as FORCE-excludes (`!!`,
// ultracite's `!!**/dist` class); (2) tooling/runtime dirs — Claude Code's dir
// (worktrees live under .claude, scanning them double-lints every file), dobby's
// own state, CI config — plus markdown; (3) the agent/plugin ecosystem (agent dirs
// + skills lockfile) and CSS (biome's CSS parser aborts on Tailwind 4 @apply/@theme
// and the house stack is Tailwind-only, so CSS is out of biome's scope entirely);
// (4) the house-convention generated/vendored consumer dirs biome should never lint
// (Convex functions + generated dir, shadcn-vendored ui components, generated DB
// types). Their group comments are injected via `injectBefore` at the markers below.
const DOBBY_IGNORES: readonly string[] = [
  "!!**/.nitro",
  "!!**/.vinxi",
  "!!**/.tanstack",
  "!.claude",
  "!.dobby",
  "!.github",
  "!.agents",
  "!.hallmark",
  "!skills-lock.json",
  "!**/*.md",
  "!**/*.css",
  "!convex/**",
  "!src/components/ui/**",
  "!src/lib/database.types.ts",
];

// The house-style comment (kept verbatim from the previous hand-written core):
// why dobby turns `noArrayIndexKey` off for every consumer.
const NO_ARRAY_INDEX_KEY_REASON: readonly string[] = [
  "// House style (maintainer decision): the array-index-key rule forced",
  "// key-const gymnastics on custom-component JSX where biome can't even",
  "// anchor a suppression comment. For AI-written code its value doesn't",
  "// pay its cost, so dobby consumers get it off by default.",
];

// ultracite/biome/react RE-ENABLES noArrayIndexKey as an error; dobby disables it
// again so react consumers keep the same house style as core.
const REACT_NO_ARRAY_INDEX_KEY_REASON: readonly string[] = [
  "// ultracite/biome/react re-enables noArrayIndexKey as an error; dobby",
  "// disables it again (same house-style reason as core). A consumer extends",
  "// BOTH core and react, so this last-in-chain value is what wins.",
];

const IGNORES_REASON: readonly string[] = [
  "// dobby's common consumer ignores (appended to ultracite's includes).",
];

// TanStack Start / nitro build output — FORCE-excluded (`!!`), ultracite's
// `!!**/dist` class, injected before the first of the three build dirs.
const TANSTACK_IGNORES_REASON: readonly string[] = [
  "// TanStack Start / nitro build output (force-exclude, ultracite's !!**/dist class).",
];

// The agent/plugin ecosystem dirs + the skills lockfile — same class as .claude.
const AGENT_IGNORES_REASON: readonly string[] = [
  "// Agent/plugin ecosystem: agent dirs + skills lockfile (same class as .claude).",
];

// CSS is out of biome's scope entirely: biome's CSS parser rejects Tailwind 4
// `@apply`/`@theme` ("Tailwind-specific syntax is disabled") and aborts formatting;
// the house stack is Tailwind-only, so CSS is handled outside biome.
const CSS_IGNORES_REASON: readonly string[] = [
  "// Tailwind-only stack: biome's CSS parser aborts on Tailwind 4 @apply/@theme,",
  "// so CSS is out of biome's scope entirely.",
];

// The house-convention ignores appended after the tooling ignores above:
// generated/vendored consumer dirs biome should never lint by default.
const HOUSE_IGNORES_REASON: readonly string[] = [
  "// House conventions: generated/vendored consumer dirs (never linted by default).",
];

// The house-style rules-off set (field round 2): each rule's cost exceeds its value
// for AI-written code, so dobby turns it off for every consumer. Groups are biome's
// REAL categories, verified against the vendored core.jsonc (not guessed). Injected
// as one-line comments before each rule key, mirroring the noArrayIndexKey style.
const NO_UNNECESSARY_CONDITIONS_REASON: readonly string[] = [
  "// House style: biome's control-flow analysis doesn't model tsc noUncheckedIndexedAccess, so it flags guards tsc REQUIRES — off (field-confirmed twice: dobby repo + consumer).",
];
const NO_VOID_REASON: readonly string[] = [
  "// House style: the void-operator ban's cost exceeds its value for AI-written code — off.",
];
const NO_NAMESPACE_IMPORT_REASON: readonly string[] = [
  "// House style: namespace imports are idiomatic in the maintainer's stack; the rule's cost exceeds its value for AI-written code — off.",
];
const NO_AWAIT_IN_LOOPS_REASON: readonly string[] = [
  "// House style: sequential awaits are frequently intentional; the rule's cost exceeds its value for AI-written code — off.",
];

// The react preset ADDS noJsxPropsBind (a PERFORMANCE rule ultracite's react config
// omits) as off: its "fix" is hundreds of hand-written useCallback/useMemo deps
// arrays with stale-closure risk and no perf gain without react-compiler.
const NO_JSX_PROPS_BIND_REASON: readonly string[] = [
  "// House style: noJsxPropsBind's 'fix' is hundreds of hand-written useCallback/useMemo",
  "// deps arrays (stale-closure risk, no perf gain without react-compiler) — off. A",
  "// PERFORMANCE rule ultracite's react config omits, so dobby adds it here.",
];

// The src/routes/** override rationale (dobby's react preset deliberately couples
// to the maintainer's TanStack Start stack). Injected blocks: the group header,
// plus one rationale per rule the override relaxes or adds.
const ROUTES_OVERRIDE_REASON: readonly string[] = [
  "// TanStack Start stack coupling: under the route dir the router owns the file",
  "// shapes, so two rules relax there — and the server graph is banned outright",
  "// (rationale beside each rule). Glob is `**/`-prefixed so it anchors under BOTH",
  "// the consumer's extends chain AND dobby's config-less `--config-path` wrapper",
  "// (biome anchors override globs to the config's own dir there, not the project",
  "// cwd) — lab-verified, bundled biome.",
];
const ROUTES_FILENAME_REASON: readonly string[] = [
  "// TanStack Router route filenames ($param, $ splat, _layout, -components, dotted",
  "// segments) ARE the route tree — renaming them to kebab-case breaks routing.",
];
const ROUTES_SORTED_KEYS_REASON: readonly string[] = [
  "// useSortedKeys alphabetises Route options, moving `head` before `loader`; but",
  "// TanStack infers head()'s loaderData in TEXTUAL order, so sorting collapses",
  "// loaderData to `never` (52 tsc errors in the field). Off under routes.",
];

// ---------------------------------------------------------------------------
// Tier (a) convention rules — the house stack's conventions expressed as NATIVE
// biome rules, shipped in the REACT preset ONLY. That IS the capability gate:
// `tasks.biomeConfigSpec` points a config-less project at the react wrapper only
// when the `react` capability is detected, so a non-stack consumer never sees a
// convention about `@/shared`, TanStack or the .server boundary. (The react
// preset already couples deliberately to the maintainer's TanStack Start stack —
// see the src/routes/** override above.)
//
// Every path-scoped glob is `**/`-PREFIXED for the reason spelled out in
// ROUTES_OVERRIDE_REASON: it must anchor under BOTH the consumer's extends chain
// and dobby's config-less `--config-path` wrapper.
//
// Messages are the convention skills' own wording (module-conventions /
// data-fetching / data-processing), so a finding names the house alternative
// instead of just the ban.
//
// SHIPPED here: A1 (noProcessEnv), A3/A4/A6/A10 (the project-wide
// noRestrictedImports options), A5 (the src/routes server-graph ban). Already
// enabled upstream, verified NOT re-added: A7 (noBarrelFile), A8
// (useImportType — lab-verified that it fires when the only use is `typeof`),
// A12 (useFilenamingConvention), A13 (core's `!!**/*.gen.*` force-exclude
// already covers `schema.gen.ts`, and a plain `!` negation could not weaken a
// `!!` anyway).
//
// DEMOTED to tier (c) — NOT expressible as a native biome 2.5.4 rule, each
// verdict lab-verified against the bundled biome:
//   A2 (`import.meta.env` ad-hoc reads) — biome ships no `noRestrictedSyntax`
//     class rule, and `noRestrictedGlobals.deniedGlobals` matches bare global
//     identifiers only: `"import.meta.env"` as a denied global reports nothing.
//   A9 (`*.browser.ts` may import `*.server` as TYPE only) — noRestrictedImports
//     has no `allowTypeImports` (PathOptions/PatternOptions are message +
//     import-name lists), and it flags `import type { X } from "./y.server"`
//     identically to a value import — i.e. it would ban exactly the LEGAL usage.
//   A11 (query-source alias must not shadow a route-scope binding) — native
//     `noShadow` does cover the arrow-callback destructured param, but it cannot
//     be scoped to the `q.from({ … })` construct; it is a blanket shadow ban, a
//     strict superset of the convention, so shipping it would ship a DIFFERENT
//     rule. A GritQL rule can match the construct.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tier (c) convention rules — the house conventions biome's NATIVE rules cannot
// express, shipped as GritQL plugins (`cli/grit/*.grit`, one file per inventory
// row) and declared HERE so the wiring is generated, never hand-edited.
//
// DELIVERY MODE (the load-bearing lab finding). Biome resolves a plugin path
// relative to the ROOT config — the file `--config-path` names, or the consumer's
// own `biome.jsonc` — NOT relative to the config that DECLARES the plugin. So:
//   - Declared in `configless.react.jsonc` (dobby's internal `--config-path`
//     wrapper, which lives beside this dir): `../grit/x.grit` resolves, the rules
//     fire, and per-plugin `includes` scoping works. This is the mode dobby owns
//     end to end and the one that ships.
//   - Declared in `react.jsonc` (the CONSUMER `extends` target): the same relative
//     path is resolved from the CONSUMER's project root, where `../grit/` does not
//     exist, and biome aborts the WHOLE run with "Error(s) during loading of
//     plugins: Cannot read file" — no lint output at all. That is why the plugins
//     are NOT declared in `react.jsonc`: a consumer with their own `biome.jsonc`
//     must keep a working gate. See cli/README.md for their opt-in snippet.
// Both lab-verified against bundled biome 2.5.4.
//
// Every path-scoped `includes` glob is `**/`-PREFIXED for the same reason the
// override globs are (see ROUTES_OVERRIDE_REASON): under `--config-path` biome
// anchors these globs to the config's own directory, not the project cwd.
// ---------------------------------------------------------------------------

// One entry of biome's `plugins` array: a bare path, or a path plus the per-plugin
// `includes` globs that scope a path-sensitive rule.
interface GritPlugin {
  includes?: string[];
  path: string;
}

// Every source file, minus the co-located tests — the base scope for a rule that is
// about production code shape.
const SOURCE_FILES: readonly string[] = [
  "**/*.ts",
  "**/*.tsx",
  "!**/*.test.ts",
  "!**/*.test.tsx",
];

function gritPlugin(file: string, includes?: readonly string[]): GritPlugin {
  const plugin: GritPlugin = { path: `../grit/${file}` };
  if (includes !== undefined) {
    plugin.includes = [...includes];
  }
  return plugin;
}

// The shipped tier-(c) set, in inventory order. A rule whose `includes` is omitted
// runs over every linted file; the rest carry the path scope the inventory row
// specifies (the pattern itself never sees the file path — see c31's PARTIAL note).
const GRIT_PLUGINS: readonly GritPlugin[] = [
  // C1 — createServerFn outside the module's functions.ts.
  gritPlugin("c01-server-fn-outside-functions.grit", [
    ...SOURCE_FILES,
    "!**/functions.ts",
  ]),
  // C4 — an eager server instance outside a `.server` file.
  gritPlugin("c04-eager-instance-outside-server-file.grit", [
    ...SOURCE_FILES,
    "!**/*.server.ts",
    "!**/*.server.tsx",
  ]),
  // C5 — the lazy-singleton `??=` inside a `.server` file.
  gritPlugin("c05-lazy-server-instance.grit", [
    "**/*.server.ts",
    "**/*.server.tsx",
  ]),
  // C6 — a table declared outside schema.ts / schema.gen.ts.
  gritPlugin("c06-table-outside-schema-file.grit", [
    ...SOURCE_FILES,
    "!**/schema.ts",
    "!**/schema.gen.ts",
  ]),
  // C7 — the db instance built without the aggregated schema namespaces.
  gritPlugin("c07-db-instance-without-schema.grit", ["**/db.server.ts"]),
  // C9/C10/C13/C14 — the collection + <LiveQuery> shape rules (no path scope).
  gritPlugin("c09-collection-persistence-handlers.grit"),
  gritPlugin("c10-collection-not-eager.grit"),
  gritPlugin("c13-live-query-prop-set.grit"),
  gritPlugin("c14-retry-without-clear-error.grit"),
  // C15 — the raw live-query hooks, everywhere except the src/shared boundary.
  gritPlugin("c15-raw-live-query-hooks.grit", ["**", "!**/src/shared/**"]),
  // C18 — a useAppForm whose options carry no validators.onSubmit schema.
  gritPlugin("c18-form-without-submit-validator.grit"),
  // C19/C20/C21/C23/C24/C25/C26/C27 — the form + field shape rules.
  gritPlugin("c19-field-control-without-render.grit"),
  gritPlugin("c20-incomplete-field-anatomy.grit"),
  gritPlugin("c21-dialog-form-not-rendered-as-form.grit"),
  gritPlugin("c23-raw-value-submitted.grit"),
  gritPlugin("c24-email-not-lowercased.grit"),
  gritPlugin("c25-hand-rolled-submit-button.grit"),
  gritPlugin("c26-secondary-button-outside-form-button.grit"),
  gritPlugin("c27-manual-field-a11y-props.grit"),
  // C29 — reaching into form internals, in test files only.
  gritPlugin("c29-test-reaches-into-form-internals.grit", [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
  ]),
  // C31 — the bare `@/module` barrel import.
  gritPlugin("c31-barrel-module-import.grit"),
  // C32 — a `.browser` file importing a `.server` module as a VALUE (the A9 fallback).
  gritPlugin("c32-browser-value-import-of-server-module.grit", [
    "**/*.browser.ts",
    "**/*.browser.tsx",
  ]),
  // C33 — zod v3's chained email validator.
  gritPlugin("c33-zod-v3-email-validator.grit"),
  // A2 (demoted from tier (a)) — ad-hoc `import.meta.env`, outside the blessed
  // out-of-Vite files. The list is the noProcessEnv override's allowlist (both env
  // module locations, the router, the drizzle-kit config, the email templates) with
  // TWO deliberate deltas, because this scope is a plugin `includes` rather than a
  // rule override:
  //   - the react-email templates are excluded as a whole DIRECTORY (`src/emails/**`,
  //     not just `**/*.tsx`): a template dir's helper `.ts` files load in the same
  //     out-of-Vite React Email / CLI process as the `.tsx` entry points, and unlike
  //     the override — which only turns a rule off — a plugin `includes` decides
  //     whether the file is analyzed at all.
  //   - `src/notifications/templates/**` is excluded too: module-conventions names
  //     `notifications/templates/*.tsx` as the blessed out-of-Vite template
  //     location, while the noProcessEnv override allowlists `src/emails/**` —
  //     react-email's own default layout. Both are listed here, so a consumer on
  //     either layout is covered.
  gritPlugin("a2-import-meta-env.grit", [
    "**",
    "!**/src/shared/env.ts",
    "!**/src/lib/env.ts",
    "!**/src/router.tsx",
    "!**/drizzle.config.ts",
    "!**/src/emails/**",
    "!**/src/notifications/templates/**",
  ]),
];

// A `noRestrictedImports` `paths` entry: a banned module, optionally narrowed to
// (or widened from) specific exported names.
interface RestrictedPath {
  allowImportNames?: string[];
  importNames?: string[];
  message: string;
}

// A `noRestrictedImports` `patterns` entry: gitignore-style module globs, with an
// optional regex over the IMPORTED NAMES. Biome's `importNamePattern` is
// implicitly anchored — `^`/`$` are a hard config error (bundled biome 2.5.4).
interface RestrictedPattern {
  group: string[];
  importNamePattern?: string;
  message: string;
}

// A3 — data-processing: forms are built with `useAppForm`; the raw TanStack Form
// hooks are wired ONCE inside src/shared.
const RAW_FORM_HOOKS: RestrictedPath = {
  importNames: [
    "useForm",
    "useField",
    "createFormHook",
    "createFormHookContexts",
  ],
  message:
    'Use useAppForm from "@/shared/use-app-form" — raw @tanstack/react-form hooks are only wired inside src/shared/.',
};

// A4 — data-fetching: `<LiveQuery>` is the boundary for every collection read;
// the raw hooks bypass SSR/loading/empty/retry handling.
const RAW_LIVE_QUERY_HOOKS: RestrictedPath = {
  importNames: ["useLiveQuery", "useLiveSuspenseQuery"],
  message:
    'Consume collection data through <LiveQuery> from "@/shared/live-query" — the raw useLiveQuery/useLiveSuspenseQuery hook bypasses SSR/loading/empty/retry handling.',
};

// A6 — module-conventions: tables are imported from their OWNER module; only the
// `db` instance itself may come out of @/shared/db.server.
const DB_INSTANCE_ONLY: RestrictedPath = {
  allowImportNames: ["db"],
  message:
    'Import the table from its owner module ("@/<module>/schema.gen") — importing it through @/shared/db.server drags the Pool into the caller.',
};

// A10 — module-conventions: eager, never lazy. The name-level half of the rule
// (the construction-site half is a tier-(c) structural rule): no `get*()`
// accessor for the eager server instances, from ANY module (`**` covers package
// and relative specifiers alike).
const LAZY_ACCESSOR_NAMES: RestrictedPattern = {
  group: ["**"],
  importNamePattern: "(getDb|getAuth|getResend)",
  message:
    'Import the eager instance (e.g. `db` from "@/shared/db.server") — there is no getDb() accessor; the .server boundary replaces laziness.',
};

// A5 — module-conventions + import-protection: a route file owns page UI only.
// The whole server graph is banned under src/routes: the db instance, ANY
// *.server module, and the server-only packages themselves.
const SERVER_GRAPH_MESSAGE =
  'Routes own page UI only — import the module\'s server fn from "@/<module>/functions", not the server instance.';
const SERVER_MODULE_PATTERN: RestrictedPattern = {
  group: ["**/*.server"],
  message: SERVER_GRAPH_MESSAGE,
};
const SERVER_ONLY_PACKAGES = [
  "@neondatabase/serverless",
  "better-auth",
  "drizzle-orm",
  "pg",
] as const;

// The rule value (`{ level, options }`) for one scope. Biome overrides REPLACE a
// rule's options rather than merging them (lab-verified, bundled biome 2.5.4), so
// each scope states its FULL set — see the shared/routes rationales below.
function restrictedImports(
  paths: Record<string, RestrictedPath>,
  patterns: RestrictedPattern[]
): Record<string, unknown> {
  return { level: "error", options: { paths, patterns } };
}

// The project-wide set (A3, A4, A6, A10).
function defaultRestrictedImports(): Record<string, unknown> {
  return restrictedImports(
    {
      "@/shared/db.server": DB_INSTANCE_ONLY,
      "@tanstack/react-db": RAW_LIVE_QUERY_HOOKS,
      "@tanstack/react-form": RAW_FORM_HOOKS,
    },
    [LAZY_ACCESSOR_NAMES]
  );
}

// src/shared: the two hook bans lift (this module IS the boundary that wraps
// them); everything else still applies.
function sharedRestrictedImports(): Record<string, unknown> {
  return restrictedImports({ "@/shared/db.server": DB_INSTANCE_ONLY }, [
    LAZY_ACCESSOR_NAMES,
  ]);
}

// src/routes: the server graph is banned outright (A5) — including @/shared/db.server,
// whose project-wide `db`-only allowance does NOT survive here — and the project-wide
// bans are re-stated because an override REPLACES the options.
function routesRestrictedImports(): Record<string, unknown> {
  // Built by insertion (not a literal) so the emitted key order is fixed by THIS
  // order — the injected rationale anchors on the first key. The server-only
  // packages lead, then the db instance (its project-wide `db`-only allowance does
  // NOT survive an override), then the re-stated project-wide bans.
  const paths: Record<string, RestrictedPath> = {};
  for (const pkg of SERVER_ONLY_PACKAGES) {
    paths[pkg] = { message: SERVER_GRAPH_MESSAGE };
  }
  paths["@/shared/db.server"] = { message: SERVER_GRAPH_MESSAGE };
  paths["@tanstack/react-form"] = RAW_FORM_HOOKS;
  paths["@tanstack/react-db"] = RAW_LIVE_QUERY_HOOKS;
  return restrictedImports(paths, [SERVER_MODULE_PATTERN, LAZY_ACCESSOR_NAMES]);
}

// A1 — module-conventions: `env` is the single source. core ships noProcessEnv
// OFF; the stack path turns it on, with the env module ITSELF plus the three
// out-of-Vite files allowlisted.
const PROCESS_ENV_REASON: readonly string[] = [
  "// House convention (env is the single source): app code reads validated env from",
  '// "@/shared/env", never process.env. core ships this rule off; the react preset —',
  "// the stack path — turns it on, and the override below allowlists the env module",
  "// itself plus the three files that load OUTSIDE Vite (no @/shared/env to read).",
];
const PROCESS_ENV_ALLOWLIST_REASON: readonly string[] = [
  "// The env module ITSELF first: it is the file that VALIDATES process.env (t3-env's",
  "// `createEnv({ runtimeEnv: process.env })`) and hands the rest of the app the typed",
  "// `env` — without this entry the rule is unsatisfiable for every house app, since",
  "// the single blessed source of env would itself fail the gate. Both house locations",
  "// are listed (`@/shared/env` per module-conventions, `src/lib/env.ts` per",
  "// onboard/migrate-config). Then the three blessed out-of-Vite files: the router",
  "// (pre-Vite bootstrap), the drizzle-kit config (drizzle-kit's own process), and the",
  "// react-email templates (rendered by the email preview/CLI). Globs are",
  "// `**/`-prefixed like every other override glob here — see the routes rationale below.",
];
const RESTRICTED_IMPORTS_REASON: readonly string[] = [
  "// House conventions as import bans (stack path only). core enables",
  "// noRestrictedImports with NO options — a no-op — and the react preset supplies",
  "// them: raw TanStack Form hooks (use useAppForm), the raw live-query hooks (render",
  "// <LiveQuery>), anything but `db` out of @/shared/db.server, and the lazy get*()",
  "// accessors the .server boundary replaces. Messages are the convention skills'",
  "// own wording, so a finding names the house alternative, not just the ban.",
];
const SHARED_OVERRIDE_REASON: readonly string[] = [
  "// src/shared IS the boundary that wraps the raw hooks (useAppForm, <LiveQuery>),",
  "// so those two bans lift there. Biome overrides REPLACE a rule's options rather",
  "// than merging them (lab-verified, bundled biome 2.5.4), so this block RE-STATES",
  "// the bans that still hold inside shared instead of layering onto the global set.",
];
const ROUTES_RESTRICTED_IMPORTS_REASON: readonly string[] = [
  "// Route files own page UI only: the whole server graph is banned under the route",
  "// dir — the db instance, ANY *.server module, and the server-only packages. The",
  "// project-wide bans are RE-STATED because an override REPLACES the rule's options",
  "// (see the src/shared note); without the repeat, a route file would be the one",
  "// place raw form/live-query hooks were legal.",
];

// The biome-config subset this generator reaches into. Everything else rides
// through opaque via the parse -> mutate -> serialize round-trip.
interface BiomeConfig {
  $schema?: string;
  files?: { includes?: string[] };
  linter?: { rules?: Record<string, Record<string, unknown>> };
  overrides?: unknown[];
  [key: string]: unknown;
}

// A JSON string literal (escapes handled), a `//` line comment, or a `/* */` block
// comment. Trying the string arm FIRST is what makes the strip string-aware: a `//`
// INSIDE a string is consumed by the string arm and never seen as a comment.
const JSON_STRING_OR_COMMENT_RE =
  /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

// A JSON string literal OR a trailing comma (a `,` before optional whitespace then a
// closing `}` / `]`). The string arm protects a comma INSIDE a string from removal.
const JSON_STRING_OR_TRAILING_COMMA_RE = /("(?:\\.|[^"\\])*")|,(\s*[}\]])/g;

// Leading whitespace of a line, for indent-matching in `injectBefore`.
const LEADING_WHITESPACE_RE = /^\s*/;

// Strip `//` line and `/* */` block comments, string-aware. Comments are NOT
// preserved in the emitted output — "verbatim" means content, not ultracite's
// comments; dobby's own mod comments are injected after serialization.
function stripComments(text: string): string {
  return text.replace(JSON_STRING_OR_COMMENT_RE, (match) =>
    match.startsWith('"') ? match : ""
  );
}

// Drop trailing commas (before `}` / `]`), string-aware (the string arm passes
// through unchanged). Runs after `stripComments`, so `JSON.parse` accepts the result.
function stripTrailingCommas(text: string): string {
  return text.replace(
    JSON_STRING_OR_TRAILING_COMMA_RE,
    (_match, stringLiteral, closer) => stringLiteral ?? closer ?? ""
  );
}

function parseJsonc(text: string): BiomeConfig {
  return JSON.parse(stripTrailingCommas(stripComments(text))) as BiomeConfig;
}

// Insert `comment` lines (matched to the target line's indentation) immediately
// before the first line containing `marker`. `marker` must be unique in `text`.
function injectBefore(
  text: string,
  marker: string,
  comment: readonly string[]
): string {
  const lines = text.split("\n");
  const target = lines.findIndex((line) => line.includes(marker));
  if (target === -1) {
    throw new Error(`vendor-biome: marker not found for injection: ${marker}`);
  }
  const indent = (lines[target] ?? "").match(LEADING_WHITESPACE_RE)?.[0] ?? "";
  const block = comment.map((line) => indent + line);
  lines.splice(target, 0, ...block);
  return lines.join("\n");
}

// The ultracite package root, derived from a RESOLVED config file path (ultracite's
// `exports` block hides `./package.json` — require.resolve("ultracite/package.json")
// throws ERR_PACKAGE_PATH_NOT_EXPORTED — so the root can't be resolved directly).
// Walk up from the resolved core config until a directory holds a `package.json`
// whose `name` is "ultracite"; the nesting depth is ultracite's to change, not ours.
function ultraciteRoot(): string {
  const core = requireFrom.resolve("ultracite/biome/core");
  let dir = dirname(core);
  let parent = dirname(dir);
  while (parent !== dir) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: string;
      };
      if (manifest.name === "ultracite") {
        return dir;
      }
    }
    dir = parent;
    parent = dirname(dir);
  }
  throw new Error(
    `vendor-biome: could not locate the ultracite package root by walking up from ${core}`
  );
}

function ultraciteVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(ultraciteRoot(), "package.json"), "utf8")
  ) as { version?: string };
  if (manifest.version === undefined) {
    throw new Error("vendor-biome: could not read ultracite version");
  }
  return manifest.version;
}

function header(version: string): string {
  return [
    `// Vendored from ultracite@${version} — regenerate: bun cli/scripts/vendor-biome.ts`,
    "// DO NOT EDIT: dobby's modifications are applied by the generator; drift is gated by src/vendor-biome.test.ts.",
    "",
  ].join("\n");
}

// The rule bag for a linter group, or a hard error if ultracite restructured (a
// drift signal in its own right).
function ruleGroup(
  config: BiomeConfig,
  group: string
): Record<string, unknown> {
  const rules = config.linter?.rules?.[group];
  if (rules === undefined) {
    throw new Error(
      `vendor-biome: ultracite config has no linter.rules.${group}`
    );
  }
  return rules;
}

// Turn an EXISTING ultracite rule OFF, hard-erroring if its group no longer defines
// it — so an upstream rename/removal screams at the drift gate instead of silently
// dropping dobby's house override. `group` is biome's REAL category for the rule
// (verified against the vendored preset), not a guess.
function disableRule(config: BiomeConfig, group: string, rule: string): void {
  const rules = ruleGroup(config, group);
  if (rules[rule] === undefined) {
    throw new Error(
      `vendor-biome: ultracite ${group} group no longer defines ${rule}`
    );
  }
  rules[rule] = "off";
}

// Set a rule dobby ADDS (one the upstream config omits) — creating the group if
// ultracite doesn't ship it, merging into it if it does (so an upstream addition is
// never clobbered). Used for the react preset's noJsxPropsBind, a PERFORMANCE rule
// ultracite's react config omits, and for the tier-(a) convention rules (whose value
// is the `{ level, options }` object form, hence the non-string `value`).
function setAddedRule(
  config: BiomeConfig,
  group: string,
  rule: string,
  value: unknown
): void {
  const rules = config.linter?.rules;
  if (rules === undefined) {
    throw new Error("vendor-biome: ultracite config has no linter.rules");
  }
  const bag = rules[group] ?? {};
  bag[rule] = value;
  rules[group] = bag;
}

function generateCore(version: string): string {
  const config = parseJsonc(
    readFileSync(requireFrom.resolve("ultracite/biome/core"), "utf8")
  );
  config.$schema = SCHEMA_URL;
  // ultracite's core does NOT list noArrayIndexKey (it rides recommended), so dobby
  // ADDS the off override; the field-round-2 rules below ARE listed by ultracite, so
  // they're drift-checked disables. Groups verified against the vendored core.jsonc.
  setAddedRule(config, "suspicious", "noArrayIndexKey", "off");
  disableRule(config, "suspicious", "noUnnecessaryConditions");
  disableRule(config, "complexity", "noVoid");
  disableRule(config, "performance", "noNamespaceImport");
  disableRule(config, "performance", "noAwaitInLoops");
  const includes = config.files?.includes;
  if (includes === undefined) {
    throw new Error("vendor-biome: ultracite core has no files.includes");
  }
  includes.push(...DOBBY_IGNORES);

  let body = JSON.stringify(config, null, 2);
  body = injectBefore(body, '"noArrayIndexKey"', NO_ARRAY_INDEX_KEY_REASON);
  body = injectBefore(
    body,
    '"noUnnecessaryConditions"',
    NO_UNNECESSARY_CONDITIONS_REASON
  );
  body = injectBefore(body, '"noVoid"', NO_VOID_REASON);
  body = injectBefore(body, '"noNamespaceImport"', NO_NAMESPACE_IMPORT_REASON);
  body = injectBefore(body, '"noAwaitInLoops"', NO_AWAIT_IN_LOOPS_REASON);
  body = injectBefore(body, '"!!**/.nitro"', TANSTACK_IGNORES_REASON);
  body = injectBefore(body, '"!.claude"', IGNORES_REASON);
  body = injectBefore(body, '"!.agents"', AGENT_IGNORES_REASON);
  body = injectBefore(body, '"!**/*.css"', CSS_IGNORES_REASON);
  body = injectBefore(body, '"!convex/**"', HOUSE_IGNORES_REASON);
  return `${header(version)}${body}\n`;
}

function generateReact(version: string): string {
  const config = parseJsonc(
    readFileSync(requireFrom.resolve("ultracite/biome/react"), "utf8")
  );
  config.$schema = SCHEMA_URL;
  disableRule(config, "suspicious", "noArrayIndexKey");
  // noJsxPropsBind is a PERFORMANCE rule ultracite's react config omits; dobby ADDS
  // it as off (its "fix" is hand-written useCallback/useMemo deps arrays).
  setAddedRule(config, "performance", "noJsxPropsBind", "off");
  // The tier-(a) convention rules: core ships noProcessEnv off and
  // noRestrictedImports option-less, and the STACK path (this preset) supplies
  // both — so a non-react consumer never sees a house convention (see the
  // tier-(a) block above for the gating argument).
  setAddedRule(config, "style", "noProcessEnv", "error");
  setAddedRule(
    config,
    "style",
    "noRestrictedImports",
    defaultRestrictedImports()
  );

  // dobby's react preset deliberately couples to the maintainer's TanStack Start
  // stack: two rules must relax under the route dir, where the router owns the file
  // shapes (renaming route files breaks the tree; sorting Route keys breaks head()'s
  // textual-order loaderData inference), and the server graph is banned there.
  // Appended (never clobbering an upstream one). Every glob is `**/`-PREFIXED (not
  // the bare `src/routes/**`): biome anchors override `includes` to biome's CWD via
  // the consumer's own config (extends chain), but to the CONFIG's OWN directory
  // when loaded via `--config-path` (dobby's config-less wrapper, which lives in the
  // dobby package). A bare `src/routes/**` matches only the former; the `**/` prefix
  // matches both (lab-verified against bundled biome 2.5.4 — see the work log). Kept
  // `src/routes/` (not `**/routes/`) for house precision: the TanStack route dir is
  // `src/routes/`.
  config.overrides = [
    ...(config.overrides ?? []),
    {
      includes: [
        "**/src/shared/env.ts",
        "**/src/lib/env.ts",
        "**/src/router.tsx",
        "**/drizzle.config.ts",
        "**/src/emails/**/*.tsx",
      ],
      linter: { rules: { style: { noProcessEnv: "off" } } },
    },
    {
      includes: ["**/src/shared/**"],
      linter: {
        rules: { style: { noRestrictedImports: sharedRestrictedImports() } },
      },
    },
    {
      assist: { actions: { source: { useSortedKeys: "off" } } },
      includes: ["**/src/routes/**"],
      linter: {
        rules: {
          style: {
            noRestrictedImports: routesRestrictedImports(),
            useFilenamingConvention: "off",
          },
        },
      },
    },
  ];

  let body = JSON.stringify(config, null, 2);
  body = injectBefore(
    body,
    '"noArrayIndexKey"',
    REACT_NO_ARRAY_INDEX_KEY_REASON
  );
  body = injectBefore(body, '"noJsxPropsBind"', NO_JSX_PROPS_BIND_REASON);
  body = injectBefore(body, '"noProcessEnv": "error"', PROCESS_ENV_REASON);
  // Indentation-qualified marker: the three override scopes repeat this rule key
  // deeper in the tree, and `injectBefore` takes the FIRST matching line — 8 spaces
  // is the top-level `linter.rules.style` depth of JSON.stringify's 2-space layout.
  body = injectBefore(
    body,
    '        "noRestrictedImports"',
    RESTRICTED_IMPORTS_REASON
  );
  body = injectBefore(
    body,
    '"**/src/shared/env.ts"',
    PROCESS_ENV_ALLOWLIST_REASON
  );
  body = injectBefore(body, '"**/src/shared/**"', SHARED_OVERRIDE_REASON);
  body = injectBefore(body, '"**/src/routes/**"', ROUTES_OVERRIDE_REASON);
  body = injectBefore(
    body,
    '"@neondatabase/serverless"',
    ROUTES_RESTRICTED_IMPORTS_REASON
  );
  body = injectBefore(
    body,
    '"useFilenamingConvention"',
    ROUTES_FILENAME_REASON
  );
  body = injectBefore(body, '"useSortedKeys"', ROUTES_SORTED_KEYS_REASON);
  return `${header(version)}${body}\n`;
}

// The internal config-less ROOT wrapper. Generated (not hand-written) since it now
// carries the tier-(c) `plugins` array — the one place the GritQL rules are declared.
const CONFIGLESS_HEADER: readonly string[] = [
  "// GENERATED — regenerate: bun cli/scripts/vendor-biome.ts",
  "// DO NOT EDIT: drift is gated by src/vendor-biome.test.ts.",
  "//",
  "// Internal config-less ROOT wrapper — NOT a consumer extends target. dobby's",
  "// package.json `exports` expose ONLY `./biome/core` and `./biome/react`, so a",
  "// consumer can never `extends` this file by package specifier (consumers extending",
  "// a wrapper is exactly the non-transitive-extends bug this vendoring kills).",
  "//",
  "// Used ONLY by dobby: `tasks.biomeConfigSpec` points a config-less react app's",
  "// `--config-path` here via `resolveAsset`. Biome's `extends` resolves ONE level",
  "// from the ROOT config, and both targets are now flat/vendored, so nothing is lost.",
  "//",
  "// `plugins` — the tier-(c) GritQL rules — is declared HERE and not in react.jsonc",
  "// because biome resolves a plugin path relative to the ROOT config, never to the",
  "// config that declares it: from this file `../grit/x.grit` lands inside dobby's own",
  "// package, while from a CONSUMER's biome.jsonc extending react.jsonc the same path",
  "// would miss and abort their entire run. See the tier-(c) block in the generator.",
  "",
];

function generateConfiglessReact(): string {
  const config = {
    extends: ["./core.jsonc", "./react.jsonc"],
    plugins: GRIT_PLUGINS,
  };
  return `${CONFIGLESS_HEADER.join("\n")}${JSON.stringify(config, null, 2)}\n`;
}

// Deterministic: reads the INSTALLED ultracite, applies dobby's modifications, and
// returns the three file bodies. The script writes them; the drift test compares them.
export function generateVendoredBiome(): {
  configlessReact: string;
  core: string;
  react: string;
} {
  const version = ultraciteVersion();
  return {
    configlessReact: generateConfiglessReact(),
    core: generateCore(version),
    react: generateReact(version),
  };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));

// The committed output paths, resolved from THIS file's location (so the drift test
// reads the same paths regardless of where it runs from).
export const VENDORED_BIOME_PATHS = {
  configlessReact: join(scriptDir, "..", "biome", "configless.react.jsonc"),
  core: join(scriptDir, "..", "biome", "core.jsonc"),
  react: join(scriptDir, "..", "biome", "react.jsonc"),
} as const;

function isInvokedDirectly(): boolean {
  const [, entry] = process.argv;
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const { configlessReact, core, react } = generateVendoredBiome();
  writeFileSync(VENDORED_BIOME_PATHS.core, core);
  writeFileSync(VENDORED_BIOME_PATHS.react, react);
  writeFileSync(VENDORED_BIOME_PATHS.configlessReact, configlessReact);
  process.stdout.write(
    `vendor-biome: wrote ${Object.values(VENDORED_BIOME_PATHS).join(", ")}\n`
  );
}
