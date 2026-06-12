#!/bin/bash

# Global PostToolUse hook: lint/format-check edited files via vite-plus (vp).
# This hook is registered globally, so it fires in every project — gate it to
# vite-plus projects only. A vite.config.ts at the project root is the vp entry
# point (see a vp project's CLAUDE.md); without it, or without vp on PATH, no-op.
[[ -f "${CLAUDE_PROJECT_DIR:-$PWD}/vite.config.ts" ]] || exit 0
command -v vp >/dev/null 2>&1 || exit 0

file_path=$(jq -r '.tool_input.file_path // empty')

if [[ "$file_path" =~ \.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json|jsonc)$ ]]; then
  output=$(vp check --fix --no-error-on-unmatched-pattern "$file_path" 2>&1)
  status=$?
  if [[ $status -ne 0 ]]; then
    {
      echo "$output" | sed 's/\x1b\[[0-9;]*m//g' | awk '
        /^[[:space:]]*x [a-z][a-z-]*\(/ {
          msg = $0
          sub(/^[[:space:]]*x /, "", msg)
          next
        }
        /,-\[.*:[0-9]+:[0-9]+\]/ {
          loc = $0
          sub(/.*\[/, "", loc)
          sub(/\].*/, "", loc)
          if (msg) { print loc " " msg; msg = "" }
          next
        }
        /^Found [0-9]+ errors/ { print; next }
        /^error: Formatting/ { print; next }
        /Found formatting issues/ { print; next }
      '
    } >&2
    exit 2
  fi
fi
