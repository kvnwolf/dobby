import { NON_CMUX_GUIDE } from "../browser-guide.ts";
import {
  DEV_START_COMMAND,
  type Environment,
  type Instruction,
  type SurfaceContext,
  type Topic,
} from "../environment.ts";

// THE TERMINAL ADAPTER — no cmux workspace. A REAL second implementation, not
// "cmux with no-ops": it has no browser surface, its verification guide is the
// non-cmux ladder, and its instruction catalogue routes `start`/`browser` to what
// the HOST terminal session (Claude Code's own Bash tool) must do, while
// `stop`/`rename` don't apply — the plain terminal has no workspace to rename, and
// `dobby down` kills the registered process itself. Since TASK 4 `up` never spawns
// `dobby dev` itself on this adapter — the model runs the `start` instruction as a
// background Bash job and registers its own pidfile (`pidfile.ts`'s `writePidfile`,
// called by `dobby dev` on startup).

export function terminalEnvironment(): Environment {
  return {
    cmux: null,
    discoverPanes: () => ({ browserPane: null, runPane: null }),
    id: "terminal",
    instruction: terminalInstruction,
  };
}

// Not applicable: nothing for the model to do, and the reason never leaks into
// `text` (the CALLER — `dobby instructions`' text-mode rendering — owns that).
function notApplicable(topic: Topic): Instruction {
  return { applies: false, text: "", topic };
}

function terminalInstruction(
  topic: Topic,
  context: SurfaceContext
): Instruction {
  switch (topic) {
    case "start":
      return terminalStartInstruction(context);
    case "stop":
      // `dobby down` kills the registered process itself — nothing for the
      // model to do.
      return notApplicable(topic);
    case "browser":
      return { applies: true, text: NON_CMUX_GUIDE, topic };
    case "rename":
      // A plain terminal has no workspace to rename.
      return notApplicable(topic);
    default:
      // Exhaustive over Topic — `topic` is `never` here (compile-time guard).
      return topic;
  }
}

// `start`: run `bunx dobby dev` from the workroot as a background task of the
// HOST's own Bash tool (`run_in_background`), then confirm from its early output
// that the server is booting — a failed command shows its error right there —
// before re-invoking `bunx dobby up --json`.
function terminalStartInstruction(context: SurfaceContext): Instruction {
  const devUrlNote =
    context.devUrl === null ? "the devUrl `dobby env` reports" : context.devUrl;
  return {
    applies: true,
    text: [
      `Run \`${DEV_START_COMMAND}\` from ${context.workroot} as a background task of the host: use Claude Code's Bash tool with the \`run_in_background\` option set to true.`,
      "Read the command's early output to confirm the server is booting — a failed command shows its error right there — before re-invoking `bunx dobby up --json` to confirm the app is live.",
      `Once confirmed live, the app is reachable at ${devUrlNote}.`,
    ].join(" "),
    topic: "start",
  };
}

// `ensureGitignored`, `killFromPidfile`, `isAlive`, `ownsDetachedRun` and
// `parseEtimeSeconds` live in `pidfile.ts` (the run-process registry) — see that
// module for the teardown mechanics `down` relies on regardless of which
// environment is currently active.
