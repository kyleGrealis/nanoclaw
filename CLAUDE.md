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
9. **`src/channels/chat-sdk-bridge.ts`** — copy from `operator/overlay/host-src/channels/chat-sdk-bridge.ts`. Adds `url: att.url` to the inbound attachment entry. Without this, Discord image/PDF attachments arrive in messages_in with neither `data` nor `url` (because `@chat-adapter/discord` doesn't implement `fetchData()` on attachments), so the container preprocessor has nothing to save and the agent renders `[image: name.png]` with no path. With the URL passed through, the container's existing URL-fetch fallback in `attachment-preprocessor.ts` handles the download. After applying, run `pnpm build` on the host (no container rebuild needed).

## Andy-Only Configuration

- `groups/dm-with-kyle/container.json` — 5 MCP servers (google_calendar, google_drive, gmail, github, brave_search) and 6 mounts (home, andy-ssh, 3 google config dirs, piCloud).
- `groups/dm-with-kyle/CLAUDE.local.md` — persona (~285 lines including Channel Hats).
- `groups/dm-with-kyle/memory/` — 7 memory files (family, infrastructure, channels, etc.).
- `groups/dm-with-kyle/scripts/doc-check.sh` — daily drift audit script.

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
