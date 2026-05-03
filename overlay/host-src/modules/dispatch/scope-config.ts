/**
 * Dispatch scope configuration.
 *
 * Each scope is a template directory at `dispatch-scopes/<scope>/` containing:
 *   - CLAUDE.md       — worker persona (instructs use of task_progress + complete_task)
 *   - container.json  — worker MCP toolset, model, mounts
 *
 * At dispatch time, the worker-spawn module copies these into a per-worker
 * folder under `groups/dispatch-workers/<taskId>/`, then registers an
 * ephemeral agent_group + session pointing at that folder.
 */
import fs from 'fs';
import path from 'path';

export const VALID_SCOPES = ['research', 'devops', 'data', 'plain'] as const;
export type Scope = (typeof VALID_SCOPES)[number];

export function isValidScope(s: string): s is Scope {
  return (VALID_SCOPES as readonly string[]).includes(s);
}

export function scopesRoot(): string {
  return path.join(process.cwd(), 'dispatch-scopes');
}

export function scopeDir(scope: Scope): string {
  return path.join(scopesRoot(), scope);
}

export interface ScopeConfig {
  scope: Scope;
  claudeMdPath: string;
  containerJsonPath: string;
}

export function loadScopeConfig(scope: Scope): ScopeConfig {
  const dir = scopeDir(scope);
  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  const containerJsonPath = path.join(dir, 'container.json');
  if (!fs.existsSync(dir)) {
    throw new Error(`Scope folder missing: ${dir}`);
  }
  if (!fs.existsSync(claudeMdPath)) {
    throw new Error(`Scope ${scope} missing CLAUDE.md at ${claudeMdPath}`);
  }
  if (!fs.existsSync(containerJsonPath)) {
    throw new Error(`Scope ${scope} missing container.json at ${containerJsonPath}`);
  }
  return { scope, claudeMdPath, containerJsonPath };
}
