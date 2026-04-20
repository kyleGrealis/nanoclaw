/**
 * Audio handling for channel messages.
 *
 * Downloads an audio attachment from a channel-provided URL and transcribes
 * it using the OpenAI Whisper API. Returns the transcript text on success,
 * or null if the API key is not configured or transcription fails.
 *
 * Used by Discord to handle voice messages (audio/ogg, audio/*).
 */
import fs from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export async function downloadAudio(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = process.env.OPENAI_API_KEY || envVars['OPENAI_API_KEY'];
  if (!apiKey) {
    logger.debug('Voice transcription skipped: OPENAI_API_KEY not configured');
    return null;
  }

  try {
    // Write buffer to a temp file — fetch's FormData needs a Blob with a name,
    // and Node 20 FormData doesn't support named Buffers directly.
    const tmpPath = path.join('/tmp', `audio-${Date.now()}-${filename}`);
    fs.writeFileSync(tmpPath, buffer);

    try {
      const form = new FormData();
      // Node 20 fetch FormData accepts a Blob; read the temp file as a Blob.
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
        logger.warn(
          { status: res.status, body: errText.slice(0, 200) },
          'Whisper API error',
        );
        return null;
      }

      const data = (await res.json()) as { text?: string };
      return data.text?.trim() || null;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (err) {
    logger.warn({ err }, 'Voice transcription failed');
    return null;
  }
}
