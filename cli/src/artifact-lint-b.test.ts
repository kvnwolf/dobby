import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import {
  cleanupDirs,
  makeScratchRepo,
  mkStubBins,
  readStubLog,
  restoreEnv,
  type StubResponse,
  useSpawnBudget,
  withStubPath,
} from "./test-helpers.ts";

// Real git/biome/tsc spawns under full-suite parallelism: the config-independent
// budget (see `useSpawnBudget`), not vitest's 5s default.
useSpawnBudget();

// ===========================================================================
// The ARTIFACT LINTERS, family B — `dobby wizard verify`, `dobby arch-report
// verify`, `dobby handoff finalize` and `dobby brief lint`.
//
// Same shape as family A (see `artifact-lint.test.ts`, which stays green): each
// command reads ONE artifact, runs its check inventory, and answers with the
// SHARED report contract — findings one per line, exit 1 on any finding, exit 0
// when clean, `--json` → `{ok, findings: [{check, message, where}]}` as the sole
// stdout. So the suite is organized inventory-first: one CLEAN fixture per
// artifact (the spine), then one test per check, each injecting a SINGLE defect
// into that otherwise-clean fixture. The clean-fixture test is what makes a bare
// `exitCode === 1` a real assertion — everything else in the document is proven
// silent, so the exit can only come from the injected defect.
//
// Every defect fixture is built through `mutate()`, which THROWS when its target
// text is absent — a fixture that silently stopped injecting its defect fails
// loudly instead of turning into a vacuous green.
//
// Seam: the in-process `run(argv, cwd)` contract (ADR-0008). The domain module is
// never imported directly, so its internals stay free to move.
//
// Boundaries mocked: `gh` ONLY (a stub bin on PATH, the repo's established seam)
// for `brief lint --issue N`. `git`, `bash` and the filesystem are REAL (throwaway
// repos + temp dirs), which is what makes the workroot / parse / on-disk
// assertions trustworthy. `shellcheck` is controlled by PATH composition: a stub
// bin makes it "present"; a PATH with every shellcheck-carrying directory removed
// AND a curated bin dir (symlinks to the real `bash` and `git`) prepended makes it
// "absent" deterministically on any machine — without taking the tools the other
// checks really do spawn down with it.
//
// Where every expected value comes from (all INDEPENDENT of the code):
//  - The wizard library region, the `# STAGES` marker, and the helper vocabulary
//    (`stage`/`open_url`/`ask`/`ask_secret`/`write_env`/`set_secret`/`set_var`)
//    are `plugin/skills/wizard/references/template.sh` verbatim — the canonical
//    template, read HERE from the plugin, which is what makes the vendoring
//    fidelity test an independent oracle rather than a copy of the copy.
//  - The authoring rules the wizard checks enforce (`TOTAL_STAGES` honest, open
//    the URL before asking for its value, `ask_secret` for anything secret,
//    `write_env` every persisted value, each `set_secret` name matching a
//    `secrets.*` reference) are `plugin/skills/wizard/SKILL.md` Step 3-4.
//  - The report's modern-CDN contract (`@tailwindcss/browser@4`, `mermaid@11`
//    ESM in a `type="module"` script, NO `cdn.tailwindcss.com`, NO
//    `tailwind.config`, NO SRI), the `#candidates` / `#top-recommendation`
//    sections, the anchor link, the temp-dir location and the banned prose
//    ("easier to maintain", "cleaner code", "it's worth noting") are
//    `plugin/skills/improve-architecture/references/html-report.md`.
//  - The handoff's five sections, the "reference by path or URL — never paste"
//    rule, the OS-temp-dir location and the redaction step are
//    `plugin/skills/handoff/SKILL.md`.
//  - The brief's AI-disclaimer line, its labeled sections and the
//    never-paths/never-line-numbers rule are
//    `plugin/skills/triage/references/agent-brief.md` (its template block and its
//    "bad brief" example, which is where `Files to change` / `What to do` /
//    `line 150` come from verbatim).
//  - Every secret sample is a well-known FAKE in the documented shape of its
//    provider's token (AWS's own documentation access key id, an
//    `sk-`/`ghp_`/`xoxb-` shaped literal, a credentialed `postgres://` DSN),
//    assembled at RUNTIME from inert fragments — see the Slice 12 header.
//
// Why these are RED before the implementation: `runArtifactLint` answers these
// four commands with `notImplemented` today (exit 1, `<command>: not implemented`
// on stderr, empty stdout), and `cli/wizard/template.sh` does not exist at all —
// so no clean verdict, no JSON payload, no finding text, no echoed path.
//
// Surface notes for the implementor (the work log carries the full list):
//  - A wizard script's library region is compared against the CLI's VENDORED
//    template (`cli/wizard/template.sh`), which is what a generated script is
//    copied from now — so the fixtures here are built from the vendored copy,
//    and a SEPARATE test proves that copy still carries the plugin template's
//    library verbatim.
//  - `handoff finalize`'s local artifact references are resolved against the
//    WORKROOT (the handoff doc itself lives in the OS temp dir, so its own
//    directory could never resolve them).
//  - `brief lint --issue N` reads the ISSUE COMMENTS payload and picks the LAST
//    comment itself (no `--jq` in the gh invocation): the stub answers with the
//    API's JSON array, and "newest wins" is asserted through it.
// ===========================================================================

const scratchDirs: string[] = [];

afterAll(() => {
  cleanupDirs(scratchDirs);
});

// --- report readers (test-side, deliberately dumb) --------------------------

// Both channels of a report: the contract fixes the exit code and the finding
// TEXT, not which stream carries it.
function reportOf(result: { stderr: string; stdout: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

// The `--json` payload as loose data — the shape is asserted key by key, so a
// parse helper never encodes an expectation.
function payloadOf(result: { stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// --- fixture plumbing -------------------------------------------------------

// The ONE mutation primitive every defect fixture goes through. It THROWS when
// the target text is absent, so a fixture that stopped injecting its defect (a
// reworded clean fixture, a typo) fails loudly instead of quietly asserting
// nothing.
function mutate(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`fixture mutation target not found: ${from}`);
  }
  return text.replaceAll(from, to);
}

// A temp directory OUTSIDE any git repo — where a handoff doc and an
// architecture report are required to live. Realpath-normalized so the path a
// test asserts on is the path the command sees (macOS /var → /private/var).
function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

function writeAt(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// The deterministic "shellcheck is not installed" environment, on a machine that
// has it and on one that does not: every PATH directory carrying a real
// `shellcheck` removed, with a CURATED bin dir prepended that holds a symlink to
// the real `bash` and the real `git`.
//
// The curated dir is the load-bearing half. Subtracting alone is not enough:
// dropping every directory that carries a shellcheck drops `/usr/bin` on any
// Linux CI image that ships ShellCheck (ubuntu-latest does), which takes `bash`
// and `git` — the tools these checks legitimately spawn — down with it. The parse
// check would then SKIP instead of report, and this suite would be green on macOS
// and red in CI.
let curatedBinDir: string | undefined;

function pathWithoutShellcheck(): string {
  if (curatedBinDir === undefined) {
    const dir = makeTempDir("dobby-no-shellcheck-");
    for (const name of ["bash", "git"]) {
      symlinkSync(realBinPath(name), join(dir, name));
    }
    curatedBinDir = dir;
  }
  const withoutShellcheck = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !existsSync(join(dir, "shellcheck")));
  return [curatedBinDir, ...withoutShellcheck].join(delimiter);
}

// The real tool the curated dir links to: the first `name` on the CURRENT PATH.
// Absent = a broken machine, not a test outcome, so it throws rather than
// silently producing a PATH the checks would skip on.
function realBinPath(name: string): string {
  const found = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `${name} is not on PATH — the wizard static checks spawn it for real`
    );
  }
  return found;
}

async function withPathValue<T>(
  value: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    restoreEnv("PATH", original);
  }
}

// ===========================================================================
// FIXTURES — the wizard script.
//
// The library region is taken from the CLI's VENDORED template (what a generated
// wizard is copied from), sliced at the `# STAGES` marker; the stages below it
// are authored here. Slice-then-append is what makes the region above the marker
// byte-identical to the template by construction, so the hash check has exactly
// one thing to disagree about: a deliberate edit.
// ===========================================================================

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliDir, "..");
const VENDORED_TEMPLATE = join(cliDir, "wizard", "template.sh");
const PLUGIN_TEMPLATE = join(
  repoRoot,
  "plugin",
  "skills",
  "wizard",
  "references",
  "template.sh"
);
const STAGES_MARKER = "# STAGES";
const LIBRARY_START = "set -euo pipefail";

// The one library line the "hand-edited library" fixture rewrites. Written as
// template literals with an escaped `\${` so the shell expansion stays literal
// (a plain string would read as a stray TS placeholder).
const ENV_FILE_LINE = `ENV_FILE="\${ENV_FILE:-.env}"`;
const ENV_FILE_LINE_EDITED = `ENV_FILE="\${ENV_FILE:-.env.local}"`;

function cliManifest(): { files?: string[] } {
  return JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as {
    files?: string[];
  };
}

function vendoredTemplate(): string {
  if (!existsSync(VENDORED_TEMPLATE)) {
    throw new Error(
      `${VENDORED_TEMPLATE} is missing — \`wizard verify\` compares a script against the CLI's VENDORED copy of plugin/skills/wizard/references/template.sh (the plugin dir is unreachable from a consumer install)`
    );
  }
  return readFileSync(VENDORED_TEMPLATE, "utf8");
}

// The canonical library BODY of a template: from `set -euo pipefail` up to (not
// including) the `# STAGES` marker line. The header comment block above it is
// deliberately excluded — the vendored copy is allowed to add its own provenance
// comment there, and nothing else.
function libraryBody(template: string): string {
  const lines = template.split("\n");
  const start = lines.findIndex((line) => line.trim() === LIBRARY_START);
  const marker = lines.findIndex((line) =>
    line.trimStart().startsWith(STAGES_MARKER)
  );
  if (start === -1 || marker === -1 || marker <= start) {
    throw new Error(
      `template has no ${LIBRARY_START} … ${STAGES_MARKER} region`
    );
  }
  return lines.slice(start, marker).join("\n");
}

// A wizard script: the vendored template's region THROUGH the `# STAGES` marker
// line, then the authored stages. `editLibrary` mutates the region above the
// marker — the one thing the hash check exists to catch.
function wizardScript(
  stages: string,
  editLibrary?: (library: string) => string
): string {
  const lines = vendoredTemplate().split("\n");
  const marker = lines.findIndex((line) =>
    line.trimStart().startsWith(STAGES_MARKER)
  );
  const head = lines.slice(0, marker + 1).join("\n");
  return `${editLibrary === undefined ? head : editLibrary(head)}\n\n${stages}\n`;
}

// Two honest stages: each opens its URL before asking for the value, captures the
// secret with `ask_secret`, persists everything it captures, and pushes to CI
// exactly the one value CI references.
const CLEAN_STAGES = [
  "TOTAL_STAGES=2",
  "TOTAL_MINUTES=8",
  "",
  'banner "Neon setup"',
  "",
  'stage "Neon — project" 4',
  'say "We will create the Neon project this app talks to."',
  'open_url "https://console.neon.tech/app/projects"',
  'step "Create a project, then copy its project id from the settings page."',
  'ask NEON_PROJECT_ID "Paste the project id:"',
  'write_env NEON_PROJECT_ID "$NEON_PROJECT_ID"',
  "",
  'stage "Neon — API access" 4',
  'say "CI needs an API key of its own."',
  'open_url "https://console.neon.tech/app/settings/api-keys"',
  'step "Create a new API key and copy it — it is shown once."',
  'ask_secret NEON_API_KEY "Paste the API key:"',
  'write_env NEON_API_KEY "$NEON_API_KEY"',
  'set_secret NEON_API_KEY "$NEON_API_KEY"',
  "",
  "finish",
].join("\n");

// A third stage producing a value CI does NOT reference — the material for the
// set_secret → workflows direction of the bidirectional diff.
const SENTRY_STAGE = [
  'stage "Sentry — DSN" 2',
  'open_url "https://sentry.io/settings/projects/"',
  'step "Copy the DSN from the client keys page."',
  'ask_secret SENTRY_DSN "Paste the DSN:"',
  'write_env SENTRY_DSN "$SENTRY_DSN"',
  'set_secret SENTRY_DSN "$SENTRY_DSN"',
].join("\n");

// A CI workflow referencing the named repo secrets — the other half of the
// bidirectional diff. `\${{` keeps the literal GitHub Actions expression intact.
function workflow(names: readonly string[]): string {
  return [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  migrate:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: bunx neonctl branches list",
    "        env:",
    ...names.map((name) => `          ${name}: \${{ secrets.${name} }}`),
    "",
  ].join("\n");
}

function makeWizardRepo(
  secrets: readonly string[] | null = ["NEON_API_KEY"]
): string {
  const files: Record<string, string> =
    secrets === null ? {} : { ".github/workflows/ci.yml": workflow(secrets) };
  return makeScratchRepo({
    files,
    pkg: { name: "fixture-project", private: true },
    prefix: "dobby-artifact-wizard-",
    track: scratchDirs,
  });
}

const WIZARD_REL = "scripts/setup-wizard.sh";

function writeWizard(
  root: string,
  content: string,
  opts: { executable?: boolean } = {}
): string {
  const path = join(root, WIZARD_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, opts.executable === false ? 0o644 : 0o755);
  return path;
}

// One `wizard verify` run. With no `shellcheck` responses the tool is ABSENT
// (PATH filtered); with them a stub bin answers as the real one would.
async function verifyWizard(
  root: string,
  argv: string[],
  shellcheck?: StubResponse[]
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  if (shellcheck === undefined) {
    return await withPathValue(pathWithoutShellcheck(), () => run(argv, root));
  }
  const binDir = mkStubBins({ shellcheck }, scratchDirs);
  return await withStubPath(binDir, () => run(argv, root));
}

// Top-level per the repo's useTopLevelRegex convention.
const SAYS_LIBRARY = /library/i;
const SAYS_PARSE = /bash|syntax|parse/i;
const SAYS_SHELLCHECK = /shellcheck/i;
const SAYS_SHELLCHECK_FINDING = /shellcheck|SC2034/i;
const SAYS_EXECUTABLE = /executable|chmod|\+x/i;
const SAYS_TOTAL_STAGES = /TOTAL_STAGES/;
const SAYS_PERSISTED = /persist|write_env|set_secret|set_var/i;
const SAYS_HIDDEN_INPUT = /ask_secret|hidden|secret/i;
const SAYS_OPEN_URL = /open_url|url/i;
const SAYS_WORKFLOW = /workflow/i;

// ===========================================================================
// Slice 1 — the FIRST tracer bullet: the VENDORED template asset.
//
// Every wizard check hangs off it (the hash comparison has nothing to compare
// against without it, and a consumer install carries no plugin directory), so it
// is the slice to make green first.
// ===========================================================================

describe("the vendored wizard template", () => {
  it("ships at cli/wizard/template.sh so a consumer install carries it", () => {
    expect(existsSync(VENDORED_TEMPLATE)).toBe(true);
  });

  it("carries the canonical wizard library verbatim", () => {
    // The independent oracle: the PLUGIN's template, the one the wizard skill
    // has always pointed at. Byte drift between the two is exactly what would
    // make `wizard verify` reject honest scripts.
    const canonical = libraryBody(readFileSync(PLUGIN_TEMPLATE, "utf8"));
    expect(vendoredTemplate()).toContain(canonical);
  });

  it("keeps the `# STAGES` marker the authored section hangs below", () => {
    expect(vendoredTemplate()).toContain(STAGES_MARKER);
  });

  it("names the plugin file it was copied from", () => {
    expect(vendoredTemplate()).toContain(
      "plugin/skills/wizard/references/template.sh"
    );
  });

  it("is listed in the package files allowlist so it lands in the tarball", () => {
    expect(cliManifest().files ?? []).toContain("wizard");
  });
});

// ===========================================================================
// Slice 2 — `wizard verify`: a well-formed wizard.
// ===========================================================================

describe("dobby wizard verify — a well-formed wizard", () => {
  it("reports ok and exits 0 for a script whose library is the template and whose stages are honest", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(root, wizardScript(CLEAN_STAGES));
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("answers a clean script with {ok: true, findings: []} as the only stdout", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(root, wizardScript(CLEAN_STAGES));
    const result = await verifyWizard(root, [
      "wizard",
      "verify",
      script,
      "--json",
    ]);
    const payload = payloadOf(result);
    expect(payload.ok).toBe(true);
    expect(payload.findings).toEqual([]);
  });
});

// ===========================================================================
// Slice 3 — the library region: the hash comparison against the vendored
// template. "Never edit the library above the marker" is the wizard skill's one
// load-bearing authoring rule.
// ===========================================================================

describe("dobby wizard verify — the library region", () => {
  it("reports a hand-edited library region", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(
      root,
      wizardScript(CLEAN_STAGES, (library) =>
        mutate(library, ENV_FILE_LINE, ENV_FILE_LINE_EDITED)
      )
    );
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_LIBRARY);
  });

  it("reports a library region the author trimmed a helper out of", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(
      root,
      wizardScript(CLEAN_STAGES, (library) =>
        mutate(
          library,
          'note() { printf \'  %s%s%s\\n\' "$DIM" "$1" "$RESET"; }',
          ""
        )
      )
    );
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_LIBRARY);
  });
});

// ===========================================================================
// Slice 4 — the static checks the wizard skill's Step 4 mandates: it parses,
// shellcheck when available, and the executable bit.
// ===========================================================================

describe("dobby wizard verify — static checks", () => {
  it("reports a script bash cannot parse", async () => {
    const root = makeWizardRepo();
    const broken = mutate(
      CLEAN_STAGES,
      "finish",
      'if [[ -z "$NEON_PROJECT_ID" ]]; then\nfinish'
    );
    const script = writeWizard(root, wizardScript(broken));
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_PARSE);
  });

  it("reports what shellcheck found when shellcheck is on PATH", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(root, wizardScript(CLEAN_STAGES));
    const result = await verifyWizard(
      root,
      ["wizard", "verify", script],
      [
        {
          exitCode: 1,
          stdout:
            "setup-wizard.sh:210:1: warning: NEON_PROJECT_ID appears unused. Verify use (or export if used externally). [SC2034]\n",
        },
      ]
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_SHELLCHECK_FINDING);
  });

  it("notes shellcheck as SKIPPED rather than reporting a finding when it is not installed", async () => {
    // "Skip cleanly if not available" (wizard SKILL.md Step 4): the absence of a
    // tool is never a defect in the artifact, but it must be visible — a caller
    // must be able to tell a shellcheck-checked wizard from an unchecked one.
    const root = makeWizardRepo();
    const script = writeWizard(root, wizardScript(CLEAN_STAGES));
    const result = await verifyWizard(root, [
      "wizard",
      "verify",
      script,
      "--json",
    ]);
    const payload = payloadOf(result);
    expect(result.exitCode).toBe(0);
    expect(payload.findings).toEqual([]);
    expect(JSON.stringify(payload)).toMatch(SAYS_SHELLCHECK);
  });

  it("reports a script without the executable bit", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(root, wizardScript(CLEAN_STAGES), {
      executable: false,
    });
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_EXECUTABLE);
  });
});

// ===========================================================================
// Slice 5 — the authored stages: the totals, the captured values, and the order
// a human actually walks the stage in.
// ===========================================================================

describe("dobby wizard verify — the authored stages", () => {
  it("reports TOTAL_STAGES disagreeing with the number of stages authored", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(
      root,
      wizardScript(mutate(CLEAN_STAGES, "TOTAL_STAGES=2", "TOTAL_STAGES=3"))
    );
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_TOTAL_STAGES);
  });

  it("reports a captured value the stage never persists", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(
      root,
      wizardScript(
        mutate(CLEAN_STAGES, 'write_env NEON_PROJECT_ID "$NEON_PROJECT_ID"', "")
      )
    );
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("NEON_PROJECT_ID");
    expect(reportOf(result)).toMatch(SAYS_PERSISTED);
  });

  it("accepts a value persisted with set_var instead of write_env", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(
      root,
      wizardScript(
        mutate(
          CLEAN_STAGES,
          'write_env NEON_PROJECT_ID "$NEON_PROJECT_ID"',
          'set_var NEON_PROJECT_ID "$NEON_PROJECT_ID"'
        )
      )
    );
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(0);
  });

  it("reports a secret-shaped value captured with visible input", async () => {
    const root = makeWizardRepo();
    const script = writeWizard(
      root,
      wizardScript(
        mutate(
          CLEAN_STAGES,
          'ask_secret NEON_API_KEY "Paste the API key:"',
          'ask NEON_API_KEY "Paste the API key:"'
        )
      )
    );
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("NEON_API_KEY");
    expect(reportOf(result)).toMatch(SAYS_HIDDEN_INPUT);
  });

  it("reports a stage that asks for a value before opening the page it comes from", async () => {
    const root = makeWizardRepo();
    const swapped = mutate(
      CLEAN_STAGES,
      [
        'open_url "https://console.neon.tech/app/projects"',
        'step "Create a project, then copy its project id from the settings page."',
        'ask NEON_PROJECT_ID "Paste the project id:"',
      ].join("\n"),
      [
        'ask NEON_PROJECT_ID "Paste the project id:"',
        'open_url "https://console.neon.tech/app/projects"',
        'step "Create a project, then copy its project id from the settings page."',
      ].join("\n")
    );
    const script = writeWizard(root, wizardScript(swapped));
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_OPEN_URL);
  });
});

// ===========================================================================
// Slice 6 — the CI mapping: every `set_secret` name matches a `secrets.*`
// reference and vice-versa. This is the check that keeps CI and the wizard in
// sync, which is the wizard skill's stated reason for reading `.github/workflows`
// in the first place.
// ===========================================================================

describe("dobby wizard verify — secrets against the workflows", () => {
  it("reports a secret the wizard sets that no workflow references", async () => {
    const root = makeWizardRepo(["NEON_API_KEY"]);
    const stages = mutate(
      mutate(CLEAN_STAGES, "TOTAL_STAGES=2", "TOTAL_STAGES=3"),
      "\nfinish",
      `\n${SENTRY_STAGE}\n\nfinish`
    );
    const script = writeWizard(root, wizardScript(stages));
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("SENTRY_DSN");
  });

  it("reports a workflow secret the wizard never produces", async () => {
    const root = makeWizardRepo(["NEON_API_KEY", "VERCEL_TOKEN"]);
    const script = writeWizard(root, wizardScript(CLEAN_STAGES));
    const result = await verifyWizard(root, ["wizard", "verify", script]);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("VERCEL_TOKEN");
  });

  it("notes a repo with no workflows directory as a SKIP rather than a mismatch", async () => {
    const root = makeWizardRepo(null);
    const script = writeWizard(root, wizardScript(CLEAN_STAGES));
    const result = await verifyWizard(root, [
      "wizard",
      "verify",
      script,
      "--json",
    ]);
    const payload = payloadOf(result);
    expect(result.exitCode).toBe(0);
    expect(payload.findings).toEqual([]);
    expect(JSON.stringify(payload)).toMatch(SAYS_WORKFLOW);
  });
});

// ===========================================================================
// FIXTURES — the architecture report.
//
// The scaffold `html-report.md` prescribes, minus the editorial bulk: the two
// modern CDNs (Tailwind v4 browser build + Mermaid 11 ESM in a module script),
// one candidate `<article>` under `#candidates`, and a `#top-recommendation`
// section anchoring at that article's id.
// ===========================================================================

const CLEAN_REPORT = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  "    <title>Architecture review — scratch</title>",
  '    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>',
  '    <style type="text/tailwindcss">',
  "      @theme {",
  "        --color-leak: #dc2626;",
  "      }",
  "    </style>",
  '    <script type="module">',
  '      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";',
  '      mermaid.initialize({ startOnLoad: true, theme: "neutral" });',
  "    </script>",
  "    <style>",
  "      .seam { stroke-dasharray: 4 4; }",
  "    </style>",
  "  </head>",
  '  <body class="bg-stone-50 text-slate-900 font-sans">',
  '    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">',
  "      <header>",
  '        <h1 class="text-2xl font-serif">Architecture review — scratch</h1>',
  "      </header>",
  '      <section id="candidates" class="space-y-10">',
  '        <article id="collapse-order-intake" class="rounded-lg border p-4">',
  "          <h2>Collapse the Order intake pipeline</h2>",
  '          <span class="rounded-full bg-emerald-100 text-emerald-800">Strong</span>',
  '          <pre class="mermaid">flowchart LR',
  "  A[OrderHandler] --> B[OrderValidator]</pre>",
  "          <p>Order intake is shallow — the interface nearly matches the implementation.</p>",
  "          <ul>",
  "            <li>locality: bugs concentrate in one module</li>",
  "            <li>leverage: one interface, N call sites</li>",
  "          </ul>",
  "        </article>",
  "      </section>",
  '      <section id="top-recommendation">',
  "        <h2>Top recommendation</h2>",
  '        <p><a href="#collapse-order-intake">Collapse the Order intake pipeline</a> — one interface, one place to test.</p>',
  "      </section>",
  "    </main>",
  "  </body>",
  "</html>",
  "",
].join("\n");

const REPORT_NAME = "architecture-review-20260724-1432.html";

const SAYS_TAILWIND_CDN = /tailwind/i;
const SAYS_MERMAID = /mermaid/i;
const SAYS_MODULE = /module|esm/i;
const SAYS_INTEGRITY = /integrity/i;
const SAYS_EXTERNAL_ASSET = /external|stylesheet|script|link/i;
const SAYS_CANDIDATES = /candidates/i;
const SAYS_ARTICLE = /article|candidate/i;
const SAYS_TOP_RECOMMENDATION = /top-recommendation/i;
const SAYS_ANCHOR = /anchor|href|id/i;
const SAYS_BANNED_PROSE = /easier to maintain/i;
// Deliberately WITHOUT a bare `repo` alternative: `arch-report` contains it, so
// that spelling would match the stub's own `arch-report: not implemented` and the
// test would pass before the check exists.
const SAYS_OUTSIDE_REPO = /temp|workroot|worktree|tracked|inside|outside/i;

function makeReportRepo(): string {
  return makeScratchRepo({
    pkg: { name: "fixture-project", private: true },
    prefix: "dobby-artifact-report-",
    track: scratchDirs,
  });
}

// The report as the skill writes it: in the OS temp dir, never in the repo.
function writeReport(html: string): string {
  return writeAt(makeTempDir("dobby-artifact-html-"), REPORT_NAME, html);
}

// ===========================================================================
// Slice 7 — `arch-report verify`: a well-formed report.
// ===========================================================================

describe("dobby arch-report verify — a well-formed report", () => {
  it("reports ok and exits 0 for a report on the modern CDNs with a candidate and a resolving top recommendation", async () => {
    const root = makeReportRepo();
    const report = writeReport(CLEAN_REPORT);
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});

// ===========================================================================
// Slice 8 — the CDN wiring: the modern builds, and the stale ones the reference
// explicitly corrects (they are what a model's training data reaches for).
// ===========================================================================

describe("dobby arch-report verify — the CDN wiring", () => {
  it("reports the stale Tailwind v3 CDN", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        CLEAN_REPORT,
        "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4",
        "https://cdn.tailwindcss.com"
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_TAILWIND_CDN);
  });

  it("reports the removed `tailwind.config` JS global", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        CLEAN_REPORT,
        "    <style>",
        "    <script>tailwind.config = { theme: {} };</script>\n    <style>"
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("tailwind.config");
  });

  it("reports the non-existent Mermaid UMD bundle", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        CLEAN_REPORT,
        '    <script type="module">\n      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";\n      mermaid.initialize({ startOnLoad: true, theme: "neutral" });\n    </script>',
        '    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>'
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_MERMAID);
  });

  it("reports the Mermaid ESM import loaded outside a module script", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(CLEAN_REPORT, '<script type="module">', "<script>")
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_MODULE);
  });

  it("reports a Subresource-Integrity attribute (the range CDNs move under it)", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        CLEAN_REPORT,
        '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>',
        '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" integrity="sha384-abc123"></script>'
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_INTEGRITY);
  });

  it("reports a third external asset beyond the two CDNs", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        CLEAN_REPORT,
        "  </head>",
        '    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />\n  </head>'
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_EXTERNAL_ASSET);
  });
});

// ===========================================================================
// Slice 9 — the report's structure and prose.
// ===========================================================================

describe("dobby arch-report verify — structure and prose", () => {
  it("reports a report with no candidates section", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(CLEAN_REPORT, ' id="candidates" class="space-y-10"', "")
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_CANDIDATES);
  });

  it("reports a candidates section carrying no candidate", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        mutate(
          CLEAN_REPORT,
          '<article id="collapse-order-intake" class="rounded-lg border p-4">',
          '<div id="collapse-order-intake" class="rounded-lg border p-4">'
        ),
        "</article>",
        "</div>"
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_ARTICLE);
  });

  it("reports a report with no top-recommendation section", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(CLEAN_REPORT, '<section id="top-recommendation">', "<section>")
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_TOP_RECOMMENDATION);
  });

  it("reports a top-recommendation anchor pointing at an id the report does not carry", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        CLEAN_REPORT,
        'href="#collapse-order-intake"',
        'href="#no-such-card"'
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("no-such-card");
    expect(reportOf(result)).toMatch(SAYS_ANCHOR);
  });

  it("reports banned prose the vocabulary rules out", async () => {
    const root = makeReportRepo();
    const report = writeReport(
      mutate(
        CLEAN_REPORT,
        "<li>locality: bugs concentrate in one module</li>",
        "<li>easier to maintain</li>"
      )
    );
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_BANNED_PROSE);
  });

  it("reports a report written inside the repo instead of the OS temp dir", async () => {
    const root = makeReportRepo();
    const report = writeAt(root, REPORT_NAME, CLEAN_REPORT);
    const result = await run(["arch-report", "verify", report], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_OUTSIDE_REPO);
  });
});

// ===========================================================================
// FIXTURES — the handoff document.
//
// The five sections `handoff/SKILL.md` Step 2 prescribes, artifacts referenced by
// path/URL only, and suggested skills naming real `/dobby:*` commands.
// ===========================================================================

const ADR_REL = "docs/adr/0008-zero-framework-portable-cli.md";

const CLEAN_HANDOFF = [
  "# Handoff — mechanize the kit",
  "",
  "## Focus",
  "Land the four remaining artifact linters in the dobby CLI.",
  "",
  "## Where we are",
  "The command registry and the first three linters are in. The four remaining",
  "linters are specced and unimplemented; the wave before them is merged.",
  "",
  "## Artifacts",
  "- STATE.md — the session doc: goal, findings, spec, work log",
  `- ${ADR_REL} — the CLI's zero-framework portability constraint`,
  "- https://github.com/kvnwolf/dobby/pull/18 — the previous wave's merged PR",
  "",
  "## Open questions",
  "- Does the wizard template stay vendored, or move to a self-declared hash header?",
  "",
  "## Suggested skills",
  "- `/dobby:execute` — resume the plan in STATE.md; the last wave remains",
  "- `/dobby:wrap` — once the wave lands, to reconcile docs and commit",
  "",
].join("\n");

const HANDOFF_NAME = "dobby-handoff-20260724-1432.md";

const SAYS_FOCUS = /focus/i;
const SAYS_ARTIFACTS_SECTION = /artifacts/i;
const SAYS_CODE_BLOCK = /code block|fenc/i;
const SAYS_MISSING_REF = /exist|missing|not found/i;
const SAYS_SKILL = /skill/i;
const SAYS_SECRET = /secret|token|key|credential|redact/i;

function makeHandoffRepo(): string {
  return makeScratchRepo({
    files: {
      "STATE.md": "# Work session\n\n## Goal\nmechanize the kit\n",
      [ADR_REL]: "# 8. Zero-framework portable CLI\n\nAccepted.\n",
    },
    pkg: { name: "fixture-project", private: true },
    prefix: "dobby-artifact-handoff-",
    track: scratchDirs,
  });
}

function writeHandoff(doc: string): string {
  return writeAt(makeTempDir("dobby-artifact-fork-"), HANDOFF_NAME, doc);
}

// ===========================================================================
// Slice 10 — `handoff finalize`: a well-formed handoff.
// ===========================================================================

describe("dobby handoff finalize — a well-formed handoff", () => {
  it("exits 0 and echoes the document's absolute path (the hand-off to the next session)", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(CLEAN_HANDOFF);
    const result = await run(["handoff", "finalize", doc], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(doc);
  });

  it("answers --json with ok:true, no findings, and the path", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(CLEAN_HANDOFF);
    const result = await run(["handoff", "finalize", doc, "--json"], root);
    const payload = payloadOf(result);
    expect(payload.ok).toBe(true);
    expect(payload.findings).toEqual([]);
    expect(JSON.stringify(payload)).toContain(doc);
  });
});

// ===========================================================================
// Slice 11 — the required sections and the reference-don't-copy rule.
// ===========================================================================

describe("dobby handoff finalize — completeness", () => {
  it("reports a missing `## Artifacts` section", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(mutate(CLEAN_HANDOFF, "## Artifacts", "## Files"));
    const result = await run(["handoff", "finalize", doc], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_ARTIFACTS_SECTION);
  });

  it("reports a Focus that runs past one line", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(
      mutate(
        CLEAN_HANDOFF,
        "Land the four remaining artifact linters in the dobby CLI.",
        "Land the four remaining artifact linters in the dobby CLI.\nThen rewrite the skills that call them, and reconcile the docs."
      )
    );
    const result = await run(["handoff", "finalize", doc], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_FOCUS);
  });

  it("reports a pasted code block (a handoff references, it never copies)", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(
      mutate(
        CLEAN_HANDOFF,
        "## Open questions",
        "```ts\nexport function runArtifactLint() {}\n```\n\n## Open questions"
      )
    );
    const result = await run(["handoff", "finalize", doc], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_CODE_BLOCK);
  });

  it("reports an artifact reference that is not on disk", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(
      mutate(CLEAN_HANDOFF, ADR_REL, "docs/adr/9999-ghost-decision.md")
    );
    const result = await run(["handoff", "finalize", doc], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("9999-ghost-decision.md");
    expect(reportOf(result)).toMatch(SAYS_MISSING_REF);
  });

  it("reports a suggested skill the plugin does not carry", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(
      mutate(CLEAN_HANDOFF, "/dobby:wrap", "/dobby:ghost-writer")
    );
    const result = await run(["handoff", "finalize", doc], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("ghost-writer");
    expect(reportOf(result)).toMatch(SAYS_SKILL);
  });

  it("reports a handoff written inside the repo instead of the OS temp dir", async () => {
    const root = makeHandoffRepo();
    const doc = writeAt(root, HANDOFF_NAME, CLEAN_HANDOFF);
    const result = await run(["handoff", "finalize", doc], root);
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_OUTSIDE_REPO);
  });
});

// Slice 11b — `--focus`: the subject the handoff was ASKED for. `/dobby:handoff`
// is invoked with a focus, and the one-line `## Focus` section is where it has to
// land — a doc whose focus line is about something else hands the next session the
// wrong session. Both directions are pinned here, at the `run()` seam, so the flag
// has to survive the command registry as well as the linter.
describe("dobby handoff finalize --focus", () => {
  it("accepts a Focus line that is about the focus it was given", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(CLEAN_HANDOFF);
    const result = await run(
      ["handoff", "finalize", doc, "--focus", "artifact linters"],
      root
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(doc);
  });

  it("reports a Focus line that never mentions the focus it was given", async () => {
    const root = makeHandoffRepo();
    const doc = writeHandoff(CLEAN_HANDOFF);
    const result = await run(
      ["handoff", "finalize", doc, "--focus", "the release pipeline"],
      root
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("the release pipeline");
    expect(reportOf(result)).toMatch(SAYS_FOCUS);
  });
});

// ===========================================================================
// Slice 12 — the SECRET SCAN. It fails CLOSED: every sample below is a
// well-known FAKE in its provider's documented token shape, and each must be a
// finding on its own. A handoff is written to a shared temp dir and pasted into
// a fresh session, so a leaked credential here is the one defect that cannot be
// allowed to pass silently.
//
// Every fake is ASSEMBLED AT RUNTIME from inert fragments and never written as
// one literal: GitHub's push protection scans the SOURCE of this file, and a
// full-shape token here — even a documented fake — blocks the push that ships
// the test. Joined, each value still matches its `SECRET_PATTERNS` regex in
// `artifact-lint.ts` exactly, which is the only thing the scan judges. Keep the
// joins (and never `+`: the formatter folds concatenated literals back into
// one). The delimiter each token carries natively IS the join separator.
// ===========================================================================

const FAKE_OPENAI_KEY = ["sk", "AAAABBBBCCCCDDDDEEEE1234"].join("-");
const FAKE_GITHUB_PAT = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join(
  "_"
);
const FAKE_AWS_KEY_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const FAKE_PG_DSN = ["postgres://app", "s3cr3tpass@db.neon.tech/main"].join(
  ":"
);
const FAKE_PRIVATE_KEY = ["-----BEGIN", "PRIVATE KEY----- MIIEvQIBADAN"].join(
  " "
);
const FAKE_SLACK_TOKEN = [
  "xoxb",
  "0123456789",
  "0123456789",
  "AbCdEfGhIjKlMnOp",
].join("-");
const FAKE_API_KEY_ASSIGNMENT = ["api_key", "8f4c1d9e2b7a6350"].join(" = ");

const SECRET_SAMPLES: readonly { label: string; line: string }[] = [
  {
    label: "an OpenAI-shaped `sk-` key",
    line: `- The provider client reads ${FAKE_OPENAI_KEY} from the env`,
  },
  {
    label: "a GitHub personal access token",
    line: `- CI authenticates with ${FAKE_GITHUB_PAT}`,
  },
  {
    label: "an AWS access key id",
    line: `- The uploader runs as ${FAKE_AWS_KEY_ID} in staging`,
  },
  {
    label: "a Postgres connection string with credentials",
    line: `- The branch DB is ${FAKE_PG_DSN}`,
  },
  {
    label: "an inlined private key",
    line: `- The signer holds ${FAKE_PRIVATE_KEY}`,
  },
  {
    label: "a Slack bot token",
    line: `- Notifications post via ${FAKE_SLACK_TOKEN}`,
  },
  {
    label: "a generic api_key assignment",
    line: `- The seeded fixture sets ${FAKE_API_KEY_ASSIGNMENT} for the sandbox`,
  },
];

describe("dobby handoff finalize — the secret scan", () => {
  for (const sample of SECRET_SAMPLES) {
    it(`reports ${sample.label}`, async () => {
      const root = makeHandoffRepo();
      const doc = writeHandoff(
        mutate(
          CLEAN_HANDOFF,
          "- Does the wizard template stay vendored, or move to a self-declared hash header?",
          sample.line
        )
      );
      const result = await run(["handoff", "finalize", doc], root);
      expect(result.exitCode).toBe(1);
      expect(reportOf(result)).toMatch(SAYS_SECRET);
    });
  }
});

// ===========================================================================
// FIXTURES — the triage agent brief.
//
// `agent-brief.md`'s template, filled in as its own "good brief (bug)" example
// does — with the example's `SKILL.md` mention rewritten as an interface
// description, since naming a file is exactly what the brief may never do.
// ===========================================================================

const CLEAN_BRIEF = [
  "> *This was generated by AI during triage.*",
  "",
  "## Agent Brief",
  "",
  "**Category:** bug",
  "**Summary:** Skill description truncation drops mid-word, producing broken output",
  "",
  "**Current behavior:**",
  "When a skill description exceeds the character cap it is truncated at exactly the",
  "cap regardless of word boundaries, so descriptions end mid-word.",
  "",
  "**Desired behavior:**",
  "Truncation breaks at the last word boundary before the cap and appends an",
  "ellipsis to signal that it happened.",
  "",
  "**Key interfaces:**",
  "- The skill-metadata description field — no type change, but the validation that",
  "  populates it must respect word boundaries.",
  "- Any function that reads skill frontmatter and extracts the description.",
  "",
  "**Acceptance criteria:**",
  "- [ ] Descriptions under the cap are unchanged",
  "- [ ] Descriptions over the cap break at the last word boundary before it",
  "- [ ] Truncated descriptions end with an ellipsis",
  "",
  "**Out of scope:**",
  "- Changing the character cap itself",
  "- Multi-line description support",
  "",
].join("\n");

const BRIEF_REL = "brief.md";

const SAYS_DISCLAIMER = /disclaimer|generated by ai/i;
const SAYS_CATEGORY = /category/i;
const SAYS_KEY_INTERFACES = /key interfaces/i;
const SAYS_ACCEPTANCE = /acceptance|criteri/i;
const SAYS_OUT_OF_SCOPE = /out of scope/i;
const SAYS_FILE_PATH = /path|file/i;
const SAYS_LINE_REFERENCE = /line/i;
const SAYS_BANNED_HEADING = /files to change/i;

function makeBriefRepo(brief: string): { path: string; root: string } {
  const root = makeScratchRepo({
    files: { [BRIEF_REL]: brief },
    pkg: { name: "fixture-project", private: true },
    prefix: "dobby-artifact-brief-",
    track: scratchDirs,
  });
  return { path: join(root, BRIEF_REL), root };
}

async function lintBrief(
  brief: string
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const { path, root } = makeBriefRepo(brief);
  return await run(["brief", "lint", "--file", path], root);
}

// ===========================================================================
// Slice 13 — `brief lint`: a well-formed brief.
// ===========================================================================

describe("dobby brief lint — a well-formed brief", () => {
  it("reports ok and exits 0 for a brief carrying every labeled section", async () => {
    const result = await lintBrief(CLEAN_BRIEF);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});

// ===========================================================================
// Slice 14 — the brief's required sections.
// ===========================================================================

describe("dobby brief lint — the required sections", () => {
  it("reports a brief that does not open with the AI disclaimer", async () => {
    const result = await lintBrief(
      mutate(CLEAN_BRIEF, "> *This was generated by AI during triage.*\n\n", "")
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_DISCLAIMER);
  });

  it("reports a Category outside bug|enhancement", async () => {
    const result = await lintBrief(
      mutate(CLEAN_BRIEF, "**Category:** bug", "**Category:** chore")
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_CATEGORY);
  });

  it("reports a missing `Key interfaces` section", async () => {
    const result = await lintBrief(
      mutate(CLEAN_BRIEF, "**Key interfaces:**", "**Notes:**")
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_KEY_INTERFACES);
  });

  it("reports fewer than two acceptance criteria", async () => {
    const result = await lintBrief(
      mutate(
        CLEAN_BRIEF,
        [
          "- [ ] Descriptions under the cap are unchanged",
          "- [ ] Descriptions over the cap break at the last word boundary before it",
          "- [ ] Truncated descriptions end with an ellipsis",
        ].join("\n"),
        "- [ ] Descriptions under the cap are unchanged"
      )
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_ACCEPTANCE);
  });

  it("reports a vacuous acceptance criterion", async () => {
    const result = await lintBrief(
      mutate(
        CLEAN_BRIEF,
        "- [ ] Truncated descriptions end with an ellipsis",
        "- [ ] It works correctly"
      )
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_ACCEPTANCE);
  });

  it("reports an `Out of scope` section with no boundary in it", async () => {
    const result = await lintBrief(
      mutate(
        CLEAN_BRIEF,
        "- Changing the character cap itself\n- Multi-line description support\n",
        ""
      )
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_OUT_OF_SCOPE);
  });
});

// ===========================================================================
// Slice 15 — durability: the brief may sit unactioned for weeks, so it names
// interfaces and contracts, never paths, line numbers, or a to-do list.
// ===========================================================================

describe("dobby brief lint — durability over precision", () => {
  it("reports a file path", async () => {
    const result = await lintBrief(
      mutate(
        CLEAN_BRIEF,
        "- Any function that reads skill frontmatter and extracts the description.",
        "- The parser in `src/skills/frontmatter.ts` reads the description."
      )
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toContain("frontmatter.ts");
    expect(reportOf(result)).toMatch(SAYS_FILE_PATH);
  });

  it("accepts a named project contract file (dobby.config.json is allowlisted)", async () => {
    // The rule bans paths that go stale, not the two manifests every repo keeps
    // at a fixed name — a brief that says "the tracker key in dobby.config.json"
    // is naming a contract, not a location.
    const result = await lintBrief(
      mutate(
        CLEAN_BRIEF,
        "- Any function that reads skill frontmatter and extracts the description.",
        "- The cap is declared in dobby.config.json and read at startup."
      )
    );
    expect(result.exitCode).toBe(0);
  });

  it("reports a line-number reference", async () => {
    const result = await lintBrief(
      mutate(
        CLEAN_BRIEF,
        "cap regardless of word boundaries, so descriptions end mid-word.",
        "cap regardless of word boundaries — the truncation happens around line 150."
      )
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_LINE_REFERENCE);
  });

  it("reports a procedural `Files to change` heading", async () => {
    const result = await lintBrief(
      mutate(CLEAN_BRIEF, "**Out of scope:**", "**Files to change:**")
    );
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_BANNED_HEADING);
  });
});

// ===========================================================================
// Slice 16 — `brief lint --issue N`: the brief as it really arrives, posted as a
// tracker comment. `gh` is the ONE mocked boundary (a stub bin on PATH answering
// the issue-comments payload); the CLI picks the NEWEST comment itself.
// ===========================================================================

function ghComments(bodies: readonly string[]): StubResponse[] {
  return [
    {
      match: "comments",
      stdout: JSON.stringify(
        bodies.map((body, index) => ({ body, id: index + 1 }))
      ),
    },
  ];
}

// A brief with the disclaimer stripped — an older comment that must NOT be the
// one judged when a newer brief follows it.
const STALE_BRIEF = mutate(
  CLEAN_BRIEF,
  "> *This was generated by AI during triage.*\n\n",
  ""
);

interface IssueRun {
  exitCode: number;
  ghArgv: string[][];
  stderr: string;
  stdout: string;
}

async function lintIssue(
  gh: StubResponse[],
  argv: string[] = ["brief", "lint", "--issue", "7"]
): Promise<IssueRun> {
  const root = makeScratchRepo({
    pkg: { name: "fixture-project", private: true },
    prefix: "dobby-artifact-brief-",
    track: scratchDirs,
  });
  const binDir = mkStubBins({ gh }, scratchDirs);
  const result = await withStubPath(binDir, () => run(argv, root));
  return { ...result, ghArgv: readStubLog(binDir, "gh") };
}

describe("dobby brief lint --issue", () => {
  it("lints the NEWEST comment on the issue", async () => {
    // The older comment would fail (no disclaimer); a clean verdict is only
    // possible if the last comment is the one judged.
    const result = await lintIssue(ghComments([STALE_BRIEF, CLEAN_BRIEF]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("asks gh for that issue's comments", async () => {
    const result = await lintIssue(ghComments([CLEAN_BRIEF]));
    const asked = result.ghArgv.some((argv) =>
      argv.some((arg) => arg.includes("issues/7/comments"))
    );
    expect(asked).toBe(true);
  });

  it("reports the newest comment's defects", async () => {
    const result = await lintIssue(ghComments([CLEAN_BRIEF, STALE_BRIEF]));
    expect(result.exitCode).toBe(1);
    expect(reportOf(result)).toMatch(SAYS_DISCLAIMER);
  });

  it("fails hard when gh cannot fetch the issue — never a clean verdict", async () => {
    // The family's refusal contract: nothing was JUDGED, which is not the same
    // answer as "judged and clean" — so `ok` is false with an EMPTY findings
    // list, and the reason goes to stderr.
    const result = await lintIssue(
      [
        {
          exitCode: 1,
          match: "comments",
          stderr: "gh: Not Found (HTTP 404)\n",
        },
      ],
      ["brief", "lint", "--issue", "7", "--json"]
    );
    const payload = payloadOf(result);
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.findings).toEqual([]);
    expect(result.stderr).not.toBe("");
  });
});
