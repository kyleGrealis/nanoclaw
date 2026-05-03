/**
 * In-memory tracking of active dispatched workers.
 *
 * Mapping: taskId → DispatchState (parent session, worker session, scope, timing).
 * Reverse index: workerSessionId → taskId so action handlers can look up
 * their parent context from the worker's session.
 *
 * Cleared on host process restart (workers from a prior run are detected
 * as orphans by the kevlar sweep on startup).
 */

export interface DispatchState {
  taskId: string;
  scope: string;
  brief: string;
  expected: string;
  parentSessionId: string;
  parentAgentGroupId: string;
  workerSessionId: string;
  workerAgentGroupId: string;
  workerFolderName: string;
  startedAt: number;
  timeoutMs: number;
  lastProgressAt: number;
  /** Set true once `complete_task` arrives. Prevents double-cleanup. */
  completed: boolean;
}

const byTaskId = new Map<string, DispatchState>();
const workerToTask = new Map<string, string>();

export function recordDispatch(state: DispatchState): void {
  byTaskId.set(state.taskId, state);
  workerToTask.set(state.workerSessionId, state.taskId);
}

export function getDispatchByTask(taskId: string): DispatchState | undefined {
  return byTaskId.get(taskId);
}

export function getDispatchByWorker(workerSessionId: string): DispatchState | undefined {
  const taskId = workerToTask.get(workerSessionId);
  if (!taskId) return undefined;
  return byTaskId.get(taskId);
}

export function listActiveDispatches(): DispatchState[] {
  return [...byTaskId.values()].filter((s) => !s.completed);
}

export function countActiveForParent(parentSessionId: string): number {
  let n = 0;
  for (const s of byTaskId.values()) {
    if (!s.completed && s.parentSessionId === parentSessionId) n++;
  }
  return n;
}

export function markCompleted(taskId: string): void {
  const s = byTaskId.get(taskId);
  if (s) s.completed = true;
}

export function removeDispatch(taskId: string): void {
  const s = byTaskId.get(taskId);
  if (s) workerToTask.delete(s.workerSessionId);
  byTaskId.delete(taskId);
}
