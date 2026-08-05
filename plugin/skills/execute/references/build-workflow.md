# Build Run — the whole plan in ONE workflow (script template)

The coordinator authors ONE Workflow from this template per plan — the **build run** — passing the plan's waves (plus the dev URL) as `args`. Run via the Workflow tool. The script sequences the waves itself (one after another, tasks inside a wave in parallel) and puts every task through a state machine with a SEPARATE custom agent per role — `dobby:test-author` (conditional), `dobby:implementor`, `dobby:reviewer`, `dobby:verifier` — dispatched via `agentType`.

This is the **build loop component**: `/dobby:execute` hands it the whole approved plan (`args.waves`); `/dobby:dispatch` and `/dobby:address-review` hand it a single ad-hoc fix (`args.tasks`, read as one wave). Same loop, same guarantees.

The per-task loop is **count-agnostic** — 4 steps when a task authors tests first, the classic 3 otherwise:

```
[test-author] → implement → review (loop until pass) → verify
```

The leading test-author step is **gated** (see below): it runs ONLY when the repo has a test suite AND the task is marked test-first. Lib / prose / no-suite repos skip it entirely and the loop stays the classic 3-step (implement → review → verify) — nothing about those runs changes.

Encoded rules:
- **Use the script below VERBATIM.** Fill in ONLY the `args` (`waves` — or `tasks` for a single ad-hoc fix — `devUrl`, `hasTestSuite`, `workRoot`) — do NOT paraphrase, rename, or "simplify" the wave loop, the blocked-dependent skip, the `log()` lines, the loop logic, the null guards, the defensive `args` parse, the test-step gate, the worktree preamble, or the scoped re-review. Paraphrasing silently drops these fixes (it has before — a re-authored script reverted the review loop to the thrashing version).
- **ONE build run per plan.** The whole plan goes into a SINGLE Workflow invocation; the script walks the waves in order. Do NOT launch one workflow per wave, and do NOT merge waves into one flat list — the wave boundaries ARE the safety (area-disjoint parallelism, destructive tasks alone) and the script preserves them exactly as they arrive.
- **`args.waves` carries FULL task objects, never ids.** `bunx dobby build-plan --json` emits `waves[][]` as id arrays NEXT to `tasks[]`; the coordinator zips them so each wave entry is the whole task object (`{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst, dependsOn}`). The script reads `t.dependsOn` off those objects to skip blocked tasks; a wave of bare ids makes the run throw immediately instead of building the wrong thing.
- **Compute `workRoot` ONCE before launching, and pass it in `args`.** Before running the Workflow, resolve the absolute worktree root — `WORKROOT="$(git rev-parse --show-toplevel)"` — and hand it in as `args.workRoot`. The script PREPENDS a mandatory worktree preamble to every agent's `ctx` when `workRoot` is present (see the `WORKTREE` note below for why this is load-bearing — the session's worktree is nested under the main checkout).
- Test-author, implement, review, verify = four separate agents (`agentType: 'dobby:test-author' | 'dobby:implementor' | 'dobby:reviewer' | 'dobby:verifier'`) — never one agent in two roles. Their role instructions live in the agent definitions, NOT in this script.
- Order: (test-author, if gated in) → implement → review (loop until pass) → verify → (fail → restart implement→review→verify).
- **Test-author runs ONCE, at task start, and only when gated in** (suite exists AND the task is test-first). Its tests are the FIXED contract for the whole task: outer-loop retries re-implement / re-review / re-verify against those SAME tests, so a green-vs-red disagreement always means the code is wrong, never that the goalposts moved. The ONE exception is the reviewer's `testFindings` — the arbiter demanding more/better coverage re-dispatches the test-author to EXTEND the contract (never the implementor). The implementor does NOT edit these tests and can never send the test-author back; if it believes a test is wrong it says so in its work-log for the reviewer to scrutinize (no cheating the contract).
- Caps prevent infinite loops; a task that exhausts them is flagged `needs-human`.
- **A task whose dependency ended badly is skipped as `blocked`** — status `blocked`, `blockedBy` naming the blocker, ZERO agents spawned, no work-log entry (nothing ran). Blocking is transitive by construction: a blocked task is itself non-`done`, so its own dependents block too. Independent tasks in the same later wave still run.
- **The run narrates itself with `log()`** — the only channel it has while it runs (the main thread receives nothing until the final return). One terminal line per task, one line per retry, a line per wave boundary, plus every subsequent milestone of any task that failed a review or a verify (adaptive verbosity: the detail appears exactly where the trouble is). Lines are English, terse, symbol-led (`✓` / `✗` / `⊘`).
- When a test step ran, the **reviewer receives the COMBINED diff** (the test-author's tests + the implementor's code) and judges test quality (spec coverage, behavior-not-implementation) under its Spec axis; the **verifier runs the suite** (must be green) plus the dynamic tautology litmus. Those role behaviors live in the `dobby:reviewer` / `dobby:verifier` definitions — the script just wires the same review/verify steps; it does not special-case them.
- The implementor RETURNS its work-log entry (it does NOT write `STATE.md` — parallel self-appends race and clobber each other). The workflow accumulates them per task; the coordinator appends them to `STATE.md` serially AFTER the workflow returns (single writer). The test-author's returned tests are part of the diff the reviewer/verifier see; the coordinator does not separately record them.
- Every wave must be non-overlapping in Affected areas, and anything that mutates shared backend state during verify must sit alone in its wave — `bunx dobby build-plan` already groups them that way; the script never regroups.
- **Coordination guards (per-task agents run in parallel — these keep them from corrupting each other):**
  - **Never commit.** No `git commit`, no `git add` from any test-author/implementor/reviewer/verifier — the coordinator and `/dobby:commit` own the index. Parallel tasks share a working tree; a stray commit/stage sweeps in siblings' half-done edits.
  - **Scope review/verify to the task's Affected areas.** Judge scope with `git diff -- <that task's files>` or by reading those files — NEVER a bare `git diff` / `git status`, which shows sibling tasks' in-flight changes and invites false findings.
  - **Never revert or "fix" changes outside your task's areas.** Another parallel task's edits are not yours to touch; leave them even if they look wrong.
  - **Never use a working-tree-wide revert — no `git checkout -- <path>`, `git restore`, `git stash`, `git reset --hard`, `git clean` — EVEN to undo your OWN scope-creep.** In the shared parallel worktree those wipe sibling tasks' uncommitted in-flight edits (a T1 fix's `git checkout --` once erased a parallel T5's work). To undo your own overreach, EDIT the specific lines back with the Edit tool (scoped to your task's files), or leave it and report it in your work-log for the reviewer.

```js
export const meta = {
  name: 'build-run',
  description: 'Run a whole plan: waves in sequence, tasks in parallel, each implemented → reviewed → verified by separate agents',
  // NO `phases` here: meta must stay a pure literal, so it could only ever declare a skeleton it never fills — and a declared-but-unused phase shows up in the UI as a dead "0 agents" row. Each wave opens its OWN group at runtime instead (`Wave n/m`).
}

const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    findings: { type: 'string', description: 'concrete issues if pass=false, else empty' },
    testFindings: { type: 'string', description: 'reviewer only: findings whose FIX is adding/changing tests (coverage gap, weak/tautological assertion) — routed to the test-author, never the implementor; empty if none' },
    evidence: { type: 'string', description: 'what was observed if verifying, else empty' },
  },
  required: ['pass', 'findings', 'evidence'],
}

const IMPL = {
  type: 'object', additionalProperties: false,
  properties: {
    workLog: { type: 'string', description: "this task's ## Work log entry: diff summary (by area), decisions + deviations and why, files touched" },
  },
  required: ['workLog'],
}

const a = typeof args === 'string' ? JSON.parse(args) : args   // runtime may hand args over as a JSON string — parse defensively, else a.waves is undefined and every task throws
// DUAL ARGS CONTRACT: /dobby:execute passes the plan's waves[][]; /dobby:dispatch and
// /dobby:address-review pass a single-task tasks[], which is simply one wave. Neither
// present means a mis-authored launch — throw NOW, before a single agent burns tokens.
if (!Array.isArray(a.waves) && !Array.isArray(a.tasks)) {
  throw new Error('build run: args must carry `waves` (an array of waves, each an array of task objects) or `tasks` (one wave of task objects) — got neither')
}
const WAVES = a.waves ?? [a.tasks]
// build-plan emits `waves` as ID arrays beside `tasks[]`; the coordinator zips them so
// each entry here is the FULL task object (this script reads t.dependsOn / t.spec off it).
if (WAVES.some((w) => !Array.isArray(w) || w.some((t) => !t || typeof t !== 'object'))) {
  throw new Error('build run: every wave must be an array of FULL task objects — `build-plan` reports `waves` as id arrays, so zip them against `tasks[]` before launching')
}
const HAS_SUITE = a.hasTestSuite === true   // repo-level gate: only true when the project actually has a runnable test suite (lib/prose/plugin repos → false → classic 3-step, test-author never runs)
const WORK_ROOT = a.workRoot        // absolute worktree root (git rev-parse --show-toplevel), computed ONCE by the coordinator. Load-bearing: the session's worktree is nested under the main checkout, so every agent must be pinned to it.
// Every agent inherits the PROCESS cwd = the MAIN checkout, NOT the session's nested worktree — invisible until files land in the wrong tree. Prepend an absolute-path preamble to every ctx when workRoot is known.
const WORKTREE_PREAMBLE = WORK_ROOT
  ? `🔴 WORKING DIRECTORY — READ FIRST: Operate ONLY on the git worktree at absolute path ${WORK_ROOT}. Your process cwd may WRONGLY default to the main checkout — do NOT trust \`pwd\`. RULES: (1) Bash — ALWAYS begin with \`cd ${WORK_ROOT}\`. (2) Read/Edit/Write/Grep/Glob — use ABSOLUTE paths under ${WORK_ROOT} ONLY; never create or edit anything outside it (the main checkout is off-limits). (3) NEW files are UNTRACKED — \`git diff\` will NOT show them; use \`git status --short\` + Read to see/review them. (4) Before finishing, confirm your edits landed with \`cd ${WORK_ROOT} && git status --short\`.\n\n`
  : ''
const MAX_OUTER = 3, MAX_REVIEW = 3

// log() lines are ONE-LINERS above the progress tree: take the first non-empty line of
// whatever an agent said and cap it, so a paragraph of findings never floods the run.
const brief = (text) => {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

// A task whose thunk died outright (never expected — runTask catches nothing it can fix):
// parallel() hands back null for it, and a null must still be a REPORTED task, never a
// silently missing row in the coordinator's final table.
const crashed = (t) => {
  log(`${t.id} ✗ needs-human — the task crashed inside the build run`)
  return { id: t.id, status: 'needs-human', reason: 'the task crashed inside the build run', workLog: '', loops: 0 }
}

async function runTask(t, phaseName) {
  const ctx = `${WORKTREE_PREAMBLE}TASK: ${t.title}\nSpec: ${t.spec}\nDecisions: ${t.decisions}\nConstraints: ${t.constraints}\nAffected areas: ${t.areas}`   // every agent (test-author/implementor/reviewer/verifier) reads ctx, so all four get the worktree preamble
  const workLog = []                       // accumulate every implementor entry (initial + fixes) for this task
  // ADAPTIVE VERBOSITY. A task is TERSE — one terminal line — until it fails a review or
  // a verify; that first failure flips `loud` for good and every LATER milestone of THIS
  // task is narrated, while its siblings stay terse. No de-escalation, no retro-logging:
  // the detail starts exactly where the trouble started.
  let loud = false
  const milestone = (line) => { if (loud) log(`${t.id}: ${line}`) }
  const verified = (loops, evidence) => {
    log(`${t.id} ✓ verified — ${brief(evidence) || 'verify passed'} (${loops} loop${loops === 1 ? '' : 's'})`)
    return { id: t.id, status: 'done', evidence, workLog: workLog.join('\n\n'), loops }   // status stays 'done' (the prose says "verified"; the CONTRACT does not move — /dobby:dispatch and /dobby:address-review read 'done')
  }
  const stuck = (loops, reason) => {
    log(`${t.id} ✗ needs-human — ${reason}`)
    return { id: t.id, status: 'needs-human', reason, workLog: workLog.join('\n\n'), loops }
  }

  // 0. TEST-AUTHOR (conditional, runs ONCE at task start) — gated on suite-exists AND this task marked test-first.
  // When it doesn't run, the loop below is the classic 3-step (implement → review → verify), byte-for-byte unchanged.
  // The tests it writes are the FIXED contract for the whole task: outer-loop retries re-implement/re-review/re-verify
  // against these SAME tests — the test-author re-runs ONLY on the reviewer's testFindings (contract extension by the
  // arbiter, wired in the review loop below). Written blind to the implementation (independent source of truth). The
  // reviewer/verifier see these tests in the combined diff; how they judge/run them lives in their agents.
  // (No milestone line here: this step runs BEFORE anything can have failed, so no task is ever loud yet.)
  let testContract = ''
  if (HAS_SUITE && t.testFirst) {
    const authored = await agent(`${ctx}\nWrite the tests for this task from the spec ALONE, before any implementation exists. They are the fixed contract the implementor must satisfy.`,
      { label: `test:${t.id}`, phase: phaseName, agentType: 'dobby:test-author', schema: IMPL })
    if (authored?.workLog) { workLog.push(authored.workLog); testContract = '\nTests already authored for this task (the fixed contract — do NOT edit them; if you believe one is wrong, flag it in your work-log for the reviewer, do not change it):\n' + authored.workLog }
  }

  let feedback = ''
  for (let outer = 0; outer < MAX_OUTER; outer++) {
    // 1. IMPLEMENT (or fix with the accumulated feedback) — implementor agent; capture its work-log entry.
    // testContract is '' unless a test-author ran; when present it tells the implementor the tests are fixed and off-limits.
    const impl = await agent(`${ctx}${testContract}\n${feedback ? 'Apply this feedback and nothing else:\n' + feedback : ''}`,
      { label: `impl:${t.id}`, phase: phaseName, agentType: 'dobby:implementor', schema: IMPL })
    if (impl?.workLog) workLog.push(impl.workLog)
    milestone(`implementation ready (loop ${outer + 1}/${MAX_OUTER})`)

    // 2. CODE REVIEW (fresh reviewer agent; fix→re-review loop until pass)
    // Round 0 = full review; rounds 1+ are SCOPED to "were the prior findings fixed?" so the loop
    // converges instead of a fresh agent hunting new nitpicks each round (the classic review thrash).
    let reviewed = false, prior = ''
    for (let r = 0; r < MAX_REVIEW; r++) {
      const instruction = r === 0
        ? `Review the current diff for this task${testContract ? ' — this is the COMBINED diff (the authored tests AND the code); judge the tests too (spec coverage, behavior-not-implementation) under your Spec axis' : ''}.`
        : `RE-REVIEW. The implementor just applied fixes for these findings:\n${prior}\nConfirm ONLY that each is resolved and that the fix introduced no regression. Do NOT hunt for NEW issues you could have raised on the first review — pass if the listed findings are addressed.`
      const review = await agent(`${ctx}\n${instruction}`,
        { label: `review:${t.id}`, phase: phaseName, agentType: 'dobby:reviewer', schema: VERDICT })
      if (!review) continue                  // agent() returns null if it errors/is skipped — retry within the cap, never deref null
      if (review.pass) { reviewed = true; milestone(`review ✓ (round ${r + 1})`); break }
      loud = true                            // first review failure → this task narrates everything from here on
      if (r + 1 < MAX_REVIEW) log(`${t.id}: review ✗ (${brief(review.findings) || 'findings'}) — retry ${r + 1}/${MAX_REVIEW}`)   // the last round has no retry left: the terminal line reports it
      // Route findings by who CAN fix them. A test finding sent to the implementor is unresolvable by
      // construction (the contract is off-limits to it) and deadlocks the loop into needs-human. The
      // reviewer demanding coverage is the ARBITER extending the contract — not the implementor moving
      // goalposts — so this is the ONE re-dispatch the fixed contract allows. Without a test-author
      // (classic 3-step) there is no contract, and the implementor takes test findings like any other.
      const testF = (testContract && review.testFindings) ? review.testFindings : ''
      const codeF = testF ? review.findings : [review.findings, review.testFindings].filter(Boolean).join('\n')
      prior = [codeF, testF].filter(Boolean).join('\n')
      if (testF) {
        const tfix = await agent(`${ctx}\nThe code reviewer requests these TEST additions/changes to the contract you authored for this task — extend it with EXACTLY what these findings name (the rest of the contract stays fixed):\n${testF}`,
          { label: `test-fix:${t.id}`, phase: phaseName, agentType: 'dobby:test-author', schema: IMPL })
        if (tfix?.workLog) workLog.push(tfix.workLog)
        milestone('test contract extended')
      }
      if (codeF) {
        const fix = await agent(`${ctx}${testContract}\nApply ONLY these code-review findings:\n${codeF}`,
          { label: `fix:${t.id}`, phase: phaseName, agentType: 'dobby:implementor', schema: IMPL })
        if (fix?.workLog) workLog.push(fix.workLog)
        milestone('fix applied — re-reviewing')
      }
    }
    if (!reviewed) return stuck(outer + 1, 'code review never passed')

    // 3. VERIFY (fresh verifier agent)
    const runState = a.devUrl                                   // devUrl set → app already running at that URL; null → no dev server (lib/CLI/plugin), verify programmatically
      ? `The app is already running at: ${a.devUrl}`
      : `This project has no dev server (no run script) — verify programmatically (Bash/reads), not against a URL.`
    const verify = await agent(`${runState}\n\n${ctx}\nVerify recipe: ${t.verifyRecipe}`,
      { label: `verify:${t.id}`, phase: phaseName, agentType: 'dobby:verifier', schema: VERDICT })
    if (verify?.pass) { milestone('verify ✓'); return verified(outer + 1, verify.evidence) }   // verify may be null (agent errored/skipped) → treat as not-passed
    loud = true                              // first verify failure → this task narrates everything from here on
    if (outer + 1 < MAX_OUTER) log(`${t.id}: verify ✗ (${brief(verify?.findings) || 'no result'}) — outer loop ${outer + 2}/${MAX_OUTER}`)   // the last loop has no retry left: the terminal line reports it
    feedback = 'Verification failed:\n' + (verify?.findings ?? 'verifier returned no result')   // restart implement→review→verify
  }
  return stuck(MAX_OUTER, 'verify never passed within retries')
}

// THE WAVE LOOP — the whole plan in one run. Waves go one after another (a later wave may
// depend on an earlier one); the tasks INSIDE a wave go at once, which is safe because the
// plan already made each wave area-disjoint and put every destructive task alone in its own.
const outcome = {}                           // id → terminal status, the ONLY thing a later wave reads back
const results = []
for (let i = 0; i < WAVES.length; i++) {
  const wave = WAVES[i]
  const title = `Wave ${i + 1}/${WAVES.length}`
  phase(title)
  log(`${title} — ${wave.length} task${wave.length === 1 ? '' : 's'}`)
  const settled = await parallel(wave.map((t) => async () => {
    // BLOCKED: a dependency that did NOT end 'done' (needs-human, or blocked itself) makes
    // this task un-buildable — skip it without spawning a single agent. Transitivity falls
    // out of the map: a blocked task is non-'done' too, so ITS dependents block in turn.
    const blocker = (t.dependsOn ?? []).find((d) => outcome[d] && outcome[d] !== 'done')
    if (blocker) {
      log(`${t.id} ⊘ blocked — depends on ${blocker} (${outcome[blocker]})`)
      return { id: t.id, status: 'blocked', blockedBy: blocker, workLog: '', loops: 0 }   // no work log: nothing ran
    }
    return runTask(t, title)
  }))
  const returned = settled.filter(Boolean)   // pair BY ID, not by index: a wave must report one row per PLANNED task whatever order parallel() answers in
  const waveResults = wave.map((t) => returned.find((r) => r.id === t.id) ?? crashed(t))
  for (const r of waveResults) { outcome[r.id] = r.status; results.push(r) }
  const count = (s) => waveResults.filter((r) => r.status === s).length
  log(`${title} done: ${count('done')} ✓ · ${count('needs-human')} needs-human · ${count('blocked')} ⊘`)
}
return { results }
```

Notes:
- **ONE build run per plan, waves inside it.** The coordinator makes a SINGLE Workflow call carrying every wave; the script runs them in order and reports each task as it lands. Waves are `bunx dobby build-plan`'s waves VERBATIM (area-disjoint, destructive tasks alone) — never re-cut, never merged.
- **The result** is `{ results: [{id, status, workLog, loops, evidence?, reason?, blockedBy?}] }`, one entry per planned task, in wave order. `status` is `done` (verified), `needs-human` (caps exhausted), or `blocked` (a dependency did not pass). `loops` counts the outer implement→review→verify iterations the task used. Blocked entries carry `blockedBy` and an EMPTY `workLog` — no agent ran, so there is nothing to append to `STATE.md`; the coordinator's final table names the blocker instead.
- **`log()` is the run's only live voice.** The main thread receives nothing until the run returns, so the script narrates: a wave-opening line, one terminal line per task the moment it lands, one line per review/verify retry, a wave summary (`Wave 1/3 done: 2 ✓ · 1 needs-human · 0 ⊘`), and — for any task that failed a review or a verify — every subsequent milestone of THAT task. Narrator lines are ephemeral UI (they are not persisted chat), which is why the coordinator still writes its own summary after the run returns.
- **Role instructions are NOT passed in `args`** — they live in the `dobby:test-author` / `dobby:implementor` / `dobby:reviewer` / `dobby:verifier` agent definitions (dispatched via `agentType`). `args` carries only `waves` (or `tasks`), `devUrl`, `hasTestSuite`, and `workRoot`. The coordinator resolves `devUrl` per `/dobby:execute` Step 2 — `bunx dobby up` ensures the run is up (idempotent, liveness-first), then `bunx dobby env` reports the `devUrl` — and passes it so verifiers never start their own. A project with no run script (lib/CLI/plugin) has `devUrl = null`, and the verify prompt switches to "no dev server — verify programmatically".
- **The test-author step is doubly gated.** `hasTestSuite` (repo-level, from the spec's Testing Decisions) must be `true` AND the individual task must carry `testFirst: true`. When `hasTestSuite` is `false` — as it is for a lib / CLI / plugin like dobby with no runnable suite — the test-author never runs for any task and the loop is byte-for-byte the classic 3-step. Do NOT set `hasTestSuite: true` for a repo without a real suite just to force the step.
- **Work log: the workflow does NOT write `STATE.md`** (workflows have no filesystem access). Each task result carries its accumulated `workLog`; the coordinator appends these to `STATE.md` serially after the workflow returns (single writer — no parallel-append race).
- The workflow is headless: no human QA, no interactive steps.
- **Pass `args` as an actual JSON object** in the Workflow call (the tool delivers it verbatim — do NOT `JSON.stringify` it). The script still parses defensively (`typeof args === 'string' ? JSON.parse(args) : args`) because the runtime may deliver it as a JSON string; without that guard, `args.waves` is `undefined` and the run throws on the first access.
- **Phases**: `meta` declares NO phases — it is a pure literal, so it could never name the waves it has not seen, and a phase declared but never entered renders as a dead "0 agents · Not started yet" row. Every group is opened at RUNTIME instead: each wave calls `phase('Wave n/m')` and that wave's agents are dispatched into it.
- **`workRoot` — the nested-worktree cwd fix.** Workflow subagents inherit the *PROCESS* cwd = the MAIN checkout, NOT the session's logical worktree at `.claude/worktrees/<slug>/`. This is invisible until files land in the wrong tree: in a real session it caused wave-1 files to write into MAIN while a reviewer saw the worktree clean and a re-check agent saw those files "already present" (in main) — the review loop never converged, a task was flagged `needs-human` with a fabricated work log, and the coordinator only recovered by hand-injecting an absolute-path preamble into every later agent prompt (~90 wasted turns + a contaminated main). So the coordinator computes `WORKROOT="$(git rev-parse --show-toplevel)"` ONCE up front and passes it as `args.workRoot`; the script prepends the mandatory worktree preamble to every agent's `ctx`. The worktree is nested under the main checkout, so this preamble is load-bearing — it is the only thing that keeps the four agents operating on the right tree.
