import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectFailingSuites } from "./check.ts";
import type { CommandContext, CommandResult } from "./command.ts";
import { ensureExcluded } from "./gate-cache.ts";
import { requireWorkroot } from "./runner.ts";

// THE GREEN BASELINE — `dobby baseline record` names the test suites that are
// failing RIGHT NOW, in a repo-relative path list, and stores them at
// `.dobby/baseline.json`. `dobby check --baseline` (check.ts) reads that record
// back to judge only NEWLY-failing suites: the run() dispatcher resolves it
// before calling `check()`, so this module has no reverse dependency on check.ts
// beyond `collectFailingSuites` (the one-directional edge: baseline.ts -> check.ts).
//
// WHY A SEPARATE FILE FROM THE GATE CACHE. `gate-cache.json` records only GREEN
// verdicts (codeHash -> proven-green): a repo with pre-existing red suites has
// nothing there to consult at all. The baseline is a DIFFERENT question — not
// "was this exact tree already proven green?" but "which suites were already red
// before this task started?" — answered by its own reference run and its own
// file, never folded into gate-cache.ts (which would overload one file with two
// unrelated questions).
//
// A RECORD IS A FACT, NOT A VERDICT: `record` always exits 0, whether the tree is
// spotless or on fire — it states what it found, it never judges it. Judgment is
// `check --baseline`'s job.
//
// node:* imports only (ADR-0008): vitest imports this under Node while Bun runs
// it in production.

const STATE_DIR = ".dobby";
const BASELINE_FILE = "baseline.json";

function baselinePath(root: string): string {
  return join(root, STATE_DIR, BASELINE_FILE);
}

// The stored shape: a sorted, de-duplicated list of repo-relative suite paths —
// exactly what `collectFailingSuites` returns. Storage layout is deliberately an
// implementation detail (no test asserts it): the record is meant to be observed
// only through `record` and `check --baseline`.
interface BaselineFile {
  suites: string[];
}

/**
 * Read the recorded baseline: the suites that were already failing when it was
 * taken. Returns null on ANY degraded state — no file, unreadable, unparsable,
 * not the expected shape — which every caller (check.ts) reads as "no baseline
 * exists": everything counts. An EMPTY array is a valid, DIFFERENT answer (a
 * record taken on a green tree) — never confused with "absent" by this contract.
 *
 * @public — consumed by run.ts, which resolves the record before calling
 * `check()` (check.ts never imports this module, keeping the dependency
 * one-directional).
 */
export function readBaselineSuites(root: string): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(baselinePath(root), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const { suites } = parsed as Record<string, unknown>;
  if (!(Array.isArray(suites) && suites.every((s) => typeof s === "string"))) {
    return null;
  }
  return suites as string[];
}

/**
 * Write the baseline record. Keeps `.dobby/` out of git's sight FIRST
 * (`ensureExcluded`, the same guarantee `gate-cache.ts` relies on) — otherwise
 * the file would both risk being committed and enter the gate cache's own code
 * hash, a key that could then never match again. Returns a human-readable NOTE
 * on failure (an unwritable `.dobby/`) or null on success — never throws: a
 * record command states a fact and must not crash over its own bookkeeping.
 */
function writeBaselineSuites(root: string, suites: string[]): string | null {
  ensureExcluded(root);
  const sorted = [...new Set(suites)].sort();
  try {
    mkdirSync(join(root, STATE_DIR), { recursive: true });
    const payload: BaselineFile = { suites: sorted };
    writeFileSync(baselinePath(root), `${JSON.stringify(payload, null, 2)}\n`);
    return null;
  } catch (error) {
    return `baseline not recorded: ${messageOf(error)}`;
  }
}

// ---------------------------------------------------------------------------
// dobby baseline record
// ---------------------------------------------------------------------------

export function runBaseline(context: CommandContext): CommandResult {
  // An ACTION command: outside a git repo it fails hard (there is no tree to
  // reference-run over). `requireWorkroot` THROWS and run.ts's dispatch has no
  // try/catch, so it is folded into the failure shape.
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return fail(messageOf(error));
  }
  // The registry validates the subcommand token before dispatch — `record` is
  // the only one it registers — so reaching here always means `record`.
  const suites = collectFailingSuites(root);
  const failure = writeBaselineSuites(root, suites);
  if (context.options.json === true) {
    return { error: failure ?? undefined, exitCode: 0, json: { suites } };
  }
  return { error: failure ?? undefined, exitCode: 0, text: recordText(suites) };
}

function recordText(suites: string[]): string {
  if (suites.length === 0) {
    return "baseline recorded: no failing suites\n";
  }
  const lines = suites.map((suite) => `  ${suite}`);
  return [`baseline recorded: ${suites.length} failing suite(s)`, ...lines]
    .join("\n")
    .concat("\n");
}

function fail(error: string): CommandResult {
  return { error, exitCode: 1 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
