/**
 * `complete_task` — worker-side completion signal.
 *
 * Workers spawned by the host's dispatch module receive ONE inbound message
 * (the brief), do their work, then call this tool with their final summary.
 * Writing `kind=system, action=complete_task` to outbound triggers the
 * host's dispatch handler, which forwards the summary to the parent
 * session's inbound and tears down this worker container.
 *
 * No-op outside the dispatch flow: if a non-worker container calls this,
 * the host has no parent to forward to and just logs a warning.
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

export const completeTask: McpToolDefinition = {
  tool: {
    name: 'complete_task',
    description:
      "WORKER ONLY — emit your final result and end the worker container. Use this exactly once when you've finished the dispatched task. The `summary` argument should contain everything the orchestrator needs (a complete answer, a structured report, a list of findings, whatever fits the brief). After this call, your container is terminated and the orchestrator receives the summary on its next inbound batch. Don't call this if you're not running as a dispatched worker — outside the dispatch flow this is a no-op and you should reply normally with `send_message` instead.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description:
            'Final result text for the orchestrator. Self-contained — the orchestrator does not see your scratch work, only this summary. Markdown is fine.',
        },
      },
      required: ['summary'],
    },
  },
  async handler(args) {
    const summary = String(args.summary || '').trim();
    if (!summary) return err('`summary` is required and must be non-empty.');

    try {
      writeMessageOut({
        id: `complete-task-${Date.now()}`,
        kind: 'system',
        platform_id: null,
        channel_type: null,
        thread_id: null,
        content: JSON.stringify({
          action: 'complete_task',
          summary,
        }),
      });
    } catch (e) {
      return err(`Could not record complete_task: ${e instanceof Error ? e.message : String(e)}`);
    }

    return ok(
      'Final result recorded. Your container will be terminated by the host shortly. No further work needed.',
    );
  },
};

registerTools([completeTask]);
