# Logic Prototype

A tiny interactive terminal app that lets the user drive a state model by hand. Use this when the question is about **business logic, state transitions, or data shape** — the kind of thing that looks reasonable on paper but only feels wrong once you push it through real cases.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where the user wants to **press buttons and watch state change**.

If the question is "what should this look like" — wrong branch. Use `ui.md`.

## Process (the architect specs this; the implementor builds it)

### 1. State the question

Before any code, the question goes in writing — one paragraph, in the prototype's README or a comment at the top of the file. A logic prototype that answers the wrong question is pure waste — make it explicit so it can be checked later.

### 2. Pick the language

Whatever the host project uses. No new package manager or runtime just for the prototype; if the project has no obvious runtime (e.g. a docs repo), ask the user.

### 3. Isolate the logic in a portable module

Put the actual logic — the bit answering the question — behind a small, pure interface that could be lifted into the real codebase later. The TUI around it is throwaway; the logic module shouldn't be.

The right shape depends on the question:

- **A pure reducer** — `(state, action) => state`. Good when actions are discrete events and state is a single value.
- **A state machine** — explicit states and transitions. Good when "which actions are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no implicit current state — just transformations.
- **A class/module with a clear method surface** when the logic genuinely owns ongoing internal state.

Pick whichever fits the question, *not* whichever is easiest to wire to a TUI. Keep it pure: no I/O, no terminal code, no `console.log` for control flow. The TUI imports it and calls into it; nothing flows the other direction. This is what makes the prototype useful past its own lifetime — the validated reducer/machine/function set gets lifted into the real module; the TUI shell gets deleted.

### 4. Build the smallest TUI that exposes the state

A **lightweight TUI**: on every tick, clear the screen (`console.clear()` / `print("\033[2J\033[H")` / equivalent) and re-render the whole frame — one stable view, not an ever-growing scrollback.

Each frame, in order:

1. **Current state**, pretty-printed and diff-friendly (one field per line, or formatted JSON). **Bold** for field names/section headers, **dim** for less important context (timestamps, IDs, derived values). Native ANSI codes are fine — `\x1b[1m` bold, `\x1b[2m` dim, `\x1b[0m` reset; no styling library unless the project already has one.
2. **Keyboard shortcuts** at the bottom: `[a] add user  [d] delete user  [t] tick clock  [q] quit`. Bold the key, dim the description.

Behaviour: initialise in-memory state → render the first frame → read one keystroke at a time → dispatch to a handler → re-render the full frame (replace, don't append) → loop until quit. The whole frame fits on one screen.

### 5. Make it runnable in one command

Add a script to the project's existing task runner (`package.json` scripts, `Makefile`, `justfile`, `pyproject.toml`). The user runs `<runner> <prototype-name>` — never needs to remember a path. No task runner? Put the command at the top of the prototype's README.

### 6. Hand it over

Give the user the run command. They drive; the interesting moments are "wait, that shouldn't be possible" or "huh, I assumed X" — those are the bugs in the *idea*, which is the whole point. New actions requested → add them (via the implementor). Prototypes evolve.

### 7. Capture the answer

The answer is the only thing worth keeping — see the SKILL's Step 4 (STATE.md section of the calling stage, or NOTES.md next to the prototype).

## Anti-patterns

- **Don't add tests.** A prototype that needs tests is no longer a prototype.
- **Don't wire it to the real database.** In-memory unless the question is specifically about persistence.
- **Don't generalise.** No "what if we wanted X later" — the prototype answers one question.
- **Don't blur the logic and the TUI together.** If the reducer references `console.log`, prompts, or escape codes, it's no longer portable. The TUI is a thin shell over a pure module.
- **Don't ship the TUI shell into production.** The logic module behind it is the bit worth keeping.
