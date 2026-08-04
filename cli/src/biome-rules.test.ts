import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import { cleanupDirs, makeScratchRepo } from "./test-helpers.ts";

// ===========================================================================
// Tier (a) convention rules — native Biome rules in the SHIPPED presets,
// capability-gated.
//
// The seam is the GATE, exercised in-process: `run(["check", "--lint"], repo)`
// over a throwaway git repo that ships NO biome config of its own, so the
// config-less default (ADR-0015, override-by-presence) puts dobby's SHIPPED
// preset in charge — the react/tanstack preset path when the project declares
// the react + tanstack-start capabilities, the plain core preset when it does
// not. That capability fork IS the gating mechanism under test.
//
// `--lint` (not the full gate) on purpose: the fixture imports modules that do
// not exist on disk (`@tanstack/react-db`, `drizzle-orm`, `@/shared/db.server`),
// so tsc and knip would drown the report in unrelated findings. The lint step is
// the one the shipped Biome preset governs.
//
// WHERE THE EXPECTED VALUES COME FROM (never from the implementation):
//  - WHICH file must be flagged and which must not is the SPEC's own allowlist /
//    scope text (A1's `src/router.tsx` + `drizzle.config.ts` + `src/emails/**/*.tsx`
//    exceptions; A4's "outside **/src/shared/**"; A5's "scoped to **/src/routes/**"
//    with its six banned specifiers). Each fixture file is a two-line, hand-written
//    violation whose LINE NUMBER is fixed by the literal text written here.
//  - The `noProcessEnv` message ("Don't use process.env.") is BIOME's own text,
//    read off a real biome 2.5.4 run in a lab repo — an external tool's literal,
//    not something dobby computes.
//  - The `noRestrictedImports` messages are dobby-authored (the rule supports a
//    custom message), so their wording is deliberately NOT asserted here; what IS
//    asserted is the behaviour the spec fixes: WHERE the rule fires and where it
//    must stay quiet. Each positive is paired with a NEGATIVE over a file carrying
//    the IDENTICAL import in an exempt location, so an unrelated Biome rule firing
//    on the fixture cannot make the pair pass by accident.
//
// The fixture is deliberately clean under BOTH shipped presets today: before the
// tier-(a) rules land, `check --lint` over the stack repo reports ZERO findings.
// Any finding these tests observe is therefore attributable to the new rules.
// ===========================================================================

// --- The fixture app --------------------------------------------------------
// One file per behaviour, each a violation on a KNOWN line (line 1 of every
// import, line 1 of every `process.env` read). Nothing is indented: the two
// shipped preset paths disagree about indent style, and un-indented sources are
// format-clean under both, so the formatter never contributes a finding.
const APP_SOURCES: Record<string, string> = {
  // A1 — the blessed out-of-Vite exceptions the spec allowlists.
  "drizzle.config.ts":
    'export default { dialect: "postgresql", url: process.env.DATABASE_URL };\n',
  "nitro.config.ts":
    "export default { supabaseUrl: process.env.VITE_PUBLIC_SUPABASE_URL };\n",
  "src/emails/welcome.tsx": "export const emailBase = process.env.APP_URL;\n",

  // A1 — ordinary app code: `env` is the single source, so a raw read is banned.
  "src/features/tasks/config.ts":
    "export const appUrl = process.env.APP_URL;\n",

  // A4 — the raw live-query hooks belong to the <LiveQuery> boundary in
  // src/shared; the same import outside it is the violation.
  "src/features/tasks/list.tsx":
    'import { useLiveQuery } from "@tanstack/react-db";\n\nexport const taskRows = () => useLiveQuery();\n',

  // A5 — server-only modules are banned INSIDE src/routes only; the identical
  // import in a feature module stays legal.
  "src/features/tasks/queries.ts":
    'import { eq } from "drizzle-orm";\n\nexport const taskFilter = eq;\n',
  "src/router.tsx": "export const routerBase = process.env.APP_URL;\n",
  "src/routes/dashboard.tsx":
    'import { eq } from "drizzle-orm";\n\nexport const routeFilter = eq;\n',
  // The remaining banned specifiers, one per line, in Biome's canonical import
  // order so the organize-imports assist never fires (which would put a finding
  // on line 1 for the wrong reason).
  "src/routes/settings.tsx":
    'import { neon } from "@neondatabase/serverless";\n' +
    'import { betterAuth } from "better-auth";\n' +
    'import { eq } from "drizzle-orm";\n' +
    'import { Pool } from "pg";\n' +
    'import { serverOnly } from "@/features/tasks/loader.server";\n' +
    'import { db } from "@/shared/db.server";\n' +
    "\n" +
    "export const parts = { betterAuth, db, eq, neon, Pool, serverOnly };\n",
  "src/shared/live.tsx":
    'import { useLiveQuery } from "@tanstack/react-db";\n\nexport const sharedRows = () => useLiveQuery();\n',
};

// A violation of a rule EVERY preset path carries (`noDoubleEquals`), used in the
// capability-absent repo as the control that proves Biome really linted it — so
// "the stack rules are silent there" can never be silence-because-nothing-ran.
const UNIVERSAL_LINT_ERROR = {
  "src/features/tasks/compare.ts":
    "export const looseEqual = (a: number, b: number) => a == b;\n",
};

const scratchDirs: string[] = [];

// A throwaway git repo carrying the fixture app and a package.json whose
// dependencies decide the detected capabilities — and therefore which shipped
// preset the config-less default selects. NO biome config is written: a consumer
// config would be a TOTAL override and would take the shipped preset out of play.
function makeAppRepo(
  dependencies: Record<string, string>,
  extraSources: Record<string, string> = {}
): string {
  return makeScratchRepo({
    files: { ...APP_SOURCES, ...extraSources },
    // Written verbatim (a string), NOT as a pretty-printed value: the manifest is
    // checked like any other file, and this exact text — 2-space, one trailing
    // newline — is format-clean under the react preset path. (The core-only path
    // formats JSON differently, so the non-stack repo does carry a package.json
    // formatting finding; every assertion below is scoped to a SOURCE file, so
    // that pre-existing preset difference never leaks into a rule assertion.)
    pkg: `${JSON.stringify({ dependencies, name: "fixture-app", private: true }, null, 2)}\n`,
    prefix: "dobby-biome-rules-",
    track: scratchDirs,
  });
}

// One reported finding: the gate prints `<repo-relative file>:<line> <message>`
// per finding. The `configs: biome=default(react)` note line cannot match (no
// digits follow its colon), and neither can the group headers.
interface Finding {
  line: number;
  message: string;
}
const FINDING_LINE = /^\s*([^\s:]+):(\d+)\s+(.+)$/;

function findingsFor(stdout: string, file: string): Finding[] {
  const found: Finding[] = [];
  for (const raw of stdout.split("\n")) {
    const match = FINDING_LINE.exec(raw);
    if (match && match[1] === file) {
      found.push({ line: Number(match[2]), message: match[3] ?? "" });
    }
  }
  return found;
}

const linesFlaggedIn = (stdout: string, file: string) =>
  findingsFor(stdout, file).map((finding) => finding.line);

// The gate is spawned once per fixture repo (real Biome over a real repo); every
// assertion below reads that one report.
const GATE_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// The stack app: react + tanstack-start declared, so the config-less default
// selects the react/tanstack preset path — the ONLY path the tier-(a) rules ride.
// ---------------------------------------------------------------------------
describe("dobby check — tier (a) rules in a react/tanstack project", () => {
  let stdout: string;
  let exitCode: number;

  beforeAll(async () => {
    const repo = makeAppRepo({
      "@tanstack/react-db": "0.1.0",
      "@tanstack/react-start": "1.0.0",
      "drizzle-orm": "0.31.0",
      react: "19.0.0",
      "react-dom": "19.0.0",
    });
    ({ exitCode, stdout } = await run(["check", "--lint"], repo));
  }, GATE_TIMEOUT);

  afterAll(() => {
    cleanupDirs(scratchDirs.splice(0));
  });

  // --- Tracer bullet: A1, the rule the spec flips from off to error ----------
  it("reports an ad-hoc process.env read in app code, and fails the gate", () => {
    const findings = findingsFor(stdout, "src/features/tasks/config.ts");
    expect(findings).toContainEqual({
      line: 1,
      message: expect.stringContaining("process.env"),
    });
    // The gate is red BECAUSE of that finding: the fixture carries no other
    // violation (it reports nothing at all before the tier-(a) rules land).
    expect(exitCode).toBe(1);
  });

  it("exempts the out-of-Vite files the spec allowlists from the process.env ban", () => {
    expect(findingsFor(stdout, "src/router.tsx")).toEqual([]);
    expect(findingsFor(stdout, "drizzle.config.ts")).toEqual([]);
    expect(findingsFor(stdout, "nitro.config.ts")).toEqual([]);
    expect(findingsFor(stdout, "src/emails/welcome.tsx")).toEqual([]);
  });

  // --- A4: the raw live-query hooks -----------------------------------------
  it("reports a raw useLiveQuery import from @tanstack/react-db outside src/shared", () => {
    expect(linesFlaggedIn(stdout, "src/features/tasks/list.tsx")).toContain(1);
  });

  it("allows the raw live-query hooks inside src/shared, where the boundary lives", () => {
    expect(findingsFor(stdout, "src/shared/live.tsx")).toEqual([]);
  });

  // --- A5: server-only modules are banned in route files only ---------------
  it("reports a drizzle-orm import inside src/routes", () => {
    expect(linesFlaggedIn(stdout, "src/routes/dashboard.tsx")).toContain(1);
  });

  it("allows the identical drizzle-orm import outside src/routes", () => {
    expect(findingsFor(stdout, "src/features/tasks/queries.ts")).toEqual([]);
  });

  it("reports every server-only specifier the route ban lists", () => {
    // One import per line, in the order written into the fixture:
    // 1 @neondatabase/serverless · 2 better-auth · 3 drizzle-orm · 4 pg
    // 5 a deep **/*.server module · 6 @/shared/db.server
    const flagged = [
      ...new Set(linesFlaggedIn(stdout, "src/routes/settings.tsx")),
    ];
    expect(flagged).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));
  });
});

// ---------------------------------------------------------------------------
// The same app WITHOUT the stack capabilities: the config-less default falls
// back to the plain core preset, which must not carry any of the stack rules —
// a non-stack consumer never sees a convention about @/shared or TanStack.
// ---------------------------------------------------------------------------
describe("dobby check — tier (a) rules in a project without the react/tanstack capability", () => {
  let stdout: string;

  beforeAll(async () => {
    const repo = makeAppRepo({ zod: "3.23.8" }, UNIVERSAL_LINT_ERROR);
    ({ stdout } = await run(["check", "--lint"], repo));
  }, GATE_TIMEOUT);

  afterAll(() => {
    cleanupDirs(scratchDirs.splice(0));
  });

  it("still lints the project (the control violation is reported)", () => {
    // Guards the three assertions below against vacuous silence: if Biome had not
    // run at all, this universal rule would be silent too.
    expect(linesFlaggedIn(stdout, "src/features/tasks/compare.ts")).toContain(
      1
    );
  });

  it("keeps the process.env ban out of a non-stack project", () => {
    expect(findingsFor(stdout, "src/features/tasks/config.ts")).toEqual([]);
  });

  it("keeps the live-query hook ban out of a non-stack project", () => {
    expect(findingsFor(stdout, "src/features/tasks/list.tsx")).toEqual([]);
  });

  it("keeps the route server-only-import ban out of a non-stack project", () => {
    expect(findingsFor(stdout, "src/routes/dashboard.tsx")).toEqual([]);
    expect(findingsFor(stdout, "src/routes/settings.tsx")).toEqual([]);
  });
});
