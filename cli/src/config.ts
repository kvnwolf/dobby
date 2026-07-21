import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The SOLE reader of `dobby.config.json`. Pure over its `root` argument, node:*
// imports only (vitest imports it under Node/Vite), and deliberately tolerant:
// it returns data describing what it found rather than throwing, so callers with
// different needs (an action command that must fail on a broken config vs `env`
// which must never fail) each decide their own reaction.

// The dobby.config.json schema (post-shrink): doc-sync `files[]` plus optional
// `setup[]` / `teardown[]` / `checks[]` extras that run in addition to the
// capability-inferred defaults. Every field is optional — an empty `{}` is a
// valid config. `env` observes only presence + parseability; the commands that
// consume the fields (e.g. the `check` gate reads `checks[]`, and `up`'s setup
// phase reads `setup[]`) import this type.
export interface DobbyConfig {
	files?: Array<{ path: string; update_when: string[] }>;
	setup?: string[];
	teardown?: string[];
	checks?: Array<{ name: string; run: string }>;
}

// The outcome of loading dobby.config.json:
//  - `null`          — no dobby.config.json at the root (the common, expected case).
//  - `{ ok: false }` — the file exists but is unparseable; `error` is a clear,
//    caller-presentable message. Action commands surface this and fail; `env`
//    treats it as config:false.
//  - `{ ok: true }`  — parsed successfully; `config` carries the schema.
export type ConfigLoad =
	| { ok: true; config: DobbyConfig }
	| { ok: false; error: string };

// Read + parse `<root>/dobby.config.json`. Never throws: a missing file is a
// `null` result; an unparseable file is an `{ ok: false, error }` result naming
// the file. Valid JSON parses into `{ ok: true, config }` (all schema fields are
// optional, so any parseable object is accepted as-is in this task).
export function loadConfig(root: string): ConfigLoad | null {
	const configPath = join(root, "dobby.config.json");
	if (!existsSync(configPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `could not read ${configPath}: ${detail}` };
	}

	try {
		return { ok: true, config: JSON.parse(raw) as DobbyConfig };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `could not parse ${configPath}: ${detail}` };
	}
}
