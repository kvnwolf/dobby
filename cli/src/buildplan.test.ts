import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// `dobby build-plan` — the spec's task table, projected as the dispatch
// `args` (plus the preconditions verdict and the two gates the execute skill
// reads: `hasTestSuite` and `manualVerifySetup`).
//
// The command does NOT batch the plan. It emits the task list with each task's
// `dependsOn` and `destructive` flag intact, so a task can start the moment its
// OWN dependencies are done — a failed task stops only what genuinely depends
// on it, and the Architect serialises a destructive task himself at dispatch
// time. There is therefore no wave grouping anywhere in the payload.
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008): the domain
// module is never imported directly, so its internals can be restructured
// freely without touching this file.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (all INDEPENDENT of the code):
//  - Every fixture STATE.md below is authored HERE, by hand, and every expected
//    task field is the literal text of a cell in it (titles, descriptions,
//    areas, verify recipes) — never a value recomputed the way the parser
//    computes it.
//  - The payload's key set (`tasks[{id,title,spec,decisions,constraints,areas,
//    verifyRecipe,testFirst,destructive,dependsOn}]`, `preconditions`,
//    `hasTestSuite`, `manualVerifySetup`, `workRoot`) is the literal field list
//    of this task's spec: everything the payload carried keeps its meaning, and
//    only the wave grouping goes.
//  - `dependsOn` is the literal content of a row's `Depends on` cell — the ids
//    exactly as the spec writer typed them, and none at all for `—`/empty. The
//    dispatcher looks a dependency up BY IDENTITY against the emitted task ids
//    (to skip a task whose dependency ended needs-human), so the expected
//    values are those same id STRINGS, never numbers or re-derived keys.
//  - The column layout (`# | Task | Description | Depends on | Affected areas |
//    Test-first | Destructive | Verify recipe`), the `—` "no dependency" cell,
//    and the `Manual verify setup:` field are the kit's own spec-writing
//    conventions (`plugin/skills/spec/references/task-decomposition.md` and
//    `references/testing-decisions.md`).
//  - Every ORDER expectation is the top-to-bottom order of the fixture's own
//    table — a list a reader can verify by eye against the rows above it, not a
//    schedule re-derived from areas or dependencies.
//  - `hasTestSuite.value` follows the `vitest` CAPABILITY, so the fixtures make
//    it a fact of the repo we built: a `vitest` devDependency (present) or none
//    (absent). The spec-vs-capability `disagreement` is then a claim about two
//    inputs we chose to conflict.
//
// NOTHING IS MOCKED. The only boundaries this command touches are the git
// workroot and the filesystem, and both are REAL here (throwaway repos in
// temp dirs). No external API, no clock, no randomness.
// ===========================================================================

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// --- the payload shape (the spec's field list, nothing more) ----------------

interface PlanTask {
  areas: string[];
  constraints: string;
  decisions: string;
  dependsOn: string[];
  destructive: boolean;
  id: string;
  spec: string;
  testFirst: boolean;
  title: string;
  verifyRecipe: string;
}

interface BuildPlan {
  hasTestSuite: {
    disagreement: boolean;
    specSays: boolean | null;
    value: boolean;
  };
  manualVerifySetup: string | string[];
  preconditions: {
    cycles: unknown[];
    danglingDeps: unknown[];
    missing: { field: string; taskId: string }[];
    ok: boolean;
  };
  tasks: PlanTask[];
  workRoot: string;
}

// The payload keys this task's spec fixes, sorted. `waves` — or any other name
// for a batch of tasks — is not among them: the grouping is gone, not renamed.
const PAYLOAD_KEYS = [
  "hasTestSuite",
  "manualVerifySetup",
  "preconditions",
  "tasks",
  "workRoot",
];

// --- fixture builders -------------------------------------------------------

// A canonical work-session doc (the seven `## ` sections `dobby state init`
// writes) carrying the given `## Spec` body. `decoys` plants a task table in
// `## Research` AND in `## Work log` — tables that are NOT this plan's tasks, so
// a reader that scans the whole document instead of the `## Spec` section is
// caught red-handed.
function stateDoc(spec: string, decoys = false): string {
  const research = decoys
    ? `Prior art — the table an EARLIER session shipped (not this plan):

| # | Task | Description | Depends on | Affected areas | Test-first | Destructive | Verify recipe |
|---|------|-------------|------------|----------------|------------|-------------|---------------|
| 8 | Research decoy | From a previous session. | — | research module | yes | no | Never run → never observed |`
    : "six researcher reports";
  const workLog = decoys
    ? `### Task 9 — done (wave 1)

| # | Task | Description | Depends on | Affected areas | Test-first | Destructive | Verify recipe |
|---|------|-------------|------------|----------------|------------|-------------|---------------|
| 9 | Work-log decoy | Already shipped. | — | log module | no | no | Already observed |`
    : "_pending_";
  return `# Work session: build-plan fixture

## Goal
ship the plan emitter

## Source
issue #42

## Exploration
_pending_

## Findings (interview)
_pending_

## Research
${research}

## Spec
${spec}

## Work log
${workLog}
`;
}

// A throwaway repo carrying that doc as its root STATE.md. `suite: true` gives
// the repo a `vitest` devDependency — the detection signal behind the `vitest`
// capability, i.e. the repo-level fact `hasTestSuite.value` reports.
function makePlanRepo(opts: {
  decoys?: boolean;
  files?: Record<string, string>;
  prefix: string;
  spec: string;
  suite?: boolean;
}): string {
  return makeScratchRepo({
    branch: "main",
    config: { files: [] },
    files: {
      "STATE.md": stateDoc(opts.spec, opts.decoys === true),
      ...opts.files,
    },
    pkg: {
      devDependencies:
        opts.suite === true ? { vitest: "^3.0.0" } : { typescript: "^5.9.0" },
      name: "scratch-build-plan",
    },
    prefix: opts.prefix,
    track: scratchDirs,
  });
}

// --- invoking the command ---------------------------------------------------

async function planOutcome(cwd: string, extraArgs: string[] = []) {
  return await run(["build-plan", ...extraArgs, "--json"], cwd);
}

// The plan of a repo whose preconditions HOLD: exit 0, payload on stdout.
async function plan(cwd: string, extraArgs: string[] = []): Promise<BuildPlan> {
  const result = await planOutcome(cwd, extraArgs);
  expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as BuildPlan;
}

// The plan of a repo whose preconditions FAIL: exit 1, and the payload is STILL
// on stdout — the verdict fields (`missing`/`danglingDeps`/`cycles`) exist to be
// read by the caller that has to fix the spec.
async function blockedPlan(cwd: string): Promise<BuildPlan> {
  const result = await planOutcome(cwd);
  expect(result.exitCode).toBe(1);
  // The refusal still ANSWERS: an empty stdout here means the command bailed
  // without telling the caller what to fix.
  expect(result.stdout, `stderr: ${result.stderr}`).not.toBe("");
  return JSON.parse(result.stdout) as BuildPlan;
}

// The ids of every task, in emitted order.
function ids(tasks: PlanTask[]): string[] {
  return tasks.map((task) => task.id);
}

// The first task of a plan. Every fixture below yields at least one, so a plan
// that emitted none fails HERE, naming the reason, instead of somewhere down an
// undefined property.
function firstTask(built: BuildPlan): PlanTask {
  const [task] = built.tasks;
  if (task === undefined) {
    throw new Error("the plan emitted no tasks");
  }
  return task;
}

// ===========================================================================
// Slice 1 (the tracer bullet) — the task table becomes the dispatch args, as a
// FLAT list of tasks that each name what they wait on.
//
// Everything downstream leans on this: the Architect reads `tasks`, starts each
// one the moment its own `dependsOn` are done, and never receives a batch to
// step through. The fixture is the CURRENT spec format — `### ` sub-headings
// inside `## Spec`, the full 8-column table (Description, Test-first and
// Destructive all present) — and it carries the decoy tables, so "read the
// `## Spec` section" is proven, not assumed.
//
// Table (authored below):
//   1  no deps        areas: notifications module, data layer   test-first yes
//   2  depends on 1   areas: notifications module               test-first no
//   3  depends on 1   areas: app header                         test-first yes
// The tasks CHAIN (2 and 3 both wait on 1), which is exactly the case the old
// grouping existed for — so this fixture is where "no wave grouping, and each
// task still names the tasks it waits on" is proven.
// ===========================================================================

const SPEC_FULL = `### Overview

Notifications: a list, a read toggle, and an unread badge.

### Testing Decisions

Tests live beside each module (\`src/**/*.test.ts\`). Tasks 1 and 3 are **test-first** (real logic and a seam); task 2 is a trivial UI toggle.

Manual verify setup: none

### Tasks

| # | Task | Description | Depends on | Affected areas | Test-first | Destructive | Verify recipe |
|---|------|-------------|------------|----------------|------------|-------------|---------------|
| 1 | Notification model + list | Create the notification record and an endpoint returning a user's notifications, with an empty state. | — | notifications module, data layer | yes | no | Browser at the dev URL → the empty state renders |
| 2 | Mark one as read | Clicking a notification marks it read with optimistic UI, rolling back on error. | 1 | notifications module | no | no | Click a notification → it greys out instantly |
| 3 | Unread badge | Header badge shows the unread count, refreshing on an interval. | 1 | app header | yes | no | Two unread rows → the badge reads 2 |
`;

describe("build-plan — the spec's task table as dispatch args", () => {
  let repo: string;

  beforeAll(() => {
    repo = makePlanRepo({
      decoys: true,
      // A nested directory to invoke from: the workroot is resolved from the
      // caller's cwd, so the plan must be the same one from deep inside the tree.
      files: { "nested/deep/keep.md": "a directory to run from\n" },
      prefix: "dobby-plan-full-",
      spec: SPEC_FULL,
      suite: true,
    });
  });

  it("emits one task per row of the spec's table, in table order", async () => {
    const built = await plan(repo);
    expect(ids(built.tasks)).toEqual(["1", "2", "3"]);
  });

  it("reads only the `## Spec` section, ignoring task tables elsewhere in the doc", async () => {
    // The fixture plants id 8 in `## Research` and id 9 in `## Work log`.
    const built = await plan(repo);
    expect(ids(built.tasks)).not.toContain("8");
    expect(ids(built.tasks)).not.toContain("9");
  });

  it("carries each task's title, description and verify recipe as written", async () => {
    const built = await plan(repo);
    expect(firstTask(built)).toMatchObject({
      spec: "Create the notification record and an endpoint returning a user's notifications, with an empty state.",
      title: "Notification model + list",
      verifyRecipe: "Browser at the dev URL → the empty state renders",
    });
  });

  it("splits the affected-areas cell into an array of areas", async () => {
    const built = await plan(repo);
    expect(firstTask(built).areas).toEqual([
      "notifications module",
      "data layer",
    ]);
  });

  it("leaves decisions and constraints empty for the coordinator to distribute", async () => {
    const built = await plan(repo);
    expect(
      built.tasks.map((task) => [task.decisions, task.constraints])
    ).toEqual([
      ["", ""],
      ["", ""],
      ["", ""],
    ]);
  });

  it("marks a task test-first exactly as its Test-first cell says", async () => {
    const built = await plan(repo);
    expect(built.tasks.map((task) => task.testFirst)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("carries each task's dependencies as the ids of its `Depends on` cell", async () => {
    const built = await plan(repo);
    // The cells above: task 1 depends on nothing (`—`), tasks 2 and 3 both on 1.
    expect(built.tasks.map((task) => task.dependsOn)).toEqual([
      [],
      ["1"],
      ["1"],
    ]);
  });

  it("carries `dependsOn` alongside the payload's other task fields and nothing else", async () => {
    const built = await plan(repo);
    // The build run reads these fields by name; `dependsOn` is ADDITIVE — no
    // existing field is renamed, dropped, or joined by a second newcomer.
    expect(Object.keys(firstTask(built)).sort()).toEqual([
      "areas",
      "constraints",
      "decisions",
      "dependsOn",
      "destructive",
      "id",
      "spec",
      "testFirst",
      "title",
      "verifyRecipe",
    ]);
  });

  it("emits no batching of the tasks, only the fields the plan is made of", async () => {
    const built = await plan(repo);
    // The chain 1 → {2, 3} is precisely what used to be cut into batches. The
    // whole key set is pinned so the grouping cannot come back under another
    // name: a task starts when its own dependencies are done, and nothing in
    // the payload says when to start it.
    expect(Object.keys(built).sort()).toEqual(PAYLOAD_KEYS);
  });

  it("keeps every task in the plan even when a chain makes them wait", async () => {
    const built = await plan(repo);
    // All three rows are dispatchable work; the chain lives in `dependsOn`, not
    // in a schedule that could drop or duplicate a task on its way out.
    expect(ids(built.tasks)).toEqual(["1", "2", "3"]);
    expect(built.tasks.map((task) => task.dependsOn)).toEqual([
      [],
      ["1"],
      ["1"],
    ]);
  });

  it("reports the workroot as the absolute root of the repo it planned", async () => {
    const built = await plan(repo);
    expect(built.workRoot).toBe(repo);
  });

  it("plans the workroot's STATE.md even when invoked from a subdirectory", async () => {
    const built = await plan(join(repo, "nested", "deep"));
    expect(ids(built.tasks)).toEqual(["1", "2", "3"]);
    expect(built.workRoot).toBe(repo);
  });

  it("answers with a single JSON line on stdout and nothing on stderr", async () => {
    const result = await planOutcome(repo);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });
});

// ===========================================================================
// Slice 2 — the layout the parser must tolerate.
//
// A real spec's table varies: no Description column (the 7-column layout), and
// — per Decision 15 — a Destructive column that may be absent entirely. This
// fixture also carries the OTHER two gates: numbered `Manual verify setup`
// steps, and a repo whose capability CONTRADICTS what the spec claims.
//
// Table (authored below), all three tasks dependency-free:
//   1  areas: export drawer   test-first yes   destructive no
//   2  areas: search index    test-first no    destructive YES
//   3  areas: api layer       test-first yes   destructive no
// Task 2 is destructive. Serialising it is the Architect's job at dispatch
// time, so the payload's only duty is to CARRY the flag: task 2 is emitted
// alongside the others, flagged, never isolated or held back.
// ===========================================================================

const SPEC_NO_DESCRIPTION = `### Testing Decisions

Tests live in \`src/export/*.test.ts\`; prior art is the importer suite. Tasks 1 and 3 are test-first.

Manual verify setup:
1. Log in as the \`owner\` test user (\`owner@example.test\`) in the verification surface.
2. Ensure at least one project exists in that account (create one if empty).

Prior art: the importer's own verify recipes.

### Tasks

| # | Task | Depends on | Affected areas | Test-first | Destructive | Verify recipe |
|---|------|------------|----------------|------------|-------------|---------------|
| 1 | Add the CSV export button | — | export drawer | yes | no | Click Export → a CSV downloads |
| 2 | Backfill the export index | — | search index | no | yes | Run the backfill → every row carries an index entry |
| 3 | Stream large exports | — | api layer | yes | no | Export 100k rows → the file streams to disk |
`;

describe("build-plan — a table with no Description column", () => {
  let repo: string;

  beforeAll(() => {
    repo = makePlanRepo({
      prefix: "dobby-plan-nodesc-",
      spec: SPEC_NO_DESCRIPTION,
      // No vitest: the repo has NO suite, while the spec above claims
      // test-first tasks — the disagreement case.
      suite: false,
    });
  });

  it("falls back to the task's title as its spec when there is no Description cell", async () => {
    const built = await plan(repo);
    expect(firstTask(built).spec).toBe("Add the CSV export button");
    expect(firstTask(built).title).toBe("Add the CSV export button");
  });

  it("still reads the Test-first column when the Description column is absent", async () => {
    const built = await plan(repo);
    expect(built.tasks.map((task) => task.testFirst)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("marks a task destructive exactly as its Destructive cell says", async () => {
    const built = await plan(repo);
    expect(built.tasks.map((task) => task.destructive)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("emits a destructive task beside the others, flagged rather than isolated", async () => {
    const built = await plan(repo);
    // The Architect serialises task 2 himself; the plan neither drops it, nor
    // pulls it out into a group of its own, nor reorders the table around it.
    expect(built.tasks.map((task) => [task.id, task.destructive])).toEqual([
      ["1", false],
      ["2", true],
      ["3", false],
    ]);
  });

  it("emits each task exactly once", async () => {
    const built = await plan(repo);
    expect(ids(built.tasks)).toEqual(["1", "2", "3"]);
  });

  it("reports the manual verify setup as the developer's numbered steps", async () => {
    const built = await plan(repo);
    const steps = built.manualVerifySetup as string[];
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatch(/owner@example\.test/);
    expect(steps[1]).toMatch(/at least one project exists/);
  });

  it("flags the disagreement when the spec expects tests the repo cannot run", async () => {
    const built = await plan(repo);
    expect(built.hasTestSuite).toEqual({
      disagreement: true,
      specSays: true,
      value: false,
    });
  });
});

// ===========================================================================
// Slice 3 — a spec written the OLD way (no `###` sub-headings at all).
//
// The mandated sub-heading format is new: specs already in flight are plain
// prose plus tables, and those must still plan. This fixture also plants a
// SECOND table inside `## Spec` (an edge-case table), so the tasks table can
// only be found by its header row.
//
// Table (authored below): 1 (no deps, export module), 2 (depends on 1, export
// drawer) — both emitted, in that order, 2 naming 1 as its blocker.
// ===========================================================================

const SPEC_NO_SUBHEADINGS = `The export drawer gains a CSV download. Backend-only; the route is public, so nothing needs preparing.

Edge cases:

| Edge case | Handling |
|-----------|----------|
| Empty result set | Download a header-only file |
| A second export while one runs | Queue it behind the first |

Tasks:

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Ship the CSV endpoint | — | export module | curl the endpoint → a CSV body comes back |
| 2 | Wire the drawer button | 1 | export drawer | Click Export → the file downloads |
`;

describe("build-plan — a spec with no sub-headings", () => {
  let repo: string;

  beforeAll(() => {
    repo = makePlanRepo({
      prefix: "dobby-plan-flat-",
      spec: SPEC_NO_SUBHEADINGS,
      suite: false,
    });
  });

  it("finds the task table without a `### Tasks` heading to anchor on", async () => {
    const built = await plan(repo);
    expect(ids(built.tasks)).toEqual(["1", "2"]);
  });

  it("ignores a table in the spec that is not the task table", async () => {
    const built = await plan(repo);
    expect(built.tasks.map((task) => task.title)).toEqual([
      "Ship the CSV endpoint",
      "Wire the drawer button",
    ]);
  });

  it("treats every task as not test-first when the column is absent", async () => {
    const built = await plan(repo);
    expect(built.tasks.map((task) => task.testFirst)).toEqual([false, false]);
  });

  it("treats every task as non-destructive when the column is absent", async () => {
    const built = await plan(repo);
    expect(built.tasks.map((task) => task.destructive)).toEqual([false, false]);
  });

  it("reports no manual verify setup when the spec never states one", async () => {
    const built = await plan(repo);
    expect(built.manualVerifySetup).toBe("none");
  });

  it("claims nothing about the suite when the spec has no Testing Decisions", async () => {
    const built = await plan(repo);
    expect(built.hasTestSuite).toEqual({
      disagreement: false,
      specSays: null,
      value: false,
    });
  });
});

// ===========================================================================
// Slice 4 — the cases the grouping used to exist for, each proving the plan now
// answers with the flat task list and its declared dependencies instead.
//
// A shared area, a chain, and a task waiting on two others are exactly the
// inputs that used to force a partition. None of them may reorder, hold back,
// merge or drop a task now: whether two tasks may run together is the
// Architect's call at dispatch time, made from `areas` and `dependsOn`.
// ===========================================================================

// 1 and 3 both touch `billing module`; 2 is independent — the area clash that
// used to split the plan in two.
const SPEC_AREA_CLASH = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Add the invoice list | — | billing module | Open billing → the invoices render |
| 2 | Add the settings tab | — | settings module | Open settings → the tab renders |
| 3 | Add invoice filters | — | billing module | Filter by month → the list narrows |
`;

// 1 and 3 both touch `cli/src/parse.ts`; 4 depends on 1 — an area clash and a
// chain in the same table, which used to produce a two-batch refill.
const SPEC_REFILL = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Extract the plan parser | — | cli/src/parse.ts | Parse a table → the rows come back |
| 2 | Add the config loader | — | cli/src/config.ts | Load a config → its keys resolve |
| 3 | Harden the parser errors | — | cli/src/parse.ts | Feed a broken table → a named error comes back |
| 4 | Emit the plan JSON | 1 | cli/src/emit.ts | Emit a plan → stdout parses as JSON |
`;

// A table whose rows are NOT in dependency order: row 1 waits on row 2. The
// plan reports the tasks as the spec writer wrote them — resolving that order
// is the dispatcher's job, and a plan that sorted the rows would answer a
// different document than the one the user approved.
const SPEC_BACKWARD_DEP = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Render the audit page | 2 | audit page | Open the page → the rows render |
| 2 | Add the audit query | — | audit query | Run the query → rows come back |
`;

// 3 depends on BOTH 1 and 2 — the multi-blocker case.
const SPEC_MULTI_DEP = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Add the job queue | — | queue module | Enqueue a job → it lands in the queue |
| 2 | Add the worker | — | worker module | Run the worker → it picks the job up |
| 3 | Wire the retry policy | 1, 2 | retry module | Fail a job → it is retried |
`;

describe("build-plan — no ordering imposed on the tasks", () => {
  it("emits two tasks that touch the same area as ordinary neighbours", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-clash-",
      spec: SPEC_AREA_CLASH,
    });
    const built = await plan(repo);
    // 1 and 3 collide on `billing module`; the plan reports the areas and
    // leaves the collision for the Architect to resolve when he dispatches.
    expect(ids(built.tasks)).toEqual(["1", "2", "3"]);
    expect(built.tasks.map((task) => task.areas)).toEqual([
      ["billing module"],
      ["settings module"],
      ["billing module"],
    ]);
  });

  it("emits a chained plan in table order with no grouping around it", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-refill-",
      spec: SPEC_REFILL,
    });
    const built = await plan(repo);
    expect(Object.keys(built).sort()).toEqual(PAYLOAD_KEYS);
    expect(ids(built.tasks)).toEqual(["1", "2", "3", "4"]);
  });

  it("emits the tasks in table order even when a row waits on a later one", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-backward-",
      spec: SPEC_BACKWARD_DEP,
    });
    const built = await plan(repo);
    // Row 1 waits on row 2. The plan is the table, not a schedule: it hands the
    // rows over as written and lets the dependency say what waits for what.
    expect(ids(built.tasks)).toEqual(["1", "2"]);
    expect(built.tasks.map((task) => task.dependsOn)).toEqual([["2"], []]);
  });
});

// ===========================================================================
// Slice 5 — the preconditions verdict. A spec that cannot be executed must be
// REFUSED with the reason, not planned into a broken workflow.
// ===========================================================================

// Task 1 is complete (the control). Task 2 has no title, task 3 no areas, task 4
// no verify recipe — three empty cells, one per required field.
const SPEC_EMPTY_CELLS = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Rename the export module | — | export module | Import the new path → it resolves |
| 2 |  | — | billing module | Open billing → the totals render |
| 3 | Purge the stale exports | — |  | Run the purge → the old rows are gone |
| 4 | Add the export index | — | search index |  |
`;

// Task 2 depends on 7 — a task that does not exist in this table.
const SPEC_DANGLING_DEP = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Add the audit table | — | audit module | Insert a row → it lands in audit |
| 2 | Write the audit rows | 7 | audit writer | Change a record → an audit row appears |
`;

// 2 depends on 3 and 3 depends on 2 — neither can ever be ready.
const SPEC_CYCLE = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Extract the http client | — | http client | Call the client → a response comes back |
| 2 | Route reads through the client | 3 | reads module | Load a page → the data renders |
| 3 | Route writes through the client | 2 | writes module | Save a form → the row updates |
`;

describe("build-plan — preconditions", () => {
  it("passes a plan whose every task is complete and resolvable", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-ok-",
      spec: SPEC_FULL,
      suite: true,
    });
    const built = await plan(repo);
    expect(built.preconditions).toEqual({
      cycles: [],
      danglingDeps: [],
      missing: [],
      ok: true,
    });
  });

  it("refuses a plan with empty required cells, naming each task and field", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-empty-",
      spec: SPEC_EMPTY_CELLS,
    });
    const built = await blockedPlan(repo);
    const { missing } = built.preconditions;
    expect(built.preconditions.ok).toBe(false);
    expect(missing).toHaveLength(3);
    expect(missing.find((entry) => entry.taskId === "2")?.field).toMatch(
      /task|title/i
    );
    expect(missing.find((entry) => entry.taskId === "3")?.field).toMatch(
      /areas/i
    );
    expect(missing.find((entry) => entry.taskId === "4")?.field).toMatch(
      /verif/i
    );
  });

  it("keeps the dependency verdicts clean when only cells are missing", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-empty2-",
      spec: SPEC_EMPTY_CELLS,
    });
    const built = await blockedPlan(repo);
    expect(built.preconditions.danglingDeps).toEqual([]);
    expect(built.preconditions.cycles).toEqual([]);
  });

  it("refuses a plan that depends on a task the table does not contain", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-dangling-",
      spec: SPEC_DANGLING_DEP,
    });
    const built = await blockedPlan(repo);
    const reported = JSON.stringify(built.preconditions.danglingDeps);
    expect(built.preconditions.ok).toBe(false);
    expect(built.preconditions.danglingDeps).toHaveLength(1);
    // Whatever shape the entry takes, it names the task that declared the
    // dependency (2) and the id that does not exist (7).
    expect(reported).toContain("2");
    expect(reported).toContain("7");
    expect(built.preconditions.missing).toEqual([]);
  });

  it("refuses a plan whose dependencies form a cycle", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-cycle-",
      spec: SPEC_CYCLE,
    });
    const built = await blockedPlan(repo);
    const reported = JSON.stringify(built.preconditions.cycles);
    expect(built.preconditions.ok).toBe(false);
    expect(built.preconditions.cycles.length).toBeGreaterThan(0);
    // The cycle is 2 ↔ 3; task 1 is fine and no dependency is dangling.
    expect(reported).toContain("2");
    expect(reported).toContain("3");
    expect(built.preconditions.danglingDeps).toEqual([]);
  });
});

// ===========================================================================
// Slice 6 — the dispatch path: ONE ad-hoc task from a JSON file, no STATE.md.
//
// `/dobby:dispatch` has no work-session doc; it hands the CLI a single task and
// wants the same payload back. The fixture repo DOES carry a STATE.md (the
// 3-task plan of slice 1), so "no STATE.md read" is observable: the answer must
// be the one ad-hoc task, never the doc's three.
// ===========================================================================

const ADHOC_TASK = {
  areas: ["export drawer"],
  id: "1",
  spec: "The export button reads 'Exprot'. Fix the label and its aria-label.",
  testFirst: true,
  title: "Fix the export button label",
  verifyRecipe: "Open the drawer → the button reads Export",
};

describe("build-plan — a single ad-hoc task (dispatch)", () => {
  let repo: string;
  let taskFile: string;

  beforeAll(() => {
    repo = makePlanRepo({
      files: { "task.json": `${JSON.stringify(ADHOC_TASK, null, 2)}\n` },
      prefix: "dobby-plan-adhoc-",
      spec: SPEC_FULL,
      suite: true,
    });
    taskFile = join(repo, "task.json");
  });

  it("plans the one task from the file instead of the doc's task table", async () => {
    const built = await plan(repo, ["--task", taskFile]);
    expect(built.tasks).toHaveLength(1);
    expect(firstTask(built).title).toBe("Fix the export button label");
  });

  it("gives the ad-hoc task the same shape a table task gets", async () => {
    const built = await plan(repo, ["--task", taskFile]);
    expect(firstTask(built)).toEqual({
      areas: ["export drawer"],
      constraints: "",
      decisions: "",
      // A lone ad-hoc task has no table and so waits for nobody.
      dependsOn: [],
      destructive: false,
      id: "1",
      spec: "The export button reads 'Exprot'. Fix the label and its aria-label.",
      testFirst: true,
      title: "Fix the export button label",
      verifyRecipe: "Open the drawer → the button reads Export",
    });
  });

  it("answers the dispatch path with the same ungrouped payload", async () => {
    const built = await plan(repo, ["--task", taskFile]);
    expect(Object.keys(built).sort()).toEqual(PAYLOAD_KEYS);
  });

  it("still reports the repo's own suite capability and workroot", async () => {
    const built = await plan(repo, ["--task", taskFile]);
    expect(built.hasTestSuite).toEqual({
      disagreement: false,
      specSays: null,
      value: true,
    });
    expect(built.workRoot).toBe(repo);
  });

  it("has nothing to complain about for a complete ad-hoc task", async () => {
    const built = await plan(repo, ["--task", taskFile]);
    expect(built.preconditions).toEqual({
      cycles: [],
      danglingDeps: [],
      missing: [],
      ok: true,
    });
  });
});

// ===========================================================================
// Slice 7 — the two surfaces the review found uncovered.
//
//  - `--file <doc>`: the document override. A plan does not always live in
//    STATE.md (a plan document reviewed on its own, a second plan inside one
//    session), so the source must be redirectable — and the redirect is only
//    proven by a repo that ALSO carries a STATE.md whose tasks are different.
//  - the EMPHASIZED `Manual verify setup` field. `**Manual verify setup:** none`
//    is the most idiomatic spelling of the field, and its closing marker lands
//    inside the value; if it survives, `/dobby:execute`'s pre-verification gate
//    stops the user with a fabricated step instead of skipping silently.
// ===========================================================================

// A plan document that is NOT STATE.md — same `## Spec` section, different tasks
// from the ones its repo's STATE.md carries (1..3, "Notification model + list").
const ALT_PLAN_DOC = `# Plan: the webhook receiver

## Spec

### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Add the webhook receiver | — | webhooks module | POST a webhook → it is recorded |
| 2 | Retry a failed webhook | 1 | webhooks worker | Make one fail → it is retried |
`;

describe("build-plan — planning a document other than STATE.md", () => {
  let repo: string;

  beforeAll(() => {
    repo = makePlanRepo({
      files: { "docs/webhooks-plan.md": ALT_PLAN_DOC },
      prefix: "dobby-plan-file-",
      spec: SPEC_FULL,
      suite: true,
    });
  });

  it("plans the `--file` document's tasks instead of the workroot's STATE.md", async () => {
    const built = await plan(repo, ["--file", "docs/webhooks-plan.md"]);
    expect(built.tasks.map((task) => task.title)).toEqual([
      "Add the webhook receiver",
      "Retry a failed webhook",
    ]);
    expect(built.tasks.map((task) => task.dependsOn)).toEqual([[], ["1"]]);
  });

  it("still reports the repo's workroot when the document lives elsewhere", async () => {
    const built = await plan(repo, ["--file", "docs/webhooks-plan.md"]);
    expect(built.workRoot).toBe(repo);
  });
});

// The field written the idiomatic way — the label bolded THROUGH its colon, so
// the closing `**` sits in front of the value.
const SPEC_BOLD_SETUP_NONE = `### Testing Decisions

Tests live beside each module (\`src/**/*.test.ts\`).

**Manual verify setup:** none

### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Rename the unread badge | — | app header | Open the header → the badge reads Unread |
`;

const SPEC_BOLD_SETUP_STEP = `### Testing Decisions

Tests live beside each module.

**Manual verify setup:** Log in as the \`owner\` test user before verifying.

### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Add the billing tab | — | billing module | Open billing → the tab renders |
`;

describe("build-plan — an emphasized `Manual verify setup` field", () => {
  it("reads a bolded field declaring `none` as no manual setup at all", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-boldnone-",
      spec: SPEC_BOLD_SETUP_NONE,
    });
    const built = await plan(repo);
    expect(built.manualVerifySetup).toBe("none");
  });

  it("reads a bolded field's inline value as the step, without its emphasis", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-boldstep-",
      spec: SPEC_BOLD_SETUP_STEP,
    });
    const built = await plan(repo);
    expect(built.manualVerifySetup).toEqual([
      "Log in as the `owner` test user before verifying.",
    ]);
  });
});

// ===========================================================================
// Slice 8 — each task's declared dependencies.
//
// With no batching left, `dependsOn` is the ONLY thing that says who a task
// waits for: a task starts the moment its own dependencies are done, and one
// whose dependency ended `needs-human` is skipped (`blocked`) instead of built.
// The dispatcher can only recognize that dependency if the id it reads is the
// same id the task list carries. So each expectation below is the literal
// `Depends on` cell of the row it names, as strings.
// ===========================================================================

// The `Depends on` cell left EMPTY rather than dashed — the other spelling of
// "no dependency", and the one that must not read as a dependency named "".
const SPEC_BLANK_DEPENDS = `### Tasks

| # | Task | Depends on | Affected areas | Verify recipe |
|---|------|------------|----------------|---------------|
| 1 | Add the health endpoint |  | health module | curl /health → a 200 comes back |
| 2 | Log the health checks | 1 | logging module | curl /health → a log line appears |
`;

describe("build-plan — each task's declared dependencies", () => {
  let multiDepRepo: string;

  beforeAll(() => {
    multiDepRepo = makePlanRepo({
      prefix: "dobby-plan-depends-",
      spec: SPEC_MULTI_DEP,
    });
  });

  it("lists every id when a task depends on more than one task", async () => {
    const built = await plan(multiDepRepo);
    // The cells: 1 and 2 depend on nothing, 3 on `1, 2` — both blockers named,
    // in the order written, with the separator's spacing gone.
    expect(built.tasks.map((task) => task.dependsOn)).toEqual([
      [],
      [],
      ["1", "2"],
    ]);
  });

  it("names dependencies with the same ids the emitted tasks carry", async () => {
    const built = await plan(multiDepRepo);
    // Looking a blocker up is an identity match against the task list: a
    // number, a padded string or a title here would silently never match, and
    // every dependent would start as if its blocker had passed.
    expect(built.tasks.flatMap((task) => task.dependsOn)).toEqual(["1", "2"]);
    expect(ids(built.tasks)).toEqual(["1", "2", "3"]);
  });

  it("reads an empty `Depends on` cell as no dependency at all", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-blankdeps-",
      spec: SPEC_BLANK_DEPENDS,
    });
    const built = await plan(repo);
    expect(built.tasks.map((task) => task.dependsOn)).toEqual([[], ["1"]]);
  });

  it("reports a dependency the table does not contain, exactly as written", async () => {
    const repo = makePlanRepo({
      prefix: "dobby-plan-danglingdeps-",
      spec: SPEC_DANGLING_DEP,
    });
    const built = await blockedPlan(repo);
    // Task 2's cell says `7`. Calling that out is the preconditions verdict's
    // job; the field itself mirrors what the spec writer typed.
    expect(built.tasks.map((task) => task.dependsOn)).toEqual([[], ["7"]]);
  });
});
