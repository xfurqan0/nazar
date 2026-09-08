/**
 * WP3': the status-line capture reader.
 *
 * `nazar-statusline` — a nazar-tray binary, not ours — is installed as Claude
 * Code's `statusLine.command`. On every redraw it writes the whole status-line
 * payload, inside a four-field envelope, to
 * `~/.nazar/statusline/<session_id>.json`. That payload is the only source on
 * this machine for three things the transcript does not carry: what the run has
 * cost, how full the context window is, and (on Pro and Max) the two rate-limit
 * windows.
 *
 * Two rules shape this file, and both are tested rather than promised:
 *
 * 1. **Only the allow-listed keys leave the parser.** A capture is the whole
 *    payload, so it holds `cwd`, `transcript_path`, `scratchpad_dir`, the
 *    workspace directories and the repository name. None of them is read. The
 *    parser builds a new object from a closed list; it never filters a parsed
 *    one, so a field that is not on the list is gone with the parse result.
 *    `packages/core/test/statusline-captures.test.ts` feeds a capture whose
 *    every path is a sentinel and fails if the sentinel appears anywhere in the
 *    output or in `JSON.stringify` of it.
 * 2. **Nothing here writes.** The directory is read with `readdir` and
 *    `readFile` and that is the whole interaction. A machine without the
 *    wrapper has no such directory, which reads as `configured: false` and
 *    draws nothing — never a `0`.
 *
 * Like every other watcher in this package, the poll is the floor and
 * `fs.watch` is the accelerator (see `fs-watch.ts`).
 */
import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DirectoryWatcher, WatchFactory } from './fs-watch.js';
import { watchPath } from './fs-watch.js';
import { statuslineCapturesDir } from './paths.js';

/** The envelope version this reader understands. A bump is breaking. */
export const CAPTURE_SCHEMA_VERSION = 1;

/** Longest string the parser will carry out of a capture. */
export const MAX_CAPTURE_STRING = 200;

/** Files in the capture directory that are not captures. Skipped by name. */
const NOT_A_CAPTURE = new Set(['chain.json']);

/** How full the context window is, as the status line reports it. */
export interface CaptureContextWindow {
  /** `context_window.total_input_tokens`. */
  readonly used?: number;
  /** `context_window.context_window_size`. */
  readonly size?: number;
  /** `context_window.used_percentage`, as reported and unrounded. */
  readonly percent?: number;
}

/** One `rate_limits` window. Absent percentage means unknown, never zero. */
export interface CaptureRateWindow {
  readonly percent?: number;
  /** Epoch **milliseconds**; the payload writes Unix seconds. */
  readonly resetsAt?: number;
}

/**
 * The rate-limit windows a payload can carry. `spend_limit` is documented but
 * was never observed on this machine, so it is read defensively and never
 * depended on.
 */
export interface CaptureRateLimits {
  readonly five_hour?: CaptureRateWindow;
  readonly seven_day?: CaptureRateWindow;
  readonly spend_limit?: CaptureRateWindow;
}

/** One capture, reduced to the fields Nazar reads. Nothing else survives. */
export interface StatuslineCapture {
  /** The envelope's `sessionId`, which is also the file name. */
  readonly sessionId: string;
  /** `wrapper`, e.g. `nazar-statusline/0.1.0`. Shown by doctor only. */
  readonly wrapper?: string;
  /** The envelope's `updatedAt`, parsed. Absent when it was not a timestamp. */
  readonly capturedAt?: number;
  /** `mtimeMs` of the capture file: when the wrapper last rewrote it. */
  readonly fileAt?: number;
  /** `model.display_name`. */
  readonly model?: string;
  /** `model.id`. */
  readonly modelId?: string;
  /** `effort.level`. Live, unlike the transcript's last written line. */
  readonly effort?: string;
  /** `cost.total_cost_usd`. */
  readonly costUsd?: number;
  readonly contextWindow?: CaptureContextWindow;
  readonly rateLimits?: CaptureRateLimits;
}

/** One pass over the capture directory. */
export interface CaptureScan {
  /** False when the directory does not exist: the wrapper is not installed. */
  readonly configured: boolean;
  /** By `sessionId`. A session with no capture is simply absent. */
  readonly captures: ReadonlyMap<string, StatuslineCapture>;
  /** Files that looked like captures and could not be used. */
  readonly warnings: number;
  /** The freshest `capturedAt` (or `fileAt`) seen in this pass. */
  readonly newestAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short, capped string, or `undefined`. Every kept string goes through it. */
function readString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= MAX_CAPTURE_STRING ? value : value.slice(0, MAX_CAPTURE_STRING);
}

/** A finite, non-negative number, or `undefined`. `0` is a measurement. */
function readNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * A reset time. Claude Code writes Unix **seconds**; a value past 10^12 is read
 * as milliseconds, so a future switch degrades instead of breaking. This is the
 * same rule nazar-tray's own reader applies to the same field.
 */
export function readResetsAt(value: unknown): number | undefined {
  const seconds = readNumber(value);
  if (seconds === undefined || seconds === 0) return undefined;
  return seconds > 1e12 ? seconds : seconds * 1000;
}

function readRateWindow(value: unknown): CaptureRateWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = readNumber(value['used_percentage']);
  const resetsAt = readResetsAt(value['resets_at']);
  if (percent === undefined && resetsAt === undefined) return undefined;
  const window: { percent?: number; resetsAt?: number } = {};
  if (percent !== undefined) window.percent = percent;
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

function readRateLimits(value: unknown): CaptureRateLimits | undefined {
  if (!isRecord(value)) return undefined;
  const out: { five_hour?: CaptureRateWindow; seven_day?: CaptureRateWindow; spend_limit?: CaptureRateWindow } = {};
  const five = readRateWindow(value['five_hour']);
  const seven = readRateWindow(value['seven_day']);
  const spend = readRateWindow(value['spend_limit']);
  if (five !== undefined) out.five_hour = five;
  if (seven !== undefined) out.seven_day = seven;
  if (spend !== undefined) out.spend_limit = spend;
  return five === undefined && seven === undefined && spend === undefined ? undefined : out;
}

function readContextWindow(value: unknown): CaptureContextWindow | undefined {
  if (!isRecord(value)) return undefined;
  // `total_input_tokens` is what `used_percentage` is computed from: 159,283 of
  // 1,000,000 is the 16 % the payload reports. `current_usage` is the last
  // request's four counters and is a different question, so it is not read.
  const used = readNumber(value['total_input_tokens']);
  const size = readNumber(value['context_window_size']);
  const percent = readNumber(value['used_percentage']);
  if (used === undefined && size === undefined && percent === undefined) return undefined;
  const out: { used?: number; size?: number; percent?: number } = {};
  if (used !== undefined) out.used = used;
  if (size !== undefined) out.size = size;
  if (percent !== undefined) out.percent = percent;
  return out;
}

/**
 * Parse one capture file.
 *
 * Returns `undefined` for anything that is not a version-1 envelope with a
 * usable session id: a half-written file, a document from a newer wrapper, or
 * a file that is not a capture at all. Nothing here throws.
 */
export function parseStatuslineCapture(raw: string, fileAt?: number): StatuslineCapture | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed['schemaVersion'] !== CAPTURE_SCHEMA_VERSION) return undefined;

  const sessionId = readString(parsed['sessionId']);
  if (sessionId === undefined) return undefined;

  const capture: {
    -readonly [K in keyof StatuslineCapture]: StatuslineCapture[K];
  } = { sessionId };

  const wrapper = readString(parsed['wrapper']);
  if (wrapper !== undefined) capture.wrapper = wrapper;

  const updatedAt = readString(parsed['updatedAt']);
  if (updatedAt !== undefined) {
    const at = Date.parse(updatedAt);
    if (Number.isFinite(at)) capture.capturedAt = at;
  }
  if (fileAt !== undefined && Number.isFinite(fileAt)) capture.fileAt = fileAt;

  // Everything below reaches into the payload, and this is the whole of what it
  // takes out of it. `cwd`, `transcript_path`, `scratchpad_dir`, `workspace`,
  // `session_name` and `prompt_id` are all in there and none of them is read.
  const payload = parsed['payload'];
  if (isRecord(payload)) {
    const model = payload['model'];
    if (isRecord(model)) {
      const display = readString(model['display_name']);
      const id = readString(model['id']);
      if (display !== undefined) capture.model = display;
      if (id !== undefined) capture.modelId = id;
    }

    const effort = payload['effort'];
    if (isRecord(effort)) {
      const level = readString(effort['level']);
      if (level !== undefined) capture.effort = level;
    }

    const cost = payload['cost'];
    if (isRecord(cost)) {
      const usd = readNumber(cost['total_cost_usd']);
      if (usd !== undefined) capture.costUsd = usd;
    }

    const contextWindow = readContextWindow(payload['context_window']);
    if (contextWindow !== undefined) capture.contextWindow = contextWindow;

    const rateLimits = readRateLimits(payload['rate_limits']);
    if (rateLimits !== undefined) capture.rateLimits = rateLimits;
  }

  return capture;
}

/** When a capture was taken: the envelope's stamp, else the file's mtime. */
export function captureAgeSource(capture: StatuslineCapture): number | undefined {
  return capture.capturedAt ?? capture.fileAt;
}

/**
 * The newest capture in a scan, by {@link captureAgeSource}. Ties go to the
 * first seen, which `readdir` orders; nothing depends on which one wins a tie
 * because two captures written in the same millisecond carry the same numbers.
 */
export function newestCapture(scan: CaptureScan): StatuslineCapture | undefined {
  let best: StatuslineCapture | undefined;
  let bestAt = -Infinity;
  for (const capture of scan.captures.values()) {
    const at = captureAgeSource(capture) ?? -Infinity;
    if (at > bestAt) {
      best = capture;
      bestAt = at;
    }
  }
  return best;
}

/** One pass over `~/.nazar/statusline`. Opens no file it cannot name. */
export async function readCapturesDir(dir: string): Promise<CaptureScan> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { configured: false, captures: new Map(), warnings: 0 };
    }
    return { configured: false, captures: new Map(), warnings: 1 };
  }

  const captures = new Map<string, StatuslineCapture>();
  let warnings = 0;
  let newestAt: number | undefined;

  for (const name of names) {
    if (!name.endsWith('.json') || NOT_A_CAPTURE.has(name)) continue;
    const file = path.join(dir, name);

    let fileAt: number | undefined;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      fileAt = info.mtimeMs;
    } catch {
      // Written and removed between the listing and the stat: not a warning.
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const capture = parseStatuslineCapture(raw, fileAt);
    if (capture === undefined) {
      warnings += 1;
      continue;
    }
    captures.set(capture.sessionId, capture);
    const at = captureAgeSource(capture);
    if (at !== undefined && (newestAt === undefined || at > newestAt)) newestAt = at;
  }

  const scan: {
    -readonly [K in keyof CaptureScan]: CaptureScan[K];
  } = { configured: true, captures, warnings };
  if (newestAt !== undefined) scan.newestAt = newestAt;
  return scan;
}

/* ------------------------------------------------------------------ *
 * The watcher
 * ------------------------------------------------------------------ */

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface StatuslineCapturesOptions {
  /** Directory to read. Defaults to `~/.nazar/statusline`. */
  readonly dir?: string;
  /** Debounce applied to `fs.watch` events. Default 100 ms. */
  readonly debounceMs?: number;
  /** The floor. Default 2 s, matching every other watcher in this package. */
  readonly pollIntervalMs?: number;
  /** Set false to run on the poll alone. */
  readonly watch?: boolean;
  readonly watchFactory?: WatchFactory;
}

export interface StatuslineCapturesEvents {
  change: [CaptureScan];
}

/**
 * `~/.nazar/statusline`, read on a 2 s poll with `fs.watch` on top of it.
 *
 * The status line is rewritten every few seconds while a session is open, so
 * this directory is the busiest of Nazar's sources; the fingerprint below is
 * what keeps that from turning into an SSE frame per redraw when nothing the
 * canvas draws has actually moved.
 */
export class StatuslineCaptures extends EventEmitter<StatuslineCapturesEvents> {
  readonly dir: string;

  readonly debounceMs: number;

  readonly pollIntervalMs: number;

  private readonly useWatch: boolean;

  private readonly watchFactory: WatchFactory;

  private watcher: DirectoryWatcher | undefined;

  private pollTimer: NodeJS.Timeout | undefined;

  private debounceTimer: NodeJS.Timeout | undefined;

  private started = false;

  private queue: Promise<void> = Promise.resolve();

  private scan: CaptureScan = { configured: false, captures: new Map(), warnings: 0 };

  private fingerprint = '';

  constructor(options: StatuslineCapturesOptions = {}) {
    super();
    this.dir = options.dir ?? statuslineCapturesDir();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.useWatch = options.watch ?? true;
    this.watchFactory = options.watchFactory ?? watchPath;
  }

  /** The last pass. Cheap; never touches the disk. */
  snapshot(): CaptureScan {
    return this.scan;
  }

  /** True while an `fs.watch` handle is held. False means "poll only". */
  get watching(): boolean {
    return this.watcher !== undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    if (!this.started) return;
    this.beginWatching();
  }

  stop(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** One pass. Emits `change` only when something the canvas draws moved. */
  refresh(): Promise<void> {
    const task = async (): Promise<void> => {
      const next = await readCapturesDir(this.dir);
      const print = fingerprintOf(next);
      this.scan = next;
      if (print === this.fingerprint) return;
      this.fingerprint = print;
      this.emit('change', next);
    };
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private beginWatching(): void {
    this.beginPolling();
    if (!this.useWatch) return;
    try {
      const watcher = this.watchFactory(this.dir, () => {
        this.scheduleRefresh();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch {
      // The directory is absent whenever the wrapper is not installed, which is
      // the normal case. The poll covers the moment it appears.
    }
  }

  private beginPolling(): void {
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }
}

/**
 * Everything a consumer draws, and nothing that moves on its own.
 *
 * `capturedAt` is deliberately in it: the age of a reading is shown on the
 * strip, so a capture that was rewritten with identical numbers is still a
 * change worth publishing.
 */
export function fingerprintOf(scan: CaptureScan): string {
  const rows = [...scan.captures.values()]
    .map((capture) => [
      capture.sessionId,
      capture.capturedAt ?? null,
      capture.model ?? null,
      capture.effort ?? null,
      capture.costUsd ?? null,
      capture.contextWindow?.used ?? null,
      capture.contextWindow?.size ?? null,
      capture.contextWindow?.percent ?? null,
      capture.rateLimits?.five_hour?.percent ?? null,
      capture.rateLimits?.five_hour?.resetsAt ?? null,
      capture.rateLimits?.seven_day?.percent ?? null,
      capture.rateLimits?.seven_day?.resetsAt ?? null,
      capture.rateLimits?.spend_limit?.percent ?? null,
      capture.rateLimits?.spend_limit?.resetsAt ?? null,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([scan.configured, rows]);
}
