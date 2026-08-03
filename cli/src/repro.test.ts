import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  useSpawnBudget,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ---------------------------------------------------------------------------
// `dobby repro` — the red/green capture harness.
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008): these tests
// never spawn the bin and never import `repro.ts` directly, so the module can be
// restructured freely as long as the COMMAND behaves.
//
// Where every expected value comes from (all INDEPENDENT of the implementation):
//  - `verdict: "red" | "green"` (red = nonzero exit), `matched` (verdict ===
//    expect, null without --expect), the payload key list, the exit-code rule
//    (0 matched / 0 without --expect / 1 on mismatch) and the persistence path
//    `.dobby/repro/<reproId>.json` are the SPEC's own literals.
//  - The child's behavior is POSIX truth, not something repro derives: `sh -c
//    'exit 3'` exits 3, `echo x >&2` writes to stderr, `sleep 0.25` burns at
//    least 250ms of wall clock, an awk loop of 20 000 lines prints exactly
//    20 000 lines.
//  - The flakiness / timing numbers are WORKED EXAMPLES: the stub scripts below
//    decide, from a counter file WE seed, exactly which run is red and exactly
//    which run sleeps — so `redCount`, `reproductionRate`, `firstDivergent.run`
//    and the shape of the duration distribution are known before any code runs.
//
// PINNED BY THIS FILE (the spec is silent; the tests fix the contract — see the
// test-author work log): `firstDivergent.run` is 1-BASED; `reproductionRate` is
// redCount / runs; `--bench` adds `baseline` (null on the first bench for a
// reproId) and `delta` (current MINUS baseline, so faster-than-baseline is
// negative) alongside the stats.
// ---------------------------------------------------------------------------

// The single-run record the spec enumerates, plus the fields --repeat / --bench
// add. Declared here purely so the assertions read in the domain's vocabulary —
// nothing in this file recomputes any of it.
interface ReproPayload {
  baseline?: { median: number } | null;
  delta?: { median: number } | null;
  deterministic?: boolean;
  durationMs: number;
  durations?: number[];
  exitCode: number;
  firstDivergent?: { run: number; stdout: string; stderr: string } | null;
  greenCount?: number;
  invocation: { argv: string[]; cwd: string };
  matched: boolean | null;
  max?: number;
  mean?: number;
  median?: number;
  min?: number;
  redCount?: number;
  reproductionRate?: number;
  reproId: string;
  // --repeat
  runs?: number;
  // --bench
  samples?: number;
  stderr: string;
  stdout: string;
  verdict: string;
}

const scratchDirs: string[] = [];

// A throwaway git repo (the shared scratch-repo seam), realpath-normalized so it
// matches the workroot git itself reports (macOS /var -> /private/var).
// `files` seeds the stub scripts / counter files a slice needs.
function makeRepo(files?: Record<string, string>): string {
  return makeScratchRepo({
    // repro only needs a workroot to pin the child's cwd to — it never reads git
    // history, so the fixture skips the initial commit (and its per-repo cost).
    commit: false,
    files,
    prefix: "dobby-repro-",
    track: scratchDirs,
  });
}

// A directory that is NOT a git repo — no workroot to pin the command's cwd to.
function makePlainDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-repro-nogit-")));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  cleanupDirs(scratchDirs);
  scratchDirs.length = 0;
});

// Run the command and parse the `--json` payload. `--json` renders as ONE JSON
// line and is the only stdout (the CLI's established contract), so a failure to
// parse means the payload never arrived.
async function reproJson(
  repo: string,
  args: string[]
): Promise<{ payload: ReproPayload; exitCode: number; stderr: string }> {
  const result = await run(["repro", "--json", ...args], repo);
  let payload: ReproPayload;
  try {
    payload = JSON.parse(result.stdout) as ReproPayload;
  } catch (error) {
    throw new Error(
      `repro --json produced no payload — stdout: ${JSON.stringify(result.stdout)}, stderr: ${result.stderr.trim()}`,
      { cause: error }
    );
  }
  return { exitCode: result.exitCode, payload, stderr: result.stderr };
}

// The spec's own example command: the canonical red loop.
const RED_CMD = ["sh", "-c", "exit 1"];
const GREEN_CMD = ["sh", "-c", "exit 0"];

// ---------------------------------------------------------------------------
// Slice 1 — the single-run artifact (the first tracer bullet).
//
// `repro -- sh -c 'exit 1' --expect red` -> `{verdict:"red", matched:true}` is the
// task's own verify recipe: everything else in this file builds on it.
// ---------------------------------------------------------------------------

describe("repro — single run verdict", () => {
  it("judges a command that exits nonzero as red", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...RED_CMD]);
    expect(payload.verdict).toBe("red");
  });

  it("judges a command that exits zero as green", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...GREEN_CMD]);
    expect(payload.verdict).toBe("green");
  });

  it("records the command after `--` as the invocation argv", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...RED_CMD]);
    expect(payload.invocation.argv).toEqual(["sh", "-c", "exit 1"]);
  });

  it("carries the whole single-run record the spec enumerates", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...RED_CMD]);
    const record = payload as unknown as Record<string, unknown>;
    for (const key of [
      "invocation",
      "exitCode",
      "stdout",
      "stderr",
      "durationMs",
      "verdict",
      "matched",
      "reproId",
    ]) {
      expect(Object.hasOwn(record, key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — the expectation, and the exit code that carries it.
//
// The whole point of --expect: the harness JUDGES the loop, so the model never
// has to read output to decide whether it reproduced. A mismatch is the "your
// loop is not red-capable" signal, and it is the ONLY nonzero exit of a run that
// completed.
// ---------------------------------------------------------------------------

describe("repro — expectation matching", () => {
  it("matches when the verdict equals --expect", async () => {
    const { payload } = await reproJson(makeRepo(), [
      "--expect",
      "red",
      "--",
      ...RED_CMD,
    ]);
    expect(payload.matched).toBe(true);
  });

  it("does not match when the verdict differs from --expect", async () => {
    const { payload } = await reproJson(makeRepo(), [
      "--expect",
      "red",
      "--",
      ...GREEN_CMD,
    ]);
    expect(payload.matched).toBe(false);
  });

  it("reports a null match when no --expect is given", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...RED_CMD]);
    const record = payload as unknown as Record<string, unknown>;
    // Explicitly null, never absent: JSON.stringify drops undefined, so the key
    // has to survive the round trip.
    expect(Object.hasOwn(record, "matched")).toBe(true);
    expect(payload.matched).toBeNull();
  });

  it("exits 0 when the verdict matches --expect", async () => {
    const { exitCode } = await reproJson(makeRepo(), [
      "--expect",
      "red",
      "--",
      ...RED_CMD,
    ]);
    expect(exitCode).toBe(0);
  });

  it("exits 1 when the verdict differs from --expect", async () => {
    const { exitCode } = await reproJson(makeRepo(), [
      "--expect",
      "red",
      "--",
      ...GREEN_CMD,
    ]);
    expect(exitCode).toBe(1);
  });

  it("exits 0 for a failing command when no --expect is given", async () => {
    // The harness reports, it does not inherit: the command failed (verdict red,
    // captured exitCode 1) but `repro` itself ran fine.
    const { exitCode, payload } = await reproJson(makeRepo(), [
      "--",
      ...RED_CMD,
    ]);
    expect(exitCode).toBe(0);
    expect(payload.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — capture. The artifact IS the pasted invocation + output, so the
// output has to arrive whole and unmixed.
// ---------------------------------------------------------------------------

describe("repro — output capture", () => {
  it("captures stdout and stderr as separate streams", async () => {
    const { payload } = await reproJson(makeRepo(), [
      "--",
      "sh",
      "-c",
      "echo out-marker; echo err-marker >&2",
    ]);
    expect(payload.stdout).toContain("out-marker");
    expect(payload.stdout).not.toContain("err-marker");
    expect(payload.stderr).toContain("err-marker");
  });

  it("preserves the command's own exit code, not just its verdict", async () => {
    const { payload } = await reproJson(makeRepo(), [
      "--",
      "sh",
      "-c",
      "exit 3",
    ]);
    expect(payload.exitCode).toBe(3);
  });

  it("captures long output whole, without truncating it", async () => {
    // 20 000 lines (~220 KB) printed by awk — well under any runner buffer
    // ceiling, so anything missing was dropped by repro itself.
    const { payload } = await reproJson(makeRepo(), [
      "--",
      "awk",
      'BEGIN { for (i = 1; i <= 20000; i++) print "line-" i }',
    ]);
    const lines = payload.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(20_000);
    expect(lines[0]).toBe("line-1");
    expect(lines.at(-1)).toBe("line-20000");
  });

  it("measures the wall-clock duration of the run", async () => {
    // `sleep 0.25` burns at least 250ms of real time; the measurement can only be
    // longer (spawn overhead), never shorter.
    const { payload } = await reproJson(makeRepo(), [
      "--",
      "sh",
      "-c",
      "sleep 0.25",
    ]);
    expect(payload.durationMs).toBeGreaterThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Slice 3b — the command that never starts: a typo'd binary is a RED run like any
// other, not a hole in the record.
//
// This is the one path where the child hands back no exit code of its own, and
// the two runtimes spell that differently (node: `status: null`, Bun — what the
// `dobby` bin runs on: `undefined`), so it is exactly where the "the record
// always carries the 8 keys" contract is easiest to lose: an `undefined` exitCode
// is DROPPED by JSON.stringify, from both the payload and the persisted record.
// The name below cannot exist on $PATH, so this is runtime truth, not something
// repro derives.
// ---------------------------------------------------------------------------

const MISSING_BIN = "dobby-definitely-not-a-real-binary-xyz";
const MISSING_CMD = [MISSING_BIN];

describe("repro — a command that cannot be spawned", () => {
  it("judges an unspawnable command as red", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...MISSING_CMD]);
    expect(payload.verdict).toBe("red");
  });

  it("still reports a nonzero exitCode when the child never started", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...MISSING_CMD]);
    const record = payload as unknown as Record<string, unknown>;
    expect(Object.hasOwn(record, "exitCode")).toBe(true);
    expect(payload.exitCode).not.toBe(0);
    expect(typeof payload.exitCode).toBe("number");
  });

  it("surfaces the spawn failure in the captured stderr", async () => {
    const { payload } = await reproJson(makeRepo(), ["--", ...MISSING_CMD]);
    expect(payload.stderr).toContain(MISSING_BIN);
    // node says `spawnSync <cmd> ENOENT`, Bun `Executable not found in $PATH`.
    expect(payload.stderr).toMatch(/enoent|not found/i);
  });

  it("persists the same nonzero exitCode in the record", async () => {
    const repo = makeRepo();
    const { payload } = await reproJson(repo, ["--", ...MISSING_CMD]);
    const stored = readFileSync(
      join(repo, ".dobby", "repro", `${payload.reproId}.json`),
      "utf8"
    );
    // Asserted on the RAW text, so the record's own nesting stays free: what
    // matters is that the key reached the file with the reported value, rather
    // than being dropped as an `undefined`.
    expect(stored).toMatch(new RegExp(`"exitCode":\\s*${payload.exitCode}\\b`));
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — the workroot invariant: every dobby child runs with its cwd pinned to
// the git top level, and an action command fails hard outside a git repo.
// ---------------------------------------------------------------------------

describe("repro — workroot", () => {
  it("runs the command from the workroot even when invoked in a subdirectory", async () => {
    const repo = makeRepo({
      "marker.txt": "workroot-marker\n",
      "nested/deep/placeholder": "",
    });
    const nested = join(repo, "nested", "deep");

    const { payload } = await reproJson(nested, ["--", "cat", "marker.txt"]);

    expect(payload.stdout).toContain("workroot-marker");
    expect(payload.invocation.cwd).toBe(repo);
  });

  it("fails hard outside a git repository", async () => {
    const result = await run(["repro", "--", ...GREEN_CMD], makePlainDir());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/git/i);
    expect(result.stderr).not.toContain("not implemented");
  });
});

// ---------------------------------------------------------------------------
// Slice 5 — the reproId and the record it keys.
//
// The id is a short hash of argv + cwd, so it is STABLE for one loop in one
// worktree and DISTINCT across loops or worktrees — that identity is what lets a
// later run compare against a stored baseline (one change at a time).
// ---------------------------------------------------------------------------

describe("repro — reproId", () => {
  it("derives the same reproId for the same command in the same workroot", async () => {
    const repo = makeRepo();
    const first = await reproJson(repo, ["--", ...RED_CMD]);
    const second = await reproJson(repo, ["--", ...RED_CMD]);
    expect(second.payload.reproId).toBe(first.payload.reproId);
  });

  it("derives a filename-safe short id", async () => {
    // It names a file at .dobby/repro/<reproId>.json, so: no separators, no
    // whitespace, and short enough to read in a summary line.
    const { payload } = await reproJson(makeRepo(), ["--", ...RED_CMD]);
    expect(payload.reproId).toMatch(/^[\w-]{6,32}$/);
  });

  it("derives a different reproId for a different command", async () => {
    const repo = makeRepo();
    const red = await reproJson(repo, ["--", ...RED_CMD]);
    const green = await reproJson(repo, ["--", ...GREEN_CMD]);
    expect(green.payload.reproId).not.toBe(red.payload.reproId);
  });

  it("derives a different reproId for the same command in another workroot", async () => {
    const here = await reproJson(makeRepo(), ["--", ...RED_CMD]);
    const there = await reproJson(makeRepo(), ["--", ...RED_CMD]);
    expect(there.payload.reproId).not.toBe(here.payload.reproId);
  });

  it("keys the reproId on the command, not on repro's own flags", async () => {
    const repo = makeRepo();
    const plain = await reproJson(repo, ["--", ...RED_CMD]);
    const repeated = await reproJson(repo, ["--repeat", "2", "--", ...RED_CMD]);
    expect(repeated.payload.reproId).toBe(plain.payload.reproId);
  });
});

describe("repro — persisted record", () => {
  it("persists the run at .dobby/repro/<reproId>.json under the workroot", async () => {
    const repo = makeRepo();
    const { payload } = await reproJson(repo, ["--", ...RED_CMD]);
    const record = join(repo, ".dobby", "repro", `${payload.reproId}.json`);
    expect(existsSync(record)).toBe(true);
    expect(() => JSON.parse(readFileSync(record, "utf8"))).not.toThrow();
  });

  it("keeps the LATEST run for a reproId that is run again", async () => {
    // Same argv both times (so the same reproId), but the loop flips from red to
    // green because the command reads its exit code from a file we rewrite.
    const repo = makeRepo();
    const cmd = ["sh", "-c", "exit $(cat exit-code)"];

    writeFileSync(join(repo, "exit-code"), "1\n");
    const red = await reproJson(repo, ["--", ...cmd]);
    const file = join(repo, ".dobby", "repro", `${red.payload.reproId}.json`);
    expect(readFileSync(file, "utf8")).toContain("red");

    writeFileSync(join(repo, "exit-code"), "0\n");
    await reproJson(repo, ["--", ...cmd]);
    expect(readFileSync(file, "utf8")).toContain("green");
  });
});

// ---------------------------------------------------------------------------
// Slice 6 — `--repeat N`: the flakiness probe.
//
// The flaky stub is a WORKED EXAMPLE: it reads a counter file we seed at 1 and
// bumps it each run, failing on runs 1-3 and passing on runs 4-5. So a
// `--repeat 5` gives 3 red / 2 green -> reproductionRate 0.6 (red over runs; a
// green-based rate would read 0.4) and the FIRST divergence is run 4.
// ---------------------------------------------------------------------------

const FLAKY_SH = `#!/bin/sh
n=$(cat flaky-count)
echo $((n + 1)) > flaky-count
if [ "$n" -le 3 ]; then
  echo "red-run $n"
  exit 1
fi
echo "green-run $n"
exit 0
`;

function makeFlakyRepo(): string {
  return makeRepo({ "flaky-count": "1\n", "flaky.sh": FLAKY_SH });
}

const FLAKY_CMD = ["sh", "flaky.sh"];

describe("repro — --repeat over a deterministic loop", () => {
  it("counts every run of a loop that always fails", async () => {
    const { payload } = await reproJson(makeRepo(), [
      "--repeat",
      "3",
      "--",
      ...RED_CMD,
    ]);
    expect(payload.runs).toBe(3);
    expect(payload.redCount).toBe(3);
    expect(payload.greenCount).toBe(0);
  });

  it("reports full reproduction and no divergence for a loop that always fails", async () => {
    const { payload } = await reproJson(makeRepo(), [
      "--repeat",
      "3",
      "--",
      ...RED_CMD,
    ]);
    expect(payload.reproductionRate).toBe(1);
    expect(payload.deterministic).toBe(true);
    expect(payload.firstDivergent).toBeNull();
  });

  it("reports one duration per run", async () => {
    const { payload } = await reproJson(makeRepo(), [
      "--repeat",
      "3",
      "--",
      ...RED_CMD,
    ]);
    expect(payload.durations).toHaveLength(3);
  });
});

describe("repro — --repeat over a flaky loop", () => {
  it("reports the reproduction rate of a loop that fails 3 times out of 5", async () => {
    const { payload } = await reproJson(makeFlakyRepo(), [
      "--repeat",
      "5",
      "--",
      ...FLAKY_CMD,
    ]);
    expect(payload.redCount).toBe(3);
    expect(payload.greenCount).toBe(2);
    expect(payload.reproductionRate).toBe(0.6);
  });

  it("flags a flaky loop as non-deterministic", async () => {
    const { payload } = await reproJson(makeFlakyRepo(), [
      "--repeat",
      "5",
      "--",
      ...FLAKY_CMD,
    ]);
    expect(payload.deterministic).toBe(false);
  });

  it("reports the first run whose outcome diverged, with its output", async () => {
    // Runs 1-3 are red, run 4 is the first green: the divergence to paste.
    const { payload } = await reproJson(makeFlakyRepo(), [
      "--repeat",
      "5",
      "--",
      ...FLAKY_CMD,
    ]);
    expect(payload.firstDivergent?.run).toBe(4);
    expect(payload.firstDivergent?.stdout).toContain("green-run 4");
  });
});

// ---------------------------------------------------------------------------
// Slice 7 — `--bench`: the timing probe and its baseline.
//
// The bench stub is a WORKED EXAMPLE too: over 3 runs only the MIDDLE one sleeps
// 0.8s, so the durations are roughly [fast, slow, fast]. That distribution pins
// the statistics independently — the median must be a FAST sample (the middle of
// the SORTED samples, not the middle of the raw sequence) while the mean is
// dragged up by the slow one.
// ---------------------------------------------------------------------------

const BENCH_SH = `#!/bin/sh
n=$(cat bench-count)
echo $((n + 1)) > bench-count
if [ "$n" = "2" ]; then
  sleep 0.8
fi
exit 0
`;

function makeBenchRepo(): string {
  return makeRepo({ "bench-count": "1\n", "bench.sh": BENCH_SH });
}

const BENCH_CMD = ["sh", "bench.sh"];

// One statistic of a `--bench` payload, as a NUMBER: the fields are optional on
// the payload type (they exist only under `--bench`), and a missing one is a
// failure of the command, not a comparison against `undefined` that silently
// reads as "well, it isn't 500ms apart".
function stat(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`--bench payload carries no \`${name}\``);
  }
  return value;
}

describe("repro — --bench statistics", () => {
  it("summarizes one sample per run", async () => {
    const { payload } = await reproJson(makeBenchRepo(), [
      "--bench",
      "--repeat",
      "3",
      "--",
      ...BENCH_CMD,
    ]);
    expect(payload.samples).toBe(3);
  });

  it("reports the slowest and fastest run", async () => {
    const { payload } = await reproJson(makeBenchRepo(), [
      "--bench",
      "--repeat",
      "3",
      "--",
      ...BENCH_CMD,
    ]);
    expect(payload.max).toBeGreaterThanOrEqual(700);
    // The fast/slow SPREAD, never an absolute ceiling on the fast run: the only
    // difference between the two is the stub's own 0.8s sleep, while machine load
    // (the full suite runs these spawn-heavy files in parallel) inflates every
    // sample alike — an absolute `min < 300` measures the CI box, not the probe.
    expect(
      stat(payload.max, "max") - stat(payload.min, "min")
    ).toBeGreaterThanOrEqual(500);
  });

  it("reports the median over sorted samples and a mean dragged up by the slow run", async () => {
    const { payload } = await reproJson(makeBenchRepo(), [
      "--bench",
      "--repeat",
      "3",
      "--",
      ...BENCH_CMD,
    ]);
    // Durations are ~[fast, 800+, fast]: the median is a fast sample, the mean is
    // above a third of the slow one. "Fast" is asserted as the DISTANCE from the
    // slow sample (same reason as the slice above — an absolute ceiling measures
    // the machine): a median taken over the RAW sequence would land on the slow
    // run and collapse that distance to zero.
    expect(
      stat(payload.max, "max") - stat(payload.median, "median")
    ).toBeGreaterThanOrEqual(500);
    expect(payload.mean).toBeGreaterThanOrEqual(200);
  });
});

// The delta stub sleeps 0.6s on its first two runs only, so the FIRST benched
// invocation (2 runs) is slow and stores a slow baseline, and the SECOND
// invocation of the very same command is fast — a negative delta.
const DELTA_SH = `#!/bin/sh
n=$(cat delta-count)
echo $((n + 1)) > delta-count
if [ "$n" -le 2 ]; then
  sleep 0.6
fi
exit 0
`;

const DELTA_CMD = ["sh", "delta.sh"];

describe("repro — --bench baseline", () => {
  it("reports no baseline on the first benchmark of a reproId", async () => {
    const repo = makeRepo({ "delta-count": "1\n", "delta.sh": DELTA_SH });

    const { payload } = await reproJson(repo, [
      "--bench",
      "--repeat",
      "2",
      "--",
      ...DELTA_CMD,
    ]);

    expect(payload.baseline).toBeNull();
    // Sanity on the worked example itself: both runs slept 0.6s.
    expect(payload.median).toBeGreaterThanOrEqual(400);
  });

  it("compares a later benchmark against the stored baseline", async () => {
    const repo = makeRepo({ "delta-count": "1\n", "delta.sh": DELTA_SH });

    // Runs 1-2 sleep 0.6s and become the baseline; runs 3-4 do not sleep.
    await reproJson(repo, ["--bench", "--repeat", "2", "--", ...DELTA_CMD]);
    const { payload } = await reproJson(repo, [
      "--bench",
      "--repeat",
      "2",
      "--",
      ...DELTA_CMD,
    ]);

    expect(payload.baseline?.median).toBeGreaterThanOrEqual(400);
    // current MINUS baseline: this loop got ~600ms faster.
    expect(payload.delta?.median).toBeLessThanOrEqual(-300);
  });
});

// ---------------------------------------------------------------------------
// Slice 8 — the human render and the usage errors.
// ---------------------------------------------------------------------------

describe("repro — text render", () => {
  it("renders a human summary naming the verdict and the reproId", async () => {
    const repo = makeRepo();
    // The id comes from the --json run of the SAME command in the SAME repo, and
    // the reproId is stable for that pair — so it is a known value here, never
    // one recomputed from the render.
    const { payload } = await reproJson(repo, ["--", ...RED_CMD]);

    const result = await run(["repro", "--", ...RED_CMD], repo);

    expect(result.stdout).toContain("red");
    expect(result.stdout).toContain(payload.reproId);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
  });
});

describe("repro — invalid invocations", () => {
  it("rejects an invocation with no command after `--`", async () => {
    const result = await run(["repro"], makeRepo());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/command/i);
    expect(result.stdout).toBe("");
  });

  it("rejects an --expect value other than red or green", async () => {
    const result = await run(
      ["repro", "--expect", "maybe", "--", ...GREEN_CMD],
      makeRepo()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--expect");
    expect(result.stderr).toContain("red");
    expect(result.stderr).toContain("green");
  });

  it("does not run the command when --expect is invalid", async () => {
    const repo = makeRepo();
    await run(
      ["repro", "--expect", "maybe", "--", "sh", "-c", "touch ran-anyway"],
      repo
    );
    expect(existsSync(join(repo, "ran-anyway"))).toBe(false);
  });

  it("rejects a --repeat that is not a count", async () => {
    const result = await run(
      ["repro", "--repeat", "many", "--", ...GREEN_CMD],
      makeRepo()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--repeat");
  });
});
