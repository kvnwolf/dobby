---
name: wizard
description: Generates an interactive bash wizard that walks a human step by step through a manual procedure — third-party setup, a one-off migration, an A→B state transition — opening URLs, capturing values, confirming each step, and writing .env files and GitHub Actions secrets. Use when the user wants to script a manual setup, generate a setup wizard, or turn a tedious click-through procedure into a repeatable guided run.
disable-model-invocation: true
model: opus
effort: high
---

A **wizard** is a bash script that walks a human, step by step, through a manual procedure that's tedious to do by hand and tedious to re-explain to an AI every time. It opens each URL, says exactly what to click and copy, captures the values, writes them where they belong (`.env`, GitHub secrets), confirms at every stage, and shows how much is left. It might configure a third-party service (Better Auth, Neon, CI secrets), run a one-off migration, or move the project from one state to another.

The delightful UX is already solved by `references/template.sh` — progress with time-remaining, confirmation gates, cross-platform URL opening (including WSL), hidden secret entry, idempotent `.env` upserts, `gh secret`/`gh variable` writes with graceful degradation when `gh` is missing, and a closing summary. **The only work is to scope the procedure and author its stages.** The library above the `# STAGES` marker is identical in every wizard; that consistency is the point — it is copied verbatim and NEVER hand-edited.

You stay the architect: scope the procedure and map each stage's journey, then dispatch a `dobby:implementor` to copy the template and author the stages over it. A wizard is **ephemeral by default** — built for one run, saved to a scratch or `scripts/` path, deleted when the job's done. Commit it only when the user wants a repeatable setup path that should live in the repo. `/dobby:onboard` may offer to invoke this.

## Step 1: Scope the procedure

Work out every manual step the human must take and every value captured along the way. Read the repo first — don't ask cold:

- **For setup:** `.env`, `.env.example`, `.env.*`, `README`, `docker-compose*`, framework config, and `.github/workflows/*`. **Every `secrets.*` / `vars.*` reference in CI is a value the wizard must produce** — that mapping is what keeps CI and the wizard in sync.
- **For a migration or transition:** the current state, the target state, and the irreversible actions between them.

Then show the user the ordered list of stages and the values each produces, and confirm — they may add, drop, or reorder.

**Done when:** every stage is named in order, and for each captured value you know (a) where the human gets it, (b) where it's written (`.env`, a GitHub secret, both, or nowhere — some stages are pure actions), and (c) whether it's secret (hidden entry) or public.

## Step 2: Map each stage's journey

For each stage, write the precise path a human follows: which URL to open, what to do there, where a value is shown, which variable it fills — e.g. "Dashboard → Developers → API keys → Reveal test key → copy". Where you don't actually know the current UI or the exact command, say so and ask the user or check the docs (via `dobby:researcher` if it needs verification) — **never invent steps that may not exist.**

**Done when:** every stage traces to concrete instructions a stranger could follow.

## Step 3: Dispatch the authoring

Hand the mapped-out procedure to **ONE `dobby:implementor`** (Agent tool, `subagent_type: "dobby:implementor"`) — one script, one author, no parallel writers. The build instruction gives the implementor:

- The target path (scratch or `scripts/`; ephemeral by default).
- The ordered stages from Steps 1–2, each with its URL, click-path, captured variable, destination, and secret/public flag.
- These authoring rules (the implementor doesn't have this skill's context):
  - **Copy `references/template.sh` verbatim to the target path.** Author ONLY below the `# STAGES` marker (line 189). **NEVER edit the library above the marker** — that consistency is load-bearing.
  - Replace the example stage with one `stage "Name" <minutes>` per step, in dependency order. Set `TOTAL_STAGES` and `TOTAL_MINUTES` to **honest** estimates (they drive the time-remaining display).
  - Use the library helpers: `stage`, `say`/`step`/`note`/`warn`, `open_url`, `ask`/`ask_secret`, `write_env`, `set_secret`/`set_var`, `pause`/`confirm`.
  - Hold the template's bar: open the URL before asking for its value; `ask_secret` for anything secret; `write_env` every persisted value; `set_secret` only the values CI actually needs (each name must exactly match a `secrets.*` reference); `confirm` before any irreversible action. Each `stage` clears the screen — keep a stage to one focused task so nothing the human needs scrolls away.
  - **Static-verify only** (see Step 4) — NEVER run the script end-to-end.

## Step 4: Verify and hand off

The implementor static-verifies and reports back; confirm the wizard is sound:

- `bash -n <script>` parses; `shellcheck <script>` if available (skip cleanly if not); `chmod +x <script>`.
- **Never run it end-to-end** — it blocks on human input and opens browsers. Trace it statically instead: every value from Step 1 is captured and lands where Step 1 said, and every `set_secret` name exactly matches a `secrets.*` reference in CI.
- Tell the user how to run it. If it's a repeatable setup path, suggest committing it (via `/dobby:commit`) and linking it from the README so the next person runs the script instead of asking an AI.

## Next step

End with a plain-text handoff for the user to TYPE — NO AskUserQuestion, NO Skill-tool auto-invoke; typed entry re-applies the next skill's own `model`/`effort`.

- **Run the wizard** *(Recommended)* — give the exact command; the user drives it in their own terminal (it opens browsers and prompts for input, so it can't run inside the session).
- `/dobby:commit` — if it's a repeatable setup path worth keeping in the repo.
- **Stop here** — the wizard is scoped for one run and can be deleted once the job's done.

## Language

Interact with the user in their language. Write the wizard's code, comments, and instruction strings in English; keep domain terms in their real-world form and any user-facing product strings in the product's language.

## Acceptance checklist

- [ ] Procedure scoped from the repo (`.env*` / `README` / `docker-compose*` / `.github/workflows/*`); every CI `secrets.*` / `vars.*` reference mapped to a produced value
- [ ] Every stage traces to concrete UI/CLI instructions a stranger could follow; no invented steps
- [ ] Built by ONE `dobby:implementor`: `references/template.sh` copied verbatim, stages authored ONLY below the `# STAGES` marker, library above it untouched
- [ ] Honest `TOTAL_STAGES` / `TOTAL_MINUTES`; library helpers used; secrets hidden, persisted values written, only CI-needed values `set_secret`
- [ ] Static-verify ONLY (`bash -n`, `shellcheck` if available, `chmod +x`) — never run end-to-end
- [ ] Ephemeral by default; committed only if the user wants a repeatable path
- [ ] Next step handed off in plain text for the user to TYPE (no AskUserQuestion, no Skill-tool auto-invoke)

---
*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `in-progress/wizard`.*
