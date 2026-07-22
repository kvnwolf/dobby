import type { ChildProcess } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { loadConfig } from "./config.ts";
import { detectCapabilities, scanCapabilities } from "./detect.ts";
import { discoverPanes, resolveDevUrl, resolveShareUrl } from "./envinfo.ts";
import {
	configArgs,
	requireWorkroot,
	resolveBin,
	resolveViteConfig,
	resolveWorkroot,
	runCapture,
	runInherit,
	spawnBackground,
	spawnDetached,
} from "./runner.ts";
import {
	type DbCommand,
	type DbTaskSet,
	type DevCommand,
	type DevPlan,
	dbTasks,
	devPlan,
	drizzleConfigSpec,
	type ShareDecision,
	shareDecision,
	UPDATE_ARGS,
	viteBlockedMessage,
	viteConfigSpec,
} from "./tasks.ts";

// The action-command executors (the inferred `db:*` tasks, `update`, and
// `up`/`down`/`dev`). They are the IMPURE counterpart to the pure planners in
// `tasks.ts`: they resolve the workroot, touch the filesystem, and spawn children —
// always through `runner.ts` so every child's cwd is pinned to the workroot. Each
// returns DATA (a plan + outcome); `run.ts` owns ALL rendering, so nothing here
// formats output.
//
// node:*-only (vitest imports this under Node/Vite; Bun runs it in production).

// ---------------------------------------------------------------------------
// The SETUP PHASE — folded into `dobby up` (Findings #32: the user always wants a
// workspace running when opening it, so `setup` is no longer a standalone command).
//
// The ordered sequence `up` runs BEFORE its run phase:
//   (1) `bun install` at the workroot — ALWAYS, the inferred default.
//   (2) worktree env re-materialization — in a LINKED git worktree only: read the
//       MAIN checkout's `.worktreeinclude`, and for each pattern copy any matched
//       file that is MISSING at the worktree over from main (idempotent — NEVER
//       overwriting a file already present). The belt-and-suspenders complement to
//       the native EnterWorktree copy (documented as ambiguous).
//   (3) config `setup[]` extras — run sequentially, FAIL-FAST on the first nonzero.
//
// `up --dry-run` builds the SAME ordered plan but executes nothing; a real `up`
// executes it fail-fast and only starts the run phase once every step succeeds.
// ---------------------------------------------------------------------------

// One planned setup step. The plan is pure data; `run.ts` renders it and the
// executor below runs it.
export type SetupAction =
	| { kind: "install" }
	| { kind: "copy"; rel: string; from: string; to: string }
	| { kind: "extra"; run: string };

// The documented TEST SEAM (task constraint): when `DOBBY_SKIP_INSTALL=1` the
// executor skips ONLY the `bun install` step while still performing the copy +
// extras — so a real run is exercised without ever invoking bun (which the tests
// forbid). Test-only; never set in production.
const SKIP_INSTALL_ENV = "DOBBY_SKIP_INSTALL";

// Build the ordered setup-phase plan for the workroot: (1) install (always),
// (2) worktree copies (linked-worktree only, missing-only), (3) config `setup[]`
// extras — in that fixed order. Extras APPEND after the defaults. Pure — no spawn.
function buildSetupPlan(
	root: string,
	config: { setup?: string[] } | null,
): SetupAction[] {
	const plan: SetupAction[] = [{ kind: "install" }];
	for (const copy of planWorktreeCopies(root)) {
		plan.push(copy);
	}
	for (const extra of config?.setup ?? []) {
		plan.push({ kind: "extra", run: extra });
	}
	return plan;
}

// Run the setup plan in order, fail-fast. Returns the first failing step's exit
// code (0 on success) alongside a `failure` note naming what failed (else null).
function executeSetup(
	plan: SetupAction[],
	root: string,
): { exitCode: number; failure: string | null } {
	const skipInstall = Boolean(process.env[SKIP_INSTALL_ENV]);

	for (const action of plan) {
		if (action.kind === "install") {
			if (skipInstall) {
				continue;
			}
			const code = runInherit("bun", ["install"], { root });
			if (code !== 0) {
				return { exitCode: code, failure: "`bun install` failed" };
			}
		} else if (action.kind === "copy") {
			// Idempotent: only fill a MISSING file — never clobber a locally-edited one.
			mkdirSync(dirname(action.to), { recursive: true });
			copyFileSync(action.from, action.to);
		} else {
			// Extras run through the workroot-pinned runner (sh -c), streaming so a long
			// setup step's progress is visible. Fail-fast: a nonzero exit stops the run.
			const code = runInherit("sh", ["-c", action.run], { root });
			if (code !== 0) {
				return {
					exitCode: code,
					failure: `setup extra failed (exit ${code}): ${action.run}`,
				};
			}
		}
	}

	return { exitCode: 0, failure: null };
}

// The worktree re-materialization plan: copy actions for every `.worktreeinclude`
// match present in the MAIN checkout but MISSING at the worktree. Empty unless
// `root` is a LINKED git worktree whose main checkout carries a `.worktreeinclude`.
function planWorktreeCopies(
	root: string,
): Array<{ kind: "copy"; rel: string; from: string; to: string }> {
	const mainRoot = linkedWorktreeMain(root);
	if (mainRoot === null) {
		return [];
	}
	const includePath = join(mainRoot, ".worktreeinclude");
	if (!existsSync(includePath)) {
		return [];
	}

	let raw: string;
	try {
		raw = readFileSync(includePath, "utf8");
	} catch {
		return [];
	}

	const copies: Array<{ kind: "copy"; rel: string; from: string; to: string }> =
		[];
	const seen = new Set<string>();
	for (const pattern of parseIncludePatterns(raw)) {
		for (const rel of matchInMain(mainRoot, pattern)) {
			if (seen.has(rel)) {
				continue;
			}
			seen.add(rel);
			const to = join(root, rel);
			// Missing-only: an already-present target is left untouched (idempotent).
			if (existsSync(to)) {
				continue;
			}
			copies.push({ kind: "copy", rel, from: join(mainRoot, rel), to });
		}
	}
	return copies;
}

// The MAIN checkout root when `root` is a LINKED git worktree, else null. A linked
// worktree is detected by `--git-dir` differing from `--git-common-dir`; the main
// checkout root is the PARENT of the common `.git` directory. Both queried as
// absolute paths so the comparison and dirname are reliable. Never throws — a
// non-git / non-worktree root yields null (re-materialization simply skips).
function linkedWorktreeMain(root: string): string | null {
	const result = runCapture(
		"git",
		["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
		{ root },
	);
	if (result.error || result.status !== 0) {
		return null;
	}
	const lines = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length < 2) {
		return null;
	}
	const [gitDir, commonDir] = lines;
	// Equal dirs => the main checkout itself (not a linked worktree) => no copy.
	if (gitDir === commonDir || commonDir === undefined) {
		return null;
	}
	return dirname(commonDir);
}

// Parse a `.worktreeinclude` body into pattern lines: trim each line, drop blanks
// and `#` comments, and strip a leading `./`.
function parseIncludePatterns(raw: string): string[] {
	const patterns: string[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}
		patterns.push(trimmed.startsWith("./") ? trimmed.slice(2) : trimmed);
	}
	return patterns;
}

// Resolve a single `.worktreeinclude` pattern to the relative paths it matches in
// the MAIN checkout. A literal pattern (no `*`/`?`) is a direct existence check —
// the common case (`.env.local`) and the one that dodges dotfile/glob edge cases.
// A glob walks the main checkout (skipping `.git`/`node_modules`) and regex-matches
// relative paths — matching gitignored dotfiles too (no shell-style dot exclusion),
// since those are precisely the files a worktree lacks.
function matchInMain(mainRoot: string, pattern: string): string[] {
	if (!/[*?]/.test(pattern)) {
		return existsSync(join(mainRoot, pattern)) ? [pattern] : [];
	}
	const regex = globToRegExp(pattern);
	const matches: string[] = [];
	for (const rel of walkFiles(mainRoot, "")) {
		if (regex.test(rel)) {
			matches.push(rel);
		}
	}
	return matches;
}

// Regex characters (other than the glob metachars `*`/`?`) that must be escaped
// when a glob is translated to a RegExp. The `$`, `{`, `}` are literal regex
// metacharacters here — not a template placeholder.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex metacharacters, not an interpolation
const REGEX_SPECIALS = ".+^${}()|[]\\";

// Translate a glob to an anchored RegExp: `**` matches across path separators,
// `*` matches within one segment, `?` matches a single non-separator character.
function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				source += ".*";
				index++;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else if (char !== undefined && REGEX_SPECIALS.includes(char)) {
			source += `\\${char}`;
		} else {
			source += char;
		}
	}
	return new RegExp(`^${source}$`);
}

// Yield every FILE under `root` as a relative POSIX path, skipping `.git` and
// `node_modules`. Tolerant: an unreadable directory contributes nothing.
function* walkFiles(root: string, prefix: string): Generator<string> {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, prefix), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name === ".git" || entry.name === "node_modules") {
				continue;
			}
			yield* walkFiles(root, rel);
		} else if (entry.isFile()) {
			yield rel;
		}
	}
}

// ---------------------------------------------------------------------------
// `dobby db:<task>` — the inferred database tasks
//
// The pure name→command map lives in `tasks.ts` (`dbTasks`); this executor
// detects the project's capabilities, resolves the requested task through that
// map, and — unless `--dry-run` — resolves the tool bin CONSUMER-local and spawns
// it (cwd pinned to the workroot). Unknown / ambiguous names fail with the set of
// names that IS available, so the caller sees exactly what to type instead.
// ---------------------------------------------------------------------------

// The outcome of a db task:
//   - `{ ok: false, error }`   — no db capability, or an unknown/ambiguous name.
//     `run.ts` prints `error` on stderr with exit 1 (the available-names hint is
//     baked INTO `error`).
//   - `{ ok: true, kind: "plan" }`  — `--dry-run`: the RESOLVED tool bin (CONSUMER
//     node_modules/.bin path, or the bare name when absent) + args + workroot,
//     rendered by `run.ts`, nothing spawned.
//   - `{ ok: true, kind: "ran" }`   — a real run: the child's exit code plus an
//     optional `failure` note (tool not installed, nonzero exit).
export type DbTaskReport =
	| { ok: false; error: string }
	| { ok: true; kind: "plan"; bin: string; command: DbCommand; cwd: string }
	| { ok: true; kind: "ran"; exitCode: number; failure: string | null };

// Resolve and (unless dry-run) run the `db:<task>` named `name` for the project at
// `cwd`. Capabilities are detected from `cwd` (a single-package project runs dobby
// at its root); the workroot is resolved for the pinned spawn cwd, so a real run
// fails hard outside a git repo. `--dry-run` never spawns — it returns the resolved
// command for `run.ts` to print.
export function runDbTask(
	name: string,
	cwd: string,
	opts: { dryRun: boolean },
): DbTaskReport {
	const set = dbTasks(detectCapabilities(cwd));

	if (set.mode === "none") {
		return {
			ok: false,
			error:
				"no database capability detected — dobby infers db:* tasks from a drizzle project",
		};
	}

	const command = set.tasks.get(name);
	if (command === undefined) {
		return { ok: false, error: dbUnknownMessage(name, set) };
	}

	let root: string;
	try {
		root = requireWorkroot(cwd);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// Config-less default (ADR-0015): drizzle-kit gains `--config=<preset>` when the
	// consumer ships no drizzle.config.* — the SAME augmented args feed the dry-run
	// plan and the real spawn, so the plan never lies. A consumer file → NO extra
	// args (bare — native discovery, a total override).
	const cfgArgs = configArgs(root, drizzleConfigSpec()).args;
	const augmented: DbCommand = {
		tool: command.tool,
		args: [...command.args, ...cfgArgs],
	};

	if (opts.dryRun) {
		// Resolve the tool bin CONSUMER-local (part c: the dry-run plan renders the
		// RESOLVED path so the resolution is observable) — bare fallback when absent.
		const bin = resolveBin(command.tool, { scope: "consumer", root });
		return { ok: true, kind: "plan", bin, command: augmented, cwd: root };
	}

	return { ok: true, kind: "ran", ...executeDbCommand(augmented, root) };
}

// Build the error for an unresolved db name, listing the available (short) drizzle
// task names so the caller sees exactly what to type instead.
function dbUnknownMessage(name: string, set: DbTaskSet): string {
	const available = [...set.tasks.keys()];
	return `unknown db task: ${name}\navailable: ${available.join(", ")}`;
}

// Spawn a resolved db command. The tool bin is resolved CONSUMER-local via the
// shared resolver (the consumer's own node_modules/.bin); a detected-but-not-
// installed tool (resolveBin fell back to the bare name) yields a clear "run dobby
// up" failure rather than a raw ENOENT. The command inherits stdio (finite runs
// stream; db:studio is interactive).
function executeDbCommand(
	command: DbCommand,
	root: string,
): { exitCode: number; failure: string | null } {
	const bin = resolveBin(command.tool, { scope: "consumer", root });
	// A bare-name fallback (bin === the tool name) means it is not installed in the
	// consumer's node_modules/.bin — a setup gap, surfaced actionably.
	if (bin === command.tool) {
		return {
			exitCode: 127,
			failure: `${command.tool} not found — run \`dobby up\` to install it`,
		};
	}

	const code = runInherit(bin, command.args, { root });
	return {
		exitCode: code,
		failure: code === 0 ? null : `${command.tool} exited ${code}`,
	};
}

// ---------------------------------------------------------------------------
// Share (ngrok tunnel) preflight — the IMPURE ngrok-presence probe.
//
// Share is ON BY DEFAULT (the tunnel makes the dev app reachable from a phone);
// `--no-share` opts out. Because it is the default, a machine without the `ngrok`
// binary must DEGRADE (drop the tunnel + one note), never fail the bring-up. The
// pure DECISION lives in tasks.ts (`shareDecision`); the PRESENCE fact is discovered
// HERE by a cheap `ngrok version` probe (a bare system tool, workroot-pinned) — kept
// out of the pure planners. The result is threaded as DATA into `shareDecision` so
// both branches stay deterministic; `DOBBY_NGROK` is the documented test seam.
// ---------------------------------------------------------------------------

// The documented test seam (never set in production): force the ngrok-presence probe
// deterministically so tests can assert BOTH the tunnel-on and the degrade branch
// regardless of whether the runner happens to have ngrok installed. "1" → present,
// "0" → absent, unset → the real `ngrok version` probe.
const NGROK_FORCE_ENV = "DOBBY_NGROK";

// Whether the `ngrok` binary is available on this machine. `ngrok version` exits 0
// when installed; a missing binary makes the spawn error (folded to false). System
// tool → BARE (never resolveBin), pinned to the workroot like every other spawn.
function ngrokAvailable(root: string): boolean {
	const forced = process.env[NGROK_FORCE_ENV];
	if (forced === "0") {
		return false;
	}
	if (forced === "1") {
		return true;
	}
	const result = runCapture("ngrok", ["version"], { root });
	return !result.error && result.status === 0;
}

// Resolve the share outcome (whether `--ngrok` applies + the degrade note) for a
// requested-share flag against `root`: probe ngrok ONLY when share is requested (no
// point probing when opted out), then let the pure `shareDecision` decide. A null
// root (a dev dry-run outside a git repo) cannot probe → treated as absent (degrade).
function resolveShare(share: boolean, root: string | null): ShareDecision {
	const ngrokPresent = share && root !== null && ngrokAvailable(root);
	return shareDecision(share, ngrokPresent);
}

// ---------------------------------------------------------------------------
// `dobby dev` — the run composition (streaming split, part c)
//
// The pure ordered plan lives in `tasks.ts` (`devPlan`); this executor has two
// entry points around it:
//   - `planDev(cwd)` — the CAPTURE path (used by run() for `--dry-run` and the
//     no-app gate): detect capabilities, build the plan, and turn "no app main"
//     into the hard "nothing to run" error. No spawn.
//   - `runDev(cwd)` — the STREAMING path (used ONLY by the bin, index.ts): clear
//     the `.vite` cache, then spawn the portless-wrapped main + the concurrent
//     secondaries as ONE managed process group; on any child exit or a
//     SIGINT/SIGTERM to dobby, tear the whole group down and exit with the MAIN's
//     code. Inherited stdio — it streams and lives until the group exits. NOT
//     CI-tested (spawns real servers) — covered by the wrap-stage human smoke + the
//     verifier's live recipe.
// ---------------------------------------------------------------------------

// A dev command whose bin is RESOLVED to a spawnable path: a consumer-local
// node_modules/.bin path, or the bare tool name when the consumer has not
// installed it (the documented fallback). Both the `--dry-run` render and the
// real spawn read this, so the plan can never diverge from what actually runs.
export interface ResolvedDevCommand {
	bin: string;
	args: string[];
}

// The `dobby dev` plan with every bin resolved (part c: the dry-run render shows
// resolved paths). `secondaries` are CONSUMER-local; the main app command is
// wrapped by the BUNDLED portless (also resolved from dobby's tree), with `ngrok`
// telling the renderer/executor whether to insert `--ngrok` (the share tunnel).
// `cacheClears` stay logical (a native `rm`, never spawned). `shareNote` carries the
// degrade note when share was requested but ngrok is missing (else null).
export interface ResolvedDevPlan {
	cacheClears: DevCommand[];
	main: {
		portless: string;
		ngrok: boolean;
		command: ResolvedDevCommand;
	} | null;
	secondaries: ResolvedDevCommand[];
	shareNote: string | null;
}

// The outcome of planning `dobby dev`:
//   - `{ ok: false, error }` — no app main (no vite) → the "nothing to run" gate.
//   - `{ ok: true, plan }`   — an app exists; the RESOLVED ordered plan (main,
//     secondaries) is ready to render (dry-run) or execute (streaming).
export type DevReport =
	| { ok: false; error: string }
	| { ok: true; plan: ResolvedDevPlan };

// Build the `dobby dev` plan for the project at `cwd` (the CAPTURE path — no
// spawn). Capabilities are detected from `cwd` (a single-package project runs
// dobby at its root); `config` is threaded for signature-completeness (v1 has no
// config-driven dev behavior). No vite app → the "nothing to run" gate (exit 1);
// `up` is the graceful path for a project with nothing to serve. `share` (ON BY
// DEFAULT; `--no-share` opts out) decides the ngrok tunnel — resolved here so the
// dry-run plan reflects the real ngrok-presence probe (degrade note when missing).
export function planDev(cwd: string, opts: { share: boolean }): DevReport {
	// Scan ONCE for both the capabilities AND the raw dependency set — the latter
	// feeds `viteConfigSpec`'s require-all-imports guard (the tanstack preset is
	// picked only when every package it imports is declared).
	const { capabilities, dependencies } = scanCapabilities(cwd);
	const loaded = loadConfig(cwd);
	const config = loaded?.ok ? loaded.config : null;
	const plan = devPlan(capabilities, config);

	if (plan.main === null) {
		return {
			ok: false,
			error:
				"nothing to run — no app capability (no vite) detected; use `dobby up` for the graceful path",
		};
	}
	// Resolve every bin now (SOFT workroot — the dry-run capture path must not fail
	// hard outside a git repo; a null root leaves consumer bins as bare names, the
	// documented fallback). The real streaming path re-asserts a hard workroot.
	const root = resolveWorkroot(cwd);
	// The vite default (ADR-0015): BLOCKED for a config-less tanstack app missing an
	// imported package — no import-safe fallback serves the app, so it is a HARD ERROR
	// through the plan/run error path (dev's 'nothing to run' twin), not a silent base.
	const viteCfg = resolveViteConfig(
		root,
		viteConfigSpec(capabilities, dependencies),
	);
	if (viteCfg.blocked) {
		return { ok: false, error: viteBlockedMessage(viteCfg.missing) };
	}
	return {
		ok: true,
		plan: resolveDevPlan(
			plan,
			root,
			viteCfg.args,
			resolveShare(opts.share, root),
		),
	};
}

// Resolve the logical dev plan's bins to spawnable paths: consumer-local for the
// app/email tools (`<root>/node_modules/.bin/<tool>`, bare fallback), BUNDLED for
// the portless wrapper (dobby's own tree). The SAME resolution feeds the dry-run
// render and the real spawn, so the plan never lies about what runs. `viteConfigArgs`
// are the config-less default `--config <preset>` args (ADR-0015) the caller already
// resolved from the workroot (empty when the consumer ships its own vite config) —
// appended so both the dry-run render and the real spawn read the identical path.
// A BLOCKED tanstack default is handled by the caller (`planDev`) BEFORE this point.
function resolveDevPlan(
	plan: DevPlan,
	root: string | null,
	viteConfigArgs: string[],
	share: ShareDecision,
): ResolvedDevPlan {
	const consumer = (command: DevCommand): ResolvedDevCommand => ({
		bin: resolveBin(command.tool, {
			scope: "consumer",
			root: root ?? undefined,
		}),
		args: command.args,
	});
	// The vite dev command (the main) gains `--config <preset>` when absent — the
	// caller-resolved `viteConfigArgs` (empty when the consumer ships its own config).
	const main = ((): ResolvedDevPlan["main"] => {
		if (plan.main === null) {
			return null;
		}
		const command = consumer(plan.main.command);
		return {
			portless: resolveBin("portless", { scope: "bundled" }),
			// `--ngrok` (the share tunnel) is applied when share is on AND ngrok is present.
			ngrok: share.ngrok,
			command: {
				bin: command.bin,
				args: [...command.args, ...viteConfigArgs],
			},
		};
	})();
	return {
		cacheClears: plan.main?.cacheClears ?? [],
		main,
		secondaries: plan.secondaries.map(consumer),
		shareNote: share.note,
	};
}

// Execute a live `dobby dev` (the STREAMING path). Returns the process exit code
// once the managed group tears down. The bin (index.ts) is the ONLY caller — it
// installs no output capture, so children stream straight to the terminal. `share`
// (ON BY DEFAULT; `--no-share` opts out) drives the ngrok tunnel — resolved inside
// `planDev` (the same probe the dry-run uses), so the degrade note prints once here.
export async function runDev(
	cwd: string,
	opts: { share: boolean },
): Promise<number> {
	const report = planDev(cwd, { share: opts.share });
	if (!report.ok) {
		process.stderr.write(`${report.error}\n`);
		return 1;
	}

	let root: string;
	try {
		root = requireWorkroot(cwd);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}

	const { cacheClears, main, secondaries, shareNote } = report.plan;
	if (main === null) {
		// Unreachable: planDev returns ok only when the app main exists.
		return 1;
	}

	// Surface the degrade note (share requested but ngrok missing) before the group
	// starts, so the user knows the app is local-only this session.
	if (shareNote !== null) {
		process.stderr.write(`${shareNote}\n`);
	}

	// (1) Cache-clear (`rm -rf node_modules/.vite`) — done natively, before spawning.
	for (const clear of cacheClears) {
		const target = clear.args.at(-1);
		if (clear.tool === "rm" && target !== undefined) {
			rmSync(join(root, target), { recursive: true, force: true });
		}
	}

	// (2) The portless-wrapped main + concurrent secondaries as ONE managed group.
	// portless resolves from DOBBY's OWN tree (bundled); the app/email bins are
	// consumer-local; portless wraps ONLY the main. A bare (unresolved) portless
	// means dobby's own tree is broken — fail with the clear message.
	if (!isAbsolute(main.portless)) {
		process.stderr.write(
			"could not resolve the bundled portless binary from dobby\n",
		);
		return 1;
	}
	const mainSpawn = {
		bin: process.execPath,
		args: [
			main.portless,
			"run",
			// `--ngrok` opens the share tunnel; omitted when share is off or ngrok is absent.
			...(main.ngrok ? ["--ngrok"] : []),
			main.command.bin,
			...main.command.args,
		],
	};
	const secondarySpawns = secondaries.map((secondary) => ({
		bin: secondary.bin,
		args: secondary.args,
	}));

	return runManagedGroup(mainSpawn, secondarySpawns, root);
}

// Spawn the main + secondaries as ONE managed process group and resolve once it
// tears down. Each child is DETACHED (its own group) via the runner, so teardown
// is `process.kill(-pid, …)` — the child AND its descendants (vite workers, the
// email dev server, …) die together. ANY child exiting, or a SIGINT/SIGTERM to
// dobby, collapses the whole group; the resolved code is the MAIN's exit code (a
// secondary dying or a signal is a nonzero teardown). node:child_process semantics
// only.
function runManagedGroup(
	main: { bin: string; args: string[] },
	secondaries: Array<{ bin: string; args: string[] }>,
	root: string,
): Promise<number> {
	const mainChild = spawnDetached(main.bin, main.args, { root });
	const secondaryChildren = secondaries.map((spec) =>
		spawnDetached(spec.bin, spec.args, { root }),
	);
	const children = [mainChild, ...secondaryChildren];

	return new Promise<number>((resolve) => {
		let settled = false;
		const teardown = (code: number): void => {
			if (settled) {
				return;
			}
			settled = true;
			for (const child of children) {
				killGroup(child);
			}
			resolve(code);
		};

		for (const child of children) {
			child.on("exit", (childCode, signal) => {
				const code = child === mainChild ? (childCode ?? (signal ? 1 : 0)) : 1;
				teardown(code);
			});
			child.on("error", () => teardown(1));
		}

		// Detached children sit in their own process groups, so a terminal Ctrl-C does
		// NOT reach them — dobby receives the signal and forwards teardown to the group.
		process.on("SIGINT", () => teardown(130));
		process.on("SIGTERM", () => teardown(143));
	});
}

// SIGTERM a child's whole process group (the NEGATIVE pid). Guards against a child
// that never started or already exited; a vanished group is ignored.
function killGroup(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) {
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		// Already dead or no such group — nothing to tear down.
	}
}

// ---------------------------------------------------------------------------
// `dobby build` — the inferred mechanical build (ADR-0015)
//
// External builders build THROUGH dobby: a consumer's Vercel `buildCommand` is
// `bunx dobby build`, so dobby (not the raw framework CLI) owns the build spawn —
// which lets future niceties (env checks, cache warmup, telemetry) land CENTRALLY
// without every consumer editing its buildCommand. The real run is the consumer's
// OWN `vite build` (never dobby's — the dual-Vite invariant) + the config-less
// default `--config <preset>` (ADR-0015) when the consumer ships no vite config.
//
// Capability-gated on `vite` (mirroring `dev`'s gate): no vite → exit 1 'nothing to
// build'. FINITE (not the streaming split) — it is dispatched inside run() and
// inherits stdio through the runner (the `db:*` pattern), so run() renders the
// outcome. `--dry-run` renders the plan (bin + args + pinned cwd), no spawn.
// `check --build` reuses the SAME config resolution (viteConfigSpec).
// ---------------------------------------------------------------------------

// The outcome of `dobby build`:
//   - `{ ok: false, error }` — no vite capability ('nothing to build'), or outside
//     a git repo. `run.ts` prints `error` on stderr with exit 1.
//   - `{ ok: true, kind: "plan", bin, args, cwd }` — `--dry-run`: the RESOLVED
//     consumer vite bin + args (incl. the `--config` default when absent) + the
//     pinned workroot, rendered by `run.ts`, nothing spawned.
//   - `{ ok: true, kind: "ran", exitCode, failure }` — a real run: the child's exit
//     code plus an optional failure note (vite not installed, nonzero exit).
export type BuildReport =
	| { ok: false; error: string }
	| { ok: true; kind: "plan"; bin: string; args: string[]; cwd: string }
	| { ok: true; kind: "ran"; exitCode: number; failure: string | null };

// Resolve and (unless dry-run) run `vite build` for the project at `cwd`.
// Capabilities are detected from `cwd` (a single-package project runs dobby at its
// root); no vite → the hard 'nothing to build' gate (dev's gate's twin). The
// workroot is resolved for the pinned spawn cwd, so a real run fails hard outside a
// git repo.
export function runBuild(cwd: string, opts: { dryRun: boolean }): BuildReport {
	// Scan ONCE — capabilities gate the build, the dependency set feeds
	// `viteConfigSpec`'s require-all-imports guard (tanstack preset vs vite base).
	const { capabilities, dependencies } = scanCapabilities(cwd);
	if (!capabilities.includes("vite")) {
		return {
			ok: false,
			error:
				"nothing to build — no app capability (no vite) detected; `dobby build` is the inferred build for vite apps",
		};
	}

	let root: string;
	try {
		root = requireWorkroot(cwd);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const bin = resolveBin("vite", { scope: "consumer", root });
	const viteCfg = resolveViteConfig(
		root,
		viteConfigSpec(capabilities, dependencies),
	);
	// BLOCKED (ADR-0015): a config-less tanstack app missing an imported package has no
	// import-safe fallback that serves — fail loud (exit 1) via the run error path (the
	// 'nothing to build' twin) in BOTH dry-run and a real build. Never a silent base.
	if (viteCfg.blocked) {
		return { ok: false, error: viteBlockedMessage(viteCfg.missing) };
	}
	const args = ["build", ...viteCfg.args];

	if (opts.dryRun) {
		return { ok: true, kind: "plan", bin, args, cwd: root };
	}

	// A bare-name fallback (bin === "vite") means it is not installed in the
	// consumer's node_modules/.bin — a setup gap, surfaced actionably (mirrors db:*).
	if (bin === "vite") {
		return {
			ok: true,
			kind: "ran",
			exitCode: 127,
			failure: "vite not found — run `dobby up` to install it",
		};
	}

	const code = runInherit(bin, args, { root });
	return {
		ok: true,
		kind: "ran",
		exitCode: code,
		failure: code === 0 ? null : `vite build exited ${code}`,
	};
}

// ---------------------------------------------------------------------------
// `dobby update` — taze in interactive mode
//
// Resolves taze from DOBBY's OWN dependency tree (it is bundled, not a consumer
// dep) and runs it with inherited stdio: the interactive picker is driven by the
// user and terminates with them. Fails hard outside a git repo (an action command).
// ---------------------------------------------------------------------------

// The outcome of `dobby update`:
//   - `{ ok: false, error }` — outside a git repo, or the bundled taze is missing.
//   - `{ ok: true, exitCode }` — taze ran (interactively); its exit code, streamed.
export type UpdateReport =
	| { ok: false; error: string }
	| { ok: true; exitCode: number };

export function runUpdate(cwd: string): UpdateReport {
	let root: string;
	try {
		root = requireWorkroot(cwd);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// taze is BUNDLED — resolve it from dobby's OWN tree, run via process.execPath
	// (bun runs the resolved bin). A bare (unresolved) taze means dobby's own tree
	// is broken; surface the clear message rather than a raw PATH miss.
	const bin = resolveBin("taze", { scope: "bundled" });
	if (!isAbsolute(bin)) {
		return {
			ok: false,
			error: "could not resolve the bundled taze binary from dobby",
		};
	}

	return {
		ok: true,
		exitCode: runInherit(process.execPath, [bin, ...UPDATE_ARGS], { root }),
	};
}

// ---------------------------------------------------------------------------
// `dobby up` / `dobby down` — the run-lifecycle pair
//
// `up` is THE single lifecycle entry point: it PREPARES the workspace (the setup
// phase — bun install + linked-worktree `.worktreeinclude` re-materialization +
// config `setup[]` extras, fail-fast) and THEN brings the app up (liveness-first,
// idempotent). `down` mechanizes finish teardown. Both are ACTION commands (fail
// hard outside a git repo) and both expose `--dry-run`, which builds the SAME
// decision-derived plan but executes NOTHING. `up --dry-run` prints the FULL ordered
// plan — the setup phase THEN the run phase, including what would be skipped and why.
// `run.ts` renders the plan (a list of `SetupAction` + `UpAction` / `DownAction` —
// this module returns DATA, run.ts owns all formatting); a real run walks the same
// decisions imperatively.
//
// The plan-vs-execution split is deliberate: the DRY-RUN plan is fully CI-tested
// (through the `--dry-run` render), while the real execution (curl liveness probe,
// `bunx neonctl` branch create/delete, the cmux pane orchestration with its
// runtime surface-ref capture, the detached spawn) needs a live server / cmux /
// neonctl and is covered by the verifier's live recipe + the wrap-stage human
// smoke — NOT CI (mirroring how `dev`'s streaming path is handled). The cmux stdout
// ref format is runtime-unverified, so the orchestration carries the spec-mandated
// discovery-diff fallback.
//
// slug = workroot basename (a spec Decision); the neon branch is `dobby/<slug>`
// (SLASH), the kit panes are `dobby-{browser,run}-<slug>` (DASHES).
// ---------------------------------------------------------------------------

// The single liveness probe: `curl -sf --max-time 5 <devUrl>` — HTTP 200 on the
// portless root (neither consumer has a health endpoint). The retry wait loops it.
const LIVENESS_MAX_TIME_SEC = 5;
const LIVENESS_RETRIES = 6;
const LIVENESS_INTERVAL_SEC = 5;

// One planned `up` action, discriminated by `kind`. `run.ts` renders each to its
// shell-style plan line(s); `executeUp` performs the real operation. Every literal
// a test reads (the cmux command shape, the neon branch verb, the pane names, the
// detached-state paths) is carried HERE as data.
export type UpAction =
	| { kind: "probe"; url: string | null }
	| { kind: "neon-branch"; branch: string; projectId: string }
	| {
			kind: "cmux-panes";
			workspace: string;
			devUrl: string | null;
			browserName: string;
			runName: string;
			sendLine: string;
	  }
	| { kind: "detached"; command: string; pidRel: string; logRel: string }
	| { kind: "wait"; url: string | null; retries: number; intervalSec: number };

// The ordered `up` plan for `--dry-run`: the workroot it is pinned to, its slug,
// the SETUP-PHASE actions (install → copies → extras) that run first, the cmux
// WORKSPACE rename (present only under cmux, INDEPENDENT of the app gate), the
// run-phase `actions` in execution order (probe → neon → start → wait), and
// `runSkipped` — the reason the run phase is skipped (e.g. 'no app to run') or null
// when it runs.
export interface UpPlan {
	workroot: string;
	slug: string;
	setup: SetupAction[];
	// The cmux workspace rename — present ONLY under cmux (null otherwise). Renames the
	// workspace to the plain goal SLUG (no dobby- prefix — the panes carry that; the
	// workspace title IS the goal identity) so the user can tell which workspace is
	// which at a glance. Runs after the setup phase and BEFORE the no-app gate, so a
	// no-app project still gets its workspace renamed.
	renameWorkspace: { workspace: string; title: string } | null;
	actions: UpAction[];
	runSkipped: string | null;
	// The share degrade note (share on by default, but ngrok is missing) — surfaced in
	// the plan just like the dev plan's, or null (share off, ngrok present, or no app).
	shareNote: string | null;
}

// The outcome of `dobby up`:
//   - `{ ok: false, error }` — a HARD failure (outside a git repo; the neon
//     capability present but its creds missing — no silent main-DB fallback).
//     `run.ts` prints `error` on stderr with exit 1.
//   - `{ ok: true, kind: "noop", message }` — the no-app gate: a project with no
//     vite capability has nothing to serve ('no app to run', exit 0) — the graceful
//     counterpart to `dev`'s hard 'nothing to run'.
//   - `{ ok: true, kind: "plan", plan }` — `--dry-run`: the ordered plan to render.
//   - `{ ok: true, kind: "ran", exitCode, failure, note }` — a real run executed;
//     `note` carries any advisory (the share degrade note, or the already-live
//     no-tunnel restart hint), rendered on stdout, distinct from a `failure`.
export type UpReport =
	| { ok: false; error: string }
	| { ok: true; kind: "noop"; message: string }
	| { ok: true; kind: "plan"; plan: UpPlan }
	| {
			ok: true;
			kind: "ran";
			exitCode: number;
			failure: string | null;
			note: string | null;
	  };

// The decisions `up` resolves ONCE (git precondition, capabilities, devUrl, cmux,
// neon creds, share intent) — the single source both the plan and the imperative
// execution derive from, so `--dry-run` never lies about what a real run would do.
interface UpContext {
	workroot: string;
	slug: string;
	devUrl: string | null;
	cmux: string | null;
	neon: { apiKey: string; projectId: string } | null;
	// The requested share intent (true by default; false with `--no-share`). Drives
	// whether the started `dobby dev` carries `--no-share`, and whether the already-live
	// path hints at restarting for a tunnel.
	share: boolean;
}

// Resolve `up` for the git worktree enclosing `cwd`, then either PLAN (`--dry-run`)
// or execute. The single lifecycle entry point:
//   (0) fail hard outside a git repo (git precondition wins over every gate);
//   (1) the SETUP PHASE — bun install + linked-worktree copies + config `setup[]`
//       extras, fail-fast (a real run stops with exit 1 and the run phase never
//       starts on any setup failure);
//   (2) the no-app gate (no vite) — the graceful exit-0 no-op (dev's hard gate's
//       gentle twin), reached only AFTER the setup phase;
//   (3) the RUN PHASE — liveness-first, idempotent; a neon project with missing
//       creds fails hard (guaranteed branch isolation, no main-DB fallback).
// `--dry-run` prints the FULL ordered plan (setup phase + run phase, or the skip
// reason) without executing anything.
export function runUp(
	cwd: string,
	opts: { dryRun: boolean; share: boolean },
): UpReport {
	let workroot: string;
	try {
		workroot = requireWorkroot(cwd);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// The setup phase reads config `setup[]` extras. A broken config is a hard failure
	// (an action command must not proceed on an unreadable contract); absent = none.
	const loaded = loadConfig(workroot);
	if (loaded && !loaded.ok) {
		return { ok: false, error: loaded.error };
	}
	const config = loaded?.config ?? null;

	const setupPlan = buildSetupPlan(workroot, config);
	const capabilities = detectCapabilities(cwd);
	const hasApp = capabilities.includes("vite");
	const slug = basename(workroot);
	// The cmux workspace rename — present ONLY under cmux, resolved ONCE (independent
	// of the app gate) so it appears in the plan and runs whether or not there is an app.
	const cmux = process.env.CMUX_WORKSPACE_ID || null;
	const renameWorkspace =
		cmux === null ? null : { workspace: cmux, title: slug };
	// Share is resolved (ngrok probe) ONLY for a project that actually starts an app —
	// a no-app project has nothing to tunnel, so no degrade note. The started `dobby dev`
	// re-probes and applies `--ngrok` itself; `up` surfaces the degrade note as a preview.
	const share: ShareDecision = hasApp
		? resolveShare(opts.share, workroot)
		: { ngrok: false, note: null };

	if (opts.dryRun) {
		// No app → the run phase is skipped, but the FULL plan still shows the setup
		// phase, the cmux workspace rename (when present), and names the skip reason
		// (spec's --dry-run contract).
		if (!hasApp) {
			return {
				ok: true,
				kind: "plan",
				plan: {
					workroot,
					slug,
					setup: setupPlan,
					renameWorkspace,
					actions: [],
					runSkipped: "no app to run",
					shareNote: share.note,
				},
			};
		}
		const resolved = resolveUpContext(
			cwd,
			workroot,
			slug,
			capabilities,
			opts.share,
		);
		if (!resolved.ok) {
			return { ok: false, error: resolved.error };
		}
		return {
			ok: true,
			kind: "plan",
			plan: {
				workroot,
				slug,
				setup: setupPlan,
				renameWorkspace,
				actions: buildUpActions(resolved.context),
				runSkipped: null,
				shareNote: share.note,
			},
		};
	}

	// A real run: (1) the setup phase, fail-fast — any failure stops here (exit
	// nonzero, the run phase never starts).
	const setupOutcome = executeSetup(setupPlan, workroot);
	if (setupOutcome.exitCode !== 0) {
		return {
			ok: true,
			kind: "ran",
			exitCode: setupOutcome.exitCode,
			failure: setupOutcome.failure,
			note: null,
		};
	}

	// (1b) Rename the cmux WORKSPACE to the goal slug — WHENEVER cmux is present, after
	// the setup phase and BEFORE the no-app gate, so a no-app project's workspace is
	// still renamed. Idempotent by nature (re-running `up` re-renames to the same title).
	if (cmux !== null) {
		renameCmuxWorkspace(workroot, cmux, slug);
	}

	// (2) The no-app gate — the graceful no-op, reached only after the setup phase.
	if (!hasApp) {
		return { ok: true, kind: "noop", message: "no app to run" };
	}

	// (3) The run phase (a neon project with missing creds fails hard).
	const resolved = resolveUpContext(
		cwd,
		workroot,
		slug,
		capabilities,
		opts.share,
	);
	if (!resolved.ok) {
		return { ok: false, error: resolved.error };
	}
	const outcome = executeUp(resolved.context);
	// The degrade note (share requested but ngrok missing) and any already-live
	// restart hint from execution both surface as advisories on the ran report.
	const note = joinNotes(share.note, outcome.note);
	return {
		ok: true,
		kind: "ran",
		exitCode: outcome.exitCode,
		failure: outcome.failure,
		note,
	};
}

// Join up to two advisory notes into one block (dropping nulls), or null when both
// are absent — so a real `up` can carry the degrade note AND the already-live hint.
function joinNotes(a: string | null, b: string | null): string | null {
	const notes = [a, b].filter((n): n is string => n !== null);
	return notes.length === 0 ? null : notes.join("\n");
}

// Resolve the run-phase decisions (devUrl, cmux, neon creds) for a vite app into an
// `UpContext`, or a HARD error when a neon project is missing its isolation creds.
// The single source both the plan and the imperative execution derive from, so
// `--dry-run` never lies about what a real run would do.
function resolveUpContext(
	cwd: string,
	workroot: string,
	slug: string,
	capabilities: string[],
	share: boolean,
): { ok: false; error: string } | { ok: true; context: UpContext } {
	const devUrl = resolveDevUrl(cwd, workroot, capabilities);
	const cmux = process.env.CMUX_WORKSPACE_ID || null;

	// Neon isolation: BOTH creds must be present in the worktree's .env.local, or up
	// fails hard — refusing to fall back to the shared main database.
	let neon: { apiKey: string; projectId: string } | null = null;
	if (capabilities.includes("neon")) {
		const creds = readNeonCreds(workroot);
		if (creds.apiKey === null || creds.projectId === null) {
			return {
				ok: false,
				error:
					"neon capability detected but NEON_API_KEY and/or NEON_PROJECT_ID are missing from .env.local — refusing to fall back to the main database (each dev copies .env.local for guaranteed branch isolation)",
			};
		}
		neon = { apiKey: creds.apiKey, projectId: creds.projectId };
	}

	return { ok: true, context: { workroot, slug, devUrl, cmux, neon, share } };
}

// The `bunx dobby dev` command `up` starts (via a cmux pane or a detached spawn),
// carrying `--no-share` ONLY when the user opted out — so the inner dev tunnels by
// default. The degrade-on-missing-ngrok is the inner dev's own concern (it re-probes).
function devStartCommand(context: UpContext): string {
	return context.share ? "bunx dobby dev" : "bunx dobby dev --no-share";
}

// The ordered `up` plan derived from the resolved decisions: probe → neon branch
// (when neon) → start (cmux panes XOR detached run) → liveness wait.
function buildUpActions(context: UpContext): UpAction[] {
	const actions: UpAction[] = [{ kind: "probe", url: context.devUrl }];

	if (context.neon !== null) {
		actions.push({
			kind: "neon-branch",
			branch: `dobby/${context.slug}`,
			projectId: context.neon.projectId,
		});
	}

	if (context.cmux !== null) {
		actions.push({
			kind: "cmux-panes",
			workspace: context.cmux,
			devUrl: context.devUrl,
			browserName: `dobby-browser-${context.slug}`,
			runName: `dobby-run-${context.slug}`,
			sendLine: `cd ${context.workroot} && ${devStartCommand(context)}`,
		});
	} else {
		actions.push({
			kind: "detached",
			command: devStartCommand(context),
			pidRel: ".dobby/dev.pid",
			logRel: ".dobby/dev.log",
		});
	}

	actions.push({
		kind: "wait",
		url: context.devUrl,
		retries: LIVENESS_RETRIES,
		intervalSec: LIVENESS_INTERVAL_SEC,
	});
	return actions;
}

// Execute a real `up` (liveness-first, idempotent). NOT CI-tested — needs a live
// server / cmux / neonctl.
function executeUp(context: UpContext): {
	exitCode: number;
	failure: string | null;
	note: string | null;
} {
	// (1) Already up? A single probe short-circuits — ensure the kit panes exist
	// (idempotent) under cmux, then done. If share was requested but the RUNNING
	// instance has no ngrok tunnel (shareUrl null in portless's routes.json), we do
	// NOT restart automatically — we just note that a restart would add the tunnel.
	if (
		context.devUrl !== null &&
		probeLiveness(context.workroot, context.devUrl)
	) {
		if (context.cmux !== null) {
			createPanes(context, context.cmux);
		}
		const note =
			context.share && resolveShareUrl(context.devUrl) === null
				? "the running app has no share tunnel — `bunx dobby down && bunx dobby up` to restart with the default share"
				: null;
		return { exitCode: 0, failure: null, note };
	}

	// (2) Neon branch — create idempotently and rewrite the worktree's .env.local.
	if (context.neon !== null) {
		const failure = provisionNeonBranch(context);
		if (failure !== null) {
			return { exitCode: 1, failure, note: null };
		}
	}

	// (3) Start: cmux owns the process in named panes, else spawn detached. A failed
	// detached spawn fails `up` NOW (never entering the liveness wait for a server
	// that never started); the cmux path is owned by cmux and unaffected.
	if (context.cmux !== null) {
		createPanes(context, context.cmux);
	} else if (!startDetached(context)) {
		return {
			exitCode: 1,
			failure: "could not start `bunx dobby dev` — see .dobby/dev.log",
			note: null,
		};
	}

	// (4) Wait for liveness (retry loop). Never reachable → fail with the trust hint.
	if (
		context.devUrl === null ||
		!waitForLiveness(context.workroot, context.devUrl)
	) {
		return {
			exitCode: 1,
			failure:
				"the app never became reachable — check that the portless daemon is running and the local CA is trusted (`portless trust`)",
			note: null,
		};
	}
	return { exitCode: 0, failure: null, note: null };
}

// A single liveness probe: `curl -sf --max-time 5 <url>` (HTTP 200 → alive).
function probeLiveness(workroot: string, url: string): boolean {
	const result = runCapture(
		"curl",
		["-sf", "--max-time", String(LIVENESS_MAX_TIME_SEC), url],
		{
			root: workroot,
		},
	);
	return !result.error && result.status === 0;
}

// Probe up to LIVENESS_RETRIES times, LIVENESS_INTERVAL_SEC apart (a blocking wait
// via Atomics — the executor is synchronous, mirroring the sibling action runners).
function waitForLiveness(workroot: string, url: string): boolean {
	for (let attempt = 0; attempt < LIVENESS_RETRIES; attempt++) {
		if (probeLiveness(workroot, url)) {
			return true;
		}
		if (attempt < LIVENESS_RETRIES - 1) {
			sleepSync(LIVENESS_INTERVAL_SEC * 1000);
		}
	}
	return false;
}

// A synchronous sleep (no busy-wait): block the thread on an Atomics wait against a
// never-notified buffer for `ms` milliseconds. node-only, no dependency.
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Neon branch provisioning (up) — creates `dobby/<slug>` and rewrites .env.local.
// ---------------------------------------------------------------------------

// Create the isolation branch idempotently (branch-exists → fetch its connection
// string instead) and rewrite the worktree's DATABASE_URL* lines. Returns null on
// success or a message on hard failure. NOT CI-tested (needs real neonctl).
function provisionNeonBranch(context: UpContext): string | null {
	const neon = context.neon;
	if (neon === null) {
		return null;
	}
	const branch = `dobby/${context.slug}`;
	const env = { ...process.env, NEON_API_KEY: neon.apiKey };

	const created = runCapture(
		"bunx",
		[
			"neonctl",
			"branches",
			"create",
			"--name",
			branch,
			"--project-id",
			neon.projectId,
			"--output",
			"json",
		],
		{ root: context.workroot, env },
	);
	if (created.error) {
		return `could not run neonctl: ${created.error.message}`;
	}

	let connectionUri: string | null = null;
	if (created.status === 0) {
		connectionUri = parseNeonConnectionUri(created.stdout);
	} else {
		// Branch already exists (idempotent) → fetch its connection string instead.
		const existing = runCapture(
			"bunx",
			["neonctl", "connection-string", branch, "--project-id", neon.projectId],
			{ root: context.workroot, env },
		);
		if (existing.status !== 0) {
			return `neonctl branches create failed: ${created.stderr.trim() || `exit ${created.status}`}`;
		}
		connectionUri = existing.stdout.trim() || null;
	}

	if (connectionUri !== null) {
		rewriteDatabaseUrls(context.workroot, connectionUri);
	}
	return null;
}

// The pooled connection URI from a `neonctl branches create --output json` payload
// (`connection_uris[0].connection_uri`), or null when the shape is unexpected.
function parseNeonConnectionUri(stdout: string): string | null {
	try {
		const data = JSON.parse(stdout) as {
			connection_uris?: Array<{ connection_uri?: string }>;
		};
		const uri = data.connection_uris?.[0]?.connection_uri;
		return typeof uri === "string" && uri !== "" ? uri : null;
	} catch {
		return null;
	}
}

// Rewrite the worktree's .env.local DATABASE_URL / DATABASE_URL_UNPOOLED lines from
// the branch connection string. Best-effort (missing file → skip). The unpooled
// counterpart drops Neon's `-pooler` host suffix, the pooled adds it.
function rewriteDatabaseUrls(workroot: string, connectionUri: string): void {
	const path = join(workroot, ".env.local");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return;
	}
	const pooled = togglePooler(connectionUri, true);
	const unpooled = togglePooler(connectionUri, false);
	const rewritten = raw
		.split("\n")
		.map((line) => {
			if (/^\s*DATABASE_URL\s*=/.test(line)) {
				return `DATABASE_URL=${pooled}`;
			}
			if (/^\s*DATABASE_URL_UNPOOLED\s*=/.test(line)) {
				return `DATABASE_URL_UNPOOLED=${unpooled}`;
			}
			return line;
		})
		.join("\n");
	writeFileSync(path, rewritten);
}

// Toggle Neon's pooled-endpoint `-pooler` host suffix on a connection URI.
function togglePooler(uri: string, pooled: boolean): string {
	try {
		const url = new URL(uri);
		const hasPooler = url.hostname.includes("-pooler.");
		if (pooled && !hasPooler) {
			url.hostname = url.hostname.replace(/^([^.]+)\./, "$1-pooler.");
		} else if (!pooled && hasPooler) {
			url.hostname = url.hostname.replace("-pooler.", ".");
		}
		return url.toString();
	} catch {
		return uri;
	}
}

// ---------------------------------------------------------------------------
// cmux workspace rename (up) — the workspace title IS the goal identity.
// ---------------------------------------------------------------------------

// Rename the cmux WORKSPACE to the plain goal `title` (the slug) so the user can tell
// which workspace belongs to which goal at a glance. Workspace-scoped like the pane
// commands, so `--workspace` is passed explicitly (matching createPanes' new-pane /
// list-panes style). Idempotent by nature (re-running re-renames to the same title).
// Best-effort — a cmux failure never blocks the run. NOT CI-tested.
function renameCmuxWorkspace(
	workroot: string,
	cmux: string,
	title: string,
): void {
	runCapture("cmux", ["rename-workspace", "--workspace", cmux, title], {
		root: workroot,
	});
}

// ---------------------------------------------------------------------------
// cmux pane orchestration (up) — browser right of Claude, run terminal below it.
// ---------------------------------------------------------------------------

// Create (or REUSE) the kit panes: browser to the RIGHT of Claude, run terminal
// BELOW the browser via a surface-targeted `new-split down` (never focus-dependent).
// Create-missing-only (spec up step 1): each kit pane is reused INDIVIDUALLY by its
// discovered surface ref — both present → no-op; exactly one survivor → reuse it and
// create only the missing pane (never a duplicate). Surface refs are captured from
// cmux stdout, with the spec-mandated discovery-diff fallback (the stdout ref format
// is runtime-unverified). NOT CI-tested.
function createPanes(context: UpContext, cmux: string): void {
	const existing = discoverPanes(context.workroot, cmux);
	// Both kit panes already present → nothing to do (idempotent).
	if (existing.browserPane !== null && existing.runPane !== null) {
		return;
	}

	// Reuse a surviving browser pane, else create it (right of Claude); a failure to
	// capture its surface ref aborts — the run split can't be targeted without it.
	const browserRef = existing.browserPane ?? createBrowserPane(context, cmux);
	if (browserRef === null) {
		return;
	}

	// Create the run terminal (below the browser) ONLY when it did not survive —
	// create-missing-only, never duplicating an existing kit pane.
	if (existing.runPane === null) {
		createRunPane(context, cmux, browserRef);
	}
}

// Create the browser pane (right of Claude), rename it `dobby-browser-<slug>`, and
// return its surface ref (captured from stdout, discovery-diff fallback) — or null
// when the ref can't be resolved.
function createBrowserPane(context: UpContext, cmux: string): string | null {
	const before = listAllSurfaces(context.workroot, cmux);
	const created = runCapture(
		"cmux",
		[
			"new-pane",
			"--workspace",
			cmux,
			"--type",
			"browser",
			...(context.devUrl === null ? [] : ["--url", context.devUrl]),
			"--direction",
			"right",
		],
		{ root: context.workroot },
	);
	const browserRef =
		captureSurfaceRef(created.stdout) ??
		diffNewSurface(before, listAllSurfaces(context.workroot, cmux));
	if (browserRef === null) {
		return null;
	}
	runCapture(
		"cmux",
		["rename-tab", "--surface", browserRef, `dobby-browser-${context.slug}`],
		{
			root: context.workroot,
		},
	);
	return browserRef;
}

// Create the run terminal BELOW the browser via a surface-targeted `new-split down`
// (never focus-dependent), rename it `dobby-run-<slug>`, and send the `dobby dev`
// line. Surface ref captured from stdout with the discovery-diff fallback.
function createRunPane(
	context: UpContext,
	cmux: string,
	browserRef: string,
): void {
	const before = listAllSurfaces(context.workroot, cmux);
	const split = runCapture(
		"cmux",
		["new-split", "down", "--surface", browserRef],
		{
			root: context.workroot,
		},
	);
	const runRef =
		captureSurfaceRef(split.stdout) ??
		diffNewSurface(before, listAllSurfaces(context.workroot, cmux));
	if (runRef === null) {
		return;
	}
	runCapture(
		"cmux",
		["rename-tab", "--surface", runRef, `dobby-run-${context.slug}`],
		{
			root: context.workroot,
		},
	);
	runCapture(
		"cmux",
		[
			"send",
			"--surface",
			runRef,
			`cd ${context.workroot} && ${devStartCommand(context)}\n`,
		],
		{
			root: context.workroot,
		},
	);
}

// The first `surface:<ref>` token in cmux stdout, or null (format runtime-unverified).
function captureSurfaceRef(stdout: string): string | null {
	return /surface:\S+/.exec(stdout)?.[0] ?? null;
}

// Every surface ref in the cmux workspace — the discovery-diff fallback input.
// Tolerant: any failure yields an empty set.
function listAllSurfaces(workroot: string, cmux: string): Set<string> {
	const refs = new Set<string>();
	const panes = runCapture("cmux", ["list-panes", "--workspace", cmux], {
		root: workroot,
	});
	if (panes.status !== 0) {
		return refs;
	}
	for (const line of panes.stdout.split("\n")) {
		const paneRef = /pane:\S+/.exec(line)?.[0];
		if (paneRef === undefined) {
			continue;
		}
		const surfaces = runCapture(
			"cmux",
			["list-pane-surfaces", "--workspace", cmux, "--pane", paneRef],
			{ root: workroot },
		);
		if (surfaces.status !== 0) {
			continue;
		}
		for (const surfaceLine of surfaces.stdout.split("\n")) {
			const ref = /surface:\S+/.exec(surfaceLine)?.[0];
			if (ref !== undefined) {
				refs.add(ref);
			}
		}
	}
	return refs;
}

// The one surface present in `after` but not `before` (the just-created pane).
function diffNewSurface(
	before: Set<string>,
	after: Set<string>,
): string | null {
	for (const ref of after) {
		if (!before.has(ref)) {
			return ref;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Detached start (up, no cmux) — hand `dobby dev` to the OS, keep the handles.
// ---------------------------------------------------------------------------

// Spawn `dobby dev` DETACHED with output to <workroot>/.dobby/dev.log and its pid
// to <workroot>/.dobby/dev.pid (so a later `down` can signal the group), ensuring
// .dobby/ is gitignored. Returns true when the spawn took (pid written), false when
// the spawn failed (no pidfile) so `up` can fail fast instead of waiting on liveness
// for a server that never started. NOT CI-tested.
function startDetached(context: UpContext): boolean {
	const dobbyDir = join(context.workroot, ".dobby");
	mkdirSync(dobbyDir, { recursive: true });
	ensureGitignored(context.workroot, ".dobby/");
	// `--no-share` only when the user opted out; the default shares (inner dev re-probes).
	const devArgs = context.share
		? ["dobby", "dev"]
		: ["dobby", "dev", "--no-share"];
	const pid = spawnBackground("bunx", devArgs, {
		root: context.workroot,
		logPath: join(dobbyDir, "dev.log"),
	});
	if (pid === undefined) {
		return false;
	}
	writeFileSync(join(dobbyDir, "dev.pid"), `${pid}\n`);
	return true;
}

// Append `entry` to <workroot>/.gitignore when absent (idempotent). Best-effort.
function ensureGitignored(workroot: string, entry: string): void {
	const path = join(workroot, ".gitignore");
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// No .gitignore yet — created below.
	}
	const bare = entry.replace(/\/$/, "");
	const present = raw.split("\n").some((line) => {
		const trimmed = line.trim();
		return trimmed === entry || trimmed === bare;
	});
	if (present) {
		return;
	}
	const prefix = raw === "" || raw.endsWith("\n") ? "" : "\n";
	appendFileSync(path, `${prefix}${entry}\n`);
}

// ---------------------------------------------------------------------------
// `dobby down` — teardown: close kit panes, kill the detached run, delete the neon
// branch, run teardown[] extras.
// ---------------------------------------------------------------------------

// One planned `down` action. `run.ts` renders each; `executeDown` performs it.
export type DownAction =
	| { kind: "cmux-close"; browserName: string; runName: string }
	| { kind: "kill-pidfile"; pidRel: string }
	| { kind: "neon-delete"; branch: string; projectId: string }
	| { kind: "extra"; run: string };

// The ordered `down` plan for `--dry-run`.
export interface DownPlan {
	workroot: string;
	slug: string;
	actions: DownAction[];
}

// The outcome of `dobby down`:
//   - `{ ok: false, error }`  — outside a git repo (fail hard).
//   - `{ ok: true, kind: "plan", plan }` — `--dry-run`: the plan to render.
//   - `{ ok: true, kind: "ran", exitCode, failure }` — a real teardown executed
//     (nothing to clean → exit 0 no-op).
export type DownReport =
	| { ok: false; error: string }
	| { ok: true; kind: "plan"; plan: DownPlan }
	| { ok: true; kind: "ran"; exitCode: number; failure: string | null };

// The decisions a real `down` needs (cmux for pane discovery, the neon API key for
// the delete). Derived once, shared with the plan.
interface DownContext {
	workroot: string;
	slug: string;
	cmux: string | null;
	neonApiKey: string | null;
}

// Resolve `down` for the git worktree enclosing `cwd`, then either PLAN
// (`--dry-run`) or execute the teardown. Fails hard outside a git repo. Nothing to
// clean → exit 0 no-op.
export function runDown(cwd: string, opts: { dryRun: boolean }): DownReport {
	let workroot: string;
	try {
		workroot = requireWorkroot(cwd);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const slug = basename(workroot);
	const capabilities = detectCapabilities(cwd);
	const cmux = process.env.CMUX_WORKSPACE_ID || null;
	const loaded = loadConfig(cwd);
	const config = loaded?.ok ? loaded.config : null;
	const neonCreds = capabilities.includes("neon")
		? readNeonCreds(workroot)
		: null;

	const actions: DownAction[] = [];

	// (1) Kit panes (cmux only) — discovered + closed live at execution time.
	if (cmux !== null) {
		actions.push({
			kind: "cmux-close",
			browserName: `dobby-browser-${slug}`,
			runName: `dobby-run-${slug}`,
		});
	}
	// (2) The detached-run pidfile — kill the group, or clean a stale file.
	if (existsSync(join(workroot, ".dobby", "dev.pid"))) {
		actions.push({ kind: "kill-pidfile", pidRel: ".dobby/dev.pid" });
	}
	// (3) Neon branch delete (capability + BOTH creds present; missing → skip).
	if (
		neonCreds !== null &&
		neonCreds.apiKey !== null &&
		neonCreds.projectId !== null
	) {
		actions.push({
			kind: "neon-delete",
			branch: `dobby/${slug}`,
			projectId: neonCreds.projectId,
		});
	}
	// (4) Config teardown[] extras, sequentially.
	for (const extra of config?.teardown ?? []) {
		actions.push({ kind: "extra", run: extra });
	}

	if (opts.dryRun) {
		return { ok: true, kind: "plan", plan: { workroot, slug, actions } };
	}
	const context: DownContext = {
		workroot,
		slug,
		cmux,
		neonApiKey: neonCreds?.apiKey ?? null,
	};
	return { ok: true, kind: "ran", ...executeDown(context, actions) };
}

// Execute a real `down` teardown, best-effort (a failing cleanup step never blocks
// the rest). Only a failing config `teardown[]` extra surfaces in the exit code.
// The pane-close / kill / neon-delete real work is NOT CI-tested.
function executeDown(
	context: DownContext,
	actions: DownAction[],
): { exitCode: number; failure: string | null } {
	let exitCode = 0;
	let failure: string | null = null;

	for (const action of actions) {
		switch (action.kind) {
			case "cmux-close":
				closeKitPanes(context);
				break;
			case "kill-pidfile":
				killFromPidfile(
					join(context.workroot, action.pidRel),
					context.workroot,
				);
				break;
			case "neon-delete":
				deleteNeonBranch(context, action.branch, action.projectId);
				break;
			case "extra": {
				const code = runInherit("sh", ["-c", action.run], {
					root: context.workroot,
				});
				if (code !== 0 && failure === null) {
					exitCode = code;
					failure = `teardown extra failed (exit ${code}): ${action.run}`;
				}
				break;
			}
		}
	}
	return { exitCode, failure };
}

// Discover and close the kit panes (`cmux close-surface --surface <ref>` each).
// Live cmux IPC; a no-op when nothing is discoverable. NOT CI-tested.
function closeKitPanes(context: DownContext): void {
	if (context.cmux === null) {
		return;
	}
	const panes = discoverPanes(context.workroot, context.cmux);
	for (const ref of [panes.browserPane, panes.runPane]) {
		if (ref !== null) {
			runCapture("cmux", ["close-surface", "--surface", ref], {
				root: context.workroot,
			});
		}
	}
}

// Kill the detached run's process GROUP (SIGTERM to -pid) when the pid is still alive
// AND `ownsDetachedRun` confirms both the command-line signature AND the start-time
// (see below); either way remove the pidfile (a stale pid is cleaned up silently). The
// ownership check guards against pid reuse: a recycled pid can pass `isAlive` (EPERM
// counts even another user's process alive), so we never signal a group that isn't ours.
function killFromPidfile(pidPath: string, workroot: string): void {
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	} catch {
		return;
	}
	if (
		Number.isInteger(pid) &&
		isAlive(pid) &&
		ownsDetachedRun(pid, workroot, pidPath)
	) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// The group already vanished — nothing to signal.
		}
	}
	rmSync(pidPath, { force: true });
}

// Whether `pid` names a live process (`kill(pid, 0)`): ESRCH → dead, EPERM → alive
// (exists but unsignalable).
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// Whether `pid` is OUR detached run — requires BOTH (a) the command-line signature
// (`dobby dev`, since it was spawned as `bunx dobby dev`) AND (b) a start-time match:
// the process must have started no later than the pidfile was written (+ tolerance).
// (a) alone is insufficient — the signature matches ANY dobby dev, including another
// worktree's (parallel goals are the kit's normal mode), so a recycled pid now running
// an UNRELATED workspace's dev group would still match. The start-time guard closes
// that: a process that came up AFTER we recorded this pid can't be the one we recorded.
// `ps` is a system tool → bare. Any failure — failed/empty `ps`, a non-matching command,
// an unstat-able pidfile, or an unparseable etime — is treated as NOT ours (the pid is
// stale → signal nothing; the caller still removes the file).
function ownsDetachedRun(
	pid: number,
	workroot: string,
	pidPath: string,
): boolean {
	const command = runCapture("ps", ["-o", "command=", "-p", String(pid)], {
		root: workroot,
	});
	if (
		command.error ||
		command.status !== 0 ||
		!command.stdout.includes("dobby dev")
	) {
		return false;
	}
	// (b) Start-time guard against pid REUSE across worktrees. pidfile mtime ≈ when we
	// recorded the pid; the process's `ps` etime gives its start (now − elapsed). Owned
	// only when the process is no NEWER than the pidfile write, within a 15s tolerance.
	let pidfileMtimeMs: number;
	try {
		pidfileMtimeMs = statSync(pidPath).mtimeMs;
	} catch {
		return false;
	}
	const etime = runCapture("ps", ["-o", "etime=", "-p", String(pid)], {
		root: workroot,
	});
	if (etime.error || etime.status !== 0) {
		return false;
	}
	const elapsedSeconds = parseEtimeSeconds(etime.stdout);
	if (elapsedSeconds === null) {
		return false;
	}
	const processStartMs = Date.now() - elapsedSeconds * 1000;
	const toleranceMs = 15_000;
	return processStartMs <= pidfileMtimeMs + toleranceMs;
}

// Parse `ps -o etime=` elapsed time to whole seconds. Grammar `[[dd-]hh:]mm:ss` (each
// field one-or-more digits; days optional, hours optional). Deterministic — any shape
// outside the grammar returns null (the caller treats that as NOT ours). Pure; kept
// private because the only reachable caller is the kill path, which is a documented
// non-CI boundary (a real matching process can't be conjured through the run() seam).
function parseEtimeSeconds(raw: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
	if (match === null || match[3] === undefined || match[4] === undefined) {
		return null;
	}
	const days = match[1] === undefined ? 0 : Number(match[1]);
	const hours = match[2] === undefined ? 0 : Number(match[2]);
	const minutes = Number(match[3]);
	const seconds = Number(match[4]);
	return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

// Delete the neon isolation branch (a missing branch is idempotently fine). NOT
// CI-tested (needs real neonctl).
function deleteNeonBranch(
	context: DownContext,
	branch: string,
	projectId: string,
): void {
	runCapture(
		"bunx",
		["neonctl", "branches", "delete", branch, "--project-id", projectId],
		{
			root: context.workroot,
			env: { ...process.env, NEON_API_KEY: context.neonApiKey ?? "" },
		},
	);
}

// Read the neon creds (NEON_API_KEY + NEON_PROJECT_ID) from <workroot>/.env.local
// — each dev copies .env.local, so the project id is no longer committed. Either
// missing → null (up fails hard, down skips). Tolerant of an absent/odd file.
function readNeonCreds(workroot: string): {
	apiKey: string | null;
	projectId: string | null;
} {
	const env = parseEnvFile(join(workroot, ".env.local"));
	return {
		apiKey: env.get("NEON_API_KEY") ?? null,
		projectId: env.get("NEON_PROJECT_ID") ?? null,
	};
}

// Parse a `.env`-style file into a KEY→value map (drop blanks/`#` comments, split
// on the first `=`, strip surrounding quotes). Tolerant: an unreadable file → empty.
function parseEnvFile(path: string): Map<string, string> {
	const map = new Map<string, string>();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return map;
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		map.set(key, value);
	}
	return map;
}
