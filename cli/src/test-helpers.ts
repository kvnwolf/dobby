import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// SHARED TEST HELPERS — the seams the per-domain vitest suites (ship, release,
// review, tracker, …) build their fixtures from. This file is imported ONLY by
// `*.test.ts` and never by production code; it also NEVER ships (package.json's
// `files` allowlist negates `src/*.test.ts` AND `src/test-helpers.ts`).
//
// Two things live here:
//
//  1. STUB BINS ON PATH — the established seam for a tool dobby spawns BARE
//     (`gh`, `npm`, `cmux`, `curl`, …). A stub is an executable `/bin/sh` script
//     in a temp dir the test prepends to PATH, so a bare-name spawn resolves to
//     OUR script: it RECORDS its full argv into a log and optionally answers a
//     canned stdout/stderr/exit-code per invocation pattern. Network-adjacent
//     tools are testable only this way — `gh`/`npm` can't run for real in CI.
//
//     Log format (append-only, one record per invocation, in order):
//         "<argc>\n" followed by argc NUL-TERMINATED argument bytes
//     NUL is the one byte a POSIX argv can never contain, so an argument holding
//     spaces, quotes, or newlines round-trips VERBATIM — which is the whole point
//     for the injection-string assertions (a command built by string
//     concatenation would show up here as mangled argv).
//
//  2. SCRATCH GIT REPOS — a throwaway real repo under a PINNED git env (identity
//     + `GIT_CONFIG_GLOBAL=/dev/null` …), so a commit succeeds regardless of the
//     developer's ambient git setup (gpg signing, hooks, templates). Extracted
//     from `run.test.ts`'s local copy, which deliberately keeps its own.
//
// node:* only (ADR-0008): these run under vitest/Node as well as Bun.
// ---------------------------------------------------------------------------

/**
 * The per-test and per-hook budget every SPAWN-HEAVY suite here runs under, and
 * the value `vitest.base.mjs` ships as its ceiling — the two must agree.
 *
 * A CEILING, not a target: these suites build scratch repos and drive REAL tools
 * (git, biome, tsc, the CLI itself), the full run does 24 such files in parallel
 * across the cores, and the ambient environment moves the wall clock a long way —
 * the same suite that takes ~175s under a bare `vitest run` takes ~780s under
 * `bunx dobby check`. Vitest's defaults (5s / 10s) kill honest work there and
 * report it as `STACK_TRACE_ERROR`, which reads like a product bug.
 *
 * @public — applied per FILE via `useSpawnBudget()`.
 */
export const SPAWN_BUDGET_MS = 120_000;

/**
 * Put the CURRENT test file on the spawn budget, whatever config it was launched
 * with. The preset carries the same ceiling, but a config-LESS invocation never
 * reads it — `bunx vitest run src/release.test.ts` while debugging one suite gets
 * vitest's 5s default — so a suite that spawns real tools states its budget here
 * instead of relying on how it was started.
 *
 * Call it ONCE at module scope, above the fixtures.
 *
 * @public — every spawn-heavy suite's first line of body.
 */
export function useSpawnBudget(): void {
  vi.setConfig({
    hookTimeout: SPAWN_BUDGET_MS,
    testTimeout: SPAWN_BUDGET_MS,
  });
}

/**
 * The PINNED git environment every scratch-repo spawn runs under: a fixed
 * identity plus global/system config, hook, template and prompt isolation, so a
 * `git commit` can never be derailed by the developer's own git setup.
 *
 * Computed FRESH on every call (not a module-load snapshot) so a PATH the test
 * mutated meanwhile — `withStubPath` — is honored by the child too.
 *
 * @public — the env any test spawning git itself should pass.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_EMAIL: "test@dobby.invalid",
    GIT_AUTHOR_NAME: "dobby-test",
    GIT_COMMITTER_EMAIL: "test@dobby.invalid",
    GIT_COMMITTER_NAME: "dobby-test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Run git inside `root` under the pinned env and return its trimmed stdout — the
 * INDEPENDENT observer tests read git facts through (`log --oneline`,
 * `rev-parse HEAD^{tree}`, `status --porcelain`). THROWS on a nonzero exit: this
 * is test-side scaffolding, where a failed git call is a broken test, not data.
 *
 * @public — the git observer for the per-domain suites.
 */
export function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Build a THROWAWAY real git repo in a fresh temp dir, on a KNOWN branch, with
 * an initial commit — the fixture shape every command-level test needs (a
 * command that fails its git precondition never reaches the behavior under
 * test). Returns the realpath-normalized root, so comparing it against git's own
 * resolved paths never trips on macOS's /var → /private/var symlink.
 *
 * `pkg` / `config` accept either a VALUE (written as pretty JSON) or a STRING
 * (written verbatim — the deliberately-malformed-JSON case). `files` writes
 * arbitrary repo-relative files (parent dirs created). With `commit: false` the
 * tree is left dirty and unversioned instead.
 *
 * @public — the scratch-repo maker for the per-domain suites.
 */
export function makeScratchRepo(
  opts: {
    branch?: string;
    commit?: boolean;
    config?: unknown;
    files?: Record<string, string>;
    pkg?: unknown;
    prefix?: string;
    track?: string[];
  } = {}
): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), opts.prefix ?? "dobby-scratch-"))
  );
  opts.track?.push(dir);
  gitIn(dir, ["init", "-q"]);
  gitIn(dir, ["checkout", "-q", "-b", opts.branch ?? "main"]);

  const files = opts.files ?? {};
  const empty =
    Object.keys(files).length === 0 &&
    opts.pkg === undefined &&
    opts.config === undefined;
  if (empty) {
    // An initial commit needs SOMETHING staged; a repo asked for with no content
    // still has to be committable.
    writeRepoFile(dir, "README", "scratch\n");
  }
  for (const [relPath, content] of Object.entries(files)) {
    writeRepoFile(dir, relPath, content);
  }
  if (opts.pkg !== undefined) {
    writeRepoFile(dir, "package.json", asFileContent(opts.pkg));
  }
  if (opts.config !== undefined) {
    writeRepoFile(dir, "dobby.config.json", asFileContent(opts.config));
  }

  if (opts.commit !== false) {
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-q", "-m", "scratch"]);
  }
  return dir;
}

/**
 * Remove the temp dirs a suite collected (the `track` arrays the makers push
 * into) — the afterAll counterpart. Best-effort: an already-gone dir is fine.
 *
 * @public — cleanup for the per-domain suites.
 */
export function cleanupDirs(dirs: string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
}

// A canned answer for ONE invocation pattern of a stub bin. Matching is
// FIRST-WINS in declaration order; a response with no `match` is a catch-all
// (everything after it is unreachable).
export interface StubResponse {
  // The child's exit status (default 0).
  exitCode?: number;
  // LITERAL substring(s) of the argv joined by spaces (`"$*"`): the pattern's
  // bytes match themselves — `*`, `?` and `[…]` stand for THEMSELVES, never as
  // wildcards (only the `*…*` wrapped AROUND the pattern floats it). So
  // `"pr view --json *"` answers an argv literally containing a `*`, NOT
  // `pr view --json number`; express the latter as `["pr view", "--json"]`.
  // Several patterns = ALL must match (AND), each anywhere in the joined argv.
  match?: string | string[];
  // Written to the child's stderr VERBATIM.
  stderr?: string;
  // Written to the child's stdout VERBATIM (no trailing newline is added).
  stdout?: string;
}

/**
 * Create a fresh temp dir to hold stub bins (and their logs), registered in
 * `track` for cleanup. Prepend it to PATH with `stubPath`/`withStubPath`.
 *
 * @public — the stub-bin dir maker.
 */
export function mkStubBinDir(track?: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dobby-stubbin-")));
  track?.push(dir);
  return dir;
}

/**
 * Where a stub bin named `name` records its invocations: `<dir>/<name>.log`.
 * The convention a hand-written `script` must follow to stay readable by
 * `readStubLog`.
 *
 * @public — the log-path convention.
 */
export function stubLogPath(dir: string, name: string): string {
  return join(dir, `${name}.log`);
}

/**
 * Write an EXECUTABLE stub at `<dir>/<name>` so a bare-name spawn resolving
 * through PATH runs OUR script instead of the real tool. `script` is the shell
 * body (a `#!/bin/sh` shebang is prepended unless the text already carries one);
 * omitted, the stub is a pure RECORDER. Returns the stub's absolute path.
 *
 * @public — the raw escape hatch (custom shell behavior); `mkRecorderBin` is the
 * declarative form.
 */
export function mkStubBin(dir: string, name: string, script?: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const body =
    script === undefined ? recorderScript(dir, name, []) : withShebang(script);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Write a RECORDER stub at `<dir>/<name>`: every invocation appends its full
 * argv to `<dir>/<name>.log` (read it back with `readStubLog`), then the first
 * matching `responses` entry supplies stdout/stderr/exit code — e.g. answering
 * `gh pr view --json …` with a fixture payload. Recording happens FIRST, so an
 * invocation is logged whatever the canned answer does.
 *
 * @public — the stub-bin seam for gh/npm and any other bare tool.
 */
export function mkRecorderBin(
  dir: string,
  name: string,
  responses: StubResponse[] = []
): string {
  return mkStubBin(dir, name, recorderScript(dir, name, responses));
}

/**
 * Create a whole stub-bin dir in one call — `mkStubBins({ gh: [...], npm: [] })`
 * — returning the dir to prepend to PATH. Each key becomes a recorder bin with
 * its own log; an empty array is a pure recorder.
 *
 * @public — the one-liner every suite that stubs gh/npm starts from.
 */
export function mkStubBins(
  spec: Record<string, StubResponse[]>,
  track?: string[]
): string {
  const dir = mkStubBinDir(track);
  for (const [name, responses] of Object.entries(spec)) {
    mkRecorderBin(dir, name, responses);
  }
  return dir;
}

/**
 * The argv vectors a stub bin recorded, in invocation order (`[]` when it was
 * never called). Each vector is the child's arguments WITHOUT the program name,
 * byte-faithful: spaces, quotes and newlines inside one argument survive.
 *
 * @public — the assertion surface for "what did dobby actually run".
 */
export function readStubLog(dir: string, name: string): string[][] {
  const path = stubLogPath(dir, name);
  if (!existsSync(path)) {
    return [];
  }
  return parseStubLog(readFileSync(path));
}

/**
 * `dir` prepended to the CURRENT PATH — the value to assign to `process.env.PATH`
 * (or to a child's `env.PATH`) so the dir's stubs win over the real tools.
 *
 * @public — PATH composition for stub bins.
 */
export function stubPath(dir: string): string {
  const current = process.env.PATH ?? "";
  return current === "" ? dir : `${dir}${delimiter}${current}`;
}

/**
 * Run `fn` with `dir` prepended to `process.env.PATH`, restoring PATH afterwards
 * (even when `fn` throws). The IN-PROCESS `run(argv, cwd)` seam spawns children
 * off the PARENT's env, so this is how a stub bin reaches the code under test.
 *
 * @public — the PATH scope for in-process command tests.
 */
export async function withStubPath<T>(
  dir: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = stubPath(dir);
  try {
    return await fn();
  } finally {
    restoreEnv("PATH", original);
  }
}

/**
 * Restore an env var to a value captured before a slice mutated it — unset when
 * it was unset (`delete` is banned by the lint preset, hence Reflect).
 *
 * @public — the beforeAll/afterAll env dance.
 */
export function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = original;
  }
}

// --- internals -------------------------------------------------------------

// A repo-relative file plus any parent dirs it needs.
function writeRepoFile(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// A fixture value as file text: a STRING goes in verbatim (so a test can write
// deliberately malformed JSON), anything else is pretty-printed JSON.
function asFileContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// The shebang is the stub's whole reason to be executable; a caller-supplied
// script may bring its own (then it is used verbatim).
function withShebang(script: string): string {
  return script.startsWith("#!") ? script : `#!/bin/sh\n${script}\n`;
}

// The generated recorder: append ONE record (argc line + NUL-terminated args) to
// the log through a single redirection, then walk the canned responses.
//
// `printf '%s\0' "$@"` is the standard NUL-delimited idiom, but POSIX printf
// applies its format AT LEAST ONCE — with zero arguments it would emit a stray
// NUL and desync the parser, hence the `[ "$#" -eq 0 ] ||` guard.
function recorderScript(
  dir: string,
  name: string,
  responses: StubResponse[]
): string {
  const log = shQuote(stubLogPath(dir, name));
  const lines = [
    "#!/bin/sh",
    `# dobby test stub: ${name} (records argv, then answers canned responses)`,
    "{",
    `  printf '%s\\n' "$#"`,
    `  [ "$#" -eq 0 ] || printf '%s\\0' "$@"`,
    `} >> ${log}`,
  ];
  if (responses.length > 0) {
    lines.push('all="$*"');
    for (const response of responses) {
      lines.push(responseBlock(response));
    }
  }
  lines.push("exit 0", "");
  return lines.join("\n");
}

// One response as a shell statement: the canned body, wrapped in one `case` per
// match pattern (nested = AND). No patterns → an unconditional catch-all.
//
// The pattern is single-quoted (`shQuote`), which is what makes matching LITERAL
// (see `StubResponse.match`): inside '…' a `case` pattern's metacharacters lose
// their meaning, so only the `*` we add on each side floats the substring. That
// is deliberate — a pattern is written against argv the test also writes, and a
// stray `[` or `?` in either must never silently change which response fires.
function responseBlock(response: StubResponse): string {
  const patterns =
    response.match === undefined
      ? []
      : [response.match].flat().map((pattern) => shQuote(pattern));
  let block = responseBody(response);
  for (const pattern of patterns.reverse()) {
    block = `case "$all" in *${pattern}*) ${block} ;; esac`;
  }
  return block;
}

// The canned effect itself: write the payloads VERBATIM (printf '%s', never
// echo — no escape interpretation, no added newline) and exit.
function responseBody(response: StubResponse): string {
  const parts: string[] = [];
  if (response.stdout !== undefined) {
    parts.push(`printf '%s' ${shQuote(response.stdout)}`);
  }
  if (response.stderr !== undefined) {
    parts.push(`printf '%s' ${shQuote(response.stderr)} >&2`);
  }
  parts.push(`exit ${Math.trunc(response.exitCode ?? 0)}`);
  return `{ ${parts.join("; ")}; }`;
}

// Single-quote a value for the shell: inside '…' every byte is literal — for a
// word AND for a `case` pattern — and the only escape needed is the quote itself
// ('\'' closes, escapes, reopens).
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const NEWLINE = 0x0a;
const NUL = 0x00;

// Walk the append-only log: each record is an argc line followed by exactly that
// many NUL-terminated arguments. A truncated tail (a stub killed mid-write) is
// dropped rather than throwing — the recorded prefix is still the evidence.
function parseStubLog(buffer: Buffer): string[][] {
  const records: string[][] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf(NEWLINE, offset);
    if (lineEnd === -1) {
      break;
    }
    const count = Number.parseInt(buffer.toString("utf8", offset, lineEnd), 10);
    offset = lineEnd + 1;
    if (!Number.isInteger(count) || count < 0) {
      break;
    }
    const args: string[] = [];
    let truncated = false;
    for (let index = 0; index < count; index += 1) {
      const end = buffer.indexOf(NUL, offset);
      if (end === -1) {
        truncated = true;
        break;
      }
      args.push(buffer.toString("utf8", offset, end));
      offset = end + 1;
    }
    if (truncated) {
      break;
    }
    records.push(args);
  }
  return records;
}
