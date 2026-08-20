import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ===========================================================================
// THE DISPATCH PROTOCOL — the shared build-loop component the Architect FOLLOWS.
//
// This file replaces the harness that used to extract and execute a fenced `js`
// build-run script out of `references/build-workflow.md`. That script is gone:
// the build loop is no longer a Workflow run, it is a protocol the interactive
// Architect reads and carries out by dispatching named subagents itself. The
// coverage does not disappear with the script — the SAME behaviours it used to
// pin (who is launched, when a task may start, what happens when one dies, who
// writes the work log, what the run reports at the end) are re-expressed here as
// invariants of the protocol document.
//
// THE SEAM. The artifact under test is a document, so its interface is its text:
// the instructions an Architect (or a `/dobby:dispatch` / `/dobby:address-review`
// caller) actually reads. Assertions are therefore scoped to a document SECTION
// (a heading plus its body) rather than an exact sentence, so the protocol's
// prose stays free to be written well while its RULES stay pinned.
//
// BOUNDARIES MOCKED: none. There is no network, clock, randomness or write here
// — only reads of committed repository files.
//
// WHERE EVERY EXPECTED VALUE COMES FROM (all INDEPENDENT of any implementation):
//  - The new filename `build-protocol.md` and the retirement of
//    `build-workflow.md` are the task's constraint, verbatim.
//  - The seven behaviours asserted are the spec's own sentences: launch each
//    task's workers NAMED; start a task when its dependencies are done; serialise
//    the Exit gate so only one runs at a time; keep dispatching independent work
//    when a task dies and say what died; workers append their own work log and
//    return a short verdict; run state lives in STATE.md as it advances; close
//    with a summary table.
//  - The four summary-table facts (rounds per task, first-attempt success, where
//    anything died, wall clock) are the decision's literal list.
//  - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `ToolSearch`, `select:SendMessage`
//    and `dobby state append-worklog` are literal identifiers the constraints and
//    decisions name character-for-character — nothing is inferred about them.
//  - "This task must not describe a Workflow anywhere" is the constraint stated
//    as a ban, so the ban is what is asserted.
//  - The `dobby:`-qualified agent ids are the kit's mandatory namespacing rule
//    (CLAUDE.md, CONTEXT.md `Namespacing`).
// ===========================================================================

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REFERENCES = resolve(REPO_ROOT, "plugin/skills/execute/references");
const PROTOCOL_PATH = resolve(REFERENCES, "build-protocol.md");
const RETIRED_SCRIPT_PATH = resolve(REFERENCES, "build-workflow.md");

// The two filenames the rename retires. A live kit surface still naming either is
// a dangling pointer, which the constraint forbids explicitly.
const RETIRED_NAMES = ["build-workflow.md", "build-workflow.test.ts"];

function readProtocol(): string {
  if (!existsSync(PROTOCOL_PATH)) {
    throw new Error(
      `the dispatch protocol does not exist at ${relative(REPO_ROOT, PROTOCOL_PATH)}`
    );
  }
  return readFileSync(PROTOCOL_PATH, "utf8");
}

// A document SECTION: one markdown heading plus everything under it, up to the
// next heading. Rules are asserted per-section so a rule written as "heading +
// body" reads the same to this suite as one written on a single bullet line —
// while still being far stricter than a whole-document `toContain`.
function sections(doc: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of doc.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      if (current.length > 0) {
        out.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    out.push(current.join("\n"));
  }
  return out;
}

// Sections in which EVERY pattern matches — the unit of "the protocol states this
// rule, in one place, joined up".
function sectionsStating(doc: string, ...patterns: RegExp[]): string[] {
  return sections(doc).filter((section) =>
    patterns.every((pattern) => pattern.test(section))
  );
}

function statesRule(doc: string, ...patterns: RegExp[]): boolean {
  return sectionsStating(doc, ...patterns).length > 0;
}

// A section INCLUDING everything nested under it: a heading plus its body AND any
// deeper headings below it, up to the next heading at the same or a shallower
// level. The document's single title heading is excluded, so this can never
// degrade into a whole-file `toContain`.
//
// The fix conversation is one multi-rule loop (route, count, cap, escalate), so a
// writer may reasonably break it into subsections. Grouping a heading with its
// descendants keeps a rule matchable wherever inside its own section the writer
// put it, while still scoping the assertion to that section.
function nestedSections(doc: string): string[] {
  const lines = doc.split("\n");
  const heads: Array<{ index: number; depth: number }> = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})\s/.exec(line);
    if (match?.[1] !== undefined) {
      heads.push({ depth: match[1].length, index });
    }
  }
  if (heads.length === 0) {
    return [];
  }

  const minDepth = Math.min(...heads.map((head) => head.depth));
  const skipTitle =
    heads.filter((head) => head.depth === minDepth).length === 1;

  const blocks: string[] = [];
  for (const [i, head] of heads.entries()) {
    if (skipTitle && head.depth === minDepth) {
      continue;
    }
    const next = heads.slice(i + 1).find((later) => later.depth <= head.depth);
    blocks.push(
      lines.slice(head.index, next?.index ?? lines.length).join("\n")
    );
  }
  return blocks;
}

// One section (with its subsections) states ALL of these — the unit of "this rule
// is written down, joined up, in one place a reader lands on".
function statesJoinedRule(doc: string, ...patterns: RegExp[]): boolean {
  return nestedSections(doc).some((section) =>
    patterns.every((pattern) => pattern.test(section))
  );
}

// Vocabulary shared by the fix-conversation rules. Each is an ALTERNATION so the
// rule is pinned while the prose stays free to be written well.
const SENDS = /message|send/i;
const ROUND = /\bround/i;
const FIVE = /\bfive\b|\b5\b/i;
const ARCHITECT = /Architect/i;
const NEGATION = /never|not\b|n't|no\b|instead of|rather than|without/i;
const SPENDS = /consume|count|spend|burn|cost/i;
const UNDELIVERABLE =
  /dead|died|gone|unreachable|no longer|deliver|undelivered|fails to send|send fails|cannot be reached|can't be reached/i;

// The languages of a fenced block that would make the document a SCRIPT again.
const EXECUTABLE_FENCE = /^```(js|javascript|jsx|ts|typescript|tsx)\s*$/;

function executableFenceLanguages(doc: string): string[] {
  const found: string[] = [];
  for (const line of doc.split("\n")) {
    const match = EXECUTABLE_FENCE.exec(line.trim());
    if (match?.[1] !== undefined) {
      found.push(match[1]);
    }
  }
  return found;
}

// --- the repo-wide reference scan ------------------------------------------

const TEXT_EXTENSIONS = new Set([".md", ".ts", ".js", ".json", ".jsonc"]);
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "vendor"]);
const SELF = basename(fileURLToPath(import.meta.url));

// The LIVE kit surfaces: anything here that names a retired file is a pointer a
// reader would follow today. `docs/` (ADRs — immutable records of decisions as
// they were made) and `PLAN.md` (a historical migration plan) are deliberately
// out: rewriting history is not what "update every reference" means.
const SCAN_ROOTS = [
  "plugin",
  "cli/src",
  "cli/CONTEXT.md",
  "cli/README.md",
  "CONTEXT.md",
  "README.md",
  "CLAUDE.md",
];

function textFilesUnder(target: string, collected: string[]): void {
  if (!existsSync(target)) {
    return;
  }
  if (!statSync(target).isDirectory()) {
    if (TEXT_EXTENSIONS.has(extname(target)) && basename(target) !== SELF) {
      collected.push(target);
    }
    return;
  }
  for (const entry of readdirSync(target)) {
    if (SKIPPED_DIRS.has(entry)) {
      continue;
    }
    textFilesUnder(join(target, entry), collected);
  }
}

function liveSurfaceFiles(): string[] {
  const collected: string[] = [];
  for (const root of SCAN_ROOTS) {
    textFilesUnder(resolve(REPO_ROOT, root), collected);
  }
  return collected;
}

// ---------------------------------------------------------------------------
// SLICE 1 — the artifact itself: renamed, and no longer a script.
// This is the tracer bullet: nothing else in the contract can hold until the
// shared build-loop component exists at its new path as prose instructions.
// ---------------------------------------------------------------------------

describe("the shared build-loop component", () => {
  it("lives at build-protocol.md", () => {
    expect(
      existsSync(PROTOCOL_PATH),
      `expected the dispatch protocol at ${relative(REPO_ROOT, PROTOCOL_PATH)}`
    ).toBe(true);
    expect(readProtocol().trim().length).toBeGreaterThan(0);
  });

  it("no longer ships the retired build-workflow.md file", () => {
    expect(
      existsSync(RETIRED_SCRIPT_PATH),
      `${relative(REPO_ROOT, RETIRED_SCRIPT_PATH)} was renamed, so it must be gone`
    ).toBe(false);
  });

  it("carries no runnable script for a runtime to execute", () => {
    const doc = readProtocol();

    expect(
      executableFenceLanguages(doc),
      "the protocol is instructions the Architect follows, not a script"
    ).toEqual([]);
    for (const runtimeCall of [
      "export const meta",
      "parallel(",
      "pipeline(",
      "phase(",
      "budget(",
      "agent(",
    ]) {
      expect(doc, `retired runtime primitive: ${runtimeCall}`).not.toContain(
        runtimeCall
      );
    }
  });

  it("describes no Workflow anywhere", () => {
    expect(readProtocol()).not.toMatch(/workflow/i);
  });

  it("imposes no retired concurrency cap", () => {
    expect(readProtocol()).not.toMatch(/maxconcurrency/i);
  });
});

// ---------------------------------------------------------------------------
// SLICE 2 — the rename leaves no dangling path behind.
// ---------------------------------------------------------------------------

describe("the rename of the build-loop component", () => {
  it("leaves no live kit surface pointing at a retired filename", () => {
    const offenders: string[] = [];
    for (const file of liveSurfaceFiles()) {
      const content = readFileSync(file, "utf8");
      for (const name of RETIRED_NAMES) {
        if (content.includes(name)) {
          offenders.push(`${relative(REPO_ROOT, file)} → ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("points execute, dispatch and address-review at the dispatch protocol", () => {
    for (const skill of ["execute", "dispatch", "address-review"]) {
      const path = resolve(REPO_ROOT, "plugin/skills", skill, "SKILL.md");
      expect(readFileSync(path, "utf8"), `${skill} SKILL.md`).toContain(
        "build-protocol.md"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SLICE 3 — how the Architect launches workers.
// ---------------------------------------------------------------------------

describe("the dispatch protocol — launching workers", () => {
  it("requires every worker to be dispatched with a name", () => {
    expect(
      statesRule(readProtocol(), /\bname\b/i, /roster|sibling|addressab/i),
      "named dispatch is what makes the sibling roster (and SendMessage) exist"
    ).toBe(true);
  });

  it("names each worker it dispatches in the kit's namespace", () => {
    const doc = readProtocol();

    for (const worker of [
      "dobby:test-author",
      "dobby:implementor",
      "dobby:qa",
    ]) {
      expect(doc, `the protocol must name ${worker}`).toContain(worker);
    }
  });

  it("requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to be unset", () => {
    expect(
      statesRule(
        readProtocol(),
        /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/,
        /unset|not be set|must not|off\b|disabled/i
      ),
      "with agent teams on, a named subagent silently launches as a teammate"
    ).toBe(true);
  });

  it("loads the deferred SendMessage tool before a worker uses it", () => {
    const doc = readProtocol();

    expect(doc).toContain("ToolSearch");
    expect(doc).toContain("select:SendMessage");
  });
});

// ---------------------------------------------------------------------------
// SLICE 4 — when a task may start, and the one thing that must not overlap.
// ---------------------------------------------------------------------------

describe("the dispatch protocol — scheduling", () => {
  it("starts a task as soon as its own dependencies are done", () => {
    expect(
      statesRule(
        readProtocol(),
        /depend/i,
        /\bdone\b|satisfied|complete|finished|passed/i
      )
    ).toBe(true);
  });

  it("schedules without wave barriers", () => {
    expect(
      readProtocol(),
      "tasks start on their own dependencies, so there are no waves left"
    ).not.toMatch(/\bwaves?\b/i);
  });

  it("serialises the Exit gate so only one implementor runs it at a time", () => {
    expect(
      statesRule(
        readProtocol(),
        /exit gate/i,
        /one at a time|only one|serialis|serializ|take turns|wait your turn|queue/i
      ),
      "otherwise one task's gate judges another's half-written code"
    ).toBe(true);
  });

  it("never dispatches two tasks whose Affected areas overlap at the same time", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /affected areas|\bareas\b/i,
        /overlap|share|same/i,
        /wait|exactly as if it depended|not (?:be )?dispatch|never dispatch/i
      ),
      "overlapping writers must be serialised like a dependency, not raced"
    ).toBe(true);
  });

  it("does not let Exit-gate serialisation stand in for the area-overlap check", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /exit gate/i,
        /judg/i,
        /overlap|concurrent|same time/i,
        NEGATION
      ),
      "gate serialisation protects the gate's verdict, not the shared tree from concurrent edits"
    ).toBe(true);
  });

  it("compares areas as normalised paths, not as opaque strings matched for exact equality", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /affected areas|\bareas\b/i,
        /normali[sz]/i,
        /opaque|exact.{0,10}equal|string.{0,10}equal/i
      ),
      "a directory area and a file area beneath it must compare equal, not just identical strings"
    ).toBe(true);
  });

  it("treats one area being a prefix of the other as overlap", () => {
    expect(
      statesJoinedRule(readProtocol(), /affected areas|\bareas\b/i, /prefix/i),
      "a directory area and a file area beneath it describe overlapping ground even though the labels differ"
    ).toBe(true);
  });

  it("states that a task with vague areas weakens its own protection", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /affected areas|\bareas\b/i,
        /vague/i,
        /weaken/i
      ),
      "the area check is only as good as the paths the spec actually declares"
    ).toBe(true);
  });

  it("admits the area check cannot catch every real collision", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /affected areas|\bareas\b/i,
        /unrelated|undeclared|never declar/i,
        NEGATION
      ),
      "unrelated labels for the same file, or a file a task never declared, slip past a static comparison"
    ).toBe(true);
  });

  it("states that spec-time lint now prevents two tasks describing the same file under unrelated labels", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /affected areas|\bareas\b/i,
        /spec lint/i,
        /real (?:repository )?path/i
      ),
      "`dobby spec lint` requires every area to be a real path, so unrelated prose labels for the same file can no longer both pass — the residual gap narrows to files a task never declared at all"
    ).toBe(true);
  });

  it("narrows the residual gap to a file a task never declared, now that unrelated labels are caught at spec time", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /affected areas|\bareas\b/i,
        /irreducible|residual/i,
        /never declared/i
      ),
      "what remains after spec-time lint is genuinely irreducible: no static comparison can know what a task will open before it opens it"
    ).toBe(true);
  });

  it("names the serialised Exit gate as detection, not prevention, for that residual gap", () => {
    expect(
      statesJoinedRule(readProtocol(), /exit gate/i, /detect/i, /prevent/i),
      "the gate judges the whole tree and surfaces a sibling's undeclared edit as a finding, after the fact"
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SLICE 5 — when a task dies.
// ---------------------------------------------------------------------------

describe("the dispatch protocol — a task that dies", () => {
  it("stops only what genuinely depends on the dead task", () => {
    const doc = readProtocol();

    expect(
      statesRule(
        doc,
        /depend/i,
        /fail|died|dies|dead|needs-human|blocked/i,
        /keep|still|continu|carry on|unaffected|independent/i
      ),
      "independent work keeps being dispatched while dependents stop"
    ).toBe(true);
  });

  it("reports what died", () => {
    expect(
      statesRule(
        readProtocol(),
        /report|say|name|surface|tell|record/i,
        /died|dead|failed|needs-human|blocked/i
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SLICE 6 — what a worker writes and what it returns.
// ---------------------------------------------------------------------------

describe("the dispatch protocol — what a worker hands back", () => {
  it("has each worker append its own work-log entry", () => {
    expect(readProtocol()).toContain("dobby state append-worklog");
  });

  it("has each worker return only a short verdict", () => {
    expect(
      statesRule(
        readProtocol(),
        /verdict/i,
        /short|brief|terse|one[- ]line|a line|few/i
      ),
      "the short verdict is what preserves context isolation"
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SLICE 7 — the run's own record.
// ---------------------------------------------------------------------------

describe("the dispatch protocol — the run record", () => {
  it("keeps run state in STATE.md as the run advances", () => {
    expect(
      statesRule(
        readProtocol(),
        /STATE\.md/,
        /as it advances|as the run|progress|run state|in flight|live/i
      )
    ).toBe(true);
  });

  it("keeps enough run state to reconstruct progress after a compaction", () => {
    expect(readProtocol()).toMatch(/compact/i);
  });

  it("closes the run with a summary table covering rounds, first-attempt success, deaths and wall clock", () => {
    const doc = readProtocol();
    const summary = sectionsStating(doc, /summary/i, /^\s*\|/m);

    expect(summary, "a closing summary TABLE").not.toHaveLength(0);
    const table = summary.join("\n");
    expect(table, "rounds per task").toMatch(/round/i);
    expect(table, "first-attempt success").toMatch(/first[- ]attempt/i);
    expect(table, "where anything died").toMatch(
      /died|dead|failed|needs-human|blocked/i
    );
    expect(table, "wall clock").toMatch(/wall[- ]?clock/i);
  });
});

// ===========================================================================
// THE FIX CONVERSATION — the loop that closes a failure.
//
// WHERE THESE EXPECTED VALUES COME FROM (all INDEPENDENT of any implementation):
//  - The routing (QA → the implementor that still holds the context for a code
//    defect; QA → the test-author when the CONTRACT is at fault) is the spec's
//    own sentence.
//  - "QA numbers every message so the count lives in the text" and "the count
//    travels in the text rather than in anyone's memory" are the decision's
//    literal words.
//  - FIVE is the decision's literal cap, and "at five it stops and reports to the
//    Architect" is its literal consequence.
//  - "environment failures go to the Architect, never to a writer, and do NOT
//    consume a round" is the decision, stated as three separate facts.
//  - "the sender reports to the Architect rather than retrying blindly, and the
//    round still counts" is the constraint, verbatim.
//  - The `dobby:`-qualified addressee ids are the kit's mandatory namespacing
//    rule (CLAUDE.md, CONTEXT.md `Namespacing`) — and the name is literally the
//    answer to "who does QA message", since a worker can only reach a sibling it
//    can name.
// ===========================================================================

// ---------------------------------------------------------------------------
// SLICE 8 — the tracer bullet of the fix loop: a real defect reaches the worker
// that can still fix it cheaply. Nothing else in the conversation matters until
// the first message has a correct addressee.
// ---------------------------------------------------------------------------

describe("the fix conversation — routing a failure", () => {
  it("has QA message the implementor that still holds the task's context", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /\bQA\b/,
        /dobby:implementor/,
        SENDS,
        /defect|failure|failing/i
      ),
      "a code defect goes to the worker that still holds the context, by name"
    ).toBe(true);
  });

  it("has QA message the test-author when the contract itself is at fault", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /\bQA\b/,
        /dobby:test-author/,
        SENDS,
        /contract/i
      ),
      "a test-contract failure is the test-author's to fix, not the implementor's"
    ).toBe(true);
  });

  it("keeps a test-contract message to expected behaviour, never quoting the implementation", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /dobby:test-author/,
        /behaviou?r/i,
        /quote|verbatim|snippet|fragment|implementation/i,
        NEGATION
      ),
      "the test-author's blindness to the code is what keeps the tests honest"
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SLICE 9 — the count that travels in the text.
// ---------------------------------------------------------------------------

describe("the fix conversation — counting the rounds", () => {
  it("has QA write the round number into every message it sends", () => {
    expect(
      statesJoinedRule(readProtocol(), /\bnumber|\bcount/i, SENDS, ROUND)
    ).toBe(true);
  });

  it("keeps the count in the message text rather than in anyone's memory", () => {
    expect(
      statesJoinedRule(readProtocol(), /memor|remember|recall/i, SENDS, ROUND),
      "a count nobody has to remember is a count that survives a fresh context"
    ).toBe(true);
  });

  it("caps the fix conversation at five rounds", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        FIVE,
        ROUND,
        /cap|limit|most|maximum|no more|stop|last/i
      )
    ).toBe(true);
  });

  it("stops at the fifth round and reports to the Architect", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        FIVE,
        ROUND,
        ARCHITECT,
        /stop|hand|report|escalat|give up/i
      ),
      "the exhausted loop ends with the Architect, not with another retry"
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SLICE 10 — the failures that are not the code's fault.
// ---------------------------------------------------------------------------

describe("the fix conversation — failures no writer can fix", () => {
  it("routes an environment failure to the Architect and never to a writer", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        /environment/i,
        ARCHITECT,
        /dobby:implementor|implementor|dobby:test-author|test-author|writer/i,
        NEGATION
      ),
      "a dead browser or a missing session is nothing a writer can implement away"
    ).toBe(true);
  });

  it("spends no round on an environment failure", () => {
    expect(
      statesJoinedRule(readProtocol(), /environment/i, ROUND, SPENDS, NEGATION),
      "the five rounds are for code defects; an environment failure costs none"
    ).toBe(true);
  });

  it("reports an undeliverable message to the Architect instead of retrying blindly", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        UNDELIVERABLE,
        ARCHITECT,
        /retry|retries|retrying|re-?send|again|blind/i
      ),
      "a sibling that died is not going to answer the second attempt either"
    ).toBe(true);
  });

  it("still counts the round when the message could not be delivered", () => {
    expect(
      statesJoinedRule(
        readProtocol(),
        UNDELIVERABLE,
        ROUND,
        SPENDS,
        /still|anyway|regardless|even (so|then|when)/i
      ),
      "an undeliverable message is a spent round, or the cap stops capping"
    ).toBe(true);
  });
});
