import type { DobbyConfig } from "./config.ts";

// Pure task inference. Given the detected capabilities, the loaded config, and
// the selective flags, `checkPipeline` returns the ORDERED step plan for
// `dobby check`. It is the most-tested module BECAUSE it is pure: NO spawning,
// NO filesystem, NO process — just data in, plan out. `check.ts` executes the
// plan this returns (running the tools, reducing findings); nothing here shells
// out. node:*-free entirely (no imports but the config type), so vitest and Bun
// both load it identically.

// The selective flags that subset the pipeline. When ANY flag is present, the
// gate runs ONLY the flagged steps (and config `checks[]` extras are excluded);
// with NO flag it runs the full gate plus the extras.
export interface CheckFlags {
	lint?: boolean;
	types?: boolean;
	unused?: boolean;
	build?: boolean;
	test?: boolean;
}

// One step of the check pipeline, discriminated by `kind`:
//   - biome / tsc / knip — the always-available findings tools (bundled in dobby).
//   - build / test       — capability-gated. `skipNote` is null when the gating
//     capability (vite / vitest) is present (the step will run via the CONSUMER's
//     own bin); non-null when it is absent — the single line naming why the step
//     was skipped, which `check.ts` prints verbatim. A skip is NOT a failure.
//   - extra              — a config `checks[]` shell command, run last (full gate
//     only), fail-fast among themselves.
export type CheckStep =
	| { kind: "biome" }
	| { kind: "tsc" }
	| { kind: "knip" }
	| { kind: "build"; skipNote: string | null }
	| { kind: "test"; skipNote: string | null }
	| { kind: "extra"; name: string; run: string };

// The full-gate order (no flags): biome, tsc, knip, then the capability-gated
// build + test, then config `checks[]` extras. Selective flags pick a SUBSET of
// the tool steps in this same order and drop the extras.
//
// Capability gating is decided HERE (pure): `build` needs the `vite` capability,
// `test` needs `vitest`. When the capability is missing the step still appears in
// the plan but carries a `skipNote` — so the gate reports "skipped" rather than
// silently omitting it. The consumer-local bin resolution + actual run of a
// present build/test lives in `check.ts`; this module only decides run-vs-skip.
export function checkPipeline(
	capabilities: string[],
	config: DobbyConfig | null,
	flags: CheckFlags,
): CheckStep[] {
	const anyFlag = Boolean(
		flags.lint || flags.types || flags.unused || flags.build || flags.test,
	);
	// A tool step is selected if its flag is set (selective mode) or, with no flag
	// at all, always (the full gate).
	const selected = (flag: boolean | undefined): boolean =>
		anyFlag ? Boolean(flag) : true;

	const steps: CheckStep[] = [];

	if (selected(flags.lint)) {
		steps.push({ kind: "biome" });
	}
	if (selected(flags.types)) {
		steps.push({ kind: "tsc" });
	}
	if (selected(flags.unused)) {
		steps.push({ kind: "knip" });
	}
	if (selected(flags.build)) {
		steps.push({
			kind: "build",
			skipNote: capabilities.includes("vite")
				? null
				: "build: skipped (no vite capability)",
		});
	}
	if (selected(flags.test)) {
		steps.push({
			kind: "test",
			skipNote: capabilities.includes("vitest")
				? null
				: "test: skipped (no vitest capability)",
		});
	}

	// Config `checks[]` extras run LAST and ONLY on the full gate — a selective
	// flag run is a focused subset and excludes them.
	if (!anyFlag) {
		for (const extra of config?.checks ?? []) {
			steps.push({ kind: "extra", name: extra.name, run: extra.run });
		}
	}

	return steps;
}

// ---------------------------------------------------------------------------
// db:* task inference
//
// `dbTasks(capabilities)` maps the DETECTED db capability to the concrete `db:*`
// task set — pure data, no spawning. The executor (`lifecycle.ts`) resolves the
// tool bin consumer-local and runs the returned command.
//
// The rule (spec): drizzle is the ONLY db tool, so the SHORT names (`db:push`,
// `db:generate`, …) ALWAYS map to drizzle-kit. No drizzle capability → an empty
// set (mode "none"); the dispatcher reports it.
// ---------------------------------------------------------------------------

// A resolved db command: the tool bin (resolved CONSUMER-local at run time) and
// its argument vector.
export interface DbCommand {
	tool: string;
	args: string[];
}

// The inferred db task set:
//   - `mode` — "none" (no db capability) or "single" (drizzle → short names).
//   - `tasks` — the resolvable task name → its command. Keys are the short
//     `db:*` names, each mapping to drizzle-kit.
export interface DbTaskSet {
	mode: "none" | "single";
	tasks: Map<string, DbCommand>;
}

// The drizzle-kit task suffix → args map. Every command is `drizzle-kit <args>`.
const DRIZZLE_TASKS: Record<string, string[]> = {
	generate: ["generate"],
	migrate: ["migrate"],
	push: ["push"],
	check: ["check"],
	studio: ["studio"],
};

// Infer the db task set from the detected capabilities (pure). `drizzle` fires on
// drizzle-orm/drizzle-kit (see detect.ts) — the ONLY db tool, so the SHORT `db:*`
// names always map to drizzle-kit. No drizzle → an empty set (mode "none").
export function dbTasks(capabilities: string[]): DbTaskSet {
	const tasks = new Map<string, DbCommand>();

	if (capabilities.includes("drizzle")) {
		for (const [name, args] of Object.entries(DRIZZLE_TASKS)) {
			tasks.set(`db:${name}`, { tool: "drizzle-kit", args });
		}
		return { mode: "single", tasks };
	}

	return { mode: "none", tasks };
}

// The `dobby update` command: taze in interactive mode, resolved from DOBBY's OWN
// dependency tree (taze is bundled, not a consumer dep) and run with inherited
// stdio. The pure part is just the argument vector; `lifecycle.ts` resolves the
// bundled bin and spawns it.
export const UPDATE_ARGS: readonly string[] = ["--interactive"];

// ---------------------------------------------------------------------------
// Capability-aware usage (help) inference
//
// `usageCommands(capabilities)` returns the SUBSET of the `dobby` Commands list
// that applies to a repo — pure data, no rendering (`run.ts` lays it out into the
// aligned help text and the unknown-command error). This is the fix for the field
// report: the static help advertised dev/up/down/db:* in repos that have neither a
// vite nor a db capability. The filter:
//   - UNIVERSAL commands are ALWAYS present: env, check, update. (`setup` is folded
//     into `up`'s setup phase — no standalone command — so it is not advertised.)
//   - dev / up / down appear ONLY with the `vite` capability. `up` is the single
//     lifecycle entry point (prepare + run), so its description covers both.
//   - db:* entries appear ONLY with a db capability, each carrying its ACTUAL
//     resolved task name (the short `db:push` / `db:studio` / … drizzle names) and
//     the concrete shell command it runs — sourced from the SAME `dbTasks` map the
//     executor resolves.
// Order mirrors the pre-filter help: env, check, [dev, up, down], [db:*…], update.
// ---------------------------------------------------------------------------

// One entry in the `dobby` usage Commands list: the command token as the user
// types it plus a one-line description. `run.ts` renders these into aligned
// columns; the capability filter lives in `usageCommands` (this module).
export interface UsageCommand {
	name: string;
	description: string;
}

export function usageCommands(capabilities: string[]): UsageCommand[] {
	const commands: UsageCommand[] = [
		{ name: "env", description: "Print a snapshot of the working environment" },
		{
			name: "check [file...]",
			description:
				"Run the quality gate (biome, tsc, knip, build, test); file args = biome-only fast path",
		},
	];

	// dev / up / down — the run lifecycle, gated on a runnable app (the vite capability).
	if (capabilities.includes("vite")) {
		commands.push(
			{
				name: "dev",
				description:
					"Run the app: the portless-wrapped dev server + concurrent secondaries",
			},
			{
				name: "up",
				description:
					"Prepare + run the workspace (idempotent): the setup phase (install, worktree copies, setup[] extras) then a liveness-first run (cmux panes or a detached run, neon branch isolation)",
			},
			{
				name: "down",
				description:
					"Tear the run down: close panes, kill the run, delete the neon branch, teardown[] extras",
			},
		);
	}

	// db:* — only when a db capability resolves tasks; the ACTUAL resolved names.
	for (const [name, command] of dbTasks(capabilities).tasks) {
		commands.push({ name, description: describeDbCommand(command) });
	}

	commands.push({
		name: "update",
		description: "Update dependencies interactively (taze)",
	});

	return commands;
}

// The concrete shell command a resolved db task runs, as one line. Mirrors
// `run.ts`'s dry-run db plan line, reused here so the help shows exactly what each
// db:* task executes.
function describeDbCommand(command: DbCommand): string {
	return `${command.tool} ${command.args.join(" ")}`.trimEnd();
}

// ---------------------------------------------------------------------------
// `dobby dev` composition inference
//
// `devPlan(capabilities, config)` maps the DETECTED capabilities to the ordered
// `dobby dev` plan — pure data, no spawning. `lifecycle.ts` executes it (main +
// secondaries as one managed process group) and `run.ts` renders it for `--dry-run`.
//
// The composition (spec Decision "one command, one pane"):
//   - `main`        — the app dev server, present ONLY for a vite app (null with no
//     vite → the no-app gate). Its `cacheClears` (`rm -rf node_modules/.vite`,
//     admin's preamble, now inferred for every vite dev) run first, then `command`
//     (`vite dev`) is spawned WRAPPED in `portless run` — portless wraps ONLY the
//     main process (never the secondaries).
//   - `secondaries` — concurrent, spawned alongside the main: `email dev --dir
//     src/emails` for a react-email project (the canonical emails dir is a spec
//     Decision), the only secondary. Consumer-local bins, un-wrapped.
// ---------------------------------------------------------------------------

// One command in the dev plan: a tool + argument vector (mirrors `DbCommand`). In
// the plan these carry LOGICAL tool names (`vite`, `email`, `rm`); `lifecycle.ts`
// resolves the real bin (consumer-local for the app/email tools, DOBBY-bundled for
// portless) at spawn time. `run.ts` renders them for the dry-run plan without ever
// resolving a bin.
export interface DevCommand {
	tool: string;
	args: string[];
}

// The main dev process: the cache-clears that precede it and the app-dev command
// that is spawned wrapped in `portless run`. Internal to `DevPlan` (structural —
// no caller names it), so it stays un-exported.
interface DevMain {
	cacheClears: DevCommand[];
	command: DevCommand;
}

// The ordered `dobby dev` plan. `main` is null for a project with no app (no vite)
// — the executor turns that into the "nothing to run" gate.
export interface DevPlan {
	main: DevMain | null;
	secondaries: DevCommand[];
}

// Infer the `dobby dev` plan from the detected capabilities (pure). `config` is
// part of the signature for forward-compat (per-project dev extras) but v1 has NO
// config-driven dev behavior, so the composition is a pure function of the
// capabilities; the config presence is only echoed back for callers that thread it.
export function devPlan(
	capabilities: string[],
	config: DobbyConfig | null,
): DevPlan {
	void config;

	// The app main exists ONLY for a vite project. `.vite` cache-clear first, then the
	// vite dev command (wrapped in `portless run` by the renderer/executor).
	const main: DevMain | null = capabilities.includes("vite")
		? {
				cacheClears: [{ tool: "rm", args: ["-rf", "node_modules/.vite"] }],
				command: { tool: "vite", args: ["dev"] },
			}
		: null;

	const secondaries: DevCommand[] = [];
	if (capabilities.includes("react-email")) {
		secondaries.push({ tool: "email", args: ["dev", "--dir", "src/emails"] });
	}

	return { main, secondaries };
}
