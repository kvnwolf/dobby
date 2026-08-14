import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// This suite lives in `cli/src` (not under `plugin/`) so it gets tsc + biome
// coverage and is excluded from both the npm package (`cli/package.json`'s
// `files` already drops `src/*.test.ts`) and the plugin's cache-copied install
// tree. It still exercises the REAL shipped script — no logic is duplicated —
// by spawning it from its actual location under the skill.
const skillRoot = resolve(
  import.meta.dirname,
  "../../plugin/skills/trim-context"
);
const script = join(skillRoot, "scripts/comment-inventory.mjs");
const trees: string[] = [];

type CommentKind = "block" | "directive" | "doc" | "line" | "shebang";

interface CommentUnit {
  bytes: number;
  kind: CommentKind;
  path: string;
  range: {
    end: { column: number; line: number };
    endByte: number;
    start: { column: number; line: number };
    startByte: number;
  };
}

interface FileInventory {
  comments: CommentUnit[];
  extension: string;
  path: string;
  status: "parse-error" | "parsed" | "unsupported";
}

interface Inventory {
  extensions: Record<
    string,
    { parseError: number; parsed: number; unsupported: number }
  >;
  files: FileInventory[];
  knownLimitations: Record<string, string>;
  schemaVersion: 1;
  totals: {
    commentBytes: number;
    comments: number;
    parseErrorFiles: number;
    parsedFiles: number;
    trackedFiles: number;
    unsupportedFiles: number;
  };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dobby-comment-inventory-"));
  trees.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFiles(root, files);
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

function runInventory(cwd: string): { output: string; report: Inventory } {
  const output = execFileSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
  });
  return { output, report: JSON.parse(output) as Inventory };
}

function file(report: Inventory, path: string): FileInventory {
  const found = report.files.find((entry) => entry.path === path);
  expect(found, `missing inventory row for ${path}`).toBeDefined();
  return found as FileInventory;
}

function commentText(root: string, unit: CommentUnit): string {
  const bytes = readFileSync(join(root, unit.path));
  return bytes.subarray(unit.range.startByte, unit.range.endByte).toString();
}

afterAll(() => {
  for (const tree of trees) {
    rmSync(tree, { force: true, recursive: true });
  }
});

describe("trim-context mechanical comment inventory", () => {
  it("extracts real comments across the supported Vonda surface with exact byte ranges", () => {
    const root = makeRepo({
      "db/query.sql":
        "SELECT '-- not a comment';\n-- SQL line\n/* SQL block */\n",
      "public/index.html":
        '<p data-note="<!-- not a comment -->">Hi</p>\n<!-- HTML block -->\n',
      "scripts/run.sh":
        '#!/usr/bin/env bash\nprintf "%s\\n" "# not a comment"\n# shell line\n',
      "src/app.ts":
        'const url = "https://example.com//not-comment";\n// TypeScript line ✓\n/** TypeScript docs */\nexport { url };\n',
      "src/card.tsx":
        "export const Card = () => (\n  <div>{/* TSX block */}</div>\n);\n",
      "src/module.cjs": "/* CJS block */\nmodule.exports = { value: 1 };\n",
      "src/module.cts": "// CTS line\nexport const value: number = 1;\n",
      "src/module.mjs": "/* MJS block */\nexport const value = 1;\n",
      "src/module.mts": "// MTS line\nexport const value: number = 1;\n",
      "src/page.jsx":
        "export const Page = () => (\n  <main>{/* JSX block */}</main>\n);\n",
      "src/plain.js": "const value = 1; // JavaScript line\n",
      "styles/app.css":
        '.hero::after { content: "/* not a comment */"; }\n/* CSS block */\n',
    });

    const { report } = runInventory(root);
    const expectedParsed = [
      ".cjs",
      ".css",
      ".cts",
      ".html",
      ".js",
      ".jsx",
      ".mjs",
      ".mts",
      ".sh",
      ".sql",
      ".ts",
      ".tsx",
    ];

    for (const extension of expectedParsed) {
      expect(report.extensions[extension]).toMatchObject({
        parsed: 1,
        parseError: 0,
        unsupported: 0,
      });
    }
    expect(report.files.map((entry) => entry.path)).toEqual(
      [...report.files.map((entry) => entry.path)].sort()
    );
    expect(report.files.every((entry) => entry.status === "parsed")).toBe(true);

    const units = report.files.flatMap((entry) => entry.comments);
    expect(units.map((unit) => commentText(root, unit))).toEqual(
      expect.arrayContaining([
        "// TypeScript line ✓",
        "/** TypeScript docs */",
        "/* TSX block */",
        "/* JSX block */",
        "// JavaScript line",
        "/* MJS block */",
        "/* CJS block */",
        "// MTS line",
        "// CTS line",
        "-- SQL line",
        "/* SQL block */",
        "/* CSS block */",
        "<!-- HTML block -->",
        "#!/usr/bin/env bash",
        "# shell line",
      ])
    );
    expect(
      units.some((unit) => commentText(root, unit).includes("not a comment"))
    ).toBe(false);
    expect(
      file(report, "src/app.ts").comments.map((unit) => unit.kind)
    ).toEqual(["line", "doc"]);
    expect(file(report, "scripts/run.sh").comments[0]?.kind).toBe("shebang");

    for (const unit of units) {
      expect(unit.path).toBeTruthy();
      expect(unit.bytes).toBe(unit.range.endByte - unit.range.startByte);
      expect(unit.bytes).toBe(
        Buffer.byteLength(commentText(root, unit), "utf8")
      );
      expect(unit.range.start).toEqual({
        column: expect.any(Number),
        line: expect.any(Number),
      });
      expect(unit.range.end).toEqual({
        column: expect.any(Number),
        line: expect.any(Number),
      });
      expect(unit).not.toHaveProperty("candidate");
      expect(unit).not.toHaveProperty("disposition");
      expect(unit).not.toHaveProperty("retain");
    }

    expect(report.totals.comments).toBe(units.length);
    expect(report.totals.commentBytes).toBe(
      units.reduce((total, unit) => total + unit.bytes, 0)
    );
    expect(report.totals.parsedFiles).toBe(expectedParsed.length);
  });

  it("classifies tool directives separately without making an inferential disposition", () => {
    const root = makeRepo({
      "src/directives.ts":
        "// biome-ignore lint/suspicious/noExplicitAny: compatibility fixture\n" +
        "export const value = 1;\n" +
        "// Ordinary rationale stays a comment unit.\n",
    });

    const { report } = runInventory(root);
    const { comments } = file(report, "src/directives.ts");

    expect(comments.map((unit) => unit.kind)).toEqual(["directive", "line"]);
    expect(comments[0]).not.toHaveProperty("candidate");
    expect(comments[0]).not.toHaveProperty("retain");
  });

  it("does not follow tracked symlinks outside the workroot", () => {
    const root = makeRepo({ "src/tracked.ts": "// safe\n" });
    const secret = join(
      tmpdir(),
      `dobby-comment-inventory-secret-${Date.now()}`
    );
    writeFileSync(secret, "// outside secret\n");
    symlinkSync(secret, join(root, "src/outside.ts"));
    execFileSync("git", ["add", "src/outside.ts"], { cwd: root });

    const { report } = runInventory(root);

    expect(file(report, "src/outside.ts")).toMatchObject({
      comments: [],
      status: "unsupported",
    });
    expect(JSON.stringify(report)).not.toContain("outside secret");
    rmSync(secret, { force: true });
  });

  it("does not follow a symlinked parent directory from the tracked index", () => {
    const root = makeRepo({ "src/parent/outside.ts": "// initial\n" });
    const outside = mkdtempSync(
      join(tmpdir(), "dobby-comment-inventory-parent-")
    );
    trees.push(outside);
    writeFileSync(join(outside, "outside.ts"), "// parent secret\n");
    rmSync(join(root, "src/parent"), { force: true, recursive: true });
    symlinkSync(outside, join(root, "src/parent"));

    const { report } = runInventory(root);

    expect(file(report, "src/parent/outside.ts")).toMatchObject({
      comments: [],
      status: "unsupported",
    });
    expect(JSON.stringify(report)).not.toContain("parent secret");
  });

  it("uses only tracked workroot files and reports unsupported/parse-error coverage without ever writing", () => {
    const root = makeRepo({
      "config/service.toml": "# unsupported config comment\nenabled = true\n",
      "src/broken.ts": "export const = ; // syntactically broken\n",
      "src/tracked.ts": "// tracked\nexport const tracked = true;\n",
    });
    writeFiles(root, { "src/untracked.ts": "// untracked\n" });
    const nested = join(root, "src");
    const before = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    });

    const first = runInventory(nested);
    const second = runInventory(nested);
    const after = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(first.output).toBe(second.output);
    expect(first.report.schemaVersion).toBe(1);
    expect(first.report.files.map((entry) => entry.path)).not.toContain(
      "src/untracked.ts"
    );
    expect(file(first.report, "config/service.toml").status).toBe(
      "unsupported"
    );
    expect(file(first.report, "src/broken.ts").status).toBe("parse-error");
    expect(first.report.extensions[".toml"]).toMatchObject({
      parsed: 0,
      parseError: 0,
      unsupported: 1,
    });
    expect(first.report.extensions[".ts"]).toMatchObject({
      parsed: 1,
      parseError: 1,
      unsupported: 0,
    });
    expect(first.report.totals.trackedFiles).toBe(3);
    expect(first.report.totals.unsupportedFiles).toBe(1);
    expect(first.report.totals.parseErrorFiles).toBe(1);
    expect(after).toBe(before);
  });

  it("includes a tracked file even when it later matches a `.git/info/exclude` pattern (tracked-index semantics, not a live ignore filter)", () => {
    const root = makeRepo({ "src/tracked.ts": "// tracked\n" });
    writeFiles(root, {
      ".git/info/exclude": "src/ignored-but-tracked.ts\n",
      "src/ignored-but-tracked.ts": "// tracked despite matching exclude\n",
      "src/untracked.ts": "// never added, genuinely excluded\n",
    });
    // Force-add despite the exclude pattern: proves the extractor reads `git
    // ls-files`'s tracked index, which ignore patterns never retroactively prune,
    // rather than re-deriving exclusions itself.
    execFileSync("git", ["add", "-f", "src/ignored-but-tracked.ts"], {
      cwd: root,
    });

    const { report } = runInventory(root);
    const paths = report.files.map((entry) => entry.path);

    expect(paths).toContain("src/ignored-but-tracked.ts");
    expect(file(report, "src/ignored-but-tracked.ts").status).toBe("parsed");
    expect(paths).not.toContain("src/untracked.ts");
  });

  it("reports parse-error, not a crash, for a tracked path missing from the working tree", () => {
    const root = makeRepo({
      "src/deleted.ts": "// removed from disk without git rm\n",
      "src/kept.ts": "// stays on disk\n",
    });
    rmSync(join(root, "src/deleted.ts"));

    const { report } = runInventory(root);

    expect(file(report, "src/deleted.ts")).toMatchObject({
      comments: [],
      status: "parse-error",
    });
    expect(file(report, "src/kept.ts").status).toBe("parsed");
    expect(report.totals.trackedFiles).toBe(2);
    expect(report.totals.parseErrorFiles).toBe(1);
  });

  it("parses TypeScript template-literal interpolations and regex literals with the real grammar, not a text heuristic", () => {
    // "${" below is a literal "${": written as an escape (rather than a bare
    // "${" in this OUTER file's own string literal) only so biome's
    // noTemplateCurlyInString heuristic — which flags a literal "${" it finds inside
    // any regular string, real mistake or not — doesn't fire on OUR string. The
    // produced fixture bytes are identical either way; it's the FIXTURE's `.ts` file
    // that must contain a real `${...}` template interpolation for the assertion
    // below (parsing it with the real grammar, not a text heuristic) to mean anything.
    const root = makeRepo({
      "src/tricky.ts":
        "const t = `has // not a comment and $" +
        "{1 + 1 /* real nested comment */} end`;\n" +
        "const re = /\\/\\/ not a comment in regex/;\n" +
        "// actual line comment\n",
    });

    const { report } = runInventory(root);
    const entry = file(report, "src/tricky.ts");

    expect(entry.status).toBe("parsed");
    expect(entry.comments.map((unit) => commentText(root, unit))).toEqual([
      "/* real nested comment */",
      "// actual line comment",
    ]);
  });

  it("does not misclassify a `const =` substring inside a comment as a parse error (regression for the old text-heuristic scanner)", () => {
    const root = makeRepo({
      "src/const-in-comment.ts":
        "// const = looks broken to a text heuristic but isn't\nexport const value = 1;\n",
    });

    const { report } = runInventory(root);

    expect(file(report, "src/const-in-comment.ts").status).toBe("parsed");
  });

  it("recognizes a JavaScript/TypeScript shebang as its own grammar node, not a directive or a candidate-bearing unit", () => {
    const root = makeRepo({
      "bin/cli.ts": "#!/usr/bin/env node\nexport const run = () => 1;\n",
    });

    const { report } = runInventory(root);
    const { comments } = file(report, "bin/cli.ts");

    expect(comments[0]).toMatchObject({ kind: "shebang" });
    expect(comments[0]).not.toHaveProperty("candidate");
    expect(comments[0]).not.toHaveProperty("retain");
  });

  it("excludes a `<!-- -->` run inside a quoted HTML attribute value even though the grammar nests it as a comment node", () => {
    const root = makeRepo({
      "public/nested.html":
        '<div title="<!-- fake -->">real</div>\n<!-- real HTML comment -->\n',
    });

    const { report } = runInventory(root);
    const { comments } = file(report, "public/nested.html");

    expect(comments.map((unit) => commentText(root, unit))).toEqual([
      "<!-- real HTML comment -->",
    ]);
  });

  it("captures SQL block comments (marginalia) but not the `COMMENT ON` DDL statement or its keyword", () => {
    const root = makeRepo({
      "db/ddl.sql":
        "-- line comment\n/* block comment */\nCOMMENT ON TABLE users IS 'not a comment unit';\n",
    });

    const { report } = runInventory(root);
    const entry = file(report, "db/ddl.sql");

    expect(entry.status).toBe("parsed");
    expect(entry.comments.map((unit) => commentText(root, unit))).toEqual([
      "-- line comment",
      "/* block comment */",
    ]);
    expect(
      entry.comments.some((unit) =>
        commentText(root, unit).includes("not a comment unit")
      )
    ).toBe(false);
  });

  it("documents the SQL grammar's PostgreSQL RLS/GRANT coverage gap as a known limitation, and fails closed on it", () => {
    const root = makeRepo({
      "db/rls.sql":
        "-- lost because the statement below doesn't parse\n" +
        "alter table public.todos enable row level security;\n" +
        'create policy "select_own" on public.todos for select using (true);\n',
    });

    const { report } = runInventory(root);

    expect(file(report, "db/rls.sql").status).toBe("parse-error");
    expect(report.knownLimitations[".sql"]).toMatch(/row.level.security/i);
    expect(report.knownLimitations[".sql"]).toMatch(/grant/i);
    expect(report.knownLimitations[".sql"]).toMatch(/policy/i);
  });
});

describe("trim-context workflow contract", () => {
  it("runs the mechanical inventory before inferential judgment and fails closed only on parse-error, not on unsupported", () => {
    const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
    const contract = readFileSync(
      join(skillRoot, "references/sweep-contract.md"),
      "utf8"
    );
    const scriptReference = "scripts/comment-inventory.mjs";

    expect(skill).toContain(scriptReference);
    expect(skill.indexOf(scriptReference)).toBeLessThan(
      skill.indexOf("dobby:researcher")
    );
    expect(`${skill}\n${contract}`).toMatch(/unsupported/i);
    expect(`${skill}\n${contract}`).toMatch(/parse-error/i);
    expect(`${skill}\n${contract}`).toMatch(
      /parse-error[\s\S]{0,300}(?:ledger|coverage)[\s\S]{0,100}(?:incomplete|stop|final)/i
    );
    expect(skill).toMatch(/read[- ]only/i);
    expect(skill).toMatch(/mechanical|deterministic/i);
  });
});
