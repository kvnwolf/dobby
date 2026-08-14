# 0026. Track the sweep ledger inside the ignored .dobby directory

An incremental sweep needs per-file state that survives clones and worktrees, so it must be committed — but the natural home, `.dobby/`, is ignored by design because it holds machine-local state such as the gate cache. We put the ledger at `.dobby/sweeps.json` anyway and made it a deliberate exception: the coordinator runs `git add -f -- .dobby/sweeps.json` exactly once, only when the file did not previously exist and only after an independent reviewer has validated it; later updates are already tracked and stage normally. A separate root-level file was rejected because it scatters sweep state away from the directory that names it, and changing the CLI's ignore rules was rejected because the rest of `.dobby/` must stay local.

The ledger keys state per file and per skill, so neither skill can certify the other:

```json
{
  "schemaVersion": 1,
  "files": {
    "relative/path.md": {
      "trim-context": { "contentHash": "sha256:…", "rulesVersion": "human-text-v1" },
      "anti-slop":    { "contentHash": "sha256:…", "rulesVersion": "contextual-slop-v1" }
    }
  }
}
```

## Consequences

The exception is easy to lose. A smoke test caught the contract claiming that "normal commit flow makes it tracked", which is false in every consumer where `.dobby/` is ignored — the ledger would have stayed untracked forever and every run would have repeated a full sweep. The same test caught a flat single-skill manifest that would have made the other skill's entry look like corruption and fail closed. Both were fixed before shipping; the shape above is what the contract now validates, with a malformed shared container failing closed for both skills and a malformed sub-entry failing closed only for its owner.
