# Tracker operations — the CLI's surface, and the two things it can't do for you

The single place every tracker-touching skill delegates to. The kit's issue tracker is **per-project configurable** — `github`, `linear`, or `local` — and the `dobby` CLI reads that selection itself (`dobby.config.json#tracker`, key absent → `github`, the repo `gh` is authenticated against). A skill therefore names the **operation**, never the backend, and never hand-writes `gh`.

Two things stay outside the CLI, and they are what this file exists for:

1. **Linear is never spawned.** On a `linear` project every tracker command answers with a **delegation descriptor** — `{delegate:"mcp", op, …}` — that YOU execute through the Linear MCP.
2. **Degradation is reported, never performed.** When the configured backend can't be reached, the CLI says so and stops; falling back to the local `BACKLOG.md` is the session's move, in the format below.

## Detecting the backend

```bash
bunx dobby tracker info --json
# {type, team, available, degradedTo, reason}
```

- **`type`** — `github` | `linear` | `local`.
- **`team`** — Linear's human team **KEY** (e.g. `VON`), never a UUID; null on the other backends.
- **`available`** — github: `gh`'s own verdict. local: always true. linear: **null** — reachability is MCP-side and the CLI never talks to the MCP, so you discover it by calling the tool.
- **`degradedTo` / `reason`** — **D8, now mechanical**: `degradedTo: "local"` means `gh` is absent, off PATH, or unauthenticated. Use the local recipe below and **say which you used**; a free-text flow always continues on the fallback. Don't retry the github command hoping for a different answer — `search` / `create` / `close` / `claim` fail loudly rather than silently rerouting your write into a `BACKLOG.md` nobody asked for.

**The one hard stop** is a skill that must READ a specific issue it cannot reach — `/dobby:scope` handed `VON-123` with the Linear MCP down, or a github issue goal while `gh` is unauthenticated (`dobby goal parse` reports that one as `hardStop`). There is no free-text equivalent: stop and report.

## The six operations

| Operation | Command | linear answers | degraded → local |
|---|---|---|---|
| dedup / search | `bunx dobby tracker search "<concept>" --json` | `op:"search"` descriptor | grep `BACKLOG.md` |
| create + role-label | `bunx dobby tracker create --title "<t>" --body-file <f> --label <role> --json` | `op:"create"` descriptor | append a checklist line |
| view goal | *the one operation the CLI does not own* — see below | the MCP tool that fetches an issue | read the matching line |
| claim (→ In Progress) | `bunx dobby claim <id> --json` | `op:"claim"` descriptor | no state machine — no-op |
| close-as-rejected | `bunx dobby tracker close <id> --rejected --json` | `op:"setState"` descriptor | mark the line `- [x]` |
| lifecycle-link (PR body) | `bunx dobby goal parse "<goal>" --json` → `lifecycleLink` | `Fixes VON-123` | none — no PR linkage |

`<id>` is the bare id whichever backend answers: `42` (github, no `#`), `VON-123` (linear), or the item's **title** (local).

The four **role labels are the same on every backend** — `bug` / `feature` / `chore` / `docs` — and a missing one is created lazily before the issue references it.

**The CLI owns the github path end to end**: label-then-create and label-then-edit ordering, the body handed over as a file, `--reason "not planned"` on a close, `@me` + `status:in-progress` on a claim. `tracker close` REQUIRES `--rejected` because that is the only close the kit performs — a *completed* goal is closed by its merged PR's lifecycle link.

### view goal — the exception

Fetching an issue's body and comments is a read the CLI has no verb for; `bunx dobby goal parse "<goal>" --json` only resolves the reference (`{source, id, url, slug, slugCollision, lifecycleLink, hardStop}`). Fetch the content yourself:

- **github** — `gh issue view <n>` (accepts `#123` or a GitHub issue URL).
- **linear** — the MCP tool that fetches an issue by identifier (`VON-123`) or a linear.app issue URL.
- **local** — read the matching `BACKLOG.md` line; local goals are free text, so match by concept.

## Linear — the delegation descriptors

A `linear` project gets a descriptor back instead of an action. Execute the named **operation** through whichever Linear MCP tool you resolve via **ToolSearch**: this file names tools by what they DO, never by a hardcoded name, so the recipes work with any Linear MCP (the official `mcp.linear.app` server or a community one) and survive a rename. Pass `team` as the **key** and let the MCP resolve key → id.

| Command | Descriptor | Execute as |
|---|---|---|
| `tracker search` | `{delegate:"mcp", op:"search", args:{query, team}}` | search/list issues, filtered to `team` |
| `tracker create` | `{delegate:"mcp", op:"create", args:{title, body, label, team}}` | create an issue: `teamId` resolved from the key, title, description = `body`, the `<role>` label (create it via the MCP first if missing) |
| `tracker close --rejected` | `{delegate:"mcp", op:"setState", id, state:"Canceled", team}` | set the issue's state to **Canceled** |
| `claim` | `{delegate:"mcp", op:"claim", id, assignee:"me", state:"In Progress", team}` | assignee = me, state = the team's **In Progress** workflow state |

The claim is the kit's **only** Linear state write besides Canceled. In Review (on PR-open) and Done (on merge) come from Linear's **native GitHub integration**, driven by the `Fixes VON-123` magic word in the PR body — which is why `goal parse` emits that word and why the kit pushes no further transitions through the MCP.

MCP arguments are structured, not shell-parsed: pass the title, body and query straight through.

## Local — the `BACKLOG.md` format

One checklist line per item, in a `BACKLOG.md` at the repo root that is created lazily:

```
- [ ] <title> — <first line of the body> (<role>)
```

`- [x]` is closed; a search reads only the open lines. The CLI writes and reads this itself on a `local` project. You write it **by hand only** when `tracker info` reported `degradedTo: "local"` — and then you say so.

## Superseded: the shell-hardening recipe

This file used to carry a block on binding user-derived text to single-quoted shell variables (escaping embedded quotes as `'\''`), never building an issue body with a heredoc (a body line reading `EOF` terminates the delimiter early and spills the rest back as code), and passing the body out of band.

**That hazard class is dead.** Every tracker command spawns `gh` as an **argv array**: a concept, a title, an id lands as ONE argument whatever bytes it holds — quotes, `$(…)`, backticks, `&&`, newlines — because no shell ever parses it. The body never reaches argv at all; `--body-file` hands `gh` a path. Write the title and body verbatim; there is nothing left to escape, and nothing to re-derive here.

The one habit that survives is not a security rule: **the body goes to a file** — because that is the flag's shape. Write it (and every other `--*-file` hand-off) to an absolute path **outside the repo** — the OS temp dir, e.g. `/tmp/dobby-item-<timestamp>.md`; `Write` takes a literal path, so no `${TMPDIR:-/tmp}` shell syntax, which would create that directory under the repo root. These files are hand-offs, not artifacts: a stray one at the repo root gets staged by the next `bunx dobby ship`, so `rm -f` it once the command has run.
