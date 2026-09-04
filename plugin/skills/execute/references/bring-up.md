# Bring-up — the two-step `up` protocol

This file (`references/bring-up.md`, cited elsewhere as `../execute/references/bring-up.md`) is the shared reference every lifecycle-consuming skill and agent points to. Since `up` stopped starting anything itself, bringing a worktree's app up is a
protocol the MODEL carries out, not a single command. `dobby up` prepares
the workspace and probes it; it never spawns the run.

## The two-step protocol

**Step 1 — run `bunx dobby up --json` from the worktree root.**

- **`ok: false`** — the failure gate. STOP and report `reason` (the closed
  enum: `not-a-git-repo` · `config-unreadable` · `install-failed` ·
  `worktree-copy-failed` · `setup-extra-failed` · `neon-creds-missing` ·
  `neon-branch-failed` · `liveness-timeout`) with the human message on stderr.
  Nothing here is worth retrying blindly — the sole exception is
  `degradedCommand`, offered only for an install-phase failure, which re-runs
  `up` with the documented skip seam.
- **`ok: true`** — read `instructions[]` next.

**Step 2 — carry out `instructions[]`, in order, as the model.** Each entry is
`{topic, applies: true, text}`; only applicable ones are present, and they are
always ordered `rename` (cmux only) then `start` (the devUrl isn't live yet).
An `Instruction` in the payload is not a failure — it is dobby handing you the
one thing it cannot do on your behalf.

- **`rename`** — one cmux command. Run it and move on.
- **`start`** — the `text` says exactly how: a cmux pane `send`, or the host's
  `Bash` tool with `run_in_background`. Read the command's OWN early output
  before doing anything else — a start that fails shows its error right there
  (a missing bin, a port conflict, a crash on boot). That early read is why
  there is no `dev-start-failed` in the reason enum any more: a failed start
  is something the model observes directly, not something `up` reports for
  you.

**Step 3 — run `bunx dobby up --json` again.** It probes once more, this time
finds the start you just registered in flight, and waits out the liveness
loop instead of handing back another instruction. A second call that returns
`ok: true` with `live: true` means the app answered — proceed with `devUrl`.

**Step 4 — the stop rule.** If the SECOND `up` still returns a non-empty
`start` instruction, the process you started never registered (`bunx dobby
dev` registers itself on startup — see `pidfile.ts`). STOP and report to the
user what the start command printed. Never start a second server on the
strength of a repeated instruction: `dobby dev` refuses a live twin anyway, so
firing the start command again either does nothing or collides.

If the second `up` instead returns `ok: false` with `reason: "liveness-timeout"`,
that is the DIFFERENT failure — the process registered but never answered the
devUrl (check the portless daemon / `portless trust`) — not the stop rule
above.

**`live: false` with an empty `instructions[]` is a no-app project**
(`phase: "noop"`) — a library, CLI, or plugin with nothing to serve. That is a
clean success, not a failure: every field a caller then reads — `devUrl`,
`verifyMode`, `workroot`, `browserPane` — is unchanged from before this
protocol existed.

## Opening the verification surface

`up` no longer opens a browser surface itself. Whoever needs one — the
manual-setup gate, QA — runs `bunx dobby instructions browser --json` and
follows its `text`. Under cmux that reuses or opens the `dobby-browser-<slug>`
pane at the devUrl; on Claude Desktop / t3 code it drives their own MCP
browser tools; otherwise it drives claude-in-chrome, falling back to a
curl-only check when no browser is reachable.

## Tearing down

Run `bunx dobby down --json`. Its mechanics already ran — the pidfile kill,
the Neon branch delete, the `teardown[]` extras — by the time it returns; the
only thing left for the model is `instructions[]` (the `stop` topic, present
only when a kit pane was discovered). Carry each one out yourself, in order,
the same as `up`'s `start`/`rename`.
