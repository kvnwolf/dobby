# Tracker seeds

Per-backend seed for the **Workflow config** section of `CLAUDE.md` (Step 3) — drop in the block matching the issue tracker the user chose in Step 1, then fill the placeholders. Also a role→label table so `/dobby:backlog` and `/dobby:triage` file issues with a consistent, dedup-able vocabulary from day one.

Pick ONE tracker. If the user has no tracker yet, use the **local markdown** seed (a `docs/backlog/` folder) — it has a real destination and can migrate to a hosted tracker later.

## GitHub Issues

```md
## Workflow config

- **Issue tracker**: GitHub Issues (`<owner>/<repo>`). `/dobby:backlog` and `/dobby:triage` file here via the `gh` CLI.
- **Labels**: see the role→label table below. Create them once with `gh label create <name> --color <hex>`.
```

`gh` is the mechanics reference — cross-refs already live in `skills/address-review/references/github-api.md`. Auth via `gh auth status` / `GH_TOKEN`.

## Linear

```md
## Workflow config

- **Issue tracker**: Linear (team `<TEAM-KEY>`). `/dobby:backlog` and `/dobby:triage` file here.
- **Labels**: see the role→label table below — create matching Linear labels in the team settings.
```

Linear needs an API key (`LINEAR_API_KEY`) — a secret, so it goes in `.conductor/settings.local.toml`, never `settings.toml`. This is a candidate to script with `/dobby:wizard`.

## Local markdown (no hosted tracker)

```md
## Workflow config

- **Issue tracker**: local markdown — one file per issue under `docs/backlog/` (kebab-case, `# Title` + behavioral body). `/dobby:backlog` writes here; migrate to a hosted tracker later.
- **Labels**: encode the role as a `**Type:**` line in each file's body (see the role→label table).
```

Create `docs/backlog/` lazily (on the first issue) — don't commit an empty dir.

## Role→label table

One vocabulary across trackers so issues dedup by concept, not by whoever happened to file them. Map the ROLE an issue plays; the color is a suggestion (GitHub `--color`), the Linear/markdown column is the equivalent.

| Role (what the issue is) | GitHub label | Color | Linear / markdown equivalent |
|---|---|---|---|
| Bug — something is broken | `bug` | `d73a4a` | `Bug` label / `**Type:** Bug` |
| Feature — new capability | `feature` | `0e8a16` | `Feature` / `**Type:** Feature` |
| Chore — maintenance, deps, config | `chore` | `fbca04` | `Chore` / `**Type:** Chore` |
| Out-of-scope — declined, captured for dedup | `wontfix` | `ffffff` | `Wontfix` / `**Type:** Wontfix` |
| Docs — documentation only | `docs` | `0075ca` | `Docs` / `**Type:** Docs` |
| Question — needs a decision first | `question` | `d876e3` | `Triage` / `**Type:** Question` |

`/dobby:triage`'s out-of-scope KB (`docs/out-of-scope/`) pairs with the `wontfix` role — a declined request is filed there AND (if a tracker issue exists) labeled `wontfix`, so future dedup finds it either way.
