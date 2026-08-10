import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import { resolveWorkflowRecipe, WORKFLOW_RECIPE } from "./workflow-recipe.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dobby-workflow-recipe-"));
  tempRoots.push(root);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "workflow-recipe-fixture", private: true })}\n`
  );
  return root;
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("resolveWorkflowRecipe() — fixed baseline", () => {
  it("returns the exact deterministic baseline-v1 recipe", () => {
    expect(resolveWorkflowRecipe()).toEqual({
      capabilities: {
        effortPerWorkflowInvocation: true,
        modelPerWorkflowInvocation: true,
        sameRoleBuildThreadReuse: false,
      },
      fingerprint: "fnv1a32:32afa935",
      id: "baseline-v1",
      limits: { maxConcurrency: 2, maxOuter: 2 },
      roles: {
        implementor: { model: "claude-sonnet-5", reasoning: "high" },
        researcher: { model: "claude-sonnet-5", reasoning: "medium" },
        reviewer: { model: "claude-opus-5", reasoning: "high" },
        "test-author": { model: "claude-opus-5", reasoning: "high" },
        verifier: { model: "claude-sonnet-5", reasoning: "medium" },
      },
      verification: "mechanical-first",
    });
  });

  it("keeps the exact fingerprint deterministic across defensive clones", () => {
    const first = resolveWorkflowRecipe();
    const second = resolveWorkflowRecipe();

    expect(first.fingerprint).toBe("fnv1a32:32afa935");
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first).not.toBe(second);
    expect(first.capabilities).not.toBe(second.capabilities);
    expect(first.limits).not.toBe(second.limits);
    expect(first.roles).not.toBe(second.roles);
    expect(first.roles.researcher).not.toBe(second.roles.researcher);

    (first.limits as { maxOuter: number }).maxOuter = 99;
    (first.roles.researcher as { model: string }).model = "mutated";
    expect(resolveWorkflowRecipe()).toEqual(WORKFLOW_RECIPE);
  });

  it("does not read STATE.md, project config, or former environment overrides", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "STATE.md"),
      "# Work session: legacy\n\n## Execution profile\nProfile: critical\n"
    );
    writeFileSync(
      join(root, "dobby.config.json"),
      `${JSON.stringify({ workflowBudget: { profile: "economical" } })}\n`
    );
    const prior = process.env.DOBBY_PROFILE;
    process.env.DOBBY_PROFILE = "critical";

    try {
      expect(resolveWorkflowRecipe()).toEqual(WORKFLOW_RECIPE);
    } finally {
      if (prior === undefined) {
        delete process.env.DOBBY_PROFILE;
      } else {
        process.env.DOBBY_PROFILE = prior;
      }
    }
  });
});

describe("dobby env — effective native Workflow recipe", () => {
  it("renders baseline-v1, all roles, and fixed limits as JSON", async () => {
    const result = await run(["env", "--json"], tempRoot());
    const payload = JSON.parse(result.stdout) as Record<string, unknown> & {
      workflowRecipe: typeof WORKFLOW_RECIPE;
    };

    expect(result.exitCode).toBe(0);
    expect(payload.workflowRecipe).toEqual(WORKFLOW_RECIPE);
    expect(payload.workflowRecipe.fingerprint).toBe("fnv1a32:32afa935");
    expect(payload).not.toHaveProperty("workflowBudget");
  });

  it("renders the fixed recipe in human output", async () => {
    const result = await run(["env"], tempRoot());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("workflowRecipe.id: baseline-v1");
    expect(result.stdout).toContain(
      "workflowRecipe.fingerprint: fnv1a32:32afa935"
    );
    expect(result.stdout).toContain("reviewer=claude-opus-5/high");
    expect(result.stdout).not.toContain("workflowBudget");
    expect(result.stdout).not.toContain("profile");
  });

  it("does not expose former budget flags", async () => {
    const root = tempRoot();
    const help = await run([], root);
    const override = await run(["env", "--profile", "economical"], root);

    expect(help.stdout).not.toContain("--profile");
    expect(help.stdout).not.toContain("--max-concurrency");
    expect(help.stdout).not.toContain("--model-<role>");
    expect(override.exitCode).toBe(1);
  });
});

describe("agent frontmatter — recipe drift", () => {
  it("pins exactly the five canonical agents to baseline-v1", () => {
    const agentDir = join(REPO_ROOT, "plugin", "agents");
    const expected = Object.keys(WORKFLOW_RECIPE.roles).sort();
    const actual = readdirSync(agentDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();

    expect(actual).toEqual(expected);
    for (const role of expected) {
      const policy =
        WORKFLOW_RECIPE.roles[role as keyof typeof WORKFLOW_RECIPE.roles];
      const markdown = readFileSync(join(agentDir, `${role}.md`), "utf8");
      const frontmatter = markdown.split("---")[1] ?? "";
      expect(frontmatter).toMatch(new RegExp(`^model: ${policy.model}$`, "m"));
      expect(frontmatter).toMatch(
        new RegExp(`^effort: ${policy.reasoning}$`, "m")
      );
    }
  });
});
