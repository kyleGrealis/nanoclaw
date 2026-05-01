/**
 * Bash MCP tool — execute a shell command inside the agent container.
 *
 * The Claude Agent SDK ships with a built-in Bash tool; the Gemini provider
 * does not, so this fills the gap. The container is itself the sandbox, so
 * no further command filtering is applied here — destructive guardrails
 * (no `git reset --hard`, no `rm`, etc.) live in the persona, not in code.
 *
 * Output is the combined stdout+stderr stream, capped to keep tool results
 * inside Gemini's per-call payload limits. Large output should be redirected
 * to a file under /workspace/agent/ and surfaced with `send_file` instead.
 */
import { spawn } from 'child_process';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_CWD = '/workspace/agent';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// Host OPSEC Policy: Block destructive commands and exfiltration patterns
const DANGEROUS_COMMANDS_RE = /\b(rm\s+-[rR]f?|chmod\s+-R|chown\s+-R|mkfs|dd\s+if=|git\s+reset\s+--hard|git\s+push\s+.*--force)\b/i;

function isCommandSafe(command: string): { safe: boolean; reason?: string } {
  if (DANGEROUS_COMMANDS_RE.test(command)) {
    return { safe: false, reason: 'Destructive command detected (e.g., rm -rf, chmod -R, git reset --hard, or force-push).' };
  }
  return { safe: true };
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface BashResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

function runBash(command: string, cwd: string, timeoutMs: number): Promise<BashResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;

    const child = spawn('bash', ['-c', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const cap = (buf: Buffer, chunks: Buffer[], current: number): number => {
      if (current >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      const remaining = MAX_OUTPUT_BYTES - current;
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        truncated = true;
        return MAX_OUTPUT_BYTES;
      }
      chunks.push(buf);
      return current + buf.length;
    };

    child.stdout.on('data', (b: Buffer) => {
      stdoutBytes = cap(b, stdoutChunks, stdoutBytes);
    });
    child.stderr.on('data', (b: Buffer) => {
      stderrBytes = cap(b, stderrChunks, stderrBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8') + `\nspawn error: ${e.message}`,
        truncated,
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
        timedOut,
      });
    });
  });
}

function formatResult(command: string, cwd: string, r: BashResult): string {
  const status = r.timedOut
    ? `timed out (SIGTERM after deadline)`
    : r.signal
      ? `killed by signal ${r.signal}`
      : `exit ${r.exitCode}`;
  const parts: string[] = [`$ ${command}`, `cwd: ${cwd}`, `status: ${status}`];
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  if (!r.stdout && !r.stderr) parts.push(`(no output)`);
  if (r.truncated) parts.push(`(output truncated at ${MAX_OUTPUT_BYTES} bytes — redirect to a file for full output)`);
  return parts.join('\n\n');
}

export const bash: McpToolDefinition = {
  tool: {
    name: 'bash',
    description:
      "Execute a shell command inside your container sandbox and return the combined stdout/stderr with exit code. Use for filesystem inspection (ls, find, cat, grep), running scripts, curl checks, git operations on mounted repos, and other one-shot shell work. The container is your sandbox — host paths are reachable only through configured mounts (typically /workspace/agent, /workspace/home, etc.). Output is capped at 64KB; for larger results, redirect to a file under /workspace/agent and use send_file. Default timeout 30s, max 300s. **Note: A Host OPSEC policy is enforced; destructive commands (rm -rf, chmod -R, git reset --hard, force-push, etc.) are blocked. Use safer alternatives like trash-put.**",
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run via `bash -c`. Multi-line scripts are supported.',
        },
        cwd: {
          type: 'string',
          description: `Working directory for the command. Defaults to ${DEFAULT_CWD}.`,
        },
        timeout_ms: {
          type: 'number',
          description: `Hard timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
        },
      },
      required: ['command'],
    },
  },
  async handler(args) {
    const command = String(args.command || '').trim();
    if (!command) return err('command is required');

    const safety = isCommandSafe(command);
    if (!safety.safe) {
      return err(`Execution blocked by Host OPSEC policy: ${safety.reason} Please use safer alternatives (e.g., trash-put instead of rm, or soft git resets).`);
    }

    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : DEFAULT_CWD;
    const requestedTimeout =
      typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.floor(requestedTimeout));

    log(`bash: cwd=${cwd} timeout=${timeout}ms cmd=${command.length > 120 ? command.slice(0, 120) + '…' : command}`);
    const result = await runBash(command, cwd, timeout);
    const text = formatResult(command, cwd, result);
    if (result.exitCode !== 0 || result.timedOut || result.signal) {
      return { content: [{ type: 'text' as const, text }], isError: true };
    }
    return ok(text);
  },
};

registerTools([bash]);
