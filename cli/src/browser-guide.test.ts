import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  restoreEnv,
  useSpawnBudget,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// THE VERIFICATION PROTOCOL SHIPS INSIDE THE CLI.
//
// Task contract: the cmux browser protocol — open, read the URL, snapshot for
// fresh refs, act, wait, re-snapshot, plus the stale-ref and script-error
// recovery — is VENDORED into `cli/src/browser-guide.ts`, which picks the
// variant for the detected environment, and `dobby instructions browser`
// DELIVERS it. Without cmux the guide is the non-cmux verification
// instructions — never empty.
// Provenance (repository, commit, licence, SHA-256) is recorded the way
// `plugin/skills/trim-context/scripts/vendor/PROVENANCE.md` already does it
// (ADR-0027).
//
// THE GUIDE'S DELIVERY CHANNEL IS `dobby instructions browser --json`, whose
// payload is `{environment, topic, applies, text}` — the guide is the `text`
// field, and `browser` applies in every environment (it needs no git workroot).
// It is NO LONGER an `env` snapshot field: `dobby env` reports environment
// FACTS only. This suite pins what the guide SAYS, whatever command hands it
// over; `instructions.test.ts` pins the catalogue's own contract.
//
// The seam under test is the PUBLIC one: `run(argv, cwd) -> {exitCode, stdout,
// stderr}` against a throwaway git repo — the repo's standing convention for
// env behavior. `browser-guide.ts`, `environment.ts` and the adapters are NEVER
// imported here, so how the catalogue stores or selects its text is free to
// change; only what the CLI HANDS THE MODEL is pinned.
//
// Where every expected value comes from (all independent of any implementation):
//  - the two variants and the "never empty" floor are the task's constraints,
//    stated outright;
//  - the nine protocol beats are the spec's own enumeration ("open, read the
//    URL, snapshot for fresh refs, act, wait, re-snapshot, and the stale-ref
//    and script-error recovery");
//  - `cmux-browser` is the glossary's name for the tool the cmux rung drives,
//    and claude-in-chrome / curl are the glossary's non-cmux rungs of the same
//    ladder;
//  - cmux presence is `CMUX_WORKSPACE_ID` (the task's constraint, and the same
//    marker the snapshot's own `cmux` field reports);
//  - the payload shape `{environment, topic, applies, text}` and `applies:
//    true` for `browser` in both environments are the catalogue contract,
//    stated outright;
//  - the provenance facts are `PROVENANCE.md`'s existing four columns, and each
//    recorded SHA-256 is checked against the bytes on disk, recomputed here
//    with node:crypto — never against whatever the module believes.
//
// RETARGETED when `env` went back to reporting facts only: every case below
// that used to read `browserGuide` off `dobby env --json` now reads the `text`
// of `dobby instructions browser --json`, same fixtures and same cmux toggling.
// Under cmux that text now OPENS with a surface step (reuse or open the
// `dobby-browser-<slug>` pane) before the vendored protocol, so the protocol is
// asserted by containment, never as the first line. Since the command already
// exists these are REGRESSION GUARDS, not red contract tests.
// ---------------------------------------------------------------------------

useSpawnBudget();

const CMUX = "CMUX_WORKSPACE_ID";
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SRC_DIR, "..");

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA256_ANYWHERE_RE = /\b[0-9a-f]{64}\b/;
const BACKTICKED_RE = /`([^`]+)`/g;
const COMMIT_RE = /commit[^\n]*\b[0-9a-f]{7,40}\b/i;
const LICENCE_RE = /licen[cs]e/i;
const CMUX_UPSTREAM_RE = /manaflow-ai\/cmux/i;
// A cmux-browser CLI instruction: the tool name followed by an operation. The
// non-cmux variant may NAME cmux in prose; it may not INSTRUCT its commands.
const CMUX_BROWSER_COMMAND_RE =
  /cmux-browser\s+(?:--\S+\s+)*(?:open|snapshot|url|click|type|press|wait|eval|screenshot|navigate)/i;

// The nine beats the spec enumerates for the vendored cmux protocol. A guide
// that drops one has stopped being the protocol QA was promised.
const PROTOCOL_BEATS: [string, RegExp][] = [
  ["names the cmux-browser driver", /cmux-browser/i],
  ["opening the page", /\bopen(?:s|ing|ed)?\b/i],
  ["reading the current URL", /\burl\b/i],
  ["taking a snapshot", /snapshot/i],
  ["the element refs a snapshot yields", /\brefs?\b/i],
  ["acting on the page", /\b(?:click|type|press|fill|act)\w*\b/i],
  ["waiting", /\bwait\w*\b/i],
  [
    "snapshotting again after acting",
    /re-?snapshot|snapshot again|new snapshot|snapshot after|fresh snapshot/i,
  ],
  ["stale-ref recovery", /stale/i],
  ["script-error recovery", /script/i],
];

const scratchDirs: string[] = [];
const originalCmux = process.env[CMUX];

// One project fixture, reused: a real git repo with a valid dobby.config.json
// and no app capabilities, so nothing but the cmux marker can move the guide.
const project = makeScratchRepo({
  branch: "dobby-browser-guide",
  config: { files: [] },
  pkg: { name: "scratch-browser-guide", version: "0.0.0" },
  prefix: "dobby-browser-guide-",
  track: scratchDirs,
});

beforeEach(() => {
  Reflect.deleteProperty(process.env, CMUX);
});

afterAll(() => {
  restoreEnv(CMUX, originalCmux);
  cleanupDirs(scratchDirs);
});

// Put the process in (or out of) a cmux workspace before asking.
function withCmux(workspaceId?: string): void {
  if (workspaceId === undefined) {
    Reflect.deleteProperty(process.env, CMUX);
  } else {
    process.env[CMUX] = workspaceId;
  }
}

// Ask the environment for its JSON snapshot, optionally inside a cmux workspace.
async function snapshot(
  workspaceId?: string
): Promise<Record<string, unknown>> {
  withCmux(workspaceId);
  const result = await run(["env", "--json"], project);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// Ask the CATALOGUE for the browser topic — the guide's delivery channel.
async function browserInstruction(
  workspaceId?: string
): Promise<Record<string, unknown>> {
  withCmux(workspaceId);
  const result = await run(["instructions", "browser", "--json"], project);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function guideFor(workspaceId?: string): Promise<string> {
  const value = (await browserInstruction(workspaceId)).text;
  expect(typeof value).toBe("string");
  return value as string;
}

// --- Slice 1 (tracer bullet): the cmux protocol reaches QA ------------------
// The headline behavior: inside a cmux workspace QA is handed the protocol it
// would otherwise rediscover every run.
describe("dobby instructions browser — inside a cmux workspace", () => {
  it("hands over a browser guide for the environment", async () => {
    const payload = await browserInstruction("cmux-ws-browser-guide");

    expect(payload.applies).toBe(true);
    expect(typeof payload.text).toBe("string");
  });

  it("carries the vendored cmux browser protocol, not a pointer to it", async () => {
    const guide = await guideFor("cmux-ws-browser-guide");

    // A URL to fetch later is exactly what the vendoring replaced. The text may
    // OPEN with the surface step (reuse or open the browser pane), so the
    // protocol is asserted by containment, never as the first line.
    expect(guide.trim().length).toBeGreaterThan(200);
    expect(guide).toMatch(/cmux-browser/i);
  });

  it("covers every step of the protocol the spec enumerates", async () => {
    const guide = await guideFor("cmux-ws-browser-guide");

    const missing = PROTOCOL_BEATS.filter(([, re]) => !re.test(guide)).map(
      ([beat]) => beat
    );
    expect(missing).toEqual([]);
  });
});

// --- Slice 2: the non-cmux variant, never empty -----------------------------
describe("dobby instructions browser — without a cmux workspace", () => {
  it("carries the non-cmux verification instructions instead", async () => {
    const guide = await guideFor();

    expect(guide.trim().length).toBeGreaterThan(80);
    expect(guide).toMatch(/claude-in-chrome|chrome|curl/i);
  });

  it("never instructs a cmux-browser command QA cannot run", async () => {
    const guide = await guideFor();

    expect(guide).not.toMatch(CMUX_BROWSER_COMMAND_RE);
  });

  it("reads an empty CMUX_WORKSPACE_ID as no cmux at all", async () => {
    const empty = await guideFor("");
    const unset = await guideFor();

    expect(empty).toBe(unset);
  });
});

// --- Slice 3: the selector actually selects ---------------------------------
describe("dobby instructions browser — the guide matches the detected environment", () => {
  it("returns a different guide for each environment", async () => {
    const cmuxGuide = await guideFor("cmux-ws-browser-guide");
    const terminalGuide = await guideFor();

    expect(cmuxGuide).not.toBe(terminalGuide);
  });

  it("agrees with the cmux fact the environment snapshot reports", async () => {
    // The two commands must read the same environment: whenever `env` says a
    // cmux workspace is present, the guide handed over is the cmux one — and
    // when it says none is, the guide never names the driver QA cannot run.
    const insideFacts = await snapshot("cmux-ws-browser-guide");
    const insideGuide = await guideFor("cmux-ws-browser-guide");
    const outsideFacts = await snapshot();
    const outsideGuide = await guideFor();

    expect([
      insideFacts.cmux === "cmux-ws-browser-guide",
      /cmux-browser/i.test(insideGuide),
      outsideFacts.cmux === null,
      /cmux-browser/i.test(outsideGuide),
    ]).toEqual([true, true, true, false]);
  });

  it("answers the same bytes on every call, with no network of its own", async () => {
    const first = await guideFor("cmux-ws-browser-guide");
    const second = await guideFor("cmux-ws-browser-guide");

    expect(second).toBe(first);
  });
});

// --- Slice 4: the snapshot keeps its own job --------------------------------
// `env` reports environment FACTS; the guide reaches QA through the catalogue.
describe("dobby env — the snapshot reports facts, not the guide", () => {
  it("no longer delivers the browser guide as an environment fact", async () => {
    const snap = await snapshot("cmux-ws-browser-guide");

    expect(snap).not.toHaveProperty("browserGuide");
  });

  it("still reports the project's branch, worktree root and config", async () => {
    const snap = await snapshot();

    expect(snap.branch).toBe("dobby-browser-guide");
    expect(snap.worktree).toBe(project);
    expect(snap.config).toBe(true);
    expect(snap.devUrl).toBe(null);
  });

  it("still exits 0 in human form with every other field on its own line", async () => {
    const result = await run(["env"], project);
    const printed = new Set(
      result.stdout
        .split("\n")
        .filter((line) => line.includes(":"))
        .map((line) => line.slice(0, line.indexOf(":")).trim())
    );

    expect(result.exitCode).toBe(0);
    for (const key of [
      "cmux",
      "worktree",
      "branch",
      "capabilities",
      "config",
    ]) {
      expect(printed.has(key), `missing field: ${key}`).toBe(true);
    }
  });
});

// --- Slice 5: provenance, recorded the way ADR-0027 records it ---------------
// Vendored text with no provenance is text of unknown origin; a recorded hash
// that no longer matches the bytes is worse than none, so both are asserted.
describe("the vendored protocol's provenance record", () => {
  const doc = findProvenanceDoc();

  it("ships a provenance record naming the upstream cmux repository", () => {
    expect(doc, "no provenance doc under cli/ names manaflow-ai/cmux").not.toBe(
      null
    );
    expect(readFileSync(doc as string, "utf8")).toMatch(CMUX_UPSTREAM_RE);
  });

  it("records the commit, the licence and both vendored upstream files", () => {
    const text = readFileSync(doc as string, "utf8");

    const missing = (
      [
        ["commit", COMMIT_RE],
        ["licence", LICENCE_RE],
        ["skills/cmux-browser/SKILL.md", /skills\/cmux-browser\/SKILL\.md/],
        ["references/commands.md", /references\/commands\.md/],
      ] as [string, RegExp][]
    )
      .filter(([, re]) => !re.test(text))
      .map(([fact]) => fact);

    expect(missing).toEqual([]);
  });

  it("records at least one vendored file by its true SHA-256", () => {
    const text = readFileSync(doc as string, "utf8");
    const digests = new Set(
      backticked(text).filter((token) => SHA256_RE.test(token))
    );
    const onDisk = new Set(
      filesUnder(dirname(doc as string)).map((path) => sha256(path))
    );

    expect(
      [...digests].some((digest) => onDisk.has(digest)),
      "no recorded SHA-256 matches any file vendored beside the record"
    ).toBe(true);
  });

  it("records the true SHA-256 for every file it pairs one with", () => {
    const text = readFileSync(doc as string, "utf8");
    const drifted: string[] = [];

    for (const line of text.split("\n")) {
      if (!SHA256_ANYWHERE_RE.test(line)) {
        continue;
      }
      const tokens = backticked(line);
      const digests = tokens.filter((token) => SHA256_RE.test(token));
      const paths = tokens
        .filter((token) => !SHA256_RE.test(token))
        .map((token) => join(dirname(doc as string), token))
        .filter((path) => existsSync(path) && statSync(path).isFile());
      for (const path of paths) {
        if (digests.length > 0 && !digests.includes(sha256(path))) {
          drifted.push(path);
        }
      }
    }

    expect(drifted).toEqual([]);
  });
});

// --- helpers ---------------------------------------------------------------

// The provenance record for the vendored protocol: the first markdown file
// under `cli/` naming the upstream cmux repository. Location-agnostic on
// purpose — the record must EXIST and be true, not sit at a path this suite
// dictates.
function findProvenanceDoc(): string | null {
  const naming = filesUnder(CLI_ROOT)
    .filter((path) => path.endsWith(".md"))
    .filter((path) => CMUX_UPSTREAM_RE.test(readFileSync(path, "utf8")));

  // A module doc may MENTION the vendoring; the provenance RECORD is the file
  // named for it, or failing that the one carrying checksums.
  return (
    naming.find((path) => /provenance/i.test(path)) ??
    naming.find((path) =>
      SHA256_ANYWHERE_RE.test(readFileSync(path, "utf8"))
    ) ??
    naming[0] ??
    null
  );
}

// Every regular file under `dir`, skipping node_modules, .git and this suite.
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...filesUnder(path));
    } else if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

// Every backtick-quoted token in `text` — the cells a PROVENANCE table pairs a
// vendored file path with its digest in.
function backticked(text: string): string[] {
  const out: string[] = [];
  for (const [, token] of text.matchAll(BACKTICKED_RE)) {
    if (token !== undefined) {
      out.push(token.trim());
    }
  }
  return out;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
