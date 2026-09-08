/**
 * WP4b's `done` rule, held to the second.
 *
 * The three triggers are easy; the guard is the point. A monitor that calls a
 * thinking agent finished is worse than one that says `unknown`, so the tests
 * below spend most of their weight on what must *not* be `done`: a quiet
 * transcript before the window, a transcript that ends on a tool result, and a
 * transcript whose last assistant line still has a tool call open.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentDoneState, DEFAULT_RUNNING_WINDOW_MS, DONE_QUIET_MS } from '../src/agent-done.ts';
import { buildAgentTree } from '../src/agent-tree.ts';
import type { AgentMeta } from '../src/subagent-meta.ts';

const NOW = 1_788_800_000_000;

/** A closing assistant turn, written `ms` ago. Everything else neutral. */
function quiet(ms: number): Parameters<typeof agentDoneState>[0] {
  return {
    lastLineType: 'assistant',
    pendingToolUse: false,
    lastWriteAt: NOW - ms,
    lastEventAt: NOW - ms,
    now: NOW,
  };
}

test('(a) the parent tool result ends an agent immediately, with no quiet window', () => {
  const verdict = agentDoneState({
    hasParentResult: true,
    lastLineType: 'assistant',
    pendingToolUse: true,
    lastWriteAt: NOW - 200,
    lastEventAt: NOW - 200,
    now: NOW,
  });
  assert.equal(verdict.state, 'done');
  assert.equal(verdict.signal, 'parent-result');
  assert.equal(verdict.endedAt, NOW - 200);
});

test('(b) a closing assistant turn is done only once the guard window has passed', () => {
  // One millisecond short of the window: still unknown, never done.
  const just = agentDoneState(quiet(DONE_QUIET_MS - 1));
  assert.equal(just.state, 'unknown');
  assert.equal(just.signal, undefined);

  const exactly = agentDoneState(quiet(DONE_QUIET_MS));
  assert.equal(exactly.state, 'done');
  assert.equal(exactly.signal, 'quiet-turn');
  assert.equal(exactly.endedAt, NOW - DONE_QUIET_MS);

  const later = agentDoneState(quiet(DONE_QUIET_MS * 40));
  assert.equal(later.state, 'done');
});

test('(b) silence alone is not done: 59 seconds of nothing is unknown', () => {
  for (const ms of [0, 1000, 29_000, 30_000, 45_000, 59_999]) {
    const verdict = agentDoneState(quiet(ms));
    assert.notEqual(verdict.state, 'done', `${ms} ms of quiet must not read as done`);
  }
});

test('(b) a transcript ending on a tool result is never done from quiet alone', () => {
  const verdict = agentDoneState({
    lastLineType: 'user',
    pendingToolUse: false,
    lastWriteAt: NOW - DONE_QUIET_MS * 10,
    now: NOW,
  });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.signal, undefined);
});

test('(b) an unanswered tool call keeps an agent open however long it is quiet', () => {
  const verdict = agentDoneState({
    lastLineType: 'assistant',
    pendingToolUse: true,
    lastWriteAt: NOW - DONE_QUIET_MS * 10,
    now: NOW,
  });
  assert.equal(verdict.state, 'unknown');
});

test('(c) a gone session ends every agent under it, whatever the last line says', () => {
  const verdict = agentDoneState({
    sessionGone: true,
    lastLineType: 'user',
    pendingToolUse: true,
    lastWriteAt: NOW - 500,
    lastEventAt: NOW - 700,
    now: NOW,
  });
  assert.equal(verdict.state, 'done');
  assert.equal(verdict.signal, 'session-gone');
  assert.equal(verdict.endedAt, NOW - 700, 'the transcript timestamp beats the file mtime');
});

test('the parent result outranks a gone session, so the reason shown is the real one', () => {
  const verdict = agentDoneState({
    hasParentResult: true,
    sessionGone: true,
    lastWriteAt: NOW - 500,
    now: NOW,
  });
  assert.equal(verdict.signal, 'parent-result');
});

test('a warm transcript with no signal is running, a cold one is unknown', () => {
  const warm = agentDoneState({
    lastLineType: 'user',
    lastWriteAt: NOW - DEFAULT_RUNNING_WINDOW_MS,
    now: NOW,
  });
  assert.equal(warm.state, 'running');

  const cold = agentDoneState({
    lastLineType: 'user',
    lastWriteAt: NOW - DEFAULT_RUNNING_WINDOW_MS - 1,
    now: NOW,
  });
  assert.equal(cold.state, 'unknown');
});

test('an agent with no transcript at all is unknown, not done and not running', () => {
  assert.equal(agentDoneState({ now: NOW }).state, 'unknown');
  assert.equal(agentDoneState({ now: NOW }).endedAt, undefined);
});

test('a clock that ran backwards does not produce a negative age or a done agent', () => {
  const verdict = agentDoneState({
    lastLineType: 'assistant',
    pendingToolUse: false,
    lastWriteAt: NOW + 60_000,
    now: NOW,
  });
  assert.equal(verdict.state, 'running', 'a future write is age zero, which is warm');
});

/* ------------------------------------------------------------------ *
 * The same three rules, through the tree builder the canvas draws
 * ------------------------------------------------------------------ */

function meta(id: string, parentAgentId?: string): AgentMeta {
  return parentAgentId === undefined
    ? { id, agentType: 'general-purpose', spawnDepth: 1 }
    : { id, agentType: 'Explore', spawnDepth: 2, parentAgentId };
}

test('the tree marks an agent done when its parent wrote the tool result', () => {
  const tree = buildAgentTree({
    sessionId: 's',
    metas: [meta('a1'), meta('a2')],
    activity: new Map([
      ['a1', { lastWriteAt: NOW - 1000, lastEventAt: NOW - 1200, lastLineType: 'user' as const }],
      ['a2', { lastWriteAt: NOW - 1000, lastEventAt: NOW - 1100, lastLineType: 'user' as const }],
    ]),
    bridges: new Map([['a1', { modelId: 'claude-opus-5[1m]', completed: true }]]),
    now: NOW,
  });

  const byId = new Map(tree.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get('a1')?.state, 'done');
  assert.equal(byId.get('a1')?.doneSignal, 'parent-result');
  assert.equal(byId.get('a1')?.endedAt, NOW - 1200);
  assert.equal(byId.get('a2')?.state, 'running');
  assert.equal(byId.get('a2')?.doneSignal, undefined);
  assert.equal(byId.get('a2')?.endedAt, undefined, 'endedAt belongs to done agents alone');
});

test('an asynchronous launch bridge does not end a subagent that is still writing', () => {
  // The bug this test exists for, caught against live data: on Claude Code
  // 2.1.263 the `Agent` tool returns at launch, so a bridge exists from the
  // first second of a run. Reading it as an ending marked a subagent that had
  // written 124 ms ago as finished. A launch bridge still carries the model id.
  const tree = buildAgentTree({
    sessionId: 's',
    metas: [meta('a1')],
    activity: new Map([
      ['a1', { lastWriteAt: NOW - 124, lastEventAt: NOW - 200, lastLineType: 'user' as const }],
    ]),
    bridges: new Map([
      ['a1', { modelId: 'claude-opus-5[1m]', completed: false, status: 'async_launched' }],
    ]),
    now: NOW,
  });
  const agent = tree.agents[0];
  assert.equal(agent?.state, 'running');
  assert.equal(agent?.doneSignal, undefined);
  assert.equal(agent?.modelId, 'claude-opus-5[1m]', 'the bridge is still the model-id source');
});

test('the tree fades every agent when the session is gone', () => {
  const tree = buildAgentTree({
    sessionId: 's',
    metas: [meta('a1'), meta('a2', 'a1')],
    activity: new Map([['a1', { lastWriteAt: NOW - 500, lastLineType: 'user' as const }]]),
    now: NOW,
    sessionGone: true,
  });
  assert.deepEqual(
    tree.agents.map((agent) => [agent.state, agent.doneSignal]),
    [
      ['done', 'session-gone'],
      ['done', 'session-gone'],
    ],
  );
});

test('a done agent carries a duration, from the tool result when there is one', () => {
  const tree = buildAgentTree({
    sessionId: 's',
    metas: [meta('a1'), meta('a2')],
    activity: new Map([
      [
        'a1',
        { startedAt: NOW - 900_000, lastEventAt: NOW - 180_000, lastWriteAt: NOW - 180_000 },
      ],
      [
        'a2',
        {
          startedAt: NOW - 900_000,
          lastEventAt: NOW - 180_000,
          lastWriteAt: NOW - 180_000,
          lastLineType: 'assistant' as const,
          pendingToolUse: false,
        },
      ],
    ]),
    bridges: new Map([['a1', { durationMs: 723_000, completed: true }]]),
    now: NOW,
  });
  const byId = new Map(tree.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get('a1')?.durationMs, 723_000, "the tool's own measurement wins");
  assert.equal(byId.get('a2')?.durationMs, 720_000, 'otherwise first line to last');
  assert.equal(byId.get('a2')?.doneSignal, 'quiet-turn');
});

test('the guard window is configurable, and shortening it does not change the order', () => {
  const options = {
    sessionId: 's',
    metas: [meta('a1')],
    activity: new Map([
      [
        'a1',
        {
          // Past the running window, inside the default guard window.
          lastWriteAt: NOW - 40_000,
          lastEventAt: NOW - 40_000,
          lastLineType: 'assistant' as const,
          pendingToolUse: false,
        },
      ],
    ]),
    now: NOW,
  };
  assert.equal(buildAgentTree(options).agents[0]?.state, 'unknown');
  assert.equal(buildAgentTree({ ...options, quietMs: 1000 }).agents[0]?.state, 'done');
});
