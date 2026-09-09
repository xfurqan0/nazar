import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  cacheReadNote,
  basename,
  formatAge,
  formatContextWindow,
  formatCostUsd,
  formatCount,
  formatDuration,
  formatElapsed,
  formatTokens,
  formatTotal,
  hostLabel,
  hostTitle,
  MAX_HOST_LABEL,
  modelChip,
  orUnknown,
  summarize,
  summaryChips,
  unknownWord,
} from '../src/format.ts';

test('formatCount is exact: grouped, never abbreviated, never rounded', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1929), '1,929');
  assert.equal(formatCount(179_402), '179,402');
  assert.equal(formatCount(14_023_930), '14,023,930');
  // The whole point of the (message.id, requestId) dedupe is the exact number.
  for (const rendered of ['1,929', '179,402', '14,023,930']) {
    assert.ok(!rendered.includes('k'));
    assert.ok(!rendered.includes('M'));
    assert.ok(!rendered.includes('≈'));
  }
});

test('an absent number is unknown, never zero', () => {
  assert.equal(formatCount(undefined), unknownWord());
  assert.equal(formatDuration(undefined), unknownWord());
  assert.equal(formatAge(undefined), unknownWord());
  assert.equal(formatTokens(undefined), unknownWord());
  assert.equal(orUnknown(undefined), unknownWord());
  assert.equal(orUnknown(''), unknownWord());
  assert.notEqual(formatCount(undefined), '0');
});

test('formatDuration steps through seconds, minutes, hours and days', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(8_400), '8s');
  assert.equal(formatDuration(247_000), '4m 07s');
  assert.equal(formatDuration(8_040_000), '2h 14m');
  assert.equal(formatDuration(273_600_000), '3d 04h');
});

test('formatDuration treats a negative or broken duration as unknown', () => {
  assert.equal(formatDuration(-1), unknownWord());
  assert.equal(formatDuration(Number.NaN), unknownWord());
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), unknownWord());
});

test('formatElapsed measures from a start against a clock', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatElapsed(now - 90_000, now), '1m 30s');
  assert.equal(formatElapsed(undefined, now), unknownWord());
});

test('formatAge says "just now" only for the first two seconds', () => {
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(1_999), 'just now');
  assert.equal(formatAge(2_000), '2s ago');
  assert.equal(formatAge(420_000), '7m 00s ago');
});

test('formatTokens prints all four counters and marks the missing ones', () => {
  assert.equal(
    formatTokens({ in: 24_118, out: 9_402, cacheRead: 1_284_507, cacheWrite: 61_440 }),
    '24,118 in · 9,402 out · 1,284,507 r · 61,440 w',
  );
  assert.equal(formatTokens({ in: 5 }), `5 in · ${unknownWord()} out · ${unknownWord()} r · ${unknownWord()} w`);
});

test('N-WP15: the card total is a magnitude, and it is the one rounded number', () => {
  /*
   * The card answers "is this a big session"; the hover card answers "how many
   * tokens exactly". `formatCount` above is still exact everywhere it is used,
   * including in the four counters this one summarises.
   */
  assert.equal(formatTotal({ in: 24_118, out: 9_402 }), '34k');
  assert.equal(formatTotal({ in: 900, out: 12 }), '912');
  assert.equal(formatTotal({ in: 999, out: 0 }), '999');
  assert.equal(formatTotal({ in: 1000, out: 0 }), '1k');
  assert.equal(formatTotal({ in: 1240, out: 0 }), '1.2k');
  assert.equal(formatTotal({ in: 1_300_000, out: 0 }), '1.3M');
  assert.equal(formatTotal({ in: 2_000_000, out: 0 }), '2M');
});

test('N-WP15: the total is input plus output, and cache is not in it', () => {
  // A cache read is the whole prompt prefix re-read once per request, so adding
  // it would put a number three orders of magnitude larger on the card and call
  // it "the tokens". `cacheReadNote` is the long version of the same point.
  assert.equal(formatTotal({ in: 1000, out: 1000, cacheRead: 96_200_000, cacheWrite: 61_440 }), '2k');
  // A partially filled object still totals what it has; nothing at all is
  // `unknown`, never `0` — the same rule every other formatter here follows.
  assert.equal(formatTotal({ in: 5000 }), '5k');
  assert.equal(formatTotal(undefined), unknownWord());
  assert.equal(formatTotal({}), unknownWord());
  assert.equal(formatTotal({ cacheRead: 900_000 }), unknownWord());
});

test('basename copes with both separators, trailing slashes and roots', () => {
  assert.equal(basename('C:/proj/nazar'), 'nazar');
  assert.equal(basename('C:\\proj\\nazar'), 'nazar');
  assert.equal(basename('/home/x/dile/'), 'dile');
  assert.equal(basename('C:\\'), 'C:');
  assert.equal(basename('nazar'), 'nazar');
  assert.equal(basename(undefined), unknownWord());
  assert.equal(basename(''), unknownWord());
});

test('modelChip drops the provider prefix and keeps the rest verbatim', () => {
  assert.equal(modelChip('claude-opus-5[1m]'), 'opus-5[1m]');
  assert.equal(modelChip('claude-sonnet-5'), 'sonnet-5');
  assert.equal(modelChip('opus'), 'opus');
  assert.equal(modelChip(undefined), unknownWord());
});

test('the cache-read note is three words and says why the number is big', () => {
  // The hover card, the README and the tooltip must not drift apart; this is
  // the one place the sentence lives.
  assert.equal(cacheReadNote(), 'cumulative across requests');
});

/* ------------------------------------------------------------------ *
 * Folded trees (WP4c)
 * ------------------------------------------------------------------ */

const states = (running: number, done: number, unknown: number): { state: 'running' | 'done' | 'unknown' }[] => [
  ...Array.from({ length: running }, () => ({ state: 'running' as const })),
  ...Array.from({ length: done }, () => ({ state: 'done' as const })),
  ...Array.from({ length: unknown }, () => ({ state: 'unknown' as const })),
];

test('summarize counts a folded tree by state, and the parts add up', () => {
  const summary = summarize(states(3, 59, 0));
  assert.deepEqual(summary, { total: 62, running: 3, done: 59, unknown: 0 });
  assert.equal(summary.running + summary.done + summary.unknown, summary.total);
});

test('the folded chips are the line the maintainer asked for', () => {
  assert.deepEqual(summaryChips(summarize(states(3, 59, 0))), [
    '62 subagents',
    '3 running',
    '59 done',
  ]);
});

test('a zero group is left out, but the total is always shown', () => {
  assert.deepEqual(summaryChips(summarize(states(0, 0, 0))), ['0 subagents']);
  assert.deepEqual(summaryChips(summarize(states(1, 0, 0))), ['1 subagent', '1 running']);
  assert.deepEqual(summaryChips(summarize(states(0, 2, 1))), [
    '3 subagents',
    '2 done',
    '1 unknown',
  ]);
});

test('a folded count of a thousand is grouped, like every other count', () => {
  assert.deepEqual(summaryChips(summarize(states(1200, 0, 0))), [
    '1,200 subagents',
    '1,200 running',
  ]);
});

/* ------------------------------------------------------------------ *
 * WP3': cost and context window
 * ------------------------------------------------------------------ */

test('cost is money: two decimals, and nothing at all when there is no source', () => {
  assert.equal(formatCostUsd(9.60050075), '$9.60');
  assert.equal(formatCostUsd(0), '$0.00', 'zero spent is a measurement, and reads as one');
  assert.equal(formatCostUsd(1234.5), '$1234.50');
  // `undefined` in, `undefined` out: the caller draws no row rather than a row
  // saying `unknown` on every machine without the wrapper.
  assert.equal(formatCostUsd(undefined), undefined);
  assert.equal(formatCostUsd(Number.NaN), undefined);
  assert.equal(formatCostUsd(-1), undefined);
});

test('the context window shows the counts and the payload’s own percentage', () => {
  assert.equal(
    formatContextWindow({ used: 159_283, size: 1_000_000, percent: 16 }),
    '159,283 / 1,000,000 (16%)',
  );
  assert.equal(formatContextWindow({ used: 159_283, size: 1_000_000 }), '159,283 / 1,000,000');
  assert.equal(formatContextWindow({ percent: 16 }), '16%');
  assert.equal(formatContextWindow({ used: 42 }), '42 used');
  assert.equal(formatContextWindow({}), undefined);
  assert.equal(formatContextWindow(undefined), undefined);
});

test('the context percentage is floored, like every other percentage', () => {
  assert.equal(formatContextWindow({ percent: 99.9 }), '99%');
});

/* ------------------------------------------------------------------ *
 * N-WP17a: which machine a card is describing
 * ------------------------------------------------------------------ */

test('a host becomes @alias, and no host becomes no label at all', () => {
  assert.equal(hostLabel('box'), '@box');
  assert.equal(hostLabel(' build-box '), '@build-box');
  // Three ways of saying "this machine", and all three draw nothing rather
  // than an empty label.
  assert.equal(hostLabel(undefined), undefined);
  assert.equal(hostLabel(''), undefined);
  assert.equal(hostLabel('   '), undefined);
});

test('a long alias is cut, and the cut is visible', () => {
  const long = 'a'.repeat(MAX_HOST_LABEL + 10);
  const label = hostLabel(long) as string;
  assert.equal(label.length, MAX_HOST_LABEL + 1, 'the @ plus the cap');
  assert.ok(label.endsWith('…'));
  // Exactly at the cap is not cut: a truncated hostname is a different
  // hostname, so the ellipsis only appears when something was actually lost.
  const exact = 'a'.repeat(MAX_HOST_LABEL);
  assert.equal(hostLabel(exact), `@${exact}`);
});

test('the hover behind the label says which machine, and how long since it spoke', () => {
  assert.equal(hostTitle('box'), 'on box');
  // A remote card that goes quiet is not a session that ended, and the
  // difference is exactly the age of the last frame that arrived.
  assert.equal(hostTitle('box', 90_000), 'on box · last seen 1m 30s ago');
  // `formatAge` carries the locale's own word for "ago", so the sentence around
  // it must not add a second one.
  assert.equal((hostTitle('box', 90_000).match(/ago/g) ?? []).length, 1);
});
