import { parseArgs } from "node:util";
import pkg from "../package.json";
import { detectProject, type ProjectDetection } from "./detect.ts";

// The CLI's public interface: a pure process-independent seam. It parses argv,
// dispatches on the first positional, and returns the process outcome as data
// ({ exitCode, stdout, stderr }) so the bin entry can stay a logic-free adapter
// and vitest can exercise every branch in-process. `cwd` is the caller's
// directory, threaded down to the capability detector.
//
// Runtime-portable invariant: only node:* imports + the plain JSON import — no
// Bun.* globals, no bun: modules — so vitest (Node/Vite runtime) can import it.

// The usage text. First line begins "Usage: dobby" (asserted by the contract);
// the Commands block advertises `capabilities`.
const usage = `Usage: dobby [command]

Commands:
  capabilities    Detect and print this project's capabilities

Options:
  -v, --version   Print the dobby version and exit
`;

export async function run(
  argv: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let positionals: string[];
  let version: boolean | undefined;

  try {
    const parsed = parseArgs({
      args: argv,
      options: { version: { type: "boolean", short: "v" } },
      allowPositionals: true,
      strict: true,
    });
    positionals = parsed.positionals;
    version = parsed.values.version;
  } catch (error) {
    // parseArgs (strict) throws a TypeError on unknown/malformed flags. Emit the
    // parse error message BEFORE the usage — the order is part of the contract.
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `${message}\n\n${usage}` };
  }

  if (version) {
    return { exitCode: 0, stdout: `${pkg.version}\n`, stderr: "" };
  }

  const command = positionals[0];

  if (command === undefined) {
    return { exitCode: 0, stdout: usage, stderr: "" };
  }

  if (command === "capabilities") {
    let detection: ProjectDetection;
    try {
      detection = detectProject(cwd);
    } catch (error) {
      // Missing/unparseable root package.json, an unparseable workspace member
      // (the message names its own file path), or an unsupported workspace
      // pattern — all share the same exit-1 contract. The thrown message already
      // carries the full text; run() just appends the trailing newline.
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout: "", stderr: `${message}\n` };
    }
    return { exitCode: 0, stdout: formatDetection(detection), stderr: "" };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `unknown command: ${command}\n\n${usage}`,
  };
}

// Render a project detection to the `capabilities` stdout contract.
//  - single: one capability name per line; zero capabilities → exactly "none\n".
//  - grouped: for each group with ≥1 capability, a header line "<relpath>\n"
//    followed by each capability indented two spaces ("  <cap>\n"); groups are
//    already ordered (root ".", then members by relpath). Zero-capability groups
//    (members and root alike) are OMITTED, with no blank lines between groups. If
//    every group is empty → exactly "none\n".
function formatDetection(detection: ProjectDetection): string {
  if (detection.kind === "single") {
    return formatFlat(detection.capabilities);
  }

  const nonEmpty = detection.groups.filter((group) => group.capabilities.length > 0);
  if (nonEmpty.length === 0) {
    return "none\n";
  }
  return nonEmpty
    .map(
      (group) =>
        `${group.relpath}\n${group.capabilities.map((capability) => `  ${capability}\n`).join("")}`,
    )
    .join("");
}

// The flat (single-package) form: one capability per line; empty → "none\n".
function formatFlat(capabilities: string[]): string {
  return capabilities.length === 0
    ? "none\n"
    : capabilities.map((capability) => `${capability}\n`).join("");
}
