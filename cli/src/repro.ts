import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CommandContext, CommandResult } from "./command.ts";
import { type RunResult, requireWorkroot, runCapture } from "./runner.ts";

// `dobby repro -- <cmd…>` — the deterministic reproduction harness the diagnose
// discipline needs: run the command, capture `{invocation, exitCode, stdout,
// stderr, durationMs, verdict, matched, reproId}` and judge it against the
// declared `--expect red|green` (the model never derives the verdict by reading
// output). `--repeat N` turns it into a flakiness probe (reproduction rate + the
// FIRST divergent output), `--bench` into a timing probe (min/median/mean/max and
// the delta against the stored baseline for the same reproId).
//
// Three properties carry the whole design:
//
//  1. **The harness JUDGES, the model reads.** `--expect red` on a loop that came
//     back green exits 1 — the "your loop is not red-capable" signal that stops a
//     diagnose session from theorising over a reproduction it never had. Without
//     `--expect` there is nothing to judge, so a failing command still exits 0:
//     repro REPORTS an exit code, it never inherits one.
//  2. **The artifact IS the pasted invocation + output.** stdout and stderr are
//     captured whole and go into the record VERBATIM — repro never truncates them
//     (only the human text render shows a labelled tail; `--json` and the
//     persisted record always carry everything). The single ceiling is the
//     runner's own capture buffer: `runCapture` raises node's spawnSync default
//     of 1MB per stream to 64MB (`MAX_CAPTURE_BUFFER` in runner.ts), and a child
//     that outruns THAT comes back as an ENOBUFS spawn error carrying no exit
//     code of its own — recorded here as a red run whose stderr names the error,
//     never as silently-clipped output.
//  3. **`reproId` = a short hash of the command argv + the workroot**, and NOTHING
//     else — repro's own flags are deliberately not in it, so `--repeat`/`--bench`
//     runs of the same loop all key the same record. That is what makes bench
//     baselines bisectable: change ONE thing, re-bench, read the delta.
//
// Every child is spawned through `runner.ts` with its cwd pinned to the workroot
// (the runner invariant), so the same loop reproduces identically from any
// subdirectory. The handler seam is SYNCHRONOUS (`run.ts` dispatches
// `(context) => CommandResult`), hence spawnSync-based `runCapture` rather than a
// streamed child.

// ---------------------------------------------------------------------------
// The domain vocabulary.
// ---------------------------------------------------------------------------

type Verdict = "green" | "red";

// What was actually run, recorded so the pasted artifact is self-contained.
interface Invocation {
  argv: string[];
  cwd: string;
}

// ONE execution of the command.
interface RunRecord {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stdout: string;
  verdict: Verdict;
}

// The first run whose outcome differed from run 1's — the divergence worth
// pasting when a loop turns out to be flaky. `run` is 1-BASED (it names a run the
// way a human counts them).
interface Divergence {
  run: number;
  stderr: string;
  stdout: string;
}

// The aggregate over a `--repeat` set (computed for every invocation; only
// SURFACED when `--repeat` was passed).
interface RunSet {
  deterministic: boolean;
  durations: number[];
  firstDivergent: Divergence | null;
  greenCount: number;
  redCount: number;
  reproductionRate: number;
  runs: number;
  verdict: Verdict;
}

// The timing summary `--bench` reports and stores. Durations are integer
// milliseconds, so every statistic is too (the mean is rounded).
interface BenchStats {
  max: number;
  mean: number;
  median: number;
  min: number;
  samples: number;
}

// Current MINUS baseline, per timing statistic — so a loop that got FASTER reads
// negative. `samples` carries no delta: it is a count of runs, not a duration, and
// differencing it would only invite reading it as a timing change.
interface BenchDelta {
  max: number;
  mean: number;
  median: number;
  min: number;
}

interface BenchResult {
  baseline: BenchStats | null;
  delta: BenchDelta | null;
  stats: BenchStats;
}

// The single payload shape: the 8 keys the spec enumerates ALWAYS, plus the
// `--repeat` block and the `--bench` block when those flags were passed. An absent
// block's keys are `undefined` and are dropped by `JSON.stringify`, so the JSON a
// caller parses carries exactly the keys that apply — except `matched`, which is
// explicitly NULL (not absent) without `--expect`: "nothing was judged" is an
// answer, and the key has to survive the round trip to say so.
interface ReproPayload {
  baseline?: BenchStats | null;
  delta?: BenchDelta | null;
  deterministic?: boolean;
  durationMs: number;
  durations?: number[];
  exitCode: number;
  firstDivergent?: Divergence | null;
  greenCount?: number;
  invocation: Invocation;
  matched: boolean | null;
  max?: number;
  mean?: number;
  median?: number;
  min?: number;
  redCount?: number;
  reproductionRate?: number;
  reproId: string;
  runs?: number;
  samples?: number;
  stderr: string;
  stdout: string;
  verdict: Verdict;
}

// What the `.dobby/repro/<reproId>.json` record holds: the LATEST run's full
// payload (so the artifact survives the terminal scrollback) plus the bench
// BASELINE the next `--bench` of this same loop compares against.
interface StoredRecord {
  baseline: BenchStats | null;
  latest: ReproPayload;
  reproId: string;
}

// One validated invocation of `repro` itself. `command` is a NON-EMPTY tuple: the
// "no command after `--`" case is rejected during parsing, so nothing downstream
// has to re-check it.
interface ReproRequest {
  bench: boolean;
  command: [string, ...string[]];
  expect: Verdict | null;
  json: boolean;
  repeat: number | null;
}

type ParsedRequest =
  | { error: string; ok: false }
  | { ok: true; request: ReproRequest };

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

const USAGE_EXAMPLE =
  "dobby repro [--expect red|green] [--repeat N] [--bench] [--json] -- <cmd…>";

// The machine-state home (gitignored, exactly like `up`'s detached-run pidfile).
const RECORD_DIR = join(".dobby", "repro");

export function runRepro(context: CommandContext): CommandResult {
  const parsed = parseRequest(context);
  if (!parsed.ok) {
    return { error: parsed.error, exitCode: 1 };
  }
  try {
    return execute(parsed.request, context.cwd);
  } catch (error) {
    // `requireWorkroot` throws outside a git repo, and the record write can fail
    // on a read-only tree. `run()` does not catch handler exceptions, so a raw
    // stack would reach the user; fold both into the CLI's ordinary hard error.
    return { error: `repro: ${messageOf(error)}`, exitCode: 1 };
  }
}

// Validate repro's OWN argv before anything is spawned — an invalid `--expect`
// must never leave a side effect behind, so every check happens up front.
function parseRequest(context: CommandContext): ParsedRequest {
  const [bin, ...rest] = context.positionals;
  if (bin === undefined) {
    return {
      error: `repro: no command to run — put it after \`--\`, e.g. ${USAGE_EXAMPLE}`,
      ok: false,
    };
  }

  // `red` / `green` are the whole point of the flag, so anything else is a typo
  // worth naming rather than a silent "no expectation".
  const rawExpect = context.options.expect;
  let expect: Verdict | null = null;
  if (rawExpect !== undefined) {
    if (rawExpect !== "red" && rawExpect !== "green") {
      return {
        error: `repro: --expect must be \`red\` or \`green\` (got \`${String(rawExpect)}\`)`,
        ok: false,
      };
    }
    expect = rawExpect;
  }

  // A positive integer. `--repeat 0` is rejected with the same message as
  // `--repeat many`: both ask for no runs at all.
  const rawRepeat = context.options.repeat;
  let repeat: number | null = null;
  if (rawRepeat !== undefined) {
    const count =
      typeof rawRepeat === "string" && COUNT_RE.test(rawRepeat)
        ? Number(rawRepeat)
        : 0;
    if (count < 1) {
      return {
        error: `repro: --repeat must be a positive integer (got \`${String(rawRepeat)}\`)`,
        ok: false,
      };
    }
    repeat = count;
  }

  return {
    ok: true,
    request: {
      bench: context.options.bench === true,
      command: [bin, ...rest],
      expect,
      json: context.options.json === true,
      repeat,
    },
  };
}

const COUNT_RE = /^\d+$/;

function execute(request: ReproRequest, cwd: string): CommandResult {
  const root = requireWorkroot(cwd);
  const reproId = deriveReproId(request.command, root);
  const recordPath = join(root, RECORD_DIR, `${reproId}.json`);
  // Read BEFORE running: the baseline a `--bench` reports is the one stored by the
  // PREVIOUS bench of this loop, never the one this run is about to write.
  const storedBaseline = readBaseline(recordPath);

  const records = runAll(request.command, root, request.repeat ?? 1);
  const set = summarize(records);
  const bench = request.bench ? benchmark(set.durations, storedBaseline) : null;

  const payload = buildPayload({
    bench,
    invocation: { argv: [...request.command], cwd: root },
    matched: request.expect === null ? null : set.verdict === request.expect,
    // With `--repeat` the base record is ONE run's, and WHICH one decides what
    // `--expect` judges. repro takes the first run whose verdict equals the SET's
    // — red as soon as ANY run went red, green only when every run passed — so
    // `repro --expect red --repeat 10` is a red-CAPABILITY probe: a 1-in-10 flake
    // reports matched:true (it demonstrably reproduces) with reproductionRate
    // saying how flaky it is, and the pasted output is the FAILING run's rather
    // than a lucky green one. Pinning the base record to run 1 instead would fail
    // that same probe nine times out of ten.
    reference:
      records.find((record) => record.verdict === set.verdict) ?? records[0],
    repeated: request.repeat === null ? null : set,
    reproId,
  });

  const persistError = persist(root, recordPath, {
    // A non-bench run must NOT clobber the stored baseline: only `--bench`
    // measures, so only `--bench` replaces what the next one compares against.
    baseline: bench === null ? storedBaseline : bench.stats,
    latest: payload,
    reproId,
  });

  return {
    // A failed record write is a WARNING, never the outcome: the run happened and
    // its artifact is already on stdout.
    error: persistError ?? undefined,
    exitCode: payload.matched === false ? 1 : 0,
    json: request.json ? payload : undefined,
    text: request.json ? undefined : renderText(payload, request.expect),
  };
}

// The record identity: a short hash over the workroot + the command argv, and
// NOTHING else. JSON-encoding the parts keeps the joining unambiguous (no
// separator a command argument could forge).
function deriveReproId(command: readonly string[], root: string): string {
  const material = JSON.stringify([root, ...command]);
  return createHash("sha256")
    .update(material)
    .digest("hex")
    .slice(0, REPRO_ID_LENGTH);
}

// Long enough that a collision across a repo's loops is not a practical concern,
// short enough to read inside a one-line summary.
const REPRO_ID_LENGTH = 12;

// ---------------------------------------------------------------------------
// Running the loop.
// ---------------------------------------------------------------------------

// Run the command `runs` times, in order. The return type is a NON-EMPTY tuple:
// `runs` is at least 1 by construction, and saying so in the type is what lets
// the summary below index run 1 without a defensive branch.
function runAll(
  command: [string, ...string[]],
  root: string,
  runs: number
): [RunRecord, ...RunRecord[]] {
  const [bin, ...args] = command;
  const records: [RunRecord, ...RunRecord[]] = [executeRun(bin, args, root)];
  // Runs 2..N. Sequential BY DESIGN: a flakiness probe whose runs overlap would
  // measure contention, not the loop.
  while (records.length < runs) {
    records.push(executeRun(bin, args, root));
  }
  return records;
}

function executeRun(bin: string, args: string[], root: string): RunRecord {
  const started = performance.now();
  // cwd pinned to the workroot (the runner invariant) — the same loop reproduces
  // identically from any subdirectory of the repo.
  const result = runCapture(bin, args, { root });
  const durationMs = Math.round(performance.now() - started);
  const exitCode = resolveExitCode(result);
  return {
    durationMs,
    exitCode,
    // A spawn failure has no output of its own; folding its message into stderr
    // keeps "the artifact explains itself" true for a typo'd command too.
    stderr:
      result.error === undefined
        ? result.stderr
        : `${result.stderr}${result.error.message}\n`,
    stdout: result.stdout,
    verdict: exitCode === 0 ? "green" : "red",
  };
}

// spawnSync reports NO exit code in two cases: the child never started (`error`
// set — a missing binary, an ENOBUFS overflow) or it was killed by a signal.
// Neither is a green run and neither has an exit code of its own, so repro records
// the POSIX conventions — 127 "command not found", 128 the base of the killed-by-N
// range — both nonzero, both red.
//
// The extraction tests the VALUE's type rather than comparing against `null`,
// because the two runtimes disagree on how "no code" is spelled: node returns
// `status: null`, Bun — which is what the `dobby` bin actually runs on —
// returns `undefined`. A `!== null` guard would fall through under Bun and hand
// `undefined` back as the exit code, which `JSON.stringify` then DROPS, taking a
// spec-mandated key out of the payload and the persisted record. `typeof ===
// "number"` is true for exactly the case that has an answer, on both.
function resolveExitCode(result: RunResult): number {
  if (typeof result.status === "number") {
    return result.status;
  }
  return result.error === undefined ? KILLED_EXIT : SPAWN_FAILED_EXIT;
}

const KILLED_EXIT = 128;
const SPAWN_FAILED_EXIT = 127;

function summarize(records: [RunRecord, ...RunRecord[]]): RunSet {
  const runs = records.length;
  const redCount = records.filter((record) => record.verdict === "red").length;
  const greenCount = runs - redCount;
  const [first] = records;
  return {
    deterministic: redCount === 0 || greenCount === 0,
    durations: records.map((record) => record.durationMs),
    firstDivergent: findDivergence(records, first.verdict),
    greenCount,
    redCount,
    // RED over runs: the question a repro asks is "how often does it fail",
    // so 3 red out of 5 reads 0.6, never 0.4.
    reproductionRate: redCount / runs,
    runs,
    verdict: redCount > 0 ? "red" : "green",
  };
}

// The first run that broke the streak run 1 established — the output to paste when
// a loop turns out not to be deterministic. Null when every run agreed.
function findDivergence(
  records: readonly RunRecord[],
  established: Verdict
): Divergence | null {
  for (const [index, record] of records.entries()) {
    if (record.verdict !== established) {
      return { run: index + 1, stderr: record.stderr, stdout: record.stdout };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// `--bench` — the timing probe.
// ---------------------------------------------------------------------------

function benchmark(
  durations: number[],
  storedBaseline: BenchStats | null
): BenchResult {
  const stats = computeStats(durations);
  return {
    baseline: storedBaseline,
    delta: storedBaseline === null ? null : computeDelta(stats, storedBaseline),
    stats,
  };
}

// The median is taken over SORTED samples (an even count averages the two middle
// ones) — the middle of the raw sequence would just report whichever run happened
// to sit in the middle. The mean is kept alongside precisely because the two
// disagree when one sample is an outlier, which is the signal worth seeing.
function computeStats(durations: number[]): BenchStats {
  const sorted = [...durations].sort((a, b) => a - b);
  const samples = sorted.length;
  const middle = Math.floor(samples / 2);
  const upper = sorted[middle] ?? 0;
  const lower = sorted[middle - 1] ?? upper;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    max: sorted[samples - 1] ?? 0,
    mean: Math.round(total / samples),
    median: samples % 2 === 0 ? Math.round((lower + upper) / 2) : upper,
    min: sorted[0] ?? 0,
    samples,
  };
}

function computeDelta(current: BenchStats, baseline: BenchStats): BenchDelta {
  return {
    max: current.max - baseline.max,
    mean: current.mean - baseline.mean,
    median: current.median - baseline.median,
    min: current.min - baseline.min,
  };
}

// ---------------------------------------------------------------------------
// The payload.
// ---------------------------------------------------------------------------

function buildPayload(parts: {
  bench: BenchResult | null;
  invocation: Invocation;
  matched: boolean | null;
  reference: RunRecord;
  repeated: RunSet | null;
  reproId: string;
}): ReproPayload {
  const { bench, invocation, matched, reference, repeated, reproId } = parts;
  // Optional chaining is load-bearing here: an absent BLOCK yields `undefined`
  // (JSON.stringify drops the key), while a present block's own null — no
  // baseline yet, no divergence — survives as an explicit null.
  return {
    baseline: bench?.baseline,
    delta: bench?.delta,
    deterministic: repeated?.deterministic,
    durationMs: reference.durationMs,
    durations: repeated?.durations,
    exitCode: reference.exitCode,
    firstDivergent: repeated?.firstDivergent,
    greenCount: repeated?.greenCount,
    invocation,
    matched,
    max: bench?.stats.max,
    mean: bench?.stats.mean,
    median: bench?.stats.median,
    min: bench?.stats.min,
    redCount: repeated?.redCount,
    reproductionRate: repeated?.reproductionRate,
    reproId,
    runs: repeated?.runs,
    samples: bench?.stats.samples,
    stderr: reference.stderr,
    stdout: reference.stdout,
    verdict: reference.verdict,
  };
}

// ---------------------------------------------------------------------------
// Persistence — `.dobby/repro/<reproId>.json`.
// ---------------------------------------------------------------------------

// Write the record, returning a WARNING message on failure instead of throwing:
// the run already happened and its artifact is already going to stdout, so a
// read-only tree must not turn a successful reproduction into a failed command.
function persist(
  root: string,
  recordPath: string,
  record: StoredRecord
): string | null {
  try {
    mkdirSync(join(root, RECORD_DIR), { recursive: true });
    ensureGitignored(root);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return null;
  } catch (error) {
    return `repro: could not write ${RECORD_DIR}/${record.reproId}.json — ${messageOf(error)}`;
  }
}

// The stored baseline for this reproId, or null when there is no record yet / the
// record is unreadable or corrupt. TOLERANT by design: a damaged record means the
// next `--bench` starts a fresh baseline, never that the command fails.
function readBaseline(recordPath: string): BenchStats | null {
  let raw: string;
  try {
    raw = readFileSync(recordPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const baseline =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { baseline?: unknown }).baseline
        : undefined;
    return isBenchStats(baseline) ? baseline : null;
  } catch {
    return null;
  }
}

const BENCH_KEYS = ["max", "mean", "median", "min", "samples"] as const;

function isBenchStats(value: unknown): value is BenchStats {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return BENCH_KEYS.every((key) => typeof record[key] === "number");
}

// Keep the machine-state home out of the consumer's index — the same guarantee
// `up` makes for its detached-run pidfile, repeated here (rather than shared)
// because a diagnostic command must not depend on the run lifecycle. Idempotent
// and best-effort: an unwritable .gitignore is caught by persist()'s wrapper.
function ensureGitignored(root: string): void {
  const path = join(root, ".gitignore");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = "";
  }
  const present = raw
    .split("\n")
    .some((line) => line.trim() === ".dobby/" || line.trim() === ".dobby");
  if (present) {
    return;
  }
  const prefix = raw === "" || raw.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${prefix}.dobby/\n`);
}

// ---------------------------------------------------------------------------
// The human render — a compact summary. `--json` carries the full payload, and
// the persisted record carries it too, so this view is free to show only a
// labelled TAIL of a long output (repro itself never truncates what it stores).
// ---------------------------------------------------------------------------

function renderText(payload: ReproPayload, expect: Verdict | null): string {
  const recordRel = `${RECORD_DIR}/${payload.reproId}.json`;
  const lines = [
    `repro ${payload.reproId} — ${payload.verdict} (exit ${payload.exitCode}) in ${payload.durationMs}ms`,
    `  cmd: ${payload.invocation.argv.map(quoteArg).join(" ")}`,
    `  cwd: ${payload.invocation.cwd}`,
    ...expectLine(payload, expect),
    ...repeatLines(payload),
    ...benchLines(payload),
    `  record: ${recordRel}`,
    "",
    ...outputBlock("stdout", payload.stdout, recordRel),
    ...outputBlock("stderr", payload.stderr, recordRel),
  ];
  return `${lines.join("\n")}\n`;
}

function expectLine(payload: ReproPayload, expect: Verdict | null): string[] {
  if (expect === null) {
    return [];
  }
  if (payload.matched === true) {
    return [`  expect: ${expect} — matched`];
  }
  return [
    `  expect: ${expect} — MISMATCH (this loop is not ${expect}-capable)`,
  ];
}

function repeatLines(payload: ReproPayload): string[] {
  const { deterministic, firstDivergent, greenCount, redCount, runs } = payload;
  if (runs === undefined) {
    return [];
  }
  const rate = Math.round((payload.reproductionRate ?? 0) * PERCENT);
  const lines = [
    `  runs: ${runs} → ${redCount} red / ${greenCount} green · reproduction ${rate}% · ${deterministic === true ? "deterministic" : "flaky"}`,
  ];
  if (firstDivergent) {
    lines.push(
      `  first divergence: run ${firstDivergent.run}${headlineOf(firstDivergent)}`
    );
  }
  return lines;
}

const PERCENT = 100;

// The first non-blank line of a divergent run's output, so the summary says what
// changed and not merely that something did. Empty output yields no suffix.
function headlineOf(divergence: Divergence): string {
  const first = `${divergence.stdout}\n${divergence.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (first === undefined) {
    return "";
  }
  return ` — ${first.length > HEADLINE_CHARS ? `${first.slice(0, HEADLINE_CHARS)}…` : first}`;
}

const HEADLINE_CHARS = 80;

function benchLines(payload: ReproPayload): string[] {
  const { baseline, delta, samples } = payload;
  if (samples === undefined) {
    return [];
  }
  const lines = [
    `  bench: ${samples} samples · min ${payload.min}ms · median ${payload.median}ms · mean ${payload.mean}ms · max ${payload.max}ms`,
  ];
  if (baseline === null || baseline === undefined) {
    lines.push("  baseline: none yet — this run becomes the baseline");
    return lines;
  }
  lines.push(
    `  baseline: min ${baseline.min}ms · median ${baseline.median}ms · mean ${baseline.mean}ms · max ${baseline.max}ms`
  );
  if (delta) {
    lines.push(
      `  delta: min ${signed(delta.min)} · median ${signed(delta.median)} · mean ${signed(delta.mean)} · max ${signed(delta.max)}`
    );
  }
  return lines;
}

// A delta reads as a change, so it always carries its sign — `-600ms` is the
// answer "this loop got faster", `+600ms` the regression.
function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}ms`;
}

function outputBlock(label: string, body: string, recordRel: string): string[] {
  if (body.trim() === "") {
    return [`${label}: (empty)`];
  }
  const { text, truncated } = tailOf(body);
  return [
    truncated ? `${label} (tail — full output in ${recordRel}):` : `${label}:`,
    ...text.split("\n").map((line) => `  ${line}`.trimEnd()),
  ];
}

// The same shape check.ts uses for a crashed tool's raw output: the LAST lines
// (where a failure announces itself), capped by lines then by bytes.
function tailOf(body: string): { text: string; truncated: boolean } {
  const lines = body.replace(TRAILING_NEWLINES_RE, "").split("\n");
  let truncated = lines.length > TAIL_LINES;
  let text = lines.slice(-TAIL_LINES).join("\n");
  if (text.length > TAIL_CHARS) {
    truncated = true;
    text = text.slice(-TAIL_CHARS);
  }
  return { text, truncated };
}

const TAIL_CHARS = 4000;
const TAIL_LINES = 40;
const TRAILING_NEWLINES_RE = /\n+$/;

// Render one argv token the way a shell would take it back — the `cmd:` line is
// meant to be copy-pasteable, which is the whole point of recording the
// invocation next to its output.
function quoteArg(arg: string): string {
  if (SHELL_SAFE_RE.test(arg)) {
    return arg;
  }
  return `'${arg.replace(SINGLE_QUOTE_RE, "'\\''")}'`;
}

const SHELL_SAFE_RE = /^[\w./:=@%+,-]+$/;
const SINGLE_QUOTE_RE = /'/g;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
