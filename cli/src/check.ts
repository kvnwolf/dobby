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
import { detectCapabilities } from "./detect.ts";
import { resolveWorkroot, runCapture } from "./runner.ts";
import { type CheckFlags, checkPipeline } from "./tasks.ts";

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
	tool: string;
	findings: Finding[];
}

// The outcome of a check run:
//   - { ok: true, groups, notes, exitCode } — the pipeline ran. `groups` carries
//     the findings tools' output (possibly empty), `notes` the single-line step
//     notes (capability skips, build/test/extra failures), and `exitCode` the
//     aggregated FIRST failing exit code (0 = all selected steps passed). run.ts
//     prints groups + notes and exits with `exitCode`.
//   - { ok: false, error } — a HARD error (not a git repo, or a BUNDLED tool
//     could not be resolved/spawned): surfaced on stderr with a nonzero exit.
type CheckReport =
	| { ok: true; groups: CheckGroup[]; notes: string[]; exitCode: number }
	| { ok: false; error: string };

// Run the quality gate. `files` empty = project-wide (the composed pipeline);
// non-empty = per-file fast path (biome only). `flags` subset the project-wide
// pipeline (ignored on the per-file path). `fix` applies biome's SAFE fixes in
// place FIRST (project-wide `biome check --write .`, or over the named files) so
// the pre-commit gate never fails on formatting the edit hook did not reach — then
// the selected pipeline runs and reports whatever biome could NOT safely fix (the
// UNSAFE rewrites, e.g. `==`→`===`, are never applied). `cwd` is the caller's
// directory; the workroot is resolved from it and pinned as every child's cwd.
export function check(
	files: string[],
	cwd: string,
	flags: CheckFlags,
	fix = false,
): CheckReport {
	const root = resolveWorkroot(cwd);
	if (root === null) {
		return {
			ok: false,
			error:
				"dobby check must run inside a git repository — no git worktree found",
		};
	}

	const biomeBin = binFrom(requireFromHere, "@biomejs/biome", "biome");
	if (biomeBin === null) {
		return {
			ok: false,
			error: "could not resolve the bundled biome binary from dobby",
		};
	}

	// Per-file fast path: biome ONLY over the named files (resolved against the
	// CALLER's cwd so a relative arg from a subdirectory still points at the right
	// file). No pipeline, no tsc/knip/build/test, no extras — the edit-adjacent
	// quick check where a whole-project gate would defeat the point. With `--fix`,
	// biome's SAFE fixes are written to just those files (`--write`) and the
	// remaining findings are reported.
	if (files.length > 0) {
		const biome = runBiome(
			root,
			files.map((file) => resolve(cwd, file)),
			biomeBin,
			fix,
		);
		if ("error" in biome) {
			return { ok: false, error: biome.error };
		}
		const exitCode = biome.group.findings.length > 0 ? 1 : 0;
		return { ok: true, groups: [biome.group], notes: [], exitCode };
	}

	// Project-wide `--fix`: apply biome's SAFE fixes across the WHOLE tree FIRST
	// (`biome check --write .`), independent of the pipeline's own biome step — so
	// `--fix --types` still formats before the tsc-only report, and the fix reaches
	// the config files too, not just `src/`. The result is discarded here; whatever
	// biome could not safely fix is surfaced by the pipeline's biome step below.
	if (fix) {
		const fixed = runBiome(root, ["."], biomeBin, true);
		if ("error" in fixed) {
			return { ok: false, error: fixed.error };
		}
	}

	// Project-wide: infer the plan from capabilities + config + flags, then run it.
	const capabilities = detectCapabilities(root);
	const configLoad = loadConfig(root);
	const config = configLoad?.ok ? configLoad.config : null;
	const plan = checkPipeline(capabilities, config, flags);

	const groups: CheckGroup[] = [];
	const notes: string[] = [];
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
				const biome = runBiome(root, ["."], biomeBin);
				if ("error" in biome) {
					return { ok: false, error: biome.error };
				}
				groups.push(biome.group);
				if (biome.group.findings.length > 0) {
					fail(1);
				}
				break;
			}
			case "tsc": {
				const tscBin = binFrom(requireFromHere, "typescript", "tsc");
				if (tscBin === null) {
					return {
						ok: false,
						error: "could not resolve the bundled tsc binary from dobby",
					};
				}
				const tsc = runTsc(root, tscBin);
				if ("error" in tsc) {
					return { ok: false, error: tsc.error };
				}
				groups.push(tsc.group);
				if (tsc.group.findings.length > 0) {
					fail(1);
				}
				break;
			}
			case "knip": {
				const knipBin = binFrom(requireFromHere, "knip", "knip");
				if (knipBin === null) {
					return {
						ok: false,
						error: "could not resolve the bundled knip binary from dobby",
					};
				}
				const knip = runKnip(root, knipBin);
				groups.push(knip.group);
				if (knip.group.findings.length > 0) {
					fail(1);
				}
				break;
			}
			case "build": {
				if (step.skipNote !== null) {
					notes.push(step.skipNote);
					break;
				}
				const built = runBuild(root);
				if (built.note !== null) {
					notes.push(built.note);
				}
				fail(built.exitCode);
				break;
			}
			case "test": {
				if (step.skipNote !== null) {
					notes.push(step.skipNote);
					break;
				}
				const tested = runTest(root);
				if (tested.note !== null) {
					notes.push(tested.note);
				}
				fail(tested.exitCode);
				break;
			}
			case "extra": {
				if (extrasStopped) {
					break;
				}
				const code = runExtra(root, step.run);
				if (code !== 0) {
					notes.push(`check '${step.name}' failed (exit ${code})`);
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

	return { ok: true, groups, notes, exitCode };
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

	const biome = runBiome(root, [absolute], biomeBin, true);
	if ("error" in biome) {
		// biome could not spawn / emitted no JSON — never block an edit on harness noise.
		return { surface: false };
	}
	return biome.group.findings.length > 0
		? { surface: true, groups: [biome.group] }
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
	pkg: string,
): string | null {
	try {
		return dirname(req.resolve(`${pkg}/package.json`));
	} catch {
		// Blocked subpath (knip): walk up from the main entry to the package root.
	}
	try {
		let dir = dirname(req.resolve(pkg));
		for (let depth = 0; depth < 12 && dir !== dirname(dir); depth++) {
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
	binName: string,
): string | null {
	const root = pkgRootFrom(req, pkg);
	if (root === null) {
		return null;
	}
	try {
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as {
			bin?: string | Record<string, string>;
		};
		const bin = manifest.bin;
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
	binName: string,
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
	severity?: string;
	message?: string;
	location?: {
		path?: string | { file?: string };
		start?: { line?: number } | null;
	};
}

// Spawn biome (via node/bun) with the JSON reporter and reduce it to findings.
// ONLY error/warning severities count — biome also emits info/hint diagnostics
// (e.g. a config-deprecation notice) that must not fail the gate. `write` adds
// `--write` (SAFE fixes only): the edit-time hook mutates the file in place, then
// the parsed diagnostics are whatever biome could NOT auto-fix.
function runBiome(
	root: string,
	paths: string[],
	biomeBin: string,
	write = false,
): { group: CheckGroup } | { error: string } {
	const args = write
		? [biomeBin, "check", "--write", "--reporter=json", ...paths]
		: [biomeBin, "check", "--reporter=json", ...paths];
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
	return { group: { tool: "biome", findings } };
}

// tsc --pretty false emits one diagnostic per line: `path(line,col): error TSxxxx: message`.
// Continuation lines of multi-line messages simply don't match and are dropped
// (token-lean — the head line carries the file:line the model needs).
const TSC_DIAGNOSTIC = /^(.+?)\((\d+),\d+\):\s+error\s+TS\d+:\s+(.*)$/;

// Spawn tsc (via node/bun) with --noEmit and scan its text diagnostics — TS7 has
// no JSON reporter and no JS API, so text parsing is the only path.
function runTsc(
	root: string,
	tscBin: string,
): { group: CheckGroup } | { error: string } {
	const result = runCapture(
		process.execPath,
		[tscBin, "--noEmit", "--pretty", "false"],
		{
			root,
		},
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
	return { group: { tool: "tsc", findings } };
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
// Real issues (parseable JSON) DO become findings and fail the gate.
function runKnip(root: string, knipBin: string): { group: CheckGroup } {
	const result = runCapture(process.execPath, [knipBin, "--reporter", "json"], {
		root,
	});
	if (result.error) {
		return { group: { tool: "knip", findings: [] } };
	}

	let report: { issues?: KnipIssue[] };
	try {
		report = JSON.parse(result.stdout) as { issues?: KnipIssue[] };
	} catch {
		return { group: { tool: "knip", findings: [] } };
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
							},
				);
			}
		}
	}
	return { group: { tool: "knip", findings } };
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
// yields a concise note and propagates the exit code. A missing consumer bin
// (capability present but not installed) degrades to a note without failing the
// gate — `dobby up` is the fix (it runs the install), not a gate failure. NOT run
// in tests (the fixtures carry no vite); the verifier's live recipe covers the run path.
function runBuild(root: string): { note: string | null; exitCode: number } {
	const bin = resolveConsumerBin(root, "vite", "vite");
	if (bin === null) {
		return {
			note: "build: skipped (consumer vite binary not found — run dobby up)",
			exitCode: 0,
		};
	}
	const result = runCapture(process.execPath, [bin, "build"], { root });
	const exitCode = result.error ? 1 : (result.status ?? 1);
	return {
		note: exitCode === 0 ? null : `build: failed (exit ${exitCode})`,
		exitCode,
	};
}

// Run the capability-gated test step: `vitest run --reporter=json` via the
// CONSUMER's OWN vitest binary. Same silent-on-pass / note-on-fail / degrade-on-
// missing-bin contract as runBuild. NOT run in tests (fixtures carry no vitest).
function runTest(root: string): { note: string | null; exitCode: number } {
	const bin = resolveConsumerBin(root, "vitest", "vitest");
	if (bin === null) {
		return {
			note: "test: skipped (consumer vitest binary not found — run dobby up)",
			exitCode: 0,
		};
	}
	const result = runCapture(process.execPath, [bin, "run", "--reporter=json"], {
		root,
	});
	const exitCode = result.error ? 1 : (result.status ?? 1);
	return {
		note: exitCode === 0 ? null : `test: failed (exit ${exitCode})`,
		exitCode,
	};
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
