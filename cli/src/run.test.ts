import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pkg from "../package.json";
import { run } from "./run.ts";

// Fixture paths are anchored to THIS test file's location (never process.cwd()),
// so `run(["env"], cwd)` reads a stable, hand-written sample project. The
// `__fixtures__` dir sits beside `src/`, so we climb one level out of `src/`.
const fixturesDir = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../__fixtures__",
);
const fixture = (name: string) => resolve(fixturesDir, name);

// The seam under test: run(argv, cwd) -> { exitCode, stdout, stderr }, exercised
// IN-PROCESS. The dispatch-seam block below (bare / version / unknown / malformed)
// never touches the filesystem, so `cwd` is irrelevant there and any path serves.
//
// Independent sources for every expected value in the dispatch-seam block:
//  - "Usage: dobby", "unknown command: <X>", and the upgrade-hint sentence are
//    literals named by the spec.
//  - The --version output is the version field of the package the spec points to
//    (`../package.json`), read here purely as data — never recomputed by run().
const cwd = process.cwd();

// The exact upgrade-hint line the spec requires as the SECOND line of every
// unknown-command error (a literal, not derived from any code path).
const upgradeHint =
	"if this command is expected, run `bun update @kvnwolf/dobby`";

describe("run() — CLI dispatch seam", () => {
	describe("bare invocation (no arguments)", () => {
		it("prints usage on stdout (first line begins 'Usage: dobby'), exits 0, empty stderr", async () => {
			const result = await run([], cwd);
			expect(result.stdout.startsWith("Usage: dobby")).toBe(true);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
		});

		it("advertises the 'env' command in the usage text", async () => {
			// The `capabilities` command is deleted this task and `env` takes its slot,
			// so the usage Commands block must list `env` (a line indented then `env`).
			const result = await run([], cwd);
			const advertisesEnv = result.stdout
				.split("\n")
				.some((line) => /^\s+env\b/.test(line));
			expect(advertisesEnv).toBe(true);
		});
	});

	describe("version flag", () => {
		it("prints the package version plus a single trailing newline, exits 0, empty stderr", async () => {
			const result = await run(["--version"], cwd);
			expect(result.stdout).toBe(`${pkg.version}\n`);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
		});

		it("treats the short flag -v identically to --version", async () => {
			const result = await run(["-v"], cwd);
			expect(result.stdout).toBe(`${pkg.version}\n`);
			expect(result.exitCode).toBe(0);
		});
	});

	describe("unknown subcommand", () => {
		it("errors to stderr with the command name, the usage text, and the upgrade hint, exits 1, empty stdout", async () => {
			const result = await run(["frobnicate"], cwd);
			expect(result.stderr).toContain("unknown command: frobnicate");
			expect(result.stderr).toContain("Usage: dobby");
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
		});

		it("appends the 'bun update @kvnwolf/dobby' upgrade hint as a second line on unknown commands", async () => {
			const result = await run(["frobnicate"], cwd);
			expect(result.stderr).toContain(upgradeHint);
		});
	});

	describe("malformed flags (parseArgs strict)", () => {
		it("catches the parse error: the message precedes the usage on stderr, exits 1, empty stdout", async () => {
			const result = await run(["--nope"], cwd);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Usage: dobby");
			// Spec order is "parse error message + usage": usage is present but is NOT
			// the first thing on stderr — the error message precedes it.
			expect(result.stderr.startsWith("Usage: dobby")).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// Test helpers for the `env` command.
//
// `env` reports git facts (worktree root, branch) and the CMUX_WORKSPACE_ID env
// var. A committed fixture cannot carry its own `.git` (git refuses nested
// repos), so the git-dependent slices build a THROWAWAY real git repo in a temp
// dir at runtime — a boundary (filesystem/process) we own, giving KNOWN literals
// (a branch name and root path WE chose) as independent expected values. The
// pure capability-detection slices keep using committed on-disk fixtures.
// ---------------------------------------------------------------------------

const CMUX = "CMUX_WORKSPACE_ID";
const scratchDirs: string[] = [];

// Isolate repo creation from ambient git config (gpg signing, hooks, templates,
// identity) so a commit always succeeds regardless of the developer's setup.
const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "dobby-test",
	GIT_AUTHOR_EMAIL: "test@dobby.invalid",
	GIT_COMMITTER_NAME: "dobby-test",
	GIT_COMMITTER_EMAIL: "test@dobby.invalid",
};

// Build a real git repo in a fresh temp dir on a KNOWN branch, optionally with a
// package.json and a (valid or deliberately broken) dobby.config.json. Returns
// the repo root. Registered for cleanup in afterAll.
function makeGitRepo(
	branch: string,
	opts: { pkg?: unknown; config?: unknown; brokenConfig?: boolean } = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "dobby-env-git-"));
	scratchDirs.push(dir);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv });

	git("init", "-q");
	git("checkout", "-q", "-b", branch);
	writeFileSync(join(dir, "README"), "scratch\n");
	if (opts.pkg !== undefined) {
		writeFileSync(join(dir, "package.json"), JSON.stringify(opts.pkg, null, 2));
	}
	if (opts.brokenConfig) {
		writeFileSync(join(dir, "dobby.config.json"), "{ this is not valid json");
	} else if (opts.config !== undefined) {
		writeFileSync(
			join(dir, "dobby.config.json"),
			JSON.stringify(opts.config, null, 2),
		);
	}
	git("add", "-A");
	git("commit", "-q", "-m", "scratch");
	return dir;
}

// A plain temp dir that is NOT a git repo and has no package.json/config — the
// "outside a project" case where every resolvable fact must degrade to null.
function makeNonGitDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dobby-env-plain-"));
	scratchDirs.push(dir);
	return dir;
}

// Parse `key: value` text output into a map (values are raw strings, e.g. the
// literal text "null"). Splitting on the FIRST colon is safe: none of the field
// values (paths, ids, "none", "null", "true"/"false") contain a leading colon.
function parseEnvText(stdout: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return map;
}

// The detected capabilities as a sorted array (order-independent): the spec
// defines the capabilities `env` reports as a "comma-separated list or none" but
// does NOT fix their order, so tests assert the SET, never a sequence.
function capsSet(stdout: string): string[] {
	const value = parseEnvText(stdout).capabilities;
	if (value === undefined || value === "none") return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.sort();
}

// run(["env"], cwd) — the environment snapshot. Every expected value is an
// INDEPENDENT source: cmux ids and branch names are literals WE injected, the
// worktree root is the temp dir WE created (normalized via node:fs realpath, a
// different mechanism than the git call the code makes), config true/false and
// devUrl null are the spec's literal contract, and capability names come from
// the spec's fixed signal map applied to hand-written fixtures.
describe("run() — env command (environment snapshot)", () => {
	// A complete project: a git repo on a known branch, a package.json declaring
	// two signals (drizzle, vitest), and a valid dobby.config.json at its root.
	let gitProject: string;
	// A git repo with NO dobby.config.json — worktree resolves, config is false.
	let gitNoConfig: string;
	// A git repo whose dobby.config.json is unparseable — env tolerates it (false).
	let gitBrokenConfig: string;
	// Not a git repo, no package.json — every resolvable fact degrades to null.
	let nonGitDir: string;

	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		gitProject = makeGitRepo("dobby-env-test", {
			pkg: {
				name: "scratch-project",
				dependencies: { "drizzle-orm": "^0.30.0" },
				devDependencies: { vitest: "^2.0.0" },
			},
			config: { files: [] },
		});
		gitNoConfig = makeGitRepo("dobby-noconfig", {
			pkg: { name: "scratch-noconfig" },
		});
		gitBrokenConfig = makeGitRepo("dobby-broken", {
			pkg: { name: "scratch-broken" },
			brokenConfig: true,
		});
		nonGitDir = makeNonGitDir();
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const dir of scratchDirs)
			rmSync(dir, { recursive: true, force: true });
	});

	// Baseline: no cmux unless a test opts in, isolating from an ambient cmux pane.
	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("exits 0 and prints all six snapshot fields as `key: value` lines", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		for (const key of [
			"cmux",
			"worktree",
			"branch",
			"capabilities",
			"config",
			"devUrl",
		]) {
			expect(env[key], `missing field: ${key}`).toBeDefined();
		}
	});

	it("reports cmux as the CMUX_WORKSPACE_ID value when the variable is set", async () => {
		process.env[CMUX] = "cmux-ws-abc123";
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).cmux).toBe("cmux-ws-abc123");
	});

	it("reports cmux as null when CMUX_WORKSPACE_ID is not set", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).cmux).toBe("null");
	});

	it("reports worktree as the enclosing git repo root", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).worktree).toBe(realpathSync(gitProject));
	});

	it("reports branch as the current git branch", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).branch).toBe("dobby-env-test");
	});

	it("reports config true when a valid dobby.config.json exists at the root", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).config).toBe("true");
	});

	it("reports config false when no dobby.config.json exists (worktree still resolves)", async () => {
		const result = await run(["env"], gitNoConfig);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		expect(env.config).toBe("false");
		// Discriminator: this is a real git repo, so worktree is NON-null — only
		// config is false, proving config is a distinct fact from the git facts.
		expect(env.worktree).toBe(realpathSync(gitNoConfig));
	});

	it("reports config false when dobby.config.json exists but is unparseable (never fails)", async () => {
		const result = await run(["env"], gitBrokenConfig);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).config).toBe("false");
	});

	it("reports devUrl as null in this task", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).devUrl).toBe("null");
	});

	it("exits 0 outside a git repo and with no package.json (never fails)", async () => {
		const result = await run(["env"], nonGitDir);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("reports worktree and branch as null outside a git repo", async () => {
		const result = await run(["env"], nonGitDir);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		expect(env.worktree).toBe("null");
		expect(env.branch).toBe("null");
	});

	it("reports capabilities as none and config false in a bare non-project dir", async () => {
		const result = await run(["env"], nonGitDir);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		expect(env.capabilities).toBe("none");
		expect(env.config).toBe("false");
	});
});

// run(["env", "--json"], cwd) — the same facts as one JSON object.
//
// SPEC-AMBIGUITY DECISION (flagged in the work log): the spec says --json prints
// "the same as one JSON object" but does not fix the JSON types. For a
// skill-consumable object the idiomatic shape is asserted here: string-or-null
// scalars, a capabilities ARRAY, and a boolean config. If the product wants a
// different shape a human must adjust these assertions.
describe("run() — env command (--json)", () => {
	let gitProject: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		gitProject = makeGitRepo("dobby-env-json", {
			pkg: {
				name: "scratch-json",
				dependencies: { "drizzle-orm": "^0.30.0" },
				devDependencies: { vitest: "^2.0.0" },
			},
			config: { files: [] },
		});
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		// gitProject is registered in the shared scratchDirs list, cleaned above.
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("emits one parseable JSON object, exit 0", async () => {
		const result = await run(["env", "--json"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	it("carries the scalar facts (cmux, worktree, branch, devUrl) with JSON null for the absent ones", async () => {
		process.env[CMUX] = "cmux-ws-json";
		const result = await run(["env", "--json"], gitProject);
		expect(result.exitCode).toBe(0);
		const env = JSON.parse(result.stdout);
		expect(env.cmux).toBe("cmux-ws-json");
		expect(env.worktree).toBe(realpathSync(gitProject));
		expect(env.branch).toBe("dobby-env-json");
		expect(env.devUrl).toBe(null);
	});

	it("carries config as a JSON boolean", async () => {
		const result = await run(["env", "--json"], gitProject);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).config).toBe(true);
	});

	it("carries capabilities as a JSON array of the detected capability names", async () => {
		const result = await run(["env", "--json"], gitProject);
		expect(result.exitCode).toBe(0);
		const env = JSON.parse(result.stdout);
		expect(Array.isArray(env.capabilities)).toBe(true);
		expect([...env.capabilities].sort()).toEqual(["drizzle", "vitest"]);
	});
});

// run(["env"], cwd) — capability detection catalog (task 1b).
//
// Detection is observed ONLY through env's `capabilities:` line (env is flat,
// single-package; monorepo grouping is out of scope for v1). Every expected
// capability comes from the spec's fixed signal map applied to a hand-written
// __fixtures__/<name>/package.json this suite ships — never recomputed by the
// detector. Order is unspecified by the spec, so assertions compare SETS.
describe("run() — env command (capability detection)", () => {
	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("detects the surviving catalog across dependencies AND devDependencies, and NEVER convex", async () => {
		// env-many declares, split across deps/devDeps: react, convex (a REMOVED
		// signal), @neondatabase/serverless, drizzle-orm (deps) and vite, vitest,
		// @react-email/components (devDeps). Expected SET pins the deps-union-devDeps
		// rule and the six SURVIVING signals — and, because the fixture DECLARES a
		// convex dependency yet `convex` is NOT in the expected set, it doubles as the
		// convex-removal proof within a rich multi-signal project (the `convex` and
		// `supabase-local` signals were deleted this task).
		const result = await run(["env"], fixture("env-many"));
		expect(result.exitCode).toBe(0);
		expect(capsSet(result.stdout)).toEqual([
			"drizzle",
			"neon",
			"react",
			"react-email",
			"vite",
			"vitest",
		]);
	});

	it("no longer detects supabase-local from the 'supabase' dependency OR a supabase/ directory (signal removed)", async () => {
		// env-removed-signals DECLARES a `supabase` dependency AND carries a
		// `supabase/` directory (both halves of the deleted signal) alongside a single
		// SURVIVING signal (`react`). The expected set is exactly `["react"]`: neither
		// the supabase dep nor the supabase/ dir contributes a capability now that the
		// signal is deleted. If either still fired, `supabase-local` would appear and
		// this would fail — so it pins the removal of BOTH supabase signal forms.
		const result = await run(["env"], fixture("env-removed-signals"));
		expect(result.exitCode).toBe(0);
		expect(capsSet(result.stdout)).toEqual(["react"]);
	});

	it("no longer detects convex from the 'convex' dependency (signal removed)", async () => {
		// env-removed-signals also declares a `convex` dependency; it must NOT surface
		// as a capability. Asserting the whole set is `["react"]` above already implies
		// this, but this focused assertion makes the convex-removal contract explicit.
		const result = await run(["env"], fixture("env-removed-signals"));
		expect(result.exitCode).toBe(0);
		expect(capsSet(result.stdout)).not.toContain("convex");
	});

	it("detects drizzle from the 'drizzle-kit' dependency (the alternate drizzle form)", async () => {
		const result = await run(["env"], fixture("env-drizzle-kit"));
		expect(result.exitCode).toBe(0);
		expect(capsSet(result.stdout)).toEqual(["drizzle"]);
	});

	it("detects react-email from the plain 'react-email' dependency, without also flagging react", async () => {
		// Discriminator: the exact-name `react` signal must NOT match "react-email".
		const result = await run(["env"], fixture("env-react-email-plain"));
		expect(result.exitCode).toBe(0);
		expect(capsSet(result.stdout)).toEqual(["react-email"]);
	});

	it("still detects the existing vite/tanstack-start/neon signals", async () => {
		// Regression: the pre-existing catalog must survive the expansion.
		const result = await run(["env"], fixture("tanstack-app"));
		expect(result.exitCode).toBe(0);
		expect(capsSet(result.stdout)).toEqual(["neon", "tanstack-start", "vite"]);
	});

	it("still detects the existing expo signal", async () => {
		const result = await run(["env"], fixture("expo-app"));
		expect(result.exitCode).toBe(0);
		expect(capsSet(result.stdout)).toEqual(["expo"]);
	});

	it("reports none when a valid package.json declares no matching signals", async () => {
		const result = await run(["env"], fixture("empty-pkg"));
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).capabilities).toBe("none");
	});

	it("never reads peerDependencies: signals present only there yield none", async () => {
		// peer-only declares vite + expo ONLY in peerDependencies.
		const result = await run(["env"], fixture("peer-only"));
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).capabilities).toBe("none");
	});

	it("tolerates a missing package.json: capabilities none, exit 0 (env never fails)", async () => {
		// Contrast with the deleted `capabilities` command, which exited 1 here.
		const result = await run(["env"], fixture("no-pkg"));
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).capabilities).toBe("none");
	});

	it("tolerates an unparseable package.json: capabilities none, exit 0 (env never fails)", async () => {
		const result = await run(["env"], fixture("broken-json"));
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).capabilities).toBe("none");
	});
});

// The `capabilities` command is DELETED this task; `env` replaces it. Its old
// invocation must now fall through to the unknown-command path (exit 1, usage,
// upgrade hint). Expected substrings are the spec's literal wording.
describe("run() — capabilities command is removed", () => {
	it("treats `capabilities` as an unknown command (exit 1, names it, empty stdout)", async () => {
		const result = await run(["capabilities"], cwd);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("unknown command: capabilities");
	});

	it("includes the upgrade hint when the removed `capabilities` command is invoked", async () => {
		const result = await run(["capabilities"], cwd);
		expect(result.stderr).toContain(upgradeHint);
	});
});

// ===========================================================================
// TASK 2 — Workroot runner + devUrl + pane refs (env complete).
//
// Everything below is observed ONLY through the run(["env"], cwd) seam (the
// task constraint: "Tests via run() + fixtures only"). The runner (resolveWorkroot
// / runCapture / runInherit) is never imported directly; its behavior surfaces
// as the env snapshot's resolved worktree, devUrl, and pane fields.
//
// The environment these tests assume (the task constraint): CI/tests have NO
// portless and NO cmux binary reachable for a real project — so devUrl and the
// pane refs must resolve to null, and env must STILL exit 0. Expected values are
// independent: the repo root and subdir are paths WE create (normalized via
// node:fs realpath — a different mechanism than the runner's git call); the
// null contract for devUrl/panes is the spec's literal wording; the vite
// capability that gates devUrl comes from the spec's fixed signal map applied to
// a hand-written package.json this suite writes.
// ===========================================================================

// --- Slice 1 (tracer bullet): workroot pinning ----------------------------
// The headline invariant of this task — "workroot pinning kills the
// run-in-main-checkout bug class." Observed through env: run from a NESTED
// SUBDIRECTORY of a git repo, the snapshot must report the repo ROOT (the git
// top-level), never the ambient subdir. A runner that resolved to the passed
// (ambient) cwd instead of `git rev-parse --show-toplevel` would report the
// subdir here and fail this slice.
describe("run() — env command (workroot resolved from a nested subdirectory)", () => {
	let gitRoot: string;
	let nestedSubdir: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		gitRoot = makeGitRepo("dobby-workroot", {
			pkg: { name: "scratch-workroot" },
		});
		// Two levels deep — the runner must climb to the git top-level regardless.
		nestedSubdir = join(gitRoot, "packages", "inner");
		mkdirSync(nestedSubdir, { recursive: true });
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		rmSync(gitRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("reports the git repo ROOT as the worktree when env runs from a nested subdirectory", async () => {
		const result = await run(["env"], nestedSubdir);
		expect(result.exitCode).toBe(0);
		// Independent expected value: the root WE created, not the subdir we invoked from.
		expect(parseEnvText(result.stdout).worktree).toBe(realpathSync(gitRoot));
	});

	it("reports the same resolved workroot in --json when run from a nested subdirectory", async () => {
		const result = await run(["env", "--json"], nestedSubdir);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).worktree).toBe(realpathSync(gitRoot));
	});

	it("still exits 0 with a null worktree when the subdirectory is not inside any git repo", async () => {
		// A subdir of a plain (non-git) temp dir — resolveWorkroot must yield null,
		// and env (the snapshot exception) must never fail on that.
		const plainRoot = makeNonGitDir();
		const plainSub = join(plainRoot, "nested");
		mkdirSync(plainSub, { recursive: true });
		const result = await run(["env"], plainSub);
		expect(result.exitCode).toBe(0);
		expect(parseEnvText(result.stdout).worktree).toBe("null");
	});
});

// --- Slice 2: kit pane refs (the clearest NEW-field signal) ----------------
// Task 1 had NO pane fields at all; this task adds runPane/browserPane. Under
// cmux they are discovered by surface title (dobby-run-<slug> / dobby-browser-<slug>,
// slug = workroot basename); with no cmux workspace, or when the cmux binary/panes
// can't be reached (the CI/test condition), they degrade to null while env stays
// exit 0.
describe("run() — env command (kit pane refs)", () => {
	let gitProject: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		gitProject = makeGitRepo("dobby-panes", { pkg: { name: "scratch-panes" } });
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		rmSync(gitProject, { recursive: true, force: true });
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("exposes runPane and browserPane fields in the snapshot", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		expect(env.runPane, "missing field: runPane").toBeDefined();
		expect(env.browserPane, "missing field: browserPane").toBeDefined();
	});

	it("reports runPane and browserPane as null when CMUX_WORKSPACE_ID is unset", async () => {
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		expect(env.runPane).toBe("null");
		expect(env.browserPane).toBe("null");
	});

	it("degrades pane refs to null and still exits 0 when cmux is set but no matching panes are reachable", async () => {
		// CMUX_WORKSPACE_ID present but no reachable cmux surface for this repo's
		// unique basename (the CI/test condition: no cmux) — every failure of the
		// `cmux list-panes` / `cmux list-pane-surfaces` discovery must fold to null,
		// never a nonzero exit.
		process.env[CMUX] = "cmux-ws-nonexistent-xyz";
		const result = await run(["env"], gitProject);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		expect(env.runPane).toBe("null");
		expect(env.browserPane).toBe("null");
	});

	it("carries runPane and browserPane as JSON null in --json output", async () => {
		const result = await run(["env", "--json"], gitProject);
		expect(result.exitCode).toBe(0);
		const env = JSON.parse(result.stdout);
		expect(env.runPane).toBe(null);
		expect(env.browserPane).toBe(null);
	});
});

// --- Slice 3: devUrl (portless resolution via dobby's BUNDLED portless) -----
// UPDATED by the bundled-first-resolution task: devUrl is RESOLVED for a vite
// project via `portless get <name>` run through dobby's OWN bundled portless (a
// declared CLI dependency) — so it resolves even when portless is NOT on PATH.
// That is the field-bug fix: the bug was a null devUrl in a vite worktree
// (`portless` was spawned bare, off PATH, and failed). The two vite-project
// slices below therefore now assert a RESOLVED URL, not null (they were written
// under the now-invalidated assumption "CI has no portless"). `portless get` is
// deterministic and daemon-free: for a plain (non-worktree) project named
// `scratch-vite` it yields `https://scratch-vite.localhost` (verified
// out-of-band against the bundled portless — a DIFFERENT mechanism than the env
// code, which resolves the bin then parses portless's stdout). A project WITHOUT
// the vite capability never attempts resolution → still null.
describe("run() — env command (devUrl resolution)", () => {
	let gitVite: string;
	let gitNoVite: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		gitVite = makeGitRepo("dobby-vite", {
			pkg: { name: "scratch-vite", dependencies: { vite: "^5.0.0" } },
		});
		gitNoVite = makeGitRepo("dobby-novite", {
			pkg: { name: "scratch-novite" },
		});
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		rmSync(gitVite, { recursive: true, force: true });
		rmSync(gitNoVite, { recursive: true, force: true });
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("resolves devUrl via the bundled portless when the vite capability is present (field-bug fix: portless need not be on PATH)", async () => {
		const result = await run(["env"], gitVite);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		// The vite capability IS detected (independent fact) — so devUrl resolution
		// is genuinely attempted here, and it SUCCEEDS via dobby's bundled portless
		// (the field bug was exactly a null devUrl in a vite worktree).
		expect(capsSet(result.stdout)).toContain("vite");
		expect(env.devUrl).not.toBe("null");
		// The resolved URL carries the project name (`portless get <name>`, name =
		// the package.json name `scratch-vite`) and is an https URL.
		expect(env.devUrl).toContain("scratch-vite");
		expect(env.devUrl).toMatch(/^https:\/\//);
	}, 20000);

	it("reports devUrl as null for a project WITHOUT the vite capability (resolution never attempted)", async () => {
		const result = await run(["env"], gitNoVite);
		expect(result.exitCode).toBe(0);
		const env = parseEnvText(result.stdout);
		expect(env.capabilities).toBe("none");
		expect(env.devUrl).toBe("null");
	});

	it("carries the resolved devUrl (not null) in --json when the vite capability is present", async () => {
		const result = await run(["env", "--json"], gitVite);
		expect(result.exitCode).toBe(0);
		const devUrl = JSON.parse(result.stdout).devUrl;
		expect(devUrl).not.toBe(null);
		expect(devUrl).toContain("scratch-vite");
	}, 20000);
});

// ===========================================================================
// TASK 3 — Presets + `dobby check` core (biome + tsc).
//
// Two independent deliverables, tested through their OWN observable surfaces:
//   (A) `dobby check` — the quality gate — observed ONLY through the run(argv,
//       cwd) seam, running the REAL biome + tsc against a throwaway git repo we
//       build at runtime. (A committed __fixtures__ dir would resolve its git
//       workroot to THIS repo, so `check` would scan all of dobby — the env
//       tests set the same precedent: build a real git repo in a temp dir.)
//   (B) The exported presets (tsconfig.base.json, biome/core.jsonc,
//       biome/react.jsonc) + their package.json `exports` — read as files.
//
// Independent sources for every expected value below:
//   - The lint finding (lintbad.ts line 2) and type finding (typebad.ts line 1)
//     come from HAND-WRITTEN sources whose offending token sits on a line WE
//     chose — never recomputed by the tool or the code under test. biome's
//     `noDoubleEquals` (suspicious group) fires on `==`; tsc's TS2322 fires on a
//     number <- string assignment. We assert dobby's REFORMATTED `file:line`
//     output, so we depend on neither tool's exact message wording nor its JSON.
//   - Preset targets, extends strings, tsconfig flags, and the bin entry are
//     LITERALS the spec states outright.
// ===========================================================================

// The cli/ package root, anchored to this test file (never process.cwd()).
const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = (rel: string) => resolve(cliDir, rel);

// Read a preset asset, tolerating absence so a not-yet-created deliverable fails
// as a clean assertion ("" never matches the expected content) rather than a
// thrown ENOENT.
const safeRead = (rel: string) =>
	existsSync(cliFile(rel)) ? readFileSync(cliFile(rel), "utf8") : "";

// The cli/package.json manifest, re-read at runtime (not the static import) so
// edits by the implementor are reflected.
function readCliManifest(): {
	exports?: Record<string, unknown>;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	files?: string[];
} {
	return JSON.parse(readFileSync(cliFile("package.json"), "utf8"));
}

// Build a THROWAWAY git repo carrying a biome.jsonc (ONE explicit lint rule, so
// the only possible biome finding is noDoubleEquals — a JS rule that cannot fire
// on the JSON config files or on the type-error file), a strict tsconfig.json,
// and the given `src/*` sources. `dobby check` resolves biome + tsc from dobby's
// OWN node_modules (consumers install nothing) and pins cwd to this repo (its git
// workroot). A git-init is enough — `git rev-parse --show-toplevel` resolves the
// workroot with no commit. Returns the repo root.
function makeCheckRepo(srcFiles: Record<string, string>): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-check-")));
	execFileSync("git", ["init", "-q"], {
		cwd: dir,
		stdio: "ignore",
		env: gitEnv,
	});
	writeFileSync(
		join(dir, "biome.jsonc"),
		JSON.stringify(
			{
				formatter: { enabled: false },
				assist: { enabled: false },
				linter: {
					enabled: true,
					rules: {
						recommended: false,
						suspicious: { noDoubleEquals: "error" },
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
				include: ["src"],
			},
			null,
			2,
		),
	);
	for (const [rel, content] of Object.entries(srcFiles)) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

// Hand-written sources, each isolating ONE tool's finding so the two groups never
// overlap:
//   - lintbad.ts: `a == b` on LINE 2 -> biome noDoubleEquals; both a,b are number
//     so tsc stays silent (no TS2367 "no overlap").
//   - typebad.ts: number <- string on LINE 1 -> tsc TS2322; no `==` so biome
//     stays silent.
//   - clean.ts:   neither -> both tools pass.
const LINTBAD =
	"export function eq(a: number, b: number): boolean {\n  return a == b;\n}\n";
const TYPEBAD = 'export const wrong: number = "not a number";\n';
const CLEAN =
	"export function ok(a: number, b: number): number {\n  return a + b;\n}\n";

// --- Tracer bullet: `dobby check` runs real biome + tsc, project-wide --------
// The headline behavior of this task. A dirty project (one lint error + one type
// error) must surface BOTH findings and exit 1; a clean project exits 0. Both
// findings appearing proves biome AND tsc ran (they are the "grouped per tool"
// evidence — the exact section labels are the implementor's presentation choice).
describe("run() — check command (project-wide biome + tsc)", () => {
	let dirty: string;
	let clean: string;

	beforeAll(() => {
		dirty = makeCheckRepo({
			"src/clean.ts": CLEAN,
			"src/lintbad.ts": LINTBAD,
			"src/typebad.ts": TYPEBAD,
		});
		clean = makeCheckRepo({ "src/clean.ts": CLEAN });
	});

	afterAll(() => {
		rmSync(dirty, { recursive: true, force: true });
		rmSync(clean, { recursive: true, force: true });
	});

	it("exits 1 when the project has findings (and NOT via the unknown-command path)", async () => {
		const result = await run(["check"], dirty);
		expect(result.exitCode).toBe(1);
		// Anti-tautology guard: an unimplemented `check` ALSO exits 1 through the
		// unknown-command branch — assert this is genuinely the check path.
		expect(result.stderr).not.toContain("unknown command");
	}, 20000);

	it("reports the biome lint finding as `file:line` (lintbad.ts, line 2)", async () => {
		const result = await run(["check"], dirty);
		expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
	}, 20000);

	it("reports the tsc type finding as `file:line` (typebad.ts, line 1)", async () => {
		const result = await run(["check"], dirty);
		expect(result.stdout).toMatch(/typebad\.ts:1\b/);
	}, 20000);

	it("surfaces BOTH tools' findings in one report (biome ran AND tsc ran)", async () => {
		const result = await run(["check"], dirty);
		expect(result.stdout).toMatch(/lintbad\.ts/);
		expect(result.stdout).toMatch(/typebad\.ts/);
	}, 20000);

	it("exits 0 on a clean project and reports no `file:line` findings", async () => {
		const result = await run(["check"], clean);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toMatch(/\.ts:\d/);
	}, 20000);
});

// --- `dobby check <file...>` — the per-file fast path: biome only, NO tsc ----
// The discriminator for "tsc is skipped": the project carries a type error in
// typebad.ts, but a per-file check must never surface it — tsc never runs.
describe("run() — check command (per-file fast path skips tsc)", () => {
	let dirty: string;

	beforeAll(() => {
		dirty = makeCheckRepo({
			"src/clean.ts": CLEAN,
			"src/lintbad.ts": LINTBAD,
			"src/typebad.ts": TYPEBAD,
		});
	});

	afterAll(() => {
		rmSync(dirty, { recursive: true, force: true });
	});

	it("a lint-clean file passes (exit 0) even though the project has a type error — tsc did not run", async () => {
		const result = await run(["check", "src/clean.ts"], dirty);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toMatch(/typebad\.ts/);
	}, 20000);

	it("flags a lint error in the named file (exit 1) and never reports the untouched file's type error", async () => {
		const result = await run(["check", "src/lintbad.ts"], dirty);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
		expect(result.stdout).not.toMatch(/typebad\.ts/);
	}, 20000);
});

// --- Preset exports (thin-file model): consumers extend @kvnwolf/dobby/* ------
// Every target is a spec literal.
describe("dobby presets — package.json exports", () => {
	it("maps ./tsconfig to ./tsconfig.base.json", () => {
		expect(readCliManifest().exports?.["./tsconfig"]).toBe(
			"./tsconfig.base.json",
		);
	});

	it("maps ./biome/core to ./biome/core.jsonc", () => {
		expect(readCliManifest().exports?.["./biome/core"]).toBe(
			"./biome/core.jsonc",
		);
	});

	it("maps ./biome/react to ./biome/react.jsonc", () => {
		expect(readCliManifest().exports?.["./biome/react"]).toBe(
			"./biome/react.jsonc",
		);
	});

	it("maps ./vitest to ./vitest.base.mjs", () => {
		expect(readCliManifest().exports?.["./vitest"]).toBe("./vitest.base.mjs");
	});

	it("keeps the existing dobby bin entry intact", () => {
		expect(readCliManifest().bin?.dobby).toBe("./src/index.ts");
	});
});

// --- Bundled toolchain as RUNTIME dependencies (consumers install nothing) ---
// biome, ultracite (the presets' extends target), and typescript must be runtime
// `dependencies` — not devDependencies — so a consumer inherits the tool bins and
// the preset resolution transitively. Names are spec literals.
describe("dobby dependencies — bundled toolchain in runtime dependencies", () => {
	for (const name of ["@biomejs/biome", "ultracite", "typescript"]) {
		it(`declares ${name} as a runtime dependency`, () => {
			const deps = readCliManifest().dependencies ?? {};
			expect(deps[name], `missing runtime dependency: ${name}`).toBeDefined();
		});
	}
});

// --- tsconfig.base.json — strict base for consumer apps ----------------------
// Substring/regex assertions tolerate JSONC comments and whitespace; every flag
// is a spec literal from the enumerated strict base.
describe("dobby preset — tsconfig.base.json", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("tsconfig.base.json"))).toBe(true);
	});

	it("declares the strict compiler flags the spec enumerates", () => {
		const raw = safeRead("tsconfig.base.json");
		expect(raw).toMatch(/"strict"\s*:\s*true/);
		expect(raw).toMatch(/"noUncheckedIndexedAccess"\s*:\s*true/);
		expect(raw).toMatch(/"noEmit"\s*:\s*true/);
		expect(raw).toMatch(/"skipLibCheck"\s*:\s*true/);
		expect(raw).toMatch(/"isolatedModules"\s*:\s*true/);
		expect(raw).toMatch(/"esModuleInterop"\s*:\s*true/);
		expect(raw).toMatch(/"resolveJsonModule"\s*:\s*true/);
	});

	it("uses bundler-style module settings (module preserve, moduleResolution bundler)", () => {
		const raw = safeRead("tsconfig.base.json");
		expect(raw).toMatch(/"module"\s*:\s*"preserve"/);
		expect(raw).toMatch(/"moduleResolution"\s*:\s*"bundler"/);
	});
});

// --- biome presets — thin files extending ultracite -------------------------
describe("dobby preset — biome/core.jsonc", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("biome/core.jsonc"))).toBe(true);
	});

	it("extends ultracite's biome core preset", () => {
		expect(safeRead("biome/core.jsonc")).toMatch(/"ultracite\/biome\/core"/);
	});

	it("does not pull in the react preset (core stays framework-agnostic)", () => {
		// Require the file to EXIST first, so this negative assertion is not
		// vacuously true when the preset is simply absent.
		expect(existsSync(cliFile("biome/core.jsonc"))).toBe(true);
		expect(safeRead("biome/core.jsonc")).not.toMatch(/ultracite\/biome\/react/);
	});
});

describe("dobby preset — biome/react.jsonc", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("biome/react.jsonc"))).toBe(true);
	});

	it("extends the dobby core preset (multi-level) plus the ultracite react preset", () => {
		// react → ./core.jsonc → ultracite/biome/core: consumers extend ONLY
		// @kvnwolf/dobby/biome/react and inherit core's common ignores transitively.
		const raw = safeRead("biome/react.jsonc");
		expect(raw).toMatch(/"\.\/core\.jsonc"/);
		expect(raw).toMatch(/"ultracite\/biome\/react"/);
		expect(safeRead("biome/core.jsonc")).toMatch(/"ultracite\/biome\/core"/);
	});
});

// --- vitest preset — the universal test wiring consumers merge on top ---------
// The default-exported config asset (@kvnwolf/dobby/vitest) carries the two
// ingredients every consumer was re-deriving by hand: inline zod (so vitest-under-
// bun's module runner can't mangle its dual export map) and a `.claude/**` exclude
// (so full worktree copies aren't double-discovered). Asserted by FILE READ — same
// as the biome/tsconfig presets (config assets are read, not imported: the `run()`
// seam is for the CLI's behavior, and a defineConfig() return is a typed union that
// resists a clean direct-import shape assertion). The mergeConfig pointer is a spec
// literal in the file's own header comment.
describe("dobby preset — vitest.base.mjs", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("vitest.base.mjs"))).toBe(true);
	});

	it("is built with vitest's own defineConfig (a mergeable base, not a bespoke object)", () => {
		const raw = safeRead("vitest.base.mjs");
		expect(raw).toMatch(/from\s+"vitest\/config"/);
		expect(raw).toMatch(/defineConfig/);
		// Default export so consumers `import dobbyVitest from "@kvnwolf/dobby/vitest"`.
		expect(raw).toMatch(/export\s+default\s+defineConfig/);
	});

	it("inlines zod (server.deps.inline) so vitest-under-bun can't mangle its export map", () => {
		const raw = safeRead("vitest.base.mjs");
		expect(raw).toMatch(/inline/);
		expect(raw).toMatch(/"zod"/);
	});

	it("excludes .claude/** on top of vitest's own defaults (no double-discovery)", () => {
		const raw = safeRead("vitest.base.mjs");
		expect(raw).toMatch(/configDefaults\.exclude/);
		expect(raw).toMatch(/"\.claude\/\*\*"/);
	});

	it("points consumers at mergeConfig in its header (the documented merge-on shape)", () => {
		expect(safeRead("vitest.base.mjs")).toMatch(/mergeConfig/);
	});

	it("never adds vitest as a dobby dependency (dual-Vite invariant)", () => {
		// vitest resolves from the CONSUMER's tree at config-load time; bundling a
		// second copy in dobby would clash with the consumer's Vite plugins.
		const deps = readCliManifest().dependencies ?? {};
		expect(deps.vitest).toBeUndefined();
	});
});

// ===========================================================================
// TASK 3b — The stack-preset suite: vite/vitest-react/drizzle presets so a
// consumer of the house stack (TanStack Start + Drizzle/Neon + vite + vitest)
// carries only DELTAS. Six preset assets, each observed the same way as the
// task-3 presets above: read as FILES (config assets are read, never imported —
// the `run()` seam is for CLI behavior, and these import consumer-resolved
// packages that this repo does NOT install, so a real import would not resolve).
//
// Independent sources for every expected value below: the export targets, the
// tsconfig flags, the vite/vitest/drizzle keys, and the schema globs are all
// LITERALS the spec states outright.
// ===========================================================================

// Strip `//` line comments so a marker assertion reads the actual CONFIG, not the
// documented consumer snippet in a file's header (vite.base.mjs legitimately shows
// `plugins:` inside its header comment; the config body must NOT declare it).
const codeOnly = (raw: string) =>
	raw
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");

// --- package.json exports for the four new presets --------------------------
describe("dobby stack presets — package.json exports", () => {
	it("maps ./tsconfig/vite to ./tsconfig.vite.json", () => {
		expect(readCliManifest().exports?.["./tsconfig/vite"]).toBe(
			"./tsconfig.vite.json",
		);
	});

	it("maps ./vite to ./vite.base.mjs", () => {
		expect(readCliManifest().exports?.["./vite"]).toBe("./vite.base.mjs");
	});

	it("maps ./vitest/react to ./vitest.react.mjs", () => {
		expect(readCliManifest().exports?.["./vitest/react"]).toBe(
			"./vitest.react.mjs",
		);
	});

	it("maps ./drizzle to ./drizzle.base.mjs", () => {
		expect(readCliManifest().exports?.["./drizzle"]).toBe("./drizzle.base.mjs");
	});
});

// --- package.json `files` allowlist — the packed tarball ships only presets --
// The npm/bun `files` field is an ALLOWLIST: the published tarball carries exactly
// what a consumer needs (src minus the co-located test, the biome presets, the two
// tsconfig presets, the four .mjs config presets) and NOTHING else — the
// __fixtures__/ dir and src/run.test.ts must never ship. Asserted against the
// manifest (the pack itself is verified out-of-band via `bun pm pack`). Every
// expected entry is a spec literal.
describe("dobby packaging — package.json files allowlist", () => {
	it("declares a files allowlist array", () => {
		expect(Array.isArray(readCliManifest().files)).toBe(true);
	});

	it("ships src and the biome presets", () => {
		const files = readCliManifest().files ?? [];
		expect(files).toContain("src");
		expect(files).toContain("biome");
	});

	it("excludes the co-located run.test.ts via a negation entry", () => {
		// The `!src/run.test.ts` negation keeps the test out of the tarball while
		// still shipping the rest of src/.
		expect(readCliManifest().files ?? []).toContain("!src/run.test.ts");
	});

	it("never lists the __fixtures__ dir (test fixtures must not ship)", () => {
		const files = readCliManifest().files ?? [];
		expect(files.some((entry) => entry.includes("__fixtures__"))).toBe(false);
	});

	it("ships the two tsconfig presets and the four .mjs config presets", () => {
		const files = readCliManifest().files ?? [];
		for (const asset of [
			"tsconfig.base.json",
			"tsconfig.vite.json",
			"vite.base.mjs",
			"vitest.base.mjs",
			"vitest.react.mjs",
			"drizzle.base.mjs",
		]) {
			expect(files, `missing packaged asset: ${asset}`).toContain(asset);
		}
	});
});

// --- tsconfig.base.json gains the two universal-safe options ----------------
// D1: allowImportingTsExtensions only ALLOWS the style (base already has noEmit)
// and noUncheckedSideEffectImports is pure strictness — both are universal-safe.
describe("dobby preset — tsconfig.base.json (D1 additions)", () => {
	it("allows importing .ts extensions", () => {
		expect(safeRead("tsconfig.base.json")).toMatch(
			/"allowImportingTsExtensions"\s*:\s*true/,
		);
	});

	it("checks unresolved side-effect imports", () => {
		expect(safeRead("tsconfig.base.json")).toMatch(
			/"noUncheckedSideEffectImports"\s*:\s*true/,
		);
	});
});

// --- tsconfig.vite.json — the vite-app tsconfig variant (D2) -----------------
describe("dobby preset — tsconfig.vite.json", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("tsconfig.vite.json"))).toBe(true);
	});

	it("extends the strict base and adds the vite/client types", () => {
		const raw = safeRead("tsconfig.vite.json");
		expect(raw).toMatch(/"extends"\s*:\s*"\.\/tsconfig\.base\.json"/);
		expect(raw).toMatch(/"vite\/client"/);
	});
});

// --- vite.base.mjs — the universal vite-app config (D3) -----------------------
// The dobby-lifecycle-coupled bits (native tsconfig paths + portless's custom
// hostnames) are preset; plugins are consumer-owned + version-coupled, so the
// config body carries NONE.
describe("dobby preset — vite.base.mjs", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("vite.base.mjs"))).toBe(true);
	});

	it("enables vite@8 native tsconfig path resolution (never the plugin)", () => {
		expect(safeRead("vite.base.mjs")).toMatch(/tsconfigPaths/);
	});

	it("accepts portless's custom hostnames (server.allowedHosts)", () => {
		expect(safeRead("vite.base.mjs")).toMatch(/allowedHosts/);
	});

	it("declares NO plugins in the config body (consumer-owned + version-coupled)", () => {
		// The header comment shows `plugins:` in the merge snippet — strip comments
		// so this reads the config object, not the docs.
		expect(codeOnly(safeRead("vite.base.mjs"))).not.toMatch(/plugins:/);
	});
});

// --- vitest.react.mjs — the react-app vitest variant (D4) ---------------------
// Layered on the base via mergeConfig; lives in its OWN file precisely because it
// imports vite / @vitejs packages (the base must stay importable without vite).
describe("dobby preset — vitest.react.mjs", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("vitest.react.mjs"))).toBe(true);
	});

	it("layers on the vitest base (imports ./vitest.base)", () => {
		expect(safeRead("vitest.react.mjs")).toMatch(/from\s+"\.\/vitest\.base/);
	});

	it("adds the react test plugin and import-time env loading", () => {
		const raw = safeRead("vitest.react.mjs");
		expect(raw).toMatch(/react\(\)/);
		expect(raw).toMatch(/loadEnv/);
	});
});

// --- drizzle.base.mjs — the house drizzle-kit config (D5) ---------------------
// Field-proven whole; every clause is a spec literal.
describe("dobby preset — drizzle.base.mjs", () => {
	it("exists as an exported preset file", () => {
		expect(existsSync(cliFile("drizzle.base.mjs"))).toBe(true);
	});

	it("resolves the UNPOOLED URL from both house env-var names", () => {
		const raw = safeRead("drizzle.base.mjs");
		expect(raw).toMatch(/DATABASE_URL_UNPOOLED/);
		expect(raw).toMatch(/POSTGRES_URL_NON_POOLING/);
	});

	it("targets postgresql with migrations out at ./drizzle", () => {
		const raw = safeRead("drizzle.base.mjs");
		expect(raw).toMatch(/"postgresql"/);
		expect(raw).toMatch(/"\.\/drizzle"/);
	});

	it("globs co-located schema across modules (schema.ts + schema.gen.ts)", () => {
		const raw = safeRead("drizzle.base.mjs");
		expect(raw).toMatch(/"\.\/src\/\*\*\/schema\.ts"/);
		expect(raw).toMatch(/"\.\/src\/\*\*\/schema\.gen\.ts"/);
	});

	it("skips the missing-URL hard-fail under CI (config loads to read schema)", () => {
		expect(safeRead("drizzle.base.mjs")).toMatch(/process\.env\.CI/);
	});
});

// --- No consumer-resolved package leaks into cli dependencies ----------------
// The dual-Vite invariant, extended to the whole preset suite: vite / vitest /
// drizzle-kit / @vitejs are ALWAYS resolved from the consumer's tree at
// config-load time, never bundled inside dobby.
describe("dobby dependencies — no consumer-resolved stack packages", () => {
	for (const name of [
		"vite",
		"vitest",
		"drizzle-kit",
		"@vitejs/plugin-react",
	]) {
		it(`never declares ${name} as a dobby dependency`, () => {
			const deps = readCliManifest().dependencies ?? {};
			expect(deps[name]).toBeUndefined();
		});
	}

	it("declares no @vitejs/* package at all", () => {
		const deps = readCliManifest().dependencies ?? {};
		expect(Object.keys(deps).some((key) => key.startsWith("@vitejs/"))).toBe(
			false,
		);
	});
});

// --- Dogfood: the repo's own root vitest.config.ts re-exports the base (D6) --
// Proves the base preset loads under vitest with vite NOT installed, and stops
// the suite discovering .claude/** worktree copies. Read relative to cli/ (the
// file lives one level up, at the repo root).
describe("dobby dogfood — root vitest.config.ts", () => {
	it("exists at the repo root", () => {
		expect(existsSync(cliFile("../vitest.config.ts"))).toBe(true);
	});

	it("re-exports the dobby vitest BASE preset (no vite/react in this repo)", () => {
		const raw = safeRead("../vitest.config.ts");
		expect(raw).toMatch(/export\s+\{\s*default\s*\}/);
		expect(raw).toMatch(/"@kvnwolf\/dobby\/vitest"/);
	});
});

// ===========================================================================
// TASK 4 — Full gate: selective flags + knip/build/test steps.
//
// This task grows `dobby check` from the task-3 core (biome + tsc) into the FULL
// gate — adding knip, a capability-gated build step (vite) and test step
// (vitest) — plus the selective flags `--lint --types --unused --build --test`
// that subset the one pipeline. The pure step-plan inference lives in the new
// `tasks.ts` (checkPipeline); `check.ts` consumes the plan. Per the task
// constraint, EVERY behavior is observed through the run(argv, cwd) seam (the
// note lines + which tool reported) — tasks.ts is never imported directly.
//
// Independent sources for every expected value below:
//   - The biome finding (LINTBAD, `==` on line 2) and the tsc finding (TYPEBAD2,
//     a number<-string assignment on line 2) come from HAND-WRITTEN sources whose
//     offending token sits on a line WE chose — the tool never recomputes them.
//     Each finding's line is UNIQUE to its tool (the export declarations sit on
//     line 1, so a `file.ts:2` reference can only come from biome/tsc, never from
//     knip's file/export listing) — so "which tool reported" is read cleanly.
//   - Every repo carries a KNIP-CLEAN config (`entry`/`project` = all of src), so
//     knip deterministically emits no findings and never contaminates the
//     "tool X did / did not report" assertions. (Verified out-of-band: with this
//     config `knip --reporter json` prints {"issues":[]} exit 0; without it, it
//     lists the src filenames.)
//   - The capability-gated build/test steps are exercised ONLY on the skip path
//     (a project WITHOUT the vite/vitest capability) — the task forbids actually
//     running vite build / vitest in tests (fixtures lack them). The skip is
//     observed as a note line naming the step, plus the fact that the step never
//     fails the gate.
//   - The extras behavior is observed via a `checks[]` shell command's FILE
//     SIDE-EFFECT (a `touch`ed marker), independent of any output format.
// ===========================================================================

// tsc type error on LINE 2 (the export decl is line 1), so `typebad.ts:2` is a
// tsc-only reference. Complements the reused LINTBAD (`==` on line 2 -> biome).
const TYPEBAD2 =
	'export function bad(): number {\n  const x: number = "nope";\n  return x;\n}\n';

// Build a THROWAWAY git repo shaped for the full gate: the same isolated biome
// linter (only noDoubleEquals can fire) and strict tsconfig as the task-3 helper,
// PLUS a package.json carrying a knip-clean config (so knip never contaminates
// the assertions) and — by default — NO vite/vitest deps (so the build/test
// steps hit the capability-skip path). `checks` writes a dobby.config.json with
// `checks[]` extras. A bare `git init` is enough (the workroot resolves with no
// commit). Returns the repo root (realpath-normalized).
function makeGateRepo(opts: {
	src: Record<string, string>;
	deps?: Record<string, string>;
	devDeps?: Record<string, string>;
	checks?: Array<{ name: string; run: string }>;
}): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-gate-")));
	execFileSync("git", ["init", "-q"], {
		cwd: dir,
		stdio: "ignore",
		env: gitEnv,
	});
	writeFileSync(
		join(dir, "biome.jsonc"),
		JSON.stringify(
			{
				formatter: { enabled: false },
				assist: { enabled: false },
				linter: {
					enabled: true,
					rules: {
						recommended: false,
						suspicious: { noDoubleEquals: "error" },
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
				include: ["src"],
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "gate-fixture",
				private: true,
				// Entry = every src file -> nothing is "unused" -> knip stays clean.
				knip: { entry: ["src/**/*.ts"], project: ["src/**/*.ts"] },
				...(opts.deps ? { dependencies: opts.deps } : {}),
				...(opts.devDeps ? { devDependencies: opts.devDeps } : {}),
			},
			null,
			2,
		),
	);
	if (opts.checks) {
		writeFileSync(
			join(dir, "dobby.config.json"),
			JSON.stringify({ files: [], checks: opts.checks }, null, 2),
		);
	}
	for (const [rel, content] of Object.entries(opts.src)) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

// The combined output of a run — a skip note MAY land on stdout or stderr, so
// note detection searches both.
const combined = (r: { stdout: string; stderr: string }) =>
	`${r.stdout}\n${r.stderr}`;

// Whether some single line of `text` matches every matcher — the shape of a
// "single note line" that names one thing and asserts a fact about it.
function hasNoteLine(text: string, matchers: RegExp[]): boolean {
	return text.split("\n").some((line) => matchers.every((m) => m.test(line)));
}

// A capability-gated step's skip is a SINGLE note line naming the step and
// saying it was skipped. Contract (from "skipped with a single note line"): the
// build note names the `build` step; the test note names the `test` step (or its
// gating `vitest` capability). Anchored on the spec's own word "skip".
const buildSkipNote = (text: string) => hasNoteLine(text, [/build/i, /skip/i]);
const testSkipNote = (text: string) =>
	hasNoteLine(text, [/vitest|\btest\b/i, /skip/i]);

// --- Slice 1 (tracer bullet): --lint subsets the pipeline to biome only -------
// The headline of this task — "when ANY flag present run ONLY the flagged steps".
// A dirty project (lint error + type error), no vite/vitest. `--lint` must report
// the biome finding and NOT the tsc finding (tsc is not in the plan). knip is not
// selected here, so it never runs — the assertions are contamination-free.
describe("run() — check command (selective flags subset the pipeline)", () => {
	let dirty: string;

	beforeAll(() => {
		dirty = makeGateRepo({
			src: {
				"src/clean.ts": CLEAN,
				"src/lintbad.ts": LINTBAD,
				"src/typebad.ts": TYPEBAD2,
			},
		});
	});

	afterAll(() => {
		rmSync(dirty, { recursive: true, force: true });
	});

	it("under --lint runs biome ONLY: reports the lint finding (lintbad.ts:2), exits 1, and never surfaces the project's type error", async () => {
		// The positive facet (biome finding present) is RED until --lint is wired;
		// the negative facet (typebad absent) is the "only" discriminator — together
		// they assert the ONE behavior "--lint runs biome and nothing else".
		const result = await run(["check", "--lint"], dirty);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
		expect(combined(result)).not.toMatch(/typebad/);
	}, 20000);

	it("under --types runs tsc ONLY: reports the type finding (typebad.ts:2), exits 1, and never surfaces the project's lint error", async () => {
		const result = await run(["check", "--types"], dirty);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/typebad\.ts:2\b/);
		expect(combined(result)).not.toMatch(/lintbad/);
	}, 20000);

	it("combines flags additively and reports EVERY selected tool (does not stop at the first failing one)", async () => {
		// --lint --types: both tools run and BOTH findings surface. If the gate
		// stopped at the first failing tool, only one would appear.
		const result = await run(["check", "--lint", "--types"], dirty);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
		expect(result.stdout).toMatch(/typebad\.ts:2\b/);
	}, 30000);

	it("under --unused runs knip only: exits 0 with neither the biome nor the tsc finding", async () => {
		// knip is clean by construction, so the ONLY way lintbad:2 / typebad:2 could
		// appear is if biome/tsc wrongly ran. Their absence + exit 0 proves --unused
		// subsets to knip alone.
		const result = await run(["check", "--unused"], dirty);
		expect(result.exitCode).toBe(0);
		expect(combined(result)).not.toMatch(/lintbad\.ts:2\b/);
		expect(combined(result)).not.toMatch(/typebad\.ts:2\b/);
	}, 30000);
});

// --- Slice 2: capability-gated build/test steps skip with a note --------------
// The build step runs vite (consumer-local) only with the vite capability; the
// test step runs vitest only with the vitest capability. The `dirty` repo has
// NEITHER capability, so selecting --build / --test must SKIP the step with a
// note and never fail the gate (a skip is not a failure) — and, since the flag
// subsets the pipeline, biome/tsc are not run (the repo's lint/type errors stay
// uncaught). We NEVER run vite build / vitest here (the task forbids it): only
// the skip path is exercised.
describe("run() — check command (capability-gated build/test skip with a note)", () => {
	let dirty: string;

	beforeAll(() => {
		// Lint + type errors present, but NO vite/vitest capability.
		dirty = makeGateRepo({
			src: { "src/lintbad.ts": LINTBAD, "src/typebad.ts": TYPEBAD2 },
		});
	});

	afterAll(() => {
		rmSync(dirty, { recursive: true, force: true });
	});

	it("under --build on a project without the vite capability: exits 0 (skip is not a failure) and runs no other tool", async () => {
		const result = await run(["check", "--build"], dirty);
		expect(result.exitCode).toBe(0);
		// biome/tsc are not in the --build plan, so the repo's errors are untouched.
		expect(combined(result)).not.toMatch(/lintbad/);
		expect(combined(result)).not.toMatch(/typebad/);
	}, 20000);

	it("under --build emits a single skip note naming the build step", async () => {
		const result = await run(["check", "--build"], dirty);
		expect(buildSkipNote(combined(result))).toBe(true);
	}, 20000);

	it("under --test on a project without the vitest capability: exits 0 and runs no other tool", async () => {
		const result = await run(["check", "--test"], dirty);
		expect(result.exitCode).toBe(0);
		expect(combined(result)).not.toMatch(/lintbad/);
		expect(combined(result)).not.toMatch(/typebad/);
	}, 20000);

	it("under --test emits a single skip note naming the test step", async () => {
		const result = await run(["check", "--test"], dirty);
		expect(testSkipNote(combined(result))).toBe(true);
	}, 20000);
});

// --- Slice 3: the full gate (no flags) composes every step --------------------
// No flags = [biome, tsc, knip, build-if-vite, test-if-vitest] (+ extras). On a
// dirty project with NO vite/vitest capability, biome and tsc report their
// findings (exit 1), knip runs clean, and the build + test steps are each
// skipped with a note. Observing all four (both findings + both skip notes)
// proves the full pipeline composed.
describe("run() — check command (full gate, no flags)", () => {
	let dirty: string;

	beforeAll(() => {
		dirty = makeGateRepo({
			src: {
				"src/clean.ts": CLEAN,
				"src/lintbad.ts": LINTBAD,
				"src/typebad.ts": TYPEBAD2,
			},
		});
	});

	afterAll(() => {
		rmSync(dirty, { recursive: true, force: true });
	});

	it("reports BOTH the biome and the tsc findings and exits 1", async () => {
		const result = await run(["check"], dirty);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/lintbad\.ts:2\b/);
		expect(result.stdout).toMatch(/typebad\.ts:2\b/);
	}, 30000);

	it("emits a skip note for the build step (project has no vite capability)", async () => {
		const result = await run(["check"], dirty);
		expect(buildSkipNote(combined(result))).toBe(true);
	}, 30000);

	it("emits a skip note for the test step (project has no vitest capability)", async () => {
		const result = await run(["check"], dirty);
		expect(testSkipNote(combined(result))).toBe(true);
	}, 30000);
});

// --- Slice 4: config checks[] extras run last (no flags) / excluded otherwise --
// The extra is a shell command whose FILE SIDE-EFFECT (a touched marker) is the
// format-independent observable. On the full gate (no flags) the extra runs and
// the marker appears; with ANY selective flag present the extras are EXCLUDED and
// the marker never appears. The no-flags case establishes the extra's efficacy,
// so the with-flag case's absence is meaningful (not vacuously true). Both repos
// are clean, so no tool failure can interfere with the extra.
describe("run() — check command (config checks[] extras)", () => {
	const MARKER = "dobby-extra-marker";
	const extra = [{ name: "marker", run: `touch ${MARKER}` }];
	let repoNoFlags: string;
	let repoWithFlag: string;

	beforeAll(() => {
		repoNoFlags = makeGateRepo({
			src: { "src/clean.ts": CLEAN },
			checks: extra,
		});
		repoWithFlag = makeGateRepo({
			src: { "src/clean.ts": CLEAN },
			checks: extra,
		});
	});

	afterAll(() => {
		rmSync(repoNoFlags, { recursive: true, force: true });
		rmSync(repoWithFlag, { recursive: true, force: true });
	});

	it("runs the config checks[] extras on the full gate (no flags): the extra's marker appears", async () => {
		await run(["check"], repoNoFlags);
		expect(existsSync(join(repoNoFlags, MARKER))).toBe(true);
	}, 30000);

	it("excludes the config checks[] extras when a selective flag is present: the same extra never runs", async () => {
		const result = await run(["check", "--lint"], repoWithFlag);
		// --lint on a clean project passes; extras are excluded because a flag is set.
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(repoWithFlag, MARKER))).toBe(false);
	}, 30000);
});

// --- Slice 5 (review-added): knip's finding-PRESENT path fails the gate --------
// Every makeGateRepo fixture is knip-CLEAN by construction (entry = ALL of src,
// so nothing is unused), and the only prior knip assertion (--unused runs knip
// only) checks exit 0 with no biome/tsc finding. So NO existing test ever makes
// knip emit a finding and fail the gate — the ~50 lines of knip JSON reduction in
// check.ts (runKnip + knipItem: the `files` vs symbol categories, the object/
// string/array item shapes, line extraction) live entirely on an untested
// failure path. biome and tsc each have a positive failing-path test (lintbad.ts:2
// / typebad.ts:2); knip had none. This fixture closes that gap.
//
// Independent source of the expected value: this repo declares a SINGLE entry
// (src/index.ts) with a src/orphan.ts that nothing imports and that is NOT an
// entry — so knip deterministically reports it as an unused FILE (verified
// out-of-band against the bundled knip: `knip --reporter json` on this exact
// shape prints {"issues":[{"file":"src/orphan.ts","files":[{"name":"src/orphan.ts"}],…}]}
// and EXITS 1). `check --unused` must reduce that JSON issue to a finding naming
// orphan.ts and FAIL the gate — proving the reducer maps a real knip issue (not
// just the empty {"issues":[]}), and that a knip finding fails the gate. The orphan
// export declaration sits on line 1, so an `orphan.ts` reference here can only be
// knip's unused-file finding (biome/tsc are not in the --unused plan anyway).
function makeKnipDirtyRepo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-knip-")));
	execFileSync("git", ["init", "-q"], {
		cwd: dir,
		stdio: "ignore",
		env: gitEnv,
	});
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "knip-dirty-fixture",
				private: true,
				// Single entry + project spanning all of src => src/orphan.ts (imported by
				// nothing, and not itself an entry) is a deterministically-unused FILE.
				knip: { entry: ["src/index.ts"], project: ["src/**/*.ts"] },
			},
			null,
			2,
		),
	);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "src", "index.ts"),
		"export const used = 1;\nconsole.log(used);\n",
	);
	writeFileSync(join(dir, "src", "orphan.ts"), "export const orphan = 3;\n");
	return dir;
}

describe("run() — check command (knip finding-present path fails the gate)", () => {
	let dirty: string;

	beforeAll(() => {
		dirty = makeKnipDirtyRepo();
	});

	afterAll(() => {
		rmSync(dirty, { recursive: true, force: true });
	});

	it("under --unused reports the unused file finding (orphan.ts) via knip and exits 1", async () => {
		const result = await run(["check", "--unused"], dirty);
		// The reducer mapped a real knip issue to a finding, so the gate FAILS (exit 1)
		// and knip is the reporting tool naming orphan.ts.
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/knip/i);
		expect(result.stdout).toMatch(/orphan\.ts/);
	}, 30000);
});

// ===========================================================================
// TASK 5 — `check --hook` + plugin hook rewire.
//
// The PostToolUse edit hook: `dobby check --hook` reads the hook's JSON payload
// from STDIN (the NEW third `run(argv, cwd, stdin?)` parameter), applies biome's
// SAFE auto-fixes to the edited file so formatting never bothers the model, and
// exits 2 ONLY when unfixable findings remain (the exit code Claude Code
// surfaces to the model). Every guard — unparsable payload / no file_path /
// missing file / no dobby.config.json marker / unsupported extension — is a
// SILENT exit 0: harness noise must never block an edit.
//
// Observed through the run(argv, cwd, stdin) seam against throwaway git repos we
// build at runtime. A committed __fixtures__ dir would resolve its git workroot
// to THIS repo, AND the hook MUTATES files on disk — so a temp repo is
// mandatory (the task-3/4 check slices set the same precedent). The real bundled
// biome runs.
//
// Independent sources for every expected value below (each confirmed out-of-band
// against the bundled biome 2.5.x — establishing ground truth with raw biome, a
// DIFFERENT thing than the dobby code under test):
//   - AUTO-FIXABLE: a file written with SINGLE quotes and no semicolon, under a
//     formatter config pinned to quoteStyle "double" + semicolons "always". The
//     known-good fixed form `"hello";` is a worked example of those formatting
//     rules applied BY HAND — never recomputed by dobby. `biome check --write`
//     rewrites the file and reports zero remaining diagnostics (exit 0).
//   - UNFIXABLE: `a == b` on line 2 under `noDoubleEquals: error`. biome's fix
//     for `==` is UNSAFE-only, so a SAFE `--write` leaves it — the finding
//     remains and the gate exits 2. Line 2 is where WE put the `==`.
//   - GUARD exit-0/silent contract: the spec's literal wording ("silent exit 0").
//   - EXTENSION guard: a `.mjs` file (NOT in the spec's supported list
//     ts,tsx,js,jsx,json,jsonc,css) that biome WOULD otherwise format — so an
//     unchanged file + exit 0 proves the guard fired, not that biome had no work.
//   - OUTSIDE-WORKROOT guard: with the repo's own noDoubleEquals config, biome
//     lints an out-of-tree `==` file and would exit 2 — so exit 0 proves the
//     guard, not biome inaction.
// ===========================================================================

// A formatter-only biome config: single quotes -> double quotes, semicolons
// added. A formatting-only file is SAFELY auto-fixed with no remaining finding.
const BIOME_FORMAT_CONFIG = {
	formatter: { enabled: true, indentStyle: "space", indentWidth: 2 },
	assist: { enabled: false },
	javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
	linter: { enabled: false },
};

// A linter-only biome config: noDoubleEquals=error. `==` has an UNSAFE fix only,
// so `biome check --write` (SAFE fixes) can never remove it — the finding stays.
const BIOME_LINT_CONFIG = {
	formatter: { enabled: false },
	assist: { enabled: false },
	linter: {
		enabled: true,
		rules: { recommended: false, suspicious: { noDoubleEquals: "error" } },
	},
};

// A file with a purely-formatting problem (single quote + missing semicolon).
// Known-good fixed form, worked BY HAND from the pinned rules above:
// `export const greeting = "hello";`.
const FIXABLE_SOURCE = "export const greeting = 'hello'\n";

// Throwaway repos/dirs created for the hook slices; removed in the describe's
// afterAll. The hook mutates files on disk, so each slice owns a fresh repo.
const hookDirs: string[] = [];

// Build a THROWAWAY git repo for the `check --hook` path: a biome.jsonc (the
// given config), OPTIONALLY a dobby.config.json marker (the hook's "dobby
// project" gate — omit it to exercise the no-config guard), and the given files
// written verbatim so biome --write can mutate them. `check --hook` resolves this
// repo as the workroot. Returns the realpath-normalized root (matching git's
// resolved top-level).
function makeHookRepo(opts: {
	biome: unknown;
	files: Record<string, string>;
	config?: unknown;
}): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-hook-")));
	hookDirs.push(dir);
	execFileSync("git", ["init", "-q"], {
		cwd: dir,
		stdio: "ignore",
		env: gitEnv,
	});
	writeFileSync(join(dir, "biome.jsonc"), JSON.stringify(opts.biome, null, 2));
	if (opts.config !== undefined) {
		writeFileSync(
			join(dir, "dobby.config.json"),
			JSON.stringify(opts.config, null, 2),
		);
	}
	for (const [rel, content] of Object.entries(opts.files)) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

// The PostToolUse hook payload as a stdin string: `{ tool_name, tool_input:
// { file_path }, ... }`. `filePath === undefined` omits file_path entirely (the
// "no file_path" guard).
function hookStdin(filePath: string | undefined): string {
	const toolInput = filePath === undefined ? {} : { file_path: filePath };
	return JSON.stringify({
		session_id: "hook-test",
		tool_name: "Edit",
		tool_input: toolInput,
	});
}

describe("run() — check --hook (edit-time safe auto-fix)", () => {
	afterAll(() => {
		for (const dir of hookDirs) rmSync(dir, { recursive: true, force: true });
		hookDirs.length = 0;
	});

	// --- Tracer bullet: auto-fixable issue fixed on disk, exit 0, silent ---------
	// The headline behavior — formatting is fixed silently so it never bothers the
	// model. Proves the whole path: seam accepts stdin, parses the payload, resolves
	// the workroot, sees the config marker, accepts the .ts extension, runs biome
	// --write, mutates the file, and exits 0 with nothing surfaced.
	it("applies biome's safe fix to the edited file on disk and exits 0 without surfacing anything to the model", async () => {
		const repo = makeHookRepo({
			biome: BIOME_FORMAT_CONFIG,
			config: { files: [] },
			files: { "greeting.ts": FIXABLE_SOURCE },
		});
		const file = join(repo, "greeting.ts");
		const result = await run(["check", "--hook"], repo, hookStdin(file));
		expect(result.exitCode).toBe(0);
		// File mutated on disk to the known-good fixed form (double quotes + semicolon).
		const after = readFileSync(file, "utf8");
		expect(after).toContain('"hello"');
		expect(after).not.toContain("'hello'");
		// Silent on the model-facing channel: no findings surfaced on the fixed path.
		expect(result.stderr).toBe("");
	}, 20000);

	// --- Unfixable finding: exit 2 (the code Claude Code surfaces to the model) --
	it("exits 2 when an unfixable finding remains after the safe fix", async () => {
		const repo = makeHookRepo({
			biome: BIOME_LINT_CONFIG,
			config: { files: [] },
			files: { "eq.ts": LINTBAD },
		});
		const result = await run(
			["check", "--hook"],
			repo,
			hookStdin(join(repo, "eq.ts")),
		);
		expect(result.exitCode).toBe(2);
	}, 20000);

	it("surfaces the unfixable finding on stderr (the channel Claude Code shows the model on exit 2)", async () => {
		// The whole point of exit 2 is that Claude Code feeds STDERR back to the
		// model — findings routed to stdout would leave the model blind, so stderr is
		// the required channel, not an implementation detail.
		const repo = makeHookRepo({
			biome: BIOME_LINT_CONFIG,
			config: { files: [] },
			files: { "eq.ts": LINTBAD },
		});
		const result = await run(
			["check", "--hook"],
			repo,
			hookStdin(join(repo, "eq.ts")),
		);
		expect(result.stderr).toMatch(/eq\.ts/);
	}, 20000);

	// --- Guard: no dobby.config.json marker -> silent exit 0, file untouched -----
	// The config file is the "dobby project" gate. Without it the hook must not run
	// biome at all — the fixable file stays byte-for-byte unchanged (proving the
	// guard fired BEFORE biome, not that biome had nothing to fix).
	it("exits 0 silently and never touches the file when the repo has no dobby.config.json", async () => {
		const repo = makeHookRepo({
			biome: BIOME_FORMAT_CONFIG,
			// No config marker -> the "dobby project" gate fails.
			files: { "greeting.ts": FIXABLE_SOURCE },
		});
		const file = join(repo, "greeting.ts");
		const result = await run(["check", "--hook"], repo, hookStdin(file));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(readFileSync(file, "utf8")).toBe(FIXABLE_SOURCE);
	}, 20000);

	// --- Guard: unparsable stdin payload -> silent exit 0 ------------------------
	it("exits 0 silently on an unparsable (garbage) stdin payload", async () => {
		const repo = makeHookRepo({
			biome: BIOME_FORMAT_CONFIG,
			config: { files: [] },
			files: { "greeting.ts": FIXABLE_SOURCE },
		});
		const result = await run(["check", "--hook"], repo, "this is not json {{{");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	// --- Guard: valid JSON but no file_path -> silent exit 0 ---------------------
	it("exits 0 silently when the payload carries no file_path", async () => {
		const repo = makeHookRepo({
			biome: BIOME_FORMAT_CONFIG,
			config: { files: [] },
			files: { "greeting.ts": FIXABLE_SOURCE },
		});
		const result = await run(["check", "--hook"], repo, hookStdin(undefined));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	// --- Guard: file_path points at a nonexistent file -> silent exit 0 ---------
	it("exits 0 silently when the edited file does not exist", async () => {
		const repo = makeHookRepo({
			biome: BIOME_FORMAT_CONFIG,
			config: { files: [] },
			files: { "greeting.ts": FIXABLE_SOURCE },
		});
		const result = await run(
			["check", "--hook"],
			repo,
			hookStdin(join(repo, "ghost.ts")),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	// --- Guard: extension outside ts,tsx,js,jsx,json,jsonc,css -> silent exit 0 --
	// `.mjs` is NOT in the spec's supported list, yet biome WOULD format it (single
	// quote -> double, confirmed out-of-band). An unchanged file + exit 0 proves
	// the extension guard fired BEFORE biome, not that biome had nothing to do.
	it("exits 0 silently and never touches a file whose extension is outside the allowed list (.mjs)", async () => {
		const repo = makeHookRepo({
			biome: BIOME_FORMAT_CONFIG,
			config: { files: [] },
			files: { "thing.mjs": FIXABLE_SOURCE },
		});
		const file = join(repo, "thing.mjs");
		const result = await run(["check", "--hook"], repo, hookStdin(file));
		expect(result.exitCode).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(FIXABLE_SOURCE);
	}, 20000);

	// --- Guard (Decisions note): file_path outside the workroot -> exit 0 --------
	// The edited file lives OUTSIDE the project's workroot. With the repo's own
	// noDoubleEquals config, an UNGUARDED hook would lint the out-of-tree `==` and
	// exit 2 (confirmed out-of-band: biome lints an absolute out-of-tree path using
	// the project cwd's config). The guard must instead exit 0 — never block on a
	// file the project does not own. [Derived from the Decisions note "the hook
	// payload file_path may live outside the workroot — guard exits 0", NOT the
	// explicit guard list; flagged for the implementor/reviewer.]
	it("exits 0 when the edited file lives outside the project workroot", async () => {
		const repo = makeHookRepo({
			biome: BIOME_LINT_CONFIG,
			config: { files: [] },
			files: {},
		});
		// A sibling temp dir, NOT under the repo — the edited file's real home.
		const outside = realpathSync(
			mkdtempSync(join(tmpdir(), "dobby-hook-out-")),
		);
		hookDirs.push(outside);
		writeFileSync(join(outside, "eq.ts"), LINTBAD);
		const result = await run(
			["check", "--hook"],
			repo,
			hookStdin(join(outside, "eq.ts")),
		);
		expect(result.exitCode).toBe(0);
	}, 20000);
});

// ===========================================================================
// TASK 5 (plugin) — hooks.json rewired to `dobby check --hook`; the old
// vp-check-changes.sh deleted.
//
// The PostToolUse Edit|Write hook must invoke the LOCAL dobby bin
// (`node_modules/.bin/dobby check --hook`) behind a config-presence guard, and
// must NEVER use `bunx` (which would fetch the FOREIGN npm package named `dobby`
// in a repo that isn't a dobby project). Read as files: plugin/ sits beside cli/,
// reached from the repo root. Every expected string is a spec literal, and each
// assertion is RED against the current (vp-check-changes) hooks.json — the
// rewire is what turns it green.
// ===========================================================================

// plugin/hooks, resolved from cli/ (cliDir is defined with the task-3 presets).
const pluginHooksDir = resolve(cliDir, "..", "plugin", "hooks");

interface HooksFile {
	hooks?: {
		PostToolUse?: Array<{
			matcher?: string;
			hooks?: Array<{ type?: string; command?: string }>;
		}>;
	};
}

// Read + parse plugin/hooks/hooks.json. Throws (a RED test failure) if the file
// is missing or unparseable — transitively enforcing "hooks.json stays parseable
// JSON" without a separate green-before-impl assertion.
function readHooks(): { raw: string; parsed: HooksFile } {
	const raw = readFileSync(resolve(pluginHooksDir, "hooks.json"), "utf8");
	return { raw, parsed: JSON.parse(raw) as HooksFile };
}

// Every command string under a PostToolUse matcher that targets Edit or Write.
// An empty result (matcher removed, or JSON reshaped) fails the command
// assertions below — so the Edit|Write matcher is enforced transitively.
function editHookCommands(parsed: HooksFile): string[] {
	const out: string[] = [];
	for (const group of parsed.hooks?.PostToolUse ?? []) {
		if (!/Edit|Write/.test(group.matcher ?? "")) {
			continue;
		}
		for (const hook of group.hooks ?? []) {
			if (typeof hook.command === "string") {
				out.push(hook.command);
			}
		}
	}
	return out;
}

describe("plugin hooks.json — rewired to dobby check --hook", () => {
	it("invokes the LOCAL dobby bin with `check --hook`, never bunx", () => {
		const commands = editHookCommands(readHooks().parsed).join("\n");
		expect(commands).toContain("node_modules/.bin/dobby");
		expect(commands).toContain("check --hook");
		// bunx would fetch the foreign npm `dobby` in a non-dobby repo — forbidden.
		expect(commands).not.toContain("bunx");
	});

	it("guards on the dobby.config.json project marker before running", () => {
		const commands = editHookCommands(readHooks().parsed).join("\n");
		expect(commands).toContain("dobby.config.json");
	});

	it("no longer references the deleted vp-check-changes hook", () => {
		const raw = readHooks().raw;
		expect(raw).not.toContain("vp-check-changes");
		expect(raw).not.toContain("vp check");
	});

	it("deletes the vp-check-changes.sh script", () => {
		expect(existsSync(resolve(pluginHooksDir, "vp-check-changes.sh"))).toBe(
			false,
		);
	});
});

// ===========================================================================
// TASK — `dobby setup` MERGED INTO `dobby up` (one lifecycle entry point).
//
// USER DECISION (STATE.md Findings #32): fewer commands — the user always wants a
// workspace running when opening it. The standalone `setup` command is DELETED;
// its ordered sequence becomes the SETUP PHASE of `up`:
//   (1) `bun install` at the workroot — ALWAYS, the inferred default;
//   (2) worktree env re-materialization: in a LINKED git worktree, read the MAIN
//       checkout's `.worktreeinclude`, and for each pattern copy any matched file
//       that is MISSING at the worktree over from main (idempotent — NEVER
//       overwriting a file already present);
//   (3) config `setup[]` extras, run sequentially, FAIL-FAST on the first nonzero
//       (any setup-phase failure → clear error, exit 1, the RUN PHASE never starts).
// The `setup` command itself now falls through to the unknown-command path.
//
// THIS section keeps the shared helpers (SKIP_INSTALL, makeWorktree, makeSetupRepo,
// gitIn) that BACK the up setup-phase slices in the TASK 9 up section below, plus
// the setup-REMOVAL contract. The former setup contract tests (worktree-copy,
// extras fail-fast, dry-run plan) are FOLDED into the up slices — a real `up` now
// runs bun install first, so those slices set the documented DOBBY_SKIP_INSTALL=1
// seam (which STILL works for the setup phase inside up) exactly as the former
// setup tests did, and never invoke a real bun install.
//
// Observed ONLY through the run(argv, cwd) seam (the executor is never imported):
//   - Plan assertions read the `--dry-run` stdout (the plan text).
//   - Copy behavior is observed as real FILE side-effects in a throwaway git repo
//     + linked worktree we build at runtime (git init + worktree add) — the same
//     temp-repo precedent the env/check slices set (a committed __fixtures__ dir
//     would resolve its workroot to THIS repo).
//   - `bun install` is NEVER run in tests: dry-run covers the plan, and the
//     real-run copy/extras slices set the documented test seam DOBBY_SKIP_INSTALL=1
//     so the executor skips ONLY install while still performing copy + extras.
//
// Independent sources for every expected value below:
//   - `bun install` is the spec's literal inferred default (a Decision: "Default
//     inferred setup is always bun install").
//   - The re-materialized file's NAME (`.env.local`) and CONTENT are literals WE
//     write into the MAIN checkout only; the worktree never carried them (created
//     AFTER `git worktree add`, untracked) — so a copy is the ONLY path by which
//     they can appear at the worktree.
//   - Extra command strings are literals WE put in `dobby.config.json#setup`.
//   - The unknown-command literals (`unknown command: setup`, the upgrade hint),
//     the fail-hard-outside-git contract, the "extras APPEND after defaults", the
//     "never overwrite / second run is a no-op", and "dry-run executes nothing"
//     properties are the spec's / Decisions' literal wording.
// ===========================================================================

// The documented test seam (task constraint): DOBBY_SKIP_INSTALL=1 makes the
// executor skip `bun install` while still running the copy + extras steps, so a
// real run is exercised without ever invoking bun. Set around each real-run slice
// and restored — mirroring the CMUX env handling in the env slices above.
const SKIP_INSTALL = "DOBBY_SKIP_INSTALL";

// Run `git` in a specific dir with the isolated gitEnv (reused from the env slices).
function gitIn(dir: string, ...args: string[]): void {
	execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv });
}

// Build a THROWAWAY main checkout + a LINKED git worktree. The worktree is checked
// out from a single committed README, so it carries NONE of the main-only untracked
// files. AFTER the worktree exists we drop into the MAIN checkout (only) a
// `.worktreeinclude` (the given pattern lines) and the given main-only files — so
// they live SOLELY in main, and re-materialization is the ONLY path by which they
// can reach the worktree. `config` (when given) is written at the WORKTREE root
// (its own workroot). Returns { main, worktree }, both realpath-normalized to match
// git's resolved top-level. Registers both dirs in `track` for afterAll cleanup.
function makeWorktree(
	track: string[],
	opts: {
		worktreeinclude?: string[];
		mainFiles?: Record<string, string>;
		config?: unknown;
	} = {},
): { main: string; worktree: string } {
	const main = realpathSync(mkdtempSync(join(tmpdir(), "dobby-setup-main-")));
	track.push(main);
	gitIn(main, "init", "-q");
	gitIn(main, "checkout", "-q", "-b", "main");
	writeFileSync(join(main, "README"), "scratch\n");
	gitIn(main, "add", "-A");
	gitIn(main, "commit", "-q", "-m", "init");

	// A sibling path (same real parent, guaranteed non-existent) — git creates it.
	gitIn(main, "worktree", "add", "-q", "-b", "feature", `${main}-wt`);
	const worktree = realpathSync(`${main}-wt`);
	track.push(worktree);

	if (opts.worktreeinclude) {
		writeFileSync(
			join(main, ".worktreeinclude"),
			`${opts.worktreeinclude.join("\n")}\n`,
		);
	}
	for (const [rel, content] of Object.entries(opts.mainFiles ?? {})) {
		const full = join(main, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	if (opts.config !== undefined) {
		writeFileSync(
			join(worktree, "dobby.config.json"),
			JSON.stringify(opts.config, null, 2),
		);
	}
	return { main, worktree };
}

// A plain (NON-worktree) throwaway git repo — the workroot IS the repo root.
// `worktreeinclude` (when given) is written at the root; because this is NOT a
// linked worktree the re-materialization step must not fire regardless. `config`
// is written at the root. Returns the realpath-normalized root; registered in track.
function makeSetupRepo(
	track: string[],
	opts: {
		worktreeinclude?: string[];
		files?: Record<string, string>;
		config?: unknown;
	} = {},
): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-setup-repo-")));
	track.push(dir);
	gitIn(dir, "init", "-q");
	if (opts.worktreeinclude) {
		writeFileSync(
			join(dir, ".worktreeinclude"),
			`${opts.worktreeinclude.join("\n")}\n`,
		);
	}
	for (const [rel, content] of Object.entries(opts.files ?? {})) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	if (opts.config !== undefined) {
		writeFileSync(
			join(dir, "dobby.config.json"),
			JSON.stringify(opts.config, null, 2),
		);
	}
	return dir;
}

// --- The setup-REMOVAL contract (the behavioral setup-phase slices live in the
// up section below, folded into `up`). ----------------------------------------
// The standalone `setup` command is DELETED. Invoking it must now fall through to
// the unknown-command path (exit 1, capability-filtered usage, upgrade hint),
// exactly like the removed `capabilities` / `commit` commands, and it is no longer
// advertised in the usage Commands list. Every expected substring is the spec's
// literal wording.
describe("run() — setup command is removed (folded into up)", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	// A plain (non-git) temp dir. While `setup` is STILL wired (pre-removal) it
	// fails the git precondition (requireWorkroot) with a git error BEFORE any bun
	// install — so verifying this RED never runs a real install. Post-removal it is
	// the unknown command. Either way, no install is attempted here.
	function plainDir(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-nosetup-")));
		dirs.push(dir);
		return dir;
	}

	it("treats `setup` as an unknown command with the upgrade hint (exit 1, empty stdout)", async () => {
		const result = await run(["setup"], plainDir());
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		// The discriminating red: pre-removal `setup` runs its own git-precondition
		// path (a git error, not this literal); post-removal it is the unknown command.
		expect(result.stderr).toContain("unknown command: setup");
		expect(result.stderr).toContain(upgradeHint);
	}, 20000);

	it("no longer advertises `setup` in the usage Commands list", async () => {
		// Line-anchored to the Commands column (the same shape the bare-usage `env`
		// check and the commit-removal check use), so the Options block never counts.
		const result = await run([], plainDir());
		expect(result.exitCode).toBe(0);
		const advertisesSetup = result.stdout
			.split("\n")
			.some((line) => /^\s+setup\b/.test(line));
		expect(advertisesSetup).toBe(false);
	}, 20000);
});

// ===========================================================================
// TASK 7 — db:* inference + `dobby update` (DRIZZLE-ONLY after the removal).
//
// The pure db-task map lives in `tasks.ts` (dbTasks(capabilities)); run.ts routes
// any positional starting with `db:` through it. Per the task constraint the mapping
// is observed ONLY through the run(argv, cwd) seam against hand-written
// __fixtures__/db-* projects — tasks.ts is never imported directly. A fixture
// carries NO real drizzle-kit tool (no node_modules; it is not resolvable from this
// repo), so a REAL `dobby db:push` there must FAIL at spawn. The resolved command is
// therefore asserted through the approved `--dry-run` observability flag, which
// "prints the resolved command + cwd" with NO spawn — exactly as the constraint
// dictates. (A fixture's db capabilities come from the spec's fixed signal map —
// drizzle <- drizzle-orm/drizzle-kit — and its git workroot is this repo, so
// `--dry-run`'s workroot resolution never fails.)
//
// REMOVAL (this task): supabase-local is deleted, so drizzle is the ONLY db tool.
// dbTasks is drizzle-only — the SHORT `db:*` names ALWAYS map to drizzle-kit; the
// supabase task set AND the tool-namespacing-on-conflict logic are gone (no
// `db:supabase:*` / `db:drizzle:*` forms exist, and there is no `db:types` codegen —
// that was supabase). A project whose ONLY db-ish dependency is `supabase` now has
// NO db capability at all, so every `db:*` name errors there.
//
// Independent sources for every expected value below:
//   - Each resolved command string (`drizzle-kit push`, `drizzle-kit generate`, …)
//     is a LITERAL the spec's drizzle db:* map states outright — never recomputed by
//     the code under test.
//   - The "exactly-one-tool → short names" rule (drizzle is that one tool) and the
//     "supabase gives no db capability" rule are the spec's literal contract.
//   - The usage-text entries `db:*` and `update` are spec literals.
//
// Interface expectation this block pins (flagged for the implementor/reviewer):
// `--dry-run` renders the resolved command as a shell-style STRING (tool + args
// joined by spaces), matching the sibling `setup --dry-run` plan format the suite
// already asserts (`bun install`, `run: <cmd>`). Substring assertions on the mapped
// command survive either a logical command render or a resolved-bin-path render
// (`…/.bin/drizzle-kit push` still contains `drizzle-kit push`).
// ===========================================================================

// --- Slice 1 (tracer bullet): drizzle is the one db tool → SHORT db:* names ------
// The headline of the drizzle-only surface: `db:push` resolves to `drizzle-kit push`
// and dry-run plans it WITHOUT spawning (exit 0 despite the tool being absent). No
// supabase form exists anywhere.
describe("run() — db:* dispatch (drizzle is the one db tool, resolving the short names)", () => {
	it("resolves db:push to `drizzle-kit push` in a drizzle-only project (dry-run, exit 0, no spawn)", async () => {
		const result = await run(
			["db:push", "--dry-run"],
			fixture("db-drizzle-only"),
		);
		// exit 0 proves dry-run PLANNED without spawning: a real spawn of the ABSENT
		// drizzle-kit would exit nonzero (Slice 2 asserts exactly that).
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("unknown command");
		expect(result.stdout).toContain("drizzle-kit push");
		// The supabase tool is gone entirely: `db:push` is drizzle's, never supabase's.
		expect(result.stdout).not.toContain("supabase db push");
	});
});

// --- Slice 1b: a supabase-only project has NO db capability now ------------------
// supabase-local is deleted, so a project whose only db-ish dependency is `supabase`
// resolves NO db tasks: every `db:*` name is an error (exit 1), NOT a supabase
// command. This is the crisp removal proof for the deleted supabase task set.
describe("run() — db:* dispatch (a supabase dependency no longer yields any db task)", () => {
	it("errors (exit 1) on db:push in a supabase-only project — no db capability, and NEVER `supabase db push`", async () => {
		const result = await run(
			["db:push", "--dry-run"],
			fixture("db-supabase-removed"),
		);
		expect(result.exitCode).toBe(1);
		// The deleted task set: the old supabase mapping must not resurface.
		expect(combined(result)).not.toContain("supabase db push");
		expect(combined(result)).not.toContain("supabase db");
	});

	it("errors (exit 1) on db:start in a supabase-only project — the supabase task set is gone", async () => {
		// db:start was a supabase-only task; with supabase-local removed it is simply an
		// unknown db task in a project that has no db capability.
		const result = await run(
			["db:start", "--dry-run"],
			fixture("db-supabase-removed"),
		);
		expect(result.exitCode).toBe(1);
		expect(combined(result)).not.toContain("supabase start");
	});
});

// --- Slice 2: a real db:* run without the tool installed FAILS at spawn ----------
// The constraint: "invoking `dobby db:push` in a fixture WITHOUT the real tools must
// fail at spawn." This is the counterpart that makes the dry-run slices meaningful —
// dry-run is a genuine no-spawn PLAN, while a real run tries (and, tool absent,
// fails). db:push IS a known drizzle task here, so the failure is a spawn/resolution
// failure, NEVER the unknown-command path (the anti-tautology guard).
describe("run() — db:* dispatch (real run without --dry-run fails at spawn)", () => {
	it("exits nonzero when db:push runs (no --dry-run) in a project whose db tool is not installed", async () => {
		const result = await run(["db:push"], fixture("db-drizzle-only"));
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).not.toContain("unknown command");
	}, 20000);
});

// --- Slice 2b: the full drizzle task map (the ONLY db task set now) --------------
// "Pure mapping tested heavily" (task constraint). Each pair is a spec literal. This
// is the complete drizzle-only surface — the SHORT names always map to drizzle-kit,
// with no supabase forms and no `db:types` codegen (that was supabase).
describe("run() — db:* dispatch (drizzle task map)", () => {
	const cases: Array<[string, string]> = [
		["db:generate", "drizzle-kit generate"],
		["db:migrate", "drizzle-kit migrate"],
		["db:push", "drizzle-kit push"],
		["db:check", "drizzle-kit check"],
		["db:studio", "drizzle-kit studio"],
	];
	for (const [name, resolved] of cases) {
		it(`resolves ${name} to \`${resolved}\``, async () => {
			const result = await run([name, "--dry-run"], fixture("db-drizzle-only"));
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(resolved);
		});
	}
});

// --- Slice 3: an unknown db:* task errors with the available names listed --------
describe("run() — db:* dispatch (an unknown db:* task errors, exit 1, listing what IS available)", () => {
	it("errors (exit 1) on an unknown db:* task and lists the available drizzle task names", async () => {
		const result = await run(
			["db:frobnicate", "--dry-run"],
			fixture("db-drizzle-only"),
		);
		expect(result.exitCode).toBe(1);
		// "unknown -> exit 1 with the available names listed": the drizzle set. The
		// input was db:frobnicate, so a `db:push` in the output can only be the
		// available-names list (independent of the rejected input).
		const out = combined(result);
		expect(out).toContain("db:push");
		expect(out).toContain("db:studio");
	});
});

// --- Slice 8: `update` is a UNIVERSAL command in the usage text ------------------
// TASK 11 SUPERSEDES the earlier static `db:* (inferred; see dobby env)` usage line.
// Usage is now COMPUTED per repo (see the "TASK 11 — capability-aware usage" section
// at the end of this file): db:* appears ONLY when the cwd carries a db capability,
// so the old assertion that bare `dobby` ALWAYS advertises db:* no longer holds —
// this repo (the cwd) has no db capability, so it must NOT list any db task. What
// survives from the task-7 contract is that `update` is a UNIVERSAL command (always
// listed regardless of capabilities), asserted here; the interactive `dobby update`
// (taze --interactive, inherit stdio) is never auto-invoked in tests.
describe("run() — usage text: update is universal", () => {
	it("advertises the update command in the usage text (always, regardless of capabilities)", async () => {
		const result = await run([], cwd);
		const advertisesUpdate = result.stdout
			.split("\n")
			.some((line) => /^\s+update\b/.test(line));
		expect(advertisesUpdate).toBe(true);
	});
});

// ===========================================================================
// TASK 8 — `dobby dev` + streaming dispatch.
//
// The pure dev composition lives in the new `tasks.ts` `devPlan(capabilities,
// config)`; `lifecycle.ts` executes it and `run.ts` routes the `dev` positional.
// Per the task constraint, EVERY composition assertion is observed through the
// run(argv, cwd) seam using `--dry-run` on hand-written __fixtures__/dev-*
// projects — real dev servers are NEVER spawned (dry-run prints the plan, no
// spawn), and `tasks.ts`/`lifecycle.ts` are never imported directly.
//
// The streaming split (part a) is a PREFACTOR: `dev` (and `update`, `db:studio`)
// spawn with inherited stdio and live until child exit/signal — that streaming
// path and its process-group kill logic CANNOT be unit-tested here (no real
// server, and inherited stdio bypasses the run() capture seam), so it is covered
// by the wrap-stage human smoke + the verifier's live recipe, NOT CI (mirroring
// how `update` and `db:studio` are handled). What IS testable — and is the whole
// point of the "--dry-run on a streaming command routes through the CAPTURE path"
// clause — is that `dev --dry-run` returns its plan as DATA through run() (a
// streaming path would inherit stdio and return empty stdout): every slice below
// reads that captured plan.
//
// REMOVAL (this task): the dev plan drops its sequential-prereq phase (supabase
// start was the only prereq) AND the convex secondary. The shape is now simply
// main + concurrent secondaries, and react-email (`email dev --dir src/emails`) is
// the ONLY secondary. The fixtures:
//   - dev-admin   = drizzle + react-email + vite + vitest  (the surviving composition)
//   - dev-removed = vite + supabase dep + convex dep       (removal proof: even when
//                   supabase & convex ARE declared, dev plans NEITHER)
//   - dev-no-app  = react-email only, NO vite              (the no-app gate)
//
// Independent sources for every expected value below:
//   - Each command literal — `rm -rf node_modules/.vite` (the vite cache-clear),
//     `portless run … dev` (the portless-wrapped main), `email dev --dir src/emails`
//     (the react-email secondary at the CANONICAL emails dir), and the `nothing to
//     run` message — is a LITERAL the spec's dev recipe / Decisions state outright,
//     never recomputed by the code under test.
//   - The DELETED literals `supabase start` (the removed prereq) and `convex dev`
//     (the removed secondary) are asserted ABSENT — even on a fixture that declares
//     both a supabase and a convex dependency — which is the removal contract.
//   - Each fixture's capabilities come from the spec's fixed signal map
//     (detect.ts) applied to a package.json this suite ships — so which secondary
//     appears is derived independently of the dev planner.
//   - The order (cache-clear before the portless dev) and the "portless wraps ONLY
//     the main" rule are the spec's literal contract.
//
// Interface expectation these slices pin (flagged for the implementor/reviewer):
// `dev --dry-run` renders each planned command as a shell-style STRING (mirroring
// the sibling `setup`/`db:*` dry-run plan format the suite already asserts). The
// `<consumer vite bin>` inside the portless-wrapped main is asserted only via the
// substring `vite` on the portless line — robust whether it renders the logical
// bin name (`portless run vite dev`) or a resolved path (`…/.bin/vite`).
// ===========================================================================

// Whether a SINGLE line of `text` contains the `vite` dev wrapped by portless:
// one line naming `portless run`, the vite bin (`vite`), and the `dev` subcommand.
// Single-line-all-matchers is deliberate — it proves portless WRAPS the vite dev
// (not that the three tokens merely appear somewhere), and it is immune to an
// unrelated line (e.g. a printed `cwd:` path containing "dev-admin") satisfying
// only some matchers.
const portlessMainLine = (text: string) =>
	hasNoteLine(text, [/portless run/, /vite/, /\bdev\b/]);

// --- Slice 1 (tracer bullet): dev --dry-run plans via the CAPTURE path ---------
// The headline of this task — `dobby dev --dry-run` is wired, routes through the
// run() capture seam (returns the plan as DATA, not via inherited stdio), and
// exits 0. The captured `portless run` in stdout is the proof: a streaming path
// would have inherited stdio and returned empty stdout.
describe("run() — dev command (--dry-run routes through the capture path)", () => {
	it("prints a dev plan on stdout and exits 0 (not the unknown-command branch)", async () => {
		const result = await run(["dev", "--dry-run"], fixture("dev-admin"));
		expect(result.exitCode).toBe(0);
		// Anti-tautology guard: an unimplemented `dev` ALSO exits nonzero via the
		// unknown-command branch — assert this is the genuine dev/dry-run path.
		expect(result.stderr).not.toContain("unknown command");
		// The plan came back as DATA through run() (capture path), not inherited stdio.
		expect(result.stdout).toMatch(/portless run/);
	});
});

// --- Slice 2: the surviving composition (vite main + react-email secondary) -----
// The complete post-removal dev plan: vite => the `.vite` cache-clear + the
// portless-wrapped main; react-email => an `email dev --dir src/emails` secondary at
// the canonical dir. There is NO prereq phase and NO convex secondary. dev-admin
// declares drizzle + react-email + vite + vitest.
describe("run() — dev command (surviving composition: vite main + react-email secondary)", () => {
	it("wraps the vite dev in `portless run … dev` as the main process", async () => {
		const result = await run(["dev", "--dry-run"], fixture("dev-admin"));
		expect(result.exitCode).toBe(0);
		expect(portlessMainLine(result.stdout)).toBe(true);
	});

	it("includes the `.vite` cache-clear as part of the inferred vite dev, before the portless main", async () => {
		const result = await run(["dev", "--dry-run"], fixture("dev-admin"));
		const out = result.stdout;
		// The cache-clear removes node_modules/.vite (admin's preamble, now inferred).
		expect(hasNoteLine(out, [/rm/, /node_modules\/\.vite/])).toBe(true);
		// Ordering: the cache-clear precedes the portless-wrapped dev (spec: cache
		// clear "then" portless run).
		expect(out.indexOf("node_modules/.vite")).toBeLessThan(
			out.indexOf("portless run"),
		);
	});

	it("plans `email dev --dir src/emails` as a concurrent secondary for a react-email project", async () => {
		// The canonical emails dir `src/emails` is a spec Decision; one line names the
		// email dev command AND that dir. react-email is now the ONLY dev secondary.
		const result = await run(["dev", "--dry-run"], fixture("dev-admin"));
		expect(hasNoteLine(result.stdout, [/email dev/, /--dir src\/emails/])).toBe(
			true,
		);
	});

	it("does NOT wrap the react-email secondary in portless (portless wraps only the main)", async () => {
		// Discriminator for "portless wraps ONLY the main process": the email secondary
		// line must not carry portless.
		const result = await run(["dev", "--dry-run"], fixture("dev-admin"));
		const emailLine = result.stdout
			.split("\n")
			.find((line) => line.includes("email dev"));
		expect(emailLine, "expected an `email dev` line in the plan").toBeDefined();
		expect(emailLine).not.toContain("portless");
	});
});

// --- Slice 3: removal proof — supabase prereq & convex secondary are GONE --------
// The strongest removal assertion: even a project that DECLARES both a `supabase`
// dependency and a `convex` dependency alongside vite gets NEITHER a `supabase start`
// prereq NOR a `convex dev` secondary — the prereq phase and the convex secondary
// were deleted, not merely gated on absence. The portless main is the positive
// anchor proving a real plan was produced, so the two negatives are not vacuous.
describe("run() — dev command (removed: no supabase prereq, no convex secondary)", () => {
	it("produces a real vite dev plan (portless main present) as the positive anchor", async () => {
		const result = await run(["dev", "--dry-run"], fixture("dev-removed"));
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("unknown command");
		expect(portlessMainLine(result.stdout)).toBe(true);
	});

	it("plans NO `supabase start` prerequisite even though a supabase dependency is declared", async () => {
		const result = await run(["dev", "--dry-run"], fixture("dev-removed"));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("supabase start");
	});

	it("plans NO `convex dev` secondary even though a convex dependency is declared", async () => {
		const result = await run(["dev", "--dry-run"], fixture("dev-removed"));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("convex dev");
	});
});

// --- Slice 4: no app capability (no vite) => exit 1 'nothing to run' ------------
// The spec's explicit no-app gate. A project with a secondary-triggering
// capability (react-email) but NO vite still has no MAIN to run, so `dobby dev`
// exits 1 with 'nothing to run' — proving the gate is the vite/app, and a lone
// secondary is not an app. Safe to run WITHOUT --dry-run: no vite means the gate
// returns before any spawn, and the fixture's email bin is not installed anyway.
describe("run() — dev command (no app capability: nothing to run)", () => {
	it("exits 1 with 'nothing to run' for a project without the vite (app) capability", async () => {
		const result = await run(["dev"], fixture("dev-no-app"));
		expect(result.exitCode).toBe(1);
		// Anti-tautology guard: NOT the unknown-command branch (which also exits 1).
		expect(result.stderr).not.toContain("unknown command");
		expect(combined(result)).toMatch(/nothing to run/i);
	});

	it("exits 1 with 'nothing to run' under --dry-run too when there is no app to run", async () => {
		// A dry run of nothing is still nothing — the no-app gate holds regardless of
		// --dry-run. [Inferred from combining "No app => exit 1 'nothing to run'" with
		// "--dry-run prints the plan"; flagged for the implementor/reviewer.]
		const result = await run(["dev", "--dry-run"], fixture("dev-no-app"));
		expect(result.exitCode).toBe(1);
		expect(combined(result)).toMatch(/nothing to run/i);
	});
});

// ===========================================================================
// TASK 9 — `dobby up` / `dobby down` (the run-lifecycle pair).
//
// up/down mechanize execute Step 2 + finish teardown. Both are ACTION commands
// (fail hard outside git) and both expose `--dry-run`, which "prints the exact
// action plan" WITHOUT invoking anything. Per the task constraint, cmux, neonctl,
// portless and curl are NEVER invoked for real in tests: every path is asserted
// through the run(argv, cwd) seam via `--dry-run` PLANS, toggled by the
// CMUX_WORKSPACE_ID env var (set/unset) and hand-built fixtures (neon capability
// with/without .env.local creds; teardown extras). The `--db` flag is REMOVED this
// task (supabase-local support is gone), so `down` never stops supabase and rejects
// `--db` as an unknown option. lifecycle.ts is never imported directly.
//
// Where the git workroot, its basename `slug`, `.env.local`, `.dobby/` state, and
// the CMUX env var all matter, a committed __fixtures__ dir cannot serve (its git
// workroot would resolve to THIS repo). So — exactly as the env/check/setup/hook
// slices already do — each slice builds a THROWAWAY git repo in a temp dir, giving
// KNOWN independent values: the workroot is the dir WE create (read back via
// node:fs realpath / node:path basename — a DIFFERENT mechanism than the code's
// `git rev-parse --show-toplevel`), and the capabilities come from the spec's
// fixed signal map applied to a package.json WE write.
//
// Independent sources for every expected value below:
//   - The no-app message 'no app to run' (up step 0); the cmux command literals
//     `cmux new-pane` / `--type browser` / `--direction right` / `new-split down`
//     / `--surface` / `cmux send`; the pane names `dobby-browser-<slug>` /
//     `dobby-run-<slug>`; the detached-state paths `.dobby/dev.pid` /
//     `.dobby/dev.log`; the neon branch verbs `neonctl branches create` /
//     `neonctl branches delete` with `--project-id` and the branch `dobby/<slug>` —
//     each is a LITERAL the spec's up/down recipe states outright, never recomputed
//     by the code under test. (`supabase stop` no longer appears anywhere.)
//   - The slug (workroot basename) and workroot path are read back from the temp
//     dir WE created (node:path basename / node:fs realpath).
//   - The NEON_PROJECT_ID value `proj-123` and the teardown marker command are
//     literals WE write into .env.local / dobby.config.json — so the plan echoing
//     `proj-123` proves it parsed OUR .env.local, and the marker's file
//     side-effect is format-independent.
//
// Interface expectations these slices pin (flagged for the implementor/reviewer):
//   - `--dry-run` renders each planned action as a shell-style command line — the
//     SAME convention the sibling setup / db:* / dev dry-run plans already assert
//     (`bun install`, `drizzle-kit push`, `portless run … dev`). The slug/workroot
//     value assertions avoid the runtime devUrl (portless is absent in CI → devUrl
//     is null), so a null URL never breaks a plan assertion.
//   - The neon MISSING-creds check fails the command (exit 1) even under
//     `--dry-run`. Derived from the task constraint (the with/without-creds path is
//     asserted "via --dry-run plans") + the verify recipe ("neon capability sans
//     creds → exit ≠0 with message"): a dry run cannot plan a branch-create without
//     the project id, so the validation fires during planning.
// ===========================================================================

// Build a THROWAWAY git repo for the up/down slices: `git init` (enough for
// `git rev-parse --show-toplevel` to resolve the workroot — no commit needed),
// plus an optional package.json (capabilities), dobby.config.json (teardown
// extras), .env.local (neon creds), and .dobby/dev.pid (detached-run state).
// Returns the realpath-normalized root (matching git's resolved top-level); its
// basename is the `slug`. Registers the dir in `track` for afterAll cleanup.
function makeLifecycleRepo(
	track: string[],
	opts: {
		pkg?: unknown;
		config?: unknown;
		envLocal?: string;
		devPid?: string;
	} = {},
): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-life-")));
	track.push(dir);
	gitIn(dir, "init", "-q");
	if (opts.pkg !== undefined) {
		writeFileSync(join(dir, "package.json"), JSON.stringify(opts.pkg, null, 2));
	}
	if (opts.config !== undefined) {
		writeFileSync(
			join(dir, "dobby.config.json"),
			JSON.stringify(opts.config, null, 2),
		);
	}
	if (opts.envLocal !== undefined) {
		writeFileSync(join(dir, ".env.local"), opts.envLocal);
	}
	if (opts.devPid !== undefined) {
		mkdirSync(join(dir, ".dobby"), { recursive: true });
		writeFileSync(join(dir, ".dobby", "dev.pid"), opts.devPid);
	}
	return dir;
}

// A vite-only package.json (the app capability that gets past up's no-app gate).
const VITE_PKG = {
	name: "life-app",
	private: true,
	devDependencies: { vite: "^5.0.0" },
};
// vite + neon (@neondatabase/serverless -> the neon signal), so up reaches the
// neon isolation step (which is gated behind the app/vite check).
const VITE_NEON_PKG = {
	name: "life-neon",
	private: true,
	dependencies: { "@neondatabase/serverless": "^0.9.0" },
	devDependencies: { vite: "^5.0.0" },
};
// A well-formed .env.local carrying BOTH neon creds (+ the DATABASE_URL lines the
// branch step rewrites). `proj-123` is the project id WE inject.
const NEON_ENV_LOCAL =
	"NEON_API_KEY=napi_testkey\nNEON_PROJECT_ID=proj-123\n" +
	"DATABASE_URL=postgres://old@host/db\nDATABASE_URL_UNPOOLED=postgres://old@host/db_unpooled\n";

// --- Slice U1 (tracer bullet): `up` is wired and no-app-gates GRACEFULLY --------
// up's step 0: a project with NO vite (app) capability prints 'no app to run' and
// exits 0 — the graceful counterpart to `dev`'s hard 'nothing to run' exit 1. This
// also proves the command is genuinely wired (NOT the unknown-command branch). Safe
// to run WITHOUT --dry-run: step 0 returns before any probe / spawn / cmux / neon.
describe("run() — up command (no app capability: graceful no-op)", () => {
	const dirs: string[] = [];
	let originalCmux: string | undefined;
	let originalSkip: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		originalSkip = process.env[SKIP_INSTALL];
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		if (originalSkip === undefined) delete process.env[SKIP_INSTALL];
		else process.env[SKIP_INSTALL] = originalSkip;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
		delete process.env[SKIP_INSTALL];
	});

	it("exits 0 with 'no app to run' for a project without the vite capability (not the unknown-command path)", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: {
				name: "life-noapp",
				private: true,
				dependencies: { "drizzle-orm": "^0.30.0" },
			},
		});
		// up now runs the SETUP PHASE first (bun install) before the no-app gate; the
		// documented test seam skips ONLY the install so no real bun install runs,
		// while the rest of the setup phase and the no-app gate still execute.
		process.env[SKIP_INSTALL] = "1";
		const result = await run(["up"], repo);
		expect(result.exitCode).toBe(0);
		// Anti-tautology guard: an unimplemented `up` ALSO exits nonzero via the
		// unknown-command branch — assert this is the genuine up/no-app path.
		expect(result.stderr).not.toContain("unknown command");
		expect(combined(result)).toMatch(/no app to run/i);
	}, 20000);

	it("under --dry-run prints the FULL plan: the setup phase (bun install) plus the run phase skipped (no app to run)", async () => {
		// The spec's --dry-run contract: "prints the FULL ordered plan (setup phase +
		// run phase, including what would be skipped and why)". Even when the run phase
		// is skipped (no vite), the setup phase (bun install) is still shown, and the
		// skip reason ('no app to run') is named.
		const repo = makeLifecycleRepo(dirs, {
			pkg: {
				name: "life-noapp2",
				private: true,
				dependencies: { "drizzle-orm": "^0.30.0" },
			},
		});
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		// Setup phase is planned (the merge folded it into up)...
		expect(result.stdout).toMatch(/bun install/);
		// ...and the run phase is skipped, with the reason named.
		expect(combined(result)).toMatch(/no app to run/i);
	}, 20000);

	it("still renames the cmux workspace for a no-app project (rename is INDEPENDENT of the app gate)", async () => {
		// The workspace rename happens WHENEVER cmux is present — a no-app project
		// (setup phase then 'no app to run') still gets its workspace renamed. Set cmux
		// for THIS test only (beforeEach cleared it; afterAll restores the original).
		process.env[CMUX] = "cmux-ws-noapp";
		const repo = makeLifecycleRepo(dirs, {
			pkg: {
				name: "life-noapp3",
				private: true,
				dependencies: { "drizzle-orm": "^0.30.0" },
			},
		});
		const slug = basename(repo);
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		// The rename line is present (plain slug title) even though the run phase is
		// skipped...
		expect(result.stdout).toContain(
			`cmux rename-workspace --workspace cmux-ws-noapp "${slug}"`,
		);
		// ...proving the rename is NOT gated on the app: 'no app to run' still fires.
		expect(combined(result)).toMatch(/no app to run/i);
	}, 20000);
});

// --- Slice U2: `up` fails hard outside a git repo ------------------------------
// "Both fail hard outside git." A non-git dir (no workroot to pin slug / .env.local
// / .dobby to) must fail hard with a git message BEFORE anything — even though it
// also has no vite: the git precondition wins over the no-app gate.
describe("run() — up command (fail hard outside a git repo)", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("exits nonzero with a git-repo error when run outside a git repository", async () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "dobby-up-nogit-")));
		dirs.push(plain);
		const result = await run(["up", "--dry-run"], plain);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).not.toContain("unknown command");
		expect(result.stderr).toMatch(/git/i);
	}, 20000);
});

// --- Slice U3 (headline): cmux present -> the positional pane layout plan --------
// The load-bearing layout decision: browser pane to the RIGHT of Claude, run
// terminal BELOW the browser via `new-split down` TARGETED BY --surface (never
// focus-dependent). All asserted from the --dry-run plan; CMUX_WORKSPACE_ID drives
// the branch. Fixture is vite-ONLY (no neon) so step 2 is skipped and the plan
// reaches step 3's pane creation.
describe("run() — up command (cmux present: positional pane layout plan)", () => {
	const dirs: string[] = [];
	let repo: string;
	let slug: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		repo = makeLifecycleRepo(dirs, { pkg: VITE_PKG });
		slug = basename(repo);
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		process.env[CMUX] = "cmux-ws-up";
	});

	it("prints a plan that creates a cmux pane and exits 0 (not the unknown-command branch)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		// Anti-tautology guard: an unimplemented `up` ALSO exits nonzero via the
		// unknown-command branch — assert this is the genuine up/cmux/dry-run path, and
		// that the plan came back as DATA through the capture seam.
		expect(result.stderr).not.toContain("unknown command");
		expect(result.stdout).toContain("cmux new-pane");
	}, 20000);

	it("creates the browser pane to the RIGHT of Claude (--type browser --direction right)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		expect(
			hasNoteLine(result.stdout, [
				/new-pane/,
				/--type browser/,
				/--direction right/,
			]),
		).toBe(true);
	}, 20000);

	it("puts the run terminal BELOW the browser via a surface-targeted `new-split down` (never focus-dependent)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		const out = result.stdout;
		// The split is targeted by --surface (the browser ref), not by focus — the
		// load-bearing layout decision.
		expect(hasNoteLine(out, [/new-split down/, /--surface/])).toBe(true);
		// Ordering: the browser pane is created BEFORE the split that targets it.
		expect(out.indexOf("new-pane")).toBeLessThan(out.indexOf("new-split down"));
	}, 20000);

	it("names the panes `dobby-browser-<slug>` and `dobby-run-<slug>` (slug = workroot basename)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		// Independent: the slug is the basename of the temp dir WE created (read via
		// node:path, a different mechanism than the code's git top-level + basename).
		expect(result.stdout).toContain(`dobby-browser-${slug}`);
		expect(result.stdout).toContain(`dobby-run-${slug}`);
	}, 20000);

	it("sends the workroot-pinned `dobby dev` to the run pane", async () => {
		const result = await run(["up", "--dry-run"], repo);
		const sendLine = result.stdout
			.split("\n")
			.find((l) => l.includes("cmux send"));
		expect(sendLine, "expected a `cmux send` line in the plan").toBeDefined();
		// Pinned to the workroot (cmux has no --cwd on panes, so the `cd <workroot> &&`
		// prefix is the workroot-pinning invariant) and runs dobby dev.
		expect(sendLine).toContain(`cd ${repo}`);
		expect(sendLine).toContain("dobby dev");
	}, 20000);

	it("renames the cmux WORKSPACE to the plain goal slug (workspace context passed explicitly)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		// The workspace title IS the goal identity: the PLAIN slug (no dobby- prefix —
		// that prefix is carried by the PANE names). The workspace context is passed
		// explicitly (--workspace cmux-ws-up, matching the new-pane / list-panes style).
		// Independent: slug = basename of the temp dir WE created; cmux id = the value
		// beforeEach injected.
		expect(result.stdout).toContain(
			`cmux rename-workspace --workspace cmux-ws-up "${slug}"`,
		);
		// The rename is distinct from the PANE renames — its title is the bare slug, not
		// the dobby-browser-/dobby-run- pane forms.
		const renameLine = result.stdout
			.split("\n")
			.find((l) => l.includes("rename-workspace"));
		expect(renameLine).not.toContain(`dobby-browser-${slug}`);
		expect(renameLine).not.toContain(`dobby-run-${slug}`);
	}, 20000);
});

// --- Slice U4: NO cmux -> detached run + pidfile/log plan (the discriminator) ----
// Without a cmux workspace the start path spawns `dobby dev` DETACHED, with pid +
// log under <workroot>/.dobby/. The absence of any `cmux new-pane` is the
// discriminator proving the cmux branch was NOT taken.
describe("run() — up command (no cmux: detached run + pidfile plan)", () => {
	const dirs: string[] = [];
	let repo: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		repo = makeLifecycleRepo(dirs, { pkg: VITE_PKG });
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("plans a detached `dobby dev` with pid + log under .dobby/ when CMUX_WORKSPACE_ID is unset", async () => {
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		const out = result.stdout;
		expect(out).toContain("dobby dev");
		expect(out).toContain(".dobby/dev.pid");
		expect(out).toContain(".dobby/dev.log");
	}, 20000);

	it("plans NO cmux pane creation without a cmux workspace (the start-path discriminator)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		// Positive anchor so the negative is not vacuously true on an empty/unimplemented
		// output: a real detached plan IS produced (exit 0, spawning dobby dev) and it
		// carries NO cmux pane creation.
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("dobby dev");
		expect(result.stdout).not.toContain("cmux new-pane");
	}, 20000);

	it("plans NO cmux workspace rename without a cmux workspace", async () => {
		const result = await run(["up", "--dry-run"], repo);
		// Positive anchor (a real detached plan IS produced) so the negative is not
		// vacuously true: with cmux unset there is no workspace to rename.
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("dobby dev");
		expect(result.stdout).not.toContain("rename-workspace");
	}, 20000);
});

// --- Slice U5: neon isolation (creds parsed from .env.local at the workroot) -----
// neon capability => up parses .env.local for NEON_API_KEY + NEON_PROJECT_ID.
// EITHER missing => EXIT 1 (guaranteed isolation, no silent main-DB fallback). Both
// present => an idempotent branch-create plan `neonctl branches create dobby/<slug>
// --project-id <id>`, plus rewriting the DATABASE_URL lines. Fixture is vite+neon so
// step 0 passes and up reaches the neon step. CMUX unset (neon is cmux-independent).
describe("run() — up command (neon isolation: creds from .env.local)", () => {
	const dirs: string[] = [];
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("exits 1 with a neon message when the neon capability is present but .env.local is absent (no silent main-DB fallback)", async () => {
		const repo = makeLifecycleRepo(dirs, { pkg: VITE_NEON_PKG });
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain("unknown command");
		expect(combined(result)).toMatch(/neon/i);
	}, 20000);

	it("exits 1 when only ONE of the two neon creds is present (EITHER missing fails)", async () => {
		// NEON_API_KEY present, NEON_PROJECT_ID missing -> still exit 1 (it checks BOTH,
		// not merely that a .env.local exists).
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_NEON_PKG,
			envLocal: "NEON_API_KEY=napi_testkey\n",
		});
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain("unknown command");
	}, 20000);

	it("plans an idempotent neon branch create `dobby/<slug>` with the project id parsed from .env.local when both creds are present", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_NEON_PKG,
			envLocal: NEON_ENV_LOCAL,
		});
		const slug = basename(repo);
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		const out = result.stdout;
		expect(out).toContain("neonctl branches create");
		expect(out).toContain(`dobby/${slug}`);
		expect(out).toContain("--project-id");
		// Independent: the project id was read from OUR .env.local (proves the parse).
		expect(out).toContain("proj-123");
	}, 20000);

	it("plans rewriting the .env.local DATABASE_URL lines from the branch connection strings", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_NEON_PKG,
			envLocal: NEON_ENV_LOCAL,
		});
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		// The rewrite target: the DATABASE_URL* keys and/or the .env.local file (the
		// exact plan wording of the rewrite is spec-thin — flagged for the reviewer).
		expect(combined(result)).toMatch(/DATABASE_URL|\.env\.local/);
	}, 20000);
});

// ---------------------------------------------------------------------------
// up SETUP PHASE — the former `setup` command, FOLDED into `up` (Findings #32).
//
// `up` now runs, before the run phase: (1) bun install, (2) linked-worktree
// .worktreeinclude re-materialization, (3) config setup[] extras (fail-fast). The
// former standalone-setup contract tests move here, retargeted at `up`. A real
// `up` runs bun install first, so every real-run slice sets DOBBY_SKIP_INSTALL=1
// (the seam STILL works for the setup phase inside up) and never invokes bun.
// Independent expected values: `bun install` is the spec's literal inferred
// default; the copied file's name/content are literals we write into MAIN only;
// extra command strings are literals we put in dobby.config.json#setup.
// ---------------------------------------------------------------------------

// --- Slice U6 (merge headline): the setup phase PRECEDES the run phase ----------
// The load-bearing proof of the merge — `up --dry-run` now prints the FULL ordered
// plan and the SETUP PHASE (bun install) comes BEFORE the RUN PHASE. A vite project
// (so the run phase has a real action) with no cmux → the run phase spawns a
// detached `dobby dev`; the ORDER `bun install` < `dobby dev` is the invariant.
describe("run() — up command (setup phase precedes the run phase in the dry-run plan)", () => {
	const dirs: string[] = [];
	let repo: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		repo = makeLifecycleRepo(dirs, { pkg: VITE_PKG });
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("names the `bun install` setup default in the plan (the folded setup phase), exit 0 (not the unknown-command path)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("unknown command");
		expect(result.stdout).toMatch(/bun install/);
	}, 20000);

	it("orders the setup phase (`bun install`) BEFORE the run phase (`dobby dev`)", async () => {
		const result = await run(["up", "--dry-run"], repo);
		const out = result.stdout;
		// Presence guards first, so the ordering assertion can never pass vacuously on
		// a missing `bun install` (indexOf -1 < anything).
		expect(out).toMatch(/bun install/);
		expect(out).toContain("dobby dev");
		expect(out.indexOf("bun install")).toBeLessThan(out.indexOf("dobby dev"));
	}, 20000);

	it("plans NO copy in a plain (non-worktree) repo even when a .worktreeinclude is present (the linked-worktree gate)", async () => {
		// Discriminator for the linked-worktree gate: re-materialization fires ONLY in
		// a LINKED worktree — a `.worktreeinclude` (and even a matching file) in a plain
		// repo produces no copy. Positive anchor (bun install) keeps the negative
		// non-vacuous: the setup phase DID run, it just planned no copy.
		const plain = makeSetupRepo(dirs, {
			worktreeinclude: [".env.local"],
			files: { ".env.local": "SECRET=plain\n" },
		});
		const result = await run(["up", "--dry-run"], plain);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/bun install/);
		expect(result.stdout).not.toMatch(/\.env\.local/);
	}, 20000);
});

// --- Slice U7: up's setup phase re-materializes .worktreeinclude matches ---------
// The folded worktree-copy contract: in a LINKED worktree, up copies each main-only
// .worktreeinclude match that is MISSING at the worktree, idempotently (never
// clobbering). The makeWorktree fixture has no package.json → no vite → after the
// copy, up hits the no-app gate (exit 0), so no run-phase spawn ever occurs.
describe("run() — up command (setup phase: .worktreeinclude re-materialization)", () => {
	const dirs: string[] = [];
	let originalSkip: string | undefined;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalSkip = process.env[SKIP_INSTALL];
		originalCmux = process.env[CMUX];
	});

	afterAll(() => {
		if (originalSkip === undefined) delete process.env[SKIP_INSTALL];
		else process.env[SKIP_INSTALL] = originalSkip;
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[SKIP_INSTALL];
		delete process.env[CMUX];
	});

	it("dry-run lists the copy of a main-only .worktreeinclude match, and executes nothing", async () => {
		const { worktree } = makeWorktree(dirs, {
			worktreeinclude: [".env.local"],
			mainFiles: { ".env.local": "SECRET=from-main\n" },
		});
		const result = await run(["up", "--dry-run"], worktree);
		expect(result.exitCode).toBe(0);
		// The plan names the copy it WOULD make.
		expect(result.stdout).toMatch(/\.env\.local/);
		// Dry run: nothing is executed -> the file was NOT actually copied.
		expect(existsSync(join(worktree, ".env.local"))).toBe(false);
	}, 20000);

	it("copies a main-only .worktreeinclude match into the worktree with main's exact content", async () => {
		const { worktree } = makeWorktree(dirs, {
			worktreeinclude: [".env.local"],
			mainFiles: { ".env.local": "SECRET=from-main\n" },
		});
		process.env[SKIP_INSTALL] = "1"; // skip `bun install`; the copy step still runs.
		const result = await run(["up"], worktree);
		expect(result.exitCode).toBe(0);
		const copied = join(worktree, ".env.local");
		expect(existsSync(copied)).toBe(true);
		// Independent expected value: the literal we wrote into MAIN (a copy is the
		// only path by which it can appear at the worktree).
		expect(readFileSync(copied, "utf8")).toBe("SECRET=from-main\n");
	}, 20000);

	it("second run is a no-op: never overwrites an already-present worktree file (idempotent end-to-end)", async () => {
		const { worktree } = makeWorktree(dirs, {
			worktreeinclude: [".env.local"],
			mainFiles: { ".env.local": "SECRET=from-main\n" },
		});
		const target = join(worktree, ".env.local");
		process.env[SKIP_INSTALL] = "1";
		// First run copies main's file in.
		const first = await run(["up"], worktree);
		expect(first.exitCode).toBe(0);
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("SECRET=from-main\n");
		// A local edit the developer makes after re-materialization.
		writeFileSync(target, "SECRET=edited-locally\n");
		// The second run must NOT clobber it — copy only fills MISSING files.
		const second = await run(["up"], worktree);
		expect(second.exitCode).toBe(0);
		expect(readFileSync(target, "utf8")).toBe("SECRET=edited-locally\n");
	}, 20000);
});

// --- Slice U8: up's setup phase runs config setup[] extras (append + fail-fast) ---
// Extras APPEND after `bun install`, still WITHIN the setup phase (before the run
// phase). On a real run they execute fail-fast; a setup-phase failure exits 1 and
// the RUN PHASE never starts. To keep every real run spawn-free, the fail-fast/pass
// pair uses a NO-APP project (drizzle only): a passing setup phase reaches the
// no-app gate ('no app to run', exit 0); a failing one short-circuits before it.
describe("run() — up command (setup phase: config setup[] extras)", () => {
	const dirs: string[] = [];
	const MARKER = "dobby-up-setup-marker";
	const ALPHA = "dobby-up-extra-alpha";
	let originalSkip: string | undefined;
	let originalCmux: string | undefined;

	// A no-app (no vite) project, so a SUCCESSFUL setup phase reaches step 2's no-app
	// gate rather than spawning a real dev server.
	const NOAPP_PKG = {
		name: "life-extras-noapp",
		private: true,
		dependencies: { "drizzle-orm": "^0.30.0" },
	};

	beforeAll(() => {
		originalSkip = process.env[SKIP_INSTALL];
		originalCmux = process.env[CMUX];
	});

	afterAll(() => {
		if (originalSkip === undefined) delete process.env[SKIP_INSTALL];
		else process.env[SKIP_INSTALL] = originalSkip;
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[SKIP_INSTALL];
		delete process.env[CMUX];
	});

	it("dry-run appends config setup[] extras AFTER the `bun install` default, still BEFORE the run phase", async () => {
		// Decision: extras APPEND after the inferred default (never replace). A vite
		// project so the run phase has a real action to order against; no cmux → the
		// run phase is `dobby dev`. Order: bun install < extra < dobby dev.
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_PKG,
			config: { files: [], setup: [`echo ${ALPHA}`] },
		});
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		const out = result.stdout;
		expect(out).toMatch(/bun install/);
		expect(out).toContain(ALPHA);
		expect(out).toContain("dobby dev");
		expect(out.indexOf("bun install")).toBeLessThan(out.indexOf(ALPHA));
		expect(out.indexOf(ALPHA)).toBeLessThan(out.indexOf("dobby dev"));
	}, 20000);

	it("dry-run lists a setup extra but does not execute it (its marker never appears)", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_PKG,
			config: { files: [], setup: [`touch ${MARKER}`] },
		});
		const result = await run(["up", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(MARKER);
		expect(existsSync(join(repo, MARKER))).toBe(false);
	}, 20000);

	it("real run executes a passing setup extra (its side-effect appears) then reaches the no-app gate, exit 0", async () => {
		// Efficacy anchor: the extra genuinely runs on the real setup path (so the
		// fail-fast test's ABSENT marker below is meaningful), and control then reaches
		// step 2 (no vite → 'no app to run', exit 0) — proving the setup phase runs
		// BEFORE the no-app gate.
		const repo = makeLifecycleRepo(dirs, {
			pkg: NOAPP_PKG,
			config: { files: [], setup: [`touch ${MARKER}`] },
		});
		process.env[SKIP_INSTALL] = "1";
		const result = await run(["up"], repo);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(repo, MARKER))).toBe(true);
		expect(combined(result)).toMatch(/no app to run/i);
	}, 20000);

	it("real run fails fast on a nonzero setup extra (exit 1) and the RUN PHASE never starts", async () => {
		// `false` exits nonzero; the `touch` extra ordered AFTER it must never run
		// (fail-fast), AND the flow short-circuits BEFORE step 2 — so 'no app to run'
		// is never printed. This pins "any setup-phase failure → exit 1, run phase
		// never starts".
		const repo = makeLifecycleRepo(dirs, {
			pkg: NOAPP_PKG,
			config: { files: [], setup: ["false", `touch ${MARKER}`] },
		});
		process.env[SKIP_INSTALL] = "1";
		const result = await run(["up"], repo);
		expect(result.exitCode).toBe(1);
		// Anti-tautology guard: the real fail-fast path, NOT the unknown-command branch.
		expect(result.stderr).not.toContain("unknown command");
		// Fail-fast: the extra AFTER the failing one never ran.
		expect(existsSync(join(repo, MARKER))).toBe(false);
		// The setup-phase failure short-circuits before the no-app gate (step 2).
		expect(combined(result)).not.toMatch(/no app to run/i);
	}, 20000);
});

// --- Slice D1 (tracer bullet): `down` is wired and no-ops on nothing to clean ----
// A repo with no panes (cmux unset), no pidfile, no neon, no config teardown has
// nothing to clean -> exit 0. Safe to run WITHOUT --dry-run (every cleanup step is
// gated off). Also proves down is genuinely wired (NOT the unknown-command branch).
describe("run() — down command (nothing to clean: no-op)", () => {
	const dirs: string[] = [];
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("exits 0 on a repo with nothing to clean (no panes, no pidfile, no neon, no config) — not the unknown-command path", async () => {
		const repo = makeLifecycleRepo(dirs, { pkg: VITE_PKG });
		const result = await run(["down"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("unknown command");
	}, 20000);
});

// --- Slice D2: `down` fails hard outside a git repo ----------------------------
describe("run() — down command (fail hard outside a git repo)", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("exits nonzero with a git-repo error when run outside a git repository", async () => {
		const plain = realpathSync(
			mkdtempSync(join(tmpdir(), "dobby-down-nogit-")),
		);
		dirs.push(plain);
		const result = await run(["down", "--dry-run"], plain);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).not.toContain("unknown command");
		expect(result.stderr).toMatch(/git/i);
	}, 20000);
});

// --- Slice D3: down plans the neon branch delete (neon + creds) -----------------
// The teardown counterpart to up's create: neon capability + .env.local creds =>
// `neonctl branches delete dobby/<slug>` (a missing branch is idempotently ok).
describe("run() — down command (neon branch delete plan)", () => {
	const dirs: string[] = [];
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("plans `neonctl branches delete dobby/<slug>` when the neon capability + .env.local creds are present", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_NEON_PKG,
			envLocal: NEON_ENV_LOCAL,
		});
		const slug = basename(repo);
		const result = await run(["down", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		const out = result.stdout;
		expect(out).toContain("neonctl branches delete");
		expect(out).toContain(`dobby/${slug}`);
	}, 20000);
});

// --- Slice D4: the `--db` flag is REMOVED; supabase is never stopped -------------
// supabase-local support is deleted, so `down` loses `--db` (and every supabase-stop
// mention). The fixture is a "former-supabase" project — it still DECLARES a
// `supabase` dependency (proving the removal is not merely "no supabase present") and
// carries neon creds so a plain `down` produces a real teardown plan (the neon-branch
// delete is the positive anchor making the "no supabase stop" negatives meaningful).
describe("run() — down command (the --db flag is removed; supabase is never stopped)", () => {
	const dirs: string[] = [];
	let repo: string;
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
		repo = makeLifecycleRepo(dirs, {
			pkg: {
				name: "life-formersupa",
				private: true,
				dependencies: { "@neondatabase/serverless": "^0.9.0" },
				devDependencies: { vite: "^5.0.0", supabase: "^1.150.0" },
			},
			envLocal: NEON_ENV_LOCAL,
		});
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("rejects the removed `--db` flag (exit 1) — the flag no longer exists", async () => {
		const result = await run(["down", "--db", "--dry-run"], repo);
		expect(result.exitCode).toBe(1);
		// Anti-tautology guard: `down` IS a known command — the failure is the removed
		// FLAG, not an unimplemented command.
		expect(result.stderr).not.toContain("unknown command");
		expect(combined(result)).not.toContain("supabase stop");
	}, 20000);

	it("plans the neon-branch delete but NEVER a `supabase stop` on a plain `down`", async () => {
		const result = await run(["down", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		// Positive anchor: down genuinely produced a teardown plan (neon branch delete),
		// so the "no supabase stop" negative below is not vacuously true.
		expect(result.stdout).toContain("neonctl branches delete");
		// The removal: no supabase stop, even though a `supabase` dependency is declared.
		expect(combined(result)).not.toContain("supabase stop");
	}, 20000);
});

// --- Slice D5: config teardown[] extras run on down ------------------------------
// down runs the config `teardown[]` extras. The extra has a FILE side-effect (a
// touched marker) — format-independent. Dry-run lists it without running it; a real
// run executes it (the efficacy anchor that makes the dry-run's absent marker
// meaningful). CMUX unset + no neon/pidfile, so a real `down` runs ONLY the extra.
describe("run() — down command (config teardown[] extras)", () => {
	const dirs: string[] = [];
	const MARKER = "dobby-teardown-marker";
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("dry-run lists a teardown extra but does not execute it (its marker never appears)", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_PKG,
			config: { files: [], teardown: [`touch ${MARKER}`] },
		});
		const result = await run(["down", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(MARKER);
		expect(existsSync(join(repo, MARKER))).toBe(false);
	}, 20000);

	it("real run executes the teardown extra (its file side-effect appears), exit 0", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_PKG,
			config: { files: [], teardown: [`touch ${MARKER}`] },
		});
		const result = await run(["down"], repo);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(repo, MARKER))).toBe(true);
	}, 20000);
});

// --- Slice D6: a stale pidfile is cleaned up silently ---------------------------
// down reads <workroot>/.dobby/dev.pid; a STALE pid (not alive) => clean up the file
// silently, no signal sent. 2147483647 (2^31-1) is far above any live pid on
// darwin/linux, so the liveness check treats it as stale. The file existed before; a
// clean down removes it. Safe: no live process, no cmux (unset), no neon.
describe("run() — down command (stale pidfile cleaned up silently)", () => {
	const dirs: string[] = [];
	let originalCmux: string | undefined;

	beforeAll(() => {
		originalCmux = process.env[CMUX];
	});

	afterAll(() => {
		if (originalCmux === undefined) delete process.env[CMUX];
		else process.env[CMUX] = originalCmux;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	beforeEach(() => {
		delete process.env[CMUX];
	});

	it("removes a stale .dobby/dev.pid (a pid that is not alive) and exits 0", async () => {
		const repo = makeLifecycleRepo(dirs, {
			pkg: VITE_PKG,
			devPid: "2147483647\n",
		});
		const pidfile = join(repo, ".dobby", "dev.pid");
		expect(existsSync(pidfile)).toBe(true);
		const result = await run(["down"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("unknown command");
		expect(existsSync(pidfile)).toBe(false);
	}, 20000);
});

// ===========================================================================
// TASK 21 — Remove `dobby commit`; add `check --fix` (the pre-commit standard).
//
// USER DECISION (STATE.md Findings #31): `dobby commit` wrapped git for little
// value — it is DELETED. The cross-project standard becomes running the quality
// gate before committing: **`bunx dobby check --fix` IS the pre-commit gate** in
// every project; whoever commits (the /dobby:commit SKILL, a human, any tool)
// runs it first, and the git/gh ceremony lives in the SKILL, not the CLI.
//
//   (a) `dobby commit` is GONE — it now falls through to the unknown-command path
//       (exit 1, the capability-filtered usage, and the `bun update @kvnwolf/dobby`
//       upgrade hint), like any other unrecognised command. Its commit-only flags
//       (--pr / --pr-title / --pr-body-file) go with it, and it is no longer
//       advertised in the usage Commands list.
//   (b) `dobby check` gains `--fix`: it applies biome's SAFE fixes PROJECT-WIDE
//       first (`biome check --write`, SAFE only — never the UNSAFE `==`→`===`
//       rewrite), THEN runs the selected pipeline and reports what remains. It
//       composes with the selective flags (`--fix --lint` = fix then lint-report)
//       and with the no-flag full gate; per-file mode (`check <files> --fix`) fixes
//       just those files. (`--hook` already fixes — unchanged, covered by Task 5.)
//
// Observed ONLY through the run(argv, cwd) seam. The commit-removal slices run
// against an ISOLATED plain (non-git) temp dir — never this repo — so verifying
// them RED can NEVER stage/commit/push anything (while `commit` is still wired it
// aborts on the missing git precondition). The `--fix` slices build throwaway git
// repos we mutate on disk (a committed __fixtures__ dir would resolve its workroot
// to THIS repo, AND --fix writes files) — the real bundled biome runs.
//
// Independent sources for every expected value below:
//   - The unknown-command literals (`unknown command: commit`, the upgrade hint)
//     are the spec's own wording; the "not advertised" facts are the removal
//     contract — never recomputed by the code under test.
//   - Each `--fix` expected value was confirmed OUT-OF-BAND against the bundled
//     biome 2.5.x (a DIFFERENT mechanism than the dobby code): a single-quoted,
//     semicolon-less source is SAFELY rewritten to `"hello";` (worked BY HAND from
//     quoteStyle "double" + semicolons "always") with zero remaining findings
//     (exit 0); an `a == b` is left untouched by a SAFE `--write` (its only fix is
//     UNSAFE), so the finding survives and the report exits 1.
// ===========================================================================

// --- Slice R1: `dobby commit` is removed → the unknown-command path -------------
// The removal contract. `commit` is no longer a recognised command, so it falls
// through to the same exit-1 unknown-command path as any typo — carrying the
// upgrade hint — and it is dropped from the usage Commands list.
describe("run() — commit command is removed", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	// A plain (non-git) temp dir — GUARANTEES no commit can occur while `commit` is
	// still wired (it fails the git precondition before touching any index).
	function plainDir(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-nocommit-")));
		dirs.push(dir);
		return dir;
	}

	it("treats `commit` as an unknown command with the upgrade hint (exit 1, empty stdout)", async () => {
		const result = await run(["commit", "a message"], plainDir());
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		// The discriminating red: pre-removal `commit` runs its own git-precondition
		// path (a git error, not this literal); post-removal it is the unknown command.
		expect(result.stderr).toContain("unknown command: commit");
		expect(result.stderr).toContain(upgradeHint);
	}, 20000);

	it("no longer advertises `commit` in the usage Commands list", async () => {
		const result = await run([], plainDir());
		expect(result.exitCode).toBe(0);
		// Line-anchored to the Commands column (same shape as the bare-usage `env`
		// check), so the Options block never counts as a command entry.
		const advertisesCommit = result.stdout
			.split("\n")
			.some((line) => /^\s+commit\b/.test(line));
		expect(advertisesCommit).toBe(false);
	});
});

// --- `dobby check --fix` — safe project-wide fix, then report -------------------
// Biome config that ENABLES the formatter (quoteStyle "double", semicolons
// "always") so a SAFE `--write` genuinely mutates files, AND keeps an isolated
// noDoubleEquals linter (recommended off) so an `==` is an UNFIXABLE (unsafe-only)
// finding that survives a safe fix.
const BIOME_FIX_CONFIG = {
	formatter: { enabled: true, indentStyle: "space", indentWidth: 2 },
	assist: { enabled: false },
	javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
	linter: {
		enabled: true,
		rules: { recommended: false, suspicious: { noDoubleEquals: "error" } },
	},
};

// A purely-format-broken source (single quote + no semicolon). Under
// BIOME_FIX_CONFIG the SAFE `--write` rewrites it to `export const greeting =
// "hello";` (known-good, worked BY HAND; confirmed out-of-band) with NOTHING left
// to report.
const FIX_FORMAT_ONLY = "export const greeting = 'hello'\n";

// A second format-only source, for the project-wide-reach and per-file-scoping
// slices. Known-good fixed form: `export const other = "y";`.
const FIX_OTHER = "export const other = 'y'\n";

// A source mixing a SAFE-fixable format issue (single quote on line 2) with an
// UNFIXABLE one (`a == b` on line 3 → noDoubleEquals, whose only fix is UNSAFE).
// Confirmed out-of-band: a SAFE `--write` rewrites line 2 to `const label = "x";`
// but leaves the `==` — so after `--fix` the file carries `"x"` AND still `a == b`,
// and the report names this file and fails.
const FIX_MIXED =
	"export function eq(a: number, b: number): boolean {\n  const label = 'x'\n  return a == b\n}\n";

// Build a THROWAWAY git repo shaped for `check --fix`: BIOME_FIX_CONFIG (formatter
// on, so a SAFE `--write` mutates files; noDoubleEquals on, so an `==` is an
// unfixable finding), a strict tsconfig over src (the full-gate tsc step), and a
// knip-clean package.json (entry = all of src) so tsc/knip never contaminate the
// fixable-only assertions. A bare `git init` resolves the workroot. Returns the
// realpath-normalized root; registered in `track` for cleanup.
function makeFixRepo(track: string[], src: Record<string, string>): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-fix-")));
	track.push(dir);
	execFileSync("git", ["init", "-q"], {
		cwd: dir,
		stdio: "ignore",
		env: gitEnv,
	});
	writeFileSync(
		join(dir, "biome.jsonc"),
		JSON.stringify(BIOME_FIX_CONFIG, null, 2),
	);
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
				include: ["src"],
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "fix-fixture",
				private: true,
				knip: { entry: ["src/**/*.ts"], project: ["src/**/*.ts"] },
			},
			null,
			2,
		),
	);
	for (const [rel, content] of Object.entries(src)) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("run() — check --fix (safe project-wide fix, then report)", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	// --- Slice 1 (tracer): a format-broken file is fixed on disk, exit 0 ----------
	// The headline of the task — `--fix` applies biome's safe fixes then reports.
	// Before --fix exists it is an unknown flag (parse error, exit 1, nothing
	// written), so exit 0 AND the on-disk mutation both prove the real fix path ran.
	it("applies biome's safe fix to a format-broken file on disk and exits 0 (--fix --lint)", async () => {
		const repo = makeFixRepo(dirs, { "src/greeting.ts": FIX_FORMAT_ONLY });
		const file = join(repo, "src", "greeting.ts");
		const result = await run(["check", "--fix", "--lint"], repo);
		expect(result.exitCode).toBe(0);
		const after = readFileSync(file, "utf8");
		expect(after).toContain('"hello"');
		expect(after).not.toContain("'hello'");
	}, 30000);

	// --- Slice 2: --fix applies SAFE fixes but NEVER the unsafe `==` fix -----------
	it("applies the safe format fix but leaves the unsafe `==` untouched under --fix", async () => {
		const repo = makeFixRepo(dirs, { "src/mixed.ts": FIX_MIXED });
		const file = join(repo, "src", "mixed.ts");
		const result = await run(["check", "--fix", "--lint"], repo);
		expect(result.exitCode).toBe(1);
		const after = readFileSync(file, "utf8");
		// The safe format fix landed (single quote → double) — proof biome --write ran.
		expect(after).toContain('"x"');
		expect(after).not.toContain("'x'");
		// … yet the UNSAFE `==`→`===` fix was NEVER applied: the `==` survives on disk.
		expect(after).toContain("a == b");
	}, 30000);

	// --- Slice 3: the remaining unfixable finding is reported ----------------------
	it("reports the remaining unfixable finding (names the file) and exits 1 under --fix", async () => {
		const repo = makeFixRepo(dirs, { "src/mixed.ts": FIX_MIXED });
		const result = await run(["check", "--fix", "--lint"], repo);
		expect(result.exitCode).toBe(1);
		// After fixing what it safely can, --fix runs the selected pipeline and reports
		// what remains — the `==` finding names the file (stdout is empty on the
		// pre-removal parse-error path, so this is a genuine red).
		expect(result.stdout).toMatch(/mixed\.ts/);
	}, 30000);

	// --- Slice 4: project-wide reach + full-gate composition (no flags) ------------
	// `--fix` with NO selective flag fixes EVERY file (project-wide) and then runs
	// the FULL gate; both fixed files leave the gate clean (exit 0).
	it("fixes every file project-wide and passes the full gate (no flags) with exit 0", async () => {
		const repo = makeFixRepo(dirs, {
			"src/greeting.ts": FIX_FORMAT_ONLY,
			"src/other.ts": FIX_OTHER,
		});
		const result = await run(["check", "--fix"], repo);
		expect(result.exitCode).toBe(0);
		// BOTH files were rewritten (project-wide, not just one).
		expect(readFileSync(join(repo, "src", "greeting.ts"), "utf8")).toContain(
			'"hello"',
		);
		expect(readFileSync(join(repo, "src", "other.ts"), "utf8")).toContain(
			'"y"',
		);
	}, 60000);

	// --- Slice 5: per-file mode fixes ONLY the named file --------------------------
	it("fixes only the named file under per-file mode (check <file> --fix), leaving others untouched", async () => {
		const repo = makeFixRepo(dirs, {
			"src/target.ts": FIX_FORMAT_ONLY,
			"src/other.ts": FIX_OTHER,
		});
		const result = await run(["check", "src/target.ts", "--fix"], repo);
		expect(result.exitCode).toBe(0);
		// The named file is fixed …
		expect(readFileSync(join(repo, "src", "target.ts"), "utf8")).toContain(
			'"hello"',
		);
		// … and the OTHER file is left exactly as written (per-file scope).
		expect(readFileSync(join(repo, "src", "other.ts"), "utf8")).toBe(FIX_OTHER);
	}, 30000);

	// --- Slice 6 (guard): a plain check (no --fix) never mutates -------------------
	// Proves --fix is the mutation trigger: an ordinary `check` is read-only, so the
	// format-broken file is byte-for-byte unchanged. (Green today; it anchors the
	// meaning of every "mutated on disk" assertion above.)
	it("never mutates files under a plain check (no --fix)", async () => {
		const repo = makeFixRepo(dirs, { "src/greeting.ts": FIX_FORMAT_ONLY });
		const file = join(repo, "src", "greeting.ts");
		await run(["check", "--lint"], repo);
		expect(readFileSync(file, "utf8")).toBe(FIX_FORMAT_ONLY);
	}, 30000);
});
// ===========================================================================
// TASK 11 — cli/README.md + capability-aware usage.
//
// (a) The usage/help text is COMPUTED per repo from the SAME capability detection
//     `env` uses (detectCapabilities over the PASSED cwd — NOT a git-workroot
//     resolve). This is load-bearing for the tests: the committed __fixtures__
//     live INSIDE this git repo, so a workroot resolve would collapse EVERY fixture
//     to this repo's own (empty) capabilities and the whole matrix would be
//     meaningless — capability detection must read the cwd's package.json, exactly
//     as env's `capabilities:` line already does. The field-report bug: the static
//     help advertised dev/up/down/db:* in a plugin repo that has neither a vite nor
//     a db capability. The new contract:
//       - UNIVERSAL commands are ALWAYS listed: env, check, update. (`setup` is
//         DELETED this task — folded into `up`'s setup phase — so it is no longer
//         advertised anywhere; `up` stays vite-gated per the split below.)
//       - dev / up / down are listed ONLY with the `vite` capability.
//       - db:* is listed ONLY with a db capability (drizzle — the one db tool now
//         that supabase-local is removed), showing the ACTUAL resolved SHORT task
//         names (`db:push`, `db:studio`, …). There is no tool-namespacing and no
//         `db:supabase:*` / `db:drizzle:*` forms.
//       - the unknown-command error's command list follows the SAME filter.
//     Observed ONLY through the run(argv, cwd) seam on hand-written __fixtures__
//     whose capabilities WE control: empty-pkg (no capabilities), db-drizzle-only
//     (one db tool, no vite), dev-admin (vite + drizzle). Every expected value is
//     SPEC-derived: which command belongs to which capability, and the resolved db
//     task names (`db:push`, `db:studio`), come from the task spec + the db:* map —
//     never recomputed by the code under test.
//
// (b) cli/README.md — the npm package's front page. Asserted as a FILE: it must
//     document the FULL command surface (all commands, regardless of the per-repo
//     help filter), the thin-config `extends` model, the conventions, and the
//     dobby.config.json schema, and it must state that the help output is
//     capability-filtered. Every expected literal (the install line, the `extends`
//     targets, the canonical paths) is stated outright by the spec.
// ===========================================================================

// A command is advertised in the usage Commands list when SOME line BEGINS with
// (indentation then) that command token — the same line-anchored shape the existing
// bare-usage checks use (`^\s+env\b`). Anchoring to the line start scopes the check
// to the Commands column, so the Options block (whose `--dry-run` blurb happens to
// mention "dev / db:* / up / down" mid-line) is never mistaken for a command entry.
function advertisesCommand(text: string, token: string): boolean {
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^\\s+${escaped}(?=\\s|$)`);
	return text.split("\n").some((line) => re.test(line));
}

// Whether the Commands list carries ANY db:* task entry (line-anchored, so the
// Options `--dry-run` mention of `db:*` never counts as a command).
function advertisesAnyDbCommand(text: string): boolean {
	return text.split("\n").some((line) => /^\s+db:/.test(line));
}

// The commands the spec fixes as UNIVERSAL — always listed, whatever the repo's
// capabilities.
// `commit` and `setup` are both REMOVED (commit → `check --fix`; setup folded into
// `up`), so neither is a universal command any longer — their removal and absence
// from the usage are pinned by the "commit command is removed" / "setup command is
// removed" describes above.
const UNIVERSAL_COMMANDS = ["env", "check", "update"];

// --- Slice 1 (tracer bullet): the field-report fix on the real repo -------------
// The headline behavior — the exact bug the field report named: bare `dobby` in
// THIS plugin repo listed dev/up/down/db:* though it has NEITHER a vite NOR a db
// capability (its package.json declares no matching signal). cwd IS that repo, so
// this reproduces the report directly and pins the fix.
describe("run() — capability-aware usage (field-report fix: this plugin repo)", () => {
	it("does NOT advertise dev in the bare usage of this repo (no vite capability)", async () => {
		const result = await run([], cwd);
		expect(result.exitCode).toBe(0);
		expect(advertisesCommand(result.stdout, "dev")).toBe(false);
	});

	it("does NOT advertise any db:* task in the bare usage of this repo (no db capability)", async () => {
		const result = await run([], cwd);
		expect(result.exitCode).toBe(0);
		expect(advertisesAnyDbCommand(result.stdout)).toBe(false);
	});
});

// --- Slice 2: a no-capability fixture hides the vite/db-gated commands -----------
// The same contract on a deterministic hand-written fixture (empty-pkg declares no
// signals): the vite-gated trio (dev/up/down) and every db:* task are absent.
describe("run() — capability-aware usage (no-capability repo hides dev/up/down/db:*)", () => {
	it("hides the vite-gated commands dev, up, and down", async () => {
		const result = await run([], fixture("empty-pkg"));
		expect(result.exitCode).toBe(0);
		expect(advertisesCommand(result.stdout, "dev")).toBe(false);
		expect(advertisesCommand(result.stdout, "up")).toBe(false);
		expect(advertisesCommand(result.stdout, "down")).toBe(false);
	});

	it("hides every db:* task (no drizzle capability)", async () => {
		const result = await run([], fixture("empty-pkg"));
		expect(result.exitCode).toBe(0);
		expect(advertisesAnyDbCommand(result.stdout)).toBe(false);
	});
});

// --- Slice 3: universal commands are ALWAYS listed (over-filter guard) -----------
// The other half of the filter contract: env/check/update survive in
// a no-capability repo. Guards against an implementation that over-filters and drops
// a universal command while removing the capability-gated ones.
describe("run() — capability-aware usage (universal commands always listed)", () => {
	for (const name of UNIVERSAL_COMMANDS) {
		it(`advertises the universal command '${name}' even in a no-capability repo`, async () => {
			const result = await run([], fixture("empty-pkg"));
			expect(result.exitCode).toBe(0);
			expect(advertisesCommand(result.stdout, name)).toBe(true);
		});
	}
});

// --- Slice 4: a single db tool → SHORT db:* names, still no vite lifecycle -------
// db-drizzle-only carries drizzle-kit (one db capability) and NO vite. So the usage
// lists the SHORT db names from the drizzle map (db:push, db:studio — spec literals)
// and NEVER the tool-namespaced forms; and because there is no vite capability,
// dev/up/down stay hidden — proving db-gating and vite-gating are independent axes.
describe("run() — capability-aware usage (single db tool → short db:* names)", () => {
	it("advertises the resolved SHORT db task names (db:push, db:studio) for a drizzle-only repo", async () => {
		const result = await run([], fixture("db-drizzle-only"));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("db:push");
		expect(result.stdout).toContain("db:studio");
	});

	it("never uses the tool-namespaced forms when only one db tool is present", async () => {
		const result = await run([], fixture("db-drizzle-only"));
		expect(result.stdout).not.toContain("db:drizzle:");
		expect(result.stdout).not.toContain("db:supabase:");
	});

	it("still hides dev/up/down for a db-only repo without the vite capability", async () => {
		const result = await run([], fixture("db-drizzle-only"));
		expect(advertisesCommand(result.stdout, "dev")).toBe(false);
		expect(advertisesCommand(result.stdout, "up")).toBe(false);
		expect(advertisesCommand(result.stdout, "down")).toBe(false);
	});
});

// --- Slice 5: vite + drizzle → dev/up/down + SHORT db:* names --------------------
// dev-admin is the surviving vite + drizzle fixture: vite (devDep) + drizzle-orm
// (dep) + react-email + vitest. vite → dev/up/down are listed; drizzle (the one db
// tool now) → the SHORT db task names (db:push, db:studio) appear and NO
// tool-namespaced form exists (supabase-local is removed).
describe("run() — capability-aware usage (vite + drizzle)", () => {
	it("advertises the vite-gated commands dev, up, and down", async () => {
		const result = await run([], fixture("dev-admin"));
		expect(result.exitCode).toBe(0);
		expect(advertisesCommand(result.stdout, "dev")).toBe(true);
		expect(advertisesCommand(result.stdout, "up")).toBe(true);
		expect(advertisesCommand(result.stdout, "down")).toBe(true);
	});

	it("describes `up` as 'prepare + run the workspace' — the merged setup+run entry point, not just the run command", async () => {
		// setup is folded into up, so up's usage description now covers PREPARE (bun
		// install + worktree copies + extras) as well as run. The old up description
		// named only the run command, so /prepare/i on the up line is the discriminator.
		const result = await run([], fixture("dev-admin"));
		expect(result.exitCode).toBe(0);
		const upLine = result.stdout
			.split("\n")
			.find((line) => /^\s+up\b/.test(line));
		expect(upLine, "usage should list `up`").toBeDefined();
		expect(upLine).toMatch(/prepare/i);
	});

	it("advertises the SHORT drizzle db task names (db:push, db:studio)", async () => {
		const result = await run([], fixture("dev-admin"));
		expect(result.stdout).toContain("db:push");
		expect(result.stdout).toContain("db:studio");
	});

	it("uses NO tool-namespaced db forms (db:drizzle:* / db:supabase:*)", async () => {
		const result = await run([], fixture("dev-admin"));
		expect(result.stdout).not.toContain("db:drizzle:");
		expect(result.stdout).not.toContain("db:supabase:");
	});
});

// --- Slice 6: the unknown-command error follows the SAME filter ------------------
// Spec: "the unknown-command error and any command suggestions follow the same
// filter." The unknown-command path prints its command list on STDERR (the existing
// unknown-command slice pins that), so the filter must apply there too: hidden in a
// no-capability repo, and showing the resolved short db names in a drizzle-only repo.
describe("run() — capability-aware usage (the unknown-command error follows the same filter)", () => {
	it("hides dev/up/down and every db:* task in the unknown-command usage of a no-capability repo", async () => {
		const result = await run(["frobnicate"], fixture("empty-pkg"));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unknown command: frobnicate");
		expect(advertisesCommand(result.stderr, "dev")).toBe(false);
		expect(advertisesCommand(result.stderr, "up")).toBe(false);
		expect(advertisesCommand(result.stderr, "down")).toBe(false);
		expect(advertisesAnyDbCommand(result.stderr)).toBe(false);
	});

	it("shows the resolved short db:* names in the unknown-command usage of a drizzle-only repo", async () => {
		const result = await run(["frobnicate"], fixture("db-drizzle-only"));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("db:push");
	});
});

// ---------------------------------------------------------------------------
// TASK 11(b) — cli/README.md, the npm-facing package documentation.
//
// Asserted purely as file content (like the preset assets). `safeRead` returns ""
// for an absent file, so every content assertion fails as a clean mismatch until
// the README is written. Each expected literal is a spec-stated value.
// ---------------------------------------------------------------------------
describe("cli/README.md — npm-facing package documentation", () => {
	it("exists at the cli package root", () => {
		expect(existsSync(cliFile("README.md"))).toBe(true);
	});

	it("introduces @kvnwolf/dobby as a zero-config toolchain", () => {
		const raw = safeRead("README.md");
		expect(raw).toContain("@kvnwolf/dobby");
		expect(raw).toMatch(/zero-config/i);
	});

	it("documents the single-devDependency install", () => {
		expect(safeRead("README.md")).toContain("bun add -d @kvnwolf/dobby");
	});

	it("documents the thin-config extends targets (tsconfig + biome/react)", () => {
		const raw = safeRead("README.md");
		expect(raw).toContain("@kvnwolf/dobby/tsconfig");
		expect(raw).toContain("@kvnwolf/dobby/biome/react");
	});

	it("documents the full command surface with dobby-prefixed examples", () => {
		// `dobby commit` (→ `check --fix`) and `dobby setup` (folded into `up`) are
		// both REMOVED — no longer part of the surface. Their absence is pinned by the
		// sibling slices (the commit/setup removal describes and the negatives below).
		const raw = safeRead("README.md");
		for (const cmd of [
			"dobby env",
			"dobby check",
			"dobby dev",
			"dobby up",
			"dobby down",
			"dobby update",
		]) {
			expect(raw, `README must document \`${cmd}\``).toContain(cmd);
		}
		// db:* tasks are part of the documented surface (drizzle-only short names).
		expect(raw).toContain("db:");
	});

	it("documents `dobby up` as 'prepare + run the workspace (idempotent)' — the single lifecycle entry point", () => {
		// Spec part (c): up absorbs setup, so up's OWN docs must now cover PREPARE as
		// well as run + idempotent. Splitting on `###` headings isolates the up section
		// from the (deleted) setup section, so the "prepare" currently living in the
		// setup section can't satisfy this vacuously — the word must appear in up's own
		// section.
		const raw = safeRead("README.md");
		expect(raw).toContain("dobby up");
		const upSection =
			raw
				.split(/^###\s/m)
				.find((section) => /^`?dobby up\b/.test(section.trimStart())) ?? "";
		expect(upSection, "README must have a `dobby up` section").not.toBe("");
		expect(upSection).toMatch(/prepare/i);
		expect(upSection).toMatch(/idempotent/i);
	});

	it("no longer documents the removed standalone `dobby setup` command, but keeps the setup[] extras as up's setup phase", () => {
		// The removal contract on the docs: the standalone command is gone from the
		// surface, but the `setup[]` config extras survive — now documented as running
		// in up's setup phase (so the word "setup" still appears; only the command
		// invocation `dobby setup` is purged).
		const raw = safeRead("README.md");
		// Anti-vacuous guard: the README must have real content.
		expect(raw.length).toBeGreaterThan(0);
		expect(raw).not.toContain("dobby setup");
		// The setup[] extras are documented as part of up's setup phase.
		expect(raw).toMatch(/setup phase/i);
	});

	it("documents `dobby check --fix` and the convention of running it before committing", () => {
		// Spec part (c): the README documents `check --fix` and states the standard —
		// "run `bunx dobby check --fix` before committing — it IS the pre-commit gate".
		const raw = safeRead("README.md");
		expect(raw).toContain("check --fix");
		expect(raw).toMatch(/before commit/i);
		expect(raw).toMatch(/pre[- ]commit/i);
	});

	it("no longer documents the removed `dobby commit` command or its `--pr` flag", () => {
		// The removal contract on the docs: the commit command and its commit-only PR
		// flags are gone from the CLI, so the README must not advertise them.
		const raw = safeRead("README.md");
		// Anti-vacuous guard: the README must have real content, else the negatives
		// below pass trivially on an empty string.
		expect(raw.length).toBeGreaterThan(0);
		expect(raw).not.toContain("dobby commit");
		expect(raw).not.toContain("--pr");
	});

	it("documents the key command flags in examples (--json, --hook, --dry-run, --fix)", () => {
		// `--db` (supabase-local) and `--pr` (commit) are both REMOVED, so neither is
		// documented; `--fix` is the new documented check flag.
		const raw = safeRead("README.md");
		for (const flag of ["--json", "--hook", "--dry-run", "--fix"]) {
			expect(raw, `README must document the ${flag} flag`).toContain(flag);
		}
	});

	it("notes that the help output is capability-filtered per repo", () => {
		const raw = safeRead("README.md");
		expect(raw).toMatch(/capabilit/i);
		expect(raw).toMatch(/help|usage/i);
		expect(raw).toMatch(
			/filter|only what applies|applicable|subset|per[- ]repo/i,
		);
	});

	it("documents the surviving canonical conventions (emails dir, NEON creds in .env.local)", () => {
		// `src/emails` STAYS; `src/database.types.ts` DIES (it was supabase codegen,
		// removed this task) — asserted absent by the purge test below.
		const raw = safeRead("README.md");
		expect(raw).toContain("src/emails");
		expect(raw).toContain(".env.local");
		expect(raw).toMatch(/NEON_/);
	});

	it("purges every supabase and convex mention, and the dead src/database.types.ts path", () => {
		// The removal contract on the docs: supabase-local and convex support are gone,
		// so the README must not mention either tool, and the supabase-codegen canonical
		// path `src/database.types.ts` must not appear.
		const raw = safeRead("README.md");
		// Anti-vacuous guard: the README must actually exist / have content, else the
		// negatives below pass trivially on an empty string.
		expect(raw.length).toBeGreaterThan(0);
		expect(raw).not.toMatch(/supabase/i);
		expect(raw).not.toMatch(/convex/i);
		expect(raw).not.toContain("src/database.types.ts");
	});

	it("documents the dobby.config.json schema (files[] + setup/teardown/checks extras)", () => {
		// The config schema is UNCHANGED by the merge: setup[] extras stay under the
		// same `setup` key (now consumed by up's setup phase, not a standalone command).
		const raw = safeRead("README.md");
		expect(raw).toContain("dobby.config.json");
		expect(raw).toContain("files");
		expect(raw).toContain("setup");
		expect(raw).toContain("teardown");
		expect(raw).toContain("checks");
	});
});

// ===========================================================================
// FIELD BUG — Bundled-first binary resolution for every CLI spawn.
//
// The reproduced bug: `dobby env` in a vite worktree printed `devUrl: null`
// because the CLI spawned a BARE `portless` from PATH — and portless is NOT on
// PATH even though dobby BUNDLES it (a declared CLI dependency). The fix routes
// every spawn site through ONE resolver (`resolveBin(name, { scope, root })`):
//   - BUNDLED tools (portless, biome, tsc, knip, taze) resolve from DOBBY's OWN
//     dependency tree (walked from the runner module's own location) — so they
//     work regardless of PATH; PATH is only a last-resort fallback.
//   - CONSUMER tools (vite, vitest, drizzle-kit, email)
//     resolve from `<workroot>/node_modules/.bin/<name>` first, bare fallback.
// Part (c) of the fix: the `--dry-run` plans must RENDER the resolved absolute
// paths so the resolution is OBSERVABLE — that render is the seam these tests
// use (no real tool is ever spawned; portless is exercised for real only as the
// deterministic, daemon-free `env` devUrl resolution asserted in the task-2
// devUrl slices above).
//
// Observed ONLY through the run(argv, cwd) seam. runner.ts / lifecycle.ts /
// tasks.ts are NEVER imported directly — the resolved paths surface purely as
// the dry-run plan text. Each slice builds a THROWAWAY git repo in a temp dir
// (a committed __fixtures__ dir would resolve its workroot to THIS repo, whose
// node_modules carries none of the consumer tools anyway).
//
// Independent sources for every expected value below:
//   - The CONSUMER bin's absolute path is exactly `<workroot>/node_modules/.bin/
//     <tool>` — a file WE create in the temp repo, so its path is a KNOWN
//     LITERAL the resolved dry-run plan must echo (never recomputed by the code
//     under test).
//   - The BUNDLED portless bin lives in DOBBY's own dependency tree (portless is
//     a declared CLI dependency — an independent fact from cli/package.json). We
//     never hardcode dobby's install path; the resolved token must be ABSOLUTE,
//     sit under a `node_modules` tree, and EXIST on disk (existsSync) — a real
//     bin, not a fabricated string.
//   - The PATH-independence property (bundled resolution ignores PATH) and the
//     bare-fallback property ("no consumer bin → the bare name") are the fix's
//     literal contract.
// ===========================================================================

// Build a THROWAWAY git repo for the bin-resolution slices: `git init` (enough
// for the workroot to resolve — `git rev-parse --show-toplevel` needs no
// commit), a package.json (the capabilities), and — for each name in
// `consumerBins` — a fake, executable `<root>/node_modules/.bin/<name>` so the
// CONSUMER resolver finds a KNOWN absolute path. The bins are never executed
// (dry-run only). Returns the realpath-normalized root (matching git's resolved
// top-level); registered in `track` for afterAll cleanup.
function makeBinResRepo(
	track: string[],
	opts: { pkg?: unknown; consumerBins?: string[] } = {},
): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-binres-")));
	track.push(dir);
	gitIn(dir, "init", "-q");
	if (opts.pkg !== undefined) {
		writeFileSync(join(dir, "package.json"), JSON.stringify(opts.pkg, null, 2));
	}
	for (const name of opts.consumerBins ?? []) {
		const binDir = join(dir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		const binPath = join(binDir, name);
		writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
		chmodSync(binPath, 0o755);
	}
	return dir;
}

// The portless-wrapped MAIN line of a `dev --dry-run` plan: the only line that
// carries BOTH the portless wrapper (` run `) and the `dev` subcommand. After
// the fix its leading token is the RESOLVED portless path; before it, the bare
// word `portless`. (The `Dev plan (dry-run):` header and the `rm -rf
// node_modules/.vite` cache-clear line match neither ` run ` nor a lowercase
// `\bdev\b`, so this uniquely finds the portless main.)
const devMainLine = (stdout: string): string | undefined =>
	stdout.split("\n").find((l) => / run /.test(l) && /\bdev\b/.test(l));

// The whitespace-delimited token on `line` referencing `tool` — the resolved
// absolute path after the fix, or the bare tool name before it. Immune to the
// plan's leading indentation.
const toolToken = (line: string, tool: string): string | undefined =>
	line
		.split(/\s+/)
		.filter(Boolean)
		.find((t) => t.includes(tool));

// The resolved-command line of a `db:* --dry-run` plan: the line naming the db
// tool's subcommand, never the `cwd:` line (which carries the workroot path).
const dbCommandLine = (stdout: string, tool: string): string | undefined =>
	stdout
		.split("\n")
		.find((l) => l.includes(tool) && !l.trim().startsWith("cwd:"));

// --- Slice 1 (tracer bullet): bundled portless resolves PATH-independently -----
// The headline of the fix — the exact field bug. A vite project's `dev --dry-run`
// must render the portless wrapper as an ABSOLUTE path from dobby's OWN tree, and
// that resolution must hold even with PATH emptied (portless is never on PATH).
describe("run() — dev command (bundled portless resolves from dobby's own tree)", () => {
	const dirs: string[] = [];
	let repo: string;

	beforeAll(() => {
		// vite ONLY (the app) and NO consumer vite bin — so vite stays bare and the
		// portless wrapper is the sole thing under test here.
		repo = makeBinResRepo(dirs, {
			pkg: { name: "binres-vite", devDependencies: { vite: "^5.0.0" } },
		});
	});

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("renders the portless wrapper as an ABSOLUTE bundled path in `dev --dry-run` (never the bare word `portless`)", async () => {
		const result = await run(["dev", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		// Anti-tautology guard: an unimplemented `dev` ALSO exits nonzero via the
		// unknown-command branch — assert this is the genuine dev/dry-run path.
		expect(result.stderr).not.toContain("unknown command");
		const line = devMainLine(result.stdout);
		expect(
			line,
			"expected a portless-wrapped dev line in the plan",
		).toBeDefined();
		const token = toolToken(line ?? "", "portless");
		expect(token, "expected a portless token on the main line").toBeDefined();
		// The field bug: a BARE `portless` (off PATH) fails to spawn. The fix
		// resolves dobby's bundled copy to an ABSOLUTE path.
		expect(token?.startsWith("/")).toBe(true);
	}, 20000);

	it("resolves portless to a real bin inside a node_modules tree (absolute + exists on disk)", async () => {
		const result = await run(["dev", "--dry-run"], repo);
		const token = toolToken(devMainLine(result.stdout) ?? "", "portless") ?? "";
		expect(token.startsWith("/")).toBe(true);
		// dobby bundles portless as a dependency, so the resolved path sits under a
		// node_modules tree and names a REAL file (not a fabricated string).
		expect(token).toContain("node_modules");
		expect(existsSync(token)).toBe(true);
	}, 20000);

	it("still resolves portless to an absolute existing path when PATH is emptied (reproduces the field condition)", async () => {
		// The exact field condition: portless is NOT on the spawn PATH. Bundled
		// resolution walks dobby's node_modules, so it must be PATH-independent — a
		// `which portless`-style (PATH-based) resolver would find nothing here and
		// fall back to the bare word.
		const savedPath = process.env.PATH;
		// A minimal PATH that still carries `git` (the workroot resolve) but NOT
		// portless.
		process.env.PATH = "/usr/bin:/bin";
		try {
			const result = await run(["dev", "--dry-run"], repo);
			expect(result.exitCode).toBe(0);
			const token =
				toolToken(devMainLine(result.stdout) ?? "", "portless") ?? "";
			expect(token.startsWith("/")).toBe(true);
			expect(existsSync(token)).toBe(true);
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
	}, 20000);
});

// --- Slice 2: consumer bin resolution in `dev --dry-run` (vite) -----------------
// The consumer half: with a fake <workroot>/node_modules/.bin/vite the dev plan
// must render that EXACT absolute path; without it, the bare `vite` name.
describe("run() — dev command (consumer vite bin resolution in the plan)", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("renders the consumer vite bin as the absolute <workroot>/node_modules/.bin/vite path when present", async () => {
		const repo = makeBinResRepo(dirs, {
			pkg: {
				name: "binres-vite-consumer",
				devDependencies: { vite: "^5.0.0" },
			},
			consumerBins: ["vite"],
		});
		// Independent expected value: WE created this bin, so its absolute path is a
		// known literal the resolved dev plan must echo.
		const viteBin = join(repo, "node_modules", ".bin", "vite");
		const result = await run(["dev", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		const line = devMainLine(result.stdout);
		expect(
			line,
			"expected a portless-wrapped dev line in the plan",
		).toBeDefined();
		expect(line).toContain(viteBin);
	}, 20000);

	it("falls back to the bare `vite` name when no consumer vite bin is installed", async () => {
		// Regression guard for the fallback half: no consumer bin → the bare tool
		// name, never an absolute node_modules path.
		const repo = makeBinResRepo(dirs, {
			pkg: { name: "binres-vite-bare", devDependencies: { vite: "^5.0.0" } },
		});
		const result = await run(["dev", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		const token = toolToken(devMainLine(result.stdout) ?? "", "vite");
		expect(token, "expected a vite token on the main line").toBeDefined();
		expect(token).toBe("vite");
	}, 20000);
});

// --- Slice 3: consumer bin resolution in `db:* --dry-run` (drizzle-kit) ---------
// The db:* consumer path, mirroring the constraint's contract idea exactly: a
// fake <workroot>/node_modules/.bin/drizzle-kit → `db:generate --dry-run` renders
// that absolute consumer path; without it, the bare name.
describe("run() — db:* dispatch (consumer bin resolution in the dry-run plan)", () => {
	const dirs: string[] = [];

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("renders the db tool as the absolute <workroot>/node_modules/.bin/drizzle-kit path when the consumer bin is present", async () => {
		const repo = makeBinResRepo(dirs, {
			pkg: {
				name: "binres-drizzle",
				devDependencies: { "drizzle-kit": "^0.20.0" },
			},
			consumerBins: ["drizzle-kit"],
		});
		// Independent expected value: WE created this bin; the resolved db plan must
		// echo its exact path.
		const drizzleBin = join(repo, "node_modules", ".bin", "drizzle-kit");
		const result = await run(["db:generate", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("unknown command");
		expect(result.stdout).toContain(drizzleBin);
		// The resolved-path form still names the `generate` subcommand (…/.bin/
		// drizzle-kit generate).
		const line = dbCommandLine(result.stdout, "drizzle-kit");
		expect(line, "expected a drizzle-kit command line").toBeDefined();
		expect(line).toContain("generate");
	}, 20000);

	it("falls back to the bare `drizzle-kit` name in db:* --dry-run when no consumer bin is installed", async () => {
		// Regression guard: no consumer bin → the bare command, never an absolute
		// node_modules/.bin path (the `cwd:` line carries the workroot path, so we
		// scope to the tool's command line).
		const repo = makeBinResRepo(dirs, {
			pkg: {
				name: "binres-drizzle-bare",
				devDependencies: { "drizzle-kit": "^0.20.0" },
			},
		});
		const result = await run(["db:generate", "--dry-run"], repo);
		expect(result.exitCode).toBe(0);
		const line = dbCommandLine(result.stdout, "drizzle-kit");
		expect(line, "expected a drizzle-kit command line").toBeDefined();
		expect(line).toContain("drizzle-kit generate");
		expect(line).not.toContain(join(repo, "node_modules", ".bin"));
	}, 20000);
});
