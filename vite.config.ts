import { defineConfig } from "vite-plus";

const ignorePatterns = [
  ".claude/**",
  ".claude-plugin/**",
  ".github/**",
  "cli/__fixtures__/**",
  "docs/**",
  "plugin/**",
  "**/*.md",
];

export default defineConfig({
  fmt: { ignorePatterns },
  lint: { ignorePatterns },
  run: {
    tasks: {
      check: { command: "vp check" },
      test: { command: "vp test" },
      unused: { cache: false, command: "vpx knip" },
      update: { cache: false, command: "vpx taze -r --interactive" },
      validate: { command: "vpr check && vpr unused && vpr test" },
    },
  },
});
