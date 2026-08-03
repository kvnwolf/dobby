#!/usr/bin/env bun
import { runDev } from "./lifecycle.ts";
import { run } from "./run.ts";
import { isLiveDev } from "./tasks.ts";

// The bin adapter. Two concessions to the otherwise logic-free adapter:
//
// (1) The STREAMING SPLIT: a live `dobby dev` manages a concurrent process group —
//     the portless-wrapped app main plus its secondaries — with signal forwarding,
//     spawning with INHERITED stdio and living until the group exits or a signal
//     arrives. That cannot flow through run()'s synchronous capture seam, so the
//     bin owns it directly (via lifecycle's runDev). The split fires ONLY on a
//     CLEAN live-dev argv — the `dev` positional with NO flags — decided by the
//     PURE `isLiveDev` (tasks.ts, where it is unit-testable). Everything else —
//     every finite command, `dev --dry-run`, AND any flagged dev — routes through
//     run() (the capture path), so vitest can exercise it in-process AND run()'s
//     strict parseArgs stays the single flag validator: an unknown flag such as
//     `--no-share` exits 1 with the usage instead of being silently swallowed by
//     the stream.
//
// (2) `check --hook` needs the PostToolUse payload on stdin, `check --pre-push`
//     needs git's ref lines there (the pre-push hook pipes them in — without this
//     the backstop would see nothing and wave every push through), and the
//     `--stdin` commands (`state set` / `state append-worklog`) take their BODY
//     there; when any of those flags is present we drain process stdin and pass it
//     as run()'s third argument. All are explicit opt-ins, so dobby never blocks
//     on a stdin nobody piped to.
const argv = process.argv.slice(2);

if (isLiveDev(argv)) {
  process.exit(await runDev(process.cwd()));
}

const STDIN_FLAGS = ["--hook", "--pre-push", "--stdin"];

const stdin = STDIN_FLAGS.some((flag) => argv.includes(flag))
  ? await readStdin()
  : undefined;

const { exitCode, stdout, stderr } = await run(argv, process.cwd(), stdin);
if (stdout) {
  process.stdout.write(stdout);
}
if (stderr) {
  process.stderr.write(stderr);
}
process.exit(exitCode);

// Read all of process stdin as a UTF-8 string. Event-based (not async-iteration)
// so a closed/empty stdin resolves to "" rather than hanging.
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
