/**
 * The pure half of the history panel: grouping, absolute times, and the
 * adapter that lets the frozen tree reuse the live canvas renderer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { History, HistorySummary } from '@nazar/core';

import { makeDemoHistory, DEMO_HISTORY_EPOCH, DEMO_HISTORY_IDS } from '../src/demo-history.ts';
import '../test/catalogs.ts';
import { unknownWord } from '../src/format.ts';
import {
  formatBytes,
  formatDay,
  formatStamp,
  groupByProject,
  historySnapshot,
  shortSessionId,
} from '../src/history-view.ts';

function summary(project: string, sessionId: string, lastWriteAt: number): HistorySummary {
  return { sessionId, project, transcriptBytes: 1024, lastWriteAt, hydrated: false };
}

test('grouping keeps the listing order: projects by their newest session', () => {
  const groups = groupByProject([
    summary('beta', 's1', 900),
    summary('alpha', 's2', 800),
    summary('beta', 's3', 700),
    summary('alpha', 's4', 600),
  ]);

  assert.deepEqual(
    groups.map((group) => [group.project, group.sessions.map((one) => one.sessionId)]),
    [
      ['beta', ['s1', 's3']],
      ['alpha', ['s2', 's4']],
    ],
  );
});

test('grouping an empty listing is an empty list, not a group of nothing', () => {
  assert.deepEqual(groupByProject([]), []);
});

test('an absolute stamp is fixed-format, so two screenshots of one moment agree', () => {
  // Built from local parts, so the assertion is timezone-independent.
  const when = new Date(2026, 8, 6, 21, 46, 12);
  assert.equal(formatStamp(when.getTime()), '2026-09-06 21:46');
  assert.equal(formatDay(when.getTime()), '2026-09-06');

  const early = new Date(2026, 0, 2, 3, 4, 0);
  assert.equal(formatStamp(early.getTime()), '2026-01-02 03:04', 'every field is zero-padded');
});

test('an absent or nonsensical timestamp reads unknown, never as the epoch', () => {
  assert.equal(formatStamp(undefined), unknownWord());
  assert.equal(formatStamp(Number.NaN), unknownWord());
  assert.equal(formatStamp(Number.POSITIVE_INFINITY), unknownWord());
  assert.equal(formatDay(undefined), unknownWord());
});

test('sizes read at a glance and an absent one is unknown', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(6_412_800), '6.1 MB');
  assert.equal(formatBytes(undefined), unknownWord());
  assert.equal(formatBytes(-1), unknownWord());
});

test('a short session id is the head of the uuid', () => {
  assert.equal(shortSessionId('7f3a1c04-0000-4000-8000-0000000000a1'), '7f3a1c04');
  assert.equal(shortSessionId('nodashes'), 'nodashes');
  assert.equal(shortSessionId(''), '');
});

test('a History becomes the one-session snapshot the canvas renderer draws', async () => {
  const history = await makeDemoHistory().open(DEMO_HISTORY_IDS[0] as string);
  assert.ok(history !== undefined);

  const snapshot = historySnapshot(history);
  assert.equal(snapshot.sessions.length, 1);
  const session = snapshot.sessions[0];
  assert.ok(session !== undefined);

  assert.equal(session.id, history.sessionId);
  assert.equal(session.cwd, history.project, 'history knows a project by slug, not by cwd');
  assert.equal(session.agents.length, history.agentCount);
  assert.deepEqual(session.roots, history.roots);
  assert.deepEqual(session.tokens, history.tokens);
  assert.deepEqual(session.treeTokens, history.treeTokens);
  assert.equal(session.startedAt, history.firstWriteAt);
  assert.equal(session.transcriptAt, history.lastWriteAt);
  assert.equal(session.treeRead, true);

  // The clock is the session's own last write: a frozen canvas must not age.
  assert.equal(snapshot.generatedAt, history.lastWriteAt);
  assert.equal(snapshot.commandAvailable, false, 'no command answered for a session that ended');

  // Nothing in a frozen snapshot is running or waiting.
  assert.equal(session.waitingFor, undefined);
  assert.equal(session.currentTool, undefined);
  assert.deepEqual([...new Set(session.agents.map((agent) => agent.state))], ['done']);
});

test('the demo history hydrates a row only once it has been opened', async () => {
  const source = makeDemoHistory();
  const before = await source.list(50);
  assert.ok(before.sessions.length > 1);
  assert.deepEqual(
    [...new Set(before.sessions.map((one) => one.hydrated))],
    [false],
    'nothing has been read yet, so nothing may claim a token count',
  );
  assert.deepEqual(
    [...new Set(before.sessions.map((one) => one.tokens))],
    [undefined],
  );
  assert.equal(before.generatedAt, DEMO_HISTORY_EPOCH);

  await source.open(DEMO_HISTORY_IDS[0] as string);
  const after = await source.list(50);
  const row = after.sessions.find((one) => one.sessionId === DEMO_HISTORY_IDS[0]);
  assert.equal(row?.hydrated, true);
  assert.ok(row?.tokens !== undefined);
  assert.ok(row?.model !== undefined);
});

test('the demo history builds a real tree, with depth and finished agents', async () => {
  const history = (await makeDemoHistory().open(DEMO_HISTORY_IDS[0] as string)) as History;
  assert.equal(history.agentCount, 5);
  assert.deepEqual(history.agents.map((agent) => agent.spawnDepth), [1, 2, 3, 1, 2]);
  assert.equal(history.roots.length, 2, 'two depth-1 roots, each with its own subtree');
  for (const agent of history.agents) {
    assert.equal(agent.state, 'done');
    assert.ok((agent.durationMs ?? 0) > 0, 'a finished agent must be able to say how long it ran');
    assert.ok((agent.toolCalls ?? 0) > 0);
    assert.ok((agent.endedAt ?? 0) > (agent.startedAt ?? 0));
  }
  // The demo carries no account name: its home-relative project is pre-collapsed.
  assert.ok(!JSON.stringify(history).includes('Users'));
});

test('an unknown demo session is undefined, exactly as the real scanner answers', async () => {
  assert.equal(await makeDemoHistory().open('nope'), undefined);
});
