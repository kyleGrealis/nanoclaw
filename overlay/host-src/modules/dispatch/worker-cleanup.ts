/**
 * Tear down a dispatched worker.
 *
 * Order matters:
 *   1. Kill container first (so it can't write more outbound between cleanup steps).
 *   2. Remove DB rows.
 *   3. Trash worker folder (best-effort; trash-put failure must not break cleanup).
 *   4. Remove from in-memory state.
 *
 * Cleanup is idempotent: calling it twice on the same taskId is a no-op the
 * second time (state lookup returns undefined).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { killContainer } from '../../container-runner.js';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { deleteAgentGroup } from '../../db/agent-groups.js';
import { deleteSession } from '../../db/sessions.js';
import { log } from '../../log.js';

import { getDispatchByTask, removeDispatch } from './state.js';

function trashOrRemove(p: string): void {
  if (!fs.existsSync(p)) return;
  // Prefer trash-put (Kyle's recoverable-delete policy); fall back to rm -rf
  // if trash-put isn't on PATH (CI / alt environments).
  const trash = spawnSync('trash-put', [p], { stdio: 'ignore' });
  if (trash.status === 0) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (err) {
    log.warn('Failed to remove worker dir', { path: p, err });
  }
}

export function cleanupWorker(taskId: string, reason: string): void {
  const state = getDispatchByTask(taskId);
  if (!state) {
    log.debug('cleanupWorker: no state for task (already cleaned?)', { taskId });
    return;
  }

  log.info('Cleaning up dispatched worker', { taskId, reason, workerSessionId: state.workerSessionId });

  // 1. Kill container (no-op if already exited)
  try {
    killContainer(state.workerSessionId, `dispatch-cleanup: ${reason}`);
  } catch (err) {
    log.warn('killContainer threw during cleanup (continuing)', { taskId, err });
  }

  // 2. DB rows. Sessions FK references agent_groups so delete in order.
  try {
    deleteSession(state.workerSessionId);
  } catch (err) {
    log.warn('deleteSession failed (continuing)', { taskId, err });
  }
  try {
    deleteAgentGroup(state.workerAgentGroupId);
  } catch (err) {
    log.warn('deleteAgentGroup failed (continuing)', { taskId, err });
  }

  // 3. Worker folder + session data dir
  const folder = path.join(GROUPS_DIR, state.workerFolderName);
  trashOrRemove(folder);

  const sessDir = path.join(DATA_DIR, 'v2-sessions', state.workerAgentGroupId);
  trashOrRemove(sessDir);

  // 4. State map
  removeDispatch(taskId);
}
