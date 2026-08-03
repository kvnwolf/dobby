import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommandContext, CommandResult } from "./command.ts";
import { requireWorkroot, runCapture } from "./runner.ts";

// `dobby adr new` — allocate the next ADR number and create the file, RACE-SAFE:
// the max scan covers the local `docs/adr/` AND `origin/HEAD:docs/adr` (a sibling
// worktree's ADR may not exist locally yet), and the create loop re-checks the
// directory for the NUMBER (any `NNNN-*.md`, whatever its slug) immediately before
// each write, with `O_EXCL` as the last-resort arbiter for the identical filename.
// A taken number retries at the next one. Consumers: wrap, address-review, and the
// `adr-format` reference.
//
// The command writes a SKELETON only — the H1 carrying the number, the optional
// Status line, and a placeholder paragraph. Body authorship stays with the
// architect: what moves into the CLI is the numbering (the part that is
// mechanical AND the part a model gets wrong under parallelism), never the
// decision record itself.
//
// node:* only + the shared runner (ADR-0008): vitest imports this under Node, and
// git is spawned through `runner.runCapture` with cwd pinned to the workroot.

// The ADR directory, relative to the workroot. ONE constant, used both as an fs
// path (joined onto the root) and as git's pathspec — which is why it is spelled
// with a forward slash rather than built with `join`.
const ADR_DIR = "docs/adr";

// The statuses `adr-format.md` teaches (`superseded by ADR-NNNN` is written by
// hand, not allocated). Omitting `--status` writes NO status line at all — the
// reference calls the Status frontmatter optional, and the repo's own ADRs carry
// none.
const STATUSES: readonly string[] = ["proposed", "accepted", "deprecated"];

// A filename's `NNNN-` prefix. Anything without it (`README.md`, `template.md`)
// is NOT an ADR and never influences the numbering.
const NUMBER_PREFIX = /^(\d{4})-/;

// Non-slug characters, collapsed into one separator, plus the leading/trailing
// separators to strip. Hoisted — `slugify` runs them per call.
const NON_SLUG = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

// The number is zero-padded to four digits everywhere: the filename, the H1, and
// the refusal messages.
const NUMBER_WIDTH = 4;

// How many numbers the retry walks before giving up. Reached only when that many
// CONSECUTIVE numbers are already taken above the scanned max, which is a
// corrupted tree, not a race — a bounded loop so it can never hang.
const MAX_ATTEMPTS = 50;

// The placeholder body, matching `adr-format.md`'s own template
// (`{1-3 sentences: the context, what was decided, and why.}`) — a stub the
// architect replaces, never an empty file that reads as "nothing was decided".
const PLACEHOLDER_BODY =
  "_Replace this paragraph_ with 1-3 sentences: the context that forced the decision, what was decided, and why the alternatives lost.";

export function runAdr(context: CommandContext): CommandResult {
  // An ACTION command: outside a git repo it fails hard (the numbering scan reads
  // git, and a `docs/adr` written into an ambient directory is a lost ADR).
  // `requireWorkroot` THROWS and run.ts's dispatch has no try/catch.
  let root: string;
  try {
    root = requireWorkroot(context.cwd);
  } catch (error) {
    return fail(messageOf(error));
  }
  // The title is a POSITIONAL (`dobby adr new "Single terminal host"`), joined
  // from every positional after the token so an unquoted title still works.
  const title = context.positionals.slice(1).join(" ").trim();
  if (title === "") {
    return fail(
      'adr new requires a title — `dobby adr new "<title>"` (it becomes the H1 and the filename slug)'
    );
  }
  const { status } = context.options;
  if (status !== undefined && !STATUSES.includes(String(status))) {
    return fail(
      `unknown status: ${String(status)} — expected one of: ${STATUSES.join(", ")}`
    );
  }
  const slug = slugify(title);
  if (slug === "") {
    return fail(
      `adr new cannot build a filename slug from the title: ${title} — use a title with letters or digits in it`
    );
  }
  return create(context, {
    root,
    slug,
    start: nextNumber(root),
    status: status === undefined ? undefined : String(status),
    title,
  });
}

// Everything the creation loop needs, decided before a single byte is written.
interface AdrRequest {
  root: string;
  slug: string;
  // The first number to try: max(local, origin/HEAD) + 1.
  start: number;
  status: string | undefined;
  title: string;
}

// Claim a NUMBER — not a filename — retrying at the next one when it is taken.
//
// THE RETRY LOOP IS THE POINT. The scan in `nextNumber` is a READ, and every
// number it yields is stale the instant it returns: a sibling worktree (the kit
// runs one session per goal, in PARALLEL) can land `0017-anything.md` between our
// scan and our write. So each attempt re-reads the directory and rejects the
// number if ANY file already carries the `NNNN-` prefix — the collision is on the
// number, and a sibling's ADR almost never shares our slug, so an exact-filename
// check alone would happily mint a second 0017. `O_EXCL` ('wx') then backs that
// re-read up as the last-resort arbiter for the window between it and the write,
// where the sibling picked our slug too: EEXIST means they won, and we take the
// next number instead of truncating their file. Neither guard alone is enough.
// The body is re-rendered per attempt because it CARRIES the number.
function create(context: CommandContext, request: AdrRequest): CommandResult {
  const dir = join(request.root, ADR_DIR);
  // Created LAZILY — only now, once the inputs are known good, so a refused
  // invocation never leaves an empty `docs/adr/` behind.
  mkdirSync(dir, { recursive: true });
  let number = request.start;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (isTaken(dir, number)) {
      number += 1;
      continue;
    }
    const path = join(dir, `${pad(number)}-${request.slug}.md`);
    try {
      writeFileSync(path, skeleton(number, request), { flag: "wx" });
      return created(context, { number, path, slug: request.slug });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") {
        return fail(`could not write ${path}: ${messageOf(error)}`);
      }
      number += 1;
    }
  }
  return fail(
    `could not allocate an ADR number: ${pad(request.start)}–${pad(number - 1)} are all taken in ${ADR_DIR}`
  );
}

// Is any file in `dir` already numbered `number` — whatever its slug? Read fresh
// per attempt, deliberately: a cached listing would reintroduce exactly the stale
// read this loop exists to defeat.
function isTaken(dir: string, number: number): boolean {
  const prefix = `${pad(number)}-`;
  return readdirSync(dir).some((name) => name.startsWith(prefix));
}

// The skeleton: the H1 carrying the allocated number, the optional Status line,
// and the placeholder paragraph — blocks separated by one blank line, single
// trailing newline.
function skeleton(number: number, request: AdrRequest): string {
  const blocks = [`# ${pad(number)}. ${request.title}`];
  if (request.status !== undefined) {
    blocks.push(`**Status:** ${request.status}`);
  }
  blocks.push(PLACEHOLDER_BODY);
  return `${blocks.join("\n\n")}\n`;
}

function created(
  context: CommandContext,
  payload: { number: number; path: string; slug: string }
): CommandResult {
  if (context.options.json === true) {
    return { exitCode: 0, json: payload };
  }
  return {
    exitCode: 0,
    text: `ADR ${pad(payload.number)} created at ${payload.path}\n`,
  };
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

// The next number to try: one past the highest ADR ANYWHERE this checkout can
// see. The local directory is only HALF the picture — the kit runs one worktree
// per goal, so a sibling session's ADR is pushed long before it lands here, and a
// local-only scan hands two goals the same number (Findings open question 6).
function nextNumber(root: string): number {
  return Math.max(scanLocal(root), scanOrigin(root)) + 1;
}

// The highest `NNNN-` in the local `docs/adr/`. An absent directory scores 0, so
// the first ADR in a repo is 0001.
function scanLocal(root: string): number {
  const dir = join(root, ADR_DIR);
  if (!existsSync(dir)) {
    return 0;
  }
  return highest(readdirSync(dir));
}

// The highest `NNNN-` in `origin/HEAD:docs/adr` — the ADRs a sibling worktree has
// already PUSHED but this checkout has never pulled. TOLERANT by design: no
// origin, no `origin/HEAD` ref, no git, or no `docs/adr` upstream all score 0
// (`git ls-tree` exits nonzero for the first three), because a repo without a
// remote must still be able to file an ADR.
function scanOrigin(root: string): number {
  const result = runCapture(
    "git",
    ["ls-tree", "-r", "origin/HEAD", "--name-only", "--", ADR_DIR],
    { root }
  );
  if (result.error !== undefined || result.status !== 0) {
    return 0;
  }
  return highest(
    result.stdout.split("\n").map((line) => basename(line.trim()))
  );
}

// The highest `NNNN-` prefix among `names`, or 0 when none carries one.
function highest(names: string[]): number {
  let max = 0;
  for (const name of names) {
    const match = NUMBER_PREFIX.exec(name);
    const value = match === null ? 0 : Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(value) && value > max) {
      max = value;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(number: number): string {
  return String(number).padStart(NUMBER_WIDTH, "0");
}

// The filename slug: the title lowercased, every run of non-alphanumerics
// collapsed to a single `-`, edges trimmed — the repo's own ADR naming
// (`0010-single-terminal-host.md` from "Single terminal host").
function slugify(title: string): string {
  return title.toLowerCase().replace(NON_SLUG, "-").replace(EDGE_DASHES, "");
}

// The errno of a thrown fs error, or "" — how the EEXIST retry distinguishes "the
// number is taken" from a real failure (a read-only tree, a bad path) that must
// surface instead of walking the numbers.
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

// The refusal shape: the message on STDERR with exit 1. Deliberately NOT mirrored
// into a `--json` payload — the success answer is the bare `{number, slug, path}`
// the spec pins, so there is no envelope to carry an error in.
function fail(error: string): CommandResult {
  return { error, exitCode: 1 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
