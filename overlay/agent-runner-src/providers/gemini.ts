/**
 * Gemini provider — built on `@google/genai` (the supported SDK).
 *
 * Capabilities:
 *   - `googleSearch: {}` and `functionDeclarations` share one `Tool` object,
 *     so built-in web grounding and custom MCP function calling can be combined
 *     in a single request (Gemini 3+).
 *   - Persona load (CLAUDE.md + CLAUDE.local.md).
 *   - Vision: `[image: /workspace/agent/attachments/...]` paths get inlined
 *     as `inlineData` parts so the model can actually see them.
 *   - JSON-Schema sanitization for Gemini's stricter parameter validator.
 *   - Flat-name tool routing fallback (Gemini sometimes drops the `server__`
 *     prefix when a server name is a substring of the tool name).
 *   - `setContainerToolInFlight` / `clearContainerToolInFlight` so host-sweep
 *     doesn't kill the container during long-running tool calls.
 */
import {
  GoogleGenAI,
  ThinkingLevel,
  type Chat,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
  type Tool,
} from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "fs/promises";
import { extname } from "path";

import { setContainerToolInFlight, clearContainerToolInFlight } from "../db/connection.js";
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, QueryInput, ProviderEvent, ProviderOptions, McpServerConfig } from './types.js';

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

async function loadPersonaFiles(baseInstructions: string | undefined): Promise<string> {
  const candidates = [
    '/app/CLAUDE.md',
    '/workspace/agent/CLAUDE.local.md',
  ];
  const sections: string[] = [];
  for (const path of candidates) {
    try {
      const content = await readFile(path, 'utf8');
      if (content.trim().length > 0) {
        sections.push(`<!-- source: ${path} -->\n${content}`);
      }
    } catch {
      // file doesn't exist for this agent group; that's fine
    }
  }
  if (baseInstructions) sections.push(baseInstructions);
  return sections.join('\n\n---\n\n');
}

async function buildMessageParts(text: string): Promise<Part[]> {
  const parts: Part[] = [{ text }];
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

interface McpClientEntry {
  client: Client;
  transport: StdioClientTransport;
  declarations: FunctionDeclaration[];
}

interface ToolRoute {
  server: string;
  originalName: string;
}

export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private ai: GoogleGenAI;
  private mcpConfigs: Record<string, McpServerConfig>;
  private mcpClients: Record<string, McpClientEntry> = {};
  private toolRoutes: Map<string, ToolRoute> = new Map();
  private assistantName?: string;

  constructor(options: ProviderOptions = {}) {
    const apiKey = options.env?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

    this.ai = new GoogleGenAI({ apiKey });
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
        env: { ...process.env, ...config.env },
      });

      const client = new Client(
        { name: "nanoclaw-gemini-provider", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );

      try {
        await client.connect(transport);
        const toolsResult = (await client.listTools()) as ListToolsResult;

        const declarations: FunctionDeclaration[] = toolsResult.tools.map((tool) => {
          const prefixed = `${name}__${tool.name}`;
          this.toolRoutes.set(prefixed, { server: name, originalName: tool.name });
          if (!this.toolRoutes.has(tool.name)) {
            this.toolRoutes.set(tool.name, { server: name, originalName: tool.name });
          }
          return {
            name: prefixed,
            description: tool.description,
            parameters: sanitizeSchema(tool.inputSchema) as FunctionDeclaration['parameters'],
          };
        });

        this.mcpClients[name] = { client, transport, declarations };
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
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    yield { type: 'activity' };

    await this.ensureMcpClients();

    const allDeclarations = Object.values(this.mcpClients).flatMap((c) => c.declarations);
    const composedSystemInstruction = await loadPersonaFiles(input.systemContext?.instructions);
    log(`System instruction composed: ${composedSystemInstruction.length} chars`);

    // Single Tool object combining MCP function declarations with Gemini's
    // built-in googleSearch grounding. Possible only on @google/genai;
    // the legacy SDK kept these as separate Tool variants.
    const tools: Tool[] = [
      {
        ...(allDeclarations.length > 0 ? { functionDeclarations: allDeclarations } : {}),
        googleSearch: {},
      },
    ];

    const history: Content[] = input.continuation ? JSON.parse(input.continuation) : [];

    const chat: Chat = this.ai.chats.create({
      model: input.model || 'gemini-2.5-flash',
      history,
      config: {
        systemInstruction: composedSystemInstruction,
        tools,
        // Required when combining built-in tools (googleSearch) with
        // functionDeclarations on Gemini 3+. Without this the API rejects
        // with HTTP 400: "Please enable tool_config.include_server_side_tool_invocations
        // to use Built-in tools with Function calling."
        toolConfig: { includeServerSideToolInvocations: true },
        // Gemini 3 default is `high`; medium reduces internal-reasoning
        // verbosity (cuts <internal> dumps + stutter) without crippling
        // multi-step task quality. Temperature stays at default 1.0 —
        // lowering it on Gemini 3 causes loops per Google's docs.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });

    if (!input.continuation) {
      yield { type: 'init', continuation: JSON.stringify(chat.getHistory()) };
    }

    try {
      for await (const userText of stream) {
        if (signal.aborted) break;

        const messageParts = await buildMessageParts(userText);
        let response = await chat.sendMessage({ message: messageParts });
        yield { type: 'activity' };

        // Tool execution loop. The new SDK exposes `response.functionCalls`
        // as a convenience accessor, but we still need to pull the calls in
        // the order they appear in `candidates[0].content.parts` so each
        // call gets a paired `functionResponse` part back.
        while (this.hasFunctionCalls(response)) {
          if (signal.aborted) break;

          const calls = this.extractFunctionCalls(response);
          const toolResponses: Part[] = [];

          for (const call of calls) {
            yield { type: 'activity' };
            yield { type: 'progress', message: `Executing ${call.name}...` };

            const route = call.name ? this.toolRoutes.get(call.name) : undefined;
            const mcp = route ? this.mcpClients[route.server] : undefined;

            if (!route || !mcp) {
              toolResponses.push({
                functionResponse: {
                  name: call.name,
                  response: { error: `No route for tool ${call.name}` },
                },
              });
              continue;
            }

            setContainerToolInFlight(call.name ?? 'unknown', null);
            try {
              const toolResult = (await mcp.client.callTool({
                name: route.originalName,
                arguments: (call.args ?? {}) as Record<string, unknown>,
              })) as CallToolResult;

              toolResponses.push({
                functionResponse: {
                  name: call.name,
                  response: { result: toolResult.content },
                },
              });
            } catch (err) {
              toolResponses.push({
                functionResponse: {
                  name: call.name,
                  response: { error: String(err) },
                },
              });
            } finally {
              clearContainerToolInFlight();
            }
          }

          response = await chat.sendMessage({ message: toolResponses });
          yield { type: 'activity' };
        }

        const finalOutput = this.extractText(response);
        yield { type: 'result', text: finalOutput };

        yield { type: 'init', continuation: JSON.stringify(chat.getHistory()) };
      }
    } catch (err) {
      if (!signal.aborted) {
        yield { type: 'error', message: String(err), retryable: true };
      }
    }
  }

  private hasFunctionCalls(response: { candidates?: Array<{ content?: Content }> }): boolean {
    const parts = response.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) && parts.some((p) => p.functionCall);
  }

  private extractFunctionCalls(
    response: { candidates?: Array<{ content?: Content }> },
  ): FunctionCall[] {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    return parts.filter((p) => p.functionCall).map((p) => p.functionCall!) as FunctionCall[];
  }

  private extractText(
    response: { text?: string; candidates?: Array<{ content?: Content }> },
  ): string | null {
    if (typeof response.text === 'string' && response.text.length > 0) return response.text;
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    return text.length > 0 ? text : null;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = String(err);
    return /invalid|expired|not found/i.test(msg);
  }
}

registerProvider('gemini', (opts) => new GeminiProvider(opts));
