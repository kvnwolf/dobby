import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import { cleanupDirs, makeScratchRepo } from "./test-helpers.ts";

// ===========================================================================
// Tier (c) convention rules — GritQL plugins shipped as .grit assets and wired
// into the REACT-PATH biome presets, so the house stack's structural
// conventions are enforced by the gate instead of by prose.
//
// The seam is the GATE, exercised in-process: `run(["check", "--lint"], repo)`
// over a throwaway git repo that ships NO biome config of its own, so the
// config-less default (ADR-0015, override-by-presence) puts dobby's SHIPPED
// preset in charge — the react preset path when the project declares the react
// capability, the plain core preset when it does not. That capability fork IS
// the gate that keeps a non-stack consumer free of stack conventions, and it is
// the delivery mode dobby itself owns (`--config-path` at the shipped preset).
//
// `--lint` (not the full gate) on purpose: the fixture imports modules that do
// not exist on disk (`@tanstack/react-db`, `@/shared/use-app-form`), so tsc and
// knip would drown the report in unrelated findings. The lint step is the one
// the shipped Biome preset — and therefore its GritQL plugins — governs.
//
// WHERE THE EXPECTED VALUES COME FROM (never from the implementation):
//  - WHICH construct must be flagged is the CONVENTION SKILLS' own text, which
//    is what the rule inventory was extracted from: `/dobby:data-fetching` —
//    "Do NOT call the underlying useLiveQuery / useLiveSuspenseQuery hook
//    directly in a component" (C15, scoped outside `src/shared`, where the
//    <LiveQuery> boundary itself lives); `/dobby:data-processing` — "Every
//    field MUST include field.Root, field.Label, field.Control,
//    field.ErrorMessage" and "Forms inside Dialogs MUST use render prop on
//    DialogContent" (the skill even ships the wrong-way example this fixture
//    copies: form.Root nested inside DialogContent).
//  - Every expected LINE is fixed by the literal fixture text written below and
//    counted by hand from it — not read back from any report.
//  - The diagnostic MESSAGES are dobby-authored (the inventory's wording), so
//    they are deliberately NOT asserted, exactly as the tier-(a) suite does for
//    noRestrictedImports. What IS asserted is the behaviour the convention
//    fixes: WHERE the rule fires and where it must stay quiet. Every positive is
//    paired with a NEGATIVE over the same construct in its legal location, so an
//    unrelated Biome rule firing on the fixture cannot make a pair pass by
//    accident.
//
// The fixture is deliberately QUIET under the shipped presets today: before the
// tier-(c) plugins land, `check --lint` over the structural repo reports ZERO
// findings, and the live-query repo reports only the tier-(a) import ban on
// list.tsx LINE 1 (the `@tanstack/react-db` import). Every assertion below
// therefore targets a line that carries nothing today — a finding on it is
// attributable to the new GritQL rule and to nothing else.
// ===========================================================================

// --- Fixture: the live-query hook rule (C15) --------------------------------
// One flat, un-indented file per side of the rule. The CALL lines are what C15
// is about — line 1's import is the tier-(a) ban's business, and no assertion
// below reads line 1.
//
//   list.tsx                     src/shared/live-rows.tsx
//   1 import { useLiveQuery, …   1 import { useLiveQuery, …
//   2                            2
//   3 import { tasks } …         3 import { tasks } …
//   4                            4
//   5 useLiveQuery call          5 useLiveQuery call        (legal here)
//   6                            6
//   7 useLiveSuspenseQuery call  7 useLiveSuspenseQuery call (legal here)
const LIVE_QUERY_SOURCES: Record<string, string> = {
  // Ordinary app code: the raw hook bypasses the <LiveQuery> boundary.
  "src/features/tasks/list.tsx":
    'import { useLiveQuery, useLiveSuspenseQuery } from "@tanstack/react-db";\n' +
    "\n" +
    'import { tasks } from "./collection.browser";\n' +
    "\n" +
    "export const taskRows = () => useLiveQuery((q) => q.from(tasks));\n" +
    "\n" +
    "export const taskRow = () => useLiveSuspenseQuery((q) => q.from(tasks));\n",

  // src/shared IS the boundary — the same two calls are legal here.
  "src/shared/live-rows.tsx":
    'import { useLiveQuery, useLiveSuspenseQuery } from "@tanstack/react-db";\n' +
    "\n" +
    'import { tasks } from "@/features/tasks/collection.browser";\n' +
    "\n" +
    "export const sharedRows = () => useLiveQuery((q) => q.from(tasks));\n" +
    "\n" +
    "export const sharedRow = () => useLiveSuspenseQuery((q) => q.from(tasks));\n",
};

const LIVE_QUERY_CALL_LINE = 5;
const LIVE_SUSPENSE_CALL_LINE = 7;

// --- Fixture: the structural form rules -------------------------------------
// Multi-line JSX, written in the react preset's own formatting (verified
// format-clean, so the formatter never contributes a finding of its own).
//
//   edit-task-form.tsx (incomplete field)   task-dialog.tsx (nested form.Root)
//    7 <form.Root form={form}>               8 <Dialog open>
//    8   <form.AppField name="title">        9   <DialogContent>
//    9     {(field) => (                    10     <form.Root form={form}>
//   10       <field.Root>                   11       <form.Submit>…
//   11         <field.Label>…               12     </form.Root>
//   12         <field.Control …             13   </DialogContent>
//   13       </field.Root>                  14 </Dialog>
const FORM_SOURCES: Record<string, string> = {
  // Correct: DialogContent RENDERS AS the form (the render prop), and the form
  // carries the `validators.onSubmit` schema every house form MUST declare
  // (`/dobby:data-processing`, "Rules every form MUST follow" — C18).
  "src/features/tasks/archive-dialog.tsx":
    'import { Dialog, DialogContent } from "@/components/ui/dialog";\n' +
    'import { useAppForm } from "@/shared/use-app-form";\n' +
    'import { archiveSchema } from "./schema";\n' +
    "\n" +
    "export function ArchiveDialog() {\n" +
    "  const form = useAppForm({\n" +
    '    defaultValues: { reason: "" },\n' +
    "    validators: { onSubmit: archiveSchema },\n" +
    "  });\n" +
    "\n" +
    "  return (\n" +
    "    <Dialog open>\n" +
    "      <DialogContent render={<form.Root form={form} />}>\n" +
    "        <form.Submit>Archive</form.Submit>\n" +
    "      </DialogContent>\n" +
    "    </Dialog>\n" +
    "  );\n" +
    "}\n",

  // Correct: the full field anatomy — Root, Label, Control, ErrorMessage — over a
  // form that declares its `validators.onSubmit` schema (C18, as above).
  "src/features/tasks/create-task-form.tsx":
    'import { useAppForm } from "@/shared/use-app-form";\n' +
    'import { taskSchema } from "./schema";\n' +
    "\n" +
    "export function CreateTaskForm() {\n" +
    "  const form = useAppForm({\n" +
    '    defaultValues: { title: "" },\n' +
    "    validators: { onSubmit: taskSchema.pick({ title: true }) },\n" +
    "  });\n" +
    "\n" +
    "  return (\n" +
    "    <form.Root form={form}>\n" +
    '      <form.AppField name="title">\n' +
    "        {(field) => (\n" +
    "          <field.Root>\n" +
    "            <field.Label>Title</field.Label>\n" +
    "            <field.Control render={<input />} />\n" +
    "            <field.ErrorMessage />\n" +
    "          </field.Root>\n" +
    "        )}\n" +
    "      </form.AppField>\n" +
    "      <form.Submit>Create</form.Submit>\n" +
    "    </form.Root>\n" +
    "  );\n" +
    "}\n",

  // Violation: the field carries no field.ErrorMessage.
  "src/features/tasks/edit-task-form.tsx":
    'import { useAppForm } from "@/shared/use-app-form";\n' +
    "\n" +
    "export function EditTaskForm() {\n" +
    '  const form = useAppForm({ defaultValues: { title: "" } });\n' +
    "\n" +
    "  return (\n" +
    "    <form.Root form={form}>\n" +
    '      <form.AppField name="title">\n' +
    "        {(field) => (\n" +
    "          <field.Root>\n" +
    "            <field.Label>Title</field.Label>\n" +
    "            <field.Control render={<input />} />\n" +
    "          </field.Root>\n" +
    "        )}\n" +
    "      </form.AppField>\n" +
    "      <form.Submit>Save</form.Submit>\n" +
    "    </form.Root>\n" +
    "  );\n" +
    "}\n",

  // Violation: form.Root nested INSIDE DialogContent (the skill's wrong-way
  // example) — it breaks the dialog's grid layout.
  "src/features/tasks/task-dialog.tsx":
    'import { Dialog, DialogContent } from "@/components/ui/dialog";\n' +
    'import { useAppForm } from "@/shared/use-app-form";\n' +
    "\n" +
    "export function TaskDialog() {\n" +
    '  const form = useAppForm({ defaultValues: { title: "" } });\n' +
    "\n" +
    "  return (\n" +
    "    <Dialog open>\n" +
    "      <DialogContent>\n" +
    "        <form.Root form={form}>\n" +
    "          <form.Submit>Create</form.Submit>\n" +
    "        </form.Root>\n" +
    "      </DialogContent>\n" +
    "    </Dialog>\n" +
    "  );\n" +
    "}\n",
};

// The offending ELEMENT's own line range in each violation file, counted from
// the literal text above. A diagnostic must point AT the construct it is about;
// which node of it carries the span (the element, its opening tag, the nested
// child) is the rule author's call, so the assertion is the range.
const INCOMPLETE_FIELD_ROOT = { from: 10, to: 13 };
const DIALOG_WRAPPING_A_FORM = { from: 9, to: 13 };

// A violation of a rule EVERY preset path carries (`noDoubleEquals`), used in
// the capability-absent repo as the control that proves Biome really linted it —
// so "the stack rules are silent there" can never be silence-because-nothing-ran.
const UNIVERSAL_LINT_ERROR: Record<string, string> = {
  "src/features/tasks/compare.ts":
    "export const looseEqual = (a: number, b: number) => a == b;\n",
};

const scratchDirs: string[] = [];

// A throwaway git repo carrying fixture sources and a package.json whose
// dependencies decide the detected capabilities — and therefore which shipped
// preset the config-less default selects. NO biome config is written: a consumer
// config would be a TOTAL override and would take the shipped preset out of play.
function makeAppRepo(
  dependencies: Record<string, string>,
  sources: Record<string, string>
): string {
  return makeScratchRepo({
    files: sources,
    pkg: `${JSON.stringify({ dependencies, name: "fixture-app", private: true }, null, 2)}\n`,
    prefix: "dobby-grit-rules-",
    track: scratchDirs,
  });
}

const STACK_DEPENDENCIES = {
  "@tanstack/react-db": "0.1.0",
  "@tanstack/react-start": "1.0.0",
  react: "19.0.0",
  "react-dom": "19.0.0",
};

// One reported finding: the gate prints `<repo-relative file>:<line> <message>`
// per finding. The `configs: biome=default(react)` note line cannot match (no
// digits follow its colon), and neither can the group headers.
interface Finding {
  line: number;
  message: string;
}
const FINDING_LINE = /^\s*([^\s:]+):(\d+)\s+(.+)$/;

// Biome's own literal for a whole-file formatting diff (reported at line 0). The
// two shipped preset paths format JSX differently — the fixture is written in the
// REACT preset's style — so the core-path repo carries these on every .tsx file.
// They are not convention findings; every assertion below is about rules.
const FORMATTER_DIFF = "Formatter would have printed";

function findingsFor(stdout: string, file: string): Finding[] {
  const found: Finding[] = [];
  for (const raw of stdout.split("\n")) {
    const match = FINDING_LINE.exec(raw);
    if (match && match[1] === file) {
      found.push({ line: Number(match[2]), message: match[3] ?? "" });
    }
  }
  return found.filter(({ message }) => !message.startsWith(FORMATTER_DIFF));
}

const linesFlaggedIn = (stdout: string, file: string) =>
  findingsFor(stdout, file).map((finding) => finding.line);

const flaggedWithin = (
  stdout: string,
  file: string,
  range: { from: number; to: number }
) =>
  linesFlaggedIn(stdout, file).filter(
    (line) => line >= range.from && line <= range.to
  );

// The gate is spawned once per fixture repo (real Biome over a real repo); every
// assertion in a block reads that one report.
const GATE_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Slice 1 — C15, the tracer bullet: a GritQL plugin shipped inside dobby's own
// package fires through the config-less `--config-path` delivery, and its
// path-scoped `includes` keeps src/shared out.
// ---------------------------------------------------------------------------
describe("dobby check — the raw live-query hook rule in a react project", () => {
  let stdout: string;

  beforeAll(async () => {
    const repo = makeAppRepo(STACK_DEPENDENCIES, LIVE_QUERY_SOURCES);
    ({ stdout } = await run(["check", "--lint"], repo));
  }, GATE_TIMEOUT);

  afterAll(() => {
    cleanupDirs(scratchDirs.splice(0));
  });

  it("reports a useLiveQuery call outside src/shared", () => {
    expect(linesFlaggedIn(stdout, "src/features/tasks/list.tsx")).toContain(
      LIVE_QUERY_CALL_LINE
    );
  });

  it("reports a useLiveSuspenseQuery call outside src/shared", () => {
    expect(linesFlaggedIn(stdout, "src/features/tasks/list.tsx")).toContain(
      LIVE_SUSPENSE_CALL_LINE
    );
  });

  it("allows both hooks inside src/shared, where the <LiveQuery> boundary lives", () => {
    expect(findingsFor(stdout, "src/shared/live-rows.tsx")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — the structural rules: single-file JSX anatomy, the class of
// convention only a GritQL pattern can express. This repo carries NO import-ban
// violation, so it is entirely quiet before the plugins land: its gate exit code
// is itself an assertion that the diagnostics ship at severity `error`.
// ---------------------------------------------------------------------------
describe("dobby check — the form/field structural rules in a react project", () => {
  let stdout: string;
  let exitCode: number;

  beforeAll(async () => {
    const repo = makeAppRepo(STACK_DEPENDENCIES, FORM_SOURCES);
    ({ exitCode, stdout } = await run(["check", "--lint"], repo));
  }, GATE_TIMEOUT);

  afterAll(() => {
    cleanupDirs(scratchDirs.splice(0));
  });

  it("reports a field.Root that is missing field.ErrorMessage, and fails the gate", () => {
    expect(
      flaggedWithin(
        stdout,
        "src/features/tasks/edit-task-form.tsx",
        INCOMPLETE_FIELD_ROOT
      )
    ).not.toEqual([]);
    // The gate is red BECAUSE of the structural findings: this repo carries no
    // other violation (it reports nothing at all before the plugins land), so an
    // `error`-severity diagnostic is what turns the gate red.
    expect(exitCode).toBe(1);
  });

  it("allows a field carrying the full Root/Label/Control/ErrorMessage anatomy", () => {
    expect(
      findingsFor(stdout, "src/features/tasks/create-task-form.tsx")
    ).toEqual([]);
  });

  it("reports a form.Root nested inside DialogContent", () => {
    expect(
      flaggedWithin(
        stdout,
        "src/features/tasks/task-dialog.tsx",
        DIALOG_WRAPPING_A_FORM
      )
    ).not.toEqual([]);
  });

  it("allows a DialogContent that renders as the form", () => {
    expect(
      findingsFor(stdout, "src/features/tasks/archive-dialog.tsx")
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — the capability gate: the plugins ride the REACT-path preset only, so
// a project without the react capability never sees a convention about
// @/shared, <LiveQuery>, or the house form system.
// ---------------------------------------------------------------------------
describe("dobby check — tier (c) rules in a project without the react capability", () => {
  let stdout: string;

  beforeAll(async () => {
    const repo = makeAppRepo(
      { zod: "3.23.8" },
      {
        ...LIVE_QUERY_SOURCES,
        ...FORM_SOURCES,
        ...UNIVERSAL_LINT_ERROR,
      }
    );
    ({ stdout } = await run(["check", "--lint"], repo));
  }, GATE_TIMEOUT);

  afterAll(() => {
    cleanupDirs(scratchDirs.splice(0));
  });

  it("still lints the project (the control violation is reported)", () => {
    // Guards the assertions below against vacuous silence: if Biome had not run
    // at all, the stack rules would be silent too.
    expect(linesFlaggedIn(stdout, "src/features/tasks/compare.ts")).toContain(
      1
    );
  });

  it("keeps the live-query hook rule out of a non-react project", () => {
    expect(findingsFor(stdout, "src/features/tasks/list.tsx")).toEqual([]);
  });

  it("keeps the form/field structural rules out of a non-react project", () => {
    expect(
      findingsFor(stdout, "src/features/tasks/edit-task-form.tsx")
    ).toEqual([]);
    expect(findingsFor(stdout, "src/features/tasks/task-dialog.tsx")).toEqual(
      []
    );
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — the shipping contract. The rules above are proven from dobby's own
// working tree; these guard the PUBLISHED package, where a .grit asset that is
// not packed (or a plugin path that does not resolve from the config file that
// declares it) silently takes every tier-(c) rule out of the field.
// ---------------------------------------------------------------------------
describe("the shipped GritQL assets", () => {
  const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const PRESET_DIR = join(CLI_ROOT, "biome");
  const GRIT_REFERENCE = /"([^"]*\.grit)"/g;

  const presetFiles = () =>
    readdirSync(PRESET_DIR).filter((name) => name.endsWith(".jsonc"));

  // Every `.grit` path a preset names, whether it is declared as a bare string
  // or as the `path` of a `{ path, includes }` entry.
  const gritPathsIn = (preset: string): string[] => {
    const text = readFileSync(join(PRESET_DIR, preset), "utf8");
    return [...text.matchAll(GRIT_REFERENCE)].map((match) => match[1] ?? "");
  };

  // The NON-VACUITY guard for the two integrity checks below: they quantify over
  // the declared plugin set, so an empty set would satisfy both. This one fails
  // until the react path actually declares plugins. WHICH of the two react-path
  // configs carries them is left open on purpose — the config-less wrapper and
  // the extendable react preset are two delivery modes of the same wiring.
  it("declares its plugins on the react preset path the stack consumers load", () => {
    const declared = ["configless.react.jsonc", "react.jsonc"].flatMap(
      gritPathsIn
    );
    expect(declared.length).toBeGreaterThan(0);
  });

  it("resolves every declared plugin path to a file that exists", () => {
    const unresolved = presetFiles().flatMap((preset) =>
      gritPathsIn(preset)
        .filter((path) => !existsSync(resolve(PRESET_DIR, path)))
        .map((path) => `${preset} → ${path}`)
    );
    expect(unresolved).toEqual([]);
  });

  it("packs every referenced .grit asset into the published package", () => {
    const pkg = JSON.parse(
      readFileSync(join(CLI_ROOT, "package.json"), "utf8")
    ) as { files?: string[] };
    // An allowlist entry ships a path when its literal (pre-glob) prefix leads
    // it; npm's negations start with `!` and can only subtract.
    const allowed = (pkg.files ?? [])
      .filter((entry) => !entry.startsWith("!"))
      .map((entry) => (entry.split("*")[0] ?? entry).replace(/\/+$/, ""));
    const unshipped = presetFiles()
      .flatMap(gritPathsIn)
      .map((path) => relative(CLI_ROOT, resolve(PRESET_DIR, path)))
      .filter((path) => !allowed.some((entry) => path.startsWith(entry)));
    expect(unshipped).toEqual([]);
  });
});
