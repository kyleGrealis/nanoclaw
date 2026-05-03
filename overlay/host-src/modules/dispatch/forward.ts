/**
 * Write task_progress and task_result events back to the parent session's
 * inbound.db so the parent agent (Andy) sees them on its next wake.
 *
 * Format: a `kind=text` inbound message wrapped in a `<dispatch_progress>` or
 * `<dispatch_result>` tag. The tag carries `task_id` and `scope` attributes
 * so the parent agent's persona can recognize them as worker output (not
 * user input) and route accordingly. We deliberately avoid a custom `kind`
 * value so the existing message-formatter and SDK pipeline don't need any
 * special-casing — Andy just sees text.
 */
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

import type { DispatchState } from './state.js';

interface ResultPayload {
  status: 'ok' | 'timeout' | 'crashed' | 'error';
  text: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Minimum ms between forwarded progress events per worker. Workers
 *  occasionally fire task_progress per tool call (5+ in 30s), which
 *  spams the parent's inbound. Excess is silently dropped here so the
 *  worker stays unaware (no model behavior change needed). */
const PROGRESS_MIN_INTERVAL_MS = 15_000;

export function writeTaskProgressToParent(state: DispatchState, text: string): void {
  const sinceLast = Date.now() - state.lastProgressAt;
  if (sinceLast < PROGRESS_MIN_INTERVAL_MS) {
    log.debug('Dropping task_progress (under min interval)', {
      taskId: state.taskId,
      sinceLastMs: sinceLast,
      minMs: PROGRESS_MIN_INTERVAL_MS,
    });
    return;
  }
  const parent = getSession(state.parentSessionId);
  if (!parent) {
    log.warn('writeTaskProgressToParent: parent session vanished', { taskId: state.taskId });
    return;
  }
  state.lastProgressAt = Date.now();
  const wrapped = `<dispatch_progress task_id="${state.taskId}" scope="${state.scope}">\n${text}\n</dispatch_progress>`;
  writeSessionMessage(parent.agent_group_id, parent.id, {
    id: `dispatch-progress-${state.taskId}-${Date.now()}`,
    kind: 'chat',
    timestamp: nowIso(),
    content: wrapped,
    trigger: 1,
  });
  // Wake the parent so the message is processed promptly. Failures here are
  // non-fatal — the next user message would pick it up too.
  void wakeContainer(parent).catch((err) => {
    log.warn('Wake parent after dispatch_progress failed (non-fatal)', { taskId: state.taskId, err });
  });
}

export function writeTaskResultToParent(state: DispatchState, payload: ResultPayload): void {
  const parent = getSession(state.parentSessionId);
  if (!parent) {
    log.warn('writeTaskResultToParent: parent session vanished', { taskId: state.taskId, status: payload.status });
    return;
  }
  const wrapped =
    `<dispatch_result task_id="${state.taskId}" scope="${state.scope}" status="${payload.status}">\n` +
    `${payload.text}\n` +
    `</dispatch_result>`;
  writeSessionMessage(parent.agent_group_id, parent.id, {
    id: `dispatch-result-${state.taskId}`,
    kind: 'chat',
    timestamp: nowIso(),
    content: wrapped,
    trigger: 1,
  });
  void wakeContainer(parent).catch((err) => {
    log.warn('Wake parent after dispatch_result failed (non-fatal)', { taskId: state.taskId, err });
  });
}
