#!/usr/bin/env bun
import { run } from "./run.ts";

const { exitCode, stdout, stderr } = await run(process.argv.slice(2), process.cwd());
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);
