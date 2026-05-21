import { GoogleGenAI } from '@google/genai';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[gemini-provider] ${msg}`);
}

/** Sanitize JSON Schema 2020-12 to OpenAPI 3.0 for Gemini Interactions API. */
function sanitizeSchema(node: any): any {
  if (Array.isArray(node)) return node.map((n) => sanitizeSchema(n));
  if (node === null || typeof node !== "object") return node;

  const drop = new Set(["$schema", "additionalProperties", "propertyNames", "anyOf", "oneOf"]);
  const out: any = {};
  for (const key of Object.keys(node)) {
    if (drop.has(key)) continue;

    if (key === "required" && Array.isArray(node[key]) && node[key].length === 0) {
      continue;
    }

    if (key === "type") {
      if (Array.isArray(node[key])) {
        out[key] = node[key].find((t: string) => t !== "null") || "string";
      } else if (node[key] === "null") {
        out[key] = "string";
      } else {
        out[key] = node[key];
      }
      continue;
    }

    out[key] = sanitizeSchema(node[key]);
  }
  return out;
}

// MCP tool allowlist logic
function sanitizeMcpName(serverName: string, toolName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private mcpConfigs: Record<string, McpServerConfig>;
  private model: string;
  private client: GoogleGenAI;
  private mcpClients: Map<string, Client> = new Map();
  private geminiTools: any[] = [];
  private toolRegistry: Map<string, { serverName: string, originalName: string }> = new Map();
  private toolsInitialized = false;

  constructor(options: ProviderOptions = {}) {
    this.mcpConfigs = options.mcpServers ?? {};
    this.model = options.model || 'gemini-2.5-flash';
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not found in environment");
    this.client = new GoogleGenAI({ apiKey });
  }

  async initTools() {
    if (this.toolsInitialized) return;
    this.toolsInitialized = true;

    for (const [serverName, config] of Object.entries(this.mcpConfigs)) {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env as Record<string, string>,
        });
        const mcpClient = new Client({ name: "nanoclaw-gemini", version: "1.0.0" }, { capabilities: {} });
        await mcpClient.connect(transport);
        this.mcpClients.set(serverName, mcpClient);

        const toolsResult = await mcpClient.request({ method: "tools/list" }, ListToolsResultSchema);
        for (const tool of toolsResult.tools) {
          const namespacedName = sanitizeMcpName(serverName, tool.name);
          this.toolRegistry.set(namespacedName, { serverName, originalName: tool.name });
          
          this.geminiTools.push({
            type: "function",
            name: namespacedName,
            description: tool.description || "No description provided.",
            parameters: sanitizeSchema(tool.inputSchema),
          });
        }
      } catch (err) {
        log(`Failed to init MCP server ${serverName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /interaction.*not found/i.test(msg) || /404/.test(msg);
  }

  private async callTool(namespacedName: string, args: any): Promise<any> {
    const config = this.toolRegistry.get(namespacedName);
    if (!config) throw new Error(`Tool not found: ${namespacedName}`);
    const client = this.mcpClients.get(config.serverName);
    if (!client) throw new Error(`Client not found for server: ${config.serverName}`);

    // PreToolUse equivalent
    let declaredTimeoutMs = null;
    if (namespacedName.startsWith('mcp__core__Bash') && args && typeof args.timeout === 'number') {
      declaredTimeoutMs = args.timeout;
    }
    setContainerToolInFlight(namespacedName, declaredTimeoutMs);

    try {
      const toolCall = client.request(
        { method: "tools/call", params: { name: config.originalName, arguments: args } },
        CallToolResultSchema
      );
      
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP tool call '${namespacedName}' timed out after 120s`)), 120_000)
      );
      
      const result = await Promise.race([toolCall, timeout]);
      return result.content;
    } finally {
      clearContainerToolInFlight();
    }
  }

  query(input: QueryInput): AgentQuery {
    const queue: string[] = [];
    let resolveWait: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    queue.push(input.prompt);

    const eventsQueue: ProviderEvent[] = [];
    let resolveEventWait: (() => void) | null = null;
    let eventsEnded = false;

    const pushEvent = (ev: ProviderEvent) => {
      eventsQueue.push(ev);
      if (resolveEventWait) {
        resolveEventWait();
        resolveEventWait = null;
      }
    };

    const runLoop = async () => {
      let interactionId = input.continuation;

      await this.initTools();

      try {
        while (!aborted) {
          if (queue.length === 0) {
            if (ended) break;
            await new Promise<void>(r => resolveWait = r);
            if (aborted) break;
          }

          if (queue.length === 0) continue;
          
          let nextPrompt: any = queue.shift()!;
          if (typeof nextPrompt === 'string') {
            nextPrompt = [{ type: "text", text: nextPrompt }];
          }

          // Inner loop for multi-turn function calls
          let turnInput = nextPrompt;
          let finishedTurn = false;
          let turnText = "";

          while (!finishedTurn && !aborted) {
            const requestBody: any = {
              model: this.model,
              input: turnInput,
            };

            if (input.systemContext?.instructions && !interactionId) {
              requestBody.system_instruction = input.systemContext.instructions;
            }
            if (interactionId) {
              requestBody.previous_interaction_id = interactionId;
            }
            if (this.geminiTools.length > 0) {
              requestBody.tools = this.geminiTools;
            }

            const streamResult = await this.client.interactions.create({ ...requestBody, stream: true });
            const steps: any[] = [];
            let finalInteraction: any = null;

            for await (const event of (streamResult as any)) {
              if (aborted) return;
              pushEvent({ type: 'activity' });

              switch (event.event_type) {
                case 'interaction.created':
                  interactionId = event.interaction.id;
                  pushEvent({ type: 'init', continuation: interactionId as string });
                  break;
                case 'step.start':
                  steps[event.index] = event.step;
                  break;
                case 'step.delta':
                  const step = steps[event.index];
                  if (!step) break;
                  if (event.delta?.type === 'text' && event.delta.text) {
                    turnText += event.delta.text;
                  } else if (event.delta?.type === 'arguments_delta') {
                    if (typeof step.arguments !== 'string') step.arguments = "";
                    step.arguments += event.delta.arguments || "";
                  }
                  break;
                case 'step.stop':
                  const fs = steps[event.index];
                  if (fs && fs.type === "function_call" && typeof fs.arguments === "string") {
                    try { fs.arguments = JSON.parse(fs.arguments); } catch {}
                  }
                  break;
                case 'interaction.completed':
                  finalInteraction = event.interaction;
                  break;
              }
            }

            if (finalInteraction?.id) {
              interactionId = finalInteraction.id;
            }

            const functionCalls = steps.filter(s => s && s.type === "function_call");
            if (functionCalls.length > 0) {
              turnInput = await Promise.all(functionCalls.map(async (step: any) => {
                let tr;
                try {
                  const args = step.arguments || {};
                  tr = await this.callTool(step.name, args);
                } catch (err: any) {
                  tr = [{ type: "text", text: `Error: ${err.message}` }];
                }
                
                // Format the result properly for Interactions API
                let resultObj = tr;
                if (typeof tr === 'string') {
                   resultObj = { value: tr };
                } else if (Array.isArray(tr)) {
                   // Ensure it's an object, as function_result.result expects an object
                   resultObj = { content: tr };
                }
                return { type: "function_result", call_id: step.id, name: step.name, result: resultObj };
              }));
              // Loop again with the function results as turnInput
            } else {
              finishedTurn = true;
              pushEvent({ type: 'result', text: turnText });
            }
          }
        }
      } catch (err: any) {
        log(`Error in runLoop: ${err.message}`);
        pushEvent({ type: 'error', message: err.message, retryable: false });
      } finally {
        eventsEnded = true;
        if (resolveEventWait) resolveEventWait();
      }
    };

    runLoop();

    async function* eventsGenerator(): AsyncGenerator<ProviderEvent> {
      while (true) {
        while (eventsQueue.length > 0) {
          yield eventsQueue.shift()!;
        }
        if (eventsEnded) return;
        await new Promise<void>(r => resolveEventWait = r);
      }
    }

    return {
      push: (msg: string) => {
        queue.push(msg);
        if (resolveWait) { resolveWait(); resolveWait = null; }
      },
      end: () => {
        ended = true;
        if (resolveWait) { resolveWait(); resolveWait = null; }
      },
      events: eventsGenerator(),
      abort: () => {
        aborted = true;
        if (resolveWait) { resolveWait(); resolveWait = null; }
      }
    };
  }
}

registerProvider('gemini', (opts) => new GeminiProvider(opts));
