# Build Workflow — the reusable trifecta (script template)

The coordinator authors a Workflow from this template: read the task list from `STATE.md`'s spec and pass it (plus the dev URL) as `args`. Run via the Workflow tool. It runs each task through a state machine with a SEPARATE custom agent per role — `dobby:implementor`, `dobby:reviewer`, `dobby:verifier` — dispatched via `agentType`.

This is the **trifecta component**: `/dobby:execute` runs it over waves of tasks; `/dobby:dispatch` runs it for a single ad-hoc fix. Same loop, same guarantees.

Encoded rules:
- **Use the script below VERBATIM.** Fill in ONLY the `args` (task list, devUrl) — do NOT paraphrase, rename, or "simplify" the loop logic, the null guards, the defensive `args` parse, or the scoped re-review. Paraphrasing silently drops these fixes (it has before — a re-authored script reverted the review loop to the thrashing version).
- Implement, review, verify = three separate agents (`agentType: 'dobby:implementor' | 'dobby:reviewer' | 'dobby:verifier'`) — never one agent in two roles. Their role instructions live in the agent definitions, NOT in this script.
- Order: implement → review (loop until pass) → verify → (fail → restart implement→review→verify).
- Caps prevent infinite loops; a task that exhausts them is flagged `needs-human`.
- The implementor RETURNS its work-log entry (it does NOT write `STATE.md` — parallel self-appends race and clobber each other). The workflow accumulates them per task; the coordinator appends them to `STATE.md` serially AFTER the workflow returns (single writer).
- Pass only non-overlapping-area tasks into one batch (the coordinator groups waves). Serialize anything that mutates shared backend state during verify.

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
const TASKS = a.tasks               // [{id, title, spec, decisions, constraints, areas, verifyRecipe}]
const MAX_OUTER = 3, MAX_REVIEW = 3

async function runTask(t) {
  const ctx = `TASK: ${t.title}\nSpec: ${t.spec}\nDecisions: ${t.decisions}\nConstraints: ${t.constraints}\nAffected areas: ${t.areas}`
  const workLog = []                       // accumulate every implementor entry (initial + fixes) for this task
  let feedback = ''
  for (let outer = 0; outer < MAX_OUTER; outer++) {
    // 1. IMPLEMENT (or fix with the accumulated feedback) — implementor agent; capture its work-log entry
    const impl = await agent(`${ctx}\n${feedback ? 'Apply this feedback and nothing else:\n' + feedback : ''}`,
      { label: `impl:${t.id}`, phase: 'Build', agentType: 'dobby:implementor', schema: IMPL })
    if (impl?.workLog) workLog.push(impl.workLog)

    // 2. CODE REVIEW (fresh reviewer agent; fix→re-review loop until pass)
    // Round 0 = full review; rounds 1+ are SCOPED to "were the prior findings fixed?" so the loop
    // converges instead of a fresh agent hunting new nitpicks each round (the classic review thrash).
    let reviewed = false, prior = ''
    for (let r = 0; r < MAX_REVIEW; r++) {
      const instruction = r === 0
        ? 'Review the current diff for this task.'
        : `RE-REVIEW. The implementor just applied fixes for these findings:\n${prior}\nConfirm ONLY that each is resolved and that the fix introduced no regression. Do NOT hunt for NEW issues you could have raised on the first review — pass if the listed findings are addressed.`
      const review = await agent(`${ctx}\n${instruction}`,
        { label: `review:${t.id}`, phase: 'Build', agentType: 'dobby:reviewer', schema: VERDICT })
      if (!review) continue                  // agent() returns null if it errors/is skipped — retry within the cap, never deref null
      if (review.pass) { reviewed = true; break }
      prior = review.findings
      const fix = await agent(`${ctx}\nApply ONLY these code-review findings:\n${review.findings}`,
        { label: `fix:${t.id}`, phase: 'Build', agentType: 'dobby:implementor', schema: IMPL })
      if (fix?.workLog) workLog.push(fix.workLog)
    }
    if (!reviewed) return { id: t.id, status: 'needs-human', reason: 'code review never passed', workLog: workLog.join('\n\n') }

    // 3. VERIFY (fresh verifier agent)
    const verify = await agent(`The app is already running at: ${a.devUrl}\n\n${ctx}\nVerify recipe: ${t.verifyRecipe}`,
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
- **Role instructions are NOT passed in `args`** — they live in the `dobby:implementor` / `dobby:reviewer` / `dobby:verifier` agent definitions (dispatched via `agentType`). `args` carries only `tasks` and `devUrl` (the already-running dev server the coordinator started ONCE — so verifiers never start their own).
- **Work log: the workflow does NOT write `STATE.md`** (workflows have no filesystem access). Each task result carries its accumulated `workLog`; the coordinator appends these to `STATE.md` serially after the workflow returns (single writer — no parallel-append race).
- The workflow is headless: no human QA, no interactive steps.
- **Pass `args` as an actual JSON object** in the Workflow call (the tool delivers it verbatim — do NOT `JSON.stringify` it). The script still parses defensively (`typeof args === 'string' ? JSON.parse(args) : args`) because the runtime may deliver it as a JSON string; without that guard, `args.tasks` is `undefined` and every task throws on the first access.
