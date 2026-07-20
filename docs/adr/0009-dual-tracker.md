# Dual-tracker: GitHub Issues default + opt-in Linear / local

**Status:** accepted — overrides the PR #10 commit decision
("standardize on GitHub Issues, drop Linear"), which had no ADR.

The work skills' issue tracker is now per-project configurable via an optional
`tracker` key in `dobby.config.json` — `github` (default), `linear` (with a
`team` key, via the Linear MCP), or `local` (a plain `BACKLOG.md`). GitHub Issues
stays the zero-config default (the `gh`-authenticated repo IS the tracker when the
key is absent), so every existing repo is unaffected. All per-backend knowledge
lives in one shared reference (`backlog/references/trackers.md`) that the
tracker-touching skills (`backlog`, `scope`, `commit`, `triage`,
`resolve-conflicts`) delegate to, keeping them tracker-agnostic. The kit writes
Linear state in exactly ONE place — `scope → In Progress`; In Review (PR open) and
Done (merge) are handled by Linear's native GitHub integration via a `Fixes VON-123`
PR-body link, not by the kit.

## Considered options

- **Dual-tracker with a shared reference (chosen)** — one `tracker` key, one
  `trackers.md` mapping 6 ops × 3 backends; skills stay tracker-agnostic. Reintroduces
  Linear (reverting #10) but as opt-in config, not a forced abstraction. Motivated by a
  real project (Vonda) whose tracker is Linear.
- **Stay GitHub-only (#10's status quo)** — rejected: a real project runs on Linear;
  #10's premise ("nobody uses the multi-tracker path") no longer holds.
- **Replace GitHub with Linear** — rejected: dobby and other repos live on GitHub Issues;
  a straight swap loses the zero-config `repo→tracker` derivation everywhere to serve one repo.
- **Scattered `if tracker == linear` branches** — rejected: the multi-tracker abstraction
  #10 removed. The shared `trackers.md` centralizes all backend knowledge instead.

## Consequences

- GitHub keeps a natural `repo → tracker` derivation (zero-config); Linear does not
  (`workspace → teams → issues`, `teamId` required), so a Linear project MUST set
  `tracker.team` — the MCP OAuth authenticates the user but does not disambiguate the team.
  Inherent asymmetry, not a kit limitation.
- The kit only pushes `scope → In Progress`; In Review/Done rely on the user configuring
  Linear's native GitHub integration + two per-team PR automations (PR opened → In Review,
  PR merged → Done). `/dobby:onboard` reminds them.
- `local` (`BACKLOG.md`) is both a first-class explicit choice AND the graceful-degradation
  destination when `gh`/the Linear MCP is unavailable — one recipe, two entry points.
- `/dobby:migrate-config` reversed its rule that DELETED a Linear tracker line from CLAUDE.md;
  it now MECHANIZES it into the `tracker` key (the old rule would have destroyed valid config).
