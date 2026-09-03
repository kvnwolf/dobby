import { basename } from "node:path";
import { CMUX_GUIDE } from "../browser-guide.ts";
import {
  DEV_START_COMMAND,
  type Environment,
  type Instruction,
  type PaneRefs,
  type SurfaceContext,
  type Topic,
} from "../environment.ts";
import { runCapture } from "../runner.ts";

// THE CMUX ADAPTER — pane DISCOVERY (`list-panes`, `list-pane-surfaces`),
// extracted from environment.ts with its invocations unchanged, PLUS the
// instruction catalogue: what the model must do for a topic dobby cannot act on
// its own behalf for. Discovery is the one thing `instruction()` EXECUTES — every
// acting cmux call (`send`, `new-pane`, `close-surface`, `rename-workspace`) stays
// INSIDE the returned text; dobby only ever prints it. Since TASK 4 `up` no longer
// opens, sends to, renames or closes a cmux surface itself — the model runs those
// commands from the instruction text.

// Top-level regexes (biome useTopLevelRegex).
const WHITESPACE_SPLIT_RE = /\s+/;
const SINGLE_QUOTE_RE = /'/g;

// Single-quote a dynamic value bound for a shell command line inside an
// instruction's `text` — every workroot, cmux workspace id, slug, pane title
// and discovered pane ref lands on a line the model pastes into a shell
// verbatim, so it must survive spaces and embedded quotes alike (POSIX
// single-quote escaping: end the quote, emit an escaped quote, reopen it).
function shellQuote(value: string): string {
  return `'${value.replace(SINGLE_QUOTE_RE, "'\\''")}'`;
}

export function cmuxEnvironment(cmux: string): Environment {
  return {
    cmux,
    discoverPanes: (workroot) => discoverPanesFor(workroot, cmux),
    id: "cmux",
    instruction: (topic, context) => cmuxInstruction(topic, context, cmux),
  };
}

// ---------------------------------------------------------------------------
// Kit pane refs — discovered through cmux's local IPC (never a network probe).
// Walk the workspace's panes and their surfaces, matching surface titles
// `dobby-run-<slug>` / `dobby-browser-<slug>` where slug is the workroot directory
// basename, and report the matching surface refs.
//
// Any failure — no workroot, cmux binary absent, access denied, no matching
// surface — folds to null (env never fails). The exact cmux listing stdout format
// is runtime-unverified (see research); the parser is deliberately tolerant (scan
// lines for `<kind>:<ref>` tokens, substring-match titles) and is CI-null
// regardless (no reachable cmux surface), with live behavior covered by the
// wrap-stage human smoke.
// ---------------------------------------------------------------------------

function discoverPanesFor(workroot: string | null, cmux: string): PaneRefs {
  const none = { browserPane: null, runPane: null };
  if (workroot === null) {
    return none;
  }
  const slug = basename(workroot);
  const runTitle = `dobby-run-${slug}`;
  const browserTitle = `dobby-browser-${slug}`;

  const panes = runCapture("cmux", ["list-panes", "--workspace", cmux], {
    root: workroot,
  });
  if (panes.status !== 0) {
    return none;
  }
  const paneRefs = parseRefs(panes.stdout, "pane");
  if (paneRefs.length === 0) {
    return none;
  }

  let runPane: string | null = null;
  let browserPane: string | null = null;
  for (const pane of paneRefs) {
    const surfaces = runCapture(
      "cmux",
      ["list-pane-surfaces", "--workspace", cmux, "--pane", pane],
      { root: workroot }
    );
    if (surfaces.status !== 0) {
      continue;
    }
    for (const line of surfaces.stdout.split("\n")) {
      if (runPane === null && line.includes(runTitle)) {
        runPane = refOf(line, "surface");
      }
      if (browserPane === null && line.includes(browserTitle)) {
        browserPane = refOf(line, "surface");
      }
    }
    if (runPane !== null && browserPane !== null) {
      break;
    }
  }
  return { browserPane, runPane };
}

// Extract the ref token of `kind` (e.g. "pane" / "surface") from each non-empty
// line of a cmux listing. cmux "Output defaults to refs" (`pane:3`, `surface:4`);
// we scan for that token and fall back to the line's first whitespace-delimited
// field when it is absent (format is runtime-unverified).
function parseRefs(stdout: string, kind: string): string[] {
  const refs: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const ref = refOf(line, kind);
    if (ref !== null) {
      refs.push(ref);
    }
  }
  return refs;
}

// The `kind:ref` token in a line (`surface:4`), or the first field as a fallback.
function refOf(line: string, kind: string): string | null {
  const token = new RegExp(`${kind}:\\S+`).exec(line);
  if (token !== null) {
    return token[0];
  }
  const [first] = line.trim().split(WHITESPACE_SPLIT_RE);
  return first === undefined || first === "" ? null : first;
}

// ---------------------------------------------------------------------------
// The instruction catalogue — what the model must do for a topic, given the
// resolved surface context. Discovery is the only EXECUTED cmux call; every
// acting command (`send`, `new-pane`, `close-surface`, `rename-workspace`) is
// named INSIDE the returned text, never run here.
// ---------------------------------------------------------------------------

const CONFIRM_BOOT_LINE =
  "Verify the pane shows the server booting before re-invoking `bunx dobby up --json`.";

function cmuxInstruction(
  topic: Topic,
  context: SurfaceContext,
  cmux: string
): Instruction {
  switch (topic) {
    case "start":
      return cmuxStartInstruction(context, cmux);
    case "stop":
      return cmuxStopInstruction(context, cmux);
    case "browser":
      return cmuxBrowserInstruction(context, cmux);
    case "rename":
      return cmuxRenameInstruction(context, cmux);
    default:
      // Exhaustive over Topic — `topic` is `never` here (compile-time guard).
      return topic;
  }
}

// The resolved workroot to discover panes with, or null when `instruction()` was
// called with no resolvable workroot (only `browser` can reach this — it embeds
// no workroot precondition; `run.ts` passes `""` in that case).
function discoveryWorkroot(context: SurfaceContext): string | null {
  return context.workroot === "" ? null : context.workroot;
}

// `start`: reuse the surviving run pane (`cmux send` the dev line into it), or
// instruct creating + naming one when none is open. Both end on the same
// boot-confirmation line.
function cmuxStartInstruction(
  context: SurfaceContext,
  cmux: string
): Instruction {
  const panes = discoverPanesFor(discoveryWorkroot(context), cmux);
  const sendLine = `cd ${shellQuote(context.workroot)} && ${DEV_START_COMMAND}`;
  const quotedSendLine = shellQuote(sendLine);
  if (panes.runPane !== null) {
    return {
      applies: true,
      text: [
        `A run pane is already open: ${panes.runPane}.`,
        `Run \`cmux send --surface ${shellQuote(panes.runPane)} ${quotedSendLine}\` to start the dev server in it.`,
        CONFIRM_BOOT_LINE,
      ].join(" "),
      topic: "start",
    };
  }
  const runTitle = `dobby-run-${context.slug}`;
  return {
    applies: true,
    text: [
      "No run pane is open.",
      `Create one with \`cmux new-pane --workspace ${shellQuote(cmux)} --direction right\`, rename it with \`cmux rename-tab --surface <ref> ${shellQuote(runTitle)}\`, then run \`cmux send --surface <ref> ${quotedSendLine}\` to start the dev server.`,
      CONFIRM_BOOT_LINE,
    ].join(" "),
    topic: "start",
  };
}

// `stop`: applies only when at least one kit pane is discovered — names
// `cmux close-surface` for each discovered ref. No pane open -> not applicable
// (nothing for the model to close).
function cmuxStopInstruction(
  context: SurfaceContext,
  cmux: string
): Instruction {
  const panes = discoverPanesFor(discoveryWorkroot(context), cmux);
  const refs = [panes.runPane, panes.browserPane].filter(
    (ref): ref is string => ref !== null
  );
  if (refs.length === 0) {
    return { applies: false, text: "", topic: "stop" };
  }
  const closeCommands = refs
    .map((ref) => `\`cmux close-surface --surface ${shellQuote(ref)}\``)
    .join(", then ");
  return {
    applies: true,
    text: `Close every kit pane dobby opened: ${closeCommands}.`,
    topic: "stop",
  };
}

// `browser`: surface step first (reuse the discovered browser pane, or instruct
// creating + naming one at the devUrl), followed by the vendored cmux-browser
// protocol verbatim. Always applies — there is always a way to drive the browser
// under cmux.
function cmuxBrowserInstruction(
  context: SurfaceContext,
  cmux: string
): Instruction {
  const panes = discoverPanesFor(discoveryWorkroot(context), cmux);
  const urlFlag =
    context.devUrl === null ? "" : ` --url ${shellQuote(context.devUrl)}`;
  const browserTitle = `dobby-browser-${context.slug}`;
  const surfaceStep =
    panes.browserPane === null
      ? `No browser pane is open. Create one with \`cmux new-pane --workspace ${shellQuote(cmux)} --type browser${urlFlag} --direction right\`, then rename it with \`cmux rename-tab --surface <ref> ${shellQuote(browserTitle)}\`.`
      : `A browser pane is already open: ${panes.browserPane}. Drive it directly.`;
  return {
    applies: true,
    text: `${surfaceStep}\n\n${CMUX_GUIDE}`,
    topic: "browser",
  };
}

// `rename`: always applies under cmux — names `cmux rename-workspace` with the
// workspace id and slug quoted (the tests pin this exact form).
function cmuxRenameInstruction(
  context: SurfaceContext,
  cmux: string
): Instruction {
  return {
    applies: true,
    text: `Rename the cmux workspace to the goal slug: \`cmux rename-workspace --workspace ${shellQuote(cmux)} ${shellQuote(context.slug)}\`.`,
    topic: "rename",
  };
}
