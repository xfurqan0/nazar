/**
 * Acceptance check for WP2, run by hand on a machine that has real transcripts:
 *
 *     node --import tsx scripts/recount.ts [count]
 *
 * For the N most recently written transcripts under `~/.claude/projects` it
 * computes the same totals twice and compares them:
 *
 * - **naive**: every `assistant` line's `usage` summed, which is what a reader
 *   without the `(message.id, requestId)` dedupe reports;
 * - **full-file**: one pass over the whole file through the extractor and
 *   `TranscriptStats`, deduplicated;
 * - **incremental**: the same file fed through `TranscriptTailer` in four
 *   arbitrary byte slices, so partial lines fall in the middle of the data, and
 *   accumulated exactly as the live watcher does.
 *
 * "matches" is the last two agreeing. They must, or the tailer is losing or
 * double-counting lines.
 *
 * Read-only with respect to Claude Code: it opens transcripts and writes
 * nothing under `~/.claude`. The slicing happens in the OS temp directory, and
 * the temp copies are removed. File names are printed as a hash, never as a
 * path: this output ends up in reports.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDirPath } from '../packages/core/src/paths.ts';
import { extractTranscriptLine } from '../packages/core/src/transcript-extract.ts';
import type { TokenTotals } from '../packages/core/src/transcript-stats.ts';
import { TranscriptStats } from '../packages/core/src/transcript-stats.ts';
import { TranscriptTailer } from '../packages/core/src/transcript-tailer.ts';

interface Candidate {
  readonly file: string;
  readonly kind: 'session' | 'subagent';
  readonly mtimeMs: number;
  readonly size: number;
}

/** Twelve hex characters of the path's digest: stable, and not a path. */
function hashName(file: string): string {
  return createHash('sha256').update(file).digest('hex').slice(0, 12);
}

async function candidates(root: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return found;
  }

  for (const project of projects) {
    const projectDir = path.join(root, project);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(projectDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(full);
        found.push({ file: full, kind: 'session', mtimeMs: info.mtimeMs, size: info.size });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const subagents = path.join(full, 'subagents');
      let names: string[];
      try {
        names = await readdir(subagents);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
        const agentFile = path.join(subagents, name);
        const info = await stat(agentFile);
        found.push({ file: agentFile, kind: 'subagent', mtimeMs: info.mtimeMs, size: info.size });
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

interface Counted {
  readonly lines: number;
  readonly assistant: number;
  readonly unique: number;
  readonly naive?: TokenTotals;
  readonly dedup?: TokenTotals;
  readonly fallbacks: number;
}

function countLines(lines: readonly string[]): Counted {
  const stats = new TranscriptStats();
  for (const line of lines) {
    const event = extractTranscriptLine(line);
    if (event !== undefined) stats.add(event);
  }
  const result: {
    -readonly [K in keyof Counted]: Counted[K];
  } = {
    lines: lines.length,
    assistant: stats.assistantLineCount,
    unique: stats.uniqueMessageCount,
    fallbacks: stats.dedupeFallbacks,
  };
  const naive = stats.naiveTokens;
  if (naive !== undefined) result.naive = naive;
  const dedup = stats.tokens;
  if (dedup !== undefined) result.dedup = dedup;
  return result;
}

/** Feed the file to the tailer in four slices, as if it were being appended. */
async function incremental(file: string, tempDir: string, slices = 4): Promise<Counted> {
  const body = await readFile(file);
  const copy = path.join(tempDir, `${hashName(file)}.jsonl`);
  await writeFile(copy, Buffer.alloc(0));

  const tailer = new TranscriptTailer(copy);
  const stats = new TranscriptStats();
  let lines = 0;

  const step = Math.max(1, Math.ceil(body.length / slices));
  for (let offset = 0; offset < body.length || offset === 0; offset += step) {
    await appendFile(copy, body.subarray(offset, Math.min(offset + step, body.length)));
    const result = await tailer.read();
    if (result.restarted) stats.reset();
    for (const line of result.lines) {
      lines += 1;
      const event = extractTranscriptLine(line);
      if (event !== undefined) stats.add(event);
    }
    if (body.length === 0) break;
  }

  await rm(copy, { force: true });

  const result: {
    -readonly [K in keyof Counted]: Counted[K];
  } = {
    lines,
    assistant: stats.assistantLineCount,
    unique: stats.uniqueMessageCount,
    fallbacks: stats.dedupeFallbacks,
  };
  const naive = stats.naiveTokens;
  if (naive !== undefined) result.naive = naive;
  const dedup = stats.tokens;
  if (dedup !== undefined) result.dedup = dedup;
  return result;
}

function same(a: TokenTotals | undefined, b: TokenTotals | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.in === b.in && a.out === b.out && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
  );
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 10);
  const root = projectsDirPath();
  const files = (await candidates(root)).slice(0, Number.isFinite(count) ? count : 10);

  if (files.length === 0) {
    console.log(`no transcripts under the project store; nothing to recount`);
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nazar-recount-'));
  const rows: string[][] = [];
  let allMatch = true;
  let fallbacks = 0;

  try {
    for (const candidate of files) {
      const raw = await readFile(candidate.file, 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);
      const full = countLines(lines);
      const inc = await incremental(candidate.file, tempDir);

      const matches =
        same(full.dedup, inc.dedup) && full.unique === inc.unique && full.assistant === inc.assistant;
      if (!matches) allMatch = false;
      fallbacks += full.fallbacks;

      const naiveOut = full.naive?.out ?? 0;
      const dedupOut = full.dedup?.out ?? 0;
      rows.push([
        hashName(candidate.file),
        candidate.kind,
        `${(candidate.size / 1024).toFixed(0)}K`,
        String(lines.length),
        String(full.assistant),
        String(full.unique),
        naiveOut.toLocaleString('en-US'),
        dedupOut.toLocaleString('en-US'),
        dedupOut === 0 ? '-' : `${(naiveOut / dedupOut).toFixed(2)}x`,
        matches ? 'yes' : 'NO',
      ]);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const header = [
    'file',
    'kind',
    'size',
    'lines',
    'asst',
    'msgs',
    'naive_out',
    'dedup_out',
    'ratio',
    'matches',
  ];
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const rightAligned = new Set([2, 3, 4, 5, 6, 7, 8]);
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => pad(cell, widths[column] ?? 0, rightAligned.has(column))).join('  ');

  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
  console.log();
  console.log(
    `${rows.length} transcripts; incremental totals match the full-file recount: ${allMatch ? 'all' : 'NOT ALL'}; ` +
      `lines keyed on message.id alone (no requestId): ${fallbacks}`,
  );
}

await main();
