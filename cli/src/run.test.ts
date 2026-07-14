import { describe, it, expect } from "vite-plus/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./run.ts";
import pkg from "../package.json";

// Fixture paths are anchored to THIS test file's location (never process.cwd()),
// so `run(["capabilities"], cwd)` reads a stable, hand-written sample project.
// `__fixtures__` sits beside `src/`, so we climb one level out of `src/`.
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__");
const fixture = (name: string) => resolve(fixturesDir, name);

// The seam under test: run(argv, cwd) -> { exitCode, stdout, stderr }, exercised
// IN-PROCESS. The dispatch-seam block below (bare / version / unknown / malformed)
// never touches the filesystem, so `cwd` is irrelevant there and any path serves;
// the capabilities block further down passes real fixture paths as `cwd`.
//
// Independent sources for every expected value in the dispatch-seam block:
//  - "Usage: dobby" and "unknown command: <X>" are literals named by the spec.
//  - The --version output is the version field of the package the spec points
//    to (`../package.json`), read here purely as data — never recomputed by the
//    detector or by run()'s own logic.
const cwd = process.cwd();

describe("run() — CLI dispatch seam", () => {
  describe("bare invocation (no arguments)", () => {
    it("prints usage on stdout (first line begins 'Usage: dobby'), exits 0, empty stderr", async () => {
      const result = await run([], cwd);
      expect(result.stdout.startsWith("Usage: dobby")).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("advertises the 'capabilities' command in the usage text", async () => {
      const result = await run([], cwd);
      expect(result.stdout).toContain("capabilities");
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
    it("errors to stderr with the command name and the usage text, exits 1, empty stdout", async () => {
      const result = await run(["frobnicate"], cwd);
      expect(result.stderr).toContain("unknown command: frobnicate");
      expect(result.stderr).toContain("Usage: dobby");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
    });
  });

  describe("malformed flags (parseArgs strict)", () => {
    it("catches the parse error: the message precedes the usage on stderr, exits 1, empty stdout", async () => {
      const result = await run(["--nope"], cwd);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage: dobby");
      // Spec order is "parse error message + usage": usage is present but is
      // NOT the first thing on stderr — the error message precedes it.
      expect(result.stderr.startsWith("Usage: dobby")).toBe(false);
    });
  });
});

// run(["capabilities"], cwd) — single-package detection (task 3).
//
// Every expected value is an INDEPENDENT source, never recomputed by the
// detector: the capability names come from the spec's fixed signal map
// (vite <- "vite"; tanstack-start <- "@tanstack/react-start"; neon <-
// "@neondatabase/serverless"; expo <- "expo"), the ORDER from the spec's fixed
// declaration order (vite, tanstack-start, neon, expo), and each line's contents
// from the hand-written `__fixtures__/<name>/package.json` that this suite ships.
// Error-message substrings come from the spec's literal wording plus the fixture
// path this file resolves itself — not from anything the implementation returns.
describe("run() — capabilities command (single package)", () => {
  it("emits deps AND devDeps signals in fixed declaration order, not package.json order", async () => {
    // Fixture declares vite in devDependencies and the others in dependencies,
    // yet the spec's fixed order puts vite FIRST — this pins order + the
    // deps-union-devDeps rule at once.
    const result = await run(["capabilities"], fixture("tanstack-app"));
    expect(result.stdout).toBe("vite\ntanstack-start\nneon\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("detects a single capability from its lone signal", async () => {
    const result = await run(["capabilities"], fixture("expo-app"));
    expect(result.stdout).toBe("expo\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("prints 'none' and exits 0 when a valid package.json declares no matching signals", async () => {
    // empty-pkg has neither `dependencies` nor `devDependencies` (missing fields
    // are treated as empty objects, per the spec's edge case).
    const result = await run(["capabilities"], fixture("empty-pkg"));
    expect(result.stdout).toBe("none\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("never reads peerDependencies: a signal present ONLY there yields 'none'", async () => {
    const result = await run(["capabilities"], fixture("peer-only"));
    expect(result.stdout).toBe("none\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("errors and exits 1, naming the cwd, when no package.json exists there", async () => {
    const dir = fixture("no-pkg");
    const result = await run(["capabilities"], dir);
    expect(result.stderr).toContain(`no package.json in ${dir}`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("errors and exits 1, naming the offending file, when package.json is unparseable", async () => {
    const result = await run(["capabilities"], fixture("broken-json"));
    expect(result.stderr).toContain(fixture("broken-json/package.json"));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });
});

// run(["capabilities"], cwd) — workspace-aware monorepo grouping (task 4).
//
// When the cwd's package.json declares `workspaces`, the command switches from a
// flat list to grouped per-package reporting. Every expected value below is an
// INDEPENDENT source, never recomputed by the detector:
//  - the grouped stdout literals are hand-written in the task spec's byte-exact
//    contract (header line "<relpath>\n" then two-space-indented capability lines
//    "  <cap>\n"; groups ordered root-"." first then members lexicographically by
//    POSIX relative path; zero-capability groups omitted; whole thing collapses to
//    "none\n" when nothing detects);
//  - the capability names + fixed order (vite, tanstack-start, neon, expo) come
//    from the same signal map the single-package block cites;
//  - each member's contents come from the hand-written __fixtures__/<name>/**
//    package.json files this suite ships;
//  - error substrings come from the spec's literal wording plus the fixture path
//    this file resolves itself.
describe("run() — capabilities command (workspace-aware monorepo)", () => {
  it("groups capabilities per member, sorted by relative path, skipping dirs without a package.json", async () => {
    // Root declares `workspaces: ["apps/*", "packages/db"]` (glob + literal mix)
    // and no detectable deps. apps/* expands to web, mobile, and docs; docs has
    // NO package.json so it is silently skipped (not a member). Members sort
    // lexicographically by POSIX relative path: apps/mobile < apps/web <
    // packages/db. Each member's capabilities follow the fixed declaration order.
    const result = await run(["capabilities"], fixture("monorepo"));
    expect(result.stdout).toBe(
      "apps/mobile\n  expo\napps/web\n  vite\n  tanstack-start\npackages/db\n  neon\n",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("lists the root group first under the '.' header when the root itself detects a capability", async () => {
    // Root declares `workspaces: ["pkgs/*"]` AND a vite devDep; member pkgs/a
    // detects expo. The root group ("." header) precedes the member group.
    const result = await run(["capabilities"], fixture("monorepo-root-detects"));
    expect(result.stdout).toBe(".\n  vite\npkgs/a\n  expo\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reads the object form of workspaces via .packages, producing the same grouped output", async () => {
    // Root declares the object form `workspaces: { packages: ["pkgs/*"] }` and no
    // detectable deps; member pkgs/a detects vite. Same grouping as the array form.
    const result = await run(["capabilities"], fixture("monorepo-object-form"));
    expect(result.stdout).toBe("pkgs/a\n  vite\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("omits a member that has a package.json but detects zero capabilities", async () => {
    // Members pkgs/a (expo) and pkgs/b (only a non-signal typescript devDep). The
    // root detects vite. pkgs/b IS a member (it has a package.json) but its group
    // is omitted entirely because it detects nothing — no empty header, no blank.
    const result = await run(["capabilities"], fixture("monorepo-omit-empty-member"));
    expect(result.stdout).toBe(".\n  vite\npkgs/a\n  expo\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("dedupes a dir matched by two patterns into a single group", async () => {
    // Root declares `workspaces: ["packages/*", "packages/db"]`; packages/db is
    // matched BOTH by the glob and by the literal. It must appear exactly once.
    const result = await run(["capabilities"], fixture("monorepo-dedupe"));
    expect(result.stdout).toBe("packages/db\n  neon\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails loud on an unsupported workspace pattern, exits 1 with empty stdout", async () => {
    // `workspaces: ["**/nested"]` is neither a literal nor a single-star dir
    // pattern, so it must error rather than silently mis-scan.
    const result = await run(["capabilities"], fixture("monorepo-bad-pattern"));
    expect(result.stderr).toContain("unsupported workspace pattern: **/nested");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("applies the parse-error contract to a workspace member, naming that member's file path", async () => {
    // Member pkgs/bad/package.json is invalid JSON. A member parse failure uses
    // the SAME error contract as the root: exit 1, empty stdout, stderr naming the
    // offending file's absolute path.
    const result = await run(["capabilities"], fixture("monorepo-broken-member"));
    expect(result.stderr).toContain(fixture("monorepo-broken-member/pkgs/bad/package.json"));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("falls back to single-package behavior when every workspace pattern expands to zero members", async () => {
    // `workspaces: ["apps/*"]` but there is no apps/ directory, so expansion
    // yields zero members. The command falls back to flat single-package output;
    // the root has no detectable deps, so it prints exactly "none".
    const result = await run(["capabilities"], fixture("monorepo-empty"));
    expect(result.stdout).toBe("none\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("collapses to 'none' via the grouped path when members exist but nothing detects", async () => {
    // `workspaces: ["pkgs/*"]` expands to ONE real member (pkgs/a has a
    // package.json), so this takes the GROUPED path — not the empty-expansion
    // fallback. Neither the root (only a non-signal typescript devDep) nor pkgs/a
    // (only a non-signal typescript dep) detects anything, so every group is
    // empty and the whole output collapses to exactly "none". This exercises the
    // grouped all-empty branch, distinct from monorepo-empty (single-package
    // fallback) above. Expected value is the spec's byte-exact "none\n" literal.
    const result = await run(["capabilities"], fixture("monorepo-all-empty"));
    expect(result.stdout).toBe("none\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
