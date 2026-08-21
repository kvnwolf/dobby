import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
// THE GREEN BASELINE — what was ALREADY red before the work began, recorded
// once, so the Gate run inside the build loop reports only what this task broke.
//
// The contract, in tracer-bullet order (one entry per SLICE banner below):
//   1. `dobby baseline record` records the suites failing RIGHT NOW (text +
//      `--json`), and a green tree records an EMPTY set (still a record);
//   2. `dobby check --baseline` does not report a suite the baseline already
//      carries — with the SAME tree under a plain `dobby check` as the efficacy
//      control (that suite really is red);
//   3. a suite that breaks AFTER the record IS reported, and only it — even when
//      the baselined suite's failure has changed message meanwhile (the record
//      is per TEST — file + full name — which is what "only newly-failing
//      tests are reported" means; a message change on the SAME test is still
//      the same identity, still exempt);
//   4. NO record at all means everything counts, said EXPLICITLY — the run names
//      the missing baseline instead of passing (or filtering) in silence;
//   5. a plain `dobby check` is NEVER softened by a record — the commit and
//      pre-push forms of the Gate keep judging the whole tree;
//   6. a `--baseline` run that suppressed a failure records no green input in
//      the gate cache, so the next plain Gate is not served a green nothing
//      ever earned;
//   7. `--baseline` is a registered flag OF `check` (usage + allowlist);
//   8. identity is per TEST, not per FILE (the P1 this file exists to pin) — a
//      SECOND, NEW failing test landing in an already-red file is reported,
//      even though the file itself was already in the record, and even when
//      the per-file COUNT of failing tests stays the same (one test fixed,
//      a different one breaks);
//   9. a DUPLICATE identity (two tests sharing one file+fullName token, which
//      vitest does not forbid) is safe WHEN BOTH occurrences were failing
//      SIMULTANEOUSLY at record time: the record carries a COUNT per
//      identity, not just membership, so one recorded occurrence exempts only
//      one current failure — a second failure landing under the exact same
//      name is still new and still surfaces. That SAME shape (both recorded
//      together) is also what makes the file AMBIGUOUS (slice 11) — a count
//      cannot rescue it once counting alone is known to have a hole, so it is
//      reported too, worst case a false red;
//   10. an OLD-format record (bare suite paths, pre-dating per-test identity)
//      never crashes the gate — it is treated as no record at all;
//   11. an AMBIGUOUS FILE (two tests sharing one identity in the FULL test
//      list at record time, not just among current failures — the shape a
//      pure count can never see, since it only ever counts what is failing)
//      is refused exemption OUTRIGHT: every failure in that file surfaces,
//      even one whose current COUNT is arithmetically unchanged from what was
//      recorded, and `record` names the file as ambiguous (text + `--json`)
//      the moment it is taken. Never voids a DIFFERENT, unambiguous file's
//      exemption in the same record.
//
// INDEPENDENT SOURCES for every expected value here:
//   - Which suites fail, and with WHICH message, is DICTATED by this file: the
//     fixture's vitest is a STUB bin that prints a reporter payload WE hand-write
//     (the seam `run.test.ts` already uses for the failure parser). So
//     `src/alpha.test.ts` / `src/beta.test.ts` and `expected 3 to be 4` are
//     literals we chose, never values recomputed the way the gate derives them.
//   - "The gate would have reported it" is never assumed: every suppression
//     assertion is paired with the SAME tree judged by a run that must report it
//     (a plain `dobby check`, or a `--baseline` run with no record). A silence
//     that is not contrasted with a matching noise proves nothing.
//   - "Only the new one" is asserted on the gate's OWN failure summary, which
//     names each failed suite by its repo-relative path — the baselined path must
//     be ABSENT from the whole output, not merely deprioritised.
//   - Where the record is STORED is deliberately NOT asserted for anything a
//     command can still WRITE: the baseline is observed only through the
//     commands that write and read it, so the storage layout stays free to
//     change without touching this contract. Slice 10 is the one exception —
//     it plants a file BY HAND, because no command written against the current
//     format can produce the shape it needs to exist: a record from before
//     per-test identity.
//
// Why `--no-cache` on almost every `check` here: the stub's reporter payload
// lives OUTSIDE the repo, so making a suite fail does not change the tree the
// gate cache keys on. Without it a later run would be served the earlier run's
// verdict and the slice would assert nothing. Slice 6 is the one exception — the
// cache is its subject.
// ===========================================================================

const dirs: string[] = [];

afterAll(() => {
  cleanupDirs(dirs);
});

// --- fixtures ---------------------------------------------------------------

// Neither biome nor tsc fires on it — the fixture's only possible finding is the
// one the stubbed test step reports.
const CLEAN =
  "export function ok(a: number, b: number): number {\n  return a + b;\n}\n";

// One failed suite as vitest's --reporter=json spells it: an absolute file name
// plus one failed assertion carrying the message we chose.
interface FailedSuite {
  file: string;
  message: string;
}

// A repo shaped for the full Gate with a STUB vitest: biome (lint only), a strict
// tsconfig over `src`, a knip-clean package.json (the stub dependency is ignored
// so knip never contaminates a "which step reported" assertion), and a local
// `node_modules/vitest` whose bin resolves — so the test step really SPAWNS —
// printing a reporter payload read from a control file OUTSIDE the repo.
//
// Returns the repo root plus `failing(...)`: the switch this file uses to decide
// which suites are red at any moment.
// A single NAMED failing test, for the slices that need per-test (not just
// per-file) identity: two of these sharing a `file` are two DIFFERENT tests in
// the same suite, distinguished by `name` — the field the fix in this file is
// about (vitest's `fullName`, carried by every real assertionResult).
// `status` is optional and defaults to "failed" — every EXISTING caller in
// this file leaves it unset. Set to "passed" for the AMBIGUOUS-FILE slices
// (below): a test that is CURRENTLY passing but shares its `name` with a
// currently-failing one in the same file is exactly the structural shape a
// per-identity COUNT can never see (only the failing row is ever counted),
// which is why detecting it needs the file's full assertionResults list, not
// just what is failing right now.
interface NamedFailure {
  file: string;
  message: string;
  name: string;
  status?: "failed" | "passed";
}

function makeBaselineRepo(): {
  failingTests: (tests: NamedFailure[]) => void;
  repo: string;
  failing: (suites: FailedSuite[]) => void;
} {
  const side = realpathSync(
    mkdtempSync(join(tmpdir(), "dobby-baseline-side-"))
  );
  dirs.push(side);
  const reportPath = join(side, "report.json");
  writeFileSync(reportPath, JSON.stringify({ testResults: [] }));

  const stub = [
    'import { readFileSync } from "node:fs";',
    `const report = JSON.parse(readFileSync(${JSON.stringify(reportPath)}, "utf8"));`,
    "process.stdout.write(JSON.stringify(report));",
    'process.exit(report.testResults.some((r) => r.status === "failed") ? 1 : 0);',
    "",
  ].join("\n");

  const repo = makeScratchRepo({
    files: {
      "biome.jsonc": JSON.stringify(
        {
          assist: { enabled: false },
          formatter: { enabled: false },
          linter: {
            enabled: true,
            rules: {
              recommended: false,
              suspicious: { noDoubleEquals: "error" },
            },
          },
        },
        null,
        2
      ),
      "node_modules/vitest/package.json": JSON.stringify(
        {
          bin: { vitest: "./stub.mjs" },
          name: "vitest",
          version: "0.0.0-stub",
        },
        null,
        2
      ),
      "node_modules/vitest/stub.mjs": stub,
      "src/clean.ts": CLEAN,
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: { noEmit: true, skipLibCheck: true, strict: true },
          include: ["src"],
        },
        null,
        2
      ),
    },
    pkg: {
      devDependencies: { vitest: "^2.0.0" },
      knip: {
        entry: ["src/**/*.ts"],
        ignoreDependencies: ["vitest"],
        project: ["src/**/*.ts"],
      },
      name: "baseline-fixture",
      private: true,
    },
    prefix: "dobby-baseline-",
    track: dirs,
  });

  const failing = (suites: FailedSuite[]): void => {
    writeFileSync(
      reportPath,
      JSON.stringify({
        testResults: suites.map((suite) => ({
          assertionResults: [
            { failureMessages: [suite.message], status: "failed" },
          ],
          name: join(repo, suite.file),
          status: "failed",
        })),
      })
    );
  };

  // The per-TEST twin of `failing` above: each entry becomes its own
  // `assertionResults` row, named by `fullName` (the field vitest's real json
  // reporter carries and this fix now reads) — grouped back under one
  // `testResults` entry PER FILE, exactly as vitest itself would report
  // several failing tests living in the same suite file.
  const failingTests = (tests: NamedFailure[]): void => {
    const byFile = new Map<string, NamedFailure[]>();
    for (const test of tests) {
      const forFile = byFile.get(test.file) ?? [];
      forFile.push(test);
      byFile.set(test.file, forFile);
    }
    writeFileSync(
      reportPath,
      JSON.stringify({
        testResults: [...byFile.entries()].map(([file, forFile]) => ({
          assertionResults: forFile.map((test) =>
            (test.status ?? "failed") === "passed"
              ? { fullName: test.name, status: "passed" }
              : {
                  failureMessages: [test.message],
                  fullName: test.name,
                  status: "failed",
                }
          ),
          name: join(repo, file),
          status: "failed",
        })),
      })
    );
  };

  return { failing, failingTests, repo };
}

// The two suites this file talks about, and the messages they fail with — all of
// them literals chosen HERE, so every assertion below has an independent source.
const ALPHA: FailedSuite = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 3 to be 4",
};
const ALPHA_LATER: FailedSuite = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 7 to be 9",
};
const BETA: FailedSuite = {
  file: "src/beta.test.ts",
  message: "AssertionError: expected 1 to be 2",
};

// Two DISTINCT named tests living in the SAME file — the shape the P1 fix is
// about. Suite-path identity alone cannot tell these apart; test identity
// (file + `fullName`) can.
const ALPHA_TEST_A: NamedFailure = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 3 to be 4",
  name: "alpha › test A",
};
const ALPHA_TEST_B: NamedFailure = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 10 to be 11",
  name: "alpha › test B",
};

// A DUPLICATE identity (same file, same `fullName`) worn by two DIFFERENT
// failures — the shape slice 9 exists to pin. Nothing about vitest forbids
// two tests sharing a title (two `it("does the thing")` in one describe, or
// two describes that flatten to the same full name); their messages differ
// only so the fixture can tell, by eye, that they really are two rows.
const DUPLICATE_NAME = "alpha › duplicate title";
const ALPHA_DUP_FIRST: NamedFailure = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 1 to be 2",
  name: DUPLICATE_NAME,
};
const ALPHA_DUP_SECOND: NamedFailure = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 8 to be 9",
  name: DUPLICATE_NAME,
};

// A NAMED test in `src/beta.test.ts`, for the slices that need a SECOND,
// unambiguous file recorded alongside an ambiguous one — proving the
// ambiguity of one file never bleeds into another file's ordinary exemption.
const BETA_NAMED: NamedFailure = {
  file: "src/beta.test.ts",
  message: "AssertionError: expected 5 to be 6",
  name: "beta › test",
};

// The AMBIGUOUS-FILE shape (the finding this file exists to close, after an
// earlier round tried counting alone): two tests share `TWIN_NAME` in
// `src/alpha.test.ts`, but — unlike `ALPHA_DUP_FIRST`/`ALPHA_DUP_SECOND`
// above — only ONE of them is failing at record time; its twin is PASSING.
// A per-identity count can never see the twin (it only ever counts what is
// FAILING), so counting alone cannot flag this file. Detecting it needs the
// file's full test list, not just what is red right now.
const TWIN_NAME = "alpha › twin title";
const ALPHA_TWIN_FAILING_AT_RECORD: NamedFailure = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 4 to be 5",
  name: TWIN_NAME,
};
const ALPHA_TWIN_PASSING_AT_RECORD: NamedFailure = {
  file: "src/alpha.test.ts",
  message: "",
  name: TWIN_NAME,
  status: "passed",
};
// Later: the RECORDED test above got FIXED, and its same-named twin — passing
// at record time — is the one failing now. Same file, same identity token,
// same failure COUNT (exactly 1) as what was recorded: this is precisely what
// a pure count cannot distinguish from "the recorded test is still red".
const ALPHA_TWIN_FAILING_LATER: NamedFailure = {
  file: "src/alpha.test.ts",
  message: "AssertionError: expected 6 to be 7",
  name: TWIN_NAME,
};

// --- observers --------------------------------------------------------------

const combined = (r: { stdout: string; stderr: string }) =>
  `${r.stdout}\n${r.stderr}`;

// Does ANY single line satisfy every matcher? (A note is one line; matching the
// whole blob would let two unrelated lines fake it.)
function hasNoteLine(text: string, matchers: RegExp[]): boolean {
  return text
    .split("\n")
    .some((line) => matchers.every((matcher) => matcher.test(line)));
}

// The "there is no record" statement, asserted on MEANING rather than on a
// phrasing this file invented: one line that speaks about the baseline AND says
// it is not there.
const missingBaselineNote = (text: string) =>
  hasNoteLine(text, [
    /baseline/i,
    /\b(no|none|never|not|missing|absent|unrecorded)\b/i,
  ]);

// ---------------------------------------------------------------------------
// Slice 1 (tracer bullet): recording. The smallest end-to-end proof — the CLI
// can look at a tree and say which suites are red RIGHT NOW, and it says so
// without failing (a record is a fact, not a verdict).
//
// Its twin matters just as much: recording a GREEN tree writes an EMPTY record,
// which is a different thing from no record at all (slice 4 is the other half).
// ---------------------------------------------------------------------------
describe("run() — dobby baseline record captures the suites failing today", () => {
  it("names the already-failing suite and still exits 0", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);

    const result = await run(["baseline", "record"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).toContain("src/alpha.test.ts");
  });

  it("lists the failing suites in its --json payload", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA, BETA]);

    const result = await run(["baseline", "record", "--json"], repo);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { suites: string[] };
    expect(payload.suites).toEqual(["src/alpha.test.ts", "src/beta.test.ts"]);
  });

  it("records an empty set on a green tree", async () => {
    const { repo } = makeBaselineRepo();

    const result = await run(["baseline", "record", "--json"], repo);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { suites: string[] };
    expect(payload.suites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 2: the whole point — a Gate run inside the loop does not report a
// failure the task inherited. The efficacy control is the SAME tree under a
// plain `dobby check`, which must report it: without that pairing, the silence
// could just as well be a test step that never ran.
// ---------------------------------------------------------------------------
describe("run() — check --baseline ignores a suite that was already failing", () => {
  it("reports the suite when the gate judges the whole tree (control)", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);

    const result = await run(["check", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
  });

  it("does not report it once it is in the record, and the gate passes", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);
    const recorded = await run(["baseline", "record"], repo);
    expect(recorded.exitCode).toBe(0);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).not.toContain("src/alpha.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Slice 3: the other half of the same judgement — what the task itself broke is
// reported, and NOTHING else. This is the slice that keeps slice 2 honest: a
// `--baseline` run that simply dropped the test step would pass slice 2 and fail
// here.
//
// The baselined suite's message CHANGES between the record and the run, because
// the record is per SUITE: `src/alpha.test.ts` was red before the work started
// and is still somebody else's problem, whatever it now says.
// ---------------------------------------------------------------------------
describe("run() — check --baseline reports only the newly-failing suite", () => {
  it("names the suite that broke after the record and not the one that predates it", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);
    await run(["baseline", "record"], repo);
    failing([ALPHA_LATER, BETA]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/beta.test.ts");
    expect(combined(result)).not.toContain("src/alpha.test.ts");
  });

  it("counts only the newly-failing suite in the failure summary", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);
    await run(["baseline", "record"], repo);
    failing([ALPHA_LATER, BETA]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    // Two suites are red; one of them is inherited, so the run answers for ONE.
    expect(combined(result)).toContain("test: 1 suite(s) failed");
  });
});

// ---------------------------------------------------------------------------
// Slice 4: no record at all. The dangerous reading of "judge against the
// baseline" is "with nothing recorded, nothing is new" — a run that passes over
// a broken tree. The contract is the opposite: everything counts, and the run
// SAYS the record is missing rather than leaving the reader to infer it.
//
// The control is a run with a record in hand, which must NOT carry that
// statement — otherwise the assertion would pass on boilerplate.
// ---------------------------------------------------------------------------
describe("run() — check --baseline with no record counts every failure", () => {
  it("reports every failing suite and fails the gate", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA, BETA]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
    expect(combined(result)).toContain("src/beta.test.ts");
  });

  it("says the baseline is missing instead of passing silently", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(missingBaselineNote(combined(result))).toBe(true);
  });

  it("says nothing of the kind once a record exists", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);
    await run(["baseline", "record"], repo);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    // The run judged the tree against the record (the inherited failure did not
    // fail it), so the silence below is a run that HAD a baseline — not a run
    // that never got that far.
    expect(result.exitCode).toBe(0);
    expect(missingBaselineNote(combined(result))).toBe(false);
  });

  it("still counts everything when the record was taken on a green tree", async () => {
    // An EMPTY record is a record: nothing was inherited, so a suite that breaks
    // afterwards is this task's own — reported, with no missing-record note.
    const { repo, failing } = makeBaselineRepo();
    await run(["baseline", "record"], repo);
    failing([BETA]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/beta.test.ts");
    expect(missingBaselineNote(combined(result))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slice 5: the safety twin. The baseline exists for the run INSIDE the loop; the
// Gate's commit and pre-push forms must keep judging the whole tree, or a
// recorded red would ride to the remote behind a green exit code.
// ---------------------------------------------------------------------------
describe("run() — a recorded baseline never softens a plain check", () => {
  it("reports the recorded suite anyway and fails, without --baseline", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);
    // The record really exists — otherwise the plain gate below would be
    // reporting the suite for want of anything to consult.
    const recorded = await run(["baseline", "record"], repo);
    expect(recorded.exitCode).toBe(0);

    const result = await run(["check", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Slice 6: the two records must not contaminate each other. A `--baseline` run
// exits 0 while a suite is red on purpose — that verdict says "nothing NEW
// broke", never "this tree is green". If it were remembered as a green input,
// the next plain Gate (the pre-push backstop, say) would be served it and wave
// the red tree through.
//
// This is the ONE slice without `--no-cache`: the cache is the subject, so the
// consult has to be live.
// ---------------------------------------------------------------------------
describe("run() — a suppressed failure is never remembered as a green gate", () => {
  it("lets the next plain check run and report the still-red suite", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);
    await run(["baseline", "record"], repo);

    const inLoop = await run(["check", "--baseline"], repo);
    expect(inLoop.exitCode).toBe(0);

    const plain = await run(["check"], repo);
    expect(plain.exitCode).toBe(1);
    expect(combined(plain)).toContain("src/alpha.test.ts");
    expect(combined(plain)).not.toContain("gate skipped");
  });
});

// ---------------------------------------------------------------------------
// Slice 7: `--baseline` is a registered flag OF `check` — advertised in the
// usage Options block, and refused (naming flag and command) anywhere else, so
// it can never be a silently-ignored no-op on another command.
// ---------------------------------------------------------------------------
describe("run() — the --baseline flag is registered for check", () => {
  it("advertises --baseline in the usage Options block as a check flag", async () => {
    const { repo } = makeBaselineRepo();

    const result = await run([], repo);
    const advertised = result.stdout
      .split("\n")
      .some((line) => /^\s+--baseline\s+check:/.test(line));
    expect(advertised).toBe(true);
  });

  it("refuses --baseline on another command, naming the flag and the command", async () => {
    const { repo } = makeBaselineRepo();

    const result = await run(["env", "--baseline"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag --baseline");
    expect(result.stderr).toContain("dobby env");
  });
});

// ---------------------------------------------------------------------------
// Slice 8 (the P1 this file exists to pin): identity is per TEST, not per
// FILE. A green baseline that filtered on the suite path alone would drop a
// SECOND, brand-new failure landing in an already-red file right alongside
// the one it recorded — replacing a genuinely broken run with a false green.
//
// The record ONLY ever names test A (`failingTests([ALPHA_TEST_A])`); test B
// never appears in it. Whatever the gate does with a same-file, different-test
// failure, it can only be told apart from "the recorded failure, unchanged" by
// its NAME — which is exactly what this slice is proving is now consulted.
// ---------------------------------------------------------------------------
describe("run() — check --baseline reports a NEW failing test even inside an already-red file", () => {
  it("names the file and fails the gate when a second test breaks alongside the recorded one", async () => {
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_TEST_A]);
    const recorded = await run(["baseline", "record"], repo);
    expect(recorded.exitCode).toBe(0);
    failingTests([ALPHA_TEST_A, ALPHA_TEST_B]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    // The old (file-keyed) behaviour dropped the WHOLE file's failures because
    // src/alpha.test.ts was in the record — exit 0, no mention of the suite at
    // all. The fix must fail the gate and still name the file.
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
    expect(combined(result)).toContain("test: 1 suite(s) failed");
  });

  it("still reports the file when the recorded test itself got FIXED but a different one in it broke (count-per-file unchanged)", async () => {
    // The count-based trap the fix must avoid: exactly ONE failing test in the
    // file both before (A) and after (B) the record — a comparison keyed on
    // "how many failures does this file have" would see no change and stay
    // silent. Identity, not arithmetic, is what has to catch this.
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_TEST_A]);
    await run(["baseline", "record"], repo);
    failingTests([ALPHA_TEST_B]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
  });

  it("stays silent when the SAME named test is still the only one failing (keep-working case)", async () => {
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_TEST_A]);
    await run(["baseline", "record"], repo);
    failingTests([ALPHA_TEST_A]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).not.toContain("src/alpha.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Slice 9 (a P1 this file exists to pin): a DUPLICATE identity. Two DIFFERENT
// tests sharing one file+fullName token collapse to ONE entry in the record's
// naive reading — a record keyed on membership alone could not tell "the
// recorded failure is still the only one" from "a second, brand-new failure
// landed under the exact same name". A per-identity COUNT closes this HALF of
// the gap — one recorded, two failing now, one of them is new and must
// surface — for as long as the record itself was never ambiguous (slice 11,
// below, covers the half a count cannot close: the file's ONE recorded
// occurrence being structurally indistinguishable from a same-named twin that
// was merely passing at record time).
// ---------------------------------------------------------------------------
describe("run() — check --baseline reports a NEW failure sharing an identity with a recorded one", () => {
  it("fails the gate when a second test fails under the SAME name as the recorded one", async () => {
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_DUP_FIRST]);
    const recorded = await run(["baseline", "record"], repo);
    expect(recorded.exitCode).toBe(0);
    // Now TWO tests fail under the identical identity: the recorded one
    // (unchanged) plus a brand-new one wearing the same title.
    failingTests([ALPHA_DUP_FIRST, ALPHA_DUP_SECOND]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    // An identity keyed on membership alone (`Set.has`) would see the token
    // already recorded and exempt BOTH occurrences — a false green over a
    // live regression. The fix must fail the gate and name the file.
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
    expect(combined(result)).toContain("test: 1 suite(s) failed");
  });

  it("stays silent when only the single recorded occurrence remains (keep-working case)", async () => {
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_DUP_FIRST]);
    await run(["baseline", "record"], repo);
    failingTests([ALPHA_DUP_FIRST]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(0);
    expect(combined(result)).not.toContain("src/alpha.test.ts");
  });

  it("reports the file when BOTH duplicate occurrences were recorded together (ambiguous — a false RED, not a false green)", async () => {
    // This is the SAME record shape slice 11 below is about: two tests
    // sharing one identity BOTH failing at record time is what
    // `ambiguousFilesIn` (check.ts) flags — the file's record can no longer
    // be trusted to exempt ANYTHING, even a failure that is arithmetically
    // unchanged from what was recorded. Before the ambiguous-file fix this
    // read as silent (the count budget of 2 exactly matched 2 current
    // failures); now it must surface, worst case a false red until the
    // duplicate name is renamed — never a false green over a live regression
    // that could be hiding behind either occurrence.
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_DUP_FIRST, ALPHA_DUP_SECOND]);
    const recorded = await run(["baseline", "record"], repo);
    expect(recorded.exitCode).toBe(0);
    failingTests([ALPHA_DUP_FIRST, ALPHA_DUP_SECOND]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Slice 11 (the P1 a PRIOR round tried to close with counting alone, and a
// reviewer caught still open): an AMBIGUOUS file. `ALPHA_TWIN_FAILING_AT_RECORD`
// and `ALPHA_TWIN_PASSING_AT_RECORD` share one `fullName` in the same file,
// but only ONE of them is failing when `baseline record` runs — the shape
// slice 9's count-based fix cannot see, because only what is CURRENTLY
// FAILING is ever counted. Later, the recorded test gets fixed and its
// passing twin starts failing instead: the current failure COUNT under that
// shared identity is still exactly 1, unchanged from what was recorded, so a
// pure count would exempt the new failure outright — the exact false green
// the finding names. The fix: flag the file ambiguous AT RECORD TIME, from
// its full test list, and refuse it exemption entirely from then on.
// ---------------------------------------------------------------------------
describe("run() — check --baseline never exempts a file whose record was ambiguous", () => {
  it("names the file as ambiguous in both text and --json record output", async () => {
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_TWIN_FAILING_AT_RECORD, ALPHA_TWIN_PASSING_AT_RECORD]);

    const text = await run(["baseline", "record"], repo);
    expect(text.exitCode).toBe(0);
    expect(hasNoteLine(combined(text), [/ambiguous/i, /duplicat/i])).toBe(true);
    expect(combined(text)).toContain("src/alpha.test.ts");

    const json = await run(["baseline", "record", "--json"], repo);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      ambiguousSuites: string[];
      suites: string[];
    };
    expect(payload.ambiguousSuites).toEqual(["src/alpha.test.ts"]);
    // `ambiguousSuites` is a SUBSET of `suites`, never a disjoint list — an
    // ambiguous file always carries at least one currently-failing identity
    // too (`ambiguousFilesIn` only inspects FAILED files), so it must still
    // show up in the plain failing-suites list a human orients from.
    expect(payload.suites).toContain("src/alpha.test.ts");
  });

  it("reports a same-named DIFFERENT test's new failure even though the recorded count is unchanged", async () => {
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_TWIN_FAILING_AT_RECORD, ALPHA_TWIN_PASSING_AT_RECORD]);
    const recorded = await run(["baseline", "record"], repo);
    expect(recorded.exitCode).toBe(0);
    // The RECORDED test is fixed; its same-named twin — passing at record
    // time — is the one failing now. One failure, same identity, same count
    // as what was recorded: a pure count would call this "the recorded
    // failure, still red" and exempt it.
    failingTests([ALPHA_TWIN_FAILING_LATER]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
  });

  it("names the reason inline so the red is diagnosable, not just present", async () => {
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([ALPHA_TWIN_FAILING_AT_RECORD, ALPHA_TWIN_PASSING_AT_RECORD]);
    await run(["baseline", "record"], repo);
    failingTests([ALPHA_TWIN_FAILING_LATER]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(
      hasNoteLine(combined(result), [
        /src\/alpha\.test\.ts/,
        /ambiguous/i,
        /duplicat/i,
      ])
    ).toBe(true);
  });

  it("does not void a DIFFERENT file's ordinary exemption in the same record", async () => {
    // Scoping: one ambiguous file must never drag down an unrelated file's
    // clean, unambiguous record in the SAME `.dobby/baseline.json`.
    const { repo, failingTests } = makeBaselineRepo();
    failingTests([
      ALPHA_TWIN_FAILING_AT_RECORD,
      ALPHA_TWIN_PASSING_AT_RECORD,
      BETA_NAMED,
    ]);
    const recorded = await run(["baseline", "record"], repo);
    expect(recorded.exitCode).toBe(0);
    // alpha's twin swaps (the ambiguous break); beta is UNCHANGED from what
    // was recorded — its exemption must still hold.
    failingTests([ALPHA_TWIN_FAILING_LATER, BETA_NAMED]);

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
    expect(combined(result)).not.toContain("src/beta.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Slice 10: a record written by the format that predates this fix (bare suite
// paths, no per-test identity — planted directly at `.dobby/baseline.json`,
// since no command still writes that shape) must not crash the gate. It is
// treated exactly like NO record at all: everything counts, and the run says
// the baseline is missing rather than half-trusting a shape it can no longer
// interpret precisely.
// ---------------------------------------------------------------------------
describe("run() — an old-format baseline record is treated as absent", () => {
  it("does not crash, counts the failure, and says the baseline is missing", async () => {
    const { repo, failing } = makeBaselineRepo();
    failing([ALPHA]);
    mkdirSync(join(repo, ".dobby"), { recursive: true });
    writeFileSync(
      join(repo, ".dobby", "baseline.json"),
      JSON.stringify({ suites: ["src/alpha.test.ts"] })
    );

    const result = await run(["check", "--baseline", "--no-cache"], repo);
    expect(result.exitCode).toBe(1);
    expect(combined(result)).toContain("src/alpha.test.ts");
    expect(missingBaselineNote(combined(result))).toBe(true);
  });
});
