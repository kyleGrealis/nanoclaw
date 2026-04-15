/**
 * PDF attachment handling for channel messages.
 *
 * Downloads a PDF from a channel-provided URL into the group's
 * `attachments/` directory and returns a relative path that gets embedded
 * into message content as `[PDF: attachments/...]`. The agent reads the
 * placeholder and can run `pdf-reader extract <path>` inside the container.
 */
import fs from 'fs';
import path from 'path';

export interface ProcessedPdf {
  relativePath: string;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

export async function downloadPdf(
  url: string,
  groupDir: string,
  originalName: string | null | undefined,
): Promise<ProcessedPdf | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    if (buffer.length < 5 || buffer.slice(0, 5).toString() !== '%PDF-') {
      return null;
    }

    const attachmentsDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });

    const safeName = sanitizeFilename(
      originalName || `document-${Date.now()}.pdf`,
    );
    const filename = `pdf-${Date.now()}-${safeName}`;
    const absPath = path.join(attachmentsDir, filename);
    fs.writeFileSync(absPath, buffer);

    return { relativePath: `attachments/${filename}` };
  } catch {
    return null;
  }
}
