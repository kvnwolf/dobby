import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { detectCapabilities } from "./detect.ts";
import { detectEnvironment } from "./environment.ts";
import { resolveBin, resolveWorkroot, runCapture } from "./runner.ts";
import { dbTasks } from "./tasks.ts";

// Top-level regexes (biome useTopLevelRegex — a literal inside a function recompiles
// on every call).
const SCOPED_NAME_RE = /^@[^/]+\/(.+)$/;

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
  // The current git branch, or null outside a repo / on a detached HEAD.
  branch: string | null;
  // The kit browser-pane surface ref (surface titled dobby-browser-<slug>), or null.
  browserPane: string | null;
  // Detected project capabilities (may be empty).
  capabilities: string[];
  // The CMUX_WORKSPACE_ID value, or null when unset/empty.
  cmux: string | null;
  // Whether a parseable dobby.config.json exists at the root.
  config: boolean;
  // The INFERRED `db:<task>` command names for this project (`db:push`, `db:migrate`,
  // …), empty without a db capability. Reported so a consumer that needs to run one
  // (the migrate verify recipe) reads the names dobby will actually resolve instead
  // of hard-coding a guess that drifts with the inference.
  dbTasks: string[];
  // The portless-resolved dev URL, or null (no vite capability / portless absent / errors).
  devUrl: string | null;
  // The kit run-pane surface ref (surface titled dobby-run-<slug>), or null.
  runPane: string | null;
  // The enclosing git worktree root (git's resolved top-level), or null outside a repo.
  worktree: string | null;
}

// Assemble the environment snapshot for the project at `root` (the caller's cwd).
export function collectEnv(root: string): EnvSnapshot {
  // Resolved ONCE — the single CMUX_WORKSPACE_ID read this command makes (see
  // environment.ts); everything environment-specific below (the pane refs)
  // reads through it.
  const environment = detectEnvironment();
  // Resolve the workroot ONCE; every git/portless/cmux spawn below pins to it.
  const workroot = resolveWorkroot(root);
  // Capabilities are read from the CALLER's cwd (a single-package project runs
  // dobby at its root), independent of the git top-level.
  const capabilities = detectCapabilities(root);
  const panes = environment.discoverPanes(workroot);
  const devUrl = resolveDevUrl(root, workroot, capabilities);
  return {
    branch: workroot === null ? null : gitBranch(workroot),
    browserPane: panes.browserPane,
    capabilities,
    cmux: environment.cmux,
    config: loadConfig(root)?.ok === true,
    // The same pure map the `db:*` executor resolves through — one source, so the
    // reported names and the runnable commands can never disagree.
    dbTasks: [...dbTasks(capabilities).tasks.keys()],
    devUrl,
    runPane: panes.runPane,
    worktree: workroot,
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
  capabilities: string[]
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
  const scoped = SCOPED_NAME_RE.exec(name);
  // The required capture group is always present when `scoped` matched; the
  // `?? name` keeps `noUncheckedIndexedAccess` happy without changing behavior.
  return scoped?.[1] ?? name;
}

// Read + parse `<root>/package.json`, tolerant: null on any read/parse failure.
function readManifest(root: string): Manifest | null {
  try {
    return JSON.parse(
      readFileSync(join(root, "package.json"), "utf8")
    ) as Manifest;
  } catch {
    return null;
  }
}
