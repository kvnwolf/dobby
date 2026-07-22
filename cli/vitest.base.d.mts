// Types for the untyped ./vitest.base.mjs — a consumer's strict tsc hits TS7016 (implicit any) when re-exporting the plain .mjs, so this sibling declaration types its default export (`vitest/config` resolves from the CONSUMER's tree, same as the .mjs import).
import type { UserConfig } from "vitest/config";

declare const config: UserConfig;
export default config;
