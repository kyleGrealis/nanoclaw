/**
 * Kevlar tick — runs every host-sweep cycle to enforce timeouts and clean up
 * orphans that slipped past the normal complete_task flow.
 *
 * Three jobs:
 *   1. Hard timeout: dispatches whose age exceeds their `timeoutMs` budget
 *      get force-cleaned, with a synthesized task_result reporting the timeout.
 *   2. Stale workers: container exited (no longer in `activeContainers`) but
 *      no `complete_task` arrived. Synthesize a "worker exited unexpectedly"
 *      result so the parent isn't left hanging.
 *   3. Pre-existing orphans on host startup: any leftover
 *      `groups/dispatch-workers/*` dirs and `dispatch-ag-*` rows that weren't
 *      in this process's state map are scrubbed once at boot.
 */
import fs from 'fs';
import path from 'path';

import { isContainerRunning } from '../../container-runner.js';
import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { log } from '../../log.js';

import { listActiveDispatches, markCompleted } from './state.js';
import { cleanupWorker } from './worker-cleanup.js';
import { writeTaskResultToParent } from './forward.js';

export const HARD_CEILING_MS = 30 * 60_000; // 30 min absolute cap, regardless of opts

export function runDispatchKevlar(): void {
  const now = Date.now();
  for (const state of listActiveDispatches()) {
    const age = now - state.startedAt;
    const budget = Math.min(state.timeoutMs, HARD_CEILING_MS);

    if (age > budget) {
      log.warn('Dispatch timeout — force-cleaning worker', { taskId: state.taskId, ageMs: age, budgetMs: budget });
      writeTaskResultToParent(state, {
        status: 'timeout',
        text: `Worker timed out after ${Math.round(age / 1000)}s (budget ${Math.round(budget / 1000)}s). No final result was reported.`,
      });
      markCompleted(state.taskId);
      cleanupWorker(state.taskId, 'timeout');
      continue;
    }

    // Container exited but never sent complete_task — synthesize a result.
    if (!isContainerRunning(state.workerSessionId) && age > 5_000) {
      log.warn('Dispatch worker exited without complete_task', { taskId: state.taskId, ageMs: age });
      writeTaskResultToParent(state, {
        status: 'crashed',
        text: 'Worker container exited before reporting a final result. Likely a crash, OOM, or premature shutdown.',
      });
      markCompleted(state.taskId);
      cleanupWorker(state.taskId, 'container-exited-without-result');
    }
  }
}

/**
 * Boot-time scrub: clears worker dirs/agent-groups that survived a host
 * crash. Only safe to call once at startup, before any new dispatches.
 */
export function scrubOrphansOnBoot(): void {
  // Orphan agent_groups (anything with the dispatch-ag- prefix is one of ours
  // and predates this process — current process hasn't recorded any yet).
  for (const ag of getAllAgentGroups()) {
    if (!ag.id.startsWith('dispatch-ag-')) continue;
    log.warn('Scrubbing orphaned dispatch agent_group from prior run', { id: ag.id, folder: ag.folder });
    // Reuse the cleanup path with synthesized state keys won't work (state
    // is empty). Just delete the rows + folder directly.
    try {
      const folder = path.join(GROUPS_DIR, ag.folder);
      if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
    } catch (err) {
      log.warn('Orphan folder removal failed', { folder: ag.folder, err });
    }
    try {
      // Cascade-friendly order
      getDb().prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(ag.id);
      getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(ag.id);
    } catch (err) {
      log.warn('Orphan DB cleanup failed', { id: ag.id, err });
    }
  }

  // Orphan worker folders without a matching agent_group. Worker folders are
  // named `dispatch-worker-<taskId>` directly under groups/.
  if (fs.existsSync(GROUPS_DIR)) {
    for (const entry of fs.readdirSync(GROUPS_DIR)) {
      if (!entry.startsWith('dispatch-worker-')) continue;
      const p = path.join(GROUPS_DIR, entry);
      try {
        fs.rmSync(p, { recursive: true, force: true });
        log.warn('Scrubbed orphaned worker folder from prior run', { folder: entry });
      } catch (err) {
        log.warn('Orphan worker folder removal failed', { folder: entry, err });
      }
    }
  }
}
