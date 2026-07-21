import { parseArgs } from "node:util";
import pkg from "../package.json";
import { type CheckGroup, check, checkHook } from "./check.ts";
import { detectCapabilities } from "./detect.ts";
import { collectEnv, type EnvSnapshot } from "./envinfo.ts";
import {
	type DownAction,
	type DownPlan,
	planDev,
	type ResolvedDevCommand,
	type ResolvedDevPlan,
	runDbTask,
	runDown,
	runUp,
	runUpdate,
	type SetupAction,
	type UpAction,
	type UpPlan,
} from "./lifecycle.ts";
import { type CheckFlags, type DbCommand, usageCommands } from "./tasks.ts";

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

// The exact upgrade-hint line appended as the second line of an unknown-command
// error: a version-skew signal telling the caller their dobby is behind the kit.
const upgradeHint =
	"if this command is expected, run `bun update @kvnwolf/dobby`";

// The Options block — STATIC (a flags reference; it documents every flag and does
// not vary per repo). The Commands block above it IS capability-filtered, so the
// help never advertises a command that does not apply to the current repo.
const OPTION_LINES = [
	"  --json          Print machine-readable JSON (env)",
	"  --lint          check: run only biome",
	"  --types         check: run only tsc",
	"  --unused        check: run only knip",
	"  --build         check: run only the build step",
	"  --test          check: run only the test step",
	"  --fix           check: apply biome's safe fixes first, then report what remains",
	"  --hook          check: edit-time PostToolUse mode (payload on stdin)",
	"  --dry-run       dev / db:* / up / down: print the resolved action plan without executing it",
	"  -v, --version   Print the dobby version and exit",
];

// The usage/help text, COMPUTED per repo from the detected capabilities. The first
// line begins "Usage: dobby" (asserted by the contract); the Commands block lists
// ONLY the applicable commands (`usageCommands`, filtered) — the fix for the field
// report where the static help advertised dev/up/down/db:* in repos with neither a
// vite nor a db capability. All rendering (column alignment, headers) lives HERE;
// `tasks.ts` returns the filtered command data.
function buildUsage(capabilities: string[]): string {
	const commands = usageCommands(capabilities);
	const width = Math.max(...commands.map((c) => c.name.length));
	const commandLines = commands.map(
		(c) => `  ${c.name.padEnd(width)}  ${c.description}`,
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

export async function run(
	argv: string[],
	cwd: string,
	stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// The usage/help text is capability-filtered per repo (the SAME detection env's
	// `capabilities:` line uses — over the PASSED cwd, never a workroot resolve), so
	// every path that prints usage (bare, parse error, unknown command) advertises
	// only the commands that apply here.
	const usage = buildUsage(detectCapabilities(cwd));

	let positionals: string[];
	let version: boolean | undefined;
	let json: boolean | undefined;
	let hook: boolean | undefined;
	let fix: boolean | undefined;
	let dryRun: boolean | undefined;
	// The selective `check` flags: any present => run ONLY the flagged steps.
	let checkFlags: CheckFlags = {};

	try {
		const parsed = parseArgs({
			args: argv,
			options: {
				version: { type: "boolean", short: "v" },
				json: { type: "boolean" },
				lint: { type: "boolean" },
				types: { type: "boolean" },
				unused: { type: "boolean" },
				build: { type: "boolean" },
				test: { type: "boolean" },
				fix: { type: "boolean" },
				hook: { type: "boolean" },
				"dry-run": { type: "boolean" },
			},
			allowPositionals: true,
			strict: true,
		});
		positionals = parsed.positionals;
		version = parsed.values.version;
		json = parsed.values.json;
		hook = parsed.values.hook;
		fix = parsed.values.fix;
		dryRun = parsed.values["dry-run"];
		checkFlags = {
			lint: parsed.values.lint,
			types: parsed.values.types,
			unused: parsed.values.unused,
			build: parsed.values.build,
			test: parsed.values.test,
		};
	} catch (error) {
		// parseArgs (strict) throws a TypeError on unknown/malformed flags. Emit the
		// parse error message BEFORE the usage — the order is part of the contract.
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: 1, stdout: "", stderr: `${message}\n\n${usage}` };
	}

	if (version) {
		return { exitCode: 0, stdout: `${pkg.version}\n`, stderr: "" };
	}

	const command = positionals[0];

	if (command === undefined) {
		return { exitCode: 0, stdout: usage, stderr: "" };
	}

	if (command === "env") {
		// env NEVER fails: collectEnv degrades every unresolvable fact to null/false/[]
		// and formatting cannot throw, so the exit code is always 0.
		const snapshot = collectEnv(cwd);
		const stdout = json ? formatEnvJson(snapshot) : formatEnvText(snapshot);
		return { exitCode: 0, stdout, stderr: "" };
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
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return {
				exitCode: 2,
				stdout: "",
				stderr: formatCheck(outcome.groups, []),
			};
		}
		// Positionals after "check" are file args (per-file fast path); none = the
		// project-wide gate (subset by the selective flags). `--fix` applies biome's
		// SAFE fixes first (project-wide, or over the named files) so the pre-commit
		// gate never fails on formatting the edit hook did not reach, THEN reports what
		// remains. A hard error (not a git repo / a bundled tool missing) reports on
		// stderr with exit 1; otherwise the report's aggregated exit code (first failing
		// step, 0 if all passed) is used.
		const report = check(positionals.slice(1), cwd, checkFlags, Boolean(fix));
		if (!report.ok) {
			return { exitCode: 1, stdout: "", stderr: `${report.error}\n` };
		}
		return {
			exitCode: report.exitCode,
			stdout: formatCheck(report.groups, report.notes),
			stderr: "",
		};
	}

	if (command === "dev") {
		// The dev PLAN — the `--dry-run` capture output — plus the no-app gate. A LIVE
		// dev (a managed group of the portless-wrapped main + concurrent secondaries
		// with signal forwarding) is owned by the bin's STREAMING path: index.ts
		// intercepts `dobby dev` before run() is reached, so run() only ever PLANS and
		// never spawns a dev server (a would-be-live dev reaching here still just prints
		// the plan). No app (no vite) is a hard error: exit 1 with 'nothing to run'.
		const report = planDev(cwd);
		if (!report.ok) {
			return { exitCode: 1, stdout: "", stderr: `${report.error}\n` };
		}
		return { exitCode: 0, stdout: formatDevPlan(report.plan), stderr: "" };
	}

	if (command === "up") {
		// Bring the app up (liveness-first, idempotent). Fails hard outside a git repo;
		// the no-app gate (no vite) is a graceful exit-0 no-op; a neon project with
		// missing creds fails hard (no main-DB fallback). `--dry-run` renders the
		// decision-derived plan without probing / spawning / touching cmux or neon; a
		// real run executes it and reports the outcome (streamed stdio, so no stdout).
		const report = runUp(cwd, { dryRun: Boolean(dryRun) });
		if (!report.ok) {
			return { exitCode: 1, stdout: "", stderr: `${report.error}\n` };
		}
		if (report.kind === "noop") {
			return { exitCode: 0, stdout: `${report.message}\n`, stderr: "" };
		}
		if (report.kind === "plan") {
			return { exitCode: 0, stdout: formatUpPlan(report.plan), stderr: "" };
		}
		return {
			exitCode: report.exitCode,
			stdout: "",
			stderr: report.failure === null ? "" : `${report.failure}\n`,
		};
	}

	if (command === "down") {
		// Tear the run down (close panes, kill the detached run, delete the neon
		// branch, teardown[] extras). Fails hard outside a git repo; nothing to clean →
		// exit 0 no-op. `--dry-run` renders the plan without executing.
		const report = runDown(cwd, { dryRun: Boolean(dryRun) });
		if (!report.ok) {
			return { exitCode: 1, stdout: "", stderr: `${report.error}\n` };
		}
		if (report.kind === "plan") {
			return { exitCode: 0, stdout: formatDownPlan(report.plan), stderr: "" };
		}
		return {
			exitCode: report.exitCode,
			stdout: "",
			stderr: report.failure === null ? "" : `${report.failure}\n`,
		};
	}

	if (command.startsWith("db:")) {
		// Inferred db task: the command name resolves through the capability-driven
		// db:* map (drizzle is the one db tool, so the short db:* names map to
		// drizzle-kit). An unknown name is a hard error (exit 1) whose message already
		// lists what IS available. `--dry-run` prints the resolved command without spawning.
		const report = runDbTask(command, cwd, { dryRun: Boolean(dryRun) });
		if (!report.ok) {
			return { exitCode: 1, stdout: "", stderr: `${report.error}\n` };
		}
		if (report.kind === "plan") {
			return {
				exitCode: 0,
				stdout: formatDbPlan(report.bin, report.command, report.cwd),
				stderr: "",
			};
		}
		// A real run inherited stdio (output streamed straight to the terminal); only
		// the exit code and an optional failure note come back as data.
		return {
			exitCode: report.exitCode,
			stdout: "",
			stderr: report.failure === null ? "" : `${report.failure}\n`,
		};
	}

	if (command === "update") {
		// Interactive dependency update (taze). Inherits stdio — the picker streams to
		// the user and terminates with them — so only the exit code is captured here.
		const report = runUpdate(cwd);
		if (!report.ok) {
			return { exitCode: 1, stdout: "", stderr: `${report.error}\n` };
		}
		return { exitCode: report.exitCode, stdout: "", stderr: "" };
	}

	return {
		exitCode: 1,
		stdout: "",
		stderr: `unknown command: ${command}\n${upgradeHint}\n\n${usage}`,
	};
}

// Render the env snapshot as `key: value` lines (the default form). Scalars
// print their value or the literal "null"; capabilities print as a
// comma-separated list or the literal "none"; config prints "true"/"false".
function formatEnvText(snapshot: EnvSnapshot): string {
	const capabilities =
		snapshot.capabilities.length === 0
			? "none"
			: snapshot.capabilities.join(", ");
	return [
		`cmux: ${scalar(snapshot.cmux)}`,
		`worktree: ${scalar(snapshot.worktree)}`,
		`branch: ${scalar(snapshot.branch)}`,
		`capabilities: ${capabilities}`,
		`config: ${snapshot.config}`,
		`devUrl: ${scalar(snapshot.devUrl)}`,
		`runPane: ${scalar(snapshot.runPane)}`,
		`browserPane: ${scalar(snapshot.browserPane)}`,
	]
		.join("\n")
		.concat("\n");
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
		case "copy":
			return `copy ${action.rel} (from main checkout)`;
		case "extra":
			return `run: ${action.run}`;
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
			`  ${plan.main.portless} run ${renderResolvedCommand(plan.main.command)}`,
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

// The placeholder surface refs the `up` plan renders where a real run would capture
// a runtime cmux surface ref — the split targets the browser surface by ref (never
// by focus), so the plan spells the dependency out even though the ref is unknown
// until the pane is created.
const BROWSER_SURFACE = "<browser-surface>";
const RUN_SURFACE = "<run-surface>";

// Render the FULL `up` plan for `--dry-run`: the SETUP PHASE first (install → copies
// → extras, mirroring the folded former setup plan), THEN the cmux WORKSPACE rename
// (when under cmux — independent of the app gate), THEN the run phase in execution
// order (probe → neon branch → cmux panes XOR detached run → liveness wait), OR — when
// the run phase is skipped — the skip reason line ('no app to run'). The cmux pane
// block renders the exact positional layout (browser `--direction right`, run terminal
// `new-split down` targeted by `--surface`).
function formatUpPlan(plan: UpPlan): string {
	const lines: string[] = [];
	for (const action of plan.setup) {
		lines.push(`  ${describeSetupAction(action)}`);
	}
	if (plan.renameWorkspace !== null) {
		lines.push(
			`  cmux rename-workspace --workspace ${plan.renameWorkspace.workspace} "${plan.renameWorkspace.title}"`,
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
		case "cmux-panes": {
			const url = action.devUrl === null ? "" : ` --url ${action.devUrl}`;
			return [
				`cmux new-pane --workspace ${action.workspace} --type browser${url} --direction right`,
				`cmux rename-tab --surface ${BROWSER_SURFACE} "${action.browserName}"`,
				`cmux new-split down --surface ${BROWSER_SURFACE}`,
				`cmux rename-tab --surface ${RUN_SURFACE} "${action.runName}"`,
				`cmux send --surface ${RUN_SURFACE} "${action.sendLine}"`,
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
	}
}

// The per-tool cap on printed findings: the model needs a representative sample,
// not an exhaustive dump. Overflow collapses to a `…N more` tail per tool.
const FINDING_CAP = 50;

// Render a check run as token-lean text: one `file:line message` line per
// finding, grouped and labelled per tool, each group capped — then the step
// notes (capability skips, build/test/extra failures), each its OWN single line
// (so a skip note is scannable as one line). An empty run (no findings, no notes)
// prints a single "No findings." line.
function formatCheck(groups: CheckGroup[], notes: string[]): string {
	const blocks: string[] = [];
	for (const group of groups) {
		if (group.findings.length === 0) {
			continue;
		}
		const lines = [`${group.tool} (${group.findings.length}):`];
		const shown = group.findings.slice(0, FINDING_CAP);
		for (const finding of shown) {
			lines.push(
				`  ${finding.file}:${finding.line} ${finding.message}`.trimEnd(),
			);
		}
		const overflow = group.findings.length - shown.length;
		if (overflow > 0) {
			lines.push(`  …${overflow} more`);
		}
		blocks.push(lines.join("\n"));
	}
	for (const note of notes) {
		blocks.push(note);
	}
	return blocks.length === 0 ? "No findings.\n" : `${blocks.join("\n\n")}\n`;
}
