# Operator Repo — Andy + Milton

This is **not** a NanoClaw install. It is the operator control repo where Kyle and Claude Code coordinate work across two installed bots:

- **Andy** lives at `~/nanoclaw-andy/` — Kyle's personal assistant. Discord bot `NanoClaw-Andy` (app `1491659146469179532`). 7 channels: DM-with-Kyle, #main, #weather, #typescript-learning, #logs-and-issues, #devops, #misc.
- **Milton** lives at `~/nanoclaw-milton/` — Alexa's paralegal. Discord bot `NanoClaw-Milton` (app `1495427147953737728`). 1 channel: #milton.

Both are pure-upstream NanoClaw v2 + a small consistent overlay (see "Overlay items" below). Per-install paths use the upstream-default `nanoclaw-v2-<sha>` naming pattern.

## Don't Run NanoClaw From Here

This repo has no `src/`, no `package.json`, no container build. The bots run from their own paths. Do not `git clone` upstream into this directory; do not try to `pnpm install` here.

To touch a bot, `cd` into its install:
```bash
cd ~/nanoclaw-andy        # for Andy
cd ~/nanoclaw-milton      # for Milton
```

## Service Names

```bash
# Andy
systemctl --user status   nanoclaw-v2-930d9414
systemctl --user restart  nanoclaw-v2-930d9414

# Milton
systemctl --user status   nanoclaw-v2-952bb239
systemctl --user restart  nanoclaw-v2-952bb239
```

Each install also has its own container image: `nanoclaw-agent-v2-930d9414:latest` (Andy) and `nanoclaw-agent-v2-952bb239:latest` (Milton).

## Logs

```bash
tail -f ~/nanoclaw-andy/logs/nanoclaw.log
tail -f ~/nanoclaw-andy/logs/nanoclaw.error.log
tail -f ~/nanoclaw-milton/logs/nanoclaw.log
tail -f ~/nanoclaw-milton/logs/nanoclaw.error.log
```

## Overlay Items (Re-Apply on Every Upstream Pull)

Both installs apply the same set of patches on top of upstream. When pulling upstream into either install, re-apply these:

1. **`container/agent-runner/src/providers/claude.ts`** — two edits, canonical copy at `operator/overlay/agent-runner-src/providers/claude.ts`:
   - Change `settingSources: ['project', 'user']` to `settingSources: ['project', 'user', 'local']`. Without this, `CLAUDE.local.md` (the per-bot persona) is invisible to the SDK.
   - The `compact_boundary` system event must yield `progress` (logs only), **not** `result` (which posts to Discord). Without this fix, every SDK auto-compaction posts a "Context compacted (NNN tokens compacted)" message into the user's channel.
2. **`container/agent-runner/src/formatter.ts`** — copy from `operator/overlay/agent-runner-src/formatter.ts`. Adds a `<routing reply_to_channel="..." />` tag to the prompt header so post-compact summaries can't strip channel context. Without this, after auto-compaction the agent loses track of which channel the conversation originated in and defaults to whichever destination its persona names most prominently (e.g. `#main`).
3. **`container/agent-runner/src/attachment-preprocessor.ts`** — copy from operator repo `operator/overlay/` (or from the other install).
4. **`container/agent-runner/src/poll-loop.ts`** — add `import { preprocessAttachments } from './attachment-preprocessor.js';` and call `await preprocessAttachments(keep)` before `formatMessagesWithCommands(keep, ...)` in the initial-batch path, and `await preprocessAttachments(newMessages)` before `formatMessages(newMessages)` in the follow-up path. Make the `setInterval(() => {})` callback `async`.
5. **`container/agent-runner/src/mcp-tools/recall.ts`** — copy from `operator/overlay/`. Add `import './recall.js';` to `container/agent-runner/src/mcp-tools/index.ts`.
6. **`container/Dockerfile`** — add `openssh-client poppler-utils python3` to the apt deps. Add `RUN chmod 666 /etc/passwd`. Add `COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader` + `COPY skills/brave-search/brave-search /usr/local/bin/brave-search` + `RUN chmod +x /usr/local/bin/pdf-reader /usr/local/bin/brave-search`. (Andy only — Milton just needs `poppler-utils` + pdf-reader.)
7. **`container/skills/pdf-reader/`** + **`container/skills/brave-search/`** — copy binaries from `operator/overlay/`.
8. **`container/entrypoint.sh`** — Andy only. Adds andy-ssh key copying + git identity. Copy from `operator/overlay/`.
9. **`src/channels/chat-sdk-bridge.ts`** — copy from `overlay/host-src/channels/chat-sdk-bridge.ts`. Two host-side bridge fixes:
   - Adds `url: att.url` to the inbound attachment entry. Without this, Discord image/PDF attachments arrive in messages_in with neither `data` nor `url` (because `@chat-adapter/discord` doesn't implement `fetchData()` on attachments), so the container preprocessor has nothing to save and the agent renders `[image: name.png]` with no path. With the URL passed through, the container's existing URL-fetch fallback in `attachment-preprocessor.ts` handles the download.
   - Strips the internal `:ag-<groupId>` suffix from `messageId` before passing to `adapter.editMessage` / `adapter.addReaction`. `router.ts:messageIdForAgent` appends that suffix for cross-session uniqueness in `messages_in.id`, but the platform doesn't accept it (Discord rejects it as not a snowflake — 400 Invalid Form Body). Reactions/edits would silently fail before this fix; only the host error log captured the failure, the agent saw "queued".
   After applying, run `pnpm build` on the host (no container rebuild needed). Both bots' bridges should match — apply identically.
10. **`container/agent-runner/src/providers/gemini.ts`** — Andy only (Milton stays on Claude). Copy from `overlay/agent-runner-src/providers/gemini.ts`. Custom Gemini provider that translates the Anthropic-style event stream into Gemini's `Content[]` format, runs the function-calling loop against the same MCP servers Claude would use, inlines image attachments as `inlineData` Parts for vision, sanitizes JSON Schema for Gemini's stricter parameters validator, and routes tool calls via a flat-name fallback (Gemini sometimes drops the `server__` prefix when emitting function names — `brave_search__brave_web_search` arrives as `brave_web_search`). Also calls `setContainerToolInFlight` / `clearContainerToolInFlight` so host-sweep doesn't kill long Gemini tool calls. Append `import './gemini.js';` to `container/agent-runner/src/providers/index.ts`.
11. **Host-side `model` plumbing** — Andy only. Five small additions thread the `model` field from `container.json` through to the provider:
    - `container/agent-runner/src/providers/types.ts` — add `model?: string` to `QueryInput`.
    - `container/agent-runner/src/config.ts` — add `model?: string` to `RunnerConfig`, load from raw config.
    - `container/agent-runner/src/poll-loop.ts` — add `model?: string` to `PollLoopConfig`, pass `model: config.model` in the `provider.query()` call.
    - `container/agent-runner/src/index.ts` — pass `model: config.model` into `runPollLoop({...})`.
    - This is what lets each agent group declare `"model": "gemini-2.5-flash"` (or `gemini-2.5-pro`, etc.) in its own `container.json` instead of hardcoding in `gemini.ts`.
12. **`container/agent-runner/src/mcp-tools/bash.ts`** + **`bash.instructions.md`** — Andy only (Gemini provider doesn't ship a built-in Bash tool, unlike the Claude SDK). Copy from `overlay/agent-runner-src/mcp-tools/`. Adds an `mcp__nanoclaw__bash` tool that spawns `bash -c "<command>"` inside the container, streams capped (64KB) stdout/stderr back, and supports configurable cwd + timeout. Append `import './bash.js';` to `container/agent-runner/src/mcp-tools/index.ts`. The instructions fragment is auto-discovered by `claude-md-compose.ts` and surfaces persona-level command bans (no `rm`, no destructive git). Drop this overlay item if Andy ever moves back to Claude.
13. **`container/agent-runner/src/providers/gemini-v2.ts`** + **`@google/genai` dep** — Andy only. Copy from `overlay/agent-runner-src/providers/gemini-v2.ts`. Replacement Gemini provider built on the supported `@google/genai` SDK (the older `@google/generative-ai` powering item #10 is officially deprecated). Registers as the `gemini-v2` provider. Why migrate: only `@google/genai` exposes a unified `Tool` interface where `functionDeclarations` and `googleSearch` co-exist on the same object, which is how Gemini 2.5 mixes its built-in web grounding with custom function calling. The legacy SDK keeps them as separate `Tool` variants and only ships the Gemini 1.5-era `googleSearchRetrieval`. Wiring: `cd container/agent-runner && bun add @google/genai`, then append `import './gemini-v2.js';` to `container/agent-runner/src/providers/index.ts`. Container rebuild required (deps baked into image at build time). Once stable, the legacy `gemini.ts` (item #10) can be retired alongside the `@google/generative-ai` dep, but keep both in place for now as a one-flag rollback (`provider: "gemini"`).

## Andy-Only Configuration

- `groups/dm-with-kyle/container.json` — `provider: "gemini-v2"`, `model: "gemini-2.5-flash"` (migrated to v2 / `@google/genai` on 2026-04-30). 4 MCP servers (google_calendar, google_drive, gmail, github) and 8 mounts (home, andy-ssh, 3 google config dirs, piCloud, srv-shiny-server, srv-slides). `brave_search` was dropped when v2 enabled built-in `googleSearch` grounding.
- `groups/dm-with-kyle/CLAUDE.local.md` — persona (~297 lines including Channel Hats). Currently the Claude-tuned version is live; a Gemini-tuned draft sits alongside it as `CLAUDE.local.md.gemini-draft.md` pending Kyle's review. Swap by `mv` and wiping `session_state` in every `outbound.db` under `data/v2-sessions/ag-1777305993631-dasks9/sess-*/`.
- `groups/dm-with-kyle/memory/` — 7 memory files (family, infrastructure, channels, etc.).
- `groups/dm-with-kyle/scripts/doc-check.sh` — daily drift audit script.

### Gemini provider notes

- Andy switched from Claude → Gemini on 2026-04-30 (initial migration on `gemini` / `@google/generative-ai`), then upgraded same-day to `gemini-v2` / `@google/genai` to unlock `googleSearch` grounding alongside MCP function calling. Milton stays on Claude (legal-paralegal work, fewer reasons to disrupt).
- `GEMINI_API_KEY` must be in OneCLI vault (or as a fallback in `~/nanoclaw-andy/.env`).
- Two rollback paths sit in place: flip `provider: "gemini"` (legacy `@google/generative-ai`) or `provider: "claude"` (Anthropic SDK) in `container.json`, wipe `session_state`, and you're back. Plan to prune both legacy paths ~1 week into stable v2 operation, in this order: drop `gemini.ts` + `@google/generative-ai` first (the `gemini-v2` migration is the most recent and most likely to need fast revert), then `claude.ts` + `@anthropic-ai/claude-agent-sdk`.
- Per-channel model selection isn't possible while all 7 channels share the `dm-with-kyle` agent group. If you ever want Pro for `#typescript-learning` and Flash for `#weather`, you'd need to split agent groups (and migrate the relevant scheduled tasks at the same time).

## Milton-Only Configuration

- `groups/dm-with-alexa/CLAUDE.local.md` — paralegal persona (~100 lines).
- `groups/dm-with-alexa/container.json` — empty (no MCPs, no mounts).

## Backups

~~The pre-migration tar lives at `/mnt/piCloud/nanoclaw-backups/nanoclaw-pre-migrate-2026-04-27T152439Z.tar.gz` (100MB). It contains the full legacy `~/nanoclaw/` state at the moment we began this rebuild — including the original `groups/`, `data/`, `.env`. Recovery is `tar -xzf` somewhere safe, then cherry-pick what's needed.~~ _(Yeeted 2026-04-28 — Kyle ditched the pre-migrate snapshot early. Local `~/nanoclaw-snapshots/` and the piCloud copies are gone. No recovery path from this point.)_

The plan file that drove this rebuild is at `~/.claude/plans/this-repo-has-really-federated-kay.md`.

## OneCLI

OneCLI Agent Vault runs at `http://172.17.0.1:10254`. Both bots' agents are registered in `mode all` so any vault secret with a matching host pattern is available to them. Manage at the web UI or via:

```bash
onecli agents list
onecli secrets list
```

## Operator Helpers

Scripts under `operator/` for routine tasks. Currently:

- `operator/bots-status.sh` — quick status check for both services + Discord connection.

## Editing Personas

Persona files live in each install's `groups/<folder>/CLAUDE.local.md`:

- Andy: `~/nanoclaw-andy/groups/dm-with-kyle/CLAUDE.local.md`
- Milton: `~/nanoclaw-milton/groups/dm-with-alexa/CLAUDE.local.md`

After editing a persona, you must wipe the SDK session caches so the next message picks up the change:

```bash
INSTALL=~/nanoclaw-andy        # or ~/nanoclaw-milton
AG=$(sqlite3 $INSTALL/data/v2.db "SELECT id FROM agent_groups LIMIT 1;")
for db in $INSTALL/data/v2-sessions/*/sess-*/outbound.db; do
  sqlite3 "$db" "DELETE FROM session_state;"
done
trash-put $INSTALL/data/v2-sessions/$AG/.claude-shared/projects 2>/dev/null
trash-put $INSTALL/data/v2-sessions/$AG/.claude-shared/sessions 2>/dev/null
mkdir -p $INSTALL/data/v2-sessions/$AG/.claude-shared/{projects,sessions}
```

Without that wipe, the SDK resumes the prior conversation with the OLD system prompt frozen in.

## Updating Upstream

When `qwibitai/nanoclaw` ships meaningful changes:

1. Decide whether to pull (read upstream's CHANGELOG first).
2. In the bot's install: `git pull upstream main` (resolve conflicts conservatively).
3. Re-apply the overlay items listed above.
4. Rebuild the container: `cd ~/nanoclaw-<bot> && ./container/build.sh`.
5. Restart: `systemctl --user restart nanoclaw-v2-<slug>`.
6. Test in the bot's primary channel.

Avoid pulling upstream casually — every pull is a small reapplication tax. Pull when there's a fix or feature you actually want.

## Hard Rules

- **Don't run NanoClaw from this repo.** It's not an install.
- **Don't `git push` to either install's remote** unless you have a deliberate reason. Both installs are intended as pure-upstream + private overlay; pushing your overlay back upstream would leak host-specific paths and credentials patterns.
- ~~**Don't delete the piCloud backup** without first confirming both bots have at least 30 days of healthy operation on the new installs.~~ _(Rule yeeted 2026-04-28 with the backup itself.)_
