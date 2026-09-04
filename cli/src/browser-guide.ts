import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The verification protocol `dobby instructions browser` delivers (as the
// `browser` topic's `text`), so QA stops rediscovering the UI-driver ladder every
// run. Two variants, picked by whether a cmux workspace is present (the SAME
// `CMUX_WORKSPACE_ID` fact `collectEnv` already reports as `cmux`):
//
//  - cmux present: the vendored cmux-browser protocol (Rung 1 of the ladder
//    described in the root CONTEXT.md glossary) — open, read the URL, snapshot
//    for fresh refs, act, wait, re-snapshot, stale-ref recovery, script-error
//    recovery. Vendored unmodified under `vendor/cmux-browser/`, never fetched
//    live (irreproducible, network-dependent); provenance recorded in
//    `vendor/cmux-browser/PROVENANCE.md` the way ADR-0027 already records
//    `plugin/skills/trim-context/scripts/vendor/`.
//  - no cmux: the non-cmux instructions — Rung 2 (claude-in-chrome) falling back
//    to Rung 3 (curl-only), mirroring the SAME ladder's later rungs.
//
// Both variants are module-level constants: read once from disk at import time,
// so every call answers the identical bytes with no network of its own. Exported
// so the environment adapters (`adapters/cmux.ts` / `adapters/terminal.ts`) can use
// them directly by deep path — the cmux adapter's `browser` catalogue entry answers
// `CMUX_GUIDE`; terminal's answers `NON_CMUX_GUIDE`.

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(MODULE_DIR, "vendor", "cmux-browser");

export const CMUX_GUIDE = buildCmuxGuide();
export const NON_CMUX_GUIDE = buildNonCmuxGuide();

// The cmux-browser protocol: the vendored upstream skill + command reference,
// under one header naming the driver explicitly.
function buildCmuxGuide(): string {
  const skill = readFileSync(join(VENDOR_DIR, "SKILL.md"), "utf8");
  const commands = readFileSync(join(VENDOR_DIR, "commands.md"), "utf8");
  return [
    "# UI verification — cmux-browser (Rung 1)",
    "Drive the browser pane cmux already opened through the cmux-browser protocol below: open (or target) a surface, read the current URL, snapshot for fresh element refs, act on a ref, wait for the state change, then re-snapshot before acting again — refs go stale across navigation or a major DOM change. If a page's own script rejects an interactive snapshot or an eval (a script error), recover by reading raw text/HTML instead of retrying the same call.",
    skill.trim(),
    commands.trim(),
  ].join("\n\n");
}

// The non-cmux instructions: Rung 2 (claude-in-chrome) falling back to Rung 3
// (curl-only), mirroring the SAME ladder's later rungs without naming
// cmux-browser's own command surface (there is no cmux surface to drive
// here).
function buildNonCmuxGuide(): string {
  return [
    "# UI verification — no cmux workspace detected",
    "No CMUX_WORKSPACE_ID is set, so there is no cmux browser surface to drive. Use claude-in-chrome instead: load the deferred tools first (ToolSearch for mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_console_messages — or invoke the claude-in-chrome skill), navigate to the target URL, then computer / read_page to exercise and observe the rendered result, and read_console_messages for client-side errors.",
    "If claude-in-chrome cannot reach the site (no host permission, or its tools will not load), fall back to a programmatic curl-only check: curl the route directly and assert on the returned HTML/JSON. That only proves the response, not the rendered UI — report the gap as needs-human, with reproduction steps, rather than claiming a UI pass.",
  ].join("\n\n");
}
