// The contract between `run.ts` (the dispatcher + renderer) and the DOMAIN
// modules that own one session command each (ship, release, state, …). Tiny and
// import-free ON PURPOSE — every domain module depends on it, so it must never
// pull in the CLI's I/O surface.
//
// The split mirrors the `check.ts` precedent: a domain module DECIDES and (later)
// EXECUTES, returning DATA; `run.ts` renders. Rendering is GENERIC — a result
// carrying a `json` payload prints `JSON.stringify(json)`, otherwise `text`
// prints verbatim, and `error` goes to stderr — which is exactly what lets a
// later task fill a stub's internals WITHOUT editing the dispatcher (spec
// Decision 19: parallel tasks never co-edit run.ts).

// The parsed flags a command receives: only the ones actually PRESENT in argv,
// already validated against the command's allowlist by the registry in run.ts.
// Boolean flags carry `true`; string options carry their value.
export type CommandOptions = Readonly<Record<string, boolean | string>>;

// Everything a domain function needs from one invocation. It never reads
// `process.cwd()` / `process.argv` itself — `run.ts` threads all of it in, so the
// in-process `run(argv, cwd, stdin)` test seam (ADR-0008) reaches every command.
export interface CommandContext {
  // The command token as TYPED (`ship`, `state`, …). A stub names it in its
  // `not implemented` message; a real command uses it for its own messages.
  command: string;
  // The caller's directory. Action commands resolve the workroot from it
  // (`runner.requireWorkroot`) and pin every spawn there.
  cwd: string;
  // The present flags (see CommandOptions).
  options: CommandOptions;
  // The positionals AFTER the command token. For a subcommand-style command
  // `positionals[0]` is the subcommand — ALREADY validated against the registry's
  // token set, so a domain module can switch on it without re-checking.
  positionals: string[];
  // The bin's stdin payload (the PostToolUse hook payload today; the `--stdin`
  // input for the commands that accept it). Undefined when nothing was piped.
  stdin?: string;
}

// What a domain function returns — data, never rendered lines.
export interface CommandResult {
  // A message for STDERR, rendered with a trailing newline. Absent = no stderr.
  error?: string;
  // The process exit code: 0 success, 1 hard error (nothing above 2 in this CLI).
  exitCode: number;
  // The machine-readable payload, rendered as one JSON line on stdout. When it is
  // present it is the ONLY stdout (the `--json` contract).
  json?: unknown;
  // Plain-text stdout, rendered VERBATIM (newlines included) and used only when
  // `json` is absent.
  text?: string;
}

// The uniform placeholder outcome every not-yet-implemented command returns:
// exit 1 with `<command>: not implemented` on stderr and NOTHING on stdout, so a
// caller can never mistake a stub for a real (empty) answer. The later task that
// implements the command deletes this call, not the module.
export function notImplemented(command: string): CommandResult {
  return { error: `${command}: not implemented`, exitCode: 1 };
}
