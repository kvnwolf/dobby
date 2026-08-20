import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CommandContext,
  type CommandResult,
  notImplemented,
} from "./command.ts";
import { detectCapabilities } from "./detect.ts";
import { resolveAsset, resolveWorkroot, runCapture } from "./runner.ts";

// The ARTIFACT LINTERS — one module for the whole family, because they share a
// single shape (read an artifact, run its check inventory, answer with findings +
// a nonzero exit) and differ only in the inventory:
//
//   - `spec lint`        — the `###` sub-headings, the task table, the
//     `Manual verify setup:` line, the verify recipes, the banned commands, and
//     the `Affected areas` cells against real repository paths.
//   - `map next|claim|lint` — the decision map: the next claimable ticket,
//     claiming one, and the structural lint (Blocked-by cycles named).
//   - `skill lint`       — frontmatter against the VENDORED whitelist, the line
//     budget, the craft rules (closing checklist, resource graph).
//   - `wizard verify`    — the artifact against the VENDORED template (the plugin
//     dir is unreachable from a consumer), library regions hash-compared.
//   - `arch-report verify` — the report's claims against the repo.
//   - `handoff finalize` — completeness + the secret scan (a token is a finding
//     AND a nonzero exit).
//   - `brief lint`       — a triage brief (from a file or `--issue N`): paths,
//     line references, and the required sections.
//
// All seven are implemented here — one branch per command token (which arrives on
// the context), never a new dispatch arm in run.ts.
//
// THE SHARED REPORT CONTRACT, which every linter in the family answers with:
// findings print ONE PER LINE as `<where>: <message>` (`<where>` is `path:line`
// wherever a line is knowable), ANY finding exits 1, a clean artifact prints `ok`
// and exits 0, and `--json` renders `{ok, findings: [{check, message, where}]}` as
// the SOLE stdout line. A malformed INVOCATION (a target that does not exist, a
// slug the map never had) is NOT a finding — it is a hard error on stderr, so a
// caller can never read "I could not judge this" as "this is clean".
//
// Two report EXTENSIONS the second family needed, both additive:
//   - NOTES — a check that could not RUN (shellcheck absent, a repo with no
//     `.github/workflows`) is never a finding (the artifact has no defect) but
//     must stay VISIBLE, so a caller can tell a shellcheck-checked wizard from an
//     unchecked one. Notes ride alongside the findings in both channels.
//   - PAYLOAD keys — `handoff finalize` answers with the document's absolute path
//     (its output IS the "echo the path" step of the handoff skill).
//
// What these linters judge is the MECHANICAL subset only: a heading that must
// exist, a cell that must be filled, an edge that must point backwards, a
// frontmatter key that must be real. The judgment rows — whether a decision is
// right, whether an answer is good, whether prose earns its tokens — stay the
// architect's and the reviewer's call, and are deliberately unlinted.
//
// node:* only (ADR-0008): vitest imports this under Node.

// ---------------------------------------------------------------------------
// The shared report contract
// ---------------------------------------------------------------------------

// One mechanical defect: WHICH check found it, WHAT is wrong (the whole message,
// one line — the text renderer joins findings with newlines), and WHERE.
interface Finding {
  check: string;
  message: string;
  where: string;
}

function finding(check: string, where: string, message: string): Finding {
  return { check, message, where };
}

// `path:line` with a 1-BASED line, the form every editor and every `check`
// finding already uses (the module works in 0-based line indexes throughout).
function at(path: string, line: number): string {
  return `${path}:${line + 1}`;
}

// What a linter may add to its verdict beyond the findings themselves.
interface ReportExtras {
  // Checks that could not RUN, one line each (already carrying their own
  // `skipped: ` prefix). Never a finding, never an exit code — but always
  // printed, in BOTH channels.
  notes?: readonly string[];
  // The clean-verdict stdout line, replacing the bare `ok` (handoff echoes the
  // document's path instead).
  okText?: string;
  // Extra `--json` keys merged into the payload (handoff's `path`).
  payload?: Readonly<Record<string, unknown>>;
}

// The verdict: `ok` + exit 0 when the inventory came back empty, one line per
// finding + exit 1 otherwise, and the `{ok, findings}` payload under `--json`
// (rendered by run.ts as the sole stdout line). Notes ride along in both
// channels without touching the exit code.
function report(
  context: CommandContext,
  findings: Finding[],
  extras: ReportExtras = {}
): CommandResult {
  const ok = findings.length === 0;
  const notes = [...(extras.notes ?? [])];
  if (context.options.json === true) {
    return {
      exitCode: ok ? 0 : 1,
      json: { ...extras.payload, findings, notes, ok },
    };
  }
  const lines = ok
    ? [extras.okText ?? "ok"]
    : findings.map((item) => `${item.where}: ${item.message}`);
  return { exitCode: ok ? 0 : 1, text: `${[...lines, ...notes].join("\n")}\n` };
}

// A refusal: the message on STDERR (where a caller looks for one) with exit 1,
// mirrored into the payload under `--json` so a machine caller sees `ok:false`
// with an EMPTY findings list — nothing was judged, which is not the same answer
// as "judged and clean".
function fail(context: CommandContext, error: string): CommandResult {
  if (context.options.json === true) {
    return { error, exitCode: 1, json: { error, findings: [], ok: false } };
  }
  return { error, exitCode: 1 };
}

export function runArtifactLint(context: CommandContext): CommandResult {
  switch (context.command) {
    case "spec":
      return runSpecLint(context);
    case "map":
      return runMap(context);
    case "skill":
      return runSkillLint(context);
    case "wizard":
      return runWizardVerify(context);
    case "arch-report":
      return runArchReportVerify(context);
    case "handoff":
      return runHandoffFinalize(context);
    case "brief":
      return runBriefLint(context);
    default:
      return notImplemented(context.command);
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

const CRLF = /\r\n/g;
// Markdown decoration a heading or a field label may carry (`**Bold**`,
// `` `code` ``) plus the trailing `:`/`?` a hand-written column header collects.
const EMPHASIS = /[*`]/g;
const TRAILING_MARK = /[:?]+\s*$/;
const LIST_MARKER = /^\s*[-*>+]\s*/;
const TRAILING_PUNCT = /[.,;:]+$/;
// Kebab-case, the id shape both a map ticket slug and a skill `name` must take.
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The markers that mean "no dependency" in a task table's `Depends on` cell and a
// ticket's `Blocked by:` line — the kit writes an em dash, and the neighbours are
// what a human types instead.
const NO_DEPENDENCY: ReadonlySet<string> = new Set([
  "",
  "-",
  "—",
  "–",
  "n/a",
  "none",
]);

// The document as lines, CRLF normalized (a Windows-authored artifact still
// parses). Line INDEXES are the module's currency; `at()` renders them 1-based.
function readLines(path: string): string[] {
  return readDocument(path).lines;
}

// The document BOTH ways: the normalized lines every check reads, and the RAW
// text a writer must edit in place. `map claim` needs the raw form — a CRLF map
// rewritten from the normalized lines would change every line ending, which is
// exactly the "only the claimed line changes" invariant the write exists to keep.
function readDocument(path: string): { lines: string[]; raw: string } {
  const raw = readFileSync(path, "utf8");
  return { lines: raw.replace(CRLF, "\n").split("\n"), raw };
}

// The `## ` heading lines OUTSIDE any fenced block — a `## ` inside a snippet is
// sample text, never a section boundary. Shared by the spec region scan and the
// skill's closing-heading check's sibling logic.
function topLevelHeadings(lines: string[]): number[] {
  const found: number[] = [];
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (FENCE_LINE.test(line)) {
      open = !open;
      continue;
    }
    if (!open && line.startsWith("## ")) {
      found.push(index);
    }
  }
  return found;
}

// A heading / column / field label reduced to its comparable form: decoration
// stripped, trailing `:`/`?` dropped, lowercased. `**Test-first?**`, `Test-first`
// and `test-first` are the same column.
function normalize(text: string): string {
  return text
    .replace(EMPHASIS, "")
    .replace(TRAILING_MARK, "")
    .trim()
    .toLowerCase();
}

// A line stripped of its list marker and emphasis — how a field line is read
// whether it was written bare (`Manual verify setup: none`) or as a bullet.
function stripDecoration(line: string): string {
  return line.replace(LIST_MARKER, "").replace(EMPHASIS, "").trim();
}

// The workroot, or the caller's directory outside a git repo. These commands
// READ (except `map claim`, which writes a file it was pointed at), so unlike the
// action commands they degrade instead of failing hard: a spec pasted into a
// non-repo directory is still lintable.
function workroot(context: CommandContext): string {
  return resolveWorkroot(context.cwd) ?? context.cwd;
}

// The target artifact: the POSITIONAL at `index` (the form the skills type),
// falling back to `--file` (allowlisted by the registry), resolved against the
// CALLER's cwd so a relative path means what the caller typed. Undefined = use
// the command's default resolution.
function targetPath(
  context: CommandContext,
  index: number
): string | undefined {
  const positional = context.positionals[index];
  if (positional !== undefined) {
    return resolve(context.cwd, positional);
  }
  const { file } = context.options;
  return typeof file === "string" ? resolve(context.cwd, file) : undefined;
}

// A path as the report shows it: relative to the workroot when it lives inside
// one (short, and stable across machines), absolute otherwise.
function display(root: string, path: string): string {
  return inside(root, path) ? relative(root, path) : path;
}

// Whether `path` sits INSIDE `root`. `relative` answers with a `..`-prefixed (or,
// across Windows drives, an absolute) path when it does not.
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// The location rule the two EPHEMERAL artifacts share: an architecture report and
// a handoff doc are written to the OS temp dir and thrown away — they must never
// land in the repo, and least of all in git. Both halves are reported (a file can
// be inside a repo without being tracked yet, and a tracked one is worse), each
// naming the fix.
function lintEphemeralLocation(
  root: string,
  path: string,
  context: { check: string; label: string }
): Finding[] {
  const findings: Finding[] = [];
  if (inside(root, path)) {
    findings.push(
      finding(
        context.check,
        path,
        `${context.label} is written INSIDE the git workroot (${root}) — it is ephemeral and must live in the OS temp dir (\`\${TMPDIR:-/tmp}\`), never in the repo`
      )
    );
  }
  if (gitTracked(path)) {
    findings.push(
      finding(
        context.check,
        path,
        `${context.label} is tracked by git — an ephemeral artifact is never committed; write it to the OS temp dir instead`
      )
    );
  }
  return findings;
}

// Whether git tracks `path`, asked from the file's OWN directory (so a doc that
// landed in some OTHER repo is caught too). Outside a repo git exits nonzero,
// which reads as "not tracked" — the tolerant answer these read-only linters want.
function gitTracked(path: string): boolean {
  const result = runCapture("git", ["ls-files", "--error-unmatch", path], {
    root: dirname(path),
  });
  return !result.error && result.status === 0;
}

// ---------------------------------------------------------------------------
// `spec lint` — the `## Spec` section of the work-session doc
// ---------------------------------------------------------------------------

const STATE_FILE = "STATE.md";
const SPEC_HEADING = "spec";

// The `###` sub-headings `plugin/skills/spec` Step 2 mandates. `User flow` is the
// ONE optional heading (the skill omits it for backend-only work), so it is
// absent from this list and never reported. An UNKNOWN sub-heading is not a
// finding either — a plan may carry more structure than the minimum.
const REQUIRED_SPEC_HEADINGS: readonly string[] = [
  "Overview",
  "Goals",
  "Non-goals",
  "Constraints",
  "Decisions",
  "Testing Decisions",
  "Edge cases",
  "Module structure",
  "Tasks",
];

const DECISIONS_HEADING = "Decisions";
const TASKS_HEADING = "Tasks";
const TESTING_HEADING = "Testing Decisions";
const MANUAL_SETUP_LABEL = "Manual verify setup:";

// The task table's columns. `Description` is optional (a plan may fold it into
// the title), `Destructive` is optional (absent = non-destructive, the session's
// open question 5), and `Test-first` is required exactly when the repo HAS a test
// suite — task-decomposition.md says to omit the column entirely without one.
const REQUIRED_TASK_COLUMNS: readonly string[] = [
  "#",
  "Task",
  "Depends on",
  "Affected areas",
  "Verify recipe",
];
const TEST_FIRST_COLUMN = "Test-first";
const VITEST_CAPABILITY = "vitest";

// The commands a verify recipe may never run: the recipe observes BEHAVIOR, and
// the quality gate belongs to the edit-time hook + the pre-commit `dobby check
// --fix` (spec SKILL.md's "Verify recipes verify BEHAVIOR" rule). WORD-BOUNDARY
// matched and case-insensitive, which is what keeps an honest recipe writable:
// `rebuild the fixture map` is not `build`. No `g` flag — a global regex would
// carry `lastIndex` between rows.
const BANNED_VERIFY_COMMAND =
  /\b(?:lint|format|typecheck|tsc|biome|knip|vitest|jest|npm test|bun test|dobby check|build)\b/i;

// The character shape a real repository path takes in this kit: word
// characters, dot, dash and slash only. Nothing else — no space, no
// parenthesis, no stray punctuation — belongs in a path, so anything outside
// this shape is prose that leaked into the cell (task-decomposition.md's
// `Affected areas` rule: name the path, not a description of it). This is what
// catches a parenthetical aside split apart by the SAME comma that separates
// areas, e.g. `plugin/skills (research, dispatch)` → `plugin/skills (research`
// + `dispatch)`, both of which fail this shape before existence is even
// checked.
const AREA_PATH_SHAPE = /^[\w./-]+$/;

const NUMBERED_STEP = /^\s*\d+[.)]\s/;
const FENCE_LINE = /^\s*(?:```|~~~)/;
// A table's delimiter row (`|---|------|`): pipes, dashes, colons and spaces,
// with at least one dash. It is what distinguishes a TABLE from a stray line that
// happens to start with a pipe.
const TABLE_DELIMITER = /^\|[\s:|-]*-[\s:|-]*$/;
const CELL_SEPARATOR = /[,;]/;

// A half-open line range `[start, end)`.
interface Region {
  end: number;
  start: number;
}

// One `###` sub-section of the spec: the heading's own line plus the body range.
interface SpecSection {
  end: number;
  line: number;
  name: string;
  start: number;
}

interface ParsedSpec {
  // Where each fenced block OPENS, and which sub-section it opened in — the
  // snippet-exception check needs both.
  fences: { line: number; section: string }[];
  sections: SpecSection[];
}

interface SpecContext {
  // Whether the repo has the vitest capability — the SAME detector `env` and
  // `check` read, so the `Test-first` column rule can never disagree with the
  // gate about whether this repo has a suite.
  hasTestSuite: boolean;
  path: string;
  // The workroot every `Affected areas` entry resolves against — the area-path
  // check needs an absolute base to answer "does this exist in the repo".
  root: string;
}

function runSpecLint(context: CommandContext): CommandResult {
  const root = workroot(context);
  const path = targetPath(context, 1) ?? join(root, STATE_FILE);
  if (!existsSync(path)) {
    return fail(
      context,
      `spec lint: ${path} not found — pass the document as a positional, or run inside a session whose ${STATE_FILE} exists`
    );
  }
  const lines = readLines(path);
  const shown = display(root, path);
  const region = specRegion(lines);
  if (region === null) {
    return report(context, [
      finding(
        "spec-section",
        shown,
        `no \`## Spec\` section — the plan lives in ${STATE_FILE}'s \`## Spec\` (write it with \`dobby state set Spec\`)`
      ),
    ]);
  }
  const specContext: SpecContext = {
    hasTestSuite: detectCapabilities(root).includes(VITEST_CAPABILITY),
    path: shown,
    root,
  };
  return report(context, lintSpec(lines, region, specContext));
}

// The lines the spec occupies: the `## Spec` section's body when the document has
// `## ` sections (a STATE.md), or the WHOLE file when it has none (a spec
// fragment someone linted on its own). A document WITH sections but WITHOUT a
// `## Spec` is null — one finding, never a crash and never a silent pass.
// Fenced lines are skipped: a spec that QUOTES a markdown document (a `## `
// inside a snippet under `### Decisions`) must not have its region truncated.
function specRegion(lines: string[]): Region | null {
  const headings = topLevelHeadings(lines);
  if (headings.length === 0) {
    return { end: lines.length, start: 0 };
  }
  const start = headings.find(
    (index) => normalize((lines[index] ?? "").slice(3)) === SPEC_HEADING
  );
  if (start === undefined) {
    return null;
  }
  return {
    end: headings.find((index) => index > start) ?? lines.length,
    start: start + 1,
  };
}

function lintSpec(
  lines: string[],
  region: Region,
  context: SpecContext
): Finding[] {
  const parsed = parseSpec(lines, region);
  return [
    ...lintSpecHeadings(parsed, context),
    ...lintSpecFences(parsed, context),
    ...lintTaskTable(lines, parsed, context),
    ...lintTestingDecisions(lines, parsed, context),
  ];
}

// ONE pass over the spec region collecting the `###` sub-sections and every
// fenced block's opening line. Fence tracking is shared on purpose: a `###` or a
// `|` line INSIDE a code block is sample text, not structure.
function parseSpec(lines: string[], region: Region): ParsedSpec {
  const sections: SpecSection[] = [];
  const fences: { line: number; section: string }[] = [];
  let open = false;
  let current: SpecSection | null = null;
  for (let index = region.start; index < region.end; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE_LINE.test(line)) {
      if (!open) {
        fences.push({ line: index, section: current?.name ?? "" });
      }
      open = !open;
      continue;
    }
    if (open || !line.startsWith("### ")) {
      continue;
    }
    if (current !== null) {
      current.end = index;
      sections.push(current);
    }
    current = {
      end: region.end,
      line: index,
      name: line.slice(4).trim(),
      start: index + 1,
    };
  }
  if (current !== null) {
    sections.push(current);
  }
  return { fences, sections };
}

function sectionNamed(
  parsed: ParsedSpec,
  name: string
): SpecSection | undefined {
  const wanted = normalize(name);
  return parsed.sections.find((section) => normalize(section.name) === wanted);
}

function lintSpecHeadings(parsed: ParsedSpec, context: SpecContext): Finding[] {
  const present = new Set(
    parsed.sections.map((section) => normalize(section.name))
  );
  return REQUIRED_SPEC_HEADINGS.filter(
    (name) => !present.has(normalize(name))
  ).map((name) =>
    finding(
      "spec-headings",
      context.path,
      `missing required sub-heading: ### ${name}`
    )
  );
}

// The snippet exception: a fenced block is legal ONLY under `### Decisions`
// (where a state machine / schema / type shape pins a decision down more tightly
// than prose). Anywhere else it is code in a document that is meant to be prose.
function lintSpecFences(parsed: ParsedSpec, context: SpecContext): Finding[] {
  const allowed = normalize(DECISIONS_HEADING);
  return parsed.fences
    .filter((fence) => normalize(fence.section) !== allowed)
    .map((fence) =>
      finding(
        "spec-code-block",
        at(context.path, fence.line),
        "fenced code block outside `### Decisions` — a spec is prose; only a decision may inline a snippet"
      )
    );
}

// ---------------------------------------------------------------------------
// The task table
// ---------------------------------------------------------------------------

interface TableRow {
  cells: string[];
  line: number;
}

interface Table {
  header: string[];
  rows: TableRow[];
  start: number;
}

// The column indexes the row checks read; -1 = the column is absent (its own
// finding), and a check keyed on an absent column stays SILENT rather than
// reporting every row as empty.
interface TaskColumns {
  affected: number;
  dependsOn: number;
  id: number;
  recipe: number;
  task: number;
}

// One task row, already projected onto the columns that carry rules.
interface TaskRow {
  affected: string;
  dependsOn: string;
  id: string;
  line: number;
  recipe: string;
  task: string;
}

function lintTaskTable(
  lines: string[],
  parsed: ParsedSpec,
  context: SpecContext
): Finding[] {
  const section = sectionNamed(parsed, TASKS_HEADING);
  if (section === undefined) {
    // Its absence is already reported by the heading inventory.
    return [];
  }
  const tables = parseTables(lines, section.start, section.end);
  const [table] = tables;
  if (table === undefined) {
    return [
      finding(
        "spec-tasks",
        at(context.path, section.line),
        "### Tasks carries no task table — build it per task-decomposition.md"
      ),
    ];
  }
  const findings = lintExtraTables(tables, context);
  findings.push(...lintTaskColumns(table, context));
  const columns = taskColumns(table);
  const rows = taskRows(table, columns);
  findings.push(...lintRowCells(rows, columns, context));
  findings.push(...lintRowDependencies(rows, context));
  findings.push(...lintRowAreas(rows, columns, context));
  findings.push(...lintRowRecipes(rows, columns, context));
  return findings;
}

// Exactly ONE table under `### Tasks`: a second one is either a leftover draft or
// a split plan, and every downstream consumer (`build-plan`, the build loop)
// reads the first table only.
function lintExtraTables(tables: Table[], context: SpecContext): Finding[] {
  const [, second] = tables;
  if (second === undefined) {
    return [];
  }
  return [
    finding(
      "spec-tasks",
      at(context.path, second.start),
      `### Tasks carries ${tables.length} tables — exactly one task table is allowed`
    ),
  ];
}

function lintTaskColumns(table: Table, context: SpecContext): Finding[] {
  const required = [...REQUIRED_TASK_COLUMNS];
  if (context.hasTestSuite) {
    required.push(TEST_FIRST_COLUMN);
  }
  return required
    .filter((name) => columnIndex(table.header, name) < 0)
    .map((name) =>
      finding("spec-tasks", at(context.path, table.start), columnMessage(name))
    );
}

// The `Test-first` column gets its own wording: its absence is only a finding
// BECAUSE this repo has a suite, and saying so is what makes the fix obvious.
function columnMessage(name: string): string {
  if (name === TEST_FIRST_COLUMN) {
    return `task table is missing the \`${TEST_FIRST_COLUMN}\` column — this repo has a test suite, so every task carries the marker the test-author gate reads`;
  }
  return `task table is missing the \`${name}\` column`;
}

function taskColumns(table: Table): TaskColumns {
  return {
    affected: columnIndex(table.header, "Affected areas"),
    dependsOn: columnIndex(table.header, "Depends on"),
    id: columnIndex(table.header, "#"),
    recipe: columnIndex(table.header, "Verify recipe"),
    task: columnIndex(table.header, "Task"),
  };
}

function taskRows(table: Table, columns: TaskColumns): TaskRow[] {
  return table.rows.map((row, index) => ({
    affected: cellAt(row.cells, columns.affected),
    dependsOn: cellAt(row.cells, columns.dependsOn),
    id: cellAt(row.cells, columns.id) || String(index + 1),
    line: row.line,
    recipe: cellAt(row.cells, columns.recipe),
    task: cellAt(row.cells, columns.task),
  }));
}

// The cells a task cannot be dispatched without: WHAT to build, WHERE it lands,
// and HOW it is verified. Each is checked only when its column exists.
function lintRowCells(
  rows: TaskRow[],
  columns: TaskColumns,
  context: SpecContext
): Finding[] {
  const checks: {
    index: number;
    label: string;
    read: (row: TaskRow) => string;
  }[] = [
    { index: columns.task, label: "Task", read: (row) => row.task },
    {
      index: columns.affected,
      label: "Affected areas",
      read: (row) => row.affected,
    },
    {
      index: columns.recipe,
      label: "Verify recipe",
      read: (row) => row.recipe,
    },
  ];
  const findings: Finding[] = [];
  for (const row of rows) {
    for (const check of checks) {
      if (check.index >= 0 && check.read(row) === "") {
        findings.push(
          finding(
            "spec-tasks",
            at(context.path, row.line),
            `task ${row.id}: empty \`${check.label}\` cell`
          )
        );
      }
    }
  }
  return findings;
}

// Dependencies point BACKWARDS, always. Comparing by the row's POSITION (not by
// parsing the id as a number) keeps the rule honest for any id scheme, and it is
// what makes a cycle unrepresentable: an edge can only ever reach a row that is
// already above this one.
function lintRowDependencies(rows: TaskRow[], context: SpecContext): Finding[] {
  const position = new Map(rows.map((row, index) => [row.id, index]));
  const findings: Finding[] = [];
  for (const [index, row] of rows.entries()) {
    for (const dependency of splitCellList(row.dependsOn)) {
      const target = position.get(dependency);
      if (target === undefined) {
        findings.push(
          finding(
            "spec-tasks",
            at(context.path, row.line),
            `task ${row.id}: \`Depends on\` names ${dependency}, which is not a task in this table`
          )
        );
        continue;
      }
      if (target >= index) {
        findings.push(
          finding(
            "spec-tasks",
            at(context.path, row.line),
            `task ${row.id}: \`Depends on\` names ${dependency}, which is not scheduled before it — dependencies point backwards (no forward references, no cycles)`
          )
        );
      }
    }
  }
  return findings;
}

// `Affected areas` must name REAL repository paths — this is what makes the
// dispatch protocol's overlap check (build-protocol.md's "Overlapping
// writers") mean anything: it compares two tasks' areas AS PATHS, and a prose
// label ("the gate", "CLI checks") for the same file defeats that comparison
// silently, because two unrelated strings never compare equal or as a prefix
// of one another. WITHOUT dropping the no-dependency spellings (`—`, `none`,
// …) the way this file's `Depends on` check does: unlike `Depends on`, this
// column has no "nothing here" value, so `—` must fail like any other
// non-path instead of silently vanishing into zero areas checked.
function lintRowAreas(
  rows: TaskRow[],
  columns: TaskColumns,
  context: SpecContext
): Finding[] {
  if (columns.affected < 0) {
    return [];
  }
  const findings: Finding[] = [];
  for (const row of rows) {
    for (const area of splitAreaList(row.affected)) {
      const message = areaPathProblem(context.root, area, row.id);
      if (message !== null) {
        findings.push(
          finding("spec-area-path", at(context.path, row.line), message)
        );
      }
    }
  }
  return findings;
}

// The raw cell as its member areas: COMMA-split ONLY — `dobby build-plan`'s
// own area list (`buildplan.ts`'s `splitList`, which the dispatch protocol's
// overlap check reads) splits on comma alone, so this must match it exactly.
// Splitting on semicolon too (like `Depends on`'s CELL_SEPARATOR) would bless
// a cell such as `cli/src; plugin` as two clean paths here while build-plan
// still emits it as ONE unsplit, non-existent area — clean at spec time,
// invisible to the overlap check at dispatch, the exact gap this check
// exists to close. Decoration stripped, blank fragments (a trailing comma's
// leftover) dropped — but every OTHER fragment kept, `—` included, so it
// reaches the shape check below and is judged rather than quietly filtered.
function splitAreaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.replace(EMPHASIS, "").trim())
    .filter((entry) => entry !== "");
}

// An area normalised the SAME way the dispatch protocol normalises it before
// comparing paths (build-protocol.md's "Overlapping writers": strip a leading
// `./`, strip a trailing `/`) — so the lint and the dispatch-time overlap
// check judge the identical string, not two different ones.
function normalizeAreaPath(area: string): string {
  const withoutLeading = area.startsWith("./") ? area.slice(2) : area;
  return withoutLeading.endsWith("/")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
}

// Why an area is not usable, as a finding message, or null when it is fine: an
// EXISTING file or directory, or one this task will CREATE — recognised by
// its parent directory already existing (task-decomposition.md's rule: a path
// a task creates is legitimate as long as its parent already exists). A cell
// that isn't shaped like a path at all (a comma-mangled fragment of a
// parenthetical, free prose) is rejected before existence is even checked.
function areaPathProblem(
  root: string,
  rawArea: string,
  taskId: string
): string | null {
  const area = normalizeAreaPath(rawArea);
  if (!AREA_PATH_SHAPE.test(area)) {
    return `task ${taskId}: \`Affected areas\` names \`${rawArea}\`, which is not a real path — write the directory or file itself; split a parenthetical or description into its own comma-separated area, or drop it`;
  }
  const absolute = resolve(root, area);
  if (existsSync(absolute)) {
    return null;
  }
  if (area.includes("/") && existsSync(dirname(absolute))) {
    return null;
  }
  return `task ${taskId}: \`Affected areas\` names \`${rawArea}\`, which does not exist in this repo — name a real directory or file (a path the task will CREATE is fine as long as its parent directory already exists)`;
}

function lintRowRecipes(
  rows: TaskRow[],
  columns: TaskColumns,
  context: SpecContext
): Finding[] {
  if (columns.recipe < 0) {
    return [];
  }
  return rows.flatMap((row) => {
    const match = BANNED_VERIFY_COMMAND.exec(row.recipe);
    if (match === null) {
      return [];
    }
    return [
      finding(
        "spec-verify-recipe",
        at(context.path, row.line),
        `task ${row.id}: verify recipe runs the banned command \`${match[0]}\` — a recipe drives behavior and observes an effect; lint/typecheck/build/tests belong to the edit hook and the pre-commit gate`
      ),
    ];
  });
}

// Every markdown table in `[start, end)`, in document order.
function parseTables(lines: string[], start: number, end: number): Table[] {
  const tables: Table[] = [];
  let index = start;
  while (index < end) {
    const found = tableAt(lines, index, end);
    if (found === null) {
      index += 1;
      continue;
    }
    tables.push(found.table);
    index = found.next;
  }
  return tables;
}

// A table AT `start`, or null: a header row, a delimiter row under it, then every
// consecutive pipe row.
function tableAt(
  lines: string[],
  start: number,
  end: number
): { next: number; table: Table } | null {
  const header = lines[start] ?? "";
  const delimiter = (lines[start + 1] ?? "").trim();
  if (
    start + 1 >= end ||
    !isTableRow(header) ||
    !TABLE_DELIMITER.test(delimiter)
  ) {
    return null;
  }
  const rows: TableRow[] = [];
  let index = start + 2;
  while (index < end && isTableRow(lines[index] ?? "")) {
    rows.push({ cells: splitCells(lines[index] ?? ""), line: index });
    index += 1;
  }
  return {
    next: index,
    table: { header: splitCells(header), rows, start },
  };
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

// A row's cells: the outer pipes dropped, the rest split and trimmed — so a
// deliberately empty cell (`| … |  |`) comes back as `""` rather than vanishing.
function splitCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const body = withoutLeading.endsWith("|")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  return body.split("|").map((cell) => cell.trim());
}

function cellAt(cells: string[], index: number): string {
  return index < 0 ? "" : (cells[index] ?? "").trim();
}

function columnIndex(header: string[], name: string): number {
  const wanted = normalize(name);
  return header.findIndex((cell) => normalize(cell) === wanted);
}

// A list cell (`Depends on`, `Blocked by`) as its members, with the
// no-dependency markers dropped — `—` is a value, not an id.
function splitCellList(value: string): string[] {
  return value
    .split(CELL_SEPARATOR)
    .map((entry) => entry.replace(EMPHASIS, "").trim())
    .filter((entry) => !NO_DEPENDENCY.has(entry.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Testing Decisions — the `Manual verify setup:` field
// ---------------------------------------------------------------------------

// `/dobby:execute`'s pre-verification gate READS this field, so an omitted one is
// not "no setup needed" — it is an unanswered question. testing-decisions.md
// mandates writing the explicit `none`.
function lintTestingDecisions(
  lines: string[],
  parsed: ParsedSpec,
  context: SpecContext
): Finding[] {
  const section = sectionNamed(parsed, TESTING_HEADING);
  if (section === undefined) {
    return [];
  }
  const field = findManualSetup(lines, section);
  if (field === null) {
    return [
      finding(
        "spec-manual-verify",
        at(context.path, section.line),
        `\`${MANUAL_SETUP_LABEL}\` line missing from ### ${TESTING_HEADING} — write \`none\` or the numbered steps a human must perform first`
      ),
    ];
  }
  if (
    field.value.toLowerCase() === "none" ||
    hasNumberedStep(lines, field.line + 1, section.end)
  ) {
    return [];
  }
  return [
    finding(
      "spec-manual-verify",
      at(context.path, field.line),
      `\`${MANUAL_SETUP_LABEL}\` must be \`none\` or be followed by numbered steps`
    ),
  ];
}

// The field, wherever it sits ON its line. The spec skill writes it three ways —
// bare (`Manual verify setup: none`), as a bullet, and INLINE at the end of the
// Testing-Decisions paragraph (`… no test suite involvement. **Manual verify
// setup: none.**`, which is what the kit's own specs carry) — so the label is
// searched anywhere in the line and the value keeps its trailing sentence
// punctuation out of the comparison.
function findManualSetup(
  lines: string[],
  section: SpecSection
): { line: number; value: string } | null {
  const label = MANUAL_SETUP_LABEL.toLowerCase();
  for (let index = section.start; index < section.end; index += 1) {
    const stripped = stripDecoration(lines[index] ?? "");
    const offset = stripped.toLowerCase().indexOf(label);
    if (offset >= 0) {
      return {
        line: index,
        value: fieldValue(stripped.slice(offset + label.length)),
      };
    }
  }
  return null;
}

function fieldValue(text: string): string {
  return text.trim().replace(TRAILING_PUNCT, "").trim();
}

function hasNumberedStep(lines: string[], start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (NUMBERED_STEP.test(lines[index] ?? "")) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// `map next|claim|lint` — the decision map
// ---------------------------------------------------------------------------

const MAPS_DIR = "docs/maps";
const MAP_STATUSES: readonly string[] = ["open", "in-progress", "resolved"];
const MAP_TYPES: readonly string[] = ["Research", "Prototype", "Grilling"];
const STATUS_OPEN = "open";
const STATUS_IN_PROGRESS = "in-progress";
const STATUS_RESOLVED = "resolved";
const STATUS_FIELD = "Status";

// `## <slug>: <Title>` — the ticket heading `plugin/skills/map` mandates. A `## `
// section WITHOUT the colon is not a ticket and is ignored (a map may carry
// prose sections); the slug therefore never contains a colon.
const TICKET_HEADING = /^##\s+([^:]+):\s*(.*)$/;
const TICKET_FIELD = /^\s*(Blocked by|Status|Type)\s*:\s*(.*)$/i;
const QUESTION_HEADING = "question";
const ANSWER_HEADING = "answer";

interface MapTicket {
  answer: string;
  blockedBy: string[];
  line: number;
  question: string;
  slug: string;
  status: string;
  // The `Status:` line's index — where `claim` writes. -1 when the ticket has no
  // status line at all.
  statusLine: number;
  title: string;
  type: string;
}

// The accumulating form: the two prose bodies arrive line by line.
interface TicketDraft {
  answer: string[];
  blockedBy: string[];
  line: number;
  question: string[];
  slug: string;
  status: string;
  statusLine: number;
  title: string;
  type: string;
}

function runMap(context: CommandContext): CommandResult {
  const [subcommand] = context.positionals;
  switch (subcommand) {
    case "lint":
      return runMapLint(context);
    case "next":
      return runMapNext(context);
    case "claim":
      return runMapClaim(context);
    default:
      // Unreachable: the registry in run.ts validates the token before dispatch.
      return fail(
        context,
        `unknown subcommand: map ${subcommand ?? ""}`.trimEnd()
      );
  }
}

// The map a `map` invocation acts on: the named file, else the NEWEST map under
// `docs/maps/` — a session works the map it most recently touched, and naming the
// file every time is exactly the mechanical step this command exists to remove.
function resolveMap(
  context: CommandContext,
  index: number
): { error: string } | { path: string; root: string } {
  const root = workroot(context);
  const named = targetPath(context, index);
  if (named !== undefined) {
    return existsSync(named)
      ? { path: named, root }
      : { error: `map: ${named} not found` };
  }
  const newest = newestMap(root);
  if (newest === null) {
    return {
      error: `map: no decision map found under ${MAPS_DIR}/ — pass one as a positional, or build one with \`/dobby:map\``,
    };
  }
  return { path: newest, root };
}

// The newest `docs/maps/*.md` by mtime, ties broken by name (descending — the
// numbered-prefix convention makes the later map sort last).
function newestMap(root: string): string | null {
  const dir = join(root, MAPS_DIR);
  if (!existsSync(dir)) {
    return null;
  }
  const maps = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      name,
      path: join(dir, name),
      time: mtimeOf(join(dir, name)),
    }))
    .sort(
      (left, right) =>
        right.time - left.time || right.name.localeCompare(left.name)
    );
  return maps[0]?.path ?? null;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Every ticket in the map, in DOCUMENT order (which is the order `next` picks
// from — the map skill's "first open, unblocked ticket in document order").
//
// FENCED lines are prose, never structure: an `### Answer` that quotes a document
// (a schema, a sample map, a diff) routinely contains `## `, `### ` and
// `Status:` lines, and reading those as tickets would invent phantom slugs and
// rewrite which ticket is next. Inside a fence — and on the fence lines
// themselves — every line goes to the open body verbatim.
function parseMap(lines: string[]): MapTicket[] {
  const tickets: MapTicket[] = [];
  let draft: TicketDraft | null = null;
  let body: "answer" | "question" | null = null;
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    const fence = FENCE_LINE.test(line);
    if (fence) {
      fenced = !fenced;
    }
    if (fence || fenced) {
      pushTicketBody(draft, body, line);
      continue;
    }
    if (line.startsWith("## ")) {
      if (draft !== null) {
        tickets.push(finalizeTicket(draft));
      }
      draft = startTicket(line, index);
      body = null;
      continue;
    }
    if (draft === null) {
      continue;
    }
    if (line.startsWith("### ")) {
      body = ticketBody(line);
      continue;
    }
    if (body === null) {
      readTicketField(draft, line, index);
      continue;
    }
    pushTicketBody(draft, body, line);
  }
  if (draft !== null) {
    tickets.push(finalizeTicket(draft));
  }
  return tickets;
}

// A prose line into whichever body is open — nothing at all when the line sits
// before any ticket, or between a ticket's heading and its first `###`.
function pushTicketBody(
  draft: TicketDraft | null,
  body: "answer" | "question" | null,
  line: string
): void {
  if (draft === null || body === null) {
    return;
  }
  (body === "answer" ? draft.answer : draft.question).push(line);
}

function startTicket(line: string, index: number): TicketDraft | null {
  const match = TICKET_HEADING.exec(line);
  if (match === null) {
    return null;
  }
  return {
    answer: [],
    blockedBy: [],
    line: index,
    question: [],
    slug: (match[1] ?? "").trim(),
    status: "",
    statusLine: -1,
    title: (match[2] ?? "").trim(),
    type: "",
  };
}

function ticketBody(line: string): "answer" | "question" | null {
  const name = normalize(line.slice(4));
  if (name === ANSWER_HEADING) {
    return "answer";
  }
  return name === QUESTION_HEADING ? "question" : null;
}

function readTicketField(
  draft: TicketDraft,
  line: string,
  index: number
): void {
  const match = TICKET_FIELD.exec(line);
  if (match === null) {
    return;
  }
  const name = (match[1] ?? "").toLowerCase();
  const value = (match[2] ?? "").trim();
  if (name === "status") {
    draft.status = value;
    draft.statusLine = index;
    return;
  }
  if (name === "type") {
    draft.type = value;
    return;
  }
  draft.blockedBy = splitCellList(value);
}

function finalizeTicket(draft: TicketDraft): MapTicket {
  return {
    answer: draft.answer.join("\n").trim(),
    blockedBy: draft.blockedBy,
    line: draft.line,
    question: draft.question.join("\n").trim(),
    slug: draft.slug,
    status: draft.status,
    statusLine: draft.statusLine,
    title: draft.title,
    type: draft.type,
  };
}

function statusOf(ticket: MapTicket | undefined): string {
  return (ticket?.status ?? "").trim().toLowerCase();
}

// --- map lint --------------------------------------------------------------

function runMapLint(context: CommandContext): CommandResult {
  const resolved = resolveMap(context, 1);
  if ("error" in resolved) {
    return fail(context, resolved.error);
  }
  const tickets = parseMap(readLines(resolved.path));
  const path = display(resolved.root, resolved.path);
  return report(context, [
    ...lintTicketFields(tickets, path),
    ...lintDuplicateSlugs(tickets, path),
    ...lintBlockers(tickets, path),
    ...lintCycles(tickets, path),
  ]);
}

function lintTicketFields(tickets: MapTicket[], path: string): Finding[] {
  return tickets.flatMap((ticket) => {
    const where = at(path, ticket.line);
    const findings: Finding[] = [];
    if (!KEBAB.test(ticket.slug)) {
      findings.push(
        finding(
          "map-slug",
          where,
          `ticket slug \`${ticket.slug}\` is not kebab-case — the slug is the map's id, used in every \`Blocked by\` edge`
        )
      );
    }
    if (!MAP_STATUSES.includes(statusOf(ticket))) {
      findings.push(
        finding(
          "map-status",
          where,
          `${ticket.slug}: unknown Status \`${ticket.status}\` — expected one of: ${MAP_STATUSES.join(", ")}`
        )
      );
    }
    findings.push(...lintTicketType(ticket, where));
    findings.push(...lintTicketAnswer(ticket, where));
    return findings;
  });
}

function lintTicketType(ticket: MapTicket, where: string): Finding[] {
  const value = ticket.type.trim().toLowerCase();
  if (MAP_TYPES.some((type) => type.toLowerCase() === value)) {
    return [];
  }
  return [
    finding(
      "map-type",
      where,
      `${ticket.slug}: unknown Type \`${ticket.type}\` — expected one of: ${MAP_TYPES.join(", ")}`
    ),
  ];
}

// Only `resolved` obliges an answer: the whole open frontier is answerless by
// definition, and a resolved ticket with an empty `### Answer` is a lost verdict.
function lintTicketAnswer(ticket: MapTicket, where: string): Finding[] {
  if (statusOf(ticket) !== STATUS_RESOLVED || ticket.answer !== "") {
    return [];
  }
  return [
    finding(
      "map-answer",
      where,
      `${ticket.slug}: Status is resolved but \`### Answer\` is empty — record the verdict + why, with any asset linked by path`
    ),
  ];
}

function lintDuplicateSlugs(tickets: MapTicket[], path: string): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const ticket of tickets) {
    if (seen.has(ticket.slug)) {
      findings.push(
        finding(
          "map-slug",
          at(path, ticket.line),
          `duplicate ticket slug \`${ticket.slug}\` — slugs are the map's ids and must be unique within it`
        )
      );
    }
    seen.add(ticket.slug);
  }
  return findings;
}

function lintBlockers(tickets: MapTicket[], path: string): Finding[] {
  const slugs = new Set(tickets.map((ticket) => ticket.slug));
  return tickets.flatMap((ticket) =>
    ticket.blockedBy
      .filter((blocker) => !slugs.has(blocker))
      .map((blocker) =>
        finding(
          "map-edges",
          at(path, ticket.line),
          `${ticket.slug}: \`Blocked by\` names ${blocker}, which is not a ticket in this map`
        )
      )
  );
}

// The DAG check. A cycle is reported ONCE, naming every ticket caught in it —
// the whole point of the finding is that no ticket in the loop can ever unblock.
interface CycleScan {
  bySlug: Map<string, MapTicket>;
  findings: Finding[];
  path: string;
  stack: string[];
  state: Map<string, "done" | "visiting">;
}

function lintCycles(tickets: MapTicket[], path: string): Finding[] {
  const scan: CycleScan = {
    bySlug: new Map(tickets.map((ticket) => [ticket.slug, ticket])),
    findings: [],
    path,
    stack: [],
    state: new Map(),
  };
  for (const ticket of tickets) {
    visitTicket(ticket.slug, scan);
  }
  return scan.findings;
}

function visitTicket(slug: string, scan: CycleScan): void {
  const state = scan.state.get(slug);
  if (state === "done") {
    return;
  }
  if (state === "visiting") {
    const from = scan.stack.indexOf(slug);
    const cycle = [...scan.stack.slice(from), slug];
    scan.findings.push(
      finding(
        "map-cycle",
        at(scan.path, scan.bySlug.get(slug)?.line ?? 0),
        `blocking cycle: ${cycle.join(" → ")} — \`Blocked by\` edges must form a DAG or none of these tickets can ever unblock`
      )
    );
    return;
  }
  scan.state.set(slug, "visiting");
  scan.stack.push(slug);
  for (const blocker of scan.bySlug.get(slug)?.blockedBy ?? []) {
    if (scan.bySlug.has(blocker)) {
      visitTicket(blocker, scan);
    }
  }
  scan.stack.pop();
  scan.state.set(slug, "done");
}

// --- map next --------------------------------------------------------------

// The ticket this cycle works: the FIRST `open` ticket in document order whose
// every blocker is `resolved` (the map skill's own rule). A ticket blocked by a
// slug the map does not have stays blocked — an unresolvable edge is not a free
// pass. `next` never writes: claiming is `map claim`'s job, so two sessions
// asking "what's next" cannot both think they own the answer.
function runMapNext(context: CommandContext): CommandResult {
  const resolved = resolveMap(context, 1);
  if ("error" in resolved) {
    return fail(context, resolved.error);
  }
  const tickets = parseMap(readLines(resolved.path));
  const path = display(resolved.root, resolved.path);
  const ticket = nextTicket(tickets);
  if (context.options.json === true) {
    return { exitCode: 0, json: nextPayload(ticket, path) };
  }
  if (ticket === undefined) {
    return {
      exitCode: 0,
      text: `no claimable ticket in ${path} — every ticket is resolved, claimed, or still blocked\n`,
    };
  }
  return {
    exitCode: 0,
    text: `${ticket.slug} (${ticket.type}) — ${ticket.title}\n`,
  };
}

function nextTicket(tickets: MapTicket[]): MapTicket | undefined {
  const bySlug = new Map(tickets.map((ticket) => [ticket.slug, ticket]));
  return tickets.find(
    (ticket) =>
      statusOf(ticket) === STATUS_OPEN &&
      ticket.blockedBy.every(
        (blocker) => statusOf(bySlug.get(blocker)) === STATUS_RESOLVED
      )
  );
}

// Explicit NULLs rather than a missing key: "there is nothing to claim" is an
// answer, and a skill reading `slug` must be able to tell it from a broken run.
function nextPayload(
  ticket: MapTicket | undefined,
  path: string
): Record<string, unknown> {
  if (ticket === undefined) {
    return { path, question: null, slug: null, title: null, type: null };
  }
  return {
    path,
    question: ticket.question,
    slug: ticket.slug,
    title: ticket.title,
    type: ticket.type,
  };
}

// --- map claim -------------------------------------------------------------

// The family's ONE write, and a deliberately minimal one: the ticket's `Status:`
// line is rewritten IN PLACE and every other byte of the map is carried over
// untouched. Claiming is what makes parallel map sessions safe (the map skill:
// "claim it and save before any work"), so it must never be the step that
// reformats someone else's ticket.
function runMapClaim(context: CommandContext): CommandResult {
  const slug = claimSlug(context);
  if (slug === undefined) {
    return fail(
      context,
      "map claim requires a ticket slug — `dobby map claim <slug>`"
    );
  }
  const resolved = resolveMap(context, 2);
  if ("error" in resolved) {
    return fail(context, resolved.error);
  }
  const document = readDocument(resolved.path);
  const path = display(resolved.root, resolved.path);
  const tickets = parseMap(document.lines);
  const ticket = tickets.find((candidate) => candidate.slug === slug);
  if (ticket === undefined) {
    return fail(context, unknownSlugMessage(slug, tickets, path));
  }
  const refusal = claimRefusal(ticket, path);
  if (refusal !== null) {
    return fail(context, refusal);
  }
  // WRITE unless the file already says what the answer will say. `open` is the
  // ordinary case, but any other non-resolved value (a hand-typed `pending`, an
  // empty `Status:`) must be rewritten too — reporting a claim the document does
  // not carry is the one failure mode a claim can never have.
  if (statusOf(ticket) !== STATUS_IN_PROGRESS) {
    writeStatus(
      resolved.path,
      document.raw,
      ticket.statusLine,
      STATUS_IN_PROGRESS
    );
  }
  return claimed(context, slug, path);
}

function claimSlug(context: CommandContext): string | undefined {
  const [, positional] = context.positionals;
  if (positional !== undefined) {
    return positional;
  }
  const { task } = context.options;
  return typeof task === "string" ? task : undefined;
}

function unknownSlugMessage(
  slug: string,
  tickets: MapTicket[],
  path: string
): string {
  const known = tickets.map((ticket) => ticket.slug).join(", ");
  const suffix =
    known === "" ? "it carries no tickets" : `known tickets: ${known}`;
  return `map claim: no ticket \`${slug}\` in ${path} — ${suffix}`;
}

// A claim is refused when there is nothing to claim: a resolved ticket is DONE
// (re-opening it is an edit, not a claim), and a ticket with no `Status:` line is
// malformed — `map lint` says so, and guessing where to write would corrupt it.
function claimRefusal(ticket: MapTicket, path: string): string | null {
  if (ticket.statusLine < 0) {
    return `map claim: ticket \`${ticket.slug}\` in ${path} has no \`${STATUS_FIELD}:\` line — run \`dobby map lint\` and repair the ticket first`;
  }
  if (statusOf(ticket) === STATUS_RESOLVED) {
    return `map claim: ticket \`${ticket.slug}\` is already resolved — claim an open ticket (\`dobby map next\`)`;
  }
  return null;
}

// Rewrite ONE line of the RAW document, preserving its indentation AND its line
// ending — so the claim really is the only byte the write changes. Working off
// the raw text (split on `\n`, each line's `\r` still attached) is what keeps a
// CRLF-authored map CRLF: rebuilding from the normalized lines would silently
// rewrite every line ending in the file.
function writeStatus(
  path: string,
  raw: string,
  index: number,
  status: string
): void {
  const rawLines = raw.split("\n");
  const line = rawLines[index] ?? "";
  const carriage = line.endsWith("\r") ? "\r" : "";
  const indent = line.slice(0, line.length - line.trimStart().length);
  rawLines[index] = `${indent}${STATUS_FIELD}: ${status}${carriage}`;
  writeFileSync(path, rawLines.join("\n"));
}

function claimed(
  context: CommandContext,
  slug: string,
  path: string
): CommandResult {
  if (context.options.json === true) {
    return {
      exitCode: 0,
      json: { claimed: slug, ok: true, path, status: STATUS_IN_PROGRESS },
    };
  }
  return {
    exitCode: 0,
    text: `claimed ${slug} (${STATUS_FIELD}: ${STATUS_IN_PROGRESS}) in ${path}\n`,
  };
}

// ---------------------------------------------------------------------------
// `skill lint <dir>` — a skill directory against create-skill's craft rules
// ---------------------------------------------------------------------------

const SKILL_FILE = "SKILL.md";

// The frontmatter whitelist, VENDORED as data from
// `plugin/skills/create-skill/references/frontmatter.md` (Claude Code 2.1.162).
// It is copied rather than read because the CLI ships to CONSUMERS, where the
// plugin directory does not exist — the same reason the wizard template is
// vendored. Keep it in sync with that reference when Claude Code adds a field.
//
// `model` and `effort` ARE valid skill fields and are NOT findings here: "kit
// skills carry no model/effort" is a DOBBY convention (ADR-0004), enforced by the
// repo's own `dobby.config.json` checks on its agents — not a rule about skills
// in general, which is all this command may judge.
const SKILL_FIELDS: readonly string[] = [
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "paths",
  "allowed-tools",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "hooks",
  "shell",
];

const SKILL_EFFORTS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// The budget decision 18 settled (500 over 200 — three shipped skills already
// exceed 200, and 500 is create-skill's own single-to-multi migration trigger).
const MAX_SKILL_LINES = 500;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
// A name may not carry the vendor's own names (frontmatter.md).
const RESERVED_NAME_WORDS: readonly string[] = ["anthropic", "claude"];
const CLOSING_HEADING = "acceptance checklist";
const RESOURCE_DIRS: readonly string[] = ["examples", "references", "scripts"];

const FRONTMATTER_FENCE = "---";
const FRONTMATTER_FIELD = /^([A-Za-z][\w-]*)\s*:\s?(.*)$/;
// A resource path anywhere in the prose (inline code, a link target, a `bun
// scripts/x.ts` command line), captured in two parts: whatever PATH PREFIX it was
// written under, and the skill-relative tail. The prefix is what says whose file
// it is — `references/x.md` and `skills/this-one/references/x.md` are this
// skill's, while `../backlog/references/trackers.md` is a CITATION of another
// skill's material. Reading the latter as local is what turned every cross-skill
// link into a false "does not exist" / "never reference a reference".
const RESOURCE_MENTION =
  /(?<![\w@-])((?:[\w.@-]+\/)*)((?:examples|references|scripts)\/[\w.@/-]+)/g;
const LEADING_HERE = /^(?:\.\/)+/;
const TRAILING_SLASH = /\/+$/;
// The markdown-link form the craft rules ban: paths are cited as inline code.
const RESOURCE_LINK =
  /\]\(\s*\.?\/?((?:examples|references|scripts)\/[\w.@/-]+)\s*\)/g;
const QUOTES = /^["']|["']$/g;

interface FrontmatterField {
  line: number;
  name: string;
  value: string;
}

// One skill under judgment: its directory (where the resources live), its
// frontmatter fields, the WHOLE document as lines (so every finding can name a
// real line), and the display path every `where` is built from.
interface SkillDoc {
  dir: string;
  fields: FrontmatterField[];
  lines: string[];
  path: string;
}

function runSkillLint(context: CommandContext): CommandResult {
  const root = workroot(context);
  const dir = targetPath(context, 1) ?? context.cwd;
  const path = join(dir, SKILL_FILE);
  const shown = display(root, path);
  if (!existsSync(path)) {
    return report(context, [
      finding(
        "skill-file",
        shown,
        `${SKILL_FILE} not found at ${shown} — a skill is a directory containing ${SKILL_FILE}`
      ),
    ]);
  }
  const lines = readLines(path);
  const frontmatter = parseFrontmatter(lines);
  const doc: SkillDoc = {
    dir,
    fields: frontmatter?.fields ?? [],
    lines,
    path: shown,
  };
  const findings =
    frontmatter === null
      ? [
          finding(
            "skill-frontmatter",
            shown,
            `${SKILL_FILE} has no \`---\` frontmatter block — \`name\` and \`description\` are required`
          ),
        ]
      : lintFrontmatter(doc);
  findings.push(...lintSkillBudget(doc), ...lintSkillResources(doc, root));
  return report(context, findings);
}

// The frontmatter block: the leading `---`, its closing `---`, and the top-level
// `key: value` lines between them. An INDENTED line is a nested value (a `hooks:`
// tree) and is deliberately not a field.
function parseFrontmatter(
  lines: string[]
): { end: number; fields: FrontmatterField[] } | null {
  if ((lines[0] ?? "").trim() !== FRONTMATTER_FENCE) {
    return null;
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE
  );
  if (end === -1) {
    return null;
  }
  const fields: FrontmatterField[] = [];
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-")) {
      continue;
    }
    const match = FRONTMATTER_FIELD.exec(line);
    if (match !== null) {
      fields.push({
        line: index,
        name: match[1] ?? "",
        value: (match[2] ?? "").trim(),
      });
    }
  }
  return { end, fields };
}

function lintFrontmatter(doc: SkillDoc): Finding[] {
  const findings = doc.fields
    .filter((field) => !SKILL_FIELDS.includes(field.name))
    .map((field) =>
      finding(
        "skill-frontmatter",
        at(doc.path, field.line),
        `\`${field.name}\` is not a skill frontmatter field — plugin-only keys (version, license, metadata) belong to plugin.json`
      )
    );
  findings.push(...lintSkillName(doc), ...lintSkillDescription(doc));
  findings.push(...lintSkillEffort(doc));
  return findings;
}

function fieldNamed(doc: SkillDoc, name: string): FrontmatterField | undefined {
  return doc.fields.find((field) => field.name === name);
}

function unquote(value: string): string {
  return value.replace(QUOTES, "").trim();
}

function lintSkillName(doc: SkillDoc): Finding[] {
  const field = fieldNamed(doc, "name");
  if (field === undefined) {
    return [
      finding(
        "skill-frontmatter",
        doc.path,
        "frontmatter has no `name` — it is one of the two required fields"
      ),
    ];
  }
  const value = unquote(field.value);
  const where = at(doc.path, field.line);
  const findings: Finding[] = [];
  if (!KEBAB.test(value)) {
    findings.push(
      finding(
        "skill-name",
        where,
        `name \`${value}\` is not kebab-case — lowercase letters, digits and hyphens only`
      )
    );
  }
  if (value.length > MAX_NAME_LENGTH) {
    findings.push(
      finding(
        "skill-name",
        where,
        `name \`${value}\` is ${value.length} characters — the cap is ${MAX_NAME_LENGTH}`
      )
    );
  }
  findings.push(...lintReservedName(value, where));
  return findings;
}

function lintReservedName(value: string, where: string): Finding[] {
  const lowered = value.toLowerCase();
  return RESERVED_NAME_WORDS.filter((word) => lowered.includes(word)).map(
    (word) =>
      finding(
        "skill-name",
        where,
        `name \`${value}\` must not contain \`${word}\``
      )
  );
}

function lintSkillDescription(doc: SkillDoc): Finding[] {
  const field = fieldNamed(doc, "description");
  if (field === undefined) {
    return [
      finding(
        "skill-frontmatter",
        doc.path,
        "frontmatter has no `description` — it is one of the two required fields (drop it only via `disable-model-invocation`, which still needs a human-facing line)"
      ),
    ];
  }
  const value = unquote(field.value);
  if (value.length <= MAX_DESCRIPTION_LENGTH) {
    return [];
  }
  return [
    finding(
      "skill-description",
      at(doc.path, field.line),
      `description is ${value.length} characters — the cap is ${MAX_DESCRIPTION_LENGTH}`
    ),
  ];
}

function lintSkillEffort(doc: SkillDoc): Finding[] {
  const field = fieldNamed(doc, "effort");
  if (field === undefined) {
    return [];
  }
  const value = unquote(field.value).toLowerCase();
  if (SKILL_EFFORTS.includes(value)) {
    return [];
  }
  return [
    finding(
      "skill-frontmatter",
      at(doc.path, field.line),
      `effort \`${unquote(field.value)}\` is not a valid value — expected one of: ${SKILL_EFFORTS.join(", ")}`
    ),
  ];
}

// The two budget rules: the line cap (past it, split into references or migrate
// to multi-workflow) and the closing `## Acceptance checklist` — the step that
// makes the agent verify its own run, so it must be the LAST section.
function lintSkillBudget(doc: SkillDoc): Finding[] {
  const findings: Finding[] = [];
  const count = lineCount(doc.lines);
  if (count > MAX_SKILL_LINES) {
    findings.push(
      finding(
        "skill-budget",
        doc.path,
        `${SKILL_FILE} is ${count} lines — the budget is ${MAX_SKILL_LINES} lines; push detail behind a reference or split the workflow`
      )
    );
  }
  const headings = topHeadings(doc.lines);
  if (headings.at(-1) !== CLOSING_HEADING) {
    findings.push(
      finding(
        "skill-checklist",
        doc.path,
        `${SKILL_FILE} does not end with \`## Acceptance checklist\` — every skill closes on the checklist the agent verifies against`
      )
    );
  }
  return findings;
}

// A trailing newline yields a final empty element from `split` — the file has
// `n` lines, not `n + 1`.
function lineCount(lines: string[]): number {
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

// The `## ` headings, normalized, IGNORING anything inside a fenced block (a
// skill's examples routinely contain markdown).
function topHeadings(lines: string[]): string[] {
  return topLevelHeadings(lines).map((index) =>
    normalize((lines[index] ?? "").slice(3))
  );
}

// The RESOURCE GRAPH — the three checks that keep a skill's disclosure ladder
// honest: every path the body points at exists (a dead pointer is silent
// breakage), every file on disk is pointed at (an orphan is sediment nobody
// loads), and no resource points at another resource (one level deep — a
// reference behind a reference is never reliably reached). Plus the citation
// form: paths are inline code, never markdown links.
function lintSkillResources(doc: SkillDoc, root: string): Finding[] {
  const body = doc.lines.join("\n");
  const mentioned = new Set(resourcePaths(body, doc.dir));
  const onDisk = listResources(doc.dir);
  const findings: Finding[] = [];
  for (const path of mentioned) {
    if (!onDisk.includes(path)) {
      findings.push(
        finding(
          "skill-resources",
          resourceWhere(doc, path),
          `${SKILL_FILE} points at \`${path}\`, which does not exist in the skill directory`
        )
      );
    }
  }
  for (const path of onDisk) {
    if (!mentioned.has(path)) {
      findings.push(
        finding(
          "skill-resources",
          display(root, join(doc.dir, path)),
          `\`${path}\` is never pointed at from ${SKILL_FILE} — a resource nothing loads is dead weight`
        )
      );
    }
  }
  findings.push(...lintResourceLinks(doc, body));
  findings.push(...lintNestedResources(doc, onDisk, root));
  return findings;
}

// Every resource path in `text` that belongs to THIS skill, de-punctuated. A
// DIRECTORY mention ("see `examples/` for sample outputs") carries no filename
// and is not a pointer at a file, so it never enters the set — and neither does
// another skill's path.
function resourcePaths(text: string, dir: string): string[] {
  return [...text.matchAll(RESOURCE_MENTION)]
    .filter((match) => isOwnResource(dir, match[1] ?? ""))
    .map((match) => (match[2] ?? "").replace(TRAILING_PUNCT, ""))
    .filter((path) => (path.split("/").at(-1) ?? "").includes("."));
}

// Whether a mention's prefix still points INTO this skill: no prefix at all (the
// skill-relative form the craft rules ask for), or a longer spelling of this very
// directory — `skills/improve-architecture/references/…` written from inside
// `plugin/skills/improve-architecture` is the skill's own file, not a foreign one.
function isOwnResource(dir: string, prefix: string): boolean {
  const trimmed = prefix.replace(LEADING_HERE, "").replace(TRAILING_SLASH, "");
  if (trimmed === "") {
    return true;
  }
  return dir.replaceAll("\\", "/").endsWith(`/${trimmed}`);
}

// The files actually shipped under `references/`, `examples/` and `scripts/`, as
// skill-relative posix paths (the same form the body cites them by).
function listResources(dir: string): string[] {
  const found: string[] = [];
  for (const name of RESOURCE_DIRS) {
    const base = join(dir, name);
    if (existsSync(base)) {
      collectFiles(base, name, found);
    }
  }
  return found;
}

function collectFiles(base: string, prefix: string, found: string[]): void {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectFiles(join(base, entry.name), path, found);
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
}

function lintResourceLinks(doc: SkillDoc, body: string): Finding[] {
  return [...body.matchAll(RESOURCE_LINK)].map((match) =>
    finding(
      "skill-resources",
      resourceWhere(doc, match[1] ?? ""),
      `\`${match[1] ?? ""}\` is cited as a markdown link — reference paths go in inline code, never as links`
    )
  );
}

// One level deep: a resource that points at another resource hides material
// behind two hops, and the second is effectively never loaded.
function lintNestedResources(
  doc: SkillDoc,
  onDisk: string[],
  root: string
): Finding[] {
  const findings: Finding[] = [];
  for (const path of onDisk.filter((entry) => entry.endsWith(".md"))) {
    const nested = resourcePaths(
      readFileSync(join(doc.dir, path), "utf8"),
      doc.dir
    ).filter((target) => target !== path);
    for (const target of nested) {
      findings.push(
        finding(
          "skill-resources",
          display(root, join(doc.dir, path)),
          `\`${path}\` points at \`${target}\` — resources are one level deep; never reference a reference`
        )
      );
    }
  }
  return findings;
}

// The line a resource is mentioned on, so the finding lands where the fix is.
function resourceWhere(doc: SkillDoc, path: string): string {
  const line = doc.lines.findIndex((entry) => entry.includes(path));
  return line === -1 ? doc.path : at(doc.path, line);
}

// ---------------------------------------------------------------------------
// `wizard verify <script>` — a generated wizard against the VENDORED template
// ---------------------------------------------------------------------------

// The template the CLI SHIPS (`cli/wizard/template.sh`, a verbatim copy of
// `plugin/skills/wizard/references/template.sh`). It is vendored for the same
// reason the skill-frontmatter whitelist is: `wizard verify` runs in a CONSUMER
// repo, where no plugin directory exists.
const WIZARD_TEMPLATE_ASSET = "wizard/template.sh";

// The two anchors that bracket the LIBRARY REGION — the part of a wizard that is
// identical across every wizard and must never be hand-edited.
//
// The region is measured from `set -euo pipefail` (not from byte 0) DELIBERATELY:
// the vendored copy carries a provenance comment the plugin's original does not,
// so a script copied from EITHER file has to hash the same. Everything a wizard
// author actually touches lives below the marker, so the region still covers the
// whole library.
const STAGES_MARKER = "# STAGES";
const LIBRARY_START = "set -euo pipefail";

const EXECUTABLE_BITS = 0o111;

const WORKFLOWS_DIR = ".github/workflows";
const WORKFLOW_EXTENSIONS: readonly string[] = [".yml", ".yaml"];
// GitHub Actions injects this one into every workflow run, so a `secrets.*`
// reference to it is never a value some wizard failed to produce.
const CI_PROVIDED_SECRETS: ReadonlySet<string> = new Set(["GITHUB_TOKEN"]);

// The library's own vocabulary, as the stage inventory reads it. `ask_secret`
// leads the alternation so the longer name wins the match.
const STAGE_CALL = /^\s*stage\s+\S/;
const ASK_CALL = /^\s*(ask_secret|ask)\s+([A-Za-z_]\w*)/;
const PERSIST_CALL = /^\s*(write_env|set_secret|set_var)\s+([A-Za-z_]\w*)/;
const OPEN_URL_CALL = /^\s*open_url\b/;
const TOTAL_STAGES_ASSIGN = /^\s*TOTAL_STAGES\s*=\s*"?(\d+)/;
// A KEY whose NAME says the value is a credential. `PUBLIC`/`PUBLISHABLE` keys
// are exempt: a publishable key is public by definition (the template's own
// example stage captures `STRIPE_PUBLISHABLE_KEY` with a visible `ask`, and
// flagging it would train authors to ignore this finding).
const SECRET_SHAPED_KEY = /SECRET|TOKEN|KEY|PASSWORD|DSN/;
const PUBLIC_KEY = /PUBLIC|PUBLISHABLE/;
const WORKFLOW_SECRET = /secrets\.([A-Za-z_]\w*)/g;

// ONE shellcheck diagnostic in its `gcc` format — `file:line:col: level: message
// [SCxxxx]`, captured as the LINE and the rest. That format is why shellcheck is
// asked for it: its DEFAULT (tty) output spreads a single diagnostic over five
// lines (the location, the echoed source line, a caret, "For more information:",
// the wiki URL), which would become five findings carrying fragments and no line.
const SHELLCHECK_DIAGNOSTIC = /^.*?:(\d+):\d+:\s*(.+)$/;

// A check's outcome when it can also come back "not run": findings AND the notes
// that say which check was SKIPPED (an absent tool is never a defect in the
// artifact, but a caller must be able to tell a checked wizard from an unchecked
// one).
interface WizardCheck {
  findings: Finding[];
  notes: string[];
}

// One authored stage, projected onto the rules: what it captures (and whether the
// input was hidden), what it persists, and where it opens a page.
interface WizardStage {
  asks: { hidden: boolean; key: string; line: number }[];
  line: number;
  openUrls: number[];
  persisted: Set<string>;
  secrets: { line: number; name: string }[];
}

// One `secrets.NAME` reference found in CI.
interface WorkflowSecret {
  file: string;
  line: number;
  name: string;
}

function runWizardVerify(context: CommandContext): CommandResult {
  const root = workroot(context);
  const path = targetPath(context, 1);
  if (path === undefined) {
    return fail(
      context,
      "wizard verify requires the script — `dobby wizard verify <script>`"
    );
  }
  if (!existsSync(path)) {
    return fail(context, `wizard verify: ${path} not found`);
  }
  const templatePath = resolveAsset(WIZARD_TEMPLATE_ASSET);
  if (!existsSync(templatePath)) {
    return fail(
      context,
      `wizard verify: this dobby install carries no wizard template at ${templatePath} — reinstall @kvnwolf/dobby`
    );
  }
  // The vendored template is the ORACLE every library comparison reads; a copy
  // that lost its own library region can judge nothing, so it is a hard error
  // (naming the asset) rather than a silently empty inventory — otherwise a
  // corrupted install would answer `ok` for every script handed to it.
  const templateLibrary = libraryRegion(readLines(templatePath));
  if (templateLibrary === null) {
    return fail(
      context,
      `wizard verify: the vendored wizard template at ${templatePath} carries no \`${LIBRARY_START}\` … \`${STAGES_MARKER}\` region — there is nothing to compare a script against; reinstall @kvnwolf/dobby`
    );
  }
  const lines = readLines(path);
  const shown = display(root, path);
  const statik = lintWizardStatic(path, root, shown);
  const secrets = lintWizardSecrets(lines, root, shown);
  return report(
    context,
    [
      ...lintWizardLibrary(lines, templateLibrary, shown),
      ...statik.findings,
      ...lintWizardStages(lines, shown),
      ...secrets.findings,
    ],
    { notes: [...statik.notes, ...secrets.notes] }
  );
}

// The `# STAGES` line — everything above it is the library, everything below it is
// authored. -1 when the script has no marker at all.
function markerIndex(lines: string[]): number {
  return lines.findIndex((line) => line.trimStart().startsWith(STAGES_MARKER));
}

// The library region as text: `set -euo pipefail` up to (not including) the
// marker. Null when either anchor is missing or they are out of order — a script
// that is not recognizably built from the template.
function libraryRegion(lines: string[]): string | null {
  const marker = markerIndex(lines);
  const start = lines.findIndex((line) => line.trim() === LIBRARY_START);
  if (marker === -1 || start === -1 || marker <= start) {
    return null;
  }
  return lines.slice(start, marker).join("\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The wizard skill's ONE load-bearing authoring rule: author BELOW the marker,
// never touch the library above it. Compared by hash rather than by diff on
// purpose — the answer is binary ("this is the template" / "it is not"), and the
// fix is always the same: re-copy the template and re-author the stages.
function lintWizardLibrary(
  lines: string[],
  templateLibrary: string,
  path: string
): Finding[] {
  const region = libraryRegion(lines);
  if (region === null) {
    return [
      finding(
        "wizard-library",
        path,
        `the script carries no \`${LIBRARY_START}\` … \`${STAGES_MARKER}\` library region — a wizard is the template copied verbatim, with the stages authored below the marker`
      ),
    ];
  }
  if (sha256(region) === sha256(templateLibrary)) {
    return [];
  }
  return [
    finding(
      "wizard-library",
      path,
      `library region edited — everything from \`${LIBRARY_START}\` to the \`${STAGES_MARKER}\` marker must be the template byte-for-byte (that consistency is load-bearing); re-copy the template and re-author the stages below the marker`
    ),
  ];
}

// The three static checks wizard/SKILL.md Step 4 mandates: it parses, shellcheck
// when it is installed, and the executable bit. `bash` and `shellcheck` are
// spawned BARE (through the runner, cwd pinned to the workroot) — a tool that is
// not on PATH comes back as a spawn error, which is a SKIP, never a finding.
function lintWizardStatic(
  path: string,
  root: string,
  shown: string
): WizardCheck {
  const check: WizardCheck = { findings: [], notes: [] };
  runWizardParse(path, root, shown, check);
  runWizardShellcheck(path, root, shown, check);
  if (!isExecutable(path)) {
    check.findings.push(
      finding(
        "wizard-executable",
        shown,
        "the script is not executable — `chmod +x` it, or the human you hand it to cannot run it"
      )
    );
  }
  return check;
}

function runWizardParse(
  path: string,
  root: string,
  shown: string,
  check: WizardCheck
): void {
  const result = runCapture("bash", ["-n", path], { root });
  if (result.error) {
    check.notes.push(
      "skipped: bash is not available — the `bash -n` parse check did not run"
    );
    return;
  }
  if (result.status === 0) {
    return;
  }
  check.findings.push(
    finding(
      "wizard-parse",
      shown,
      `\`bash -n\` cannot parse the script: ${firstLine(result.stderr, result.stdout)}`
    )
  );
}

// shellcheck, asked for its MACHINE format so one diagnostic stays one finding
// carrying the line it happened on (`--format=gcc` prints
// `file:line:col: level: message [SCxxxx]`, one line each). Output that does not
// parse as a diagnostic is shellcheck failing to RUN on the script (an unreadable
// file, an unknown flag) — reported as a single finding against the script rather
// than shredded into one finding per line of prose.
function runWizardShellcheck(
  path: string,
  root: string,
  shown: string,
  check: WizardCheck
): void {
  const result = runCapture("shellcheck", ["--format=gcc", path], { root });
  if (result.error) {
    check.notes.push(
      "skipped: shellcheck is not installed — install it for the deeper static check (`brew install shellcheck`)"
    );
    return;
  }
  if (result.status === 0) {
    return;
  }
  const output = (result.stdout.trim() === "" ? result.stderr : result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const diagnostics = output.flatMap((line) => {
    const match = SHELLCHECK_DIAGNOSTIC.exec(line);
    return match === null
      ? []
      : [
          finding(
            "wizard-shellcheck",
            at(shown, Number(match[1]) - 1),
            `shellcheck: ${match[2] ?? line}`
          ),
        ];
  });
  if (diagnostics.length > 0) {
    check.findings.push(...diagnostics);
    return;
  }
  check.findings.push(
    finding(
      "wizard-shellcheck",
      shown,
      `shellcheck exited ${result.status}: ${output[0] ?? "(no output)"}`
    )
  );
}

// The first non-empty line of a child's output, preferring stderr — the whole
// message a `bash -n` failure needs, without the trailing context.
function firstLine(primary: string, fallback: string): string {
  const text = primary.trim() === "" ? fallback : primary;
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "(no output)"
  );
}

function isExecutable(path: string): boolean {
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: a POSIX mode IS a bit field — masking is the only way to read the executable bits
    return (statSync(path).mode & EXECUTABLE_BITS) !== 0;
  } catch {
    return false;
  }
}

// The AUTHORED section, stage by stage. Everything here is a rule about the human
// walking the wizard: the progress display must be honest, a value the human
// pastes must land somewhere, a secret must never echo, and the page a value
// comes from must already be open when it is asked for.
function lintWizardStages(lines: string[], path: string): Finding[] {
  const marker = markerIndex(lines);
  if (marker === -1) {
    // Already reported as a missing library region; a stage scan over a document
    // with no marker would invent findings from the library's own helper bodies.
    return [];
  }
  const stages = parseWizardStages(lines, marker + 1);
  return [
    ...lintTotalStages(lines, marker, stages, path),
    ...stages.flatMap((stage) => [
      ...lintStagePersistence(stage, path),
      ...lintStageSecretInput(stage, path),
      ...lintStageOrder(stage, path),
    ]),
  ];
}

function parseWizardStages(lines: string[], from: number): WizardStage[] {
  const stages: WizardStage[] = [];
  let current: WizardStage | null = null;
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (STAGE_CALL.test(line)) {
      current = {
        asks: [],
        line: index,
        openUrls: [],
        persisted: new Set<string>(),
        secrets: [],
      };
      stages.push(current);
      continue;
    }
    if (current !== null) {
      readStageCall(current, line, index);
    }
  }
  return stages;
}

function readStageCall(stage: WizardStage, line: string, index: number): void {
  const ask = ASK_CALL.exec(line);
  if (ask !== null) {
    stage.asks.push({
      hidden: ask[1] === "ask_secret",
      key: ask[2] ?? "",
      line: index,
    });
    return;
  }
  const persist = PERSIST_CALL.exec(line);
  if (persist !== null) {
    const name = persist[2] ?? "";
    stage.persisted.add(name);
    if (persist[1] === "set_secret") {
      stage.secrets.push({ line: index, name });
    }
    return;
  }
  if (OPEN_URL_CALL.test(line)) {
    stage.openUrls.push(index);
  }
}

// `TOTAL_STAGES` drives the "Stage 2/5 · (~8 min left)" line every stage prints —
// a wrong number is a promise broken to the human halfway through. The value read
// is the one assigned BELOW the marker (the library's own `TOTAL_STAGES=0` is a
// declaration, not the author's estimate).
function lintTotalStages(
  lines: string[],
  marker: number,
  stages: WizardStage[],
  path: string
): Finding[] {
  let declared: { line: number; value: number } | null = null;
  for (let index = marker + 1; index < lines.length; index += 1) {
    const match = TOTAL_STAGES_ASSIGN.exec(lines[index] ?? "");
    if (match !== null) {
      declared = { line: index, value: Number(match[1]) };
    }
  }
  if (declared === null) {
    return stages.length === 0
      ? []
      : [
          finding(
            "wizard-stages",
            at(path, marker),
            `TOTAL_STAGES is never set below the \`${STAGES_MARKER}\` marker, but the script authors ${stages.length} stage(s) — the progress line would count against 0`
          ),
        ];
  }
  if (declared.value === stages.length) {
    return [];
  }
  return [
    finding(
      "wizard-stages",
      at(path, declared.line),
      `TOTAL_STAGES is ${declared.value} but the script authors ${stages.length} stage(s) — the progress line must be honest`
    ),
  ];
}

// A value the human pasted and the stage then dropped is the worst outcome a
// wizard has: the human did the work, and nothing kept it. Persisting anywhere
// counts (`write_env`, `set_secret`, `set_var`) — but it must happen in the SAME
// stage, because a stage is where a Ctrl-C lands.
function lintStagePersistence(stage: WizardStage, path: string): Finding[] {
  return stage.asks
    .filter((ask) => !stage.persisted.has(ask.key))
    .map((ask) =>
      finding(
        "wizard-persist",
        at(path, ask.line),
        `${ask.key} is captured but never persisted in this stage — \`write_env\` it (or \`set_secret\`/\`set_var\`), or the value the human pasted is lost`
      )
    );
}

function lintStageSecretInput(stage: WizardStage, path: string): Finding[] {
  return stage.asks
    .filter(
      (ask) =>
        !ask.hidden &&
        SECRET_SHAPED_KEY.test(ask.key) &&
        !PUBLIC_KEY.test(ask.key)
    )
    .map((ask) =>
      finding(
        "wizard-secret-input",
        at(path, ask.line),
        `${ask.key} is captured with visible input — a secret is read with \`ask_secret\` so it never echoes to the terminal or the scrollback`
      )
    );
}

// Open the page BEFORE asking for the value that lives on it: each `stage` clears
// the screen, so a prompt shown first leaves the human staring at a question with
// no page to answer it from.
function lintStageOrder(stage: WizardStage, path: string): Finding[] {
  const [firstAsk] = stage.asks;
  const [firstOpen] = stage.openUrls;
  if (firstAsk === undefined || firstOpen === undefined) {
    return [];
  }
  if (firstOpen < firstAsk.line) {
    return [];
  }
  return [
    finding(
      "wizard-order",
      at(path, firstAsk.line),
      `${firstAsk.key} is asked for before the stage's \`open_url\` — open the page the value comes from first, then prompt`
    ),
  ];
}

// The BIDIRECTIONAL diff that keeps CI and the wizard in sync — the wizard skill's
// stated reason for reading `.github/workflows` at all. Both directions are real
// breakage: a secret nothing consumes is dead ceremony the human paid for, and a
// `secrets.*` reference nothing produces is a CI job that fails on first run.
function lintWizardSecrets(
  lines: string[],
  root: string,
  path: string
): WizardCheck {
  const references = readWorkflowSecrets(root);
  if (references === null) {
    return {
      findings: [],
      notes: [
        `skipped: no ${WORKFLOWS_DIR}/ directory — the \`set_secret\` ↔ CI \`secrets.*\` diff did not run`,
      ],
    };
  }
  const marker = markerIndex(lines);
  const stages = marker === -1 ? [] : parseWizardStages(lines, marker + 1);
  const produced = stages.flatMap((stage) => stage.secrets);
  const referenced = new Set(references.map((entry) => entry.name));
  const producedNames = new Set(produced.map((entry) => entry.name));
  return {
    findings: [
      ...lintUnreferencedSecrets(produced, referenced, path),
      ...lintUnproducedSecrets(references, producedNames),
    ],
    notes: [],
  };
}

function lintUnreferencedSecrets(
  produced: { line: number; name: string }[],
  referenced: ReadonlySet<string>,
  path: string
): Finding[] {
  return produced
    .filter((entry) => !referenced.has(entry.name))
    .map((entry) =>
      finding(
        "wizard-secrets",
        at(path, entry.line),
        `\`set_secret ${entry.name}\` — no workflow under ${WORKFLOWS_DIR}/ references \`secrets.${entry.name}\`; set only the values CI actually needs`
      )
    );
}

function lintUnproducedSecrets(
  references: WorkflowSecret[],
  produced: ReadonlySet<string>
): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const entry of references) {
    if (
      produced.has(entry.name) ||
      CI_PROVIDED_SECRETS.has(entry.name) ||
      seen.has(entry.name)
    ) {
      continue;
    }
    seen.add(entry.name);
    findings.push(
      finding(
        "wizard-secrets",
        at(entry.file, entry.line),
        `CI references \`secrets.${entry.name}\`, which no stage produces — every \`secrets.*\` reference is a value the wizard must capture and \`set_secret\``
      )
    );
  }
  return findings;
}

// Every `secrets.NAME` reference in the repo's workflows, with the file+line each
// was found on. NULL — not an empty list — when the repo has no workflows
// directory at all: nothing to diff against is a SKIP, never a mismatch.
function readWorkflowSecrets(root: string): WorkflowSecret[] | null {
  const dir = join(root, WORKFLOWS_DIR);
  if (!existsSync(dir)) {
    return null;
  }
  const found: WorkflowSecret[] = [];
  for (const name of readdirSync(dir)) {
    if (!WORKFLOW_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      continue;
    }
    const file = `${WORKFLOWS_DIR}/${name}`;
    for (const [index, line] of readLines(join(dir, name)).entries()) {
      for (const match of line.matchAll(WORKFLOW_SECRET)) {
        found.push({ file, line: index, name: match[1] ?? "" });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// `arch-report verify <file>` — the architecture review's HTML report
// ---------------------------------------------------------------------------
//
// The report is a SINGLE self-contained file in the OS temp dir, rendered from
// two CDNs and nothing else. Every rule below is `improve-architecture`'s
// `references/html-report.md` made mechanical: the modern CDN builds (a model's
// training data reaches for the stale ones), the two structural sections, the
// anchor that must resolve, and the two banned phrases the vocabulary rules out.
// What the report SAYS — whether a candidate is real, whether a diagram earns its
// space — stays the architect's call.

// The two assets the report is allowed to load, matched by the substring that
// pins the MAJOR: `@4` and `@11` are version RANGES on purpose (which is also why
// SRI is banned — the file behind the range moves).
const TAILWIND_CDN = "cdn.jsdelivr.net/npm/@tailwindcss/browser@4";
const MERMAID_CDN = "mermaid@11";
// The three stale spellings the reference explicitly corrects.
const TAILWIND_V3_CDN = "cdn.tailwindcss.com";
const TAILWIND_JS_CONFIG = "tailwind.config";
const MERMAID_UMD = "mermaid.min.js";

const CANDIDATES_ID = "candidates";
const TOP_RECOMMENDATION_ID = "top-recommendation";

const HTML_SCRIPT_TAG = /<script\b([^>]*)>/gi;
const HTML_LINK_TAG = /<link\b([^>]*)>/gi;
const HTML_SRC_ATTR = /\bsrc\s*=\s*["']([^"']+)["']/i;
const HTML_HREF_ATTR = /\bhref\s*=\s*["']([^"']+)["']/i;
const HTML_INTEGRITY_ATTR = /\bintegrity\s*=/i;
const HTML_ID_ATTR = /\bid\s*=\s*["']([^"']+)["']/gi;
const HTML_ANCHOR_HREF = /href\s*=\s*["']#([^"']+)["']/gi;
const MODULE_SCRIPT_BLOCK =
  /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi;
const CANDIDATES_SECTION =
  /<section\b[^>]*\bid\s*=\s*["']candidates["'][^>]*>([\s\S]*?)<\/section>/i;
const TOP_RECOMMENDATION_SECTION =
  /<section\b[^>]*\bid\s*=\s*["']top-recommendation["'][^>]*>([\s\S]*?)<\/section>/i;
const ARTICLE_TAG = /<article\b/i;
const EXTERNAL_URL = /^(?:https?:)?\/\//i;
const CURLY_APOSTROPHE = /[‘’]/g;

// The phrases the architecture vocabulary rules out: two empty claims and one
// throat-clear. They are cheap to write and carry no information, which is
// exactly why a generator reaches for them.
const BANNED_PROSE: readonly string[] = [
  "easier to maintain",
  "cleaner code",
  "it's worth noting",
];

function runArchReportVerify(context: CommandContext): CommandResult {
  const root = workroot(context);
  const path = targetPath(context, 1);
  if (path === undefined) {
    return fail(
      context,
      "arch-report verify requires the report — `dobby arch-report verify <file>`"
    );
  }
  if (!existsSync(path)) {
    return fail(context, `arch-report verify: ${path} not found`);
  }
  const lines = readLines(path);
  const html = lines.join("\n");
  const shown = display(root, path);
  return report(context, [
    ...lintEphemeralLocation(root, path, {
      check: "arch-report-location",
      label: "the architecture report",
    }),
    ...lintReportCdns(html, lines, shown),
    ...lintReportAssets(html, lines, shown),
    ...lintReportStructure(html, lines, shown),
    ...lintReportProse(lines, shown),
  ]);
}

// The CDN wiring: the two modern builds present, the three stale spellings
// absent. Tailwind v4 is CSS-first (no `tailwind.config` JS global survived the
// major) and Mermaid 11 is ESM-only (there is no UMD bundle to `src=`).
function lintReportCdns(
  html: string,
  lines: string[],
  path: string
): Finding[] {
  const findings: Finding[] = [];
  if (!html.includes(TAILWIND_CDN)) {
    findings.push(
      finding(
        "arch-report-cdn",
        path,
        `no Tailwind v4 browser build — the report styles from \`https://${TAILWIND_CDN}\``
      )
    );
  }
  findings.push(...lintStaleCdn(html, lines, path));
  if (!moduleScripts(html).some((body) => body.includes(MERMAID_CDN))) {
    findings.push(
      finding(
        "arch-report-cdn",
        path,
        `no Mermaid 11 ESM import inside a \`<script type="module">\` — Mermaid 11 is ESM-only and renders async, so it can only be loaded as a module`
      )
    );
  }
  if (HTML_INTEGRITY_ATTR.test(html)) {
    findings.push(
      finding(
        "arch-report-cdn",
        whereIn(lines, path, "integrity"),
        "Subresource-Integrity attribute — the CDN URLs are version RANGES (`@4`, `@11`) that resolve to different files over time, so a pinned hash breaks on the next patch release; SRI is omitted by design"
      )
    );
  }
  return findings;
}

function lintStaleCdn(html: string, lines: string[], path: string): Finding[] {
  const stale: { message: string; token: string }[] = [
    {
      message: `\`${TAILWIND_V3_CDN}\` is the Tailwind v3 CDN — v4 ships the browser build at \`https://${TAILWIND_CDN}\``,
      token: TAILWIND_V3_CDN,
    },
    {
      message: `\`${TAILWIND_JS_CONFIG}\` is the removed v3 JS global — Tailwind v4 is CSS-first: theme with \`<style type="text/tailwindcss">@theme{…}</style>\``,
      token: TAILWIND_JS_CONFIG,
    },
    {
      message: `\`${MERMAID_UMD}\` does not exist — Mermaid 11 is ESM-only; import it inside a \`<script type="module">\``,
      token: MERMAID_UMD,
    },
  ];
  return stale
    .filter((entry) => html.includes(entry.token))
    .map((entry) =>
      finding(
        "arch-report-cdn",
        whereIn(lines, path, entry.token),
        entry.message
      )
    );
}

// The bodies of every `<script type="module">` block.
function moduleScripts(html: string): string[] {
  return [...html.matchAll(MODULE_SCRIPT_BLOCK)].map((match) => match[1] ?? "");
}

// Self-contained means self-contained: the ONLY external assets are the Tailwind
// browser build and the Mermaid ESM import. A third one (a font stylesheet, an
// analytics script) makes the report depend on a network it may not have — and
// the reference says so in one line.
function lintReportAssets(
  html: string,
  lines: string[],
  path: string
): Finding[] {
  const findings: Finding[] = [];
  for (const match of html.matchAll(HTML_SCRIPT_TAG)) {
    const src = HTML_SRC_ATTR.exec(match[1] ?? "")?.[1];
    if (src !== undefined && isForeignAsset(src)) {
      findings.push(
        finding(
          "arch-report-assets",
          whereIn(lines, path, src),
          `external script \`${src}\` — the only scripts are the Tailwind v4 browser build and the Mermaid 11 ESM import`
        )
      );
    }
  }
  for (const match of html.matchAll(HTML_LINK_TAG)) {
    const href = HTML_HREF_ATTR.exec(match[1] ?? "")?.[1];
    if (href !== undefined && isForeignAsset(href)) {
      findings.push(
        finding(
          "arch-report-assets",
          whereIn(lines, path, href),
          `external stylesheet \`${href}\` — the report is self-contained; style it with the Tailwind v4 browser build alone`
        )
      );
    }
  }
  return findings;
}

// Whether a URL is an EXTERNAL asset that is not one of the two allowed CDNs. A
// relative/inline reference is not external at all.
function isForeignAsset(url: string): boolean {
  if (!EXTERNAL_URL.test(url)) {
    return false;
  }
  return !(url.includes(TAILWIND_CDN) || url.includes(MERMAID_CDN));
}

// The two sections `/dobby:improve-architecture` promises its reader, and the
// link between them: candidates carry the `<article>` cards, the top
// recommendation names ONE of them by anchor.
function lintReportStructure(
  html: string,
  lines: string[],
  path: string
): Finding[] {
  const candidates = CANDIDATES_SECTION.exec(html);
  const findings: Finding[] = [];
  if (candidates === null) {
    findings.push(
      finding(
        "arch-report-structure",
        path,
        `no \`#${CANDIDATES_ID}\` section — the report's candidate cards live in \`<section id="${CANDIDATES_ID}">\``
      )
    );
  } else if (!ARTICLE_TAG.test(candidates[1] ?? "")) {
    findings.push(
      finding(
        "arch-report-structure",
        whereIn(lines, path, `id="${CANDIDATES_ID}"`),
        `the \`#${CANDIDATES_ID}\` section carries no \`<article>\` — each candidate is one article card`
      )
    );
  }
  findings.push(...lintTopRecommendation(html, lines, path));
  return findings;
}

function lintTopRecommendation(
  html: string,
  lines: string[],
  path: string
): Finding[] {
  const section = TOP_RECOMMENDATION_SECTION.exec(html);
  if (section === null) {
    return [
      finding(
        "arch-report-structure",
        path,
        `no \`#${TOP_RECOMMENDATION_ID}\` section — the report closes on one card naming the candidate to do first`
      ),
    ];
  }
  const body = section[1] ?? "";
  const anchors = [...body.matchAll(HTML_ANCHOR_HREF)].map(
    (match) => match[1] ?? ""
  );
  if (anchors.length === 0) {
    return [
      finding(
        "arch-report-structure",
        whereIn(lines, path, `id="${TOP_RECOMMENDATION_ID}"`),
        `the \`#${TOP_RECOMMENDATION_ID}\` section carries no anchor link to a candidate card`
      ),
    ];
  }
  const ids = new Set(
    [...html.matchAll(HTML_ID_ATTR)].map((match) => match[1] ?? "")
  );
  return anchors
    .filter((anchor) => !ids.has(anchor))
    .map((anchor) =>
      finding(
        "arch-report-structure",
        whereIn(lines, path, `#${anchor}`),
        `the top recommendation's anchor \`#${anchor}\` resolves to no id in the report`
      )
    );
}

function lintReportProse(lines: string[], path: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of lines.entries()) {
    const text = line.replace(CURLY_APOSTROPHE, "'").toLowerCase();
    for (const phrase of BANNED_PROSE) {
      if (text.includes(phrase)) {
        findings.push(
          finding(
            "arch-report-prose",
            at(path, index),
            `banned phrase "${phrase}" — it is not in the architecture vocabulary and carries no information; name the win in glossary terms (locality, leverage, depth)`
          )
        );
      }
    }
  }
  return findings;
}

// The line a token appears on, so a finding lands where the fix is; the bare path
// when the token spans lines (or came from a whole-document match).
function whereIn(lines: string[], path: string, token: string): string {
  const index = lines.findIndex((line) => line.includes(token));
  return index === -1 ? path : at(path, index);
}

// ---------------------------------------------------------------------------
// `handoff finalize <file>` — the ephemeral fork doc for a fresh session
// ---------------------------------------------------------------------------
//
// The handoff is written to the OS temp dir, pasted into a new session, and
// thrown away. That is what makes each rule below load-bearing: a missing section
// is state the next session has to re-derive, a pasted body is the sediment the
// fork exists to shed, a dead reference is a wasted round trip — and a LEAKED
// CREDENTIAL is the one defect that cannot be walked back, so the secret scan
// FAILS CLOSED (a plausible token is a finding; a false positive costs one
// rewording, a miss costs a rotation).
//
// On success the command PRINTS the absolute path: `handoff/SKILL.md`'s "echo the
// absolute path" step IS this command's output.

// The sections handoff/SKILL.md Step 2 prescribes, matched as PREFIXES: the skill
// itself writes "Open questions / next moves", and a heading that says MORE than
// the minimum is not a defect.
const HANDOFF_SECTIONS: readonly string[] = [
  "Focus",
  "Where we are",
  "Artifacts",
  "Open questions",
  "Suggested skills",
];
const FOCUS_SECTION = "Focus";
const ARTIFACTS_SECTION = "Artifacts";
const SKILLS_SECTION = "Suggested skills";
const MAX_FOCUS_LINES = 1;

// The `/dobby:<skill>` commands the plugin carries, VENDORED as data from
// `plugin/skills/` (2026-07-24) for the same reason the wizard template and the
// frontmatter whitelist are: a consumer install has no plugin directory to read.
// Keep in sync when a skill is added, renamed or removed.
const KIT_SKILLS: readonly string[] = [
  "address-review",
  "backlog",
  "commit",
  "create-skill",
  "data-fetching",
  "data-processing",
  "diagnose",
  "dispatch",
  "execute",
  "finish",
  "handoff",
  "improve-architecture",
  "interview",
  "learn",
  "map",
  "mark",
  "migrate-config",
  "module-conventions",
  "onboard",
  "prototype",
  "research",
  "resolve-conflicts",
  "scope",
  "spec",
  "teach",
  "triage",
  "wizard",
  "wrap",
];

const SKILL_MENTION = /\/dobby:([a-z0-9-]+)/g;
const URL_REFERENCE = /^(?:https?|mailto|ssh|git):/i;
// What a reference looks like once its bullet marker and decoration are gone: the
// FIRST token on the line, which is the `path/URL — one line` form Step 2 asks
// for.
const REFERENCE_DECORATION = /^[`'"([<]+|[`'")\]>,.;:]+$/g;
const WHITESPACE_RUN = /\s+/u;

// The credential shapes the scan refuses to hand to another session. Every one is
// its provider's DOCUMENTED prefix + length, and the last is the generic
// assignment that catches the shapes nobody publishes.
const SECRET_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "an `sk-` API key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  {
    label: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  { label: "an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    label: "a database connection string carrying credentials",
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i,
  },
  { label: "an inlined private key", pattern: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { label: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    label: "a credential assignment",
    pattern: /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/i,
  },
];

// One `## ` section of a plain document: its heading line plus the body range.
interface DocSection {
  end: number;
  line: number;
  name: string;
  start: number;
}

function runHandoffFinalize(context: CommandContext): CommandResult {
  const root = workroot(context);
  const path = targetPath(context, 1);
  if (path === undefined) {
    return fail(
      context,
      "handoff finalize requires the document — `dobby handoff finalize <file>`"
    );
  }
  if (!existsSync(path)) {
    return fail(context, `handoff finalize: ${path} not found`);
  }
  const lines = readLines(path);
  const sections = docSections(lines);
  const findings = [
    ...lintEphemeralLocation(root, path, {
      check: "handoff-location",
      label: "the handoff doc",
    }),
    ...lintHandoffSections(sections, path),
    ...lintHandoffFocus(lines, sections, context, path),
    ...lintHandoffFences(lines, path),
    ...lintHandoffArtifacts(lines, sections, root, path),
    ...lintHandoffSkills(lines, sections, path),
    ...lintHandoffSecrets(lines, path),
  ];
  // The clean verdict IS the hand-off: the absolute path, which the skill echoes
  // to the user and the next session opens.
  return report(context, findings, { okText: path, payload: { path } });
}

// The document's `## ` sections with their body ranges (fenced lines skipped —
// the same rule the spec region uses).
function docSections(lines: string[]): DocSection[] {
  const headings = topLevelHeadings(lines);
  return headings.map((line, index) => ({
    end: headings[index + 1] ?? lines.length,
    line,
    name: (lines[line] ?? "").slice(3).trim(),
    start: line + 1,
  }));
}

function sectionStarting(
  sections: DocSection[],
  name: string
): DocSection | undefined {
  const wanted = normalize(name);
  return sections.find((section) => normalize(section.name).startsWith(wanted));
}

// The body lines of a section that carry content (blank lines dropped). Takes the
// bare RANGE, so the handoff's `## ` sections and the brief's `**Label:**` fields
// — two different section shapes — read their bodies through one helper.
function sectionBody(lines: string[], section: Region): number[] {
  const body: number[] = [];
  for (let index = section.start; index < section.end; index += 1) {
    if ((lines[index] ?? "").trim() !== "") {
      body.push(index);
    }
  }
  return body;
}

function lintHandoffSections(sections: DocSection[], path: string): Finding[] {
  return HANDOFF_SECTIONS.filter(
    (name) => sectionStarting(sections, name) === undefined
  ).map((name) =>
    finding(
      "handoff-sections",
      path,
      `missing required section: ## ${name} — a fresh session reads all five (Focus, Where we are, Artifacts, Open questions, Suggested skills)`
    )
  );
}

// Focus is ONE line by contract: it is what the next session tailors everything
// else to, and a paragraph is a second "Where we are". `--focus` (the argument the
// skill was invoked with) must be what that line is about — `run.ts` allowlists
// the flag on `handoff finalize` for exactly this reader.
function lintHandoffFocus(
  lines: string[],
  sections: DocSection[],
  context: CommandContext,
  path: string
): Finding[] {
  const section = sectionStarting(sections, FOCUS_SECTION);
  if (section === undefined) {
    // Already reported by the section inventory.
    return [];
  }
  const body = sectionBody(lines, section);
  const findings: Finding[] = [];
  if (body.length > MAX_FOCUS_LINES) {
    findings.push(
      finding(
        "handoff-focus",
        at(path, body[MAX_FOCUS_LINES] ?? section.line),
        `## ${FOCUS_SECTION} runs to ${body.length} lines — it is ONE line saying what the next session is for; the rest belongs under ## Where we are`
      )
    );
  }
  const { focus } = context.options;
  const text = body
    .map((index) => lines[index] ?? "")
    .join(" ")
    .toLowerCase();
  if (typeof focus === "string" && !text.includes(focus.toLowerCase())) {
    findings.push(
      finding(
        "handoff-focus",
        at(path, section.line),
        `## ${FOCUS_SECTION} does not mention "${focus}" — the focus the handoff was asked for IS the focus line`
      )
    );
  }
  return findings;
}

// "Reference each artifact by path or URL — never paste its contents." A fenced
// block is the shape that rule fails in, wherever it appears in the doc.
function lintHandoffFences(lines: string[], path: string): Finding[] {
  const findings: Finding[] = [];
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (!FENCE_LINE.test(line)) {
      continue;
    }
    if (!open) {
      findings.push(
        finding(
          "handoff-paste",
          at(path, index),
          "fenced code block — a handoff REFERENCES by path or URL and never copies; a pasted body re-introduces the sediment the fork exists to shed and goes stale immediately"
        )
      );
    }
    open = !open;
  }
  return findings;
}

// Every local reference must exist ON DISK — resolved against the WORKROOT, since
// the handoff itself lives in the OS temp dir and its own directory could never
// resolve `STATE.md`. A URL is taken on trust (this command never touches the
// network).
function lintHandoffArtifacts(
  lines: string[],
  sections: DocSection[],
  root: string,
  path: string
): Finding[] {
  const section = sectionStarting(sections, ARTIFACTS_SECTION);
  if (section === undefined) {
    return [];
  }
  const findings: Finding[] = [];
  for (const index of sectionBody(lines, section)) {
    const reference = firstToken(lines[index] ?? "");
    if (reference === null || !isLocalReference(reference)) {
      continue;
    }
    const target = isAbsolute(reference) ? reference : join(root, reference);
    if (!existsSync(target)) {
      findings.push(
        finding(
          "handoff-artifacts",
          at(path, index),
          `\`${reference}\` does not exist (looked under ${root}) — a reference the next session cannot open is worse than none`
        )
      );
    }
  }
  return findings;
}

// The reference a bullet leads with: `- path/URL — one line on what it holds`.
// Null when the line is not a bullet at all (prose under the heading is allowed).
function firstToken(line: string): string | null {
  if (!LIST_MARKER.test(line)) {
    return null;
  }
  const [token] = line.replace(LIST_MARKER, "").trim().split(WHITESPACE_RUN);
  if (token === undefined || token === "") {
    return null;
  }
  const cleaned = token.replace(REFERENCE_DECORATION, "");
  return cleaned === "" ? null : cleaned;
}

// Whether a token is a LOCAL path (so its existence is checkable) rather than a
// URL or a plain English word.
function isLocalReference(token: string): boolean {
  if (URL_REFERENCE.test(token)) {
    return false;
  }
  return token.includes("/") || token.includes(".");
}

// Every `/dobby:<skill>` the next session is pointed at must be a skill the
// plugin actually carries — a suggestion that resolves to nothing is a dead end
// the fresh session pays for.
function lintHandoffSkills(
  lines: string[],
  sections: DocSection[],
  path: string
): Finding[] {
  const section = sectionStarting(sections, SKILLS_SECTION);
  if (section === undefined) {
    return [];
  }
  const findings: Finding[] = [];
  for (const index of sectionBody(lines, section)) {
    for (const match of (lines[index] ?? "").matchAll(SKILL_MENTION)) {
      const name = match[1] ?? "";
      if (!KIT_SKILLS.includes(name)) {
        findings.push(
          finding(
            "handoff-skills",
            at(path, index),
            `/dobby:${name} is not a skill the plugin carries — suggest one that exists, or the next session opens a dead end`
          )
        );
      }
    }
  }
  return findings;
}

// The secret scan. It reports the LINE and the SHAPE, never the value — echoing a
// credential into a report that lands in a terminal, a log and a session
// transcript would leak it three more times.
function lintHandoffSecrets(lines: string[], path: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of lines.entries()) {
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push(
          finding(
            "handoff-secret",
            at(path, index),
            `looks like ${label} — a handoff is pasted into a fresh session, so redact it: reference WHERE the secret lives (.env, the secret manager), never its value`
          )
        );
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// `brief lint (--file <f> | --issue N)` — the triage agent brief
// ---------------------------------------------------------------------------
//
// The brief is the CONTRACT the downstream worker (or a `/dobby:scope` session)
// builds from, and it may sit unactioned for weeks while the codebase moves
// underneath it. That is what makes `references/agent-brief.md`'s "durability
// over precision" mechanical here: a file path and a line number are the two
// things guaranteed to be WRONG by the time anyone reads the brief, and a
// procedural heading ("Files to change", "What to do") turns a specification into
// a stale to-do list — all three are lifted verbatim from that reference's own
// "bad brief" example.
//
// The brief is judged wherever it lives: a FILE while it is still being drafted
// (`--file`, or a positional), or the NEWEST comment on an issue (`--issue N`,
// read through gh) once it has been posted — which is the form it really arrives
// in. Everything downstream of the source is identical, so the two paths differ
// only in where the lines come from and what a finding's `where` is called.

const AI_DISCLAIMER = "> *This was generated by AI during triage.*";
const BRIEF_HEADING = "Agent Brief";

// The labeled fields agent-brief.md's template prescribes, in its order. Each is
// matched by NAME, never by position: a brief that adds a field is fine, one that
// drops a field is a hole the worker has to guess its way out of.
const BRIEF_FIELDS: readonly string[] = [
  "Category",
  "Summary",
  "Current behavior",
  "Desired behavior",
  "Key interfaces",
  "Acceptance criteria",
  "Out of scope",
];
const CATEGORY_FIELD = "Category";
const SUMMARY_FIELD = "Summary";
const ACCEPTANCE_FIELD = "Acceptance criteria";
const SCOPE_FIELD = "Out of scope";

// The two shapes `/dobby:scope` reads a brief as; anything else ("chore",
// "refactor") is a category the downstream flow has no framing for.
const BRIEF_CATEGORIES: readonly string[] = ["bug", "enhancement"];
const MIN_ACCEPTANCE_CRITERIA = 2;

// The procedural headings the reference's "bad brief" is built from — a brief
// says WHAT the system should do, never WHICH files to open.
const BANNED_BRIEF_FIELDS: readonly string[] = [
  "Files to change",
  "What to do",
];

// A `**Label:**` line, with whatever the label carries INLINE (`**Category:**
// bug`). Anchored at `**` with no list marker allowed: a bullet that merely
// bolds a term (`- **TypeName** — what changes`) is body text, not a new field,
// and reading it as one would truncate the field it sits under.
const BRIEF_LABEL_LINE = /^\s*\*\*([^*]+?)\*\*:?\s*(.*)$/;
const BRIEF_MARKDOWN_HEADING = /^\s*#{1,6}\s+(.*)$/;
const BRIEF_CHECKBOX = /^\s*[-*+]\s*\[[ xX]?\]\s*(.*)$/;
// The empty criterion the reference names outright ("Bad: It should work
// correctly") — a criterion nobody can decide from is not an acceptance criterion.
const VACUOUS_CRITERION = /it should work|works correctly|no regressions/i;

// A path-like token ending in a CODE-FILE extension — the reference's "don't
// reference file paths" made mechanical. Extension-gated on purpose: prose is
// full of sentence-final periods and hyphenated words, and only a real extension
// separates `mid-word.` from `src/skills/frontmatter.ts`.
const BRIEF_FILE_PATH =
  /(?<![\w/@.-])(?:[\w@.-]+\/)*[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|jsonc|md|mdx|yml|yaml|toml|css|scss|html|sh|bash|py|rb|go|rs|java|kt|swift|sql|php|vue|svelte|astro|graphql|prisma|env|txt|ini|cfg|conf|lock)\b/g;
// The two manifests every repo keeps at a FIXED name: "the tracker key in
// dobby.config.json" names a CONTRACT, not a location, and cannot go stale the
// way `src/skills/frontmatter.ts` does.
const BRIEF_PATH_ALLOWLIST: ReadonlySet<string> = new Set([
  "dobby.config.json",
  "package.json",
]);
// The two spellings of a line reference: the prose form and the `file.ts:150`
// form. Both point at a line that will have moved by the time anyone reads this.
const BRIEF_LINE_PROSE = /\bline\s+\d+/i;
const BRIEF_LINE_SUFFIX = /[\w@.-]+\.[A-Za-z]\w*:\d+/;

// gh's own page size for the comment read (the same one `review` uses).
const BRIEF_PER_PAGE = 100;

// One `**Label:**` field of the brief: where the label sits, what it carries
// inline, and the body range under it (up to the next label, heading, or EOF).
interface BriefField {
  end: number;
  line: number;
  name: string;
  start: number;
  value: string;
}

// The brief under judgment, however it was fetched: its lines, and the name every
// finding's `where` is built from (a path for a file, `issue #N` for a comment).
interface BriefSource {
  label: string;
  lines: string[];
}

function runBriefLint(context: CommandContext): CommandResult {
  const source = resolveBrief(context);
  if ("error" in source) {
    return fail(context, source.error);
  }
  return report(context, lintBriefDocument(source.lines, source.label));
}

// Where the brief comes from: the issue's newest comment when `--issue` names
// one, else the file. A source that cannot be READ is a refusal, never a
// finding — "gh could not fetch this" must never render as "the brief is clean".
function resolveBrief(
  context: CommandContext
): BriefSource | { error: string } {
  const { issue } = context.options;
  if (typeof issue === "string") {
    return readIssueBrief(context, issue);
  }
  const path = targetPath(context, 1);
  if (path === undefined) {
    return {
      error:
        "brief lint requires the brief — `dobby brief lint --file <file>` (a draft on disk) or `dobby brief lint --issue <number>` (the one posted on the tracker)",
    };
  }
  if (!existsSync(path)) {
    return { error: `brief lint: ${path} not found` };
  }
  return {
    label: display(workroot(context), path),
    lines: readLines(path),
  };
}

// The NEWEST comment on the issue — the brief as `/dobby:triage` really posts it,
// and re-posted whenever it is revised, so the last comment is the live one. The
// selection happens HERE rather than in a `--jq` filter: the whole payload is
// small, and a jq expression in the argv would make "which comment" invisible to
// everything that reads this command's behavior.
function readIssueBrief(
  context: CommandContext,
  issue: string
): BriefSource | { error: string } {
  const number = Number.parseInt(issue, 10);
  if (!Number.isInteger(number) || number <= 0) {
    return {
      error: `brief lint: --issue takes an issue NUMBER, not \`${issue}\``,
    };
  }
  const path = `repos/{owner}/{repo}/issues/${number}/comments?per_page=${BRIEF_PER_PAGE}`;
  const result = runCapture("gh", ["api", "--paginate", "--slurp", path], {
    root: workroot(context),
  });
  if (result.error !== undefined || result.status !== 0) {
    return { error: `brief lint: gh api ${path} — ${ghFailure(result)}` };
  }
  const newest = commentBodies(result.stdout).at(-1);
  if (newest === undefined) {
    return {
      error: `brief lint: issue #${number} carries no comments — the agent brief is POSTED as a comment, so there is nothing to judge yet`,
    };
  }
  return {
    label: `issue #${number} (newest comment)`,
    lines: newest.replace(CRLF, "\n").split("\n"),
  };
}

// gh's own words when it has them (its stderr is written for humans), else the
// spawn error, else the bare exit status — a refusal is never anonymous.
function ghFailure(result: {
  error?: Error;
  status: number | null;
  stderr: string;
}): string {
  const stderr = result.stderr.trim();
  if (stderr !== "") {
    return stderr;
  }
  if (result.error !== undefined) {
    return result.error.message;
  }
  return `gh exited ${String(result.status)}`;
}

// Every comment body in a `gh api --paginate --slurp` answer, in API order
// (oldest first). `--slurp` wraps each PAGE's array, so the payload is an array
// of arrays; a single flat page array flattens to itself, which keeps the reader
// honest whichever framing gh used. Unparseable output yields NO bodies, which
// the caller reports as "nothing to judge" rather than a clean verdict.
function commentBodies(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const pages: unknown[] = Array.isArray(parsed) ? parsed : [];
  const bodies: string[] = [];
  for (const node of pages.flat()) {
    // A defensive shape read: this is a network payload, so a null entry (or a
    // scalar where an object was expected) must come back as "no body", never a
    // property access on null.
    const body =
      typeof node === "object" && node !== null
        ? (node as { body?: unknown }).body
        : undefined;
    if (typeof body === "string") {
      bodies.push(body);
    }
  }
  return bodies;
}

function lintBriefDocument(lines: string[], path: string): Finding[] {
  const fields = briefFields(lines);
  return [
    ...lintBriefDisclaimer(lines, path),
    ...lintBriefHeading(lines, path),
    ...lintBriefFields(fields, path),
    ...lintBriefCategory(fields, path),
    ...lintBriefSummary(lines, fields, path),
    ...lintBriefCriteria(lines, fields, path),
    ...lintBriefScope(lines, fields, path),
    ...lintBriefProcedural(lines, fields, path),
    ...lintBriefDurability(lines, path),
  ];
}

// The `**Label:**` fields with their body ranges. A field's body ends at the next
// label OR at a `## ` heading — a brief pasted under a second heading must not
// swallow it.
function briefFields(lines: string[]): BriefField[] {
  const fields: BriefField[] = [];
  const close = (index: number): void => {
    const previous = fields.at(-1);
    if (previous !== undefined && previous.end > index) {
      previous.end = index;
    }
  };
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("## ")) {
      close(index);
      continue;
    }
    const match = BRIEF_LABEL_LINE.exec(line);
    if (match === null) {
      continue;
    }
    close(index);
    fields.push({
      end: lines.length,
      line: index,
      name: (match[1] ?? "").replace(TRAILING_MARK, "").trim(),
      start: index + 1,
      value: fieldValue(match[2] ?? ""),
    });
  }
  return fields;
}

function briefField(
  fields: BriefField[],
  name: string
): BriefField | undefined {
  const wanted = normalize(name);
  return fields.find((field) => normalize(field.name) === wanted);
}

// The disclaimer is the FIRST line because the brief is posted as a tracker
// comment: a human scrolling the issue must see that a model wrote it before
// reading a word of it.
function lintBriefDisclaimer(lines: string[], path: string): Finding[] {
  const index = lines.findIndex((line) => line.trim() !== "");
  if (index >= 0 && (lines[index] ?? "").trim() === AI_DISCLAIMER) {
    return [];
  }
  return [
    finding(
      "brief-disclaimer",
      index < 0 ? path : at(path, index),
      `the brief does not open with the AI disclaimer \`${AI_DISCLAIMER}\` — it is posted as a tracker comment, so it says up front that a model generated it`
    ),
  ];
}

function lintBriefHeading(lines: string[], path: string): Finding[] {
  const wanted = normalize(BRIEF_HEADING);
  const found = topLevelHeadings(lines).some(
    (index) => normalize((lines[index] ?? "").slice(3)) === wanted
  );
  return found
    ? []
    : [
        finding(
          "brief-structure",
          path,
          `no \`## ${BRIEF_HEADING}\` heading — the brief is one titled block inside a comment that may also carry ordinary discussion`
        ),
      ];
}

function lintBriefFields(fields: BriefField[], path: string): Finding[] {
  return BRIEF_FIELDS.filter(
    (name) => briefField(fields, name) === undefined
  ).map((name) =>
    finding(
      "brief-sections",
      path,
      `missing required section: \`**${name}:**\` — the worker builds from this brief alone, so a dropped field is a hole it has to guess its way out of`
    )
  );
}

function lintBriefCategory(fields: BriefField[], path: string): Finding[] {
  const field = briefField(fields, CATEGORY_FIELD);
  if (field === undefined) {
    // Already reported by the field inventory.
    return [];
  }
  const value = field.value.toLowerCase();
  if (BRIEF_CATEGORIES.includes(value)) {
    return [];
  }
  return [
    finding(
      "brief-category",
      at(path, field.line),
      `\`${CATEGORY_FIELD}\` is \`${field.value}\` — a brief is one of: ${BRIEF_CATEGORIES.join(", ")} (the two framings \`/dobby:scope\` reads a goal as)`
    ),
  ];
}

// The summary is ONE line on its own label line: it is what a human scanning the
// tracker reads, and a paragraph there is a second "Current behavior".
function lintBriefSummary(
  lines: string[],
  fields: BriefField[],
  path: string
): Finding[] {
  const field = briefField(fields, SUMMARY_FIELD);
  if (field === undefined) {
    return [];
  }
  if (field.value === "") {
    return [
      finding(
        "brief-summary",
        at(path, field.line),
        `\`**${SUMMARY_FIELD}:**\` carries no line — one sentence saying what needs to happen, on the label's own line`
      ),
    ];
  }
  const body = sectionBody(lines, field);
  if (body.length === 0) {
    return [];
  }
  return [
    finding(
      "brief-summary",
      at(path, body[0] ?? field.line),
      `\`**${SUMMARY_FIELD}:**\` runs past one line — it is the single line the tracker shows; the detail belongs under \`**Current behavior:**\``
    ),
  ];
}

// The criteria are how the worker knows it is DONE. Two is the floor (one
// criterion is a restated summary), and a criterion nobody can decide from is not
// a criterion at all — the reference names the exact wording that fails.
function lintBriefCriteria(
  lines: string[],
  fields: BriefField[],
  path: string
): Finding[] {
  const field = briefField(fields, ACCEPTANCE_FIELD);
  if (field === undefined) {
    return [];
  }
  const boxes: { index: number; text: string }[] = [];
  for (const index of sectionBody(lines, field)) {
    const match = BRIEF_CHECKBOX.exec(lines[index] ?? "");
    if (match !== null) {
      boxes.push({ index, text: (match[1] ?? "").trim() });
    }
  }
  const findings: Finding[] = [];
  if (boxes.length < MIN_ACCEPTANCE_CRITERIA) {
    findings.push(
      finding(
        "brief-acceptance",
        at(path, field.line),
        `\`**${ACCEPTANCE_FIELD}:**\` carries ${boxes.length} \`- [ ]\` criteri${boxes.length === 1 ? "on" : "a"} — a brief needs at least ${MIN_ACCEPTANCE_CRITERIA} concrete, independently verifiable ones, or the worker cannot tell when it is done`
      )
    );
  }
  for (const box of boxes.filter((entry) =>
    VACUOUS_CRITERION.test(entry.text)
  )) {
    findings.push(
      finding(
        "brief-acceptance",
        at(path, box.index),
        `vacuous acceptance criterion \`${box.text}\` — name the observable behavior that must hold ("listing items filtered to pending returns only classified ones"), not that it works`
      )
    );
  }
  return findings;
}

// The scope boundary is what stops the worker gold-plating: an empty `Out of
// scope` says "everything adjacent is fair game", which is never the intent.
function lintBriefScope(
  lines: string[],
  fields: BriefField[],
  path: string
): Finding[] {
  const field = briefField(fields, SCOPE_FIELD);
  if (field === undefined) {
    return [];
  }
  const bullets = sectionBody(lines, field).filter((index) =>
    LIST_MARKER.test(lines[index] ?? "")
  );
  if (bullets.length > 0) {
    return [];
  }
  return [
    finding(
      "brief-scope",
      at(path, field.line),
      `\`**${SCOPE_FIELD}:**\` names no boundary — state at least one thing the worker must NOT change, or every adjacent feature reads as fair game`
    ),
  ];
}

// The banned headings are caught in BOTH spellings a brief writes a section in —
// a `**Label:**` field and a markdown heading — because the defect is the section
// EXISTING, not how it was decorated.
function lintBriefProcedural(
  lines: string[],
  fields: BriefField[],
  path: string
): Finding[] {
  const banned = BANNED_BRIEF_FIELDS.map((name) => normalize(name));
  const sections = [
    ...fields.map((field) => ({ line: field.line, name: field.name })),
    ...lines.flatMap((line, index) => {
      const match = BRIEF_MARKDOWN_HEADING.exec(line);
      return match === null
        ? []
        : [{ line: index, name: (match[1] ?? "").trim() }];
    }),
  ];
  return sections
    .filter((section) => banned.includes(normalize(section.name)))
    .map((section) =>
      finding(
        "brief-procedural",
        at(path, section.line),
        `\`${section.name}\` is a procedural heading — a brief is BEHAVIORAL: it states what the system should do, and the worker explores the codebase fresh and decides how (a list of files is stale before anyone reads it)`
      )
    );
}

// The two references that go stale: a file path and a line number. Both are cheap
// to write and wrong within a week, which is exactly why a generator reaches for
// them — and why the brief must name the interface instead.
function lintBriefDurability(lines: string[], path: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of lines.entries()) {
    findings.push(...lintBriefPaths(line, index, path));
    if (BRIEF_LINE_PROSE.test(line) || BRIEF_LINE_SUFFIX.test(line)) {
      findings.push(
        finding(
          "brief-line-reference",
          at(path, index),
          "references a line number — the brief may sit for weeks while the code moves; describe the behavior or the interface, never a location"
        )
      );
    }
  }
  return findings;
}

function lintBriefPaths(line: string, index: number, path: string): Finding[] {
  const findings: Finding[] = [];
  for (const match of line.matchAll(BRIEF_FILE_PATH)) {
    const [token] = match;
    if (BRIEF_PATH_ALLOWLIST.has(token.split("/").at(-1) ?? "")) {
      continue;
    }
    findings.push(
      finding(
        "brief-file-path",
        at(path, index),
        `references the file path \`${token}\` — paths go stale as the codebase is renamed and refactored; name the type, the signature or the contract the worker should look for instead`
      )
    );
  }
  return findings;
}
