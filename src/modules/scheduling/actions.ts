/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { openInboundDb as openInboundDbRaw } from '../../db/session-db.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/**
 * Resolve the inbound.db the action should operate on.
 *
 * If `content.targetSessionId` is present, open that session's inbound.db
 * instead of the caller's — used for cross-session task management. The
 * target must belong to the same agent_group as the caller; otherwise the
 * caller could manipulate another agent's tasks. Returns null on violation.
 *
 * When a target DB is opened, the caller owns closing it (via `close`).
 * When no target is specified, `close` is a no-op — the caller's inDb
 * lifetime is managed by delivery.ts.
 */
function resolveTargetInDb(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): { inDb: Database.Database; close: () => void; targetSessionId: string | null } | null {
  const targetSessionId = content.targetSessionId as string | undefined;
  if (!targetSessionId || targetSessionId === session.id) {
    return { inDb, close: () => {}, targetSessionId: null };
  }
  const target = getSession(targetSessionId);
  if (!target) {
    log.warn('Cross-session task op: target session not found', { targetSessionId });
    return null;
  }
  if (target.agent_group_id !== session.agent_group_id) {
    log.warn('Cross-session task op: agent group mismatch (denied)', {
      callerSessionId: session.id,
      callerAgentGroup: session.agent_group_id,
      targetSessionId,
      targetAgentGroup: target.agent_group_id,
    });
    return null;
  }
  const targetDb = openInboundDbRaw(inboundDbPath(target.agent_group_id, target.id));
  return { inDb: targetDb, close: () => targetDb.close(), targetSessionId };
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
    content: JSON.stringify({ prompt, script }),
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const resolved = resolveTargetInDb(content, session, inDb);
  if (!resolved) return;
  try {
    cancelTask(resolved.inDb, taskId);
    log.info('Task cancelled', { taskId, targetSessionId: resolved.targetSessionId });
  } finally {
    resolved.close();
  }
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const resolved = resolveTargetInDb(content, session, inDb);
  if (!resolved) return;
  try {
    pauseTask(resolved.inDb, taskId);
    log.info('Task paused', { taskId, targetSessionId: resolved.targetSessionId });
  } finally {
    resolved.close();
  }
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const resolved = resolveTargetInDb(content, session, inDb);
  if (!resolved) return;
  try {
    resumeTask(resolved.inDb, taskId);
    log.info('Task resumed', { taskId, targetSessionId: resolved.targetSessionId });
  } finally {
    resolved.close();
  }
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const resolved = resolveTargetInDb(content, session, inDb);
  if (!resolved) return;
  let touched: number;
  try {
    touched = updateTask(resolved.inDb, taskId, update);
  } finally {
    resolved.close();
  }
  log.info('Task updated', {
    taskId,
    touched,
    fields: Object.keys(update),
    targetSessionId: resolved.targetSessionId,
  });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
