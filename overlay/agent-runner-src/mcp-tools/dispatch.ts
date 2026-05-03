/**
 * `dispatch_task` — orchestrator → ephemeral worker dispatch.
 *
 * Spawns a fresh worker container with a scope-specific persona + toolset
 * and a single inbound message containing the brief. The worker emits zero
 * or more `task_progress` updates and exactly one `complete_task` summary,
 * which the host forwards back into this session's inbound as
 * `<dispatch_progress>` / `<dispatch_result>` tagged messages.
 *
 * Returns a `task_id` synchronously. The summary arrives later as a
 * separate inbound — DO NOT block waiting for it.
 *
 * Scopes (each grants a different model + toolset; see dispatch-scopes/<scope>/):
 *   - research — Gemini 3 Pro + googleSearch grounding + bash. For deep
 *     synthesis across many sources.
 *   - devops   — Gemini 3 Flash + bash + ssh. For infra commands across
 *     pi5/pi4/archMitters.
 *   - data     — Gemini 3 Flash + bash + filesystem. For chewing through
 *     files, sqlite DBs, logs.
 *   - plain    — Gemini 3 Flash + bash only. Catch-all for general work
 *     that doesn't need scoped tooling.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { writeMessageOut } from '../db/messages-out.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateTaskId(): string {
  return `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const dispatchTask: McpToolDefinition = {
  tool: {
    name: 'dispatch_task',
    description:
      "Spin up an ephemeral worker sub-agent to handle a long-running or specialized task without blocking your primary channel. The worker runs in an isolated container with a scope-specific toolset and model (research → Gemini 3 Pro + Google Search; devops/data/plain → Gemini 3 Flash). It reports back a `<dispatch_result>` summary as a later inbound message — you do NOT block waiting for it. May also send `<dispatch_progress>` updates mid-flight; relay or paraphrase those to the user as you see fit. Use for: chewing through a large log file, executing a multi-step DevOps procedure, doing a deep research dive across many sources, anything that would otherwise eat your turn budget. Don't use for quick lookups (use the appropriate MCP directly) or for chatting with the user. Acknowledge the dispatch to the user in plain natural language ('I'll dig into that and report back'); **do not mention the returned task_id** — it's an internal correlator. Default timeout 5min, max 30min.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        brief: {
          type: 'string',
          description:
            'Self-contained task description for the worker. Include all context the worker needs — it does not inherit your channel history or persona.',
        },
        scope: {
          type: 'string',
          enum: ['research', 'devops', 'data', 'plain'],
          description:
            'Which restricted toolset the worker gets. `research` = bash + recall + brave-style search; `devops` = bash + github + update_memory; `data` = bash + recall; `plain` = bash only. Defaults to `plain`.',
        },
        expected: {
          type: 'string',
          description:
            'What shape of result you want back (1-2 sentences). E.g. "a list of broken systemd units with their last error", "a markdown summary of the PR diff with risk callouts".',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Max worker runtime in ms before forced termination. Default 300000 (5min), max 1800000 (30min). Worker emits a `<dispatch_result status="timeout">` if it hits this.',
        },
      },
      required: ['brief'],
    },
  },
  async handler(args) {
    const brief = String(args.brief || '').trim();
    if (!brief) return err('`brief` is required.');
    const scope = (typeof args.scope === 'string' ? args.scope : 'plain') as string;
    const expected = typeof args.expected === 'string' ? args.expected.trim() : '';
    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : undefined;

    const taskId = generateTaskId();

    try {
      writeMessageOut({
        id: taskId,
        kind: 'system',
        platform_id: null,
        channel_type: null,
        thread_id: null,
        content: JSON.stringify({
          action: 'dispatch_task',
          taskId,
          brief,
          scope,
          expected,
          ...(timeoutMs ? { timeoutMs } : {}),
        }),
      });
    } catch (e) {
      log(`dispatch_task: failed to record outbound system message: ${e}`);
      return err(`Could not queue dispatch: ${e instanceof Error ? e.message : String(e)}`);
    }

    log(`dispatch_task: queued task=${taskId} scope=${scope} brief.len=${brief.length}`);

    return ok(
      `Worker accepted (scope=${scope}). Result will arrive later as a separate inbound message wrapped in a <dispatch_result>…</dispatch_result> tag, with optional <dispatch_progress>…</dispatch_progress> updates beforehand. ` +
        `When acknowledging the user, **do not mention the task_id** — it's an internal correlator, not user-facing data. Acknowledge naturally in your own voice (e.g. "I'll dig into that and report back", "On it, give me a minute"). The id is preserved in the dispatch tags themselves so you can match results to the original ask without leaking it to the user.`,
    );
  },
};

registerTools([dispatchTask]);
