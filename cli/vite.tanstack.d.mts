// Types for the untyped ./vite.tanstack.mjs — a consumer's strict tsc hits TS7016 (implicit any) when re-exporting the plain .mjs, so this sibling declaration types its default export (`vite` resolves from the CONSUMER's tree, same as the .mjs import).
import type { UserConfig } from "vite";

declare const config: UserConfig;
export default config;
