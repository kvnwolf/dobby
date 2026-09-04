import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";

// ---------------------------------------------------------------------------
// The COMMAND REGISTRY: the per-command flag allowlist, the new string/boolean
// options, and the dispatch of every command this session adds.
//
// The seam is the in-process `run(argv, cwd)` contract (ADR-0008) — these tests
// never spawn the bin and never import a domain module directly, so every command
// is exercised through the same front door a caller uses, whichever module ends
// up owning it.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - The command list (ship, release, state, build-plan, repro, review, pr,
//    tracker, claim, goal, kb, adr, finish, migrate, and the artifact-lint
//    family) and the option list (23 string options + 5 booleans) are enumerated
//    by the spec verbatim. `scope` is NOT among them: the worktree belongs to the
//    operator, so dobby has no scope command to advertise or dispatch.
//  - `Usage: dobby` and the `Commands:` header are the CLI's established, already
//    contracted help literals.
//  - "an out-of-place flag is an error naming the flag and the command, plus the
//    usage block" is interview decision I9, stated as spec text.
//  - The one exception — the front-door refusals in slice 3 — are the IMPLEMENTED
//    commands' own messages (each owned by that command's suite); this file pins
//    only a short fragment of each, as a DISPATCH oracle. See that slice's header
//    for why the stub literal it used to assert is gone.
// ---------------------------------------------------------------------------

// A committed sample project with NO detectable capabilities: the help it yields
// carries only the universal commands, so a new command showing up there proves
// the registry lists it unconditionally (never behind a capability gate).
const fixturesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../__fixtures__"
);
const plainProject = resolve(fixturesDir, "empty-pkg");

// The help block's own literals — the anchor every rejection message must carry.
const USAGE_HEADER = "Usage: dobby";
const COMMANDS_HEADER = "Commands:";

// Two-or-more spaces separate the aligned columns of a rendered help line; a
// name column may carry alternatives (`init|set`) or an argument hint.
const COLUMN_SPLIT = /\s{2,}/;
const NAME_SPLIT = /[|\s]+/;

// The part of stderr that PRECEDES the usage block: the command's own error
// message. Asserting against this slice (never whole stderr) is what makes the
// "names the flag and the command" checks meaningful — the usage block itself
// mentions every command and documents `--json`/`--fix`, so a whole-stderr
// `toContain` would pass without any message at all.
function rejectionMessage(stderr: string): string {
  const index = stderr.indexOf(USAGE_HEADER);
  return index === -1 ? stderr : stderr.slice(0, index);
}

// The PRIMARY name of every entry in the help's Commands block: the first token
// of each line's name column (`check [file...]` → `check`, `state init|set` →
// `state`). Subcommand alternatives are deliberately NOT collected — `claim` is
// both a top-level command and a `map` subcommand, and a set that conflated the
// two could pass without the top-level entry existing.
function commandNames(usage: string): Set<string> {
  const lines = usage.split("\n");
  const start = lines.indexOf(COMMANDS_HEADER);
  const names = new Set<string>();
  if (start === -1) {
    return names;
  }
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      break;
    }
    const [, column] = line.split(COLUMN_SPLIT);
    if (column === undefined) {
      continue;
    }
    const [primary] = column.trim().split(NAME_SPLIT);
    if (primary !== undefined && primary !== "") {
      names.add(primary);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Scratch repos: the release help entry is gated on a `release` key in the
// loaded `dobby.config.json`, so the fixture has to be a real repo carrying a
// real config file. `git init` makes the config discoverable whether the loader
// reads the passed cwd or resolves the workroot first.
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function makeRepo(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "dobby-registry-"));
  scratchDirs.push(dir);
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "registry-scratch", private: true }, null, 2)
  );
  if (config !== undefined) {
    writeFileSync(
      join(dir, "dobby.config.json"),
      JSON.stringify(config, null, 2)
    );
  }
  return dir;
}

// A directory that is NOT a git repo: every action command fails its git
// precondition there, so an accepted flag can be observed without a real run.
function makeNonGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dobby-registry-plain-"));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Slice 1 — the per-command flag allowlist (the task's core new behavior).
//
// Today `dobby env --fix` parses globally and is silently ignored; the spec makes
// a flag outside the command's allowlist a hard error that NAMES both the flag
// and the command and prints the usage block.
// ---------------------------------------------------------------------------

describe("run() — per-command flag allowlist", () => {
  it("rejects a flag the command does not accept, naming the flag and the command", async () => {
    const result = await run(["env", "--fix"], plainProject);
    const message = rejectionMessage(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(message).toContain("--fix");
    expect(message).toContain("env");
  });

  it("prints the usage block on stderr and nothing on stdout when it rejects a flag", async () => {
    const result = await run(["env", "--fix"], plainProject);
    expect(result.stderr).toContain(USAGE_HEADER);
    expect(result.stderr.startsWith(USAGE_HEADER)).toBe(false);
    expect(result.stdout).toBe("");
  });

  it("rejects a flag that belongs to another command (`--message-file` is ship's, not env's)", async () => {
    const result = await run(
      ["env", "--message-file", "message.md"],
      plainProject
    );
    const message = rejectionMessage(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(message).toContain("--message-file");
    expect(message).toContain("env");
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — the new global options parse (requirement 2).
//
// Probing each new option against a command that does NOT accept it turns the
// allowlist error into a REGISTRATION oracle, and the oracle discriminates the
// three failure modes precisely:
//  - unregistered   → parseArgs throws "Unknown option '--x'" (no command named)
//  - wrong type     → parseArgs throws "does not take an argument" / "argument
//                     missing" (no command named)
//  - registered     → the allowlist message, which names the command too
// So "the message names `env`" is exactly the assertion that pins the option's
// presence AND its declared type.
// ---------------------------------------------------------------------------

// The spec's string options, verbatim.
const STRING_OPTIONS = [
  "adapter",
  "message-file",
  "pr-body-file",
  "bump",
  "notes-file",
  "expect",
  "repeat",
  "plan",
  "pr",
  "deadline",
  "kind",
  "concept",
  "title",
  "body-file",
  "label",
  "reason-file",
  "entry",
  "slug",
  "task",
  "file",
  "focus",
  "issue",
  "status",
  "goal",
  "source",
];

// The spec's boolean options, verbatim.
const BOOLEAN_OPTIONS = [
  "preflight",
  "await-review",
  "bench",
  "rejected",
  "stdin",
];

describe("run() — new global options", () => {
  it.each(STRING_OPTIONS)(
    "parses --%s as a string option that takes a value",
    async (option) => {
      // `--opt=value` is only legal for a STRING option: parseArgs rejects the
      // inline form outright for a boolean, and never sees the option at all if
      // it is unregistered — in both cases the message cannot name `env`.
      const result = await run(["env", `--${option}=x`], plainProject);
      const message = rejectionMessage(result.stderr);
      expect(result.exitCode).toBe(1);
      expect(message).toContain(`--${option}`);
      expect(message).toContain("env");
    }
  );

  it.each(BOOLEAN_OPTIONS)(
    "parses --%s as a boolean option that takes no value",
    async (option) => {
      // A bare trailing `--opt` is only legal for a BOOLEAN option: a string
      // option would make parseArgs throw "argument missing" instead, and that
      // message cannot name `env`.
      const result = await run(["env", `--${option}`], plainProject);
      const message = rejectionMessage(result.stderr);
      expect(result.exitCode).toBe(1);
      expect(message).toContain(`--${option}`);
      expect(message).toContain("env");
    }
  );
});

// ---------------------------------------------------------------------------
// Slice 3 — every new command dispatches to its own handler.
//
// This slice used to assert the spec's stub literal (`<command>: not
// implemented`). Every command left in the table is IMPLEMENTED now, so that
// literal is superseded: what stays testable — and is what this slice was always
// really about — is DISPATCH. The token must reach its handler, which means all
// four of:
//   - exit 1 with a message of the HANDLER's own (its missing-input or
//     precondition refusal),
//   - no usage block, which is what a registry REJECTION always carries,
//   - never `not implemented` (no stub is left behind this token),
//   - never `unknown command` (the token resolves at all).
// The refusal TEXTS themselves stay owned by each command's own suite; only a
// short, stable fragment is pinned here — enough to tell one handler from
// another, little enough that rewording a message is not this file's problem.
//
// Every row is invoked in the shape that refuses EARLIEST — a target that does
// not exist, or the git precondition outside a repo — so no probe reads or
// writes anything in this repo (the fixture sits INSIDE it, so its workroot is
// the repo itself) and none spawns `gh`.
//
// Subcommand-style commands are invoked with a VALID subcommand token (the
// handler sits behind the token validation of slice 5). `arch-report verify` is a
// token, not a flag: the spec's option list carries no `verify` boolean, so the
// `wizard verify` shape is the only one that can parse.
// ---------------------------------------------------------------------------

// A command's refusal reaches whichever channel it chose — stderr for a hard
// error, stdout for a linter's finding report. The contract fixes the exit code
// and the TEXT, not the stream, so the fragments are matched against both.
function outputOf(result: { stderr: string; stdout: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

// `outsideRepo: true` runs the row in a directory that is NOT a git repo, where
// the command's own workroot precondition fails before it can spawn anything.
const dispatchedCommands: {
  argv: string[];
  command: string;
  expects: string[];
  outsideRepo?: true;
}[] = [
  {
    argv: ["ship", "--message-file", "message.md"],
    command: "ship",
    expects: ["--message-file", "cannot read"],
  },
  // `state` is IMPLEMENTED (`state.test.ts` owns its contract): `state init` now
  // AUTHORS a file, so it can neither answer `not implemented` nor be probed
  // against an in-repo fixture. Its registry entry (flag allowlist, subcommand
  // token validation, usage listing) is still covered by the slices around this
  // one, all of which reject before any handler runs.
  // `build-plan` is IMPLEMENTED (`buildplan.test.ts` owns its contract): it now
  // PARSES a spec's task table, so a bare `dobby build-plan` answers a parse
  // refusal naming the document it read, not `not implemented` — and it cannot be
  // probed against an in-repo fixture, whose workroot is this very repo (it would
  // read the live STATE.md). Its registry entry (flag allowlist, usage listing) is
  // still covered by the slices around this one, all of which reject before any
  // handler runs.
  // `repro` is IMPLEMENTED (its own suite owns it): a bare `dobby repro` is now a
  // usage error naming the missing command, not a stub. Its registry entry (flag
  // allowlist + usage listing) is still covered by the slices around this one.
  // `review fetch` and `pr watch` both read the PULL REQUEST first (a `gh`
  // spawn), so they are probed OUTSIDE a repo, where their own workroot
  // precondition refuses ahead of any spawn — the same reason slice 4 runs `up`
  // there.
  {
    argv: ["review", "fetch"],
    command: "review",
    expects: ["review:", "git repository"],
    outsideRepo: true,
  },
  {
    argv: ["pr", "watch"],
    command: "pr",
    expects: ["pr:", "git repository"],
    outsideRepo: true,
  },
  // `tracker`, `claim` and `goal` are IMPLEMENTED (`tracker.test.ts` owns their
  // contract): each now ACTS — reading `dobby.config.json#tracker`, spawning
  // `gh`, or writing `BACKLOG.md` — so none can answer `not implemented`, and
  // none may be probed against an in-repo fixture. Their registry entries (flag
  // allowlist, subcommand token validation, usage listing) stay covered by the
  // slices around this one, all of which reject before any handler runs.
  // `kb` and `adr` are IMPLEMENTED (`kb-adr.test.ts` owns their contract): `kb
  // list` now answers a JSON array and `adr new` AUTHORS a file, so neither can
  // answer `not implemented` nor be probed against an in-repo fixture. Their
  // registry entries (flag allowlist, subcommand token validation, usage listing)
  // are still covered by the slices around this one, all of which reject before
  // any handler runs.
  // `finish --preflight` and `migrate preflight|verify` are IMPLEMENTED (see
  // `preflight.test.ts` and `migrate.test.ts`, which own their contracts) — they
  // are no longer stubs, so their rows are gone from this table. Their registry
  // entries (flag allowlist, subcommand token validation, usage listing) stay
  // covered by the slices around this one, all of which reject before any handler
  // runs. `scope preflight` is DELETED outright — `preflight.test.ts` owns that
  // contract too (the invocation is now an ordinary unknown command).
  // `spec lint` and `map lint` both DEFAULT to a document inside the workroot
  // (the live `STATE.md`, the newest `docs/maps/*.md`) — this repo's own, from an
  // in-repo fixture — so each is handed a target that does not exist instead: the
  // refusal echoes the path, which is the handler reading the invocation.
  {
    argv: ["spec", "lint", "no-such-spec.md"],
    command: "spec",
    expects: ["spec lint:", "no-such-spec.md", "not found"],
  },
  {
    argv: ["map", "lint", "no-such-map.md"],
    command: "map",
    expects: ["map:", "no-such-map.md", "not found"],
  },
  // `skill lint` reads the cwd as the skill directory; the fixture holds no
  // `SKILL.md`, so its refusal is a FINDING (stdout) rather than a hard error —
  // which is why the fragments are matched against both channels.
  {
    argv: ["skill", "lint"],
    command: "skill",
    expects: ["SKILL.md not found"],
  },
  {
    argv: ["wizard", "verify"],
    command: "wizard",
    expects: ["wizard verify requires the script"],
  },
  {
    argv: ["arch-report", "verify"],
    command: "arch-report",
    expects: ["arch-report verify requires the report"],
  },
  {
    argv: ["handoff", "finalize"],
    command: "handoff",
    expects: ["handoff finalize requires the document"],
  },
  {
    argv: ["brief", "lint"],
    command: "brief",
    expects: ["brief lint requires the brief"],
  },
];

describe("run() — command dispatch", () => {
  it.each(dispatchedCommands)(
    "dispatches $command to its own handler: exit 1 with the handler's refusal, no usage block",
    async ({ argv, command, expects, outsideRepo }) => {
      const result = await run(
        argv,
        outsideRepo === true ? makeNonGitDir() : plainProject
      );
      const output = outputOf(result);
      expect(result.exitCode).toBe(1);
      for (const fragment of expects) {
        expect(output).toContain(fragment);
      }
      // A registry rejection ALWAYS carries the usage block, and a stub always
      // answers `<command>: not implemented`: this refusal is neither, so the
      // token reached the handler that owns it.
      expect(result.stderr).not.toContain(USAGE_HEADER);
      expect(output).not.toContain("not implemented");
      expect(output).not.toContain(`unknown command: ${command}`);
    }
  );

  it("dispatches `release` to its domain module when the config carries a release key", async () => {
    // `release` is IMPLEMENTED (`release.test.ts` owns its contract), so it can
    // no longer answer `not implemented`. What this slice still owns is the
    // config-GATED dispatch: with the key present the token RESOLVES and the
    // spine gets to refuse on its OWN terms (this suite registers no release
    // adapter, and the scratch repo is no releasable main checkout either)
    // instead of falling through to the unknown-command error the very same
    // argv gets without the key — which is the pair the slice below asserts.
    const repo = makeRepo({ files: [], release: { type: "npm" } });
    const result = await run(["release"], repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("unknown command");
    expect(result.stderr).not.toContain("not implemented");
    expect(result.stdout).toBe("");
  });

  it("accepts an allowlisted new flag in its inline `--flag=value` form", async () => {
    const result = await run(
      ["ship", "--message-file=message.md"],
      plainProject
    );
    // The refusal names the file it could not read: the inline form carried the
    // VALUE through, not merely the flag — and it came from ship's own handler,
    // never from the registry (which would have printed the usage block).
    expect(result.stderr).toContain("--message-file");
    expect(result.stderr).toContain("message.md");
    expect(result.stderr).not.toContain(USAGE_HEADER);
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — the `dobby up --json` footgun.
//
// `--json` parses globally today and `up` silently ignores it. The registry
// allowlists it for `up` (the payload lands in a later task), so the flag must
// NOT be rejected — while a flag that is genuinely foreign to `up` must be.
// Both run outside a git repo: `up`'s git precondition fails first, so an
// accepted flag is observable without ever starting a real run.
// ---------------------------------------------------------------------------

describe("run() — `up` flag allowlist", () => {
  it("accepts --json on up (it is allowlisted, not rejected)", async () => {
    const result = await run(["up", "--json"], makeNonGitDir());
    // A rejection always carries the usage block; up's own hard errors never do.
    expect(result.stderr).not.toContain(USAGE_HEADER);
    expect(result.exitCode).toBe(1);
  });

  it("rejects a flag up does not accept, naming the flag and the command", async () => {
    const result = await run(
      ["up", "--message-file", "message.md"],
      makeNonGitDir()
    );
    const message = rejectionMessage(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(message).toContain("--message-file");
    expect(message).toContain("up");
  });
});

// ---------------------------------------------------------------------------
// Slice 5 — subcommand token validation.
//
// A subcommand-style command validates its token BEFORE reaching the stub, and —
// following the `db:*` precedent, whose error already lists what IS available —
// the message names the offending token and the valid set.
// ---------------------------------------------------------------------------

describe("run() — subcommand validation", () => {
  it("rejects an unknown subcommand, naming it and the valid set", async () => {
    const result = await run(["state", "frobnicate"], plainProject);
    const message = rejectionMessage(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(message).toContain("frobnicate");
    expect(message).toContain("init");
    // The token is validated AHEAD of the stub, so an invalid one never reaches
    // the `not implemented` outcome.
    expect(result.stderr).not.toContain("not implemented");
  });

  it("rejects a missing subcommand, naming the valid set", async () => {
    const result = await run(["state"], plainProject);
    expect(result.exitCode).toBe(1);
    expect(rejectionMessage(result.stderr)).toContain("init");
  });

  it("validates subcommands for every subcommand-style command, not just state", async () => {
    const result = await run(["review", "frobnicate"], plainProject);
    const message = rejectionMessage(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(message).toContain("frobnicate");
    expect(message).toContain("fetch");
  });
});

// ---------------------------------------------------------------------------
// Slice 5b — per-SUBCOMMAND flag partitioning.
//
// The allowlist of a subcommand-style command is its own flags PLUS the chosen
// token's additions: a flag belonging to a SIBLING subcommand is as out of place
// as a flag from another command, and the rejection names the token too (`dobby
// state init`, not just `state`) — otherwise the message sends the caller to a
// flag that IS valid one token over.
// ---------------------------------------------------------------------------

describe("run() — per-subcommand flag allowlist", () => {
  it("rejects a sibling subcommand's flag (`--task` is append-worklog's, not init's)", async () => {
    const result = await run(["state", "init", "--task", "3"], plainProject);
    const message = rejectionMessage(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(message).toContain("--task");
    // The SUBCOMMAND is named, not merely the command: `--task` is legal under
    // `state append-worklog`, so `state` alone would be a misleading label.
    expect(message).toContain("state init");
    expect(result.stderr).not.toContain("not implemented");
  });

  it("partitions flags per subcommand for every such command, not just state", async () => {
    const result = await run(["tracker", "info", "--title", "x"], plainProject);
    const message = rejectionMessage(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(message).toContain("--title");
    expect(message).toContain("tracker info");
  });

  // `kb record` is implemented now, so this probes the HANDLER instead of a stub
  // — deliberately with `--kind` OMITTED, which `kb record` refuses before it
  // resolves a path: the invocation is guaranteed not to write into this repo
  // (`plainProject` is a fixture INSIDE it, so its workroot is the repo itself),
  // while the refusal — a handler message, with no usage block — is only
  // reachable if the registry ACCEPTED the subcommand-added `--concept`.
  it("accepts a flag the chosen subcommand adds, reaching the handler", async () => {
    const result = await run(
      ["kb", "record", "--concept", "worktree-per-goal"],
      plainProject
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--kind");
    expect(result.stderr).not.toContain(USAGE_HEADER);
  });

  // Probed on `brief lint` for the same reason as above — `tracker info` used to
  // play this part, but it is implemented now (it would read the config and spawn
  // `gh` against this repo). `brief lint` refuses on its MISSING target before it
  // reads anything, and that refusal — a handler message, with no usage block —
  // is only reachable if the registry accepted `--json`, which `brief` declares
  // command-wide rather than under the `lint` token.
  it("accepts a flag the command itself declares under any subcommand", async () => {
    const result = await run(["brief", "lint", "--json"], plainProject);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("brief lint requires the brief");
    expect(result.stderr).not.toContain(USAGE_HEADER);
  });
});

// ---------------------------------------------------------------------------
// Slice 6 — the help Commands block lists the new commands.
//
// The new commands are methodology commands: they apply to every repo, so they
// appear in a project with no detected capabilities. `release` is the ONE
// config-gated entry (interview I2).
// ---------------------------------------------------------------------------

const advertisedCommands = [
  "ship",
  "state",
  "build-plan",
  "repro",
  "review",
  "pr",
  "tracker",
  "claim",
  "goal",
  "kb",
  "adr",
  "finish",
  "migrate",
  "spec",
  "map",
  "skill",
  "wizard",
  "arch-report",
  "handoff",
  "brief",
];

describe("run() — usage Commands block", () => {
  it.each(advertisedCommands)(
    "advertises %s regardless of the repo's capabilities",
    async (name) => {
      const result = await run([], plainProject);
      expect(commandNames(result.stdout)).toContain(name);
    }
  );

  it("keeps advertising the existing commands", async () => {
    const result = await run([], plainProject);
    const names = commandNames(result.stdout);
    expect(names).toContain("env");
    expect(names).toContain("check");
    expect(names).toContain("update");
  });

  it("hides `release` when the loaded config carries no release key", async () => {
    const repo = makeRepo({ files: [] });
    const result = await run([], repo);
    expect(commandNames(result.stdout)).not.toContain("release");
  });

  it("hides `release` when the repo has no dobby.config.json at all", async () => {
    const repo = makeRepo();
    const result = await run([], repo);
    expect(commandNames(result.stdout)).not.toContain("release");
  });

  it("advertises `release` when the loaded config carries a release key", async () => {
    const repo = makeRepo({ files: [], release: { type: "npm" } });
    const result = await run([], repo);
    expect(commandNames(result.stdout)).toContain("release");
  });
});

// ---------------------------------------------------------------------------
// Slice 7 — the registry breaks nothing that already worked.
// ---------------------------------------------------------------------------

describe("run() — existing behavior preserved", () => {
  it("still prints the env snapshot as JSON for `env --json`", async () => {
    const result = await run(["env", "--json"], plainProject);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("still prints usage with exit 0 for a bare invocation", async () => {
    const result = await run([], plainProject);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith(USAGE_HEADER)).toBe(true);
    expect(result.stderr).toBe("");
  });

  it("still honors the command-less --version flag", async () => {
    const result = await run(["--version"], plainProject);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("still reports an unrecognized command as unknown, with the upgrade hint", async () => {
    const result = await run(["frobnicate"], plainProject);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command: frobnicate");
    expect(result.stderr).toContain(
      "if this command is expected, run `bun update @kvnwolf/dobby`"
    );
  });
});
