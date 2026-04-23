# Agent policy, hooks, settings

## 1. Agent policy (groups/global/CLAUDE.md)

**v1 commits:** `426e5b1`, `73020ea`, `9c828ad`

**Intent:** Shared policy doc inherited by all agent groups. Encodes Kyle's git rules, host environment (Pi5), and message-formatting conventions.

**Action:** Copy `groups/global/CLAUDE.md` **verbatim** from the main tree into the v2 worktree. It's content, not code.

Key rules encoded (for reference only — don't rewrite, just carry the file):

- **Git scoping:** `git add/commit/push` only in the NanoClaw working directory. No exceptions without explicit Kyle override.
- **Host environment:** Pi5 (Arch Linux ARM, aarch64). Services: shiny-server, slides-server (Quarto 3839), nanoclaw, syncthing.
- **SSH rules:** `archMitters` allowed (Tailscale `100.96.87.89`). `Pi5`/`localhost`/`127.0.0.1` forbidden (agent runs ON Pi5 — loopback suicide pattern).
- **Obsidian vault:** `/workspace/extra/obsidian/` via Syncthing.
- **Message formatting per channel:**
  - Slack: `*bold*` (single asterisks), `<url|text>`
  - WhatsApp/Telegram: `*bold*`, `_italic_`, no headings, no Markdown links
  - Discord: standard Markdown (`**bold**`, `[link](url)`)

**v2 note:** if `groups/global/` isn't a thing in v2 (e.g. global policy moves to a shared agent-group CLAUDE.md fragment or a top-level `CLAUDE.md`), adapt the location. Content stays the same.

---

## 2. Commit-message PreToolUse hook

**v1 commit:** `03ab9e1`

**Intent:** Validate `git commit` messages against Kyle's format conventions before execution. Runs as a PreToolUse hook on Bash calls; rejects non-conforming commits so Claude re-drafts rather than the commit landing wrong.

### File to copy

`.claude/hooks/commit-message-validate.py` — copy verbatim from main tree into v2 worktree.

### Validation rules encoded in the Python script

- **First line format:** `type(scope): summary` — `type` ∈ {feat, fix, docs, test, refactor, chore}
- **Length:** first line ≤ 72 chars
- **Trailers:** no `Co-Authored-By: Claude ...` trailers (they don't add value; co-authorship is noise)
- **Body:** indented bullets (`  - item`), not paragraphs; no unrelated content

### Settings wiring

In `.claude/settings.json` add (merge with any existing hooks entry):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/commit-message-validate.py",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**User-level skill dependency:** the hook logic mirrors the `/commit-message` skill stored at `~/.claude/skills/commit-message/SKILL.md`. That file is user-level (not tracked by this repo) and was backed up separately in the piCloud tar. If the hook diverges from the skill, the skill is the canonical spec.

---

## 3. Project-level git permissions

**v1 commits:** `a99afb1`, `02c5604`

**Intent:** Allow `git add/commit/push/pull/fetch/clone` at the project level so Claude can perform these without per-command permission prompts (within the nanoclaw repo).

### .claude/settings.json additions

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(git pull:*)",
      "Bash(git fetch:*)",
      "Bash(git clone:*)"
    ]
  }
}
```

(Merge with any existing `permissions.allow` array; don't duplicate entries.)

---

## 4. .env.example additions

See [core-and-tui.md § .env.example](core-and-tui.md#envexample) for the full list.

Key additions in v1:
```
DISCORD_BOT_TOKEN=
# DISCORD_BOT_TOKEN_MILTON=   # or any DISCORD_BOT_TOKEN_<REF> for multi-bot
OPENAI_API_KEY=               # voice transcription via Whisper
```

## 5. .gitignore additions

```
# Claude Code per-machine settings (local permission grants, etc.)
.claude/settings.local.json
```

---

## 6. Mount allowlist (host-side, not in repo)

**Host file:** `~/.config/nanoclaw/mount-allowlist.json` (outside the repo; backed up in the piCloud tar)

```json
{
  "allowedRoots": [
    { "path": "/home/kyle", "allowReadWrite": true, "description": "Full home directory (Andy main)" },
    { "path": "/home/kyle/.config/nanoclaw/ssh", "allowReadWrite": false, "description": "Andy SSH keys (read-only)" },
    { "path": "/mnt/piCloud", "allowReadWrite": true, "description": "piCloud shared storage" }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

Ensure this file exists at `~/.config/nanoclaw/mount-allowlist.json` post-migration. v2 uses it to enforce mount boundaries per messaging-group (was per-registered-group in v1 — terminology changes, behavior stays).

**Also host-provisioned:** `~/.config/google-calendar-mcp/` (covered in [container-infrastructure.md § Google Calendar MCP](container-infrastructure.md#3-google-calendar-mcp-direct-node-fix)).

---

## 7. CI workflows (NOT carried to v2)

Per Kyle's decision, the fork-sync CI workflows are **dropped from the v2 baseline**:

- `.github/workflows/bump-version.yml`
- `.github/workflows/update-tokens.yml`
- `.github/workflows/fork-sync-skills.yml` (renamed from old `merge-forward-skills.yml`)

Rationale: these automated v1's upstream merge workflow; v2 is a greenfield baseline and the automation can be re-added later if needed.

Do NOT copy `.github/workflows/` contents from main. Use whatever v2 ships with.
