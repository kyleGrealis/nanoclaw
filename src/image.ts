/**
 * Image processing for channel attachments.
 *
 * Downloads from a channel-provided URL or accepts a raw buffer, resizes
 * via sharp, writes a JPEG into the group's `attachments/` directory, and
 * returns a relative path that gets embedded into message content as a
 * `[Image: attachments/...]` placeholder. The agent runner reads those
 * placeholders back out and loads the files as multimodal content blocks.
 *
 * Currently used by the Discord channel; the helper is channel-agnostic.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Claude's vision API likes ~1568px on the long edge for "high-detail" mode,
// which is the sweet spot for reading text in screenshots without bloating
// the prompt. q85 JPEG keeps each image well under Claude's 5MB/image limit.
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 85;

const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

export interface ProcessedImage {
  /** Path relative to the group directory, e.g. `attachments/img-...jpg`. */
  relativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

/**
 * Resize a raw image buffer and persist it under `groupDir/attachments/`.
 * Returns null on empty input or sharp failure (caller should fall back to
 * a plain text placeholder so the agent still knows something was sent).
 */
export async function processImage(
  buffer: Buffer,
  groupDir: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  let resized: Buffer;
  try {
    resized = await sharp(buffer)
      .rotate() // honor EXIF orientation
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  } catch {
    return null;
  }

  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const filePath = path.join(attachDir, filename);
  fs.writeFileSync(filePath, resized);

  return { relativePath: `attachments/${filename}` };
}

/**
 * Download an image URL to a buffer. Caller is responsible for any retry
 * logic; we just surface fetch/network errors as null.
 */
export async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

/**
 * Scan stored message content for `[Image: attachments/...]` placeholders
 * and return one ImageAttachment per match. Always JPEG — `processImage()`
 * normalizes everything to .jpg so the media type is fixed.
 */
export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
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
