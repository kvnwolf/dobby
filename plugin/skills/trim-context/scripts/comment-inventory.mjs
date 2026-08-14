#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "./vendor/web-tree-sitter/web-tree-sitter.js";

const here = dirname(fileURLToPath(import.meta.url));
const vendorRoot = resolve(here, "vendor");

// One grammar file per supported extension; see vendor/PROVENANCE.md for exact
// package/version/license/SHA-256 of every vendored asset. `.cjs` reuses the
// JavaScript grammar and `.mts`/`.cts` reuse the TypeScript grammar — same syntax
// for comment purposes as their `.js`/`.ts` siblings, so no extra vendored asset
// is needed to cover them.
const grammarFiles = {
  ".cjs": "tree-sitter-javascript.wasm",
  ".css": "tree-sitter-css.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".html": "tree-sitter-html.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".sh": "tree-sitter-bash.wasm",
  ".sql": "tree-sitter-sql.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
};

// Per grammar, the node type(s) that represent an actual source comment. SQL also
// carries "keyword_comment"/"comment_statement" for the `COMMENT ON ...` DDL statement,
// which is executable SQL, not a comment, so it is deliberately excluded.
const commentTypesByExtension = {
  ".cjs": new Set(["comment", "hash_bang_line", "html_comment"]),
  ".css": new Set(["comment", "js_comment"]),
  ".cts": new Set(["comment", "hash_bang_line", "html_comment"]),
  ".html": new Set(["comment"]),
  ".js": new Set(["comment", "hash_bang_line", "html_comment"]),
  ".jsx": new Set(["comment", "hash_bang_line", "html_comment"]),
  ".mjs": new Set(["comment", "hash_bang_line", "html_comment"]),
  ".mts": new Set(["comment", "hash_bang_line", "html_comment"]),
  ".sh": new Set(["comment"]),
  ".sql": new Set(["comment", "marginalia"]),
  ".ts": new Set(["comment", "hash_bang_line", "html_comment"]),
  ".tsx": new Set(["comment", "hash_bang_line", "html_comment"]),
};

const supported = new Set(Object.keys(grammarFiles));

// Static, hardcoded facts about this extractor's own grammar coverage (not a judgment about
// any particular corpus). Evaluated against @derekstride/tree-sitter-sql@0.3.11 (the actively
// maintained successor grammar) on 2026-08-12: it still has no `GRANT` statement and an
// explicit `// TODO: policy` in its own grammar.js, so it fails on the same PostgreSQL DDL as
// the vendored grammar below. No verifiable, provenance-checkable Tree-sitter SQL grammar with
// real Postgres RLS/ACL support was found; see vendor/PROVENANCE.md for what was checked.
const knownLimitations = {
  ".sql": "The vendored SQL grammar has no PostgreSQL Row-Level-Security or ACL DDL support: " +
    "CREATE POLICY, ALTER TABLE ... ENABLE ROW LEVEL SECURITY, and GRANT statements do not " +
    "parse. Tree-sitter's error recovery marks the whole containing file as a parse error, so " +
    "every comment in that file is skipped (fail-closed), not just comments near the " +
    "unsupported statement. Files with this shape report status \"parse-error\" below.",
};

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "buffer" });
}

// One pass over the file's raw bytes to record where every line starts (byte offset
// right after each `\n`, plus 0 for the first line). `point()` used to rescan from
// byte 0 for every single comment endpoint — quadratic in file size for a file with
// many comments (20.4s on a 1.5MB fixture). Building this index once per file and
// binary-searching it per endpoint makes both O(file size) total.
function lineStartIndex(bytes) {
  const starts = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) starts.push(index + 1);
  }
  return starts;
}

function point(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { column: offset - lineStarts[low], line: low };
}

function kindFor(text) {
  if (text.startsWith("#!")) return "shebang";
  if (/^\/\*\*/.test(text)) return "doc";
  if (/\b(?:biome-ignore|eslint-(?:disable|enable)|@ts-(?:ignore|expect-error)|tslint:disable|prettier-ignore|stylelint-disable|shellcheck\s+disable)\b/i.test(text)) {
    return "directive";
  }
  return text.startsWith("//") || text.startsWith("--") || text.startsWith("#") ? "line" : "block";
}

// tree-sitter-html's external scanner also tokenizes a `<!-- ... -->` run found inside a
// quoted attribute value as a nested comment node; that is source text, not a real comment.
function isEligible(extension, node) {
  if (extension !== ".html") return true;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (/attribute/i.test(parent.type)) return false;
  }
  return true;
}

// Comment-ish node types are leaves in every vendored grammar: capture and stop descending.
function collectCommentNodes(node, types, out) {
  if (types.has(node.type)) {
    out.push(node);
    return;
  }
  for (let index = 0; index < node.childCount; index += 1) {
    collectCommentNodes(node.child(index), types, out);
  }
}

// web-tree-sitter's Node#startIndex/endIndex are UTF-16 code-unit offsets into the JS string
// handed to parse(), not UTF-8 byte offsets, despite the .d.ts wording. Convert by walking the
// comment nodes in document order and accumulating each gap's UTF-8 byte length once, so exact
// byte ranges match a direct read of the file's raw bytes.
function extractComments(extension, bytes, text, tree) {
  const types = commentTypesByExtension[extension];
  const nodes = [];
  collectCommentNodes(tree.rootNode, types, nodes);
  const lineStarts = lineStartIndex(bytes);
  const units = [];
  let utf16Cursor = 0;
  let byteCursor = 0;
  for (const node of nodes) {
    byteCursor += Buffer.byteLength(text.slice(utf16Cursor, node.startIndex), "utf8");
    utf16Cursor = node.startIndex;
    const nodeText = node.text;
    const nodeBytes = Buffer.byteLength(nodeText, "utf8");
    const startByte = byteCursor;
    const endByte = startByte + nodeBytes;
    byteCursor = endByte;
    utf16Cursor = node.endIndex;
    if (!isEligible(extension, node)) continue;
    units.push({
      bytes: nodeBytes,
      kind: kindFor(nodeText),
      range: {
        end: point(lineStarts, endByte),
        endByte,
        start: point(lineStarts, startByte),
        startByte,
      },
    });
  }
  return units;
}

function languageLoader() {
  const cache = new Map();
  return async function languageFor(extension) {
    const file = grammarFiles[extension];
    if (!cache.has(file)) {
      const wasm = readFileSync(resolve(vendorRoot, "grammars", file));
      cache.set(file, await Language.load(wasm));
    }
    return cache.get(file);
  };
}

async function main() {
  const coreWasm = readFileSync(resolve(vendorRoot, "web-tree-sitter/web-tree-sitter.wasm"));
  await Parser.init({ wasmBinary: coreWasm });
  const parser = new Parser();
  const languageFor = languageLoader();

  const cwd = process.cwd();
  const root = realpathSync(git(["rev-parse", "--show-toplevel"], cwd).toString("utf8").trim());
  const paths = git(["ls-files", "-z"], root)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const files = [];
  const extensions = {};
  let commentBytes = 0;
  let comments = 0;
  let parsedFiles = 0;
  let parseErrorFiles = 0;
  let unsupportedFiles = 0;

  const isOutside = (rel) =>
    isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);

  for (const path of paths) {
    const extension = extname(path).toLowerCase() || "[none]";
    extensions[extension] ??= { parseError: 0, parsed: 0, unsupported: 0 };
    const entry = resolve(root, path);
    let status;
    let units = [];
    try {
      const contained = relative(root, entry);
      const stats = lstatSync(entry);
      if (isOutside(contained) || !stats.isFile() || stats.isSymbolicLink()) {
        status = "unsupported";
      } else {
        const realEntry = realpathSync(entry);
        const realContained = relative(root, realEntry);
        if (isOutside(realContained) || !supported.has(extension)) {
          status = "unsupported";
        } else {
          const bytes = readFileSync(realEntry);
          const text = bytes.toString("utf8");
          parser.setLanguage(await languageFor(extension));
          const tree = parser.parse(text);
          status = !tree || tree.rootNode.hasError ? "parse-error" : "parsed";
          if (status === "parsed") units = extractComments(extension, bytes, text, tree);
          tree?.delete();
        }
      }
    } catch {
      // `git ls-files` lists the tracked index, not the working tree: a path can be
      // tracked but missing on disk (deleted without `git rm`) or unreadable (EACCES),
      // throwing from lstatSync/realpathSync/readFileSync above. A supported extension
      // still promised comment coverage, so report it as a parse-error (incomplete
      // coverage, blocks ledger finality per the sweep contract); an unsupported
      // extension was already out of the extractor's parser surface either way.
      status = supported.has(extension) ? "parse-error" : "unsupported";
    }
    for (const unit of units) {
      unit.path = path;
      commentBytes += unit.bytes;
      comments += 1;
    }
    if (status === "parsed") {
      extensions[extension].parsed += 1;
      parsedFiles += 1;
    } else if (status === "parse-error") {
      extensions[extension].parseError += 1;
      parseErrorFiles += 1;
    } else {
      extensions[extension].unsupported += 1;
      unsupportedFiles += 1;
    }
    files.push({ comments: units, extension, path, status });
  }

  process.stdout.write(`${JSON.stringify({
    extensions,
    files,
    knownLimitations,
    schemaVersion: 1,
    totals: { commentBytes, comments, parseErrorFiles, parsedFiles, trackedFiles: paths.length, unsupportedFiles },
  })}\n`);
}

await main();
