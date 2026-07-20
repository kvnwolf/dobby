import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The single child-process utility every dobby command spawns through. It exists
// to enforce ONE invariant: every child's working directory is pinned to the
// resolved WORKROOT (the git top-level), never the ambient cwd — killing the
// "ran in the wrong checkout" bug class. Resolve the workroot ONCE with
// resolveWorkroot / requireWorkroot, then thread it as `root` into every
// runCapture / runInherit call.
//
// node:child_process ONLY (never Bun.spawn) — vitest imports this under Node
// while Bun runs it in production. spawnSync (never execFileSync) so a nonzero
// child exit or a missing binary comes back as DATA, never a throw: `env` must
// never fail because a tool (portless, cmux) is absent.

export interface RunResult {
	// The child's exit code, or null when it was killed by a signal or never
	// started (a missing binary — `error` is then set). Callers treat anything
	// other than 0 as failure.
	status: number | null;
	stdout: string;
	stderr: string;
	// Set when the process could not be spawned at all (ENOENT for a missing
	// binary, etc.); callers fold this into the same failure path as status != 0.
	error?: Error;
}

export interface RunOptions {
	// The resolved workroot; the child's cwd is pinned HERE, never the ambient cwd.
	root: string;
	// Optional stdin payload (e.g. a PostToolUse hook body). Omitted -> stdin ignored.
	input?: string;
	// Optional env overrides; omitted -> the child inherits process.env.
	env?: NodeJS.ProcessEnv;
}

// Resolve the enclosing git worktree root for `cwd`: `git rev-parse
// --show-toplevel`, run FROM `cwd`. This is the ONE call that legitimately reads
// the ambient directory — it is HOW the workroot is discovered; every subsequent
// spawn pins to the result. Returns the top-level path, or null outside a git
// repo / when git is absent. Never throws.
export function resolveWorkroot(cwd: string): string | null {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.error || result.status !== 0) {
		return null;
	}
	const top = (result.stdout ?? "").trim();
	return top === "" ? null : top;
}

/**
 * Resolve the workroot or FAIL HARD. Action commands (dev/up/down/db:*)
 * call this: running them outside a git repo is a hard error with a clear
 * message, never a silent ambient-cwd fallback. `env` is the deliberate
 * exception — it calls resolveWorkroot and degrades to null instead of failing.
 *
 * @public — runner surface consumed by the action commands
 * (up/down/dev).
 */
export function requireWorkroot(cwd: string): string {
	const root = resolveWorkroot(cwd);
	if (root === null) {
		throw new Error(
			"dobby must run inside a git repository — no git worktree found for the current directory",
		);
	}
	return root;
}

// ---------------------------------------------------------------------------
// Bin resolution — the ONE resolver every dobby tool spawn goes through.
//
// The whole point of BUNDLING (portless, biome, tsc, knip, taze as dobby's own
// dependencies) is zero reliance on globals: a bundled tool ALWAYS prefers
// dobby's OWN dependency tree, so it resolves even when it is not on PATH — the
// field bug was `env` spawning a BARE `portless` that was off PATH and failed.
// A CONSUMER tool (vite, vitest, drizzle-kit, email) ALWAYS prefers the
// consumer's own node_modules/.bin — never a global that may version-skew with
// the project. In BOTH scopes the bare PATH name is only a last-resort fallback,
// never the first choice.
//
// The returned path is directly spawnable: an absolute `node_modules/.bin/<name>`
// shim (or a package's `bin` JS entry, from the require.resolve fallback), or the
// bare `name` when nothing was found. Callers spawn it directly, or via
// process.execPath for the bundled JS CLIs (bun runs the resolved file).
// ---------------------------------------------------------------------------

// Which dependency tree a tool is resolved from.
type BinScope = "bundled" | "consumer";

// This module's own on-disk directory — the starting point for the bundled walk.
// Derived from import.meta.url so it points at dobby's OWN install location
// wherever dobby is installed (this repo's `cli/src`, or a consumer's
// `node_modules/@kvnwolf/dobby/...`).
const runnerDir = dirname(fileURLToPath(import.meta.url));
const requireFromRunner = createRequire(import.meta.url);

// The npm package shipping each bundled bin (bin name -> package), for the
// require.resolve fallback when the node_modules/.bin walk finds nothing. The bin
// name and package name differ for some tools (`biome` <- @biomejs/biome,
// `tsc` <- typescript), so the map is explicit.
const BUNDLED_PACKAGES: Record<string, string> = {
	portless: "portless",
	biome: "@biomejs/biome",
	tsc: "typescript",
	knip: "knip",
	taze: "taze",
};

/**
 * Resolve a tool binary to a spawnable path, preferring the OWNING dependency
 * tree over PATH (which is only a last-resort fallback in both scopes):
 *   - `bundled` — dobby's OWN tree: walk `node_modules/.bin/<name>` upward from
 *     this module's location (handles both nested and hoisted install layouts),
 *     then a require.resolve fallback on the shipping package, then the bare name.
 *     PATH-independent — never a `which`-style lookup.
 *   - `consumer` — `<root>/node_modules/.bin/<name>` when present, else the bare
 *     name (the documented fallback so a missing consumer tool surfaces at spawn).
 *
 * @public — the single resolver every tool spawn routes through (envinfo devUrl,
 * lifecycle dev/db/up-down/update); system tools (git, curl, cmux, sh, bunx) stay
 * bare by design and never call this.
 */
export function resolveBin(
	name: string,
	opts: { scope: BinScope; root?: string },
): string {
	if (opts.scope === "consumer") {
		if (opts.root !== undefined) {
			const local = join(opts.root, "node_modules", ".bin", name);
			if (existsSync(local)) {
				return local;
			}
		}
		return name;
	}
	return resolveBundledBin(name);
}

// Walk `node_modules/.bin/<name>` from the runner's directory up to the
// filesystem root, returning the first hit. Climbing PAST each `node_modules`
// segment to its parent is what finds a HOISTED tool (a consumer's top-level
// node_modules/.bin) as well as a NESTED one (dobby's own). A require.resolve
// fallback covers install modes where `.bin` was not materialized; the bare name
// is the final fallback.
function resolveBundledBin(name: string): string {
	let dir = runnerDir;
	for (let depth = 0; depth < 24; depth++) {
		const candidate = join(dir, "node_modules", ".bin", name);
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	const pkg = BUNDLED_PACKAGES[name];
	if (pkg !== undefined) {
		const entry = bundledPackageBin(pkg, name);
		if (entry !== null) {
			return entry;
		}
	}
	return name;
}

// The `bin` JS entry of a bundled package, resolved via dobby's own require
// (version-robust — read from the package.json `bin` field, no hard-coded path).
// Null when the package or the named bin can't be resolved.
function bundledPackageBin(pkg: string, binName: string): string | null {
	let pkgJsonPath: string;
	try {
		pkgJsonPath = requireFromRunner.resolve(`${pkg}/package.json`);
	} catch {
		return null;
	}
	try {
		const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const bin = manifest.bin;
		const rel = typeof bin === "string" ? bin : bin?.[binName];
		return rel === undefined ? null : join(dirname(pkgJsonPath), rel);
	} catch {
		return null;
	}
}

// Run a child process CAPTURING stdout/stderr, cwd pinned to opts.root. Never
// throws: a nonzero exit or a missing binary is returned in RunResult. Used for
// the finite, output-parsed spawns (git facts, `portless get`, `cmux list-*`).
export function runCapture(
	cmd: string,
	args: string[],
	opts: RunOptions,
): RunResult {
	const result = spawnSync(cmd, args, {
		cwd: opts.root,
		encoding: "utf8",
		input: opts.input,
		env: opts.env,
		stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
}

/**
 * Run a child process INHERITING the parent's stdio (streaming straight to the
 * terminal), cwd pinned to opts.root. Returns the child's exit code (1 when it
 * could not be spawned). For long-running / interactive children (dev, db:studio)
 * where capturing output would defeat the purpose.
 *
 * @public — runner surface consumed by the streaming action commands
 * (dev/up).
 */
export function runInherit(
	cmd: string,
	args: string[],
	opts: RunOptions,
): number {
	const result = spawnSync(cmd, args, {
		cwd: opts.root,
		stdio: "inherit",
		env: opts.env,
	});
	return result.status ?? 1;
}

/**
 * Spawn a long-running child DETACHED (its own process group) with INHERITED
 * stdio, cwd pinned to opts.root. Returns the live ChildProcess so the caller can
 * manage the GROUP as a unit — wait for exit, forward signals, and tear it down
 * with `process.kill(-child.pid, …)` (the negative pid targets the whole group, so
 * the child AND its descendants die together, no orphans). The ASYNC streaming
 * counterpart to runInherit: for the managed `dobby dev` group (portless-wrapped
 * main + concurrent secondaries) that spawnSync cannot supervise concurrently.
 *
 * node:child_process `spawn` (never Bun.spawn), same as the rest of the runner.
 *
 * @public — consumed by the streaming `dev` executor in `lifecycle.ts`.
 */
export function spawnDetached(
	cmd: string,
	args: string[],
	opts: RunOptions,
): ChildProcess {
	return spawn(cmd, args, {
		cwd: opts.root,
		stdio: "inherit",
		detached: true,
		env: opts.env,
	});
}

/**
 * Spawn a BACKGROUND child that OUTLIVES dobby: DETACHED (its own process group),
 * cwd pinned to opts.root, stdio redirected to `logPath` (append), and `unref`d so
 * the parent can exit while the child keeps running. Returns the child's pid (the
 * caller writes it to a pidfile so a later `down` can signal the group) or undefined
 * when the spawn failed. The non-supervised counterpart to `spawnDetached`: `up`'s
 * plain-terminal start (`dobby dev` with no cmux to own it) hands the process to the
 * OS and walks away — the pidfile + log are the only handles. node:child_process
 * `spawn` (never Bun.spawn).
 *
 * @public — consumed by the `up` detached-start path in `lifecycle.ts`.
 */
export function spawnBackground(
	cmd: string,
	args: string[],
	opts: { root: string; logPath: string },
): number | undefined {
	const out = openSync(opts.logPath, "a");
	try {
		const child = spawn(cmd, args, {
			cwd: opts.root,
			detached: true,
			stdio: ["ignore", out, out],
		});
		child.unref();
		return child.pid;
	} finally {
		// The child dup'd its own descriptor for the log; the parent's is done with.
		closeSync(out);
	}
}
