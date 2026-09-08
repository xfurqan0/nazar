/**
 * WP4e: the strip collapsed to one bead.
 *
 * Two things had to be decided that a row of six windows never had to: which
 * window the single bead is, and what the whole thing is called. Both are here.
 *
 * The first is the one with a way to be wrong: a bead showing the *emptiest*
 * window would be a green light on a machine that is out of quota, and a bead
 * that goes grey because one window has no reading would hide four that do.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import { quotaItems, type QuotaLike } from '../src/quota-strip.ts';
import {
  beadItem,
  readUsageOpen,
  usageBead,
  usageBeadOf,
  usageExplainer,
  USAGE_KEY,
  usageTitle,
  writeUsageOpen,
} from '../src/usage-popover.ts';
import { memoryStorage } from '../src/workspace.ts';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function quota(windows: ReadonlyArray<Record<string, unknown>>, binding?: string): QuotaLike {
  return {
    source: 'limits.json',
    providers: [
      {
        name: 'claude',
        configured: true,
        sourceAt: NOW - 60_000,
        ...(binding === undefined ? {} : { binding }),
        windows: windows.map((one) => ({ state: 'ok', ...one }) as never),
      },
    ],
  };
}

test('the bead shows the binding window, not the emptiest one', () => {
  const items = quotaItems(
    quota(
      [
        { key: 'five_hour', percent: 12, windowMinutes: 300 },
        { key: 'seven_day', percent: 88, windowMinutes: 10_080 },
      ],
      'seven_day',
    ),
    NOW,
  );
  const bead = usageBead(items);
  assert.ok(bead !== undefined);
  assert.equal(bead.percent, 88);
  assert.equal(bead.percentText, '88%');
  assert.equal(bead.severity, 'critical');
  assert.match(bead.label, /weekly/);
  assert.equal(bead.count, 2);
  assert.match(bead.description, new RegExp(usageTitle()));
});

test('with no binding window marked, the fullest one wins', () => {
  // An older tray, or a provider with one window and no verdict. A bead has to
  // be *some* window, and the one closest to being spent is the honest choice.
  const items = quotaItems(
    quota([
      { key: 'five_hour', percent: 12, windowMinutes: 300 },
      { key: 'seven_day', percent: 71, windowMinutes: 10_080 },
    ]),
    NOW,
  );
  assert.equal(usageBead(items)?.percent, 71);
});

test('a window with no reading cannot hide the ones that have one', () => {
  const items = quotaItems(
    quota([
      { key: 'five_hour', windowMinutes: 300 },
      { key: 'seven_day', percent: 44, windowMinutes: 10_080 },
    ]),
    NOW,
  );
  const bead = usageBead(items);
  assert.equal(bead?.percentText, '44%');
});

test('when nothing has a reading the bead is grey and says unknown', () => {
  const items = quotaItems(quota([{ key: 'five_hour', windowMinutes: 300 }]), NOW);
  const bead = usageBead(items);
  assert.ok(bead !== undefined);
  assert.equal(bead.percentText, 'unknown');
  assert.equal(bead.severity, 'unknown');
  // Never a reassuring empty bead: `0` means "you have used nothing" and this
  // is "I could not read it", which are opposite messages.
  assert.equal(bead.percent, 0);
  assert.match(bead.description, /unknown/);
});

test('no source at all is no bead, not an empty one', () => {
  assert.equal(usageBead([]), undefined);
  assert.equal(beadItem([]), undefined);
  assert.equal(usageBeadOf(undefined, NOW), undefined);
  // A provider that is present but not configured contributes nothing either.
  assert.equal(
    usageBeadOf({ source: 'limits.json', providers: [{ name: 'claude', configured: false, windows: [] }] }, NOW),
    undefined,
  );
});

test('the bead reads a whole quota document as well as a list of items', () => {
  const document = quota([{ key: 'five_hour', percent: 54, windowMinutes: 300 }]);
  assert.deepEqual(usageBeadOf(document, NOW), usageBead(quotaItems(document, NOW)));
});

test('open or closed is a mode and survives a reload; closed is the default', () => {
  const storage = memoryStorage();
  assert.equal(readUsageOpen(storage), false, 'the whole point of the change is that it starts closed');

  writeUsageOpen(storage, true);
  assert.equal(readUsageOpen(storage), true);
  writeUsageOpen(storage, false);
  assert.equal(readUsageOpen(storage), false);

  const raw = JSON.parse(storage.getItem(USAGE_KEY) ?? '{}') as Record<string, unknown>;
  assert.equal(raw['v'], 1);

  assert.equal(readUsageOpen(memoryStorage({ [USAGE_KEY]: 'not json' })), false);
  assert.equal(readUsageOpen(memoryStorage({ [USAGE_KEY]: '"open"' })), false);
});

test('the words say usage limits and explain what that means', () => {
  // The maintainer does not know the word "quota", and nobody outside this
  // repository is obliged to. The code keeps it; the person never sees it.
  assert.equal(usageTitle(), 'Usage limits');
  assert.equal(/quota/i.test(usageTitle()), false);
  assert.equal(/quota/i.test(usageExplainer()), false);
  assert.match(usageExplainer(), /5-hour/);
  assert.match(usageExplainer(), /weekly/);
  assert.match(usageExplainer(), /Claude/);
});
