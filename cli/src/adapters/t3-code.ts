import type {
  Environment,
  Instruction,
  SurfaceContext,
  Topic,
} from "../environment.ts";
import { terminalEnvironment } from "./terminal.ts";

// THE T3-CODE ADAPTER — a session running inside the t3 code desktop app
// (detected via `__CFBundleIdentifier`, an Info.plist artefact macOS sets for
// every GUI-hosted process; there is no equivalent on Linux/Windows, so t3 code
// there falls through to the plain `terminalEnvironment()`). Detection matches by
// PREFIX: the production bundle id `com.t3tools.t3code` and every dev build
// (`com.t3tools.t3code.dev.<repo>`) land on this same adapter.
//
// The catalogue is HALF terminal, half its own:
//  - `start`/`stop`/`rename` DELEGATE to `terminalEnvironment()`'s own answers
//    verbatim (imported by deep path, never duplicated here): the app has no run
//    surface of its own to start/stop and no workspace to rename, so it adds
//    nothing terminal doesn't already say.
//  - `browser` is this adapter's own hand-written guide over the vendor's
//    `mcp__t3-code__preview_*` tool family (14 tools), always applies.
//
// Provenance: the browser guide below is verified against t3 code `v0.0.38` on
// `2026-09-02` (tool schemas loaded live; source `pingdotgg/t3code`,
// `apps/server/src/mcp/toolkits/preview/tools.ts`). When the vendor's tool
// surface moves, re-verify and bump both the version and the date so a stale
// guide fails visibly rather than drifting silently.

const T3_BUNDLE_PREFIX = "com.t3tools.t3code";

export function t3CodeEnvironment(): Environment {
  return {
    cmux: null,
    discoverPanes: () => ({ browserPane: null, runPane: null }),
    id: "t3-code",
    instruction: t3CodeInstruction,
  };
}

// The bundle-id prefix `detectEnvironment()` matches against
// `process.env.__CFBundleIdentifier`. Exported so environment.ts's cascade can
// name the exact prefix once, here, rather than restating the literal.
export const T3_CODE_BUNDLE_PREFIX = T3_BUNDLE_PREFIX;

function t3CodeInstruction(topic: Topic, context: SurfaceContext): Instruction {
  if (topic === "browser") {
    return { applies: true, text: t3BrowserGuide(context), topic: "browser" };
  }
  // start/stop/rename: delegate to terminal's own answer, unduplicated.
  return terminalEnvironment().instruction(topic, context);
}

// The port to target with `preview_navigate`'s `environment-port` kind: embed
// the devUrl's own port when known, otherwise point the model at `dobby env`.
function devPortNote(devUrl: string | null): string {
  if (devUrl === null) {
    return "the port of the devUrl `dobby env` reports";
  }
  try {
    const { port } = new URL(devUrl);
    return port === "" ? devUrl : port;
  } catch {
    return devUrl;
  }
}

// The browser guide: a hand-written walk through the vendor's
// `mcp__t3-code__preview_*` tools, in the vendor's own order — status (reuse the
// current tab if it's already automation-capable) -> open (only when there is no
// usable tab) -> navigate (target the app by environment port) -> snapshot before
// interacting, then act/observe, then evidence -> curl fallback when the tools
// are absent entirely. Written for a model that has the tool schemas loaded but
// no other context.
function t3BrowserGuide(context: SurfaceContext): string {
  const port = devPortNote(context.devUrl);
  return [
    "# UI verification — t3 code preview tools",
    "This session runs inside the t3 code desktop app, which exposes the app's own preview MCP tools (`mcp__t3-code__preview_*`) for driving the live collaborative browser tab — load their schemas first (ToolSearch) if they are not already available.",
    [
      "1. Call `mcp__t3-code__preview_status` first — the self-verifying step.",
      "If the current collaborative tab is already automation-capable, reuse it as-is; do not open a new one.",
    ].join(" "),
    [
      "2. Only when `preview_status` reports no usable tab, call `mcp__t3-code__preview_open` to open one.",
    ].join(" "),
    [
      "3. Call `mcp__t3-code__preview_navigate` with `{target: {kind: 'environment-port', port: " +
        port +
        "}}` to point the tab at the running app.",
    ].join(" "),
    [
      "4. Before interacting, call `mcp__t3-code__preview_snapshot` to get fresh element refs.",
      "Act with `mcp__t3-code__preview_click`, `mcp__t3-code__preview_type`, `mcp__t3-code__preview_press` and `mcp__t3-code__preview_wait_for`, each addressing elements with Playwright `locator`s (role/text based, e.g. `getByRole('button', {name: 'Submit'})`) rather than brittle CSS selectors.",
      "Use `mcp__t3-code__preview_scroll` to bring off-screen elements into view, and `mcp__t3-code__preview_resize` / `mcp__t3-code__preview_set_appearance` to change the viewport size and colour scheme (light/dark) under test.",
      "Use `mcp__t3-code__preview_evaluate` for INSPECTION only (reading computed state) — never to perform the interaction itself.",
      "Use `mcp__t3-code__preview_recording_start` / `mcp__t3-code__preview_recording_stop` to capture evidence of the verification run.",
    ].join(" "),
    [
      "5. Fallback: if the `mcp__t3-code__*` tools are unavailable (absent from the tool list even after ToolSearch), verify with `curl` against the devUrl directly instead — that only proves the response, not the rendered UI, so report the gap as needs-human rather than claiming a UI pass.",
    ].join(" "),
    "Verified against t3 code v0.0.38 on 2026-09-02 (tool schemas loaded live; source `pingdotgg/t3code`, `apps/server/src/mcp/toolkits/preview/tools.ts`).",
  ].join("\n\n");
}
