/**
 * WP5: which source the strip is drawn from.
 *
 * One rule, three cases, and the one that matters is the middle one: a machine
 * with nazar-tray *and* the wrapper has two readings of the same two windows,
 * taken seconds apart, and drawing both would put two different numbers for one
 * quantity on one strip.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { CaptureScan, StatuslineCapture } from '../src/statusline-captures.ts';
import type { LimitsScan } from '../src/limits-file.ts';
import { quotaFromCapture, selectQuota, windowCount } from '../src/quota.ts';

const NOW = 1_788_756_000_000;

function captures(...list: StatuslineCapture[]): CaptureScan {
  return {
    configured: true,
    captures: new Map(list.map((capture) => [capture.sessionId, capture])),
    warnings: 0,
  };
}

const NO_CAPTURES: CaptureScan = { configured: false, captures: new Map(), warnings: 0 };
const NO_LIMITS: LimitsScan = { configured: false };

function limitsWith(percent: number): LimitsScan {
  return {
    configured: true,
    fileAt: NOW,
    document: {
      schemaVersion: 1,
      updatedAt: NOW - 1000,
      providers: [
        {
          name: 'claude',
          configured: true,
          source: 'endpoint',
          sourceAt: NOW - 2000,
          binding: 'seven_day',
          windows: [{ key: 'seven_day', state: 'ok', percent, windowMinutes: 10_080 }],
        },
      ],
    },
  };
}

test('nothing installed means no strip at all', () => {
  assert.equal(selectQuota(NO_LIMITS, NO_CAPTURES), undefined);
});

test('a capture alone gives the two windows the status line can see', () => {
  const quota = selectQuota(
    NO_LIMITS,
    captures({
      sessionId: 'a',
      capturedAt: NOW - 4000,
      rateLimits: {
        five_hour: { percent: 12, resetsAt: NOW + 3_600_000 },
        seven_day: { percent: 31, resetsAt: NOW + 86_400_000 },
      },
    }),
  );
  assert.ok(quota !== undefined);
  assert.equal(quota.source, 'statusline');
  assert.equal(quota.providers.length, 1);
  assert.deepEqual(
    quota.providers[0]?.windows.map((window) => window.key),
    ['five_hour', 'seven_day'],
  );
  assert.equal(quota.providers[0]?.binding, 'seven_day');
  assert.equal(quota.providers[0]?.plan, undefined, 'the payload carries no plan name');
  assert.equal(quota.providers[0]?.windows[0]?.windowMinutes, 300);
});

test('limits.json wins over a capture, and is never merged with it', () => {
  const quota = selectQuota(
    limitsWith(18),
    captures({
      sessionId: 'a',
      capturedAt: NOW,
      rateLimits: { seven_day: { percent: 99 }, five_hour: { percent: 44 } },
    }),
  );
  assert.ok(quota !== undefined);
  assert.equal(quota.source, 'limits.json');
  assert.equal(windowCount(quota.providers), 1, 'the capture contributed nothing, not even a window');
  assert.equal(quota.providers[0]?.windows[0]?.percent, 18);
});

test('a limits file that describes nothing does not hide a capture that does', () => {
  const empty: LimitsScan = {
    configured: true,
    document: {
      schemaVersion: 1,
      providers: [{ name: 'claude', configured: false, windows: [] }],
    },
  };
  const quota = selectQuota(
    empty,
    captures({ sessionId: 'a', capturedAt: NOW, rateLimits: { seven_day: { percent: 7 } } }),
  );
  assert.equal(quota?.source, 'statusline');
});

test('the newest capture is the one that speaks for the account', () => {
  const quota = selectQuota(
    NO_LIMITS,
    captures(
      { sessionId: 'old', capturedAt: NOW - 60_000, rateLimits: { seven_day: { percent: 10 } } },
      { sessionId: 'new', capturedAt: NOW - 1_000, rateLimits: { seven_day: { percent: 14 } } },
    ),
  );
  assert.equal(quota?.providers[0]?.windows[0]?.percent, 14);
});

test('a capture with no rate limits is not a quota source', () => {
  assert.equal(
    selectQuota(NO_LIMITS, captures({ sessionId: 'a', capturedAt: NOW, costUsd: 4 })),
    undefined,
  );
  assert.equal(quotaFromCapture({ sessionId: 'a' }), undefined);
});

test('spend_limit is captured but not drawn: it is not a usage window', () => {
  const quota = quotaFromCapture({
    sessionId: 'a',
    capturedAt: NOW,
    rateLimits: { five_hour: { percent: 3 }, spend_limit: { percent: 90 } },
  });
  assert.deepEqual(
    quota?.providers[0]?.windows.map((window) => window.key),
    ['five_hour'],
  );
});
