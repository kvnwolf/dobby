import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandContext, CommandResult } from "./command.ts";
import { requireWorkroot } from "./runner.ts";

// `dobby state init|set|append-worklog|lint` — the STATE.md section engine, and
// the CLI's first file-AUTHORING command (every other command reads, spawns or
// reports; this one owns a document). It exists because STATE.md was hand-written
// by seven different skills, which drifted seven different ways (`## Findings` vs
// `## Findings (interview)`, an Environment note with no heading, an ad-hoc
// creation path in spec, a by-hand gitignore step) — so the SHAPE moves out of
// LLM judgment and into one enforcer.
//
// The four subcommands, all resolving `<workroot>/STATE.md` (an ACTION command:
// outside a git repo it fails hard, never falling back to the ambient cwd):
//
//   - `init` writes the CANONICAL skeleton — the H1 plus the seven sections in
//     their fixed order, every body `_pending_` except Goal/Source when the flags
//     supply them — and ensures the `.gitignore` entry. The skeleton in
//     `plugin/skills/scope` Step 3 is its ONE source; the two must stay
//     byte-for-byte identical. It REFUSES an existing STATE.md: a live session's
//     work is on the line.
//   - `set <Section>` replaces ONE body from `--file` / `--stdin` and leaves
//     every other byte alone — INCLUDING sections the CLI has never heard of
//     (`## Environment`), which is what makes the engine safe to run against a
//     document later stages have extended. `## Goal` / `## Source` are
//     write-once (settable only while `_pending_`), `## Work log` is never
//     settable, `## Spec` is re-settable, and setting the same body twice is a
//     no-op on disk.
//   - `append-worklog --task <id>` APPENDS an entry (replacing the `_pending_`
//     marker on the first one) and DEMOTES every `## ` heading inside it to
//     `### ` — an entry carrying its own H2 would otherwise SPLIT the section and
//     orphan everything after it. An entry that leads with the section's own
//     `## Work log` heading has it replaced by the `### Task <id>` title; an
//     entry that leads with any OTHER heading keeps it (it is already a title);
//     anything else gets `### Task <id>` prepended.
//   - `lint` reports the structural drifts (H1, all seven sections present,
//     canonical order, no duplicates, gitignored) — the check a stage runs
//     before it trusts the document. Unknown legacy sections, including the
//     retired `## Execution profile`, remain tolerated and preserved.
//
// Document model: the file is split into lines ONCE and spliced. A section's body
// region runs from its heading to the next `## ` line (or EOF), so it always
// carries the blank separator that follows it — which is why a write is
// `[...body, ""]` for the last section as well as a middle one, and why the
// single trailing newline survives. Everything outside the spliced region is
// untouched, so unknown sections cannot be lost. `_pending_` is the
// replace-marker (Decision 14).
//
// node:* only (ADR-0008): vitest imports this under Node.

// The document this engine owns, at the workroot.
const STATE_FILE = "STATE.md";

// The body every unfilled section carries — the marker `set` treats as "still
// empty" (the write-once window) and `append-worklog` replaces on the first entry.
const PENDING = "_pending_";

// The append-only section: `set` refuses it, `append-worklog` owns it.
const WORK_LOG = "Work log";

// The two sections that may be written EXACTLY once — the goal a session was
// opened for cannot be quietly rewritten mid-flight (Decision 14).
const WRITE_ONCE: readonly string[] = ["Goal", "Source"];

// The H1 title when `init` is called without `--goal`: the skeleton's OWN
// placeholder, left unsubstituted rather than invented.
const GOAL_PLACEHOLDER = "<goal title>";

// The canonical section set, in the ONE order the whole kit reads. `lint`
// enforces presence + order against it; `set` accepts a name from it (or any
// heading already in the document).
const CANONICAL_SECTIONS: readonly string[] = [
  "Goal",
  "Source",
  "Exploration",
  "Findings (interview)",
  "Research",
  "Spec",
  WORK_LOG,
];

// One `## ` section located in the split document: its name (heading text without
// the marker) and the half-open body range `[start, end)`. `end` is the NEXT `## `
// line or the end of the document, so the range includes the blank separator that
// trails the body — replacing the range therefore rewrites the body AND keeps
// exactly one blank line before the next heading.
interface StateSection {
  end: number;
  name: string;
  start: number;
}

// The body input for `set` / `append-worklog`, read from `--file` or `--stdin`.
type BodyInput = { body: string; ok: true } | { error: string; ok: false };

export function runState(context: CommandContext): CommandResult {
  const [subcommand] = context.positionals;
  // The workroot resolve is the shared precondition of ALL four subcommands (the
  // action-command rule: no ambient-cwd fallback). `requireWorkroot` THROWS, and
  // run.ts's dispatch has no try/catch — a raw rejection out of `run()` would be
  // a crash rather than an exit code, so it is folded into the failure shape here.
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return fail(context, subcommand ?? "state", messageOf(error), null);
  }
  switch (subcommand) {
    case "init":
      return runInit(context, root);
    case "set":
      return runSet(context, root);
    case "append-worklog":
      return runAppendWorklog(context, root);
    case "lint":
      return runLint(context, root);
    default:
      // Unreachable: the registry in run.ts validates the token before dispatch.
      return fail(
        context,
        "state",
        `unknown subcommand: state ${subcommand ?? ""}`.trimEnd(),
        null
      );
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function runInit(context: CommandContext, root: string): CommandResult {
  const path = join(root, STATE_FILE);
  if (existsSync(path)) {
    return fail(
      context,
      "init",
      `${STATE_FILE} already exists at ${path} — refusing to overwrite a live work session (dispose of it with /dobby:wrap first)`,
      path
    );
  }
  const goal = stringOption(context, "goal");
  const source = stringOption(context, "source");
  writeFileSync(path, skeleton(goal, source));
  const added = ensureIgnored(root, STATE_FILE);
  const note = added ? " (added to .gitignore)" : "";
  return succeed(
    context,
    "init",
    path,
    `${STATE_FILE} created at ${path}${note}\n`
  );
}

// The CANONICAL skeleton, byte for byte: the H1 carrying the goal title, the seven
// sections in order, one blank line between sections, no blank line under a
// heading, `_pending_` everywhere except the two flag-filled bodies, and a single
// trailing newline. `plugin/skills/scope` Step 3 is the source this mirrors.
function skeleton(
  goal: string | undefined,
  source: string | undefined
): string {
  const filled: Record<string, string | undefined> = {
    Goal: goal,
    Source: source,
  };
  const blocks = CANONICAL_SECTIONS.map(
    (name) => `## ${name}\n${filled[name] ?? PENDING}`
  );
  return `# Work session: ${goal ?? GOAL_PLACEHOLDER}\n\n${blocks.join("\n\n")}\n`;
}

// Ensure `<root>/.gitignore` carries `entry`, appending it when it does not (the
// file is created when absent). Returns whether anything was written, so `init`
// can say so. Idempotent — a second `init` in a repo that already ignores STATE.md
// never duplicates the line. This is drift D6: the step used to live in the skill's
// prose, where "if it isn't already" was the model's job to check.
function ensureIgnored(root: string, entry: string): boolean {
  const path = join(root, ".gitignore");
  const current = readIfPresent(path);
  if (ignoresEntry(current, entry)) {
    return false;
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${separator}${entry}\n`);
  return true;
}

// Whether a `.gitignore` body already ignores `entry`. A TEXTUAL check on the
// workroot's own file (both the bare and the anchored `/NAME` form), deliberately
// NOT `git check-ignore`: this is the exact line `init` writes, and the contract
// the skills state is "STATE.md is in .gitignore" — an entry inherited from a
// parent repo or `.git/info/exclude` is out of scope.
function ignoresEntry(content: string, entry: string): boolean {
  return content.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed === entry || trimmed === `/${entry}`;
  });
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

function runSet(context: CommandContext, root: string): CommandResult {
  const path = join(root, STATE_FILE);
  const name = sectionArgument(context);
  if (name === undefined) {
    return fail(
      context,
      "set",
      `state set requires a section name — ${expected()}`,
      path
    );
  }
  if (name === WORK_LOG) {
    return fail(
      context,
      "set",
      `## ${WORK_LOG} is append-only — use \`dobby state append-worklog --task <id>\` instead of \`state set\``,
      path
    );
  }
  if (!existsSync(path)) {
    return fail(
      context,
      "set",
      `${STATE_FILE} not found at ${path} — run \`dobby state init\` first`,
      path
    );
  }
  const lines = readLines(path);
  const sections = parseSections(lines);
  const section = sections.find((candidate) => candidate.name === name);
  if (section === undefined) {
    return fail(context, "set", missingSectionMessage(name, sections), path);
  }
  if (WRITE_ONCE.includes(name) && bodyOf(lines, section) !== PENDING) {
    return fail(
      context,
      "set",
      `## ${name} is write-once and already carries a value — only a \`${PENDING}\` body can be set`,
      path
    );
  }
  const input = readBody(context);
  if (!input.ok) {
    return fail(context, "set", input.error, path);
  }
  writeFileSync(path, splice(lines, section, bodyLines(input.body)));
  return succeed(context, "set", path, `${STATE_FILE}: set ## ${name}\n`);
}

// The refusal for a name that resolves to no section. It distinguishes the two
// causes, because the fixes differ: a name outside the canonical set is a CALLER
// error (it lists the valid set), while a canonical name absent from THIS document
// is a document error (`lint` reports it).
function missingSectionMessage(name: string, sections: StateSection[]): string {
  if (CANONICAL_SECTIONS.includes(name)) {
    return `${STATE_FILE} has no \`## ${name}\` section — run \`dobby state lint\` and repair the document first`;
  }
  const present = sections.map((section) => section.name).join(", ");
  return `unknown section: ${name} — ${expected()}; present in ${STATE_FILE}: ${present}`;
}

// The canonical set, spelled out — every refusal that rejects a name says which
// names ARE valid (the `db:*` precedent).
function expected(): string {
  return `expected one of: ${CANONICAL_SECTIONS.join(", ")}`;
}

// ---------------------------------------------------------------------------
// append-worklog
// ---------------------------------------------------------------------------

function runAppendWorklog(
  context: CommandContext,
  root: string
): CommandResult {
  const path = join(root, STATE_FILE);
  const task = stringOption(context, "task");
  if (task === undefined) {
    return fail(
      context,
      "append-worklog",
      "state append-worklog requires --task <id> — the entry is titled `### Task <id>`",
      path
    );
  }
  if (!existsSync(path)) {
    return fail(
      context,
      "append-worklog",
      `${STATE_FILE} not found at ${path} — run \`dobby state init\` first`,
      path
    );
  }
  const lines = readLines(path);
  const section = parseSections(lines).find(
    (candidate) => candidate.name === WORK_LOG
  );
  if (section === undefined) {
    return fail(
      context,
      "append-worklog",
      `${STATE_FILE} has no \`## ${WORK_LOG}\` section — run \`dobby state lint\` and repair the document first`,
      path
    );
  }
  const input = readBody(context);
  if (!input.ok) {
    return fail(context, "append-worklog", input.error, path);
  }
  const current = bodyOf(lines, section);
  const entry = formatEntry(input.body, task);
  const next =
    current === PENDING || current === "" ? entry : `${current}\n\n${entry}`;
  writeFileSync(path, splice(lines, section, next.split("\n")));
  return succeed(
    context,
    "append-worklog",
    path,
    `${STATE_FILE}: appended Task ${task} to ## ${WORK_LOG}\n`
  );
}

// One work-log entry, made safe to live INSIDE `## Work log`:
//  1. every `## ` heading in it is demoted to `### ` — a nested H2 would split the
//     section and orphan every section after it (the D4 trap);
//  2. an entry that leads with the section's OWN heading (`## Work log`, pasted by
//     a worker that copied the whole block) has that heading REPLACED by the task
//     title — the reading Findings decision 14 states ("demotes/strips the entry's
//     `## Work log` H2 to `### Task <id>`");
//  3. an entry that leads with ANY OTHER heading keeps it: it is already the
//     entry's title, and prepending a second one would double-title it;
//  4. anything else is titled `### Task <id>`.
// Headings inside fenced code blocks are demoted too — an acceptable cost for a
// line-based rule that can never corrupt the document's structure.
function formatEntry(entry: string, task: string): string {
  const title = `### Task ${task}`;
  const lines = bodyLines(entry).map((line) =>
    line.startsWith("## ") ? `#${line}` : line
  );
  const [first] = lines;
  if (first === undefined) {
    return title;
  }
  if (!isHeading(first)) {
    return [title, ...lines].join("\n");
  }
  if (headingText(first) === WORK_LOG) {
    lines[0] = title;
  }
  return lines.join("\n");
}

// A markdown ATX heading of any level, and the marker to strip off one. Hoisted
// (never inline in a hot function) — the entry demotion runs them per line.
const HEADING_LINE = /^#{1,6}\s/;
const HEADING_MARKER = /^#{1,6}\s+/;

function isHeading(line: string): boolean {
  return HEADING_LINE.test(line);
}

function headingText(line: string): string {
  return line.replace(HEADING_MARKER, "").trim();
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

// `lint` judges the ONE document this engine owns — `<workroot>/STATE.md`. There
// is deliberately no `--file` target (the artifact-lint commands have one; this
// one does not): a second resolution path would give the gitignore rule nonsense
// semantics for an arbitrary file, and every caller means the work session's own
// document.
function runLint(context: CommandContext, root: string): CommandResult {
  const path = join(root, STATE_FILE);
  if (!existsSync(path)) {
    return fail(
      context,
      "lint",
      `${STATE_FILE} not found at ${path} — run \`dobby state init\` first`,
      path
    );
  }
  const violations = lintDocument(readLines(path), root);
  if (context.options.json === true) {
    return {
      exitCode: violations.length === 0 ? 0 : 1,
      json: { action: "lint", ok: violations.length === 0, path, violations },
    };
  }
  if (violations.length === 0) {
    return { exitCode: 0, text: "ok\n" };
  }
  return { exitCode: 1, text: `${violations.join("\n")}\n` };
}

// The structural verdict: one line per violation, empty when the document is
// clean. Structure ONLY — a `_pending_` body is a perfectly valid mid-session
// state, so lint never judges CONTENT (the wrap-stage disposal guard does).
function lintDocument(lines: string[], root: string): string[] {
  const violations: string[] = [];
  const [title] = lines.filter((line) => line.trim() !== "");
  if (title === undefined || !title.startsWith("# ")) {
    violations.push("missing the `# Work session: <goal>` title (H1)");
  }
  const names = parseSections(lines).map((section) => section.name);
  for (const name of CANONICAL_SECTIONS) {
    if (!names.includes(name)) {
      violations.push(`missing section: ## ${name}`);
    }
  }
  for (const [index, name] of names.entries()) {
    if (names.indexOf(name) !== index) {
      violations.push(`duplicate section: ## ${name}`);
    }
  }
  // Order is judged over the canonical names PRESENT (a missing one is already
  // its own violation) and DEDUPED (so does a duplicate) — the comparison then
  // reports only genuine reordering.
  const expectedOrder = CANONICAL_SECTIONS.filter((canonical) =>
    names.includes(canonical)
  );
  const actualOrder = [
    ...new Set(names.filter((found) => CANONICAL_SECTIONS.includes(found))),
  ];
  if (actualOrder.join(" | ") !== expectedOrder.join(" | ")) {
    violations.push(
      `sections out of canonical order: expected ${expectedOrder.join(", ")} — found ${actualOrder.join(", ")}`
    );
  }
  if (!ignoresEntry(readIfPresent(join(root, ".gitignore")), STATE_FILE)) {
    violations.push(
      `${STATE_FILE} is not in .gitignore — it is working memory, never a committed artifact`
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The document model — split once, splice the one region, join back.
// ---------------------------------------------------------------------------

// A file's contents, or "" when it does not exist — the tolerant read the
// `.gitignore` ensure/check share (an absent `.gitignore` ignores nothing).
function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// The document as lines. CRLF is normalized so a Windows-authored document parses
// (and is rewritten LF-only — the kit's documents are LF).
function readLines(path: string): string[] {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
}

// Every `## ` section in the document, in order. `### ` is NOT a section (its
// third character is `#`, not a space), which is precisely what the work-log
// demotion relies on.
function parseSections(lines: string[]): StateSection[] {
  const headings: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("## ")) {
      headings.push(index);
    }
  }
  return headings.map((heading, index) => ({
    end: headings[index + 1] ?? lines.length,
    name: (lines[heading] ?? "").slice(3).trim(),
    start: heading + 1,
  }));
}

// A section's body as text, without the blank separator its range carries.
function bodyOf(lines: string[], section: StateSection): string {
  return lines.slice(section.start, section.end).join("\n").trim();
}

/**
 * The BODY of ONE `## ` section of a STATE.md document — given the document's
 * CONTENT (not a path) — or null when it carries no such section. Read-only and
 * additive: the engine's own splitting rules (`## ` starts a section, `### `
 * never does, the body runs to the next `## ` or EOF), exported so the OTHER
 * commands that READ the document reuse them instead of growing a second, subtly
 * different markdown parser — which is exactly how the seven hand-written
 * variants drifted in the first place.
 *
 * @public — consumed by buildplan.ts (it projects `## Spec`'s task table).
 */
export function readSection(content: string, name: string): string | null {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const section = parseSections(lines).find(
    (candidate) => candidate.name === name
  );
  return section === undefined ? null : bodyOf(lines, section);
}

// Replace ONE section's body region with `body`, returning the whole document.
// The `""` terminator restores the blank line before the next heading — and, for
// the LAST section, the file's single trailing newline. Every line outside
// `[start, end)` is carried over verbatim, which is what preserves unknown
// sections byte for byte.
function splice(
  lines: string[],
  section: StateSection,
  body: string[]
): string {
  return [
    ...lines.slice(0, section.start),
    ...body,
    "",
    ...lines.slice(section.end),
  ].join("\n");
}

// An input body as the lines to write: CRLF normalized, and the leading/trailing
// blank lines dropped so a body piped with a trailing newline (every heredoc, every
// file) still leaves exactly ONE blank line before the next heading — which is what
// makes writing the same body twice a byte-for-byte no-op.
function bodyLines(input: string): string[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

// ---------------------------------------------------------------------------
// Input + result plumbing
// ---------------------------------------------------------------------------

// The body for `set` / `append-worklog`, from `--file <path>` (resolved against
// the CALLER's cwd, so a relative path means what the caller typed) or `--stdin`.
// Neither, an unreadable file, or a blank payload is a refusal — writing an empty
// body would silently hollow out a section.
function readBody(context: CommandContext): BodyInput {
  const file = stringOption(context, "file");
  if (file !== undefined) {
    const path = resolve(context.cwd, file);
    if (!existsSync(path)) {
      return { error: `--file not found: ${path}`, ok: false };
    }
    return nonEmpty(readFileSync(path, "utf8"), `--file is empty: ${path}`);
  }
  if (context.options.stdin === true) {
    return nonEmpty(
      context.stdin ?? "",
      "--stdin carried no input — pipe the body in (`… | dobby state set …`)"
    );
  }
  return {
    error: "no input source — pass --file <path> or --stdin",
    ok: false,
  };
}

function nonEmpty(body: string, error: string): BodyInput {
  return body.trim() === "" ? { error, ok: false } : { body, ok: true };
}

// The section name positional (`state set <Section>`), tolerating a `## `-prefixed
// form so a caller can paste the heading as they see it in the document.
function sectionArgument(context: CommandContext): string | undefined {
  const [, raw] = context.positionals;
  if (raw === undefined) {
    return;
  }
  return raw.replace(HEADING_MARKER, "").trim();
}

// A string option's value, or undefined when it was not passed (a boolean flag's
// `true` is not a value).
function stringOption(
  context: CommandContext,
  name: string
): string | undefined {
  const value = context.options[name];
  return typeof value === "string" ? value : undefined;
}

// The success shape: the `{ok, path, action}` payload under `--json` (the machine
// surface the skills read), the human line otherwise.
function succeed(
  context: CommandContext,
  action: string,
  path: string,
  text: string
): CommandResult {
  if (context.options.json === true) {
    return { exitCode: 0, json: { action, ok: true, path } };
  }
  return { exitCode: 0, text };
}

// The refusal shape: the message on STDERR always (that is where a caller looks
// for a refusal), plus the mirrored `ok:false` payload under `--json`. `path` is
// null when the failure happened before one could be resolved (outside a repo).
function fail(
  context: CommandContext,
  action: string,
  error: string,
  path: string | null
): CommandResult {
  if (context.options.json === true) {
    return { error, exitCode: 1, json: { action, error, ok: false, path } };
  }
  return { error, exitCode: 1 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
