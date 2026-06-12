# Skill Frontmatter Fields

Verified against `code.claude.com/docs/en/skills` (Claude Code 2.1.162, June 2026). Only `name` and `description` are required; everything else is optional. Names are hyphenated except `when_to_use` and `arguments`.

## Required

| Field | Semantics | Example |
|---|---|---|
| `name` | Display label in listings. For directory-based skills the COMMAND name is the directory name, NOT this field. Lowercase letters, numbers, hyphens; ≤64 chars; can't contain `anthropic`/`claude`. | `name: pdf-processing` |
| `description` | What it does + when to use it, third person (it's injected into the system prompt). ≤1024 chars; with `when_to_use` capped at 1536 in the listing. Drives auto-invocation. | `description: Extract text/tables from PDFs… Use when the user mentions PDFs or forms.` |

## Discovery & invocation

| Field | Semantics | Example |
|---|---|---|
| `when_to_use` | Extra trigger phrases / example requests appended to `description` (shares the 1536 cap). | `when_to_use: document parsing, form automation` |
| `argument-hint` | Autocomplete hint for the expected arguments. | `argument-hint: [issue-number]` |
| `arguments` | Named positional args for `$name` substitution in the body. Space-separated or YAML list. | `arguments: [issue, branch]` |
| `disable-model-invocation` | `true` = only the user can invoke (`/name`); the model won't auto-load it. Default `false`. | `disable-model-invocation: true` |
| `user-invocable` | `false` = hidden from the `/` menu; only the model invokes it (background knowledge). Default `true`. | `user-invocable: false` |
| `paths` | Globs that limit AUTO-activation to matching files. Comma-separated or YAML list. | `paths: src/**/*.ts` |

## Execution control

| Field | Semantics | Example |
|---|---|---|
| `allowed-tools` | Tools usable without per-use approval while the skill is active. Does not restrict other tools. | `allowed-tools: Bash(git add *) Bash(git commit *)` |
| `disallowed-tools` | Tools removed from the pool while active (clears on the next user message). For autonomous skills that must not prompt. | `disallowed-tools: AskUserQuestion` |
| `model` | Model for the skill's turn (override, not saved). Same values as `/model`, or `inherit`. | `model: claude-opus-4-8` |
| `effort` | Reasoning effort for the skill's turn: `low\|medium\|high\|xhigh\|max` (available levels depend on the model). Default inherits the session. | `effort: xhigh` |
| `context` | `fork` runs the skill in an isolated subagent; the body becomes the subagent's task prompt. | `context: fork` |
| `agent` | Subagent type when `context: fork` (Explore / Plan / general-purpose / a custom agent). | `agent: Explore` |
| `hooks` | Hooks scoped to the skill's lifecycle (matchers + hook types). See `code.claude.com/docs/en/hooks`. | (nested YAML) |
| `shell` | Shell for `` !`command` `` blocks: `bash` (default) or `powershell` (needs `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`). | `shell: powershell` |

## NOT skill frontmatter

`version`, `license`, `metadata`, `min-version` are **not** skill fields — `version`/`license` belong to a plugin's `.claude-plugin/plugin.json`; `metadata` and `min-version` don't exist. Don't put them in `SKILL.md`.
