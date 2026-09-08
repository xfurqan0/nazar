/**
 * Reader for `~/.claude/sessions/<pid>.json`, the registry Claude Code keeps of
 * its live sessions. Nineteen keys were observed under 2.1.263; the ten listed
 * in docs/pinned-internal-formats.md are read and the rest are ignored.
 *
 * Two rules the tests pin:
 *
 * - Only a file named `<digits>.json` is opened. The directory also holds
 *   `<pid>.<hash>.key` files, which are credential material.
 * - Nothing here throws. A malformed file is skipped and counted; a missing
 *   field becomes `undefined`, or `unknown` for the status.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SessionStatus } from './types.js';
import { toSessionStatus } from './types.js';

/** A session file, parsed down to the fields Nazar depends on. */
export interface SessionFileEntry {
  readonly pid: number;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly startedAt?: number;
  readonly kind?: string;
  readonly name?: string;
  readonly status: SessionStatus;
  readonly updatedAt?: number;
  readonly statusUpdatedAt?: number;
  readonly version?: string;
}

export interface SessionFileScan {
  readonly entries: readonly SessionFileEntry[];
  /** Files that looked like session files but could not be used. */
  readonly warnings: number;
  /** True when the directory itself is missing, which is not an error. */
  readonly missingDirectory: boolean;
}

/** `<digits>.json` and nothing else: `<pid>.<hash>.key` must never match. */
const SESSION_FILE_NAME = /^(\d+)\.json$/;

export function isSessionFileName(name: string): boolean {
  return SESSION_FILE_NAME.test(name);
}

/** The pid a session file name encodes, or `undefined` when it is not one. */
export function pidFromSessionFileName(name: string): number | undefined {
  const match = SESSION_FILE_NAME.exec(name);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse one session file. `fileName` supplies the pid, because the file name is
 * the entry's identity; the `pid` field is used only when the name did not.
 * Returns `undefined` for anything unparseable, which the caller counts.
 */
export function parseSessionFile(fileName: string, raw: string): SessionFileEntry | undefined {
  const namePid = pidFromSessionFileName(fileName);
  if (namePid === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  return {
    pid: readNumber(record['pid']) ?? namePid,
    sessionId: readString(record['sessionId']),
    cwd: readString(record['cwd']),
    startedAt: readNumber(record['startedAt']),
    kind: readString(record['kind']),
    name: readString(record['name']),
    status: toSessionStatus(record['status']),
    updatedAt: readNumber(record['updatedAt']),
    statusUpdatedAt: readNumber(record['statusUpdatedAt']),
    version: readString(record['version']),
  };
}

/**
 * Read every session file in a directory. A missing directory is the normal
 * state of a machine with no session open and is reported, not thrown.
 */
export async function readSessionsDir(dir: string): Promise<SessionFileScan> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { entries: [], warnings: 0, missingDirectory: true };
    }
    return { entries: [], warnings: 1, missingDirectory: false };
  }

  const entries: SessionFileEntry[] = [];
  let warnings = 0;

  for (const name of names) {
    if (!isSessionFileName(name)) continue;
    let raw: string;
    try {
      raw = await readFile(path.join(dir, name), 'utf8');
    } catch {
      // The session ended between readdir and readFile: not a warning.
      continue;
    }
    const entry = parseSessionFile(name, raw);
    if (entry === undefined) {
      warnings += 1;
      continue;
    }
    entries.push(entry);
  }

  return { entries, warnings, missingDirectory: false };
}
