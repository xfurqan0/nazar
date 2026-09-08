/**
 * WP5: which source the quota strip is drawn from, and what it says.
 *
 * There are two, they do not overlap, and one of them is strictly better:
 *
 * | | five-hour | weekly | model-scoped weekly | Codex |
 * |---|---|---|---|---|
 * | a status-line capture | yes | yes | **no** | no |
 * | `~/.nazar/limits.json` | yes | yes | yes (detailed mode) | yes |
 *
 * So the precedence is `limits.json` > the newest capture > nothing, and the
 * strip is hidden outright in the third case. It is never a *merge*: two
 * sources disagreeing by a percent because they were read four seconds apart
 * would put two different numbers for one window on one strip, and a monitor
 * that shows a quantity twice has to show it once.
 *
 * "The newest capture" and not "this session's capture", because quota is a
 * property of the account rather than of a session: three sessions report the
 * same two windows, and the freshest reading of them is the right one.
 *
 * Nothing here is derived-and-stored. `binding`, remaining time, age and
 * severity all change with the clock rather than with the data, so they are
 * computed where they are drawn, from these numbers plus the current time.
 */
import type { CaptureScan, StatuslineCapture } from './statusline-captures.js';
import { captureAgeSource, newestCapture } from './statusline-captures.js';
import type { LimitsProvider, LimitsScan, LimitsWindow } from './limits-file.js';
import { bindingWindow } from './limits-file.js';

/** Where the numbers on the strip came from. */
export type QuotaSource = 'limits.json' | 'statusline';

/** One window on the strip. Identical in shape to the file's own. */
export type QuotaWindow = LimitsWindow;

/** One provider's block on the strip. */
export type QuotaProvider = LimitsProvider;

/** Everything the strip draws, plus where it came from. */
export interface Quota {
  readonly source: QuotaSource;
  /**
   * When the source document was last written. For a capture this is when the
   * wrapper captured it; for `limits.json` it is the tray's `updatedAt`, which
   * moves only when the content changes.
   */
  readonly updatedAt?: number;
  readonly providers: readonly QuotaProvider[];
}

/** Minutes in the two windows the status line reports. Written for both. */
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;

/** Windows across every provider. Used to decide whether a source says anything. */
export function windowCount(providers: readonly QuotaProvider[]): number {
  return providers.reduce((sum, provider) => sum + provider.windows.length, 0);
}

/**
 * A Claude provider block built out of one capture's `rate_limits`.
 *
 * Only the two windows the payload actually carries. `spend_limit` is
 * documented, was never observed on this machine, and is not a usage window in
 * the same sense as the other two, so it is not drawn; the reader keeps it so
 * the day it appears there is something to look at in doctor.
 *
 * There is no `plan` here on purpose. The payload has no plan name — `model.id`
 * says which model and `version` says which build, and neither says which
 * subscription — so guessing one would be inventing a fact.
 */
export function quotaFromCapture(capture: StatuslineCapture): Quota | undefined {
  const limits = capture.rateLimits;
  if (limits === undefined) return undefined;

  const windows: QuotaWindow[] = [];
  const add = (key: string, minutes: number, window: { percent?: number; resetsAt?: number } | undefined): void => {
    if (window === undefined) return;
    const out: { -readonly [K in keyof QuotaWindow]: QuotaWindow[K] } = {
      key,
      // The status line reports a window or drops it; there is no third state
      // it can express, so a window that is here is one that was read.
      state: 'ok',
      windowMinutes: minutes,
    };
    if (window.percent !== undefined) out.percent = window.percent;
    if (window.resetsAt !== undefined) out.resetsAt = window.resetsAt;
    windows.push(out);
  };

  add('five_hour', FIVE_HOUR_MINUTES, limits.five_hour);
  add('seven_day', SEVEN_DAY_MINUTES, limits.seven_day);
  if (windows.length === 0) return undefined;

  const at = captureAgeSource(capture);
  const provider: { -readonly [K in keyof QuotaProvider]: QuotaProvider[K] } = {
    name: 'claude',
    configured: true,
    source: 'statusline',
    windows,
  };
  if (at !== undefined) provider.sourceAt = at;
  const binding = bindingWindow(windows);
  if (binding !== undefined) provider.binding = binding;

  const quota: { -readonly [K in keyof Quota]: Quota[K] } = {
    source: 'statusline',
    providers: [provider],
  };
  if (at !== undefined) quota.updatedAt = at;
  return quota;
}

/**
 * Pick the source and build the strip's data, or return `undefined` for
 * "nothing to draw" — which is the state on any machine that has neither
 * nazar-tray nor the wrapper, and is drawn as no strip at all.
 *
 * `limits.json` wins whenever it parsed **and carries at least one window**.
 * The second half of that matters on a real machine: the file exists here with
 * `claude: {configured: false}` and a full Codex block, and it would be wrong
 * for a document that happens to describe nothing to hide a capture that
 * describes something.
 */
export function selectQuota(limits: LimitsScan, captures: CaptureScan): Quota | undefined {
  const document = limits.document;
  if (document !== undefined && windowCount(document.providers) > 0) {
    const quota: { -readonly [K in keyof Quota]: Quota[K] } = {
      source: 'limits.json',
      providers: document.providers,
    };
    const updatedAt = document.updatedAt ?? limits.fileAt;
    if (updatedAt !== undefined) quota.updatedAt = updatedAt;
    return quota;
  }

  const capture = newestCapture(captures);
  if (capture === undefined) return undefined;
  return quotaFromCapture(capture);
}
