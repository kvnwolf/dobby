# Skills run on the session tier; agents stay pinned

**Status:** accepted

The kit originally pinned an explicit `model:`/`effort:` on **every** skill and agent — leverage points (spec, interview, map, diagnose, kit self-improvement) on a top tier, coordination/execution cheaper — and added a `frontmatter-model-effort` pre-commit check to enforce it. That per-skill cost-tiering proved not worth its rigidity: hand-tuning the session tier per task is simpler and adapts to real session complexity better than a fixed pin. We removed the `model:`/`effort:` frontmatter from **skills** — they now run on the **session's** model/effort, which the maintainer sets manually per session. The five worker **agents** (`researcher`, `implementor`, `reviewer`, `verifier`, `test-author`) KEEP their explicit `model:`/`effort:`, because the worker asymmetry ("code is never written by the top tier" — always a strong implementor, a cheap verifier) is orthogonal to how hard the current session is. The pre-commit check is rescoped to `agents/*.md` only. Because skills no longer carry an own tier, the sole reason for the "typed handoff" convention disappears — typed entry existed only to apply the next skill's `model`/`effort` on selection — so stage handoffs (and the interview's stop-condition) return to a friendlier AskUserQuestion next-step gate that invokes the chosen skill.

## Considered options

- **Skills session-level, agents pinned, handoffs via AskUserQuestion (chosen)** — the main thread adapts to session complexity by hand; the deterministic worker tiering that actually matters is preserved.
- **Strip agents too** — rejected: the worker asymmetry is orthogonal to session complexity; you want the implementor strong and the verifier cheap regardless of how hard the session is, so agents keep deterministic pins.
- **Keep the per-skill pins** — rejected: the maintainer wants manual session control over the main-thread tier, not a fixed per-skill guarantee whose rigidity earns nothing.

## Consequences

- Simpler, session-tuned main thread — but the deterministic per-skill tier guarantee is gone: the maintainer must remember to raise the session tier for leverage-heavy work (spec, interview, map, diagnose).
- Agents retain deterministic tiering; the `frontmatter-model-effort` check now guards `agents/*.md` only.
- Stage handoffs regain an AskUserQuestion gate — nicer selection UX, at the cost of more reliance on that gate to move between stages.
- This PARTIALLY supersedes the CLAUDE.md "explicit `model:` + `effort:` in every skill and agent" convention (the agents' half stands) and reverses the "stage handoffs are TYPED, never auto-invoked" convention.
