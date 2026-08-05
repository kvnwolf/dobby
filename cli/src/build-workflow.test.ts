import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ===========================================================================
// THE BUILD RUN — the workflow script `/dobby:execute` launches ONCE per plan.
//
// The artifact under test is not a module: it is the fenced `js` script inside
// `plugin/skills/execute/references/build-workflow.md`, which the coordinator
// hands to the Workflow tool VERBATIM. Its interface is therefore the workflow
// runtime's own seam — `args` IN, and OUT: the agents it dispatches, the
// `log()` narration, the `phase()` groups, and the returned per-task results.
//
// This harness reads the markdown, extracts that script, and evaluates it with
// the runtime globals stubbed (`agent`, `parallel`, `pipeline`, `log`, `phase`,
// `budget`, `args`). Every assertion below is on that external surface — which
// task ids reached `agent()`, what was logged, what came back. Nothing here
// reaches into the script's internals, so the state machine stays free to move
// as long as the BEHAVIOR holds.
//
// BOUNDARIES MOCKED: only the workflow runtime itself (the agent spawner is an
// external system this suite cannot run, and `parallel`/`log`/`phase` are its
// primitives). There is no network, clock, filesystem write, or randomness in
// reach — the script is forbidden all four (see the last describe block).
//
// WHERE EVERY EXPECTED VALUE COMES FROM (all INDEPENDENT of the script):
//  - The status vocabulary (`done` / `needs-human` / `blocked`), the result
//    fields (`id`, `status`, `workLog`, `evidence`, `reason`, `blockedBy`,
//    `loops`) and the `{ results }` wrapper are the task spec's own literals.
//  - Every log line asserted is the spec's literal template with this file's
//    fixture ids substituted: `"<id> ⊘ blocked — depends on <blocker>
//    (<blocker status>)"`, `"Wave 1/3 done: 2 ✓ · 1 needs-human · 0 ⊘"`,
//    `"T4: review ✗ (findings) — retry 1/3"`, `"T4: verify ✗ — outer loop
//    2/3"`, `"T4 ✓ verified — … (2 loops)"`, `"T5 ✗ needs-human — <reason>"`.
//  - The `phase()` title format `Wave <n>/<total>` is the spec's decision 2.
//  - The two `needs-human` reasons (`code review never passed`, `verify never
//    passed within retries`) and the caps (MAX_OUTER 3, MAX_REVIEW 3) are the
//    CURRENT script's literals, which the spec freezes byte-for-byte.
//  - Every agent answer is a canned literal this file writes (`pass: false`
//    with a findings string, a `workLog` string, an `evidence` string), so
//    "which loop ran" and "what came back" are facts of data we authored —
//    never a value recomputed the way the script computes it.
//  - The blocking rule is read off the fixtures BY HAND: with waves
//    [[T1], [T2 depends on T1], [T3 depends on T2]] and T1 forced to
//    `needs-human`, a reader can see that T2 and T3 must never spawn an agent.
//    Likewise for a wave holding a casualty NEXT TO a bystander: only the task
//    whose `dependsOn` names the failure is skipped ("Independent tasks in the
//    same later wave still run" — the reference's own encoded rule).
//  - The args guard comes from the reference's encoded rule that `args.waves`
//    carries FULL task objects and "a wave of bare ids makes the run throw
//    immediately instead of building the wrong thing".
//  - The `phase` option each `agent()` call must carry is the same
//    `Wave <n>/<total>` title of decision 2 — the group the wave's agents
//    belong to, asserted off the option the stub records.
// ===========================================================================

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REFERENCE = resolve(
  REPO_ROOT,
  "plugin/skills/execute/references/build-workflow.md"
);

// --- extracting the script from the reference ------------------------------

function fencedJsBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of markdown.split("\n")) {
    if (current === null) {
      if (line.trim() === "```js") {
        current = [];
      }
      continue;
    }
    if (line.trim() === "```") {
      blocks.push(current.join("\n"));
      current = null;
      continue;
    }
    current.push(line);
  }
  return blocks;
}

function readBuildRunScript(): string {
  const blocks = fencedJsBlocks(readFileSync(REFERENCE, "utf8"));
  const script = blocks.find((block) => block.includes("const meta"));
  if (!script) {
    throw new Error(
      `no fenced \`js\` build-run script (a block declaring \`meta\`) in ${REFERENCE}`
    );
  }
  return script;
}

const SCRIPT = readBuildRunScript();

// The workflow runtime's globals, in the order the evaluator binds them.
const RUNTIME_GLOBALS = [
  "agent",
  "parallel",
  "pipeline",
  "log",
  "phase",
  "budget",
  "args",
];

// --- the stubbed runtime ---------------------------------------------------

type AgentResult = Record<string, unknown> | null;

interface AgentOptions {
  agentType: string;
  label: string;
  phase?: string;
  schema?: unknown;
}

interface AgentCall {
  agentType: string;
  label: string;
  /** the phase group the runtime files this agent under */
  phase: string | undefined;
  prompt: string;
}

interface AgentPlan {
  /** label -> the same canned answer every time it is dispatched */
  always?: Record<string, AgentResult>;
  /** label -> hold the answer until this settles (used to observe ordering) */
  gate?: Record<string, Promise<void>>;
  /** label -> canned answers in order; the default answer resumes after */
  queue?: Record<string, AgentResult[]>;
}

interface Runtime {
  agent: (prompt: string, options: AgentOptions) => Promise<AgentResult>;
  budget: () => null;
  log: (line: unknown) => void;
  parallel: (thunks: Array<() => unknown>) => Promise<unknown[]>;
  phase: (title: unknown) => void;
  pipeline: () => null;
}

interface Harness {
  calls: AgentCall[];
  lines: string[];
  phases: string[];
  runtime: Runtime;
}

interface TaskResult {
  blockedBy?: string;
  evidence?: string;
  id: string;
  loops?: number;
  reason?: string;
  status: string;
  workLog?: string;
}

// A worker answers in the shape its schema declares: the reviewer/verifier a
// VERDICT, everyone else a work-log entry.
function defaultResult(role: string, id: string): AgentResult {
  if (role === "review") {
    return { evidence: "", findings: "", pass: true, testFindings: "" };
  }
  if (role === "verify") {
    return {
      evidence: `${id} behaves as its verify recipe describes`,
      findings: "",
      pass: true,
    };
  }
  return { workLog: `${role} log for ${id}` };
}

function makeHarness(plan: AgentPlan = {}): Harness {
  const calls: AgentCall[] = [];
  const lines: string[] = [];
  const phases: string[] = [];

  const agent = async (
    prompt: string,
    options: AgentOptions
  ): Promise<AgentResult> => {
    const label = options?.label ?? "";
    calls.push({
      agentType: options?.agentType ?? "",
      label,
      phase: options?.phase,
      prompt,
    });
    const gate = plan.gate?.[label];
    if (gate) {
      await gate;
    }
    const queued = plan.queue?.[label];
    if (queued && queued.length > 0) {
      return queued.shift() ?? null;
    }
    if (plan.always && label in plan.always) {
      return plan.always[label] ?? null;
    }
    const separator = label.indexOf(":");
    return defaultResult(label.slice(0, separator), label.slice(separator + 1));
  };

  return {
    calls,
    lines,
    phases,
    runtime: {
      agent,
      budget: () => null,
      log: (line) => {
        lines.push(String(line));
      },
      // the runtime's `parallel`: run every thunk at once, a thrown/rejected
      // thunk surfacing as a null result rather than killing the batch
      parallel: (thunks) =>
        Promise.all(
          thunks.map((thunk) => Promise.resolve(thunk()).catch(() => null))
        ),
      phase: (title) => {
        phases.push(String(title));
      },
      pipeline: () => null,
    },
  };
}

function runBuildRun(harness: Harness, args: unknown): Promise<unknown> {
  const body = SCRIPT.replace("export const meta", "const meta");
  const evaluate = new Function(
    ...RUNTIME_GLOBALS,
    `return (async () => {\n${body}\n})();`
  ) as unknown as (...deps: unknown[]) => Promise<unknown>;
  const { runtime } = harness;
  return evaluate(
    runtime.agent,
    runtime.parallel,
    runtime.pipeline,
    runtime.log,
    runtime.phase,
    runtime.budget,
    args
  );
}

// Start a run we will only await LATER, after observing the stubs mid-flight.
// The extra no-op handler keeps an early rejection from surfacing as an
// UNHANDLED one during that observation window; the `await` on the returned
// promise still fails the test with the real error.
function startBuildRun(harness: Harness, args: unknown): Promise<unknown> {
  const running = runBuildRun(harness, args);
  running.catch(() => undefined);
  return running;
}

// --- reading the outcome ---------------------------------------------------

function resultsOf(returned: unknown): TaskResult[] {
  const results = (returned as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    throw new Error(
      `the build run must return { results: [...] } — got ${JSON.stringify(returned)}`
    );
  }
  return results as TaskResult[];
}

function resultFor(returned: unknown, id: string): TaskResult {
  const results = resultsOf(returned);
  const found = results.find((result) => result.id === id);
  if (!found) {
    throw new Error(
      `no result for ${id} — got ${JSON.stringify(results.map((r) => r.id))}`
    );
  }
  return found;
}

function labelsFor(harness: Harness, id: string): string[] {
  return harness.calls
    .map((call) => call.label)
    .filter((label) => label.endsWith(`:${id}`));
}

// The distinct phase groups this task's agents were filed under.
function phasesFor(harness: Harness, id: string): Array<string | undefined> {
  const filed = harness.calls
    .filter((call) => call.label.endsWith(`:${id}`))
    .map((call) => call.phase);
  return [...new Set(filed)];
}

function linesFor(harness: Harness, id: string): string[] {
  return harness.lines.filter((line) => line.includes(id));
}

function lineWith(harness: Harness, needle: string): string {
  const found = harness.lines.find((line) => line.includes(needle));
  if (found === undefined) {
    throw new Error(
      `no log line contains "${needle}" — got ${JSON.stringify(harness.lines)}`
    );
  }
  return found;
}

const FLUSH_MS = 10;

function flush(): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, FLUSH_MS);
  });
}

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Deferred {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    release = () => settle();
  });
  return { promise, release };
}

// --- fixtures --------------------------------------------------------------

const WORK_ROOT = "/private/tmp/dobby-build-run-fixture/worktree";
const DEV_URL = "https://build-run-fixture.dobby.test";

interface FixtureTask {
  areas: string[];
  constraints: string;
  decisions: string;
  dependsOn: string[];
  id: string;
  spec: string;
  testFirst: boolean;
  title: string;
  verifyRecipe: string;
}

function task(id: string, dependsOn: string[] = []): FixtureTask {
  return {
    areas: [`src/${id.toLowerCase()}`],
    constraints: `constraints for ${id}`,
    decisions: `decisions for ${id}`,
    dependsOn,
    id,
    spec: `spec for ${id}`,
    testFirst: false,
    title: `Task ${id}`,
    verifyRecipe: `open the app and check ${id}`,
  };
}

function waveArgs(
  waves: FixtureTask[][],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    devUrl: DEV_URL,
    hasTestSuite: false,
    waves,
    workRoot: WORK_ROOT,
    ...extra,
  };
}

// A verdict that never passes — the only way to force a terminal `needs-human`.
const VERIFY_FAILS = {
  evidence: "",
  findings: "the saved value never appears",
  pass: false,
};

describe("the build run — the args contract", () => {
  it("runs a one-wave plan and reports the task done", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({
      evidence: "T1 behaves as its verify recipe describes",
      id: "T1",
      loops: 1,
      status: "done",
    });
  });

  it("returns the implementor's work log for a task it built", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1").workLog).toContain("impl log for T1");
  });

  it("accepts the legacy tasks[] args as a single wave", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(harness, {
      devUrl: DEV_URL,
      hasTestSuite: false,
      tasks: [task("T1")],
      workRoot: WORK_ROOT,
    });

    expect(resultFor(returned, "T1")).toMatchObject({
      id: "T1",
      loops: 1,
      status: "done",
    });
  });

  it("refuses args carrying neither waves nor tasks, before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(harness, {
      devUrl: DEV_URL,
      hasTestSuite: false,
      workRoot: WORK_ROOT,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/waves/i);
    expect(String(failure)).toMatch(/tasks/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses waves of bare ids, before any agent", async () => {
    // `bunx dobby build-plan --json` reports waves as ID arrays; unzipped, they
    // carry no spec to build from — the run must say so rather than dispatch.
    const harness = makeHarness();

    const failure = await runBuildRun(harness, {
      devUrl: DEV_URL,
      hasTestSuite: false,
      waves: [["T1"]],
      workRoot: WORK_ROOT,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/task object/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses a wave that is not an array of tasks, before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(harness, {
      devUrl: DEV_URL,
      hasTestSuite: false,
      waves: [task("T1")],
      workRoot: WORK_ROOT,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/task object/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses waves repeating a task id, before any agent", async () => {
    // A task id KEYS the outcome map every later wave reads back, so a repeat
    // would overwrite a sibling's terminal status — and a dependent would build
    // on a task that failed. BY HAND: T1 appears in wave 1 and again in wave 2.
    const harness = makeHarness();

    const failure = await runBuildRun(
      harness,
      waveArgs([[task("T1")], [task("T2"), task("T1")]])
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/duplicate/i);
    expect(String(failure)).toContain("T1");
    expect(harness.calls).toEqual([]);
  });

  it("reads a task id naming an inherited property as that task alone", async () => {
    // BY HAND: wave 1 holds a task whose id is `__proto__` and whose verifier
    // never passes, so it ends needs-human; wave 2's dependent must see THAT
    // status — never a value inherited from `Object.prototype` — and therefore
    // be skipped as blocked without spawning a single agent. The logged status
    // of the blocker is what tells the two apart: an inherited read would name
    // an object here, not the terminal status the wave actually recorded.
    const harness = makeHarness({
      always: { "verify:__proto__": VERIFY_FAILS },
    });

    const returned = await runBuildRun(
      harness,
      waveArgs([[task("__proto__")], [task("T2", ["__proto__"])]])
    );

    expect(resultFor(returned, "__proto__").status).toBe("needs-human");
    expect(resultFor(returned, "T2")).toMatchObject({
      blockedBy: "__proto__",
      status: "blocked",
    });
    expect(labelsFor(harness, "T2")).toEqual([]);
    expect(harness.lines).toContain(
      "T2 ⊘ blocked — depends on __proto__ (needs-human)"
    );
  });

  it("parses args delivered as a JSON string", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(
      harness,
      JSON.stringify(waveArgs([[task("T1")]]))
    );

    expect(resultFor(returned, "T1").status).toBe("done");
  });
});

describe("the build run — blocked dependents", () => {
  // Waves BY HAND: T1 alone, then T2 which depends on it. T1's verifier never
  // passes, so T1 ends `needs-human` and T2 can never legitimately run.
  const blockedPlan = () => waveArgs([[task("T1")], [task("T2", ["T1"])]]);
  const blockedAgents = () => ({ always: { "verify:T1": VERIFY_FAILS } });

  it("marks a task blocked when the task it depends on ended needs-human", async () => {
    const harness = makeHarness(blockedAgents());

    const returned = await runBuildRun(harness, blockedPlan());

    expect(resultFor(returned, "T2")).toMatchObject({
      blockedBy: "T1",
      id: "T2",
      status: "blocked",
      workLog: "",
    });
  });

  it("spawns no agent for a blocked task", async () => {
    const harness = makeHarness(blockedAgents());

    await runBuildRun(harness, blockedPlan());

    expect(labelsFor(harness, "T2")).toEqual([]);
  });

  it("logs the blocked task with its blocker and the blocker's status", async () => {
    const harness = makeHarness(blockedAgents());

    await runBuildRun(harness, blockedPlan());

    expect(harness.lines).toContain(
      "T2 ⊘ blocked — depends on T1 (needs-human)"
    );
  });

  it("blocks transitively through an already-blocked dependency", async () => {
    // T3 depends on T2, which is itself blocked by the needs-human T1.
    const harness = makeHarness(blockedAgents());

    const returned = await runBuildRun(
      harness,
      waveArgs([[task("T1")], [task("T2", ["T1"])], [task("T3", ["T2"])]])
    );

    expect(resultFor(returned, "T3")).toMatchObject({
      blockedBy: "T2",
      status: "blocked",
    });
    expect(labelsFor(harness, "T3")).toEqual([]);
    expect(harness.lines).toContain("T3 ⊘ blocked — depends on T2 (blocked)");
  });

  // Wave 2 holds BOTH a casualty and a bystander: T2 depends on the
  // needs-human T1, while T3 depends on nothing. BY HAND: only T2 is skipped.
  const sharedWavePlan = () =>
    waveArgs([[task("T1")], [task("T2", ["T1"]), task("T3")]]);

  it("builds an independent task sharing a wave with a blocked one", async () => {
    const harness = makeHarness(blockedAgents());

    const returned = await runBuildRun(harness, sharedWavePlan());

    expect(resultFor(returned, "T3").status).toBe("done");
    expect(labelsFor(harness, "T3")).toContain("impl:T3");
  });

  it("still skips the blocked task when its wave sibling runs", async () => {
    const harness = makeHarness(blockedAgents());

    const returned = await runBuildRun(harness, sharedWavePlan());

    expect(resultFor(returned, "T2")).toMatchObject({
      blockedBy: "T1",
      status: "blocked",
    });
    expect(labelsFor(harness, "T2")).toEqual([]);
  });

  it("counts the skipped and the built task in the same wave summary", async () => {
    const harness = makeHarness(blockedAgents());

    await runBuildRun(harness, sharedWavePlan());

    expect(harness.lines).toContain("Wave 2/2 done: 1 ✓ · 0 needs-human · 1 ⊘");
  });

  it("runs a dependent task when the task it depends on was verified", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(harness, blockedPlan());

    expect(resultFor(returned, "T2").status).toBe("done");
    expect(labelsFor(harness, "T2")).toContain("impl:T2");
  });
});

describe("the build run — wave sequencing", () => {
  it("starts a wave only after the previous wave has finished", async () => {
    // T2 does NOT depend on T1 — only the wave order may hold it back.
    const held = deferred();
    const harness = makeHarness({ gate: { "impl:T1": held.promise } });

    const running = startBuildRun(
      harness,
      waveArgs([[task("T1")], [task("T2")]])
    );
    await flush();
    const startedEarly = labelsFor(harness, "T2");
    held.release();
    const returned = await running;

    expect(startedEarly).toEqual([]);
    expect(resultFor(returned, "T2").status).toBe("done");
  });

  it("runs the tasks of one wave in parallel", async () => {
    const held = deferred();
    const harness = makeHarness({ gate: { "impl:T1": held.promise } });

    const running = startBuildRun(
      harness,
      waveArgs([[task("T1"), task("T2")]])
    );
    await flush();
    const startedAlongside = labelsFor(harness, "T2");
    held.release();
    await running;

    expect(startedAlongside).toContain("impl:T2");
  });

  it("groups each wave under its own phase", async () => {
    const harness = makeHarness();

    await runBuildRun(harness, waveArgs([[task("T1")], [task("T2")]]));

    expect(harness.phases).toEqual(
      expect.arrayContaining(["Wave 1/2", "Wave 2/2"])
    );
  });

  it("files every agent of a task under its own wave's phase group", async () => {
    const harness = makeHarness();

    await runBuildRun(harness, waveArgs([[task("T1")], [task("T2")]]));

    expect(phasesFor(harness, "T1")).toEqual(["Wave 1/2"]);
    expect(phasesFor(harness, "T2")).toEqual(["Wave 2/2"]);
  });
});

describe("the build run — the narrator log", () => {
  // ONE scenario, read BY HAND: wave 1 builds T1 (passes) and T2 (verifier
  // never passes → needs-human); wave 2 holds T3, which depends on T2 and is
  // therefore blocked. Counts per wave: 1 ✓ / 1 needs-human / 0 ⊘, then
  // 0 ✓ / 0 needs-human / 1 ⊘.
  const mixedPlan = () =>
    waveArgs([[task("T1"), task("T2")], [task("T3", ["T2"])]]);
  const mixedAgents = () => ({ always: { "verify:T2": VERIFY_FAILS } });

  it("logs a terminal line for a task that passed", async () => {
    const harness = makeHarness(mixedAgents());

    await runBuildRun(harness, mixedPlan());

    expect(lineWith(harness, "T1 ✓ verified")).toBeTruthy();
  });

  it("logs a terminal line for a task that needs a human", async () => {
    const harness = makeHarness(mixedAgents());

    await runBuildRun(harness, mixedPlan());

    expect(lineWith(harness, "T2 ✗ needs-human")).toContain(
      "verify never passed"
    );
  });

  it("opens each wave with a line naming it", async () => {
    const harness = makeHarness(mixedAgents());

    await runBuildRun(harness, mixedPlan());

    const opening = harness.lines.filter(
      (line) => line.includes("Wave 1/2") && !line.includes("done:")
    );
    expect(opening).not.toEqual([]);
  });

  it("closes each wave with a summary counting its outcomes", async () => {
    const harness = makeHarness(mixedAgents());

    await runBuildRun(harness, mixedPlan());

    expect(harness.lines).toContain("Wave 1/2 done: 1 ✓ · 1 needs-human · 0 ⊘");
    expect(harness.lines).toContain("Wave 2/2 done: 0 ✓ · 0 needs-human · 1 ⊘");
  });
});

describe("the build run — retries and adaptive verbosity", () => {
  // T1's first review comes back with findings, then passes; T2 sails through.
  const reviewFailsOnce = () => ({
    queue: {
      "review:T1": [
        {
          evidence: "",
          findings: "the null guard is missing",
          pass: false,
          testFindings: "",
        },
      ],
    },
  });

  it("logs a retry line when a review comes back with findings", async () => {
    const harness = makeHarness(reviewFailsOnce());

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(lineWith(harness, "T1: review ✗")).toContain("retry 1/3");
  });

  it("narrates the later milestones of a task that failed a review while its wave sibling stays terse", async () => {
    const harness = makeHarness(reviewFailsOnce());

    await runBuildRun(harness, waveArgs([[task("T1"), task("T2")]]));

    // T2 never failed: its only line is its terminal one.
    expect(linesFor(harness, "T2")).toHaveLength(1);
    // T1 escalated: the retry line, the milestones after it, the terminal line.
    expect(linesFor(harness, "T1").length).toBeGreaterThanOrEqual(4);
  });

  it("restarts the outer loop after a failed verify and reports the loops used", async () => {
    const harness = makeHarness({ queue: { "verify:T1": [VERIFY_FAILS] } });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(lineWith(harness, "T1: verify ✗")).toContain("outer loop 2/3");
    expect(resultFor(returned, "T1")).toMatchObject({
      loops: 2,
      status: "done",
    });
  });

  it("flags a task needs-human when verify never passes within the caps", async () => {
    const harness = makeHarness({ always: { "verify:T1": VERIFY_FAILS } });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({
      loops: 3,
      reason: "verify never passed within retries",
      status: "needs-human",
    });
  });

  it("flags a task needs-human when the review never passes", async () => {
    const harness = makeHarness({
      always: {
        "review:T1": {
          evidence: "",
          findings: "the handler still swallows the error",
          pass: false,
          testFindings: "",
        },
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({
      reason: "code review never passed",
      status: "needs-human",
    });
  });

  it("keeps the wave alive when an agent returns no result at all", async () => {
    // A skipped / errored agent yields null; the task escalates, it never
    // crashes the run, and its wave sibling still finishes.
    const harness = makeHarness({ always: { "verify:T1": null } });

    const returned = await runBuildRun(
      harness,
      waveArgs([[task("T1"), task("T2")]])
    );

    expect(resultFor(returned, "T1").status).toBe("needs-human");
    expect(resultFor(returned, "T2").status).toBe("done");
  });
});

describe("the build run — the per-task state machine it wraps", () => {
  it("dispatches the test-author first when the repo has a suite and the task is test-first", async () => {
    const harness = makeHarness();
    const testFirst = { ...task("T1"), testFirst: true };

    await runBuildRun(harness, waveArgs([[testFirst]], { hasTestSuite: true }));

    expect(labelsFor(harness, "T1")).toContain("test:T1");
    expect(harness.calls[0]?.agentType).toBe("dobby:test-author");
  });

  it("never dispatches the test-author when the repo has no suite", async () => {
    const harness = makeHarness();
    const testFirst = { ...task("T1"), testFirst: true };

    await runBuildRun(harness, waveArgs([[testFirst]]));

    expect(labelsFor(harness, "T1")).not.toContain("test:T1");
  });

  it("pins every agent to the worktree root", async () => {
    const harness = makeHarness({ queue: { "verify:T1": [VERIFY_FAILS] } });

    await runBuildRun(harness, waveArgs([[task("T1"), task("T2")]]));

    const unpinned = harness.calls
      .filter((call) => !call.prompt.includes(WORK_ROOT))
      .map((call) => call.label);
    expect(unpinned).toEqual([]);
  });

  it("tells the verifier where the app is already running", async () => {
    const harness = makeHarness();

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    const verify = harness.calls.find((call) => call.label === "verify:T1");
    expect(verify?.prompt).toContain(DEV_URL);
  });

  it("tells the verifier to verify programmatically when there is no dev server", async () => {
    const harness = makeHarness();

    await runBuildRun(harness, waveArgs([[task("T1")]], { devUrl: null }));

    const verify = harness.calls.find((call) => call.label === "verify:T1");
    expect(verify?.prompt).toContain("no dev server");
  });
});

// These two are REGRESSION GUARDS on the workflow runtime's sandbox rather than
// behavior slices: the runtime offers no clock, no randomness and no Node APIs,
// and it reads `meta` statically before the script ever runs — so a violation
// cannot be caught by driving the script, only by inspecting it.
describe("the build run — the workflow runtime's constraints", () => {
  it("declares a meta the runtime can read with nothing bound", () => {
    const source = SCRIPT.slice(SCRIPT.indexOf("const meta ="));
    const lines = source.split("\n");
    const closes = lines.findIndex((line) => line === "}" || line === "};");
    const literal = lines
      .slice(0, closes + 1)
      .join("\n")
      .replace("const meta =", "");
    const evaluate = new Function(
      ...RUNTIME_GLOBALS,
      `return (${literal});`
    ) as unknown as (...deps: unknown[]) => Record<string, unknown>;

    const meta = evaluate(...RUNTIME_GLOBALS.map(() => undefined));

    expect(typeof meta.name).toBe("string");
    // No declared phases: a phase the run never enters renders as a dead
    // "0 agents" row, so every group is opened at runtime by the wave loop.
    expect(meta.phases).toBeUndefined();
  });

  it("uses no clock, randomness or Node API", () => {
    const forbidden = [
      "Date.now(",
      "new Date()",
      "Math.random(",
      "require(",
      "import(",
      "process.",
      "node:",
    ];
    const used = forbidden.filter((token) => SCRIPT.includes(token));
    expect(used).toEqual([]);
  });
});
