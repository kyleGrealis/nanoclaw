/**
 * Scheduling MCP tools: schedule_task, list_tasks, cancel_task, pause_task, resume_task.
 *
 * With the two-DB split, the container cannot write to inbound.db (host-owned).
 * Scheduling operations are sent as system actions via messages_out — the host
 * reads them during delivery and applies the changes to inbound.db.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { getInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/**
 * Sibling sessions (other sessions owned by the same agent_group) are mounted
 * read-only at /workspace/siblings/<session_id>/. Only present if the host
 * spawned the container with the sibling mount — list_tasks({scope:'all'})
 * relies on this to aggregate tasks across channels.
 */
const SIBLINGS_ROOT = '/workspace/siblings';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description:
      `Schedule a one-shot or recurring task. The user's timezone is declared in the <context timezone="..."/> header of your prompt — interpret the user's "9pm" etc. in that zone. Cron expressions are interpreted in the user's timezone too.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: {
          type: 'string',
          description:
            `ISO 8601 timestamp for the first run. Accepts either UTC (ending in "Z" or "+00:00") or a naive local timestamp (no offset) which is interpreted in the user's timezone (e.g. "2026-01-15T21:00:00" = 9pm user-local). Prefer naive local.`,
        },
        recurrence: {
          type: 'string',
          description:
            'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" = weekdays at 9am user-local). Evaluated in the user\'s timezone.',
        },
        script: { type: 'string', description: 'Optional pre-agent script to run before processing' },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    const processAfterIn = args.processAfter as string;
    if (!prompt || !processAfterIn) return err('prompt and processAfter are required');

    let processAfter: string;
    try {
      const d = parseZonedToUtc(processAfterIn, TIMEZONE);
      if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${processAfterIn}`);
      processAfter = d.toISOString();
    } catch {
      return err(`invalid processAfter: ${processAfterIn}`);
    }

    const id = generateId();
    const r = routing();
    const recurrence = (args.recurrence as string) || null;
    const script = (args.script as string) || null;

    // Write as a system action — host will insert into inbound.db
    writeMessageOut({
      id,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'schedule_task',
        taskId: id,
        prompt,
        script,
        processAfter,
        recurrence,
      }),
    });

    log(`schedule_task: ${id} at ${processAfter}${recurrence ? ` (recurring: ${recurrence})` : ''}`);
    return ok(`Task scheduled (id: ${id}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''})`);
  },
};

interface TaskRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
}

const LIST_TASKS_SQL_ALL = `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
   FROM messages_in
  WHERE kind = 'task' AND status IN ('pending', 'paused')
  GROUP BY series_id
  ORDER BY process_after ASC`;

const LIST_TASKS_SQL_FILTERED = `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
   FROM messages_in
  WHERE kind = 'task' AND status = ?
  GROUP BY series_id
  ORDER BY process_after ASC`;

function queryTasks(db: Database, status?: string): TaskRow[] {
  // One row per series — the live (pending or paused) occurrence. Recurring
  // tasks accumulate one completed row per firing plus one live follow-up;
  // exposing the whole pile to the agent is noisy and confuses task identity
  // ("which id do I cancel?"). The series_id is the stable handle.
  //
  // SQLite quirk: when MAX(seq) appears in the SELECT list of a GROUP BY
  // query, the bare columns take values from the row that contains that max
  // — that's how we pick "the latest live row per series" in one pass.
  if (status) return db.prepare(LIST_TASKS_SQL_FILTERED).all(status) as TaskRow[];
  return db.prepare(LIST_TASKS_SQL_ALL).all() as TaskRow[];
}

/**
 * Own session id — the directory name of /workspace's inbound.db sits at
 * `…/<agent_group_id>/<session_id>/inbound.db`, but the container only sees
 * /workspace directly. We derive the own session id from the sibling mount
 * (by exclusion) when listing.
 *
 * We figure it out by looking up the routing row and finding the matching
 * sibling dir — every session has its own routing row, so the sibling whose
 * routing equals ours is the one to skip.
 */
function listSiblingSessionIds(): string[] {
  if (!fs.existsSync(SIBLINGS_ROOT)) return [];
  try {
    return fs
      .readdirSync(SIBLINGS_ROOT)
      .filter((name) => {
        const dbPath = path.join(SIBLINGS_ROOT, name, 'inbound.db');
        try {
          return fs.statSync(dbPath).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

interface SiblingRouting {
  channel_type: string | null;
  platform_id: string | null;
}

function readSiblingRouting(db: Database): SiblingRouting | null {
  try {
    const row = db.prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1').get() as
      | SiblingRouting
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Map (channel_type, platform_id) → destination name using our own
 * destinations table. Every session sees the full destinations set for its
 * agent group, so the own session's destinations are the authoritative
 * lookup source for sibling channels too.
 */
function buildChannelNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const rows = getInboundDb()
      .prepare(
        "SELECT name, channel_type, platform_id FROM destinations WHERE type = 'channel' AND platform_id IS NOT NULL",
      )
      .all() as Array<{ name: string; channel_type: string | null; platform_id: string | null }>;
    for (const r of rows) {
      if (r.channel_type && r.platform_id) map.set(`${r.channel_type}|${r.platform_id}`, r.name);
    }
  } catch {
    // destinations table may be absent in a degenerate session — fall through.
  }
  return map;
}

function formatTaskLine(r: TaskRow, channelHint: string | null): string {
  const content = JSON.parse(r.content) as { prompt?: string };
  const prompt = (content.prompt || '').slice(0, 80);
  const where = channelHint ? ` channel=${channelHint}` : '';
  return `- ${r.id} [${r.status}] at=${r.process_after || 'now'} ${r.recurrence ? `recur=${r.recurrence} ` : ''}${where} → ${prompt}`;
}

export const listTasks: McpToolDefinition = {
  tool: {
    name: 'list_tasks',
    description:
      "List scheduled tasks. By default lists tasks in this channel's session only. Pass scope='all' to also list tasks from sibling sessions owned by the same agent group (e.g. when you're Andy in #main and want to see tasks scheduled in #weather, #typescript-learning, etc.). Each returned row includes a stable series id you can pass to cancel_task / update_task / pause_task / resume_task. For cross-session rows, also pass that row's targetSessionId so the op is applied to the right session.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending or paused (default: both)' },
        scope: {
          type: 'string',
          description:
            "'this' (default) lists only this session's tasks. 'all' includes sibling sessions from the same agent group.",
          enum: ['this', 'all'],
        },
      },
    },
  },
  async handler(args) {
    const status = args.status as string | undefined;
    const scope = (args.scope as string | undefined) ?? 'this';

    const ownRows = queryTasks(getInboundDb(), status);

    if (scope !== 'all') {
      if (ownRows.length === 0) return ok('No tasks found.');
      return ok(ownRows.map((r) => formatTaskLine(r, null)).join('\n'));
    }

    const channelByRouting = buildChannelNameMap();
    const sections: string[] = [];

    if (ownRows.length > 0) {
      const header = '# This session';
      sections.push([header, ...ownRows.map((r) => formatTaskLine(r, null))].join('\n'));
    }

    // Determine our own session id by finding the sibling whose routing
    // matches ours, then skip it during aggregation.
    const ownRouting = readSiblingRouting(getInboundDb());
    const ownKey = ownRouting?.channel_type && ownRouting?.platform_id
      ? `${ownRouting.channel_type}|${ownRouting.platform_id}`
      : null;

    for (const siblingId of listSiblingSessionIds()) {
      const dbPath = path.join(SIBLINGS_ROOT, siblingId, 'inbound.db');
      let db: Database | null = null;
      try {
        db = new Database(dbPath, { readonly: true });
        db.exec('PRAGMA busy_timeout = 5000');
        const routing = readSiblingRouting(db);
        const siblingKey = routing?.channel_type && routing?.platform_id
          ? `${routing.channel_type}|${routing.platform_id}`
          : null;
        // Skip our own session — it's already in ownRows.
        if (siblingKey && ownKey && siblingKey === ownKey) continue;
        const rows = queryTasks(db, status);
        if (rows.length === 0) continue;
        const channelName = siblingKey ? channelByRouting.get(siblingKey) ?? null : null;
        const label = channelName ? `#${channelName}` : siblingId;
        const header = `# ${label} (targetSessionId: ${siblingId})`;
        sections.push([header, ...rows.map((r) => formatTaskLine(r, channelName))].join('\n'));
      } catch (e) {
        sections.push(`# (sibling ${siblingId} unreadable: ${e instanceof Error ? e.message : String(e)})`);
      } finally {
        db?.close();
      }
    }

    if (sections.length === 0) return ok('No tasks found.');
    return ok(sections.join('\n\n'));
  },
};

const TARGET_SESSION_ID_PROP = {
  type: 'string',
  description:
    "Optional: operate on a sibling session's task instead of this session's. Pass the targetSessionId shown by list_tasks({scope:'all'}) for that task. The target must belong to the same agent group.",
} as const;

export const cancelTask: McpToolDefinition = {
  tool: {
    name: 'cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to cancel' },
        targetSessionId: TARGET_SESSION_ID_PROP,
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    const targetSessionId = (args.targetSessionId as string | undefined) || null;

    // Write as a system action — host will update inbound.db
    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'cancel_task', taskId, targetSessionId }),
    });

    log(`cancel_task: ${taskId}${targetSessionId ? ` target=${targetSessionId}` : ''}`);
    return ok(
      `Task cancellation requested: ${taskId}${targetSessionId ? ` (target session ${targetSessionId})` : ''}`,
    );
  },
};

export const pauseTask: McpToolDefinition = {
  tool: {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to pause' },
        targetSessionId: TARGET_SESSION_ID_PROP,
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    const targetSessionId = (args.targetSessionId as string | undefined) || null;

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'pause_task', taskId, targetSessionId }),
    });

    log(`pause_task: ${taskId}${targetSessionId ? ` target=${targetSessionId}` : ''}`);
    return ok(`Task pause requested: ${taskId}${targetSessionId ? ` (target session ${targetSessionId})` : ''}`);
  },
};

export const resumeTask: McpToolDefinition = {
  tool: {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to resume' },
        targetSessionId: TARGET_SESSION_ID_PROP,
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    const targetSessionId = (args.targetSessionId as string | undefined) || null;

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'resume_task', taskId, targetSessionId }),
    });

    log(`resume_task: ${taskId}${targetSessionId ? ` target=${targetSessionId}` : ''}`);
    return ok(`Task resume requested: ${taskId}${targetSessionId ? ` (target session ${targetSessionId})` : ''}`);
  },
};

export const updateTask: McpToolDefinition = {
  tool: {
    name: 'update_task',
    description:
      'Update a scheduled task. Pass the series id from list_tasks. Any field omitted is left unchanged. Use this instead of cancel + reschedule when adjusting an existing task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Series id of the task to update (as shown by list_tasks)' },
        prompt: { type: 'string', description: 'New task prompt (optional)' },
        recurrence: {
          type: 'string',
          description: 'New cron expression (optional). Pass empty string to clear and make the task one-shot.',
        },
        processAfter: {
          type: 'string',
          description:
            `New ISO 8601 timestamp for the next run (optional). Accepts either UTC (ending in "Z" / "+00:00") or a naive local timestamp interpreted in the user's timezone.`,
        },
        script: {
          type: 'string',
          description: 'New pre-agent script (optional). Pass empty string to clear.',
        },
        targetSessionId: TARGET_SESSION_ID_PROP,
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    const targetSessionId = (args.targetSessionId as string | undefined) || null;
    const update: Record<string, unknown> = { taskId };
    if (typeof args.prompt === 'string') update.prompt = args.prompt;
    if (typeof args.processAfter === 'string') {
      try {
        const d = parseZonedToUtc(args.processAfter, TIMEZONE);
        if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${args.processAfter}`);
        update.processAfter = d.toISOString();
      } catch {
        return err(`invalid processAfter: ${args.processAfter}`);
      }
    }
    // Empty string clears recurrence/script; undefined leaves them as-is.
    if (typeof args.recurrence === 'string') update.recurrence = args.recurrence === '' ? null : args.recurrence;
    if (typeof args.script === 'string') update.script = args.script === '' ? null : args.script;

    if (Object.keys(update).length === 1) return err('at least one field to update is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'update_task', ...update, targetSessionId }),
    });

    log(`update_task: ${taskId}${targetSessionId ? ` target=${targetSessionId}` : ''}`);
    return ok(`Task update requested: ${taskId}${targetSessionId ? ` (target session ${targetSessionId})` : ''}`);
  },
};

registerTools([scheduleTask, listTasks, updateTask, cancelTask, pauseTask, resumeTask]);
