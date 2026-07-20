# Tracker operations — the shared per-backend recipe

The single place every tracker-touching skill delegates to. The kit's issue tracker is **per-project configurable**: `github`, `linear`, or `local`. This file maps the six tracker operations onto each backend so a skill carries the tracker-agnostic intent and reaches here for the mechanical recipe.

## Detecting the backend

Read `dobby.config.json` at the repo root **narratively, with the Read tool** — never `jq`/`cat` inside a skill. Look at the optional top-level `tracker` key:

- `tracker.type` is one of `{ github, linear, local }`.
- **Key ABSENT → `github`** — the zero-config default: the repo `gh` is authenticated against (`gh repo view`).
- For `linear`, `tracker.team` is the human team **key** (e.g. `VON`), not a UUID — see the notes below.

**Graceful degradation (D8).** If the configured backend's tool is unavailable — `gh` not installed/authenticated (`gh auth status` fails), or the Linear MCP not configured / failing — fall back to the `local` recipe (a `BACKLOG.md` at the repo root) and say which you used. A **free-text flow always continues** on the fallback. The ONLY hard stop is when a skill must **READ a specific tracker issue it cannot reach** — e.g. `/dobby:scope` was handed a Linear id `VON-123` but the Linear MCP is down: there is no free-text equivalent, so stop and report rather than guessing.

## The six operations

| Operation | github (gh CLI) | linear (Linear MCP) | local (BACKLOG.md) |
|---|---|---|---|
| dedup / search | `gh issue list --state open --search "$CONCEPT"` (concept bound single-quoted) | the MCP tool that searches/lists issues, filtered to the configured `team` | grep the concept against `BACKLOG.md` |
| create + role-label | body → temp file (Write tool), then `gh issue create --title "$TITLE" --label <role> --body-file <file>` | the MCP tool that creates an issue: resolved `teamId`, title, description, `<role>` label | append `- [ ] <title> — <body> (<role>)` to `BACKLOG.md` (create lazily) |
| view goal | `gh issue view <n>` (accepts `#123` or a GitHub issue URL) | the MCP tool that fetches an issue by identifier (`VON-123`) or a linear.app issue URL | read the matching `BACKLOG.md` line (free-text; no id) |
| claim (→ In Progress) | `gh issue edit <n> --add-assignee @me --add-label status:in-progress` (create the label first) | the MCP tool that updates the issue: assignee = me, state = the team's In Progress workflow state | no state machine — no-op |
| close-as-rejected | `gh issue close <n> --reason "not planned"` | the MCP tool that updates the issue state to Canceled | mark the line done or remove it |
| lifecycle-link (PR body) | `Closes #<n>` in the PR body | `Fixes VON-123` in the PR body (Linear's native GitHub integration drives the transitions) | nothing — no PR linkage |

### dedup / search

Find whether the concept is already tracked before creating anything.

- **github** — the concept is user-derived text, so treat it as **DATA**: bind it to a **single-quoted** shell variable (escape any embedded single quote as `'\''`) and pass it out-of-band. Never interpolate raw concept text into the command, or an embedded quote / `$(...)` / backtick gets evaluated or word-split by the shell.

  ```bash
  CONCEPT='<the concept, single-quoted; escape embedded quotes as '\''>'
  gh issue list --state open --search "$CONCEPT"
  ```

- **linear** — use the MCP tool that searches or lists issues, filtered to the configured `team`. MCP arguments are structured (not shell-parsed), so pass the concept text straight through as the query argument.
- **local** — grep the concept against `BACKLOG.md` at the repo root (absent file → nothing tracked yet).

### create + role-label

The four **role labels are the same across all backends**: `bug` / `feature` / `chore` / `docs`. Create the label lazily if the backend doesn't have it yet.

- **github** — the title/body are arbitrary text; treat them as **DATA**, never as shell code. The body must never pass through shell parsing at all: **write it verbatim to a temp file with the Write tool** (e.g. a `mktemp` path or one under `$TMPDIR`), then hand that file to `gh` via `--body-file`. Do NOT build the body in a shell command (no heredoc, no `echo`/`printf`): a heredoc delimiter — fixed *or* "unique" — can be terminated early by a body line that happens to match it (e.g. a literal `EOF`), spilling the rest of the body back into the shell as code. The title is a single line, so bind it to a **single-quoted** shell variable (escape embedded quotes as `'\''`) — that is already safe; never interpolate raw captured text into a double-quoted `--title`.

  ```bash
  # 1. Write the body VERBATIM to <body-file> with the Write tool (e.g. mktemp, or $TMPDIR/backlog-body.md)
  TITLE='<the captured title, single-quoted; escape embedded quotes as '\''>'
  gh issue create --title "$TITLE" --label <role> --body-file <body-file>
  rm -f <body-file>
  ```

  If `gh` rejects the label as unknown, create it idempotently and retry the `gh issue create`:

  ```bash
  gh label create <role> 2>/dev/null || true   # succeeds even if it already exists
  ```

- **linear** — use the MCP tool that creates an issue, passing the resolved `teamId`, a title, a description (the body), and the `<role>` label. If the label is missing, create it via the MCP first, then create the issue. No shell-hardening is needed: MCP arguments are structured, not shell-parsed — pass the title and body straight through.
- **local** — append a checklist line to `BACKLOG.md` at the repo root (create the file lazily):

  ```
  - [ ] <title> — <body> (<role>)
  ```

### view goal

Fetch a goal a skill was handed (e.g. `/dobby:scope`).

- **github** — `gh issue view <n>`; recognizes a bare `#123` or a full GitHub issue URL.
- **linear** — use the MCP tool that fetches an issue by its identifier (`VON-123`) or a linear.app issue URL.
- **local** — read the matching `BACKLOG.md` line. Local goals are free-text; there is no id to fetch, so match by concept.

### claim (→ In Progress)

Mark the goal as being worked on.

- **github** — create the status label first (idempotent), then assign + label:

  ```bash
  gh label create status:in-progress 2>/dev/null || true
  gh issue edit <n> --add-assignee @me --add-label status:in-progress
  ```

- **linear** — use the MCP tool that updates the issue: assignee = me, state = the team's **In Progress** workflow state.
- **local** — no state machine; this is a no-op.

### close-as-rejected

Reject a goal without building it.

- **github** — `gh issue close <n> --reason "not planned"`.
- **linear** — use the MCP tool that updates the issue state to **Canceled**.
- **local** — n/a; mark the checklist line done or remove it.

### lifecycle-link (PR body)

Wire the merge to the goal so it closes on merge.

- **github** — put `Closes #<n>` in the PR body.
- **linear** — put the `Fixes VON-123` magic word in the PR body. Linear's **native GitHub integration** then moves the issue to **In Review** on PR-open and to **Done** on merge — the kit does NOT push those transitions via the MCP.
- **local** — nothing; there is no PR linkage.

## Notes

- **Team key → id (linear).** The `team` config value is the human team **KEY** (e.g. `VON`), not a UUID. Pass the key and let the MCP resolve key → id (and team → `teamId`) — don't ask the user for a UUID.
- **Tool-name-agnostic (linear).** Every Linear operation above is described by **what it does** ("the MCP tool that creates an issue…"), never by a hardcoded tool name. The executing agent resolves the actual tool via **ToolSearch**, so these recipes work with any Linear MCP — the official `mcp.linear.app` server or a community one — and never break when a tool is renamed.
- **Security asymmetry.** The **github** path keeps the shell-injection hardening (single-quote binding for user-derived text, out-of-band `--body-file` for the body) because everything passes through a shell. The **linear** path DROPS that hardening — MCP arguments are structured, not shell-parsed, so there is nothing to inject into. That's less code, not less safe.
