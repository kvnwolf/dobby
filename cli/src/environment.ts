import {
  CLAUDE_DESKTOP_ENTRYPOINTS,
  claudeDesktopEnvironment,
} from "./adapters/claude-desktop.ts";
import { cmuxEnvironment } from "./adapters/cmux.ts";
import {
  T3_CODE_BUNDLE_PREFIX,
  t3CodeEnvironment,
} from "./adapters/t3-code.ts";
import { terminalEnvironment } from "./adapters/terminal.ts";

// The ENVIRONMENT ADAPTER SEAM (issue #27): everywhere the kit's mechanics differ by
// host runner — pane discovery, teardown, and (since TASK 4) the INSTRUCTION
// CATALOGUE for what the model must do — is behind ONE `Environment` interface,
// resolved ONCE per command via `detectEnvironment()`. Four real implementations:
// `cmuxEnvironment` (cli/src/adapters/cmux.ts — a cmux workspace is present),
// `claudeDesktopEnvironment` (cli/src/adapters/claude-desktop.ts — the Desktop
// app or one of its `claude-desktop-3p`/`local-agent` siblings), `t3CodeEnvironment`
// (cli/src/adapters/t3-code.ts — the t3 code desktop app), and `terminalEnvironment`
// (cli/src/adapters/terminal.ts — the floor: no enrichment detected).
//
// This file is the INTERFACE + DETECTION only: pane discovery/teardown mechanics
// live in `./adapters/cmux.ts` / `./adapters/terminal.ts`, and the INSTRUCTION
// CATALOGUE (`instruction(topic, context)` — what the MODEL must do, for an
// environment dobby cannot act inside on the model's behalf) is answered by each
// adapter too. `up` no longer executes anything through this interface beyond pane
// DISCOVERY (needed so an instruction's text can embed a discovered surface ref) —
// starting, stopping, renaming and opening surfaces are now instructions the model
// carries out itself. `environment.ts` must NEVER import `lifecycle.ts` (lifecycle.ts
// imports THIS file).
//
// What stays OUT of this seam (lifecycle.ts owns it): portless, the liveness probe,
// Neon branch provisioning, the `up`/`down` plan-rendering data (`UpAction` /
// `DownAction` / `UpPlan` / `DownPlan`) — none of that varies by host runner.

// The command every adapter's run surface starts. One literal, shared by the `up`
// plan (lifecycle.ts's `buildUpActions`, for `--dry-run` rendering) and the real
// mechanics in the adapters, so they can never diverge.
export const DEV_START_COMMAND = "bunx dobby dev";

/**
 * Every host runner dobby can detect — all four have real adapters:
 * `"cmux"` (cli/src/adapters/cmux.ts), `"claude-desktop"`
 * (cli/src/adapters/claude-desktop.ts), `"t3-code"`
 * (cli/src/adapters/t3-code.ts), and `"terminal"` (cli/src/adapters/terminal.ts
 * — the floor).
 *
 * @public — `dobby instructions --json`'s `environment` field / `EnvSnapshot`
 * callers type against this full set.
 */
export type EnvironmentId = "cmux" | "terminal" | "claude-desktop" | "t3-code";

// The four things dobby ever needs the MODEL to do on its behalf, because the
// environment gives dobby no way to act there itself: start the run surface, stop
// it, verify the UI in a browser, and rename the workspace. `dobby instructions
// <topic>` answers one of these; dobby never performs the topic itself.
export type Topic = "start" | "stop" | "browser" | "rename";

// One catalogue entry: whether `topic` applies in this environment, and — when it
// does — the complete, self-contained instruction text for a model with no other
// context. `applies: false` carries `text: ""` (nothing to leak into an unused
// field); the reason a topic doesn't apply belongs to the CALLER's rendering
// (`dobby instructions`' text-mode "not applicable" line), never to this text.
export interface Instruction {
  applies: boolean;
  text: string;
  topic: Topic;
}

// The kit's two named surface refs, discovered by title. `null` when a surface
// doesn't exist (or the environment has no concept of one, e.g. terminal).
// Exported so the adapters (which implement `discoverPanes`) can name the type by
// deep path.
export interface PaneRefs {
  browserPane: string | null;
  runPane: string | null;
}

// What `up`'s run/browser-surface mechanics — and `instruction()` — need from the
// resolved context. Deliberately NOT `lifecycle.ts`'s `UpContext`: this file must
// never import from lifecycle.ts (lifecycle.ts imports THIS file). `UpContext`
// structurally satisfies this — it carries every field here plus more (`cmux`,
// `neon`) — so passing it at a call site needs no adapter object of its own.
// Exported so the adapters can name the type by deep path.
export interface SurfaceContext {
  devUrl: string | null;
  slug: string;
  workroot: string;
}

// The adapter interface every host runner implements: detection/naming (`cmux`,
// `id`), pane discovery, and the instruction catalogue for the topics dobby cannot
// act on the model's behalf.
//
// `ensureRunSurface` / `ensureBrowserSurface` / `renameWorkspace` / `browserGuide`
// were the EXECUTABLE half of the seam (`up`/`down` calling them directly); TASK 4
// removed that half from `up`, and TASK 7 finished the job for `down` —
// `closeSurfaces` is gone: dobby no longer closes a surface itself anywhere, it
// only hands the model the `instruction` catalogue entry for the topic (`down`'s
// `stop` instruction names `cmux close-surface` for every discovered kit pane).
export interface Environment {
  // The CMUX_WORKSPACE_ID value this environment was detected from, or `null` for
  // the terminal adapter. Reported verbatim as `EnvSnapshot.cmux` / `UpFacts.cmux`.
  readonly cmux: string | null;
  // Discover the kit's run/browser surface refs, or `{ null, null }` when this
  // environment has no such concept (terminal) or none are open.
  discoverPanes: (workroot: string | null) => PaneRefs;
  // The environment's own identity — `dobby instructions --json`'s `environment`
  // field, and the future third-adapter discriminant.
  readonly id: EnvironmentId;
  // The instruction catalogue: what the MODEL must do for `topic`, given the
  // resolved surface context. `applies: false` means dobby needs nothing from the
  // model here (e.g. terminal's `stop` — `dobby down` kills the process itself).
  instruction: (topic: Topic, context: SurfaceContext) => Instruction;
}

// Resolve the environment for THIS process, from `CMUX_WORKSPACE_ID` — the single
// read every command-level caller (`collectEnv`, `runUp`, `runDown`, `dobby
// instructions`) makes ONCE and threads through, replacing what were four
// independent reads of the same variable. Reads `process.env` fresh on every call
// (never memoized): tests toggle the variable between cases within one process.
//
// Detection is a FOUR-RUNG cascade: `CMUX_WORKSPACE_ID` present -> cmux (richer
// enrichment always wins); else `CLAUDE_CODE_ENTRYPOINT` is one of Claude
// Desktop's three documented values -> claudeDesktopEnvironment(); else the
// hosting app's bundle id starts with the t3-code prefix -> t3CodeEnvironment();
// else terminal (the floor — an unknown SDK host lands here, and its
// instructions work anywhere).
//
// Desktop is keyed on the ENTRYPOINT, not a bundle id: `CLAUDE_CODE_ENTRYPOINT`
// is the signal `code.claude.com/docs/en/monitoring-usage` documents as
// Desktop-owned (the `tool_source` attribute spec names all three values —
// `claude-desktop`, `claude-desktop-3p`, `local-agent` — as sessions Desktop
// started) and it is cross-platform, unlike a bundle id. `__CFBundleIdentifier
// = com.anthropic.claudefordesktop` is macOS reinforcement only, never read
// here — the entrypoint alone decides. Desktop sits ABOVE t3-code in the
// cascade: a session can run inside Desktop which itself hosts t3 code, and the
// surface the model actually drives is Desktop's.
export function detectEnvironment(): Environment {
  const cmux = process.env.CMUX_WORKSPACE_ID || null;
  if (cmux !== null) {
    return cmuxEnvironment(cmux);
  }
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (
    entrypoint !== undefined &&
    CLAUDE_DESKTOP_ENTRYPOINTS.includes(entrypoint)
  ) {
    return claudeDesktopEnvironment();
  }
  const bundleId = process.env.__CFBundleIdentifier;
  if (bundleId?.startsWith(T3_CODE_BUNDLE_PREFIX)) {
    return t3CodeEnvironment();
  }
  return terminalEnvironment();
}
