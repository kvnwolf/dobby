# Shared sweep contract

This is the source of truth for any `/dobby:trim-context` sweep. A sweep reduces inference context cost; it is not a refactor, copy-edit pass, formatter, or behavior change. The coordinator delegates all filesystem work and never stages, commits, or writes the ledger, except the single narrow ledger exception this contract carries in two parts, always together: promoting each checkpoint's independently reviewed `.dobby/sweeps.json.pending` onto the canonical `.dobby/sweeps.json` (see "Writers, reviewers, and final bytes" below) and, only after the first such promotion, the resulting one-time `git add -f` (see "Getting a new ledger tracked" below).

## Scope and eligible-text inventory

Before inferential inventory, `/dobby:trim-context` runs its packaged, read-only deterministic extractor `scripts/comment-inventory.mjs` against the Git workroot. It parses each tracked, supported file with a real, vendored Tree-sitter grammar and walks the resulting syntax tree for comment-kind nodes — never a text/regex heuristic — emitting stable JSON comment units with exact UTF-8 byte ranges, kinds, per-extension coverage, and totals. Its parser surface is TypeScript/MTS/CTS, TSX/JSX, JavaScript/MJS/CJS, SQL, CSS, HTML, and shell; the Tree-sitter runtime and every grammar `.wasm` are vendored under `scripts/vendor/` (provenance, exact versions, licenses, and SHA-256 per asset in `scripts/vendor/PROVENANCE.md`), never fetched at run time and never read from the skill's own `../cli` or a consumer's `node_modules`. The extractor makes no candidate/retain/disposition decision and is neither a CLI command nor a repository check/Gate. Its own known grammar-coverage gaps are reported alongside every run in the extractor's `knownLimitations` JSON field, keyed by extension.

Every tracked file outside that parser surface — Markdown, JSON, YAML, TOML, lockfiles, and every other extension not in the list above — reports `unsupported`. That is the extractor's normal, expected result for such a file, not a coverage gap: it carries no source comments for the extractor to find, and its prose or data is instead read in full by the researcher's inferential inventory below. A tracked, in-surface file that a real Tree-sitter grammar failed to parse (or that the extractor could not read at all, e.g. a path missing from the working tree) reports `parse-error` instead — that IS incomplete comment coverage.

**Known SQL coverage gap**: the vendored SQL grammar has no PostgreSQL Row-Level-Security or ACL DDL support — `CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, and `GRANT` do not parse. Tree-sitter's error recovery then marks the *whole containing file* as a parse error, so every comment in that file is skipped, not just comments near the unsupported statement — a single RLS policy or grant statement in an otherwise-ordinary migration file can zero out that file's comment coverage. This was evaluated against both the currently vendored grammar and `@derekstride/tree-sitter-sql@0.3.11` (its actively maintained successor, which as of 2026-08-12 still carries an explicit `// TODO: policy` and has no `GRANT` production at all); neither parses these statements, and no other verifiable, provenance-checkable Tree-sitter SQL grammar with real Postgres RLS/ACL support was found. A sweep over a Postgres/Supabase-heavy repository should expect a materially incomplete `.sql` inventory for this reason and report it as such, not as an anomaly.

`parsed` rows feed comment inventory. A `parse-error` row is incomplete coverage for that file alone — report it and name it in the savings report — but it no longer voids ledger finality for the rest of the workroot. A run against a Postgres/Supabase-heavy repository can hit dozens of RLS/ACL parse errors this way (a field sweep hit 43 `.sql` files) while resolving hundreds of other files cleanly; the ledger records what was resolved and simply leaves the parse-error files uncovered, not the whole sweep. A later run may re-attempt any `parse-error` path from a fresh inventory. An `unsupported` row is not itself incomplete coverage (see above) — it still gets a disposition from the researcher's whole-workroot inferential inventory, which reads its full text rather than the mechanical extractor's per-comment view.

Resolve the Git workroot, then cover the **entire workroot**, not a requested subtree or the diff. Inventory tracked files at that root; do not cross into another repository, a submodule, `.git/`, ignored output, or untracked scratch files.

An eligible unit is human-authored guidance that an agent or maintainer may read:

- Markdown, text, RST, instruction files, READMEs, ADRs, and `CONTEXT.md` files.
- Comments in tracked source or configuration files, including block comments and doc comments.

Do not treat executable code, identifiers, string literals, user-visible copy, data, lockfiles, generated/minified/vendor files, licenses, or `.dobby/sweeps.json` as eligible text. A source file enters the inventory only for its comments; its logic is outside the sweep.

The researcher returns one row per FILE, not per unit: workroot-relative path, tier, current eligible-text bytes, expected disposition, and any known lever. Per-unit decisions are made inside the lot by the implementor, under the preservation rules below — not enumerated up front. A one-row-per-unit inventory does not scale: a 24,113-comment repository would spend its entire budget writing rows before a single judgment is made. For comment-track files, the extractor's per-file comment-byte totals are the ranking input: group by file/module and order lots by weight (post-process the extractor's JSON with `jq`/`awk` to rank modules). Do not hide a low-value file by omitting it — a file whose units are all retain is still reported, as a retain row with its reason.

## Cost tiers, lot sizing, and tracks

Tier context cost, not editorial attractiveness:

| Tier | Context exposure | Examples |
| --- | --- | --- |
| 1 | Loaded or consulted to direct agent behavior | Root instruction files, agent/skill instructions, project glossaries and policy documents |
| 2 | Repeatedly reached while working | `CONTEXT.md`, module guidance, operational docs, contributor documentation |
| 3 | Read only with a file or narrow task | General docs and source/configuration comments |

A lot is **6-8 files chosen by weight** — not a whole tier, not one file at a time. A 47-file lot calibration exhausted one implementor after 13 of 47 files, 430K tokens, and 257 tool calls; 6-8 files is the size a real sweep could carry all the way to a finished, reviewed state. Lot size is a per-lot WORK cap; how many lots run concurrently is the architect's own judgment call, separate from how large any one lot is.

An implementor brief is EITHER comment-trim OR prose densification, never both. A worker briefed for one track that also reworks the other is out of scope even when the diff nets negative bytes — a field lot briefed to trim comments instead reformatted a `CONTEXT.md` into bullets for a net −186 bytes. The two tracks also carry different expected yields; see "Levers and rate calibration" below.

A lot combines only files of the same tier and the same track. It lists its complete, disjoint file set, before bytes, projected bytes removed, rough projected tokens (`bytes / 4`, labelled as an estimate), and every preservation constraint. No file may appear in two lots.

## Policy approval

Approval happens once, up front, at the level of **scope and aggressiveness** — which tracks run, how aggressive the trim is, and what is explicitly excluded — not per lot; a repository that produces lots by the hundred can never clear a per-lot gate. Lots then run without individual pre-write approval. Return to the human only when: the policy changes (redirecting budget between tracks, changing aggressiveness), a lot proposes something outside the approved scope, or the sweep reaches a blocked/partial outcome (see "Partial, blocked, and error outcomes" below). Silence, a general request to "clean it up", or approval of an unrelated policy question is never approval to write. An explicit rejection is an explicit retain; a defer is unresolved.

## First full sweep and ledger selection

The tracked repository ledger is `.dobby/sweeps.json`. It is shared, per-file, per-skill state, not configuration: `/dobby:trim-context` and `/dobby:anti-slop` both read and write it, and each owns only its own named sub-entry inside every record — never the other's. `.dobby/` is gitignored by design, for local run state that has no general reason to be committed; the ledger is a deliberate, narrow exception to that rule, and getting it under tracking the first time takes an explicit action — normal commit flow never stages an ignored path on its own. See "Getting a new ledger tracked" below for that one-time step; workers themselves never stage or commit anything, at any point, including this file.

A valid ledger has exactly this semantic shape:

```json
{
  "schemaVersion": 1,
  "files": {
    "relative/path.md": {
      "trim-context": { "contentHash": "sha256:<64 lowercase hex characters>", "rulesVersion": "human-text-v2" },
      "anti-slop": { "contentHash": "sha256:<64 lowercase hex characters>", "rulesVersion": "contextual-slop-v1" }
    }
  },
  "metrics": {
    "anti-slop": {
      "byPatternCategory": {
        "category-name": { "findings": 0, "changed": 0, "retained": 0 }
      }
    }
  }
}
```

`schemaVersion` is the ledger container's own version, shared by both skills. `files` maps a workroot-relative path to an object keyed by skill name (`trim-context`, `anti-slop`); a path's entry may hold either skill's sub-key, both, or neither yet, and each sub-key is independent of its sibling. `metrics` is an optional top-level container, also keyed by skill name, for whatever aggregate data a skill defines for itself — today only `anti-slop` uses it. `schemaVersion`, `files`, and `metrics` are the ledger's only top-level keys; any other top-level key is a schema violation (see the fail-closed row below).

Each skill reads and writes only the sub-key matching its own name, inside every `files["<path>"]` entry and inside `metrics`. It never inspects, repairs, certifies, or treats as corruption the shape or presence of another skill's sub-key — a sibling key is expected, not a schema violation, and plays no part in this skill's own coverage decisions. `rulesVersion` lives inside each skill's own sub-entry and describes that skill's eligibility/preservation rules, independent of the other skill, the plugin, or the top-level `schemaVersion`. Keep `files` keys, each file's skill sub-keys, and `metrics` skill sub-keys lexically sorted. Each `contentHash` is the SHA-256 of the file's exact final bytes, not normalized text, a diff, or a pre-write hash. The ledger does not hash itself.

When a path a skill previously covered no longer exists in the workroot, whichever skill's ledger writer notices first removes that path's entire `files` entry — both sub-keys together, not only its own — since neither skill's coverage of a nonexistent path is meaningful; this is cleanup, not certifying the other skill's coverage. A `files` entry left with only one sub-key removed for a path that is otherwise still present is not itself a problem — that is simply the normal state for a path only one skill has ever covered.

Use these states, evaluated against this skill's own sub-key wherever it appears:

| Ledger state (for this skill) | Required action |
| --- | --- |
| No `.dobby/sweeps.json` file on disk | Enter the **first full sweep**: inventory the whole workroot and lot eligible files by weight. Write this skill's sub-key for every file this run resolves — changed or explicit-retain. A file not reached this run gets no sub-key; the ledger is promoted incrementally as lots pass review, never blocked waiting for every eligible file to resolve. |
| File exists, but this skill has no sub-key in any `files` entry yet (its first run against a ledger the other skill created) | Enter the first full sweep for this skill alone, same incremental rule; treat the other skill's sub-keys as already-covered and untouched. |
| This skill's sub-key present for a path, `rulesVersion` matches | Inventory all eligible files; only paths whose sub-key for this skill is missing or whose current bytes do not match the stored `contentHash` require a new decision. Still report unchanged sub-key entries as already covered. |
| This skill's sub-key present for a path, `rulesVersion` differs | Run the same whole-workroot first full sweep for this skill; a prior rule set cannot certify this one. |
| Ledger container malformed: invalid JSON, unrecognized top-level key, unknown `schemaVersion`, `files` not an object, or an invalid path key | Fail closed for **both** skills: report the ledger defect and stop before dispatching any writer. Do not replace, repair, or infer from it — the container is shared and cannot be trusted in half. |
| This skill's own sub-key malformed: invalid `contentHash` format, or missing/invalid `rulesVersion`, wherever it appears for this skill | Fail closed for **this skill only**: report the defect and stop before dispatching any writer for this skill. A malformed sub-key filed under the other skill's name is that skill's problem to surface, not evidence of corruption here. |

The ledger records exactly what this run actually swept and independently reviewed. A resolved file — changed by an approved lot, or explicit-retain — gets this skill's sub-key written into the canonical ledger only once that lot's checkpoint increment has been independently reviewed and the coordinator has promoted it, from reviewed final bytes. A file this run did not reach — parse-error, deferred, blocked, or simply out of this run's budget — gets no sub-key and no coverage claim; the absent-sub-key semantics above already cover it, so no schema change is needed. The savings report (below) names every unresolved file and its reason. The ledger never claims coverage it does not have. This is deliberate: a sweep is incremental by design, and later runs pick up wherever the last run's sub-keys stop, per the table above.

### Getting a new ledger tracked

Whether `git add -f` is needed depends on whether the path is **tracked by Git**, never on whether the file merely **exists on disk**. A file can exist untracked: `.dobby/` is ignored, so an earlier run whose first checkpoint was promoted but interrupted before the coordinator's force-add leaves `.dobby/sweeps.json` sitting on disk, unstaged and untracked, for the next run to find. Treating that on-disk presence as proof of tracking would let the force-add be skipped forever, stranding the ledger outside Git indefinitely. Determine trackedness with a Git query against the path itself (e.g. `git ls-files --error-unmatch -- .dobby/sweeps.json`), not a file-existence check.

If `.dobby/sweeps.json` is **not tracked by Git** — whether no run has ever written it, or an earlier run promoted it but never got it staged — the first checkpoint this run promotes (see "Writers, reviewers, and final bytes" below) leaves a file Git still does not track. Once the independent reviewer has validated that checkpoint's staging file and the **coordinator — never a worker —** has promoted it over the canonical file, the coordinator runs `git add -f -- .dobby/sweeps.json` exactly once, immediately after that promotion, to bring the path under tracking despite the ignore rule. Promotion and this force-add are the coordinator's one narrow, approved exception to never staging, committing, or writing the ledger — both are deterministic bookkeeping over already-reviewed bytes, never authorship — and they fire in that order: promotion only after independent review of the staging file passes, and the force-add only once, immediately after the FIRST promotion, only when the path was not already tracked. Every checkpoint after that first one promotes onto an already-tracked path and needs no further `git add -f`.

If `.dobby/sweeps.json` is **already tracked by Git** — because an earlier run, an earlier checkpoint in this run, or the other sweep skill got it tracked — it is an ordinary tracked path: the coordinator's reviewed promotions of this skill's own sub-keys need no `-f` and are picked up by whatever normal commit flow runs afterward, the same as any other tracked file the sweep changed.

## Preservation rules

Keep meaning, behavior, and operational safety intact. A trim may remove duplicate explanation, stale repetition already established by a durable source, or conversational filler. It may condense wording only when the surviving text still tells a reader the same action, boundary, and reason. Never invent an inference to replace missing evidence.

### Comments are trim-owned

`/dobby:trim-context` is the only workflow that edits comments. Its implementors may change only approved comment units and no executable text in those files. Preserve comments that carry a license/copyright, lint/type/tool directive, security or safety warning, public API contract, compatibility/workaround reason, TODO/FIXME ownership, non-obvious invariant, external citation, or a fact not evident from the adjacent code. When in doubt, retain the comment.

Do not send a comment-bearing file to any unrelated writer during the sweep. If another task needs a comment change, stop and defer it to this workflow rather than overlapping ownership.

Two traps force an out-of-bounds change to executable code to fix — retain the comment instead of triggering either: deleting a JSX comment can collapse a fragment and trip `noUselessFragment`; deleting the sole comment inside an otherwise-empty block trips `noEmptyBlockStatements`. Also do not replace content with a cross-pointer (e.g. "see Interface") when the detail lives only in the section being cut — that moves the loss, it does not remove it.

### `CONTEXT.md` is a contract, not padding

Treat every `CONTEXT.md` as a compact interface document. Preserve its title, purpose, Files, Interface, Invariants, and What's intentionally NOT here sections when present, plus the root glossary and any recorded decision. Do not remove a domain term, public surface, invariant, or intentional deferral merely because code appears to imply it. Its Files section must still describe the actual current file surface; the sweep cannot invent a change to make that true. Keep the headings and condense only redundant prose within their existing meaning.

## Levers and rate calibration

Every lot returns the reusable levers it discovered — a preservation shortcut or a load-bearing structural pattern that will recur in other files of the same track — and the coordinator injects them into subsequent briefs. Field example: a `CONTEXT.md`'s `## Files` section that merely restates `## Interface` and `## Invariants` is redundant repetition already covered under "Preservation rules" above; once that lever was carried forward it produced a consistent ~-12% lot after lot.

Every brief states the expected yield: roughly **5% on code comments, 12-14% on prose**. State explicitly that leaving a file untouched because everything in it is load-bearing is a CORRECT outcome — this exists to stop agents inflating cuts to look productive. Outliers exist and must not re-calibrate expectations: one route directory yielded −31,900 bytes from inline label-comments while the repository's real comment rate outside it was ~5%.

## Writers, reviewers, and final bytes

After policy approval, assign one `dobby:implementor` per lot. Every brief includes its exact file set, track (comment or prose, never mixed), tier, preservation constraints, expected yield and the "untouched is correct" note (see "Levers and rate calibration" above), any levers carried forward from prior lots, and the prohibition on staging, committing, touching other files, or writing the ledger. Every brief requires the file-editing tools for every edit — never a shell heredoc or a compound shell pipeline; the permission guard in isolated worktrees rejects both, and a worker forced to route around that rejection mid-run is a known stall cause. Writers return the standard structured envelope and record final paths plus before/after bytes.

Verify the hard invariant — **zero executable lines changed** — mechanically, per lot, before any human-judgment review: a filtered diff must come back empty, e.g. `git diff -U0 -- '<lot's file set>' | grep -E '^[+-]' | grep -vE '<comment-syntax patterns for the files in scope>'`. This is cheap, deterministic, and caught every violation in the field session that used it.

Reserve the independent `dobby:reviewer` for what a diff cannot decide: whether surviving text still carries the same action, boundary, and reason, and whether every removed comment was safe to lose under the preservation rules. Every lot gets this review, comment or prose — the mechanical check proves only that no executable line changed, and deleting a load-bearing comment (a lint/type/tool directive, a licence/copyright header, a security or safety warning, a public API contract, a compatibility/workaround reason, a TODO/FIXME owner, or a non-obvious invariant) changes no executable line either, so a clean mechanical check alone never proves a deletion was safe. Point the reviewer at the diff's deleted lines for lint/type/tool directives (`biome-ignore`, `eslint-disable`, `@ts-expect-error`), `SPDX`/`Copyright`, security or safety wording, `TODO`/`FIXME`, and external citations — a targeting aid, not a completeness proof: a removed comment carrying a non-obvious invariant or a fact not evident from adjacent code has no syntactic marker, which is exactly why this review is mandatory rather than conditional. The reviewer must have authored none of the reviewed files. A review finding returns only to the implementing owner; the corrected file set gets another independent review (and, if bytes changed, a fresh mechanical check). Do not substitute an implementor's self-check, a diff skim, or the coordinator's judgment for either check.

Once a lot passes both checks, checkpoint it before moving to the next lot's checkpoint. A separate implementor stages the increment: it writes that lot's resolved sub-keys — changed and explicit-retain files only, from that lot's reviewed final bytes — added to this skill's own sub-key (and, for `anti-slop`, its own `metrics` sub-key), to a **staging path, `.dobby/sweeps.json.pending`, never to the canonical `.dobby/sweeps.json`**. It builds that staging file as the full ledger the canonical file would become, always from the canonical ledger itself: the current canonical content plus this lot's resolved sub-keys, with every other skill's existing entries and every earlier lot's already-written sub-keys passed through byte-for-byte untouched. It overwrites any existing `.dobby/sweeps.json.pending` outright — it never reads, merges with, or appends to one, since a leftover staging file from an interrupted checkpoint carries no authority and is not an input. This writer never stages, commits, or touches the canonical file.

A different reviewer, briefed with that lot's exact, workroot-relative file set, then validates the **staging file alone** — never the canonical file — checking the ledger's top-level schema, this skill's own `rulesVersion`, sorted paths and sub-keys, every final-byte hash the increment adds against that lot's actual final bytes on disk, that the increment's added paths match the lot's file set exactly (no path missing, no extra path, none belonging to another lot), and that no other skill's sub-key and no earlier lot's sub-key changed. The file-set check is what makes a stale or misdirected staging file fail rather than pass: its paths cannot match the current lot's expected set. A mismatch fails the checkpoint and the coordinator promotes nothing.

Only once that review passes does the **coordinator — never a worker —** promote the staging file: a mechanical move of `.dobby/sweeps.json.pending` onto `.dobby/sweeps.json`. This is deterministic bookkeeping over already-reviewed bytes, not authorship, and is the same narrow coordinator-owned exception to never staging, committing, or writing the ledger that also covers the one-time `git add -f` (see "Getting a new ledger tracked" above): promotion runs first, and the force-add — only when the path was not already tracked, only once, immediately after the FIRST promotion — runs after it.

`.dobby/` is gitignored and only `.dobby/sweeps.json` itself is ever force-added, so `.dobby/sweeps.json.pending` is never committed. A failed or interrupted checkpoint leaves at most a stale pending file; the next checkpoint attempt simply overwrites it. This is why no pending state in the schema and no cleanup ceremony are needed — the canonical ledger only ever holds promoted, reviewed bytes.

A lot this run does not reach or resolve — parse-error, deferred, blocked, or out of budget — gets no staged increment, no promotion, and no sub-key; it is named in the savings report instead and never unwrites an earlier lot's already-promoted checkpoint. This costs one writer, one reviewer, and one coordinator promotion per lot instead of one pair per run — deliberately: the increment is small next to a lot, and buys durable progress, so coverage a checkpoint has staged, reviewed, and promoted survives a later blocked lot or an interruption; only the unpromoted work is lost. Each checkpoint writer/reviewer pair runs in the same judgment-sized sequential batches as lot writers and reviewers, like any other Agent dispatch; the coordinator's promotion and any force-add are mechanical bookkeeping, not Agent dispatches.

## Partial, blocked, and error outcomes

Treat a blocked/malformed writer or reviewer result, an out-of-scope edit, a hash mismatch, or an unresolved review finding as incomplete for the lot it touches:

1. Stop dispatching further writes into that lot's files; do not auto-revert any bytes already written. A blocked lot does not retroactively unwrite an earlier lot's checkpoint — every checkpoint already reviewed and promoted stands.
2. A blocked or unresolved lot never reaches a promoted checkpoint: it gets no sub-key, not a partial or dishonest one, and is named in the savings report instead. This costs only that lot's coverage — every earlier lot's checkpoint, already reviewed and promoted, is unaffected.
3. Report each changed, unreviewed, reviewed, rejected, and unstarted unit with its owner/result and the exact blocker.
4. Ask the human whether to repair the blocked lot through the responsible worker or leave those files unresolved for a later run. A resumed run re-inventories final bytes for any changed proposal it re-attempts.

A checkpoint writer or checkpoint reviewer failure follows the same rule: the lot's proposed sub-keys are never promoted — the canonical `.dobby/sweeps.json` is untouched, the lot's files stay unresolved, and they are named in the savings report — but every prior lot's already-promoted checkpoint stands regardless, and so does the other skill's existing entries. A failed write or review leaves at most a stale `.dobby/sweeps.json.pending`; since `.dobby/` is gitignored and only `.dobby/sweeps.json` itself is ever force-added, that stale staging file is never committed, and the next checkpoint attempt simply overwrites it — no cleanup step is required. A missing `.dobby/sweeps.json` file is not an error; it is the first-full-sweep case above. When the path was not already tracked by Git, a failed first checkpoint's write or review also means the coordinator never promotes and never runs the one-time `git add -f`: without that checkpoint's independent review passing and the coordinator's promotion, the path stays untracked for the next run to re-check, regardless of any stale `.pending` file left on disk. When the path was already tracked by Git (by the other skill, an earlier run, or an earlier checkpoint in this run), a failed checkpoint only leaves that lot's own sub-keys unpromoted — the path's tracking status is unaffected.

## Savings report

Finish with a compact, auditable report. Separate projected from actual savings and include, by tier and total:

- eligible files, changed files, and explicit retains/deferred/rejected counts;
- before and final eligible-text bytes, bytes removed, and estimated tokens removed (`bytes / 4`);
- comment and `CONTEXT.md` files changed, with retained safety/contract reasons;
- this skill's own sub-key ledger state before/after and its `rulesVersion`; and
- every unresolved file by name and reason — parse-error, deferred, blocked, or out of this run's budget. Never omit a name to make coverage look further along than it is.

Never present a partial sweep as a completed saving or a final ledger.
