import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { detectCapabilities } from "./detect.ts";
import { resolveBin, resolveWorkroot, runCapture } from "./runner.ts";

// Assembles the `dobby env` snapshot: a local picture of the working environment.
// Pure over its `root` argument plus process.env; every fact is best-effort and
// degrades to null/false/[] rather than throwing — `env` must NEVER fail. Only
// node:* imports (vitest imports it under Node).
//
// Workroot invariant: the git top-level is resolved ONCE via the shared runner
// (resolveWorkroot) and every child spawn here (git branch, `portless get`,
// `cmux list-*`) is pinned to that root, never the ambient cwd. devUrl and the
// kit pane refs are resolved through local CLI/IPC only (no network probe): all
// fold to null when their tool is missing/errors, keeping `env` exit-0 always.

// The env snapshot as pure data. run() owns all rendering (the `key: value`
// text form and the `--json` object) — this module returns facts, never lines.
export interface EnvSnapshot {
	// The CMUX_WORKSPACE_ID value, or null when unset/empty.
	cmux: string | null;
	// The enclosing git worktree root (git's resolved top-level), or null outside a repo.
	worktree: string | null;
	// The current git branch, or null outside a repo / on a detached HEAD.
	branch: string | null;
	// Detected project capabilities (may be empty).
	capabilities: string[];
	// Whether a parseable dobby.config.json exists at the root.
	config: boolean;
	// The portless-resolved dev URL, or null (no vite capability / portless absent / errors).
	devUrl: string | null;
	// The kit run-pane surface ref (surface titled dobby-run-<slug>), or null.
	runPane: string | null;
	// The kit browser-pane surface ref (surface titled dobby-browser-<slug>), or null.
	browserPane: string | null;
}

// Assemble the environment snapshot for the project at `root` (the caller's cwd).
export function collectEnv(root: string): EnvSnapshot {
	const cmux = process.env.CMUX_WORKSPACE_ID || null;
	// Resolve the workroot ONCE; every git/portless/cmux spawn below pins to it.
	const workroot = resolveWorkroot(root);
	// Capabilities are read from the CALLER's cwd (a single-package project runs
	// dobby at its root), independent of the git top-level.
	const capabilities = detectCapabilities(root);
	const panes = discoverPanes(workroot, cmux);
	return {
		cmux,
		worktree: workroot,
		branch: workroot === null ? null : gitBranch(workroot),
		capabilities,
		config: loadConfig(root)?.ok === true,
		devUrl: resolveDevUrl(root, workroot, capabilities),
		runPane: panes.runPane,
		browserPane: panes.browserPane,
	};
}

// The current branch of the repo at `root`, pinned via the shared runner; null on
// a detached HEAD (empty output), a git failure, or a missing git binary.
function gitBranch(root: string): string | null {
	const result = runCapture("git", ["branch", "--show-current"], { root });
	if (result.status !== 0) {
		return null;
	}
	const branch = result.stdout.trim();
	return branch === "" ? null : branch;
}

// ---------------------------------------------------------------------------
// devUrl — the portless dev URL, resolved locally (never a network probe).
// Attempted ONLY for a project carrying the `vite` capability; the portless
// project name is the package.json `portless` key if present, else the package
// `name` with any leading `@scope/` stripped. Null whenever portless is missing,
// errors, prints nothing, or the project has no vite capability.
// ---------------------------------------------------------------------------

/**
 * Resolve the portless dev URL for the vite project at `cwd`, pinned to `workroot`
 * — the SAME resolution `env` reports. Null when the project has no vite
 * capability, has no workroot, declares no portless/package name, or portless is
 * missing / errors / prints nothing. Network-free (a local `portless get`, never a
 * liveness probe).
 *
 * @public — reused by `up` (lifecycle.ts) so its browser pane / liveness target is
 * the identical URL `dobby env` reports.
 */
export function resolveDevUrl(
	cwd: string,
	workroot: string | null,
	capabilities: string[],
): string | null {
	// Only vite projects have a portless dev URL; skip the spawn otherwise.
	if (!capabilities.includes("vite")) {
		return null;
	}
	// No workroot to pin the child to (env is exempt from the fail-hard rule).
	if (workroot === null) {
		return null;
	}
	const name = portlessName(cwd);
	if (name === null) {
		return null;
	}
	// THE field-bug fix: resolve portless from dobby's OWN bundled tree, not a bare
	// PATH spawn — dobby bundles portless, so it must resolve even when portless is
	// not on PATH (the exact condition that made `env` print `devUrl: null`).
	const portless = resolveBin("portless", { scope: "bundled" });
	const result = runCapture(portless, ["get", name], { root: workroot });
	if (result.status !== 0) {
		return null;
	}
	const url = result.stdout.trim();
	return url === "" ? null : url;
}

interface Manifest {
	name?: string;
	portless?: string;
}

// The portless project name from `<root>/package.json`: the explicit `portless`
// key wins; otherwise the package `name` with a leading `@scope/` stripped
// ("@acme/admin" -> "admin"). Null when the manifest is absent/unparseable or
// declares no usable name. Read from the same cwd the vite capability came from.
function portlessName(root: string): string | null {
	const manifest = readManifest(root);
	if (manifest === null) {
		return null;
	}
	if (
		typeof manifest.portless === "string" &&
		manifest.portless.trim() !== ""
	) {
		return manifest.portless.trim();
	}
	if (typeof manifest.name === "string" && manifest.name.trim() !== "") {
		return stripScope(manifest.name.trim());
	}
	return null;
}

// "@scope/pkg" -> "pkg"; an unscoped name is returned unchanged.
function stripScope(name: string): string {
	const scoped = /^@[^/]+\/(.+)$/.exec(name);
	// The required capture group is always present when `scoped` matched; the
	// `?? name` keeps `noUncheckedIndexedAccess` happy without changing behavior.
	return scoped?.[1] ?? name;
}

// Read + parse `<root>/package.json`, tolerant: null on any read/parse failure.
function readManifest(root: string): Manifest | null {
	try {
		return JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as Manifest;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Kit pane refs — discovered through cmux's local IPC (never a network probe).
// When CMUX_WORKSPACE_ID is set, walk the workspace's panes and their surfaces,
// matching surface titles `dobby-run-<slug>` / `dobby-browser-<slug>` where slug
// is the workroot directory basename, and report the matching surface refs.
//
// Any failure — no cmux workspace, cmux binary absent, access denied, no
// matching surface — folds to null (env never fails). The exact cmux listing
// stdout format is runtime-unverified (see research); the parser is deliberately
// tolerant (scan lines for `<kind>:<ref>` tokens, substring-match titles) and is
// CI-null regardless (no reachable cmux surface), with live behavior covered by
// the wrap-stage human smoke.
// ---------------------------------------------------------------------------

/**
 * Discover the kit's run/browser pane surface refs through cmux's local IPC:
 * match the surfaces titled `dobby-run-<slug>` / `dobby-browser-<slug>` (slug =
 * workroot basename) and return their refs, else null. Any failure (no workspace,
 * cmux absent, no matching surface) folds to null.
 *
 * @public — reused by the `up`/`down` lifecycle (lifecycle.ts): `up` reuses
 * existing kit panes (idempotent), `down` discovers them to close.
 */
export function discoverPanes(
	workroot: string | null,
	cmux: string | null,
): { runPane: string | null; browserPane: string | null } {
	const none = { runPane: null, browserPane: null };
	if (cmux === null || workroot === null) {
		return none;
	}
	const slug = basename(workroot);
	const runTitle = `dobby-run-${slug}`;
	const browserTitle = `dobby-browser-${slug}`;

	const panes = runCapture("cmux", ["list-panes", "--workspace", cmux], {
		root: workroot,
	});
	if (panes.status !== 0) {
		return none;
	}
	const paneRefs = parseRefs(panes.stdout, "pane");
	if (paneRefs.length === 0) {
		return none;
	}

	let runPane: string | null = null;
	let browserPane: string | null = null;
	for (const pane of paneRefs) {
		const surfaces = runCapture(
			"cmux",
			["list-pane-surfaces", "--workspace", cmux, "--pane", pane],
			{ root: workroot },
		);
		if (surfaces.status !== 0) {
			continue;
		}
		for (const line of surfaces.stdout.split("\n")) {
			if (runPane === null && line.includes(runTitle)) {
				runPane = refOf(line, "surface");
			}
			if (browserPane === null && line.includes(browserTitle)) {
				browserPane = refOf(line, "surface");
			}
		}
		if (runPane !== null && browserPane !== null) {
			break;
		}
	}
	return { runPane, browserPane };
}

// Extract the ref token of `kind` (e.g. "pane" / "surface") from each non-empty
// line of a cmux listing. cmux "Output defaults to refs" (`pane:3`, `surface:4`);
// we scan for that token and fall back to the line's first whitespace-delimited
// field when it is absent (format is runtime-unverified).
function parseRefs(stdout: string, kind: string): string[] {
	const refs: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		const ref = refOf(line, kind);
		if (ref !== null) {
			refs.push(ref);
		}
	}
	return refs;
}

// The `kind:ref` token in a line (`surface:4`), or the first field as a fallback.
function refOf(line: string, kind: string): string | null {
	const token = new RegExp(`${kind}:\\S+`).exec(line);
	if (token !== null) {
		return token[0];
	}
	const first = line.trim().split(/\s+/)[0];
	return first === undefined || first === "" ? null : first;
}
