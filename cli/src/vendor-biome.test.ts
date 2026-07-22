import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  generateVendoredBiome,
  VENDORED_BIOME_PATHS,
} from "../scripts/vendor-biome.ts";

// Drift guard for the VENDORED biome presets. `generateVendoredBiome()` reads the
// INSTALLED ultracite, applies dobby's modifications, and returns the two file
// bodies deterministically; this suite regenerates in-memory and byte-compares
// against the committed files. Any ultracite upgrade (new rules / renamed rules /
// reordered keys) OR a hand-edit of the committed presets makes the bytes differ,
// so the gate screams until someone reruns `bun cli/scripts/vendor-biome.ts`.
describe("vendored biome presets", () => {
  it("core.jsonc matches the generator (no ultracite drift, no hand-edit)", () => {
    const { core } = generateVendoredBiome();
    expect(readFileSync(VENDORED_BIOME_PATHS.core, "utf8")).toBe(core);
  });

  it("react.jsonc matches the generator (no ultracite drift, no hand-edit)", () => {
    const { react } = generateVendoredBiome();
    expect(readFileSync(VENDORED_BIOME_PATHS.react, "utf8")).toBe(react);
  });
});
