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
// to the maintainer's TanStack Start stack). Three injected blocks: the group
// header, plus one rationale per relaxed rule.
const ROUTES_OVERRIDE_REASON: readonly string[] = [
  "// TanStack Start stack coupling: under the route dir the router owns the file",
  "// shapes, so two rules relax there (rationale beside each rule). Glob is `**/`-",
  "// prefixed so it anchors under BOTH the consumer's extends chain AND dobby's",
  "// config-less `--config-path` wrapper (biome anchors override globs to the",
  "// config's own dir there, not the project cwd) — lab-verified, bundled biome.",
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
// ultracite's react config omits.
function setAddedRule(
  config: BiomeConfig,
  group: string,
  rule: string,
  value: string
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

  // dobby's react preset deliberately couples to the maintainer's TanStack Start
  // stack: two rules must relax under the route dir, where the router owns the file
  // shapes (renaming route files breaks the tree; sorting Route keys breaks head()'s
  // textual-order loaderData inference). Appended (never clobbering an upstream one).
  // The glob is `**/`-PREFIXED (not the bare `src/routes/**`): biome anchors override
  // `includes` to biome's CWD via the consumer's own config (extends chain), but to
  // the CONFIG's OWN directory when loaded via `--config-path` (dobby's config-less
  // wrapper, which lives in the dobby package). A bare `src/routes/**` matches only
  // the former; the `**/` prefix matches both (lab-verified against bundled biome
  // 2.5.4 — see the work log). Kept `src/routes/` (not `**/routes/`) for house
  // precision: the TanStack route dir is `src/routes/`.
  config.overrides = [
    ...(config.overrides ?? []),
    {
      assist: { actions: { source: { useSortedKeys: "off" } } },
      includes: ["**/src/routes/**"],
      linter: { rules: { style: { useFilenamingConvention: "off" } } },
    },
  ];

  let body = JSON.stringify(config, null, 2);
  body = injectBefore(
    body,
    '"noArrayIndexKey"',
    REACT_NO_ARRAY_INDEX_KEY_REASON
  );
  body = injectBefore(body, '"noJsxPropsBind"', NO_JSX_PROPS_BIND_REASON);
  body = injectBefore(body, '"**/src/routes/**"', ROUTES_OVERRIDE_REASON);
  body = injectBefore(
    body,
    '"useFilenamingConvention"',
    ROUTES_FILENAME_REASON
  );
  body = injectBefore(body, '"useSortedKeys"', ROUTES_SORTED_KEYS_REASON);
  return `${header(version)}${body}\n`;
}

// Deterministic: reads the INSTALLED ultracite, applies dobby's modifications, and
// returns the two file bodies. The script writes them; the drift test compares them.
export function generateVendoredBiome(): { core: string; react: string } {
  const version = ultraciteVersion();
  return { core: generateCore(version), react: generateReact(version) };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));

// The committed output paths, resolved from THIS file's location (so the drift test
// reads the same paths regardless of where it runs from).
export const VENDORED_BIOME_PATHS = {
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
  const { core, react } = generateVendoredBiome();
  writeFileSync(VENDORED_BIOME_PATHS.core, core);
  writeFileSync(VENDORED_BIOME_PATHS.react, react);
  process.stdout.write(
    `vendor-biome: wrote ${VENDORED_BIOME_PATHS.core} and ${VENDORED_BIOME_PATHS.react}\n`
  );
}
