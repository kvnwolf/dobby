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

// dobby's common consumer ignores, appended to ultracite's `files.includes`:
// Claude Code's dir (worktrees live under .claude — scanning them double-lints
// every file), dobby's own runtime state, CI config, and markdown.
const DOBBY_IGNORES: readonly string[] = [
  "!.claude",
  "!.dobby",
  "!.github",
  "!**/*.md",
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

// The biome-config subset this generator reaches into. Everything else rides
// through opaque via the parse -> mutate -> serialize round-trip.
interface BiomeConfig {
  $schema?: string;
  files?: { includes?: string[] };
  linter?: { rules?: { suspicious?: Record<string, unknown> } };
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

// The `suspicious` rule bag, or a hard error if ultracite restructured (a drift
// signal in its own right).
function suspiciousRules(config: BiomeConfig): Record<string, unknown> {
  const suspicious = config.linter?.rules?.suspicious;
  if (suspicious === undefined) {
    throw new Error(
      "vendor-biome: ultracite config has no linter.rules.suspicious"
    );
  }
  return suspicious;
}

function generateCore(version: string): string {
  const config = parseJsonc(
    readFileSync(requireFrom.resolve("ultracite/biome/core"), "utf8")
  );
  config.$schema = SCHEMA_URL;
  suspiciousRules(config).noArrayIndexKey = "off";
  const includes = config.files?.includes;
  if (includes === undefined) {
    throw new Error("vendor-biome: ultracite core has no files.includes");
  }
  includes.push(...DOBBY_IGNORES);

  let body = JSON.stringify(config, null, 2);
  body = injectBefore(body, '"noArrayIndexKey"', NO_ARRAY_INDEX_KEY_REASON);
  body = injectBefore(body, '"!.claude"', IGNORES_REASON);
  return `${header(version)}${body}\n`;
}

function generateReact(version: string): string {
  const config = parseJsonc(
    readFileSync(requireFrom.resolve("ultracite/biome/react"), "utf8")
  );
  config.$schema = SCHEMA_URL;
  suspiciousRules(config).noArrayIndexKey = "off";

  let body = JSON.stringify(config, null, 2);
  body = injectBefore(
    body,
    '"noArrayIndexKey"',
    REACT_NO_ARRAY_INDEX_KEY_REASON
  );
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
