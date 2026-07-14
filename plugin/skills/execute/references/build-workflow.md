# Build Workflow — the reusable build loop (script template)

The coordinator authors a Workflow from this template: read the task list from `STATE.md`'s spec and pass it (plus the dev URL) as `args`. Run via the Workflow tool. It runs each task through a state machine with a SEPARATE custom agent per role — `dobby:test-author` (conditional), `dobby:implementor`, `dobby:reviewer`, `dobby:verifier` — dispatched via `agentType`.

This is the **build loop component**: `/dobby:execute` runs it over waves of tasks; `/dobby:dispatch` runs it for a single ad-hoc fix. Same loop, same guarantees.

The loop is **count-agnostic** — 4 steps when a task authors tests first, the classic 3 otherwise:

```
[test-author] → implement → review (loop until pass) → verify
```

The leading test-author step is **gated** (see below): it runs ONLY when the repo has a test suite AND the task is marked test-first. Lib / prose / no-suite repos skip it entirely and the loop stays the classic 3-step (implement → review → verify) — nothing about those runs changes.

Encoded rules:
- **Use the script below VERBATIM.** Fill in ONLY the `args` (task list, devUrl, `hasTestSuite`, `workRoot`) — do NOT paraphrase, rename, or "simplify" the loop logic, the null guards, the defensive `args` parse, the test-step gate, the worktree preamble, or the scoped re-review. Paraphrasing silently drops these fixes (it has before — a re-authored script reverted the review loop to the thrashing version).
- **Compute `workRoot` ONCE before launching, and pass it in `args`.** Before running the Workflow, resolve the absolute worktree root — `WORKROOT="$(git rev-parse --show-toplevel)"` — and hand it in as `args.workRoot`. The script PREPENDS a mandatory worktree preamble to every agent's `ctx` when `workRoot` is present (see the `WORKTREE` note below for why this is load-bearing on the terminal host and harmless under Conductor).
- Test-author, implement, review, verify = four separate agents (`agentType: 'dobby:test-author' | 'dobby:implementor' | 'dobby:reviewer' | 'dobby:verifier'`) — never one agent in two roles. Their role instructions live in the agent definitions, NOT in this script.
- Order: (test-author, if gated in) → implement → review (loop until pass) → verify → (fail → restart implement→review→verify).
- **Test-author runs ONCE, at task start, and only when gated in** (suite exists AND the task is test-first). Its tests are the FIXED contract for the whole task: outer-loop retries re-implement / re-review / re-verify against those SAME tests — the test-author never re-runs, so a green-vs-red disagreement always means the code is wrong, never that the goalposts moved. The implementor does NOT edit these tests; if it believes a test is wrong it says so in its work-log for the reviewer to scrutinize (no cheating the contract).
- Caps prevent infinite loops; a task that exhausts them is flagged `needs-human`.
- When a test step ran, the **reviewer receives the COMBINED diff** (the test-author's tests + the implementor's code) and judges test quality (spec coverage, behavior-not-implementation) under its Spec axis; the **verifier runs the suite** (must be green) plus the dynamic tautology litmus. Those role behaviors live in the `dobby:reviewer` / `dobby:verifier` definitions — the script just wires the same review/verify steps; it does not special-case them.
- The implementor RETURNS its work-log entry (it does NOT write `STATE.md` — parallel self-appends race and clobber each other). The workflow accumulates them per task; the coordinator appends them to `STATE.md` serially AFTER the workflow returns (single writer). The test-author's returned tests are part of the diff the reviewer/verifier see; the coordinator does not separately record them.
- Pass only non-overlapping-area tasks into one batch (the coordinator groups waves). Serialize anything that mutates shared backend state during verify.
- **Coordination guards (per-task agents run in parallel — these keep them from corrupting each other):**
  - **Never commit.** No `git commit`, no `git add` from any test-author/implementor/reviewer/verifier — the coordinator and `/dobby:commit` own the index. Parallel tasks share a working tree; a stray commit/stage sweeps in siblings' half-done edits.
  - **Scope review/verify to the task's Affected areas.** Judge scope with `git diff -- <that task's files>` or by reading those files — NEVER a bare `git diff` / `git status`, which shows sibling tasks' in-flight changes and invites false findings.
  - **Never revert or "fix" changes outside your task's areas.** Another parallel task's edits are not yours to touch; leave them even if they look wrong.
  - **Never use a working-tree-wide revert — no `git checkout -- <path>`, `git restore`, `git stash`, `git reset --hard`, `git clean` — EVEN to undo your OWN scope-creep.** In the shared parallel worktree those wipe sibling tasks' uncommitted in-flight edits (a T1 fix's `git checkout --` once erased a parallel T5's work). To undo your own overreach, EDIT the specific lines back with the Edit tool (scoped to your task's files), or leave it and report it in your work-log for the reviewer.

```js
export const meta = {
  name: 'build-tasks',
  description: 'Implement → review → verify each task with separate agents, looping until both pass',
  phases: [{ title: 'Build' }],
}

const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    findings: { type: 'string', description: 'concrete issues if pass=false, else empty' },
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

const a = typeof args === 'string' ? JSON.parse(args) : args   // runtime may hand args over as a JSON string — parse defensively, else a.tasks is undefined and every task throws
const TASKS = a.tasks               // [{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst}]
const HAS_SUITE = a.hasTestSuite === true   // repo-level gate: only true when the project actually has a runnable test suite (lib/prose/plugin repos → false → classic 3-step, test-author never runs)
const WORK_ROOT = a.workRoot        // absolute worktree root (git rev-parse --show-toplevel), computed ONCE by the coordinator. Load-bearing on the terminal host (nested worktree); harmless under Conductor (workspace IS the worktree).
// Every agent inherits the PROCESS cwd = the MAIN checkout, NOT the session's nested worktree — invisible until files land in the wrong tree. Prepend an absolute-path preamble to every ctx when workRoot is known.
const WORKTREE_PREAMBLE = WORK_ROOT
  ? `🔴 WORKING DIRECTORY — READ FIRST: Operate ONLY on the git worktree at absolute path ${WORK_ROOT}. Your process cwd may WRONGLY default to the main checkout — do NOT trust \`pwd\`. RULES: (1) Bash — ALWAYS begin with \`cd ${WORK_ROOT}\`. (2) Read/Edit/Write/Grep/Glob — use ABSOLUTE paths under ${WORK_ROOT} ONLY; never create or edit anything outside it (the main checkout is off-limits). (3) NEW files are UNTRACKED — \`git diff\` will NOT show them; use \`git status --short\` + Read to see/review them. (4) Before finishing, confirm your edits landed with \`cd ${WORK_ROOT} && git status --short\`.\n\n`
  : ''
const MAX_OUTER = 3, MAX_REVIEW = 3

async function runTask(t) {
  const ctx = `${WORKTREE_PREAMBLE}TASK: ${t.title}\nSpec: ${t.spec}\nDecisions: ${t.decisions}\nConstraints: ${t.constraints}\nAffected areas: ${t.areas}`   // every agent (test-author/implementor/reviewer/verifier) reads ctx, so all four get the worktree preamble
  const workLog = []                       // accumulate every implementor entry (initial + fixes) for this task

  // 0. TEST-AUTHOR (conditional, runs ONCE at task start) — gated on suite-exists AND this task marked test-first.
  // When it doesn't run, the loop below is the classic 3-step (implement → review → verify), byte-for-byte unchanged.
  // The tests it writes are the FIXED contract for the whole task: outer-loop retries re-implement/re-review/re-verify
  // against these SAME tests — the test-author never re-runs. Written blind to the implementation (independent source
  // of truth). The reviewer/verifier see these tests in the combined diff; how they judge/run them lives in their agents.
  let testContract = ''
  if (HAS_SUITE && t.testFirst) {
    const authored = await agent(`${ctx}\nWrite the tests for this task from the spec ALONE, before any implementation exists. They are the fixed contract the implementor must satisfy.`,
      { label: `test:${t.id}`, phase: 'Build', agentType: 'dobby:test-author', schema: IMPL })
    if (authored?.workLog) { workLog.push(authored.workLog); testContract = '\nTests already authored for this task (the fixed contract — do NOT edit them; if you believe one is wrong, flag it in your work-log for the reviewer, do not change it):\n' + authored.workLog }
  }

  let feedback = ''
  for (let outer = 0; outer < MAX_OUTER; outer++) {
    // 1. IMPLEMENT (or fix with the accumulated feedback) — implementor agent; capture its work-log entry.
    // testContract is '' unless a test-author ran; when present it tells the implementor the tests are fixed and off-limits.
    const impl = await agent(`${ctx}${testContract}\n${feedback ? 'Apply this feedback and nothing else:\n' + feedback : ''}`,
      { label: `impl:${t.id}`, phase: 'Build', agentType: 'dobby:implementor', schema: IMPL })
    if (impl?.workLog) workLog.push(impl.workLog)

    // 2. CODE REVIEW (fresh reviewer agent; fix→re-review loop until pass)
    // Round 0 = full review; rounds 1+ are SCOPED to "were the prior findings fixed?" so the loop
    // converges instead of a fresh agent hunting new nitpicks each round (the classic review thrash).
    let reviewed = false, prior = ''
    for (let r = 0; r < MAX_REVIEW; r++) {
      const instruction = r === 0
        ? `Review the current diff for this task${testContract ? ' — this is the COMBINED diff (the authored tests AND the code); judge the tests too (spec coverage, behavior-not-implementation) under your Spec axis' : ''}.`
        : `RE-REVIEW. The implementor just applied fixes for these findings:\n${prior}\nConfirm ONLY that each is resolved and that the fix introduced no regression. Do NOT hunt for NEW issues you could have raised on the first review — pass if the listed findings are addressed.`
      const review = await agent(`${ctx}\n${instruction}`,
        { label: `review:${t.id}`, phase: 'Build', agentType: 'dobby:reviewer', schema: VERDICT })
      if (!review) continue                  // agent() returns null if it errors/is skipped — retry within the cap, never deref null
      if (review.pass) { reviewed = true; break }
      prior = review.findings
      const fix = await agent(`${ctx}${testContract}\nApply ONLY these code-review findings:\n${review.findings}`,
        { label: `fix:${t.id}`, phase: 'Build', agentType: 'dobby:implementor', schema: IMPL })
      if (fix?.workLog) workLog.push(fix.workLog)
    }
    if (!reviewed) return { id: t.id, status: 'needs-human', reason: 'code review never passed', workLog: workLog.join('\n\n') }

    // 3. VERIFY (fresh verifier agent)
    const runState = a.devUrl                                   // devUrl set → app already running at that URL; null → no dev server (lib/CLI/plugin), verify programmatically
      ? `The app is already running at: ${a.devUrl}`
      : `This project has no dev server (no run script) — verify programmatically (Bash/reads), not against a URL.`
    const verify = await agent(`${runState}\n\n${ctx}\nVerify recipe: ${t.verifyRecipe}`,
      { label: `verify:${t.id}`, phase: 'Build', agentType: 'dobby:verifier', schema: VERDICT })
    if (verify?.pass) return { id: t.id, status: 'done', evidence: verify.evidence, workLog: workLog.join('\n\n') }   // verify may be null (agent errored/skipped) → treat as not-passed
    feedback = 'Verification failed:\n' + (verify?.findings ?? 'verifier returned no result')   // restart implement→review→verify
  }
  return { id: t.id, status: 'needs-human', reason: 'verify never passed within retries', workLog: workLog.join('\n\n') }
}

phase('Build')
const results = await parallel(TASKS.map((t) => () => runTask(t)))
return { results }
```

Notes:
- The coordinator passes ONE wave of area-disjoint tasks per workflow run (or runs waves in sequence as dependencies clear).
- For verify steps that write shared backend state, run those tasks one wave at a time so no two destructive verifies overlap.
- **Role instructions are NOT passed in `args`** — they live in the `dobby:test-author` / `dobby:implementor` / `dobby:reviewer` / `dobby:verifier` agent definitions (dispatched via `agentType`). `args` carries only `tasks`, `devUrl`, `hasTestSuite`, and `workRoot`. The coordinator resolves `devUrl` the SAME way on both execution hosts — `portless get` then a `curl` health-check — and passes it so verifiers never start their own. The only host difference is who started the run: under **Conductor** it is already up (`auto_run_after_setup`); on the **terminal host** the coordinator first ensures the run is up per `/dobby:execute` Step 2 (liveness-check, then start it in a named cmux pane — or a background Bash job without cmux — never double-starting) before resolving `devUrl`. A project with no run script (lib/CLI/plugin) has `devUrl = null` on both hosts, and the verify prompt switches to "no dev server — verify programmatically".
- **The test-author step is doubly gated.** `hasTestSuite` (repo-level, from the spec's Testing Decisions) must be `true` AND the individual task must carry `testFirst: true`. When `hasTestSuite` is `false` — as it is for a lib / CLI / plugin like dobby with no runnable suite — the test-author never runs for any task and the loop is byte-for-byte the classic 3-step. Do NOT set `hasTestSuite: true` for a repo without a real suite just to force the step.
- **Work log: the workflow does NOT write `STATE.md`** (workflows have no filesystem access). Each task result carries its accumulated `workLog`; the coordinator appends these to `STATE.md` serially after the workflow returns (single writer — no parallel-append race).
- The workflow is headless: no human QA, no interactive steps.
- **Pass `args` as an actual JSON object** in the Workflow call (the tool delivers it verbatim — do NOT `JSON.stringify` it). The script still parses defensively (`typeof args === 'string' ? JSON.parse(args) : args`) because the runtime may deliver it as a JSON string; without that guard, `args.tasks` is `undefined` and every task throws on the first access.
- **`workRoot` — the nested-worktree cwd fix.** Workflow subagents inherit the *process* cwd = the MAIN checkout, NOT the session's logical worktree at `.claude/worktrees/<slug>/`. This is invisible until files land in the wrong tree: in a real terminal-host session it caused wave-1 files to write into MAIN while a reviewer saw the worktree clean and a re-check agent saw those files "already present" (in main) — the review loop never converged, a task was flagged `needs-human` with a fabricated work log, and the coordinator only recovered by hand-injecting an absolute-path preamble into every later agent prompt (~90 wasted turns + a contaminated main). So the coordinator computes `WORKROOT="$(git rev-parse --show-toplevel)"` ONCE up front and passes it as `args.workRoot`; the script prepends the mandatory worktree preamble to every agent's `ctx`. Injecting `workRoot` is always safe: under **Conductor** the workspace IS the worktree, so `workRoot` equals the checkout root and the preamble is a harmless no-op restatement; on the **terminal host** (nested worktree under the main checkout) it is load-bearing — it is the only thing that keeps the four agents operating on the right tree.
