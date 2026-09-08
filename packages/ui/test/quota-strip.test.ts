/**
 * WP5: the strip's pure half.
 *
 * The whole point of putting the labels, the colours and the countdown in a
 * module with no DOM in it is that the rules a monitor must not get wrong can
 * be asserted rather than looked at. Three of them are worth the file on their
 * own:
 *
 * - an unknown percentage is never `0 %`;
 * - a percentage is rounded **down**, so a window is never called spent before
 *   it is;
 * - a window key nobody has seen before still gets a sensible label instead of
 *   disappearing.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  AGING_MS,
  ageLabel,
  barPercent,
  countdownLabel,
  FRESH_MS,
  freshnessOf,
  hasQuota,
  itemLabel,
  percentLabel,
  providerLabel,
  quotaItems,
  quotaSourceLabel,
  severityOf,
  windowLabel,
} from '../src/quota-strip.ts';
import type { ProviderLike, QuotaLike, WindowLike } from '../src/quota-strip.ts';

const NOW = 1_788_756_000_000;

function window(percent: number | undefined, extra: Partial<WindowLike> = {}): WindowLike {
  return {
    key: 'seven_day',
    state: 'ok',
    windowMinutes: 10_080,
    ...(percent === undefined ? {} : { percent }),
    ...extra,
  };
}

/* ---------------------------------------------------------- severity */

test('the thresholds are the theme file\'s: amber at 60, red at 85', () => {
  assert.equal(severityOf(window(0)), 'ok');
  assert.equal(severityOf(window(59.9)), 'ok');
  assert.equal(severityOf(window(60)), 'warn');
  assert.equal(severityOf(window(84.9)), 'warn');
  assert.equal(severityOf(window(85)), 'critical');
  assert.equal(severityOf(window(100)), 'critical');
});

test('no percentage is unknown, and unknown is not zero', () => {
  assert.equal(severityOf(window(undefined, { state: 'error' })), 'unknown');
  assert.equal(percentLabel(window(undefined)), 'unknown');
  assert.equal(barPercent(window(undefined)), 0);
  // The distinction the whole rule exists for.
  assert.equal(percentLabel(window(0)), '0%');
  assert.notEqual(percentLabel(window(undefined)), percentLabel(window(0)));
});

test('a stale window keeps its number: state is not the same question as percent', () => {
  assert.equal(severityOf(window(70, { state: 'stale', error: 'no log since 18:40' })), 'warn');
  assert.equal(percentLabel(window(70, { state: 'stale' })), '70%');
});

test('percentages round down, so a window is never called spent early', () => {
  assert.equal(percentLabel(window(99.6)), '99%');
  assert.equal(percentLabel(window(12.9)), '12%');
  assert.equal(percentLabel(window(100)), '100%');
});

/* ------------------------------------------------------------ labels */

test('a window is named from windowMinutes first, and its key second', () => {
  assert.equal(windowLabel({ key: 'five_hour', state: 'ok', windowMinutes: 300 }), '5 h');
  assert.equal(windowLabel({ key: 'primary', state: 'ok', windowMinutes: 300 }), '5 h');
  assert.equal(windowLabel({ key: 'secondary', state: 'ok', windowMinutes: 10_080 }), 'weekly');
  // No `windowMinutes` at all: the key still has to produce something.
  assert.equal(windowLabel({ key: 'five_hour', state: 'ok' }), '5 h');
  assert.equal(windowLabel({ key: 'seven_day', state: 'ok' }), 'weekly');
});

test('a key nobody has seen before is shown, not dropped', () => {
  assert.equal(windowLabel({ key: 'thirty_day', state: 'ok', windowMinutes: 43_200 }), 'thirty day');
});

test('a model-scoped weekly says which model — it is why limits.json wins', () => {
  assert.equal(
    windowLabel({ key: 'seven_day_fable', state: 'ok', windowMinutes: 10_080, model: 'Fable' }),
    'weekly Fable',
  );
});

test('providers are named the way a person writes them', () => {
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('gemini'), 'Gemini');
  assert.equal(providerLabel(''), 'unknown');
});

test('an item reads provider first, then window', () => {
  const provider: ProviderLike = { name: 'codex', configured: true, windows: [] };
  assert.equal(itemLabel(provider, { key: 'primary', state: 'ok', windowMinutes: 300 }), 'Codex · 5 h');
});

/* --------------------------------------------------------- countdown */

test('the countdown counts down, and says so when the reset is already due', () => {
  assert.equal(countdownLabel(NOW + 3 * 3_600_000 + 41 * 60_000, NOW), 'resets in 3h 41m');
  assert.equal(countdownLabel(NOW + 45_000, NOW), 'resets in 45s');
  assert.equal(countdownLabel(NOW - 1, NOW), 'reset due');
  assert.equal(countdownLabel(NOW, NOW), 'reset due');
  assert.equal(countdownLabel(undefined, NOW), '', 'no reset time means no countdown, not a zero');
});

/* -------------------------------------------------------- freshness */

test('freshness uses the same bands as nazar-tray, so the two agree', () => {
  assert.equal(freshnessOf(0), 'fresh');
  assert.equal(freshnessOf(FRESH_MS), 'fresh');
  assert.equal(freshnessOf(FRESH_MS + 1), 'aging');
  assert.equal(freshnessOf(AGING_MS), 'aging');
  assert.equal(freshnessOf(AGING_MS + 1), 'stale');
  assert.equal(freshnessOf(undefined), 'unknown');
  // A source clock ahead of ours is not an error.
  assert.equal(freshnessOf(-5000), 'fresh');
});

test('an age is printed only once it is worth printing', () => {
  assert.equal(ageLabel(1000), '');
  assert.equal(ageLabel(FRESH_MS), '');
  assert.equal(ageLabel(52 * 60_000), 'read 52m 00s ago');
  assert.equal(ageLabel(undefined), '');
});

/* ------------------------------------------------------------- items */

const QUOTA: QuotaLike = {
  source: 'limits.json',
  updatedAt: NOW - 90_000,
  providers: [
    {
      name: 'claude',
      configured: true,
      plan: 'max_20x',
      source: 'endpoint',
      sourceAt: NOW - 90_000,
      binding: 'seven_day_fable',
      windows: [
        { key: 'five_hour', state: 'ok', percent: 12, windowMinutes: 300, resetsAt: NOW + 3_600_000 },
        { key: 'seven_day', state: 'ok', percent: 71, windowMinutes: 10_080 },
        {
          key: 'seven_day_fable',
          state: 'ok',
          percent: 88,
          windowMinutes: 10_080,
          model: 'Fable',
          detailed: true,
        },
        { key: 'seven_day_sonnet', state: 'error', windowMinutes: 10_080, model: 'Sonnet', error: 'no answer' },
      ],
    },
    // Present in the file so a consumer can tell "not on this machine" from
    // "not written yet". It contributes no bar.
    { name: 'codex', configured: false, windows: [] },
  ],
};

test('every window of every configured provider becomes one item, in file order', () => {
  const items = quotaItems(QUOTA, NOW);
  assert.deepEqual(
    items.map((item) => item.id),
    [
      'claude/five_hour',
      'claude/seven_day',
      'claude/seven_day_fable',
      'claude/seven_day_sonnet',
    ],
  );
  assert.deepEqual(
    items.map((item) => item.severity),
    ['ok', 'warn', 'critical', 'unknown'],
  );
  assert.deepEqual(
    items.map((item) => item.label),
    ['Claude · 5 h', 'Claude · weekly', 'Claude · weekly Fable', 'Claude · weekly Sonnet'],
  );
  assert.deepEqual(
    items.map((item) => item.binding),
    [false, false, true, false],
  );
  assert.equal(items[2]?.detailed, true);
  assert.equal(items[3]?.percentText, 'unknown');
  assert.equal(items[3]?.barPercent, 0);
});

test('an unconfigured provider draws nothing at all', () => {
  const items = quotaItems(QUOTA, NOW);
  assert.equal(
    items.some((item) => item.provider === 'codex'),
    false,
  );
});

test('a fresh provider prints no age; a stale one prints it on every item', () => {
  const fresh = quotaItems(QUOTA, NOW);
  assert.deepEqual(new Set(fresh.map((item) => item.freshness)), new Set(['fresh']));
  assert.deepEqual(new Set(fresh.map((item) => item.ageText)), new Set(['']));

  const later = quotaItems(QUOTA, NOW + 52 * 60_000);
  assert.deepEqual(new Set(later.map((item) => item.freshness)), new Set(['stale']));
  assert.ok(later[0]?.ageText.startsWith('read '));
});

test('the description says the whole item in one sentence', () => {
  const items = quotaItems(QUOTA, NOW);
  assert.equal(items[0]?.description, 'Claude · 5 h: 12% used · resets in 1h 00m');
  assert.equal(
    items[3]?.description,
    'Claude · weekly Sonnet: unknown · error · no answer',
  );
});

test('no quota means no items and no strip', () => {
  assert.deepEqual(quotaItems(undefined, NOW), []);
  assert.equal(hasQuota(undefined, NOW), false);
  assert.equal(hasQuota({ source: 'limits.json', providers: [] }, NOW), false);
  assert.equal(hasQuota(QUOTA, NOW), true);
});

test('the sidebar names the source, and says what to do when there is none', () => {
  assert.equal(quotaSourceLabel(QUOTA), 'from nazar-tray');
  assert.equal(
    quotaSourceLabel({ source: 'statusline', providers: [] }),
    'from status-line captures',
  );
  assert.equal(quotaSourceLabel(undefined), 'none — install the wrapper or nazar-tray');
});
