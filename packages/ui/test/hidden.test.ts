/**
 * WP4f: **clear finished subagents**, and the two things it must never do.
 *
 * It must not delete anything — the snapshot the server sent is what the next
 * frame will be built from again, so hiding has to be a filter and not a
 * mutation — and it must not break the tree, which means a finished agent that
 * spawned a *running* one stays, or its child would be orphaned on screen.
 *
 * Both are properties of one pure function, so both are checked here against
 * the demo canvas (which carries a finished agent, an unknown one and an orphan
 * on purpose) and against hand-built shapes for the cases the demo does not
 * happen to contain.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import type { Agent, AgentNode, SessionView } from '@nazar/core';

import { makeDemoState } from '../src/demo.ts';
import { finishedAgentIds, hiddenLabel, hideAgents } from '../src/hidden.ts';

const NOW = 1_788_756_000_000;

/** An agent with only the fields this filter reads. */
function agent(id: string, state: Agent['state']): Agent {
  return { id, state, spawnDepth: 1 } as Agent;
}

function node(one: Agent, ...children: AgentNode[]): AgentNode {
  return { agent: one, children };
}

/** A session carrying a forest, with everything else at its emptiest. */
function session(roots: readonly AgentNode[]): SessionView {
  const flat: Agent[] = [];
  const walk = (nodes: readonly AgentNode[]): void => {
    for (const one of nodes) {
      flat.push(one.agent);
      walk(one.children);
    }
  };
  walk(roots);
  return {
    id: 's1',
    provider: 'claude',
    pid: 1,
    status: 'busy',
    state: 'alive',
    source: 'files',
    lastSeenAt: NOW,
    agents: flat,
    roots,
    orphans: [],
    treeRead: true,
  } as SessionView;
}

test('nothing hidden is the same object, so no frame is wasted on it', () => {
  const one = session([node(agent('a', 'done'))]);
  const result = hideAgents(one, new Set());
  assert.equal(result.session, one, 'the identical object, not a copy of it');
  assert.equal(result.hidden, 0);
});

test('a finished leaf goes, from the tree and from the flat list alike', () => {
  const one = session([node(agent('a', 'done')), node(agent('b', 'running'))]);
  const result = hideAgents(one, new Set(['a']));
  assert.equal(result.hidden, 1);
  assert.deepEqual(
    result.session.roots.map((root) => root.agent.id),
    ['b'],
  );
  assert.deepEqual(
    result.session.agents.map((one) => one.id),
    ['b'],
    'the count on the card comes from `agents`, so the two must agree',
  );
});

test('the original session is untouched: this hides, it does not delete', () => {
  const one = session([node(agent('a', 'done')), node(agent('b', 'running'))]);
  hideAgents(one, new Set(['a']));
  assert.equal(one.agents.length, 2);
  assert.equal(one.roots.length, 2);
});

test('a finished parent of a running child stays, so nothing is orphaned', () => {
  const one = session([node(agent('parent', 'done'), node(agent('child', 'running')))]);
  const result = hideAgents(one, new Set(['parent']));
  assert.equal(result.hidden, 0, 'hiding it would either orphan the child or take it along');
  assert.equal(result.session, one);
});

test('a finished parent goes once its whole subtree has gone with it', () => {
  const one = session([
    node(agent('parent', 'done'), node(agent('child', 'done'))),
    node(agent('other', 'running')),
  ]);
  const result = hideAgents(one, new Set(['parent', 'child']));
  assert.equal(result.hidden, 2);
  assert.deepEqual(
    result.session.roots.map((root) => root.agent.id),
    ['other'],
  );
});

test('a deep branch is pruned from the bottom up', () => {
  //     a (done)
  //     └── b (done)
  //         ├── c (done)      -> all three may go
  //         └── d (running)   -> and so none of them does
  const tree = (dState: Agent['state']): SessionView =>
    session([
      node(
        agent('a', 'done'),
        node(agent('b', 'done'), node(agent('c', 'done')), node(agent('d', dState))),
      ),
    ]);
  const finished = new Set(['a', 'b', 'c']);

  const kept = hideAgents(tree('running'), finished);
  assert.equal(kept.hidden, 1, 'only the leaf c goes; b and a hold d up');
  assert.deepEqual(
    kept.session.roots[0]?.children[0]?.children.map((one) => one.agent.id),
    ['d'],
  );

  const gone = hideAgents(tree('done'), new Set([...finished, 'd']));
  assert.equal(gone.hidden, 4);
  assert.deepEqual(gone.session.roots, []);
});

test('an id that is not in the tree hides nothing', () => {
  const one = session([node(agent('a', 'running'))]);
  const result = hideAgents(one, new Set(['nobody']));
  assert.equal(result.hidden, 0);
  assert.equal(result.session, one);
});

test('finishedAgentIds names every done agent and only those', () => {
  const one = session([
    node(agent('a', 'done'), node(agent('b', 'running'))),
    node(agent('c', 'done')),
    node(agent('d', 'unknown')),
  ]);
  assert.deepEqual(finishedAgentIds(one).sort(), ['a', 'c']);
});

test('the demo canvas can be cleared and comes back whole', () => {
  const state = makeDemoState({ now: NOW });
  let cleared = 0;
  for (const one of state.sessions) {
    const finished = finishedAgentIds(one);
    const result = hideAgents(one, new Set(finished));
    cleared += result.hidden;

    // Every agent still drawn is either not finished, or finished with
    // something under it that is.
    const drawn = new Set(result.session.agents.map((agent) => agent.id));
    for (const id of finished) {
      if (!drawn.has(id)) continue;
      const held = result.session.agents.some((agent) => agent.id !== id);
      assert.ok(held, `${id} is finished and still drawn, so it must be holding a child up`);
    }
    assert.ok(result.session.agents.length <= one.agents.length);
  }
  assert.ok(cleared > 0, 'the demo canvas has finished agents; clearing them must do something');
});

test('the chip says how many and offers them back', () => {
  assert.equal(hiddenLabel(1), '1 finished hidden · show');
  assert.equal(hiddenLabel(42), '42 finished hidden · show');
});
