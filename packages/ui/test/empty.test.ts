/**
 * N-WP20: the sentences an empty canvas shows.
 *
 * The server's half is asserted in `packages/core/test/state.test.ts`, against
 * a real sessions directory: three arrangements of disk, three verdicts. This
 * is the other half — the verdict turned into the two lines a person reads —
 * and the property that matters is that the three are *different*. A mapping
 * that compiled but answered the same sentence for all three would leave the
 * bug exactly where it was while every test still passed.
 *
 * Driven with a diagnosis in each of the six languages, because a catalogue
 * that only has the English text is a page that quietly speaks English to
 * somebody who asked for Korean.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import './catalogs.ts';
import type { EmptyDiagnosis, EmptyReason } from '@nazar/core';

import { emptyStateLines } from '../src/empty.ts';
import { FALLBACK_LOCALE, LOCALES, currentLocale, setLocale } from '../src/i18n.ts';

const REASONS: readonly EmptyReason[] = ['noConfigDir', 'noSessions', 'staleSessions'];

function diagnosis(reason: EmptyReason, over: Partial<EmptyDiagnosis> = {}): EmptyDiagnosis {
  return { reason, agentsOk: true, sessionFiles: 0, wrapper: true, ...over };
}

test('N-WP20: the three empty canvases get three different answers', () => {
  const whys = new Set<string>();
  const nexts = new Set<string>();

  for (const reason of REASONS) {
    const lines = emptyStateLines(diagnosis(reason));
    assert.ok(lines.why.length > 0, `${reason} has no reason line`);
    assert.ok(lines.next.length > 0, `${reason} has no next step`);
    assert.notEqual(lines.why, lines.next, `${reason} repeats itself`);
    whys.add(lines.why);
    nexts.add(lines.next);
  }

  assert.equal(whys.size, 3, 'two empties are being explained the same way');
  assert.equal(nexts.size, 3, 'two empties are being given the same advice');
});

test('N-WP20: the advice actually fits the reason it is given for', () => {
  setLocale(FALLBACK_LOCALE);

  // The old page told everybody to start `claude`. That is right for exactly
  // one of the three, and these are the two it was wrong for.
  const moved = emptyStateLines(diagnosis('noConfigDir'));
  assert.match(moved.next, /CLAUDE_CONFIG_DIR/, 'a moved config dir is not fixed by a terminal');

  const stale = emptyStateLines(diagnosis('staleSessions'));
  assert.match(stale.why, /no process/, 'stale files are explained as ended sessions');

  const none = emptyStateLines(diagnosis('noSessions'));
  assert.match(none.next, /terminal/, 'and the one case where starting a session is the answer');
});

test('N-WP20: every reason has a full set of words in all six languages', () => {
  for (const locale of LOCALES) {
    // `setLocale` answers false for a language already in force, so the check
    // is where it landed, not what it returned.
    setLocale(locale);
    assert.equal(currentLocale(), locale, `${locale} did not install`);
    for (const reason of REASONS) {
      const lines = emptyStateLines(diagnosis(reason));
      // An untranslated key falls through as the key itself, which is exactly
      // what a reader of that language would see on the page.
      assert.ok(!lines.why.startsWith('empty.'), `${locale} has no reason for ${reason}`);
      assert.ok(!lines.next.startsWith('empty.'), `${locale} has no next step for ${reason}`);
    }
  }
  setLocale(FALLBACK_LOCALE);
});

test('N-WP20: the notes appear only when true, and never as the reason', () => {
  setLocale(FALLBACK_LOCALE);

  const healthy = emptyStateLines(diagnosis('noSessions'));
  assert.deepEqual(healthy.notes, [], 'a machine with nothing else wrong says nothing else');

  const noAgents = emptyStateLines(diagnosis('noSessions', { agentsOk: false }));
  assert.equal(noAgents.notes.length, 1);
  assert.match(noAgents.notes[0] ?? '', /claude agents/);
  assert.equal(noAgents.why, healthy.why, 'the reason did not change because a note appeared');

  const noWrapper = emptyStateLines(diagnosis('noSessions', { wrapper: false }));
  assert.equal(noWrapper.notes.length, 1);
  assert.notEqual(noWrapper.notes[0], noAgents.notes[0], 'the two notes are different sentences');

  const both = emptyStateLines(
    diagnosis('staleSessions', { agentsOk: false, wrapper: false, sessionFiles: 3 }),
  );
  assert.equal(both.notes.length, 2, 'both are reported when both are true');
  assert.equal(both.why, emptyStateLines(diagnosis('staleSessions')).why);
});
