/**
 * Bash MCP tool — execute a shell command inside the agent container.
 *
 * The Claude Agent SDK ships with a built-in Bash tool; the Gemini provider
 * does not, so this tool fills the gap.
 *
 * The container is itself the sandbox, but persona-level rules ("don't run
 * rm", "don't `git reset --hard`") are advisory — the model can talk itself
 * around them under prompt injection. So we add a deterministic pre-flight
 * deny-list here as defense-in-depth: a fixed set of regexes the agent
 * cannot bypass by phrasing tricks. If a command matches a rule, the tool
 * returns a structured `Error: Execution blocked by Host OPSEC policy` so
 * the model learns to route around it (use the suggested alternative)
 * instead of crashing the container.
 *
 * Origin: built on Gemini CLI's seed regex (`a9d535b` in operator repo) and
 * extended to cover the full destructive-git list, trash-cli enforcement
 * (Kyle's `feedback_use_trash` memory: rm is permanently blocked even with
 * mild flags; deletes go through trash-put, never `trash-empty`), and a
 * couple of disk/permission/exfil patterns.
 *
 * Output is the combined stdout+stderr stream, capped at 64KB. Large output
 * should be redirected to a file under /workspace/agent/ and surfaced with
 * `send_file`.
 */
import { spawn } from 'child_process';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_CWD = '/workspace/agent';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

interface OpsecRule {
  /** Identifying name for telemetry / logs. */
  name: string;
  /** Pattern to match against the raw command string. */
  pattern: RegExp;
  /** Human-friendly explanation surfaced back to the model. */
  reason: string;
  /** Suggested safer alternative the model should attempt instead. */
  suggestion: string;
}

/**
 * Deny-list, evaluated in order. First match wins. Anchored with `\b` /
 * explicit boundaries to keep substrings inside larger words from matching
 * (e.g. `chmod 644 file` is fine; `chmod -R 777 /` is not).
 */
const OPSEC_RULES: OpsecRule[] = [
  // ---- File deletion: trash-cli is non-negotiable -----------------------
  {
    name: 'rm-any',
    // matches `rm` as a command word with any flags/args; tolerant of
    // leading sudo. NOT matching `rm` inside larger words (`firmware`,
    // `arm-`) thanks to the leading boundary.
    pattern: /(^|[\s;&|`(])(?:sudo\s+)?rm(\s|$)/,
    reason: 'Direct `rm` is banned — deletes must be recoverable.',
    suggestion: 'Use `trash-put <path>` instead. Files go to the host trash and are recoverable.',
  },
  {
    name: 'trash-empty',
    pattern: /(^|[\s;&|`(])(?:sudo\s+)?(trash-empty|trash-rm)\b/,
    reason: 'Emptying the trash defeats the recoverability guarantee.',
    suggestion:
      'Leave the trash alone. If you need to verify a delete is gone, list with `trash-list`. Kyle empties manually on the host.',
  },
  {
    name: 'gio-trash-empty',
    pattern: /\bgio\s+trash\s+(--empty|-e)\b/,
    reason: 'Same rule via the GIO backend — trash must stay recoverable.',
    suggestion: 'Use `trash-list` to inspect. Do not empty.',
  },

  // ---- Destructive git ops (Kyle: nuked a sqlite DB on 2026-04-28) ------
  {
    name: 'git-reset-hard',
    pattern: /\bgit\s+(?:-[A-Za-z]+\s+)*reset\s+(?:[^\n]*\s)?--hard\b/,
    reason: '`git reset --hard` discards uncommitted work irrecoverably.',
    suggestion: 'Use `git reset` (mixed) or `git reset --soft`, or `git stash` first.',
  },
  {
    name: 'git-clean-force',
    pattern: /\bgit\s+(?:-[A-Za-z]+\s+)*clean\s+(?:[^\n]*\s)?-[a-zA-Z]*[fxFX][a-zA-Z]*/,
    reason: '`git clean -f[dx]` permanently deletes untracked files.',
    suggestion: 'List with `git clean -n` first. If you actually need to remove, ask Kyle.',
  },
  {
    name: 'git-checkout-discard',
    // matches `git checkout -- ...` or `git checkout .` only.
    // does NOT match `git checkout main`, `git checkout -b feature`, etc.
    pattern: /\bgit\s+(?:-[A-Za-z]+\s+)*checkout\s+(--(\s|$)|\.\s*(?:$|[;&|]))/,
    reason: '`git checkout -- <path>` or `git checkout .` discards working-tree edits.',
    suggestion: 'Stash first (`git stash push -m "before checkout"`) then checkout.',
  },
  {
    name: 'git-restore-discard',
    // matches `git restore .` (with the dot path). `git restore --staged ...`
    // is fine — it only operates on the index. `git restore some-file` is
    // also destructive but we block only the .-path variant explicitly per
    // Kyle's documented rule; for individual files, persona guidance applies.
    pattern: /\bgit\s+(?:-[A-Za-z]+\s+)*restore\s+(?:--worktree\s+)?\.\s*(?:$|[;&|])/,
    reason: '`git restore .` discards all working-tree edits.',
    suggestion: 'Stash first, or restore individual files explicitly.',
  },
  {
    name: 'git-stash-drop',
    pattern: /\bgit\s+(?:-[A-Za-z]+\s+)*stash\s+(drop|clear)\b/,
    reason: 'Dropping/clearing stashes is irrecoverable.',
    suggestion: 'Inspect with `git stash list`. If a stash is truly stale, ask Kyle to drop it.',
  },
  {
    name: 'git-branch-Delete',
    pattern: /\bgit\s+(?:-[A-Za-z]+\s+)*branch\s+(?:[^\n]*\s)?-D\b/,
    reason: 'Capital `-D` force-deletes unmerged branches.',
    suggestion: 'Use lowercase `-d` (safe delete; refuses if unmerged).',
  },
  {
    name: 'git-push-force',
    // allow --force-with-lease (safer); block bare --force / -f
    pattern: /\bgit\s+(?:-[A-Za-z]+\s+)*push\b(?=[^\n]*\s(--force(?!-with-lease)|-f\b))/,
    reason: 'Bare `git push --force` overwrites remote history.',
    suggestion: 'Use `--force-with-lease`, which refuses to clobber concurrent pushes.',
  },

  // ---- Permission / ownership escalation --------------------------------
  {
    name: 'chmod-recursive',
    pattern: /\bchmod\s+(?:[^\n]*\s)?-R\b/,
    reason: 'Recursive chmod is rarely what you want and easy to over-apply.',
    suggestion: 'Apply `chmod` per-file, or describe what you need and Kyle will run it.',
  },
  {
    name: 'chown-recursive',
    pattern: /\bchown\s+(?:[^\n]*\s)?-R\b/,
    reason: 'Recursive chown can break ownership across mounted volumes.',
    suggestion: 'Apply `chown` per-file, or ask Kyle.',
  },

  // ---- Filesystem / disk-level operations -------------------------------
  {
    name: 'mkfs',
    pattern: /\bmkfs(\.[a-zA-Z0-9]+)?\b/,
    reason: 'Creating a filesystem destroys whatever is on the target device.',
    suggestion: 'Out of scope for an agent. Ask Kyle.',
  },
  {
    name: 'dd-write',
    pattern: /\bdd\s+(?:[^\n]*\s)?(if|of)=\/dev\//,
    reason: '`dd` reading from or writing to /dev/ is a disk-level op.',
    suggestion: 'Out of scope for an agent. Ask Kyle.',
  },
  {
    name: 'redirect-to-block-device',
    pattern: />\s*\/dev\/(sd[a-z]|nvme|mmcblk)\b/,
    reason: 'Redirecting output into a block device wipes it.',
    suggestion: 'You almost certainly meant a regular file path.',
  },

  // ---- Outbound network: bare IP destinations smell like exfil ----------
  // Fine to research with curl/wget against domain names. Bare public-IPv4
  // destinations are a classic exfil pattern; deny by default.
  {
    name: 'curl-bare-ip',
    pattern: /\b(curl|wget)\s+(?:[^\n]*\s)?(https?:\/\/)?\b(?!127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)((?:\d{1,3}\.){3}\d{1,3})\b/,
    reason: 'curl/wget to a bare public IP is an exfiltration pattern.',
    suggestion:
      'Use a domain name. If you genuinely need an IP literal (lab work), ask Kyle to allow-list it.',
  },
];

interface SafetyVerdict {
  safe: true;
}
interface SafetyBlock {
  safe: false;
  rule: OpsecRule;
  match: string;
}
type Safety = SafetyVerdict | SafetyBlock;

function checkOpsec(command: string): Safety {
  for (const rule of OPSEC_RULES) {
    const m = command.match(rule.pattern);
    if (m) return { safe: false, rule, match: m[0].trim() };
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
      "Execute a shell command inside your container sandbox and return the combined stdout/stderr with exit code. Use for filesystem inspection (ls, find, cat, grep), running scripts, curl checks against domain names, git operations on mounted repos, and other one-shot shell work. The container is your sandbox — host paths are reachable only through configured mounts (typically /workspace/agent, /workspace/home, etc.). Output is capped at 64KB; for larger results, redirect to a file under /workspace/agent and use send_file. Default timeout 30s, max 300s. **Host OPSEC policy is enforced before spawn:** `rm` is banned (use `trash-put`); the trash itself is also protected (no `trash-empty`); destructive git ops are blocked (no `reset --hard`, `clean -f`, `checkout -- .`, `restore .`, `stash drop`, `branch -D`, bare `push --force`); recursive chmod/chown, mkfs, dd to /dev, and curl/wget to bare public IPs are blocked. Blocked commands return a structured error with a safer-alternative suggestion — read the suggestion and retry with the alternative.",
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

    const verdict = checkOpsec(command);
    if (!verdict.safe) {
      const { rule, match } = verdict;
      log(`bash: BLOCKED rule=${rule.name} match="${match}"`);
      return err(
        `Execution blocked by Host OPSEC policy.\n` +
          `Rule: ${rule.name}\n` +
          `Matched: \`${match}\`\n` +
          `Reason: ${rule.reason}\n` +
          `Try instead: ${rule.suggestion}`,
      );
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
