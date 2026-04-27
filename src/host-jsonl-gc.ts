/**
 * Host JSONL garbage collector.
 *
 * The Claude Agent SDK accumulates one transcript jsonl per session at
 * `data/v2-sessions/<agentGroupId>/.claude-shared/projects/-workspace-agent/<uuid>.jsonl`.
 * Cold-start session rotation (poll-loop.ts) and `/clear` both abandon
 * jsonls without removing them, so the directory grows indefinitely.
 *
 * This sweep deletes any jsonl whose UUID is no longer the active
 * `sdk_session_id` for any session in its agent group AND whose mtime is
 * older than 30 days. The SDK only reads the active session's file, so
 * removing orphans is safe for runtime; the threshold protects against
 * deleting a transcript that's between writes during a brief gap.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { openOutboundDb, outboundDbPath } from './session-manager.js';

const JSONL_AGE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startJsonlGc(): void {
  if (timer) return;
  runGc().catch((err) => log.error('JSONL GC failed', { err }));
  timer = setInterval(() => {
    runGc().catch((err) => log.error('JSONL GC failed', { err }));
  }, GC_INTERVAL_MS);
  timer.unref?.();
}

export function stopJsonlGc(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function runGc(): Promise<{ deleted: number; bytes: number }> {
  const now = Date.now();
  let deleted = 0;
  let bytes = 0;

  for (const group of getAllAgentGroups()) {
    const transcriptsDir = path.join(
      DATA_DIR,
      'v2-sessions',
      group.id,
      '.claude-shared',
      'projects',
      '-workspace-agent',
    );
    if (!fs.existsSync(transcriptsDir)) continue;

    const referenced = collectReferencedSessionIds(group.id);

    let entries: string[];
    try {
      entries = fs.readdirSync(transcriptsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const uuid = entry.slice(0, -'.jsonl'.length);
      if (referenced.has(uuid)) continue;

      const fullPath = path.join(transcriptsDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (now - stat.mtimeMs < JSONL_AGE_THRESHOLD_MS) continue;

      try {
        fs.unlinkSync(fullPath);
        deleted++;
        bytes += stat.size;
      } catch (err) {
        log.warn('Failed to remove orphaned jsonl', { path: fullPath, err });
      }
    }
  }

  if (deleted > 0) {
    log.info('JSONL GC swept orphaned transcripts', {
      deleted,
      mb: +(bytes / 1024 / 1024).toFixed(1),
    });
  }

  return { deleted, bytes };
}

function collectReferencedSessionIds(agentGroupId: string): Set<string> {
  const referenced = new Set<string>();
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    const outPath = outboundDbPath(agentGroupId, session.id);
    if (!fs.existsSync(outPath)) continue;
    let db;
    try {
      db = openOutboundDb(agentGroupId, session.id);
    } catch {
      continue;
    }
    try {
      const row = db
        .prepare("SELECT value FROM session_state WHERE key = 'sdk_session_id'")
        .get() as { value: string } | undefined;
      if (row?.value) referenced.add(row.value);
    } catch {
      // table may not exist yet for fresh sessions
    } finally {
      db.close();
    }
  }
  return referenced;
}
