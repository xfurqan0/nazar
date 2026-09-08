/**
 * The subagent tree.
 *
 * Depth 1 to 3 is the shape the fixtures pin and the shape this machine
 * produces (287 / 31 / 28 meta files). The failure cases below have never been
 * observed and are the ones that must never take the canvas down: a parent that
 * does not exist, a parent that is the node itself, and a loop.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAgentTree, walkAgentTree } from '../src/agent-tree.ts';
import { readSubagentsDir } from '../src/subagent-meta.ts';
import type { AgentMeta } from '../src/subagent-meta.ts';
import type { AgentBridge } from '../src/transcript-stats.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSubagents = path.join(here, '..', '..', '..', 'fixtures', 'subagents');
const SESSION = '00000000-0000-4000-8000-000000000005';
const NOW = 1_788_800_000_000;

function meta(id: string, fields: Partial<AgentMeta> = {}): AgentMeta {
  return { id, agentType: 'general-purpose', model: 'opus', spawnDepth: 1, ...fields };
}

test('the fixture chain renders as depth 1 to 3 with two siblings at the bottom', async () => {
  const scan = await readSubagentsDir(fixtureSubagents);
  const tree = buildAgentTree({ sessionId: SESSION, metas: scan.metas, now: NOW });

  assert.deepEqual(tree.orphans, []);
  assert.equal(tree.agents.length, 7);
  assert.equal(tree.roots.length, 4, 'one chain root plus three standalone agents');

  const depths: Array<[string, number]> = [];
  walkAgentTree(tree.roots, (node, depth) => depths.push([node.agent.id, depth]));
  assert.equal(depths.length, 7, 'every agent is reachable from a root');

  const chain = tree.roots.find((node) => node.agent.id === 'a0000000000000001');
  assert.ok(chain !== undefined);
  assert.equal(chain.agent.spawnDepth, 1);
  assert.equal(chain.children.length, 1);

  const middle = chain.children[0];
  assert.equal(middle?.agent.id, 'a0000000000000002');
  assert.equal(middle?.agent.spawnDepth, 2);
  assert.equal(middle?.agent.parentAgentId, 'a0000000000000001');
  assert.deepEqual(
    middle?.children.map((node) => [node.agent.id, node.agent.spawnDepth]),
    [
      ['a0000000000000003', 3],
      ['a0000000000000004', 3],
    ],
  );

  // Every agent keeps its session, and the user-authored description rides
  // along in memory for the hover card.
  assert.equal(chain.agent.sessionId, SESSION);
  assert.equal(chain.agent.description, 'task placeholder');
});

test('a dangling parent attaches to the session root and is flagged, never thrown', () => {
  const metas = [
    meta('a0000000000000001'),
    meta('a0000000000000002', { parentAgentId: 'a0000000000000099', spawnDepth: 2 }),
  ];
  const tree = buildAgentTree({ sessionId: SESSION, metas, now: NOW });

  assert.deepEqual(tree.orphans, ['a0000000000000002']);
  assert.equal(tree.roots.length, 2, 'the orphan hangs off the session, not off nothing');
  const orphan = tree.agents.find((agent) => agent.id === 'a0000000000000002');
  assert.equal(orphan?.orphan, true);
  assert.equal(orphan?.parentAgentId, 'a0000000000000099', 'the claimed parent is kept for the card');
  assert.equal(orphan?.spawnDepth, 2, 'the written depth is still what Claude Code said');
});

test('a self-parent and a loop are broken instead of hanging the builder', () => {
  const selfParent = buildAgentTree({
    sessionId: SESSION,
    metas: [meta('a0000000000000001', { parentAgentId: 'a0000000000000001' })],
    now: NOW,
  });
  assert.deepEqual(selfParent.orphans, ['a0000000000000001']);
  assert.equal(selfParent.roots.length, 1);

  const loop = buildAgentTree({
    sessionId: SESSION,
    metas: [
      meta('a0000000000000001', { parentAgentId: 'a0000000000000002', spawnDepth: 2 }),
      meta('a0000000000000002', { parentAgentId: 'a0000000000000001', spawnDepth: 2 }),
    ],
    now: NOW,
  });
  assert.equal(loop.orphans.length > 0, true);
  assert.equal(loop.agents.length, 2);
  let visited = 0;
  walkAgentTree(loop.roots, () => {
    visited += 1;
  });
  assert.equal(visited, 2, 'both nodes are still reachable exactly once');
});

test('depth comes from the file, and is computed only when the file has none', () => {
  const written = buildAgentTree({
    sessionId: SESSION,
    // A depth Claude Code wrote wins even when it disagrees with the chain: the
    // file is the source, not our arithmetic.
    metas: [meta('a1'), meta('a2', { parentAgentId: 'a1', spawnDepth: 7 })],
    now: NOW,
  });
  assert.equal(written.agents.find((agent) => agent.id === 'a2')?.spawnDepth, 7);

  const computed = buildAgentTree({
    sessionId: SESSION,
    metas: [
      { id: 'a1', agentType: 'general-purpose' },
      { id: 'a2', agentType: 'general-purpose', parentAgentId: 'a1' },
      { id: 'a3', agentType: 'general-purpose', parentAgentId: 'a2' },
    ],
    now: NOW,
  });
  assert.deepEqual(
    computed.agents.map((agent) => [agent.id, agent.spawnDepth]),
    [
      ['a1', 1],
      ['a2', 2],
      ['a3', 3],
    ],
  );
});

test('the bridge gives the full model id while meta.json keeps the shortcut', () => {
  const bridges = new Map<string, AgentBridge>([
    ['a0000000000000005', { modelId: 'claude-haiku-4-5-20251001', completed: false }],
    ['a0000000000000006', { modelId: 'claude-opus-5[1m]', durationMs: 91_000, completed: true }],
  ]);
  const tree = buildAgentTree({
    sessionId: SESSION,
    metas: [
      meta('a0000000000000005', { agentType: 'claude-code-guide', model: undefined }),
      meta('a0000000000000006'),
      meta('a0000000000000007'),
    ],
    bridges,
    now: NOW,
  });

  const byId = new Map(tree.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get('a0000000000000005')?.model, undefined);
  assert.equal(byId.get('a0000000000000005')?.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(byId.get('a0000000000000006')?.model, 'opus', 'the shortcut from meta.json');
  assert.equal(byId.get('a0000000000000006')?.modelId, 'claude-opus-5[1m]', 'the full id, [1m] included');
  assert.equal(byId.get('a0000000000000006')?.durationMs, 91_000);
  assert.equal(byId.get('a0000000000000007')?.modelId, undefined, 'no bridge, no invented model');
});

test('running is decided by the age of the last transcript write, and never guessed', () => {
  const tree = buildAgentTree({
    sessionId: SESSION,
    metas: [meta('a1'), meta('a2'), meta('a3')],
    activity: new Map([
      ['a1', { lastWriteAt: NOW - 1_000, tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 } }],
      ['a2', { lastWriteAt: NOW - 600_000 }],
    ]),
    now: NOW,
    runningWindowMs: 30_000,
  });

  const byId = new Map(tree.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get('a1')?.state, 'running');
  assert.equal(byId.get('a1')?.writeAgeMs, 1_000);
  assert.deepEqual(byId.get('a1')?.tokens, { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 });
  // Quiet for ten minutes is not "done": WP4b owns done detection.
  assert.equal(byId.get('a2')?.state, 'unknown');
  assert.equal(byId.get('a3')?.state, 'unknown', 'an agent with no transcript yet');
  assert.equal(byId.get('a3')?.tokens, undefined, 'nothing seen shows nothing, not zero');
});

test('an empty session has an empty tree, not an error', () => {
  const tree = buildAgentTree({ sessionId: SESSION, metas: [], now: NOW });
  assert.deepEqual(tree.agents, []);
  assert.deepEqual(tree.roots, []);
  assert.deepEqual(tree.orphans, []);
});
