/**
 * Tests for the heartbeat lifecycle helper. Regression: the container-runner
 * left stale `.heartbeat` files behind on exit, so respawns inherited an
 * old mtime and got killed by host-sweep's ceiling check within seconds.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sm-test-'));
  vi.resetModules();
  process.env.DATA_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe('clearHeartbeat', () => {
  it('removes the heartbeat file so a respawn starts with no mtime', async () => {
    const { clearHeartbeat, heartbeatPath, sessionDir } = await import('./session-manager.js');
    const ag = 'ag-test';
    const sess = 'sess-test';
    fs.mkdirSync(sessionDir(ag, sess), { recursive: true });
    const hbPath = heartbeatPath(ag, sess);
    fs.writeFileSync(hbPath, '');
    expect(fs.existsSync(hbPath)).toBe(true);

    clearHeartbeat(ag, sess);

    expect(fs.existsSync(hbPath)).toBe(false);
  });

  it('is a no-op when no heartbeat file exists', async () => {
    const { clearHeartbeat, sessionDir } = await import('./session-manager.js');
    const ag = 'ag-test';
    const sess = 'sess-test';
    fs.mkdirSync(sessionDir(ag, sess), { recursive: true });

    expect(() => clearHeartbeat(ag, sess)).not.toThrow();
  });
});
