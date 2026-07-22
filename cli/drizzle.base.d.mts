// Types for the untyped ./drizzle.base.mjs — a consumer's strict tsc hits TS7016 (implicit any) when re-exporting the plain .mjs, so this sibling declaration types its default export (`drizzle-kit` resolves from the CONSUMER's tree, same as the .mjs import).
import type { Config } from "drizzle-kit";

declare const config: Config;
export default config;
