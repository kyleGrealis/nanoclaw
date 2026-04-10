import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

import { downloadImage, parseImageReferences, processImage } from './image.js';

describe('parseImageReferences', () => {
  it('returns an empty array when no placeholders are present', () => {
    const refs = parseImageReferences([
      { content: 'just text' },
      { content: 'no images here either' },
    ]);
    expect(refs).toEqual([]);
  });

  it('extracts a single placeholder', () => {
    const refs = parseImageReferences([
      { content: 'look: [Image: attachments/img-1.jpg]' },
    ]);
    expect(refs).toEqual([
      { relativePath: 'attachments/img-1.jpg', mediaType: 'image/jpeg' },
    ]);
  });

  it('extracts multiple placeholders across messages', () => {
    const refs = parseImageReferences([
      { content: 'first [Image: attachments/a.jpg]' },
      {
        content:
          'second [Image: attachments/b.jpg] and [Image: attachments/c.jpg]',
      },
    ]);
    expect(refs).toEqual([
      { relativePath: 'attachments/a.jpg', mediaType: 'image/jpeg' },
      { relativePath: 'attachments/b.jpg', mediaType: 'image/jpeg' },
      { relativePath: 'attachments/c.jpg', mediaType: 'image/jpeg' },
    ]);
  });

  it('ignores non-attachment Image tags', () => {
    // Only [Image: attachments/...] is treated as a real attachment ref.
    const refs = parseImageReferences([
      { content: '[Image: photo.png]' },
      { content: '[Image: /etc/passwd]' },
    ]);
    expect(refs).toEqual([]);
  });

  it('is reentrant — repeated calls return the same result', () => {
    const messages = [{ content: '[Image: attachments/x.jpg]' }];
    expect(parseImageReferences(messages)).toEqual(
      parseImageReferences(messages),
    );
  });
});

describe('processImage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-img-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null on empty buffer', async () => {
    expect(await processImage(Buffer.alloc(0), tmpDir)).toBeNull();
  });

  it('returns null on invalid image data', async () => {
    expect(await processImage(Buffer.from('not an image'), tmpDir)).toBeNull();
  });

  it('writes a JPEG to attachments/ and returns its relative path', async () => {
    // Build a small valid PNG with sharp itself.
    const sourcePng = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImage(sourcePng, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.relativePath).toMatch(
      /^attachments\/img-\d+-[a-z0-9]{4}\.jpg$/,
    );

    const fullPath = path.join(tmpDir, result!.relativePath);
    expect(fs.existsSync(fullPath)).toBe(true);

    // Verify the written file is a valid JPEG that sharp can read back.
    const meta = await sharp(fullPath).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });

  it('downsizes oversized images to fit within MAX_DIMENSION', async () => {
    const huge = await sharp({
      create: {
        width: 4000,
        height: 3000,
        channels: 3,
        background: { r: 0, g: 128, b: 255 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImage(huge, tmpDir);
    expect(result).not.toBeNull();
    const meta = await sharp(
      path.join(tmpDir, result!.relativePath),
    ).metadata();
    // 1568 max long edge, 4:3 aspect → width 1568, height 1176.
    expect(meta.width).toBeLessThanOrEqual(1568);
    expect(meta.height).toBeLessThanOrEqual(1568);
    expect(meta.width).toBe(1568);
    expect(meta.height).toBe(1176);
  });

  it('does not enlarge images smaller than MAX_DIMENSION', async () => {
    const tiny = await sharp({
      create: {
        width: 50,
        height: 40,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImage(tiny, tmpDir);
    const meta = await sharp(
      path.join(tmpDir, result!.relativePath),
    ).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(40);
  });

  it('creates the attachments directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'group');
    const png = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImage(png, nestedDir);
    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(nestedDir, 'attachments'))).toBe(true);
  });
});

describe('downloadImage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns a Buffer for a successful response', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => payload.buffer,
    }) as unknown as typeof fetch;

    const result = await downloadImage('https://example.com/img.png');
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns null for a non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch;

    expect(await downloadImage('https://example.com/missing.png')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    expect(await downloadImage('https://example.com/img.png')).toBeNull();
  });
});
