import { GoogleGenerativeAI, type ChatSession, type Content, type Part } from "@google/generative-ai";
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, QueryInput, ProviderEvent, ProviderOptions, McpServerConfig } from './types.js';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "fs/promises";
import { extname } from "path";
import { setContainerToolInFlight, clearContainerToolInFlight } from "../db/connection.js";

function log(msg: string): void {
  console.error(`[gemini-provider] ${msg}`);
}

const IMAGE_PATH_RE = /\/workspace\/agent\/attachments\/[^\s\]"']+\.(png|jpe?g|gif|webp|heic|heif)/gi;
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

async function buildMessageParts(text: string): Promise<Array<Part>> {
  const parts: Array<Part> = [{ text }];
  const seen = new Set<string>();
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    const path = m[0];
    if (seen.has(path)) continue;
    seen.add(path);
    const mimeType = MIME_BY_EXT[extname(path).toLowerCase()];
    if (!mimeType) continue;
    try {
      const buf = await readFile(path);
      parts.push({ inlineData: { mimeType, data: buf.toString('base64') } });
      log(`Inlined image for vision: ${path} (${mimeType}, ${buf.length} bytes)`);
    } catch (err) {
      log(`Could not read image ${path}: ${(err as Error).message}`);
    }
  }
  return parts;
}

// Gemini's function_declarations.parameters accepts an OpenAPI subset and
// rejects MCP/JSON-Schema metadata fields with HTTP 400. Strip them recursively.
const STRIP_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions',
  'additionalProperties', 'examples', 'default',
  'const', 'not', 'if', 'then', 'else',
  'patternProperties', 'propertyNames',
  'readOnly', 'writeOnly', 'deprecated',
]);
function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return value;
}

/**
 * Push-based async iterable for streaming user messages.
 */
class MessageStream {
  private queue: string[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push(text);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

interface McpClient {
  client: Client;
  transport: StdioClientTransport;
  tools: any[];
}

interface ToolRoute {
  server: string;
  originalName: string;
}

export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private genAI: GoogleGenerativeAI;
  private mcpConfigs: Record<string, McpServerConfig>;
  private mcpClients: Record<string, McpClient> = {};
  // Resolves both prefixed (`server__tool`) and bare (`tool`) function names
  // back to a server + tool. Gemini sometimes drops the prefix when the
  // server name is a substring of the tool name (observed on `brave_search`
  // emitting `brave_web_search`).
  private toolRoutes: Map<string, ToolRoute> = new Map();
  private assistantName?: string;

  constructor(options: ProviderOptions = {}) {
    const apiKey = options.env?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.mcpConfigs = options.mcpServers ?? {};
    this.assistantName = options.assistantName;
  }

  private async ensureMcpClients(): Promise<void> {
    for (const [name, config] of Object.entries(this.mcpConfigs)) {
      if (this.mcpClients[name]) continue;

      log(`Connecting to MCP server: ${name}`);
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env }
      });

      const client = new Client(
        { name: "nanoclaw-gemini-provider", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );

      try {
        await client.connect(transport);
        const toolsResult = await client.listTools() as ListToolsResult;

        // Map MCP tools to Gemini Function Declarations
        const geminiTools = toolsResult.tools.map(tool => {
          const prefixed = `${name}__${tool.name}`;
          this.toolRoutes.set(prefixed, { server: name, originalName: tool.name });
          // Bare-name fallback: only register if it doesn't collide with an
          // existing route from another server (first-write wins; collisions
          // will keep working via the prefixed form).
          if (!this.toolRoutes.has(tool.name)) {
            this.toolRoutes.set(tool.name, { server: name, originalName: tool.name });
          }
          return {
            name: prefixed,
            description: tool.description,
            parameters: sanitizeSchema(tool.inputSchema)
          };
        });

        this.mcpClients[name] = { client, transport, tools: geminiTools };
      } catch (err) {
        log(`Failed to connect to MCP server ${name}: ${err}`);
      }
    }
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const abortController = new AbortController();
    
    const events = this.processQuery(input, stream, abortController.signal);

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events,
      abort: () => abortController.abort(),
    };
  }

  private async *processQuery(
    input: QueryInput, 
    stream: MessageStream, 
    signal: AbortSignal
  ): AsyncGenerator<ProviderEvent> {
    yield { type: 'activity' };

    await this.ensureMcpClients();
    
    const allTools = Object.values(this.mcpClients).flatMap(c => c.tools);
    const model = this.genAI.getGenerativeModel({
      model: input.model || "gemini-2.5-flash",
      systemInstruction: input.systemContext?.instructions,
      tools: allTools.length > 0 ? [{ functionDeclarations: allTools }] : undefined
    });

    // Handle continuation (Gemini history)
    const history: Content[] = input.continuation ? JSON.parse(input.continuation) : [];
    const chat = model.startChat({ history });

    if (!input.continuation) {
      yield { type: 'init', continuation: JSON.stringify(await chat.getHistory()) };
    }

    try {
      for await (const userText of stream) {
        if (signal.aborted) break;

        const messageParts = await buildMessageParts(userText);
        let result = await chat.sendMessage(messageParts);
        yield { type: 'activity' };

        // Tool execution loop
        while (result.response.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
          if (signal.aborted) break;

          const calls = result.response.candidates[0].content.parts
            .filter(p => p.functionCall)
            .map(p => p.functionCall!);

          const toolResponses: Part[] = [];

          for (const call of calls) {
            yield { type: 'activity' };
            yield { type: 'progress', message: `Executing ${call.name}...` };

            const route = this.toolRoutes.get(call.name);
            const mcp = route ? this.mcpClients[route.server] : undefined;

            if (!route || !mcp) {
              toolResponses.push({
                functionResponse: { name: call.name, response: { error: `No route for tool ${call.name}` } }
              });
              continue;
            }

            setContainerToolInFlight(call.name, null);
            try {
              const toolResult = await mcp.client.callTool({
                name: route.originalName,
                arguments: call.args as any
              }) as CallToolResult;

              toolResponses.push({
                functionResponse: { name: call.name, response: { result: toolResult.content } }
              });
            } catch (err) {
              toolResponses.push({
                functionResponse: { name: call.name, response: { error: String(err) } }
              });
            } finally {
              clearContainerToolInFlight();
            }
          }

          result = await chat.sendMessage(toolResponses);
          yield { type: 'activity' };
        }

        const finalOutput = result.response.text();
        yield { type: 'result', text: finalOutput };
        
        // Update continuation
        yield { type: 'init', continuation: JSON.stringify(await chat.getHistory()) };
      }
    } catch (err) {
      if (!signal.aborted) {
        yield { type: 'error', message: String(err), retryable: true };
      }
    }
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = String(err);
    return /invalid|expired|not found/i.test(msg);
  }
}

registerProvider('gemini', (opts) => new GeminiProvider(opts));
