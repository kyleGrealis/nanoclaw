/**
 * One-shot script: wire Andy's 5 Discord server channels to the existing Andy agent group.
 *
 * Bypasses setup/register.ts which is upstream-stale (doesn't include the engage_mode
 * columns that migration 010-engage-modes added to messaging_group_agents).
 *
 * Mirrors the pattern used by scripts/init-first-agent.ts:
 * - createMessagingGroup (with is_group=1, unknown_sender_policy='strict')
 * - createMessagingGroupAgent (with engage_mode, engage_pattern, sender_scope,
 *   ignored_message_policy as required by current schema)
 *
 * Run from repo root:
 *   pnpm exec tsx .nanoclaw-migrations/wire-andy-channels.ts
 *
 * Safe to re-run: skips channels already wired (checked by platform_id + agent pair).
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';

interface ChannelSpec {
  platformId: string; // raw Discord channel ID (we prefix)
  name: string;
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  engagePattern: string | null;
}

// Decisions from the 2026-04-23 migration (see .nanoclaw-migrations/index.md):
// - #nanoclaw = Kyle's primary server chat → respond to everything (pattern '.')
// - Others = require @Andy mention → engage_mode='mention'
// - sender_scope='all' across the board (no allowlist gating)
// - ignored_message_policy='drop' (no accumulation)
const CHANNELS: ChannelSpec[] = [
  { platformId: '1435481829573656628', name: 'nanoclaw', engageMode: 'pattern', engagePattern: '.' },
  { platformId: '1494156244439666829', name: 'weather', engageMode: 'mention', engagePattern: null },
  { platformId: '1494156616071643386', name: 'typescript-learning', engageMode: 'mention', engagePattern: null },
  { platformId: '1494156045331992586', name: 'news', engageMode: 'mention', engagePattern: null },
  { platformId: '1494157843325255720', name: 'server-logs', engageMode: 'mention', engagePattern: null },
];

const AGENT_FOLDER = 'dm-with-kyle'; // Andy's agent group (created by init-first-agent)
const SESSION_MODE = 'shared'; // one session per messaging group, same memory/CLAUDE.local.md

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const dbPath = path.join(DATA_DIR, 'v2.db');
  initDb(dbPath);
  runMigrations(initDb(dbPath));

  const agent = getAgentGroupByFolder(AGENT_FOLDER);
  if (!agent) {
    console.error(`[!] No agent group found at folder '${AGENT_FOLDER}'. Run /init-first-agent first.`);
    process.exit(1);
  }
  console.log(`Agent group: ${agent.id} ("${agent.name}") @ groups/${agent.folder}`);
  console.log('');

  for (const ch of CHANNELS) {
    // IMPORTANT: platform_id uses `discord:` prefix (Chat-SDK internal),
    // not the NanoClaw channel_type. Channel_type ('discord-andy') distinguishes
    // which bot's adapter handles the event; platform_id is what Chat-SDK sends.
    const prefixedPlatformId = `discord:${ch.platformId}`;
    let mg = getMessagingGroupByPlatform('discord-andy', prefixedPlatformId);
    if (!mg) {
      const mgId = generateId('mg');
      createMessagingGroup({
        id: mgId,
        channel_type: 'discord-andy',
        platform_id: prefixedPlatformId,
        name: ch.name,
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: new Date().toISOString(),
      });
      mg = getMessagingGroupByPlatform('discord-andy', prefixedPlatformId)!;
      console.log(`  + messaging_group ${mgId} (#${ch.name})`);
    } else {
      console.log(`  = messaging_group ${mg.id} (#${ch.name}) already existed, reusing`);
    }

    const existingWire = getMessagingGroupAgentByPair(mg.id, agent.id);
    if (existingWire) {
      console.log(`  = wiring already exists for #${ch.name}, skipping`);
      continue;
    }

    const mgaId = generateId('mga');
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: mg.id,
      agent_group_id: agent.id,
      session_mode: SESSION_MODE,
      priority: 0,
      created_at: new Date().toISOString(),
      engage_mode: ch.engageMode,
      engage_pattern: ch.engagePattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
    });
    console.log(
      `  + wired #${ch.name} → Andy [${ch.engageMode}${ch.engagePattern ? ` '${ch.engagePattern}'` : ''}]`,
    );
  }

  console.log('');
  console.log('Done. Andy now responds in all 5 Discord server channels.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
