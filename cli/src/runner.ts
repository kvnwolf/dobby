import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigDefaultSpec, ViteConfigSelection } from "./tasks.ts";

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
  // Set when the process could not be spawned at all (ENOENT for a missing
  // binary, etc.); callers fold this into the same failure path as status != 0.
  error?: Error;
  // The child's exit code, or null when it was killed by a signal or never
  // started (a missing binary — `error` is then set). Callers treat anything
  // other than 0 as failure.
  status: number | null;
  stderr: string;
  stdout: string;
}

export interface RunOptions {
  // Optional env overrides; omitted -> the child inherits process.env.
  env?: NodeJS.ProcessEnv;
  // Optional stdin payload (e.g. a PostToolUse hook body). Omitted -> stdin ignored.
  input?: string;
  // The resolved workroot; the child's cwd is pinned HERE, never the ambient cwd.
  root: string;
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
      "dobby must run inside a git repository — no git worktree found for the current directory"
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

// This module's package ROOT — the directory shipping the preset ASSETS (biome/,
// knip.base.jsonc, the .mjs configs). runner.ts always lives at
// <pkgRoot>/src/runner.ts (the `files` allowlist ships `src` at the package root),
// so the package root is its grandparent — derived from import.meta.url so it
// points at dobby's OWN install location (this repo's cli/, or a consumer's
// node_modules/@kvnwolf/dobby/).
const packageRoot = dirname(runnerDir);

/**
 * Resolve a SHIPPED preset asset (e.g. "biome/core.jsonc", "knip.base.jsonc",
 * "vitest.base.mjs") to an absolute path inside dobby's OWN package tree — the
 * ASSET counterpart to resolveBin's bundled scope (both walk from this module's
 * own location, never the consumer's cwd). Used by the config-less defaults
 * (ADR-0015): when a consumer ships no config of its own for a tool dobby
 * invokes, dobby points the tool at this asset via its native config flag.
 *
 * @public — consumed by check.ts / lifecycle.ts (via configArgs) to supply the
 * default tool configs.
 */
export function resolveAsset(relPath: string): string {
  return join(packageRoot, relPath);
}

/**
 * The override-by-presence seam (ADR-0015). Given the workroot and a tool's pure
 * `ConfigDefaultSpec` (from tasks.ts), decide whether the consumer ships its OWN
 * config for that tool and return the config args to APPEND to the tool spawn:
 *   - PRESENT (a matching file at the workroot, or the package.json key) → NO args
 *     (dobby spawns bare; the tool's native discovery finds the consumer file — a
 *     TOTAL override, never merged) and a null `usedDefault`.
 *   - ABSENT (or no workroot) → the tool's native config flag pointing at dobby's
 *     SHIPPED preset (`resolveAsset`, an absolute path in dobby's own tree), plus
 *     the note label (`usedDefault`) so `check` can report which default kicked in.
 * Biome additionally gets `--vcs-root=<workroot>` (see `ConfigDefaultSpec.vcsRoot`).
 * A null root cannot happen for check (requireWorkroot) but can for a dev dry-run
 * outside a git repo — there the default still applies (nothing to override).
 *
 * @public — the single config-args resolver every config-less tool spawn routes
 * through (check biome/knip/vite/vitest, dev/build vite, db drizzle-kit).
 */
export function configArgs(
  root: string | null,
  spec: ConfigDefaultSpec
): { args: string[]; usedDefault: string | null } {
  if (root !== null && consumerOwnsConfig(root, spec)) {
    return { args: [], usedDefault: null };
  }
  const assetPath = resolveAsset(spec.asset);
  const args = spec.equals
    ? [`${spec.flag}=${assetPath}`]
    : [spec.flag, assetPath];
  if (spec.vcsRoot && root !== null) {
    args.push(`--vcs-root=${root}`);
  }
  return { args, usedDefault: spec.label };
}

// The result of resolving the vite config-less default against the workroot:
//   - `{ blocked: false, args, usedDefault }` — the config args to append (bare when
//     the consumer ships its own vite config, else the default `--config <preset>`),
//     identical to `configArgs`.
//   - `{ blocked: true, missing }` — a config-LESS tanstack app missing packages the
//     tanstack default imports; the caller turns this into a HARD ERROR (never a
//     silent base fallback). `missing` names the packages for the message.
export type ViteConfigResolution =
  | { blocked: false; args: string[]; usedDefault: string | null }
  | { blocked: true; missing: string[] };

/**
 * Resolve the pure `ViteConfigSelection` (from tasks.ts) against the workroot — the
 * IMPURE seam that combines the presence check with the blocked-default enforcement:
 *   - a "default" selection resolves exactly like `configArgs` (bare when the consumer
 *     ships its own vite config, else the default preset via `--config`).
 *   - a "blocked" selection (a config-less tanstack app missing an imported package) is
 *     BLOCKED — UNLESS the consumer ships its own vite config, a TOTAL override that
 *     supersedes both the default AND the block (the consumer supplies the plugins).
 * So only a config-LESS tanstack app is ever blocked; a present config is never blocked.
 *
 * @public — the vite callers (check build step, dev planDev, build runBuild) route
 * through this; on `blocked` they emit the hard error (`viteBlockedMessage`).
 */
export function resolveViteConfig(
  root: string | null,
  selection: ViteConfigSelection
): ViteConfigResolution {
  if (selection.kind === "default") {
    return { blocked: false, ...configArgs(root, selection.spec) };
  }
  // A present consumer vite config wins over the block (the same override-by-presence
  // rule `configArgs` applies to a default): only a config-LESS app is blocked.
  if (root !== null && anyConfigFilePresent(root, selection.ownFiles)) {
    return { args: [], blocked: false, usedDefault: null };
  }
  return { blocked: true, missing: selection.missing };
}

// Whether the consumer ships its OWN config for a tool at `root`: any of the
// spec's own-config filenames present, or the spec's package.json key declared.
function consumerOwnsConfig(root: string, spec: ConfigDefaultSpec): boolean {
  if (anyConfigFilePresent(root, spec.ownFiles)) {
    return true;
  }
  return spec.ownPkgKey !== undefined && pkgHasKey(root, spec.ownPkgKey);
}

// Whether any of `ownFiles` exists at the workroot — a consumer config file present.
function anyConfigFilePresent(
  root: string,
  ownFiles: readonly string[]
): boolean {
  return ownFiles.some((file) => existsSync(join(root, file)));
}

// Whether `<root>/package.json` declares top-level `key` (knip's `#knip`).
// Tolerant: an absent/unparseable manifest is "no key".
function pkgHasKey(root: string, key: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8")
    ) as Record<string, unknown>;
    return manifest[key] !== undefined;
  } catch {
    return false;
  }
}

// The npm package shipping each bundled bin (bin name -> package), for the
// require.resolve fallback when the node_modules/.bin walk finds nothing. The bin
// name and package name differ for some tools (`biome` <- @biomejs/biome,
// `tsc` <- typescript), so the map is explicit.
const BUNDLED_PACKAGES: Record<string, string> = {
  biome: "@biomejs/biome",
  knip: "knip",
  portless: "portless",
  taze: "taze",
  tsc: "typescript",
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
  opts: { scope: BinScope; root?: string }
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
  for (let depth = 0; depth < 24; depth += 1) {
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
    const { bin } = manifest;
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
  opts: RunOptions
): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.root,
    encoding: "utf8",
    env: opts.env,
    input: opts.input,
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
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
  opts: RunOptions
): number {
  const result = spawnSync(cmd, args, {
    cwd: opts.root,
    env: opts.env,
    stdio: "inherit",
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
  opts: RunOptions
): ChildProcess {
  return spawn(cmd, args, {
    cwd: opts.root,
    detached: true,
    env: opts.env,
    stdio: "inherit",
  });
}

/**
 * Spawn a BACKGROUND child that OUTLIVES dobby: DETACHED (its own process group),
 * cwd pinned to opts.root, stdio redirected to `logPath` (append), and `unref`d so
 * the parent can exit while the child keeps running. Returns the child's pid (the
 * caller writes it to a pidfile so a later `down` can signal the group), or undefined
 * when the background start FAILED — it NEVER throws: any synchronous failure (opening
 * the log with openSync, or spawn itself) is caught and folded into undefined so the
 * caller (`up`) fails fast instead of crashing raw. The non-supervised counterpart to
 * `spawnDetached`: `up`'s plain-terminal start (`dobby dev` with no cmux to own it)
 * hands the process to the OS and walks away — the pidfile + log are the only handles.
 * node:child_process `spawn` (never Bun.spawn).
 *
 * @public — consumed by the `up` detached-start path in `lifecycle.ts`.
 */
export function spawnBackground(
  cmd: string,
  args: string[],
  opts: { root: string; logPath: string }
): number | undefined {
  // openSync lives INSIDE the try so a throw (bad logPath, permission) is caught too;
  // `out` stays undefined until it opens, so the finally only closes a real descriptor.
  // `pid` carries the result out of the try/finally: a synchronous openSync/spawn
  // failure leaves it undefined, which routes `up` onto its fail-fast path.
  let out: number | undefined;
  let pid: number | undefined;
  try {
    out = openSync(opts.logPath, "a");
    const child = spawn(cmd, args, {
      cwd: opts.root,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    ({ pid } = child);
  } catch {
    pid = undefined;
  } finally {
    // The child dup'd its own descriptor for the log; the parent's is done with.
    // Close it on BOTH the success and the throw path (only if it ever opened).
    if (out !== undefined) {
      closeSync(out);
    }
  }
  return pid;
}
