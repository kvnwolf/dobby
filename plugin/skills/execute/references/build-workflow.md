# Build Run — the whole plan in ONE workflow (script template)

The coordinator authors ONE Workflow from this template per plan — the **build run** — passing the plan's waves (plus the dev URL) as `args`. Run via the Workflow tool. The script sequences the waves itself (one after another, tasks inside a wave in parallel) and puts every task through a state machine with a SEPARATE custom agent per active role — `dobby:test-author` (conditional), `dobby:implementor`, and `dobby:verifier` — dispatched via `agentType`. `dobby:reviewer` is deliberately absent from the normal loop; holistic code review happens on the PR.

This is the **build loop component**: `/dobby:execute` hands it the whole approved plan (`args.waves`); `/dobby:dispatch` and `/dobby:address-review` hand it a single ad-hoc fix (`args.tasks`, read as one wave). Same loop, same guarantees.

The per-task loop is **count-agnostic** — 3 steps when a task authors tests first, 2 otherwise:

```
[test-author] → implement → verify → (actionable failure and another slot? fix → verify)
```

The leading test-author step is **gated** (see below): it runs ONLY when the repo has a test suite AND the task is marked test-first. Lib / prose / no-suite repos skip it and run implement → verify.

Encoded rules:
- **Use the script below VERBATIM.** Fill in ONLY the `args` (`waves` — or `tasks` for a single ad-hoc fix — `devUrl`, `hasTestSuite`, `workRoot`, `workflowRecipe`) — do NOT paraphrase, rename, or "simplify" the wave loop, the blocked-dependent skip, the `log()` lines, the loop logic, the null guards and writer-null safety review, the defensive `args` parse, the test-step gate, the worktree preamble, or the recipe fingerprint guards.
- **ONE build run per plan.** The whole plan goes into a SINGLE Workflow invocation; the script walks the waves in order. Do NOT launch one workflow per wave, and do NOT merge waves into one flat list — the wave boundaries ARE the safety (area-disjoint parallelism, destructive tasks alone) and the script preserves them exactly as they arrive.
- **`args.waves` carries FULL task objects, never ids.** `bunx dobby build-plan --json` emits `waves[][]` as id arrays NEXT to `tasks[]`; the coordinator zips them so each wave entry is the whole task object (`{id, title, spec, decisions, constraints, areas, verifyRecipe, testFirst, dependsOn}`). The script reads `t.dependsOn` off those objects to skip blocked tasks; a wave of bare ids makes the run throw immediately instead of building the wrong thing — as does a task id repeated across the waves (ids key the run's outcome map, so they must be unique).
- **`workRoot` is REQUIRED and absolute.** Before running the Workflow, resolve the worktree root ONCE — `WORKROOT="$(git rev-parse --show-toplevel)"` — and hand that non-empty absolute path in as `args.workRoot`. Missing, relative, or control-character-bearing values abort before any agent. The script ALWAYS prepends the mandatory worktree preamble to every agent's `ctx` (see the `WORKTREE` note below for why this is load-bearing — the session's worktree is nested under the main checkout).
- **`hasTestSuite` is REQUIRED and boolean.** Pass exactly `build-plan.hasTestSuite.value`, not the enclosing object, an omitted field, or a value inferred from prose. The script aborts before any agent unless it receives a literal boolean.
- Test-author, implement, and verify are separate agents (`agentType: 'dobby:test-author' | 'dobby:implementor' | 'dobby:verifier'`) — never one agent in two roles. Their role instructions live in the agent definitions, NOT in this script.
- Order: (test-author, if gated in) → implement → verify → (actionable failure and another outer slot → optional test-contract extension → implement → verify).
- **Test-author runs at task start only when gated in** (suite exists AND the task is test-first). Its tests are the fixed contract. The only later test-author call is a verifier-requested `testFindings` extension, and it is allowed only while a full implement→verify cycle remains. The implementor never edits that authored contract.
- Caps prevent infinite loops; a task that exhausts them is flagged `needs-human`.
- **No terminal fix.** A code or test-contract mutation is dispatched only when another verifier call remains. A failure on the final outer attempt goes straight to `needs-human`, so the last normal agent is always the verifier.
- **No-action failures stop rather than amplify.** The verifier classifies every failure as `code`, `test-contract`, `environment`, or `needs-human`; ONLY the first two may dispatch a writer, and only while another verifier slot remains. Environment/auth/setup failures and work that requires human judgment stop immediately instead of being misrouted as code fixes. A thrown `agent()` call is recorded as telemetry outcome `error` and normalized to `null`; any write-capable test-author/implementor stage first consumes one scoped safety review before stopping `needs-human`.
- **`workflowRecipe` comes verbatim from `dobby env --json`, fingerprint included.** It is the fixed `baseline-v1` experiment: native per-invocation model/effort for each of the five workers plus bounded outer/concurrency limits and mechanical-first verification. Its fingerprint seals the id, roles in canonical order, limits, and verification posture. Before any agent, the script validates the supplied fingerprint AND independently recomputes that fingerprint from the received fields against the exact baseline; missing, malformed, or drifted input aborts. There is no profile, state selection, override, escalation surface, second policy table, or silent fallback.
- **A writer null or invalid result cannot be treated as a clean no-op.** Every test-author or implementor result must coherently report `status`, non-empty `workLog`, and `blocker`; an invalid result dispatches one exceptional task-scoped reviewer at stage `safety-review` over the current diff. A coherent `blocked` result stops `needs-human` with its accounted work log and blocker. The reviewer audits only and never fixes; this is not a normal review gate.
- **A task whose dependency ended badly is skipped as `blocked`** — status `blocked`, `blockedBy` naming the blocker, ZERO agents spawned, no work-log entry (nothing ran). Blocking is transitive by construction: a blocked task is itself non-`done`, so its own dependents block too. Independent tasks in the same later wave still run.
- **Telemetry stays inside the native Workflow return.** Every `agent()` invocation records task/stage/role, the requested model/effort/recipe and recipe fingerprint, attempt, outcome, verification source, and a null escalation reason (the fixed recipe has no dynamic escalation). Claude Code may apply an operator-level model override that the Workflow cannot observe, so `requestedModel` carries the recipe value while effective `model` is explicitly `unknown`. The runtime also exposes neither its own run id nor token counts/clock to this script, so `runId`, token fields, provider, and duration are `unknown` too — never guessed and never scraped from private transcripts. The final summary reports attempts, retries, first-attempt success, limit exhaustion, and verification-source counts.
- **The run narrates itself with `log()`** — the only channel it has while it runs (the main thread receives nothing until the final return). One terminal line per task, one line per verify retry, a line per wave boundary, plus every subsequent milestone of any task that failed verification. Lines are English, terse, symbol-led (`✓` / `✗` / `⊘`).
- When a test step ran, the verifier prompt says so explicitly and the **verifier** runs the suite for EVERY task type (UI included), requires it green, applies the dynamic tautology litmus without mutating the shared worktree, and separates implementation findings from test-contract findings. Code quality/style/architecture review belongs to the later PR review.
- The implementor RETURNS its work-log entry (it does NOT write `STATE.md` — parallel self-appends race and clobber each other). The workflow accumulates them per task; the coordinator appends them to `STATE.md` serially AFTER the workflow returns (single writer). The test-author's returned tests are part of the diff the verifier sees; the coordinator does not separately record them.
- Every wave must be non-overlapping in Affected areas, and anything that mutates shared backend state during verify must sit alone in its wave — `bunx dobby build-plan` already groups them that way; the script never regroups.
- **Coordination guards (per-task agents run in parallel — these keep them from corrupting each other):**
  - **Never commit.** No `git commit`, no `git add` from any test-author/implementor/verifier (or exceptional safety reviewer) — the coordinator and `/dobby:commit` own the index. Parallel tasks share a working tree; a stray commit/stage sweeps in siblings' half-done edits.
  - **Scope verification to the task's Affected areas.** Judge scope with `git diff -- <that task's files>` or by reading those files — NEVER a bare `git diff` / `git status`, which shows sibling tasks' in-flight changes and invites false findings.
  - **Never revert or "fix" changes outside your task's areas.** Another parallel task's edits are not yours to touch; leave them even if they look wrong.
  - **Never use a working-tree-wide revert — no `git checkout -- <path>`, `git restore`, `git stash`, `git reset --hard`, `git clean` — EVEN to undo your OWN scope-creep.** In the shared parallel worktree those wipe sibling tasks' uncommitted in-flight edits. To undo your own overreach, EDIT the specific lines back with the Edit tool, or leave it and report it in your work-log.

```js
export const meta = {
  name: 'build-run',
  description: 'Run a whole plan: waves in sequence, tasks in parallel, each implemented → verified by separate agents',
  // NO `phases` here: meta must stay a pure literal, so it could only ever declare a skeleton it never fills — and a declared-but-unused phase shows up in the UI as a dead "0 agents" row. Each wave opens its OWN group at runtime instead (`Wave n/m`).
}

const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    failureKind: { type: 'string', enum: ['none', 'code', 'test-contract', 'environment', 'needs-human'], description: '`none` only with pass=true; only code/test-contract are writer-actionable' },
    findings: { type: 'string', description: 'concrete issues if pass=false, else empty' },
    testFindings: { type: 'string', description: 'verifier only: findings whose FIX is adding/changing the authored test contract — routed to the test-author when one exists; empty if none' },
    evidence: { type: 'string', description: 'non-empty observation supporting either pass or failure' },
    verificationKind: { type: 'string', enum: ['mechanically-proven', 'model-judged', 'not-available'], description: 'strongest honest evidence source; pass=true may not use not-available' },
  },
  required: ['pass', 'failureKind', 'findings', 'testFindings', 'evidence', 'verificationKind'],
}

const SAFETY_VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    findings: { type: 'string', description: 'unlogged task-scoped mutations or risks; empty if none' },
    testFindings: { type: 'string', description: 'test-specific unlogged mutations or risks; empty if none' },
  },
  required: ['pass', 'findings'],
}

const IMPL = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'], description: 'completed only when the requested writer work finished; blocked when it could not safely finish' },
    workLog: { type: 'string', description: "this task's ## Work log entry: diff summary (by area), decisions + deviations and why, files touched" },
    blocker: { type: 'string', description: 'non-empty when status=blocked, otherwise empty' },
  },
  required: ['status', 'workLog', 'blocker'],
}

const a = typeof args === 'string' ? JSON.parse(args) : args   // runtime may hand args over as a JSON string — parse defensively, else a.waves is undefined and every task throws
if (!a || typeof a !== 'object') throw new Error('build run: args must be an object')
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
// UNIQUE IDS. A task id KEYS the outcome map every later wave reads back, so a repeated id
// would overwrite a sibling's terminal status and let a dependent build on a task that failed
// (or block on one that passed). Neither build-plan nor an ad-hoc tasks[] enforces uniqueness —
// so check it here, before a single agent burns tokens.
const seenIds = new Set()
for (const w of WAVES) {
  for (const t of w) {
    if (seenIds.has(t.id)) throw new Error(`build run: duplicate task id \`${t.id}\` across the waves — ids key the run's outcome map, so every task must have its own`)
    seenIds.add(t.id)
  }
}
if (typeof a.hasTestSuite !== 'boolean') throw new Error('build run: args.hasTestSuite must be a boolean from `dobby build-plan --json`')
const HAS_SUITE = a.hasTestSuite   // repo-level gate: only true when the project actually has a runnable test suite (lib/prose/plugin repos → false → implement→verify, test-author never runs)
const WORK_ROOT = typeof a.workRoot === 'string' ? a.workRoot.trim() : ''
const ABSOLUTE_WORK_ROOT = WORK_ROOT.startsWith('/') || /^[A-Za-z]:[\\/]/.test(WORK_ROOT)
if (!ABSOLUTE_WORK_ROOT || /[\0\r\n]/.test(WORK_ROOT)) throw new Error('build run: args.workRoot must be a non-empty absolute path from `dobby build-plan --json`')
const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`
const SHELL_WORK_ROOT = shellQuote(WORK_ROOT)
// Every agent inherits the PROCESS cwd = the MAIN checkout, NOT the session's nested worktree — invisible until files land in the wrong tree. The validated absolute preamble is mandatory for every ctx.
const WORKTREE_PREAMBLE = `🔴 WORKING DIRECTORY — READ FIRST: Operate ONLY on the git worktree whose exact path is ${JSON.stringify(WORK_ROOT)}. Your process cwd may WRONGLY default to the main checkout — do NOT trust \`pwd\`. RULES: (1) Bash — ALWAYS begin with \`cd -- ${SHELL_WORK_ROOT}\` (this value is shell-escaped; copy it exactly). (2) Read/Edit/Write/Grep/Glob — use ABSOLUTE paths under the exact worktree path ONLY; never create or edit anything outside it (the main checkout is off-limits). (3) NEW files are UNTRACKED — \`git diff\` will NOT show them; use \`git status --short\` + Read to see/review them. (4) Before finishing, confirm your edits landed with \`cd -- ${SHELL_WORK_ROOT} && git status --short\`.\n\n`
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const FINGERPRINT_ROLES = ['researcher', 'test-author', 'implementor', 'reviewer', 'verifier']
const EXPECTED_RECIPE_FINGERPRINT = 'fnv1a32:32afa935'
const requestedRecipe = a.workflowRecipe && typeof a.workflowRecipe === 'object' ? a.workflowRecipe : null
if (!requestedRecipe || requestedRecipe.id !== 'baseline-v1') {
  throw new Error('build run: args.workflowRecipe must be the complete recipe from `dobby env --json`')
}
const fingerprintMaterial = [
  'dobby.workflow-recipe/v1',
  requestedRecipe.id,
  ...FINGERPRINT_ROLES.flatMap((role) => [role, requestedRecipe.roles?.[role]?.model ?? '', requestedRecipe.roles?.[role]?.reasoning ?? '']),
  String(requestedRecipe.limits?.maxOuter ?? ''),
  String(requestedRecipe.limits?.maxConcurrency ?? ''),
  requestedRecipe.verification ?? '',
].join('\0')
let fingerprintHash = 0x811c9dc5
for (const byte of new TextEncoder().encode(fingerprintMaterial)) fingerprintHash = Math.imul(fingerprintHash ^ byte, 0x01000193) >>> 0
const computedRecipeFingerprint = `fnv1a32:${fingerprintHash.toString(16).padStart(8, '0')}`
if (requestedRecipe.fingerprint !== EXPECTED_RECIPE_FINGERPRINT || computedRecipeFingerprint !== EXPECTED_RECIPE_FINGERPRINT) {
  throw new Error('build run: workflowRecipe fingerprint does not match the exact baseline-v1 policy')
}
const fixedLimit = (value, expected, field) => {
  if (value !== expected) throw new Error(`build run: workflowRecipe.${field} must be ${expected} for baseline-v1`)
  return expected
}
const RECIPE = requestedRecipe.id
const RECIPE_FINGERPRINT = requestedRecipe.fingerprint
const MAX_OUTER = fixedLimit(requestedRecipe.limits?.maxOuter, 2, 'limits.maxOuter')
const MAX_CONCURRENCY = fixedLimit(requestedRecipe.limits?.maxConcurrency, 2, 'limits.maxConcurrency')
const VERIFICATION_POLICY = requestedRecipe.verification === 'mechanical-first' ? 'mechanical-first' : null
if (!VERIFICATION_POLICY) throw new Error('build run: workflowRecipe.verification must be `mechanical-first`')
const rolePolicy = (role) => {
  const requested = requestedRecipe.roles?.[role]
  if (typeof requested?.model !== 'string' || !requested.model.trim() || !EFFORTS.includes(requested?.reasoning)) {
    throw new Error(`build run: workflowRecipe.roles.${role} needs a model and valid reasoning effort`)
  }
  return { model: requested.model.trim(), effort: requested.reasoning }
}
for (const role of FINGERPRINT_ROLES) rolePolicy(role)
const agentOptions = (role, label, phaseName, schema) => {
  const policy = rolePolicy(role)
  return { label, phase: phaseName, agentType: `dobby:${role}`, schema, model: policy.model, effort: policy.effort }
}
const UNKNOWN = 'unknown'
const telemetryEvents = []
const verificationKind = (result) => ['mechanically-proven', 'model-judged', 'not-available'].includes(result?.verificationKind) ? result.verificationKind : 'not-available'
const textField = (result, field) => typeof result?.[field] === 'string' ? result[field].trim() : ''
const retryCount = (taskId) => telemetryEvents.filter((event) => event.taskId === taskId && event.attempt > 1).length
const hasWorkLog = (result) => typeof result?.workLog === 'string' && result.workLog.trim().length > 0
const writerState = (result) => {
  if (!hasWorkLog(result)) return 'invalid'
  const blocker = typeof result?.blocker === 'string' ? result.blocker.trim() : ''
  if (result?.status === 'completed' && !blocker) return 'completed'
  if (result?.status === 'blocked' && blocker) return 'blocked'
  return 'invalid'
}

// log() lines are ONE-LINERS above the progress tree: take the first non-empty line of
// whatever an agent said and cap it, so a paragraph of findings never floods the run.
const brief = (text) => {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

// A task whose thunk died outside the guarded agent-dispatch seam (never expected):
// parallel() hands back null for it, and a null must still be a REPORTED task, never a
// silently missing row in the coordinator's final table. An agent() throw itself never
// reaches this path: dispatch records it and returns null to the role's bounded guard.
const crashed = (t) => {
  log(`${t.id} ✗ needs-human — the task crashed inside the build run`)
  return { id: t.id, status: 'needs-human', reason: 'the task crashed inside the build run', workLog: '', loops: 0, retries: retryCount(t.id), limitExhausted: false, verification: 'not-available' }
}

async function runTask(t, phaseName) {
  const ctx = `${WORKTREE_PREAMBLE}TASK: ${t.title}\nSpec: ${t.spec}\nDecisions: ${t.decisions}\nConstraints: ${t.constraints}\nAffected areas: ${t.areas}`   // every active agent reads ctx, so all get the worktree preamble
  const workLog = []                       // accumulate every implementor entry (initial + fixes) for this task
  const roleAttempts = Object.create(null)
  const dispatch = async (role, stage, prompt, label, schema) => {
    const attempt = (roleAttempts[role] ?? 0) + 1
    roleAttempts[role] = attempt
    const policy = rolePolicy(role)
    const event = {
      runId: UNKNOWN,
      taskId: t.id,
      stage,
      role,
      host: 'claude-code',
      provider: UNKNOWN,
      requestedModel: policy.model,
      model: UNKNOWN,
      reasoning: policy.effort,
      recipe: RECIPE,
      recipeFingerprint: RECIPE_FINGERPRINT,
      attempt,
      inputTokens: UNKNOWN,
      cachedInputTokens: UNKNOWN,
      outputTokens: UNKNOWN,
      duration: UNKNOWN,
      outcome: UNKNOWN,
      escalationReason: null,
      verification: role === 'verifier' ? 'not-available' : 'not-applicable',
    }
    try {
      const result = await agent(prompt, agentOptions(role, label, phaseName, schema))
      event.outcome = result === null
        ? 'no-result'
        : typeof result?.pass === 'boolean'
          ? (result.pass ? 'passed' : 'failed')
          : result?.status === 'completed' || result?.status === 'blocked'
            ? result.status
            : 'invalid-result'
      if (role === 'verifier') event.verification = verificationKind(result)
      telemetryEvents.push(event)
      return result
    } catch {
      event.outcome = 'error'
      telemetryEvents.push(event)
      return null
    }
  }
  // ADAPTIVE VERBOSITY. A task is TERSE — one terminal line — until verification fails;
  // that first failure flips `loud` for good and every LATER milestone of THIS
  // task is narrated, while its siblings stay terse. No de-escalation, no retro-logging:
  // the detail starts exactly where the trouble started.
  let loud = false
  const milestone = (line) => { if (loud) log(`${t.id}: ${line}`) }
  const verified = (loops, evidence, verifyResult) => {
    log(`${t.id} ✓ verified — ${brief(evidence) || 'verify passed'} (${loops} loop${loops === 1 ? '' : 's'})`)
    return { id: t.id, status: 'done', evidence, workLog: workLog.join('\n\n'), loops, retries: retryCount(t.id), limitExhausted: false, verification: verificationKind(verifyResult) }   // status stays 'done' (the prose says "verified"; the CONTRACT does not move — /dobby:dispatch and /dobby:address-review read 'done')
  }
  const stuck = (loops, reason, limitExhausted = true) => {
    log(`${t.id} ✗ needs-human — ${reason}`)
    return { id: t.id, status: 'needs-human', reason, workLog: workLog.join('\n\n'), loops, retries: retryCount(t.id), limitExhausted, verification: 'not-available' }
  }
  // A write-capable agent can mutate the shared tree and then throw or fail structured
  // output. A null/invalid writer result therefore cannot simply stop: consume one exceptional,
  // read-only reviewer call over the current scoped diff, then remain needs-human.
  const stopAfterUnloggedMutation = async (loops, reason) => {
    const safetyReview = await dispatch('reviewer', 'safety-review', `${ctx}\nSAFETY REVIEW ONLY. A write-capable agent may have changed this task's affected areas but returned no valid structured writer result. Review the current task-scoped diff for unaccounted mutations. Do not implement or repair anything; this task will remain needs-human after your verdict.`, `review:${t.id}`, SAFETY_VERDICT)
    const reviewOutcome = safetyReview?.pass ? 'passed' : safetyReview ? 'failed' : 'returned no result'
    return stuck(loops, `${reason}; safety review ${reviewOutcome}`, false)
  }

  // 0. TEST-AUTHOR (conditional) — gated on suite-exists AND this task marked test-first.
  // The tests it writes are the FIXED contract for the whole task. It may run again only when
  // the verifier identifies a concrete test-contract gap and a full implement→verify slot remains.
  // (No milestone line here: this step runs BEFORE anything can have failed, so no task is ever loud yet.)
  let testContract = ''
  if (HAS_SUITE && t.testFirst) {
    const authored = await dispatch('test-author', 'test-author', `${ctx}\nWrite the tests for this task from the spec ALONE, before any implementation exists. They are the fixed contract the implementor must satisfy.`, `test:${t.id}`, IMPL)
    const authoredState = writerState(authored)
    if (authoredState === 'invalid') return stopAfterUnloggedMutation(0, 'test-author returned no valid writer result')
    workLog.push(authored.workLog)
    if (authoredState === 'blocked') return stuck(0, `test-author blocked: ${textField(authored, 'blocker')}`, false)
    testContract = '\nTests already authored for this task (the fixed contract — do NOT edit them; if you believe one is wrong, flag it in your work-log, do not change it):\n' + authored.workLog
  }

  let feedback = ''
  for (let outer = 0; outer < MAX_OUTER; outer++) {
    // 1. IMPLEMENT (or fix with the accumulated verifier feedback) — capture its work-log entry.
    // testContract is '' unless a test-author ran; when present it tells the implementor the tests are fixed and off-limits.
    const impl = await dispatch('implementor', 'implement', `${ctx}${testContract}\n${feedback ? 'Apply this feedback and nothing else:\n' + feedback : ''}`, `impl:${t.id}`, IMPL)
    const implState = writerState(impl)
    if (implState === 'invalid') return stopAfterUnloggedMutation(outer + 1, 'implementor returned no valid writer result')
    workLog.push(impl.workLog)
    if (implState === 'blocked') return stuck(outer + 1, `implementor blocked: ${textField(impl, 'blocker')}`, false)
    milestone(`implementation ready (loop ${outer + 1}/${MAX_OUTER})`)

    // 2. VERIFY (fresh verifier agent). This is the normal final gate; code review happens on the PR.
    const runState = a.devUrl                                   // devUrl set → app already running at that URL; null → no dev server (lib/CLI/plugin), verify programmatically
      ? `The app is already running at: ${a.devUrl}`
      : `This project has no dev server (no run script) — verify programmatically (Bash/reads), not against a URL.`
    const verificationPosture = 'Run the exact deterministic recipe first. Keep the proof scoped; use model judgment only where the recipe, UI, or result requires interpretation.'
    const suiteContext = `hasTestSuite: ${HAS_SUITE}\ntestContractAuthored: ${Boolean(testContract)}`
    const suiteRequirement = HAS_SUITE
      ? 'Run the project test suite for EVERY task type, including UI-facing tasks, before any browser/model-judged proof. If a fixed test contract was authored, it must be included and green.'
      : 'No project test suite was detected; do not invent one as verification.'
    const verify = await dispatch('verifier', 'verify', `${runState}\n\n${ctx}\n${verificationPosture}\n${suiteContext}\n${suiteRequirement}\nVerify recipe: ${t.verifyRecipe}`, `verify:${t.id}`, VERDICT)
    const evidence = textField(verify, 'evidence')
    const codeFindings = textField(verify, 'findings')
    const rawTestFindings = textField(verify, 'testFindings')
    const failureKind = textField(verify, 'failureKind')
    const rawVerificationKind = textField(verify, 'verificationKind')
    const coherentPass = verify?.pass === true
      && failureKind === 'none'
      && evidence
      && ['mechanically-proven', 'model-judged'].includes(rawVerificationKind)
      && !codeFindings
      && !rawTestFindings
    if (coherentPass) { milestone('verify ✓'); return verified(outer + 1, evidence, verify) }
    loud = true                              // first verify failure → this task narrates everything from here on
    if (verify?.pass === true) return stuck(outer + 1, 'verifier returned an incoherent pass verdict', false)
    const validFailureKind = ['code', 'test-contract', 'environment', 'needs-human'].includes(failureKind)
    const validFailureEvidence = verify?.pass === false && evidence && ['mechanically-proven', 'model-judged', 'not-available'].includes(rawVerificationKind)
    const coherentFailureShape = validFailureKind && validFailureEvidence
      && (failureKind === 'code' ? Boolean(codeFindings) && !rawTestFindings : true)
      && (failureKind === 'test-contract' ? Boolean(rawTestFindings) : true)
      && (failureKind === 'environment' || failureKind === 'needs-human' ? Boolean(codeFindings) && !rawTestFindings : true)
    if (!coherentFailureShape) return stuck(outer + 1, 'verifier returned an invalid failure verdict', false)
    if (failureKind === 'environment') return stuck(outer + 1, `verification blocked by environment: ${brief(codeFindings)}`, false)
    if (failureKind === 'needs-human') return stuck(outer + 1, `verification requires human judgment: ${brief(codeFindings)}`, false)
    // Without an authored test contract, test gaps are ordinary implementation findings: the
    // implementor owns the task's tests. With a contract, only test-author may extend it.
    const testFindings = failureKind === 'test-contract' && testContract ? rawTestFindings : ''
    const implementorFindings = testContract ? codeFindings : [codeFindings, rawTestFindings].filter(Boolean).join('\n')
    const actionable = [implementorFindings, testFindings].filter(Boolean).join('\n')
    if (outer + 1 >= MAX_OUTER) break         // no writer after the last verifier: every mutation must have later verification
    if (!actionable) return stuck(outer + 1, 'verifier returned an actionable failure without findings', false)
    log(`${t.id}: verify ✗ (${brief(actionable)}) — outer loop ${outer + 2}/${MAX_OUTER}`)
    if (testFindings) {
      const tfix = await dispatch('test-author', 'test-fix', `${ctx}\nThe verifier found this gap in the fixed TEST contract. Extend the contract with EXACTLY what this finding names; preserve every existing test:\n${testFindings}`, `test-fix:${t.id}`, IMPL)
      const testFixState = writerState(tfix)
      if (testFixState === 'invalid') return stopAfterUnloggedMutation(outer + 1, 'test-author fix returned no valid writer result')
      workLog.push(tfix.workLog)
      if (testFixState === 'blocked') return stuck(outer + 1, `test-author fix blocked: ${textField(tfix, 'blocker')}`, false)
      testContract += `\nVerifier-requested test-contract extension:\n${tfix.workLog}`
      milestone('test contract extended')
    }
    const nextInstructions = []
    if (implementorFindings) nextInstructions.push(implementorFindings)
    if (testFindings) nextInstructions.push(`The test-author extended the fixed contract for this gap: ${testFindings}\nMake the implementation satisfy the updated contract; do not edit the authored tests.`)
    feedback = 'Verification failed. Apply only these actionable instructions before the mandatory re-verification:\n' + nextInstructions.join('\n')
  }
  return stuck(MAX_OUTER, 'verify never passed within retries')
}

// THE WAVE LOOP — the whole plan in one run. Waves go one after another (a later wave may
// depend on an earlier one); the tasks INSIDE a wave go at once, which is safe because the
// plan already made each wave area-disjoint and put every destructive task alone in its own.
const outcome = Object.create(null)          // id → terminal status, the ONLY thing a later wave reads back. Null-prototype: a task id like `__proto__` / `constructor` must never resolve to an INHERITED property and fake a status no wave ever set.
const results = []
log(`Recipe ${RECIPE} — outer ${MAX_OUTER} · concurrency ${MAX_CONCURRENCY}`)
for (let i = 0; i < WAVES.length; i++) {
  const wave = WAVES[i]
  const title = `Wave ${i + 1}/${WAVES.length}`
  phase(title)
  log(`${title} — ${wave.length} task${wave.length === 1 ? '' : 's'}`)
  const waveResults = []
  // Preserve the wave exactly; chunk only its execution so active tasks never exceed the cap.
  for (let start = 0; start < wave.length; start += MAX_CONCURRENCY) {
    const batch = wave.slice(start, start + MAX_CONCURRENCY)
    const settled = await parallel(batch.map((t) => async () => {
      // BLOCKED: a dependency that did NOT end 'done' (needs-human, or blocked itself) makes
      // this task un-buildable — skip it without spawning a single agent. Transitivity falls
      // out of the map: a blocked task is non-'done' too, so ITS dependents block in turn.
      const blocker = (t.dependsOn ?? []).find((d) => outcome[d] && outcome[d] !== 'done')
      if (blocker) {
        log(`${t.id} ⊘ blocked — depends on ${blocker} (${outcome[blocker]})`)
        return { id: t.id, status: 'blocked', blockedBy: blocker, workLog: '', loops: 0, retries: 0, limitExhausted: false, verification: 'not-available' }   // no work log: nothing ran
      }
      return runTask(t, title)
    }))
    const returned = settled.filter(Boolean)   // pair BY ID, not by index: every planned task gets one row whatever order parallel() answers in
    for (const t of batch) waveResults.push(returned.find((r) => r.id === t.id) ?? crashed(t))
  }
  for (const r of waveResults) { outcome[r.id] = r.status; results.push(r) }
  const count = (s) => waveResults.filter((r) => r.status === s).length
  log(`${title} done: ${count('done')} ✓ · ${count('needs-human')} needs-human · ${count('blocked')} ⊘`)
}
const attempted = results.filter((result) => result.status !== 'blocked')
const firstAttemptSuccess = attempted.filter((result) => result.status === 'done' && result.retries === 0).length
const verificationCounts = { 'mechanically-proven': 0, 'model-judged': 0, 'not-available': 0 }
for (const result of results) verificationCounts[result.verification]++
return {
  results,
  telemetry: {
    events: telemetryEvents,
    summary: {
      attempts: telemetryEvents.length,
      retries: telemetryEvents.filter((event) => event.attempt > 1).length,
      tasksAttempted: attempted.length,
      firstAttemptSuccess,
      firstAttemptSuccessRate: attempted.length === 0 ? 0 : firstAttemptSuccess / attempted.length,
      limitExhaustions: results.filter((result) => result.limitExhausted).length,
      verification: verificationCounts,
    },
  },
}
```

Notes:
- **ONE build run per plan, waves inside it.** The coordinator makes a SINGLE Workflow call carrying every wave; the script runs them in order and reports each task as it lands. Waves are `bunx dobby build-plan`'s waves VERBATIM (area-disjoint, destructive tasks alone) — never re-cut, never merged.
- **The result** is `{ results, telemetry }`. `results` contains `{id, status, workLog, loops, retries, limitExhausted, verification, evidence?, reason?, blockedBy?}` once per planned task, in wave order. `status` is `done` (locally verified; PR review pending), `needs-human`, or `blocked`. `verification` is `mechanically-proven`, `model-judged`, or `not-available`. Blocked entries carry `blockedBy` and an EMPTY `workLog`. `telemetry.events` is one honest record per native agent call and `telemetry.summary` aggregates attempts, retries, first-attempt success, limit exhaustion, and verification source.
- **Runtime gaps are explicit.** This Workflow script has no run-id/usage/clock primitive and cannot observe an operator-level effective-model override. Each event therefore records the policy value as `requestedModel`, records effective `model`, `runId`, `provider`, `inputTokens`, `cachedInputTokens`, `outputTokens`, and `duration` as `unknown`, and never scrapes private transcript formats.
- **`log()` is the run's only live voice.** The main thread receives nothing until the run returns, so the script narrates a wave-opening line, one terminal line per task, one line per verify retry, a wave summary, and every subsequent milestone after a task's first verify failure.
- **Role instructions are NOT passed in `args`** — they live in the `dobby:test-author` / `dobby:implementor` / `dobby:verifier` definitions (plus `dobby:reviewer` for exceptional safety review). `args.workflowRecipe`, resolved by `dobby env --json`, carries requested model/effort, bounded limits, verification posture, and its integrity fingerprint. The remaining args are `waves` (or `tasks`), `devUrl`, REQUIRED boolean `hasTestSuite`, and REQUIRED absolute `workRoot`.
- **The test-author step is doubly gated.** `hasTestSuite` must be `true` AND the task must carry `testFirst: true`. A later test-author call additionally requires verifier `testFindings` and another full implement→verify slot. Do NOT force this step in a repo without a real suite.
- **Writer-result handling is fail-closed.** A valid writer result is either `{status:'completed', workLog:<non-empty>, blocker:''}` or `{status:'blocked', workLog:<non-empty>, blocker:<non-empty>}`. Blocked work stops `needs-human` without another writer. A null, malformed result, or empty `workLog` does not prove the tree is untouched, so the script spends one task-scoped reviewer call at stage `safety-review`, records it, and still returns `needs-human` whatever the verdict.
- **Verifier verdicts are fail-closed.** `done` requires `pass:true`, `failureKind:'none'`, non-empty evidence, mechanical/model-judged proof, and empty findings. Only coherent `code` or `test-contract` failures may dispatch a writer, and only before the final verifier slot. `environment`, `needs-human`, malformed failures, and incoherent passes stop without a writer.
- **Work log: the workflow does NOT write `STATE.md`** (workflows have no filesystem access). Each task result carries its accumulated `workLog`; the coordinator appends these to `STATE.md` serially after the workflow returns (single writer — no parallel-append race).
- The workflow is headless: no human QA, no interactive steps.
- **Pass `args` as an actual JSON object** in the Workflow call (the tool delivers it verbatim — do NOT `JSON.stringify` it). The script still parses defensively (`typeof args === 'string' ? JSON.parse(args) : args`) because the runtime may deliver it as a JSON string; without that guard, `args.waves` is `undefined` and the run throws on the first access.
- **Phases**: `meta` declares NO phases — it is a pure literal, so it could never name the waves it has not seen, and a phase declared but never entered renders as a dead "0 agents · Not started yet" row. Every group is opened at RUNTIME instead: each wave calls `phase('Wave n/m')` and that wave's agents are dispatched into it.
- **`workRoot` — the required nested-worktree cwd fix.** Workflow subagents inherit the *PROCESS* cwd = the MAIN checkout, NOT the session's logical worktree at `.claude/worktrees/<slug>/`. The coordinator computes `WORKROOT="$(git rev-parse --show-toplevel)"` once and passes it as `args.workRoot`; the script validates it, POSIX-shell-quotes it (including embedded apostrophes/spaces), and prepends the mandatory worktree preamble to every context. This keeps all active agents in the right tree without allowing the path to become shell syntax.
