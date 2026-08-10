import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKFLOW_RECIPE } from "./workflow-recipe.ts";

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
//    `loops`) and the `{ results, telemetry }` wrapper are the task spec's own
//    literals.
//  - Every log line asserted is the spec's literal template with this file's
//    fixture ids substituted: `"<id> ⊘ blocked — depends on <blocker>
//    (<blocker status>)"`, `"Wave 1/2 done: 2 ✓ · 1 needs-human · 0 ⊘"`,
//    `"T4: verify ✗ (findings) — outer loop 2/2"`, `"T4 ✓ verified —
//    … (2 loops)"`, `"T5 ✗ needs-human — <reason>"`.
//  - The `phase()` title format `Wave <n>/<total>` is the spec's decision 2.
//  - The `needs-human` reasons (`verifier returned an invalid failure verdict`,
//    `verify never passed within retries`) and MAX_OUTER 2 are the policy's
//    literals, which the spec freezes byte-for-byte.
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
const EXECUTE_SKILL = resolve(REPO_ROOT, "plugin/skills/execute/SKILL.md");

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

describe("the execute coordinator — live status", () => {
  it("leaves live reporting to the Workflow run without a monitor relay", () => {
    const skill = readFileSync(EXECUTE_SKILL, "utf8");

    expect(skill).toContain("the ONLY live-status surface");
    expect(skill).toContain("Do NOT invoke `Monitor`");
    expect(skill).not.toContain("Set up ONE quiet background watcher");
    expect(skill).not.toContain("Relay the run in BATCHES");
  });
});

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
  effort?: string;
  label: string;
  model?: string;
  phase?: string;
  schema?: unknown;
}

interface AgentCall {
  agentType: string;
  effort: string | undefined;
  label: string;
  model: string | undefined;
  /** the phase group the runtime files this agent under */
  phase: string | undefined;
  prompt: string;
  schema: unknown;
}

interface AgentPlan {
  /** label -> the same canned answer every time it is dispatched */
  always?: Record<string, AgentResult>;
  /** label -> hold the answer until this settles (used to observe ordering) */
  gate?: Record<string, Promise<void>>;
  /** label -> canned answers in order; the default answer resumes after */
  queue?: Record<string, AgentResult[]>;
  /** labels whose agent invocation throws instead of returning structured output */
  throws?: string[];
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
  limitExhausted?: boolean;
  loops?: number;
  reason?: string;
  retries?: number;
  status: string;
  verification?: string;
  workLog?: string;
}

interface WorkflowTelemetry {
  events: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

// A worker answers in the shape its schema declares: the verifier (and the
// exceptional safety reviewer) a VERDICT, everyone else a work-log entry.
function defaultResult(role: string, id: string): AgentResult {
  if (role === "review") {
    return { findings: "", pass: true, testFindings: "" };
  }
  if (role === "verify") {
    return {
      evidence: `${id} behaves as its verify recipe describes`,
      failureKind: "none",
      findings: "",
      pass: true,
      testFindings: "",
      verificationKind: "mechanically-proven",
    };
  }
  return {
    blocker: "",
    status: "completed",
    workLog: `${role} log for ${id}`,
  };
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
      effort: options?.effort,
      label,
      model: options?.model,
      phase: options?.phase,
      prompt,
      schema: options?.schema,
    });
    const gate = plan.gate?.[label];
    if (gate) {
      await gate;
    }
    if (plan.throws?.includes(label)) {
      throw new Error(`agent runtime failed for ${label}`);
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

function telemetryOf(returned: unknown): WorkflowTelemetry {
  const telemetry = (returned as { telemetry?: unknown })?.telemetry;
  if (
    typeof telemetry !== "object" ||
    telemetry === null ||
    !Array.isArray((telemetry as WorkflowTelemetry).events) ||
    typeof (telemetry as WorkflowTelemetry).summary !== "object"
  ) {
    throw new Error(
      `the build run must return telemetry — got ${JSON.stringify(returned)}`
    );
  }
  return telemetry as WorkflowTelemetry;
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
    workflowRecipe: WORKFLOW_RECIPE,
    workRoot: WORK_ROOT,
    ...extra,
  };
}

// A verdict that never passes — the only way to force a terminal `needs-human`.
const VERIFY_FAILS = {
  evidence: "saved value was absent after the prescribed interaction",
  failureKind: "code",
  findings: "the saved value never appears",
  pass: false,
  testFindings: "",
  verificationKind: "model-judged",
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
      workflowRecipe: WORKFLOW_RECIPE,
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

  it("refuses a missing recipe before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(harness, {
      devUrl: DEV_URL,
      hasTestSuite: false,
      waves: [[task("T1")]],
      workRoot: WORK_ROOT,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/workflowRecipe/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses a missing workRoot before any agent", async () => {
    const harness = makeHarness();
    const input = {
      devUrl: DEV_URL,
      hasTestSuite: false,
      waves: [[task("T1")]],
      workflowRecipe: WORKFLOW_RECIPE,
    };

    const failure = await runBuildRun(harness, input).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/workRoot.*absolute/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses a relative workRoot before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(
      harness,
      waveArgs([[task("T1")]], { workRoot: ".claude/worktrees/T1" })
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/workRoot.*absolute/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses a missing hasTestSuite verdict before any agent", async () => {
    const harness = makeHarness();
    const input = {
      devUrl: DEV_URL,
      waves: [[task("T1")]],
      workflowRecipe: WORKFLOW_RECIPE,
      workRoot: WORK_ROOT,
    };

    const failure = await runBuildRun(harness, input).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/hasTestSuite.*boolean/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses a non-boolean hasTestSuite verdict before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(
      harness,
      waveArgs([[task("T1")]], { hasTestSuite: "false" })
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/hasTestSuite.*boolean/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses a recipe identity other than baseline-v1 before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(
      harness,
      waveArgs([[task("T1")]], {
        workflowRecipe: { ...WORKFLOW_RECIPE, id: "critical" },
      })
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/workflowRecipe/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses an incorrect baseline-v1 fingerprint before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(
      harness,
      waveArgs([[task("T1")]], {
        workflowRecipe: {
          ...WORKFLOW_RECIPE,
          fingerprint: "fnv1a32:00000000",
        },
      })
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/fingerprint/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses role-policy drift under a stale fingerprint before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(
      harness,
      waveArgs([[task("T1")]], {
        workflowRecipe: {
          ...WORKFLOW_RECIPE,
          roles: {
            ...WORKFLOW_RECIPE.roles,
            reviewer: {
              ...WORKFLOW_RECIPE.roles.reviewer,
              model: "claude-sonnet-5",
            },
          },
        },
      })
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/fingerprint/i);
    expect(harness.calls).toEqual([]);
  });

  it("refuses recipe-limit drift under a stale fingerprint before any agent", async () => {
    const harness = makeHarness();

    const failure = await runBuildRun(
      harness,
      waveArgs([[task("T1")]], {
        workflowRecipe: {
          ...WORKFLOW_RECIPE,
          limits: { ...WORKFLOW_RECIPE.limits, maxOuter: 3 },
        },
      })
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/fingerprint/i);
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

  it("never starts more tasks than maxConcurrency inside one wave", async () => {
    const first = deferred();
    const second = deferred();
    const harness = makeHarness({
      gate: { "impl:T1": first.promise, "impl:T2": second.promise },
    });

    const running = startBuildRun(
      harness,
      waveArgs([[task("T1"), task("T2"), task("T3")]])
    );
    await flush();
    const firstBatch = harness.calls.map((call) => call.label);
    first.release();
    second.release();
    await running;

    expect(firstBatch).toContain("impl:T1");
    expect(firstBatch).toContain("impl:T2");
    expect(firstBatch).not.toContain("impl:T3");
    expect(labelsFor(harness, "T3")).toContain("impl:T3");
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
  // T1's first verification comes back with actionable findings, then passes;
  // T2 sails through. This is the only normal correction loop.
  const verifyFailsOnce = () => ({
    queue: { "verify:T1": [VERIFY_FAILS] },
  });

  it("logs a retry line when verification returns actionable findings", async () => {
    const harness = makeHarness(verifyFailsOnce());

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(lineWith(harness, "T1: verify ✗")).toContain("outer loop 2/2");
  });

  it("narrates later milestones only for the task that failed verification", async () => {
    const harness = makeHarness(verifyFailsOnce());

    await runBuildRun(harness, waveArgs([[task("T1"), task("T2")]]));

    // T2 never failed: its only line is its terminal one.
    expect(linesFor(harness, "T2")).toHaveLength(1);
    // T1 escalated: retry, second implementation milestone, verify milestone,
    // and terminal line. The first implementation happened before it was loud.
    expect(linesFor(harness, "T1").length).toBeGreaterThanOrEqual(4);
  });

  it("restarts the outer loop after a failed verify and reports the loops used", async () => {
    const harness = makeHarness({ queue: { "verify:T1": [VERIFY_FAILS] } });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(lineWith(harness, "T1: verify ✗")).toContain("outer loop 2/2");
    expect(resultFor(returned, "T1")).toMatchObject({
      loops: 2,
      status: "done",
    });
  });

  it("flags a task needs-human when verify never passes within the caps", async () => {
    const harness = makeHarness({ always: { "verify:T1": VERIFY_FAILS } });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({
      loops: 2,
      reason: "verify never passed within retries",
      status: "needs-human",
    });
  });

  it("does not re-implement when a verifier returns an invalid failure verdict", async () => {
    const harness = makeHarness({
      always: {
        "verify:T1": {
          evidence: "the verifier could not classify an observed result",
          failureKind: "none",
          findings: "",
          pass: false,
          testFindings: "",
          verificationKind: "not-available",
        },
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "verify:T1"]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      loops: 1,
      reason: "verifier returned an invalid failure verdict",
      status: "needs-human",
    });
  });

  it.each([
    {
      evidence: "",
      findings: "",
      label: "empty evidence",
      verificationKind: "mechanically-proven",
    },
    {
      evidence: "the required proof surface was unavailable",
      findings: "",
      label: "unavailable proof",
      verificationKind: "not-available",
    },
    {
      evidence: "the recipe passed but exposed a contradictory defect",
      findings: "the observed output still violates the spec",
      label: "a non-empty finding",
      verificationKind: "mechanically-proven",
    },
  ])("rejects a passing verifier verdict with $label", async (verdict) => {
    const harness = makeHarness({
      always: {
        "verify:T1": {
          evidence: verdict.evidence,
          failureKind: "none",
          findings: verdict.findings,
          pass: true,
          testFindings: "",
          verificationKind: verdict.verificationKind,
        },
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "verify:T1"]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason: "verifier returned an incoherent pass verdict",
      status: "needs-human",
    });
  });

  it("does not dispatch a writer for an environment verification failure", async () => {
    const harness = makeHarness({
      always: {
        "verify:T1": {
          evidence: "the prepared browser session showed an expired login",
          failureKind: "environment",
          findings: "authenticate the prepared browser surface again",
          pass: false,
          testFindings: "",
          verificationKind: "not-available",
        },
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "verify:T1"]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "verification blocked by environment: authenticate the prepared browser surface again",
      status: "needs-human",
    });
  });

  it("does not dispatch a writer when verification requires human judgment", async () => {
    const harness = makeHarness({
      always: {
        "verify:T1": {
          evidence: "the task asks whether the interaction feels delightful",
          failureKind: "needs-human",
          findings: "a human must judge the subjective interaction quality",
          pass: false,
          testFindings: "",
          verificationKind: "not-available",
        },
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "verify:T1"]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "verification requires human judgment: a human must judge the subjective interaction quality",
      status: "needs-human",
    });
  });

  it("allows one correction and mandatory re-verification, never a terminal fix", async () => {
    const harness = makeHarness({ always: { "verify:T1": VERIFY_FAILS } });

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    const labels = labelsFor(harness, "T1");
    expect(labels).toEqual(["impl:T1", "verify:T1", "impl:T1", "verify:T1"]);
    expect(labels.at(-1)).toBe("verify:T1");
  });

  it("routes verifier test findings to the test-author, propagates the extension, then re-verifies", async () => {
    const testFirst = { ...task("T1"), testFirst: true };
    const verificationFailure = {
      evidence: "the empty-case exercise exposed both gaps",
      failureKind: "test-contract",
      findings: "the implementation misses the empty case",
      pass: false,
      testFindings: "add coverage for the empty case",
      verificationKind: "model-judged",
    };
    const harness = makeHarness({
      queue: { "verify:T1": [verificationFailure] },
    });

    await runBuildRun(
      harness,
      waveArgs([[testFirst]], {
        hasTestSuite: true,
      })
    );

    const labels = labelsFor(harness, "T1");
    expect(labels).toEqual([
      "test:T1",
      "impl:T1",
      "verify:T1",
      "test-fix:T1",
      "impl:T1",
      "verify:T1",
    ]);
    const implementors = harness.calls.filter(
      (call) => call.label === "impl:T1"
    );
    expect(implementors[1]?.prompt).toContain(
      "Verifier-requested test-contract extension"
    );
    expect(implementors[1]?.prompt).toContain("test-fix log for T1");
    expect(implementors[1]?.prompt).toContain(
      "add coverage for the empty case"
    );
    expect(labels.at(-1)).toBe("verify:T1");
  });

  it("never extends the test contract after the final verifier failure", async () => {
    const testFirst = { ...task("T1"), testFirst: true };
    const harness = makeHarness({
      always: {
        "verify:T1": {
          evidence:
            "the empty case still fails after the second implementation",
          failureKind: "test-contract",
          findings: "implementation still misses the empty case",
          pass: false,
          testFindings: "add empty-case coverage",
          verificationKind: "mechanically-proven",
        },
      },
    });

    const returned = await runBuildRun(
      harness,
      waveArgs([[testFirst]], { hasTestSuite: true })
    );

    const labels = labelsFor(harness, "T1");
    expect(labels.filter((label) => label === "test-fix:T1")).toHaveLength(1);
    expect(labels.at(-1)).toBe("verify:T1");
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: true,
      status: "needs-human",
    });
  });

  it("routes test findings to the implementor when no authored contract exists", async () => {
    const harness = makeHarness({
      queue: {
        "verify:T1": [
          {
            evidence:
              "the regression suite has no assertion for the empty case",
            failureKind: "test-contract",
            findings: "",
            pass: false,
            testFindings: "add a regression test for the empty case",
            verificationKind: "mechanically-proven",
          },
        ],
      },
    });

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual([
      "impl:T1",
      "verify:T1",
      "impl:T1",
      "verify:T1",
    ]);
    expect(
      harness.calls.filter((call) => call.label === "impl:T1")[1]?.prompt
    ).toContain("add a regression test for the empty case");
    expect(labelsFor(harness, "T1")).not.toContain("test-fix:T1");
  });

  it("stops outer retries at baseline-v1's maxOuter", async () => {
    const harness = makeHarness({ always: { "verify:T1": VERIFY_FAILS } });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({
      loops: 2,
      status: "needs-human",
    });
    expect(
      labelsFor(harness, "T1").filter((label) => label === "impl:T1")
    ).toHaveLength(2);
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

  it("safety-reviews the scoped diff when the test-author returns no work log", async () => {
    const harness = makeHarness({ always: { "test:T1": null } });
    const testFirst = { ...task("T1"), testFirst: true };

    const returned = await runBuildRun(
      harness,
      waveArgs([[testFirst]], { hasTestSuite: true })
    );

    expect(labelsFor(harness, "T1")).toEqual(["test:T1", "review:T1"]);
    expect(harness.calls.at(-1)?.prompt).toContain("SAFETY REVIEW ONLY");
    expect(telemetryOf(returned).events.map((event) => event.stage)).toEqual([
      "test-author",
      "safety-review",
    ]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      loops: 0,
      reason:
        "test-author returned no valid writer result; safety review passed",
      status: "needs-human",
    });
  });

  it("stops before implementation when the test-author reports a coherent blocker", async () => {
    const harness = makeHarness({
      always: {
        "test:T1": {
          blocker: "the spec does not define the public seam",
          status: "blocked",
          workLog: "No files changed; the interface is undefined.",
        },
      },
    });
    const testFirst = { ...task("T1"), testFirst: true };

    const returned = await runBuildRun(
      harness,
      waveArgs([[testFirst]], { hasTestSuite: true })
    );

    expect(labelsFor(harness, "T1")).toEqual(["test:T1"]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      loops: 0,
      reason: "test-author blocked: the spec does not define the public seam",
      status: "needs-human",
      workLog: "No files changed; the interface is undefined.",
    });
  });

  it("safety-reviews the scoped diff when the implementor returns no work log", async () => {
    const harness = makeHarness({ always: { "impl:T1": null } });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "review:T1"]);
    expect(harness.calls.at(-1)?.prompt).toContain("SAFETY REVIEW ONLY");
    expect(telemetryOf(returned).events.map((event) => event.stage)).toEqual([
      "implement",
      "safety-review",
    ]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      loops: 1,
      reason:
        "implementor returned no valid writer result; safety review passed",
      status: "needs-human",
    });
  });

  it("stops before verification when the implementor reports a coherent blocker", async () => {
    const harness = makeHarness({
      always: {
        "impl:T1": {
          blocker: "the required generated client cannot be produced offline",
          status: "blocked",
          workLog: "No files changed; generation could not start.",
        },
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1"]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      loops: 1,
      reason:
        "implementor blocked: the required generated client cannot be produced offline",
      status: "needs-human",
      workLog: "No files changed; generation could not start.",
    });
    expect(telemetryOf(returned).events).toMatchObject([
      { outcome: "blocked", stage: "implement" },
    ]);
  });

  it("safety-reviews the scoped diff when a test-contract fix returns no work log", async () => {
    const harness = makeHarness({
      always: {
        "test-fix:T1": null,
      },
      queue: {
        "verify:T1": [
          {
            evidence: "the empty-case exercise exposed both gaps",
            failureKind: "test-contract",
            findings: "implementation misses the empty case",
            pass: false,
            testFindings: "add empty-case coverage",
            verificationKind: "mechanically-proven",
          },
        ],
      },
    });
    const testFirst = { ...task("T1"), testFirst: true };

    const returned = await runBuildRun(
      harness,
      waveArgs([[testFirst]], { hasTestSuite: true })
    );

    expect(labelsFor(harness, "T1")).toEqual([
      "test:T1",
      "impl:T1",
      "verify:T1",
      "test-fix:T1",
      "review:T1",
    ]);
    expect(harness.calls.at(-1)?.prompt).toContain("SAFETY REVIEW ONLY");
    expect(telemetryOf(returned).events.at(-1)?.stage).toBe("safety-review");
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "test-author fix returned no valid writer result; safety review passed",
      status: "needs-human",
    });
  });

  it("safety-reviews the scoped diff when a code fix returns no work log", async () => {
    const harness = makeHarness({
      queue: {
        "impl:T1": [
          {
            blocker: "",
            status: "completed",
            workLog: "initial implementation",
          },
          null,
        ],
        "verify:T1": [VERIFY_FAILS],
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual([
      "impl:T1",
      "verify:T1",
      "impl:T1",
      "review:T1",
    ]);
    expect(harness.calls.at(-1)?.prompt).toContain("SAFETY REVIEW ONLY");
    expect(telemetryOf(returned).events.at(-1)?.stage).toBe("safety-review");
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "implementor returned no valid writer result; safety review passed",
      status: "needs-human",
    });
  });

  it("normalizes a thrown test-author call into a safety review and needs-human", async () => {
    const harness = makeHarness({ throws: ["test:T1"] });
    const testFirst = { ...task("T1"), testFirst: true };

    const returned = await runBuildRun(
      harness,
      waveArgs([[testFirst]], { hasTestSuite: true })
    );

    expect(labelsFor(harness, "T1")).toEqual(["test:T1", "review:T1"]);
    expect(telemetryOf(returned).events).toMatchObject([
      { outcome: "error", stage: "test-author" },
      { outcome: "passed", stage: "safety-review" },
    ]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "test-author returned no valid writer result; safety review passed",
      status: "needs-human",
    });
  });

  it("normalizes a thrown implementor call into a safety review and needs-human", async () => {
    const harness = makeHarness({ throws: ["impl:T1"] });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "review:T1"]);
    expect(telemetryOf(returned).events).toMatchObject([
      { outcome: "error", stage: "implement" },
      { outcome: "passed", stage: "safety-review" },
    ]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "implementor returned no valid writer result; safety review passed",
      status: "needs-human",
    });
  });

  it("normalizes a thrown test-contract fixer into a safety review and needs-human", async () => {
    const harness = makeHarness({
      queue: {
        "verify:T1": [
          {
            evidence: "the empty-case exercise exposed both gaps",
            failureKind: "test-contract",
            findings: "implementation misses the empty case",
            pass: false,
            testFindings: "add empty-case coverage",
            verificationKind: "mechanically-proven",
          },
        ],
      },
      throws: ["test-fix:T1"],
    });
    const testFirst = { ...task("T1"), testFirst: true };

    const returned = await runBuildRun(
      harness,
      waveArgs([[testFirst]], { hasTestSuite: true })
    );

    expect(labelsFor(harness, "T1")).toEqual([
      "test:T1",
      "impl:T1",
      "verify:T1",
      "test-fix:T1",
      "review:T1",
    ]);
    expect(telemetryOf(returned).events.slice(-2)).toMatchObject([
      { outcome: "error", stage: "test-fix" },
      { outcome: "passed", stage: "safety-review" },
    ]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "test-author fix returned no valid writer result; safety review passed",
      status: "needs-human",
    });
  });

  it("keeps needs-human when the safety reviewer itself returns no result", async () => {
    const harness = makeHarness({
      always: {
        "impl:T1": null,
        "review:T1": null,
      },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "review:T1"]);
    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      reason:
        "implementor returned no valid writer result; safety review returned no result",
      status: "needs-human",
    });
  });

  /*
   * A write-capable agent can mutate the worktree before losing structured
   * output. The slices above freeze the fail-closed contract: every writer null
   * or throw gets one exceptional read-only reviewer call, and no fixer follows.
   */
});

describe("the build run — the per-task state machine it wraps", () => {
  it("receives model policy through workflowRecipe without a second model table", () => {
    expect(SCRIPT).not.toMatch(/claude-(?:fable|opus|sonnet)-5/);
    expect(SCRIPT).not.toContain("STANDARD_ROLES");
  });

  it("passes baseline-v1 model and effort to each native Workflow agent call", async () => {
    const harness = makeHarness();

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(
      harness.calls.find((call) => call.label === "impl:T1")
    ).toMatchObject({ effort: "high", model: "claude-sonnet-5" });
    expect(
      harness.calls.find((call) => call.label === "verify:T1")
    ).toMatchObject({ effort: "medium", model: "claude-sonnet-5" });
  });

  it("runs a normal successful task as implement then verify, with no reviewer", async () => {
    const harness = makeHarness();

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "verify:T1"]);
    expect(
      harness.calls.some((call) => call.agentType === "dobby:reviewer")
    ).toBe(false);
  });

  it("dispatches the test-author first when the repo has a suite and the task is test-first", async () => {
    const harness = makeHarness();
    const testFirst = { ...task("T1"), testFirst: true };

    await runBuildRun(harness, waveArgs([[testFirst]], { hasTestSuite: true }));

    expect(labelsFor(harness, "T1")).toEqual([
      "test:T1",
      "impl:T1",
      "verify:T1",
    ]);
    expect(harness.calls[0]?.agentType).toBe("dobby:test-author");
  });

  it("never dispatches the test-author when the repo has no suite", async () => {
    const harness = makeHarness();
    const testFirst = { ...task("T1"), testFirst: true };

    await runBuildRun(harness, waveArgs([[testFirst]]));

    expect(labelsFor(harness, "T1")).toEqual(["impl:T1", "verify:T1"]);
  });

  it("pins every agent to the worktree root", async () => {
    const harness = makeHarness({ queue: { "verify:T1": [VERIFY_FAILS] } });

    await runBuildRun(harness, waveArgs([[task("T1"), task("T2")]]));

    const unpinned = harness.calls
      .filter((call) => !call.prompt.includes(WORK_ROOT))
      .map((call) => call.label);
    expect(unpinned).toEqual([]);
  });

  it("shell-quotes a worktree root containing spaces and an apostrophe", async () => {
    const harness = makeHarness();
    const trickyRoot = "/private/tmp/dobby's build run/work tree";
    const safeCd = "cd -- '/private/tmp/dobby'\"'\"'s build run/work tree'";

    await runBuildRun(
      harness,
      waveArgs([[task("T1")]], { workRoot: trickyRoot })
    );

    expect(harness.calls.every((call) => call.prompt.includes(safeCd))).toBe(
      true
    );
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

  it("passes suite and fixed-contract facts explicitly to a UI verifier", async () => {
    const harness = makeHarness();
    const testFirst = { ...task("T1"), testFirst: true };

    await runBuildRun(harness, waveArgs([[testFirst]], { hasTestSuite: true }));

    const verify = harness.calls.find((call) => call.label === "verify:T1");
    expect(verify?.prompt).toContain("hasTestSuite: true");
    expect(verify?.prompt).toContain("testContractAuthored: true");
    expect(verify?.prompt).toContain(
      "Run the project test suite for EVERY task type, including UI-facing tasks"
    );
  });

  it("requires the complete fail-closed verifier and writer schemas", async () => {
    const harness = makeHarness();

    await runBuildRun(harness, waveArgs([[task("T1")]]));

    const implementorSchema = harness.calls.find(
      (call) => call.label === "impl:T1"
    )?.schema as { required?: string[] };
    const verifierSchema = harness.calls.find(
      (call) => call.label === "verify:T1"
    )?.schema as { required?: string[] };
    expect(implementorSchema.required).toEqual([
      "status",
      "workLog",
      "blocker",
    ]);
    expect(verifierSchema.required).toEqual([
      "pass",
      "failureKind",
      "findings",
      "testFindings",
      "evidence",
      "verificationKind",
    ]);
  });
});

describe("the build run — honest native telemetry", () => {
  it("returns one event per native agent call with unavailable runtime data explicit", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));
    const telemetry = telemetryOf(returned);

    expect(telemetry.events).toHaveLength(harness.calls.length);
    expect(telemetry.events.map((event) => event.role)).toEqual([
      "implementor",
      "verifier",
    ]);
    for (const event of telemetry.events) {
      expect(event).toMatchObject({
        cachedInputTokens: "unknown",
        duration: "unknown",
        host: "claude-code",
        inputTokens: "unknown",
        model: "unknown",
        outputTokens: "unknown",
        provider: "unknown",
        recipe: "baseline-v1",
        recipeFingerprint: WORKFLOW_RECIPE.fingerprint,
        requestedModel: "claude-sonnet-5",
        runId: "unknown",
        taskId: "T1",
      });
    }
  });

  it("summarizes first-attempt success and mechanical proof", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: false,
      retries: 0,
      verification: "mechanically-proven",
    });
    expect(telemetryOf(returned).summary).toMatchObject({
      attempts: 2,
      firstAttemptSuccess: 1,
      firstAttemptSuccessRate: 1,
      limitExhaustions: 0,
      retries: 0,
      tasksAttempted: 1,
      verification: {
        "mechanically-proven": 1,
        "model-judged": 0,
        "not-available": 0,
      },
    });
  });

  it("counts same-role correction calls as retries", async () => {
    const harness = makeHarness({
      queue: { "verify:T1": [VERIFY_FAILS] },
    });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({ retries: 2 });
    expect(telemetryOf(returned).summary).toMatchObject({
      attempts: 4,
      firstAttemptSuccess: 0,
      retries: 2,
    });
  });

  it("records no dynamic escalation under the fixed recipe", async () => {
    const harness = makeHarness();

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));
    const telemetry = telemetryOf(returned);

    expect(
      telemetry.events.every((event) => event.escalationReason === null)
    ).toBe(true);
  });

  it("reports verification-cap exhaustion without manufacturing proof", async () => {
    const harness = makeHarness({ always: { "verify:T1": VERIFY_FAILS } });

    const returned = await runBuildRun(harness, waveArgs([[task("T1")]]));

    expect(resultFor(returned, "T1")).toMatchObject({
      limitExhausted: true,
      verification: "not-available",
    });
    expect(telemetryOf(returned).summary).toMatchObject({
      limitExhaustions: 1,
      verification: { "not-available": 1 },
    });
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
