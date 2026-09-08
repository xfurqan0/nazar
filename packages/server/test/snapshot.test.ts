/**
 * What leaves the process. The assertions that matter are the negative ones:
 * the two dropped fields must not survive a `JSON.stringify` of the payload.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Agent, Quota, SessionView, StateSnapshot } from '@nazar/core';

import {
  MAX_WIRE_STRING,
  toWireAgent,
  toWireQuotaWindow,
  toWireSession,
  toWireState,
} from '../src/snapshot.ts';

const HOME = 'C:\\Users\\example';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-a0000000000000001',
    sessionId: 's1',
    spawnDepth: 1,
    agentType: 'general-purpose',
    state: 'running',
    ...overrides,
  };
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    provider: 'claude',
    pid: 1001,
    status: 'busy',
    state: 'alive',
    source: 'files+command',
    lastSeenAt: 1_788_756_000_000,
    agents: [],
    roots: [],
    orphans: [],
    treeRead: true,
    ...overrides,
  };
}

test('the user-authored description never reaches the wire', () => {
  const wire = toWireAgent(agent({ description: 'SENTINEL-do-not-ship-this-text' }));
  assert.equal(wire.description, undefined);
  assert.ok(!JSON.stringify(wire).includes('SENTINEL'));
});

test('toolUseId is dropped: the tree is keyed on the agent id', () => {
  const wire = toWireAgent(agent({ toolUseId: 'toolu_000000000000000000000001' }));
  assert.equal(wire.toolUseId, undefined);
});

test('an agent keeps every measured field, and the absent ones stay absent', () => {
  const wire = toWireAgent(
    agent({
      parentAgentId: 'agent-a0000000000000002',
      model: 'opus',
      modelId: 'claude-opus-5[1m]',
      effort: 'high',
      currentTool: 'Grep',
      tokens: { in: 4820, out: 2133, cacheRead: 188_402, cacheWrite: 12_288 },
      toolCalls: 41,
      orphan: true,
      workflowRunId: 'run-1',
      lastWriteAt: 1_788_755_000_000,
      writeAgeMs: 1000,
      startedAt: 1_788_700_000_000,
      durationMs: 55_000,
    }),
  );

  assert.deepEqual(wire.tokens, { in: 4820, out: 2133, cacheRead: 188_402, cacheWrite: 12_288 });
  assert.equal(wire.modelId, 'claude-opus-5[1m]');
  assert.equal(wire.orphan, true);
  assert.equal(wire.workflowRunId, 'run-1');

  const bare = toWireAgent(agent());
  assert.equal(bare.tokens, undefined, 'no counter is invented');
  assert.equal(bare.currentTool, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(bare, 'tokens'));
});

test('the working directory is redacted, not just copied', () => {
  const wire = toWireSession(
    session({ cwd: 'C:\\Users\\example\\proj\\nazar', name: 'session-a' }),
    { home: HOME },
  );
  assert.equal(wire.cwd, '~\\proj\\nazar');
  assert.equal(wire.name, 'session-a');
});

test('a session name carrying a secret is masked', () => {
  const wire = toWireSession(session({ name: 'deploy --token=abc123def456' }), { home: HOME });
  assert.ok(!String(wire.name).includes('abc123def456'));
});

test('enum-shaped fields are length-capped but not swept for secrets', () => {
  const long = 'x'.repeat(300);
  const wire = toWireSession(session({ model: long, currentTool: 'token-counter' }), {
    home: HOME,
  });
  assert.equal(String(wire.model).length, MAX_WIRE_STRING + 1);
  assert.equal(wire.currentTool, 'token-counter', 'a legitimate tool name is not mangled');
});

test('a session with no capture behind it has no cost field at all, not a zero', () => {
  const wire = toWireSession(session(), { home: HOME });
  assert.ok(!Object.prototype.hasOwnProperty.call(wire, 'costUsd'));
  assert.ok(!Object.prototype.hasOwnProperty.call(wire, 'contextWindow'));
  assert.ok(!JSON.stringify(wire).includes('costUsd'));
});

test('the tree is sanitized in both places it appears', () => {
  const poisoned = agent({ description: 'SENTINEL' });
  const wire = toWireSession(
    session({
      agents: [poisoned],
      roots: [{ agent: poisoned, children: [{ agent: poisoned, children: [] }] }],
    }),
    { home: HOME },
  );
  assert.ok(!JSON.stringify(wire).includes('SENTINEL'));
  assert.equal(wire.roots[0]?.children[0]?.agent.id, poisoned.id);
});

test('toWireState carries the snapshot header through unchanged', () => {
  const snapshot: StateSnapshot = {
    generatedAt: 42,
    sessions: [session({ cwd: 'C:/proj/nazar' })],
    commandAvailable: true,
    warnings: 3,
  };
  const wire = toWireState(snapshot, { home: HOME });
  assert.equal(wire.generatedAt, 42);
  assert.equal(wire.commandAvailable, true);
  assert.equal(wire.warnings, 3);
  assert.equal(wire.sessions.length, 1);
});

/* ------------------------------------------------------------------ *
 * WP3'/WP5: cost, context window and the quota strip
 * ------------------------------------------------------------------ */

test('cost and context window cross the wire, and stay absent when unfilled', () => {
  const filled = toWireSession(
    session({
      costUsd: 9.60050075,
      contextWindow: { used: 159_283, size: 1_000_000, percent: 16 },
      capturedAt: 1_788_756_000_000,
    }),
    { home: HOME },
  );
  assert.equal(filled.costUsd, 9.60050075, 'rounding is a display decision, not a wire one');
  assert.deepEqual(filled.contextWindow, { used: 159_283, size: 1_000_000, percent: 16 });
  assert.equal(filled.capturedAt, 1_788_756_000_000);

  const empty = toWireSession(session(), { home: HOME });
  assert.equal('costUsd' in empty, false, 'absent, not zero');
  assert.equal('contextWindow' in empty, false);
  assert.equal('capturedAt' in empty, false);
});

test('the context window is rebuilt by name, so nothing rides along with it', () => {
  const wire = toWireSession(
    session({
      contextWindow: {
        used: 10,
        size: 100,
        percent: 10,
        ...({ transcriptPath: 'SENTINEL' } as object),
      },
    }),
    { home: HOME },
  );
  assert.equal(JSON.stringify(wire).includes('SENTINEL'), false);
});

test('a quota crosses the wire whole; no quota means no key at all', () => {
  const quota: Quota = {
    source: 'limits.json',
    updatedAt: 40,
    providers: [
      {
        name: 'claude',
        configured: true,
        plan: 'max_20x',
        source: 'endpoint',
        sourceAt: 38,
        binding: 'seven_day_fable',
        windows: [
          {
            key: 'seven_day_fable',
            state: 'ok',
            percent: 23,
            resetsAt: 99,
            windowMinutes: 10_080,
            model: 'Fable',
            detailed: true,
          },
          { key: 'five_hour', state: 'error', error: 'no answer', windowMinutes: 300 },
        ],
      },
    ],
  };

  const wire = toWireState(
    { generatedAt: 42, sessions: [], commandAvailable: true, warnings: 0, quota },
    { home: HOME },
  );
  assert.equal(wire.quota?.source, 'limits.json');
  assert.equal(wire.quota?.providers[0]?.plan, 'max_20x');
  assert.equal(wire.quota?.providers[0]?.windows[0]?.detailed, true);
  // The unknown window keeps its state and its reason, and gains no percentage.
  const unknown = wire.quota?.providers[0]?.windows[1];
  assert.equal(unknown?.state, 'error');
  assert.equal(unknown?.error, 'no answer');
  assert.equal('percent' in (unknown ?? {}), false);

  const without = toWireState(
    { generatedAt: 42, sessions: [], commandAvailable: true, warnings: 0 },
    { home: HOME },
  );
  assert.equal('quota' in without, false, 'no source means the strip is not even mentioned');
});

test('a quota window is rebuilt by name, so a future field is looked at first', () => {
  const wire = toWireQuotaWindow({
    key: 'five_hour',
    state: 'ok',
    percent: 12,
    ...({ debugPath: 'SENTINEL' } as object),
  });
  assert.equal(JSON.stringify(wire).includes('SENTINEL'), false);
});

test('an over-long error string is clipped rather than carried', () => {
  const wire = toWireQuotaWindow({ key: 'five_hour', state: 'error', error: 'x'.repeat(500) });
  assert.equal(wire.error?.length, MAX_WIRE_STRING + 1, 'clipped, with the ellipsis');
});
