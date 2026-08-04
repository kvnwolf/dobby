import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// TIER (b) — the house stack's convention checks that are facts about the
// FILESYSTEM, not about one file's syntax: a file's NAME (`index.ts`, `utils.ts`,
// `*.client.ts`), its DIRECTORY (a type-based bucket, a central schema dir, a
// module with no CONTEXT.md), the SIBLING it must be paired with, or TWO files
// compared against each other. Biome's native rules (tier a) and the GritQL
// plugins (tier c) both see a single file's syntax and nothing else, so none of
// this is expressible there — and the three CROSS-FILE rules demoted out of tier
// (c) for exactly that reason (C2 / C3 / C12) live here too.
//
// SHAPE: `scanConventions(root, files?)` is PURE fs/content scanning — no AST
// parser, no dependency beyond node:* (ADR-0008: the CLI stays zero-framework and
// loads identically under Bun and vitest/Node). `check.ts` executes it as the
// `{ kind: "conventions" }` step and folds the findings through the SAME reducer as
// biome/tsc, so the gate's exit code and the edit hook's exit-2 contract carry them
// unchanged. `tasks.ts` decides WHETHER the step runs (`conventionsEnabled` — the
// react / tanstack-start capability gate: a non-stack consumer is never judged by
// the house stack's layout).
//
// CAPABILITY-GATED, NOT CONFIGURABLE: every rule below encodes the kit's OWN
// convention skills (`module-conventions`, `data-fetching`) — the role-file
// taxonomy, no barrels, schema co-location, the collection ↔ server-fn pair.
//
// FALSE POSITIVES ARE THE ENEMY. At gate severity a wrong finding turns the gate
// red on conformant code, so every rule here SHRINKS rather than approximates: a
// content rule greps the CONSTRUCT (`pgTable(`, not "pgTable"), an unparseable
// projection is a NOTE and never a finding, and the ceilings each heuristic cannot
// see are named in its own comment.
//
// TWO MODES:
//   - project-wide (`files` omitted) — every rule, over `src/**` plus the ROOT
//     config files, plus WHATEVER build output is currently on disk (B8 reads
//     `.output/public` as it stands; the gate orders its `build` step BEFORE this
//     one so the common path scans a FRESH bundle — see `checkBundleLeak` for the
//     residual stale-output ceiling). Produces notes.
//   - per-file (`files` = ABSOLUTE paths, what `check.ts`'s per-file path and the
//     edit hook resolve) — ONLY the rules that judge the named files themselves.
//     The whole-tree rules (B9 module docs, B8 bundle leak, B4 bucket dirs) are
//     OUT: the model edited one file and must not be nagged about a neighbour's
//     omission (for B4, about the directory's pre-existing debt). No notes
//     either — an edit-adjacent run stays silent unless the edited file is
//     itself wrong.
//
// THE ESCAPE HATCH (the tier-(b) mirror of biome-ignore): a finding site may
// carry `// dobby-allow <RULE-ID>: <non-empty reason>` — an empty reason is NOT
// honored. For the per-file rules the comment lives anywhere in the judged file;
// for C3 (judged per STATEMENT) it must sit in the comment run directly above
// the chain, so blessing one public endpoint never covers its neighbour; for B4
// (judged per DIRECTORY) it lives in the directory's CONTEXT.md. Honored allows
// are counted in a note on the whole-tree path, so they stay visible.

// One convention finding. `path` is repo-RELATIVE with POSIX separators and names
// what the rule judges — the offending FILE for a file rule, the offending
// DIRECTORY for B4/B9, the `collection.browser.ts` for B6/C12 (the half of the pair
// that exists / drifted). `rule` is the convention inventory's own id, so a finding
// is traceable back to the row that motivated it.
interface ConventionFinding {
  message: string;
  path: string;
  rule: string;
}

// The scan result: findings (the gate's `conventions` group) plus single-line
// notes (a check that could not run — rendered as CheckNotes, never as failures).
export interface ConventionsReport {
  findings: ConventionFinding[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------

/**
 * Scan `root` for house-convention violations.
 *
 * @param root - the workroot to scan (the filesystem boundary is injected here,
 *   which is why this needs no mocking: a test points it at a temp tree).
 * @param files - OPTIONAL per-file subset as ABSOLUTE paths. Present = judge only
 *   those files with the rules that apply to a file (see the mode note above).
 * @public - executed by `check.ts` as the conventions gate step.
 */
export function scanConventions(
  root: string,
  files?: string[]
): ConventionsReport {
  const findings: ConventionFinding[] = [];
  const notes: string[] = [];
  const honored: string[] = [];
  const scope =
    files === undefined ? treeScope(root) : subsetScope(root, files);
  const wholeTree = files === undefined;
  const read = fileReader(root);

  for (const file of scope.files) {
    collectFileFindings(file, read, findings, honored);
    checkCollectionPairing(root, file, findings);
  }
  if (wholeTree) {
    // B4 judges the DIRECTORY, not the edited file — like B9, it never runs on
    // the per-file path, so an edit inside a legacy bucket is not hook-blocked
    // on its neighbourhood's pre-existing debt. The full gate still reports it.
    for (const dir of scope.dirs) {
      const bucket = bucketDirectoryRule(dir, read, honored);
      if (bucket !== null) {
        findings.push(bucket);
      }
    }
    checkModuleDocs(scope.files, findings);
    checkBundleLeak(root, findings, notes);
  }
  checkProjections(
    root,
    scope.modules,
    read,
    findings,
    honored,
    wholeTree ? notes : null
  );
  if (wholeTree && honored.length > 0) {
    notes.push(
      `conventions: ${honored.length} dobby-allow suppression(s) honored — ${honored.join(", ")}`
    );
  }

  return { findings, notes };
}

// ---------------------------------------------------------------------------
// Scope — WHAT gets judged, in either mode.
// ---------------------------------------------------------------------------

// The paths one scan judges. `files`/`dirs` are repo-relative POSIX paths;
// `modules` are the module directories whose collection ↔ server-fn projection
// pair C12 compares.
interface Scope {
  dirs: string[];
  files: string[];
  modules: string[];
}

// Directories never walked: dependency/build/tool output. `src` is the only tree
// walked in full, so this mostly guards a stray `src/node_modules`.
const IGNORED_DIRS = new Set([
  ".cache",
  ".dobby",
  ".git",
  ".output",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

// Recursion cap — a deep tree is fine, an unbounded one is a bug (symlinked dirs
// are skipped outright: a symlink is neither isDirectory() nor isFile()).
const MAX_DEPTH = 12;

// Project-wide scope: everything under `src/`, plus the ROOT code files (the
// config layer B7 judges — `drizzle.config.ts`, `vite.config.ts`, …). The root is
// read ONE level deep only; nothing else at the root is a convention's business.
function treeScope(root: string): Scope {
  const files: string[] = [];
  const dirs: string[] = [];
  if (existsSync(join(root, "src"))) {
    walk(root, "src", files, dirs, 0);
  }
  for (const entry of safeReaddir(root)) {
    if (entry.isFile() && CODE_FILE.test(entry.name)) {
      files.push(entry.name);
    }
  }
  return { dirs, files, modules: modulesOf(files) };
}

// Per-file scope: the named files (dropped when they point outside the
// workroot). No directories: the only directory rule that could apply, B4, is
// whole-tree only (see scanConventions).
function subsetScope(root: string, files: string[]): Scope {
  const judged: string[] = [];
  for (const file of files) {
    const rel = toRelative(root, file);
    if (rel !== null) {
      judged.push(rel);
    }
  }
  return { dirs: [], files: judged, modules: modulesOf(judged) };
}

// The module directories worth a projection comparison: those holding either half
// of the data-fetching pair. C12 then requires BOTH halves to exist.
function modulesOf(files: string[]): string[] {
  const modules = new Set<string>();
  for (const file of files) {
    if (!isUnderSrc(file)) {
      continue;
    }
    const base = basenameOf(file);
    if (base === COLLECTION_FILE || base === FUNCTIONS_FILE) {
      modules.add(dirnameOf(file));
    }
  }
  return [...modules];
}

// Collect files + directories under `rel`, depth-capped, ignoring the build/dep
// directories. Tolerant: an unreadable directory contributes nothing.
function walk(
  root: string,
  rel: string,
  files: string[],
  dirs: string[],
  depth: number
): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  for (const entry of safeReaddir(join(root, rel))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      dirs.push(child);
      walk(root, child, files, dirs, depth + 1);
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
}

// ---------------------------------------------------------------------------
// The per-FILE rules (B1 B2 B3 B5 B7 B10 C2 C3). Each takes the repo-relative
// path plus the file's text and returns AT MOST one finding — so the rule set is
// a flat list, and adding a rule is adding a function.
// ---------------------------------------------------------------------------

type FileRule = (file: string, text: string) => ConventionFinding | null;

const CODE_FILE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/;
const INDEX_FILE = /(?:^|\/)index\.tsx?$/;
// The `_Avoid_` column of module-conventions' role table: api/actions/handlers
// (obscure the isomorphic-DCE contract), utils/hooks (browser dumping grounds),
// models/tables/entities (the drizzle-kit glob only finds `schema*`),
// service/db/lib (no boundary at all). Matched on the WHOLE basename, so the
// blessed role file `db.server.ts` is not the generic `db.ts`.
const GENERIC_FILE =
  /(?:^|\/)(?:service|db|lib|api|actions|handlers|hooks|utils|models|tables|entities)\.tsx?$/;
const CLIENT_SUFFIX = /\.client\.tsx?$/;
const SERVER_FILE = /\.server\.tsx?$/;
const ENV_ACCESS = /process\.env|import\.meta\.env/;
// B7 judges CODE, so comments are stripped before ENV_ACCESS runs — prose that
// merely NAMES the API (documenting legacy behavior) must not red the gate. The
// strip is a single-pass character scanner (`withoutComments`), which is where its
// states and its one remaining ceiling are documented.
// The tier-(b) escape hatch, one line: `// dobby-allow <RULE-ID>: <reason>`.
// The trailing `\S` is the non-empty-reason requirement — a bare annotation
// with no justification is NOT honored.
const DOBBY_ALLOW_LINE = /\/\/\s*dobby-allow\s+([A-Z]\d{1,2})\s*:\s*\S/;
// C3 is judged per STATEMENT, so its allow must sit directly above the chain
// (see serverFnGuardRule) — a file-wide C3 allow would silently bless the
// neighbour chain the author never meant to cover.
const STATEMENT_ALLOW_RULES = new Set(["C3"]);
const EMAIL_TEMPLATE = /^src\/emails\/.+\.tsx$/;
const REACT_EMAIL_IMPORT =
  /from\s+["'](?:@react-email\/[^"']+|react-email)["']/;
// Deliberately matches the CALL and not its argument: `.middleware([requireAuth])`
// and `.middleware(sessionMiddlewares)` (a hoisted array constant) are both
// guarded chains, and a literal-array-only match would flag the second one.
const MIDDLEWARE_CALL = /\.middleware\(/;

const ROUTES_DIR = "src/routes";
const SHARED_DIR = "src/shared";
const EMAILS_DIR = "src/emails";
const COLLECTION_FILE = "collection.browser.ts";
const FUNCTIONS_FILE = "functions.ts";

// Tables live in their OWNER module; a central schema directory breaks the
// convention even when the FILENAME is right.
const CENTRAL_SCHEMA_DIRS = ["src/schema/", "src/db/schema/"];

// The files that may read the RAW environment. This set is the tier-(a)
// `noProcessEnv` allowlist VERBATIM (`biome/react.jsonc`) — the env module itself
// (both house locations: `@/shared/env` per module-conventions, `src/lib/env.ts`
// per onboard/migrate-config) plus the files that load OUTSIDE Vite: the router
// (pre-Vite bootstrap), the drizzle-kit and nitro configs (their own processes,
// loaded before the app graph — no @/shared/env to read) and the email
// templates (`EMAIL_TEMPLATE`, rendered by the email CLI). Keeping the two tiers'
// sets identical is what makes B7 a set-EQUALITY check that adds no false positive
// biome would not already report. The set stays CLOSED (known filenames, not a
// `*.config.ts` glob — a config that Vite itself loads has no business here);
// whatever framework config it misses next reaches for `// dobby-allow B7: …`.
const ENV_EXCEPTIONS = new Set([
  "drizzle.config.ts",
  "nitro.config.ts",
  "src/lib/env.ts",
  "src/router.tsx",
  "src/shared/env.ts",
]);

const FILE_RULES: FileRule[] = [
  barrelRule,
  genericNameRule,
  clientSuffixRule,
  tableLocationRule,
  envAccessRule,
  emailTemplateRule,
  middlewareLocationRule,
  serverFnGuardRule,
];

// Run every file rule over one judged path. Non-code files (CONTEXT.md, assets)
// are skipped wholesale — no rule here judges them, and not reading them keeps a
// binary asset out of the scanner. A finding whose rule the file dobby-allows
// (with a reason) is dropped into `honored` instead — except the per-statement
// rules, which honor their own site-scoped allow (see STATEMENT_ALLOW_RULES).
function collectFileFindings(
  file: string,
  read: (path: string) => string,
  findings: ConventionFinding[],
  honored: string[]
): void {
  if (!CODE_FILE.test(file)) {
    return;
  }
  const text = read(file);
  const allowed = allowedRules(text);
  for (const rule of FILE_RULES) {
    const found = rule(file, text);
    if (found === null) {
      continue;
    }
    if (allowed.has(found.rule) && !STATEMENT_ALLOW_RULES.has(found.rule)) {
      honored.push(`${found.rule} ${file}`);
      continue;
    }
    findings.push(found);
  }
  // A per-statement allow (C3) is honored INSIDE its rule, so it never flows
  // through the filter above — surface it in the count when the file ended
  // clean. (A leftover annotation with nothing left to suppress lands here too;
  // that visibility is what gets it cleaned up.)
  for (const rule of STATEMENT_ALLOW_RULES) {
    const clean = !findings.some(
      (found) => found.rule === rule && found.path === file
    );
    if (allowed.has(rule) && clean) {
      honored.push(`${rule} ${file}`);
    }
  }
}

// B1 — no barrels. A route file is exempt: `src/routes/**/index.tsx` is a ROUTE
// (TanStack Router's index segment), not a re-export.
function barrelRule(file: string): ConventionFinding | null {
  if (
    !isUnderSrc(file) ||
    isUnder(file, ROUTES_DIR) ||
    !INDEX_FILE.test(file)
  ) {
    return null;
  }
  return finding(
    "B1",
    file,
    "barrel file — a module has no index re-export; import the role file by its deep path (@/module/file)"
  );
}

// B2 — no generic, role-less filenames. Route files keep their own naming (the
// router owns it).
function genericNameRule(file: string): ConventionFinding | null {
  if (
    !isUnderSrc(file) ||
    isUnder(file, ROUTES_DIR) ||
    !GENERIC_FILE.test(file)
  ) {
    return null;
  }
  return finding(
    "B2",
    file,
    "generic filename — name the file by its ROLE ({descriptor}.server.ts · functions.ts · {descriptor}.browser.ts · schema.ts) or descriptively; the filename is the module's interface"
  );
}

// B3 — `.client.ts` is not a boundary suffix.
function clientSuffixRule(file: string): ConventionFinding | null {
  if (!(isUnderSrc(file) && CLIENT_SUFFIX.test(file))) {
    return null;
  }
  return finding(
    "B3",
    file,
    "'.client' is not a boundary suffix — it reads like the mirror of '.server' but TanStack Start enforces nothing on it (a false compile guarantee); browser-only code lives in {descriptor}.browser.ts"
  );
}

// B5 — tables live in a CO-LOCATED schema file. Content-gated on the `pgTable(`
// CALL, so prose mentioning the helper never fires.
function tableLocationRule(
  file: string,
  text: string
): ConventionFinding | null {
  if (!(isUnderSrc(file) && text.includes("pgTable("))) {
    return null;
  }
  const base = basenameOf(file);
  const coLocated = base === "schema.ts" || base === "schema.gen.ts";
  const central = CENTRAL_SCHEMA_DIRS.some((dir) => file.startsWith(dir));
  if (coLocated && !central) {
    return null;
  }
  return finding(
    "B5",
    file,
    "pgTable declared outside a co-located schema file — tables live in their OWNER module as {module}/schema.ts or schema.gen.ts (drizzle-kit finds them by the src/**/schema*.ts glob), never in a central schema directory"
  );
}

// B7 — the env exception set is CLOSED (see ENV_EXCEPTIONS). Judges `src/**` and
// the root config layer, so a new out-of-Vite file is caught the day it appears.
// Comments are stripped first: a comment that NAMES process.env is prose, not a
// read.
function envAccessRule(file: string, text: string): ConventionFinding | null {
  const inScope = isUnderSrc(file) || isRootFile(file);
  if (!(inScope && ENV_ACCESS.test(withoutComments(text)))) {
    return null;
  }
  if (ENV_EXCEPTIONS.has(file) || EMAIL_TEMPLATE.test(file)) {
    return null;
  }
  return finding(
    "B7",
    file,
    "reads process.env / import.meta.env — app code reads the validated env from @/shared/env; only the env module and the files that load outside Vite (src/router.tsx, drizzle.config.ts, nitro.config.ts, src/emails/**/*.tsx) may read the raw environment"
  );
}

// B10 — react-email TEMPLATES live at `src/emails/`. The discriminator is the
// `.tsx` extension: `notifications/send.server.ts` legitimately imports
// `@react-email/render` to RENDER a template and is not one itself.
function emailTemplateRule(
  file: string,
  text: string
): ConventionFinding | null {
  const outsideEmailsDir = isUnderSrc(file) && !isUnder(file, EMAILS_DIR);
  if (!(outsideEmailsDir && file.endsWith(".tsx"))) {
    return null;
  }
  if (!REACT_EMAIL_IMPORT.test(text)) {
    return null;
  }
  return finding(
    "B10",
    file,
    "react-email template outside src/emails — templates live at src/emails/ (the sender that renders them stays in its own module)"
  );
}

// C2 (demoted from tier c — resolving a middleware reference is cross-file).
// "Server fns + their middlewares" is the `functions.ts` role; a `.server` file is
// for eager instances and server-only logic.
function middlewareLocationRule(
  file: string,
  text: string
): ConventionFinding | null {
  if (!(isUnderSrc(file) && SERVER_FILE.test(file))) {
    return null;
  }
  if (!text.includes("createMiddleware(")) {
    return null;
  }
  return finding(
    "C2",
    file,
    "createMiddleware declared in a .server file — server functions AND their middlewares live in the module's functions.ts"
  );
}

// C3 (demoted from tier c) — a server fn is a publicly invokable HTTP endpoint and
// a route guard does NOT protect it.
//
// CEILING (deliberate, and why this is not a tier-(c) pattern): the check is a
// SAME-FILE statement scan. It walks each `createServerFn(` chain to the `;` that
// ends it and asks only whether that chain calls `.middleware(` AT ALL — it can
// neither resolve WHICH middleware the argument names (cross-file) nor know that a
// login/signup endpoint is legitimately public. Requiring the literal name
// `requireAuth` was rejected for that reason: a house app whose session middleware
// is named otherwise would go red on conformant code, and so was requiring a
// LITERAL array (`.middleware([…])`), which would flag the equally conformant
// `.middleware(sessionMiddlewares)`. So the rule fires ONLY on a chain with NO
// `.middleware(` call at all — a false NEGATIVE (a chain guarded by an unrelated
// middleware passes, and so does a public endpoint that carries any middleware) in
// exchange for no false positive.
//
// A DELIBERATELY public endpoint is blessed per chain: `// dobby-allow C3: <why>`
// in the comment run directly above the declaration (the doc block over it
// counts). Per chain, not per file — see STATEMENT_ALLOW_RULES.
//
// SCOPED to `src/**` like every other rule here: in per-file mode this judges
// whatever absolute path it is handed, and a `scripts/functions.ts` is not a
// module's server-fn file.
function serverFnGuardRule(
  file: string,
  text: string
): ConventionFinding | null {
  const isModuleFunctionsFile =
    isUnderSrc(file) && basenameOf(file) === FUNCTIONS_FILE;
  if (!isModuleFunctionsFile) {
    return null;
  }
  const marker = "createServerFn(";
  let index = text.indexOf(marker);
  while (index !== -1) {
    const end = statementEnd(text, index);
    const chain = text.slice(index, end);
    if (!(MIDDLEWARE_CALL.test(chain) || allowsAbove(text, index).has("C3"))) {
      return finding(
        "C3",
        file,
        "createServerFn chain with no .middleware(…) — a server fn is a publicly invokable HTTP endpoint and route guards do NOT protect it; add the session middleware (requireAuth) or mark it '// dobby-allow C3: <why it is public>'"
      );
    }
    index = text.indexOf(marker, end);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The DIRECTORY / SIBLING rules (B4 B6 B9).
// ---------------------------------------------------------------------------

// The type-based buckets module-conventions rejects, as IMMEDIATE children of
// `src/`: grouping by kind scatters one feature across six folders.
const BUCKET_DIRS = new Set([
  "components",
  "hooks",
  "lib",
  "services",
  "utils",
]);
// The scatter folder for a single-use sub-piece — a bucket by another name, at any
// depth.
const SCATTER_DIR = "-components";
// A directory is a MODULE when it holds at least one role file.
const ROLE_FILE =
  /^(?:functions\.ts|schema\.ts|schema\.gen\.ts|.+\.server\.ts|.+\.browser\.ts)$/;
const MODULE_DOC = "CONTEXT.md";
const SRC_DEPTH = 2;

// B4 — a type-based bucket directory. `src/shared/` is the blessed cross-cutting
// module, so nothing inside it is a bucket. WHOLE-TREE ONLY (B9's own reasoning
// applies: the bucket is a fact about the DIRECTORY, so the edit hook must not
// block an unrelated edit inside a legacy bucket on move-before-edit ordering).
// A directory judged a bucket may be blessed via `dobby-allow B4: <reason>` in
// its CONTEXT.md — the one place a directory-level annotation can live.
function bucketDirectoryRule(
  dir: string,
  read: (path: string) => string,
  honored: string[]
): ConventionFinding | null {
  if (!isUnderSrc(dir) || isUnder(dir, SHARED_DIR)) {
    return null;
  }
  const segments = dir.split("/");
  const name = segments.at(-1) ?? "";
  const bucket =
    name === SCATTER_DIR ||
    (segments.length === SRC_DEPTH && BUCKET_DIRS.has(name));
  if (!bucket) {
    return null;
  }
  if (allowedRules(read(`${dir}/${MODULE_DOC}`)).has("B4")) {
    honored.push(`B4 ${dir}`);
    return null;
  }
  return finding(
    "B4",
    dir,
    "type-based bucket directory — group by FEATURE, not by kind; move each file into the module that owns it (src/shared/ is the one blessed cross-cutting module)"
  );
}

// B6 — the data-fetching recipe is a PAIR: the eager collection in
// `{module}/collection.browser.ts` is fed by a server fn in the SAME module's
// `functions.ts`. Other `.browser.ts` role files (a Better Auth client) carry no
// such pairing, so the rule keys on the collection filename alone.
function checkCollectionPairing(
  root: string,
  file: string,
  findings: ConventionFinding[]
): void {
  if (!isUnderSrc(file) || basenameOf(file) !== COLLECTION_FILE) {
    return;
  }
  if (existsSync(join(root, dirnameOf(file), FUNCTIONS_FILE))) {
    return;
  }
  findings.push(
    finding(
      "B6",
      file,
      "collection.browser.ts with no sibling functions.ts — the eager collection is half the recipe; its rows come from a createServerFn in the module's functions.ts"
    )
  );
}

// B9 — every module documents itself. A module is a directory holding at least one
// ROLE file; a directory of plain components or email templates is not one, and
// `src/routes/**` is the router's tree, not a module.
//
// WHOLE-TREE ONLY: on the per-file path a missing CONTEXT.md is a fact about the
// DIRECTORY, not about the file the model just edited — nagging there would block
// an edit on a neighbour's omission.
function checkModuleDocs(files: string[], findings: ConventionFinding[]): void {
  const byDirectory = new Map<string, string[]>();
  for (const file of files) {
    if (!isUnderSrc(file) || isUnder(file, ROUTES_DIR)) {
      continue;
    }
    const dir = dirnameOf(file);
    if (dir === "src") {
      continue;
    }
    const names = byDirectory.get(dir) ?? [];
    names.push(basenameOf(file));
    byDirectory.set(dir, names);
  }
  for (const [dir, names] of byDirectory) {
    const isModule = names.some((name) => ROLE_FILE.test(name));
    if (isModule && !names.includes(MODULE_DOC)) {
      findings.push(
        finding(
          "B9",
          dir,
          "module directory without a CONTEXT.md — every module documents its files, its interface, its invariants and what is intentionally NOT there"
        )
      );
    }
  }
}

// ---------------------------------------------------------------------------
// B8 — the import-protection verify step, mechanized.
// ---------------------------------------------------------------------------

// The server-only constructs that must never appear in a client asset — the same
// set the `.server` boundary (tier-(c) C4) protects.
const BUNDLE_SYMBOLS = [
  "betterAuth(",
  "new Pool(",
  "drizzle(",
  "new Resend(",
  "neonConfig",
];
const BUNDLE_ASSET = /\.(?:js|mjs|cjs|html)$/;
const BUNDLE_DIR = ".output/public";

// B8 — after a build, the CLIENT bundle must carry no server-only symbol. BUILD
// GATED: with no build output there is nothing to judge, so the check reports a
// SKIP note rather than passing silently (the build-gated step pattern) — a silent
// pass would read as "the bundle is clean".
//
// CEILING — it judges the bundle ON DISK, which it does not itself produce.
// `checkPipeline` puts the gate's `build` step BEFORE the conventions step so the
// common full-gate path scans the bundle THIS run just built; but when the build
// step is skipped (no `vite` capability, no consumer vite binary) or fails, an
// `.output/public` left by an EARLIER build is what gets scanned — so a leak fixed
// since that build still reads as red, and a bundle deleted since then reads as a
// skip. The remedy is a real build, never a rule change.
function checkBundleLeak(
  root: string,
  findings: ConventionFinding[],
  notes: string[]
): void {
  if (!existsSync(join(root, ".output", "public"))) {
    notes.push(
      `conventions: bundle scan skipped (B8) — no ${BUNDLE_DIR} to scan (build first)`
    );
    return;
  }
  const files: string[] = [];
  const dirs: string[] = [];
  walk(root, BUNDLE_DIR, files, dirs, 0);
  for (const file of files) {
    if (!BUNDLE_ASSET.test(file)) {
      continue;
    }
    const text = readText(root, file);
    const leaked = BUNDLE_SYMBOLS.find((symbol) => text.includes(symbol));
    if (leaked !== undefined) {
      findings.push(
        finding(
          "B8",
          file,
          `client bundle carries the server-only '${leaked}' — a .server boundary leaked into the client build`
        )
      );
    }
  }
}

// ---------------------------------------------------------------------------
// C12 (demoted from tier c — the two halves live in different files).
// ---------------------------------------------------------------------------

// C12 — the collection's row shape is FIXED by its server fn: the
// `.pick({…})` key set in `collection.browser.ts` must equal the `.select({…})`
// key set in `functions.ts`. Compared as SETS (key order is free).
//
// CEILINGS: both sides are read from the source TEXT (balanced-brace scan, no
// AST). On the SELECT side a `db.select(<identifier>)` is resolved to a
// same-file `const <identifier> = {…}` object literal (the hoisted-projection
// shape the house code actually writes); a projection built from a spread, a
// computed key or an import stays UNPARSEABLE — a NOTE and never a finding. A
// `functions.ts` holding several server fns is satisfied when ANY of its
// readable select sets matches, so a multi-fn module is never flagged on an
// unrelated fn's projection.
function checkProjections(
  root: string,
  modules: string[],
  read: (path: string) => string,
  findings: ConventionFinding[],
  honored: string[],
  notes: string[] | null
): void {
  for (const dir of modules) {
    const collection = `${dir}/${COLLECTION_FILE}`;
    const functions = `${dir}/${FUNCTIONS_FILE}`;
    const bothHalves =
      existsSync(join(root, collection)) && existsSync(join(root, functions));
    if (!bothHalves) {
      continue;
    }
    const picks = projectionKeys(read(collection), ".pick(");
    if (picks.length === 0) {
      // No projection at all: this collection is not the pick/select recipe.
      continue;
    }
    const picked = picks.find(isKeySet);
    if (picked === undefined) {
      notes?.push(
        `conventions: projection check skipped (C12) for ${dir} — the collection's .pick(…) is not a literal object`
      );
      continue;
    }
    const selected = selectKeySets(read(functions)).filter(isKeySet);
    if (selected.length === 0) {
      notes?.push(
        `conventions: projection check skipped (C12) for ${dir} — no readable .select({…}) in ${FUNCTIONS_FILE}`
      );
      continue;
    }
    if (selected.some((keys) => sameKeys(keys, picked))) {
      continue;
    }
    if (allowedRules(read(collection)).has("C12")) {
      honored.push(`C12 ${collection}`);
      continue;
    }
    findings.push(
      finding(
        "C12",
        collection,
        `the collection's .pick({…}) keys (${list(picked)}) differ from the server fn's .select({…}) keys (${list(selected[0] ?? new Set<string>())}) — the row shape is fixed by the server fn and must match exactly`
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Text scanning — the balanced-delimiter helpers every content rule shares.
// Deliberately small and string-only: ADR-0008 keeps the CLI free of an AST
// dependency, so "a statement" and "an object literal" are delimiter walks.
// ---------------------------------------------------------------------------

const OBJECT_KEY =
  /^\s*(?:"([A-Za-z_$][\w$]*)"|'([A-Za-z_$][\w$]*)'|([A-Za-z_$][\w$]*))\s*:/;
const WHITESPACE = /\s/;
const OPENERS = "([{";
const CLOSERS = ")]}";
const QUOTES = "\"'`";

// The significant characters after which a `/` opens a REGEX literal rather than
// dividing: an operator, an opener or a separator — the standard prev-token
// heuristic (start-of-file counts too). After anything else (an identifier, `)`,
// a literal) the `/` is division.
const REGEX_PRECEDERS = "=(,:[!&|?;{}+-*%~^<>";

// The keyword extension of that heuristic: these keywords are followed by an
// EXPRESSION, so a `/` after one can only open a regex literal — never divide.
// (`return /[//]/` is the case a character-only rule gets wrong.)
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

// What may appear INSIDE an identifier — the word-boundary test for the keyword
// extension (`myreturn` must not read as `return`).
const IDENTIFIER_CHAR = /[\w$]/;

// `text` with `/* */` blocks and `//` line comments removed. A single-pass
// character SCANNER, not a regex (no parser either — ADR-0008), because only a
// scanner can decide what a `/` MEANS. Its states:
//   - normal      — copy through; `//` drops to end of line, `/*` drops through
//                   `*/` (newlines inside a dropped comment are not preserved:
//                   B7 only regex-tests the result, no line numbers ride on it).
//   - string      — `"` / `'` / `` ` `` copy VERBATIM to their closing quote,
//                   backslash-escape aware. A template is copied whole without
//                   parsing `${…}`, so an interpolated read stays VISIBLE.
//   - regex       — a `/` in a REGEX_PRECEDERS position, or after one of the
//                   REGEX_PRECEDING_KEYWORDS (`return /[//]/`), copies verbatim to
//                   its closing `/`, with `[…]` classes swallowing slashes; a `/`
//                   anywhere else is division and copies as one character.
// This is what spares a `//` inside a string (a URL, a path fragment) AND inside a
// regex character class (`/[//]/`) from being read as a comment — either would
// erase the rest of its line and with it a real env read after it.
//
// CEILING: with the operator and keyword positions both covered, the residue is a
// regex literal carrying RAW consecutive slashes written directly after `)`, `]`
// or a non-keyword identifier — `if (x) /[//]/.test(s)`, where the very same text
// is a division in `(a + b) /[c]/ d`. That position is genuinely ambiguous without
// grammar context (a real lexer resolves it from the parser state, not from the
// previous token), so it stays out of reach here; the failure there is the
// pre-existing one — the line's tail is dropped. A string literal that spells out
// `process.env` in prose remains the accepted false-positive ceiling.
function withoutComments(text: string): string {
  let kept = "";
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (char === "/" && next === "/") {
      index = lineCommentEnd(text, index);
    } else if (char === "/" && next === "*") {
      index = blockCommentEnd(text, index);
    } else {
      const literalEnd = literalRun(text, index, kept);
      kept += text.slice(index, literalEnd);
      index = literalEnd;
    }
  }
  return kept;
}

// The index just past the run starting at `index` that must be COPIED: a whole
// string/template literal, a whole regex literal, or a single ordinary character.
// `kept` is the output so far — the regex-vs-division decision reads its last
// significant character.
function literalRun(text: string, index: number, kept: string): number {
  const char = text.charAt(index);
  if (QUOTES.includes(char)) {
    return stringEnd(text, index);
  }
  if (char === "/" && startsRegex(kept)) {
    return regexEnd(text, index);
  }
  return index + 1;
}

// The index OF the `\n` that ends the `//` comment at `from` (text.length when it
// runs to EOF) — the newline itself is kept, so the prev-token scan-back still
// sees the line break.
function lineCommentEnd(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end;
}

// The index just past the `*/` closing the block comment at `from` (text.length
// when it never closes).
function blockCommentEnd(text: string, from: number): number {
  const end = text.indexOf("*/", from + 2);
  return end === -1 ? text.length : end + 2;
}

// The index just past the string literal opening at `open`, backslash-escape
// aware. `"` / `'` stop at a newline (JS forbids one inside them, so an
// apostrophe in JSX prose can never swallow the rest of the file); a template
// literal spans lines and is copied through its closing backtick WITHOUT parsing
// `${…}` — an interpolated `process.env` read therefore stays visible.
function stringEnd(text: string, open: number): number {
  const quote = text.charAt(open);
  let index = open + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    if (char === "\n" && quote !== "`") {
      return index;
    }
    index += 1;
  }
  return text.length;
}

// The index just past the regex literal opening at `open`. Escape aware, and a
// `[…]` character class swallows `/` — which is exactly what makes `/[//]/` close
// at its LAST slash instead of being read as a comment. A newline ends the scan
// (a regex literal cannot span lines).
function regexEnd(text: string, open: number): number {
  let index = open + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      return index;
    }
    if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

// Whether a `/` following `kept` opens a regex literal: the last significant
// character of the output so far is an operator/opener/separator, there is none
// at all (start of file), or the word ending there is one of the keywords that
// must be followed by an expression. Reading the KEPT text rather than the source
// is deliberate — a comment already dropped must not count as a token.
function startsRegex(kept: string): boolean {
  let index = kept.length - 1;
  while (index >= 0 && WHITESPACE.test(kept.charAt(index))) {
    index -= 1;
  }
  if (index < 0) {
    return true;
  }
  const char = kept.charAt(index);
  if (REGEX_PRECEDERS.includes(char)) {
    return true;
  }
  return IDENTIFIER_CHAR.test(char) && endsWithRegexKeyword(kept, index);
}

// Whether the identifier word ENDING at `end` is one of REGEX_PRECEDING_KEYWORDS.
// The word is taken back to its real boundary (the run of identifier characters),
// so `myreturn` reads as `myreturn` and stays division; a word reached through `.`
// is a PROPERTY named like a keyword (`iterator.return / 2`), which divides too.
function endsWithRegexKeyword(kept: string, end: number): boolean {
  let start = end;
  while (start > 0 && IDENTIFIER_CHAR.test(kept.charAt(start - 1))) {
    start -= 1;
  }
  if (kept.charAt(start - 1) === ".") {
    return false;
  }
  return REGEX_PRECEDING_KEYWORDS.has(kept.slice(start, end + 1));
}

// Every rule id the text dobby-allows WITH a reason, wherever the annotation
// sits in it. File-granular on purpose: each per-file rule emits at most one
// finding per file, so "anywhere in the file" and "at the site" suppress the
// same thing — the per-statement rules opt out via STATEMENT_ALLOW_RULES.
function allowedRules(text: string): Set<string> {
  const rules = new Set<string>();
  for (const line of text.split("\n")) {
    const match = DOBBY_ALLOW_LINE.exec(line);
    if (match?.[1] !== undefined) {
      rules.add(match[1]);
    }
  }
  return rules;
}

// The rule ids dobby-allowed in the contiguous `//` comment run directly above
// the statement starting at `from` — the site-scoped allow the per-statement
// rules (C3) honor. The run may be the declaration's own doc block; a blank
// line or any code line ends it.
function allowsAbove(text: string, from: number): Set<string> {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const lines = text.slice(0, lineStart).split("\n");
  const rules = new Set<string>();
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (!line.startsWith("//")) {
      break;
    }
    const match = DOBBY_ALLOW_LINE.exec(line);
    if (match?.[1] !== undefined) {
      rules.add(match[1]);
    }
  }
  return rules;
}

// The identifier argument of a call: `(facilityColumns)` — used to resolve
// `db.select(<identifier>)` to its same-file `const` initializer.
const IDENTIFIER_ARG = /^\s*([A-Za-z_$][\w$]*)\s*\)/;

// The key sets of every `.select(…)` in a functions.ts, in source order: a
// readable object literal is read directly; an IDENTIFIER argument is resolved
// to a same-file `const <identifier> = {…}` literal (the hoisted-projection
// shape). Anything else is null — the caller's skip, never a finding.
function selectKeySets(text: string): (Set<string> | null)[] {
  const marker = ".select(";
  const results: (Set<string> | null)[] = [];
  let index = text.indexOf(marker);
  while (index !== -1) {
    const argAt = index + marker.length;
    const body = objectAfter(text, argAt);
    results.push(
      body === null ? resolvedConstKeys(text, argAt) : objectKeys(body)
    );
    index = text.indexOf(marker, argAt);
  }
  return results;
}

// Resolve the identifier at `argAt` to the keys of its same-file
// `const <name> = {…}` object-literal initializer (null when the argument is
// not a bare identifier, the const is elsewhere, or its initializer is not a
// readable literal).
function resolvedConstKeys(text: string, argAt: number): Set<string> | null {
  const name = IDENTIFIER_ARG.exec(text.slice(argAt))?.[1];
  if (name === undefined) {
    return null;
  }
  const declaration = `const ${name} =`;
  const at = text.indexOf(declaration);
  if (at === -1) {
    return null;
  }
  const body = objectAfter(text, at + declaration.length);
  return body === null ? null : objectKeys(body);
}

// The index just past the `;` that closes the expression starting at `from`
// (text.length when there is none).
function statementEnd(text: string, from: number): number {
  let depth = 0;
  let index = from;
  let quote = "";
  while (index < text.length) {
    const char = text.charAt(index);
    if (quote !== "") {
      index += char === "\\" ? 2 : 1;
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (QUOTES.includes(char)) {
      quote = char;
    } else if (OPENERS.includes(char)) {
      depth += 1;
    } else if (CLOSERS.includes(char)) {
      depth -= 1;
    } else if (char === ";" && depth <= 0) {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

// The key sets of every `marker({…})` occurrence in `text`, in source order. An
// entry is `null` when that occurrence's argument is not a readable object
// literal (a constant, a spread, a computed key) — the caller turns that into a
// skip note, never a finding.
function projectionKeys(text: string, marker: string): (Set<string> | null)[] {
  const results: (Set<string> | null)[] = [];
  let index = text.indexOf(marker);
  while (index !== -1) {
    const body = objectAfter(text, index + marker.length);
    results.push(body === null ? null : objectKeys(body));
    index = text.indexOf(marker, index + marker.length);
  }
  return results;
}

// The BODY of the object literal starting at/after `from` (null when the next
// non-space character is not `{`, or the braces never balance).
function objectAfter(text: string, from: number): string | null {
  let index = from;
  while (index < text.length && WHITESPACE.test(text.charAt(index))) {
    index += 1;
  }
  if (text.charAt(index) !== "{") {
    return null;
  }
  return balancedBraces(text, index);
}

// The text between `{` at `open` and its matching `}` (null when unbalanced).
function balancedBraces(text: string, open: number): string | null {
  let depth = 0;
  let index = open;
  let quote = "";
  while (index < text.length) {
    const char = text.charAt(index);
    if (quote !== "") {
      index += char === "\\" ? 2 : 1;
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (QUOTES.includes(char)) {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
    index += 1;
  }
  return null;
}

// The KEY set of an object-literal body, or null when ANY entry is not a plain
// `key: value` (a spread, a shorthand, a computed key, a comment) — an
// approximate key set would be a false positive waiting to happen.
function objectKeys(body: string): Set<string> | null {
  const keys = new Set<string>();
  for (const entry of topLevelEntries(body)) {
    if (entry.trim() === "") {
      continue;
    }
    const match = OBJECT_KEY.exec(entry);
    const key = match?.[1] ?? match?.[2] ?? match?.[3];
    if (key === undefined) {
      return null;
    }
    keys.add(key);
  }
  return keys.size === 0 ? null : keys;
}

// Split an object body on the commas at depth 0 (nested objects/arrays/calls and
// string contents are left alone).
function topLevelEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let index = 0;
  let start = 0;
  let quote = "";
  while (index < body.length) {
    const char = body.charAt(index);
    if (quote !== "") {
      index += char === "\\" ? 2 : 1;
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (QUOTES.includes(char)) {
      quote = char;
    } else if (OPENERS.includes(char)) {
      depth += 1;
    } else if (CLOSERS.includes(char)) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  entries.push(body.slice(start));
  return entries;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

function finding(
  rule: string,
  path: string,
  message: string
): ConventionFinding {
  return { message, path, rule };
}

// A memoizing reader — several rules read the same file, and C12 reads a sibling
// the file loop already read. An unreadable file folds to "" (never a throw).
function fileReader(root: string): (path: string) => string {
  const cache = new Map<string, string>();
  return (path: string): string => {
    const hit = cache.get(path);
    if (hit !== undefined) {
      return hit;
    }
    const text = readText(root, path);
    cache.set(path, text);
    return text;
  };
}

function readText(root: string, path: string): string {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return "";
  }
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// An absolute (or caller-relative) path as a repo-relative POSIX path, or null
// when it points OUTSIDE the workroot — the per-file guard.
function toRelative(root: string, path: string): string | null {
  const rel = relative(root, resolve(root, path));
  if (rel === "" || rel.startsWith("..")) {
    return null;
  }
  return rel.split(sep).join("/");
}

function isUnderSrc(path: string): boolean {
  return path === "src" || path.startsWith("src/");
}

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function isRootFile(path: string): boolean {
  return !path.includes("/");
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function isKeySet(keys: Set<string> | null): keys is Set<string> {
  return keys !== null;
}

function sameKeys(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function list(keys: Set<string>): string {
  return [...keys].sort().join(", ");
}
