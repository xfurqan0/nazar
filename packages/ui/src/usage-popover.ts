/**
 * WP4e: the usage strip becomes a bead in the bar and a panel behind it.
 *
 * WP5 drew every provider window as a permanent row across the top of the page.
 * Six windows is six rows, and the maintainer's canvas lost 60 px of height to
 * a number he looks at twice a day. So the whole thing collapses to **one bead
 * in the top bar**, filled by the window he is closest to spending, and the
 * rows move behind a click — the same shape nazar-tray already has in the
 * Windows tray, which is where he has learned to look for them.
 *
 * Nothing about *what* is drawn changed: `quota-strip.ts` still works out every
 * label, colour, percentage and countdown, and this file only decides the two
 * things a collapsed strip needs and a row of them did not.
 *
 * 1. **Which window the bead is.** It has to be one, and it has to be the one
 *    that matters: the binding window — the one its provider will run out of
 *    first — and, across providers, the fullest of those. A bead showing the
 *    emptiest window would be a green light on a machine that is out of quota.
 * 2. **The words.** The maintainer does not know the word *quota*; nobody
 *    outside this repository is obliged to. Everything a user reads now says
 *    **usage limits**, and the panel opens with one sentence saying what that
 *    means. The code keeps `quota` — the wire format, the file name, the
 *    functions — because renaming a contract to match a label is how two
 *    projects stop agreeing about what they are exchanging.
 */
import { unknownWord } from './format.js';
import { t, tCount } from './i18n.js';
import type { QuotaItem, QuotaLike } from './quota-strip.js';
import { quotaItems, severityForPercent, type Severity } from './quota-strip.js';
import type { StorageLike } from './workspace.js';

/** What the panel is called, everywhere a person can read it. */
export function usageTitle(): string {
  return t('usage.title');
}

/** And what that means, in one line, at the top of the panel. */
export function usageExplainer(): string {
  return t('usage.explainer');
}

/** The label on the bead itself when there is nothing to show. */
export function usageNone(): string {
  return t('usage.none');
}

export const USAGE_KEY = 'nazar.usage.v1';

/**
 * Whether the panel is open.
 *
 * Remembered, because it is a mode and not a click: someone who wants the
 * numbers in front of them all day is describing the old strip, and someone who
 * wants the canvas back is describing the new default. Both get what they
 * asked for across a reload. Closed is the default — that is the change this
 * package is.
 */
export function readUsageOpen(storage: StorageLike): boolean {
  const raw = storage.getItem(USAGE_KEY);
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && (parsed as { open?: unknown }).open === true;
  } catch {
    return false;
  }
}

export function writeUsageOpen(storage: StorageLike, open: boolean): void {
  storage.setItem(USAGE_KEY, JSON.stringify({ v: 1, open }));
}

/**
 * The window the bead draws.
 *
 * The binding windows first — `quota-strip.ts` recomputes `binding` from the
 * numbers rather than believing the file — and the fullest of them wins. With
 * no binding window marked anywhere (an older tray, or a provider with one
 * window and no verdict), the fullest window of any kind is taken instead, so
 * the bead is never empty while a number exists. A window with no percentage
 * can only be the answer when *no* window has one, and then the bead is grey
 * and says `unknown` — never a reassuring empty bead.
 */
export function beadItem(items: readonly QuotaItem[]): QuotaItem | undefined {
  if (items.length === 0) return undefined;
  const known = items.filter((item) => item.percentText !== 'unknown');
  const pool = known.length > 0 ? known : items;
  const binding = pool.filter((item) => item.binding);
  const candidates = binding.length > 0 ? binding : pool;
  let best = candidates[0];
  for (const item of candidates) {
    if (best === undefined || item.barPercent > best.barPercent) best = item;
  }
  return best;
}

/** Everything the bead needs, worked out. */
export interface UsageBead {
  /** How full to draw it, 0-100. An unknown reading fills none of it. */
  readonly percent: number;
  /** `54%`, or `unknown`. The same string the panel row shows. */
  readonly percentText: string;
  readonly severity: Severity;
  /** Which window it is showing: `Claude · 5 h`. */
  readonly label: string;
  /** How many windows the panel would list. Drawn as a superscript count. */
  readonly count: number;
  /** The whole thing as one sentence, for the button's `aria-label`. */
  readonly description: string;
}

/**
 * The bead, given the items the panel would list.
 *
 * `undefined` means there is no source at all — on such a machine the button is
 * not drawn, exactly as the strip was not drawn before it. There is no empty
 * bead and no `0 %` standing in for "I could not read it".
 */
export function usageBead(items: readonly QuotaItem[]): UsageBead | undefined {
  const item = beadItem(items);
  if (item === undefined) return undefined;
  return {
    percent: item.barPercent,
    percentText: item.percentText,
    severity: item.severity,
    label: item.label,
    count: items.length,
    description:
      (item.percentText === unknownWord()
        ? t('usage.beadUnknown', { title: usageTitle(), window: item.label })
        : t('usage.beadLabel', {
            title: usageTitle(),
            window: item.label,
            used: item.percentText,
          })) +
      (items.length > 1 ? tCount('usage.beadMore', items.length) : '') +
      t('usage.beadActivate'),
  };
}

/** The bead straight from a quota document, which is what the page has. */
export function usageBeadOf(quota: QuotaLike | undefined, now: number): UsageBead | undefined {
  return usageBead(quotaItems(quota, now));
}

/**
 * The severity a *percentage* reads as, for anything that has one but is not a
 * quota window — the context-window figure on a session card, for instance,
 * which is the same question ("how full is it") against the same thresholds.
 */
export { severityForPercent };
