# Shared sweep contract

This is the source of truth for any `/dobby:trim-context` sweep. A sweep reduces inference context cost; it is not a refactor, copy-edit pass, formatter, or behavior change. The coordinator delegates all filesystem work and never stages or commits, except the single narrow ledger-tracking exception in "Getting a new ledger tracked" below.

## Scope and eligible-text inventory

Before inferential inventory, `/dobby:trim-context` runs its packaged, read-only deterministic extractor `scripts/comment-inventory.mjs` against the Git workroot. It parses each tracked, supported file with a real, vendored Tree-sitter grammar and walks the resulting syntax tree for comment-kind nodes — never a text/regex heuristic — emitting stable JSON comment units with exact UTF-8 byte ranges, kinds, per-extension coverage, and totals. Its parser surface is TypeScript/MTS/CTS, TSX/JSX, JavaScript/MJS/CJS, SQL, CSS, HTML, and shell; the Tree-sitter runtime and every grammar `.wasm` are vendored under `scripts/vendor/` (provenance, exact versions, licenses, and SHA-256 per asset in `scripts/vendor/PROVENANCE.md`), never fetched at run time and never read from the skill's own `../cli` or a consumer's `node_modules`. The extractor makes no candidate/retain/disposition decision and is neither a CLI command nor a repository check/Gate. Its own known grammar-coverage gaps are reported alongside every run in the extractor's `knownLimitations` JSON field, keyed by extension.

Every tracked file outside that parser surface — Markdown, JSON, YAML, TOML, lockfiles, and every other extension not in the list above — reports `unsupported`. That is the extractor's normal, expected result for such a file, not a coverage gap: it carries no source comments for the extractor to find, and its prose or data is instead read in full by the researcher's inferential inventory below. A tracked, in-surface file that a real Tree-sitter grammar failed to parse (or that the extractor could not read at all, e.g. a path missing from the working tree) reports `parse-error` instead — that IS incomplete comment coverage.

**Known SQL coverage gap**: the vendored SQL grammar has no PostgreSQL Row-Level-Security or ACL DDL support — `CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, and `GRANT` do not parse. Tree-sitter's error recovery then marks the *whole containing file* as a parse error, so every comment in that file is skipped, not just comments near the unsupported statement — a single RLS policy or grant statement in an otherwise-ordinary migration file can zero out that file's comment coverage. This was evaluated against both the currently vendored grammar and `@derekstride/tree-sitter-sql@0.3.11` (its actively maintained successor, which as of 2026-08-12 still carries an explicit `// TODO: policy` and has no `GRANT` production at all); neither parses these statements, and no other verifiable, provenance-checkable Tree-sitter SQL grammar with real Postgres RLS/ACL support was found. A sweep over a Postgres/Supabase-heavy repository should expect a materially incomplete `.sql` inventory for this reason and report it as such, not as an anomaly.

`parsed` rows may feed comment inventory. Any `parse-error` row is incomplete coverage: report it and stop before final ledger creation or replacement. A later run may continue from a fresh full inventory; never imply that partial parser coverage certified a completed sweep. An `unsupported` row is not itself incomplete coverage (see above) — it still gets a disposition from the researcher's whole-workroot inferential inventory, which reads its full text rather than the mechanical extractor's per-comment view.

Resolve the Git workroot, then cover the **entire workroot**, not a requested subtree or the diff. Inventory tracked files at that root; do not cross into another repository, a submodule, `.git/`, ignored output, or untracked scratch files.

An eligible unit is human-authored guidance that an agent or maintainer may read:

- Markdown, text, RST, instruction files, READMEs, ADRs, and `CONTEXT.md` files.
- Comments in tracked source or configuration files, including block comments and doc comments.

Do not treat executable code, identifiers, string literals, user-visible copy, data, lockfiles, generated/minified/vendor files, licenses, or `.dobby/sweeps.json` as eligible text. A source file enters the inventory only for its comments; its logic is outside the sweep.

The researcher returns one exhaustive row per eligible unit, including: workroot-relative file path; unit kind (`document` or `comment`); cost tier; exact current byte count; candidate, retain, or defer disposition; and a short reason. A candidate names the exact redundant/stale/filler claim and what information remains. A retain names the invariant, rationale, external reference, or audience need that makes it load-bearing. Do not hide a low-value unit by omitting it.

## Cost tiers and approval batches

Tier context cost, not editorial attractiveness:

| Tier | Context exposure | Examples |
| --- | --- | --- |
| 1 | Loaded or consulted to direct agent behavior | Root instruction files, agent/skill instructions, project glossaries and policy documents |
| 2 | Repeatedly reached while working | `CONTEXT.md`, module guidance, operational docs, contributor documentation |
| 3 | Read only with a file or narrow task | General docs and source/configuration comments |

Make approval batches in tier order. A batch may combine only units with the same tier and similar preservation rule. It must list its complete, disjoint file set, unit-level proposed change or retain, before bytes, projected bytes removed, rough projected tokens (`bytes / 4`, labelled as an estimate), and every preservation constraint. No file may appear in two batches, even when it contains multiple eligible units.

Present all batches before writing. The human explicitly approves, rejects, or revises each batch. Rejection is an explicit retain and may be included in a completed manifest; a defer is unresolved and prevents completed-sweep finality. Material revision creates a new proposal that needs approval again. Silence, a general request to "clean it up", or approval of another batch is never approval to write.

## First full sweep and ledger selection

The tracked repository ledger is `.dobby/sweeps.json`. It is shared, per-file, per-skill state, not configuration: `/dobby:trim-context` and `/dobby:anti-slop` both read and write it, and each owns only its own named sub-entry inside every record — never the other's. `.dobby/` is gitignored by design, for local run state that has no general reason to be committed; the ledger is a deliberate, narrow exception to that rule, and getting it under tracking the first time takes an explicit action — normal commit flow never stages an ignored path on its own. See "Getting a new ledger tracked" below for that one-time step; workers themselves never stage or commit anything, at any point, including this file.

A valid ledger has exactly this semantic shape:

```json
{
  "schemaVersion": 1,
  "files": {
    "relative/path.md": {
      "trim-context": { "contentHash": "sha256:<64 lowercase hex characters>", "rulesVersion": "human-text-v1" },
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

When a path a skill previously covered no longer exists in the workroot, whichever skill's manifest writer notices first removes that path's entire `files` entry — both sub-keys together, not only its own — since neither skill's coverage of a nonexistent path is meaningful; this is cleanup, not certifying the other skill's coverage. A `files` entry left with only one sub-key removed for a path that is otherwise still present is not itself a problem — that is simply the normal state for a path only one skill has ever covered.

Use these states, evaluated against this skill's own sub-key wherever it appears:

| Ledger state (for this skill) | Required action |
| --- | --- |
| No `.dobby/sweeps.json` file on disk | Enter the **first full sweep**: inventory every eligible unit in the whole workroot and propose every candidate/retain decision. Do not call coverage complete or create a ledger until each unit is resolved. |
| File exists, but this skill has no sub-key in any `files` entry yet (its first run against a ledger the other skill created) | Enter the first full sweep for this skill alone; treat the other skill's sub-keys as already-covered and untouched. |
| This skill's sub-key present for a path, `rulesVersion` matches | Inventory all eligible units; only paths whose sub-key for this skill is missing or whose current bytes do not match the stored `contentHash` require a new decision. Still report unchanged sub-key entries as already covered. |
| This skill's sub-key present for a path, `rulesVersion` differs | Run the same whole-workroot first full sweep for this skill; a prior rule set cannot certify this one. |
| Ledger container malformed: invalid JSON, unrecognized top-level key, unknown `schemaVersion`, `files` not an object, or an invalid path key | Fail closed for **both** skills: report the ledger defect and stop before dispatching any writer. Do not replace, repair, or infer from it — the container is shared and cannot be trusted in half. |
| This skill's own sub-key malformed: invalid `contentHash` format, or missing/invalid `rulesVersion`, wherever it appears for this skill | Fail closed for **this skill only**: report the defect and stop before dispatching any writer for this skill. A malformed sub-key filed under the other skill's name is that skill's problem to surface, not evidence of corruption here. |

A completed first full sweep has an approved trim or explicit-retain decision for every eligible unit. If any unit is deferred, or an approved batch cannot finish, report incomplete coverage and leave this skill's sub-keys untouched. A later run starts the first full sweep again. This deliberate repetition is safer than certifying a partial baseline.

### Getting a new ledger tracked

Whether `git add -f` is needed depends on whether the path is **tracked by Git**, never on whether the file merely **exists on disk**. A file can exist untracked: `.dobby/` is ignored, so an earlier run that wrote `.dobby/sweeps.json` and then failed its independent review (or was interrupted before the coordinator's force-add) leaves the file sitting on disk, unstaged and untracked, for the next run to find. Treating that on-disk presence as proof of tracking would let the force-add be skipped forever, stranding the ledger outside Git indefinitely. Determine trackedness with a Git query against the path itself (e.g. `git ls-files --error-unmatch -- .dobby/sweeps.json`), not a file-existence check.

If `.dobby/sweeps.json` is **not tracked by Git** — whether no run has ever written it, or an earlier run wrote it but never got it staged — this run's first full sweep (or the sweep that finally completes it) and every approved batch end with a file Git still does not track. After the independent reviewer described in "Writers, reviewers, and final bytes" below validates that file's schema and this skill's own sub-keys and hashes, the **coordinator — never a worker —** runs `git add -f -- .dobby/sweeps.json` exactly once, immediately after that validation, to bring the path under tracking despite the ignore rule. This is the coordinator's one narrow, approved exception to never staging or committing; it applies only when the path was not already tracked, only once per untracked-to-tracked transition, and only after independent review has passed.

If `.dobby/sweeps.json` is **already tracked by Git** — because an earlier run of this skill or the other sweep skill got it tracked — it is an ordinary tracked path: this skill's reviewed updates to its own sub-keys need no `-f` and are picked up by whatever normal commit flow runs afterward, the same as any other tracked file the sweep changed.

## Preservation rules

Keep meaning, behavior, and operational safety intact. A trim may remove duplicate explanation, stale repetition already established by a durable source, or conversational filler. It may condense wording only when the surviving text still tells a reader the same action, boundary, and reason. Never invent an inference to replace missing evidence.

### Comments are trim-owned

`/dobby:trim-context` is the only workflow that edits comments. Its implementors may change only approved comment units and no executable text in those files. Preserve comments that carry a license/copyright, lint/type/tool directive, security or safety warning, public API contract, compatibility/workaround reason, TODO/FIXME ownership, non-obvious invariant, external citation, or a fact not evident from the adjacent code. When in doubt, retain the comment.

Do not send a comment-bearing file to any unrelated writer during the sweep. If another task needs a comment change, stop and defer it to this workflow rather than overlapping ownership.

### `CONTEXT.md` is a contract, not padding

Treat every `CONTEXT.md` as a compact interface document. Preserve its title, purpose, Files, Interface, Invariants, and What's intentionally NOT here sections when present, plus the root glossary and any recorded decision. Do not remove a domain term, public surface, invariant, or intentional deferral merely because code appears to imply it. Its Files section must still describe the actual current file surface; the sweep cannot invent a change to make that true. Keep the headings and condense only redundant prose within their existing meaning.

## Writers, reviewers, and final bytes

After approval, assign one `dobby:implementor` per batch (or per non-overlapping subset). Every brief includes its exact file set, approved units, preservation constraints, and the prohibition on staging, committing, touching other files, or writing the ledger. Writers return the standard structured envelope and record final paths plus before/after bytes.

A `dobby:reviewer` who authored none of those files independently reviews each complete batch. It reads final file bytes and the approval, checks that only permitted human text changed, preservation rules held, and the reported saving is honest. A review finding returns only to the implementing owner; the corrected file set gets another independent review. Do not substitute an implementor's self-check, a diff skim, or the coordinator's judgment for this review.

After every approved batch passes, assign a separate implementor to build the manifest from the reviewed final bytes, writing only this skill's own sub-key (and, for `anti-slop`, its own `metrics` sub-key) inside the shared `.dobby/sweeps.json`; every other skill's existing entries pass through byte-for-byte untouched. It records all resolved eligible files under this skill's sub-key: changed, explicit-retain, and previously covered unchanged files that remain in scope. It omits deferred files. A different reviewer validates the ledger's top-level schema, this skill's own `rulesVersion`, sorted paths and sub-keys, and every final-byte hash under this skill's sub-key before ledger finality — and confirms no other skill's sub-key changed. This writer also never stages or commits — when `.dobby/sweeps.json` is not yet tracked by Git, getting it staged is the coordinator's job, per "Getting a new ledger tracked" above, not this writer's.

## Partial, blocked, and error outcomes

Treat a blocked/malformed writer or reviewer result, an out-of-scope edit, a hash mismatch, unresolved review finding, or interrupted batch as incomplete:

1. Stop dispatching later writes and do not auto-revert any bytes already written.
2. Preserve the prior ledger unchanged; do not write a partial manifest or mark changed files covered.
3. Report each changed, unreviewed, reviewed, rejected, and unstarted unit with its owner/result and the exact blocker.
4. Ask the human whether to repair through the responsible worker or leave the sweep incomplete. A resumed sweep re-inventories final bytes and re-approves any changed proposal.

A manifest writer or manifest reviewer failure follows the same rule: no new ledger finality for this skill's sub-keys; the other skill's existing entries are unaffected either way. A missing `.dobby/sweeps.json` file is not an error; it is the first-full-sweep case above. When the path was not already tracked by Git, a failed manifest write or review also means the coordinator never runs the one-time `git add -f`: without independent review passing, the path stays untracked for the next run to re-check — even if the failed write left a file sitting on disk. When the path was already tracked by Git (by the other skill or an earlier successful run), a failed write or review only leaves this skill's own sub-keys unfinalized — the path's tracking status is unaffected.

## Savings report

Finish with a compact, auditable report. Separate projected from actual savings and include, by tier and total:

- eligible files/units, changed files/units, and explicit retains/deferred/rejected counts;
- before and final eligible-text bytes, bytes removed, and estimated tokens removed (`bytes / 4`);
- comment and `CONTEXT.md` files changed, with retained safety/contract reasons;
- this skill's own sub-key ledger state before/after, its `rulesVersion`, and whether its coverage is complete; and
- every blocker, partial write, or unit deliberately left outside the manifest.

Never present a partial sweep as a completed saving or a final ledger.
