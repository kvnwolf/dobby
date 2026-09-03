import type {
  Environment,
  Instruction,
  SurfaceContext,
  Topic,
} from "../environment.ts";
import { terminalEnvironment } from "./terminal.ts";

// THE CLAUDE DESKTOP ADAPTER — a session running inside the Claude Desktop app
// (and its `claude-desktop-3p` / `local-agent` siblings — all three documented
// as Desktop-owned entrypoints, `code.claude.com/docs/en/monitoring-usage`).
// Detected via `CLAUDE_CODE_ENTRYPOINT`, the documented, cross-platform signal
// (`environment.ts`'s cascade matches it by exact value, not prefix);
// `__CFBundleIdentifier=com.anthropic.claudefordesktop` is macOS reinforcement
// only, never required for detection.
//
// The catalogue is HALF terminal, half its own:
//  - `start`/`stop`/`rename` DELEGATE to `terminalEnvironment()`'s own answers
//    verbatim (imported by deep path, never duplicated here): the app starts no
//    dev server of its own — the host's background Bash does — and has no
//    workspace to rename, so it adds nothing terminal doesn't already say.
//  - `browser` is this adapter's own hand-written guide over the built-in
//    `Claude Browser` MCP server (aliased `Claude Preview`), always applies.
//
// Provenance: UNVERIFIED against a live Claude Desktop. Written from a field
// study dated 2026-08-19 (Claude Desktop 1.30096.5, Claude Code 2.1.229) —
// `docs/field-studies/claude-desktop-2026-08-19.md`. The 18 method names it
// lists appear on no public page (CONSISTENT with `code.claude.com/docs/en/mcp`'s
// reserved-name list, not VERIFIED by it); the guide leads with `tabs_context`
// so a wrong method name fails on the model's first call rather than mid-flow.
// When someone verifies this against a live Desktop, replace this marker (and
// the one inside the guide text) rather than silently dropping it.

export function claudeDesktopEnvironment(): Environment {
  return {
    cmux: null,
    discoverPanes: () => ({ browserPane: null, runPane: null }),
    id: "claude-desktop",
    instruction: claudeDesktopInstruction,
  };
}

// The exact `CLAUDE_CODE_ENTRYPOINT` values Claude Desktop (and its
// third-party / local-agent flavours) sets — `code.claude.com/docs/en/monitoring-usage`
// names all three as Desktop-owned. Exported so `environment.ts`'s cascade can
// match against this one list rather than restating the literals.
export const CLAUDE_DESKTOP_ENTRYPOINTS: readonly string[] = [
  "claude-desktop",
  "claude-desktop-3p",
  "local-agent",
];

function claudeDesktopInstruction(
  topic: Topic,
  context: SurfaceContext
): Instruction {
  if (topic === "browser") {
    return {
      applies: true,
      text: claudeDesktopBrowserGuide(context),
      topic: "browser",
    };
  }
  // start/stop/rename: delegate to terminal's own answer, unduplicated.
  return terminalEnvironment().instruction(topic, context);
}

// The browser guide: a hand-written walk through the built-in `Claude Browser`
// MCP server (tool prefix `mcp__Claude_Browser__`, the MCP-naming transliteration
// of the documented server name `Claude Browser` — a space, replaced with `_`;
// `Claude Preview` is an alias of the same server). Written for a model that has
// the tool schemas loaded but no other context — leads with the self-verifying
// `tabs_context` step so a wrong tool name fails on the first call.
function claudeDesktopBrowserGuide(context: SurfaceContext): string {
  const devUrlNote =
    context.devUrl === null ? "the devUrl `dobby env` reports" : context.devUrl;
  return [
    "# UI verification — Claude Desktop's built-in browser",
    "This session runs inside Claude Desktop, which exposes its own embedded browser as the `Claude Browser` MCP server (also shown as `Claude Preview` — two names for the one built-in server; tool prefix `mcp__Claude_Browser__`) — load its tool schemas first (ToolSearch) if they are not already available.",
    [
      "1. Call `mcp__Claude_Browser__tabs_context` first — the self-verifying step.",
      `If a tab is already open on ${devUrlNote}, call \`mcp__Claude_Browser__tabs_select\` to bring it to the front and reuse it.`,
    ].join(" "),
    [
      "2. Only when no tab is already on the devUrl, call `mcp__Claude_Browser__tabs_create` to open one,",
      `then \`mcp__Claude_Browser__navigate\` it to ${devUrlNote}.`,
    ].join(" "),
    [
      "3. Drive the page with `mcp__Claude_Browser__read_page` (the accessibility tree with element refs — prefer it over screenshots) and `mcp__Claude_Browser__find` to locate elements,",
      "`mcp__Claude_Browser__form_input` to set form values, `mcp__Claude_Browser__computer` for clicks/keys/scroll/screenshot, and `mcp__Claude_Browser__get_page_text` for the visible text.",
      "Use `mcp__Claude_Browser__resize_window` to change the viewport size and colour scheme (light/dark) under test.",
    ].join(" "),
    [
      "4. Diagnose a failing page with `mcp__Claude_Browser__read_console_messages` and `mcp__Claude_Browser__read_network_requests`.",
      "Use `mcp__Claude_Browser__javascript_tool` for INSPECTION only — never to perform the interaction itself.",
    ].join(" "),
    [
      "Deliberately NOT `claude-in-chrome`: that tool needs the Chrome extension installed and the user's own logged-in sessions — the embedded `Claude Browser` above is the default here and needs neither.",
    ].join(" "),
    [
      "5. Fallback: if the `mcp__Claude_Browser__*` tools are absent from the tool list even after ToolSearch, verify with `curl` against the devUrl directly instead — that only proves the response, not the rendered UI, so report the gap as needs-human rather than claiming a UI pass.",
    ].join(" "),
    "This guide is unverified against a live Claude Desktop — written from a field study dated 2026-08-19 (Claude Desktop 1.30096.5, Claude Code 2.1.229), see `docs/field-studies/claude-desktop-2026-08-19.md`. The 18 method names it lists have no public documentation (consistent with `code.claude.com/docs/en/mcp`'s reserved-name list, not verified by it).",
  ].join("\n\n");
}
