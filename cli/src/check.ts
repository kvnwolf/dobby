import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { loadConfig } from "./config.ts";
import { detectCapabilities, scanCapabilities } from "./detect.ts";
import {
  configArgs,
  type RunResult,
  resolveViteConfig,
  resolveWorkroot,
  runCapture,
} from "./runner.ts";
import {
  biomeConfigSpec,
  type CheckFlags,
  checkPipeline,
  knipConfigSpec,
  viteBlockedMessage,
  viteConfigSpec,
  vitestConfigSpec,
} from "./tasks.ts";

// The quality-gate executor. `dobby check` orchestrates the bundled tools by
// SHELLING OUT and parsing their machine reporters — never an in-process/WASM
// API (slower, and TS7 has no JS API at all). Two shapes:
//   - project-wide (no file args): the pipeline `tasks.ts` composes — biome +
//     tsc + knip, the capability-gated build/test steps, and config `checks[]`
//     extras. Selective flags (`--lint/--types/--unused/--build/--test`) subset
//     it. A finding from ANY findings tool, or a nonzero build/test/extra exit,
//     fails the gate — but ALL selected steps run (report everything).
//   - per-file fast path (file args): biome ONLY over those files, NO pipeline —
//     the edit-adjacent quick check where a slow whole-project gate is skipped.
// The BUNDLED tool binaries (biome/tsc/knip) resolve from DOBBY's OWN dependency
// tree; the capability-gated build/test bins (vite/vitest) resolve from the
// CONSUMER's tree instead — a second bundled vite would clash with the consumer's
// plugins. The CONSUMER's biome.jsonc / tsconfig.json are the live configs
// (thin-file model): each tool discovers them by walking up from the workroot.
//
// node:* imports only (createRequire + node:path/fs) and process.execPath — no
// Bun.* globals, no bun: modules — so vitest imports it under Node while Bun runs
// it in production. Every spawn goes through runner.ts (cwd pinned to the
// workroot). tasks.ts decides the PLAN (pure); this module EXECUTES it and
// returns DATA (findings + notes); run.ts owns all formatting.

// Resolve a tool from dobby's own dependency tree, relative to THIS file.
const requireFromHere = createRequire(import.meta.url);

// One normalized finding: a file (relative to the workroot), a 1-based line, and
// a single-line human message. Internal — callers see it only through CheckGroup.
interface Finding {
  file: string;
  line: number;
  message: string;
}

// The findings from one tool, kept grouped so run.ts can label + cap per tool.
export interface CheckGroup {
  findings: Finding[];
  tool: string;
}

// One single-line step note (a capability skip, or a build/test/extra failure
// summary), OPTIONALLY carrying the crashed-tool RAW-output tail (`raw`). `raw` is
// non-null ONLY when a step exited nonzero with ZERO parsed findings — the
// crashed-tool case (a startup/config error, not lint findings), where the exit
// code alone is undiagnosable (the field bug: CI's `test: failed (exit 1)` with no
// stderr). run.ts renders `text`, then the labeled `raw` tail beneath it.
export interface CheckNote {
  raw: string | null;
  text: string;
}

// The outcome of a check run:
//   - { ok: true, groups, notes, exitCode } — the pipeline ran. `groups` carries
//     the findings tools' output (possibly empty), `notes` the single-line step
//     notes (capability skips, build/test/extra failures — a findingless failure
//     also carries the crashed tool's raw-output tail), and `exitCode` the
//     aggregated FIRST failing exit code (0 = all selected steps passed). run.ts
//     prints groups + notes and exits with `exitCode`.
//   - { ok: false, error } — a HARD error (not a git repo, or a BUNDLED tool
//     could not be resolved/spawned): surfaced on stderr with a nonzero exit.
type CheckReport =
  | { ok: true; groups: CheckGroup[]; notes: CheckNote[]; exitCode: number }
  | { ok: false; error: string };

// Run the quality gate. `files` empty = project-wide (the composed pipeline);
// non-empty = per-file fast path (biome only). `flags` subset the project-wide
// pipeline (ignored on the per-file path). `fix` applies biome's SAFE fixes in
// place FIRST (project-wide `biome check --write .`, or over the named files) so
// the pre-commit gate never fails on formatting the edit hook did not reach — then
// the selected pipeline runs and reports whatever biome could NOT safely fix (the
// UNSAFE rewrites, e.g. `==`→`===`, are never applied). `cwd` is the caller's
// directory; the workroot is resolved from it and pinned as every child's cwd.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: enumeration, not tangled logic — a flat switch dispatching 6 independent gate-step handlers (biome/tsc/knip/build/test/extra), several of which fatal-return from check(); extracting them would thread shared accumulators + fatal-return plumbing through 6 helpers and regress a load-bearing, tested executor
export function check(
  files: string[],
  cwd: string,
  flags: CheckFlags,
  fix = false
): CheckReport {
  const root = resolveWorkroot(cwd);
  if (root === null) {
    return {
      error:
        "dobby check must run inside a git repository — no git worktree found",
      ok: false,
    };
  }

  const biomeBin = binFrom(requireFromHere, "@biomejs/biome", "biome");
  if (biomeBin === null) {
    return {
      error: "could not resolve the bundled biome binary from dobby",
      ok: false,
    };
  }

  // Config-less defaults (ADR-0015): resolve biome's config args ONCE — the
  // default preset (react vs core, capability-driven) via `--config-path` +
  // `--vcs-root` when the consumer ships no biome.json/jsonc, else NO args (bare
  // spawn, native discovery of the consumer's file — a total override). Scan ONCE
  // for both the capabilities (preset choice) AND the raw dependency set — the
  // vite/vitest specs need it for the require-all-imports guard (a multi-import
  // preset is chosen only when every package it imports is declared).
  const { capabilities, dependencies } = scanCapabilities(root);
  const biomeCfg = configArgs(root, biomeConfigSpec(capabilities));

  // Per-file fast path: biome ONLY over the named files (resolved against the
  // CALLER's cwd so a relative arg from a subdirectory still points at the right
  // file). No pipeline, no tsc/knip/build/test, no extras — the edit-adjacent
  // quick check where a whole-project gate would defeat the point. With `--fix`,
  // biome's SAFE fixes are written to just those files (`--write`) and the
  // remaining findings are reported. (The `configs:` note is a project-wide-gate
  // concern; the edit-adjacent path stays note-free but still uses the default.)
  if (files.length > 0) {
    const biome = runBiome(
      root,
      files.map((file) => resolve(cwd, file)),
      biomeBin,
      biomeCfg.args,
      fix
    );
    if ("error" in biome) {
      return { error: biome.error, ok: false };
    }
    const exitCode = biome.group.findings.length > 0 ? 1 : 0;
    return { exitCode, groups: [biome.group], notes: [], ok: true };
  }

  // The tool spawns that used a dobby DEFAULT config (ADR-0015 observability):
  // collected in pipeline order (biome, knip, vite, vitest), rendered as ONE
  // token-lean `configs:` note after the pipeline runs, omitted when every tool
  // used a consumer config.
  const configDefaults: string[] = [];
  const recordDefault = (tool: string, label: string | null) => {
    if (label !== null) {
      configDefaults.push(`${tool}=${label}`);
    }
  };

  // Project-wide: infer the plan from capabilities + config + flags, then run it.
  const configLoad = loadConfig(root);
  const config = configLoad?.ok ? configLoad.config : null;
  const plan = checkPipeline(capabilities, config, flags);
  const planHasBiome = plan.some((step) => step.kind === "biome");

  // Project-wide `--fix`: apply biome's SAFE fixes across the WHOLE tree FIRST
  // (`biome check --write .`), independent of the pipeline's own biome step — so
  // `--fix --types` still formats before the tsc-only report, and the fix reaches
  // the config files too, not just `src/`. The result is discarded here; whatever
  // biome could not safely fix is surfaced by the pipeline's biome step below. It
  // uses the SAME biome config args, so a biome-default `--fix` still formats. Only
  // record the biome default HERE when the biome step won't run (e.g. `--fix
  // --types`) — otherwise the biome step records it (no double entry).
  if (fix) {
    const fixed = runBiome(root, ["."], biomeBin, biomeCfg.args, true);
    if ("error" in fixed) {
      return { error: fixed.error, ok: false };
    }
    if (!planHasBiome) {
      recordDefault("biome", biomeCfg.usedDefault);
    }
  }

  const groups: CheckGroup[] = [];
  const notes: CheckNote[] = [];
  let exitCode = 0;
  // Aggregate the FIRST failing exit code; every selected step still runs.
  const fail = (code: number) => {
    if (exitCode === 0 && code !== 0) {
      exitCode = code;
    }
  };
  // Config `checks[]` extras are fail-fast among THEMSELVES: once one fails, the
  // remaining extras are skipped (the tool steps above always all ran).
  let extrasStopped = false;

  for (const step of plan) {
    switch (step.kind) {
      case "biome": {
        const biome = runBiome(root, ["."], biomeBin, biomeCfg.args);
        if ("error" in biome) {
          return { error: biome.error, ok: false };
        }
        groups.push(biome.group);
        recordDefault("biome", biomeCfg.usedDefault);
        fail(findingsStepCode("biome", biome.group, biome.result, notes));
        break;
      }
      case "tsc": {
        const tscBin = binFrom(requireFromHere, "typescript", "tsc");
        if (tscBin === null) {
          return {
            error: "could not resolve the bundled tsc binary from dobby",
            ok: false,
          };
        }
        const tsc = runTsc(root, tscBin);
        if ("error" in tsc) {
          return { error: tsc.error, ok: false };
        }
        groups.push(tsc.group);
        fail(findingsStepCode("tsc", tsc.group, tsc.result, notes));
        break;
      }
      case "knip": {
        const knipBin = binFrom(requireFromHere, "knip", "knip");
        if (knipBin === null) {
          return {
            error: "could not resolve the bundled knip binary from dobby",
            ok: false,
          };
        }
        const knipCfg = configArgs(root, knipConfigSpec());
        const knip = runKnip(root, knipBin, knipCfg.args);
        groups.push(knip.group);
        recordDefault("knip", knipCfg.usedDefault);
        if (knip.group.findings.length > 0) {
          fail(1);
        }
        break;
      }
      case "build": {
        if (step.skipNote !== null) {
          notes.push({ raw: null, text: step.skipNote });
          break;
        }
        const viteCfg = resolveViteConfig(
          root,
          viteConfigSpec(capabilities, dependencies)
        );
        // BLOCKED (ADR-0015): a config-less tanstack app missing packages the
        // tanstack default imports has NO import-safe fallback that still serves —
        // fail loud through the step-failure channel (never a silent base build).
        if (viteCfg.blocked) {
          notes.push({
            raw: null,
            text: viteBlockedMessage(viteCfg.missing),
          });
          fail(1);
          break;
        }
        const built = runBuild(root, viteCfg.args);
        if (built.note !== null) {
          notes.push(built.note);
        }
        recordDefault("vite", viteCfg.usedDefault);
        fail(built.exitCode);
        break;
      }
      case "test": {
        if (step.skipNote !== null) {
          notes.push({ raw: null, text: step.skipNote });
          break;
        }
        const vitestCfg = configArgs(
          root,
          vitestConfigSpec(capabilities, dependencies)
        );
        const tested = runTest(root, vitestCfg.args);
        if (tested.note !== null) {
          notes.push(tested.note);
        }
        // A2 hermeticity/missing-keys advisory. The vitest step inherits whatever
        // env files exist locally — CI has none — so a `.env.local` the gate reads
        // but CI lacks can let a suite that validates env at import LOAD locally yet
        // crash in CI. Emit the advisory ONLY when BOTH hold:
        //   - the step ACTUALLY SPAWNED (F2): a missing consumer bin degrades/skips
        //     WITHOUT running vitest, so there is nothing to advise about.
        //   - the SELECTED config is dobby's react default (F3): only
        //     `vitest.react.mjs` calls `loadEnv`, so the env-file contract is dobby's
        //     to judge ONLY there — a base preset or a consumer-owned vitest config
        //     (`usedDefault` not `default(react)`) is silent (their config, their
        //     contract). `hermeticityNote` then compares env-file KEY sets (never
        //     values): no `.env.test` → the inherits note; an INCOMPLETE `.env.test`
        //     → the missing-keys note; a complete superset / no `.env.local` → silent.
        if (tested.spawned && vitestCfg.usedDefault === "default(react)") {
          const hermeticity = hermeticityNote(root);
          if (hermeticity !== null) {
            notes.push({ raw: null, text: hermeticity });
          }
        }
        recordDefault("vitest", vitestCfg.usedDefault);
        fail(tested.exitCode);
        break;
      }
      case "extra": {
        if (extrasStopped) {
          break;
        }
        const code = runExtra(root, step.run);
        if (code !== 0) {
          notes.push({
            raw: null,
            text: `check '${step.name}' failed (exit ${code})`,
          });
          fail(code);
          extrasStopped = true;
        }
        break;
      }
      default: {
        // Exhaustiveness guard: every CheckStep kind is handled above.
        const _never: never = step;
        return _never;
      }
    }
  }

  // ADR-0015 observability: ONE token-lean note naming every tool that ran on a
  // dobby DEFAULT config (override-by-presence made visible). Omitted entirely
  // when every tool used a consumer config (configDefaults empty).
  if (configDefaults.length > 0) {
    notes.push({ raw: null, text: `configs: ${configDefaults.join(" · ")}` });
  }

  return { exitCode, groups, notes, ok: true };
}

// Caps for a crashed tool's raw-output tail: the LAST ~40 lines AND ~4KB (both
// applied, so the tail satisfies whichever is SMALLER). Enough to carry a
// startup/config stack trace, bounded so a runaway dump stays token-lean.
const RAW_TAIL_MAX_LINES = 40;
const RAW_TAIL_MAX_BYTES = 4096;

// The raw-output tail for a step that exited nonzero with ZERO parsed findings — a
// crashed tool (a startup/config error, not lint findings). Prefer stderr (where
// tools print crash diagnostics), falling back to stdout when stderr is blank.
// Capped to the last ~40 lines then ~4KB (whichever is smaller); null when the
// child produced no output at all.
function rawOutputTail(result: RunResult): string | null {
  const source = result.stderr.trim() === "" ? result.stdout : result.stderr;
  let tail = source.trimEnd();
  if (tail === "") {
    return null;
  }
  const lines = tail.split("\n");
  if (lines.length > RAW_TAIL_MAX_LINES) {
    tail = lines.slice(-RAW_TAIL_MAX_LINES).join("\n");
  }
  if (tail.length > RAW_TAIL_MAX_BYTES) {
    tail = tail.slice(-RAW_TAIL_MAX_BYTES);
  }
  return tail;
}

// Build the note for a findingless nonzero step exit: `<tool>: failed (exit N)`
// plus the crashed tool's raw-output tail as data (run.ts renders the tail under
// the note line).
function crashNote(
  tool: string,
  exitCode: number,
  result: RunResult
): CheckNote {
  return {
    raw: rawOutputTail(result),
    text: `${tool}: failed (exit ${exitCode})`,
  };
}

// Fold a findings-tool step (biome/tsc) into the gate and return the exit code to
// aggregate via fail():
//   - findings present  -> fail 1 (as today; findings ARE the diagnostic, no tail).
//   - ZERO findings but a nonzero exit -> the CRASHED-tool case: push a labeled
//     raw-output tail note and fail with the tool's real exit code, so a
//     startup/config crash that emitted no parseable findings stays diagnosable.
//   - a clean exit -> 0 (nothing).
// (knip is intentionally NOT routed here: its can't-start crash folds to zero
// findings and never fails the gate — the documented tolerance invariant.)
function findingsStepCode(
  tool: string,
  group: CheckGroup,
  result: RunResult,
  notes: CheckNote[]
): number {
  if (group.findings.length > 0) {
    return 1;
  }
  if (result.status !== 0) {
    const code = result.status ?? 1;
    notes.push(crashNote(tool, code, result));
    return code;
  }
  return 0;
}

// The file extensions biome supports for the edit-time hook fast path. A payload
// naming any other file type is a silent no-op — biome would refuse it anyway, so
// the guard keeps the hook from surfacing harness noise on unrelated edits.
const HOOK_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "jsonc",
  "css",
]);

// The PostToolUse hook payload (only the field the hook reads). Parsed
// DEFENSIVELY — any missing/mistyped field folds to the silent-exit-0 path.
interface HookPayload {
  tool_input?: { file_path?: unknown };
}

// The outcome of the edit-time hook (`dobby check --hook`):
//   - { surface: false } — a guard tripped (unparsable payload / no file_path /
//     missing file / not a git repo / no dobby.config.json marker / file outside
//     the workroot / unsupported extension) OR biome applied every fix cleanly.
//     run.ts exits 0 with NOTHING surfaced — harness noise must never block an edit.
//   - { surface: true, groups } — biome left unfixable findings after its SAFE
//     auto-fix. run.ts prints them to STDERR and exits 2 (the code Claude Code
//     feeds back to the model on the channel it shows it — stderr, not stdout).
export type HookResult =
  | { surface: false }
  | { surface: true; groups: CheckGroup[] };

// The edit-time hook: parse the PostToolUse payload from stdin, apply biome's SAFE
// fixes to the edited file (mutating it on disk so formatting never bothers the
// model), and report ONLY the findings biome could not fix. Every guard is a
// silent exit 0 (surface:false); the only surfaced outcome is unfixable findings.
// `cwd` is the caller's directory (the bin passes process.cwd()); the workroot is
// resolved from it and every biome spawn is pinned there.
export function checkHook(stdin: string | undefined, cwd: string): HookResult {
  const filePath = parseHookFilePath(stdin);
  if (filePath === null) {
    return { surface: false };
  }

  // The payload path is normally absolute; resolve against the caller's cwd so a
  // relative one still points at the right file.
  const absolute = resolve(cwd, filePath);
  if (!existsSync(absolute)) {
    return { surface: false };
  }

  const root = resolveWorkroot(cwd);
  if (root === null) {
    return { surface: false };
  }

  // config.ts is the SOLE reader of dobby.config.json; a null result = no marker
  // file, so this is not a dobby project — mirror the hooks.json `-f` guard and no-op.
  if (loadConfig(root) === null) {
    return { surface: false };
  }

  // The edited file must live INSIDE the project the hook guards — a payload
  // pointing outside the workroot is never this project's concern (an unguarded
  // biome would happily lint the out-of-tree file and exit 2).
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { surface: false };
  }

  const ext = extname(absolute).slice(1).toLowerCase();
  if (!HOOK_EXTENSIONS.has(ext)) {
    return { surface: false };
  }

  const biomeBin = binFrom(requireFromHere, "@biomejs/biome", "biome");
  if (biomeBin === null) {
    return { surface: false };
  }

  // Config-less default (ADR-0015): a consumer without biome.json/jsonc still gets
  // linted+autofixed via dobby's shipped preset (react vs core, capability-driven);
  // a consumer WITH one keeps native discovery (bare spawn — a total override).
  const biomeCfg = configArgs(root, biomeConfigSpec(detectCapabilities(root)));
  const biome = runBiome(root, [absolute], biomeBin, biomeCfg.args, true);
  if ("error" in biome) {
    // biome could not spawn / emitted no JSON — never block an edit on harness noise.
    return { surface: false };
  }
  return biome.group.findings.length > 0
    ? { groups: [biome.group], surface: true }
    : { surface: false };
}

// Pull `tool_input.file_path` out of the hook's stdin payload, DEFENSIVELY: an
// absent/blank/unparsable payload, or a missing/non-string file_path, all return
// null (the silent-exit-0 signal).
function parseHookFilePath(stdin: string | undefined): string | null {
  if (stdin === undefined || stdin.trim() === "") {
    return null;
  }
  let payload: HookPayload;
  try {
    payload = JSON.parse(stdin) as HookPayload;
  } catch {
    return null;
  }
  const filePath = payload?.tool_input?.file_path;
  return typeof filePath === "string" && filePath !== "" ? filePath : null;
}

// The package ROOT dir for `pkg`, resolved via `req` (dobby's own require, or a
// consumer-anchored one). The `<pkg>/package.json` subpath is preferred, but some
// packages (knip) BLOCK it in their `exports` map — so fall back to resolving the
// package's main entry and walking up to the dir whose package.json `name` matches.
function pkgRootFrom(
  req: ReturnType<typeof createRequire>,
  pkg: string
): string | null {
  try {
    return dirname(req.resolve(`${pkg}/package.json`));
  } catch {
    // Blocked subpath (knip): walk up from the main entry to the package root.
  }
  try {
    let dir = dirname(req.resolve(pkg));
    for (let depth = 0; depth < 12 && dir !== dirname(dir); depth += 1) {
      const manifestPath = join(dir, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: string;
        };
        if (manifest.name === pkg) {
          return dir;
        }
      }
      dir = dirname(dir);
    }
  } catch {
    return null;
  }
  return null;
}

// The absolute path to a tool's JS entry, read from its package.json `bin` field
// (version-robust — no hard-coded path), or null when the package/bin can't be
// found. `req` selects WHOSE node_modules: `requireFromHere` for dobby's bundled
// tools, a consumer-anchored require for the capability-gated vite/vitest bins.
function binFrom(
  req: ReturnType<typeof createRequire>,
  pkg: string,
  binName: string
): string | null {
  const root = pkgRootFrom(req, pkg);
  if (root === null) {
    return null;
  }
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8")
    ) as {
      bin?: string | Record<string, string>;
    };
    const { bin } = manifest;
    const rel = typeof bin === "string" ? bin : bin?.[binName];
    if (rel === undefined) {
      return null;
    }
    return join(root, rel);
  } catch {
    return null;
  }
}

// Resolve a bin from the CONSUMER's node_modules (anchored at the workroot),
// NOT dobby's — vite/vitest must be the consumer's own instance to avoid a
// dual-vite clash with its plugins. Null when the consumer hasn't installed it.
function resolveConsumerBin(
  root: string,
  pkg: string,
  binName: string
): string | null {
  try {
    return binFrom(createRequire(join(root, "package.json")), pkg, binName);
  } catch {
    return null;
  }
}

// Biome's JSON reporter shape (only the fields this parser reads). `location.path`
// is a string in biome 2.x (older builds nested it as `{ file }` — tolerated).
interface BiomeDiagnostic {
  location?: {
    path?: string | { file?: string };
    start?: { line?: number } | null;
  };
  message?: string;
  severity?: string;
}

// Spawn biome (via node/bun) with the JSON reporter and reduce it to findings.
// ONLY error/warning severities count — biome also emits info/hint diagnostics
// (e.g. a config-deprecation notice) that must not fail the gate. `write` adds
// `--write` (SAFE fixes only): the edit-time hook mutates the file in place, then
// the parsed diagnostics are whatever biome could NOT auto-fix. `configArgs`
// carries the config-less default flags (`--config-path=<preset> --vcs-root=…`)
// when the consumer ships no biome config, else empty (bare spawn — native
// discovery of the consumer's file, a total override).
function runBiome(
  root: string,
  paths: string[],
  biomeBin: string,
  cfgArgs: string[],
  write = false
): { group: CheckGroup; result: RunResult } | { error: string } {
  const args = [
    biomeBin,
    "check",
    ...(write ? ["--write"] : []),
    "--reporter=json",
    ...cfgArgs,
    ...paths,
  ];
  const result = runCapture(process.execPath, args, {
    root,
  });
  if (result.error) {
    return { error: `biome could not be spawned: ${result.error.message}` };
  }

  let report: { diagnostics?: BiomeDiagnostic[] };
  try {
    report = JSON.parse(result.stdout) as { diagnostics?: BiomeDiagnostic[] };
  } catch {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    return { error: `biome did not emit JSON output: ${detail}` };
  }

  const findings: Finding[] = [];
  for (const diagnostic of report.diagnostics ?? []) {
    if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") {
      continue;
    }
    findings.push({
      file: relativize(root, biomePath(diagnostic.location?.path)),
      line: diagnostic.location?.start?.line ?? 0,
      message: collapse(diagnostic.message ?? ""),
    });
  }
  return { group: { findings, tool: "biome" }, result };
}

// tsc --pretty false emits one diagnostic per line: `path(line,col): error TSxxxx: message`.
// Continuation lines of multi-line messages simply don't match and are dropped
// (token-lean — the head line carries the file:line the model needs).
const TSC_DIAGNOSTIC = /^(.+?)\((\d+),\d+\):\s+error\s+TS\d+:\s+(.*)$/;

// Spawn tsc (via node/bun) with --noEmit and scan its text diagnostics — TS7 has
// no JSON reporter and no JS API, so text parsing is the only path.
function runTsc(
  root: string,
  tscBin: string
): { group: CheckGroup; result: RunResult } | { error: string } {
  const result = runCapture(
    process.execPath,
    [tscBin, "--noEmit", "--pretty", "false"],
    {
      root,
    }
  );
  if (result.error) {
    return { error: `tsc could not be spawned: ${result.error.message}` };
  }

  const findings: Finding[] = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const match = TSC_DIAGNOSTIC.exec(line.trim());
    if (match === null) {
      continue;
    }
    findings.push({
      file: relativize(root, match[1] ?? ""),
      line: Number(match[2]),
      message: collapse(match[3] ?? ""),
    });
  }
  return { group: { findings, tool: "tsc" }, result };
}

// One knip issue group (JSON reporter): a `file` plus per-category arrays of
// unused items. Only the shape this reducer reads is typed; the rest is ignored.
interface KnipIssue {
  file?: string;
  [category: string]: unknown;
}

// Spawn knip with the JSON reporter and reduce its issues to findings. TOLERANT:
// if knip cannot run (no package.json in a synthetic repo → it errors with
// non-JSON output) the step folds to ZERO findings and does NOT fail the gate —
// a knip that could not run must neither block the gate nor contaminate output.
// Real issues (parseable JSON) DO become findings and fail the gate. `cfgArgs`
// carries `--config <preset>` (the config-less default: knip's vitest plugin
// can't see test globs through a consumer's .mjs re-export, so the default keeps
// test files from being flagged unused) when the consumer ships no knip config,
// else empty (bare — native discovery of knip.json/jsonc/ts or package.json#knip).
function runKnip(
  root: string,
  knipBin: string,
  cfgArgs: string[]
): { group: CheckGroup } {
  const result = runCapture(
    process.execPath,
    [knipBin, "--reporter", "json", ...cfgArgs],
    {
      root,
    }
  );
  if (result.error) {
    return { group: { findings: [], tool: "knip" } };
  }

  let report: { issues?: KnipIssue[] };
  try {
    report = JSON.parse(result.stdout) as { issues?: KnipIssue[] };
  } catch {
    return { group: { findings: [], tool: "knip" } };
  }

  const findings: Finding[] = [];
  for (const issue of report.issues ?? []) {
    const file = typeof issue.file === "string" ? issue.file : "";
    for (const [category, value] of Object.entries(issue)) {
      if (category === "file" || !Array.isArray(value) || value.length === 0) {
        continue;
      }
      for (const item of value) {
        const { label, line } = knipItem(item);
        // The `files` category names an unused FILE (the item IS the path); other
        // categories name an unused symbol/dependency WITHIN `file`.
        findings.push(
          category === "files"
            ? {
                file: relativize(root, label || file),
                line: 0,
                message: "unused file",
              }
            : {
                file: relativize(root, file),
                line,
                message: collapse(`${category}: ${label}`),
              }
        );
      }
    }
  }
  return { group: { findings, tool: "knip" } };
}

// One knip issue item -> its label + line. Items are `{ name, line? }` objects,
// bare strings, or (duplicates/enumMembers) nested arrays — tolerated defensively.
function knipItem(item: unknown): { label: string; line: number } {
  if (typeof item === "string") {
    return { label: item, line: 0 };
  }
  if (Array.isArray(item)) {
    return {
      label: item.map((entry) => knipItem(entry).label).join(", "),
      line: 0,
    };
  }
  if (item && typeof item === "object") {
    const record = item as { name?: unknown; line?: unknown };
    return {
      label: typeof record.name === "string" ? record.name : "",
      line: typeof record.line === "number" ? record.line : 0,
    };
  }
  return { label: "", line: 0 };
}

// Run the capability-gated build step: `vite build` via the CONSUMER's OWN vite
// binary (never dobby's). A clean build is silent (note null); a nonzero exit
// yields a failure note carrying the crashed tool's raw-output tail (build never
// produces parsed findings, so ANY nonzero exit is the findingless-failure case —
// the tail is what makes a vite startup/config crash diagnosable) and propagates
// the exit code. A missing consumer bin (capability present but not installed)
// degrades to a note without failing the gate — `dobby up` is the fix (it runs the
// install), not a gate failure. NOT run in the real-tool suite except via the
// broken-bin fixture; the verifier's live recipe covers the real run path.
// `cfgArgs` carries `--config <preset>` when the consumer ships no vite config
// (config-less default, ADR-0015), else empty (bare — native discovery).
function runBuild(
  root: string,
  cfgArgs: string[]
): { note: CheckNote | null; exitCode: number } {
  const bin = resolveConsumerBin(root, "vite", "vite");
  if (bin === null) {
    return {
      exitCode: 0,
      note: {
        raw: null,
        text: "build: skipped (consumer vite binary not found — run dobby up)",
      },
    };
  }
  const result = runCapture(process.execPath, [bin, "build", ...cfgArgs], {
    root,
  });
  const exitCode = result.error ? 1 : (result.status ?? 1);
  return {
    exitCode,
    note: exitCode === 0 ? null : crashNote("build", exitCode, result),
  };
}

// Run the capability-gated test step: `vitest run --reporter=json` via the
// CONSUMER's OWN vitest binary. Same silent-on-pass / note-on-fail / degrade-on-
// missing-bin contract as runBuild. `cfgArgs` carries `--config <preset>` when the
// consumer ships no vitest config (config-less default, ADR-0015; vitest keeps
// root = cwd, so discovery is unchanged), else empty (bare — native discovery).
// NOT run in tests (fixtures carry no vitest — the real vitest spawn is a documented
// non-CI boundary; its config resolution rides the same configArgs seam biome/knip
// assert).
//
// The vitest step runs under NODE when a usable node is on the machine, falling
// back to the CURRENT runtime (`process.execPath`) otherwise. Rationale: under
// `bunx dobby`, `process.execPath` is BUN, and vitest-under-bun's module runner
// mis-resolves some deps' dual export maps (field bug: zod v4's `z.enum` →
// undefined, 65/202 spurious failures), making the gate non-deterministic by
// invocation. node is a SYSTEM tool — spawned BARE, never resolveBin'd (the
// resolver invariant) — via a cheap `node --version` probe. When the fallback
// runtime is used and vitest fails, the note names the runtime so a bun-runtime
// failure is diagnosable rather than looking like a genuine test failure.
function runTest(
  root: string,
  cfgArgs: string[]
): { note: CheckNote | null; exitCode: number; spawned: boolean } {
  const bin = resolveConsumerBin(root, "vitest", "vitest");
  if (bin === null) {
    // The consumer bin is not installed: the step degrades WITHOUT spawning
    // vitest. `spawned: false` tells the caller no run happened — so the A2
    // hermeticity advisory (which reasons about an ACTUAL run's inherited env)
    // stays silent on this path (F2).
    return {
      exitCode: 0,
      note: {
        raw: null,
        text: "test: skipped (consumer vitest binary not found — run dobby up)",
      },
      spawned: false,
    };
  }
  const { runtime, isNode } = resolveTestRuntime(root);
  const result = runCapture(
    runtime,
    [bin, "run", "--reporter=json", ...cfgArgs],
    {
      root,
    }
  );
  const exitCode = result.error ? 1 : (result.status ?? 1);
  if (exitCode === 0) {
    return { exitCode, note: null, spawned: true };
  }
  // A1: on a nonzero exit, PARSE vitest's --reporter=json stdout into a REAL
  // failure summary — one line per failed test FILE (its message + the first
  // in-repo stack frame) under a `test: N suite(s) failed` header. The old code
  // dumped a raw TAIL of the JSON, but a suite that fails to LOAD (import-time
  // error, 0 tests) appears EARLY in the report, so the tail truncated it out
  // behind a wall of passing tests (the field bug); the parsed summary names it
  // directly and stays token-lean.
  const failures = parseVitestFailures(result.stdout, root);
  if (failures !== null) {
    return {
      exitCode,
      note: { raw: null, text: vitestSummary(failures, isNode, runtime) },
      spawned: true,
    };
  }
  // The RAW TAIL survives ONLY for the true findingless crash: JSON that can't be
  // parsed at all (or carried no failed suite) — vitest died before it could
  // report. Name the fallback runtime (no node found) so a bun-runtime failure
  // (e.g. a mis-resolved dual export map) is distinguishable from a real one.
  const text = isNode
    ? `test: failed (exit ${exitCode})`
    : `test: failed (exit ${exitCode}) — ran under ${runtime} (no node found; vitest under this runtime can mis-resolve some deps)`;
  return {
    exitCode,
    note: { raw: rawOutputTail(result), text },
    spawned: true,
  };
}

// Pick the runtime for the vitest step: prefer NODE (a cheap `node --version`
// probe — node stays BARE, a system tool, never resolveBin'd), falling back to
// the current runtime (`process.execPath`). Probed once per check run (runTest
// runs at most once). Returns the spawnable runtime plus whether node was chosen,
// so the failure path can annotate a non-node run.
function resolveTestRuntime(root: string): {
  runtime: string;
  isNode: boolean;
} {
  const probe = runCapture("node", ["--version"], { root });
  if (!(probe.error || probe.status !== 0)) {
    return { isNode: true, runtime: "node" };
  }
  return { isNode: false, runtime: process.execPath };
}

// A dotenv assignment line's KEY: a leading `export` is tolerated, then the
// standard env-name shape (`[A-Za-z_][A-Za-z0-9_]*`) up to the `=`. ONLY the key
// name is captured — the value is never read, so no secret is parsed, compared, or
// logged. Blank/comment/malformed lines simply don't match.
const ENV_KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// The cap on missing-key names listed inline before collapsing to `…N more`.
const ENV_KEY_LIST_CAP = 6;

// The set of KEY names declared in a dotenv-style file (values deliberately
// ignored). A read failure folds to an empty set — never a throw.
function envFileKeys(path: string): Set<string> {
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return keys;
  }
  for (const line of raw.split("\n")) {
    const match = ENV_KEY_LINE.exec(line);
    if (match?.[1] !== undefined) {
      keys.add(match[1]);
    }
  }
  return keys;
}

// The advisory hermeticity note (A2): the vitest step inherits the workroot's
// `.env.local`, which CI does NOT have — so a suite that validates env at IMPORT
// time can load locally (dev creds) yet crash in CI (no env). Two shapes:
//   - `.env.local` present, NO `.env.test` → the inherits note (nothing hermetic).
//   - BOTH present → compare KEY SETS only, never values (F1): an INCOMPLETE
//     `.env.test` (keys present in `.env.local` but absent in `.env.test`) still
//     sources those keys from `.env.local` — which CI lacks — so name them (capped
//     at ~6, then `…N more`). A complete superset is genuinely hermetic → silent.
// Null when there is no `.env.local` at all, or `.env.test` covers every key.
function hermeticityNote(root: string): string | null {
  const localPath = join(root, ".env.local");
  if (!existsSync(localPath)) {
    return null;
  }
  const testPath = join(root, ".env.test");
  if (!existsSync(testPath)) {
    return "test: vitest inherits .env.local (absent in CI) — commit a placeholder .env.test for hermetic runs";
  }
  const testKeys = envFileKeys(testPath);
  const missing = [...envFileKeys(localPath)].filter(
    (key) => !testKeys.has(key)
  );
  if (missing.length === 0) {
    return null;
  }
  const shown = missing.slice(0, ENV_KEY_LIST_CAP);
  const overflow = missing.length - shown.length;
  const list =
    overflow > 0 ? `${shown.join(", ")}, …${overflow} more` : shown.join(", ");
  return `test: .env.test is missing ${missing.length} key(s) present in .env.local: ${list} — CI runs without them`;
}

// The per-file cap on the vitest failure summary: enough failed suites to orient,
// bounded so a wholesale failure stays token-lean. Overflow collapses to `…N more`.
const VITEST_FILE_CAP = 10;

// One parsed vitest failure: the failed test FILE (repo-relative), a one-line
// summary (its first failure message / load error), and the first in-repo stack
// frame as `file:line` (null when the message carried no in-repo frame).
interface VitestFailure {
  file: string;
  frame: string | null;
  summary: string;
}

// The vitest --reporter=json shape (Jest-compatible), only the fields this parser
// reads. `testResults[]` = one entry per test FILE; a file-level LOAD failure sets
// `status: "failed"` with an EMPTY `assertionResults` and a `message`, while an
// individual test failure lands in `assertionResults[].failureMessages`.
interface VitestReport {
  testResults?: VitestFileResult[];
}
interface VitestFileResult {
  assertionResults?: { status?: string; failureMessages?: string[] }[];
  message?: string;
  name?: string;
  status?: string;
}

// Render the parsed vitest failures (A1) as a multi-line note: the `test: N
// suite(s) failed — <first file>` header (naming the fallback runtime when node was
// absent), then one capped line per failed file, then a `…N more` tail. Rendered as
// a single note block (run.ts prints `note.text` verbatim when `raw` is null).
function vitestSummary(
  failures: VitestFailure[],
  isNode: boolean,
  runtime: string
): string {
  const firstFile = failures[0]?.file ?? "unknown";
  const runtimeHint = isNode
    ? ""
    : ` — ran under ${runtime} (no node found; vitest under this runtime can mis-resolve some deps)`;
  const header = `test: ${failures.length} suite(s) failed — ${firstFile}${runtimeHint}`;
  const shown = failures.slice(0, VITEST_FILE_CAP);
  const lines = shown.map((failure) => {
    const frame = failure.frame === null ? "" : ` (${failure.frame})`;
    return `  ${failure.file} — ${failure.summary}${frame}`;
  });
  const overflow = failures.length - shown.length;
  if (overflow > 0) {
    lines.push(`  …${overflow} more`);
  }
  return [header, ...lines].join("\n");
}

// Parse vitest's --reporter=json stdout into per-file failures (A1). Returns null
// when the JSON can't be parsed OR carries no failed suite — the caller then falls
// back to the raw-output tail (the true findingless crash: vitest died before it
// could report). Covers BOTH failure shapes: a file-level load error (the `message`)
// and individual failed tests (the first `failureMessages`).
//
// PURE and PRIVATE — reached only through the vitest step. Exercised in CI via a
// STUB vitest bin (a fake `node_modules/vitest` that exits nonzero writing
// hand-written reporter JSON), never a real vitest run, so the parser is covered
// without the forbidden real spawn — the same stub-bin seam the hermeticity tests
// use to make the step actually run.
function parseVitestFailures(
  stdout: string,
  root: string
): VitestFailure[] | null {
  let report: VitestReport;
  try {
    report = JSON.parse(stdout) as VitestReport;
  } catch {
    return null;
  }
  if (!Array.isArray(report.testResults)) {
    return null;
  }
  const failures: VitestFailure[] = [];
  for (const file of report.testResults) {
    if (file.status !== "failed") {
      continue;
    }
    const rawName = typeof file.name === "string" ? file.name : "";
    const relFile = rawName === "" ? "<unknown>" : relativize(root, rawName);
    const assertions = Array.isArray(file.assertionResults)
      ? file.assertionResults
      : [];
    const failed = assertions.find(
      (assertion) =>
        assertion.status === "failed" &&
        Array.isArray(assertion.failureMessages) &&
        assertion.failureMessages.length > 0
    );
    const detail = stripAnsi(
      failed?.failureMessages?.[0] ??
        (typeof file.message === "string" ? file.message : "")
    );
    failures.push({
      file: relFile,
      frame: firstInRepoFrame(detail, root),
      summary: firstLine(detail) || "test failed",
    });
  }
  return failures.length > 0 ? failures : null;
}

// The first non-blank line of a message, whitespace-collapsed (token-lean — one
// line per failure).
function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? "" : collapse(line);
}

// A `path:line:col` stack-frame token. The path excludes whitespace/parens/colon,
// so a unix path qualifies (a Windows drive-letter colon is out of scope for CI).
const FRAME_TOKEN = /([^\s():]+):(\d+):\d+/g;

// The first stack frame in `text` pointing INSIDE the repo (a real file under the
// workroot, not node_modules / node internals), rendered `file:line`. Requires a
// `/` in the path (so bare `word:1:2` noise never matches) and that the file EXISTS
// (filtering node internals + non-path noise). Null when no in-repo frame is found.
function firstInRepoFrame(text: string, root: string): string | null {
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(FRAME_TOKEN)) {
      const [, rawPath, rawLine] = match;
      if (
        rawPath === undefined ||
        rawLine === undefined ||
        !rawPath.includes("/") ||
        rawPath.includes("node_modules")
      ) {
        continue;
      }
      const absolute = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
      const rel = relative(root, absolute);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        continue;
      }
      if (!existsSync(absolute)) {
        continue;
      }
      return `${rel}:${rawLine}`;
    }
  }
  return null;
}

// Strip ANSI SGR escapes (vitest colorizes error diffs even under --reporter=json).
// Built from the ESC char code so no control character sits literally in source.
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

// Run one config `checks[]` extra as a shell command, cwd pinned to the workroot
// (the runner invariant). Returns the child's exit code (1 when it could not be
// spawned at all). Captured — the gate reports a concise failure note, not a dump.
function runExtra(root: string, command: string): number {
  const result = runCapture("sh", ["-c", command], { root });
  if (result.error) {
    return 1;
  }
  return result.status ?? 1;
}

// The file path from a biome diagnostic location (string form, or the legacy
// `{ file }` object form).
function biomePath(path: string | { file?: string } | undefined): string {
  if (typeof path === "string") {
    return path;
  }
  if (path && typeof path.file === "string") {
    return path.file;
  }
  return "";
}

// A tool-reported path (absolute or relative to the pinned cwd) made relative to
// the workroot for token-lean output.
function relativize(root: string, path: string): string {
  if (path === "") {
    return path;
  }
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  return rel === "" ? path : rel;
}

// Flatten any whitespace run (incl. newlines) to a single space so every finding
// stays one line.
function collapse(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}
