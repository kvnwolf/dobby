import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { CommandContext, CommandResult } from "./command.ts";
import { requireWorkroot } from "./runner.ts";

// `dobby kb list|record` — ONE module for BOTH durable knowledge bases, which
// differ only in their directory and headings, so the KIND is a parameter
// (`--kind out-of-scope|learn-discarded`) rather than a second implementation:
// `docs/out-of-scope/` (triage's rejected concepts) and `docs/learn-discarded/`
// (learn's discarded frictions). One file per concept, created lazily (no empty
// dirs), `record` appending a bullet to the concept's file — so recording the
// same concept twice yields ONE file with two bullets.
//
// The CLI never DECIDES to record: triage/learn decide, the CLI executes the
// decided record. What moves out of LLM judgment here is the SHAPE (the skeleton,
// the headings, the one-file-per-concept dedup) and the SCAN both skills open
// with — nothing about whether a concept belongs in the KB.
//
// Both subcommands resolve their directory under the WORKROOT via
// `runner.requireWorkroot` — an ACTION command, so outside a git repo it fails
// hard rather than writing a KB into whatever directory the caller stood in.
//
// node:* only (ADR-0008): vitest imports this under Node.

// The two knowledge bases. THIS TABLE IS THE PARAMETERIZATION: two real adapters
// whose only differences are a directory and two heading strings — the
// "two adapters" test the one-module decision was taken against (Research R5).
// Anything that would need a third field here is a sign the KBs have genuinely
// diverged and the shared engine has stopped paying for itself.
interface KbKind {
  // The KB's directory, relative to the workroot. Created LAZILY by `record`.
  dir: string;
  // The heading whose `- ` bullets are the prior requests / occurrences.
  priorHeading: string;
  // The heading introducing the rationale body.
  whyHeading: string;
}

const KINDS: Readonly<Record<string, KbKind>> = {
  "learn-discarded": {
    dir: join("docs", "learn-discarded"),
    priorHeading: "## Prior occurrences",
    whyHeading: "## Why this was NOT turned into a skill edit",
  },
  "out-of-scope": {
    dir: join("docs", "out-of-scope"),
    priorHeading: "## Prior requests",
    whyHeading: "## Why this is out of scope",
  },
};

// One record as `kb list` reports it — the dedup scan every triage / learn
// session opens with, so it carries exactly what deciding "have we rejected this
// already?" needs and nothing more.
interface KbRecord {
  // The filename stem: the kebab-case concept name.
  concept: string;
  // The record's absolute path.
  path: string;
  // The `- ` bullets under the kind's prior-section, markers stripped.
  priorEntries: string[];
  // The first paragraph under the H1 — the one-line "what was rejected".
  statement: string;
  // The H1 text.
  title: string;
}

// The `--kind` resolution: the descriptor, or the refusal naming both KBs.
type KindResolution = { error: string; ok: false } | { kind: KbKind; ok: true };

export function runKb(context: CommandContext): CommandResult {
  const [subcommand] = context.positionals;
  // The workroot resolve is the shared precondition of both subcommands (the
  // action-command rule: no ambient-cwd fallback). `requireWorkroot` THROWS and
  // run.ts's dispatch has no try/catch, so it is folded into the failure shape.
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return fail(messageOf(error));
  }
  // `--kind` is the parameter the whole module turns on, so it is resolved BEFORE
  // anything reads an argument or touches the filesystem: a typo'd kind must never
  // read as "that KB is empty" (dedup would silently stop working and every
  // rejected concept would be re-litigated).
  const resolved = resolveKind(context, subcommand ?? "kb");
  if (!resolved.ok) {
    return fail(resolved.error);
  }
  if (subcommand === "record") {
    return record(context, root, resolved.kind);
  }
  // Unreachable for anything but `list`: the registry in run.ts validates the
  // token before dispatch.
  return list(context, root, resolved.kind);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function list(
  context: CommandContext,
  root: string,
  kind: KbKind
): CommandResult {
  const dir = join(root, kind.dir);
  // An ABSENT directory is the normal state of a lazily created KB — the empty
  // list, never an error. (The dirs are created by the first `record`, so a repo
  // that has rejected nothing yet has no `docs/out-of-scope/` at all.)
  const records = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => parseRecord(join(dir, name), kind))
    : [];
  if (context.options.json === true) {
    return { exitCode: 0, json: records };
  }
  if (records.length === 0) {
    return { exitCode: 0, text: "(no records)\n" };
  }
  const lines = records.map(
    (entry) =>
      `${entry.concept} — ${entry.title} (${entry.priorEntries.length} prior)`
  );
  return { exitCode: 0, text: `${lines.join("\n")}\n` };
}

// Read ONE record off disk. Deliberately TOLERANT: these files are written by
// hand as often as by `record` (the committed `docs/learn-discarded/*.md` lead
// with bold inline markers rather than the skeleton), so every field degrades to
// its empty value instead of failing the scan.
function parseRecord(path: string, kind: KbKind): KbRecord {
  const lines = readLines(path);
  const titleIndex = lines.findIndex((line) => line.startsWith("# "));
  return {
    concept: basename(path, ".md"),
    path,
    priorEntries: bulletsUnder(lines, kind.priorHeading),
    statement: firstParagraph(lines, titleIndex),
    title: titleIndex === -1 ? "" : (lines[titleIndex] ?? "").slice(2).trim(),
  };
}

// The first paragraph after the H1 — the record's one-line statement. A WRAPPED
// paragraph is joined into one line: the statement exists to be scanned in a
// dedup listing, where a single normalized line is the useful form (the skeleton
// `record` writes is one line by construction).
function firstParagraph(lines: string[], titleIndex: number): string {
  const paragraph: string[] = [];
  for (const line of lines.slice(titleIndex + 1)) {
    if (line.startsWith("#")) {
      break;
    }
    if (line.trim() === "") {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(line.trim());
  }
  return paragraph.join(" ");
}

// The `- ` bullets under `heading`, markers stripped, in document order. The
// section runs from the heading to the next `## ` line (or EOF) — the same body
// range the append writes into, so list and record agree on what the section is.
function bulletsUnder(lines: string[], heading: string): string[] {
  const start = headingIndex(lines, heading);
  if (start === -1) {
    return [];
  }
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1, sectionEnd(lines, start))) {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2).trim());
    }
  }
  return bullets;
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

function record(
  context: CommandContext,
  root: string,
  kind: KbKind
): CommandResult {
  const inputs = readRecordInputs(context);
  if (!inputs.ok) {
    return fail(inputs.error);
  }
  const path = join(root, kind.dir, `${inputs.concept}.md`);
  // The concept is the IDENTITY: an existing file is APPENDED to, never replaced
  // and never duplicated under a second filename — which is the KB's whole
  // purpose (a second rejection of the same concept is one more bullet, and the
  // rationale written the first time wins over the one this call carries).
  if (existsSync(path)) {
    writeFileSync(path, appendEntry(readLines(path), kind, inputs.entry));
    return recorded(context, path, false);
  }
  mkdirSync(join(root, kind.dir), { recursive: true });
  writeFileSync(path, skeleton(kind, inputs));
  return recorded(context, path, true);
}

// The canonical concept file, byte for byte: the H1, the one-line statement, the
// kind's rationale heading + the reason body, the kind's prior-section + the
// first bullet. The layout is the kit's OWN published format
// (`plugin/skills/triage/references/out-of-scope-kb.md`, "File format"), which is
// what the two KBs' committed files already look like.
function skeleton(kind: KbKind, inputs: RecordInputs): string {
  const lines = [
    `# ${inputs.title}`,
    "",
    inputs.statement,
    "",
    kind.whyHeading,
    "",
    ...inputs.reason,
    "",
    kind.priorHeading,
    "",
    `- ${inputs.entry}`,
  ];
  return `${lines.join("\n")}\n`;
}

// Append ONE bullet to the kind's prior-section, leaving every byte before that
// heading untouched (the title, statement and reason of the existing record are
// not this call's to rewrite). The bullet lands after the LAST content line of
// the section, so the blank separator before the next heading survives. A record
// missing the section entirely (hand-written, or a kind renamed) grows one at the
// end rather than losing the entry.
function appendEntry(lines: string[], kind: KbKind, entry: string): string {
  const bullet = `- ${entry}`;
  const start = headingIndex(lines, kind.priorHeading);
  if (start === -1) {
    const body = [...lines];
    while (body.length > 0 && (body.at(-1) ?? "").trim() === "") {
      body.pop();
    }
    return `${[...body, "", kind.priorHeading, "", bullet].join("\n")}\n`;
  }
  let insert = sectionEnd(lines, start);
  while (insert > start + 1 && (lines[insert - 1] ?? "").trim() === "") {
    insert -= 1;
  }
  return [...lines.slice(0, insert), bullet, ...lines.slice(insert)].join("\n");
}

// The `{path, created, appended}` answer both branches share. `created` and
// `appended` are the two halves of one verdict — a NEW file is created (and the
// entry is part of the skeleton, so nothing was "appended"), an EXISTING one is
// appended to.
function recorded(
  context: CommandContext,
  path: string,
  created: boolean
): CommandResult {
  if (context.options.json === true) {
    return { exitCode: 0, json: { appended: !created, created, path } };
  }
  return {
    exitCode: 0,
    text: `${path}: ${created ? "created" : "appended"}\n`,
  };
}

// ---------------------------------------------------------------------------
// Input plumbing
// ---------------------------------------------------------------------------

// Everything `record` needs, already validated and split.
interface RecordInputs {
  concept: string;
  entry: string;
  ok: true;
  // The rationale body: every line of `--reason-file` AFTER the statement.
  reason: string[];
  // The one-line statement: the FIRST line of `--reason-file`.
  statement: string;
  title: string;
}

type RecordInput = { error: string; ok: false } | RecordInputs;

function readRecordInputs(context: CommandContext): RecordInput {
  const missing = REQUIRED.filter(
    (name) => stringOption(context, name) === undefined
  );
  if (missing.length > 0) {
    return {
      error: `kb record requires ${missing.map((name) => `--${name}`).join(", ")}`,
      ok: false,
    };
  }
  const concept = conceptSlug(stringOption(context, "concept") ?? "");
  if (concept === "") {
    return {
      error:
        "--concept must be a kebab-case concept name (it becomes the record's filename)",
      ok: false,
    };
  }
  const reason = readReasonFile(context);
  if (!reason.ok) {
    return reason;
  }
  return {
    concept,
    entry: stringOption(context, "entry") ?? "",
    ok: true,
    reason: reason.reason,
    statement: reason.statement,
    title: stringOption(context, "title") ?? "",
  };
}

// The flags `record` cannot proceed without (`--kind` is already resolved, for
// BOTH subcommands, before this runs). The skill does NOT know whether the
// concept already exists, so it always carries a title and a reason — an existing
// record simply wins over them.
const REQUIRED: readonly string[] = [
  "concept",
  "title",
  "reason-file",
  "entry",
];

// The rationale document `/dobby:triage` (or `/dobby:learn`) hands the CLI, split
// the ONE way that never duplicates text: its FIRST line is the one-line
// statement that sits under the H1, everything after it is the substantive
// reason. A file carrying only a statement is REFUSED — a record whose rationale
// section is empty is the failure this guard prevents.
function readReasonFile(
  context: CommandContext
):
  | { error: string; ok: false }
  | { ok: true; reason: string[]; statement: string } {
  const file = stringOption(context, "reason-file") ?? "";
  const path = resolve(context.cwd, file);
  if (!existsSync(path)) {
    return { error: `--reason-file not found: ${path}`, ok: false };
  }
  const lines = trimBlankEdges(readLines(path));
  const [statement, ...rest] = lines;
  const reason = trimBlankEdges(rest);
  if (statement === undefined || reason.length === 0) {
    return {
      error: `--reason-file must carry a one-line statement, a blank line, then the reason: ${path}`,
      ok: false,
    };
  }
  return { ok: true, reason, statement: statement.trim() };
}

// The `--kind` descriptor, or a refusal that NAMES both knowledge bases (the
// `db:*` precedent: every refusal that rejects a name says which names are valid).
function resolveKind(context: CommandContext, label: string): KindResolution {
  const requested = stringOption(context, "kind");
  if (requested === undefined) {
    return { error: `kb ${label} requires --kind — ${expected()}`, ok: false };
  }
  const kind = Object.hasOwn(KINDS, requested) ? KINDS[requested] : undefined;
  if (kind === undefined) {
    return {
      error: `unknown knowledge base: ${requested} — ${expected()}`,
      ok: false,
    };
  }
  return { kind, ok: true };
}

function expected(): string {
  return `expected one of: ${Object.keys(KINDS).sort().join(", ")}`;
}

// ---------------------------------------------------------------------------
// Document + option helpers
// ---------------------------------------------------------------------------

// Non-slug characters, collapsed into one separator, plus the leading/trailing
// separators to strip. Hoisted — `conceptSlug` runs them per call.
const NON_SLUG = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

// The concept as a filename stem. `--concept` is documented as kebab-case, so for
// a well-formed caller this is the identity; it is applied anyway because the
// value becomes a PATH — normalizing it is also what makes `../../etc/passwd`
// impossible, and what keeps two spellings of one concept from becoming two files.
function conceptSlug(concept: string): string {
  return concept.toLowerCase().replace(NON_SLUG, "-").replace(EDGE_DASHES, "");
}

// A document as lines. CRLF is normalized so a Windows-authored record parses
// (and is rewritten LF-only — the kit's documents are LF).
function readLines(path: string): string[] {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
}

// The index of a `## ` heading line, or -1. Compared on the TRIMMED line so a
// record with trailing whitespace on the heading still matches.
function headingIndex(lines: string[], heading: string): number {
  return lines.findIndex((line) => line.trim() === heading);
}

// Where the section opened at `start` ends: the next `## ` line, or EOF.
function sectionEnd(lines: string[], start: number): number {
  const next = lines
    .slice(start + 1)
    .findIndex((line) => line.startsWith("## "));
  return next === -1 ? lines.length : start + 1 + next;
}

// Lines with the leading and trailing blank ones dropped — what turns a file's
// trailing newline into "no trailing blank line" for both the reason split and
// the section append.
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") {
    start += 1;
  }
  while (end > start && (lines[end - 1] ?? "").trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

// A string option's value, or undefined when it was not passed.
function stringOption(
  context: CommandContext,
  name: string
): string | undefined {
  const value = context.options[name];
  return typeof value === "string" ? value : undefined;
}

// The refusal shape: the message on STDERR with exit 1. Deliberately NOT mirrored
// into a `--json` payload — `list` answers a bare ARRAY and `record` a bare
// `{path, created, appended}` (the spec's shapes), so there is no envelope to
// carry an error in.
function fail(error: string): CommandResult {
  return { error, exitCode: 1 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
