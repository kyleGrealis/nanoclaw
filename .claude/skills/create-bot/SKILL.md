---
name: create-bot
description: Add a new Discord bot persona (e.g. Sally, Teek) as a first-class NanoClaw agent — its own Discord app, its own adapter file, its own agent_group, its own memory/persona. Use when the user wants to spin up a new assistant beyond the existing ones (Andy, Milton, …).
---

# Create Bot

Add a new Discord-backed persona to NanoClaw. Each bot is a fully separate Discord application with its own identity (name, avatar, token) and its own agent_group (folder, CLAUDE.local.md, memory). This skill automates the mechanical parts; you make the human decisions.

## Pattern overview

NanoClaw uses **one adapter file per bot** (Pattern Y). For a bot named `Sally`:

- `src/channels/discord-sally.ts` — Discord adapter that reads `DISCORD_BOT_TOKEN_SALLY` etc. and registers channel_type `discord-sally`
- `src/channels/index.ts` — has `import './discord-sally.js';` for self-registration
- `.env` — has `DISCORD_BOT_TOKEN_SALLY`, `DISCORD_PUBLIC_KEY_SALLY`, `DISCORD_APPLICATION_ID_SALLY`
- `data/v2.db:agent_groups` — one row for Sally, pointing at `groups/<folder>/`
- `groups/<folder>/CLAUDE.local.md` — Sally's persona + memory
- `data/v2.db:messaging_groups` — one row per Discord channel/DM Sally should respond in, with `channel_type='discord-sally'` and `platform_id='discord:<channel_id>'` — **note the `discord:` prefix, not `discord-sally:`. The platform_id is what Chat-SDK sends internally (always `discord:`); the channel_type distinguishes which bot's adapter handles it.**
- `data/v2.db:messaging_group_agents` — one row per wiring, with `engage_mode`, `engage_pattern`, etc.

Reference examples: see `src/channels/discord-andy.ts` (Kyle's assistant) and `src/channels/discord-milton.ts` (Alexa's paralegal).

## Prerequisites

- Service is running (`systemctl --user is-active nanoclaw` returns `active`)
- Central DB exists (`data/v2.db` — created automatically on first service start)
- You have access to `discord.com/developers/applications` to create the Discord app

## Step 1 — Gather decisions (ask the user)

Use AskUserQuestion or plain-text prompts:

1. **Bot name** (e.g. "Sally"). This becomes the persona name and drives env var names (`_SALLY`). Record as `BOT_NAME`. Lowercase for var suffix: `BOT_NAME_UPPER = BOT_NAME.toUpperCase()`.
2. **Agent folder** — where Sally's memory lives. Default: `dm-with-<primary-user>` if the bot is primarily for one person (follows Andy's `dm-with-kyle` and Milton's `dm-with-alexa`), else just the bot name (`sally`). Record as `AGENT_FOLDER`.
3. **Primary Discord channel to wire** — the first channel where Sally should respond. Record as `PLATFORM_ID` (raw Discord channel ID, without prefix).
4. **Channel name** (human-readable, e.g. "sally-dev"). Record as `CHANNEL_NAME`.
5. **Engage mode**:
   - `pattern` with pattern `.` — respond to every message (best for personal DMs or dedicated channels)
   - `mention` — respond only when @-mentioned (best for busy channels)
   - `mention-sticky` — @-mention opens a thread, follow-ups don't re-mention
   - Record as `ENGAGE_MODE` and `ENGAGE_PATTERN` (null unless mode=pattern)
6. **Unknown sender policy** (who can talk to Sally):
   - `strict` — only registered users
   - `public` — anyone in the channel
   - `request_approval` — first message from a new sender goes to approval queue
   - Record as `USP`

## Step 2 — Create the Discord app

Tell the user:

> Open `https://discord.com/developers/applications` and click **New Application**.
>
> 1. Name it whatever you want Discord users to see (e.g. "NanoClaw-Sally"). This is the bot's display name.
> 2. After creating, on the **General Information** tab:
>    - Copy the **APPLICATION ID**
>    - Copy the **PUBLIC KEY**
> 3. On the **Bot** tab (left sidebar):
>    - Click **Reset Token** → **Yes, do it** → copy the token (one-time view)
>    - Enable **Message Content Intent** (required so the bot can read message text)
> 4. On the **OAuth2 → URL Generator** tab:
>    - Scopes: `bot`, `applications.commands`
>    - Bot permissions: `Read Messages/View Channels`, `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Embed Links`
>    - Copy the generated URL and open it in a browser to invite the bot to the target Discord server
>
> Paste the three values back here when ready.

Record as `TOKEN`, `PUBLIC_KEY`, `APP_ID`.

## Step 3 — Add env vars

Append to `.env`:

```bash
cat >> /home/kyle/nanoclaw/.env <<EOF

# ${BOT_NAME}
DISCORD_APPLICATION_ID_${BOT_NAME_UPPER}=${APP_ID}
DISCORD_PUBLIC_KEY_${BOT_NAME_UPPER}=${PUBLIC_KEY}
DISCORD_BOT_TOKEN_${BOT_NAME_UPPER}=${TOKEN}
EOF
```

Do not commit `.env` (it's in `.gitignore`).

## Step 4 — Generate the adapter file

Write `src/channels/discord-${bot_name_lower}.ts` using the template below (substitute `<BOT_NAME_UPPER>` and `<bot-name-lower>`):

```typescript
/**
 * Discord channel adapter for <BOT_NAME>.
 * Reads DISCORD_BOT_TOKEN_<BOT_NAME_UPPER> / DISCORD_PUBLIC_KEY_<BOT_NAME_UPPER> /
 * DISCORD_APPLICATION_ID_<BOT_NAME_UPPER> and registers channel_type 'discord-<bot-name-lower>'.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord-<bot-name-lower>', {
  factory: () => {
    const env = readEnvFile([
      'DISCORD_BOT_TOKEN_<BOT_NAME_UPPER>',
      'DISCORD_PUBLIC_KEY_<BOT_NAME_UPPER>',
      'DISCORD_APPLICATION_ID_<BOT_NAME_UPPER>',
    ]);
    if (!env.DISCORD_BOT_TOKEN_<BOT_NAME_UPPER>) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN_<BOT_NAME_UPPER>,
      publicKey: env.DISCORD_PUBLIC_KEY_<BOT_NAME_UPPER>,
      applicationId: env.DISCORD_APPLICATION_ID_<BOT_NAME_UPPER>,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      channelType: 'discord-<bot-name-lower>',
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN_<BOT_NAME_UPPER>,
      extractReplyContext,
      supportsThreads: false, // inline replies in server channels — flip to true if
                              // the bot will juggle many parallel conversations and
                              // benefits from Discord threads keeping them separate
    });
  },
});
```

Append the import to `src/channels/index.ts`:

```typescript
import './discord-<bot-name-lower>.js';
```

## Step 5 — Seed the persona folder

```bash
mkdir -p /home/kyle/nanoclaw/groups/${AGENT_FOLDER}
cat > /home/kyle/nanoclaw/groups/${AGENT_FOLDER}/CLAUDE.local.md <<EOF
# ${BOT_NAME}

(Persona placeholder — replace with the real persona, tone, rules, and memory directives.)

## Identity & Tone
- ...

## Capabilities
- ...

## Memory
- ...
EOF
```

If the user wants to write the persona right now, prompt them for it. Otherwise leave the placeholder — the bot will still function (with a thin persona) and the user can edit the file any time.

## Step 6 — Build and restart

```bash
cd /home/kyle/nanoclaw
pnpm run build
systemctl --user restart nanoclaw
sleep 4
tail -10 logs/nanoclaw.log
```

Expect a line like:

```
Channel adapter started channel="discord-<bot-name-lower>" type="discord"
Discord Gateway connected { username: '<BOT_NAME>', id: '<application-id>' }
```

If you see `publicKey is required` or `botToken is required` in `logs/nanoclaw.error.log`, the `.env` vars didn't load — verify spelling and that the file has no stray spaces or quotes.

## Step 7 — Create agent_group + messaging_group + wiring

Since upstream `setup/register.ts` is stale (doesn't write the engage_mode columns added by migration 010), use a bypass script. Write and run:

```typescript
// .nanoclaw-migrations/create-<bot-name-lower>.ts
import path from 'path';
import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';

const BOT_NAME = '<BOT_NAME>';
const FOLDER = '<AGENT_FOLDER>';
const CHANNEL_TYPE = 'discord-<bot-name-lower>';
// IMPORTANT: platform_id uses 'discord:' prefix (Chat-SDK internal), NOT the channel_type.
const PLATFORM_ID = `discord:<RAW_CHANNEL_ID>`;
const CHANNEL_NAME = '<CHANNEL_NAME>';
const ENGAGE_MODE = '<ENGAGE_MODE>'; // 'pattern' | 'mention' | 'mention-sticky'
const ENGAGE_PATTERN = <ENGAGE_PATTERN_OR_NULL>; // e.g. '.' or null
const USP = '<USP>'; // 'strict' | 'public' | 'request_approval'

const id = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(initDb(path.join(DATA_DIR, 'v2.db')));

  let ag = getAgentGroupByFolder(FOLDER);
  if (!ag) {
    const agId = id('ag');
    createAgentGroup({ id: agId, name: BOT_NAME, folder: FOLDER, agent_provider: null, created_at: new Date().toISOString() });
    ag = getAgentGroupByFolder(FOLDER)!;
    console.log(`+ agent_group ${agId}`);
  }
  initGroupFilesystem(ag);

  let mg = getMessagingGroupByPlatform(CHANNEL_TYPE, PLATFORM_ID);
  if (!mg) {
    const mgId = id('mg');
    createMessagingGroup({
      id: mgId, channel_type: CHANNEL_TYPE, platform_id: PLATFORM_ID, name: CHANNEL_NAME,
      is_group: 1, unknown_sender_policy: USP, created_at: new Date().toISOString(),
    });
    mg = getMessagingGroupByPlatform(CHANNEL_TYPE, PLATFORM_ID)!;
    console.log(`+ messaging_group ${mgId}`);
  }

  if (!getMessagingGroupAgentByPair(mg.id, ag.id)) {
    const mgaId = id('mga');
    createMessagingGroupAgent({
      id: mgaId, messaging_group_id: mg.id, agent_group_id: ag.id,
      session_mode: 'shared', priority: 0, created_at: new Date().toISOString(),
      engage_mode: ENGAGE_MODE, engage_pattern: ENGAGE_PATTERN, sender_scope: 'all', ignored_message_policy: 'drop',
    });
    console.log(`+ wired #${CHANNEL_NAME} → ${BOT_NAME}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Then: `pnpm exec tsx .nanoclaw-migrations/create-<bot-name-lower>.ts`.

## Step 8 — Smoke test

Tell the user to post a message in the wired channel. Watch:

```bash
tail -f logs/nanoclaw.log
```

You should see:
- `Inbound ... received adapter="discord-<bot-name-lower>"`
- `Session created` / `Message routed`
- `Spawning container`
- `Message delivered`

And the bot should reply in Discord using the persona from `groups/<AGENT_FOLDER>/CLAUDE.local.md`.

## Adding additional channels to an existing bot

To wire another Discord channel (or DM) to an already-created bot, repeat step 7 but skip the agent_group creation (it already exists). Just add:
- A new messaging_group row with the new `platform_id`
- A new messaging_group_agents row pointing at the existing agent_group

(Once upstream `setup/register.ts` is fixed, `/manage-channels` will do this directly.)

## When upstream `setup/register.ts` is fixed

This skill's step 7 bypass script can be replaced with:

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "<RAW_CHANNEL_ID>" --name "<CHANNEL_NAME>" \
  --folder "<AGENT_FOLDER>" --channel "discord-<bot-name-lower>" \
  --session-mode "shared" --assistant-name "<BOT_NAME>" \
  --trigger "<PATTERN>" [--no-trigger-required]
```

Update this SKILL.md when that happens.

## Troubleshooting

- **Bot connects but doesn't respond**: check `unknown_sender_policy` on the messaging_group. If it's `strict`, the sender must be a registered user with access to this agent_group.
- **"publicKey is required"**: `.env` is missing the suffixed keys or has typos. Verify `cut -d= -f1 .env`.
- **Build fails after step 4**: usually a typo in the adapter file (unresolved `<BOT_NAME_UPPER>` placeholder). Read the file back and check each substitution.
- **Bot posts twice per message**: check `src/channels/index.ts` for duplicate imports.
