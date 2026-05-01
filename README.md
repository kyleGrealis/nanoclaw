# Operator Repo

Control hub for two NanoClaw bots running on Pi5 (`rasparch` / `archpi5`):

- **Andy** at `~/nanoclaw-andy/` — Kyle's personal assistant. Discord app `NanoClaw-Andy`. 7 channels (DM-with-Kyle, #main, #weather, #typescript-learning, #logs-and-issues, #devops, #misc). Currently running on **Gemini 3 Flash Preview** via the `@google/genai` SDK with combined function calling + Google Search grounding.
- **Milton** at `~/nanoclaw-milton/` — Alexa's paralegal. Discord app `NanoClaw-Milton`. 1 channel (#milton). Stays on **Claude** via the Anthropic Agent SDK (legal-paralegal work, no reason to disrupt).

This repo holds operator instructions, an overlay reference for re-applying customizations after upstream pulls, and helper scripts. **It is not a NanoClaw install** — `pnpm install` here will do nothing useful, and you should never `git clone` upstream into this directory.

```
operator/         helper scripts (status checks, etc.)
overlay/          source files / patches to re-apply after upstream pulls
  agent-runner-src/  → goes to <install>/container/agent-runner/src/
  host-src/          → goes to <install>/src/
CLAUDE.md         operator playbook (Claude Code reads this — exhaustive)
GEMINI.md         Gemini CLI's view of this repo (compact)
README.md         this file
```

## Quick reference

```bash
# Status of both bots
operator/bots-status.sh

# Restart
systemctl --user restart nanoclaw-v2-930d9414   # Andy
systemctl --user restart nanoclaw-v2-952bb239   # Milton

# Tail live
tail -f ~/nanoclaw-andy/logs/nanoclaw.log
tail -f ~/nanoclaw-milton/logs/nanoclaw.log
```

To touch a bot's actual code, `cd ~/nanoclaw-andy/` (or milton). Do **not** modify a bot directly from this repo — modify the install, then sync the change back here as an overlay file so the next upstream pull can re-apply it.

## Architecture at a glance

```
Discord ──► chat-sdk-bridge (host) ──► inbound.db (per session)
                                            │
                                            ▼
                       agent-runner container (per session, ephemeral)
                       ┌────────────────────────────────────────────┐
                       │  /app/src        (mounted RO from host)    │
                       │  /workspace      (session: in/out + state) │
                       │  /workspace/agent (group: persona, memory) │
                       │  /workspace/extra/<name> (per container.json) │
                       └────────────────────────────────────────────┘
                                            │
                       ┌────────────────────┴───────────────────────┐
                       ▼                                            ▼
                Provider (Gemini-v2 / Claude / Mock)         MCP servers
                  + native googleSearch (Gemini)               google_calendar
                  + per-Tool functionDeclarations              google_drive
                  + inlineData parts (vision)                   gmail / github
                                                                + in-house tools:
                                                                  recall, bash,
                                                                  update_memory,
                                                                  dispatch (scaffold),
                                                                  send_message, …
                                            │
                                            ▼
                                     outbound.db ──► host delivery ──► Discord
```

OneCLI Agent Vault sits at `http://172.17.0.1:10254` and proxies API auth (Anthropic / Gemini / GitHub / Google). The container never sees raw `.env` secrets.

## Overlay system

`overlay/` is the **golden copy** of every customization that lives on top of upstream NanoClaw. After a `git pull upstream main` in either install, every file under `overlay/` needs to be re-applied to the matching path in the install. `CLAUDE.md` enumerates each item with a number, the path it lands at, and the rationale — the list grows over time, currently at item #15.

Highlights:

- **`overlay/agent-runner-src/providers/gemini-v2.ts`** — canonical Gemini provider on the supported `@google/genai` SDK (the older `@google/generative-ai` is deprecated). Combines `functionDeclarations` + `googleSearch` on Gemini 3, requires `toolConfig: { includeServerSideToolInvocations: true }`.
- **`overlay/host-src/providers/gemini-v2.ts`** — host-side env passthrough so `GEMINI_API_KEY` lands in the container. Without this matching pair on both sides, the container exits code=1 in 2 seconds with no useful host log.
- **`overlay/agent-runner-src/mcp-tools/bash.ts`** — `mcp__nanoclaw__bash` with a 16-rule deterministic OPSEC deny-list (no `rm`, no destructive git, no `trash-empty`, no recursive perms, no exfil-style curl). Fills the gap left by the Anthropic SDK's built-in Bash being unavailable under Gemini.
- **`overlay/agent-runner-src/mcp-tools/update-memory.ts`** — atomic structured writes to `memory/*.md` so `recall` always sees a consistent corpus.
- **`overlay/agent-runner-src/mcp-tools/dispatch.ts`** — scaffolded orchestrator → ephemeral worker dispatch. Tool signature is final; host-side spawner is not yet wired.
- **`overlay/agent-runner-src/mcp-tools/recall.ts`** — searches structured memory at `/workspace/agent/memory/*.md`. Path was previously `/workspace/group/memory` and silently failed on every call until 2026-04-30.
- **`overlay/host-src/channels/chat-sdk-bridge.ts`** — strips the internal `:ag-<groupId>` suffix from message ids before edit/reaction calls hit Discord (without it, reactions silently fail with HTTP 400). Also forwards inbound attachment URLs so vision works.

Read `CLAUDE.md` for the exhaustive list with the order to apply.

## Hard rules

- **Never run NanoClaw from this repo.** It's not an install. No `pnpm install`, no `./container/build.sh`.
- **Never `git push` either install's remote.** Both installs are pure-upstream + private overlay; pushing your overlay back upstream would leak host-specific paths and credentials patterns.
- **Never run destructive git ops** in any agent-controlled path — and now also enforced in the bash MCP tool (`reset --hard`, `clean -fxd`, `checkout -- .`, `restore .`, `stash drop`, `branch -D`, bare `push --force` are all blocked at the tool layer, not just persona advice).
- **Use `trash-put`, never `rm`.** The bash tool blocks raw `rm` and protects the trash from being emptied — this is non-negotiable so deletes stay recoverable.

## Backups

`~/nanoclaw-andy/.backups/` holds occasional pre-change tar snapshots (excluding `node_modules`). Same intent for milton when needed. The pre-migration tarball from 2026-04-27 was deleted on 2026-04-28 — there is no recovery path before the install split.
