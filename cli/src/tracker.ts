import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CommandContext,
  CommandOptions,
  CommandResult,
} from "./command.ts";
import { type DobbyConfig, loadConfig } from "./config.ts";
import { linkedWorktreeMain } from "./lifecycle.ts";
import { type RunResult, requireWorkroot, runCapture } from "./runner.ts";

// `dobby tracker info|search|create|close`, `dobby claim`, `dobby goal parse` —
// the session's issue-tracker surface, backend-agnostic by CONFIG
// (`dobby.config.json#tracker`, absent → `github`), mechanizing
// `plugin/skills/backlog/references/trackers.md` verbatim:
//
//   - `tracker info` — which backend this repo talks to, and whether it can be
//     reached (the answer every other verb branches on).
//   - `tracker search <concept>` — is this already tracked?
//   - `tracker create --title --body-file --label` — open a role-labelled item.
//   - `tracker close <id> --rejected` — reject a goal without building it.
//   - `claim <id>` — the backlog → work handshake.
//   - `goal parse <arg>` — resolve a goal reference (an issue key, a URL, or free
//     prompt text) into `{source, id, url, slug, …}` plus the per-backend
//     `lifecycleLink`, emitted HERE so commit/scope never re-derive it.
//
// THREE properties this module exists to hold:
//
//  1. NO SHELL, EVER. Every `gh` call goes out as an ARGV ARRAY through
//     `runner.runCapture` (cwd pinned to the workroot). User-derived text — a
//     search concept, an issue title — lands as ONE argv element whatever bytes
//     it holds, so the single-quote-binding / heredoc-escaping prose the skills
//     used to carry is not "simplified" but RETIRED: there is no shell to inject
//     into. The body never even reaches argv — it is handed over as a FILE.
//  2. LINEAR IS NEVER SPAWNED. A `linear` backend returns a DELEGATION DESCRIPTOR
//     (`{delegate:"mcp", op, …}`) that the SKILL executes through whichever Linear
//     MCP tool it resolves via ToolSearch. Naming a tool here would break the
//     tool-name agnosticism trackers.md mandates, so the CLI names the OPERATION
//     and stops.
//  3. DEGRADATION IS REPORTED, NEVER PERFORMED. D8 (gh unavailable → fall back to
//     the local recipe) is a decision the SESSION takes: `tracker info` reports
//     `degradedTo:"local"` and `goal parse` hard-stops on an unreadable issue
//     goal, but `search`/`create`/`close`/`claim` never silently re-route a
//     github call into a `BACKLOG.md` write nobody asked for. One `gh auth
//     status` probe per session, at `info`, is the whole degradation surface.
//
// `node:*` + the shared runner only (ADR-0008): vitest imports this under Node
// while Bun runs it in production.

// ---------------------------------------------------------------------------
// Backend resolution — the one config read every verb starts from
// ---------------------------------------------------------------------------

// Derived from the config schema so an added backend can never drift out of
// this module's switches (tsc flags the missing arm).
type Backend = NonNullable<DobbyConfig["tracker"]>["type"];

interface Tracker {
  // Linear's non-inferable team KEY (`VON`, never a UUID); null everywhere else.
  team: string | null;
  type: Backend;
}

// Everything a verb needs from one invocation, resolved ONCE: the CALLER's
// directory (what a path FLAG is relative to), the workroot (what every spawn
// and every storage file is pinned to — the two differ whenever dobby is run
// from a subdirectory), the configured backend, and the invocation's flags.
interface Session {
  cwd: string;
  options: CommandOptions;
  root: string;
  tracker: Tracker;
}

// Resolve the workroot + the backend, or THROW — these are ACTION commands (they
// open issues and write files), so outside a git repo they fail hard rather than
// acting relative to an ambient cwd. A config that exists but is MALFORMED throws
// too: its `tracker` key is exactly what this module dispatches on, so guessing
// `github` from a broken config would act against the wrong tracker.
function resolveSession(context: CommandContext): Session {
  const root = requireWorkroot(context.cwd);
  const load = loadConfig(root);
  if (load?.ok === false) {
    throw new Error(load.error);
  }
  const configured = load?.ok === true ? load.config.tracker : undefined;
  return {
    cwd: context.cwd,
    options: context.options,
    root,
    // The zero-config default: no `tracker` key at all means github — the repo
    // `gh` is authenticated against (trackers.md, "Detecting the backend").
    tracker:
      configured === undefined
        ? { team: null, type: "github" }
        : { team: configured.team ?? null, type: configured.type },
  };
}

// ---------------------------------------------------------------------------
// Shared vocabulary — the literals trackers.md fixes for every backend
// ---------------------------------------------------------------------------

// The label a claim adds. Same string on both halves of the github claim (the
// `label create` and the `issue edit`), so they can never drift apart.
const STATUS_LABEL = "status:in-progress";

// gh's own enum value for "closed as rejected" — ONE argv element, space and all.
const CLOSE_REASON = "not planned";

// The two Linear workflow states the kit ever names (see `runClaim`).
const LINEAR_CANCELED = "Canceled";
const LINEAR_IN_PROGRESS = "In Progress";

// The delegation target every Linear descriptor carries — a CHANNEL, not a tool.
const DELEGATE_MCP = "mcp";

// The fields a github search projects: exactly what a skill needs to dedup and
// show a match, nothing more (a full issue body is not a search result).
const SEARCH_FIELDS = "number,title,url,state,labels";

// The local backend's whole storage: a checklist at the repo root, one item per
// line, `- [ ] <title> — <body> (<role>)`.
const BACKLOG_FILE = "BACKLOG.md";
const OPEN_MARK = "- [ ] ";
const DONE_MARK = "- [x] ";
// The em dash (with its surrounding spaces) trackers.md mandates between an
// item's title and its body.
const TITLE_SEPARATOR = " — ";

// ---------------------------------------------------------------------------
// gh plumbing — argv arrays through the workroot-pinned runner, failures as DATA
// ---------------------------------------------------------------------------

function gh(args: string[], root: string): RunResult {
  return runCapture("gh", args, { root });
}

function ghFailed(result: RunResult): boolean {
  return result.error !== undefined || result.status !== 0;
}

// gh's own words when it has them (its stderr is written for humans), else the
// spawn error, else the bare exit status — so a failure is never anonymous.
function ghError(action: string, result: RunResult): string {
  const stderr = result.stderr.trim();
  if (stderr !== "") {
    return `${action}: ${stderr}`;
  }
  if (result.error !== undefined) {
    return `${action}: ${result.error.message}`;
  }
  return `${action}: gh exited ${String(result.status)}`;
}

// Whether `gh` can actually answer — installed, on PATH, AND authenticated.
// `gh auth status` is the probe trackers.md itself names (D8); a missing binary
// comes back as a spawn error, which folds into the same "unavailable" verdict.
function ghAvailable(root: string): boolean {
  return !ghFailed(gh(["auth", "status"], root));
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The BACKLOG.md model — the local backend's only storage
// ---------------------------------------------------------------------------

// One parsed checklist line. `index` is its position in the file's line array,
// which is what lets a close rewrite exactly that line and nothing else.
interface BacklogItem {
  body: string;
  done: boolean;
  index: number;
  label: string | null;
  line: string;
  title: string;
}

// The trailing `(<role>)` of a checklist line.
const TRAILING_LABEL = /\s*\(([^()]+)\)\s*$/;

function backlogPath(root: string): string {
  return join(root, BACKLOG_FILE);
}

// The backlog's raw lines, or null when the file does not exist yet (an absent
// backlog is "nothing tracked", never an error — it is created lazily).
function readBacklogLines(root: string): string[] | null {
  const path = backlogPath(root);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8").split("\n");
}

// Parse one line, or null when it is not a checklist item (a heading, a blank,
// prose). The label is stripped from the END first, so a title carrying no body
// (`- [ ] Ship it (chore)`) still reads as a title plus a role.
function parseBacklogLine(line: string, index: number): BacklogItem | null {
  const done = line.startsWith(DONE_MARK);
  if (!(done || line.startsWith(OPEN_MARK))) {
    return null;
  }
  const rest = line.slice(OPEN_MARK.length);
  const labelMatch = TRAILING_LABEL.exec(rest);
  const withoutLabel =
    labelMatch === null ? rest : rest.slice(0, labelMatch.index);
  const separator = withoutLabel.indexOf(TITLE_SEPARATOR);
  return {
    body:
      separator === -1
        ? ""
        : withoutLabel.slice(separator + TITLE_SEPARATOR.length).trim(),
    done,
    index,
    label: labelMatch?.[1]?.trim() ?? null,
    line,
    title: (separator === -1
      ? withoutLabel
      : withoutLabel.slice(0, separator)
    ).trim(),
  };
}

function parseBacklog(lines: string[]): BacklogItem[] {
  const items: BacklogItem[] = [];
  for (const [index, line] of lines.entries()) {
    const item = parseBacklogLine(line, index);
    if (item !== null) {
      items.push(item);
    }
  }
  return items;
}

// A local item projected onto the SAME shape a github search answers with
// (`number,title,url,state,labels`), so a skill reads one result shape whichever
// backend answered. `number`/`url` are null because local items have neither —
// that absence IS the local backend, not a lookup that failed.
interface LocalIssue {
  body: string;
  labels: Array<{ name: string }>;
  number: null;
  state: string;
  title: string;
  url: null;
}

function toLocalIssue(item: BacklogItem): LocalIssue {
  return {
    body: item.body,
    labels: item.label === null ? [] : [{ name: item.label }],
    number: null,
    state: item.done ? "CLOSED" : "OPEN",
    title: item.title,
    url: null,
  };
}

// Append one item, creating the file lazily. A backlog whose last line lacks its
// newline gets one first, so an append can never glue two items together.
function appendBacklogLine(root: string, line: string): void {
  const path = backlogPath(root);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const prefix =
    existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  writeFileSync(path, `${prefix}${line}\n`);
}

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

// The hard-error result for a thrown precondition (outside a git repo, or a
// malformed config).
function hardError(error: unknown): CommandResult {
  return {
    error: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  };
}

// A caller error: exit 1, the message on stderr, and NOTHING on stdout — so no
// consumer can mistake silence for an empty answer.
function rejected(message: string): CommandResult {
  return { error: message, exitCode: 1 };
}

// The `--json` contract: the payload is the ONLY stdout when `--json` is passed,
// otherwise the human `key: value` fallback (`run.ts` prints it verbatim). Every
// call site names its payload TYPE explicitly (`rendered<GoalParse>({…})`), so a
// field that drifts out of a documented shape fails tsc at the literal.
function rendered<T extends object>(
  payload: T,
  options: CommandOptions
): CommandResult {
  return options.json === true
    ? { exitCode: 0, json: payload }
    : { exitCode: 0, text: formatText(payload) };
}

// The human fallback, GENERIC over every payload in this module: one
// `key: value` line per field (the `env` render's shape), an array as one
// indented line per element. The machine path is `--json`; this exists so a
// human running the command bare still sees the answer.
function formatText(payload: object): string {
  const lines: string[] = [];
  // `object` carries no index signature, so the entries are read through one
  // widening cast — the alternative (`Record<string, unknown>` as the parameter)
  // would reject every INTERFACE payload at the call site.
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>
  )) {
    if (Array.isArray(value)) {
      lines.push(`${key}:${value.length === 0 ? " -" : ""}`);
      for (const item of value) {
        lines.push(`  ${scalarText(item)}`);
      }
    } else {
      lines.push(`${key}: ${scalarText(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// A string option's value, or null when absent (a bare boolean flag counts as
// absent — `--title` without a value cannot title anything).
function stringOption(value: boolean | string | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// A free-text operand: every remaining positional, rejoined. An unquoted goal
// (`dobby goal parse add csv export`) is split by the SHELL before dobby ever
// sees it, so rejoining is what makes the quoted and unquoted forms agree; a
// quoted operand is one positional and comes back byte-identical.
function textOperand(positionals: string[], from: number): string {
  return positionals.slice(from).join(" ").trim();
}

// An id operand (an issue number, a Linear key, a local item title): the ONE
// positional at `from`, never a rejoin — an id is a single token.
function idOperand(positionals: string[], from: number): string {
  return positionals[from]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// `dobby tracker info` — which backend, and can it be reached
// ---------------------------------------------------------------------------

interface TrackerInfo {
  // github: gh's verdict. local: always true. linear: NULL — reachability is
  // MCP-side, and the CLI never talks to the MCP, so "unknown" is the honest
  // answer (the skill discovers it by calling the tool).
  available: boolean | null;
  degradedTo: "local" | null;
  reason: string | null;
  team: string | null;
  type: Backend;
}

function trackerInfo(session: Session): CommandResult {
  const { team, type } = session.tracker;
  if (type !== "github") {
    return rendered<TrackerInfo>(
      {
        available: type === "local" ? true : null,
        degradedTo: null,
        reason: null,
        team,
        type,
      },
      session.options
    );
  }

  // D8: the ONE probe. An unauthenticated / absent gh does not fail the
  // command — it REPORTS the fallback the session should use instead.
  const available = ghAvailable(session.root);
  return rendered<TrackerInfo>(
    {
      available,
      degradedTo: available ? null : "local",
      reason: available
        ? null
        : "`gh auth status` failed — gh is not installed, not on PATH, or not authenticated; use the local BACKLOG.md recipe and say so (D8)",
      team,
      type,
    },
    session.options
  );
}

// ---------------------------------------------------------------------------
// `dobby tracker search <concept>` — is this already tracked?
// ---------------------------------------------------------------------------

interface SearchResult {
  backend: Backend;
  concept: string;
  results: unknown[];
}

interface SearchDelegation {
  args: { query: string; team: string | null };
  delegate: string;
  op: string;
}

function trackerSearch(session: Session, concept: string): CommandResult {
  if (concept === "") {
    return rejected(
      'tracker search requires a concept — the text to look for among the open issues (e.g. `dobby tracker search "csv export" --json`)'
    );
  }

  if (session.tracker.type === "linear") {
    return rendered<SearchDelegation>(
      {
        args: { query: concept, team: session.tracker.team },
        delegate: DELEGATE_MCP,
        op: "search",
      },
      session.options
    );
  }

  if (session.tracker.type === "local") {
    const lines = readBacklogLines(session.root) ?? [];
    const needle = concept.toLowerCase();
    // Only OPEN items, mirroring github's `--state open`: a search answers "is
    // this already tracked", and a closed item is not.
    const results = parseBacklog(lines)
      .filter((item) => !item.done && item.line.toLowerCase().includes(needle))
      .map(toLocalIssue);
    return rendered<SearchResult>(
      { backend: "local", concept, results },
      session.options
    );
  }

  // THE argv-array payoff: `concept` is user-derived text and lands here as ONE
  // element of the vector handed to execve — quotes, `$(…)`, backticks, `&&`, a
  // trailing `#` and newlines included. No shell parses it, so there is nothing
  // to escape and nothing to bind: the entire shell-hardening class the old
  // prose defended against (single-quote binding, `'\''` escaping) dies here.
  const result = gh(
    [
      "issue",
      "list",
      "--state",
      "open",
      "--search",
      concept,
      "--json",
      SEARCH_FIELDS,
    ],
    session.root
  );
  if (ghFailed(result)) {
    return rejected(ghError("gh issue list", result));
  }
  return rendered<SearchResult>(
    {
      backend: "github",
      concept,
      // Passed THROUGH exactly as gh reported it — the CLI never re-shapes or
      // re-ranks what the tracker answered.
      results: parseJson<unknown[]>(result.stdout) ?? [],
    },
    session.options
  );
}

// ---------------------------------------------------------------------------
// `dobby tracker create --title <t> --body-file <f> --label <role>`
// ---------------------------------------------------------------------------

interface CreateResult {
  number: number | null;
  url: string | null;
}

interface CreateDelegation {
  args: {
    body: string;
    label: string | null;
    team: string | null;
    title: string;
  };
  delegate: string;
  op: string;
}

// The issue URL gh prints on stdout after creating, and the number inside it —
// `gh issue create` has no `--json` mode, so its stdout is the only source.
const ISSUE_URL_LINE = /^https?:\/\/\S+$/;
const ISSUE_NUMBER = /\/issues\/(\d+)/;

function trackerCreate(session: Session): CommandResult {
  const title = stringOption(session.options.title);
  if (title === null) {
    return rejected(
      "tracker create requires --title <title> — the one-line issue title (the body is passed separately with --body-file)"
    );
  }

  const bodyFile = stringOption(session.options["body-file"]);
  if (bodyFile === null) {
    return rejected(
      "tracker create requires --body-file <path> — the issue body is handed over as a FILE, never through argv: write it first, then point --body-file at it"
    );
  }
  // Resolved against the CALLER's cwd — the CLI's house convention for every
  // path flag (`ship --message-file`, `kb record --reason-file`, …) — and
  // resolved ONCE: this absolute path is both what we read and what gh is
  // handed below. The workroot would be the wrong base (every spawn is pinned
  // there, so a relative `--body-file` would silently change meaning the moment
  // dobby is run from a subdirectory), and passing the raw relative path on to
  // gh would re-open the same gap from the other side.
  const bodyPath = resolve(session.cwd, bodyFile);
  let body: string;
  try {
    body = readFileSync(bodyPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return rejected(
      `tracker create --body-file ${bodyPath}: could not read the body file — ${detail}`
    );
  }

  // The four role labels (`bug`/`feature`/`chore`/`docs`) are the same on every
  // backend. Optional: an item may legitimately be opened unlabelled, and a
  // missing role must not invent one.
  const label = stringOption(session.options.label);

  if (session.tracker.type === "linear") {
    return rendered<CreateDelegation>(
      {
        args: { body, label, team: session.tracker.team, title },
        delegate: DELEGATE_MCP,
        op: "create",
      },
      session.options
    );
  }

  if (session.tracker.type === "local") {
    const firstLine = body.split("\n")[0]?.trim() ?? "";
    const role = label === null ? "" : ` (${label})`;
    appendBacklogLine(
      session.root,
      `${OPEN_MARK}${title}${TITLE_SEPARATOR}${firstLine}${role}`
    );
    return rendered<CreateResult>({ number: null, url: null }, session.options);
  }

  if (label !== null) {
    // The label must EXIST before the issue references it. `gh label create`
    // is NOT idempotent — it exits nonzero ("Name has already been taken") when
    // the label is there — and that nonzero is exactly the success case we are
    // aiming for, so it is ignored on purpose. NOT `--force`: force would
    // OVERWRITE an existing label's colour and description, silently undoing a
    // colour the repo's maintainers chose.
    gh(["label", "create", label], session.root);
  }

  const args = ["issue", "create", "--title", title];
  if (label !== null) {
    args.push("--label", label);
  }
  // The body goes OUT OF BAND: gh reads the file itself, so an arbitrary body
  // (backticks, `$(…)`, a line that reads `EOF`) never becomes an argument, let
  // alone shell input. The title is an argv element, which is already verbatim.
  // gh gets the ABSOLUTE path: its cwd is the workroot, not the caller's, so a
  // relative path would resolve somewhere else than the file we just read.
  args.push("--body-file", bodyPath);

  const result = gh(args, session.root);
  if (ghFailed(result)) {
    return rejected(ghError("gh issue create", result));
  }
  const url = issueUrl(result.stdout);
  return rendered<CreateResult>(
    { number: url === null ? null : issueNumber(url), url },
    session.options
  );
}

// The created issue's URL: the LAST bare-URL line gh printed (it may narrate
// "Creating issue in owner/repo" first). Null when gh printed none — the issue
// still exists, so that is a null field, never a failure.
function issueUrl(stdout: string): string | null {
  const urls = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => ISSUE_URL_LINE.test(line));
  return urls.at(-1) ?? null;
}

// The issue NUMBER out of that URL, as a number (matching gh's own `--json
// number` type).
function issueNumber(url: string): number | null {
  const digits = ISSUE_NUMBER.exec(url)?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 10);
}

// ---------------------------------------------------------------------------
// `dobby tracker close <id> --rejected` — reject a goal without building it
// ---------------------------------------------------------------------------

interface CloseResult {
  closed: boolean;
  id: string;
  reason: string;
}

interface CloseDelegation {
  delegate: string;
  id: string;
  op: string;
  state: string;
  team: string | null;
}

function trackerClose(session: Session, id: string): CommandResult {
  if (id === "") {
    return rejected(
      "tracker close requires an issue id — the github issue number (`42`), the linear key (`VON-123`), or the local BACKLOG.md item title"
    );
  }
  // `--rejected` is REQUIRED, not decorative: closing as rejected is the only
  // close the kit performs (a COMPLETED goal is closed by its merged PR's
  // lifecycle link, never by this command). Accepting the flag and ignoring it
  // would be the silently-dropped-flag footgun the registry exists to close.
  if (session.options.rejected !== true) {
    return rejected(
      'tracker close takes --rejected — this command only ever closes an issue AS REJECTED (github `--reason "not planned"`, linear Canceled, local: the line marked done); a completed goal is closed by its merged PR'
    );
  }

  if (session.tracker.type === "linear") {
    return rendered<CloseDelegation>(
      {
        delegate: DELEGATE_MCP,
        id,
        op: "setState",
        state: LINEAR_CANCELED,
        team: session.tracker.team,
      },
      session.options
    );
  }

  if (session.tracker.type === "local") {
    return closeLocal(session, id);
  }

  const result = gh(
    ["issue", "close", id, "--reason", CLOSE_REASON],
    session.root
  );
  if (ghFailed(result)) {
    return rejected(ghError("gh issue close", result));
  }
  return rendered<CloseResult>(
    { closed: true, id, reason: CLOSE_REASON },
    session.options
  );
}

// Mark the matching backlog line done. Local items have no id, so the match is
// against the TITLE (exact first, then a contains fallback), and the rewrite
// touches ONLY the checkbox — every other byte of the line, and every other
// line, is carried over verbatim.
function closeLocal(session: Session, id: string): CommandResult {
  const lines = readBacklogLines(session.root);
  if (lines === null) {
    return rejected(
      `tracker close: there is no ${BACKLOG_FILE} in this repository — nothing to close`
    );
  }
  const open = parseBacklog(lines).filter((item) => !item.done);
  const needle = id.toLowerCase();
  const match =
    open.find((item) => item.title.toLowerCase() === needle) ??
    open.find((item) => item.title.toLowerCase().includes(needle));
  if (match === undefined) {
    return rejected(
      `tracker close: no open ${BACKLOG_FILE} item matches "${id}" — a local item is identified by its title`
    );
  }
  lines[match.index] = `${DONE_MARK}${match.line.slice(OPEN_MARK.length)}`;
  writeFileSync(backlogPath(session.root), lines.join("\n"));
  return rendered<CloseResult>(
    { closed: true, id, reason: `marked done in ${BACKLOG_FILE}` },
    session.options
  );
}

// ---------------------------------------------------------------------------
// `dobby claim <id>` — the backlog → work handshake
// ---------------------------------------------------------------------------

interface ClaimResult {
  assignee: string;
  claimed: boolean;
  id: string;
  label: string;
}

interface ClaimDelegation {
  assignee: string;
  delegate: string;
  id: string;
  op: string;
  state: string;
  team: string | null;
}

interface ClaimSkipped {
  claimed: boolean;
  id: string;
  reason: string;
}

export function runClaim(context: CommandContext): CommandResult {
  let session: Session;
  try {
    session = resolveSession(context);
  } catch (error) {
    return hardError(error);
  }

  // `claim` has no subcommand token, so the id is the FIRST positional.
  const id = idOperand(context.positionals, 0);
  if (id === "") {
    return rejected(
      "claim requires an issue id — the github issue number (`42`), the linear key (`VON-123`), or the local BACKLOG.md item title"
    );
  }

  if (session.tracker.type === "linear") {
    // The kit's ONLY Linear state WRITE besides Canceled: everything after this
    // (In Review on PR-open, Done on merge) is driven by Linear's native GitHub
    // integration off the PR body's `Fixes <key>` link, which is why the CLI
    // emits that link from `goal parse` and pushes no further transitions.
    return rendered<ClaimDelegation>(
      {
        assignee: "me",
        delegate: DELEGATE_MCP,
        id,
        op: "claim",
        state: LINEAR_IN_PROGRESS,
        team: session.tracker.team,
      },
      session.options
    );
  }

  if (session.tracker.type === "local") {
    // A BACKLOG.md has no state machine — there is no in-progress to move to.
    // Reported as a no-op rather than faked, so the skill can say what happened.
    return rendered<ClaimSkipped>(
      { claimed: false, id, reason: "local" },
      session.options
    );
  }

  // ORDER IS LOAD-BEARING: the label must exist BEFORE `issue edit` references
  // it. On a fresh repo the status label does not exist yet, and `gh issue edit
  // --add-label <unknown>` fails OUTRIGHT — the assignee never lands either, so
  // the whole in-progress signal is silently lost. Creating it first (and
  // ignoring the nonzero "already taken" — see `tracker create`) makes the
  // claim work on the first repo as well as the hundredth.
  gh(["label", "create", STATUS_LABEL], session.root);

  const result = gh(
    ["issue", "edit", id, "--add-assignee", "@me", "--add-label", STATUS_LABEL],
    session.root
  );
  if (ghFailed(result)) {
    return rejected(ghError("gh issue edit", result));
  }
  return rendered<ClaimResult>(
    { assignee: "@me", claimed: true, id, label: STATUS_LABEL },
    session.options
  );
}

// ---------------------------------------------------------------------------
// `dobby goal parse <arg>` — issue reference, or free prompt text?
// ---------------------------------------------------------------------------

interface GoalParse {
  // Set ONLY when the goal names an issue the session cannot read (D8): an
  // issue goal has no free-text equivalent, so the flow stops instead of
  // guessing. A free-text goal ALWAYS continues, degraded or not.
  hardStop: string | null;
  // The bare id — `"42"` (no `#`) or `"VON-123"` — the one shape both backends
  // carry. Null for a prompt goal.
  id: string | null;
  lifecycleLink: string | null;
  slug: string;
  slugCollision: boolean;
  source: "github" | "linear" | "prompt";
  url: string | null;
}

// The PATTERN SET IS GATED BY THE CONFIGURED TRACKER, so there is never a
// cross-pattern ambiguity to resolve: a github project reads `#42` and a GitHub
// issue URL and NEVER `VON-123`; a linear project reads `VON-123` and a
// linear.app URL and NEVER `#42`; a local project has no issue pattern at all.
const GITHUB_HASH = /^#(\d+)$/;
const GITHUB_URL =
  /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)(?:[/?#]\S*)?$/;
// UPPERCASE-only on purpose: a Linear identifier is always displayed (and
// copied) uppercase, and requiring it is what keeps an ordinary hyphenated
// phrase (`fix-3`, `sprint-2`) from being swallowed as an issue reference.
const LINEAR_KEY = /^([A-Z][A-Z0-9]*-\d+)$/;
const LINEAR_URL =
  /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]\S*)?$/;

// Everything that is not a letter or a digit becomes a slug separator.
const SLUG_SEPARATORS = /[^a-z0-9]+/g;

// "a few kebab-case words capturing the goal" (scope/SKILL.md) — long enough to
// stay recognizable as a branch name, short enough to stay one.
const MAX_SLUG_WORDS = 6;

// The kit's literal worktree naming — branch `worktree-<slug>` at
// `<mainRoot>/.claude/worktrees/<slug>/`. `scope preflight` is the AUTHORITY on
// collisions (it also suggests a free variant); this is the early warning the
// goal parse can give before a slug is committed to.
const BRANCH_PREFIX = "worktree-";
const WORKTREES_SEGMENTS = [".claude", "worktrees"] as const;

// One recognized issue reference.
interface IssueRef {
  id: string;
  source: "github" | "linear";
  // The canonical URL when the goal WAS one; null for a bare key — resolving it
  // would need a tracker round-trip, and the skill that reads the issue makes
  // that call anyway.
  url: string | null;
}

export function runGoal(context: CommandContext): CommandResult {
  let session: Session;
  try {
    session = resolveSession(context);
  } catch (error) {
    return hardError(error);
  }

  // `positionals[0]` is the `parse` token (the registry validated it).
  const text = textOperand(context.positionals, 1);
  if (text === "") {
    return rejected(
      "goal parse requires a goal reference — an issue id or URL for the configured tracker (`#42`, `VON-123`, a github.com or linear.app issue URL), or free prompt text describing the goal"
    );
  }

  const ref = parseIssueRef(text, session.tracker.type);
  const slug = ref === null ? slugify(text) : slugForIssue(ref);
  return rendered<GoalParse>(
    {
      hardStop: hardStopFor(session, ref),
      id: ref?.id ?? null,
      // Emitted HERE so `/dobby:commit` and `/dobby:scope` never re-derive it:
      // the closing keyword belongs to the BACKEND, and this module is the one
      // place that knows which backend answered.
      lifecycleLink: lifecycleLink(ref),
      slug,
      slugCollision: slugTaken(session.root, slug),
      source: ref?.source ?? "prompt",
      url: ref?.url ?? null,
    },
    session.options
  );
}

function parseIssueRef(text: string, backend: Backend): IssueRef | null {
  if (backend === "github") {
    const hash = GITHUB_HASH.exec(text)?.[1];
    if (hash !== undefined) {
      return { id: hash, source: "github", url: null };
    }
    const inUrl = GITHUB_URL.exec(text)?.[1];
    if (inUrl !== undefined) {
      // The goal WAS the URL, so it is reported back verbatim; a bare `#42`
      // carries no URL (resolving one needs a round-trip nothing here needs).
      return { id: inUrl, source: "github", url: text };
    }
    return null;
  }
  if (backend === "linear") {
    const key = LINEAR_KEY.exec(text)?.[1];
    if (key !== undefined) {
      return { id: key, source: "linear", url: null };
    }
    const inUrl = LINEAR_URL.exec(text)?.[1];
    if (inUrl !== undefined) {
      return { id: inUrl.toUpperCase(), source: "linear", url: text };
    }
    return null;
  }
  // local: goals are free text end to end — there is no id to recognize.
  return null;
}

// The PR-body magic word that closes the goal on merge (trackers.md's
// lifecycle-link row). Null for a prompt goal and for local, which has no PR
// linkage at all.
function lifecycleLink(ref: IssueRef | null): string | null {
  if (ref === null) {
    return null;
  }
  return ref.source === "github" ? `Closes #${ref.id}` : `Fixes ${ref.id}`;
}

// The slug an ISSUE goal starts from. github ids are bare numbers, which make a
// nonsense branch (`worktree-42`), so they carry the `issue-` prefix; a Linear
// key already reads as a name. Either way this is a STARTING point — the skill
// that reads the issue may rename it after its title.
function slugForIssue(ref: IssueRef): string {
  return ref.source === "github" ? `issue-${ref.id}` : slugify(ref.id);
}

// A few kebab-case words: lowercase, every non-alphanumeric run becomes a
// separator, and the first `MAX_SLUG_WORDS` words survive. ASCII by design — a
// slug becomes a branch name and a directory name.
function slugify(text: string): string {
  const words = text
    .toLowerCase()
    .replace(SLUG_SEPARATORS, "-")
    .split("-")
    .filter((word) => word !== "");
  return words.length === 0 ? "goal" : words.slice(0, MAX_SLUG_WORDS).join("-");
}

// Whether this goal's worktree name is already taken — the branch
// `worktree-<slug>` (refs are shared across a repo's worktrees, so a branch with
// no directory still counts) or the directory `.claude/worktrees/<slug>/` under
// the MAIN checkout.
function slugTaken(root: string, slug: string): boolean {
  const branch = runCapture(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${BRANCH_PREFIX}${slug}`],
    { root }
  );
  if (!(branch.error || branch.status !== 0)) {
    return true;
  }
  const mainRoot = linkedWorktreeMain(root) ?? root;
  return existsSync(join(mainRoot, ...WORKTREES_SEGMENTS, slug));
}

// D8's ONE hard stop: the goal names a GITHUB issue and gh cannot answer. There
// is no free-text equivalent of "build issue #42", so the session stops and says
// why instead of inventing a goal. A LINEAR issue never hard-stops here —
// reachability is MCP-side and this CLI never talks to the MCP, so the skill
// discovers it by calling the tool. A prompt goal never stops at all, and never
// pays for the probe.
function hardStopFor(session: Session, ref: IssueRef | null): string | null {
  if (ref === null || ref.source !== "github") {
    return null;
  }
  if (ghAvailable(session.root)) {
    return null;
  }
  return `cannot read github issue #${ref.id} — \`gh auth status\` failed (gh is not installed, not on PATH, or not authenticated). An issue goal has no free-text fallback (D8): authenticate gh, or restate the goal as prompt text`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function runTracker(context: CommandContext): CommandResult {
  let session: Session;
  try {
    session = resolveSession(context);
  } catch (error) {
    return hardError(error);
  }

  const [subcommand] = context.positionals;
  switch (subcommand) {
    case "close":
      return trackerClose(session, idOperand(context.positionals, 1));
    case "create":
      return trackerCreate(session);
    case "info":
      return trackerInfo(session);
    case "search":
      return trackerSearch(session, textOperand(context.positionals, 1));
    default:
      // Unreachable: run.ts's registry validated the token before dispatch.
      // Present so the switch is total rather than silently answering nothing.
      return rejected(`unknown tracker subcommand: ${String(subcommand)}`);
  }
}
