/**
 * Recall MCP tool — search structured memory at /workspace/group/memory/*.md.
 *
 * The agent calls this whenever it needs a fact instead of pre-loading the whole
 * memory tree at session start. Each file declares `kind` (config | procedural |
 * state | reference) and `verified-on:` in YAML frontmatter; results surface
 * both, plus a freshness assessment so the agent can decide whether to verify
 * before acting.
 *
 * Implementation is grep-based: split each file by H2 headers, score chunks by
 * query-term overlap, return the top N. Files are small (largest ~18KB) and
 * read on every call — no cache, no index.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MEMORY_DIR = '/workspace/group/memory';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const STALE_DAYS = 30;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface Frontmatter {
  kind?: string;
  'verified-on'?: string;
  status?: string;
  note?: string;
  [key: string]: string | undefined;
}

interface Chunk {
  file: string;
  header: string;
  body: string;
  frontmatter: Frontmatter;
  score: number;
}

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const fmRaw = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const frontmatter: Frontmatter = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m) {
      const value = m[2].replace(/^["']|["']$/g, '').trim();
      if (value) frontmatter[m[1]] = value;
    }
  }
  return { frontmatter, body };
}

function splitByH2(body: string, fileFallback: string): Array<{ header: string; body: string }> {
  const lines = body.split('\n');
  const chunks: Array<{ header: string; body: string }> = [];
  let currentHeader = fileFallback;
  let currentLines: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (currentLines.length > 0) {
        chunks.push({ header: currentHeader, body: currentLines.join('\n').trim() });
      }
      currentHeader = line.replace(/^##\s+/, '').trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    chunks.push({ header: currentHeader, body: currentLines.join('\n').trim() });
  }
  return chunks.filter((c) => c.body.length > 0);
}

function scoreChunk(chunk: { header: string; body: string }, terms: string[]): number {
  if (terms.length === 0) return 0;
  const headerLower = chunk.header.toLowerCase();
  const bodyLower = chunk.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const headerMatches = (headerLower.match(new RegExp(escapeRegex(term), 'g')) || []).length;
    const bodyMatches = (bodyLower.match(new RegExp(escapeRegex(term), 'g')) || []).length;
    score += headerMatches * 5 + bodyMatches;
    if (new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(chunk.header)) score += 10;
  }
  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function freshness(verifiedOn: string | undefined): string {
  if (!verifiedOn) return 'freshness: unknown (no verified-on date)';
  const verified = new Date(verifiedOn);
  if (isNaN(verified.getTime())) return `freshness: unparseable date "${verifiedOn}"`;
  const ageMs = Date.now() - verified.getTime();
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  if (ageDays < 0) return `freshness: future-dated (verified ${verifiedOn})`;
  if (ageDays > STALE_DAYS) return `freshness: STALE (verified ${ageDays} days ago — verify before acting)`;
  return `freshness: fresh (verified ${ageDays} day${ageDays === 1 ? '' : 's'} ago)`;
}

function formatResult(chunk: Chunk, idx: number): string {
  const fm = chunk.frontmatter;
  const meta: string[] = [`source: ${chunk.file}`];
  if (fm.kind) meta.push(`kind: ${fm.kind}`);
  meta.push(freshness(fm['verified-on']));
  if (fm.status) meta.push(`status: ${fm.status}`);
  return `### Result ${idx + 1}: ${chunk.header}\n\n_${meta.join(' | ')}_\n\n${chunk.body}`;
}

export const recall: McpToolDefinition = {
  tool: {
    name: 'recall',
    description:
      "Search Andy's structured memory (memory/*.md) for facts about Kyle, infrastructure, channels, family, procedures, etc. Returns matching chunks with their kind (config/procedural/state/reference), verified-on date, and freshness assessment. Use this whenever you need a remembered fact — it is faster and cheaper than reading whole files. Multi-word queries match best when terms are specific (e.g. 'Pi5 backup schedule', 'Sofia birthday', 'cloudflared tunnel port').",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Multiple terms are scored independently and combined.',
        },
        limit: {
          type: 'number',
          description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = String(args.query || '').trim();
    if (!query) return err('query is required');
    const requestedLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)));

    let files: string[];
    try {
      files = fs
        .readdirSync(MEMORY_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(MEMORY_DIR, f));
    } catch (e) {
      return err(`Cannot read memory dir ${MEMORY_DIR}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    const allChunks: Chunk[] = [];
    for (const filePath of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const fileBase = path.basename(filePath);
      const { frontmatter, body } = parseFrontmatter(raw);
      const sections = splitByH2(body, fileBase);
      for (const section of sections) {
        const score = scoreChunk(section, terms);
        if (score > 0) {
          allChunks.push({
            file: fileBase,
            header: section.header,
            body: section.body,
            frontmatter,
            score,
          });
        }
      }
    }

    if (allChunks.length === 0) {
      const filenames = files.map((f) => path.basename(f)).join(', ');
      return ok(
        `No matches for "${query}" in memory/. Files searched: ${filenames}.\n\nIf the fact should exist, try broader terms or read a specific file directly with the Read tool.`,
      );
    }

    allChunks.sort((a, b) => b.score - a.score);
    const top = allChunks.slice(0, limit);
    const header = `# Recall results for "${query}"\n\n${top.length} of ${allChunks.length} matched chunks (limit: ${limit})\n\n---\n`;
    log(`recall: query="${query}" matched ${allChunks.length} chunks, returning ${top.length}`);
    return ok(header + top.map((c, i) => formatResult(c, i)).join('\n\n---\n\n'));
  },
};

registerTools([recall]);
