# Discord feature deltas

Each feature below is re-implemented on v2's Chat-SDK Discord adapter (`@chat-adapter/discord@4.26.0`, installed via `/add-discord`). v1's hand-rolled `src/channels/discord.ts` (707 lines) does not exist on v2 — these are **feature deltas**, not a file port.

## Structural blueprint of v1 `src/channels/discord.ts`

Sections that guide the v2 re-port:

| Section | v1 lines | Role |
|---------|----------|------|
| Health Tick | ~100–142 | Heartbeat staleness detection → **drop**: v2 Chat-SDK owns reconnection |
| Message Processing (attachment loop) | ~150–520 | Download/transcribe/process + attachment placeholders → **port as adapter deltas** |
| Send / Streaming (`sendMessage`, `setTyping`, `streamMessage`) | ~520–648 | Outbound deltas → **port to v2 adapter** |
| Factory registration | ~651–706 | Multi-instance via `bot_token_ref` → **re-wire via schema migration** |
| Ownership gating (`ownsJid`) | ~570–580 | `bot_token_ref` matching → **same logic, v2-native API** |

---

## a) bot_token_ref multi-instance (ad72d81)

**Intent:** Each Discord messaging group can use a different bot identity via a label stored in the DB. On startup, one Discord client is spawned per unique label. Default (null label) claims everything unclaimed.

**Files (v2 target):**
- v2 DB migration file (new): `src/db/migrations/<next>-messaging-group-bot-token-ref.ts` (template: `module-agent-to-agent-destinations.ts`)
- v2 Discord adapter (from `/add-discord`): `src/channels/discord.ts` (freshly installed by skill, then patched)
- v2 channel registry: `src/channels/registry.ts` (if return type isn't already `Channel | Channel[] | null`, widen it)
- v2 main loop: `src/index.ts` (channel startup must handle array return)

**DB migration (v2):**
```typescript
// src/db/migrations/<next>-messaging-group-bot-token-ref.ts
export function migrate(db: Database): void {
  db.exec(`ALTER TABLE messaging_groups ADD COLUMN bot_token_ref TEXT`);
}
```
Nullable. `null` = default token, string = label (uppercased → env var).

**Env var lookup pattern:**
```typescript
const key = `DISCORD_BOT_TOKEN_${ref.toUpperCase()}`;
const token = process.env[key] || envVars[key] || '';
```
For Milton: set `bot_token_ref='milton'` on the `dc:1495248172740509800` messaging_group row → reads `DISCORD_BOT_TOKEN_MILTON` from `.env`.

**Factory pattern (v2 adaptation):**
Apply this logic inside whatever v2's `/add-discord` skill exposes as the factory or init function. Pseudocode:

```typescript
// Collect labeled refs from all messaging groups with channel_type='discord'
const namedRefs = new Set<string>();
const namedJidsByRef: Record<string, Set<string>> = {};
for (const mg of messagingGroups) {
  if (mg.channel_type !== 'discord' || !mg.bot_token_ref) continue;
  namedRefs.add(mg.bot_token_ref);
  (namedJidsByRef[mg.bot_token_ref] ??= new Set()).add(mg.jid);
}

const channels: Channel[] = [];
const allNamedJids = new Set<string>();
for (const ref of namedRefs) {
  const token = readToken(`DISCORD_BOT_TOKEN_${ref.toUpperCase()}`);
  if (!token) { logger.warn({ ref }, 'Discord token missing for ref'); continue; }
  namedJidsByRef[ref].forEach(jid => allNamedJids.add(jid));
  channels.push(new DiscordChannel(token, opts, ref));
}
const defaultToken = readToken('DISCORD_BOT_TOKEN');
if (defaultToken) {
  channels.push(new DiscordChannel(defaultToken, opts, null, allNamedJids));
}
return channels;
```

**Ownership gate:**
```typescript
ownsJid(jid: string): boolean {
  if (!jid.startsWith('dc:')) return false;
  if (this.tokenRef === null) return !this.excludedJids.has(jid);  // default claims unclaimed
  const mg = this.opts.messagingGroup(jid);
  return mg?.bot_token_ref === this.tokenRef;  // named claims own only
}
```

**Channel startup loop** must handle array returns (if v2 doesn't already):
```typescript
const result = factory(channelOpts);
const instances = Array.isArray(result) ? result : (result ? [result] : []);
for (const ch of instances) { channels.push(ch); await ch.connect(); }
```

**Env vars to set:**
- `DISCORD_BOT_TOKEN` — default (Andy's app)
- `DISCORD_BOT_TOKEN_MILTON` — Milton's app

---

## b) Progressive long-reply reveal (067593e)

**Intent:** Discord's 2000-char limit — instead of silent chunking, stream visible edits so the user sees the message grow. First 2000 chars revealed in 350-char steps every 650ms; overflow posts as separate messages.

**Files (v2 target):**
- v2 Discord adapter's outbound path — add a `streamMessage` method
- v2 types (if outbound interface is there) — add optional `streamMessage?(jid, text): Promise<void>`
- v2 main loop — prefer `streamMessage` over `sendMessage` when available

**Constants:**
```typescript
const STREAM_THRESHOLD = 250;      // below this, just sendMessage
const MAX_LENGTH = 2000;           // Discord hard limit
const CHUNK_SIZE = 350;            // reveal increment
const EDIT_INTERVAL_MS = 650;      // edit pulse (≈12 edits before 10s typing expiry)
```

**Implementation pattern:**
```typescript
async streamMessage(jid: string, text: string): Promise<void> {
  if (text.length <= STREAM_THRESHOLD) return this.sendMessage(jid, text);

  const firstPart = text.slice(0, MAX_LENGTH);
  const overflow = text.slice(MAX_LENGTH);

  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await this.adapter.getTextChannel(channelId);
    if (!channel) return this.sendMessage(jid, text);

    const sentMsg = await channel.send(firstPart.slice(0, CHUNK_SIZE));
    let cursor = CHUNK_SIZE;
    while (cursor < firstPart.length) {
      await new Promise((r) => setTimeout(r, EDIT_INTERVAL_MS));
      cursor = Math.min(cursor + CHUNK_SIZE, firstPart.length);
      await sentMsg.edit(firstPart.slice(0, cursor));
    }
    for (let i = 0; i < overflow.length; i += MAX_LENGTH) {
      await channel.send(overflow.slice(i, i + MAX_LENGTH));
    }
  } catch (err) {
    logger.error({ jid, err }, 'Stream failed, falling back to sendMessage');
    await this.sendMessage(jid, text);
  }
}
```

**Caller in main loop:**
```typescript
if (channel.streamMessage) await channel.streamMessage(chatJid, text);
else await channel.sendMessage(chatJid, text);
```

**v2 SDK API mapping:** check `@chat-adapter/discord` for `Message.edit()` equivalent. If the SDK wraps discord.js, the API is the same (`message.edit(content)`).

---

## c) Voice transcription (e14a27f)

**Intent:** Transcribe Discord voice attachments (audio/* content type) via OpenAI Whisper. Transcript replaces the `[Voice message: ...]` placeholder so the agent reads content, not a bare marker.

**Files (v2 target):**
- Copy `src/audio.ts` from v1 verbatim — self-contained, no v1-specific dependencies
- In v2 Discord adapter's attachment loop, add audio-content-type branch

**v1 `src/audio.ts` (copy verbatim):**
```typescript
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { readEnvFile } from './config.js';  // adjust import for v2

export async function downloadAudio(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch { return null; }
}

export async function transcribeAudio(buffer: Buffer, filename: string): Promise<string | null> {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = process.env.OPENAI_API_KEY || envVars['OPENAI_API_KEY'];
  if (!apiKey) { logger.debug('Voice transcription skipped: OPENAI_API_KEY not set'); return null; }

  try {
    const tmpPath = path.join('/tmp', `audio-${Date.now()}-${filename}`);
    fs.writeFileSync(tmpPath, buffer);
    try {
      const form = new FormData();
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      form.append('file', blob, filename);
      form.append('model', 'whisper-1');
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        logger.warn({ status: res.status, body: errText.slice(0, 200) }, 'Whisper API error');
        return null;
      }
      const data = (await res.json()) as { text?: string };
      return data.text?.trim() || null;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } catch (err) { logger.warn({ err }, 'Voice transcription failed'); return null; }
}
```

**Attachment-loop branch (v2 Discord adapter):**
```typescript
} else if (contentType.startsWith('audio/') && registeredGroup) {
  let placeholder = `[Voice message: ${att.name || 'audio'}]`;
  const buf = await downloadAudio(att.url);
  if (buf) {
    const transcript = await transcribeAudio(buf, att.name || 'audio.ogg');
    if (transcript) {
      placeholder = `[Voice message: "${transcript}"]`;
      logger.info({ chatJid, chars: transcript.length }, 'Transcribed voice message');
    }
  }
  attachmentDescriptions.push(placeholder);
}
```

**Env var:** `OPENAI_API_KEY` (absent → graceful no-op with placeholder).

**Dependencies:** Node 20+ (native `fetch`, `FormData`, `Blob`). No new npm packages.

---

## d) Typing-pulse stop on agent turn end (805b777)

**Intent:** Bug fix — Discord typing indicator was pulsed for the entire `processGroupMessages()` lifetime (up to 30min idle wait), but the agent only runs ~10s. Stop pulse immediately on `result.status === 'success'`; also clean up in `finally`.

**Files (v2 target):**
- v2 main loop (the function that runs the agent turn) — wire a pulse controller

**Pattern (apply in v2's agent-invocation function):**
```typescript
let typingInterval: ReturnType<typeof setInterval> | null = null;
const startTypingPulse = () => {
  if (typingInterval) return;
  channel.setTyping?.(chatJid, true)?.catch(() => {});
  typingInterval = setInterval(() => {
    channel.setTyping?.(chatJid, true)?.catch(() => {});
  }, 8000);  // Discord typing expires ~10s, pulse every 8s
};
const stopTypingPulse = () => {
  if (!typingInterval) return;
  clearInterval(typingInterval);
  typingInterval = null;
  channel.setTyping?.(chatJid, false)?.catch(() => {});
};

startTypingPulse();
try {
  const output = await runAgent(group, prompt, chatJid, imageAttachments, async (result) => {
    if (result.result) { /* ... send reply ... */ }
    if (result.status === 'success') {
      stopTypingPulse();             // ← stop on agent success
      queue.notifyIdle(chatJid);
    }
  });
} finally {
  stopTypingPulse();                  // ← cleanup on any exit path
  if (idleTimer) clearTimeout(idleTimer);
}
```

**Interval:** 8000 ms (8s) — Discord typing indicator ~10s, refresh before expiry.

---

## e) PDF reading (2649742)

**Intent:** PDF attachments downloaded to the group's `attachments/` folder, embedded as `[PDF: attachments/<filename>]` placeholders. Agent uses `pdf-reader` CLI (installed via container skill) to extract text. See also [container-infrastructure.md](container-infrastructure.md) for the CLI + Dockerfile side.

**Files (v2 target):**
- Copy `src/pdf.ts` from v1 verbatim
- v2 Discord adapter's attachment loop — add `application/pdf` branch

**v1 `src/pdf.ts` (copy verbatim):**
```typescript
import fs from 'fs';
import path from 'path';

export interface ProcessedPdf { relativePath: string; }

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

export async function downloadPdf(
  url: string, groupDir: string, originalName: string | null | undefined,
): Promise<ProcessedPdf | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 5 || buffer.slice(0, 5).toString() !== '%PDF-') return null;  // magic bytes
    const attachmentsDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const safeName = sanitizeFilename(originalName || `document-${Date.now()}.pdf`);
    const filename = `pdf-${Date.now()}-${safeName}`;
    fs.writeFileSync(path.join(attachmentsDir, filename), buffer);
    return { relativePath: `attachments/${filename}` };
  } catch { return null; }
}
```

**Attachment-loop branch:**
```typescript
} else if (contentType === 'application/pdf' && registeredGroup) {
  let placeholder = `[PDF: ${att.name || 'document.pdf'}]`;
  try {
    const groupDir = path.join(GROUPS_DIR, registeredGroup.folder);
    const processed = await downloadPdf(att.url, groupDir, att.name);
    if (processed) {
      placeholder = `[PDF: ${processed.relativePath}]`;
      logger.info({ chatJid, relativePath: processed.relativePath }, 'Downloaded PDF attachment');
    }
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to download PDF attachment');
  }
  attachmentDescriptions.push(placeholder);
}
```

**GROUPS_DIR resolution:** in v2, resolve the agent group folder via the new entity model (`agent_groups.folder` column). Adjust `registeredGroup.folder` lookup accordingly.

---

## f) Image vision (809cafa, 0c9c579, 7847297)

**Intent:** Download Discord image attachments, resize via sharp (1568px max edge, JPEG q85), embed as `[Image: attachments/<filename>]` placeholders. Agent runner loads the files and sends them as base64 multimodal content blocks to Claude.

**Files (v2 target):**
- Copy `src/image.ts` from v1 verbatim (change `/workspace/group/` path if v2 renames it)
- v2 Discord adapter attachment loop — `image/*` branch
- v2 main loop — `parseImageReferences()` + thread `imageAttachments` through runAgent
- v2 container-runner — add `imageAttachments` to `ContainerInput`
- v2 `container/agent-runner/src/index.ts` — load images, build `ContentBlock[]`, push multimodal

**v1 `src/image.ts` (copy verbatim; adjust imports for v2):**
```typescript
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 85;
const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

export interface ProcessedImage { relativePath: string; }
export interface ImageAttachment { relativePath: string; mediaType: string; }

export async function processImage(buffer: Buffer, groupDir: string): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;
  let resized: Buffer;
  try {
    resized = await sharp(buffer).rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch { return null; }
  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  fs.writeFileSync(path.join(attachDir, filename), resized);
  return { relativePath: `attachments/${filename}` };
}

export async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

export function parseImageReferences(messages: Array<{ content: string }>): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  for (const msg of messages) {
    IMAGE_REF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_REF_PATTERN.exec(msg.content)) !== null) {
      refs.push({ relativePath: match[1], mediaType: 'image/jpeg' });
    }
  }
  return refs;
}
```

**Sharp parameters:**
- `MAX_DIMENSION = 1568` (Claude vision detail sweet spot)
- `JPEG_QUALITY = 85` (keeps each image < 5MB limit)
- `fit: 'inside', withoutEnlargement: true`
- `.rotate()` honors EXIF orientation

**Attachment-loop branch (v2 Discord adapter):**
```typescript
if (contentType.startsWith('image/') && registeredGroup) {
  let placeholder = `[Image: ${att.name || 'image'}]`;
  const buf = await downloadImage(att.url);
  if (buf) {
    try {
      const groupDir = path.join(GROUPS_DIR, registeredGroup.folder);
      const processed = await processImage(buf, groupDir);
      if (processed) {
        placeholder = `[Image: ${processed.relativePath}]`;
        logger.info({ chatJid, relativePath: processed.relativePath }, 'Processed image attachment');
      }
    } catch (err) { logger.warn({ err, chatJid }, 'Image processing failed'); }
  }
  attachmentDescriptions.push(placeholder);
}
```

**Main loop wiring:**
```typescript
const imageAttachments = parseImageReferences(missedMessages);
const output = await runAgent(group, prompt, chatJid, imageAttachments, async (result) => { /* ... */ });
```

**Container runner (`src/container-runner.ts`):**
```typescript
export interface ContainerInput {
  // ... existing fields ...
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}
```

**Agent-runner (`container/agent-runner/src/index.ts`):**
```typescript
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
const VALID_IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function coerceImageMediaType(mt: string): ImageMediaType {
  return (VALID_IMAGE_MEDIA_TYPES as readonly string[]).includes(mt) ? (mt as ImageMediaType) : 'image/jpeg';
}

// In main handler, after reading ContainerInput:
if (containerInput.imageAttachments?.length) {
  const blocks: ContentBlock[] = [];
  for (const img of containerInput.imageAttachments) {
    const imgPath = path.join(WORKSPACE_GROUP_PATH, img.relativePath);   // v2: verify this constant
    try {
      const data = fs.readFileSync(imgPath).toString('base64');
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: coerceImageMediaType(img.mediaType), data },
      });
    } catch (err) { log(`Failed to load image: ${imgPath}`); }
  }
  if (blocks.length > 0) stream.pushMultimodal(blocks);
}
```

**`MessageStream.pushMultimodal` (agent-runner):**
```typescript
pushMultimodal(content: ContentBlock[]): void {
  this.queue.push({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  });
  this.waiting?.();
}
```
`SDKUserMessage.message.content` becomes `string | ContentBlock[]`.

**Dependencies (new npm):**
- `sharp` — image resize/format conversion (already in v1 package.json at `^0.34.5`)

**WORKSPACE_GROUP_PATH for v2:** v1 used `/workspace/group/`. v2 renames workspace root — verify the actual v2 constant before committing. Likely `/workspace/agent/` but check `container/agent-runner/src/` on `upstream/v2` at replay time.
