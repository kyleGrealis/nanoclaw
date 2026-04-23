# Core src changes + TUI mode

## Core src changes

### src/logger.ts — pino migration

**Intent:** Replace v1's custom logger with `pino`. Better structured logging; file persistence for TUI debugging via `NANOCLAW_LOG_DIR`.

**v2 check first:** `upstream/v2:src/logger.ts` may already use pino. If yes, this whole section is a no-op (celebrate and move on). If no, apply this migration.

**Apply:**
```bash
# Add deps (already in v1 package.json):
npm install pino@^9.6.0 pino-pretty@^13.0.0
```

v1's logger exports a configured pino instance. In TUI mode (`NANOCLAW_TUI=1`), log output is redirected to a timestamped file (`logs/run/nanoclaw-<timestamp>.log`) so the terminal UI isn't clobbered by log lines.

---

### src/config.ts — MAIN_GROUP_FOLDER constant

Add a single constant used by TUI mode:
```typescript
export const MAIN_GROUP_FOLDER = 'main';
```
Other config changes: none (the trigger pattern, poll interval, etc. are unchanged).

---

### src/types.ts — interface extensions

Two additions:

```typescript
// For bot_token_ref multi-instance (see discord-features.md)
export interface RegisteredGroup {
  // ... existing fields ...
  botTokenRef?: string;   // Maps to DISCORD_BOT_TOKEN_<LABEL>
}

// For progressive reveal (see discord-features.md)
export interface Channel {
  // ... existing fields ...
  streamMessage?(jid: string, text: string): Promise<void>;
}
```

In v2, `RegisteredGroup` is replaced by the new entity model (`agent_groups` + `messaging_groups`). The `botTokenRef` field goes on the v2 `MessagingGroup` type.

---

### src/db.ts — bot_token_ref schema + ops

See [discord-features.md § bot_token_ref](discord-features.md#a-bot_token_ref-multi-instance-ad72d81) for the full schema migration and read/write patterns. In v2 this is a dedicated module migration file in `src/db/migrations/`, not an inline ALTER.

---

### src/router.ts — parseTextStyles call

Added by the `channel-formatting` skill merge. In `formatOutbound()`, messages are run through `parseTextStyles()` from `src/text-styles.ts` so Markdown is converted to each channel's native syntax (WhatsApp `*bold*`, Slack mrkdwn, etc.).

**v2:** the `channel-formatting` skill is re-merged first (see [index.md](index.md) § Applied skills), so this is automatically restored. Verify the `formatOutbound()` hook point still exists in v2.

---

### src/container-runner.ts — imageAttachments + Google Calendar mount

Two additions:

1. **imageAttachments in ContainerInput** — see [discord-features.md § Image vision](discord-features.md#f-image-vision-809cafa-0c9c579-7847297).

2. **Google Calendar mount** — see [container-infrastructure.md § Google Calendar MCP](container-infrastructure.md#3-google-calendar-mcp-direct-node-fix).

---

### src/channels/index.ts and src/channels/registry.ts

- **`index.ts`:** v1 uncommented the Discord channel import. In v2, Discord is re-installed via `/add-discord` which should wire the import for us.
- **`registry.ts`:** `ChannelFactory` return type widened to `Channel | Channel[] | null` to support multi-instance Discord (bot_token_ref). In v2, verify the factory return type — if already `Channel | Channel[] | null`, no change needed; otherwise widen it.

---

### src/index.ts — several threading changes

Change types to preserve:

1. **Session command interception** (`handleSessionCommand`) before the trigger check — added by `compact` skill merge. Preserved by re-merging the skill.

2. **Image attachment parsing + threading** — `parseImageReferences(missedMessages)` then pass `imageAttachments` through `runAgent`. See [discord-features.md § Image vision](discord-features.md#f-image-vision-809cafa-0c9c579-7847297).

3. **Typing pulse controller** — see [discord-features.md § typing-pulse](discord-features.md#d-typing-pulse-stop-on-agent-turn-end-805b777).

4. **Channel startup loop supports arrays** — `result = factory(opts); instances = Array.isArray(result) ? result : [result]`. See [discord-features.md § bot_token_ref](discord-features.md#a-bot_token_ref-multi-instance-ad72d81).

5. **`streamMessage` fallback** — `channel.streamMessage ?? channel.sendMessage` when dispatching outbound.

6. **Co-Authored-By: Claude trailers removed** — never emit these in commit messages produced by the agent. (Related: the commit-message hook enforces this.)

---

### tsconfig.json

Add one option:
```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx"
  }
}
```
Required for TUI (Ink + React).

---

### package.json

**Dependencies to ensure (v2 may already have some):**
```jsonc
{
  "dependencies": {
    "discord.js": "^14.18.0",          // via /add-discord
    "ink": "^6.8.0",                   // TUI
    "react": "^19.2.4",                // TUI
    "@types/react": "^19.2.14",        // TUI
    "pino": "^9.6.0",                  // logger
    "pino-pretty": "^13.0.0",
    "qrcode": "^1.5.4",                // WhatsApp auth (if you add WA later)
    "qrcode-terminal": "^0.12.0",
    "sharp": "^0.34.5",                // image vision
    "yaml": "^2.8.2",
    "zod": "^4.3.6"
  }
}
```

**Scripts to add:**
```jsonc
{
  "scripts": {
    "tui": "NANOCLAW_TUI=1 tsx src/tui-main.ts",
    "format": "prettier --write \"src/**/*.{ts,tsx}\""
  }
}
```

---

### .env.example

Add:
```
DISCORD_BOT_TOKEN=
# Per-group bot identities — one env var per ref used in messaging_groups.bot_token_ref
# e.g. DISCORD_BOT_TOKEN_MILTON= for the #milton channel
OPENAI_API_KEY=    # For voice transcription (Whisper)
```

### .gitignore

Add:
```
# Claude Code per-machine settings (local permission grants, etc.)
.claude/settings.local.json
```

---

## TUI mode

**v1 commits:** `194dcb1`, `c205cd4`, `aeddc69`, `f18d146`, `c66c9fe`

**Intent:** Terminal UI for chatting with the local agent without Discord. Useful for testing, debugging, and pre-bed-time quick queries.

### Files to create

- `src/tui-main.ts` — entry point
- `src/tui.tsx` — React + Ink UI

### Entry point pattern

```typescript
// src/tui-main.ts
import { render } from 'ink';
import React from 'react';
import { Tui } from './tui.js';
import { MAIN_GROUP_FOLDER, /* ... */ } from './config.js';
import { RegisteredGroup } from './types.js';
// For v2, import the v2-equivalent of runContainerAgent

const TUI_CHAT_JID = 'tui:local';
const tuiGroup: RegisteredGroup = {
  name: 'terminal',
  folder: MAIN_GROUP_FOLDER,
  trigger: '.*',
  added_at: new Date().toISOString(),
};

render(<Tui group={tuiGroup} chatJid={TUI_CHAT_JID} />);
```

### UI shell

```tsx
// src/tui.tsx
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';  // or similar

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Tui(props) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);

  const handleSubmit = async (value) => {
    setMessages(m => [...m, { role: 'user', content: value }]);
    setInput('');
    setThinking(true);
    const result = await runAgent(props.group, value, props.chatJid, [], onOutput);
    setThinking(false);
  };

  return (
    <Box flexDirection="column">
      {messages.map((m, i) => <Text key={i}>{m.role}: {m.content}</Text>)}
      {thinking && <Text>{SPINNER_FRAMES[Date.now() % SPINNER_FRAMES.length]}</Text>}
      <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
    </Box>
  );
}
```

### v2 adaptation notes — IMPORTANT

v1's TUI piped stdin/stdout to the container agent-runner via `runContainerAgent()`. **v2's IO model is SQLite tables, not pipes.** The TUI must:

1. Create (or re-use) a session folder under `data/v2-sessions/<agent-group-id>/tui-local/`.
2. Write user messages to that session's `inbound.db` (`messages_in` with `kind='user'`).
3. Poll the session's `outbound.db` (`messages_out`) for replies.

There's no v1→v2 TUI port path in upstream yet; this will be new work on top of the v2 session DB APIs. Rough sketch:

```typescript
import { openInboundDb, openOutboundDb, pushMessageIn, pollMessagesOut } from './db/session-db.js';

const sessionId = 'tui-local';
const agentGroupId = getAgentGroupId(tuiGroup.folder);
const sessionDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId);
fs.mkdirSync(sessionDir, { recursive: true });
const inbound = openInboundDb(path.join(sessionDir, 'inbound.db'));
const outbound = openOutboundDb(path.join(sessionDir, 'outbound.db'));

// On user submit:
pushMessageIn(inbound, { kind: 'user', content: value, process_after: Date.now() });
// Poll outbound for replies:
const replies = pollMessagesOut(outbound, { since: lastCursor });
```

Check `upstream/v2:src/db/session-db.ts` for exact function signatures at replay time.

### Dependencies

```jsonc
{
  "ink": "^6.8.0",
  "react": "^19.2.4",
  "@types/react": "^19.2.14"
}
```

### Logging

In TUI mode (`NANOCLAW_TUI=1`), logs go to `logs/run/nanoclaw-<timestamp>.log` instead of stdout. The logger checks `process.env.NANOCLAW_TUI` to decide output destination.
