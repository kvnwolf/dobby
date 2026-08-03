#!/usr/bin/env python3
"""digest-transcript.py — index a Claude Code session transcript (.jsonl).

Three modes, one index:

    python3 scripts/digest-transcript.py TX                    # the turn index
    python3 scripts/digest-transcript.py TX --grep 'REGEX'     # matching turns
    python3 scripts/digest-transcript.py TX --show 12,40-44    # full turn text

The INDEX of a turn is its 1-based LINE number in the file, and all three modes
speak it: grep answers indexes, `--show` takes them back. That is what lets a
finding be anchored to concrete turns instead of paraphrased.

Why a script and not parsing instructions: the file is one JSON object per line
and runs to hundreds of MB. It is read line by line and never slurped — a
per-line `json.loads` is the whole parse. Reading the transcript into context is
the failure this replaces.

Turn kinds (the human-vs-tool discrimination that trips every hand-rolled pass):

    human        type=user whose content is a string or text blocks and carries
                 NO tool_result block
    meta         a `human` turn that is really Claude Code's own echo of a slash
                 command (<command-name>, <command-message>, <local-command-*>)
    tool-result  type=user carrying tool_result blocks — NOT the human
    assistant    type=assistant with text/thinking only
    tool-use     type=assistant carrying tool_use blocks
    <type>       anything else, reported under its own `type` value

A live transcript is HALF host bookkeeping (`mode`, `permission-mode`,
`last-prompt`, `worktree-state`, `file-history-*`, `attachment`, `ai-title`, …).
Those turns are counted in the tally but their rows are hidden unless `--all` —
they carry no session evidence and would bury the conversation.

Host-coupled on purpose (Claude Code's transcript layout), which is why it lives
in this skill and not in the `dobby` CLI. Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Iterator

# The skill-launch banner. This pattern is shared VERBATIM with /dobby:mark's
# scripts/mark.sh — a session's skills must be read the same way on both sides or
# an indicator and its digest disagree about what ran.
#
# The segment right before `skills/` is ANCHORED to `dobby` or `plugin`, never an
# open `.*`. The kit moved its skills under `plugin/`, so a live banner reads
# `…/dobby/plugin/skills/<name>` (and `…/dobby/.claude/worktrees/<x>/plugin/
# skills/<name>` from a worktree), while the pre-plugin era read
# `…/dobby/skills/<name>`; both are covered. An open `…/dobby/.*skills/` would
# ALSO swallow `…/dobby/.claude/skills/<name>` — a PROJECT skill of the dobby
# checkout, not a kit skill — and the header must name only the /dobby:* skills
# the session launched. (Cost of the anchor: the retired conductor layout
# `…/workspaces/<x>/skills/<name>` no longer matches — a wildcard there is
# exactly the over-match.) The group stays non-capturing so `findall` keeps
# yielding the skill name, exactly as `grep -oE` + `sed` do on the shell side.
SKILL_BANNER = re.compile(r"Base directory for this skill: .*/(?:dobby|plugin)/skills/([a-z-]+)")

# Claude Code injects its own slash-command bookkeeping as `user` turns.
META_PREFIXES = (
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<user-memory-input>",
)

WHITESPACE = re.compile(r"\s+")

# The kinds that carry session evidence. Every other record type is host
# bookkeeping and is tallied but not listed (see `--all`).
CONVERSATION_KINDS = frozenset(
    {
        "human",
        "meta",
        "assistant",
        "tool-use",
        "tool-result",
        "system",
        "summary",
        "unparseable",
    }
)


class Turn:
    """One transcript line, already classified and flattened."""

    def __init__(self, index: int, kind: str, preview: str, text: str) -> None:
        self.index = index
        self.kind = kind
        self.preview = preview
        self.text = text


def message_of(record: dict[str, Any]) -> dict[str, Any]:
    message = record.get("message")
    return message if isinstance(message, dict) else {}


def blocks_of(record: dict[str, Any]) -> list[dict[str, Any]]:
    """The content blocks, normalized: a bare string becomes one text block."""
    content = message_of(record).get("content", record.get("content"))
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [block for block in content if isinstance(block, dict)]
    return []


def result_text(block: dict[str, Any]) -> str:
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return "\n".join(parts)
    return json.dumps(content, ensure_ascii=False) if content is not None else ""


def flatten(record: dict[str, Any]) -> str:
    """Everything searchable in one turn: prose, tool input, tool output."""
    parts: list[str] = []
    for block in blocks_of(record):
        kind = block.get("type")
        if kind == "text":
            parts.append(str(block.get("text", "")))
        elif kind == "thinking":
            parts.append(str(block.get("thinking", "")))
        elif kind == "tool_use":
            name = str(block.get("name", "?"))
            parts.append(f"{name} {json.dumps(block.get('input', {}), ensure_ascii=False)}")
        elif kind == "tool_result":
            flag = " [error]" if block.get("is_error") else ""
            parts.append(f"→{flag} {result_text(block)}")
    summary = record.get("summary")
    if not parts and isinstance(summary, str):
        parts.append(summary)
    return "\n".join(part for part in parts if part)


def classify(record: dict[str, Any]) -> str:
    record_type = record.get("type")
    kinds = {block.get("type") for block in blocks_of(record)}
    if record_type == "user":
        if "tool_result" in kinds:
            return "tool-result"
        text = flatten(record).lstrip()
        if text.startswith(META_PREFIXES) or record.get("isMeta") is True:
            return "meta"
        return "human"
    if record_type == "assistant":
        return "tool-use" if "tool_use" in kinds else "assistant"
    return str(record_type or "unknown")


def condense(text: str, width: int) -> str:
    flat = WHITESPACE.sub(" ", text).strip()
    if len(flat) <= width:
        return flat
    return flat[: max(width - 1, 1)] + "…"


def prose_of(record: dict[str, Any]) -> str:
    """Only what the assistant SAID — no tool input, no tool output."""
    parts = [
        str(block.get("text", block.get("thinking", "")))
        for block in blocks_of(record)
        if block.get("type") in ("text", "thinking")
    ]
    return "\n".join(part for part in parts if part)


def preview_of(record: dict[str, Any], kind: str, width: int) -> str:
    """The one-line preview: enough to recognize a turn, never enough to flood."""
    if kind == "tool-use":
        names = [
            str(block.get("name", "?"))
            for block in blocks_of(record)
            if block.get("type") == "tool_use"
        ]
        # The prose the call was announced with, when there is any; otherwise the
        # call's own arguments, which say which file/command the turn touched.
        said = prose_of(record)
        detail = said if said else flatten(record)
        return condense(f"{'/'.join(names) or '?'} — {detail}", width)
    return condense(flatten(record), width)


def read_turns(path: str, width: int) -> Iterator[tuple[Turn | None, str]]:
    """Stream the file: one (turn, raw line) pair per line. Never slurped."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for index, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                yield None, line
                continue
            try:
                record = json.loads(stripped)
            except (ValueError, TypeError):
                yield Turn(index, "unparseable", condense(stripped, width), stripped), line
                continue
            if not isinstance(record, dict):
                yield Turn(index, "unparseable", condense(stripped, width), stripped), line
                continue
            kind = classify(record)
            yield Turn(index, kind, preview_of(record, kind, width), flatten(record)), line


def parse_indexes(spec: str) -> list[int]:
    """`12,40-44` → [12, 40, 41, 42, 43, 44]."""
    wanted: set[int] = set()
    for chunk in spec.split(","):
        piece = chunk.strip()
        if not piece:
            continue
        if "-" in piece[1:]:
            head, _, tail = piece.partition("-")
            try:
                start, end = int(head), int(tail)
            except ValueError:
                raise SystemExit(f"digest-transcript.py: bad range: {piece}")
            if end < start:
                start, end = end, start
            wanted.update(range(start, end + 1))
            continue
        try:
            wanted.add(int(piece))
        except ValueError:
            raise SystemExit(f"digest-transcript.py: bad turn index: {piece}")
    return sorted(wanted)


def run_index(path: str, width: int, show_all: bool) -> int:
    counts: dict[str, int] = {}
    skills: set[str] = set()
    rows: list[str] = []
    total = 0
    hidden = 0
    for turn, line in read_turns(path, width):
        for name in SKILL_BANNER.findall(line):
            skills.add(f"/dobby:{name}")
        if turn is None:
            continue
        total += 1
        counts[turn.kind] = counts.get(turn.kind, 0) + 1
        if not show_all and turn.kind not in CONVERSATION_KINDS:
            hidden += 1
            continue
        rows.append(f"{turn.index}\t{turn.kind}\t{turn.preview}")
    tally = " · ".join(f"{kind} {counts[kind]}" for kind in sorted(counts))
    print(f"# transcript: {path} ({os.path.getsize(path)} bytes)")
    print(f"# turns: {total} — {tally}")
    print(f"# skills launched: {' '.join(sorted(skills)) or '(none — no launch banner found)'}")
    if hidden:
        print(f"# hidden: {hidden} host-bookkeeping turns (--all lists them)")
    print("# columns: index<TAB>kind<TAB>preview (index = 1-based line number; --grep and --show speak it)")
    for row in rows:
        print(row)
    return 0


def run_grep(path: str, pattern: str, width: int, ignore_case: bool, show_all: bool) -> int:
    flags = re.IGNORECASE if ignore_case else 0
    try:
        needle = re.compile(pattern, flags)
    except re.error as error:
        print(f"digest-transcript.py: bad regex {pattern!r}: {error}", file=sys.stderr)
        return 1
    matched = 0
    total = 0
    rows: list[str] = []
    for turn, _ in read_turns(path, width):
        if turn is None:
            continue
        if not show_all and turn.kind not in CONVERSATION_KINDS:
            continue
        total += 1
        found = needle.search(turn.text)
        if found is None:
            continue
        matched += 1
        start = max(found.start() - width // 3, 0)
        rows.append(f"{turn.index}\t{turn.kind}\t{condense(turn.text[start : found.end() + width], width)}")
    scope = "turns" if show_all else "conversation turns (--all searches bookkeeping too)"
    print(f"# grep: {pattern} — {matched} of {total} {scope}")
    print("# columns: index<TAB>kind<TAB>match context (read a full turn with --show <index>)")
    for row in rows:
        print(row)
    return 0


def run_show(path: str, spec: str, max_chars: int, width: int) -> int:
    wanted = parse_indexes(spec)
    if not wanted:
        print("digest-transcript.py: --show needs at least one turn index", file=sys.stderr)
        return 1
    remaining = set(wanted)
    for turn, _ in read_turns(path, width):
        if turn is None or turn.index not in remaining:
            continue
        remaining.discard(turn.index)
        body = turn.text
        suffix = ""
        if len(body) > max_chars:
            body = body[:max_chars]
            suffix = f"\n… [truncated at {max_chars} chars — raise it with --max-chars]"
        print(f"=== turn {turn.index} ({turn.kind}) ===")
        print(body + suffix)
        print()
        if not remaining:
            break
    for index in sorted(remaining):
        print(f"# turn {index}: no such line in {path}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="digest-transcript.py",
        description="Index a Claude Code session transcript (.jsonl) by turn.",
    )
    parser.add_argument("transcript", help="path to the session .jsonl")
    parser.add_argument("--grep", metavar="REGEX", help="answer the turn indexes whose text matches")
    parser.add_argument("--show", metavar="INDEXES", help="print full turn text, e.g. 12,40-44")
    parser.add_argument("-i", "--ignore-case", action="store_true", help="case-insensitive --grep")
    parser.add_argument(
        "--all",
        action="store_true",
        help="include host-bookkeeping turns (hidden by default)",
    )
    parser.add_argument("--width", type=int, default=160, help="preview width (default: 160)")
    parser.add_argument(
        "--max-chars",
        type=int,
        default=4000,
        help="per-turn cap in --show (default: 4000)",
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.transcript):
        print(f"digest-transcript.py: no such transcript: {args.transcript}", file=sys.stderr)
        return 1
    if args.show is not None:
        return run_show(args.transcript, args.show, args.max_chars, args.width)
    if args.grep is not None:
        return run_grep(args.transcript, args.grep, args.width, args.ignore_case, args.all)
    return run_index(args.transcript, args.width, args.all)


if __name__ == "__main__":
    sys.exit(main())
