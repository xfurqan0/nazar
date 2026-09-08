/**
 * The demo canvas backs the screenshots and the frame-rate check, so it has to
 * stay both *deterministic* and *representative*. Representative means: the
 * states that are easy to render wrongly are present — a session waiting for a
 * permission prompt, a process whose liveness is unknown, a finished subagent,
 * a subagent with no transcript at all, an orphan, and — since WP4d made the
 * two tell each other apart — a session that is alive and *not* working.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import { agentActivity, sessionActivity } from '../src/activity.ts';
import { forestOf, makeDemoState } from '../src/demo.ts';

const NOW = 1_788_756_000_000;

test('the default canvas is four sessions and fourteen subagents', () => {
  const state = makeDemoState({ now: NOW });
  assert.equal(state.sessions.length, 4);
  assert.equal(
    state.sessions.reduce((sum, session) => sum + session.agents.length, 0),
    14,
  );
  assert.equal(state.generatedAt, NOW);
});

test('the same options give the same canvas, byte for byte', () => {
  const options = { now: NOW, sessions: 3, agentsPerSession: 6 };
  assert.equal(JSON.stringify(makeDemoState(options)), JSON.stringify(makeDemoState(options)));
});

test('it covers the states that are easy to get wrong', () => {
  const state = makeDemoState({ now: NOW });
  const agents = state.sessions.flatMap((session) => session.agents);

  assert.ok(
    state.sessions.some((session) => session.status === 'waiting' && session.waitingFor !== undefined),
    'a session waiting for the user',
  );
  assert.ok(state.sessions.some((session) => session.state === 'unknown'), 'an unknown process');
  assert.ok(
    state.sessions.some((session) => session.status === 'busy' && session.state === 'alive'),
    'a session that is working',
  );
  assert.ok(agents.some((agent) => agent.state === 'done'), 'a finished subagent');
  assert.ok(agents.some((agent) => agent.state === 'unknown'), 'a subagent with no transcript');
  assert.ok(agents.some((agent) => agent.orphan === true), 'an orphan');
  assert.ok(agents.some((agent) => agent.spawnDepth === 3), 'depth 3');

  const blank = agents.find((agent) => agent.tokens === undefined);
  assert.ok(blank !== undefined, 'an agent whose counters are absent rather than zero');
  assert.equal(blank.currentTool, undefined);
});

/**
 * The screenshot in `docs/screenshots/wp4d-activity-*.png` is only worth
 * taking if the canvas behind it actually contains all four frames. It is
 * built from this generator, so this is where that is guaranteed.
 */
test('the demo canvas draws every activity frame at once', () => {
  const state = makeDemoState({ now: NOW });
  const sessions = state.sessions.map((session) => sessionActivity(session, NOW));
  const agents = state.sessions
    .flatMap((session) => session.agents)
    .map((agent) => agentActivity(agent, NOW));

  for (const wanted of ['working', 'idle', 'waiting', 'unknown'] as const) {
    assert.ok(sessions.includes(wanted), `no ${wanted} session on the demo canvas`);
  }
  for (const wanted of ['working', 'done', 'unknown'] as const) {
    assert.ok(agents.includes(wanted), `no ${wanted} subagent on the demo canvas`);
  }
  // An idle session is idle because it has been quiet, not because it has no
  // transcript: the 30 s window has to be *passed*, not dodged.
  const idle = state.sessions.find((session) => sessionActivity(session, NOW) === 'idle');
  assert.ok(idle !== undefined);
  assert.ok((idle.writeAgeMs ?? 0) > 30_000, 'the idle session is idle only by accident');
});

test('nothing in the demo canvas looks like a real machine', () => {
  const dump = JSON.stringify(makeDemoState({ now: NOW, sessions: 6, agentsPerSession: 4 }));
  for (const pattern of [/C:[\\/]+Users/i, /\/home\//, /\/Users\//, /y[ıi]ld[ıi]z/i, /yldz/i]) {
    assert.equal(pattern.test(dump), false, `demo data matched ${String(pattern)}`);
  }
});

test('the generator grows the canvas for the frame-rate check', () => {
  const big = makeDemoState({ now: NOW, sessions: 9, agentsPerSession: 6 });
  assert.equal(big.sessions.length, 9);
  const ids = new Set(big.sessions.map((session) => session.id));
  assert.equal(ids.size, 9, 'session ids stay unique when the seeds repeat');

  const agentIds = new Set(big.sessions.flatMap((session) => session.agents.map((a) => a.id)));
  assert.equal(
    agentIds.size,
    big.sessions.reduce((sum, session) => sum + session.agents.length, 0),
    'agent ids stay unique too, or the diffed renderer would collide',
  );
});

test('forestOf hangs children under parents and orphans at the root', () => {
  const roots = forestOf([
    { id: 'a', sessionId: 's', spawnDepth: 1, agentType: 'x', state: 'running' },
    { id: 'b', sessionId: 's', parentAgentId: 'a', spawnDepth: 2, agentType: 'x', state: 'running' },
    {
      id: 'c',
      sessionId: 's',
      parentAgentId: 'missing',
      spawnDepth: 2,
      agentType: 'x',
      orphan: true,
      state: 'unknown',
    },
  ]);

  assert.equal(roots.length, 2);
  assert.equal(roots[0]?.agent.id, 'a');
  assert.equal(roots[0]?.children[0]?.agent.id, 'b');
  assert.equal(roots[1]?.agent.id, 'c', 'an orphan attaches to the session root');
});

test('every session in the demo canvas has been read from disk', () => {
  for (const session of makeDemoState({ now: NOW }).sessions) {
    assert.equal(session.treeRead, true);
    assert.equal(session.roots.length > 0, session.agents.length > 0);
  }
});

test('zero sessions is a legal demo canvas, so the empty state is reachable', () => {
  const state = makeDemoState({ now: NOW, sessions: 0 });
  assert.deepEqual(state.sessions, []);
  assert.equal(state.generatedAt, NOW);
});
