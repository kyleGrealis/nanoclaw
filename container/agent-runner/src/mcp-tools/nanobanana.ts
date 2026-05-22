/**
 * nanobanana MCP tool — image generation via Google's Gemini 2.5 Flash Image
 * model (codename "nano-banana"). Andy calls this tool with a prompt; the
 * tool saves the generated PNG to /tmp and returns the path. Andy then uses
 * send_file to deliver it to a channel.
 *
 * Auth: this tool issues an unauthenticated fetch. The OneCLI gateway
 * (HTTPS_PROXY) intercepts the outbound request, matches the host pattern
 * for generativelanguage.googleapis.com, and injects the API key as a
 * header. No secrets in this file or in the container env.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function log(msg: string): void {
  console.error(`[nanobanana] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export const generateImage: McpToolDefinition = {
  tool: {
    name: 'generate_image',
    description:
      'Generate an image with Google Gemini (nano-banana). Returns the path to a PNG file in /tmp. Use send_file to deliver it to a channel. Ephemeral by design: nothing is saved outside /tmp.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate.',
        },
        model: {
          type: 'string',
          description: `Optional model id. Defaults to ${DEFAULT_MODEL}.`,
        },
      },
      required: ['prompt'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    if (!prompt) return err('prompt is required');
    const model = (args.model as string) || DEFAULT_MODEL;

    const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    };

    log(`generating: model=${model} prompt=${prompt.slice(0, 60)}`);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return err(`network error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable body>');
      return err(`API ${resp.status}: ${text.slice(0, 300)}`);
    }

    const json = (await resp.json().catch(() => null)) as
      | { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> }
      | null;

    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      return err('no image in response — check model name and prompt');
    }

    const buf = Buffer.from(imagePart.inlineData.data, 'base64');
    const ts = Date.now();
    const outPath = path.join('/tmp', `nanobanana-${ts}.png`);
    fs.writeFileSync(outPath, buf);
    log(`wrote ${buf.length} bytes to ${outPath}`);

    return ok(
      `Image saved to ${outPath} (${buf.length} bytes, model: ${model}). Deliver with send_file({ to: "<destination>", path: "${outPath}" }).`,
    );
  },
};

registerTools([generateImage]);
