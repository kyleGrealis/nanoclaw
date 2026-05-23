import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import {
  getContainerConfig,
  ensureContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from './db/container-configs.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { openInboundDb } from './session-manager.js';
import { nextEvenSeq } from './db/session-db.js';
import { log } from './log.js';

interface YamlTask {
  id: string;
  cron: string;
  prompt?: string;
  prompt_file?: string;
  script?: string;
  platform_id?: string;
  channel_type?: string;
  thread_id?: string;
}

interface YamlMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

interface YamlConfig {
  assistantName?: string;
  provider?: string;
  model?: string;
  maxMessagesPerPrompt?: number;
  mounts?: YamlMount[];
  tasks?: YamlTask[];
}

/**
 * A lightweight, robust custom YAML parser that handles key-value pairs
 * and nested object lists starting with hyphens. Avoids external dependencies.
 */
export function parseYaml(content: string): YamlConfig {
  const lines = content.split('\n');
  const result: any = {};
  let currentKey = '';
  let currentList: any[] = [];
  let currentListItem: any = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Check for list item starter: e.g. "  - hostPath: /path"
    if (rawLine.startsWith(' ') && line.startsWith('-')) {
      if (currentListItem) {
        currentList.push(currentListItem);
      }
      currentListItem = {};
      const rest = line.slice(1).trim();
      if (rest) {
        const colonIndex = rest.indexOf(':');
        if (colonIndex !== -1) {
          const k = rest.slice(0, colonIndex).trim();
          const v = rest.slice(colonIndex + 1).trim();
          currentListItem[k] = parseValue(v);
        }
      }
      continue;
    }

    // Check for nested keys inside list items: e.g. "    containerPath: /path"
    if (rawLine.startsWith(' ') && currentListItem) {
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const k = line.slice(0, colonIndex).trim();
        const v = line.slice(colonIndex + 1).trim();
        currentListItem[k] = parseValue(v);
      }
      continue;
    }

    // Root-level keys
    const colonIndex = line.indexOf(':');
    if (colonIndex !== -1) {
      if (currentListItem) {
        currentList.push(currentListItem);
        currentListItem = null;
      }
      if (currentKey && currentList.length > 0) {
        result[currentKey] = currentList;
        currentList = [];
      }

      const k = line.slice(0, colonIndex).trim();
      const v = line.slice(colonIndex + 1).trim();
      if (v === '') {
        currentKey = k;
        currentList = [];
      } else {
        result[k] = parseValue(v);
        currentKey = '';
      }
    }
  }

  if (currentListItem) {
    currentList.push(currentListItem);
  }
  if (currentKey && currentList.length > 0) {
    result[currentKey] = currentList;
  }

  return result;
}

function parseValue(val: string): any {
  if (!val) return '';
  // strip surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = Number(val);
  if (!Number.isNaN(num) && val.trim() !== '') return num;
  return val;
}

/**
 * Scan all agent groups for a config.yaml file and sync settings, mounts,
 * and background tasks to the databases.
 */
export function syncYamlConfigs(): void {
  const groups = getAllAgentGroups();

  for (const group of groups) {
    const groupDir = path.resolve(GROUPS_DIR, group.folder);
    const yamlPath = path.join(groupDir, 'config.yaml');

    if (!fs.existsSync(yamlPath)) continue;

    log.info('Syncing configuration from config.yaml', { group: group.name });

    try {
      const content = fs.readFileSync(yamlPath, 'utf8');
      const config = parseYaml(content);

      // 1. Sync config scalars to container_configs
      ensureContainerConfig(group.id);

      const updates: any = {};
      if (config.provider) updates.provider = config.provider;
      if (config.model) updates.model = config.model;
      if (config.assistantName) updates.assistant_name = config.assistantName;
      if (config.maxMessagesPerPrompt) updates.max_messages_per_prompt = config.maxMessagesPerPrompt;

      if (Object.keys(updates).length > 0) {
        updateContainerConfigScalars(group.id, updates);
      }

      // 2. Sync mounts to container_configs
      if (config.mounts) {
        updateContainerConfigJson(group.id, 'additional_mounts', config.mounts);
      }

      // 3. Sync tasks to session databases
      if (config.tasks) {
        const sessions = getSessionsByAgentGroup(group.id);
        for (const session of sessions) {
          const db = openInboundDb(group.id, session.id);
          try {
            syncSessionTasks(db, session.id, groupDir, config.tasks);
          } catch (err) {
            log.error('Failed to sync tasks for session', { sessionId: session.id, err: String(err) });
          } finally {
            db.close();
          }
        }
      }
    } catch (err) {
      log.error('Failed to sync config.yaml', { group: group.name, err: String(err) });
    }
  }
}

function syncSessionTasks(db: Database.Database, sessionId: string, groupDir: string, yamlTasks: YamlTask[]): void {
  const yamlTaskIds = new Set(yamlTasks.map((t) => t.id));

  // Cancel any active/pending tasks in the DB that are NOT in the YAML file anymore
  const activeDbTasks = db
    .prepare("SELECT series_id FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
    .all() as Array<{ series_id: string }>;

  for (const dbTask of activeDbTasks) {
    if (!yamlTaskIds.has(dbTask.series_id)) {
      db.prepare(
        "UPDATE messages_in SET status = 'completed', recurrence = NULL WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')",
      ).run(dbTask.series_id);
      log.info('Removed task from scheduler', { taskId: dbTask.series_id, sessionId });
    }
  }

  // Sync/upsert the remaining YAML tasks
  for (const task of yamlTasks) {
    // Resolve prompt: either inline or read from blueprint file
    let prompt = task.prompt ?? '';
    if (task.prompt_file) {
      const blueprintPath = path.resolve(groupDir, task.prompt_file);
      if (fs.existsSync(blueprintPath)) {
        prompt = fs.readFileSync(blueprintPath, 'utf8');
      } else {
        log.warn('Blueprint file not found, skipping task prompt update', {
          path: blueprintPath,
          taskId: task.id,
        });
        continue;
      }
    }

    const script = task.script ?? null;
    const recurrence = task.cron || null;

    // Calculate next run time using cron-parser
    let nextRun = new Date().toISOString();
    if (recurrence) {
      try {
        const interval = CronExpressionParser.parse(recurrence, { tz: TIMEZONE });
        nextRun = interval.next().toISOString();
      } catch (err) {
        log.error('Invalid cron expression in YAML task', { taskId: task.id, cron: recurrence, err: String(err) });
        continue;
      }
    }

    // Check if task already exists as pending/paused
    const existing = db
      .prepare(
        "SELECT id, content, recurrence, process_after FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused') ORDER BY seq DESC LIMIT 1",
      )
      .get(task.id) as
      | { id: string; content: string; recurrence: string | null; process_after: string | null }
      | undefined;

    const taskContent = JSON.stringify({ prompt, script });

    if (existing) {
      // If task changed, update it
      const existingContent = JSON.parse(existing.content);
      const contentChanged = existingContent.prompt !== prompt || existingContent.script !== script;
      const recurrenceChanged = existing.recurrence !== recurrence;

      if (contentChanged || recurrenceChanged) {
        const updates: string[] = ['content = ?'];
        const params: any[] = [taskContent];

        if (recurrenceChanged) {
          updates.push('recurrence = ?', 'process_after = ?');
          params.push(recurrence, nextRun);
        }
        params.push(existing.id);

        db.prepare(`UPDATE messages_in SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        log.info('Updated task configurations in scheduler', { taskId: task.id, sessionId });
      }
    } else {
      // If it doesn't exist at all, insert it as a brand new pending task
      const seq = nextEvenSeq(db);
      db.prepare(
        `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
         VALUES (?, ?, datetime('now'), 'pending', 0, ?, ?, 'task', ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        seq,
        nextRun,
        recurrence,
        task.platform_id ?? null,
        task.channel_type ?? null,
        task.thread_id ?? null,
        taskContent,
        task.id,
      );
      log.info('Created new scheduled task', { taskId: task.id, nextRun, recurrence, sessionId });
    }
  }
}
