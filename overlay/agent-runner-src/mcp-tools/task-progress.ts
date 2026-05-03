/**
 * `task_progress` — worker-side incremental progress update.
 *
 * Workers can call this any number of times before `complete_task` to send
 * "still working" updates back to the orchestrator. Each call writes
 * `kind=system, action=task_progress` to outbound; the host forwards the
 * text into the parent session's inbound so the orchestrator can mention
 * it to the user without waiting for the final result.
 *
 * Use sparingly — every progress update wakes the parent agent and costs a
 * turn. One update per meaningful milestone is the right cadence, not one
 * per tool call.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const taskProgress: McpToolDefinition = {
  tool: {
    name: 'task_progress',
    description:
      "WORKER ONLY — send an incremental progress update to the orchestrator while you keep working. Use for milestone-level updates ('found 5 sources, synthesizing now', 'page 3 of 12 read'), NOT for every tool call. Each call wakes the orchestrator and costs them a turn — be deliberate. The orchestrator may relay your update to the user. This does NOT end the worker; you keep going until you call `complete_task`.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description:
            'Short progress note (1-2 sentences). The orchestrator sees this and may pass it to the user verbatim or paraphrase.',
        },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = String(args.text || '').trim();
    if (!text) return err('`text` is required and must be non-empty.');

    try {
      writeMessageOut({
        id: `task-progress-${Date.now()}`,
        kind: 'system',
        platform_id: null,
        channel_type: null,
        thread_id: null,
        content: JSON.stringify({
          action: 'task_progress',
          text,
        }),
      });
    } catch (e) {
      return err(`Could not record task_progress: ${e instanceof Error ? e.message : String(e)}`);
    }

    return ok('Progress update sent.');
  },
};

registerTools([taskProgress]);
