import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandContext, CommandResult } from "./command.ts";
import { detectCapabilities } from "./detect.ts";
import { requireWorkroot } from "./runner.ts";
import { readSection } from "./state.ts";

// `dobby build-plan` — the build-workflow plan, derived MECHANICALLY from the
// spec's task table. It exists because the coordinator used to READ that table by
// eye and then invent, per session, the four things below — a judgment call over
// a grid, made once per plan, with no way to check the answer:
//
//   - `tasks[]` — the workflow `args` VERBATIM (`{id, title, spec, decisions,
//     constraints, areas[], verifyRecipe, testFirst}` + `destructive`), the exact
//     shape `plugin/skills/execute/references/build-workflow.md` consumes. The
//     coordinator merges `devUrl` itself (research R4), so it is NOT emitted here.
//   - `waves[][]` — the parallel batches: topological over `Depends on`, and
//     within one batch no two tasks share an Affected area. Readiness is REFILLED
//     each round (a task deferred by an area clash rejoins the next wave next to
//     the newly unblocked ones) rather than frozen into fixed topological levels,
//     which is what keeps a clash from serializing the whole tail of a plan. A
//     DESTRUCTIVE task gets a wave to itself (spec Decision 15).
//   - `preconditions` — the refusal verdict: empty required cells, dependencies
//     on tasks the table does not contain, and dependency cycles. Not ok → exit 1,
//     WITH the payload still on stdout (the `up --json` convention: the verdict
//     fields exist to tell the caller what to fix).
//   - the two gates `/dobby:execute` reads before launching: `hasTestSuite`
//     (the repo's `vitest` CAPABILITY, plus what the spec's Testing Decisions
//     CLAIM and whether the two disagree) and `manualVerifySetup` (the developer
//     steps the pre-verification gate waits on, or `none`).
//
// Two sources, one payload shape:
//   - DEFAULT — `<workroot>/STATE.md`'s `## Spec` (read through `state.readSection`,
//     so the section rules stay owned by the engine that WRITES the document),
//     `--file <path>` to point at another document.
//   - `--task <path>` — ONE ad-hoc task as JSON, the `/dobby:dispatch` path: no
//     STATE.md is read at all. (The spec called this flag `--task-file`; the
//     dispatcher's `parseArgs` has no such option and `run.ts` is off-limits to
//     this task, so the allowlisted `--task` carries it and `--file` keeps the
//     document override.)
//
// PARSING IS TOLERANT BY CONTRACT: the `### `-sub-heading spec format is new, so a
// table is found by its HEADER ROW (never by a `### Tasks` anchor), the
// `Description`, `Test-first` and `Destructive` columns are each optional (absent
// → the title stands in as the spec, and the two flags are false), and a
// non-task table inside the spec (an edge-case grid) is skipped.
//
// node:* only (ADR-0008): vitest imports this under Node.

// The document `build-plan` reads by default, at the workroot.
const STATE_FILE = "STATE.md";

// The section of that document carrying the plan (the engine's canonical name).
const SPEC_SECTION = "Spec";

// The capability that answers "can this repo run tests at all" — the repo-level
// fact the build workflow gates its test-author step on.
const SUITE_CAPABILITY = "vitest";

// The value `manualVerifySetup` carries when the spec records no manual
// prerequisite (explicitly, or by never stating one).
const NONE = "none";

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

// ONE task as the build workflow consumes it. `decisions`/`constraints` are
// deliberately EMPTY: plan-level decisions are distributed per task by the
// coordinator's judgment (research R4), never guessed from a table cell.
interface PlanTask {
  areas: string[];
  constraints: string;
  decisions: string;
  destructive: boolean;
  id: string;
  spec: string;
  testFirst: boolean;
  title: string;
  verifyRecipe: string;
}

// A task PLUS the dependency ids that order it. `deps` never reaches the payload
// — the workflow schedules from `waves`, not from per-task edges.
interface PlannedTask {
  deps: string[];
  task: PlanTask;
}

// A required cell the spec left empty, named per task so the fix is mechanical.
interface MissingField {
  field: string;
  taskId: string;
}

// A dependency on an id the table does not contain.
interface DanglingDep {
  dependsOn: string;
  taskId: string;
}

interface Preconditions {
  cycles: string[][];
  danglingDeps: DanglingDep[];
  missing: MissingField[];
  ok: boolean;
}

// The suite gate: what the REPO can do (`value`, the vitest capability), what the
// SPEC claims (`specSays`, null when it never says), and whether they conflict —
// a spec planning test-first tasks in a repo with no runnable suite is a planning
// error the coordinator must see, not silently drop.
interface SuiteVerdict {
  disagreement: boolean;
  specSays: boolean | null;
  value: boolean;
}

interface BuildPlan {
  hasTestSuite: SuiteVerdict;
  manualVerifySetup: string[] | typeof NONE;
  preconditions: Preconditions;
  tasks: PlanTask[];
  waves: string[][];
  workRoot: string;
}

// What the spec's Testing Decisions contribute, independent of the tasks.
interface SpecGates {
  manualVerifySetup: string[] | typeof NONE;
  specSays: boolean | null;
}

// The resolved source: the tasks to plan plus the gates, or the reason there are
// none (a missing document, an unparseable ad-hoc file, a spec with no table).
type PlanSource =
  | { error: string; ok: false }
  | { gates: SpecGates; ok: true; planned: PlannedTask[] };

export function runBuildPlan(context: CommandContext): CommandResult {
  // An ACTION command: outside a git repo it fails hard rather than planning
  // against an ambient cwd. `requireWorkroot` THROWS and run()'s dispatch has no
  // try/catch, so the throw is folded into the failure shape here.
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (failure) {
    return { error: messageOf(failure), exitCode: 1 };
  }
  const source = readSource(context, root);
  if (!source.ok) {
    return { error: source.error, exitCode: 1 };
  }
  const plan = assemble(root, source.planned, source.gates);
  const { ok } = plan.preconditions;
  // A refusal still ANSWERS: exit 1 carries the message on stderr AND the whole
  // payload on stdout, because `missing`/`danglingDeps`/`cycles` are the fix list.
  const error = ok ? undefined : refusalMessage(plan.preconditions);
  const exitCode = ok ? 0 : 1;
  if (context.options.json === true) {
    return { error, exitCode, json: plan };
  }
  return { error, exitCode, text: renderPlan(plan) };
}

// The payload, from the parsed tasks + the repo's own facts.
function assemble(
  root: string,
  planned: PlannedTask[],
  gates: SpecGates
): BuildPlan {
  const value = detectCapabilities(root).includes(SUITE_CAPABILITY);
  const { specSays } = gates;
  return {
    hasTestSuite: {
      disagreement: specSays !== null && specSays !== value,
      specSays,
      value,
    },
    manualVerifySetup: gates.manualVerifySetup,
    preconditions: judge(planned),
    tasks: planned.map((entry) => entry.task),
    waves: schedule(planned),
    workRoot: root,
  };
}

// ---------------------------------------------------------------------------
// Sources — the spec document, or one ad-hoc task
// ---------------------------------------------------------------------------

function readSource(context: CommandContext, root: string): PlanSource {
  const adhoc = stringOption(context, "task");
  if (adhoc !== undefined) {
    return readAdhoc(resolve(context.cwd, adhoc));
  }
  const file = stringOption(context, "file");
  const path =
    file === undefined ? join(root, STATE_FILE) : resolve(context.cwd, file);
  return readSpecDocument(path);
}

// The DEFAULT source: the `## Spec` body of the work-session document. Every
// refusal names the path AND the repair, because a skill hits this with no
// context of its own.
function readSpecDocument(path: string): PlanSource {
  if (!existsSync(path)) {
    return {
      error: `${STATE_FILE} not found at ${path} — run \`dobby state init\` first, or point --file at the spec document`,
      ok: false,
    };
  }
  const spec = readSection(readFileSync(path, "utf8"), SPEC_SECTION);
  if (spec === null) {
    return {
      error: `${path} has no \`## ${SPEC_SECTION}\` section — run \`dobby state lint\` and repair the document first`,
      ok: false,
    };
  }
  const planned = parseTaskTable(spec);
  if (planned.length === 0) {
    return {
      error: `no task table in \`## ${SPEC_SECTION}\` of ${path} — the plan needs a markdown table whose header carries \`Task\` plus \`Depends on\` / \`Affected areas\` / \`Verify recipe\``,
      ok: false,
    };
  }
  return { gates: readGates(spec), ok: true, planned };
}

// The `/dobby:dispatch` source: ONE ad-hoc task as JSON — a dispatch is one task
// by definition, so a list is REFUSED rather than half-supported. NOTHING is read
// from STATE.md, so the gates are the repo's alone: the spec claims nothing and
// there is no manual setup to wait on.
function readAdhoc(path: string): PlanSource {
  if (!existsSync(path)) {
    return { error: `--task not found: ${path}`, ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      error: `--task is not valid JSON: ${path} — ${messageOf(error)}`,
      ok: false,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      error: `--task must hold ONE task object: ${path} — \`{"id","title","spec","areas","verifyRecipe"}\``,
      ok: false,
    };
  }
  return {
    gates: { manualVerifySetup: NONE, specSays: null },
    ok: true,
    planned: [adhocTask(parsed as Record<string, unknown>)],
  };
}

// One ad-hoc task, normalized to the SAME shape a table row produces — the
// dispatch path and the plan path must be indistinguishable downstream. Unlike a
// table row, `decisions`/`constraints` are PASSED THROUGH when the file carries
// them: there is no plan for the coordinator to distribute from, so the file is
// the only place they could come from. Being the only task, it takes id `1` when
// the file names none.
function adhocTask(raw: Record<string, unknown>): PlannedTask {
  const id = stringOf(raw.id);
  const title = stringOf(raw.title);
  const spec = stringOf(raw.spec);
  return {
    deps: listOf(raw.dependsOn ?? raw.deps),
    task: {
      areas: listOf(raw.areas),
      constraints: stringOf(raw.constraints),
      decisions: stringOf(raw.decisions),
      destructive: raw.destructive === true,
      id: id === "" ? "1" : id,
      spec: spec === "" ? title : spec,
      testFirst: raw.testFirst === true,
      title,
      verifyRecipe: stringOf(raw.verifyRecipe),
    },
  };
}

// ---------------------------------------------------------------------------
// The task table
// ---------------------------------------------------------------------------

// The columns this parser understands. Everything except `title` is optional:
// `id` (the row's position stands in), `description` (the title stands in),
// `deps`/`areas`/`verifyRecipe` (an absent column reads as an empty cell, which
// the preconditions then report), `testFirst`/`destructive` (absent → false).
type ColumnKey =
  | "areas"
  | "deps"
  | "description"
  | "destructive"
  | "id"
  | "testFirst"
  | "title"
  | "verifyRecipe";

type ColumnMap = Partial<Record<ColumnKey, number>>;

// The header spellings each column answers to. Tolerant on purpose: specs are
// hand-written markdown, and a plan must not go unplanned over `Areas` vs
// `Affected areas`.
function columnKey(header: string): ColumnKey | null {
  switch (header) {
    case "#":
    case "id":
    case "no":
    case "no.":
      return "id";
    case "task":
    case "title":
      return "title";
    case "description":
    case "desc":
      return "description";
    case "depends on":
    case "depends":
    case "dependencies":
    case "deps":
      return "deps";
    case "affected areas":
    case "affected area":
    case "areas":
      return "areas";
    case "test-first":
    case "test first":
    case "testfirst":
      return "testFirst";
    case "destructive":
      return "destructive";
    case "verify recipe":
    case "verification recipe":
    case "verify":
      return "verifyRecipe";
    default:
      return null;
  }
}

// The FIRST table in the spec whose header row reads as a task table. Anchored on
// the HEADER, never on a `### Tasks` heading: the sub-heading format is new, and a
// spec written before it (plain prose + a `Tasks:` lead-in) must still plan. A
// non-task table in the spec (an edge-case grid) simply fails the header test.
function parseTaskTable(spec: string): PlannedTask[] {
  const lines = spec.split("\n");
  for (const [index, line] of lines.entries()) {
    const cells = tableRow(line);
    if (cells === null || !isTaskHeader(cells)) {
      continue;
    }
    return readRows(lines, index + 1, columnIndex(cells));
  }
  return [];
}

// A task-table header: it names the TASK column plus at least one of the columns
// that only a task table has. Both halves are load-bearing — `Task` alone would
// match a "Task | Owner" status grid, and the dependency/area/recipe columns
// alone would match a table that is not per-task at all.
function isTaskHeader(cells: string[]): boolean {
  const keys = new Set(cells.map((cell) => columnKey(normalizeHeader(cell))));
  return (
    keys.has("title") &&
    (keys.has("deps") || keys.has("areas") || keys.has("verifyRecipe"))
  );
}

// Header cell → column position, first spelling wins.
function columnIndex(cells: string[]): ColumnMap {
  const index: ColumnMap = {};
  for (const [position, cell] of cells.entries()) {
    const key = columnKey(normalizeHeader(cell));
    if (key !== null && index[key] === undefined) {
      index[key] = position;
    }
  }
  return index;
}

// Every data row under the header, in TABLE order, stopping at the first line
// that is not a table row (the alignment row is skipped, not planned).
function readRows(
  lines: string[],
  from: number,
  index: ColumnMap
): PlannedTask[] {
  const planned: PlannedTask[] = [];
  for (let at = from; at < lines.length; at += 1) {
    const cells = tableRow(lines[at] ?? "");
    if (cells === null) {
      break;
    }
    if (isAlignmentRow(cells)) {
      continue;
    }
    planned.push(rowTask(cells, index, planned.length + 1));
  }
  return planned;
}

// One row as a task. Cells are carried VERBATIM (a title, a description and a
// verify recipe are prose the agents read); only the list and flag cells are
// interpreted. `position` is the 1-based row number, used as the id when the
// table has no `#` column.
function rowTask(
  cells: string[],
  index: ColumnMap,
  position: number
): PlannedTask {
  const cell = (key: ColumnKey): string => {
    const at = index[key];
    return at === undefined ? "" : (cells[at] ?? "");
  };
  const id = stripEmphasis(cell("id"));
  const title = cell("title");
  const description = cell("description");
  return {
    deps: splitList(cell("deps")),
    task: {
      areas: splitList(cell("areas")),
      constraints: "",
      decisions: "",
      destructive: isAffirmative(cell("destructive")),
      id: id === "" ? String(position) : id,
      spec: description === "" ? title : description,
      testFirst: isAffirmative(cell("testFirst")),
      title,
      verifyRecipe: cell("verifyRecipe"),
    },
  };
}

// A markdown table row as its trimmed cells, or null when the line is not one.
// The leading `|` produces an empty cell before the first real one (and a
// trailing `|` one after the last); both phantoms are dropped, while an EMPTY
// CELL WRITTEN BY THE AUTHOR survives — that emptiness is exactly what the
// preconditions report.
function tableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }
  const cells = splitCells(trimmed);
  cells.shift();
  if (trimmed.endsWith("|") && cells.at(-1) === "") {
    cells.pop();
  }
  return cells;
}

// Split a row on its UNESCAPED pipes (`\|` is a literal pipe inside a cell, which
// a verify recipe holding a shell pipeline really does use).
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === "\\" && row[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

// The `|---|:--:|` row under a header: every cell is dashes (optionally anchored).
function isAlignmentRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => ALIGNMENT_CELL.test(cell));
}

// ---------------------------------------------------------------------------
// The gates the execute skill reads (Testing Decisions)
// ---------------------------------------------------------------------------

function readGates(spec: string): SpecGates {
  const region = testingDecisions(spec);
  return {
    // The manual-setup field is searched in the WHOLE spec when there is no
    // Testing Decisions section to scope it to: a false `none` sends a verifier
    // into an auth wall, so a sub-headingless spec that states the steps anyway
    // must still be heard.
    manualVerifySetup: manualVerifySetup(region ?? spec),
    // The suite CLAIM, on the other hand, is only ever read from the section that
    // owns it — absent section, no claim (null), and therefore no disagreement.
    specSays: region === null ? null : mentionsTestFirst(region),
  };
}

// The Testing Decisions region: everything under the heading that names it, up to
// the next heading of the same or a higher level. Null when the spec has none.
function testingDecisions(spec: string): string | null {
  const lines = spec.split("\n");
  for (const [index, line] of lines.entries()) {
    const heading = HEADING_LINE.exec(line);
    if (heading === null) {
      continue;
    }
    if (!normalizeHeader(heading[2] ?? "").includes("testing decisions")) {
      continue;
    }
    return regionUnder(lines.slice(index + 1), (heading[1] ?? "").length);
  }
  return null;
}

// The lines up to the next heading at `level` or shallower.
function regionUnder(rest: string[], level: number): string {
  const end = rest.findIndex((line) => {
    const heading = HEADING_LINE.exec(line);
    return heading !== null && (heading[1] ?? "").length <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// Whether the Testing Decisions CLAIM test-first tasks. A plain grep would be
// wrong in the one phrasing that matters — "no task is test-first" CONTAINS
// "test-first" — so the scan is per clause: a clause mentioning test-first counts
// as a claim unless it DENIES one.
function mentionsTestFirst(region: string): boolean {
  for (const clause of region.split(CLAUSE_BREAK)) {
    if (TEST_FIRST.test(clause) && !DENIAL.test(clause)) {
      return true;
    }
  }
  return false;
}

// The `Manual verify setup:` field — the literal line plus the steps under it, or
// `none`. An inline value is honored both ways: `none` is the recorded decision
// that there is no prerequisite, anything else is a single inline step.
function manualVerifySetup(region: string): string[] | typeof NONE {
  const lines = region.split("\n");
  const at = lines.findIndex((line) => MANUAL_SETUP.test(line));
  if (at === -1) {
    return NONE;
  }
  // A BOLD field name closes AFTER the colon (`**Manual verify setup:** none`),
  // which leaves its closing marker at the head of the captured value; that
  // orphan is dropped, so the value reads the same however the label was
  // emphasized. Without this the execute gate would wait on a fabricated step
  // (`** none`) instead of skipping silently.
  const inline = stripOrphanEmphasis(
    (MANUAL_SETUP.exec(lines[at] ?? "")?.[1] ?? "").trim()
  );
  // Only an EXPLICIT `none` (or a dash) settles it here. An EMPTY inline value is
  // the normal shape of the field when the steps follow on the next lines, so it
  // must fall through to them rather than read as "no prerequisite".
  if (inline !== "" && isNoneValue(inline)) {
    return NONE;
  }
  const steps = collectSteps(lines, at + 1);
  if (steps.length > 0) {
    return steps;
  }
  return inline === "" ? NONE : [inline];
}

// The list items directly under the field, stopping at the first content line
// that is not one (blank lines inside a loose list are skipped, not a terminator).
function collectSteps(lines: string[], from: number): string[] {
  const steps: string[] = [];
  for (let at = from; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      continue;
    }
    const step = SETUP_STEP.exec(line);
    if (step === null) {
      break;
    }
    steps.push((step[1] ?? "").trim());
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Waves — topological order, refilled each round, area-disjoint within a wave
// ---------------------------------------------------------------------------

// The batches, in execution order. Each round takes the tasks whose dependencies
// have all RUN (readiness is recomputed, never frozen into levels) and fills one
// wave from them; a task left out by an area clash is simply still ready next
// round, alongside whatever the finished wave unblocked. A wave is never empty
// while a ready task exists, so the loop always terminates: it stops either with
// everything scheduled or with an unschedulable remainder (a cycle or a dangling
// dependency) that `preconditions` names.
function schedule(planned: PlannedTask[]): string[][] {
  const remaining = [...planned];
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((entry) =>
      entry.deps.every((dep) => done.has(dep))
    );
    if (ready.length === 0) {
      break;
    }
    const wave = nextWave(ready);
    for (const entry of wave) {
      done.add(entry.task.id);
      remaining.splice(remaining.indexOf(entry), 1);
    }
    waves.push(wave.map((entry) => entry.task.id));
  }
  return waves;
}

// One wave out of the ready set, in table order: a task joins unless it touches an
// area a task already in the wave touches. A DESTRUCTIVE task takes the wave
// ALONE — it mutates shared state, so nothing may verify against that state
// concurrently (spec Decision 15).
function nextWave(ready: PlannedTask[]): PlannedTask[] {
  const wave: PlannedTask[] = [];
  const claimed = new Set<string>();
  for (const entry of ready) {
    if (entry.task.destructive) {
      if (wave.length === 0) {
        return [entry];
      }
      continue;
    }
    const areas = entry.task.areas.map((area) => area.toLowerCase());
    if (areas.some((area) => claimed.has(area))) {
      continue;
    }
    wave.push(entry);
    for (const area of areas) {
      claimed.add(area);
    }
  }
  return wave;
}

// ---------------------------------------------------------------------------
// Preconditions — what makes a spec unplannable
// ---------------------------------------------------------------------------

function judge(planned: PlannedTask[]): Preconditions {
  const ids = new Set(planned.map((entry) => entry.task.id));
  const missing = missingFields(planned);
  const danglingDeps = danglingDependencies(planned, ids);
  const cycles = findCycles(planned, ids);
  return {
    cycles,
    danglingDeps,
    missing,
    ok:
      missing.length === 0 && danglingDeps.length === 0 && cycles.length === 0,
  };
}

// The three cells a task cannot execute without: WHAT to build, WHERE it lands
// (the wave grouping is computed from it), and HOW it is verified. A description
// is NOT required — the title stands in for it.
function missingFields(planned: PlannedTask[]): MissingField[] {
  const missing: MissingField[] = [];
  for (const { task } of planned) {
    if (task.title.trim() === "") {
      missing.push({ field: "title", taskId: task.id });
    }
    if (task.areas.length === 0) {
      missing.push({ field: "areas", taskId: task.id });
    }
    if (task.verifyRecipe.trim() === "") {
      missing.push({ field: "verifyRecipe", taskId: task.id });
    }
  }
  return missing;
}

function danglingDependencies(
  planned: PlannedTask[],
  ids: Set<string>
): DanglingDep[] {
  const dangling: DanglingDep[] = [];
  for (const entry of planned) {
    for (const dep of entry.deps) {
      if (!ids.has(dep)) {
        dangling.push({ dependsOn: dep, taskId: entry.task.id });
      }
    }
  }
  return dangling;
}

// Every dependency cycle, as the ids on it. A depth-first walk over the KNOWN
// edges only (a dangling dependency is its own finding, never a phantom cycle);
// each cycle is reported once, keyed by its id set.
function findCycles(planned: PlannedTask[], ids: Set<string>): string[][] {
  const edges = new Map<string, string[]>();
  for (const entry of planned) {
    edges.set(
      entry.task.id,
      entry.deps.filter((dep) => ids.has(dep))
    );
  }
  const cycles = new Map<string, string[]>();
  const settled = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const walk = (id: string): void => {
    if (settled.has(id)) {
      return;
    }
    if (onPath.has(id)) {
      const cycle = path.slice(path.indexOf(id));
      cycles.set([...cycle].sort().join("|"), cycle);
      return;
    }
    onPath.add(id);
    path.push(id);
    for (const dep of edges.get(id) ?? []) {
      walk(dep);
    }
    path.pop();
    onPath.delete(id);
    settled.add(id);
  };

  for (const id of edges.keys()) {
    walk(id);
  }
  return [...cycles.values()];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// The refusal, one clause per finding — the caller has to repair the SPEC, so the
// message names the task and the cell, never just "invalid plan".
function refusalMessage(preconditions: Preconditions): string {
  const parts: string[] = [];
  for (const entry of preconditions.missing) {
    parts.push(`task ${entry.taskId} has no ${entry.field}`);
  }
  for (const entry of preconditions.danglingDeps) {
    parts.push(
      `task ${entry.taskId} depends on ${entry.dependsOn}, which the table does not contain`
    );
  }
  for (const cycle of preconditions.cycles) {
    parts.push(`dependency cycle: ${cycle.join(" → ")}`);
  }
  return `the spec cannot be planned — ${parts.join("; ")}`;
}

// The human form (no `--json`): the plan at a glance. The machine payload is the
// real surface — a skill always passes `--json` — so this stays a summary.
function renderPlan(plan: BuildPlan): string {
  const waves = plan.waves.map(
    (wave, index) => `${index + 1}) ${wave.join(", ")}`
  );
  return [
    `tasks: ${plan.tasks.length}`,
    `waves: ${waves.length === 0 ? NONE : waves.join("  ")}`,
    `hasTestSuite: ${plan.hasTestSuite.value}${suiteNote(plan.hasTestSuite)}`,
    `manualVerifySetup: ${renderSetup(plan.manualVerifySetup)}`,
    `workRoot: ${plan.workRoot}`,
    `preconditions: ${plan.preconditions.ok ? "ok" : refusalMessage(plan.preconditions)}`,
    "",
  ].join("\n");
}

// What the spec claimed, appended only when it claimed anything.
function suiteNote(verdict: SuiteVerdict): string {
  if (verdict.specSays === null) {
    return "";
  }
  const conflict = verdict.disagreement ? " — DISAGREEMENT" : "";
  return ` (spec says: ${verdict.specSays}${conflict})`;
}

function renderSetup(setup: string[] | typeof NONE): string {
  return setup === NONE ? NONE : `\n  ${setup.join("\n  ")}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

// An ATX heading and its level; the alignment row's cells; the manual-setup field
// and one step under it; the clause split and the two test-first probes. Hoisted
// to module scope (the house rule for every regex in `src`).
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const ALIGNMENT_CELL = /^:?-+:?$/;
const MANUAL_SETUP =
  /^\s*(?:[-*]\s+)?\**\s*manual verify setup\s*\**\s*:\s*(.*)$/i;
const SETUP_STEP = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/;
const CLAUSE_BREAK = /[.\n;]/;
const TEST_FIRST = /test-?first/i;
const DENIAL = /\b(?:no|not|none|never|without)\b/i;
const EMPHASIS = /[*`_]/g;
const EDGE_EMPHASIS = /^[*`_]+|[*`_]+$/g;
const ORPHAN_EMPHASIS = /^[*`_]+(?=\s|$)\s*/;
const WHITESPACE = /\s+/g;
const TRAILING_PERIOD = /\.$/;

// The cell values that mean "nothing here": the em/en dash a spec writes for "no
// dependency", a plain hyphen, and the words.
const NO_VALUE: ReadonlySet<string> = new Set(["", "—", "–", "-", "n/a", NONE]);

// The cell values that mean yes, for the `Test-first` / `Destructive` flags.
// Anything else — including an empty or absent cell — is false.
const AFFIRMATIVE: ReadonlySet<string> = new Set([
  "y",
  "yes",
  "true",
  "x",
  "✓",
  "✔",
]);

// A comma-separated cell as its members, with the "nothing here" spellings
// dropped — so `—` yields [] rather than a dependency on a task named "—".
function splitList(cell: string): string[] {
  return cell
    .split(",")
    .map((value) => stripEmphasis(value))
    .filter((value) => !NO_VALUE.has(value.toLowerCase()));
}

function isAffirmative(cell: string): boolean {
  return AFFIRMATIVE.has(stripEmphasis(cell).toLowerCase());
}

function isNoneValue(value: string): boolean {
  return NO_VALUE.has(value.replace(TRAILING_PERIOD, "").trim().toLowerCase());
}

// A header cell, comparable: emphasis stripped, whitespace collapsed, lowercased.
function normalizeHeader(cell: string): string {
  return cell
    .replaceAll(EMPHASIS, "")
    .replaceAll(WHITESPACE, " ")
    .trim()
    .toLowerCase();
}

// Markdown emphasis AROUND a short cell value (an id, a flag, an area) — `**1**`
// and `1` are the same id, and a backticked area is the same area. Only the
// leading/trailing markers go: stripping them everywhere would silently rename
// `user_profile module` (and every other snake_case area) mid-plan. Never applied
// to prose cells, which stay verbatim.
function stripEmphasis(value: string): string {
  return value.trim().replaceAll(EDGE_EMPHASIS, "").trim();
}

// The ORPHANED closing marker a bold field name leaves at the head of its value
// (`**Field:** v` captures `** v`). Only a run followed by whitespace or the end
// of the value is an orphan — emphasis that OPENS the value itself (`**do X**`)
// is attached to a word and stays, as does any trailing marker, which belongs to
// the value (`log in as **owner**`).
function stripOrphanEmphasis(value: string): string {
  return value.replace(ORPHAN_EMPHASIS, "");
}

// A JSON field as text: a string (trimmed) or a number, anything else "".
function stringOf(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

// A JSON field as a list: an array of scalars, or a comma-separated string.
function listOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map((entry) => stringOf(entry))
      .filter((entry) => entry !== "");
  }
  return splitList(stringOf(value));
}

// A string option's value, or undefined when it was not passed.
function stringOption(
  context: CommandContext,
  name: string
): string | undefined {
  const value = context.options[name];
  return typeof value === "string" ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
