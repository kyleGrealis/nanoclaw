#!/usr/bin/env python3
"""PreToolUse hook: enforce Kyle's /commit-message skill format on git commits.

Reads the Claude Code hook payload from stdin. If the intercepted Bash
command is a `git commit` with a malformed message, emits a block decision
so Claude has to re-draft using the skill's format. Other commands pass
through silently.

Skill rules enforced (from ~/.claude/skills/commit-message/SKILL.md):
  - NEVER include Co-Authored-By: Claude
  - First line: type(scope): summary -- types: feat, fix, docs, test, refactor, chore
  - First line <= 72 chars
  - Body uses indented bullets (`  - ...`) not paragraphs
"""
import json
import re
import sys

ALLOWED_TYPES = r"feat|fix|docs|test|refactor|chore"
FIRST_LINE_RE = re.compile(rf"^(?:{ALLOWED_TYPES})(?:\([^)]+\))?:\s+\S")
SKILL_REF = "~/.claude/skills/commit-message/SKILL.md"


def block(reason: str) -> None:
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def extract_message(cmd: str) -> str | None:
    """Pull the commit message out of `git commit -m ...` invocations."""
    heredoc = re.search(r"<<\s*['\"]?(\w+)['\"]?\s*\n(.*?)\n\s*\1\b", cmd, re.S)
    if heredoc:
        return heredoc.group(2).strip()
    m = re.search(r'-m\s+"((?:[^"\\]|\\.)*)"', cmd)
    if m:
        return m.group(1).replace('\\"', '"').replace("\\n", "\n")
    m = re.search(r"-m\s+'((?:[^'\\]|\\.)*)'", cmd)
    if m:
        return m.group(1)
    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)
    cmd = payload.get("tool_input", {}).get("command", "")
    if not re.search(r"(?:^|[&;|]|\s)git\s+commit\b", cmd):
        sys.exit(0)

    msg = extract_message(cmd)
    if not msg:
        sys.exit(0)  # -F <file> or other forms — let git handle it

    # Forbid Co-Authored-By: Claude only when it's an actual trailer line
    # (line-start, not a mention inside a bullet).
    if re.search(r"(?im)^\s*co-authored-by:\s*claude", msg):
        block(
            "Commit blocked: 'Co-Authored-By: Claude' trailer is forbidden by "
            f"the /commit-message skill. Remove that trailer and retry. See "
            f"{SKILL_REF}."
        )

    lines = msg.splitlines()
    first = lines[0].strip() if lines else ""
    if not FIRST_LINE_RE.match(first):
        block(
            f"Commit blocked: first line {first!r} doesn't match Kyle's format. "
            f"Expected: type(scope): what-it-solved. Types: feat, fix, docs, "
            f"test, refactor, chore. See {SKILL_REF}."
        )
    if len(first) > 72:
        block(
            f"Commit blocked: first line is {len(first)} chars (max 72). "
            "Shorten the summary; move detail into indented bullets in the body."
        )

    body = [l for l in lines[1:] if l.strip()]
    if body and not all(l.startswith("  - ") or l.startswith("    ") for l in body):
        bad = next(l for l in body if not (l.startswith("  - ") or l.startswith("    ")))
        block(
            f"Commit blocked: body must use indented bullets (`  - ...`), not "
            f"paragraphs. Offending line: {bad!r}. See {SKILL_REF}."
        )


if __name__ == "__main__":
    main()
