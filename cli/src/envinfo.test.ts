import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  restoreEnv,
  useSpawnBudget,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// THE ENV SNAPSHOT AFTER THE FIXED RECIPE IS RETIRED.
//
// Task contract: `cli/src/workflow-recipe.ts` (and its suite) is DELETED and
// `dobby env` stops reporting `workflowRecipe`. Agent model/effort survive ONLY
// in each agent's frontmatter — the surface a direct dispatch already reads.
//
// The seam under test is the PUBLIC one: `run(argv, cwd) -> {exitCode, stdout,
// stderr}`, exercised in-process against a throwaway git repo. `envinfo.ts` is
// never imported here (the repo's standing convention for env behavior), so an
// internal restructure of the snapshot assembly cannot break these tests —
// only a change to what `dobby env` REPORTS can.
//
// Where every expected value comes from (all independent of any implementation):
//  - the ABSENCE of `workflowRecipe`, `baseline-v1` and the policy fingerprint
//    is the spec stated outright ("stop `dobby env` reporting `workflowRecipe`");
//  - the surviving key set is `cli/CONTEXT.md`'s documented `EnvSnapshot` list
//    (cmux, worktree, branch, capabilities, config, dbTasks, devUrl, runPane,
//    browserPane) MINUS the one key this task retires, PLUS `browserGuide`
//    (task 6, "ship the verification protocol inside the CLI", landed since);
//  - `branch`/`worktree` are the branch name and temp dir THIS suite created;
//  - `capabilities` are the glossary's fixed signal map (`drizzle-orm` →
//    `drizzle`, `vitest` → `vitest`) applied to a package.json written here;
//  - `config: true` / `devUrl: null` are the spec's literal env contract (no
//    vite capability, no portless in CI);
//  - the agent model/effort pins are the values CLAUDE.md fixes per role
//    (researcher Sonnet/medium, test-author Opus/high, implementor Sonnet/high,
//    reviewer Opus/high, qa Sonnet/medium — the verifier agent was renamed to
//    `dobby:qa`, so its frontmatter now lives at `plugin/agents/qa.md`).
// ---------------------------------------------------------------------------

useSpawnBudget();

const CMUX = "CMUX_WORKSPACE_ID";
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "..", "..");
const SELF = basename(fileURLToPath(import.meta.url));

const scratchDirs: string[] = [];
const originalCmux = process.env[CMUX];

// One project fixture, reused: a real git repo on a branch WE name, declaring
// exactly two capability signals, with a valid dobby.config.json at its root.
const project = makeScratchRepo({
  branch: "dobby-env-recipe",
  config: { files: [] },
  pkg: {
    dependencies: { "drizzle-orm": "^0.30.0" },
    devDependencies: { vitest: "^2.0.0" },
    name: "scratch-env-recipe",
  },
  prefix: "dobby-envinfo-",
  track: scratchDirs,
});

// No ambient cmux pane may leak into the snapshot.
beforeEach(() => {
  delete process.env[CMUX];
});

afterAll(() => {
  restoreEnv(CMUX, originalCmux);
  cleanupDirs(scratchDirs);
});

// --- Slice 1 (tracer bullet): the JSON payload drops the recipe -------------
// The headline behavior of this task, and the surface every consumer reads.
describe("dobby env --json — the workflow recipe is no longer reported", () => {
  it("omits the workflowRecipe key from the snapshot payload", async () => {
    const result = await run(["env", "--json"], project);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("workflowRecipe");
  });

  it("carries exactly the ten surviving environment facts and nothing else", async () => {
    const result = await run(["env", "--json"], project);

    expect(Object.keys(JSON.parse(result.stdout)).sort()).toEqual([
      "branch",
      "browserGuide",
      "browserPane",
      "capabilities",
      "cmux",
      "config",
      "dbTasks",
      "devUrl",
      "runPane",
      "worktree",
    ]);
  });

  it("reports no recipe identity, fingerprint, role pin, or concurrency cap under any key", async () => {
    const result = await run(["env", "--json"], project);

    // Renaming the key rather than deleting the data must not pass: the recipe's
    // own values are what may never appear again.
    expect(result.stdout).not.toMatch(/baseline-v1|fingerprint|fnv1a32/i);
    expect(result.stdout).not.toMatch(/maxConcurrency|maxOuter|reasoning/i);
    expect(result.stdout).not.toMatch(/claude-opus-5|claude-sonnet-5/i);
  });
});

// --- Slice 2: the human snapshot drops the recipe lines ---------------------
describe("dobby env — the workflow recipe is no longer printed", () => {
  it("prints no workflowRecipe line", async () => {
    const result = await run(["env"], project);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("workflowRecipe");
  });

  it("prints no recipe identity, fingerprint, or role model pin", async () => {
    const result = await run(["env"], project);

    expect(result.stdout).not.toMatch(/baseline-v1|fnv1a32/i);
    expect(result.stdout).not.toMatch(/claude-opus-5|claude-sonnet-5/i);
    expect(result.stdout).not.toMatch(/reviewer=|implementor=|verifier=/i);
  });
});

// --- Slice 3: the environment snapshot itself is untouched ------------------
// Removing the recipe must not cost the snapshot any of the facts the kit
// actually navigates with.
describe("dobby env — the environment facts survive the removal", () => {
  it("still reports the project's branch, worktree root, capabilities and config", async () => {
    process.env[CMUX] = "cmux-ws-envinfo";
    const result = await run(["env", "--json"], project);
    const snapshot = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(snapshot.branch).toBe("dobby-env-recipe");
    expect(snapshot.worktree).toBe(project);
    expect([...snapshot.capabilities].sort()).toEqual(["drizzle", "vitest"]);
    expect(snapshot.config).toBe(true);
    expect(snapshot.cmux).toBe("cmux-ws-envinfo");
    expect(snapshot.devUrl).toBe(null);
  });

  it("still prints every snapshot field as a `key: value` line in human form", async () => {
    const result = await run(["env"], project);
    const printed = new Set(
      result.stdout
        .split("\n")
        .filter((line) => line.includes(":"))
        .map((line) => line.slice(0, line.indexOf(":")).trim())
    );

    expect(result.exitCode).toBe(0);
    for (const key of [
      "cmux",
      "worktree",
      "branch",
      "capabilities",
      "config",
      "devUrl",
    ]) {
      expect(printed.has(key), `missing field: ${key}`).toBe(true);
    }
  });
});

// --- Slice 4: the module itself is gone -------------------------------------
// The spec deletes the file, not just its use: a dormant recipe module left on
// disk is a second source of truth waiting to be re-imported.
describe("cli/src — the fixed recipe module is retired", () => {
  it("no longer ships workflow-recipe.ts or its suite", () => {
    expect(existsSync(join(SRC_DIR, "workflow-recipe.ts"))).toBe(false);
    expect(existsSync(join(SRC_DIR, "workflow-recipe.test.ts"))).toBe(false);
  });

  it("leaves no module in cli/src importing the deleted recipe", () => {
    // Any module specifier naming the file — a static import, a re-export, or a
    // dynamic one — whatever line breaks it is spread across.
    const importers = readdirSync(SRC_DIR)
      .filter((name) => name.endsWith(".ts") && name !== SELF)
      .filter((name) =>
        /["'][^"']*workflow-recipe[^"']*["']/.test(
          readFileSync(join(SRC_DIR, name), "utf8")
        )
      );

    expect(importers).toEqual([]);
  });
});

// --- Slice 5: model and effort survive in agent frontmatter -----------------
// The recipe was the second home for these values; the spec keeps only the
// first. This is the drift guard the deleted suite used to carry, restated
// against the surviving surface alone.
describe("agent frontmatter — the sole home of model and effort", () => {
  const pins = {
    implementor: { effort: "high", model: "claude-sonnet-5" },
    qa: { effort: "medium", model: "claude-sonnet-5" },
    researcher: { effort: "medium", model: "claude-sonnet-5" },
    reviewer: { effort: "high", model: "claude-opus-5" },
    "test-author": { effort: "high", model: "claude-opus-5" },
  };

  it("pins each of the five canonical agents to its model and effort", () => {
    const agentDir = join(REPO_ROOT, "plugin", "agents");

    for (const [agent, pin] of Object.entries(pins)) {
      const frontmatter =
        readFileSync(join(agentDir, `${agent}.md`), "utf8").split("---")[1] ??
        "";
      expect(frontmatter, agent).toMatch(
        new RegExp(`^model: ${pin.model}$`, "m")
      );
      expect(frontmatter, agent).toMatch(
        new RegExp(`^effort: ${pin.effort}$`, "m")
      );
    }
  });
});
