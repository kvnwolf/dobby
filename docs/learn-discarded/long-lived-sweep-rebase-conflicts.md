# A long-lived sweep branch collides with new main commits

**Friction** — a repo-wide sweep landed on a long-lived worktree and had to be rebased over commits that had landed on `main` in the meantime, producing 12 conflicts (3 of them modify/delete), plus a permission-classifier block on redirect-based `awk` piping partway through the resolution. Two files that `--ours` had silently reverted during the rebase had to be re-done afterward.

**Decision: discarded** (2026-08-16, `/dobby:learn` from the solraci/vonda sweep session).

**Why** — this is long-lived-branch hygiene, not sweep methodology. Any repo-wide change sitting on a worktree for days collides the same way regardless of what produced it, and the kit already owns the remedy in `/dobby:resolve-conflicts`. Encoding rebase rules into the shared sweep contract would make every future sweep pay for a condition that is about branch DURATION, not about sweeping.

**Reconsider if** — sweeps become routine and repeated, such that "sweep on a fresh branch and land the PR the same day" earns its place as a precondition of the skill itself rather than general branch hygiene.

## Prior occurrences

- 2026-08-16 session (solraci/vonda repo-wide trim sweep, long-lived worktree) — rebase over new `main` commits produced 12 conflicts (3 modify/delete) plus an `awk` redirect-piping permission block; two `--ours`-reverted files had to be redone
