# NanoClaw v2 Migration Guide

Generated: 2026-04-23
Base: `eba94b721ab8c7476e97d6600ca7ee4c0e53249c` (eba94b7)
HEAD at generation: `03ab9e1f1e45079f0f7e25d8c78939676e983f47` (03ab9e1)
Upstream target: `5ae66624eb36c9fdb22539599261c0b3ca11ede5` (upstream/v2, 5ae6662)
Scope: Tier 3 (113 user commits, 39 user-changed files, 326 upstream commits to absorb)

## What this guide is

A replayable set of instructions for re-applying Kyle's customizations onto a **clean upstream/v2 worktree**. Built on the principle that upstream/v2 is the gospel — v1's `src/channels/discord.ts` does not exist on v2 (v2 uses a Chat-SDK adapter, `@chat-adapter/discord@4.26.0`), so Discord features are re-implemented as deltas rather than merged.

Section files:

- [discord-features.md](discord-features.md) — Discord feature deltas: bot_token_ref multi-instance, progressive reveal, voice transcription, typing-pulse, PDF reading, image vision
- [container-infrastructure.md](container-infrastructure.md) — Container SSH, host-key pinning, Google Calendar MCP (direct-node fix), brave-search CLI, Dockerfile additions
- [core-and-tui.md](core-and-tui.md) — Pino logger migration, TUI mode (Ink), core `src/` changes (config, db, types, router, container-runner)
- [policy-hooks-settings.md](policy-hooks-settings.md) — Agent policy (`groups/global/CLAUDE.md`), commit-message PreToolUse hook, `.claude/settings.json`, `.gitignore` entries
- [local-skills.md](local-skills.md) — Local skill branches `skill/brave-search` and `skill/discord-pdf-reader`

## Migration plan (order of operations)

### Staging

1. **Foundation layer** (before anything else): upstream skill re-merges — `channel-formatting` and `compact`. Native-credential-proxy is NOT re-applied (OneCLI replaces it). Ollama-tool is NOT re-applied (already reverted in v1; closed question per `~/Documents/obsidian/NanoClaw/Ollama Removed.md`).

2. **Core infrastructure**: pino logger, config constants (`MAIN_GROUP_FOLDER`), dependency bumps. This unblocks everything else.

3. **Schema migration**: add `bot_token_ref` to v2's `messaging_groups` table (v1's `registered_groups` is split in v2; see plan decision). Template: `src/db/migrations/module-agent-to-agent-destinations.ts`.

4. **Discord adapter deltas**: bot_token_ref token-selection logic, progressive reveal (`streamMessage`), voice transcription, typing-pulse stop, PDF + image attachment handling. Applied on v2's Chat-SDK Discord adapter.

5. **Container infrastructure**: Dockerfile additions (openssh-client, poppler-utils, brave-search CLI, pdf-reader CLI, /etc/passwd writable, entrypoint script), Google Calendar MCP registration in agent-runner with direct-node invocation.

6. **TUI mode**: add tui-main.ts + tui.tsx, npm script, tsconfig JSX. Will need adjustment — v2's session/session-DB model differs from v1, and TUI must target v2's per-session `inbound.db`/`outbound.db` rather than v1's stdin/stdout.

7. **Agent policy + hooks + settings**: copy `groups/global/CLAUDE.md`, `.claude/hooks/commit-message-validate.py`, settings.json PreToolUse wiring, .gitignore additions.

8. **Local skill branches**: merge `skill/brave-search` and `skill/discord-pdf-reader` into the v2 worktree.

### Risk areas

- **Discord adapter re-port**: v2's Chat-SDK adapter has different primitives (no hand-rolled discord.js client). Streaming, typing, reactions, and attachment handling all need re-wiring against SDK APIs. This is the single biggest piece of work.
- **TUI mode**: v2's IO model is SQLite tables, not stdin/stdout. TUI must write to `messages_in` and read from `messages_out`, not pipe to a Node subprocess.
- **bot_token_ref schema migration**: v2 splits v1's `registered_groups` into `agent_groups` + `messaging_groups`. The new column belongs on `messaging_groups`.
- **pino logger**: check whether upstream/v2 already uses pino. If yes, this customization may be obsolete.
- **Image vision container path**: v1 agent-runner reads from `/workspace/group/` — v2's workspace root is different (verify in pre-flight). Update path in `container/agent-runner/src/index.ts` when re-porting.

## Applied upstream skills (re-merge in Phase 2)

| Skill | Branch | v1 merge hash | v2 equivalent branch | Post-merge modifications |
|-------|--------|---------------|---------------------|--------------------------|
| channel-formatting | `upstream/skill/channel-formatting` | `c723c86` | same name | None (text-styles.ts unchanged since merge) |
| compact | `upstream/skill/compact` | `f72e20d` | same name | Minimal formatting-only edits; no logic changes |

**Dropped from v1 (do NOT re-merge):**
- `native-credential-proxy` (skill/native-credential-proxy, merge `9cec57b`): superseded by OneCLI. Kyle uses OneCLI (`ONECLI_URL=http://172.17.0.1:10254` in .env) as the sole credential path — dropping the alternative simplifies the stack.
- `ollama-tool` (skill/ollama-tool, merge `6244454`): already reverted in v1 (commit `af746dc`). Closed question per Obsidian doc "Ollama Removed.md". Do not re-apply.

**Discord channel:** merged from external repo `discord/main` at `6f3f115` in v1. In v2, channels are in `upstream/channels` — install via `/add-discord` skill, then apply deltas from [discord-features.md](discord-features.md).

## Applied upstream skills NOT re-merged (also dropped)

Kyle's v1 had a few skill branches merged that are being dropped in v2 per user decision:

- Silent-gateway death + sandbox hardening patch (`a804002`): v2's Chat-SDK Discord adapter owns reconnection. Revisit only if v2 shows similar symptoms.
- Fork-sync CI workflows (`77624a1`, `27e10c2`, etc. in `.github/workflows/`): automation for v1 merge-forward; not critical for v2 baseline. Can re-add later.
- Acknowledgement reactions (`140b56b`, reverted in `5cb8241`): already rolled back in v1; don't revive. v2 has a new first-class `add_reaction` MCP tool that would be the idiomatic approach if Kyle ever wants this back.

## Skill interactions to watch

1. **`channel-formatting` + Discord deltas**: `src/text-styles.ts` does channel-aware Markdown conversion; `src/router.ts` calls `parseTextStyles()` in `formatOutbound`. The v2 Discord adapter must route outbound messages through the same formatter (v2 may already do this — verify against `upstream/v2:src/router.ts`).

2. **`compact` + session-commands + TUI**: `src/session-commands.ts` added by the compact skill handles `/compact`. TUI mode in v1 intercepts session commands before the trigger check. v2's session model uses the per-session `inbound.db` — the interception point may have moved.

3. **bot_token_ref + Discord adapter**: the multi-instance factory pattern (`Channel | Channel[] | null` return type from factory) is a delta to `src/channels/registry.ts`. If the v2 Chat-SDK adapter expects a single instance per `channel_type`, we either (a) register two channel types (`discord` + `discord-milton`) or (b) extend the v2 registry. Per plan decision, go with (a)'s spirit via the schema migration but keep one adapter class with internal multi-client support. See [discord-features.md § bot_token_ref](discord-features.md#a-bot_token_ref-multi-instance-ad72d81).

4. **Image vision + container workspace paths**: `container/agent-runner/src/index.ts` reads images from `/workspace/group/<relativePath>`. v2 renames workspace (verify before execution). Update the path constant when re-porting.

## Data that transfers verbatim (not code)

- `groups/discord_main/` — Andy's full folder (CLAUDE.md, memory/, conversations/, attachments/)
- `groups/discord_milton/` — Milton's full folder (paralegal persona CLAUDE.md)
- `groups/global/CLAUDE.md` — shared policy doc
- `.env` — bot tokens (`DISCORD_BOT_TOKEN`, `DISCORD_BOT_TOKEN_MILTON`), `ONECLI_URL`, `OPENAI_API_KEY` if present
- `~/.config/nanoclaw/` — `mount-allowlist.json`, `ssh/` directory with Andy's SSH key + known_hosts
- `~/.config/google-calendar-mcp/` — OAuth keys + refresh tokens (do not regenerate; they're live)
- `store/messages.db` — v1 DB preserved as rollback and source for scheduled-task migration script

Backup is at `~/piCloud/nanoclaw-backup-04232026.tar.gz` + git tag `pre-v2-migration-20260423` on commit `03ab9e1`.

## Non-code state to recreate in v2

**Not written to disk by this guide** — these are created via v2's admin tooling after the worktree is live:

1. **Agent groups** (new v2 concept, replaces v1 `registered_groups`):
   - `andy` → folder `groups/discord_main/` (already exists verbatim). All 5 Discord channels wire to this agent group.
   - `milton` → folder `groups/discord_milton/` (already exists verbatim).

2. **Messaging groups** (one per Discord JID, from v1 data):
   - `dc:1435481829573656628` — #nanoclaw (Andy, main)
   - `dc:1494156244439666829` — #weather (Andy, shared session)
   - `dc:1494156616071643386` — #typescript-learning (Andy, shared session)
   - `dc:1494156045331992586` — #news (Andy, shared session)
   - `dc:1494157843325255720` — #server-logs (Andy, shared session)
   - `dc:1495248172740509800` — #milton (Milton, `bot_token_ref='milton'`)

3. **Scheduled tasks** (21 total, from `store/messages.db:scheduled_tasks`). No upstream v1→v2 import tool exists — write a one-off TS script modeled on `scripts/seed-discord.ts` that reads the v1 DB and INSERTs into each session's `inbound.db` with `kind='task'`, `process_after`, `recurrence`, `series_id`. Dry-run to JSON first; visually confirm these 5 critical one-shots before writing:
   - 2026-04-27 09:00 CT — Proton Drive decommission verification
   - 2026-05-03 09:00 CT — Descript cancel reminder
   - 2026-05-18 09:00 CT — Google One cancel reminder
   - 2026-06-02 20:45 CT — **Seaside FL weather switch Dallas→Seaside** ⚠️
   - 2026-06-10 07:05 CT — **Seaside FL restore Dallas weather** ⚠️

4. **Container mounts** for discord_main messaging group:
   - `/home/kyle` → `/workspace/extra/home` (RW)
   - `/home/kyle/.config/nanoclaw/ssh` → `/workspace/extra/andy-ssh` (RO)
   - `/mnt/piCloud` → `/workspace/extra/piCloud` (RW)
   - `/home/kyle/.config/google-calendar-mcp` → `/workspace/extra/google-calendar-mcp` (RW — tokens.json needs writes)
