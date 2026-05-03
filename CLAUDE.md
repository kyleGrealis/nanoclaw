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
6. **`container/Dockerfile`** — add `openssh-client poppler-utils python3` to the apt deps. Add `RUN chmod 666 /etc/passwd`. Add `COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader` + `RUN chmod +x /usr/local/bin/pdf-reader`. (Andy only — Milton just needs `poppler-utils` + pdf-reader.)
7. **`container/skills/pdf-reader/`** — copy binary from `operator/overlay/`.
8. **`container/agent-runner/src/bootstrap-env.ts`** — Andy only. Copy from `overlay/agent-runner-src/bootstrap-env.ts`. Runs at the very top of `container/agent-runner/src/index.ts` (add `import './bootstrap-env.js';` as the first import, before any other module loads). Three blocks, each wrapped in try/catch so a single failure doesn't block startup:
    - Registers the container's runtime uid in `/etc/passwd` (Docker user-namespace mapping can hand us an arbitrary uid; SSH's `getpwuid()` needs a passwd entry to resolve `$HOME`).
    - Copies the andy-ssh keypair + config from the read-only `/workspace/extra/andy-ssh` mount into `~/.ssh/` with correct perms (700 dir, 600 keys, 644 known_hosts).
    - Sets the global git identity (`user.email` + `user.name` = Kyle Grealis) so commits don't fail "Author identity unknown."

    History note: this work used to live in `container/entrypoint.sh`, but the host's container-runner overrides Docker's ENTRYPOINT with `bash -c "exec bun ..."`, so entrypoint.sh never actually executed. Ported into the runner src on 2026-05-02. `container/entrypoint.sh` is now back to upstream baseline (no Andy diff) and the operator overlay copy was deleted.
9. **`src/channels/chat-sdk-bridge.ts`** — copy from `overlay/host-src/channels/chat-sdk-bridge.ts`. Two host-side bridge fixes:
   - Adds `url: att.url` to the inbound attachment entry. Without this, Discord image/PDF attachments arrive in messages_in with neither `data` nor `url` (because `@chat-adapter/discord` doesn't implement `fetchData()` on attachments), so the container preprocessor has nothing to save and the agent renders `[image: name.png]` with no path. With the URL passed through, the container's existing URL-fetch fallback in `attachment-preprocessor.ts` handles the download.
   - Strips the internal `:ag-<groupId>` suffix from `messageId` before passing to `adapter.editMessage` / `adapter.addReaction`. `router.ts:messageIdForAgent` appends that suffix for cross-session uniqueness in `messages_in.id`, but the platform doesn't accept it (Discord rejects it as not a snowflake — 400 Invalid Form Body). Reactions/edits would silently fail before this fix; only the host error log captured the failure, the agent saw "queued".
   After applying, run `pnpm build` on the host (no container rebuild needed). Both bots' bridges should match — apply identically.
10. **Host-side `model` plumbing** — Andy only. Five small additions thread the `model` field from `container.json` through to the provider:
    - `container/agent-runner/src/providers/types.ts` — add `model?: string` to `QueryInput`.
    - `container/agent-runner/src/config.ts` — add `model?: string` to `RunnerConfig`, load from raw config.
    - `container/agent-runner/src/poll-loop.ts` — add `model?: string` to `PollLoopConfig`, pass `model: config.model` in the `provider.query()` call.
    - `container/agent-runner/src/index.ts` — pass `model: config.model` into `runPollLoop({...})`.
    - This is what lets each agent group declare `"model": "gemini-3-flash-preview"` (or `gemini-3-pro-preview`, etc.) in its own `container.json` instead of hardcoding in the provider.
11. **`container/agent-runner/src/mcp-tools/bash.ts`** + **`bash.instructions.md`** — Andy only (Gemini provider doesn't ship a built-in Bash tool, unlike the Claude SDK). Copy from `overlay/agent-runner-src/mcp-tools/`. Adds an `mcp__nanoclaw__bash` tool that spawns `bash -c "<command>"` inside the container, streams capped (64KB) stdout/stderr back, and supports configurable cwd + timeout. Append `import './bash.js';` to `container/agent-runner/src/mcp-tools/index.ts`.

    **Includes a deterministic Host OPSEC deny-list** (defense-in-depth, not just persona advice): `rm` is banned outright (use `trash-put`), `trash-empty`/`trash-rm`/`gio trash --empty` blocked (recoverability is non-negotiable), the full destructive-git list per `feedback_no_destructive_git` (`reset --hard`, `clean -f[dx]`, `checkout -- ...` / `checkout .`, `restore .`, `stash drop|clear`, `branch -D`, bare `push --force` — `--force-with-lease` and lowercase `-d` pass), recursive `chmod`/`chown`, `mkfs.*`, `dd if=/dev/.../of=/dev/...`, redirects to block devices, and `curl`/`wget` to bare public-IPv4 literals (exfil pattern; private IPs and domain names pass). Each rule returns a structured `Error: Execution blocked by Host OPSEC policy` with rule name, matched substring, reason, and a safer-alternative suggestion so the model routes around. Tested against 49 representative inputs (block + pass cases). Drop this overlay item if Andy ever moves back to Claude.
12. **`container/agent-runner/src/providers/gemini.ts`** + **`src/providers/gemini.ts`** + **`@google/genai` dep** — Andy only. The Gemini provider built on the supported `@google/genai` SDK. Registers as the `gemini` provider. Why this SDK: only `@google/genai` exposes a unified `Tool` interface where `functionDeclarations` and `googleSearch` co-exist on the same object, which is how Gemini 3 mixes built-in web grounding with custom function calling.

    Wiring is **two files, both required** (this is a footgun — the container side alone gets you a 2-second exit loop with nothing useful in the host log because the agent-runner crashes before it can write its error anywhere visible):
    - `container/agent-runner/src/providers/gemini.ts` (copy from `overlay/agent-runner-src/providers/gemini.ts`) — the actual provider class. Append `import './gemini.js';` to `container/agent-runner/src/providers/index.ts`. Then `cd container/agent-runner && bun add @google/genai` and rebuild the container image.
    - `src/providers/gemini.ts` (copy from `overlay/host-src/providers/gemini.ts`) — the **host-side** provider-container-registry entry that pushes `GEMINI_API_KEY` into the container env at spawn time. Append `import './gemini.js';` to `src/providers/index.ts`. Then `pnpm build` on the host.

    Why both: provider names are an open registry on both sides. The host's `provider-container-registry` is keyed by the same string container.json uses (`provider: "gemini"`). Without the host-side entry, the host wouldn't push the API key into the container env, and the provider's constructor would throw "GEMINI_API_KEY is not set" the moment agent-runner tried to instantiate it.

    Naming history: originally registered as `gemini-v2` while the legacy `@google/generative-ai`-based `gemini` provider sat alongside it as a rollback path. Legacy was retired 2026-05-02 once `#gemini-lab` (its only consumer) was torn down; v2 was renamed back to plain `gemini` the same day.

    Rollback path: if `gemini` ever needs a fast escape, flip `container.json` to `provider: "claude"` (overlay item #1 keeps that path alive) and wipe `session_state`.
13. **`container/agent-runner/src/mcp-tools/update-memory.ts`** + **`update-memory.instructions.md`** — Andy only. Structured atomic writes to `/workspace/agent/memory/*.md`, the same corpus `recall` reads. Operations: `append_section`, `update_section`, `remove_section`, `touch_verified`. Every successful op auto-bumps `verified-on:` to today. Atomic via temp-file + rename so concurrent `recall` reads never see a half-written file. Replaces brittle `bash >> memory/foo.md` patterns. Append `import './update-memory.js';` to `container/agent-runner/src/mcp-tools/index.ts`. Compatible with the existing 10 memory files Andy already has — frontmatter retrofit applied to `future-topics.md` and `typescript-curriculum.md` so all 10 parse cleanly.
14. **Dispatch system — orchestrator → ephemeral worker, end-to-end wired 2026-05-02.** Andy only. Six pieces:
    - **`container/agent-runner/src/mcp-tools/dispatch.ts`** — orchestrator-side tool. Andy calls it with `{ brief, scope, expected, timeoutMs? }` and gets a `task_id` back synchronously. Writes `kind=system, action=dispatch_task` row to outbound for the host handler to pick up.
    - **`container/agent-runner/src/mcp-tools/complete-task.ts`** + **`task-progress.ts`** — worker-side tools. Worker emits zero-or-more `task_progress(text)` updates and exactly one `complete_task(summary)` to terminate. Both write `kind=system` rows the host catches.
    - **`src/modules/dispatch/`** (host module) — six files: `state.ts` (in-memory `taskId ↔ workerSession` map), `scope-config.ts` (load `dispatch-scopes/<scope>/`), `worker-spawn.ts` (creates ephemeral agent_group + session, copies scope template into `groups/dispatch-worker-<taskId>/`, pre-populates inbound with the brief, calls `wakeContainer`), `worker-cleanup.ts` (kills container, deletes DB rows, trash-puts folder), `forward.ts` (writes `<dispatch_progress>` / `<dispatch_result>` tagged messages to parent inbound), `kevlar.ts` (30s tick: timeout enforcement, exit-without-result detection, boot-time orphan scrub), `index.ts` (registers the three delivery actions). Append `import './dispatch/index.js';` to `src/modules/index.ts`.
    - **`dispatch-scopes/<scope>/`** — four scope templates, each with `CLAUDE.md` + `container.json`: `research` (Gemini 3 Pro + built-in googleSearch + RO `/home/kyle`), `devops` (Flash + bash + ssh keys + `/home/kyle`), `data` (Flash + RO `/home/kyle` + RW `/mnt/piCloud`), `plain` (Flash + bash only). Worker personas explicitly forbid `send_message`, `schedule_task`, `dispatch_task`, etc. — workers have no chat channel, no recursion, no memory.
    - **Wire bug to watch for**: worker folder name MUST be a single segment (`dispatch-worker-<taskId>`), not nested (`dispatch-workers/<taskId>`). Container-runner builds the docker container name as `nanoclaw-v2-${folder}-${ts}`, and docker rejects names containing `/` with exit code 125 — every worker insta-died until this was flattened.
    - **Kevlar limits**: `MAX_CONCURRENT_PER_PARENT=3`, `DEFAULT_TIMEOUT_MS=5min`, `MAX_TIMEOUT_MS=30min`. Kevlar tick fires 5s after host boot (deferred so DB is initialized) and every 30s after.
15. **`container/agent-runner/src/mcp-tools/core.ts`** — Andy only for now (Milton not yet patched). Copy from `overlay/agent-runner-src/mcp-tools/core.ts`. Strips `<internal>...</internal>` from the `text` argument inside `send_message`, `send_file`, and `edit_message` before it hits `messages_out`. Without this, Gemini's habit of wrapping its prelude reasoning in `<internal>` tags *inside* the tool argument bypasses `formatter.ts:stripInternalTags` (which only runs on the model's free-text output, not on tool-arg text) and the scratchpad gets posted to Discord verbatim. Observed in #misc on 2026-05-02 (USATF rulebook reply led with the entire `<internal>` block). The persona at `groups/dm-with-kyle/CLAUDE.local.md:130-138` promises `<internal>` is "logged but not sent" — this overlay item is what makes that promise true on tool-arg text. If stripping yields empty text, the tool returns an error instead of silently posting whitespace (or wiping the original on `edit_message`), so the model gets a clear signal to put user-facing content outside the tags. Drop into Milton if Claude ever starts doing the same thing.

## Andy-Only Configuration

- `groups/dm-with-kyle/container.json` — `provider: "gemini"`, `model: "gemini-3-flash-preview"` (migrated from `@google/generative-ai` to `@google/genai` on 2026-04-30, bumped from 2.5-flash → 3-flash-preview same day, renamed from transient `gemini-v2` back to `gemini` on 2026-05-02). 4 MCP servers (google_calendar, google_drive, gmail, github) and 8 mounts (home, andy-ssh, 3 google config dirs, piCloud, srv-shiny-server, srv-slides). `brave_search` was dropped when built-in `googleSearch` grounding came online; the OneCLI Brave secret was deleted 2026-05-02.

  Why 3-flash-preview, not 2.5-flash: Gemini 2.5 enforces mutual exclusivity at the API endpoint between `googleSearch` grounding and `functionDeclarations` — the request returns HTTP 400 with `"Built-in tools ({google_search}) and Function Calling cannot be combined in the same request"`. Gemini 3 explicitly lifts that constraint (per `ai.google.dev/gemini-api/docs/gemini-3`: *"Gemini 3 allows the use of built-in tools (like Google Search, URL context, and more) and custom function calling tools in the same API call"*). The `-preview` suffix sticks around in the API model ID even though Google has put 3 Flash on the main release channel; ignore it. If the constraint were ever to come back, you'd need to either drop `googleSearch` from the v2 provider or recreate a Brave secret in OneCLI and re-add `brave_search` to container.json.

  **Required when combining built-in tools with function calling on Gemini 3:** the chat-creation config must include `toolConfig: { includeServerSideToolInvocations: true }`. Without that flag, the API returns HTTP 400 with `"Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling."` This is *not* in the public Gemini 3 example for combined tools, but is enforced server-side. `gemini-v2.ts` sets it unconditionally (it's a no-op when only one tool type is in play). The public docs page covering this is the JS reference for `ToolConfig` in `@google/genai`, not the Gemini 3 dev guide.
- `groups/dm-with-kyle/CLAUDE.local.md` — persona (~297 lines including Channel Hats).
- `groups/dm-with-kyle/memory/` — 7 memory files (family, infrastructure, channels, etc.).
- `groups/dm-with-kyle/scripts/doc-check.sh` — daily drift audit script.

### Gemini provider notes

- Andy switched from Claude → Gemini on 2026-04-30 (initial migration on `@google/generative-ai`), then upgraded same-day to `@google/genai` to unlock `googleSearch` grounding alongside MCP function calling. Milton stays on Claude (legal-paralegal work, fewer reasons to disrupt). Legacy `@google/generative-ai` SDK was retired 2026-05-02 once `#gemini-lab` was torn down (the only consumer).
- `GEMINI_API_KEY` must be in OneCLI vault (or as a fallback in `~/nanoclaw-andy/.env`).
- One rollback path remains: flip `provider: "claude"` (Anthropic SDK) in `container.json`, wipe `session_state`, and you're back on Claude. Overlay item #1 keeps that path alive.
- Per-channel model selection isn't possible while all 6 channels share the `dm-with-kyle` agent group. If you ever want Pro for `#typescript-learning` and Flash for `#weather`, you'd need to split agent groups (and migrate the relevant scheduled tasks at the same time).

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
