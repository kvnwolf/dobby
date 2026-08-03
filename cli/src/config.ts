import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The SOLE reader of `dobby.config.json`. Pure over its `root` argument, node:*
// imports only (vitest imports it under Node/Vite), and deliberately tolerant:
// it returns data describing what it found rather than throwing, so callers with
// different needs (an action command that must fail on a broken config vs `env`
// which must never fail) each decide their own reaction.

// The accepted `tracker.type` / `release.type` values. Kept as `as const` tuples
// so the union types AND the error messages that enumerate them derive from ONE
// source (an accepted value can never drift out of the message that lists it).
const TRACKER_TYPES = ["github", "linear", "local"] as const;
const RELEASE_TYPES = ["npm", "homebrew-cask"] as const;

type TrackerType = (typeof TRACKER_TYPES)[number];
type ReleaseType = (typeof RELEASE_TYPES)[number];

// Where the session's issues live. `type` is the only required field; `team` is
// Linear's non-inferable (GitHub/local derive everything from the repo itself).
interface TrackerConfig {
  team?: string;
  type: TrackerType;
}

// How this project ships. `type` is required; everything else is the
// non-inferable per channel — npm: `dir` (the publishable package dir),
// `lockstep` (surfaces whose versions move together), `surfaces` (name →
// version-carrying file) and `smoke` (the post-publish proof, below);
// homebrew-cask: `tap` + `cask`, plus the OPTIONAL `notaryProfile`.
//
// `smoke` is an ARGV ARRAY (`[program, ...args]`), never a shell string: it is
// spawned through the runner like every other child, so a value carrying spaces
// or quotes reaches the program as ONE argument and there is no shell to harden
// against. It runs only AFTER the registry serves the published version, and it
// is the only step that proves the published ARTIFACT works rather than that its
// metadata exists.
//
// `notaryProfile` is the NAME of a notarytool KEYCHAIN PROFILE (created once by
// hand: `xcrun notarytool store-credentials <name> --apple-id … --team-id …`) —
// an opaque string this loader never interprets, and the ONLY credential fact
// dobby ever holds: the Apple ID and its app-specific password stay in the
// keychain, never in the environment. Its PRESENCE is what opts a homebrew-cask
// release into notarization; an absent key is the un-notarized flow, never an
// error.
interface ReleaseConfig {
  cask?: string;
  dir?: string;
  lockstep?: string[];
  notaryProfile?: string;
  smoke?: string[];
  surfaces?: Record<string, string>;
  tap?: string;
  type: ReleaseType;
}

// The dobby.config.json schema (post-shrink): doc-sync `files[]` plus optional
// `setup[]` / `teardown[]` / `checks[]` extras that run in addition to the
// capability-inferred defaults, plus the two session keys — `tracker` (which
// issue tracker the session commands talk to) and `release` (whose presence
// gates the release command). Every field is optional — an empty `{}` is a
// valid config. `env` observes only presence + parseability; the commands that
// consume the fields (e.g. the `check` gate reads `checks[]`, and `up`'s setup
// phase reads `setup[]`) import this type.
export interface DobbyConfig {
  checks?: Array<{ name: string; run: string }>;
  files?: Array<{ path: string; update_when: string[] }>;
  release?: ReleaseConfig;
  setup?: string[];
  teardown?: string[];
  tracker?: TrackerConfig;
}

// The outcome of loading dobby.config.json:
//  - `null`          — no dobby.config.json at the root (the common, expected case).
//  - `{ ok: false }` — the file exists but is unparseable, or its `tracker` /
//    `release` key is malformed; `error` is a clear, caller-presentable message
//    naming the offending key. Action commands surface this and fail; `env`
//    treats it as config:false.
//  - `{ ok: true }`  — parsed successfully; `config` carries the schema.
export type ConfigLoad =
  | { ok: true; config: DobbyConfig }
  | { ok: false; error: string };

// A JSON object (not an array, not null) — the shape both validated keys must
// have. `typeof [] === "object"`, so the array exclusion is load-bearing:
// `surfaces` is a name → path map and can never be a list.
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

// Returns the caller-presentable problem with `tracker`, or null when it is fine.
function trackerError(value: unknown): string | null {
  if (!isJsonObject(value)) {
    return "tracker must be an object";
  }
  if (!isOneOf(value.type, TRACKER_TYPES)) {
    return `tracker.type must be one of: ${TRACKER_TYPES.join(", ")}`;
  }
  if (value.team !== undefined && typeof value.team !== "string") {
    return "tracker.team must be a string";
  }
  return null;
}

// Returns the caller-presentable problem with `release`, or null when it is fine.
function releaseError(value: unknown): string | null {
  if (!isJsonObject(value)) {
    return "release must be an object";
  }
  if (!isOneOf(value.type, RELEASE_TYPES)) {
    return `release.type must be one of: ${RELEASE_TYPES.join(", ")}`;
  }
  for (const key of ["cask", "dir", "notaryProfile", "tap"] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") {
      return `release.${key} must be a string`;
    }
  }
  if (value.lockstep !== undefined && !Array.isArray(value.lockstep)) {
    return "release.lockstep must be an array of surface names";
  }
  // An argv ARRAY, never a shell string — the adapter spawns it directly.
  if (
    value.smoke !== undefined &&
    (!Array.isArray(value.smoke) ||
      value.smoke.some((entry) => typeof entry !== "string"))
  ) {
    return "release.smoke must be an argv array of strings — the program, then its arguments (never a shell string)";
  }
  if (value.surfaces !== undefined && !isJsonObject(value.surfaces)) {
    return "release.surfaces must be an object mapping a name to a file path";
  }
  return null;
}

// Validation is SCOPED to `tracker` + `release` — the two keys whose shape a
// command branches on. Everything else stays blind-cast (a malformed `checks`
// or an unknown forward-compat key still loads), so this is deliberately NOT a
// general validator. A present-but-malformed key is the only rejection; an
// absent key passes through untouched. Returns null when there is nothing to
// complain about.
function schemaError(parsed: unknown): string | null {
  if (!isJsonObject(parsed)) {
    return null;
  }
  if (parsed.tracker !== undefined) {
    const error = trackerError(parsed.tracker);
    if (error !== null) {
      return error;
    }
  }
  if (parsed.release !== undefined) {
    return releaseError(parsed.release);
  }
  return null;
}

// Read + parse `<root>/dobby.config.json`. Never throws: a missing file is a
// `null` result; an unparseable file — or one whose `tracker`/`release` key is
// malformed — is an `{ ok: false, error }` result naming the file (parse) or the
// offending key (schema). Anything else parses into `{ ok: true, config }`.
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
    return { error: `could not read ${configPath}: ${detail}`, ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `could not parse ${configPath}: ${detail}`, ok: false };
  }

  const invalid = schemaError(parsed);
  if (invalid !== null) {
    return { error: `invalid ${configPath}: ${invalid}`, ok: false };
  }

  return { config: parsed as DobbyConfig, ok: true };
}
