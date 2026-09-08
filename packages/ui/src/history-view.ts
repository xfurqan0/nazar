/**
 * WP4b: the pure half of the history panel.
 *
 * Grouping, absolute time formatting, and the one adapter that lets the frozen
 * tree reuse the live canvas renderer instead of growing a second one. No DOM
 * here, so every rule stays testable in Node.
 *
 * The live canvas measures everything against *now*: "4s ago", "2h 14m
 * elapsed", a pulsing ring. None of that means anything for a session that
 * ended yesterday, and a relative age on a frozen tree is actively misleading —
 * "written 19h ago" changes every time you look at a thing that cannot change.
 * So history speaks in **absolute times and finished durations**, which is what
 * the formatters below produce.
 */
import type { History, HistorySummary, SessionView, StateSnapshot } from '@nazar/core';

import { unknownWord } from './format.js';

/** One project's worth of past sessions, newest write first. */
export interface HistoryGroup {
  readonly project: string;
  readonly sessions: readonly HistorySummary[];
}

/**
 * Group a listing by project, keeping the listing's own order: projects appear
 * in the order their newest session does, and sessions stay newest first. A
 * project's position therefore tracks when it was last touched, which is the
 * order someone looking for "what did I run yesterday" expects.
 */
export function groupByProject(sessions: readonly HistorySummary[]): HistoryGroup[] {
  const order: string[] = [];
  const byProject = new Map<string, HistorySummary[]>();
  for (const session of sessions) {
    const existing = byProject.get(session.project);
    if (existing === undefined) {
      order.push(session.project);
      byProject.set(session.project, [session]);
    } else {
      existing.push(session);
    }
  }
  return order.map((project) => ({ project, sessions: byProject.get(project) ?? [] }));
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * An absolute local timestamp, `2026-09-06 21:46`.
 *
 * Deliberately not `toLocaleString`: the canvas is screenshotted, and a format
 * that changes with the machine's locale makes two screenshots of the same
 * data disagree. Local *time zone*, fixed *format*.
 */
export function formatStamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return unknownWord();
  const when = new Date(ms);
  if (Number.isNaN(when.getTime())) return unknownWord();
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** The same, with a calendar day only: the group heading of a listing. */
export function formatDay(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return unknownWord();
  const when = new Date(ms);
  if (Number.isNaN(when.getTime())) return unknownWord();
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** A transcript's size on disk, for the listing's "how big was this run" column. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return unknownWord();
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The head of a session uuid: enough to tell two rows apart, short enough to fit. */
export function shortSessionId(id: string): string {
  const cut = id.indexOf('-');
  return cut > 0 ? id.slice(0, cut) : id.slice(0, 8);
}

/**
 * A `History` dressed as the one-session snapshot the canvas renderer draws.
 *
 * This is the whole reason the frozen tree looks exactly like the live one: it
 * is the same `CanvasRenderer`, the same node components, the same layout, fed
 * a snapshot whose only session is the finished one. The renderer is told it is
 * frozen separately, which is what turns off the pulsing and swaps live ages
 * for absolute times.
 *
 * Two fields are placeholders and neither is ever drawn in frozen mode: `pid`
 * (a finished session has no process, and the identity line shows the session
 * id instead) and `status`. `cwd` carries the project label, because history
 * knows a project by its slug and never by a working directory.
 */
export function historySnapshot(history: History): StateSnapshot {
  const session: {
    -readonly [K in keyof SessionView]: SessionView[K];
  } = {
    id: history.sessionId,
    provider: 'claude',
    pid: 0,
    cwd: history.project,
    status: 'unknown',
    state: 'unknown',
    source: 'files',
    lastSeenAt: history.lastWriteAt ?? 0,
    agents: history.agents,
    roots: history.roots,
    orphans: [...history.orphans],
    treeRead: true,
  };

  if (history.model !== undefined) session.model = history.model;
  if (history.effort !== undefined) session.effort = history.effort;
  if (history.tokens !== undefined) session.tokens = history.tokens;
  if (history.treeTokens !== undefined) session.treeTokens = history.treeTokens;
  if (history.toolCalls !== undefined) session.toolCalls = history.toolCalls;
  if (history.firstWriteAt !== undefined) session.startedAt = history.firstWriteAt;
  if (history.lastWriteAt !== undefined) {
    session.lastWriteAt = history.lastWriteAt;
    session.transcriptAt = history.lastWriteAt;
  }

  return {
    generatedAt: history.lastWriteAt ?? 0,
    sessions: [session],
    commandAvailable: false,
    warnings: 0,
  };
}
