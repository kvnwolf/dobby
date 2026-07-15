# Task Decomposition

Decompose the work into a task table the executor can dispatch from.

## Principles

- **Vertical slices** — each task delivers end-to-end functionality across all layers (data + backend + frontend). Never a task that only touches one layer unless it genuinely has no cross-layer implications.
- **Prefactor first** — "make the change easy, then make the easy change." If a task needs the ground reshaped before it lands cleanly, schedule that prefactor as its own slice *before* the slices that depend on it — never fold a big prefactor into the feature task.
- **Incremental expansion** — task 1 = minimal working version; each subsequent task adds a capability on top.
- **Test-first marker** — when the repo has a test suite, each task carries a `Test-first` flag (`yes` for tasks with real logic/seams, `no` for trivial config/prose/scaffolding) from the plan's Testing Decisions. `/dobby:execute`'s test-author gate reads this column. Omit the column entirely when the repo has no suite.
- **Atomic** — small enough for one agent to complete within ~50% of its context window. 3-4 files beats 8-10. Prefer many small tasks over few large ones.
- **Affected areas** — each task declares which modules/directories it touches. Used to decide parallelism: overlapping areas run sequentially, non-overlapping run in parallel.
- **Dependencies** — express which tasks depend on which.
- **Verify recipe** — each task declares how it will be verified against the running app: for UI work, what to drive in the browser and what to observe; for backend/data work, the programmatic check (a query under the right role, a build/type-check, or firing a seam and observing the effect). This makes verification planned, not improvised.
- **Name the approach** — state the libraries, patterns, and approach each task must follow (from the research brief), plus the specific docs the executor should follow. When a task touches a domain governed by a convention/design skill the brief's Reuse section surfaced, name that skill AND the specific dictate to follow (the data/mutation pattern, file-role structure, or design direction the brief extracted) — so the plan tells the implementor exactly which convention primitive to use, not just "follow the conventions." This closes the gap where a silent plan lets the implementor pick the wrong primitive despite build-time auto-activation. Name the skill + its dictate only; the implementor loads the full recipe at build. Name the affected modules/areas; leave exact file-by-file implementation to the executor.

## Anti-patterns

- **Never setup-only tasks** — installing deps / config / scaffolding is not standalone; it belongs inside the first task that needs it.
- **Never split by component or layer** — "create sidebar header" + "create sidebar footer" are horizontal slices. Task 1 = working sidebar with basic nav; task 2 = expand with user menu.
- **Never organize by domain** — "backend agent" + "frontend agent" is wrong. One agent owns one task top to bottom.

## Splitting example

Instead of one "Notification system" task: "Notification + list endpoint + empty state", "Mark single as read with optimistic UI", "Mark all as read", "Unread badge with polling", "Cross-tab sync".

## How to present

A markdown table inside the plan. Add the `Test-first` column only when the repo has a test suite (see the plan's Testing Decisions):

| # | Task | Description | Depends on | Affected areas | Test-first | Verify recipe |
|---|------|-------------|------------|----------------|------------|---------------|
| 1 | \<title\> | \<1-2 sentences: what this delivers end-to-end\> | — | \<modules/dirs\> | yes/no | \<what to run + what to observe\> |
| 2 | \<title\> | \<1-2 sentences\> | 1 | \<modules/dirs\> | yes/no | \<…\> |

### Concrete example — a notifications feature

| # | Task | Description | Depends on | Affected areas | Verify recipe |
|---|------|-------------|------------|----------------|---------------|
| 1 | Notification model + list | Create the notification record and an endpoint returning a user's notifications, with an empty state. Use the project's data layer and the listing-page skill. | — | notifications module, data layer | Browser at the dev URL → empty state renders; seed one row → it appears |
| 2 | Mark one as read (optimistic) | Clicking a notification marks it read with optimistic UI, rolling back on error. | 1 | notifications module | Browser: click → greys out instantly; force the request to fail → it reverts |
| 3 | Mark all as read | A "mark all read" action clears all unread for the user. | 1 | notifications module | Browser: 3 unread → click → all clear; reload → still read |
| 4 | Unread badge with polling | Header badge shows the unread count, refreshing on an interval. | 1 | notifications module, app header | Browser: badge shows 2; mark one read → shows 1 within the poll interval |
| 5 | Cross-tab sync | Reading in one tab updates the badge/list in another. | 2, 4 | notifications module | Two tabs; read in A → B's badge updates |

Each row names the approach/tools to follow and a concrete observable. A backend-only row instead verifies programmatically (a query under the right role, a build/type-check, firing a seam and observing the effect).

If the user rejects or asks for changes, regenerate the plan with their feedback before any execution.
