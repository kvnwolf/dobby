#!/usr/bin/env bun
import { runDev } from "./lifecycle.ts";
import { run } from "./run.ts";

// The bin adapter. Two concessions to the otherwise logic-free adapter:
//
// (1) The STREAMING SPLIT: a live `dobby dev` (no --dry-run) manages a concurrent
//     process group — the portless-wrapped app main plus its secondaries — with
//     signal forwarding, spawning with INHERITED stdio and living until the group
//     exits or a signal arrives. That cannot flow through run()'s synchronous
//     capture seam, so the bin owns it directly (via lifecycle's runDev).
//     Everything else — every finite command AND `dev --dry-run` — routes through
//     run() (the capture path) unchanged, so vitest can exercise it in-process.
//
// (2) `check --hook` needs the PostToolUse payload on stdin; when --hook is present
//     we drain process stdin and pass it as run()'s third argument.
const argv = process.argv.slice(2);

if (isLiveDev(argv)) {
	process.exit(await runDev(process.cwd()));
}

const stdin = argv.includes("--hook") ? await readStdin() : undefined;

const { exitCode, stdout, stderr } = await run(argv, process.cwd(), stdin);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);

// A live `dobby dev` is the `dev` command WITHOUT --dry-run. `dev --dry-run` stays
// on the capture path (run() prints the plan); every non-dev command is finite.
// The command is the first positional (ignoring any leading flags).
function isLiveDev(args: string[]): boolean {
	const command = args.find((arg) => !arg.startsWith("-"));
	return command === "dev" && !args.includes("--dry-run");
}

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
