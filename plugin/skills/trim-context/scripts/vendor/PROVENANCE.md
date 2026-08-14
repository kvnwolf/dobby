# Vendored asset provenance

`scripts/comment-inventory.mjs` parses tracked files with real Tree-sitter grammars instead of a
text heuristic. Everything it needs at runtime is vendored under `scripts/vendor/` so the plugin
stays self-contained (cache-copied on install; never reaches into a consumer's `node_modules` or
this repo's `../cli`). Nothing here is fetched at run time. Re-vendoring means repeating the steps
below and updating this file.

## Runtime: `web-tree-sitter`

The Tree-sitter WASM engine and its JS bindings, copied unmodified from the npm tarball (ESM build,
non-debug).

| File | Source | SHA-256 |
| --- | --- | --- |
| `web-tree-sitter/web-tree-sitter.js` | `web-tree-sitter@0.26.12`, `package/web-tree-sitter.js` | `0c868236a47296b4ff3c1570f20e0899e4a784ff6e5cd7bfc9c3a55225463e4a` |
| `web-tree-sitter/web-tree-sitter.wasm` | `web-tree-sitter@0.26.12`, `package/web-tree-sitter.wasm` | `ba5c7a539603f251f380e4d6ce26ee954ffca7bda8b2e13744dc4c87d6ce6041` |
| `web-tree-sitter/LICENSE` | `web-tree-sitter@0.26.12`, `package/LICENSE` | `c5cfb43042b6b72045f4ba997834d0a7786d2793d91680868b5815b39f14fc78` |

- Package: `web-tree-sitter@0.26.12` ([npm](https://www.npmjs.com/package/web-tree-sitter), repo `tree-sitter/tree-sitter`)
- License: MIT, Copyright (c) 2018 Max Brunsfeld (see the vendored `LICENSE`)
- Fetched with `npm pack web-tree-sitter@0.26.12`; tarball shasum `98894c92689bc0145c16791ab71a808eb5198de1` per the npm registry (unrelated to the file hashes above, which are of the extracted files).
- `web-tree-sitter/package.json` is not copied from the tarball; it is a one-line, hand-written
  `{"type":"module"}`, matching the `"type"` field the real package.json declares, so Node resolves
  the vendored `web-tree-sitter.js` as ESM without a reparse warning.

## Grammars: prebuilt `.wasm` binaries

The compiled grammar binaries were obtained from `tree-sitter-wasm@1.1.4` (published by
`Crysthamus`, MIT wrapper license, `out/<lang>/tree-sitter-<lang>.wasm` layout), which builds and
signs each grammar from a pinned upstream commit via an isolated GitHub Actions runner (SLSA level
3 + npm provenance + individual Cosign `.sigstore.json` signatures — verified via `npm audit
signatures` and the registry attestation endpoint before vendoring). Only the seven `.wasm`
binaries below were copied; no `.scm` query files, no other grammars from that package.

The **applicable license for each `.wasm` is its upstream grammar's own license**, not
`tree-sitter-wasm`'s wrapper license — the exact upstream `LICENSE` text is vendored alongside each
grammar as `grammars/LICENSE-<repo>.txt`, one file per source repository (the TypeScript grammar
repo ships both the `typescript` and `tsx` grammars, so one license file covers both binaries).

| Grammar `.wasm` | Covers extension(s) | SHA-256 |
| --- | --- | --- |
| `grammars/tree-sitter-typescript.wasm` | `.ts` | `0df5e286c944afd0e3ef1fd6ca973a5b017d7ec3e2d5b08fe0861ed9d6c8d337` |
| `grammars/tree-sitter-tsx.wasm` | `.tsx` | `d8c62a9dbf83f2c72269697213b29687bc3828745c33c6a097decb249d987831` |
| `grammars/tree-sitter-javascript.wasm` | `.js`, `.jsx`, `.mjs` | `163a9ace4029f98a9e7a8e7d0b2e814b8453ae00074f389bc8f6e1ce09e29719` |
| `grammars/tree-sitter-css.wasm` | `.css` | `10925cbd074184dc0209882268bd12d63d905ed78f4bd71aa92d9eaceb5892e0` |
| `grammars/tree-sitter-html.wasm` | `.html` | `190431517396191118d9ff44e0b9c2d4bf8727eadbdefdf1faa7b918f106f61e` |
| `grammars/tree-sitter-bash.wasm` | `.sh` | `ff6c76b12cb42f20cd9ec7de6123345d4765aca7600d34a7f27e5a02efbd6b78` |
| `grammars/tree-sitter-sql.wasm` | `.sql` | `9002db2db74aa99fb91d0a79c87212867773ee3a023dda2bea2a1d35b32fa042` |

Upstream grammar sources, exact versions the `.wasm` binaries were built from, and license files:

| Upstream grammar | npm package pinned for its LICENSE text | Repository | License |
| --- | --- | --- | --- |
| TypeScript + TSX (`LICENSE-tree-sitter-typescript.txt`) | `tree-sitter-typescript@0.23.2` | `tree-sitter/tree-sitter-typescript` | MIT, Copyright (c) 2017 Max Brunsfeld |
| JavaScript (`LICENSE-tree-sitter-javascript.txt`) | `tree-sitter-javascript@0.25.0` | `tree-sitter/tree-sitter-javascript` | MIT, Copyright (c) 2014 Max Brunsfeld |
| CSS (`LICENSE-tree-sitter-css.txt`) | `tree-sitter-css@0.25.0` | `tree-sitter/tree-sitter-css` | MIT, Copyright (c) 2018 Max Brunsfeld |
| HTML (`LICENSE-tree-sitter-html.txt`) | `tree-sitter-html@0.23.2` | `tree-sitter/tree-sitter-html` | MIT, Copyright (c) 2014 Max Brunsfeld |
| Bash (`LICENSE-tree-sitter-bash.txt`) | `tree-sitter-bash@0.25.1` | `tree-sitter/tree-sitter-bash` | MIT, Copyright (c) 2017 Max Brunsfeld |
| SQL (`LICENSE-tree-sitter-sql.txt`) | `tree-sitter-sql@0.1.0` | not published in npm metadata; copyright line taken from the vendored LICENSE itself | MIT, Copyright (c) 2021 Maksim Novikov |

| License file | SHA-256 |
| --- | --- |
| `grammars/LICENSE-tree-sitter-typescript.txt` | `49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559` |
| `grammars/LICENSE-tree-sitter-javascript.txt` | `2e0110e07abef7c2548b26ec9d6969775617ca539a0dc8dbeeb14d6452c711d1` |
| `grammars/LICENSE-tree-sitter-css.txt` | `c5cfb43042b6b72045f4ba997834d0a7786d2793d91680868b5815b39f14fc78` |
| `grammars/LICENSE-tree-sitter-html.txt` | `2e0110e07abef7c2548b26ec9d6969775617ca539a0dc8dbeeb14d6452c711d1` |
| `grammars/LICENSE-tree-sitter-bash.txt` | `49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559` |
| `grammars/LICENSE-tree-sitter-sql.txt` | `c77223ac6f87f1c03be39565d7433a719904a9172f709525b96a5178f8907308` |

(Some hashes repeat across files because upstream MIT license text is byte-identical for grammars
sharing a copyright year and holder — verified above, not a copy/paste mistake.)

### SQL grammar: known gap, evaluated and rejected alternative

The vendored `tree-sitter-sql.wasm` above has no PostgreSQL RLS/ACL DDL support (`CREATE POLICY`,
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `GRANT`); see `references/sweep-contract.md` for the
user-facing consequence. On 2026-08-12, `@derekstride/tree-sitter-sql@0.3.11` — the actively
maintained successor grammar (last published 10 months prior) — was pulled via `npm pack` and
evaluated as a replacement:

- It ships no prebuilt `.wasm` (native Node bindings only, `node-gyp-build`); a WASM build would
  have to be compiled locally from its `src/parser.c`/`src/scanner.c`, which was done as a
  throwaway test (`tree-sitter-cli@0.26.12`, `tree-sitter build --wasm`) purely to check parse
  behavior, and was **not** vendored: a self-built binary has no independent attestation (unlike
  the Cosign/SLSA-3-signed `tree-sitter-wasm` release used for every grammar above), so it cannot
  meet this file's provenance bar.
- Its own `grammar.js` carries an explicit `// TODO: policy` and defines no `GRANT` statement at
  all, so it fails to parse the same three PostgreSQL DDL forms as the currently vendored
  grammar — confirmed empirically by parsing `CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL
  SECURITY`, and `GRANT` samples with both grammars and comparing `rootNode.hasError` (identical
  results). It does correctly parse `->>` (jsonb) and `$$ ... $$` dollar-quoted bodies, which the
  currently vendored grammar already handles too, so switching would add build/provenance risk
  for zero coverage gain on the actual gap.

No other Tree-sitter SQL grammar with real Postgres RLS/ACL support and a verifiable prebuilt
`.wasm` was found. Re-evaluate if `@derekstride/tree-sitter-sql` (or another grammar) ships a
signed prebuilt WASM release with `CREATE POLICY`/`GRANT` support, or if `tree-sitter-wasm`
switches its own `sql` build to a grammar that does.

## Re-vendoring

1. `npm pack web-tree-sitter@<version>` and copy `package/web-tree-sitter.{js,wasm}` +
   `package/LICENSE` into `web-tree-sitter/`.
2. `npm pack tree-sitter-wasm@<version>`, verify (`npm audit signatures`, or `gh attestation
   verify`/`cosign verify-blob` per that package's README), then copy only
   `package/out/<lang>/tree-sitter-<lang>.wasm` for the seven grammars above into `grammars/`.
3. For each upstream grammar, `npm pack <upstream-grammar-package>@<version>` and copy its
   `package/LICENSE` into `grammars/LICENSE-<repo>.txt`.
4. Recompute every SHA-256 (`shasum -a 256 <file>`) and update the tables above.
5. Re-run `bunx vitest run plugin/skills/trim-context/comment-inventory.test.ts`.
