import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "./check.ts";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// These suites drive REAL tools (git, biome, tsc, knip) over scratch repos: the
// spawn budget, not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// THE GATE CACHE, WIRED INTO `check` — the per-step behavior of `dobby check`
// once the `gate-cache` module is consulted and recorded by the gate executor.
//
// Covered, in tracer-bullet order (one entry per SLICE banner below):
//   1. a FULL green gate RECORDS a green input (and a red one records nothing);
//   2. an identical second run HITS: the literal skip note, exit 0, and the
//      inferred steps genuinely SKIPPED (a lint error and a type error the gate
//      would report go unseen — `--no-cache` is the efficacy control);
//   3. a CHANGED non-inert file MISSES: the remembered green is never served
//      over a tree the gate has not judged;
//   4. a hit STILL runs the config `checks[]` extras, and their verdict is the
//      run's exit code;
//   5. SELECTIVE flags (`--lint`) consult but NEVER record;
//   6. `--no-cache` skips the consult and still records a full-gate green;
//   7. the per-file fast path and `--hook` never consult and never record;
//   8. the code hash is taken AFTER the `--fix` pass;
//   9. an unkeyable tree (no computable code hash) degrades to an honest run;
//  10. a RECORDING FAILURE surfaces as a note and never fails a green gate;
//  11. the report's `gateCached` field (the seam `ship` reads);
//  12. `--no-cache` is registered for `check` (usage + allowlist).
//
// INDEPENDENT SOURCES for every expected value here:
//   - The skip note is a LITERAL from the spec —
//     `gate skipped: inputs unchanged since last green (<short-hash> @ <at>)` —
//     with `<short-hash>`/`<at>` filled in from `.dobby/gate-cache.json`'s OWN
//     BYTES, read by this file (never recomputed the way `check` derives them).
//   - "The steps were skipped" is observed through errors placed in `docs/` — a
//     path the gate cache's INERT set excludes from the code hash (gate-cache.ts
//     documents `docs/**` as inert; its own suite pins that), so the tree's key
//     is unchanged while biome's and tsc's view of the tree is NOT. The SAME tree
//     under `--no-cache` reports both findings and exits 1, which is what makes
//     the hit run's silence meaningful rather than vacuous.
//   - "The extras still ran" is observed through a shell side effect written
//     OUTSIDE the repo (a marker log + an exit-code file), so the observer can
//     never perturb the tree it observes.
//   - Every fixture source is HAND-WRITTEN with its offending token on a line WE
//     chose (`lintbad.ts:2` → biome's noDoubleEquals; `typebad.ts:2` → tsc), so
//     "which tool reported" is read without recomputing either tool's output.
//   - "This tree is NOT the remembered one" (slice 3) is provoked by adding that
//     same hand-written source under `src/` — a MATERIAL edit by the spec's own
//     inert/material split (gate-cache.ts's suite pins an added untracked source
//     file as material), so the miss is the spec's rule, never a recomputed key.
//   - The RECORDING FAILURE (slice 10) is provoked from OUTSIDE any dobby code:
//     a plain FILE named `.dobby` at the repo root, so the cache's home cannot be
//     created at all. Its expectations are the SPEC's words — exit 0 ("never
//     fails the gate") and a note naming the gate cache — not a phrasing copied
//     from the writer.
//
// Fixture invariant (why NO repo here ships a `.gitignore`): the cache write
// itself must never change the tree it just keyed — and dobby must arrange that
// on its own, out of the working tree, so that a run over a project which ignores
// nothing still records an input set byte-identical to the next run's. These
// fixtures used to pre-seed `.gitignore` with `.dobby/` precisely to dodge a
// writer that appended to that file; the seed is gone, so every hit below is also
// a statement that recording left the tree alone.
// ===========================================================================

const dirs: string[] = [];

afterAll(() => {
  cleanupDirs(dirs);
});

// --- fixtures ---------------------------------------------------------------

// Only noDoubleEquals can fire, and the formatter is OFF — so the sole possible
// biome finding in these repos is a hand-written `==`.
const BIOME_LINT_ONLY = {
  assist: { enabled: false },
  formatter: { enabled: false },
  linter: {
    enabled: true,
    rules: { recommended: false, suspicious: { noDoubleEquals: "error" } },
  },
};

// The `--fix` fixture's config: the formatter ON (so a SAFE `--write` genuinely
// rewrites files on disk), the linter OFF (nothing unfixable can remain).
const BIOME_FORMAT_ON = {
  assist: { enabled: false },
  formatter: { enabled: true, indentStyle: "space", indentWidth: 2 },
  javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
  linter: { enabled: false },
};

const tsconfig = (include: string[]) => ({
  compilerOptions: { noEmit: true, skipLibCheck: true, strict: true },
  include,
});

// Neither tool fires on it.
const CLEAN =
  "export function ok(a: number, b: number): number {\n  return a + b;\n}\n";

// `==` on LINE 2 → biome noDoubleEquals (`lintbad.ts:2`); both operands are
// numbers, so tsc stays silent.
const LINTBAD =
  "export function eq(a: number, b: number): boolean {\n  return a == b;\n}\n";

// number <- string on LINE 2 → tsc TS2322 (`typebad.ts:2`); no `==`, so biome
// stays silent.
const TYPEBAD =
  'export function bad(): number {\n  const x: number = "nope";\n  return x;\n}\n';

// Purely format-broken (single quote, no semicolon). Under BIOME_FORMAT_ON a SAFE
// `--write` rewrites it to `export const greeting = "hello";` — known-good, worked
// by hand — leaving nothing to report.
const FORMAT_BROKEN = "export const greeting = 'hello'\n";

// A throwaway git repo shaped for the full gate: the isolated biome config, a
// strict tsconfig over `src` (`tsInclude` widens it — the consult slices also
// typecheck `docs/`, so tsc has its own inert-file discriminator), a knip-clean
// package.json (entry = all of src, so knip never contaminates a "which tool
// reported" assertion), NO `.gitignore` at all (see the fixture invariant above),
// and the given sources.
// `checks` adds a dobby.config.json with `checks[]` extras. No vite/vitest deps,
// so the build/test steps take the capability-skip path and the gate is fast.
// (`src` keys are repo-relative paths, not necessarily under `src/` — slice 10
// plants a plain `.dobby` FILE at the root through it.)
function makeCacheRepo(opts: {
  biome?: unknown;
  checks?: Array<{ name: string; run: string }>;
  src: Record<string, string>;
  tsInclude?: string[];
}): string {
  return makeScratchRepo({
    config:
      opts.checks === undefined
        ? undefined
        : { checks: opts.checks, files: [] },
    files: {
      "biome.jsonc": JSON.stringify(opts.biome ?? BIOME_LINT_ONLY, null, 2),
      "tsconfig.json": JSON.stringify(
        tsconfig(opts.tsInclude ?? ["src"]),
        null,
        2
      ),
      ...opts.src,
    },
    pkg: {
      knip: { entry: ["src/**/*.ts"], project: ["src/**/*.ts"] },
      name: "cache-fixture",
      private: true,
    },
    prefix: "dobby-cache-",
    track: dirs,
  });
}

// A scratch dir OUTSIDE any fixture repo — where a `checks[]` extra writes its
// side effects, so observing the extra can never change the tree being keyed.
function makeSideDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-cache-side-")));
  dirs.push(dir);
  return dir;
}

// Write a repo-relative file (parent dirs created) — used to drop a lint error
// into `docs/` AFTER a repo has been proven green.
function writeRepoFile(repo: string, rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// --- observers --------------------------------------------------------------

// One remembered green input, as the cache file spells it on disk.
interface GreenInput {
  at: string;
  hash: string;
}

const cachePath = (repo: string) => join(repo, ".dobby", "gate-cache.json");

// The green inputs the cache file carries, read from its LITERAL BYTES (the
// independent observer for "was this run recorded"). An absent file is no
// recording at all.
function readGreenInputs(repo: string): GreenInput[] {
  const path = cachePath(repo);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    greenInputs?: GreenInput[];
  };
  return parsed.greenInputs ?? [];
}

// The most-recent recorded green input — throwing (test scaffolding, not data)
// when nothing was recorded, so a fixture that never went green fails loudly.
function firstGreenInput(repo: string): GreenInput {
  const [entry] = readGreenInputs(repo);
  if (entry === undefined) {
    throw new Error(`no green input recorded at ${cachePath(repo)}`);
  }
  return entry;
}

// The skip note, LITERALLY as the spec words it, filled in from a recorded
// entry: the short hash is its first 8 characters, `<at>` its stored timestamp
// (the moment the tree was PROVEN green — not the moment it was re-served).
function skipNote(entry: GreenInput): string {
  return `gate skipped: inputs unchanged since last green (${entry.hash.slice(0, 8)} @ ${entry.at})`;
}

// A note may land on either channel — search both.
const combined = (r: { stdout: string; stderr: string }) =>
  `${r.stdout}\n${r.stderr}`;

// The PostToolUse payload shape `check --hook` parses.
function hookStdin(filePath: string): string {
  return JSON.stringify({
    session_id: "cache-test",
    tool_input: { file_path: filePath },
    tool_name: "Edit",
  });
}

// ---------------------------------------------------------------------------
// Slice 1 (tracer bullet): a FULL green gate records a green input.
// The smallest end-to-end proof that the cache is wired at all — and its safety
// twin: a RED gate must record NOTHING (a cached red would hand every later run
// a verdict nothing ever earned).
// ---------------------------------------------------------------------------
describe("run() — check records a green input after a full green gate", () => {
  it("writes one green input to .dobby/gate-cache.json when the full gate exits 0", async () => {
    const repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
    expect(existsSync(cachePath(repo))).toBe(false);

    const result = await run(["check"], repo);
    expect(result.exitCode).toBe(0);

    const inputs = readGreenInputs(repo);
    expect(inputs).toHaveLength(1);
    const entry = firstGreenInput(repo);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  it("records nothing when the full gate is red", async () => {
    const repo = makeCacheRepo({
      src: { "src/clean.ts": CLEAN, "src/lintbad.ts": LINTBAD },
    });

    const result = await run(["check"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
    expect(readGreenInputs(repo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 2: the consult — an unchanged tree HITS, and the hit really skips.
// The repo is primed green, then a lint error AND a type error are dropped into
// `docs/` (INERT to the code hash, VISIBLE to biome and — this fixture widens
// tsconfig's `include` — to tsc): a hit stays silent about both, while the same
// tree under `--no-cache` reports both. That control is what makes the silence
// meaningful rather than vacuous.
// ---------------------------------------------------------------------------
describe("run() — check consults the gate cache and skips the gate on a hit", () => {
  let repo: string;
  let recorded: GreenInput;
  let primeOutput: string;

  beforeAll(async () => {
    repo = makeCacheRepo({
      src: { "src/clean.ts": CLEAN },
      tsInclude: ["src", "docs"],
    });
    const prime = await run(["check"], repo);
    expect(prime.exitCode).toBe(0);
    primeOutput = combined(prime);
    // Captured BEFORE any hit run: the note must name the run that actually
    // proved the tree green.
    recorded = firstGreenInput(repo);
    // Inert to the key, visible to the gate.
    writeRepoFile(repo, "docs/lintbad.ts", LINTBAD);
    writeRepoFile(repo, "docs/typebad.ts", TYPEBAD);
  });

  it("gates normally on the first run (a miss prints no skip note)", () => {
    expect(primeOutput).not.toContain("gate skipped");
  });

  it("prints the skip note naming the recorded hash and timestamp, and exits 0", async () => {
    const result = await run(["check"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).toContain(skipNote(recorded));
  });

  it("skips the inferred steps: neither the lint nor the type error the gate would report is seen", async () => {
    const result = await run(["check"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).not.toMatch(/lintbad/);
    expect(combined(result)).not.toMatch(/typebad/);
  });

  it("under --no-cache runs every step on that same tree and reports both errors", async () => {
    const result = await run(["check", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
    expect(result.stdout).toMatch(/typebad\.ts:2\b/);
    expect(combined(result)).not.toContain("gate skipped");
  });
});

// ---------------------------------------------------------------------------
// Slice 3: the SAFETY TWIN of slice 2 — a remembered green is never served over
// a tree the gate has not judged. Every "skip" slice deliberately changes only
// INERT files, so on its own the suite would stay green for a wiring bug that
// consulted with a constant or stale key (a hash taken before the tree the gate
// actually judges): broken code would be waved through by a cached pass. Here
// the change is MATERIAL — the same `lintbad.ts` fixture, this time under
// `src/` — and the gate must run again and report it.
// ---------------------------------------------------------------------------
describe("run() — check misses when a non-inert file changes after a green", () => {
  let repo: string;
  let recorded: GreenInput;
  let hit: { exitCode: number; stderr: string; stdout: string };

  beforeAll(async () => {
    repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
    const prime = await run(["check"], repo);
    expect(prime.exitCode).toBe(0);
    // Captured BEFORE any hit run — the run that actually proved it green.
    recorded = firstGreenInput(repo);
    // Control: this very tree IS remembered and IS served from the cache, so the
    // miss below is the new source file and not a cache that never answers.
    hit = await run(["check"], repo);
    writeRepoFile(repo, "src/lintbad.ts", LINTBAD);
  });

  it("serves the unchanged tree from the cache first", () => {
    expect(hit.exitCode).toBe(0);
    expect(combined(hit)).toContain(skipNote(recorded));
  });

  it("gates again and reports the lint error the recorded green never saw", async () => {
    const result = await run(["check"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
    expect(combined(result)).not.toContain("gate skipped");
  });
});

// ---------------------------------------------------------------------------
// Slice 4: a hit still runs the config `checks[]` extras — they may read inert
// files no hash covers — and THEIR verdict is the run's exit code.
// The extra appends a mark to a log OUTSIDE the repo and exits with the code an
// outside file names, so both facets are observed without touching the tree.
// ---------------------------------------------------------------------------
describe("run() — a gate-cache hit still runs the config checks[] extras", () => {
  let repo: string;
  let recorded: GreenInput;
  let log: string;
  let codeFile: string;

  const marks = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

  beforeAll(async () => {
    const side = makeSideDir();
    log = join(side, "extra.log");
    codeFile = join(side, "extra.code");
    writeFileSync(codeFile, "0\n");
    repo = makeCacheRepo({
      checks: [
        {
          name: "marker",
          run: `printf x >> '${log}'; exit $(cat '${codeFile}')`,
        },
      ],
      src: { "src/clean.ts": CLEAN },
    });
    const prime = await run(["check"], repo);
    expect(prime.exitCode).toBe(0);
    recorded = firstGreenInput(repo);
  });

  it("runs the extra a second time on a hit", async () => {
    expect(marks()).toBe("x");
    const result = await run(["check"], repo);
    expect(combined(result)).toContain(skipNote(recorded));
    expect(marks()).toBe("xx");
  });

  it("fails the run when an extra fails on a hit (the extras' verdict is the exit code)", async () => {
    writeFileSync(codeFile, "1\n");
    const result = await run(["check"], repo);
    expect(combined(result)).toContain(skipNote(recorded));
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Slice 5: selective flags CONSULT (a full-green hit proves any subset) but
// NEVER record (a `--lint`-only green must not mark the whole gate green).
// ---------------------------------------------------------------------------
describe("run() — selective flags consult the gate cache", () => {
  let repo: string;
  let recorded: GreenInput;

  beforeAll(async () => {
    repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
    const prime = await run(["check"], repo);
    expect(prime.exitCode).toBe(0);
    recorded = firstGreenInput(repo);
    writeRepoFile(repo, "docs/lintbad.ts", LINTBAD);
  });

  it("skips --lint with the same note when the tree carries a full-green input", async () => {
    const result = await run(["check", "--lint"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).toContain(skipNote(recorded));
    expect(combined(result)).not.toMatch(/lintbad/);
  });

  it("under --lint --no-cache runs biome on that same tree and reports the lint error", async () => {
    const result = await run(["check", "--lint", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
  });
});

describe("run() — selective flags never record a green input", () => {
  let repo: string;

  beforeAll(() => {
    // Lint-clean but TYPE-broken: `--lint` is green, the full gate is not.
    repo = makeCacheRepo({ src: { "src/typebad.ts": TYPEBAD } });
  });

  it("records nothing after a green --lint run", async () => {
    const result = await run(["check", "--lint"], repo);
    expect(result.exitCode).toBe(0);
    expect(readGreenInputs(repo)).toEqual([]);
  });

  it("so the full gate still runs afterwards and reports the type error", async () => {
    const result = await run(["check"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/typebad\.ts:2\b/);
  });
});

// ---------------------------------------------------------------------------
// Slice 6: `--no-cache` skips the CONSULT but still RECORDS a full-gate green
// (turbo `--force` semantics) — so the next ordinary run is served from it.
// ---------------------------------------------------------------------------
describe("run() — check --no-cache still records a full-gate green", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
  });

  it("records the green input even though the consult was skipped", async () => {
    const result = await run(["check", "--no-cache"], repo);
    expect(result.exitCode).toBe(0);
    expect(readGreenInputs(repo)).toHaveLength(1);
  });

  it("serves the following ordinary check from that recorded input", async () => {
    const recorded = firstGreenInput(repo);
    const result = await run(["check"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).toContain(skipNote(recorded));
  });
});

// ---------------------------------------------------------------------------
// Slice 7: the per-file fast path and `--hook` never touch the cache — neither
// consulting it (they must judge the file in front of them) nor recording one
// (they never ran the gate).
// ---------------------------------------------------------------------------
describe("run() — the per-file fast path never touches the gate cache", () => {
  let repo: string;

  beforeAll(async () => {
    repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
    const prime = await run(["check"], repo);
    expect(prime.exitCode).toBe(0);
    writeRepoFile(repo, "docs/lintbad.ts", LINTBAD);
  });

  it("checks the named file even when the tree carries a full-green input", async () => {
    const result = await run(["check", "docs/lintbad.ts"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
    expect(combined(result)).not.toContain("gate skipped");
  });

  it("records nothing when a per-file check passes", async () => {
    const fresh = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
    const result = await run(["check", "src/clean.ts"], fresh);
    expect(result.exitCode).toBe(0);
    expect(readGreenInputs(fresh)).toEqual([]);
  });
});

describe("run() — check --hook never touches the gate cache", () => {
  it("records nothing after an edit-time hook run", async () => {
    const repo = makeCacheRepo({ checks: [], src: { "src/clean.ts": CLEAN } });
    const result = await run(
      ["check", "--hook"],
      repo,
      hookStdin(join(repo, "src", "clean.ts"))
    );
    expect(result.exitCode).toBe(0);
    expect(readGreenInputs(repo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 8: the code hash is taken AFTER the project-wide `--fix` pass, which
// mutates the tree. A hash taken BEFORE would key the pre-fix bytes, and the
// very next run — over the tree `--fix` left behind — would miss.
// ---------------------------------------------------------------------------
describe("run() — the code hash is taken after the --fix pass", () => {
  it("records the FIXED tree, so the next ordinary check hits", async () => {
    const repo = makeCacheRepo({
      biome: BIOME_FORMAT_ON,
      src: { "src/greeting.ts": FORMAT_BROKEN },
    });
    const file = join(repo, "src", "greeting.ts");

    const fixed = await run(["check", "--fix"], repo);
    expect(fixed.exitCode).toBe(0);
    // Anti-vacuity guard: the fix pass genuinely rewrote the tree this run keyed.
    expect(readFileSync(file, "utf8")).toContain('"hello";');

    const recorded = firstGreenInput(repo);
    const second = await run(["check"], repo);
    expect(second.exitCode).toBe(0);
    expect(combined(second)).toContain(skipNote(recorded));
  });
});

// ---------------------------------------------------------------------------
// Slice 9: an UNKEYABLE tree degrades to an honest gate run. The code hash is
// null when the tree cannot be enumerated, and a path carrying a NEWLINE is one
// such tree (git's `--stdin-paths` is one path per line, so it cannot express
// that name at all). The gate must then run everything, record nothing, and
// neither error nor say anything about the cache.
// ---------------------------------------------------------------------------
describe("run() — check on a tree with no computable code hash", () => {
  it("gates normally, records nothing, and stays silent about the cache", async () => {
    const repo = makeCacheRepo({
      src: { "src/clean.ts": CLEAN, "we\nird.txt": "x\n" },
    });

    const first = await run(["check"], repo);
    expect(first.exitCode).toBe(0);
    expect(readGreenInputs(repo)).toEqual([]);

    // Nothing was ever keyed, so the second run gates again — no note, no error.
    const second = await run(["check"], repo);
    expect(second.exitCode).toBe(0);
    expect(combined(second)).not.toContain("gate skipped");
  });
});

// ---------------------------------------------------------------------------
// Slice 10: bookkeeping can never fail a green gate. Recording is a WRITE to the
// filesystem, and a write can fail for reasons that say nothing about the code
// the gate just judged — so a failed recording is a NOTE, and the gate still
// exits on the verdict its steps earned.
//
// The failure is provoked from outside any dobby code: a plain FILE named
// `.dobby` at the repo root means the cache's own home cannot be created. (The
// ignore rule dobby keeps for itself names a DIRECTORY — `.dobby/` — so this file
// is an ordinary tracked input and the tree still has a key; the write is the only
// casualty.)
// ---------------------------------------------------------------------------
describe("run() — check when the green input cannot be written", () => {
  let repo: string;
  let result: { exitCode: number; stderr: string; stdout: string };
  let control: { exitCode: number; stderr: string; stdout: string };

  beforeAll(async () => {
    repo = makeCacheRepo({
      src: { ".dobby": "not a directory\n", "src/clean.ts": CLEAN },
    });
    result = await run(["check"], repo);
    // The SAME fixture with the blocker removed — the run whose recording works.
    control = await run(
      ["check"],
      makeCacheRepo({ src: { "src/clean.ts": CLEAN } })
    );
  });

  it("still exits 0 — the gate's own verdict, not the bookkeeping's", () => {
    expect(result.exitCode).toBe(0);
  });

  it("surfaces the failure as a note naming the gate cache", () => {
    // Control first: a run that recorded fine says nothing about the cache, so
    // the note below is the FAILURE speaking and not boilerplate every run
    // prints.
    expect(combined(control)).not.toMatch(/gate cache/i);
    expect(combined(result)).toMatch(/gate cache/i);
  });

  it("remembers nothing, so the next run gates again instead of being served a green that was never stored", async () => {
    expect(readGreenInputs(repo)).toEqual([]);
    const second = await run(["check"], repo);
    expect(second.exitCode).toBe(0);
    expect(combined(second)).not.toContain("gate skipped");
  });
});

// ---------------------------------------------------------------------------
// Slice 11: the report field `ship` reads — `gateCached` carries the note line
// on a hit, null otherwise, and the same note ALSO travels in `notes[]` so
// `dobby check` renders it without a formatter change.
// ---------------------------------------------------------------------------
describe("check() — the report's gateCached field", () => {
  it("is null when the run actually gated", () => {
    const repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
    const report = check([], repo, {});
    if (!report.ok) {
      throw new Error(report.error);
    }
    expect(report.exitCode).toBe(0);
    expect(report.gateCached).toBeNull();
    // The in-process gate is the same run the CLI makes: it recorded.
    expect(readGreenInputs(repo)).toHaveLength(1);
  });

  it("carries the skip note on a hit, and the same note travels in notes[]", async () => {
    const repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
    const prime = await run(["check"], repo);
    expect(prime.exitCode).toBe(0);
    const expected = skipNote(firstGreenInput(repo));

    const report = check([], repo, {});
    if (!report.ok) {
      throw new Error(report.error);
    }
    expect(report.gateCached).toBe(expected);
    expect(report.notes.map((note) => note.text)).toContain(expected);
  });
});

// ---------------------------------------------------------------------------
// Slice 12: `--no-cache` is a registered flag OF `check` — advertised in the
// usage Options block, and refused (naming flag and command) on any other.
// ---------------------------------------------------------------------------
describe("run() — the --no-cache flag is registered for check", () => {
  let repo: string;

  beforeAll(() => {
    repo = makeCacheRepo({ src: { "src/clean.ts": CLEAN } });
  });

  it("advertises --no-cache in the usage Options block as a check flag", async () => {
    const result = await run([], repo);
    const advertised = result.stdout
      .split("\n")
      .some((line) => /^\s+--no-cache\s+check:/.test(line));
    expect(advertised).toBe(true);
  });

  it("refuses --no-cache on another command, naming the flag and the command", async () => {
    const result = await run(["env", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag --no-cache");
    expect(result.stderr).toContain("dobby env");
  });
});
