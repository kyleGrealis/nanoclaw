/**
 * Spawn a dispatched worker.
 *
 * Workers register as ephemeral agent_groups + sessions in v2.db so they
 * reuse the existing `wakeContainer` machinery (OneCLI gateway, mounts,
 * provider env, host-sweep). Cleanup tears these rows down on completion.
 *
 * Folder layout:
 *   groups/dispatch-workers/<taskId>/         (cleared on cleanup)
 *     CLAUDE.md         (copied from dispatch-scopes/<scope>/CLAUDE.md)
 *     CLAUDE.local.md   (empty — required by initGroupFilesystem)
 *     container.json    (copied from dispatch-scopes/<scope>/container.json)
 *
 * Inbound is pre-populated with one message containing the brief + the
 * caller's "expected result shape" hint, so when the worker container wakes
 * it sees a single user prompt and reacts to it.
 */
import fs from 'fs';
import path from 'path';

import { wakeContainer } from '../../container-runner.js';
import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

import { recordDispatch, type DispatchState } from './state.js';
import { loadScopeConfig, type Scope } from './scope-config.js';

export interface SpawnWorkerInput {
  taskId: string;
  scope: Scope;
  brief: string;
  expected: string;
  parentSessionId: string;
  parentAgentGroupId: string;
  timeoutMs: number;
}

// Single-segment folder name (NOT a nested dir). The container-runner builds
// its docker container name as `nanoclaw-v2-${folder}-${timestamp}`, and
// docker rejects names containing `/` with exit code 125. Using a flat
// `dispatch-worker-<taskId>` keeps the name docker-legal.
const WORKER_FOLDER_PREFIX = 'dispatch-worker-';

function workerFolderName(taskId: string): string {
  return `${WORKER_FOLDER_PREFIX}${taskId}`;
}

function workerFolderPath(taskId: string): string {
  return path.join(GROUPS_DIR, workerFolderName(taskId));
}

function copyScopeIntoWorkerDir(scope: Scope, taskId: string): string {
  const dst = workerFolderPath(taskId);
  fs.mkdirSync(dst, { recursive: true });

  const cfg = loadScopeConfig(scope);
  fs.copyFileSync(cfg.claudeMdPath, path.join(dst, 'CLAUDE.md'));
  fs.copyFileSync(cfg.containerJsonPath, path.join(dst, 'container.json'));

  // CLAUDE.local.md is required by group-init; seed empty to keep it from
  // copying any stale persona content. Workers don't have memory.
  const claudeLocal = path.join(dst, 'CLAUDE.local.md');
  if (!fs.existsSync(claudeLocal)) {
    fs.writeFileSync(claudeLocal, '# Worker scratch (ephemeral)\n');
  }

  return dst;
}

function buildBriefMessage(input: SpawnWorkerInput): string {
  const lines = [
    `# Dispatched task — ${input.scope}`,
    '',
    `**Task ID:** ${input.taskId}`,
    `**Brief:** ${input.brief}`,
  ];
  if (input.expected.trim()) {
    lines.push(`**Expected result shape:** ${input.expected}`);
  }
  lines.push(
    '',
    'You are a single-shot worker. Use `task_progress(text)` for incremental updates while you work, then call `complete_task(summary)` exactly once with your final result. After `complete_task`, your container terminates.',
  );
  return lines.join('\n');
}

export async function spawnWorker(input: SpawnWorkerInput): Promise<DispatchState> {
  const workerAgentGroupId = `dispatch-ag-${input.taskId}`;
  const workerSessionId = `dispatch-sess-${input.taskId}`;
  const folderName = workerFolderName(input.taskId);
  const nowIso = new Date().toISOString();

  // 1. Materialize the scope template into the worker folder
  copyScopeIntoWorkerDir(input.scope, input.taskId);

  // 2. Register ephemeral agent_group + session in v2.db
  createAgentGroup({
    id: workerAgentGroupId,
    name: `dispatch-${input.scope}-${input.taskId}`,
    folder: folderName,
    agent_provider: null,
    created_at: nowIso,
  });

  const session: Session = {
    id: workerSessionId,
    agent_group_id: workerAgentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: nowIso,
    created_at: nowIso,
  };
  createSession(session);

  // 3. Initialize session folder (creates inbound.db + outbound.db + outbox/)
  initSessionFolder(workerAgentGroupId, workerSessionId);

  // 4. Pre-populate inbound with the one message that drives the worker
  writeSessionMessage(workerAgentGroupId, workerSessionId, {
    id: `dispatch-brief-${input.taskId}`,
    kind: 'chat',
    timestamp: nowIso,
    content: buildBriefMessage(input),
    trigger: 1,
  });

  // 5. Record state BEFORE waking — so action handlers can find the parent
  //    even if the worker emits its first event very fast.
  const state: DispatchState = {
    taskId: input.taskId,
    scope: input.scope,
    brief: input.brief,
    expected: input.expected,
    parentSessionId: input.parentSessionId,
    parentAgentGroupId: input.parentAgentGroupId,
    workerSessionId,
    workerAgentGroupId,
    workerFolderName: folderName,
    startedAt: Date.now(),
    timeoutMs: input.timeoutMs,
    lastProgressAt: Date.now(),
    completed: false,
  };
  recordDispatch(state);

  // 6. Wake container — async, non-blocking. Failures here surface to the
  //    caller via promise rejection; caller writes a task_result with the
  //    error so the parent agent isn't left hanging.
  await wakeContainer(session);

  log.info('Dispatched worker spawned', {
    taskId: input.taskId,
    scope: input.scope,
    workerSessionId,
    parentSessionId: input.parentSessionId,
  });

  return state;
}
