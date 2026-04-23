/**
 * Import v1 scheduled_tasks into v2 per-session inbound.db as kind='task' rows.
 *
 * Reads .nanoclaw-migrations/v1-scheduled-tasks.json (previously dumped from
 * v1 store/messages.db) and writes each active task as a messages_in row in
 * the appropriate v2 session's inbound.db.
 *
 * Dry-run (default): prints what WOULD be inserted, writes nothing.
 *   pnpm exec tsx .nanoclaw-migrations/import-v1-tasks.ts
 *
 * Apply for real:
 *   pnpm exec tsx .nanoclaw-migrations/import-v1-tasks.ts --apply
 *
 * Safe to re-run with --apply: skips task IDs that already exist in the
 * target session (matched by messages_in.id).
 *
 * Mapping v1 folder → v2 (agent_group, messaging_group):
 *   discord_main                → Andy  / #main
 *   discord_weather             → Andy  / #weather
 *   discord_typescript-learning → Andy  / #typescript-learning
 *   discord_news                → Andy  / #news
 *   discord_server-logs         → Andy  / #server-logs
 *   discord_milton              → Milton / #milton
 *
 * For cron tasks: schedule_value becomes `recurrence`, next_run becomes
 * `process_after`. For once tasks: schedule_value (ISO local) is shifted to
 * CT → UTC and stored as `process_after`, recurrence=null.
 */
import fs from 'fs';
import path from 'path';

import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb, getDb } from '../src/db/connection.js';
import { getMessagingGroupByPlatform } from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { resolveSession } from '../src/session-manager.js';

const DRY_RUN = !process.argv.includes('--apply');

// v1 folder → (agent_group folder, channel_type, platform_id)
const FOLDER_MAP: Record<string, { agentFolder: string; channelType: string; platformId: string; channelName: string }> = {
  discord_main: {
    agentFolder: 'dm-with-kyle',
    channelType: 'discord-andy',
    platformId: 'discord:1435481828935860330:1435481829573656628',
    channelName: 'main',
  },
  discord_weather: {
    agentFolder: 'dm-with-kyle',
    channelType: 'discord-andy',
    platformId: 'discord:1435481828935860330:1494156244439666829',
    channelName: 'weather',
  },
  'discord_typescript-learning': {
    agentFolder: 'dm-with-kyle',
    channelType: 'discord-andy',
    platformId: 'discord:1435481828935860330:1494156616071643386',
    channelName: 'typescript-learning',
  },
  discord_news: {
    agentFolder: 'dm-with-kyle',
    channelType: 'discord-andy',
    platformId: 'discord:1435481828935860330:1494156045331992586',
    channelName: 'news',
  },
  'discord_server-logs': {
    agentFolder: 'dm-with-kyle',
    channelType: 'discord-andy',
    platformId: 'discord:1435481828935860330:1494157843325255720',
    channelName: 'server-logs',
  },
  discord_milton: {
    agentFolder: 'dm-with-alexa',
    channelType: 'discord-milton',
    platformId: 'discord:1435481828935860330:1495248172740509800',
    channelName: 'milton',
  },
};

interface V1Task {
  id: string;
  status: 'active' | 'completed' | 'paused' | 'cancelled';
  schedule_type: 'cron' | 'once';
  schedule_value: string; // cron expression OR ISO datetime
  next_run: string | null; // ISO UTC
  group_folder: string;
  prompt: string;
  script: string | null;
  chat_jid?: string | null;
}

function openInboundDb(sessionId: string, agentGroupId: string): Database.Database {
  const sessDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId);
  const inboundPath = path.join(sessDir, 'inbound.db');
  if (!fs.existsSync(inboundPath)) {
    throw new Error(`inbound.db not found at ${inboundPath} — session may not be fully materialized`);
  }
  return new BetterSqlite3(inboundPath);
}

function taskExists(inDb: Database.Database, taskId: string): boolean {
  const row = inDb.prepare('SELECT id FROM messages_in WHERE id = ? AND kind = ?').get(taskId, 'task');
  return !!row;
}

async function main(): Promise<void> {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY (writing to session DBs)'}`);
  console.log('');

  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), '.nanoclaw-migrations/v1-scheduled-tasks.json'), 'utf8'),
  ) as V1Task[];

  const active = raw.filter((t) => t.status === 'active');
  console.log(`Found ${raw.length} v1 tasks, ${active.length} active.`);
  console.log('');

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const t of active) {
    const mapping = FOLDER_MAP[t.group_folder];
    if (!mapping) {
      console.warn(`[!] SKIP ${t.id}: unknown folder '${t.group_folder}'`);
      errors++;
      continue;
    }

    const ag = getAgentGroupByFolder(mapping.agentFolder);
    if (!ag) {
      console.warn(`[!] SKIP ${t.id}: agent_group for folder '${mapping.agentFolder}' not found`);
      errors++;
      continue;
    }
    const mg = getMessagingGroupByPlatform(mapping.channelType, mapping.platformId);
    if (!mg) {
      console.warn(`[!] SKIP ${t.id}: messaging_group for ${mapping.channelType} ${mapping.platformId} not found`);
      errors++;
      continue;
    }

    // Resolve (or reuse) the session for this (agent_group, messaging_group) pair.
    // session_mode='shared' is what both Andy's and Milton's wirings use.
    const { session, created } = resolveSession(ag.id, mg.id, null, 'shared');

    // Compute process_after
    let processAfter: string;
    let recurrence: string | null = null;
    if (t.schedule_type === 'cron') {
      // cron: next_run is already computed ISO UTC. Store cron expression as recurrence.
      processAfter = t.next_run ?? new Date().toISOString();
      recurrence = t.schedule_value;
    } else {
      // once: schedule_value is ISO local (no Z). next_run has the correct UTC version.
      processAfter = t.next_run ?? new Date(t.schedule_value).toISOString();
    }

    // Task content payload (prompt + optional script)
    const content = JSON.stringify({ prompt: t.prompt, script: t.script || null });

    console.log(
      `[${t.schedule_type.toUpperCase()}] ${t.id}`,
      `\n  → ${ag.name} / #${mapping.channelName} (session ${session.id}${created ? ', NEW' : ''})`,
      `\n  process_after=${processAfter}`,
      `\n  recurrence=${recurrence ?? '(none)'}`,
      `\n  prompt=${(t.prompt || '').replace(/\n/g, ' ').slice(0, 100)}...`,
    );

    if (!DRY_RUN) {
      let inDb: Database.Database | null = null;
      try {
        inDb = openInboundDb(session.id, ag.id);
        if (taskExists(inDb, t.id)) {
          console.log(`  ↳ already in inbound.db, skipping`);
          skipped++;
        } else {
          insertTask(inDb, {
            id: t.id,
            processAfter,
            recurrence,
            platformId: mapping.platformId,
            channelType: mapping.channelType,
            threadId: null,
            content,
          });
          console.log(`  ↳ inserted ✓`);
          imported++;
        }
      } catch (err) {
        console.error(`  ↳ ERROR: ${(err as Error).message}`);
        errors++;
      } finally {
        inDb?.close();
      }
    }
    console.log('');
  }

  console.log('---');
  if (DRY_RUN) {
    console.log(`Dry-run complete. Re-run with --apply to write ${active.length} tasks.`);
  } else {
    console.log(`Done. imported=${imported}, skipped=${skipped}, errors=${errors}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
