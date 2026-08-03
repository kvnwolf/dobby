# Task Decomposition

Decompose the work into a task table the executor can dispatch from.

## Principles

- **Vertical slices** — each task delivers end-to-end functionality across all layers (data + backend + frontend). Never a task that only touches one layer unless it genuinely has no cross-layer implications.
- **Prefactor first** — "make the change easy, then make the easy change." If a task needs the ground reshaped before it lands cleanly, schedule that prefactor as its own slice *before* the slices that depend on it — never fold a big prefactor into the feature task.
- **Incremental expansion** — task 1 = minimal working version; each subsequent task adds a capability on top.
- **Test-first marker** — when the repo has a test suite the `Test-first` column is REQUIRED (`dobby spec lint` fails the plan without it), and each task carries the flag (`yes` for tasks with real logic/seams, `no` for trivial config/prose/scaffolding) from the plan's Testing Decisions. `/dobby:execute`'s test-author gate reads this column. Omit the column entirely only when the repo has no suite.
- **Atomic** — small enough for one agent to complete within ~50% of its context window. 3-4 files beats 8-10. Prefer many small tasks over few large ones.
- **Affected areas** — each task declares which modules/directories it touches. This column is what decides parallelism: `dobby build-plan` puts two tasks in the same wave only when their areas are disjoint, so overlapping areas serialize themselves. Name areas consistently across rows (the same module spelled the same way) or the clash goes undetected.
- **Dependencies** — express which tasks depend on which, and **always point backwards**: a `Depends on` cell may only name tasks ABOVE it in the table (`—` for none). Ordering the table this way makes a forward reference — and a cycle — impossible; both are lint findings.
- **Verify recipe** — each task declares how it will be verified against the running app, written as **`action → observable`**: the action you take (drive the UI, fire the seam, run the query under the right role) and, after the `→`, the effect you must SEE. For UI work that's what to drive in the browser and what renders; for backend/data work the programmatic check and its result. Verify recipes observe BEHAVIOR — they never run lint/format/typecheck/build/the test suite (the edit-time hook and the pre-commit gate `dobby check --fix` own those); `dobby spec lint` rejects a recipe naming one of those commands, and rejects an empty cell. This makes verification planned, not improvised.
- **Destructive marker** — a task whose VERIFY mutates shared state (writes/deletes rows the whole local backend shares, flips global flags, runs a migration) carries `Destructive: yes`. It's the one scheduling fact the executor can't infer: `dobby build-plan` gives a destructive task a wave of its own, so nothing verifies against that state concurrently. Omit the column entirely when no task in the plan is destructive; an absent or empty cell means "no".
- **Name the approach** — state the libraries, patterns, and approach each task must follow (from the research brief), plus the specific docs the executor should follow. When a task touches a domain governed by a convention/design skill the brief's Reuse section surfaced, name that skill AND the specific dictate to follow (the data/mutation pattern, file-role structure, or design direction the brief extracted) — so the plan tells the implementor exactly which convention primitive to use, not just "follow the conventions." This closes the gap where a silent plan lets the implementor pick the wrong primitive despite build-time auto-activation. Name the skill + its dictate only; the implementor loads the full recipe at build. Name the affected modules/areas; leave exact file-by-file implementation to the executor.

## Anti-patterns

- **Never setup-only tasks** — installing deps / config / scaffolding is not standalone; it belongs inside the first task that needs it.
- **Never split by component or layer** — "create sidebar header" + "create sidebar footer" are horizontal slices. Task 1 = working sidebar with basic nav; task 2 = expand with user menu.
- **Never organize by domain** — "backend agent" + "frontend agent" is wrong. One agent owns one task top to bottom.

## Splitting example

Instead of one "Notification system" task: "Notification + list endpoint + empty state", "Mark single as read with optimistic UI", "Mark all as read", "Unread badge with polling", "Cross-tab sync".

## How to present

ONE markdown table under the spec's `### Tasks` sub-heading. `#`, `Task`, `Depends on`, `Affected areas` and `Verify recipe` are required (`dobby spec lint` checks them, `dobby build-plan` reads them). `Test-first` joins them as required whenever the repo has a runnable test suite — lint enforces it there too (see the plan's Testing Decisions) — and is dropped only in a repo with no suite. `Description` is optional — without it the title stands in as the task's spec. `Destructive` is the one truly optional column: add it only when some task's verify mutates shared state:

| # | Task | Description | Depends on | Affected areas | Test-first | Destructive | Verify recipe |
|---|------|-------------|------------|----------------|------------|-------------|---------------|
| 1 | \<title\> | \<1-2 sentences: what this delivers end-to-end\> | — | \<modules/dirs\> | yes/no | — | \<action\> → \<observable\> |
| 2 | \<title\> | \<1-2 sentences\> | 1 | \<modules/dirs\> | yes/no | yes | \<action\> → \<observable\> |

### Concrete example — a notifications feature

| # | Task | Description | Depends on | Affected areas | Verify recipe |
|---|------|-------------|------------|----------------|---------------|
| 1 | Notification model + list | Create the notification record and an endpoint returning a user's notifications, with an empty state. Use the project's data layer and the listing-page skill. | — | notifications module, data layer | Browser at the dev URL → empty state renders; seed one row → it appears |
| 2 | Mark one as read (optimistic) | Clicking a notification marks it read with optimistic UI, rolling back on error. | 1 | notifications module | Browser: click → greys out instantly; force the request to fail → it reverts |
| 3 | Mark all as read | A "mark all read" action clears all unread for the user. | 1 | notifications module | Browser: 3 unread → click → all clear; reload → still read |
| 4 | Unread badge with polling | Header badge shows the unread count, refreshing on an interval. | 1 | notifications module, app header | Browser: badge shows 2; mark one read → shows 1 within the poll interval |
| 5 | Cross-tab sync | Reading in one tab updates the badge/list in another. | 2, 4 | notifications module | Two tabs; read in A → B's badge updates |

This example comes from a repo with NO test suite — that is the only reason it carries no `Test-first` column; in a repo with a suite lint requires one, with a `yes`/`no` on every row. Each row names the approach/tools to follow and a concrete observable, and every recipe reads `action → observable`. A backend-only row instead verifies programmatically (a query under the right role, or firing a seam and observing the effect) — never by running lint/typecheck/build/the test suite, which are not verification. Had one of these rows needed a destructive verify (say a "purge read notifications" job that empties the table), it would carry a `Destructive` column with `yes` on that row so it lands in a wave alone.

If the user rejects or asks for changes, regenerate the plan with their feedback before any execution.
