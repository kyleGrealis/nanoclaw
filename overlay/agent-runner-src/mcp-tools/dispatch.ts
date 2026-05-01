/**
 * `dispatch_task` MCP tool — orchestrator → ephemeral worker dispatch.
 *
 * STATUS: scaffolded only. The tool signature is final. The host-side
 * dispatcher that actually spawns an ephemeral worker container is
 * not yet wired. For now this returns a structured "dispatch_pending"
 * acknowledgement; the agent should treat that as "I tried, queued, no
 * result yet" rather than as a result.
 *
 * Design intent (the day we light this up):
 *
 *   1. Agent (orchestrator) calls dispatch_task({ brief, scope, expected }).
 *   2. The tool writes a `kind=system, action=dispatch_task` outbound
 *      message into outbound.db. Returns a `task_id` immediately.
 *   3. Host delivery action handler (src/modules/dispatch/) sees the row,
 *      spawns a fresh agent-runner container with:
 *        - a scoped CLAUDE.md (just the brief; no channel persona)
 *        - a restricted MCP toolset (per `scope`: e.g. just bash+recall
 *          for "research", or bash+github+update_memory for "devops")
 *        - read-only mount of memory/, fresh inbound/outbound dbs
 *        - a 30-min absolute ceiling
 *   4. Worker runs the brief, writes its final summary to outbound.db
 *      with `kind=task_result, refs=task_id`.
 *   5. Host moves the task_result into the parent session's inbound.db.
 *   6. Orchestrator sees it on the next turn and resumes.
 *
 * This shape gives us clean isolation (worker only sees what `scope`
 * grants) while still letting the orchestrator stay responsive in the
 * channel — slow workers don't block #main chat.
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
      "Spin up an ephemeral worker sub-agent to handle a long-running or specialized task without blocking your primary channel. The worker runs in an isolated container with a restricted toolset (per `scope`) and reports back a structured summary on a later turn — you do NOT block waiting for it. Use for: chewing through a large log file, executing a multi-step DevOps procedure, doing a deep web research dive, anything that would otherwise eat your turn budget. Don't use for quick lookups (use the appropriate MCP directly) or for chatting with the user (just answer). Returns a `task_id` immediately; the worker's final summary arrives as a separate inbound message tagged with that id. NOTE: dispatch infrastructure is currently scaffolded but not yet wired to a real worker spawn — calls today are recorded but produce no actual sub-agent. Use only when explicitly testing dispatch.",
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
      },
      required: ['brief'],
    },
  },
  async handler(args) {
    const brief = String(args.brief || '').trim();
    if (!brief) return err('`brief` is required.');
    const scope = (typeof args.scope === 'string' ? args.scope : 'plain') as string;
    const expected = typeof args.expected === 'string' ? args.expected.trim() : '';

    const taskId = generateTaskId();

    // Record the dispatch as a system action message on the outbound DB.
    // Today the host doesn't have a handler for action='dispatch_task' yet,
    // so this is a no-op as far as actual worker spawn goes — but the
    // record is preserved so a future host-side handler can pick up
    // already-queued dispatches on first deploy.
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
          status: 'queued',
          // Marker so the host-side log clearly shows this is the not-yet-
          // implemented path. Remove when modules/dispatch/ lands.
          _scaffold: true,
        }),
      });
    } catch (e) {
      log(`dispatch_task: failed to record outbound system message: ${e}`);
      return err(`Could not queue dispatch: ${e instanceof Error ? e.message : String(e)}`);
    }

    log(`dispatch_task: scaffold-recorded task=${taskId} scope=${scope} brief.len=${brief.length}`);

    return ok(
      `Dispatch infrastructure is scaffolded but not yet wired — task ${taskId} was recorded but no worker was actually spawned. ` +
        `Continue handling the user's request yourself for now. ` +
        `When dispatch goes live, this tool will return a task_id and the worker's summary will arrive as an inbound message tagged with that id on a later turn — you should treat that as the result, not this acknowledgement.`,
    );
  },
};

registerTools([dispatchTask]);
