/**
 * One-shot: create Milton agent group + wire #milton Discord channel.
 *
 * Assumes:
 *   - src/channels/discord-milton.ts adapter is registered (channel_type='discord-milton')
 *   - groups/dm-with-alexa/ exists with Milton's CLAUDE.local.md
 *   - .env has DISCORD_*_MILTON vars and service is running
 *
 * Run: pnpm exec tsx .nanoclaw-migrations/create-milton.ts
 *
 * Safe to re-run: skips existing rows.
 */
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

const MILTON_FOLDER = 'dm-with-alexa';
const MILTON_NAME = 'Milton';
const MILTON_CHANNEL_ID = '1495248172740509800'; // #milton Discord channel

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(initDb(path.join(DATA_DIR, 'v2.db')));

  // 1. Agent group
  let ag = getAgentGroupByFolder(MILTON_FOLDER);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: MILTON_NAME,
      folder: MILTON_FOLDER,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    ag = getAgentGroupByFolder(MILTON_FOLDER)!;
    console.log(`+ agent_group ${agId} (${MILTON_NAME} @ groups/${MILTON_FOLDER})`);
  } else {
    console.log(`= agent_group ${ag.id} (${MILTON_NAME}) already existed, reusing`);
  }
  initGroupFilesystem(ag);

  // 2. Messaging group for #milton
  // IMPORTANT: platform_id uses `discord:` (Chat-SDK internal prefix), NOT the
  // NanoClaw channel_type. channel_type='discord-milton' routes through Milton's
  // adapter; platform_id 'discord:<id>' is what Chat-SDK sends for Discord events.
  const platformId = `discord:${MILTON_CHANNEL_ID}`;
  let mg = getMessagingGroupByPlatform('discord-milton', platformId);
  if (!mg) {
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: 'discord-milton',
      platform_id: platformId,
      name: 'milton',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    mg = getMessagingGroupByPlatform('discord-milton', platformId)!;
    console.log(`+ messaging_group ${mgId} (#milton, unknown_sender_policy=public)`);
  } else {
    console.log(`= messaging_group ${mg.id} (#milton) already existed, reusing`);
  }

  // 3. Wire #milton → Milton agent
  const existingWire = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (existingWire) {
    console.log(`= wiring already exists, skipping`);
  } else {
    const mgaId = generateId('mga');
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
      engage_mode: 'pattern',
      engage_pattern: '.', // respond to everything — matches v1 Milton behavior
      sender_scope: 'all',
      ignored_message_policy: 'drop',
    });
    console.log(`+ wired #milton → Milton [pattern '.' / sender_scope=all]`);
  }

  console.log('');
  console.log('Done. Milton ready — post anything in #milton and he should respond.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
