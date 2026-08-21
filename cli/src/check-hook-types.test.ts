import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  gitIn,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real biome/tsc/git spawns over scratch repos: the shared spawn budget, never
// vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// TYPE ERRORS AT EDIT TIME, SCOPED TO THE AGENT'S FILE.
//
// `dobby check --hook` gains whole-program type analysis and surfaces ONLY the
// errors whose file the agent just edited. A neighbour task's half-written code
// and pre-existing errors elsewhere are DROPPED — the edit-time path already
// stays silent when it has nothing to say about the file in front of it.
//
// The hook's PUBLIC CONTRACT does not move: silence and exit 0, or findings on
// STDERR and exit 2. Every guard stays a silent exit 0, and "no edited file"
// behaves the same way — a whole-program run must never dump the project's
// errors at a model that only edited one file.
//
// THE SEAM is the in-process `run(argv, cwd, stdin)` contract (ADR-0008):
// `check.ts` is never imported here, so its internals can be restructured
// freely. Everything is observed through the command's own outcome plus the
// state of a REAL git repository.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (never from the implementation):
//  - Every fixture source is HAND-WRITTEN with its offending token on a line WE
//    chose, so `<file>:<line>` is a worked example, not a recomputed one:
//    `typebad.ts:2` (number <- string, tsc TS2322), `both.ts:2` (biome
//    noDoubleEquals) + `both.ts:4` (tsc TS2322), `dup.ts:1` (tsc TS2322).
//  - Each fixture's biome config is LINT-ONLY with `recommended: false` and a
//    single rule (`noDoubleEquals`), formatter OFF. A source with no `==` can
//    therefore produce NO biome finding at all — so an exit 2 over it can only
//    have come from the type analysis this task adds. That is the
//    anti-tautology guard for every slice below.
//  - `noDoubleEquals` has an UNSAFE fix only, so the hook's SAFE `--write` can
//    never remove it: it is the established "unfixable biome finding" of the
//    sibling suites (run.test.ts, check-cache.test.ts), verified out of band
//    against the bundled biome.
//  - The exit codes (0 / 2), the stderr channel, and "silent = empty stdout AND
//    stderr" are the hook's already-contracted literals, restated by this
//    task's constraints.
//  - `incremental: true` in the exported tsconfig preset is the constraint's own
//    words, asserted against the shipped file's BYTES.
//  - "the buildinfo stays out of git" is observed through `git status
//    --porcelain --untracked-files=all` — GIT's answer about its own tree, not
//    dobby's claim about where it wrote something.
//
// MOCKED BOUNDARIES: none. git, biome and tsc are all REAL, and the ambient
// declaration slice below is a fact of the TypeScript language, not of dobby.
//
// SOME TESTS ARE GREEN BEFORE THE IMPLEMENTATION EXISTS, deliberately: every
// "must NOT" guard is one whose whole content is a side effect that must never
// happen (the neighbour's error must not leak, a guard must not speak, the
// whole-program analysis must not be narrowed, the buildinfo must not appear in
// git), plus the two statements of the contract that already holds (biome's
// unfixable finding still reaches stderr, stdout stays empty). Each is PAIRED
// with a red efficacy control in its own slice — the same repository answering
// exit 2 for the file that IS broken — so it cannot pass vacuously once the
// behaviour lands. The single exception is the tsconfig-less project, which has
// no type analysis to control for: it is a regression guard for the existing
// hook fixtures, which carry no tsconfig at all. Every other assertion here
// fails until the behaviour exists.
//
// TRACER-BULLET ORDER: slice 1 proves a type error in the edited file reaches
// the model at all (the whole point of the task — a type error currently
// survives the build loop and only surfaces at commit). Slice 2 is the scope
// rule that makes slice 1 safe to ship. Everything after builds on those two.
// ===========================================================================

const dirs: string[] = [];

afterAll(() => {
  cleanupDirs(dirs);
});

// --- fixtures ---------------------------------------------------------------

// Formatter OFF, `recommended: false`, ONE rule. The only biome finding these
// repos can ever produce is a hand-written `==`, and `noDoubleEquals`'s fix is
// UNSAFE-only, so the hook's safe `--write` leaves it in place.
const BIOME_LINT_ONLY = {
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

// tsc TS2322 on LINE 2 (number <- string). No `==`, so biome stays silent.
const TYPEBAD =
  'export function bad(): number {\n  const x: number = "nope";\n  return x;\n}\n';

// Neither tool fires on it.
const CLEAN =
  "export function ok(a: number, b: number): number {\n  return a + b;\n}\n";

// BOTH tools fire on ONE file: `==` on LINE 2 (biome, unfixable) and number <-
// string on LINE 4 (tsc). Both operands of the `==` are numbers, so tsc says
// nothing about line 2, and line 4 has no `==`, so biome says nothing about it.
const BOTH_BAD =
  'export function eq(a: number, b: number): boolean {\n  return a == b;\n}\nexport const wrong: number = "nope";\n';

// A GLOBAL declaration (no import, no export -> a script, not a module). The
// file that uses it is only well-typed when the WHOLE program is analysed:
// narrow tsc's input to the edited file alone and `DOBBY_BUILD_ID` becomes an
// unresolved name, which is exactly the failure this fixture must catch.
const AMBIENT_DECL = "declare const DOBBY_BUILD_ID: string;\n";
const AMBIENT_USER = "export const buildId: string = DOBBY_BUILD_ID;\n";

// A THROWAWAY git repo shaped for the edit hook: the consumer's own biome and
// tsconfig (total overrides, so dobby's presets never enter the picture), the
// `dobby.config.json` marker the hook guards on, and a `.gitignore` covering the
// two dirs a real dobby project keeps out of git — `node_modules/` and the CLI's
// machine-state home `.dobby/`.
function makeHookTypeRepo(opts: {
  files: Record<string, string>;
  marker?: boolean;
  tsconfig?: unknown;
}): string {
  return makeScratchRepo({
    config: opts.marker === false ? undefined : { files: [] },
    files: {
      ".gitignore": ".dobby/\nnode_modules/\n",
      "biome.jsonc": JSON.stringify(BIOME_LINT_ONLY, null, 2),
      ...(opts.tsconfig === null
        ? {}
        : {
            "tsconfig.json": JSON.stringify(
              opts.tsconfig ?? STRICT_TSCONFIG,
              null,
              2
            ),
          }),
      ...opts.files,
    },
    pkg: {
      knip: { entry: ["src/**/*.ts"], project: ["src/**/*.ts"] },
      name: "hook-types-fixture",
      private: true,
    },
    prefix: "dobby-hooktypes-",
    track: dirs,
  });
}

// The PostToolUse payload `check --hook` parses. `undefined` omits `file_path`
// entirely — the "no edited file" case.
function hookStdin(filePath: string | undefined): string {
  return JSON.stringify({
    session_id: "hook-types-test",
    tool_input: filePath === undefined ? {} : { file_path: filePath },
    tool_name: "Edit",
  });
}

interface Outcome {
  exitCode: number;
  stderr: string;
  stdout: string;
}

// Edit `rel` inside `repo`, exactly as the PostToolUse hook reports it.
function editHook(repo: string, rel: string): Promise<Outcome> {
  return run(["check", "--hook"], repo, hookStdin(join(repo, rel)));
}

// "The hook had nothing to say": the contract's silence, on BOTH channels.
function expectSilent(outcome: Outcome): void {
  expect(outcome.stdout).toBe("");
  expect(outcome.stderr).toBe("");
  expect(outcome.exitCode).toBe(0);
}

// ---------------------------------------------------------------------------
// Slice 1 (tracer bullet) — a type error in the file the agent just edited
// reaches the model.
//
// The smallest thing that proves the whole seam: the hook runs type analysis and
// reports its finding through the contract's own channel (stderr) and code (2).
// Biome CANNOT fire on this fixture (no `==`), so the finding is the type
// analysis or nothing.
// ---------------------------------------------------------------------------
describe("check --hook — a type error in the edited file", () => {
  let outcome: Outcome;

  beforeAll(async () => {
    const repo = makeHookTypeRepo({ files: { "src/typebad.ts": TYPEBAD } });
    outcome = await editHook(repo, "src/typebad.ts");
  });

  it("exits 2, the code Claude Code feeds back to the model", () => {
    expect(outcome.exitCode).toBe(2);
  });

  it("names the offending file and line on stderr", () => {
    expect(outcome.stderr).toMatch(/typebad\.ts:2\b/);
  });

  it("keeps stdout empty, so the model-facing channel stays stderr", () => {
    expect(outcome.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — THE SCOPE RULE: only the edited file's errors are surfaced.
//
// One repo, two files: a broken neighbour that a parallel task might be
// mid-way through, and a clean file the agent just edited. The neighbour's
// error must be invisible; the SAME repo answering exit 2 for the neighbour is
// what makes that silence meaningful rather than vacuous.
// ---------------------------------------------------------------------------
describe("check --hook — a type error in somebody else's file", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeHookTypeRepo({
      files: { "src/clean.ts": CLEAN, "src/typebad.ts": TYPEBAD },
    });
  });

  it("stays silent when the agent edited a different, clean file", async () => {
    const outcome = await editHook(repo, "src/clean.ts");

    expectSilent(outcome);
  });

  it("never mentions the neighbour's file", async () => {
    const outcome = await editHook(repo, "src/clean.ts");

    expect(`${outcome.stdout}\n${outcome.stderr}`).not.toContain("typebad");
  });

  it("still reports that same error to the agent who edited that file", async () => {
    const outcome = await editHook(repo, "src/typebad.ts");

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/typebad\.ts:2\b/);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — the scope is the PATH, not the basename.
//
// Two files share a basename in different directories; only one is broken. A
// filter that matched on the file NAME would leak the neighbour's error into an
// edit of the innocent twin.
// ---------------------------------------------------------------------------
describe("check --hook — two files sharing a basename", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeHookTypeRepo({
      files: {
        "src/a/dup.ts": "export const first = 1;\n",
        "src/b/dup.ts": 'export const second: number = "nope";\n',
      },
    });
  });

  it("stays silent on the innocent twin", async () => {
    const outcome = await editHook(repo, "src/a/dup.ts");

    expectSilent(outcome);
  });

  it("reports the broken twin to its own editor", async () => {
    const outcome = await editHook(repo, "src/b/dup.ts");

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/dup\.ts:1\b/);
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — the ANALYSIS is whole-program; only the OUTPUT is filtered.
//
// TypeScript has no per-file check. `src/uses-ambient.ts` is well-typed ONLY
// because a sibling file declares `DOBBY_BUILD_ID` globally. Hand tsc just the
// edited file and that name becomes unresolved — a finding on the edited file
// itself, which the scope filter would happily let through. Silence here is the
// proof that the input was never narrowed.
// ---------------------------------------------------------------------------
describe("check --hook — an edited file that depends on a sibling's global declaration", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeHookTypeRepo({
      files: {
        "src/ambient.d.ts": AMBIENT_DECL,
        "src/typebad.ts": TYPEBAD,
        "src/uses-ambient.ts": AMBIENT_USER,
      },
    });
  });

  it("stays silent, because the whole program was analysed", async () => {
    const outcome = await editHook(repo, "src/uses-ambient.ts");

    expectSilent(outcome);
  });

  // The efficacy control for the silence above: this repo's type analysis DOES
  // speak, so the ambient file's silence is a verdict rather than an absence.
  it("still reports a genuine error in the same repository", async () => {
    const outcome = await editHook(repo, "src/typebad.ts");

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/typebad\.ts:2\b/);
  });
});

// ---------------------------------------------------------------------------
// Slice 5 — type analysis is ADDED to the edit-time path, not swapped in for
// the biome pass that was already there.
// ---------------------------------------------------------------------------
describe("check --hook — an edited file with both an unfixable lint finding and a type error", () => {
  let outcome: Outcome;

  beforeAll(async () => {
    const repo = makeHookTypeRepo({ files: { "src/both.ts": BOTH_BAD } });
    outcome = await editHook(repo, "src/both.ts");
  });

  it("reports the lint finding", () => {
    expect(outcome.stderr).toMatch(/both\.ts:2\b/);
  });

  it("reports the type error", () => {
    expect(outcome.stderr).toMatch(/both\.ts:4\b/);
  });

  it("exits 2 once for the pair", () => {
    expect(outcome.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Slice 6 — the guards. Harness noise must never block an edit, and a
// whole-program run with no edited file to scope to must not dump the project's
// errors at the model.
// ---------------------------------------------------------------------------
describe("check --hook — guards keep failing silent", () => {
  // The efficacy control for every guard below: the SAME fixture shape reports
  // its type error the moment a payload names the broken file, so each guard's
  // silence is the guard firing and not an analysis that never runs.
  it("reports the error when a payload does name the broken file", async () => {
    const repo = makeHookTypeRepo({ files: { "src/typebad.ts": TYPEBAD } });

    const outcome = await editHook(repo, "src/typebad.ts");

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/typebad\.ts:2\b/);
  });

  it("says nothing when the payload names no edited file", async () => {
    const repo = makeHookTypeRepo({ files: { "src/typebad.ts": TYPEBAD } });

    const outcome = await run(["check", "--hook"], repo, hookStdin(undefined));

    expectSilent(outcome);
  });

  it("says nothing when the payload cannot be parsed", async () => {
    const repo = makeHookTypeRepo({ files: { "src/typebad.ts": TYPEBAD } });

    const outcome = await run(["check", "--hook"], repo, "not json {{{");

    expectSilent(outcome);
  });

  it("says nothing in a checkout with no dobby.config.json marker", async () => {
    const repo = makeHookTypeRepo({
      files: { "src/typebad.ts": TYPEBAD },
      marker: false,
    });

    const outcome = await editHook(repo, "src/typebad.ts");

    expectSilent(outcome);
  });

  it("says nothing about a broken sibling when the edited file is a supported non-TypeScript file", async () => {
    const repo = makeHookTypeRepo({
      files: {
        "src/settings.json": '{\n  "ok": true\n}\n',
        "src/typebad.ts": TYPEBAD,
      },
    });

    const outcome = await editHook(repo, "src/settings.json");

    expectSilent(outcome);
  });

  it("says nothing in a project that carries no tsconfig.json at all", async () => {
    const repo = makeHookTypeRepo({
      files: { "src/clean.ts": CLEAN },
      tsconfig: null,
    });

    const outcome = await editHook(repo, "src/clean.ts");

    expectSilent(outcome);
  });
});

// ---------------------------------------------------------------------------
// Slice 7 — incremental reuse must never go stale in either direction: a
// still-broken file keeps being reported, and a repaired one goes quiet.
// ---------------------------------------------------------------------------
describe("check --hook — repeated edits", () => {
  it("keeps reporting an error the agent has not fixed", async () => {
    const repo = makeHookTypeRepo({ files: { "src/typebad.ts": TYPEBAD } });

    const first = await editHook(repo, "src/typebad.ts");
    const second = await editHook(repo, "src/typebad.ts");

    expect(first.exitCode).toBe(2);
    expect(second.stderr).toMatch(/typebad\.ts:2\b/);
  });

  it("goes quiet once the agent repairs the file", async () => {
    const repo = makeHookTypeRepo({ files: { "src/typebad.ts": TYPEBAD } });
    const broken = await editHook(repo, "src/typebad.ts");
    expect(broken.exitCode).toBe(2);

    writeFileSync(join(repo, "src", "typebad.ts"), CLEAN);
    const repaired = await editHook(repo, "src/typebad.ts");

    expectSilent(repaired);
  });
});

// ---------------------------------------------------------------------------
// Slice 8 — the exported tsconfig preset turns incremental reuse on, and the
// buildinfo it writes never becomes a file git can see.
//
// The fixture here EXTENDS the shipped preset, which is how a real consumer
// consumes it — so the type error it reports is proof the preset's own settings
// drove the run, and git's own answer about untracked files is proof the
// buildinfo landed somewhere git ignores.
// ---------------------------------------------------------------------------
const presetPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tsconfig.base.json"
);

describe("the exported tsconfig preset", () => {
  it("enables incremental reuse", () => {
    const preset = JSON.parse(readFileSync(presetPath, "utf8")) as {
      compilerOptions?: { incremental?: boolean };
    };

    expect(preset.compilerOptions?.incremental).toBe(true);
  });
});

describe("check --hook — in a consumer extending the exported tsconfig preset", () => {
  let repo: string;
  let outcome: Outcome;

  beforeAll(async () => {
    repo = makeHookTypeRepo({
      files: { "src/typebad.ts": TYPEBAD },
      tsconfig: { extends: presetPath, include: ["src"] },
    });
    outcome = await editHook(repo, "src/typebad.ts");
  });

  it("reports the edited file's type error under the preset's own settings", () => {
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/typebad\.ts:2\b/);
  });

  it("leaves the working tree exactly as git last saw it, buildinfo included", () => {
    const status = gitIn(repo, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);

    expect(status).toBe("");
  });
});
