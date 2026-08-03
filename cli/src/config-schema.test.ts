import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ConfigLoad, type DobbyConfig, loadConfig } from "./config.ts";

// Tests for the dobby.config.json `tracker` + `release` schema keys, written from
// the spec BEFORE any implementation exists.
//
// Seam: `loadConfig(root)` — the SOLE reader of dobby.config.json (cli/CONTEXT.md
// invariant). Every case writes a REAL dobby.config.json into a throwaway temp dir
// and reads the result through the public tolerant tri-state contract
// (null / {ok:false,error} / {ok:true,config}). No internals are touched.
//
// Where every expected value comes from (independence):
//  - The accepted `tracker.type` values (github | linear | local) and
//    `release.type` values (npm | homebrew-cask) are LITERALS enumerated by the
//    spec — not read back out of any code.
//  - Each "what was expected" word asserted in an error message (string / array /
//    object) is the spec's OWN word for that malformed case ("non-string
//    team/tap/cask/dir, non-array lockstep, non-object surfaces").
//  - Every passthrough assertion compares against the literal value written into
//    the fixture FILE — the input document, never a recomputation of whatever the
//    loader does with it.
//  - `notaryProfile` is the spec's OWN key name, and its value is a notarytool
//    KEYCHAIN PROFILE name — an opaque string the loader may never interpret, so
//    the fixture's literal is the whole expectation.
//  - The github-passenger fixture is the shape the spec states mad-eye's real
//    config already carries.
//
// Why these are RED before the implementation:
//  - The validation cases fail at RUNTIME today: loadConfig blind-casts
//    JSON.parse, so every malformed value currently returns {ok:true}.
//  - The typed-passthrough cases fail at TYPE-CHECK today: `DobbyConfig` has no
//    `tracker`/`release` member, so `config.tracker` / `config.release` are tsc
//    errors. tsc is part of `dobby check`, so the gate stays red until the schema
//    lands, and they additionally guard against an OVER-strict validator
//    rejecting a legitimate config at runtime.

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A throwaway project root. `contents` is written VERBATIM (raw text, never
// re-serialized) so each fixture states exactly what sits on disk.
function rootWithConfig(contents: string): string {
  const dir = emptyRoot();
  writeFileSync(join(dir, "dobby.config.json"), contents);
  return dir;
}

function emptyRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dobby-config-schema-"));
  tempRoots.push(dir);
  return dir;
}

// Narrowing helpers — they turn a wrong tri-state branch into a readable failure
// instead of a type error at the assertion site.
function expectAccepted(load: ConfigLoad | null): DobbyConfig {
  if (load === null) {
    throw new Error(
      "expected {ok:true}, got null (no config file was written)"
    );
  }
  if (!load.ok) {
    throw new Error(`expected {ok:true}, got {ok:false}: ${load.error}`);
  }
  return load.config;
}

function expectRejected(load: ConfigLoad | null): string {
  if (load === null) {
    throw new Error(
      "expected {ok:false}, got null (no config file was written)"
    );
  }
  if (load.ok) {
    throw new Error(
      `expected {ok:false}, got {ok:true}: ${JSON.stringify(load.config)}`
    );
  }
  return load.error;
}

describe("loadConfig() — tracker key", () => {
  // TRACER BULLET: the real-world regression this task must not break. mad-eye's
  // committed config already carries `tracker: {type: "github"}` as an untyped
  // passenger alongside the existing keys; it must keep loading, and the value
  // must now be readable through the typed schema.
  it("accepts a real config carrying a github tracker beside files[] and checks[]", () => {
    const root = rootWithConfig(`{
      "files": [{ "path": "README.md", "update_when": ["a command changes"] }],
      "checks": [{ "name": "manifest", "run": "bun run scripts/manifest.ts" }],
      "tracker": { "type": "github" }
    }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.tracker?.type).toBe("github");
  });

  it("accepts a linear tracker with its team", () => {
    // `team` is the non-inferable Linear needs (GitHub derives from the repo).
    const root = rootWithConfig(`{
      "tracker": { "type": "linear", "team": "VON" }
    }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.tracker).toEqual({ team: "VON", type: "linear" });
  });

  it("accepts a local tracker", () => {
    const root = rootWithConfig(`{ "tracker": { "type": "local" } }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.tracker?.type).toBe("local");
  });

  it("accepts a linear tracker without a team (team is optional in the schema)", () => {
    // The spec declares `team?: string` — an absent team is NOT one of the
    // enumerated malformed cases, so it must pass through, not fail the load.
    const root = rootWithConfig(`{ "tracker": { "type": "linear" } }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.tracker?.team).toBeUndefined();
  });

  it("accepts a config with no tracker key at all", () => {
    const root = rootWithConfig(`{ "setup": ["bun run codegen"] }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.tracker).toBeUndefined();
  });

  it("rejects a tracker type outside github/linear/local, naming the key and the accepted values", () => {
    const root = rootWithConfig(`{ "tracker": { "type": "jira" } }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("tracker");
    expect(error).toContain("type");
    expect(error).toContain("github");
    expect(error).toContain("linear");
    expect(error).toContain("local");
  });

  it("rejects a non-string tracker team, naming the key and the expected type", () => {
    const root = rootWithConfig(`{
      "tracker": { "type": "linear", "team": 42 }
    }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("team");
    expect(error).toMatch(/string/i);
  });

  it("rejects a tracker that is not an object", () => {
    const root = rootWithConfig(`{ "tracker": "github" }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("tracker");
  });
});

describe("loadConfig() — release key", () => {
  it("accepts an npm release block with dir, lockstep and surfaces", () => {
    const root = rootWithConfig(`{
      "release": {
        "type": "npm",
        "dir": "cli",
        "lockstep": ["cli", "plugin"],
        "surfaces": { "cli": "cli/package.json", "plugin": "plugin/plugin.json" }
      }
    }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.release).toEqual({
      dir: "cli",
      lockstep: ["cli", "plugin"],
      surfaces: { cli: "cli/package.json", plugin: "plugin/plugin.json" },
      type: "npm",
    });
  });

  it("accepts a homebrew-cask release block with tap and cask", () => {
    const root = rootWithConfig(`{
      "release": { "type": "homebrew-cask", "tap": "kvnwolf/tap", "cask": "mad-eye" }
    }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.release?.tap).toBe("kvnwolf/tap");
    expect(config.release?.cask).toBe("mad-eye");
  });

  it("accepts a homebrew-cask release block carrying a notaryProfile", () => {
    // The notarytool KEYCHAIN PROFILE name — the ONLY credential dobby ever
    // learns about (mad-eye ADR 0005: no APPLE_ID/APPLE_PASSWORD env vars).
    const root = rootWithConfig(`{
      "release": {
        "type": "homebrew-cask",
        "tap": "kvnwolf/tap",
        "cask": "mad-eye",
        "notaryProfile": "mad-eye-notary"
      }
    }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.release?.notaryProfile).toBe("mad-eye-notary");
  });

  it("accepts a homebrew-cask release block with no notaryProfile (the key is optional)", () => {
    // Every config written before notarization existed carries no such key, and
    // its absence is the un-notarized flow, never a load failure.
    const root = rootWithConfig(`{
      "release": { "type": "homebrew-cask", "tap": "kvnwolf/tap", "cask": "mad-eye" }
    }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.release?.notaryProfile).toBeUndefined();
  });

  it("accepts a config with no release key at all", () => {
    const root = rootWithConfig(`{ "tracker": { "type": "github" } }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.release).toBeUndefined();
  });

  it("rejects a release type outside npm/homebrew-cask, naming the key and the accepted values", () => {
    const root = rootWithConfig(`{ "release": { "type": "brew" } }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("release");
    expect(error).toContain("type");
    expect(error).toContain("npm");
    expect(error).toContain("homebrew-cask");
  });

  it("rejects a non-string release dir, naming the key and the expected type", () => {
    const root = rootWithConfig(`{ "release": { "type": "npm", "dir": 12 } }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("dir");
    expect(error).toMatch(/string/i);
  });

  it("rejects a non-array lockstep, naming the key and the expected type", () => {
    const root = rootWithConfig(`{
      "release": { "type": "npm", "lockstep": "cli" }
    }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("lockstep");
    expect(error).toMatch(/array/i);
  });

  it("rejects a non-object surfaces, naming the key and the expected type", () => {
    const root = rootWithConfig(`{
      "release": { "type": "npm", "surfaces": "cli/package.json" }
    }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("surfaces");
    expect(error).toMatch(/object/i);
  });

  it("rejects an array surfaces (an array is not a name -> path map)", () => {
    // `typeof [] === "object"`, so this is the case a naive typeof check lets
    // through; surfaces is a Record<string,string>, never a list.
    const root = rootWithConfig(`{
      "release": { "type": "npm", "surfaces": ["cli/package.json"] }
    }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("surfaces");
  });

  it("rejects a non-string tap, naming the key and the expected type", () => {
    const root = rootWithConfig(`{
      "release": { "type": "homebrew-cask", "tap": true }
    }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("tap");
    expect(error).toMatch(/string/i);
  });

  it("rejects a non-string cask, naming the key and the expected type", () => {
    const root = rootWithConfig(`{
      "release": { "type": "homebrew-cask", "cask": ["mad-eye"] }
    }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("cask");
    expect(error).toMatch(/string/i);
  });

  it("rejects a non-string notaryProfile, naming the key and the expected type", () => {
    const root = rootWithConfig(`{
      "release": { "type": "homebrew-cask", "notaryProfile": true }
    }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("notaryProfile");
    expect(error).toMatch(/string/i);
  });

  it("rejects a release that is not an object", () => {
    const root = rootWithConfig(`{ "release": 42 }`);

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("release");
  });
});

describe("loadConfig() — validation stays scoped to tracker + release", () => {
  it("still accepts a config whose OTHER keys are malformed (the rest stays blind-cast)", () => {
    // `checks` here is a string and `files` a number — both nonsense against the
    // declared schema — plus an unknown forward-compat key. The spec scopes
    // validation to the two NEW keys only: this must load ok:true.
    const root = rootWithConfig(`{
      "checks": "not-an-array",
      "files": 7,
      "future_key": { "anything": true },
      "tracker": { "type": "github" }
    }`);

    const config = expectAccepted(loadConfig(root));

    expect(config.tracker?.type).toBe("github");
  });

  it("accepts an empty config object", () => {
    const root = rootWithConfig("{}");

    expect(expectAccepted(loadConfig(root))).toEqual({});
  });
});

describe("loadConfig() — the tolerant tri-state contract is preserved", () => {
  it("returns null when there is no dobby.config.json at the root", () => {
    expect(loadConfig(emptyRoot())).toBeNull();
  });

  it("returns {ok:false} naming the file when the JSON is unparseable", () => {
    const root = rootWithConfig("{ not json");

    const error = expectRejected(loadConfig(root));

    expect(error).toContain("dobby.config.json");
  });

  it("never throws on wildly-typed tracker/release values", () => {
    const root = rootWithConfig(`{ "tracker": [], "release": [] }`);

    expect(() => loadConfig(root)).not.toThrow();
    expect(expectRejected(loadConfig(root)).length).toBeGreaterThan(0);
  });
});
