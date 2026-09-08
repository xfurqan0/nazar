/**
 * WP5: the `~/.nazar/limits.json` reader.
 *
 * nazar-tray writes this file and nothing else reads it here. The contract is
 * frozen at `schemaVersion: 1` and lives in that repository
 * (`docs/limits-contract.md`); `fixtures/limits.sample.json` is the vendored
 * copy of its sample, which is what the tests parse.
 *
 * Four rules of that contract this reader implements, because getting any of
 * them wrong turns a monitor into a liar:
 *
 * 1. **`percent` is optional and unknown is not zero.** A window that could not
 *    be read carries `state: "error"` and no percentage. It reaches the canvas
 *    with `percent` absent and is drawn grey, never as `0 %`.
 * 2. **Window keys are open-ended.** `five_hour`, `seven_day`,
 *    `seven_day_<model>`, `primary`, `secondary` — and whatever a later writer
 *    adds. The reader iterates the object and hard-codes no set.
 * 3. **`state` and `source` are plain strings.** An unrecognised value is
 *    carried through as written rather than rejected, so an older Nazar next to
 *    a newer tray loses nothing.
 * 4. **Times are UTC and derived values are the consumer's.** Only what was
 *    measured is stored, so `binding`, remaining time, age and severity are
 *    computed here or in the browser, from these numbers plus the clock.
 *
 * `binding` is the one derived field the file does carry. It is recomputed
 * here anyway: the contract says a consumer that disagrees should trust its own
 * arithmetic, because the file may have been written by an older build.
 */
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';

import type { DirectoryWatcher, WatchFactory } from './fs-watch.js';
import { watchPath } from './fs-watch.js';
import { nazarLimitsPath } from './paths.js';

/** The contract version this reader understands. A bump is breaking. */
export const LIMITS_SCHEMA_VERSION = 1;

/** Longest string carried out of the document. */
const MAX_LIMITS_STRING = 200;

/** One quota window, as the file spells it. */
export interface LimitsWindow {
  /** The key it was written under: `five_hour`, `secondary`, … */
  readonly key: string;
  /** 0-100, unrounded. **Absent when unknown**, and never rendered as `0`. */
  readonly percent?: number;
  /** Epoch ms. The file writes RFC 3339 in UTC. */
  readonly resetsAt?: number;
  readonly windowMinutes?: number;
  /** `ok` | `stale` | `error`, or whatever a newer writer used. Required. */
  readonly state: string;
  /** Short reason a window is stale or in error. Never a response body. */
  readonly error?: string;
  /** Model a weekly window is scoped to. Absent for global windows. */
  readonly model?: string;
  /** True when only the opt-in detailed-windows mode could have produced it. */
  readonly detailed?: boolean;
}

/** One provider block. `configured: false` is a real answer, not an absence. */
export interface LimitsProvider {
  readonly name: string;
  readonly configured: boolean;
  readonly plan?: string;
  readonly source?: string;
  /** Epoch ms: when the *source* produced the numbers. */
  readonly sourceAt?: number;
  /** Key of the window with the highest percentage, as the file computed it. */
  readonly binding?: string;
  readonly windows: readonly LimitsWindow[];
}

/** The whole document, parsed. */
export interface LimitsDocument {
  readonly schemaVersion: number;
  /** Epoch ms: when the tray last wrote the file, which is when it changed. */
  readonly updatedAt?: number;
  readonly providers: readonly LimitsProvider[];
}

/** One pass over the file. Absent is the normal case, not an error. */
export interface LimitsScan {
  /** False when the file does not exist: nazar-tray is not installed. */
  readonly configured: boolean;
  readonly document?: LimitsDocument;
  /** Why the file could not be used, when it exists and could not be. */
  readonly error?: string;
  /** `mtimeMs` of the file. */
  readonly fileAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= MAX_LIMITS_STRING ? value : value.slice(0, MAX_LIMITS_STRING);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** An RFC 3339 stamp as epoch ms. The contract guarantees UTC with a `Z`. */
export function readStamp(value: unknown): number | undefined {
  const text = readString(value);
  if (text === undefined) return undefined;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
}

/** A percentage as written. Values outside 0-100 are dropped, not clamped. */
function readPercent(value: unknown): number | undefined {
  const percent = readNumber(value);
  if (percent === undefined || percent < 0 || percent > 100) return undefined;
  return percent;
}

function parseWindow(key: string, value: unknown): LimitsWindow | undefined {
  if (!isRecord(value)) return undefined;
  // `state` is required by the contract precisely because there is no safe
  // default: a window with no state is a window we cannot describe.
  const state = readString(value['state']);
  if (state === undefined) return undefined;

  const window: { -readonly [K in keyof LimitsWindow]: LimitsWindow[K] } = { key, state };
  const percent = readPercent(value['percent']);
  if (percent !== undefined) window.percent = percent;
  const resetsAt = readStamp(value['resetsAt']);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  const windowMinutes = readNumber(value['windowMinutes']);
  if (windowMinutes !== undefined && windowMinutes > 0) window.windowMinutes = windowMinutes;
  const error = readString(value['error']);
  if (error !== undefined) window.error = error;
  const model = readString(value['model']);
  if (model !== undefined) window.model = model;
  if (value['detailed'] === true) window.detailed = true;
  return window;
}

/**
 * The window with the highest percentage.
 *
 * Ties go to the shorter `windowMinutes`, then to the smaller key. A window
 * with **no** percentage never binds — "I could not read it" is not a
 * constraint — so a provider whose windows are all unknown has none.
 */
export function bindingWindow(windows: readonly LimitsWindow[]): string | undefined {
  let best: LimitsWindow | undefined;
  for (const window of windows) {
    if (window.percent === undefined) continue;
    if (best === undefined) {
      best = window;
      continue;
    }
    if (window.percent > (best.percent ?? -1)) {
      best = window;
      continue;
    }
    if (window.percent < (best.percent ?? -1)) continue;
    const mine = window.windowMinutes ?? Number.POSITIVE_INFINITY;
    const theirs = best.windowMinutes ?? Number.POSITIVE_INFINITY;
    if (mine < theirs || (mine === theirs && window.key < best.key)) best = window;
  }
  return best?.key;
}

function parseProvider(name: string, value: unknown): LimitsProvider | undefined {
  if (!isRecord(value)) return undefined;
  const configured = value['configured'];
  if (typeof configured !== 'boolean') return undefined;

  const windows: LimitsWindow[] = [];
  const windowSource = value['windows'];
  if (isRecord(windowSource)) {
    // The key set is open-ended by contract: iterate, never hard-code.
    for (const [key, raw] of Object.entries(windowSource)) {
      const window = parseWindow(key, raw);
      if (window !== undefined) windows.push(window);
    }
  }

  const provider: { -readonly [K in keyof LimitsProvider]: LimitsProvider[K] } = {
    name,
    configured,
    windows,
  };
  const plan = readString(value['plan']);
  if (plan !== undefined) provider.plan = plan;
  const source = readString(value['source']);
  if (source !== undefined) provider.source = source;
  const sourceAt = readStamp(value['sourceAt']);
  if (sourceAt !== undefined) provider.sourceAt = sourceAt;
  // Recomputed rather than trusted: the contract says a consumer that
  // disagrees with the file should believe its own arithmetic.
  const binding = bindingWindow(windows) ?? readString(value['binding']);
  if (binding !== undefined) provider.binding = binding;
  return provider;
}

/**
 * Parse the document, or say why it could not be used.
 *
 * A version other than 1 is refused by name rather than parsed hopefully: the
 * contract says a bump is a breaking change, and reading a version we have
 * never seen would be inventing numbers.
 */
export function parseLimitsDocument(
  raw: string,
): { readonly document: LimitsDocument } | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: 'not valid JSON' };
  }
  if (!isRecord(parsed)) return { error: 'the top level is not an object' };

  const schemaVersion = readNumber(parsed['schemaVersion']);
  if (schemaVersion === undefined) return { error: 'no schemaVersion' };
  if (schemaVersion !== LIMITS_SCHEMA_VERSION) {
    return {
      error: `schemaVersion ${schemaVersion}, and this build reads ${LIMITS_SCHEMA_VERSION}`,
    };
  }

  const providerSource = parsed['providers'];
  if (!isRecord(providerSource)) return { error: 'no providers object' };

  const providers: LimitsProvider[] = [];
  for (const [name, value] of Object.entries(providerSource)) {
    const provider = parseProvider(name, value);
    if (provider !== undefined) providers.push(provider);
  }

  const document: { -readonly [K in keyof LimitsDocument]: LimitsDocument[K] } = {
    schemaVersion,
    providers,
  };
  const updatedAt = readStamp(parsed['updatedAt']);
  if (updatedAt !== undefined) document.updatedAt = updatedAt;
  return { document };
}

/** One read of `~/.nazar/limits.json`. Nothing here throws. */
export async function readLimitsFile(file: string): Promise<LimitsScan> {
  let fileAt: number | undefined;
  try {
    const info = await stat(file);
    if (!info.isFile()) return { configured: false };
    fileAt = info.mtimeMs;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { configured: false };
    return { configured: false, error: code ?? 'unreadable' };
  }

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { configured: false };
    return { configured: true, error: code ?? 'unreadable', fileAt };
  }

  const parsed = parseLimitsDocument(raw);
  if ('error' in parsed) return { configured: true, error: parsed.error, fileAt };
  return { configured: true, document: parsed.document, fileAt };
}

/* ------------------------------------------------------------------ *
 * The watcher
 * ------------------------------------------------------------------ */

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface LimitsWatcherOptions {
  /** File to read. Defaults to `~/.nazar/limits.json`. */
  readonly file?: string;
  readonly debounceMs?: number;
  /** The floor. Default 2 s, like every other watcher in this package. */
  readonly pollIntervalMs?: number;
  readonly watch?: boolean;
  readonly watchFactory?: WatchFactory;
}

export interface LimitsWatcherEvents {
  change: [LimitsScan];
}

/**
 * `~/.nazar/limits.json`, polled every 2 s with `fs.watch` on top.
 *
 * The tray writes the file **only when its content changes**, atomically, by
 * rename. A rename is exactly the case `fs.watch` on a *file* handles worst on
 * some platforms — the handle can end up watching the replaced inode — which is
 * the other reason the poll is the floor here and not a fallback.
 */
export class LimitsWatcher extends EventEmitter<LimitsWatcherEvents> {
  readonly file: string;

  readonly debounceMs: number;

  readonly pollIntervalMs: number;

  private readonly useWatch: boolean;

  private readonly watchFactory: WatchFactory;

  private watcher: DirectoryWatcher | undefined;

  private pollTimer: NodeJS.Timeout | undefined;

  private debounceTimer: NodeJS.Timeout | undefined;

  private started = false;

  private queue: Promise<void> = Promise.resolve();

  private scan: LimitsScan = { configured: false };

  private fingerprint = '';

  constructor(options: LimitsWatcherOptions = {}) {
    super();
    this.file = options.file ?? nazarLimitsPath();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.useWatch = options.watch ?? true;
    this.watchFactory = options.watchFactory ?? watchPath;
  }

  snapshot(): LimitsScan {
    return this.scan;
  }

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

  refresh(): Promise<void> {
    const task = async (): Promise<void> => {
      const next = await readLimitsFile(this.file);
      const print = JSON.stringify([next.configured, next.error ?? null, next.document ?? null]);
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
      const watcher = this.watchFactory(this.file, () => {
        this.scheduleRefresh();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch {
      // The file is absent whenever nazar-tray is not installed, which is the
      // normal case. The poll notices the moment it appears.
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
