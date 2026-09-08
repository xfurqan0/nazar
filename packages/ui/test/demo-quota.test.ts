/**
 * The synthetic quota behind `?demo=1&quota=...`, and the rule that keeps every
 * screenshot taken before WP5 reproducible: a demo canvas asked for no quota
 * source has **no quota at all**, and no cost or context window either, because
 * both come from the same wrapper.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import { makeDemoQuota } from '../src/demo-quota.ts';
import { makeDemoState } from '../src/demo.ts';
import { quotaItems } from '../src/quota-strip.ts';

const NOW = 1_788_756_000_000;

test('no quota asked for means no strip, no cost and no context window', () => {
  const state = makeDemoState({ now: NOW });
  assert.equal(state.quota, undefined);
  for (const session of state.sessions) {
    assert.equal(session.costUsd, undefined);
    assert.equal(session.contextWindow, undefined);
    assert.equal(session.capturedAt, undefined);
  }
});

test('asking for a source fills the strip and the two per-session fields', () => {
  const state = makeDemoState({ now: NOW, quota: 'limits' });
  assert.equal(state.quota?.source, 'limits.json');
  const withCost = state.sessions.filter((session) => session.costUsd !== undefined);
  assert.ok(withCost.length > 0, 'nazar-tray ships the wrapper, so captures exist too');
  assert.ok(
    state.sessions.some((session) => session.costUsd === undefined),
    'a session whose process stopped answering has no fresh capture, and must show that',
  );
});

test('the limits demo covers all four severities, including unknown', () => {
  const items = quotaItems(makeDemoQuota('limits', NOW), NOW);
  assert.deepEqual(
    new Set(items.map((item) => item.severity)),
    new Set(['ok', 'warn', 'critical', 'unknown']),
    'a screenshot that never shows the grey state does not prove the grey state works',
  );
  const unknown = items.find((item) => item.severity === 'unknown');
  assert.equal(unknown?.percentText, 'unknown');
  assert.equal(unknown?.barPercent, 0);
});

test('the limits demo covers both freshness treatments', () => {
  const items = quotaItems(makeDemoQuota('limits', NOW), NOW);
  const fresh = items.filter((item) => item.freshness === 'fresh');
  const stale = items.filter((item) => item.freshness === 'stale');
  assert.ok(fresh.length > 0 && stale.length > 0);
  assert.ok(stale.every((item) => item.ageText.length > 0), 'a stale reading says how old it is');
});

test('the limits demo shows what only nazar-tray can show', () => {
  const items = quotaItems(makeDemoQuota('limits', NOW), NOW);
  assert.ok(
    items.some((item) => item.provider === 'codex'),
    'Codex quota reaches the canvas through limits.json and nowhere else',
  );
  assert.ok(
    items.some((item) => item.detailed && item.label.includes('Fable')),
    'the model-scoped weekly is the whole reason limits.json beats a capture',
  );
});

test('the capture demo shows exactly what a status line can produce', () => {
  const quota = makeDemoQuota('captures', NOW);
  assert.equal(quota.source, 'statusline');
  assert.deepEqual(
    quota.providers.map((provider) => provider.name),
    ['claude'],
    'no Codex: a Claude status line knows nothing about it',
  );
  assert.deepEqual(
    quota.providers[0]?.windows.map((window) => window.key),
    ['five_hour', 'seven_day'],
  );
  assert.equal(quota.providers[0]?.plan, undefined, 'the payload carries no plan name');
});

test('every countdown is in the future, so a screenshot never shows "reset due"', () => {
  for (const source of ['limits', 'captures'] as const) {
    for (const item of quotaItems(makeDemoQuota(source, NOW), NOW)) {
      if (item.countdown.length === 0) continue;
      assert.notEqual(item.countdown, 'reset due', `${source}/${item.id}`);
    }
  }
});

test('the demo quota is a pure function of `now`, so two runs agree', () => {
  assert.deepEqual(makeDemoQuota('limits', NOW), makeDemoQuota('limits', NOW));
  assert.notDeepEqual(makeDemoQuota('limits', NOW), makeDemoQuota('limits', NOW + 1000));
});
