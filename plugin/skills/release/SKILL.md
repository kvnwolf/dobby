---
name: release
description: Cuts ONE release of the project via the config-driven `dobby release` command — npm or homebrew-cask, per `dobby.config.json`'s `release` key.
disable-model-invocation: true
argument-hint: "[patch|minor|major]"
---

# Release

`bunx dobby release` owns every mechanic: the preflights, the version arithmetic, the manifest bump, the gate over the bumped tree, the pack gate, the publish, the tag, the push, the GitHub release, the target's own work (a Homebrew tap), the smoke, and the rollback when something goes wrong before the publish. **Never do any of it by hand** — no editing a `version` field, no `npm publish`, no `git tag`, no `gh release create`. Every rule those steps carry was paid for by a release that went wrong, and they now live in the command.

This skill owns exactly **two judgments**, and the command STOPS for each of them:

1. the two version questions a machine must not answer alone (`needsDecision`), and
2. the **release notes** (`needsNotes`) — the reason this is a skill and not a cron job.

**Releases run from the MAIN checkout only.** The CLI refuses a linked worktree, and the reason is dobby's own ADR-0008: a worktree is an in-review branch, a publish is irreversible per version, and a release cut there would tag and push the goal's branch instead of the trunk. If the session is inside a worktree, `cd` to the main checkout and run from there.

## Prerequisites (one-time, per project)

The `release` key in `dobby.config.json` is what makes the command exist at all — nothing in a repo infers a release target. `type` is required; the rest is the per-channel non-inferable:

| Target | Config | Machine setup |
|--------|--------|---------------|
| `"npm"` | `dir` (the publishable package dir, when it is not the repo root) · `lockstep` (other version-carrying manifests, moved together) · `surfaces` (display name → glob, for changelog grouping) · `smoke` (an argv **array** proving the published artifact installs) | a **granular access token with write access** in `~/.npmrc` (npmjs.com → Access Tokens → Granular) |
| `"homebrew-cask"` | `tap` (the tap REPOSITORY, e.g. `kvnwolf/homebrew-tap`) · `cask` (the cask token) · `lockstep` · `notaryProfile` (OPTIONAL — the notarytool keychain profile that turns notarization on) | `gh auth login`, plus both rustup mac targets (`aarch64-apple-darwin`, `x86_64-apple-darwin`); **with `notaryProfile`**: a `Developer ID Application` certificate (Xcode → Settings → Accounts → the Apple Developer Program team → Manage Certificates), that identity named in `tauri.conf.json`'s `signingIdentity`, and the profile stored ONCE with `xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team>` |

`npm whoami` passing does **not** prove publish rights: an interactive-login token authenticates and then dies at publish with `EOTP`, because the account's 2FA demands a per-publish one-time password — the granular token bypasses it. Creating it is the account owner's to do. Don't pre-check any of this: the CLI's preflight names whichever piece is missing, in its own words, before anything is touched.

**Notarization is optional and opt-in by the `notaryProfile` key alone.** With it, the pack gate submits the dmg to Apple, staples the ticket and lets Gatekeeper assess it before anything is tagged, and the install note is the `brew install` line by itself. Without it the release is unsigned exactly as before, and its users clear the quarantine by hand. The keychain profile NAME is the only credential involved — never set `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`, and never put an app-specific password anywhere but the keychain. Adding the key is the user's decision (it needs a paid Apple Developer Program membership); suggest it, never assume it.

## Step 1: Run the release

From the main checkout:

```bash
bunx dobby release --json                    # infer the bump
bunx dobby release --bump <level> --json     # only when the user typed patch|minor|major as the argument
```

`--json` is the contract: the payload is the sole stdout, and any refusal travels on stderr. Add `--dry-run` when the user asks what WOULD ship — it answers with the version and the changelog, having touched nothing.

**Config gate.** The `release` key is what makes the command EXIST, so an undeclared target does not read as a release error — it reads as a missing command. Two different answers, and they mean different things:

- **No `release` key** — the dispatcher hides the command entirely, so the CLI answers `unknown command: release` followed by its generic version-skew hint: *if this command is expected, run* `bun update @kvnwolf/dobby`. **That hint is a red herring here** — nothing is out of date, the project has simply declared no release target. Don't chase the update. **Stop**, and point the user at the `release` config keys in the table above; declaring the target is a config edit they own.
- **`release` present but malformed** — the command exists and the config is broken, so the CLI surfaces the config error instead (e.g. `release.type must be one of: npm, homebrew-cask`). Report it verbatim and **stop**.

Then branch on the payload: `needsDecision` → Step 2, `needsNotes` → Step 3, anything else → Step 4.

## Step 2: The two version gates (`needsDecision`)

The command exits 1 having touched **nothing**, with `{needsDecision, context: {commits, currentVersion}}`. Ask with **AskUserQuestion** — one question that restates its own context: the current version and the commit subjects from `context.commits`, listed so the user judges the actual changes, not a label.

- **`0x-major`** — the range carries a breaking change while the project is still below 1.0.0, where "major" is a judgment, never arithmetic. Options: **`major` — the true 1.0.0** (this breaking change is the moment the project commits to a stable API) vs **`minor` — the 0.x convention** (below 1.0.0, breaking changes ship as minors).
- **`first-release`** — no `v*` tag exists, so there is nothing to infer from. Options: `patch` / `minor` / `major`, each shown as the version it produces from `context.currentVersion` (0.1.0 → 0.1.1 / 0.2.0 / 1.0.0).

Re-run with the answer: `bunx dobby release --bump <answer> --json`. **Never answer either gate yourself**, and never re-run without `--bump` hoping for a different verdict.

## Step 3: Author the notes (`needsNotes`) — the judgment core

The payload carries `{needsNotes: true, version, changelog: {groupedBy, groups, since}}` and exits 1. Everything mechanical is DONE and LOCAL: the version is bumped, the gate is green over the bumped tree, the `release: v<V>` commit exists — and nothing has been pushed, tagged or published.

`changelog.groups` is **raw material**, not the output: a map of group name (surface or type) to commits (`sha`, `subject`, `type`, `breaking`). Read the diffs behind any subject too terse to explain — `git show <sha>` — rather than paraphrasing the subject line.

**Write notes with life in them.** Rich, blog-post style, emojis, personality. Explain what shipped and **why it matters to a user**: what they can now do, what stopped hurting, what they must change. A dry mechanical list of commit subjects is exactly the failure mode this step exists to prevent — never ship one.

- Open with the headline of the release: one or two lines on the single thing that changed for the better.
- One section per group that earned it (emoji heading, short paragraph). Group the story, not the commits — several commits are usually one feature.
- Call **breaking changes** out loudly, with the migration in the same breath.
- Close with what to do next: the install/upgrade command — for `homebrew-cask`, composed from the project's own `release.tap` + `release.cask` (`brew install --cask <tap>/<cask>`, the tap without its `homebrew-` prefix) — and any caveat the user will hit. Nothing is published at this stop and the smoke phase has not run, so there is no phase note to quote yet; that one lands in Step 5.

Write the notes with the `Write` tool to an absolute path under the OS temp dir (e.g. `/tmp/release-notes-v<V>.md`), **never inside the repo**. `Write` takes a LITERAL path — it does not expand shell syntax like `${TMPDIR:-/tmp}`, which would create that junk directory under the repo root and dirty the tree — exactly what the next preflight refuses. Then resume with that same absolute path:

```bash
bunx dobby release --notes-file /tmp/release-notes-v<V>.md --json
```

The resume recognizes the local bump commit and never bumps twice — don't pass `--bump` again.

## Step 4: Report the phases the CLI drove

The resume runs the release to its end. Read `phases[]` from the payload (`{name, ok, note?}`) and report each in order, with its note:

`preflight` (main checkout · on `main` · clean tree · `git pull --ff-only` · CI **green on this very commit** · the target's own channel check — for a notarizing homebrew-cask project, that includes the Developer ID certificate and the keychain profile) → `version` → `bump` (every lockstep manifest, indentation preserved · the target's non-JSON extras · `check --fix` over the bumped tree · the local commit) → `changelog` → `pack-gate` (for homebrew-cask: the universal dmg build, exactly one dmg, the bundled version — and, with a `notaryProfile`, the **notarization gate**: submit to Apple and wait for `status: Accepted`, staple the ticket, then Gatekeeper's own `Notarized Developer ID` assessment, all still before any tag) → `publish` → `tag` → `push` → `github-release` → `post-release` (a target's work that needs the release to exist first — the dmg upload, the tap move) → `smoke`.

A red `pack-gate` on a notarizing project quotes Apple's full notarytool log — report it verbatim; it is the only account of why the submission was refused, and nothing was tagged.

**Any red phase: report the CLI's `error` VERBATIM and STOP.** Never re-run blindly — the command already did whatever rollback was safe, and a second run on top of an unknown state is how a version number gets burned. Two cases, and they need different words:

- **Before the publish** — nothing left the machine. The local `release: v<V>` commit was rolled back (`git reset --hard HEAD~1`) as long as it was still the unpushed HEAD; the error says which. Report what refused, and hand the fix to the user.
- **`published: true` with a red phase** — the artifact **is public** and nothing was rolled back, by design. Report exactly which phase failed and what is left to finish by hand (attach the asset, bump the tap, create the GitHub release), and say plainly that the version is already out.

## Step 5: The final report

On a clean run (`exitCode 0`, `published: true`), report:

- the **version + tag** released, and the **bump reasoning** — the commits that justified the inference, or the decision the user made in Step 2;
- the **links**: the GitHub release for the tag, and the package page for an npm target;
- the **smoke result** from its phase note — for `npm`, the registry poll plus the project's own `release.smoke` command; for `homebrew-cask`, the smoke runs nothing, so hand the user its note **verbatim**: the `brew install --cask <tap>/<cask>` command, followed by the `xattr -dr com.apple.quarantine "/Applications/<App>.app"` line only when the release was NOT notarized (Homebrew quarantines casks with no opt-out; the `xattr` is what lets the unsigned app open). Never add that line to a notarized release's note — the CLI leaves it out because it is untrue there.

## Acceptance checklist

- [ ] Ran from the MAIN checkout (never a worktree), and every mechanic went through `bunx dobby release … --json` — no hand-edited version, no `npm publish` / `git tag` / `gh release create` run by this skill
- [ ] Config gate: an ABSENT `release` key (`unknown command: release` + the update hint) was read as an undeclared release target — not as version skew — and stopped, pointing at the `release` config keys; a MALFORMED key surfaced the CLI's config error verbatim
- [ ] `needsDecision` answered by the USER via AskUserQuestion — the question restated the current version and listed `context.commits`; re-run with `--bump <answer>`, never re-run unanswered
- [ ] `needsNotes` answered with rich, personality-carrying notes (emojis, what shipped and why it matters, breaking changes + migration called out) written from the changelog data plus the commits behind it — never a dry subject list
- [ ] Notes written to a temp file OUTSIDE the repo and passed as `--notes-file`; the resume carried no second `--bump`
- [ ] Every phase reported from `phases[]`; any failure reported VERBATIM with no blind re-run, distinguishing the rolled-back pre-publish case from a `published: true` failure that is already public
- [ ] Final report carries version + tag, the bump reasoning, the links, and the smoke result (for `homebrew-cask`, the smoke note handed over verbatim — `brew install`, plus the `xattr` line only when the release was un-notarized)
