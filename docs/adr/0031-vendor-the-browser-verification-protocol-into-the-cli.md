# 0031. Vendor the browser verification protocol into the CLI

QA was rediscovering how to drive the cmux browser on every run — the open → read URL → snapshot → act → wait → re-snapshot cycle, its stale-ref rules and its `js_error` recovery — burning turns on documentation lookup before proving anything. The protocol is now vendored inside the CLI (`cli/src/browser-guide.ts`) with its provenance recorded, and `dobby env` returns the variant matching the detected environment. This follows the precedent ADR-0027 set for the Tree-sitter runtime in `trim-context`.

## Considered options

**Fetch it live from `manaflow-ai/cmux`.** Always current and nothing for us to maintain. Rejected: it makes every verification depend on the network and on that repository not moving the file, and the same run is no longer reproducible twice.

**Return only the pointers**, as `cmux docs browser` does. Nothing to maintain and no staleness — but it is what already happens today, and the whole point was to stop QA spending turns fetching and reading.

## Consequences

The vendored text goes stale when cmux changes its CLI, and nothing detects that automatically — it is corrected in a release, like any other vendored asset. Its provenance (repository, commit, licence, checksum) is recorded alongside it so the drift is at least auditable. Where cmux is absent, the guide returns the non-cmux verification instructions rather than nothing.

*Amended by ADR-0032:* the vendored text is unchanged, but its channel moved — it is now the cmux adapter's `browser` instruction, served by `dobby instructions browser`; `dobby env` no longer carries a browser guide.
