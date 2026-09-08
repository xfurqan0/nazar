/**
 * Synthetic quota for `?demo=1&quota=...`.
 *
 * The strip has two sources and they say different things, so the demo has one
 * of each: `limits` is the document nazar-tray writes (both providers, the
 * model-scoped weekly, a plan name), `captures` is what a bare status-line
 * wrapper can produce on its own (Claude, two windows, no plan). Both are built
 * relative to the canvas's own frozen `now`, so a screenshot's countdowns are
 * identical from one run to the next.
 *
 * The numbers are chosen the way `demo.ts` chooses its sessions: to cover the
 * states that are easy to get wrong, not the ones that look good. So the
 * limits document carries a window in each of the four severities — including
 * one with **no percentage at all**, which has to read as *unknown* and never
 * as `0 %` — and a provider whose reading is nearly an hour old, which has to
 * read as stale rather than silently pass for current.
 *
 * Nothing here is read from disk. `~/.nazar` is never written by Nazar and is
 * not even touched to take these screenshots.
 */
import type { Quota, QuotaProvider, QuotaWindow } from '@nazar/core';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;

/** Which of the two sources the demo strip is drawn from. */
export type DemoQuotaSource = 'limits' | 'captures';

function window(
  key: string,
  minutes: number,
  state: string,
  resetsAt: number | undefined,
  percent?: number,
  extra?: { model?: string; detailed?: boolean; error?: string },
): QuotaWindow {
  const out: { -readonly [K in keyof QuotaWindow]: QuotaWindow[K] } = {
    key,
    state,
    windowMinutes: minutes,
  };
  if (percent !== undefined) out.percent = percent;
  if (resetsAt !== undefined) out.resetsAt = resetsAt;
  if (extra?.model !== undefined) out.model = extra.model;
  if (extra?.detailed === true) out.detailed = true;
  if (extra?.error !== undefined) out.error = extra.error;
  return out;
}

/** The document nazar-tray writes, with both providers and every state. */
function limitsQuota(now: number): Quota {
  const claudeWindows: QuotaWindow[] = [
    // Comfortable: the bead barely fills.
    window('five_hour', FIVE_HOUR_MINUTES, 'ok', now + 3 * HOUR + 41 * MINUTE, 12),
    // Past the amber threshold.
    window('seven_day', SEVEN_DAY_MINUTES, 'ok', now + 4 * DAY + 6 * HOUR, 71),
    // Past red, and the binding window: the constraint a Fable-heavy Max user
    // actually hits, and the one a status-line capture cannot see at all.
    window('seven_day_fable', SEVEN_DAY_MINUTES, 'ok', now + 4 * DAY + 6 * HOUR, 88, {
      model: 'Fable',
      detailed: true,
    }),
    // The one that matters most to get right: no percentage, so the strip must
    // say `unknown` in grey. A window that could not be read is not an empty one.
    window('seven_day_sonnet', SEVEN_DAY_MINUTES, 'error', undefined, undefined, {
      model: 'Sonnet',
      detailed: true,
      error: 'the usage endpoint did not answer',
    }),
  ];

  const claude: QuotaProvider = {
    name: 'claude',
    configured: true,
    plan: 'max_20x',
    source: 'endpoint',
    // Ninety seconds: fresh, so no age is printed beside the countdown.
    sourceAt: now - 90 * 1000,
    binding: 'seven_day_fable',
    windows: claudeWindows,
  };

  const codex: QuotaProvider = {
    name: 'codex',
    configured: true,
    plan: 'plus',
    source: 'rollout',
    // Fifty-two minutes: past the 45-minute band, so this provider's two
    // windows are drawn faded and labelled with their age.
    sourceAt: now - 52 * MINUTE,
    binding: 'secondary',
    windows: [
      window('primary', FIVE_HOUR_MINUTES, 'ok', now + 1 * HOUR + 12 * MINUTE, 54),
      window('secondary', SEVEN_DAY_MINUTES, 'ok', now + 3 * DAY + 2 * HOUR, 70),
    ],
  };

  return { source: 'limits.json', updatedAt: now - 90 * 1000, providers: [claude, codex] };
}

/**
 * What a status-line capture alone can say: Claude, two windows, no plan, no
 * model-scoped weekly and no Codex. The percentages are the ones in
 * `fixtures/statusline-payload.json` and its sibling in nazar-tray.
 */
function captureQuota(now: number): Quota {
  const provider: QuotaProvider = {
    name: 'claude',
    configured: true,
    source: 'statusline',
    sourceAt: now - 8 * 1000,
    binding: 'seven_day',
    windows: [
      window('five_hour', FIVE_HOUR_MINUTES, 'ok', now + 5 * HOUR + 12 * MINUTE, 12),
      window('seven_day', SEVEN_DAY_MINUTES, 'ok', now + 5 * DAY + 18 * HOUR, 31),
    ],
  };
  return { source: 'statusline', updatedAt: now - 8 * 1000, providers: [provider] };
}

/** The demo strip's data for one of the two sources. */
export function makeDemoQuota(source: DemoQuotaSource, now: number): Quota {
  return source === 'limits' ? limitsQuota(now) : captureQuota(now);
}
