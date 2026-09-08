/**
 * WP5: the quota strip, as pure functions.
 *
 * Everything the strip says is worked out here — the label, the colour, the
 * percentage, the countdown, how old the reading is — so that the DOM half in
 * `web/quota.ts` only writes strings into elements it created once. Node has no
 * DOM, and this is the half that can be tested in it.
 *
 * Five rules come straight out of nazar-tray's `limits-contract.md`, and every
 * one of them is a way of not lying:
 *
 * 1. **Unknown is never zero.** A window with no `percent` is grey, says
 *    `unknown`, and has an empty bar. "I could not read it" and "you have used
 *    nothing" are opposite messages to someone about to start a long task.
 * 2. **Round down.** 99.6 % is not 100 %. A strip that says a window is spent
 *    when it is not is wrong at the exact moment it matters most.
 * 3. **The key set is open-ended.** `windowMinutes` decides what a window is
 *    called; the key is only the fallback. A window a later tray invents gets a
 *    reasonable label instead of being dropped.
 * 4. **Times are UTC and countdowns are local.** The file carries an instant;
 *    the difference between it and now is the same number in every time zone,
 *    which is why the strip draws a countdown rather than a clock time.
 * 5. **Age is shown, not hidden.** A reading from an hour ago is drawn faded
 *    and labelled, because quota does not burn while you are not using it —
 *    the number is honest, and its age is part of it.
 */
import { formatDuration, unknownWord } from './format.js';
import { t } from './i18n.js';

/** How alarming a percentage is. The thresholds are the theme's own. */
export type Severity = 'ok' | 'warn' | 'critical' | 'unknown';

/** How old a reading is. Same bands as nazar-tray, so both agree. */
export type Freshness = 'fresh' | 'aging' | 'stale' | 'unknown';

/** Bead fill turns amber here (theme.nazar.json `thresholds.amberAtPercent`). */
export const AMBER_AT_PERCENT = 60;

/** And red here (`thresholds.redAtPercent`). */
export const RED_AT_PERCENT = 85;

/** A reading younger than this is `fresh`. */
export const FRESH_MS = 5 * 60_000;

/** Younger than this is `aging`; beyond it, `stale`. */
export const AGING_MS = 45 * 60_000;

/** Minutes in a five-hour window, as both providers write it. */
const FIVE_HOUR_MINUTES = 300;

/** Minutes in a weekly window. */
const SEVEN_DAY_MINUTES = 10_080;

/** The shape the strip needs from one window. `QuotaWindow` satisfies it. */
export interface WindowLike {
  readonly key: string;
  readonly percent?: number;
  readonly resetsAt?: number;
  readonly windowMinutes?: number;
  readonly state: string;
  readonly error?: string;
  readonly model?: string;
  readonly detailed?: boolean;
}

/** The shape the strip needs from one provider. `QuotaProvider` satisfies it. */
export interface ProviderLike {
  readonly name: string;
  readonly configured: boolean;
  readonly plan?: string;
  readonly source?: string;
  readonly sourceAt?: number;
  readonly binding?: string;
  readonly windows: readonly WindowLike[];
}

/** The shape the strip needs from the whole quota. `Quota` satisfies it. */
export interface QuotaLike {
  readonly source: 'limits.json' | 'statusline';
  readonly updatedAt?: number;
  readonly providers: readonly ProviderLike[];
}

/**
 * How alarming a window is.
 *
 * A window whose `state` is not `ok` is *not* automatically unknown: the
 * contract's `stale` state keeps its last percentage on purpose, and dropping a
 * number because it is twenty minutes old would be throwing away the only
 * reading there is. Unknown means **no percentage**, and nothing else does.
 */
export function severityOf(window: WindowLike): Severity {
  return severityForPercent(window.percent);
}

/**
 * The same two thresholds, over a bare percentage.
 *
 * WP4e gave the session card a context-window figure that asks the same
 * question of the same numbers ("how full is it, and should I worry"), so the
 * thresholds are read from here rather than written down a second time. An
 * absent percentage is `unknown` in both places, for the same reason.
 */
export function severityForPercent(percent: number | undefined): Severity {
  if (percent === undefined || !Number.isFinite(percent)) return 'unknown';
  if (percent >= RED_AT_PERCENT) return 'critical';
  if (percent >= AMBER_AT_PERCENT) return 'warn';
  return 'ok';
}

/** The class the stylesheet gives that severity a colour under. */
export function severityClass(severity: Severity): string {
  return `is-${severity}`;
}

/** How old a reading is, in bands. No timestamp at all reads `unknown`. */
export function freshnessOf(ageMs: number | undefined): Freshness {
  if (ageMs === undefined || !Number.isFinite(ageMs)) return 'unknown';
  // A negative age means the writer's clock is ahead of ours, which the
  // contract calls out as normal rather than as an error. Treat it as fresh.
  if (ageMs <= FRESH_MS) return 'fresh';
  if (ageMs <= AGING_MS) return 'aging';
  return 'stale';
}

export function freshnessClass(freshness: Freshness): string {
  return `is-${freshness}`;
}

/** `claude` becomes `Claude`, and an unknown provider keeps its own name. */
export function providerLabel(name: string): string {
  // The two product names are never translated: a translated brand is the
  // wrong brand, and `Claude` reads as `Claude` in all six.
  if (name === 'claude') return 'Claude';
  if (name === 'codex') return 'Codex';
  if (name.length === 0) return t('word.unknown');
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

/**
 * What a window is called.
 *
 * `windowMinutes` first, because it is the field written for both providers
 * precisely so a consumer needs no provider-specific logic; the key is the
 * fallback, and an unrecognised key is shown as itself rather than dropped. A
 * model-scoped weekly says which model — that window is the whole reason
 * `limits.json` beats a status-line capture, so its label has to earn it.
 */
export function windowLabel(window: WindowLike): string {
  const base =
    window.windowMinutes === FIVE_HOUR_MINUTES
      ? t('usage.window.fiveHour')
      : window.windowMinutes === SEVEN_DAY_MINUTES
        ? t('usage.window.weekly')
        : window.key === 'five_hour' || window.key === 'primary'
          ? t('usage.window.fiveHour')
          : window.key === 'seven_day' || window.key === 'secondary'
            ? t('usage.window.weekly')
            : window.key.replace(/_/g, ' ');
  return window.model === undefined ? base : `${base} ${window.model}`;
}

/** `Claude · weekly Fable`. The provider is on every item; there are two. */
export function itemLabel(provider: ProviderLike, window: WindowLike): string {
  return `${providerLabel(provider.name)} · ${windowLabel(window)}`;
}

/** `12%`, rounded **down**, or `unknown`. Never `0%` for a missing reading. */
export function percentLabel(window: WindowLike): string {
  if (window.percent === undefined || !Number.isFinite(window.percent)) {
    return t('word.unknown');
  }
  return t('usage.percent', { percent: Math.floor(window.percent) });
}

/** How much of the bar to fill, 0-100. An unknown window fills none of it. */
export function barPercent(window: WindowLike): number {
  if (window.percent === undefined || !Number.isFinite(window.percent)) return 0;
  return Math.max(0, Math.min(100, window.percent));
}

/**
 * `resets in 3h 41m`, or `reset due` once the moment has passed.
 *
 * Past-due is a real state and not a bug: it is what a reading taken before a
 * long sleep looks like, and the honest thing to say is that the reset is due
 * rather than to count upwards from it or to hide the window.
 */
export function countdownLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return '';
  const remaining = resetsAt - now;
  if (remaining <= 0) return t('usage.resetDue');
  return t('usage.resetsIn', { duration: formatDuration(remaining) });
}

/** How old this reading is, in words, or `''` when nothing dates it. */
export function ageLabel(ageMs: number | undefined): string {
  if (ageMs === undefined || !Number.isFinite(ageMs) || ageMs <= FRESH_MS) return '';
  return t('usage.readAgo', { duration: formatDuration(ageMs) });
}

/** One drawn item: everything the DOM half writes, already worked out. */
export interface QuotaItem {
  /** Stable across frames: `<provider>/<window key>`. The diffing key. */
  readonly id: string;
  readonly provider: string;
  readonly windowKey: string;
  readonly label: string;
  readonly percentText: string;
  readonly barPercent: number;
  readonly severity: Severity;
  readonly freshness: Freshness;
  readonly countdown: string;
  readonly ageText: string;
  /** True when this is the window the provider is closest to spending. */
  readonly binding: boolean;
  /** True when only the opt-in detailed mode could have produced it. */
  readonly detailed: boolean;
  /** The whole item as one sentence, for `aria-label` and the tooltip. */
  readonly description: string;
}

/**
 * Every window of every configured provider, in file order.
 *
 * A provider with `configured: false` contributes nothing — the key is present
 * in the file so a consumer can tell "not on this machine" from "not written
 * yet", and neither of those is a bar worth drawing.
 */
export function quotaItems(quota: QuotaLike | undefined, now: number): QuotaItem[] {
  if (quota === undefined) return [];
  const items: QuotaItem[] = [];

  for (const provider of quota.providers) {
    if (!provider.configured) continue;
    const ageMs = provider.sourceAt === undefined ? undefined : Math.max(0, now - provider.sourceAt);
    const freshness = freshnessOf(ageMs);

    for (const window of provider.windows) {
      const severity = severityOf(window);
      const label = itemLabel(provider, window);
      const percentText = percentLabel(window);
      const countdown = countdownLabel(window.resetsAt, now);
      const ageText = ageLabel(ageMs);
      const description = [
        percentText === unknownWord()
          ? t('usage.itemUnknown', { label })
          : t('usage.itemUsed', { label, used: percentText }),
        countdown,
        window.state === 'ok' ? '' : window.state,
        window.error ?? '',
        ageText,
      ]
        .filter((part) => part.length > 0)
        .join(' · ');

      items.push({
        id: `${provider.name}/${window.key}`,
        provider: provider.name,
        windowKey: window.key,
        label,
        percentText,
        barPercent: barPercent(window),
        severity,
        freshness,
        countdown,
        ageText,
        binding: provider.binding === window.key,
        detailed: window.detailed === true,
        description,
      });
    }
  }

  return items;
}

/**
 * The sentence the sidebar shows.
 *
 * It names the source rather than the file, because "from nazar-tray" is what a
 * user can act on and `~/.nazar/limits.json` is not. The third case is the one
 * that has to be a sentence and not a dash: an absent strip looks identical to
 * a broken one, and this is the only place that says which it is.
 */
export function quotaSourceLabel(quota: QuotaLike | undefined): string {
  if (quota === undefined) return t('usage.sourceNone');
  return t(quota.source === 'limits.json' ? 'usage.sourceTray' : 'usage.sourceCaptures');
}

/** Whether the strip has anything to draw at all. */
export function hasQuota(quota: QuotaLike | undefined, now: number): boolean {
  return quotaItems(quota, now).length > 0;
}
