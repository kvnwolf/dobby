import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json";
import { runCapture } from "./runner.ts";

// THE GATE CACHE — the single owner of `.dobby/gate-cache.json`, behind five
// verbs. Everything about the file (its shape, its atomicity, the LRU, the
// ignore guarantee, the version/config stamp that invalidates it) lives here;
// no caller ever touches those bytes.
//
//   computeCodeHash(root)              the index-neutral CODE HASH of the
//                                      non-inert working tree, or null
//   consultGreenInputs(root, hash)     was this exact input set already proven
//                                      green under THIS dobby + THIS config?
//   recordGreenInput(root, hash)       remember it (LRU of 5, most-recent-first)
//   writeShipRecord(root, tree, exit)  `ship`'s flat record, greenInputs kept
//   ensureExcluded(root)               keep `.dobby/` out of git's sight — the
//                                      one verb a caller needs BEFORE it stages
//
// BOOKKEEPING NEVER TOUCHES A VERSIONED FILE. The ignore rule goes into
// `.git/info/exclude` — git's repo-local, UNVERSIONED ignore file — and never
// into `.gitignore`. A `check` is a READ of the developer's work: it is composed
// in-process by `release`, `preflight` and the pre-push backstop, each of which
// runs over a tree the developer expects to be exactly as they left it, and one
// of them (`release`) REFUSES to proceed on a dirty tree. Appending to
// `.gitignore` created (or modified) a tracked file behind the caller's back — a
// green gate that dirtied the tree it had just judged. `info/exclude` takes part in
// the same ignore machinery (`git check-ignore` honours it, and the
// `--exclude-standard` enumeration below skips what it excludes), so the
// GUARANTEE is unchanged while the cost to the working tree is nil.
//
// TWO RECORDS, ONE FILE (the additive shape). The five FLAT fields
// (`at`/`configHash`/`dobbyVersion`/`exitCode`/`treeHash`) are `ship`'s: the
// pre-push backstop's fast path reads them through `hook-install.ts`'s OWN
// reader, which this module never calls and never breaks — so both writers here
// preserve whatever the other left behind. `greenInputs` is the NEW per-check
// record: the code hashes a FULL green gate has already cleared.
//
// INDEX-NEUTRAL BY CONSTRUCTION (ADR-0017). `check` and the backstop compute the
// code hash on every run, so the enumeration is `git ls-files -c -o
// --exclude-standard` + `git hash-object --stdin-paths` — both of which only
// READ. Nothing here ever stages, writes to the index, or runs a mutating git
// command: a cache that rewrote what the developer is about to commit would be
// far worse than the gate run it saves. (`git write-tree`, the obvious shortcut,
// is exactly what this must not do — and it would miss untracked-but-unignored
// files, which the gate tools DO see.)
//
// EVERY DEGRADED STATE READS AS "NOTHING IS KNOWN": no git, no cache file, a
// malformed one, a stale stamp — all answer with null / a miss, whose cost is one
// honest gate run. Write failures come back as a NOTE, never a throw: the gate's
// verdict must never depend on dobby's bookkeeping succeeding.
//
// node:* + the shared runner only (ADR-0008) — vitest imports this under Node,
// Bun runs it in production.

// dobby's machine-state home and the cache inside it.
const STATE_DIR = ".dobby";
const CACHE_FILE = "gate-cache.json";

// git's repo-local ignore file, addressed the way git itself resolves it
// (`rev-parse --git-path`): in a LINKED WORKTREE that lands on the COMMON dir's
// copy, which is exactly right — one rule covers every worktree of the repo.
const EXCLUDE_FILE = "info/exclude";

// The project contract whose BYTES stamp the cache: editing it changes what the
// gate does to an unchanged tree (`checks[]` extras, doc-sync rules).
const CONFIG_FILE = "dobby.config.json";

// How many green input sets are remembered. Branch switching and reverts return
// to trees already proven green, so keeping only the latest would lose those
// hits; five costs well under a kilobyte.
const GREEN_INPUT_LIMIT = 5;

// NUL — the one byte a path can never contain, so it does double duty: it is what
// `git ls-files -z` delimits its RAW (unquoted) path list with, and what separates
// a pair's path from its blob oid unambiguously in the hashed serialization.
// Spelled as a code point rather than an escape so the source file itself stays
// plain text.
const PAIR_SEPARATOR = String.fromCodePoint(0);

// The byte that makes a `--stdin-paths` line a C-QUOTED path rather than a literal
// one. A leading double quote is git's own escape marker there, so a path that
// starts with one is ambiguous by construction (see `enumerateInputs`).
const C_QUOTE_PREFIX = String.fromCodePoint(34);

// One remembered green input set: the code hash, and when the gate cleared it.
interface GreenInput {
  at: string;
  hash: string;
}

// `ship`'s flat record — the three fields that describe ONE gated tree. `at` is
// carried as `string | undefined` (rather than required) so a record missing only
// its timestamp still keeps the backstop's verdict alive.
interface FlatRecord {
  at: string | undefined;
  exitCode: number;
  treeHash: string;
}

// The file as it is WRITTEN. Every field is optional because the two records are
// independent: a `check` that has only ever recorded green inputs writes no
// `treeHash`/`exitCode` at all (inventing one would hand the pre-push backstop a
// free pass on a tree nothing ever gated), and a project that ships no
// `dobby.config.json` writes an explicit null `configHash`. `JSON.stringify`
// drops the undefined ones, so the serialized file holds exactly what is known.
interface GateCacheFile {
  at?: string;
  configHash?: string | null;
  dobbyVersion?: string;
  exitCode?: number;
  greenInputs?: GreenInput[];
  treeHash?: string;
}

// The file as it was READ — already validated, so callers never re-type-check it.
// The stamp pair is non-optional here: a file whose `dobbyVersion`/`configHash`
// cannot be read is not a cache this dobby can reason about at all.
interface StoredCache {
  configHash: string | null;
  dobbyVersion: string;
  flat: FlatRecord | null;
  greenInputs: GreenInput[];
}

// The answer to a consult: a hit carries WHEN the tree was proven green (the note
// `check` prints), a miss carries nothing.
interface GreenInputVerdict {
  at: string | null;
  hit: boolean;
}

/**
 * The CODE HASH of `root`'s working tree: a content key over every file a gate
 * step could possibly read, and nothing else.
 *
 * Enumerate `git ls-files -c -o --exclude-standard` (tracked + untracked-unignored
 * — the set the tools actually see, and the set `git write-tree` would get wrong),
 * drop the INERT ones (`isInert`), content-hash the survivors with a single `git
 * hash-object --stdin-paths`, then sha256 over the sorted `(path, blob-oid)`
 * PAIRS. The path is part of the pair, so a rename or a swap of two files' bytes
 * changes the key even though the blob set did not; a tracked file missing from
 * the worktree is excluded from the pair set, so a deletion changes it too.
 *
 * Null when the tree cannot be enumerated at all (not a git repository, git
 * absent, an unreadable path list) — the caller reads that as "run everything".
 * Never throws, never stages, never writes: the git state is byte-identical after
 * this call.
 *
 * @public — consumed by `check.ts` (the gate cache's key).
 */
export function computeCodeHash(root: string): string | null {
  const paths = enumerateInputs(root);
  if (paths === null) {
    return null;
  }
  const oids = hashObjects(root, paths);
  if (oids === null) {
    return null;
  }
  const digest = createHash("sha256");
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const oid = oids[index];
    if (path === undefined || oid === undefined) {
      return null;
    }
    // NUL inside the pair, newline between pairs: neither byte can occur in a
    // path that reached this point (`enumerateInputs` drops the newline case), so
    // no two distinct pair sets can serialize to the same bytes.
    digest.update(`${path}${PAIR_SEPARATOR}${oid}\n`);
  }
  return digest.digest("hex");
}

/**
 * Was `hash` already proven green — under THIS dobby version and THIS
 * `dobby.config.json`? A hit carries the timestamp of that green run.
 *
 * The two file-level stamps invalidate GLOBALLY: a dobby upgrade brings new rules
 * and new tools, a config edit brings new `checks[]` extras — both change what the
 * gate DOES to an unchanged tree, so every remembered entry becomes meaningless at
 * once. Read-only by contract: a mismatching cache is left exactly as it was found
 * (the next `recordGreenInput` is what rewrites it).
 *
 * Any degraded state — no file, malformed JSON, a pre-upgrade flat-only record —
 * is a miss, never an error.
 *
 * @public — consumed by `check.ts` before it plans a full gate run.
 */
export function consultGreenInputs(
  root: string,
  hash: string
): GreenInputVerdict {
  const stored = readCache(root);
  if (
    stored === null ||
    stored.dobbyVersion !== pkg.version ||
    stored.configHash !== currentConfigHash(root)
  ) {
    return { at: null, hit: false };
  }
  const entry = stored.greenInputs.find((green) => green.hash === hash);
  return entry === undefined
    ? { at: null, hit: false }
    : { at: entry.at, hit: true };
}

/**
 * Remember `hash` as proven green: a read-modify-write that moves the hash to the
 * FRONT of the LRU (re-recording a known one promotes it rather than duplicating
 * it), caps the list at five and evicts from the tail. `ship`'s flat record is
 * carried through untouched, and the file-level stamps are refreshed to the
 * running dobby + the current config.
 *
 * Returns a human-readable NOTE when the cache could not be written (an
 * unwritable `.dobby/`, a full disk), or null on success — it never throws: a
 * green gate stays green even when its bookkeeping fails.
 *
 * @public — consumed by `check.ts` after a full gate exits 0.
 */
export function recordGreenInput(root: string, hash: string): string | null {
  ensureExcluded(root);
  const configHash = currentConfigHash(root);
  const carried = carryForward(root, configHash);
  return writeCache(root, {
    at: carried.flat?.at,
    configHash,
    dobbyVersion: pkg.version,
    exitCode: carried.flat?.exitCode,
    greenInputs: promote(carried.greenInputs, hash),
    // Only `ship` ever names a tree (it gates a STAGED one). `check` judges a
    // WORKING tree that may differ from any commit, so the flat record is only
    // ever passed through here — never invented.
    treeHash: carried.flat?.treeHash,
  });
}

/**
 * Write `ship`'s flat record for the tree it just gated — the pre-push backstop's
 * fast-path contract, byte-compatible with what ship has always written — while
 * PRESERVING the green inputs `check` recorded alongside it.
 *
 * `exitCode` is written as given (ship only ever caches a green one, but the
 * verdict is the caller's to state, never this module's to assume).
 *
 * Returns a failure note or null, on the same never-throws contract as
 * `recordGreenInput`.
 *
 * @public — consumed by `ship.ts` after a green commit gate.
 */
export function writeShipRecord(
  root: string,
  treeHash: string,
  exitCode: number
): string | null {
  ensureExcluded(root);
  const configHash = currentConfigHash(root);
  const { greenInputs } = carryForward(root, configHash);
  return writeCache(root, {
    at: new Date().toISOString(),
    configHash,
    dobbyVersion: pkg.version,
    exitCode,
    greenInputs: greenInputs.length === 0 ? undefined : greenInputs,
    treeHash,
  });
}

// --- the code hash ----------------------------------------------------------

// Repo-relative path prefixes no gate step reads: the kit's durable artifacts and
// the host's own session directory. Anchored at the root, exactly as the inert set
// is written (`docs/**`, `.claude/**`) — a `docs/` nested inside a package is
// somebody's source tree until the set says otherwise.
const INERT_PREFIXES: readonly string[] = ["docs/", ".claude/"];

// The one place markdown IS an input: a fixture directory, whose `.md` files are
// read BY tests. Matched as a path SEGMENT at any depth (`**/__fixtures__/**`).
const FIXTURE_SEGMENTS: ReadonlySet<string> = new Set([
  "__fixtures__",
  "fixtures",
]);

const MARKDOWN_SUFFIX = ".md";

// Whether a repo-relative path is INERT — a file no gate step can see, so editing
// it must not invalidate a green verdict. The set is deliberately CONSERVATIVE:
// prose (`**/*.md`), the durable artifacts (`docs/**`) and the host's session
// directory (`.claude/**`), minus the fixture exception. Everything else counts,
// including the three files it would be tempting to drop — `.gitignore` (it
// decides what the enumeration above even sees), `package.json` and `bun.lock`
// (they drive capability detection and preset choice, so they change what the gate
// RUNS).
function isInert(relPath: string): boolean {
  if (INERT_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
    return true;
  }
  if (!relPath.toLowerCase().endsWith(MARKDOWN_SUFFIX)) {
    return false;
  }
  return !relPath.split("/").some((segment) => FIXTURE_SEGMENTS.has(segment));
}

// The non-inert input paths of `root`, sorted, or null when git cannot enumerate
// the tree (not a repository, git absent).
//
// `-c -o --exclude-standard` is the tracked ∪ untracked-unignored set — the files
// biome/tsc/knip/vitest actually read — and `-z` keeps paths RAW (git's default
// output C-QUOTES unusual bytes; the raw form is both what the pair set must key
// on and what the guards below can inspect).
//
// Paths are then dropped in three cases. The first only costs a file; the other two
// are `--stdin-paths` LINE-FORMAT hazards that poison the whole key, so they answer
// null — one honest gate run is always safe, a key computed from a misread path
// list is not:
//   - anything that is not a readable regular FILE right now — a tracked file
//     deleted from the worktree (its absence is what changes the hash), a broken
//     symlink, a submodule's gitlink. Left in, it would abort the whole batch and
//     degrade an honest tree to "no key";
//   - a path containing a NEWLINE, which `--stdin-paths` (one path per line) cannot
//     express at all;
//   - a path whose first byte is a DOUBLE QUOTE, which `--stdin-paths` C-UNQUOTES:
//     git reads the line `"foo.ts"` as the path `foo.ts` (verified out of band —
//     the two files hash to different oids, and the quoted-name file gets the
//     plain one's). That is the dangerous failure, not a missing key but a WRONG
//     one: the pair would freeze against every edit to that file, and `check` would
//     take a cache hit on a tree it never gated. (Only a LEADING quote unquotes —
//     `a"b.ts` round-trips — so the guard is exactly that.)
function enumerateInputs(root: string): string[] | null {
  const listed = runCapture(
    "git",
    ["ls-files", "-c", "-o", "--exclude-standard", "-z"],
    { root }
  );
  if (listed.error || listed.status !== 0) {
    return null;
  }
  // A Set because `ls-files -c` repeats a path once per stage while a merge is
  // unmerged; the hash must not depend on that transient shape.
  const paths = new Set<string>();
  for (const path of listed.stdout.split(PAIR_SEPARATOR)) {
    if (path === "" || isInert(path)) {
      continue;
    }
    if (path.includes("\n") || path.startsWith(C_QUOTE_PREFIX)) {
      return null;
    }
    if (isReadableFile(root, path)) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

// git's own content hash for each path, in the SAME ORDER (verified out of band:
// `hash-object --stdin-paths` answers one oid per input line, in input order). ONE
// spawn for the whole tree — per-file spawns would cost more than the gate run
// this saves. Null when git could not hash the batch, or answered with a different
// number of oids than it was given paths.
//
// Takes ONLY paths `enumerateInputs` has cleared: `--stdin-paths` reads each line
// as a possibly C-quoted path, so a newline or a leading quote must never get this
// far (a mis-read line would pair a path with ANOTHER file's oid, silently).
function hashObjects(root: string, paths: string[]): string[] | null {
  if (paths.length === 0) {
    return [];
  }
  const hashed = runCapture("git", ["hash-object", "--stdin-paths"], {
    input: `${paths.join("\n")}\n`,
    root,
  });
  if (hashed.error || hashed.status !== 0) {
    return null;
  }
  const oids = hashed.stdout.split("\n").filter((line) => line !== "");
  return oids.length === paths.length ? oids : null;
}

// Whether `relPath` is something `git hash-object` can read right now: a regular
// file (following symlinks, as hash-object does). Anything else — absent,
// directory, unreadable — is excluded from the pair set.
function isReadableFile(root: string, relPath: string): boolean {
  try {
    return (
      statSync(join(root, relPath), { throwIfNoEntry: false })?.isFile() ===
      true
    );
  } catch {
    return false;
  }
}

// --- the cache file ---------------------------------------------------------

function cacheDir(root: string): string {
  return join(root, STATE_DIR);
}

function cachePath(root: string): string {
  return join(cacheDir(root), CACHE_FILE);
}

// Read + validate the cache. EVERY failure — absent, unreadable, unparseable, not
// an object, a stamp pair this dobby cannot type — is null, which every caller
// reads as "nothing is known about this tree". A malformed file is therefore not
// an error but a full gate run plus a fresh write.
function readCache(root: string): StoredCache | null {
  let raw: string;
  try {
    raw = readFileSync(cachePath(root), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { configHash, dobbyVersion } = record;
  // `configHash` is legitimately null (a project with no `dobby.config.json`);
  // anything else typed is a cache this dobby cannot reason about.
  if (
    typeof dobbyVersion !== "string" ||
    (configHash !== null && typeof configHash !== "string")
  ) {
    return null;
  }
  return {
    configHash,
    dobbyVersion,
    flat: flatRecordOf(record),
    greenInputs: greenInputsOf(record),
  };
}

// `ship`'s flat record, when the file carries a usable one. The verdict PAIR is
// what makes it usable: a `treeHash` with no `exitCode` says nothing about that
// tree. `at` is decoration by comparison, so a missing one costs only itself.
function flatRecordOf(record: Record<string, unknown>): FlatRecord | null {
  const { at, exitCode, treeHash } = record;
  if (typeof treeHash !== "string" || typeof exitCode !== "number") {
    return null;
  }
  return { at: typeof at === "string" ? at : undefined, exitCode, treeHash };
}

// The remembered green inputs, in file order, entry by entry: anything that is not
// a `{hash, at}` pair of strings is dropped rather than failing the whole read (a
// file half-written by a future dobby still yields its usable entries). Capped on
// READ as well as on write, so a hand-edited file cannot grow the LRU.
function greenInputsOf(record: Record<string, unknown>): GreenInput[] {
  const { greenInputs } = record;
  if (!Array.isArray(greenInputs)) {
    return [];
  }
  const entries: GreenInput[] = [];
  for (const candidate of greenInputs) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const { at, hash } = candidate as Record<string, unknown>;
    if (typeof hash === "string" && hash !== "" && typeof at === "string") {
      entries.push({ at, hash });
    }
  }
  return entries.slice(0, GREEN_INPUT_LIMIT);
}

// What survives a rewrite: the records the CURRENT dobby + config still vouch for.
//
// A stamp mismatch drops BOTH records rather than carrying them under the new
// stamp — that is the whole point of the file-level invalidation. Carrying a green
// input across a dobby upgrade would resurrect a verdict this version never gave;
// carrying `ship`'s flat record would hand the pre-push backstop (which checks the
// same stamps) a free pass on a tree the new dobby never gated.
function carryForward(
  root: string,
  configHash: string | null
): { flat: FlatRecord | null; greenInputs: GreenInput[] } {
  const stored = readCache(root);
  if (
    stored === null ||
    stored.dobbyVersion !== pkg.version ||
    stored.configHash !== configHash
  ) {
    return { flat: null, greenInputs: [] };
  }
  return { flat: stored.flat, greenInputs: stored.greenInputs };
}

// The LRU move-to-front: `hash` becomes the newest entry (its previous position,
// if any, is dropped — a promotion, never a duplicate), and the list is trimmed
// from the TAIL, which is where the least recently proven tree sits.
function promote(entries: GreenInput[], hash: string): GreenInput[] {
  const rest = entries.filter((entry) => entry.hash !== hash);
  return [{ at: new Date().toISOString(), hash }, ...rest].slice(
    0,
    GREEN_INPUT_LIMIT
  );
}

// A temp-file suffix unique within this process (the pid separates processes).
let writeCounter = 0;

// Write the cache ATOMICALLY: serialize, write a temp file in the SAME directory
// (a rename is only atomic within one filesystem), then rename it over the target.
// A reader — this module, or the pre-push backstop's independent one — therefore
// sees either the old file or the new one, never a half-written mixture, even when
// a manual `check` and a `ship` write at the same moment in one worktree.
//
// Returns a note naming the failure instead of throwing, and takes the temp file
// with it: `.dobby/` holds the cache and nothing else.
function writeCache(root: string, record: GateCacheFile): string | null {
  const dir = cacheDir(root);
  writeCounter += 1;
  const temp = join(dir, `.${CACHE_FILE}.${process.pid}.${writeCounter}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, cachePath(root));
  } catch (error) {
    discard(temp);
    return `gate cache not written: ${describe(error)}`;
  }
  return null;
}

// Remove a temp file a failed write may have left behind. Best-effort by
// definition — this runs on the path where writing already failed.
function discard(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing left to do: the note the caller returns is the whole report.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// sha256 of the project's `dobby.config.json` BYTES (never a re-serialization —
// the file's own bytes are what a later run compares against), or null when the
// project ships none. The same computation `hook-install.ts`'s backstop reader
// makes, so a file written here and read there agrees byte for byte.
function currentConfigHash(root: string): string | null {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Keep the machine-state home out of git's sight — the guarantee that makes the
 * cache invisible. It matters twice over: an un-ignored cache file would be
 * committed, AND it would enter the very code hash it records, a key that could
 * never match again.
 *
 * The rule is written to `.git/info/exclude`, NEVER to `.gitignore`: bookkeeping
 * must not touch a VERSIONED file. `.gitignore` is somebody's tracked content —
 * appending to it (or creating it) turned every in-process `check` into a tree
 * mutation, which the callers that gate a tree they must not disturb (`release`,
 * `preflight`, the pre-push backstop) saw as their own dirt. `info/exclude` is
 * repo-local and unversioned, lives in the COMMON git dir (so one rule covers
 * every linked worktree), and feeds the same ignore machinery — `git
 * check-ignore` honours it, and `git ls-files --exclude-standard` (the
 * enumeration `computeCodeHash` keys on) skips what it excludes. Nothing here is
 * a working-tree file, so the write cannot move the hash it is about to record.
 *
 * Idempotent and best-effort: an unwritable exclude file (or a `root` git cannot
 * resolve one for) costs nothing but a permanent miss, and the gate run it causes
 * is always safe.
 *
 * @public — both writers above call it, and `ship.ts` calls it DIRECTLY: it stages
 * the whole tree before it records anything, so the rule has to exist BEFORE the
 * sweep, not when the record is finally written.
 */
export function ensureExcluded(root: string): void {
  const path = excludeFilePath(root);
  if (path === null) {
    return;
  }
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No exclude file yet — appending below creates it.
  }
  const present = raw
    .split("\n")
    .some(
      (line) => line.trim() === `${STATE_DIR}/` || line.trim() === STATE_DIR
    );
  if (present) {
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const prefix = raw === "" || raw.endsWith("\n") ? "" : "\n";
    appendFileSync(path, `${prefix}${STATE_DIR}/\n`);
  } catch {
    // Best-effort: an unwritable exclude file never fails a gate run.
  }
}

// Where THIS repository keeps its local exclude file, asked of git itself
// (`rev-parse --git-path info/exclude`) rather than assembled from `.git/`: a
// linked worktree's git dir is `.git/worktrees/<name>`, yet git resolves
// `info/exclude` against the COMMON dir, and a `.git` FILE (a worktree, a
// submodule) is not a directory to join onto at all. The answer is relative to
// the process cwd — pinned to `root` — so it is resolved against `root`; an
// absolute answer (the worktree case) wins on its own.
//
// Null when git cannot answer (not a repository, git absent), which the caller
// reads as "no rule to write" — the same degraded-is-a-miss contract as the rest
// of this module.
function excludeFilePath(root: string): string | null {
  const located = runCapture("git", ["rev-parse", "--git-path", EXCLUDE_FILE], {
    root,
  });
  if (located.error || located.status !== 0) {
    return null;
  }
  const answer = located.stdout.trim();
  return answer === "" ? null : resolve(root, answer);
}
