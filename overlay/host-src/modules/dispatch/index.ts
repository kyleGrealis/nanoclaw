/**
 * Dispatch module — Andy → ephemeral worker → result.
 *
 * Registers three delivery action handlers:
 *   - `dispatch_task`   (Andy emits) → spawn worker, record state
 *   - `task_progress`   (worker emits) → forward to Andy's inbound
 *   - `complete_task`   (worker emits) → forward final result + cleanup
 *
 * Adds two side-effects on import:
 *   - Boot-time orphan scrub (clears worker dirs / DB rows from a prior crash)
 *   - Schedules `runDispatchKevlar` to fire each host-sweep tick (timeout
 *     enforcement, exit-without-result detection)
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

import { writeTaskProgressToParent, writeTaskResultToParent } from './forward.js';
import { runDispatchKevlar, scrubOrphansOnBoot } from './kevlar.js';
import {
  countActiveForParent,
  getDispatchByTask,
  getDispatchByWorker,
  markCompleted,
} from './state.js';
import { isValidScope, VALID_SCOPES } from './scope-config.js';
import { spawnWorker } from './worker-spawn.js';
import { cleanupWorker } from './worker-cleanup.js';

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 min default
const MAX_TIMEOUT_MS = 30 * 60_000;    // 30 min hard ceiling
const MAX_CONCURRENT_PER_PARENT = 3;

async function handleDispatchTask(
  content: Record<string, unknown>,
  parentSession: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = String(content.taskId || '');
  const scope = String(content.scope || 'plain');
  const brief = String(content.brief || '');
  const expected = String(content.expected || '');
  const requestedTimeoutMs = typeof content.timeoutMs === 'number' ? content.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(10_000, Math.min(requestedTimeoutMs, MAX_TIMEOUT_MS));

  // Build a scaffold-state-shaped object for failure paths so we can write
  // a task_result back without having a real DispatchState.
  const failResult = (status: 'error' | 'timeout' | 'crashed', text: string) => {
    writeTaskResultToParent(
      {
        taskId,
        scope,
        brief,
        expected,
        parentSessionId: parentSession.id,
        parentAgentGroupId: parentSession.agent_group_id,
        workerSessionId: '',
        workerAgentGroupId: '',
        workerFolderName: '',
        startedAt: Date.now(),
        timeoutMs,
        lastProgressAt: Date.now(),
        completed: true,
      },
      { status, text },
    );
  };

  if (!taskId) {
    log.warn('dispatch_task missing taskId', { content });
    return;
  }
  if (!brief) {
    failResult('error', 'Dispatch rejected: empty brief.');
    return;
  }
  if (!isValidScope(scope)) {
    failResult('error', `Dispatch rejected: invalid scope '${scope}'. Valid: ${VALID_SCOPES.join(', ')}.`);
    return;
  }
  if (countActiveForParent(parentSession.id) >= MAX_CONCURRENT_PER_PARENT) {
    failResult(
      'error',
      `Dispatch rejected: ${MAX_CONCURRENT_PER_PARENT} workers already in flight for this session. Wait for one to finish before dispatching another.`,
    );
    return;
  }

  try {
    await spawnWorker({
      taskId,
      scope,
      brief,
      expected,
      parentSessionId: parentSession.id,
      parentAgentGroupId: parentSession.agent_group_id,
      timeoutMs,
    });
  } catch (err) {
    log.error('spawnWorker threw', { taskId, scope, err });
    const msg = err instanceof Error ? err.message : String(err);
    failResult('error', `Dispatch failed during spawn: ${msg}`);
    // Best-effort cleanup if any partial state was created.
    try { cleanupWorker(taskId, 'spawn-failure'); } catch { /* ignore */ }
  }
}

async function handleTaskProgress(
  content: Record<string, unknown>,
  workerSession: Session,
  _inDb: Database.Database,
): Promise<void> {
  const state = getDispatchByWorker(workerSession.id);
  if (!state) {
    log.warn('task_progress from unknown/cleaned worker (ignored)', { workerSessionId: workerSession.id });
    return;
  }
  const text = String(content.text || '').trim();
  if (!text) {
    log.warn('task_progress with empty text (ignored)', { taskId: state.taskId });
    return;
  }
  state.lastProgressAt = Date.now();
  writeTaskProgressToParent(state, text);
}

async function handleCompleteTask(
  content: Record<string, unknown>,
  workerSession: Session,
  _inDb: Database.Database,
): Promise<void> {
  const state = getDispatchByWorker(workerSession.id);
  if (!state) {
    log.warn('complete_task from unknown/cleaned worker (ignored)', { workerSessionId: workerSession.id });
    return;
  }
  if (state.completed) {
    log.warn('complete_task arrived after already completed (ignored)', { taskId: state.taskId });
    return;
  }
  const summary = String(content.summary || '').trim();
  const finalText = summary || '(worker reported done but provided no summary text)';
  markCompleted(state.taskId);
  writeTaskResultToParent(state, { status: 'ok', text: finalText });
  cleanupWorker(state.taskId, 'complete_task');
}

registerDeliveryAction('dispatch_task', handleDispatchTask);
registerDeliveryAction('task_progress', handleTaskProgress);
registerDeliveryAction('complete_task', handleCompleteTask);

// Boot-time orphan scrub + ongoing kevlar tick on a 30s interval. Doesn't
// piggy-back on host-sweep so this module stays decoupled from sweep internals.
//
// The orphan scrub runs on the first tick (not at module load) because
// modules/index.js is imported BEFORE initDb() in src/index.ts — calling
// `getAllAgentGroups()` at import time throws "Database not initialized".
// First tick fires after 5s, by which point initDb has run.
const KEVLAR_TICK_MS = 30_000;
const FIRST_TICK_DELAY_MS = 5_000;
let scrubbed = false;
function tick(): void {
  if (!scrubbed) {
    try {
      scrubOrphansOnBoot();
      scrubbed = true;
    } catch (err) {
      log.error('scrubOrphansOnBoot threw (will retry next tick)', { err });
    }
  }
  try {
    runDispatchKevlar();
  } catch (err) {
    log.error('runDispatchKevlar threw', { err });
  }
}
setTimeout(() => {
  tick();
  setInterval(tick, KEVLAR_TICK_MS).unref();
}, FIRST_TICK_DELAY_MS).unref();

log.info('Dispatch module loaded', { scopes: VALID_SCOPES, defaultTimeoutMs: DEFAULT_TIMEOUT_MS, maxTimeoutMs: MAX_TIMEOUT_MS, maxConcurrentPerParent: MAX_CONCURRENT_PER_PARENT });
