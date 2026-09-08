/**
 * Acceptance check for WP4b, run by hand on a machine that has real
 * transcripts:
 *
 *     node --import tsx scripts/history-probe.ts [openCount]
 *
 * Three questions, answered with numbers rather than with an impression:
 *
 * 1. **Is the listing cheap?** It times `HistoryScanner.list()` — the walk that
 *    the history panel does on every open — and prints how many sessions it
 *    found and how many files it opened doing so. That last number must be
 *    zero: a listing that reads a transcript is a bug, not a slow path.
 * 2. **Is opening bounded?** It opens the N largest sessions and reports bytes
 *    and milliseconds each, then re-opens the first to show the cache answering.
 * 3. **Do the three `done` signals classify real agents?** For every agent in
 *    those sessions it re-runs the state machine *as the live canvas would*
 *    (without the frozen `sessionGone`) and reports which signal each one got.
 *    An agent nothing can classify shows up as `unclassified`, which is the
 *    number this script exists to keep at zero.
 *
 * Read-only with respect to Claude Code: it opens transcripts and writes
 * nothing under `~/.claude`. Sessions are printed as a hash, never as a path or
 * an id: this output ends up in reports.
 */
import { createHash } from 'node:crypto';

import { agentDoneState, DONE_QUIET_MS } from '../packages/core/src/agent-done.ts';
import { HistoryScanner } from '../packages/core/src/history.ts';
import { readSubagentsDir } from '../packages/core/src/subagent-meta.ts';
import { projectsDirPath, sessionTranscriptPaths } from '../packages/core/src/paths.ts';
import { projectSlugFor } from '../packages/core/src/project-slug.ts';
import { extractTranscriptLine } from '../packages/core/src/transcript-extract.ts';
import { TranscriptStats } from '../packages/core/src/transcript-stats.ts';
import { TranscriptTailer } from '../packages/core/src/transcript-tailer.ts';
import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

/** Twelve hex characters of a digest: stable, and not an identifier. */
function hashName(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function table(header: readonly string[], rows: readonly (readonly string[])[], right: Set<number>): void {
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => pad(cell, widths[column] ?? 0, right.has(column))).join('  ');
  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

/** Where a project's session directory lives, for the live-rule replay. */
async function projectDirOf(sessionId: string): Promise<string | undefined> {
  const root = projectsDirPath();
  for (const slug of await readdir(root)) {
    const dir = path.join(root, slug);
    try {
      const names = await readdir(dir);
      if (names.includes(`${sessionId}.jsonl`)) return dir;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const openCount = Number(process.argv[2] ?? 10);
  const scanner = new HistoryScanner();

  /* ---- 1. the listing ------------------------------------------------ */

  const started = Date.now();
  const first = await scanner.list({ limit: 500 });
  const firstMs = Date.now() - started;

  const warmStarted = Date.now();
  await scanner.list({ limit: 500, offset: 0 });
  const warmMs = Date.now() - warmStarted;

  console.log(`home slug collapsed to "~": ${projectSlugFor(os.homedir())}`);
  console.log(
    `list: ${first.total} sessions across ${first.projects.length} projects · ` +
      `cold ${firstMs} ms (walk ${first.listMs} ms) · cached ${warmMs} ms · ` +
      `warnings ${first.warnings} · transcripts opened ${scanner.stats.fileReads}`,
  );
  if (scanner.stats.fileReads !== 0) {
    console.log('!! the listing opened a transcript, which it must never do');
  }

  /* ---- 2. opening ---------------------------------------------------- */

  const biggest = [...first.sessions]
    .sort((a, b) => b.transcriptBytes - a.transcriptBytes)
    .slice(0, Number.isFinite(openCount) ? openCount : 10);

  const rows: string[][] = [];
  const signals = new Map<string, number>();
  let unclassified = 0;
  let liveDone = 0;
  let agentTotal = 0;
  let launchOnly = 0;

  for (const summary of biggest) {
    const openStarted = Date.now();
    const history = await scanner.open(summary.sessionId);
    const openMs = Date.now() - openStarted;
    if (history === undefined) continue;

    rows.push([
      hashName(summary.sessionId),
      `${(summary.transcriptBytes / 1024 / 1024).toFixed(2)}M`,
      String(history.agentCount),
      `${openMs}`,
      `${(history.bytesRead / 1024 / 1024).toFixed(1)}M`,
      (history.tokens?.out ?? 0).toLocaleString('en-US'),
      (history.treeTokens?.out ?? 0).toLocaleString('en-US'),
      history.durationMs === undefined ? '-' : `${Math.round(history.durationMs / 60000)}m`,
      history.model ?? '-',
    ]);

    /* ---- 3. the live rule, replayed ---------------------------------- */

    const projectDir = await projectDirOf(summary.sessionId);
    if (projectDir === undefined) continue;
    const paths = sessionTranscriptPaths(projectDir, summary.sessionId);
    const scan = await readSubagentsDir(paths.subagentsDir);
    if (scan.metas.length === 0) continue;

    // `completed`, not merely "a bridge exists": the `Agent` tool returns at
    // launch on Claude Code 2.1.263, so a bridge is usually a launch record.
    const completed = new Set<string>();
    let launchBridges = 0;
    const sessionRead = new TranscriptTailer(paths.transcript);
    const sessionStats = new TranscriptStats();
    for (const line of (await sessionRead.read()).lines) {
      const event = extractTranscriptLine(line);
      if (event !== undefined) sessionStats.add(event);
    }
    const collect = (stats: TranscriptStats): void => {
      for (const [id, bridge] of stats.agentBridges) {
        if (bridge.completed) completed.add(id);
        else launchBridges += 1;
      }
    };
    collect(sessionStats);

    const perAgent = new Map<string, TranscriptStats>();
    for (const file of scan.transcripts) {
      const stats = new TranscriptStats();
      const result = await new TranscriptTailer(file.file).read();
      for (const line of result.lines) {
        const event = extractTranscriptLine(line);
        if (event !== undefined) stats.add(event);
      }
      collect(stats);
      perAgent.set(file.agentId, stats);
    }
    launchOnly += launchBridges;

    for (const meta of scan.metas) {
      agentTotal += 1;
      const stats = perAgent.get(meta.id);
      const agentFile = scan.transcripts.find((one) => one.agentId === meta.id);
      const mtime = agentFile === undefined ? undefined : (await import('node:fs/promises')).stat(agentFile.file);
      const lastWriteAt = mtime === undefined ? undefined : (await mtime).mtimeMs;

      // The live rule: no `sessionGone`, and a clock far enough past the last
      // write that the quiet window has certainly elapsed.
      const verdict = agentDoneState({
        hasParentResult: completed.has(meta.id),
        now: Date.now(),
        ...(stats?.lastLineType === undefined ? {} : { lastLineType: stats.lastLineType }),
        ...(stats === undefined ? {} : { pendingToolUse: stats.pendingToolUse }),
        ...(lastWriteAt === undefined ? {} : { lastWriteAt }),
        ...(stats?.lastEventAt === undefined ? {} : { lastEventAt: stats.lastEventAt }),
      });

      const key =
        verdict.signal ??
        `${verdict.state}:last=${stats?.lastLineType ?? 'none'}${stats?.pendingToolUse === true ? '+tool' : ''}`;
      signals.set(key, (signals.get(key) ?? 0) + 1);
      if (verdict.state === 'done') liveDone += 1;
      else unclassified += 1;
    }
  }

  console.log();
  table(
    ['session', 'size', 'agents', 'open_ms', 'read', 'out_tok', 'tree_out', 'dur', 'model'],
    rows,
    new Set([1, 2, 3, 4, 5, 6, 7]),
  );

  /* ---- the cache ----------------------------------------------------- */

  const target = biggest[0];
  if (target !== undefined) {
    const before = scanner.stats.fileReads;
    const cachedStarted = Date.now();
    await scanner.open(target.sessionId);
    console.log();
    console.log(
      `re-open of the largest session: ${Date.now() - cachedStarted} ms, ` +
        `${scanner.stats.fileReads - before} files opened (cache hits ${scanner.stats.cacheHits})`,
    );
  }

  console.log();
  console.log(
    `done signals on ${agentTotal} real agents, replayed under the live rule ` +
      `(quiet window ${DONE_QUIET_MS / 1000} s, no session-gone):`,
  );
  for (const [key, count] of [...signals].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(key, 34)} ${String(count).padStart(5)}`);
  }
  console.log(`  done ${liveDone} · not yet done ${unclassified}`);
  console.log(
    `  bridges that were launch records only (status async_launched): ${launchOnly} — ` +
      'these must never end an agent',
  );
}

await main();
