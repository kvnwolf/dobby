import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Internal capability detector. Pure functions over a passed-in root path: they
// never read process.cwd() themselves — the bin entry captures the caller's
// directory and threads it down through run(). node:* imports only, so vitest
// (a Node runtime) can import this file the same way Bun runs it.
//
// Single-package only: `env` reports a flat capability list (monorepo grouping
// is out of scope for v1). This is a TOLERANT detector — a missing or
// unparseable package.json yields zero capabilities, never a throw, because its
// sole consumer (`env`) must never fail.

// One capability signal. A signal fires when ANY of its conditions hold:
//  - `deps`: an EXACT dependency name is declared (union of dependencies and
//    devDependencies), e.g. `react` matches "react" but never "react-email".
//  - `depPrefix`: some declared dependency name starts with this scope prefix,
//    e.g. "@react-email/" matches "@react-email/components".
interface Signal {
	capability: string;
	deps?: string[];
	depPrefix?: string;
}

// The capability catalog, in FIXED declaration order. Output order follows this
// array — deliberately independent of package.json key order and of whether a
// dependency lives in `dependencies` or `devDependencies`. (`env` reports the
// set order-independently, but a stable order keeps text output deterministic.)
const SIGNALS: readonly Signal[] = [
	{ capability: "vite", deps: ["vite"] },
	{ capability: "tanstack-start", deps: ["@tanstack/react-start"] },
	{ capability: "react", deps: ["react"] },
	{ capability: "neon", deps: ["@neondatabase/serverless"] },
	{ capability: "drizzle", deps: ["drizzle-orm", "drizzle-kit"] },
	{
		capability: "react-email",
		deps: ["react-email"],
		depPrefix: "@react-email/",
	},
	{ capability: "vitest", deps: ["vitest"] },
	{ capability: "expo", deps: ["expo"] },
];

interface PackageManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

// The declared dependency names at `root`: the UNION of `dependencies` and
// `devDependencies`, NEVER `peerDependencies`. Tolerant — a missing or
// unparseable package.json (or one with no dependency fields) yields an empty
// set rather than throwing, so `env` never fails on a malformed project.
function declaredDependencies(root: string): Set<string> {
	const pkgPath = join(root, "package.json");
	if (!existsSync(pkgPath)) {
		return new Set();
	}

	let manifest: PackageManifest;
	try {
		manifest = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageManifest;
	} catch {
		return new Set();
	}

	return new Set([
		...Object.keys(manifest?.dependencies ?? {}),
		...Object.keys(manifest?.devDependencies ?? {}),
	]);
}

// Whether a single signal fires for the given declared dependencies.
function signalFires(signal: Signal, declared: Set<string>): boolean {
	if (signal.deps?.some((dependency) => declared.has(dependency))) {
		return true;
	}
	const { depPrefix } = signal;
	if (depPrefix && [...declared].some((name) => name.startsWith(depPrefix))) {
		return true;
	}
	return false;
}

// Both the detected capabilities AND the raw declared-dependency name set, from a
// SINGLE package.json read. Callers that need the dependency names for a finer
// decision than the capability catalog — the config-less preset selection, where a
// multi-import preset must NOT be chosen unless EVERY package it imports is
// declared — use this so they never read package.json twice (the `detectCapabilities`
// read is right there). `dependencies` is the same union (`deps ∪ devDeps`, never
// `peerDependencies`) the signals fire on.
export interface CapabilityScan {
	capabilities: string[];
	dependencies: Set<string>;
}

// Scan the single package at `root` once: the declared dependency set + the
// capabilities it fires, in fixed catalog order. Tolerant (a missing/unparseable
// package.json yields an empty set and no capabilities).
export function scanCapabilities(root: string): CapabilityScan {
	const dependencies = declaredDependencies(root);
	const capabilities = SIGNALS.filter((signal) =>
		signalFires(signal, dependencies),
	).map((signal) => signal.capability);
	return { capabilities, dependencies };
}

// Detect the capabilities declared by the single package at `root`, in fixed
// catalog order. Reads `<root>/package.json` (dependencies ∪ devDependencies).
// Tolerant: a missing/unparseable package.json simply contributes no signals. Thin
// wrapper over `scanCapabilities` (the same single read) for callers needing only
// the capability list.
export function detectCapabilities(root: string): string[] {
	return scanCapabilities(root).capabilities;
}
