import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupDirs,
  gitEnv,
  gitIn,
  makeScratchRepo,
  mkRecorderBin,
  mkStubBin,
  mkStubBinDir,
  mkStubBins,
  readStubLog,
  restoreEnv,
  type StubResponse,
  stubLogPath,
  stubPath,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ---------------------------------------------------------------------------
// The test INFRASTRUCTURE's own contract test. These helpers are the seam the
// gh/npm-driven suites (ship, release, review, tracker) will assert through, so
// the recorder has to be trustworthy FIRST: an argv that arrives mangled here
// would make every later "the injection string landed verbatim in argv" test
// pass for the wrong reason.
//
// Every expected value is INDEPENDENT of the helper's implementation: the argv
// vectors, canned payloads, exit codes, branch names and file contents are all
// literals written by hand in this file, and the stubs are observed through a
// REAL child process spawned by bare name off PATH — never by reading back the
// generated script.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterAll(() => {
  cleanupDirs(dirs);
});

// Spawn `name` BY BARE NAME with `dir` prepended to the child's PATH: the exact
// shape a dobby command uses for a system tool (gh, npm, curl, cmux), so a hit
// proves PATH resolution reached the stub.
function runStubbed(
  dir: string,
  name: string,
  args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: stubPath(dir) },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("stub bins — the argv recorder", () => {
  it("records the full argv of a bare-name spawn resolved through PATH", () => {
    const dir = mkStubBins({ gh: [] }, dirs);
    runStubbed(dir, "gh", ["pr", "view", "42", "--json", "number,title"]);
    expect(readStubLog(dir, "gh")).toEqual([
      ["pr", "view", "42", "--json", "number,title"],
    ]);
  });

  it("records an argument containing spaces, quotes and newlines VERBATIM", () => {
    // The injection-shaped payload the tracker/release suites care about: if the
    // command were ever built by string concatenation, this argument would come
    // back split, quoted, or truncated.
    const body = "line one\nline 'two' \"three\" `four` $five;\nrm -rf /\n";
    const dir = mkStubBins({ gh: [] }, dirs);
    runStubbed(dir, "gh", [
      "issue",
      "create",
      "--title",
      "a b c",
      "--body",
      body,
    ]);
    expect(readStubLog(dir, "gh")).toEqual([
      ["issue", "create", "--title", "a b c", "--body", body],
    ]);
  });

  it("appends one record per invocation, in order, including a zero-argument call", () => {
    const dir = mkStubBins({ npm: [] }, dirs);
    runStubbed(dir, "npm", ["whoami"]);
    runStubbed(dir, "npm", []);
    runStubbed(dir, "npm", ["publish", "--access", "public"]);
    expect(readStubLog(dir, "npm")).toEqual([
      ["whoami"],
      [],
      ["publish", "--access", "public"],
    ]);
  });

  it("keeps a separate log per bin and reports an uncalled bin as empty", () => {
    const dir = mkStubBins({ gh: [], npm: [] }, dirs);
    runStubbed(dir, "gh", ["auth", "status"]);
    expect(readStubLog(dir, "gh")).toEqual([["auth", "status"]]);
    expect(readStubLog(dir, "npm")).toEqual([]);
  });

  it("writes the log at stubLogPath (and creates nothing before the first call)", () => {
    const dir = mkStubBins({ gh: [] }, dirs);
    const log = stubLogPath(dir, "gh");
    expect(existsSync(log)).toBe(false);
    runStubbed(dir, "gh", ["repo", "view"]);
    expect(existsSync(log)).toBe(true);
  });
});

describe("stub bins — canned responses", () => {
  // A `gh pr view --json …` fixture: the payload a review/ship suite parses.
  const prPayload = '{"number":7,"state":"OPEN"}\n';

  const ghResponses: StubResponse[] = [
    { match: ["pr view", "--json"], stdout: prPayload },
    { exitCode: 3, match: "issue create", stderr: "gh: could not create\n" },
  ];

  it("answers a matching invocation with the canned stdout and exit 0", () => {
    const dir = mkStubBins({ gh: ghResponses }, dirs);
    const result = runStubbed(dir, "gh", [
      "pr",
      "view",
      "--json",
      "number,state",
    ]);
    expect(result.stdout).toBe(prPayload);
    expect(result.status).toBe(0);
  });

  it("requires EVERY pattern of a multi-pattern match (AND, not OR)", () => {
    const dir = mkStubBins({ gh: ghResponses }, dirs);
    // `pr view` alone, without `--json`, must NOT get the payload.
    const result = runStubbed(dir, "gh", ["pr", "view", "42"]);
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it("answers another pattern with its own stderr and exit code", () => {
    const dir = mkStubBins({ gh: ghResponses }, dirs);
    const result = runStubbed(dir, "gh", ["issue", "create", "--title", "x"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toBe("gh: could not create\n");
    expect(result.stdout).toBe("");
  });

  it("still records the argv of an invocation that a response answered", () => {
    const dir = mkStubBins({ gh: ghResponses }, dirs);
    runStubbed(dir, "gh", ["pr", "view", "--json", "number"]);
    runStubbed(dir, "gh", ["issue", "create", "--title", "x"]);
    expect(readStubLog(dir, "gh")).toEqual([
      ["pr", "view", "--json", "number"],
      ["issue", "create", "--title", "x"],
    ]);
  });

  it("falls through to a silent exit 0 when nothing matches", () => {
    const dir = mkStubBins({ gh: ghResponses }, dirs);
    const result = runStubbed(dir, "gh", ["auth", "status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("treats `*` in a match as a LITERAL character, not a wildcard", () => {
    // The semantics a glob-minded reader would get wrong, pinned in both
    // directions: `pr view --json *` must NOT answer `pr view --json number`
    // (that is spelled `["pr view", "--json"]`), and MUST answer an argv that
    // literally carries the asterisk. spawnSync does no shell expansion, so the
    // `*` argument reaches the stub as itself.
    const dir = mkStubBins(
      { gh: [{ match: "pr view --json *", stdout: "MATCHED" }] },
      dirs
    );
    expect(
      runStubbed(dir, "gh", ["pr", "view", "--json", "number"]).stdout
    ).toBe("");
    expect(
      runStubbed(dir, "gh", ["pr", "view", "--json", "*", "extra"]).stdout
    ).toBe("MATCHED");
  });

  it("treats `?` and a bracket expression in a match literally too", () => {
    const dir = mkStubBins(
      { npm: [{ match: "version [major|minor]?", stdout: "MATCHED" }] },
      dirs
    );
    // A wildcard reading would match `version majorX`; a literal one must not.
    expect(runStubbed(dir, "npm", ["version", "majorX"]).stdout).toBe("");
    expect(runStubbed(dir, "npm", ["version", "[major|minor]?"]).stdout).toBe(
      "MATCHED"
    );
  });

  it("mkRecorderBin adds a bin to an existing stub dir", () => {
    const dir = mkStubBinDir(dirs);
    mkRecorderBin(dir, "npm", [{ match: "view", stdout: "1.2.3\n" }]);
    const result = runStubbed(dir, "npm", [
      "view",
      "@kvnwolf/dobby",
      "version",
    ]);
    expect(result.stdout).toBe("1.2.3\n");
    expect(readStubLog(dir, "npm")).toEqual([
      ["view", "@kvnwolf/dobby", "version"],
    ]);
  });

  it("mkStubBin takes a hand-written script (shebang optional)", () => {
    const dir = mkStubBinDir(dirs);
    mkStubBin(dir, "cmux", "printf 'OK surface:1 pane:7\\n'\nexit 5\n");
    const result = runStubbed(dir, "cmux", ["new-pane"]);
    expect(result.stdout).toBe("OK surface:1 pane:7\n");
    expect(result.status).toBe(5);
  });
});

describe("stub bins — PATH scoping", () => {
  it("makes a bare spawn with NO explicit env hit the stub, then restores PATH", async () => {
    const dir = mkStubBins({ gh: [] }, dirs);
    const before = process.env.PATH;
    await withStubPath(dir, () => {
      // No env passed: the child inherits the PARENT's — the in-process
      // `run(argv, cwd)` seam's exact situation.
      spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    });
    expect(process.env.PATH).toBe(before);
    expect(readStubLog(dir, "gh")).toEqual([["auth", "status"]]);
  });

  it("restores PATH even when the body throws", async () => {
    const dir = mkStubBins({ gh: [] }, dirs);
    const before = process.env.PATH;
    await expect(
      withStubPath(dir, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(process.env.PATH).toBe(before);
  });

  it("restoreEnv unsets a variable that was unset before", () => {
    const name = "DOBBY_TEST_HELPERS_PROBE";
    const original = process.env[name];
    process.env[name] = "set-by-the-test";
    restoreEnv(name, original);
    expect(process.env[name]).toBeUndefined();
  });
});

describe("scratch git repos", () => {
  it("builds a repo on the requested branch with exactly one commit and a clean tree", () => {
    const repo = makeScratchRepo({ branch: "dobby-helper-test", track: dirs });
    expect(gitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "dobby-helper-test"
    );
    expect(gitIn(repo, ["rev-list", "--all", "--count"])).toBe("1");
    expect(gitIn(repo, ["status", "--porcelain"])).toBe("");
  });

  it("writes package.json, dobby.config.json and arbitrary files, all committed", () => {
    const repo = makeScratchRepo({
      config: { files: [], release: { type: "npm" } },
      files: { "src/deep/note.txt": "hello\n" },
      pkg: { name: "scratch-helper", private: true },
      track: dirs,
    });
    expect(gitIn(repo, ["status", "--porcelain"])).toBe("");
    expect(gitIn(repo, ["show", "HEAD:src/deep/note.txt"])).toBe("hello");
    expect(
      JSON.parse(gitIn(repo, ["show", "HEAD:package.json"])) as {
        name: string;
      }
    ).toEqual({ name: "scratch-helper", private: true });
    expect(
      JSON.parse(gitIn(repo, ["show", "HEAD:dobby.config.json"])) as {
        release: unknown;
      }
    ).toEqual({ files: [], release: { type: "npm" } });
  });

  it("writes a STRING config verbatim (the malformed-JSON fixture)", () => {
    const repo = makeScratchRepo({
      config: "{ this is not valid json",
      track: dirs,
    });
    expect(gitIn(repo, ["show", "HEAD:dobby.config.json"])).toBe(
      "{ this is not valid json"
    );
  });

  it("leaves the tree uncommitted with commit: false", () => {
    const repo = makeScratchRepo({
      commit: false,
      files: { "a.txt": "a\n" },
      track: dirs,
    });
    expect(gitIn(repo, ["rev-list", "--all", "--count"])).toBe("0");
    expect(gitIn(repo, ["status", "--porcelain"])).toContain("a.txt");
  });

  it("pins git identity and isolates ambient git config", () => {
    const env = gitEnv();
    expect(env.GIT_AUTHOR_EMAIL).toBe("test@dobby.invalid");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  it("snapshots the CURRENT PATH, so a stubbed PATH reaches git children too", async () => {
    const dir = mkStubBins({ gh: [] }, dirs);
    const inside = await withStubPath(dir, () => gitEnv().PATH ?? "");
    expect(inside.startsWith(dir)).toBe(true);
  });
});
