import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Internal capability detector. Pure functions over passed-in paths: they never
// read process.cwd() themselves — the bin entry captures the caller's directory
// and threads it down through run(). node:* imports only, so vitest (Node/Vite
// runtime under vp) can import this file the same way Bun runs it.

// The capability catalog, in FIXED declaration order. Each entry pairs a
// capability name with the single dependency that SIGNALS it. Output order is
// this array's order — deliberately independent of package.json's key order and
// of whether the dependency lives in `dependencies` or `devDependencies`.
const SIGNALS: ReadonlyArray<{ capability: string; dependency: string }> = [
  { capability: "vite", dependency: "vite" },
  { capability: "tanstack-start", dependency: "@tanstack/react-start" },
  { capability: "neon", dependency: "@neondatabase/serverless" },
  { capability: "expo", dependency: "expo" },
];

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  // `workspaces` may be the array form (`["apps/*"]`) or the object form
  // (`{ packages: ["apps/*"] }`); anything else is treated as "no workspaces".
  workspaces?: string[] | { packages?: string[] };
}

// One reporting group: a package's POSIX relative path from cwd plus the
// capabilities detected there. The root group's relpath is ".".
interface WorkspaceGroup {
  relpath: string;
  capabilities: string[];
}

// What detectProject() hands back to run() for formatting. `single` is the flat
// (task 3) shape — used both for non-workspace projects AND for the fallback
// when a workspaces field expands to zero members. `grouped` is the workspace
// shape: the root group first, then members already sorted by relpath. run()
// owns all formatting (empty-group omission, the `none` collapse).
export type ProjectDetection =
  | { kind: "single"; capabilities: string[] }
  | { kind: "grouped"; groups: WorkspaceGroup[] };

// Read + parse the package.json at `cwd`.
//
// Throws (caught by run(), mapped to the exit-1 error contract):
//  - the package.json is missing → message names the cwd
//  - the package.json is present but unparseable → message names the file path
function readManifest(cwd: string): PackageManifest {
  const pkgPath = join(cwd, "package.json");

  if (!existsSync(pkgPath)) {
    throw new Error(`no package.json in ${cwd}`);
  }

  const raw = readFileSync(pkgPath, "utf8");
  try {
    return JSON.parse(raw) as PackageManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not parse ${pkgPath}: ${detail}`);
  }
}

// Map a manifest's declared dependencies to capability names, in fixed order.
// The detection surface is the UNION of dependencies and devDependencies —
// NEVER peerDependencies. Missing fields are treated as empty objects.
function capabilitiesFromManifest(manifest: PackageManifest): string[] {
  const declared: Record<string, string> = {
    ...manifest?.dependencies,
    ...manifest?.devDependencies,
  };

  return SIGNALS.filter(({ dependency }) => Object.hasOwn(declared, dependency)).map(
    ({ capability }) => capability,
  );
}

// Detect the capabilities declared by the single package at `cwd`. Kept as the
// module's stable single-package entry (used directly for each workspace member
// and, historically, by run() for the flat path). See readManifest for the
// thrown error contract.
function detectCapabilities(cwd: string): string[] {
  return capabilitiesFromManifest(readManifest(cwd));
}

// The declared workspace patterns, or [] when there is no usable declaration.
// Array form is read directly; object form via `.packages`. An empty (or
// absent) pattern list means "not a workspace" — the caller falls back to
// single-package detection.
function workspacePatterns(manifest: PackageManifest): string[] {
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces;
  }
  if (workspaces && Array.isArray(workspaces.packages)) {
    return workspaces.packages;
  }
  return [];
}

// The absolute paths of the direct child directories of `dir`. A missing or
// non-directory prefix (e.g. a `apps/*` pattern with no `apps/` dir) yields zero
// children rather than throwing — that is the empty-expansion fallback path.
function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

// Expand one workspace pattern into candidate absolute directories.
//  - a LITERAL path (no `*`) → that one directory.
//  - a single-star DIR pattern `<prefix>/*` (exactly one `*`, as the final path
//    segment, non-empty wildcard-free prefix) → every direct child dir of prefix.
//  - anything else with a wildcard (`**`, `a/*/b`, bare `*`, `apps/**`, …) →
//    fail loud rather than silently mis-scan.
//
// Throws (caught by run(), mapped to exit-1): unsupported pattern.
function expandPattern(cwd: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    return [join(cwd, pattern)];
  }

  const starCount = (pattern.match(/\*/g) ?? []).length;
  const isSingleStarDir = starCount === 1 && pattern.endsWith("/*") && pattern.length > 2;
  if (!isSingleStarDir) {
    // ponytail: only literal + `<prefix>/*` patterns are expanded — the shapes
    // the user's repos actually use. Upgrade path when a real repo needs more:
    // swap this hand-rolled matcher for real glob expansion (`fs.glob` / a glob
    // lib) rather than loosening the guard.
    throw new Error(`unsupported workspace pattern: ${pattern}`);
  }

  const prefix = pattern.slice(0, -"/*".length);
  return childDirs(join(cwd, prefix));
}

// Expand every pattern to its member directories: a candidate COUNTS as a member
// only if it contains a package.json (the existence check IS the membership
// test; dirs without one are silently skipped). Dirs matched by multiple
// patterns are deduped (Set). Returns absolute member directories, unordered.
function expandMembers(cwd: string, patterns: string[]): string[] {
  const members = new Set<string>();
  for (const pattern of patterns) {
    for (const dir of expandPattern(cwd, pattern)) {
      if (existsSync(join(dir, "package.json"))) {
        members.add(dir);
      }
    }
  }
  return [...members];
}

// Detect the capabilities of the project at `cwd`, workspace-aware.
//
// - No usable `workspaces` field → single-package detection (flat shape).
// - `workspaces` declared but every pattern expands to zero members → fall back
//   to single-package detection of the root (flat shape).
// - Otherwise → grouped shape: the root group first, then members sorted
//   lexicographically by POSIX relative path. Empty groups are kept here (run()
//   omits them at format time).
//
// Throws (caught by run(), mapped to exit-1): a missing/unparseable root
// package.json, an unparseable member package.json (named by its own path), or
// an unsupported workspace pattern.
export function detectProject(cwd: string): ProjectDetection {
  const manifest = readManifest(cwd);
  const patterns = workspacePatterns(manifest);

  if (patterns.length === 0) {
    return { kind: "single", capabilities: capabilitiesFromManifest(manifest) };
  }

  const memberDirs = expandMembers(cwd, patterns);
  if (memberDirs.length === 0) {
    return { kind: "single", capabilities: capabilitiesFromManifest(manifest) };
  }

  const memberGroups: WorkspaceGroup[] = memberDirs
    .map((dir) => ({ dir, relpath: relative(cwd, dir).split(sep).join("/") }))
    .sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0))
    .map(({ dir, relpath }) => ({ relpath, capabilities: detectCapabilities(dir) }));

  return {
    kind: "grouped",
    groups: [{ relpath: ".", capabilities: capabilitiesFromManifest(manifest) }, ...memberGroups],
  };
}
