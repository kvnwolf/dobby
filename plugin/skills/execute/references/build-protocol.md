# The dispatch protocol — how the Architect runs a plan

This is the shared build-loop component: `/dobby:execute` follows it for a whole approved plan, and `/dobby:dispatch` / `/dobby:address-review` follow it for a single ad-hoc task, treated as a one-task plan. Same protocol, same guarantees, whatever the size of the plan.

It is not a runtime for a tool to execute — it is what the interactive Architect DOES, directly. Read every rule below, then dispatch named subagents (the Agent tool, `subagent_type`) yourself and track their progress by hand until every task in the plan has reached a terminal status. There is no separate execution engine underneath this: the Architect IS the loop.

## Launch workers named

Every worker is dispatched as a NAMED subagent — the Agent tool's `name` argument, never an anonymous call:

- Test-author → `dobby:test-author`
- Implementor → `dobby:implementor`
- QA → `dobby:qa`

Naming is not a style choice. Only a NAMED dispatch produces a sibling roster the worker can read, and only a worker who can see that roster has anyone addressable to reach with `SendMessage` — dispatch a worker anonymously and it has no roster to consult and no sibling it can name, so it silently falls back to returning its verdict alone with no fix conversation possible. Every dispatch in this protocol carries a name for exactly this reason.

Before a worker's FIRST use of `SendMessage`, it must load the deferred tool with `ToolSearch({query: 'select:SendMessage'})` — the tool does not exist in a fresh worker's toolset until then, and a worker that skips this step cannot reach anyone.

## Require CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS unset

Before dispatching anyone, confirm the session's `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` environment variable is unset. With it set, a named dispatch silently launches as a teammate instead of an ordinary worker, and the sibling roster and messaging this protocol depends on behave differently under that mode. This protocol assumes it stays off; if it is set, stop and tell the user rather than dispatching into a mode this design was never verified against.

## Start a task as soon as it can run

There is no fixed batch boundary to wait on. A task starts the moment every task it depends on — its `Depends on` ids from the plan — has reached `done` AND nothing already in flight shares any of its `Affected areas`; not before, and not held back to line up with a batch that doesn't exist. The moment both hold, dispatch its workers immediately, alongside whatever other tasks are already in flight.

Two exceptions hold a task back even once its dependencies clear:

- **Overlapping writers.** `dobby build-plan` emits each task's `areas` — compare a ready task's `Affected areas` against every task currently in flight before dispatching it, as NORMALISED PATHS (strip a trailing slash, strip a leading `./`) rather than as opaque strings matched for exact equality: one area being a PREFIX of the other counts as overlap, so a task naming a directory and a task naming a file inside it describe overlapping ground even though the labels aren't identical. If any pair overlaps, the ready task waits for the in-flight one to finish, exactly as if it depended on it, rather than starting alongside it. Two implementors mid-edit on the same file is not a hypothetical: without this check, their edits overwrite or interleave each other in the shared tree, and a gate run against that tree judges a mix of both tasks' unfinished code, not either task cleanly.
- **A destructive task** (one that mutates shared backend state during its proof) is dispatched alone, with nothing else touching the shared backend at the same time, because two destructive proofs racing each other corrupt both.

This check only ever sees what the plan wrote down. It closes the common collision — two tasks naming the same code at different depths — but it cannot close every one: two tasks can still describe the same file under genuinely UNRELATED labels, or one can touch a file it never declared in its `Affected areas` at all, and no static comparison catches either, because prose written before anyone has touched the code can't know what an implementor will actually open. Areas that name real paths are what make this check work at all; a task left vague here weakens its own protection. Where the check's blind spot is hit for real, nothing here PREVENTS the collision — but the serialised Exit gate below still DETECTS it: the gate always judges the current whole tree, so a sibling's edit to an undeclared file shows up there as a finding the implementor does not own, which it reports and leaves alone per the coordination guards. That is detection, not prevention, and the difference matters — don't read the area check as airtight just because most collisions never reach the gate to find out.

## The per-task loop

Each task moves through the same shape:

1. **Test-author (conditional)** — dispatched only when the repo has a runnable test suite AND the task is marked test-first. It writes the tests from the spec alone, before any implementation exists; those tests are the fixed contract for the rest of the task.
2. **Implementor** — implements (or fixes) the task, then runs its own Exit gate (below) before handing off.
3. **QA** — proves the task's real behaviour against the running app or artefact and returns a verdict.

When QA finds a genuine defect, it messages the implementor who still holds the task's context directly by name, rather than a fresh worker re-reading everything from nothing. When the implementor's own Exit gate turns up a test-contract problem instead, it messages the test-author directly the same way — it never edits the authored tests itself. A task reaches a terminal status once QA passes it, once a worker reports it `blocked`, or once it exhausts the retries the fix conversation allows.

## The fix conversation

This is the loop that closes a failure. QA does not stop at a verdict when it finds something fixable — it reaches back to the worker that can fix it, by name, and keeps count in the conversation itself rather than relying on anyone's memory of which round the task is on.

### Route the failure to whoever can fix it

- **A code defect** — QA sends its findings directly to `dobby:implementor`, the implementor that still holds this task's context, rather than a fresh worker that would have to re-read everything from nothing. The message describes what QA OBSERVED — the failing behaviour — not a guess at the fix.
- **A test-contract problem** — when the failure traces back to the tests themselves rather than the implementation, QA sends its findings directly to `dobby:test-author` instead. A message to the test-author describes expected BEHAVIOUR only: it never quotes, pastes, or shows any snippet or fragment of the implementation. Quoting the code is exactly what the test-author's blindness to it is meant to prevent — a test-author who never sees the implementation writes tests that pin behaviour, not ones that tautologically confirm whatever the code already does.

### Number every message, so the count lives in the text

QA numbers every message it sends in this conversation — round 1, round 2, and so on — written into the message itself. Nobody has to remember which round a task is on; the count travels in the text, not in anyone's memory, so it survives a fresh context on either side of the conversation.

The fix conversation is capped at five rounds. If a round five message still doesn't produce a pass, QA stops — it does not send a sixth round — and reports the task to the Architect instead of continuing to retry.

### Failures nothing a writer can fix

Not every failure belongs in this conversation. An environment failure — a dead browser, a missing session, an expired credential, anything QA can't attribute to the code or the tests — goes straight to the Architect, never to `dobby:implementor` or `dobby:test-author` or any other writer: there is nothing for either of them to implement or test away. Reporting an environment failure to the Architect does not spend a round; the five-round cap counts only rounds where a writer had a real chance to fix something.

If a message in this conversation can't be delivered at all — the addressed sibling has died mid-task — the sender reports that to the Architect rather than retrying blindly; a sibling that has already died isn't going to answer a second attempt either. That round still counts toward the five, even though the message never landed, so an unlucky death can't be used to dodge the cap.

## Coordination guards — many tasks share one tree

With no fixed batch to keep tasks apart, several tasks' workers are routinely mid-edit in the SAME working tree at once. That makes these non-negotiable for every worker:

- **Never commit.** No `git commit`, no `git add` from any test-author/implementor/QA — the Architect owns the index.
- **Scope your own work, and your own verification, to your task's Affected areas.** NEVER a bare `git diff` / `git status` to decide what changed — that shows every sibling task's in-flight edits too and produces false findings. Judge scope with `git diff -- <this task's files>`, or by reading those files directly.
- **Never revert or "fix" a sibling task's changes.** Files outside your Affected areas are not yours to touch, even if they look wrong — leave them and, if it matters, say so in your work-log entry.
- **Never run a working-tree-wide revert** — no `git checkout -- <path>`, `git restore`, `git stash`, `git reset --hard`, `git clean` — even to undo your OWN overreach; in a tree several tasks share, those wipe every sibling's uncommitted work. Undo your own mistake by editing the specific lines back instead.

## Serialise the Exit gate

Only one implementor may run the Exit gate — `bunx dobby check --fix --baseline`, defined in `dobby:implementor` — against the shared tree at a time. Everything else about a task keeps running in parallel with its siblings: its test-author step, its implementation, its QA proof. Only the gate itself is serialised, because the gate judges the WHOLE tree, and two implementors racing their gates would have one task's verdict contaminated by a sibling's half-written edit sitting in the same working tree at that moment.

Hold this as a single turn: when an implementor is ready to run its gate, let it go if no one else currently holds the turn; otherwise it waits, and the next implementor to finish its own gate hands the turn on. A task never blocks on this queue for longer than it takes the tasks ahead of it to finish their own gate — its implementation work, and every other task's work, keeps moving the whole time.

This queue protects only the gate's JUDGEMENT — it stops a gate run from being contaminated by a sibling's half-written edit sitting in the tree at that moment. It does nothing to stop two implementors from editing the same file concurrently in the first place; that's what the area-overlap check above exists to prevent at dispatch, for every overlap the plan's areas actually declare. Don't mistake gate serialisation for a substitute — a task whose declared areas overlap an in-flight task's must not be dispatched at all, gate queue or not. Where a collision slips past the area check entirely — the residual gap it names above — this queue is the backstop that still catches it, as a finding in the gate's own output, not as a block at dispatch.

## When a task dies, don't stop everything

A task dies when it exhausts its retries without QA passing it, when a worker crashes, or when a worker returns `blocked`/`needs-human`. When that happens, stop only the tasks that genuinely depend on the dead one — they cannot start without it, so mark them blocked and move straight on to whatever else is ready. Everything independent of the dead task keeps running exactly as if nothing had happened; a death is never a reason to pause work that never needed the dead task in the first place.

Say what died the moment it happens — name the task and its terminal status (`needs-human`, or `blocked` naming what it was blocked by) in your running narration, rather than letting it surface only in the closing table. A silent skip is not acceptable; the user should never have to infer from a gap in the summary that something went wrong.

## What a worker hands back

Every worker appends its own record before it returns — the Architect never transcribes on a worker's behalf. Immediately before reporting back, a worker writes its entry to a scratch file and runs `dobby state append-worklog --task <id> --file <that file>` itself.

What reaches the Architect is a short verdict only: pass, fail, or blocked, plus one line on why. Nothing longer. That short verdict is what preserves the context isolation this protocol depends on — the Architect never reads a worker's full reasoning trail, only its outcome, so its own context stays small enough to run the whole plan without drowning in every task's detail.

## Keep the run's state in STATE.md

As the run advances, keep `STATE.md` current — each task's status and which round of its loop it is on — so the record on disk always reflects where the run actually stands, not just what still fits in the Architect's own context. This is what lets the Architect reconstruct progress after a compaction: read `STATE.md` back, and it is clear which tasks are done, which are still running, and which never started, without replaying the conversation that got them there.

## Close the run with a summary table

Once every task in the plan has reached a terminal status, close with one table, one row per task:

| Task | Rounds | First-attempt success | Died | Wall clock |
| --- | --- | --- | --- | --- |
| `<id>` | `<n>` | yes / no | `—` or what died and why | `<duration>` |

- **Rounds** — how many implement → Exit gate → QA cycles the task went through.
- **First-attempt success** — yes only when the very first round passed outright, with no fix conversation at all.
- **Died** — `—` when the task finished clean; otherwise `needs-human`, or `blocked` naming what it waited on.
- **Wall clock** — how long the task ran, from its dependencies clearing to its terminal status.
