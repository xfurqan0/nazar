/**
 * N-WP21: the pure half of the Needs-you strip.
 *
 * Everything here is a *transition* rather than a reading, which is what makes
 * it worth testing at an instant of the caller's choosing: how long a session
 * has been waiting is not in any file — it is the difference between the first
 * frame that saw the wait and now — and "finished while you were away" is not a
 * state either, it is a session that was working on the previous frame and is
 * not on this one.
 *
 * So every test below runs the reducer over two or three frames with the clock
 * in its hand. A single-frame test would pass on a module that had no memory at
 * all, which is precisely the module this one must not be.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import './catalogs.ts';
import type { NeedsYouSession, NeedsYouState } from '../src/needs-you.js';
import {
  FINISHED_WINDOW_MS,
  NO_NEEDS_YOU,
  finishedRows,
  needsYouAnnouncement,
  needsYouBadge,
  needsYouEmpty,
  observeSessions,
  waitingForLabel,
  waitingRows,
} from '../src/needs-you.js';
import { isWaiting } from '../src/activity.js';

const NOW = 1_788_000_000_000;

type Seed = Partial<NeedsYouSession> & { readonly id: string };

/** A live session, alive and idle, with whatever the test wants on top. */
function session(seed: Seed): NeedsYouSession {
  return {
    cwd: `C:\\proj\\${seed.id}`,
    status: 'idle',
    state: 'alive',
    agents: [],
    ...seed,
  };
}

/** A session with a question outstanding. */
function waiting(id: string, waitingFor: string): NeedsYouSession {
  return session({ id, status: 'waiting', waitingFor });
}

/** A session that is working. */
function busy(id: string): NeedsYouSession {
  return session({ id, status: 'busy' });
}

/* ------------------------------------------------------------------ *
 * One definition of waiting
 * ------------------------------------------------------------------ */

test('waiting is one predicate, and either source alone is enough', () => {
  // The whole reason `isWaiting` moved into `activity.ts`: the frame, the ring,
  // the banner and this strip have to agree, and two copies of one line agree
  // only until somebody edits one of them.
  assert.equal(isWaiting({ status: 'waiting' }), true);
  assert.equal(isWaiting({ status: 'busy', waitingFor: 'permission prompt' }), true);
  assert.equal(isWaiting({ status: 'idle' }), false);
  assert.equal(isWaiting({ status: 'unknown' }), false);
});

test('the four documented waiting reasons are translated, and a fifth is not hidden', () => {
  assert.equal(waitingForLabel('permission prompt'), 'permission prompt');
  assert.equal(waitingForLabel('input needed'), 'input needed');
  assert.equal(waitingForLabel('sandbox request'), 'sandbox request');
  assert.equal(waitingForLabel('dialog open'), 'dialog open');
  // A value from a later Claude Code is shown as it arrived: the raw words are
  // still more use than `unknown`, and hiding them would hide the news.
  assert.equal(waitingForLabel('quantum entanglement'), 'quantum entanglement');
  assert.equal(waitingForLabel(undefined), 'unknown');
  assert.equal(waitingForLabel(''), 'unknown');
});

/* ------------------------------------------------------------------ *
 * The badge and the order
 * ------------------------------------------------------------------ */

test('two waiting and one working: the badge counts two, longest first', () => {
  const sessions = [waiting('a', 'permission prompt'), busy('b'), waiting('c', 'input needed')];

  // `a` and `c` start waiting at the same instant, then `a` alone is still
  // waiting nine minutes later — so on the third frame `a` is the older wait.
  let memory = observeSessions(NO_NEEDS_YOU, [sessions[0]!, sessions[1]!], NOW);
  memory = observeSessions(memory, sessions, NOW + 9 * 60_000);
  const rows = waitingRows(memory, sessions, NOW + 10 * 60_000);

  assert.deepEqual(
    rows.map((row) => row.id),
    ['a', 'c'],
    'the longest wait is not at the top',
  );
  assert.equal(rows[0]?.waited, '10m 00s');
  assert.equal(rows[1]?.waited, '1m 00s');
  assert.equal(rows[0]?.what, 'permission prompt');
  assert.equal(rows[0]?.label, 'a', 'the card title is the folder basename by default');
  assert.equal(rows[0]?.folder, 'C:\\proj\\a');

  const badge = needsYouBadge(rows);
  assert.equal(badge?.count, 2);
  assert.equal(badge?.label, 'Needs you · 2');
  assert.equal(badge?.longest, '10m 00s', 'the badge shows the longest wait, not the newest');
  assert.match(badge?.description ?? '', /2 sessions are waiting for you/);
});

test('a card that has been named is listed by its name', () => {
  const sessions = [waiting('a', 'permission prompt')];
  const memory = observeSessions(NO_NEEDS_YOU, sessions, NOW);
  const rows = waitingRows(memory, sessions, NOW, { a: 'release build' });
  assert.equal(rows[0]?.label, 'release build');
  assert.match(rows[0]?.description ?? '', /^release build in C:\\proj\\a — waiting for/);
});

test('a wait keeps its start across frames, and changing what it waits for resets it', () => {
  let memory = observeSessions(NO_NEEDS_YOU, [waiting('a', 'permission prompt')], NOW);
  memory = observeSessions(memory, [waiting('a', 'permission prompt')], NOW + 60_000);
  assert.equal(
    waitingRows(memory, [waiting('a', 'permission prompt')], NOW + 60_000)[0]?.waited,
    '1m 00s',
    'the same question was re-dated by a later frame',
  );

  // A permission prompt answered, and an input request straight after it, is a
  // *new* question: the number on the row is how long this one has gone
  // unanswered, not how long that terminal has been unattended.
  memory = observeSessions(memory, [waiting('a', 'input needed')], NOW + 60_000);
  const rows = waitingRows(memory, [waiting('a', 'input needed')], NOW + 60_000);
  assert.equal(rows[0]?.waited, '0s');
  assert.equal(rows[0]?.what, 'input needed');
});

test('a session that stops waiting and waits again starts a new clock', () => {
  let memory = observeSessions(NO_NEEDS_YOU, [waiting('a', 'permission prompt')], NOW);
  memory = observeSessions(memory, [busy('a')], NOW + 60_000);
  memory = observeSessions(memory, [waiting('a', 'permission prompt')], NOW + 120_000);
  const rows = waitingRows(memory, [waiting('a', 'permission prompt')], NOW + 150_000);
  assert.equal(rows[0]?.waited, '30s');
});

test('nobody waiting: no badge, and the announcement says so', () => {
  const memory = observeSessions(NO_NEEDS_YOU, [busy('a'), session({ id: 'b' })], NOW);
  const rows = waitingRows(memory, [busy('a'), session({ id: 'b' })], NOW);
  assert.deepEqual([...rows], []);
  assert.equal(needsYouBadge(rows), undefined, 'there is no Needs you · 0');
  assert.equal(needsYouAnnouncement(rows), 'Nobody is waiting for you.');
});

test('the announcement counts, so a change of number is heard and not only seen', () => {
  const sessions = [waiting('a', 'permission prompt')];
  const memory = observeSessions(NO_NEEDS_YOU, sessions, NOW);
  assert.equal(
    needsYouAnnouncement(waitingRows(memory, sessions, NOW)),
    '1 session is waiting for you',
  );
});

test('an empty panel says how old the reading behind it is', () => {
  assert.equal(
    needsYouEmpty(NOW - 12_000, NOW),
    'Nobody is waiting for you. Last read 12s ago.',
  );
  // No snapshot at all is the first frame, and there is nothing honest to say
  // about its age.
  assert.equal(needsYouEmpty(undefined, NOW), 'Nobody is waiting for you.');
});

/* ------------------------------------------------------------------ *
 * Finished while you were away
 * ------------------------------------------------------------------ */

/** Run the reducer over a sequence of frames, one entry per frame. */
function replay(frames: readonly { sessions: readonly NeedsYouSession[]; at: number }[]): NeedsYouState {
  let memory = NO_NEEDS_YOU;
  for (const frame of frames) memory = observeSessions(memory, frame.sessions, frame.at);
  return memory;
}

test('a session that was working and is now idle enters the finished cluster', () => {
  // The last transcript write is five minutes old: inside thirty seconds it
  // would still read as *working*, which is `activityOf`'s rule and not this
  // module's, and is why a run joins the cluster half a minute after it stops
  // rather than the instant it does.
  const done = session({
    id: 'a',
    startedAt: NOW - 600_000,
    transcriptAt: NOW - 300_000,
    costUsd: 9.6005,
    treeTokens: { in: 12_043, out: 3_120 },
  });
  const memory = replay([
    { sessions: [busy('a')], at: NOW },
    { sessions: [done], at: NOW + 1_000 },
  ]);

  const rows = finishedRows(memory, [done], NOW + 61_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 'a');
  assert.equal(rows[0]?.ranFor, 'ran 5m 00s');
  assert.equal(rows[0]?.tokens, '12,043 in · 3,120 out');
  assert.equal(rows[0]?.cost, '$9.60', 'the cost rounds to the cent, as it does everywhere');
  assert.equal(rows[0]?.ago, '1m 00s ago');
});

test('a session that was already idle on the first frame is not news', () => {
  // The transition is the whole signal. Without it, opening the canvas onto
  // four idle sessions would announce all four as having just finished.
  const memory = replay([
    { sessions: [session({ id: 'a' })], at: NOW },
    { sessions: [session({ id: 'a' })], at: NOW + 1_000 },
  ]);
  assert.deepEqual([...finishedRows(memory, [session({ id: 'a' })], NOW + 1_000)], []);
});

test('a session with a subagent still running has not finished', () => {
  const half = session({ id: 'a', agents: [{ state: 'running' }, { state: 'done' }] });
  const memory = replay([
    { sessions: [busy('a')], at: NOW },
    { sessions: [half], at: NOW + 1_000 },
  ]);
  assert.deepEqual([...finishedRows(memory, [half], NOW + 1_000)], []);

  // And it does enter once that child ends.
  const whole = session({ id: 'a', agents: [{ state: 'done' }, { state: 'done' }] });
  const later = observeSessions(memory, [whole], NOW + 2_000);
  assert.equal(finishedRows(later, [whole], NOW + 2_000).length, 1);
});

test('a session that goes busy again leaves the cluster', () => {
  const memory = replay([
    { sessions: [busy('a')], at: NOW },
    { sessions: [session({ id: 'a' })], at: NOW + 1_000 },
    { sessions: [busy('a')], at: NOW + 2_000 },
  ]);
  assert.deepEqual([...finishedRows(memory, [busy('a')], NOW + 2_000)], []);
});

test('the cluster empties itself after the window, and forgets a session that is gone', () => {
  const done = session({ id: 'a' });
  const settled = replay([
    { sessions: [busy('a')], at: NOW },
    { sessions: [done], at: NOW + 1_000 },
  ]);
  assert.equal(finishedRows(settled, [done], NOW + 1_000).length, 1);

  const expired = observeSessions(settled, [done], NOW + 1_000 + FINISHED_WINDOW_MS + 1);
  assert.deepEqual([...finishedRows(expired, [done], NOW)], [], 'the window did not close');

  // A session the machine no longer lists has no card to be taken to, so the
  // row would be a button that goes nowhere.
  const vanished = observeSessions(settled, [], NOW + 2_000);
  assert.deepEqual([...finishedRows(vanished, [], NOW + 2_000)], []);
});

test('the cluster is newest first, and a run with no source for a number drops it', () => {
  const a = session({ id: 'a' });
  const b = session({ id: 'b' });
  const memory = replay([
    { sessions: [busy('a'), busy('b')], at: NOW },
    { sessions: [a, busy('b')], at: NOW + 1_000 },
    { sessions: [a, b], at: NOW + 2_000 },
  ]);
  const rows = finishedRows(memory, [a, b], NOW + 3_000);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['b', 'a'],
  );
  // Neither has a capture and neither has both transcript timestamps, so all
  // three optional fields are absent rather than drawn as `unknown` or `0`.
  assert.equal(rows[0]?.ranFor, undefined);
  assert.equal(rows[0]?.tokens, undefined);
  assert.equal(rows[0]?.cost, undefined);
});

test('nothing here infers: a silent session is never called stuck', () => {
  /*
   * The one thing this package deliberately does not do. A session that is
   * `idle`, alive, and has written nothing for an hour is a session somebody
   * left open — it is not waiting, it did not just finish, and no amount of
   * silence turns either of those into a fact. README "Known limits" carries
   * the same sentence, because the absence is a decision.
   */
  const quiet = session({ id: 'a', transcriptAt: NOW - 3_600_000 });
  const memory = replay([
    { sessions: [quiet], at: NOW },
    { sessions: [quiet], at: NOW + 3_600_000 },
  ]);
  assert.deepEqual([...waitingRows(memory, [quiet], NOW + 3_600_000)], []);
  assert.deepEqual([...finishedRows(memory, [quiet], NOW + 3_600_000)], []);
});

test('the memory does not grow: it holds only what is on the machine now', () => {
  let memory = NO_NEEDS_YOU;
  for (let index = 0; index < 50; index += 1) {
    memory = observeSessions(memory, [waiting(`s${String(index)}`, 'permission prompt')], NOW + index);
  }
  assert.equal(memory.waiting.size, 1, 'a wait outlived the session it belonged to');
  assert.equal(memory.active.size, 1);
  assert.equal(memory.finished.size, 0);
});
