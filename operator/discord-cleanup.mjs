#!/usr/bin/env node
// Discord message cleanup for Andy's channels.
// REST API only — does NOT open a gateway connection, so the running bot is unaffected.
// Bulk-deletes messages <14 days old (max 100 per call), then one-at-a-time for older.
//
// Channels can specify { afterTimestamp: <ISO> } to PRESERVE messages from that
// timestamp forward (e.g. only delete pre-this-morning content).
//
// Run: node discord-cleanup.mjs           (live)
// Run: node discord-cleanup.mjs --dry     (dry run, no deletes)

import { readFileSync } from 'node:fs';

// -- env / token ----------------------------------------------------------
const ENV_PATH = '/home/kyle/nanoclaw-andy/.env';
const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const TOKEN = env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN in', ENV_PATH);
  process.exit(1);
}

// -- channel config -------------------------------------------------------
// Skipping: #milton (different bot/channel — we don't have/want its ID), DM.
// Preserving: #typescript-learning messages from 2026-05-04 00:00 CT (= 05:00 UTC) onward.
const TS_CUTOFF_ISO = '2026-05-04T05:00:00.000Z'; // 2026-05-04 00:00 CT (preserve from here on)
const CHANNELS = [
  { id: '1435481829573656628', name: '#main' },
  { id: '1498021549058293841', name: '#devops' },
  { id: '1494156244439666829', name: '#weather' },
  { id: '1494157843325255720', name: '#logs-and-issues' },
  { id: '1497746474463924355', name: '#misc' },
  { id: '1494156616071643386', name: '#typescript-learning', preserveAfter: TS_CUTOFF_ISO },
];

const DRY_RUN = process.argv.includes('--dry');

// -- discord helpers ------------------------------------------------------
const API = 'https://discord.com/api/v10';
const HEADERS = {
  Authorization: `Bot ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'nanoclaw-cleanup/1.0',
};
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

async function api(method, path, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const retry = (await res.json()).retry_after ?? 1;
      await new Promise((r) => setTimeout(r, retry * 1000 + 200));
      continue;
    }
    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error('Too many rate-limit retries');
}

async function fetchMessages(channelId, before) {
  const q = new URLSearchParams({ limit: '100' });
  if (before) q.set('before', before);
  return api('GET', `/channels/${channelId}/messages?${q}`);
}

async function bulkDelete(channelId, ids) {
  if (ids.length === 0) return;
  if (ids.length === 1) {
    return api('DELETE', `/channels/${channelId}/messages/${ids[0]}`);
  }
  return api('POST', `/channels/${channelId}/messages/bulk-delete`, { messages: ids });
}

async function deleteOne(channelId, id) {
  return api('DELETE', `/channels/${channelId}/messages/${id}`);
}

// -- per-channel cleanup --------------------------------------------------
async function cleanChannel(ch) {
  const tag = DRY_RUN ? ' [DRY-RUN]' : '';
  const preserveNote = ch.preserveAfter ? ` (preserving ≥ ${ch.preserveAfter})` : '';
  console.log(`\n=== ${ch.name} (${ch.id})${tag}${preserveNote}`);

  const preserveMs = ch.preserveAfter ? new Date(ch.preserveAfter).getTime() : null;
  let before;
  let totalSeen = 0;
  let totalSkipped = 0;
  let totalBulk = 0;
  let totalSlow = 0;
  let pinned = 0;

  while (true) {
    const batch = await fetchMessages(ch.id, before);
    if (batch.length === 0) break;
    totalSeen += batch.length;
    before = batch[batch.length - 1].id;

    const now = Date.now();
    const bulk = [];
    const slow = [];
    for (const m of batch) {
      if (m.pinned) {
        pinned++;
        continue;
      }
      const ts = new Date(m.timestamp).getTime();
      if (preserveMs !== null && ts >= preserveMs) {
        totalSkipped++;
        continue;
      }
      const age = now - ts;
      if (age < TWO_WEEKS_MS) bulk.push(m.id);
      else slow.push(m.id);
    }

    if (DRY_RUN) {
      totalBulk += bulk.length;
      totalSlow += slow.length;
    } else {
      // Bulk in chunks of 100 (we already get 100/page so usually fine)
      for (let i = 0; i < bulk.length; i += 100) {
        await bulkDelete(ch.id, bulk.slice(i, i + 100));
        totalBulk += Math.min(100, bulk.length - i);
        await new Promise((r) => setTimeout(r, 250));
      }
      for (const id of slow) {
        try {
          await deleteOne(ch.id, id);
          totalSlow++;
        } catch (err) {
          console.error(`    delete ${id} failed: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  console.log(
    `  seen=${totalSeen}  bulk-deleted=${totalBulk}  slow-deleted=${totalSlow}  preserved=${totalSkipped}  pinned-skipped=${pinned}`,
  );
}

// -- main -----------------------------------------------------------------
console.log(`Discord cleanup — ${DRY_RUN ? 'DRY RUN (no deletes)' : 'LIVE (deletes)'}`);
console.log(`Started at: ${new Date().toISOString()}`);
console.log(`Channels: ${CHANNELS.map((c) => c.name).join(', ')}`);
console.log(`Skipping entirely: #milton (not in list), Andy's DM with Kyle`);

for (const ch of CHANNELS) {
  try {
    await cleanChannel(ch);
  } catch (err) {
    console.error(`  ERROR on ${ch.name}: ${err.message}`);
  }
}

console.log(`\nFinished at: ${new Date().toISOString()}`);
