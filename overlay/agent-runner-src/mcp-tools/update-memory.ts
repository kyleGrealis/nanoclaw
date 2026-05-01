/**
 * `update_memory` MCP tool — structured atomic writes to the same
 * `/workspace/agent/memory/*.md` corpus that `recall` reads.
 *
 * Why this exists: today the agent updates memory via raw `bash`
 * (`echo "fact" >> memory/foo.md`), which is brittle, doesn't honor the
 * YAML frontmatter, and never refreshes the `verified-on` date. This tool
 * gives a programmatic write path with the same H2-section discipline
 * `recall` already assumes — and a single host-side hook for future cache
 * invalidation if/when we add Gemini context caching.
 *
 * Memory-file shape (existing convention, this tool preserves it):
 *
 *     ---
 *     kind: config | procedural | state | reference
 *     verified-on: YYYY-MM-DD
 *     ---
 *
 *     # Title
 *
 *     ## Section heading
 *     ...body...
 *
 *     ## Another section
 *     ...body...
 *
 * Operations:
 *   - `append_section`  add a new H2 + body (errors if heading already exists)
 *   - `update_section`  replace body under an existing H2
 *   - `remove_section`  drop an H2 + its body
 *   - `touch_verified`  bump frontmatter `verified-on` to today, no body change
 *
 * Every successful op also bumps `verified-on` (so freshness signals stay
 * honest). Writes are atomic via temp-file + rename — `recall` running
 * concurrently never sees a half-written file.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MEMORY_DIR = '/workspace/agent/memory';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** List the memory files currently on disk (without `.md`). */
function listMemoryFiles(): string[] {
  try {
    return fs
      .readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

interface ParsedFile {
  /** Raw frontmatter text (between `---` markers), or empty if none. */
  frontmatterRaw: string;
  /** Parsed frontmatter map. */
  frontmatter: Record<string, string>;
  /** Body after frontmatter (no leading `---\n`). */
  body: string;
}

function parse(raw: string): ParsedFile {
  if (!raw.startsWith('---\n')) {
    return { frontmatterRaw: '', frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatterRaw: '', frontmatter: {}, body: raw };
  const fmRaw = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const frontmatter: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m) {
      const value = m[2].replace(/^["']|["']$/g, '').trim();
      if (value) frontmatter[m[1]] = value;
    }
  }
  return { frontmatterRaw: fmRaw, frontmatter, body };
}

function serialize(p: ParsedFile): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(p.frontmatter)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  // Ensure exactly one blank line between frontmatter and body.
  const body = p.body.startsWith('\n') ? p.body : `\n${p.body}`;
  return `${lines.join('\n')}${body}`;
}

interface Section {
  /** "## Heading text" (the full marker line). */
  marker: string;
  /** Heading text only (without "## "). */
  heading: string;
  /** Body lines under the heading until the next H2 or EOF. */
  body: string;
}

/** Split body into preamble (before first H2) + sections. */
function splitSections(body: string): { preamble: string; sections: Section[] } {
  const lines = body.split('\n');
  let preambleLines: string[] = [];
  const sections: Section[] = [];
  let current: { marker: string; heading: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^(##\s+)(.+?)\s*$/);
    if (m) {
      if (current) {
        sections.push({
          marker: current.marker,
          heading: current.heading,
          body: current.bodyLines.join('\n').replace(/\n+$/, ''),
        });
      } else {
        // close out preamble
      }
      current = { marker: line, heading: m[2].trim(), bodyLines: [] };
    } else {
      if (current) {
        current.bodyLines.push(line);
      } else {
        preambleLines.push(line);
      }
    }
  }
  if (current) {
    sections.push({
      marker: current.marker,
      heading: current.heading,
      body: current.bodyLines.join('\n').replace(/\n+$/, ''),
    });
  }
  return {
    preamble: preambleLines.join('\n').replace(/\n+$/, ''),
    sections,
  };
}

function joinSections(preamble: string, sections: Section[]): string {
  const parts: string[] = [];
  if (preamble.trim().length > 0) parts.push(preamble);
  for (const s of sections) {
    parts.push(`${s.marker}\n${s.body}`.replace(/\n+$/, ''));
  }
  return `\n${parts.join('\n\n')}\n`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

type Action = 'append_section' | 'update_section' | 'remove_section' | 'touch_verified';

export const updateMemory: McpToolDefinition = {
  tool: {
    name: 'update_memory',
    description:
      "Atomically update one of your structured memory files at /workspace/agent/memory/<file>.md. Use this instead of raw `bash` redirects so the YAML frontmatter and H2-section structure stay valid (which is what `recall` searches against). Every successful update also bumps the `verified-on:` date so freshness signals stay honest. Operations: `append_section` (adds a new H2 — errors if the heading already exists, use `update_section` to overwrite), `update_section` (replaces body under an existing H2 — errors if the heading is missing), `remove_section` (drops H2 + body), `touch_verified` (just refreshes the date). To create a new memory file, ask Kyle — this tool only writes to existing files.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description:
            'Memory filename without extension (e.g. "infrastructure", "family", "channels", "task-scripts"). Must already exist.',
        },
        action: {
          type: 'string',
          enum: ['append_section', 'update_section', 'remove_section', 'touch_verified'],
          description: 'Operation to perform.',
        },
        section: {
          type: 'string',
          description:
            'H2 heading text (without the "## " prefix). Required for append_section / update_section / remove_section. Ignored for touch_verified.',
        },
        content: {
          type: 'string',
          description:
            'Markdown body for the section. Required for append_section / update_section. Ignored for remove_section / touch_verified.',
        },
      },
      required: ['file', 'action'],
    },
  },
  async handler(args) {
    const file = String(args.file || '').trim();
    const action = String(args.action || '').trim() as Action;
    const section = typeof args.section === 'string' ? args.section.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';

    if (!file) return err('`file` is required.');
    if (!/^[a-zA-Z0-9_-]+$/.test(file)) {
      return err(
        `Invalid file "${file}". Memory filenames are alphanumeric/underscore/hyphen only, no path separators.`,
      );
    }

    const filePath = path.join(MEMORY_DIR, `${file}.md`);
    if (!fs.existsSync(filePath)) {
      const known = listMemoryFiles().join(', ') || '(none)';
      return err(
        `Memory file "${file}.md" does not exist. Known files: ${known}. To create a new file, ask Kyle.`,
      );
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return err(`Could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const parsed = parse(raw);
    const { preamble, sections } = splitSections(parsed.body);

    let summary: string;

    switch (action) {
      case 'touch_verified': {
        summary = `verified-on bumped to ${todayIso()}`;
        break;
      }
      case 'append_section': {
        if (!section) return err('`section` is required for append_section.');
        if (!content) return err('`content` is required for append_section.');
        if (sections.some((s) => s.heading === section)) {
          return err(
            `Section "${section}" already exists in ${file}.md. Use action="update_section" to overwrite, or pick a different heading.`,
          );
        }
        sections.push({ marker: `## ${section}`, heading: section, body: content.trim() });
        summary = `appended section "${section}" (${content.trim().length} chars)`;
        break;
      }
      case 'update_section': {
        if (!section) return err('`section` is required for update_section.');
        if (!content) return err('`content` is required for update_section.');
        const idx = sections.findIndex((s) => s.heading === section);
        if (idx === -1) {
          return err(
            `Section "${section}" does not exist in ${file}.md. Use action="append_section" to add it, or check spelling.`,
          );
        }
        sections[idx] = { marker: `## ${section}`, heading: section, body: content.trim() };
        summary = `updated section "${section}" (${content.trim().length} chars)`;
        break;
      }
      case 'remove_section': {
        if (!section) return err('`section` is required for remove_section.');
        const before = sections.length;
        const filtered = sections.filter((s) => s.heading !== section);
        if (filtered.length === before) {
          return err(`Section "${section}" does not exist in ${file}.md.`);
        }
        sections.length = 0;
        sections.push(...filtered);
        summary = `removed section "${section}"`;
        break;
      }
      default:
        return err(
          `Unknown action "${action}". Valid: append_section, update_section, remove_section, touch_verified.`,
        );
    }

    parsed.frontmatter['verified-on'] = todayIso();
    parsed.body = joinSections(preamble, sections);

    try {
      writeAtomic(filePath, serialize(parsed));
    } catch (e) {
      return err(`Failed to write ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    log(`update_memory: file=${file} action=${action} ${summary}`);
    return ok(`Updated /workspace/agent/memory/${file}.md — ${summary}.`);
  },
};

registerTools([updateMemory]);
