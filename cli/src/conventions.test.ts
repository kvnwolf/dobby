import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanConventions } from "./conventions.ts";
import { run } from "./run.ts";
import { checkPipeline } from "./tasks.ts";
import { cleanupDirs, gitEnv, useSpawnBudget } from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ---------------------------------------------------------------------------
// TIER (b) — the CONVENTIONS check step: 10 filesystem checks (B1-B10) plus the
// three rules DEMOTED from tier (c) because GritQL plugins are single-file
// (C2 / C3 / C12).
//
// THE CONTRACT THIS SUITE FIXES (the spec left the module's shape open; these
// tests ARE the decision, so the implementor reads them as the interface):
//
//   scanConventions(root: string, files?: string[]): {
//     findings: Array<{ message: string; path: string; rule: string }>;
//     notes: string[];
//   }
//
//   - `root`     — the workroot to scan. Pure fs/content scanning, no AST deps
//                  (ADR-0008 / the task constraint).
//   - `files`    — OPTIONAL per-file subset, ABSOLUTE paths (exactly what
//                  check.ts's per-file path already resolves). Present = run
//                  only the checks relevant to those files.
//   - `rule`     — the inventory id: "B1"…"B10", "C2", "C3", "C12".
//   - `path`     — repo-RELATIVE, POSIX separators. Which path each rule
//                  reports is fixed here, per rule:
//                    · file rules (B1 B2 B3 B5 B7 B8 B10 C2 C3) → the offending FILE
//                    · directory rules (B4 B9)                  → the offending DIRECTORY
//                    · B6                                       → the collection.browser.ts that exists
//                    · C12                                      → the collection.browser.ts whose .pick() drifted
//   - `notes`    — plain single-line strings (check.ts wraps them as CheckNotes).
//                  Two producers: B8 when there is no build output to scan, and
//                  C12 when a module's pick/select cannot be parsed.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (all INDEPENDENT of the code):
//   - Each rule's deny/allow set is the task spec's own enumeration (B1…B10,
//     C2/C3/C12), cross-checked against the kit's own convention skills:
//     `plugin/skills/module-conventions/SKILL.md` (the role-file taxonomy, the
//     no-barrel rule, the rejected type-buckets, the three blessed env
//     exceptions, schema co-location) and `plugin/skills/data-fetching/SKILL.md`
//     (the `.select({…})` server fn ↔ `.pick({…})` collection projection pair).
//   - Every expected path is a filename WE wrote into the fixture by hand; the
//     scanner never gets to tell us which files it found.
//   - The near-miss beside every violation (the conformant twin) is the real
//     assertion: at gate severity a false positive turns the gate red on
//     conformant code, so each rule is pinned from BOTH sides.
//   - The zero-findings CONFORMANT_MODULE fixture is transcribed from the two
//     convention skills' own canonical examples — it is what the kit tells
//     people to write, so a single finding on it is a bug by definition.
//
// WHY THESE ARE RED BEFORE THE IMPLEMENTATION: `cli/src/conventions.ts` does not
// exist, `checkPipeline` has no `conventions` step, and `dobby check` reports
// nothing about barrels/buckets/schemas today.
// ---------------------------------------------------------------------------

const trees: string[] = [];

// Write a repo-relative file map into `dir` (parent dirs created).
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

// A THROWAWAY source tree (no git needed — `scanConventions` takes a root).
function makeTree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-conv-")));
  trees.push(dir);
  writeFiles(dir, files);
  return dir;
}

type ConventionsReport = ReturnType<typeof scanConventions>;

// The DISTINCT paths one rule reported, sorted — the assertion vehicle for every
// rule case. Deduplicating keeps the contract about WHICH files/dirs violate,
// never about how many times a scanner chose to report the same one.
function rulePaths(report: ConventionsReport, rule: string): string[] {
  return [
    ...new Set(
      report.findings
        .filter((finding) => finding.rule === rule)
        .map((finding) => finding.path)
    ),
  ].sort();
}

afterAll(() => {
  cleanupDirs(trees);
  trees.length = 0;
});

// ===========================================================================
// SLICE 1 — B1 no barrels. The first tracer bullet: the smallest rule that
// proves the whole module exists, walks src/, applies one deny with one
// exemption, and returns {rule, path, message}.
// ===========================================================================

describe("scanConventions — B1 no barrels", () => {
  it("reports every index.ts / index.tsx under src/ as a barrel", () => {
    const root = makeTree({
      "src/books/index.tsx": "export const books = 1;\n",
      "src/tasks/index.ts": "export const tasks = 1;\n",
      "src/tasks/task-card.tsx": "export const TaskCard = () => null;\n",
    });

    expect(rulePaths(scanConventions(root), "B1")).toEqual([
      "src/books/index.tsx",
      "src/tasks/index.ts",
    ]);
  });

  it("exempts route files anywhere under src/routes (a route index is not a barrel)", () => {
    const root = makeTree({
      "src/routes/index.tsx": "export const Route = null;\n",
      "src/routes/tasks/index.tsx": "export const Route = null;\n",
      "src/tasks/index.ts": "export const tasks = 1;\n",
    });

    // The real barrel beside the two route indexes: a scanner that ignored the
    // exemption would report three paths here, not one.
    expect(rulePaths(scanConventions(root), "B1")).toEqual([
      "src/tasks/index.ts",
    ]);
  });

  it("carries a rule id, a repo-relative path and a human message on every finding", () => {
    const root = makeTree({ "src/tasks/index.ts": "export const t = 1;\n" });

    const { findings } = scanConventions(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: "src/tasks/index.ts",
      rule: "B1",
    });
    expect(findings[0]?.message).toMatch(/barrel/i);
  });
});

// ===========================================================================
// SLICE 2 — the capability gate (pure, in tasks.ts). A non-stack consumer must
// never run stack conventions: the step is in the plan ONLY for react /
// tanstack-start. Decision 12 + the research reuse note ("tier (b) is one new
// {kind:'conventions'} variant").
// ===========================================================================

describe("checkPipeline — the conventions step is capability-gated", () => {
  // Widened to string[] on purpose: the plan's step kinds are compared as DATA,
  // so the assertions stay readable before `CheckStep` grows the new variant.
  const kinds = (steps: ReturnType<typeof checkPipeline>): string[] =>
    steps.map((step) => step.kind);

  it("includes the conventions step for a react project", () => {
    expect(kinds(checkPipeline(["vite", "react"], null, {}))).toContain(
      "conventions"
    );
  });

  it("includes the conventions step for a tanstack-start project", () => {
    expect(kinds(checkPipeline(["tanstack-start"], null, {}))).toContain(
      "conventions"
    );
  });

  it("omits the conventions step entirely for a project with neither react nor tanstack-start", () => {
    // A plain library/CLI consumer (dobby itself is one) must never be judged by
    // the TanStack Start + Drizzle stack conventions.
    expect(
      kinds(checkPipeline(["vite", "vitest", "drizzle"], null, {}))
    ).not.toContain("conventions");
    expect(kinds(checkPipeline([], null, {}))).not.toContain("conventions");
  });

  it("keeps config checks[] extras last, after the conventions step", () => {
    const steps = checkPipeline(
      ["react"],
      { checks: [{ name: "manifests", run: "true" }] },
      {}
    );
    const kindList = kinds(steps);

    expect(kindList).toContain("conventions");
    expect(kindList.at(-1)).toBe("extra");
    expect(kindList.indexOf("conventions")).toBeLessThan(
      kindList.indexOf("extra")
    );
  });

  it("drops the conventions step on a selective flag run (GREEN GUARD — no --conventions flag exists)", () => {
    // `--types` means "the tsc step and nothing else"; conventions has no
    // selective flag of its own, so it can never be the selected subset.
    expect(kinds(checkPipeline(["react"], null, { types: true }))).toEqual([
      "tsc",
    ]);
  });
});

// ===========================================================================
// SLICE 3 — check.ts wiring. The findings must reach the model through the SAME
// reducer as biome/tsc: a labelled group in `dobby check`'s report, and the
// gate's exit code. Observed through the in-process `run(argv, cwd)` seam
// (ADR-0008) — `run.ts` is untouched by this task, so a generic new group must
// render with no renderer change.
// ===========================================================================

// A biome config that can only ever fire ONE rule (and never formats), so the
// gate's other steps stay silent and "which tool reported" reads cleanly.
const ISOLATED_BIOME = {
  assist: { enabled: false },
  formatter: { enabled: false },
  linter: {
    enabled: true,
    rules: { recommended: false, suspicious: { noDoubleEquals: "error" } },
  },
};

const STRICT_TSCONFIG = {
  compilerOptions: { noEmit: true, skipLibCheck: true, strict: true },
  include: ["src"],
};

// A THROWAWAY git repo shaped for the real gate: consumer-owned biome/tsconfig/
// knip configs (total overrides, so dobby's presets never enter the picture),
// a dobby.config.json marker (the edit hook's gate), and — when `stack` — a
// `react` dependency, which is the ONLY thing that turns the conventions step on.
function makeGateRepo(opts: {
  files: Record<string, string>;
  stack: boolean;
}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-convgate-")));
  trees.push(dir);
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    env: gitEnv(),
    stdio: "ignore",
  });
  writeFiles(dir, {
    "biome.jsonc": JSON.stringify(ISOLATED_BIOME, null, 2),
    "dobby.config.json": JSON.stringify({ files: [] }, null, 2),
    "package.json": JSON.stringify(
      {
        ...(opts.stack ? { dependencies: { react: "^19.0.0" } } : {}),
        // entry = every src file -> nothing is unused -> knip stays silent.
        knip: {
          entry: ["src/**/*.ts"],
          ignoreDependencies: ["react"],
          project: ["src/**/*.ts"],
        },
        name: "conventions-fixture",
        private: true,
      },
      null,
      2
    ),
    "tsconfig.json": JSON.stringify(STRICT_TSCONFIG, null, 2),
    ...opts.files,
  });
  return dir;
}

// Two barrels, both biome-clean and tsc-clean: the ONLY thing wrong with this
// repo is the convention.
const TWO_BARRELS = {
  "src/books/index.ts": "export const books = 1;\n",
  "src/tasks/index.ts": "export const tasks = 1;\n",
};

// The PostToolUse hook payload (`{ tool_name, tool_input: { file_path } }`).
function hookStdin(filePath: string): string {
  return JSON.stringify({
    session_id: "conventions-test",
    tool_input: { file_path: filePath },
    tool_name: "Edit",
  });
}

describe("dobby check — conventions findings flow through the gate", () => {
  it("fails the gate and reports the convention findings under their own tool group", async () => {
    const repo = makeGateRepo({ files: TWO_BARRELS, stack: true });

    const result = await run(["check"], repo);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^conventions \(\d+\):/m);
    expect(result.stdout).toContain("src/tasks/index.ts");
    expect(result.stdout).toContain("src/books/index.ts");
    // The gate went red on the CONVENTIONS step alone — biome/tsc/knip found
    // nothing, so this is not an accidental pass-by-another-failure.
    expect(result.stdout).not.toContain("biome (");
    expect(result.stdout).not.toContain("tsc (");
  });

  it("says nothing about conventions in a project that is neither react nor tanstack-start", async () => {
    const repo = makeGateRepo({ files: TWO_BARRELS, stack: false });

    const result = await run(["check"], repo);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("conventions");
  });

  it("judges only the named file on the per-file path", async () => {
    const repo = makeGateRepo({ files: TWO_BARRELS, stack: true });

    const result = await run(["check", "src/tasks/index.ts"], repo);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("src/tasks/index.ts");
    expect(result.stdout).not.toContain("src/books/index.ts");
  });
});

describe("dobby check --hook — conventions reach the edit-time hook", () => {
  it("exits 2 and surfaces the finding on stderr when the edited file breaks a convention", async () => {
    const repo = makeGateRepo({ files: TWO_BARRELS, stack: true });

    const result = await run(
      ["check", "--hook"],
      repo,
      hookStdin(join(repo, "src/tasks/index.ts"))
    );

    // Exit 2 is the code Claude Code feeds back to the model, stderr the channel
    // it shows — the unfixable-finding contract, now carrying tier (b) findings.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("src/tasks/index.ts");
  });

  it("stays silent on an edit to a conformant file", async () => {
    const repo = makeGateRepo({
      files: {
        ...TWO_BARRELS,
        "src/tasks/functions.ts": "export const listTasks = () => [];\n",
      },
      stack: true,
    });

    const result = await run(
      ["check", "--hook"],
      repo,
      hookStdin(join(repo, "src/tasks/functions.ts"))
    );

    // The sibling barrel is still there — but the model edited a clean file, and
    // the hook must not nag about someone else's violation.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("stays silent in a project that is neither react nor tanstack-start", async () => {
    const repo = makeGateRepo({ files: TWO_BARRELS, stack: false });

    const result = await run(
      ["check", "--hook"],
      repo,
      hookStdin(join(repo, "src/tasks/index.ts"))
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

// ===========================================================================
// SLICE 4 — the remaining filesystem checks, B2 … B10. Each: the violation and
// its conformant twin in ONE fixture, asserted as that rule's exact path set.
// ===========================================================================

describe("scanConventions — B2 generic basenames", () => {
  it("reports the generic role-less filenames under src/ and spares the descriptive ones", () => {
    // The deny list is module-conventions' own "_Avoid_" column: api/actions/
    // handlers (obscure the isomorphic contract), utils/hooks (browser dumping
    // grounds), models/tables/entities (the drizzle glob only finds schema*),
    // service/db/lib (no boundary). `db.server.ts` is the BLESSED role file, not
    // the generic `db.ts` — matching on the first dot-segment would wreck it.
    const root = makeTree({
      "src/routes/api.ts": "export const Route = null;\n",
      "src/tasks/api.ts": "export const list = () => [];\n",
      "src/tasks/db.server.ts": "export const db = 1;\n",
      "src/tasks/entities.tsx": "export const Entity = () => null;\n",
      "src/tasks/task-utils.ts": "export const slugify = (s: string) => s;\n",
      "src/tasks/utils.ts": "export const noop = () => undefined;\n",
    });

    expect(rulePaths(scanConventions(root), "B2")).toEqual([
      "src/tasks/api.ts",
      "src/tasks/entities.tsx",
      "src/tasks/utils.ts",
    ]);
  });
});

describe("scanConventions — B3 no .client.ts boundary suffix", () => {
  it("reports .client files and spares the honestly named .browser files", () => {
    // `.client.ts` reads like the mirror of `.server.ts` but TanStack Start
    // enforces nothing on it — a false compile guarantee (module-conventions).
    const root = makeTree({
      "src/auth/client.browser.ts": "export const authClient = 1;\n",
      "src/auth/client.client.ts": "export const authClient = 1;\n",
      "src/auth/session.client.tsx": "export const Session = () => null;\n",
    });

    expect(rulePaths(scanConventions(root), "B3")).toEqual([
      "src/auth/client.client.ts",
      "src/auth/session.client.tsx",
    ]);
  });
});

describe("scanConventions — B4 no type-based bucket directories", () => {
  it("reports the bucket directories and spares src/shared", () => {
    // Rejected framing in module-conventions: grouping by KIND scatters one
    // feature across six folders. `src/shared/` is the blessed cross-cutting
    // module, so `src/shared/components/` is not a bucket.
    const root = makeTree({
      "src/components/button.tsx": "export const Button = () => null;\n",
      "src/lib/format.ts": "export const fmt = (s: string) => s;\n",
      "src/shared/components/button.tsx": "export const Button = () => null;\n",
      "src/tasks/-components/task-card.tsx":
        "export const TaskCard = () => null;\n",
      "src/tasks/task-card.tsx": "export const TaskCard = () => null;\n",
    });

    expect(rulePaths(scanConventions(root), "B4")).toEqual([
      "src/components",
      "src/lib",
      "src/tasks/-components",
    ]);
  });
});

describe("scanConventions — B5 tables live in a co-located schema file", () => {
  it("reports pgTable declarations outside src/**/schema.ts|schema.gen.ts, including a central schema directory", () => {
    // Schema co-location (module-conventions): tables live in their OWNER module
    // and drizzle-kit finds them by the `src/**/schema*.ts` glob — so a central
    // `src/db/schema/` breaks the convention even when the FILENAME is right.
    const root = makeTree({
      "src/auth/schema.gen.ts":
        'import { pgTable } from "drizzle-orm/pg-core";\nexport const user = pgTable("user", {});\n',
      "src/db/schema/schema.ts":
        'import { pgTable } from "drizzle-orm/pg-core";\nexport const audit = pgTable("audit", {});\n',
      "src/tasks/helpers.ts":
        "// the table itself lives in pgTable form in schema.ts\nexport const noop = () => undefined;\n",
      "src/tasks/model.ts":
        'import { pgTable } from "drizzle-orm/pg-core";\nexport const task = pgTable("task", {});\n',
      "src/tasks/schema.ts":
        'import { pgTable } from "drizzle-orm/pg-core";\nexport const task = pgTable("task", {});\n',
    });

    expect(rulePaths(scanConventions(root), "B5")).toEqual([
      "src/db/schema/schema.ts",
      "src/tasks/model.ts",
    ]);
  });
});

describe("scanConventions — B6 a collection needs its server functions", () => {
  it("reports a collection.browser.ts whose module has no functions.ts", () => {
    // The data-fetching recipe is a PAIR: the server fn in `module/functions.ts`
    // feeds the eager collection in `module/collection.browser.ts`. A collection
    // with no sibling functions.ts is half a recipe. Other `.browser.ts` role
    // files (a Better Auth client) carry no such pairing.
    const root = makeTree({
      "src/auth/client.browser.ts": "export const authClient = 1;\n",
      "src/books/collection.browser.ts": "export const bookCollection = 1;\n",
      "src/tasks/collection.browser.ts": "export const taskCollection = 1;\n",
      "src/tasks/functions.ts": "export const listTasks = () => [];\n",
    });

    expect(rulePaths(scanConventions(root), "B6")).toEqual([
      "src/books/collection.browser.ts",
    ]);
  });
});

describe("scanConventions — B7 the env exception set is closed", () => {
  it("reports any NEW file reading process.env / import.meta.env beyond the blessed exceptions", () => {
    // module-conventions: app code reads the validated `env`; only the files
    // that load OUTSIDE Vite may read the raw environment — src/router.tsx
    // (import.meta.env.DEV), drizzle.config.ts, nitro.config.ts, and the email
    // templates. The check is set EQUALITY against that list, so a new
    // exception is caught the day it appears.
    const root = makeTree({
      "drizzle.config.ts":
        "export default { url: process.env.DATABASE_URL };\n",
      "src/emails/welcome.tsx":
        "export const url = process.env.APP_URL;\nexport const Email = () => null;\n",
      "src/router.tsx": "export const isDev = import.meta.env.DEV;\n",
      "src/tasks/functions.ts":
        "export const key = () => process.env.STRIPE_SECRET;\n",
      "src/tasks/task-card.tsx": "export const TaskCard = () => null;\n",
      "vite.config.ts": "export default { mode: process.env.NODE_ENV };\n",
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/functions.ts",
      "vite.config.ts",
    ]);
  });

  it("spares the env module itself, in both house locations", () => {
    // The env module is the file that VALIDATES process.env (t3-env's
    // `createEnv({ runtimeEnv: process.env })`) and hands the rest of the app the
    // typed `env` — without it the rule is unsatisfiable for every house app. The
    // tier-(a) `noProcessEnv` allowlist blesses BOTH house locations
    // (`cli/biome/react.jsonc`: `**/src/shared/env.ts` — module-conventions'
    // `@/shared/env` — and `**/src/lib/env.ts`, what onboard/migrate-config
    // writes). B7 is a set-EQUALITY check against THAT allowlist, so it must spare
    // them too; a B7 that only knew the three out-of-Vite files would contradict
    // tier (a) and turn the gate red on the one file the convention requires.
    const root = makeTree({
      "src/lib/env.ts":
        "export const env = createEnv({ runtimeEnv: process.env });\n",
      "src/shared/env.ts":
        "export const env = createEnv({ runtimeEnv: process.env });\n",
      "src/tasks/functions.ts":
        "export const key = () => process.env.STRIPE_SECRET;\n",
    });

    // The unblessed reader beside them proves the rule is live in this fixture
    // (an all-clean expectation would also pass on a B7 that never fires).
    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/functions.ts",
    ]);
  });
});

describe("scanConventions — B8 server-only symbols must not reach the client bundle", () => {
  it("reports the built client assets that carry a server-only symbol", () => {
    // The import-protection verify step, mechanized: after a build, the client
    // bundle must be free of betterAuth/Pool/drizzle/Resend/neonConfig. The
    // SOURCE file that legitimately constructs the eager instance behind the
    // `.server.ts` boundary is not a bundle leak.
    const root = makeTree({
      ".output/public/assets/app-a1b2.js":
        "const auth=betterAuth({baseURL:'x'});\n",
      ".output/public/assets/vendor-c3d4.js":
        "neonConfig.webSocketConstructor=ws;\n",
      ".output/public/index.html": "<!doctype html><html></html>\n",
      "src/auth/auth.server.ts": "export const auth = betterAuth({});\n",
    });

    expect(rulePaths(scanConventions(root), "B8")).toEqual([
      ".output/public/assets/app-a1b2.js",
      ".output/public/assets/vendor-c3d4.js",
    ]);
  });

  it("skips the bundle scan with a note when there is no build output", () => {
    const root = makeTree({
      "src/auth/auth.server.ts": "export const auth = betterAuth({});\n",
    });

    const report = scanConventions(root);

    expect(rulePaths(report, "B8")).toEqual([]);
    // A skip is reported, never silently omitted — the build-gated step pattern.
    expect(report.notes.some((note) => note.includes(".output"))).toBe(true);
  });
});

describe("scanConventions — B9 every module documents itself", () => {
  it("reports a module directory that has role files but no CONTEXT.md", () => {
    // A "module" is a directory under src/ holding at least one ROLE file
    // (*.server.ts · functions.ts · *.browser.ts · schema.ts · schema.gen.ts).
    // A directory of plain components or templates is not a module.
    const root = makeTree({
      "src/books/schema.ts": "export const book = 1;\n",
      "src/emails/welcome.tsx": "export const Email = () => null;\n",
      "src/tasks/CONTEXT.md": "# tasks\n\nThe tasks module.\n",
      "src/tasks/functions.ts": "export const listTasks = () => [];\n",
    });

    expect(rulePaths(scanConventions(root), "B9")).toEqual(["src/books"]);
  });
});

describe("scanConventions — B10 email templates live at the canonical path", () => {
  it("reports react-email templates outside src/emails and spares the sender that renders them", () => {
    // Canonical paths (root CONTEXT.md): react-email templates live at
    // `src/emails/`. `notifications/send.server.ts` is the canonical SENDER in
    // module-conventions — it imports react-email to render, and is not a
    // template.
    const root = makeTree({
      "src/emails/welcome.tsx":
        'import { Html } from "@react-email/components";\nexport const Email = () => Html;\n',
      "src/notifications/send.server.ts":
        'import { render } from "@react-email/render";\nexport const send = () => render;\n',
      "src/notifications/templates/welcome.tsx":
        'import { Html } from "@react-email/components";\nexport const Email = () => Html;\n',
      "src/tasks/task-card.tsx":
        'import { useState } from "react";\nexport const TaskCard = () => useState;\n',
    });

    expect(rulePaths(scanConventions(root), "B10")).toEqual([
      "src/notifications/templates/welcome.tsx",
    ]);
  });
});

// ===========================================================================
// SLICE 5 — the DEMOTED cross-file rules (C2 / C3 / C12). GritQL plugins are
// single-file, so these three live here.
// ===========================================================================

describe("scanConventions — C2 middlewares live with the server functions", () => {
  it("reports a createMiddleware declared in a .server.ts file", () => {
    // module-conventions: "Server fns + their middlewares" is the functions.ts
    // role; `.server.ts` is for eager instances / server-only logic.
    const root = makeTree({
      "src/auth/auth.server.ts":
        "export const authMiddleware = createMiddleware().server(() => 1);\n",
      "src/auth/functions.ts":
        "export const requireAuth = createMiddleware().server(() => 1);\n",
    });

    expect(rulePaths(scanConventions(root), "C2")).toEqual([
      "src/auth/auth.server.ts",
    ]);
  });
});

describe("scanConventions — C3 server functions guard themselves", () => {
  it("reports a createServerFn chain in functions.ts with no requireAuth middleware", () => {
    // "Server fns are publicly invokable HTTP endpoints; route guards do NOT
    // protect them" (data-fetching). The GUARDED chain sits directly ABOVE the
    // unguarded one in the SAME file — a scanner that merely asks "does this
    // file mention requireAuth?" passes this fixture and is wrong.
    const root = makeTree({
      "src/books/functions.ts": `import { createServerFn } from "@tanstack/react-start";

export const listBooks = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => []);
`,
      "src/tasks/functions.ts": `import { createServerFn } from "@tanstack/react-start";

export const listTasks = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => []);

export const deleteTask = createServerFn({ method: "POST" })
  .handler(async () => undefined);
`,
    });

    expect(rulePaths(scanConventions(root), "C3")).toEqual([
      "src/tasks/functions.ts",
    ]);
  });
});

describe("scanConventions — C12 the collection projection matches the server fn", () => {
  it("reports the module whose .pick() key set differs from its .select() key set", () => {
    // data-fetching: "the row shape is fixed by the server fn's .select({…}) and
    // MUST match the collection's .pick(…) exactly". `books` lists the same two
    // keys in a DIFFERENT order — set equality, not text equality. `tasks` picks
    // a third key (`createdAt`) the server never selects.
    const root = makeTree({
      "src/books/collection.browser.ts":
        "const rowSchema = createSelectSchema(book).pick({ id: true, title: true });\n",
      "src/books/functions.ts":
        "export const listBooks = () => db.select({ title: book.title, id: book.id }).from(book);\n",
      "src/tasks/collection.browser.ts":
        "const rowSchema = createSelectSchema(task).pick({ createdAt: true, id: true, title: true });\n",
      "src/tasks/functions.ts":
        "export const listTasks = () => db.select({ id: task.id, title: task.title }).from(task);\n",
    });

    expect(rulePaths(scanConventions(root), "C12")).toEqual([
      "src/tasks/collection.browser.ts",
    ]);
  });

  it("skips a module it cannot parse with a note instead of guessing a mismatch", () => {
    // The projection is built from a hoisted constant, so the key set is not
    // readable from the source text. An unparseable module is a SKIP — never a
    // finding: a false positive turns the gate red on conformant code.
    const root = makeTree({
      "src/orders/collection.browser.ts":
        "const rowSchema = createSelectSchema(order).pick(ORDER_KEYS);\n",
      "src/orders/functions.ts":
        "export const listOrders = () => db.select({ id: order.id }).from(order);\n",
    });

    const report = scanConventions(root);

    expect(rulePaths(report, "C12")).toEqual([]);
    expect(report.notes.some((note) => note.includes("src/orders"))).toBe(true);
  });
});

// ===========================================================================
// SLICE 6 — the false-positive guard. A module written exactly the way the kit's
// own convention skills prescribe must produce ZERO findings across all 13
// rules. At gate severity this is the rule that matters most: a false positive
// turns the gate red on conformant code.
// ===========================================================================

const CONFORMANT_MODULE: Record<string, string> = {
  "drizzle.config.ts": `export default {
  schema: ["./src/**/schema.ts", "./src/**/schema.gen.ts"],
  url: process.env.DATABASE_URL,
};
`,
  "src/emails/welcome.tsx": `import { Html } from "@react-email/components";

export const subject = "Welcome";
export const Email = () => Html;
`,
  "src/router.tsx": `export const isDev = import.meta.env.DEV;
`,
  "src/routes/index.tsx": `export const Route = { component: () => null };
`,
  "src/tasks/CONTEXT.md": `# tasks

The tasks module.
`,
  "src/tasks/collection.browser.ts": `import { createSelectSchema } from "drizzle-zod";

import { listTasks } from "./functions";
import { task } from "./schema";

const taskRowSchema = createSelectSchema(task).pick({ id: true, title: true });

export const taskCollection = createCollection(
  queryCollectionOptions({
    getKey: (row) => row.id,
    queryFn: () => listTasks(),
    schema: taskRowSchema,
  })
);
`,
  "src/tasks/functions.ts": `import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/auth/functions";
import { db } from "@/shared/db.server";

import { task } from "./schema";

export const listTasks = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () =>
    db.select({ id: task.id, title: task.title }).from(task)
  );
`,
  "src/tasks/schema.ts": `import { pgTable, text, uuid } from "drizzle-orm/pg-core";

export const task = pgTable("task", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
});
`,
  "src/tasks/task-card.tsx": `export const TaskCard = ({ title }: { title: string }) => title;
`,
};

describe("scanConventions — a conformant module", () => {
  it("reports nothing at all on code written the way the convention skills prescribe", () => {
    const root = makeTree(CONFORMANT_MODULE);

    expect(scanConventions(root).findings).toEqual([]);
  });
});

// ===========================================================================
// SLICE 7 — per-file mode (the subset the edit hook passes).
// ===========================================================================

describe("scanConventions — per-file mode", () => {
  it("judges only the files it was handed", () => {
    const root = makeTree({
      "src/books/index.ts": "export const books = 1;\n",
      "src/tasks/index.ts": "export const tasks = 1;\n",
    });

    const report = scanConventions(root, [join(root, "src/tasks/index.ts")]);

    expect(rulePaths(report, "B1")).toEqual(["src/tasks/index.ts"]);
  });

  it("still reports a conformant file's module as clean", () => {
    const root = makeTree(CONFORMANT_MODULE);

    const report = scanConventions(root, [
      join(root, "src/tasks/functions.ts"),
    ]);

    expect(report.findings).toEqual([]);
  });

  it("does not report B4 for a file edited inside a pre-existing bucket (whole-tree only)", () => {
    // B9's own reasoning, applied to B4: the bucket is a fact about the
    // DIRECTORY, so the edit hook must not block an unrelated edit inside a
    // legacy bucket on move-before-edit ordering. The full gate still reports.
    const root = makeTree({
      "src/lib/format.ts": "export const fmt = (s: string) => s;\n",
    });

    const perFile = scanConventions(root, [join(root, "src/lib/format.ts")]);

    expect(rulePaths(perFile, "B4")).toEqual([]);
    expect(rulePaths(scanConventions(root), "B4")).toEqual(["src/lib"]);
  });
});

// ===========================================================================
// SLICE 8 — field fixes from the first consumer gate run (vonda on 0.7.0):
// the dobby-allow escape hatch, comment-stripped B7, the nitro.config.ts env
// exception, and the resolved-const C12 select.
// ===========================================================================

describe("scanConventions — the dobby-allow escape hatch", () => {
  it("honors a reasoned allow for a per-file rule and counts it in a note", () => {
    const root = makeTree({
      "src/tasks/functions.ts":
        "// dobby-allow B7: bridges the legacy worker until the env port lands\n" +
        "export const key = () => process.env.STRIPE_SECRET;\n",
    });

    const report = scanConventions(root);

    expect(rulePaths(report, "B7")).toEqual([]);
    expect(
      report.notes.some(
        (note) => note.includes("dobby-allow") && note.includes("B7")
      )
    ).toBe(true);
  });

  it("does not honor an annotation with an empty reason", () => {
    const root = makeTree({
      "src/tasks/functions.ts":
        "// dobby-allow B7:\n" +
        "export const key = () => process.env.STRIPE_SECRET;\n",
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/functions.ts",
    ]);
  });

  it("suppresses on the per-file path too, with no note (the edit hook honors the allow)", () => {
    const root = makeTree({
      "src/tasks/functions.ts":
        "// dobby-allow B7: bridges the legacy worker until the env port lands\n" +
        "export const key = () => process.env.STRIPE_SECRET;\n",
    });

    const report = scanConventions(root, [
      join(root, "src/tasks/functions.ts"),
    ]);

    expect(report.findings).toEqual([]);
    expect(report.notes).toEqual([]);
  });

  it("blesses a bucket directory via dobby-allow B4 in its CONTEXT.md, sparing only that directory", () => {
    const root = makeTree({
      "src/components/button.tsx": "export const Button = () => null;\n",
      "src/lib/CONTEXT.md":
        "# lib\n\n// dobby-allow B4: dissolving in the shadcn wave — tracked\n",
      "src/lib/format.ts": "export const fmt = (s: string) => s;\n",
    });

    expect(rulePaths(scanConventions(root), "B4")).toEqual(["src/components"]);
  });
});

describe("scanConventions — the C3 allow is per chain, not per file", () => {
  const PUBLIC_CHAIN =
    'export const listFacilities = createServerFn({ method: "GET" }).handler(\n' +
    "  async () => []\n" +
    ");\n";

  it("passes an annotated public endpoint (the doc block above it counts) and counts the allow", () => {
    const root = makeTree({
      "src/facilities/functions.ts":
        "// The catalog read serves the anonymous intake dropdown — no session exists.\n" +
        "// dobby-allow C3: public by design — anonymous co-signer intake dropdown\n" +
        PUBLIC_CHAIN,
    });

    const report = scanConventions(root);

    expect(rulePaths(report, "C3")).toEqual([]);
    expect(
      report.notes.some(
        (note) => note.includes("dobby-allow") && note.includes("C3")
      )
    ).toBe(true);
  });

  it("still fails the unannotated neighbour chain in the same file", () => {
    const root = makeTree({
      "src/facilities/functions.ts":
        "// dobby-allow C3: public by design — anonymous co-signer intake dropdown\n" +
        PUBLIC_CHAIN +
        "\n" +
        'export const deleteFacility = createServerFn({ method: "POST" }).handler(\n' +
        "  async () => undefined\n" +
        ");\n",
    });

    expect(rulePaths(scanConventions(root), "C3")).toEqual([
      "src/facilities/functions.ts",
    ]);
  });

  it("does not let a detached top-of-file C3 allow bless a later chain", () => {
    // A blank line ends the comment run — the allow must sit ON the chain.
    const root = makeTree({
      "src/marketing/functions.ts":
        "// dobby-allow C3: a detached annotation covers nothing\n" +
        "\n" +
        'export const requestDemo = createServerFn({ method: "POST" }).handler(\n' +
        "  async () => undefined\n" +
        ");\n",
    });

    expect(rulePaths(scanConventions(root), "C3")).toEqual([
      "src/marketing/functions.ts",
    ]);
  });
});

describe("scanConventions — B7 ignores prose in comments", () => {
  it("passes a file whose only env mention is a comment", () => {
    // The vonda class: comments documenting legacy behavior name the API —
    // prose, not a read.
    const root = makeTree({
      "src/tasks/notify.ts":
        "// Legacy Convex behavior read process.env.SITE_URL here; the port\n" +
        "/* reads import.meta.env via @/shared/env instead. */\n" +
        "export const notify = () => undefined;\n",
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([]);
  });

  it("still fails a real read beside an env-mentioning comment", () => {
    const root = makeTree({
      "src/tasks/functions.ts":
        "/* the old code used import.meta.env */\n" +
        "export const key = () => process.env.STRIPE_SECRET;\n",
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/functions.ts",
    ]);
  });

  it("does not mistake a URL's // for a comment (the read after it still fails)", () => {
    const root = makeTree({
      "src/tasks/fetcher.ts":
        "export const call = () =>\n" +
        '  fetch("https://api.example.com/v1?key=" + process.env.API_KEY);\n',
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/fetcher.ts",
    ]);
  });

  it("does not let a non-URL string's // hide the read after it", () => {
    // The comment strip must be STRING-aware, not just URL-aware: a `//` inside
    // ANY string literal — no `:` before it, so the old `[^:]` guard did not
    // spare it — used to erase the rest of the line and with it the real env
    // read. All three literal forms carry the same hazard.
    const root = makeTree({
      "src/tasks/double.ts":
        'const marker = "a//b" + process.env.API_KEY;\nexport const value = marker;\n',
      "src/tasks/single.ts":
        "const marker = 'a//b' + process.env.API_KEY;\nexport const value = marker;\n",
      "src/tasks/template.ts":
        "const marker = `a//b` + process.env.API_KEY;\nexport const value = marker;\n",
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/double.ts",
      "src/tasks/single.ts",
      "src/tasks/template.ts",
    ]);
  });

  it("does not let a regex character class's // hide the read after it", () => {
    // Raw consecutive slashes are legal INSIDE a character class, so `/[//]/` is
    // a regex literal, not a comment. The `/` sits after `=`, the prev-token
    // position that says "regex", and the read after it must survive the strip.
    const root = makeTree({
      "src/tasks/matcher.ts":
        'export const ok = /[//]/.test("x") && process.env.API_KEY;\n',
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/matcher.ts",
    ]);
  });

  it("still strips the comment after a division (the / is not a regex)", () => {
    // The mirror of the case above: after an identifier a `/` divides, so the
    // scanner must NOT swallow the line as a regex — the `//` that follows is a
    // real comment and its prose stays prose.
    const root = makeTree({
      "src/tasks/ratio.ts":
        "export const ratio = (a: number, b: number) => a / b; // uses process.env.RATIO in prod\n",
      "src/tasks/reader.ts": "export const key = process.env.RATIO;\n",
    });

    // The unblessed reader beside it proves the rule is live in this fixture.
    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/reader.ts",
    ]);
  });

  it("reads a regex after a keyword as a regex, not as division", () => {
    // `return` is followed by an EXPRESSION, so the `/` after it opens a regex —
    // a character-only prev-token rule sees the `n` of `return` and calls it
    // division, letting the class's `//` erase the read behind it.
    const root = makeTree({
      "src/tasks/pick.ts":
        "export function pick(s: string) {\n" +
        "  return /[//]/.test(s) && process.env.SECRET;\n" +
        "}\n",
    });

    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/pick.ts",
    ]);
  });

  it("does not treat an identifier merely ENDING in a keyword as one", () => {
    // The word boundary is real: `myreturn / b` is division, so the `//` after it
    // is a genuine comment and its prose stays prose. (A regex reading here would
    // swallow `/ b; /` and leave the comment's tail behind as code.)
    const root = makeTree({
      "src/tasks/reader.ts": "export const key = process.env.SCALE;\n",
      "src/tasks/scale.ts":
        "export const scale = (myreturn: number, b: number) =>\n" +
        "  myreturn / b; // process.env.SCALE tuned this in prod\n",
    });

    // The unblessed reader beside it proves the rule is live in this fixture.
    expect(rulePaths(scanConventions(root), "B7")).toEqual([
      "src/tasks/reader.ts",
    ]);
  });

  it("exempts nitro.config.ts — it configures the server runtime outside Vite", () => {
    const root = makeTree({
      "nitro.config.ts":
        'export default { proxy: process.env.VITE_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321" };\n',
      "vite.config.ts": "export default { mode: process.env.NODE_ENV };\n",
    });

    // The unblessed reader beside it proves the rule is live in this fixture.
    expect(rulePaths(scanConventions(root), "B7")).toEqual(["vite.config.ts"]);
  });
});

describe("scanConventions — C12 resolves a hoisted select projection", () => {
  it("resolves db.select(<identifier>) to its same-file const and ignores an unrelated literal select", () => {
    // The facilities shape: the projection is a hoisted const, and the ONE
    // literal `.select({…})` in the file belongs to a different fn entirely —
    // it must not be invented into a mismatch against the collection's pick.
    const root = makeTree({
      "src/facilities/collection.browser.ts":
        "const rowSchema = createSelectSchema(facility).pick({ city: true, id: true, name: true });\n",
      "src/facilities/functions.ts":
        "const facilityColumns = { city: facilities.city, id: facilities.id, name: facilities.name };\n" +
        "export const listFacilities = () => db.select(facilityColumns).from(facilities);\n" +
        "export const getFacilityPin = () => db.select({ pin: facilities.pin }).from(facilities);\n",
    });

    expect(rulePaths(scanConventions(root), "C12")).toEqual([]);
  });

  it("really checks the hoisted shape — a drifted pick fails instead of skipping", () => {
    const root = makeTree({
      "src/courts/collection.browser.ts":
        "const rowSchema = createSelectSchema(court).pick({ county: true, id: true, name: true });\n",
      "src/courts/functions.ts":
        "const courtColumns = { id: courts.id, name: courts.name };\n" +
        "export const listCourts = () => db.select(courtColumns).from(courts);\n",
    });

    const report = scanConventions(root);

    expect(rulePaths(report, "C12")).toEqual([
      "src/courts/collection.browser.ts",
    ]);
    expect(report.notes.some((note) => note.includes("src/courts"))).toBe(
      false
    );
  });
});

// ===========================================================================
// SLICE 9 — field fix from vonda's 0.8.0 run: vendored trees are exempt from
// tier (b), mirroring the preset's `!src/shadcn/**` / `!src/components/ui/**`
// excludes. `src/shadcn/utils.ts` is shadcn's own components.json contract and
// must need no dobby-allow B2.
// ===========================================================================

describe("scanConventions — vendored trees are never judged", () => {
  it("exempts src/shadcn/** and the legacy src/components/ui/** from every rule", () => {
    const root = makeTree({
      // B2 bait (the un-renameable contract file), B1 bait, B3 bait — plus a
      // role file that would demand a CONTEXT.md (B9) if the tree were judged.
      "src/components/ui/utils.ts": "export const cn = (s: string) => s;\n",
      "src/shadcn/hooks/utils.ts": "export const useX = () => null;\n",
      "src/shadcn/ui/index.ts": "export const button = 1;\n",
      "src/shadcn/ui/theme.client.ts": "export const theme = 1;\n",
      "src/shadcn/utils.ts": "export const cn = (s: string) => s;\n",
      // The control: the same basename OUTSIDE the vendored trees still fires.
      "src/tasks/utils.ts": "export const fmt = (s: string) => s;\n",
    });

    const report = scanConventions(root);

    expect(rulePaths(report, "B2")).toEqual(["src/tasks/utils.ts"]);
    expect(
      report.findings.filter((finding) => isVendoredPath(finding.path))
    ).toEqual([]);
  });

  it("exempts a vendored file on the per-file path too (the edit hook stays silent)", () => {
    const root = makeTree({
      "src/shadcn/utils.ts": "export const cn = (s: string) => s;\n",
    });

    const report = scanConventions(root, [join(root, "src/shadcn/utils.ts")]);

    expect(report.findings).toEqual([]);
  });

  it("still judges a consumer module merely NAMED shadcn deeper in the tree", () => {
    const root = makeTree({
      "src/foo/shadcn/utils.ts": "export const fmt = (s: string) => s;\n",
    });

    expect(rulePaths(scanConventions(root), "B2")).toEqual([
      "src/foo/shadcn/utils.ts",
    ]);
  });
});

// The test-side twin of the scanner's vendored-prefix match, so the blanket
// no-vendored-findings assertion cannot silently narrow.
function isVendoredPath(path: string): boolean {
  return ["src/shadcn/", "src/components/ui/"].some((dir) =>
    path.startsWith(dir)
  );
}
