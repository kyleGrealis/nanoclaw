/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember the SDK session ID so the agent's conversation
 * resumes across container restarts. Cleared by /clear.
 */
import { getOutboundDb } from './connection.js';

const SDK_SESSION_KEY = 'sdk_session_id';

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare(
      'INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)',
    )
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

export function getStoredSessionId(): string | undefined {
  return getValue(SDK_SESSION_KEY);
}

export function getStoredSessionUpdatedAt(): Date | undefined {
  const row = getOutboundDb()
    .prepare('SELECT updated_at FROM session_state WHERE key = ?')
    .get(SDK_SESSION_KEY) as { updated_at: string } | undefined;
  if (!row?.updated_at) return undefined;
  const d = new Date(row.updated_at);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function setStoredSessionId(sessionId: string): void {
  setValue(SDK_SESSION_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  deleteValue(SDK_SESSION_KEY);
}
