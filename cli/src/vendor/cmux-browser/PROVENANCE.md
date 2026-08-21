# Vendored asset provenance

`../browser-guide.ts` reports the cmux browser verification protocol as part of the `dobby env`
snapshot (`browserGuide`), so QA stops rediscovering it every run. The protocol text is vendored
here, unmodified, instead of fetched at run time — a network fetch would make `dobby env` network-
dependent and irreproducible. Re-vendoring means repeating the steps below and updating this file.

## Source: `manaflow-ai/cmux`

Both files were fetched with `curl -fsSL` from the raw GitHub content the `cmux docs browser` CLI
itself points at, unmodified byte-for-byte from upstream.

| File | Source | SHA-256 |
| --- | --- | --- |
| `SKILL.md` | `skills/cmux-browser/SKILL.md` | `741d9941a3d6ecca81e3e019dd301ba9aa249881b2b39f0dff4087df4eb687e4` |
| `commands.md` | `skills/cmux-browser/references/commands.md` | `2b12505ad4ff964faa28a21cb4543ff48874a04117e417d8c0d45e5b5b25b221` |

- Repository: `manaflow-ai/cmux` ([github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux))
- Commit: `24dd44e638ec49f60e8ba754dca5ed349ea54d0a` (tip of `main` at fetch time, 2026-08-19)
- License: GPL-3.0-or-later (Copyright (c) 2024-present Manaflow, Inc.), per the repository's
  `LICENSE`; no separate file-level notice on either vendored file. Vendoring the protocol TEXT
  here (documentation instructing an already-installed `cmux` binary) does not distribute or link
  against `cmux`'s own GPL-licensed source.
- Fetched with:
  ```
  curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/skills/cmux-browser/SKILL.md
  curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/skills/cmux-browser/references/commands.md
  ```

## Re-vendoring

1. Re-fetch both files with the `curl` commands above (or `cmux docs browser` to confirm the
   upstream paths have not moved).
2. Note the current tip commit of `manaflow-ai/cmux`'s `main` branch (`git ls-remote` or the GitHub
   API `commits/main` endpoint) and update the commit above.
3. Recompute each SHA-256 (`shasum -a 256 <file>`) and update the table above.
4. Re-run `bunx vitest run cli/src/browser-guide.test.ts`.
