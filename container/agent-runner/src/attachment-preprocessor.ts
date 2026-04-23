/**
 * Attachment preprocessor — runs before the formatter so the agent sees
 * attachment placeholders (`[pdf: … — saved to /workspace/agent/attachments/…]`)
 * instead of giant base64 blobs.
 *
 * The Chat SDK bridge on the host already downloads each attachment and
 * embeds its bytes as `content.attachments[i].data` (base64). We decode
 * that here, write the bytes to `/workspace/agent/attachments/<file>`,
 * set `attachments[i].localPath` so the formatter renders a nice reference,
 * and strip `data` from the in-memory content so the prompt stays lean.
 *
 * Supported types:
 *   application/pdf → save as-is; agent uses `pdf-reader extract <path>`
 *   image/*          → save as-is; agent reads the file
 *   audio/*          → POST to OpenAI Whisper, inline transcript into
 *                      `content.text` and drop the attachment entry
 *
 * Audio transcription needs OPENAI_API_KEY in the container env (or
 * OneCLI to inject it for api.openai.com). If absent, the audio entry
 * is kept as-is with a "(transcription unavailable)" note.
 */
import fs from 'fs';
import path from 'path';

import type { MessageInRow } from './db/messages-in.js';

const ATTACHMENTS_DIR = '/workspace/agent/attachments';

interface AttachmentRef {
  type?: string;
  name?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  data?: string;
  localPath?: string;
  url?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

interface ContentLike {
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
  attachments?: AttachmentRef[];
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function ensureAttachmentsDir(): void {
  try {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[attachment-preprocessor] could not create ${ATTACHMENTS_DIR}: ${(err as Error).message}`);
  }
}

function saveBinary(data: string, originalName: string | undefined, prefix: string, defaultExt: string): string | null {
  try {
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0) return null;
    const base = sanitize(originalName || `${prefix}-${defaultExt}`);
    const hasExt = /\.[a-zA-Z0-9]{2,4}$/.test(base);
    const filename = `${prefix}-${Date.now()}-${base}${hasExt ? '' : '.' + defaultExt}`;
    const filePath = path.join(ATTACHMENTS_DIR, filename);
    fs.writeFileSync(filePath, buf);
    return `agent/attachments/${filename}`; // relative to /workspace
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[attachment-preprocessor] save failed: ${(err as Error).message}`);
    return null;
  }
}

async function transcribeAudio(data: string, filename: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn('[attachment-preprocessor] OPENAI_API_KEY not set — audio transcription skipped');
    return null;
  }
  try {
    const buf = Buffer.from(data, 'base64');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/octet-stream' }), filename);
    form.append('model', 'whisper-1');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[attachment-preprocessor] Whisper error: ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { text?: string };
    return j.text?.trim() || null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[attachment-preprocessor] Whisper fetch failed: ${(err as Error).message}`);
    return null;
  }
}

async function fetchAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[attachment-preprocessor] URL fetch ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[attachment-preprocessor] URL fetch threw: ${(err as Error).message}`);
    return null;
  }
}

async function processSingleContent(content: ContentLike): Promise<void> {
  if (!Array.isArray(content.attachments) || content.attachments.length === 0) return;

  ensureAttachmentsDir();

  const keep: AttachmentRef[] = [];
  const inlineTexts: string[] = [];

  for (const att of content.attachments) {
    if (att.localPath) {
      keep.push(att); // already processed
      continue;
    }

    // If the Chat-SDK adapter didn't embed bytes (e.g. PDF, arbitrary binary
    // files — their fetchData isn't implemented), fall back to fetching the
    // platform URL. Discord CDN URLs are public with a signed query string.
    if (!att.data && att.url) {
      const fetched = await fetchAsBase64(att.url);
      if (fetched) att.data = fetched;
    }
    if (!att.data) {
      keep.push(att); // still no bytes; skip decoding, leave marker
      continue;
    }
    const mime = (att.mimeType || '').toLowerCase();
    const name = att.name || att.filename;

    if (mime === 'application/pdf') {
      const localPath = saveBinary(att.data, name, 'pdf', 'pdf');
      if (localPath) att.localPath = localPath;
      delete att.data;
      keep.push(att);
    } else if (mime.startsWith('image/')) {
      const ext = mime.split('/')[1] || 'jpg';
      const localPath = saveBinary(att.data, name, 'img', ext === 'jpeg' ? 'jpg' : ext);
      if (localPath) att.localPath = localPath;
      delete att.data;
      keep.push(att);
    } else if (mime.startsWith('audio/')) {
      const transcript = await transcribeAudio(att.data, name || 'audio.ogg');
      if (transcript) {
        inlineTexts.push(`[Voice message: "${transcript}"]`);
      } else {
        inlineTexts.push(`[Voice message: ${name || 'audio'} (transcription unavailable)]`);
      }
      // drop the audio attachment entirely; text carries the content
    } else {
      // Unknown type: save as-is so agent can still access bytes
      const localPath = saveBinary(att.data, name, 'file', 'bin');
      if (localPath) att.localPath = localPath;
      delete att.data;
      keep.push(att);
    }
  }

  content.attachments = keep;
  if (inlineTexts.length > 0) {
    const base = (content.text || '').trimEnd();
    content.text = base.length > 0 ? `${base}\n${inlineTexts.join('\n')}` : inlineTexts.join('\n');
  }
}

/**
 * Preprocess all chat-kind messages: decode attachments, save to disk, inline
 * voice transcripts. Safe for other kinds — just passes through.
 * Mutates each row's `content` JSON in place.
 */
export async function preprocessAttachments(messages: MessageInRow[]): Promise<void> {
  for (const msg of messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') continue;
    let parsed: ContentLike;
    try {
      parsed = JSON.parse(msg.content) as ContentLike;
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.attachments) || parsed.attachments.length === 0) continue;
    await processSingleContent(parsed);
    msg.content = JSON.stringify(parsed);
  }
}
