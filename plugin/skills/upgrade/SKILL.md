---
name: upgrade
description: Upgrade this repo to the latest @kvnwolf/dobby — bump the dep, walk the per-version upgrade notes, and leave the gate green. Routes a legacy (pre-CLI) repo through /dobby:migrate-config.
disable-model-invocation: true
---

Bring a consumer repo up to the latest `@kvnwolf/dobby` and run everything the jump requires. This skill lives in the PLUGIN on purpose: the consumer's CLI is by definition stale during an upgrade, so the upgrade knowledge cannot live inside it — the plugin (user-scope, auto-updated) arrives fresh in every repo regardless of which dobby version is installed.

Run it from the **main checkout**, not a goal worktree — the upgrade touches `package.json` + the lockfile; in-flight worktrees pick the new version up on their next `bunx dobby up`.

## Step 1: Detect the era

Three facts, none of them via `bunx dobby` — when the dep may be absent, `bunx` silently fetches the FOREIGN npm `dobby` package (same trap the edit hook guards against):

- **Declared** — Read `package.json`: is `@kvnwolf/dobby` a devDependency, and with what specifier?
- **Installed** — `node_modules/.bin/dobby -v` (absent bin = not installed).
- **Latest** — `npm view @kvnwolf/dobby version`.

Branch on what they say:

- **Not declared, legacy signals present** (`.claude/commit.config.yml`, vite-plus deps/aliases, `.conductor/`) → the **legacy era**. Run the `/dobby:migrate-config` flow (invoke it via the Skill tool) — it IS the cutover and installs the latest dobby. When it completes, come back and walk EVERY reference note in Step 3 (a legacy repo jumps from before all of them), then finish with Steps 4–5.
- **Declared but installed < latest** → Step 2.
- **Installed == latest** → say so and stop; there is nothing to upgrade.
- **Not declared, no legacy signals** → this repo was never on the kit at all; point to `/dobby:onboard` and stop.

## Step 2: Jump the version

```bash
bun update @kvnwolf/dobby --latest
```

`--latest` is not optional: on a 0.x line neither a `^` range nor an exact pin ever crosses a minor on its own — a plain `bun update` reports success while moving nothing. Done when `node_modules/.bin/dobby -v` prints the latest version.

## Step 3: Walk the upgrade notes

Each release that asks something of a consumer ships a note at `references/v<minor>.md`. Read, in ascending order, ONLY the files whose version falls inside the jump (above the previously installed version, up to and including the latest), and execute their actions. A version with no file asks nothing of a consumer — don't hunt for missing files.

Notes so far: `references/v0.7.md`.

## Step 4: Re-run the gate

```bash
bunx dobby check --fix
```

A jump can arm rules that didn't exist under the old version, so a tree that was green can come back with findings. Each is a fix-vs-suppress judgment (`// biome-ignore lint/<group>/<rule>: <reason>` for the deliberate ones); dispatch non-trivial code fixes to a `dobby:implementor` (Agent tool, `subagent_type: "dobby:implementor"`). Report the gate's output whole — never pipe it through `head`/`tail`; the exit code, not your reading of the text, is the verdict. Done when the gate exits 0.

## Step 5: Next step

Present an **AskUserQuestion** (one question) restating the upgrade landed — old → new version, which note actions ran, gate green — with:

- **`/dobby:commit`** *(Recommended)* — commit the bump + the note actions as a chore.
- **Stop here** — leave it uncommitted.

On selection, invoke the chosen `/dobby:<skill>` via the Skill tool; "Stop here" ends the turn.

## Language

Interact with the user in their language. Anything written to the repo stays in English.

## Acceptance checklist

- [ ] Ran from the main checkout; era detected from the three facts (declared / installed via the local bin, never `bunx` / latest via `npm view`)
- [ ] Legacy era routed through `/dobby:migrate-config` (Skill tool), then ALL reference notes walked; already-latest reported and stopped; never-onboarded pointed to `/dobby:onboard`
- [ ] Version jumped with `bun update @kvnwolf/dobby --latest`; local bin confirms the latest version
- [ ] Only the notes inside the jump read, in order; their actions executed (destructive ones on user confirmation)
- [ ] Gate re-run to exit 0; findings judged fix-vs-suppress, non-trivial fixes dispatched to an implementor; output reported whole
- [ ] Ended with the AskUserQuestion gate (`/dobby:commit` recommended / stop); chosen skill invoked via the Skill tool
