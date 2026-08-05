import { parseArgs } from "node:util";
import pkg from "../package.json";
import { runAdr } from "./adr.ts";
import { runArtifactLint } from "./artifact-lint.ts";
import { runBuildPlan } from "./buildplan.ts";
import { type CheckGroup, type CheckNote, check, checkHook } from "./check.ts";
import type {
  CommandContext,
  CommandOptions,
  CommandResult,
} from "./command.ts";
import { loadConfig } from "./config.ts";
import { detectCapabilities } from "./detect.ts";
import { collectEnv, type EnvSnapshot } from "./envinfo.ts";
import { prePushCheck } from "./hook-install.ts";
import { runKb } from "./kb.ts";
import {
  type DownAction,
  type DownPlan,
  planDev,
  type ResolvedDevCommand,
  type ResolvedDevPlan,
  runBuild,
  runDbTask,
  runDown,
  runUp,
  runUpdate,
  type SetupAction,
  type UpAction,
  type UpPlan,
  type UpReport,
} from "./lifecycle.ts";
import {
  runFinishPreflight,
  runMigrate,
  runScopePreflight,
} from "./preflight.ts";
import { runRelease } from "./release.ts";
import { runRepro } from "./repro.ts";
import { runPr, runReview } from "./review.ts";
import { resolveWorkroot } from "./runner.ts";
import { runShip } from "./ship.ts";
import { runState } from "./state.ts";
import { type CheckFlags, type DbCommand, usageCommands } from "./tasks.ts";
import { runClaim, runGoal, runTracker } from "./tracker.ts";

// The CLI's public interface: a pure process-independent seam. It parses argv,
// dispatches on the first positional, and returns the process outcome as data
// ({ exitCode, stdout, stderr }) so the bin entry can stay a logic-free adapter
// and vitest can exercise every branch in-process. `cwd` is the caller's
// directory, threaded down to the environment snapshot. `stdin` carries the
// PostToolUse hook payload for `check --hook` (the bin reads real process stdin
// when `--hook` is present); every other command ignores it.
//
// Runtime-portable invariant: only node:* imports + the plain JSON import — no
// Bun.* globals, no bun: modules — so vitest (Node/Vite runtime) can import it.
// All formatting lives HERE; the modules return data.

// The process outcome as data — what `run()` and its helpers return, and exactly
// the shape the bin adapter writes out. Named so the registry helpers below can
// declare it; `run()`'s own signature keeps the structural literal it always had.
interface CliOutcome {
  exitCode: number;
  stderr: string;
  stdout: string;
}

// The exact upgrade-hint line appended as the second line of an unknown-command
// error: a version-skew signal telling the caller their dobby is behind the kit.
const upgradeHint =
  "if this command is expected, run `bun update @kvnwolf/dobby`";

// The Options block — STATIC (a flags reference; it documents every flag and does
// not vary per repo). The Commands block above it IS capability-filtered, so the
// help never advertises a command that does not apply to the current repo.
const OPTION_LINES = [
  "  --json          Print machine-readable JSON (env, up, session commands)",
  "  --lint          check: run only biome",
  "  --types         check: run only tsc",
  "  --unused        check: run only knip",
  "  --build         check: run only the build step",
  "  --test          check: run only the test step",
  "  --fix           check: apply biome's safe fixes first, then report what remains",
  "  --hook          check: edit-time PostToolUse mode (payload on stdin)",
  "  --pre-push      check: git pre-push backstop mode (ref lines on stdin)",
  "  --no-cache      check: ignore the gate cache — run every step (a green full gate is still recorded)",
  "  --dry-run       dev / build / db:* / up / down: print the resolved action plan without executing it",
  "  -v, --version   Print the dobby version and exit",
];

// The usage/help text, COMPUTED per repo from the detected capabilities. The first
// line begins "Usage: dobby" (asserted by the contract); the Commands block lists
// ONLY the applicable commands (`usageCommands`, filtered) — the fix for the field
// report where the static help advertised dev/up/down/db:* in repos with neither a
// vite nor a db capability. `releaseAvailable` is the ONE config-derived input (the
// loaded `dobby.config.json` carries a `release` key): `usageCommands` stays PURE,
// so the config read happens in run() and only the verdict is passed. All rendering
// (column alignment, headers) lives HERE; `tasks.ts` returns the filtered data.
function buildUsage(capabilities: string[], releaseAvailable: boolean): string {
  const commands = usageCommands(capabilities, releaseAvailable);
  const width = Math.max(...commands.map((c) => c.name.length));
  const commandLines = commands.map(
    (c) => `  ${c.name.padEnd(width)}  ${c.description}`
  );
  return [
    "Usage: dobby [command]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Options:",
    ...OPTION_LINES,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The COMMAND REGISTRY — one table declaring, for EVERY command (the pre-existing
// ones included), which flags it accepts, which subcommand tokens are valid (and
// what each of those ADDS to the flag set), and — for the session commands — which
// DOMAIN function owns it.
//
// Why a table at all (spec Decisions 9 + 19):
//  - The strict `parseArgs` above validates flags GLOBALLY: it only knows the flag
//    EXISTS somewhere in the CLI. That let `dobby up --json` parse and be SILENTLY
//    ignored — a whole class of no-op footguns which grows with every flag this
//    session adds. The allowlist turns an out-of-place flag into a hard error
//    naming the flag AND the command (interview I9).
//  - Registering every command HERE (as a stub delegating to its own domain module)
//    means the tasks that implement them touch only their module — nobody has to
//    co-edit this dispatcher.
//
// Pre-existing commands declare `flags` but NO handler: they keep their bespoke arm
// in the flat if-chain inside run() (behavior unchanged — the registry only
// validates them). `db:*` is not a fixed key; it resolves through DB_ENTRY.
// ---------------------------------------------------------------------------

interface CommandEntry {
  // The flags accepted regardless of subcommand, by LONG name (as declared in
  // parseArgs). `--version` is exempt everywhere: it short-circuits before dispatch.
  flags: readonly string[];
  // The DOMAIN function for a session command. Absent = an existing command whose
  // arm lives in run()'s if-chain.
  handler?: (context: CommandContext) => CommandResult;
  // Subcommand token → the flags THAT token adds. Present at all = the command
  // REQUIRES one of these tokens as its first positional.
  subcommands?: Readonly<Record<string, readonly string[]>>;
}

// The universal machine-output flag: every session command answers with a JSON
// payload, so each accepts `--json` (their `text` form is the human fallback).
const JSON_FLAG: readonly string[] = ["json"];

const COMMANDS: Readonly<Record<string, CommandEntry>> = {
  adr: {
    flags: JSON_FLAG,
    handler: runAdr,
    // PINNED to the implemented surface (`dobby adr new "<title>" [--status …]`),
    // replacing task 1's pre-spec guess: the title is a POSITIONAL, the slug is
    // DERIVED from it, and the body is deliberately not the CLI's to write (the
    // command emits a skeleton; authorship stays with the architect) — so
    // `--title`/`--slug`/`--body-file` would each have been a silently-ignored
    // flag, the exact footgun class this allowlist exists to close.
    subcommands: { new: ["status"] },
  },
  "arch-report": {
    flags: JSON_FLAG,
    handler: runArtifactLint,
    subcommands: { verify: ["file", "focus"] },
  },
  brief: {
    flags: JSON_FLAG,
    handler: runArtifactLint,
    subcommands: { lint: ["file", "issue"] },
  },
  build: { flags: ["dry-run"] },
  "build-plan": {
    flags: ["json", "file", "task"],
    handler: runBuildPlan,
  },
  check: {
    flags: [
      "fix",
      "hook",
      "lint",
      "types",
      "unused",
      "build",
      "test",
      // The git pre-push backstop mode: git's ref lines arrive on stdin (the bin
      // drains it for `--pre-push` exactly as it does for `--hook`).
      "pre-push",
      // Bypass the gate cache's CONSULT (turbo `--force` semantics): every step
      // runs, and a green FULL gate is still recorded for the next run.
      "no-cache",
    ],
  },
  claim: { flags: ["json", "issue"], handler: runClaim },
  dev: { flags: ["dry-run"] },
  down: { flags: ["dry-run"] },
  env: { flags: JSON_FLAG },
  finish: {
    flags: ["json", "preflight", "slug"],
    handler: runFinishPreflight,
  },
  goal: {
    flags: JSON_FLAG,
    handler: runGoal,
    subcommands: { parse: ["source", "issue"] },
  },
  handoff: {
    flags: JSON_FLAG,
    handler: runArtifactLint,
    // `--focus`: the subject `/dobby:handoff` was invoked with. The linter reads
    // it (the one-line `## Focus` section must be ABOUT it), so it has to survive
    // the allowlist — without the token here the flag is rejected as unknown
    // before the handler ever runs.
    subcommands: { finalize: ["file", "focus"] },
  },
  kb: {
    flags: ["json", "kind"],
    handler: runKb,
    // PINNED to the implemented surface (`kb record --kind --concept --title
    // --reason-file --entry`), replacing task 1's pre-spec guess — which STATE.md
    // (task 1, finding 4) flagged as the weakest one and left for this task to
    // settle. `--reason-file` supersedes the generic `--file`, and a KB record is
    // ALWAYS a rejection, so `--rejected` carried no information.
    subcommands: {
      list: [],
      record: ["concept", "entry", "title", "reason-file"],
    },
  },
  map: {
    flags: ["json", "file"],
    handler: runArtifactLint,
    subcommands: { claim: ["task"], lint: [], next: ["focus"] },
  },
  migrate: {
    flags: ["json", "dry-run"],
    handler: runMigrate,
    subcommands: { preflight: [], verify: [] },
  },
  pr: {
    flags: ["json", "pr"],
    handler: runPr,
    subcommands: { watch: ["deadline", "await-review"] },
  },
  release: {
    flags: ["json", "dry-run", "bump", "notes-file"],
    handler: runRelease,
  },
  repro: {
    flags: ["json", "expect", "repeat", "bench"],
    handler: runRepro,
  },
  review: {
    flags: ["json", "pr"],
    handler: runReview,
    subcommands: { apply: ["plan", "stdin", "dry-run"], fetch: [] },
  },
  scope: {
    flags: JSON_FLAG,
    handler: runScopePreflight,
    subcommands: { preflight: ["slug", "goal", "source"] },
  },
  ship: {
    flags: ["json", "message-file", "pr-body-file"],
    handler: runShip,
  },
  skill: {
    flags: JSON_FLAG,
    handler: runArtifactLint,
    subcommands: { lint: ["file"] },
  },
  spec: {
    flags: JSON_FLAG,
    handler: runArtifactLint,
    subcommands: { lint: ["file"] },
  },
  state: {
    flags: JSON_FLAG,
    handler: runState,
    subcommands: {
      "append-worklog": ["file", "stdin", "task"],
      // `--goal` / `--source` fill the Goal and Source bodies of the skeleton
      // `init` writes (the surface `/dobby:scope` calls); both options already
      // exist globally (allowlisted for `scope preflight`).
      init: ["goal", "source"],
      // No `--file` (unlike the artifact-lint commands): `state lint` judges the
      // ONE document the engine owns, `<workroot>/STATE.md`, so a target flag
      // could only be silently ignored.
      lint: [],
      set: ["file", "stdin"],
    },
  },
  tracker: {
    flags: JSON_FLAG,
    handler: runTracker,
    subcommands: {
      close: ["issue", "reason-file", "rejected"],
      create: ["title", "body-file", "label", "kind"],
      info: ["issue"],
      search: ["label", "status", "focus"],
    },
  },
  // `--json` renders the machine report (`UpFacts`) instead of the human forms —
  // the flag used to parse and be SILENTLY dropped, which is the footgun the
  // allowlist closes for every other flag too.
  up: { flags: ["dry-run", "json"] },
  update: { flags: [] },
  wizard: {
    flags: JSON_FLAG,
    handler: runArtifactLint,
    subcommands: { verify: ["file"] },
  },
};

// Every inferred `db:<task>` shares one entry — the name is resolved by `dbTasks`,
// not by this table.
const DB_ENTRY: CommandEntry = { flags: ["dry-run"] };

// The registry entry for a command token, or undefined when the CLI has no such
// command (the caller then falls through to the unknown-command error). `release`
// is CONFIG-GATED (spec Decision 2): without a `release` key in the config loaded
// from the WORKROOT the command does not exist at all — same as it is absent from
// the help. (A config that exists but failed to load never reaches here: run()
// surfaces its error, so a broken config can never read as an absent command.)
// `Object.hasOwn` keeps inherited Object properties (`toString`, `constructor`)
// from resolving to a bogus entry.
function lookupCommand(
  command: string,
  releaseAvailable: boolean
): CommandEntry | undefined {
  if (command.startsWith("db:")) {
    return DB_ENTRY;
  }
  if (command === "release" && !releaseAvailable) {
    return;
  }
  return Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
}

// An error carrying the SAME shape as the parse error: the message first, a blank
// line, then the capability-filtered usage (the order is part of the contract).
function usageError(message: string, usage: string): CliOutcome {
  return { exitCode: 1, stderr: `${message}\n\n${usage}`, stdout: "" };
}

// Validate ONE invocation against its registry entry, BEFORE dispatch:
//  1. the subcommand token (for a subcommand-style command) — missing or unknown
//     is a hard error listing what IS valid, mirroring the `db:*` precedent, and
//     it precedes the flag check so `state frobnicate --file x` complains about
//     the token, not the flag;
//  2. the flags — every PRESENT flag must sit in the command's set ∪ the chosen
//     subcommand's additions; the first outsider is a hard error naming the flag,
//     the command (subcommand included) and what the command does accept.
// Returns null when the invocation is well-formed.
function validateInvocation(
  command: string,
  entry: CommandEntry,
  args: string[],
  options: CommandOptions,
  usage: string
): CliOutcome | null {
  let added: readonly string[] = [];
  let label = command;

  const { subcommands } = entry;
  if (subcommands !== undefined) {
    const valid = Object.keys(subcommands);
    const [token] = args;
    if (token === undefined) {
      return usageError(
        `${command} requires a subcommand — expected one of: ${valid.join(", ")}`,
        usage
      );
    }
    if (!Object.hasOwn(subcommands, token)) {
      return usageError(
        `unknown subcommand: ${command} ${token} — expected one of: ${valid.join(", ")}`,
        usage
      );
    }
    added = subcommands[token] ?? [];
    label = `${command} ${token}`;
  }

  const allowed = [...entry.flags, ...added];
  for (const flag of Object.keys(options)) {
    if (!allowed.includes(flag)) {
      const accepted =
        allowed.length === 0
          ? "it takes no flags"
          : `accepted flags: ${allowed.map((name) => `--${name}`).join(", ")}`;
      return usageError(
        `unknown flag --${flag} for \`dobby ${label}\` — ${accepted}`,
        usage
      );
    }
  }

  return null;
}

// The GENERIC renderer for every session command (the ONLY rendering they need):
// a result carrying a `json` payload prints it as one JSON line — the sole stdout
// — otherwise `text` prints verbatim; `error` goes to stderr with a trailing
// newline. Generic ON PURPOSE: a later task fills a stub's internals and gets its
// output rendered without touching this file.
function renderCommandResult(result: CommandResult): CliOutcome {
  const stdout =
    result.json === undefined
      ? (result.text ?? "")
      : `${JSON.stringify(result.json)}\n`;
  return {
    exitCode: result.exitCode,
    stderr: result.error === undefined ? "" : `${result.error}\n`,
    stdout,
  };
}

// run() is the command DISPATCHER (a flat switch over every `dobby` subcommand) and is
// async BY CONTRACT: it is the capture seam the streaming split pairs with the async
// `runDev` — index.ts awaits BOTH uniformly — and its return type is Promise. Its
// complexity is the sum of the CLI surface (each arm delegates to a planner/executor),
// not tangled logic; splitting it would scatter the one legible statement of the contract.
// It dispatches only synchronous executors today, so a bare `await` would be pure noise.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dispatcher breadth, not tangled logic (see above)
// biome-ignore lint/suspicious/useAwait: async is a deliberate load-bearing contract (see above)
export async function run(
  argv: string[],
  cwd: string,
  stdin?: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // `release` is the CLI's one CONFIG-gated command (spec Decision 2): the loaded
  // `dobby.config.json` must carry a `release` key for it to exist or be
  // advertised. Read here (config.ts stays the sole reader) and passed on as a
  // plain verdict so the help inference stays pure.
  //
  // The config is read from the RESOLVED WORKROOT — the same root every other
  // config consumer uses (check.ts, envinfo.ts) — never the bare cwd: `cd cli &&
  // dobby release` in a configured repo would otherwise find no config and make a
  // real command vanish. Outside a git repo the cwd is the only root there is.
  // An unparseable/unreadable config yields false, so the HELP never fails on it;
  // the command path below surfaces its error instead of hiding the command.
  const configLoad = loadConfig(resolveWorkroot(cwd) ?? cwd);
  const configError = configLoad?.ok === false ? configLoad.error : null;
  const releaseAvailable =
    configLoad?.ok === true && configLoad.config.release !== undefined;

  // The usage/help text is capability-filtered per repo (the SAME detection env's
  // `capabilities:` line uses — over the PASSED cwd, never a workroot resolve), so
  // every path that prints usage (bare, parse error, unknown command) advertises
  // only the commands that apply here.
  const usage = buildUsage(detectCapabilities(cwd), releaseAvailable);

  let positionals: string[];
  let version: boolean | undefined;
  let json: boolean | undefined;
  let hook: boolean | undefined;
  let fix: boolean | undefined;
  let dryRun: boolean | undefined;
  // The selective `check` flags: any present => run ONLY the flagged steps.
  let checkFlags: CheckFlags = {};
  // Every flag PRESENT in argv, for the per-command allowlist (and for the domain
  // modules, which read their own options off it).
  const options: Record<string, boolean | string> = {};

  try {
    const parsed = parseArgs({
      allowPositionals: true,
      args: argv,
      options: {
        "await-review": { type: "boolean" },
        bench: { type: "boolean" },
        "body-file": { type: "string" },
        build: { type: "boolean" },
        bump: { type: "string" },
        concept: { type: "string" },
        deadline: { type: "string" },
        "dry-run": { type: "boolean" },
        entry: { type: "string" },
        expect: { type: "string" },
        file: { type: "string" },
        fix: { type: "boolean" },
        focus: { type: "string" },
        goal: { type: "string" },
        hook: { type: "boolean" },
        issue: { type: "string" },
        json: { type: "boolean" },
        kind: { type: "string" },
        label: { type: "string" },
        lint: { type: "boolean" },
        "message-file": { type: "string" },
        "no-cache": { type: "boolean" },
        "notes-file": { type: "string" },
        plan: { type: "string" },
        pr: { type: "string" },
        "pr-body-file": { type: "string" },
        "pre-push": { type: "boolean" },
        preflight: { type: "boolean" },
        "reason-file": { type: "string" },
        rejected: { type: "boolean" },
        repeat: { type: "string" },
        slug: { type: "string" },
        source: { type: "string" },
        status: { type: "string" },
        stdin: { type: "boolean" },
        task: { type: "string" },
        test: { type: "boolean" },
        title: { type: "string" },
        types: { type: "boolean" },
        unused: { type: "boolean" },
        version: { short: "v", type: "boolean" },
      },
      strict: true,
    });
    ({ positionals } = parsed);
    ({ "dry-run": dryRun, fix, hook, json, version } = parsed.values);
    checkFlags = {
      build: parsed.values.build,
      lint: parsed.values.lint,
      test: parsed.values.test,
      types: parsed.values.types,
      unused: parsed.values.unused,
    };
    // parseArgs sets a key ONLY for a flag that appeared, so the surviving entries
    // ARE the present flags (an absent one is undefined and dropped here).
    for (const [name, value] of Object.entries(parsed.values)) {
      if (typeof value === "string" || typeof value === "boolean") {
        options[name] = value;
      }
    }
  } catch (error) {
    // parseArgs (strict) throws a TypeError on unknown/malformed flags. Emit the
    // parse error message BEFORE the usage — the order is part of the contract.
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stderr: `${message}\n\n${usage}`, stdout: "" };
  }

  if (version) {
    return { exitCode: 0, stderr: "", stdout: `${pkg.version}\n` };
  }

  const [command] = positionals;

  if (command === undefined) {
    return { exitCode: 0, stderr: "", stdout: usage };
  }

  // A config that FAILED to load cannot answer whether `release` exists. Falling
  // through to `unknown command: release` (plus the "update dobby" hint) would
  // point a typo in `release.type` at the wrong problem entirely, so the config
  // error is reported instead — the command exists, the config is broken.
  if (command === "release" && configError !== null) {
    return { exitCode: 1, stderr: `${configError}\n`, stdout: "" };
  }

  // The REGISTRY gate, ahead of every dispatch arm: a KNOWN command validates its
  // subcommand token + its flag allowlist here (so no arm below has to), and a
  // SESSION command is then dispatched to its domain module and rendered
  // generically. An unknown token resolves to no entry and falls through to the
  // unknown-command error at the bottom — naming a flag for a command that does
  // not exist would only bury the real problem.
  const entry = lookupCommand(command, releaseAvailable);
  if (entry !== undefined) {
    const args = positionals.slice(1);
    const rejection = validateInvocation(command, entry, args, options, usage);
    if (rejection !== null) {
      return rejection;
    }
    if (entry.handler !== undefined) {
      return renderCommandResult(
        entry.handler({ command, cwd, options, positionals: args, stdin })
      );
    }
  }

  if (command === "env") {
    // env NEVER fails: collectEnv degrades every unresolvable fact to null/false/[]
    // and formatting cannot throw, so the exit code is always 0.
    const snapshot = collectEnv(cwd);
    const stdout = json ? formatEnvJson(snapshot) : formatEnvText(snapshot);
    return { exitCode: 0, stderr: "", stdout };
  }

  if (command === "check") {
    if (hook) {
      // Edit-time hook: read the PostToolUse payload from stdin, apply biome's
      // SAFE fixes to the edited file, and surface ONLY unfixable findings. Every
      // guard is a SILENT exit 0 (empty stdout AND stderr) — harness noise must
      // never block an edit. Findings go to STDERR because Claude Code shows the
      // model stderr (not stdout) on exit 2 — the whole point of the exit-2 code.
      const outcome = checkHook(stdin, cwd);
      if (!outcome.surface) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return {
        exitCode: 2,
        stderr: formatCheck(outcome.groups, []),
        stdout: "",
      };
    }
    if (options["pre-push"] === true) {
      // The PRE-PUSH BACKSTOP: git's `<local-ref> <local-sha> <remote-ref>
      // <remote-sha>` lines arrive on stdin, and a nonzero exit aborts the push.
      // Everything it decides (the stdin contract, the gate cache, the uncapped
      // report) lives in hook-install.ts, so the installed shim stays a dumb
      // guarded exec — and every branch stays reachable through run(argv, cwd,
      // stdin) instead of only through a real `git push`.
      return prePushCheck(cwd, stdin);
    }
    // Positionals after "check" are file args (per-file fast path); none = the
    // project-wide gate (subset by the selective flags). `--fix` applies biome's
    // SAFE fixes first (project-wide, or over the named files) so the pre-commit
    // gate never fails on formatting the edit hook did not reach, THEN reports what
    // remains. `--no-cache` bypasses the gate cache's consult so every selected
    // step really runs (a green full gate is still recorded). A hard error (not a
    // git repo / a bundled tool missing) reports on stderr with exit 1; otherwise
    // the report's aggregated exit code (first failing step, 0 if all passed) is
    // used.
    const report = check(
      positionals.slice(1),
      cwd,
      checkFlags,
      Boolean(fix),
      options["no-cache"] === true
    );
    if (!report.ok) {
      return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
    }
    return {
      exitCode: report.exitCode,
      stderr: "",
      stdout: formatCheck(report.groups, report.notes),
    };
  }

  if (command === "dev") {
    // The dev PLAN — the `--dry-run` capture output — plus the no-app gate. A LIVE
    // dev (a managed group of the portless-wrapped main + concurrent secondaries
    // with signal forwarding) is owned by the bin's STREAMING path: index.ts
    // intercepts a CLEAN `dobby dev` (the positional, no flags — `tasks.isLiveDev`)
    // before run() is reached, so run() only ever PLANS and never spawns a dev
    // server. A FLAGGED dev always lands here, and the strict parseArgs above has
    // already had its say — an unknown flag (`dev --no-share`) never reaches this
    // arm at all (exit 1 + usage), so a would-be-live dev that gets here is one
    // whose flags parsed, and it just prints the plan. No app (no vite) is a hard
    // error: exit 1 with 'nothing to run'.
    const report = planDev(cwd);
    if (!report.ok) {
      return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
    }
    return { exitCode: 0, stderr: "", stdout: formatDevPlan(report.plan) };
  }

  if (command === "build") {
    // The inferred mechanical build (ADR-0015): external builders (Vercel CI) set
    // their buildCommand to `bunx dobby build`, so dobby owns the `vite build` spawn
    // (consumer-local vite + the config-less default `--config` when absent). Gated
    // on the vite capability (no vite → exit 1 'nothing to build', dev's gate's
    // twin). FINITE — dispatched here (not the streaming split), inheriting stdio; a
    // real run streams so only the exit code / failure come back. `--dry-run` renders
    // the resolved plan without spawning.
    const report = runBuild(cwd, { dryRun: Boolean(dryRun) });
    if (!report.ok) {
      return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
    }
    if (report.kind === "plan") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: formatBuildPlan(report.bin, report.args, report.cwd),
      };
    }
    return {
      exitCode: report.exitCode,
      stderr: report.failure === null ? "" : `${report.failure}\n`,
      stdout: "",
    };
  }

  if (command === "up") {
    // Bring the app up (liveness-first, idempotent). Fails hard outside a git repo;
    // the no-app gate (no vite) is a graceful exit-0 no-op; a neon project with
    // missing creds fails hard (no main-DB fallback). `--dry-run` renders the
    // decision-derived plan without probing / spawning / touching cmux or neon; a
    // real run executes it and reports the outcome (streamed stdio, so no stdout).
    // `--json` renders the machine report INSTEAD of every human form below.
    const report = runUp(cwd, {
      dryRun: Boolean(dryRun),
      machineReport: Boolean(json),
    });
    if (json) {
      return renderUpJson(report);
    }
    if (!report.ok) {
      return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
    }
    if (report.kind === "noop") {
      return { exitCode: 0, stderr: "", stdout: `${report.message}\n` };
    }
    if (report.kind === "plan") {
      return { exitCode: 0, stderr: "", stdout: formatUpPlan(report.plan) };
    }
    return {
      exitCode: report.exitCode,
      stderr: report.failure === null ? "" : `${report.failure}\n`,
      stdout: "",
    };
  }

  if (command === "down") {
    // Tear the run down (close panes, kill the detached run, delete the neon
    // branch, teardown[] extras). Fails hard outside a git repo; nothing to clean →
    // exit 0 no-op. `--dry-run` renders the plan without executing.
    const report = runDown(cwd, { dryRun: Boolean(dryRun) });
    if (!report.ok) {
      return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
    }
    if (report.kind === "plan") {
      return { exitCode: 0, stderr: "", stdout: formatDownPlan(report.plan) };
    }
    return {
      exitCode: report.exitCode,
      stderr: report.failure === null ? "" : `${report.failure}\n`,
      stdout: "",
    };
  }

  if (command.startsWith("db:")) {
    // Inferred db task: the command name resolves through the capability-driven
    // db:* map (drizzle is the one db tool, so the short db:* names map to
    // drizzle-kit). An unknown name is a hard error (exit 1) whose message already
    // lists what IS available. `--dry-run` prints the resolved command without spawning.
    const report = runDbTask(command, cwd, { dryRun: Boolean(dryRun) });
    if (!report.ok) {
      return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
    }
    if (report.kind === "plan") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: formatDbPlan(report.bin, report.command, report.cwd),
      };
    }
    // A real run inherited stdio (output streamed straight to the terminal); only
    // the exit code and an optional failure note come back as data.
    return {
      exitCode: report.exitCode,
      stderr: report.failure === null ? "" : `${report.failure}\n`,
      stdout: "",
    };
  }

  if (command === "update") {
    // Interactive dependency update (taze). Inherits stdio — the picker streams to
    // the user and terminates with them — so only the exit code is captured here.
    const report = runUpdate(cwd);
    if (!report.ok) {
      return { exitCode: 1, stderr: `${report.error}\n`, stdout: "" };
    }
    return { exitCode: report.exitCode, stderr: "", stdout: "" };
  }

  return {
    exitCode: 1,
    stderr: `unknown command: ${command}\n${upgradeHint}\n\n${usage}`,
    stdout: "",
  };
}

// Render the env snapshot as `key: value` lines (the default form). Scalars
// print their value or the literal "null"; capabilities and the inferred db tasks
// print as a comma-separated list or the literal "none"; config prints
// "true"/"false".
function formatEnvText(snapshot: EnvSnapshot): string {
  return [
    `cmux: ${scalar(snapshot.cmux)}`,
    `worktree: ${scalar(snapshot.worktree)}`,
    `branch: ${scalar(snapshot.branch)}`,
    `capabilities: ${list(snapshot.capabilities)}`,
    `config: ${snapshot.config}`,
    `dbTasks: ${list(snapshot.dbTasks)}`,
    `devUrl: ${scalar(snapshot.devUrl)}`,
    `runPane: ${scalar(snapshot.runPane)}`,
    `browserPane: ${scalar(snapshot.browserPane)}`,
  ]
    .join("\n")
    .concat("\n");
}

// A list field for text output: its comma-separated members, or the literal "none".
function list(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

// A scalar field for text output: its string value, or the literal "null".
function scalar(value: string | null): string {
  return value === null ? "null" : value;
}

// Render the env snapshot as one JSON object: string|null scalars, a capabilities
// ARRAY, and a boolean config — the skill-consumable shape. The snapshot already
// carries exactly these types, so a plain stringify is the whole contract.
function formatEnvJson(snapshot: EnvSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

// One human line per setup action. The wording carries the load-bearing substrings
// the contract reads: the literal `bun install`, the copied file's relative path,
// and each extra's verbatim command.
function describeSetupAction(action: SetupAction): string {
  switch (action.kind) {
    case "install":
      return "bun install";
    case "hook":
      // A FOREIGN pre-push hook is refused, not overwritten — and the refusal is
      // only useful if it names the file blocking the install (the human decides
      // whether to fold dobby's gate into their own hook or delete it).
      return action.foreign
        ? `pre-push backstop NOT installed: ${action.path} exists and was not written by dobby`
        : `install the pre-push backstop: ${action.path}`;
    case "copy":
      return `copy ${action.rel} (from main checkout)`;
    case "extra":
      return `run: ${action.run}`;
    default:
      // Exhaustive over SetupAction — `action` is `never` here; a future uncased
      // kind fails tsc rather than silently rendering nothing.
      return action;
  }
}

// Render a resolved db task for `--dry-run`: the RESOLVED tool bin (consumer
// node_modules/.bin path, or the bare name when absent) + args as one shell-style
// line (mirroring the setup plan format), followed by the pinned workroot the real
// run would spawn in (the task constraint: "prints the resolved command + cwd, no
// spawn"). NO spawn happened — this is what the real run would execute, printed so
// tests and verify recipes can assert the mapping AND observe the bin resolution
// (part c).
function formatDbPlan(bin: string, command: DbCommand, cwd: string): string {
  const line = `${bin} ${command.args.join(" ")}`.trimEnd();
  return `db task (dry-run):\n  ${line}\n  cwd: ${cwd}\n`;
}

// Render `dobby build --dry-run`: the RESOLVED consumer vite bin + args (incl. the
// config-less default `--config <preset>` when the consumer ships no vite config,
// ADR-0015) as one shell-style line, then the pinned workroot — mirroring the db:*
// dry-run plan format. NO spawn: this is exactly what a real `bunx dobby build`
// (the Vercel buildCommand) would execute.
function formatBuildPlan(bin: string, args: string[], cwd: string): string {
  const line = `${bin} ${args.join(" ")}`.trimEnd();
  return `build (dry-run):\n  ${line}\n  cwd: ${cwd}\n`;
}

// Render the RESOLVED dev plan as one shell-style line per command, in EXECUTION
// order: the main's `.vite` cache-clears, then the portless-WRAPPED main, then the
// concurrent secondaries. Mirrors the sibling setup/db dry-run plan format. The
// portless wrapper and the app/secondary bins render as their RESOLVED absolute
// paths (part c: the resolution is observable); the `rm` cache-clear stays logical
// (a native op, never spawned).
function formatDevPlan(plan: ResolvedDevPlan): string {
  const lines: string[] = [];
  if (plan.main !== null) {
    for (const clear of plan.cacheClears) {
      lines.push(`  ${clear.tool} ${clear.args.join(" ")}`.trimEnd());
    }
    lines.push(
      `  ${plan.main.portless} run ${renderResolvedCommand(plan.main.command)}`
    );
  }
  for (const secondary of plan.secondaries) {
    lines.push(`  ${renderResolvedCommand(secondary)}`);
  }
  return ["Dev plan (dry-run):", ...lines].join("\n").concat("\n");
}

// One shell-style line for a resolved dev command: `<resolved-bin> <args…>`.
function renderResolvedCommand(command: ResolvedDevCommand): string {
  return `${command.bin} ${command.args.join(" ")}`.trimEnd();
}

// Render `dobby up --json`: the flat machine report (`UpFacts`, decided in
// lifecycle.ts) as ONE JSON object that is the SOLE stdout — a skill parses stdout
// whole, so a single stray prose line would break it. The human message keeps its
// place on STDERR (setup children stream there too, via runUp's `machineReport`),
// and the exit code follows the action-command convention: 0 when the workspace is
// up, nonzero whenever `ok` is false — the failing step's own code where there is
// one, else 1, so `ok:false` and a zero exit can never be reported together.
function renderUpJson(report: UpReport): CliOutcome {
  let message: string | null = null;
  let failureExit = 1;
  if (report.ok === false) {
    message = report.error;
  } else if (report.kind === "ran") {
    message = report.failure;
    failureExit = report.exitCode;
  }
  return {
    exitCode: report.facts.ok ? 0 : Math.max(failureExit, 1),
    stderr: message === null ? "" : `${message}\n`,
    stdout: `${JSON.stringify(report.facts)}\n`,
  };
}

// The placeholder surface refs the `up` plan renders where a real run would capture
// a runtime cmux surface ref — each pane is renamed (and the run pane is sent its
// start line) through the ref cmux hands back, so the plan spells the dependency out
// even though the ref is unknown until the pane is created.
const BROWSER_SURFACE = "<browser-surface>";
const RUN_SURFACE = "<run-surface>";

// Render the FULL `up` plan for `--dry-run`: the SETUP PHASE first (install → copies
// → extras, mirroring the folded former setup plan), THEN the cmux WORKSPACE rename
// (when under cmux — independent of the app gate), THEN the run phase in execution
// order (probe → neon branch → cmux RUN pane XOR detached run → liveness wait → cmux
// BROWSER pane), OR — when the run phase is skipped — the skip reason line ('no app to
// run'). The pane lines sit where they really happen: the run terminal at start time,
// the browser pane AFTER the wait (a browser opened mid-boot renders a 404).
function formatUpPlan(plan: UpPlan): string {
  const lines: string[] = [];
  for (const action of plan.setup) {
    lines.push(`  ${describeSetupAction(action)}`);
  }
  if (plan.renameWorkspace !== null) {
    lines.push(
      `  cmux rename-workspace --workspace ${plan.renameWorkspace.workspace} "${plan.renameWorkspace.title}"`
    );
  }
  for (const action of plan.actions) {
    for (const line of describeUpAction(action)) {
      lines.push(`  ${line}`);
    }
  }
  if (plan.runSkipped !== null) {
    lines.push(`  ${plan.runSkipped}`);
  }
  return ["Up plan (dry-run):", ...lines].join("\n").concat("\n");
}

// The plan line(s) for one `up` action.
function describeUpAction(action: UpAction): string[] {
  switch (action.kind) {
    case "probe":
      return [
        `probe liveness: curl -sf --max-time 5 ${action.url ?? "<devUrl>"}`,
      ];
    case "neon-branch":
      return [
        `bunx neonctl branches create --name ${action.branch} --project-id ${action.projectId} --output json`,
        "rewrite DATABASE_URL, DATABASE_URL_UNPOOLED in .env.local (from the branch connection strings)",
      ];
    case "cmux-run-pane":
      return [
        `cmux new-pane --workspace ${action.workspace} --direction right`,
        `cmux rename-tab --surface ${RUN_SURFACE} "${action.runName}"`,
        `cmux send --surface ${RUN_SURFACE} "${action.sendLine}"`,
      ];
    case "cmux-browser-pane": {
      const url = action.devUrl === null ? "" : ` --url ${action.devUrl}`;
      return [
        `cmux new-pane --workspace ${action.workspace} --type browser${url} --direction right`,
        `cmux rename-tab --surface ${BROWSER_SURFACE} "${action.browserName}"`,
      ];
    }
    case "detached":
      return [
        `spawn detached: ${action.command} (pid → ${action.pidRel}, log → ${action.logRel})`,
      ];
    case "wait":
      return [
        `wait for liveness: curl -sf --max-time 5 ${action.url ?? "<devUrl>"} (retry ${action.retries}×${action.intervalSec}s)`,
      ];
    default:
      // Exhaustive over UpAction — `action` is `never` here (compile-time guard).
      return action;
  }
}

// Render the `down` plan as one shell-style line per planned action (close panes →
// kill the detached run → delete the neon branch → teardown[] extras). An empty
// plan prints a `(nothing to clean)` line.
function formatDownPlan(plan: DownPlan): string {
  const lines: string[] = [];
  for (const action of plan.actions) {
    for (const line of describeDownAction(action)) {
      lines.push(`  ${line}`);
    }
  }
  const body = lines.length === 0 ? ["  (nothing to clean)"] : lines;
  return ["Down plan (dry-run):", ...body].join("\n").concat("\n");
}

// The plan line(s) for one `down` action.
function describeDownAction(action: DownAction): string[] {
  switch (action.kind) {
    case "cmux-close":
      return [
        `cmux close-surface --surface <${action.browserName}>`,
        `cmux close-surface --surface <${action.runName}>`,
      ];
    case "kill-pidfile":
      return [
        `kill process group from ${action.pidRel} (SIGTERM; stale pid → remove the file)`,
      ];
    case "neon-delete":
      return [
        `bunx neonctl branches delete ${action.branch} --project-id ${action.projectId}`,
      ];
    case "extra":
      return [`run: ${action.run}`];
    default:
      // Exhaustive over DownAction — `action` is `never` here (compile-time guard).
      return action;
  }
}

// The per-tool cap on printed findings: the model needs a representative sample,
// not an exhaustive dump. Overflow collapses to a `…N more` tail per tool.
const FINDING_CAP = 50;

// Render a check run as token-lean text: one `file:line message` line per
// finding, grouped and labelled per tool, each group capped — then the step
// notes (capability skips, build/test/extra failures), each its OWN single line
// (so a skip note is scannable as one line). A findingless nonzero step exit
// (a crashed tool) renders its raw-output tail under the note line. An empty run
// (no findings, no notes) prints a single "No findings." line.
function formatCheck(groups: CheckGroup[], notes: CheckNote[]): string {
  const blocks: string[] = [];
  for (const group of groups) {
    if (group.findings.length === 0) {
      continue;
    }
    const lines = [`${group.tool} (${group.findings.length}):`];
    const shown = group.findings.slice(0, FINDING_CAP);
    for (const finding of shown) {
      lines.push(
        `  ${finding.file}:${finding.line} ${finding.message}`.trimEnd()
      );
    }
    const overflow = group.findings.length - shown.length;
    if (overflow > 0) {
      lines.push(`  …${overflow} more`);
    }
    blocks.push(lines.join("\n"));
  }
  for (const note of notes) {
    blocks.push(renderNote(note));
  }
  return blocks.length === 0 ? "No findings.\n" : `${blocks.join("\n\n")}\n`;
}

// A step note as one block: the note line, then — when the step CRASHED (a
// findingless nonzero exit) — a clearly-labeled, indented tail of the tool's raw
// output beneath it (the diagnosability fix; the tail is already capped by
// check.ts). An ordinary note (skip / findings-backed failure) is just its line.
function renderNote(note: CheckNote): string {
  if (note.raw === null) {
    return note.text;
  }
  const body = note.raw
    .split("\n")
    .map((line) => `    ${line}`.trimEnd())
    .join("\n");
  return `${note.text}\n  raw output (tail):\n${body}`;
}
