/**
 * N-WP15a: the three-layer gate, from the outside.
 *
 * The core tests prove the reader does not read unless it is asked. These prove
 * the other two layers, which is where the promise is actually kept or broken:
 *
 * - **The wire omits it by default.** No query string, no field. This is the
 *   test that keeps every existing leak assertion true — those were written
 *   against a payload with no task in it, and they go on passing because the
 *   default payload is still that payload.
 * - **`?task=1` is the whole protocol.** One parameter, on `/api/state`, on the
 *   SSE subscription and on a history open. Anything else is off.
 * - **`--no-task-text` outranks the caller.** A server started with the switch
 *   answers a request that asked as though it had not, and the readers behind
 *   it were never given anything to answer with.
 *
 * The redaction is checked too, because task text is the most sensitive string
 * that has ever crossed this wire and it goes through the same gate as `cwd`.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Agent, History, SessionView, StateSnapshot } from '@nazar/core';
import { MAX_TASK_TEXT } from '@nazar/core';

import { startNazarServer, type HistorySource, type StateSource } from '../src/http.ts';
import { toWireAgent, toWireSession } from '../src/snapshot.ts';

const TASK = 'sweep the readers and say which of them can write';
const BRIEF = 'read every file under packages and list the ones that could write to disk';
const LABEL = 'Secret sweep';

function agent(): Agent {
  return {
    id: 'a0000000000000001',
    sessionId: 's1',
    spawnDepth: 1,
    agentType: 'general-purpose',
    state: 'running',
    description: LABEL,
    task: BRIEF,
  };
}

function session(): SessionView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    provider: 'claude',
    pid: 1001,
    cwd: 'C:/proj/nazar',
    status: 'busy',
    state: 'alive',
    source: 'files+command',
    lastSeenAt: 1_788_756_000_000,
    task: TASK,
    agents: [agent()],
    roots: [{ agent: agent(), children: [] }],
    orphans: [],
    treeRead: true,
  };
}

function snapshot(): StateSnapshot {
  return {
    generatedAt: 1_788_756_000_000,
    sessions: [session()],
    commandAvailable: true,
    warnings: 0,
  };
}

function history(): History {
  return {
    sessionId: '00000000-0000-4000-8000-000000000002',
    project: '~/proj/nazar',
    task: TASK,
    agentCount: 1,
    agents: [agent()],
    roots: [{ agent: agent(), children: [] }],
    orphans: [],
    dedupeFallbacks: 0,
    bytesRead: 0,
  };
}

const state: StateSource = {
  snapshot: () => snapshot(),
  on: () => undefined,
  off: () => undefined,
};

const historySource: HistorySource = {
  list: async () =>
    Promise.resolve({
      generatedAt: 1_788_756_000_000,
      total: 0,
      offset: 0,
      sessions: [],
      projects: [],
      listMs: 0,
      warnings: 0,
    }),
  open: async () => Promise.resolve(history()),
};

async function withServer(
  taskText: boolean,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'nazar-task-'));
  const uiDir = path.join(root, 'web');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Nazar</title>', 'utf8');

  const server = await startNazarServer({
    state,
    history: historySource,
    uiDir,
    port: 0,
    heartbeatMs: 50,
    taskText,
  });
  try {
    await run(server.url);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** The first `event: state` frame of an SSE subscription, parsed. */
async function firstFrame(url: string): Promise<StateSnapshot> {
  const controller = new AbortController();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('event: state')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('the stream ended before its first frame');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const line = buffer.split('\n').find((one) => one.startsWith('data: '));
    assert.ok(line !== undefined);
    return JSON.parse(line.slice('data: '.length)) as StateSnapshot;
  } finally {
    controller.abort();
  }
}

/* ------------------------------------------------------------------ *
 * The default: no field anywhere
 * ------------------------------------------------------------------ */

test('by default the wire carries no task and no description', async () => {
  await withServer(true, async (url) => {
    const body = (await (await fetch(`${url}api/state`)).json()) as StateSnapshot;
    const one = body.sessions[0];
    assert.ok(one !== undefined);

    // Absent, not empty. Every leak test in this repository asserts on the
    // *presence* of a key, so an empty string here would let a payload carry a
    // field those tests were written to forbid while they went on passing.
    assert.equal('task' in one, false);
    assert.equal('task' in (one.agents[0] as object), false);
    assert.equal('description' in (one.agents[0] as object), false);
    // And the strongest form of the same claim.
    const raw = JSON.stringify(body);
    for (const text of [TASK, BRIEF, LABEL]) assert.equal(raw.includes(text), false);
  });
});

test('a query string that is not exactly task=1 is not a yes', async () => {
  await withServer(true, async (url) => {
    // A stale link, a hand-edited URL, a wrapper that spelled it differently.
    // None of them is a request for task text: guessing at intent is how a
    // feature switched off in a browser turns up in a screenshot.
    for (const query of ['task=0', 'task=true', 'task=', 'task=1x', 'tasks=1']) {
      const body = (await (await fetch(`${url}api/state?${query}`)).json()) as StateSnapshot;
      assert.equal('task' in (body.sessions[0] as object), false, query);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Asking for it
 * ------------------------------------------------------------------ */

test('?task=1 adds the task, on the snapshot, the stream and a history open', async () => {
  await withServer(true, async (url) => {
    const body = (await (await fetch(`${url}api/state?task=1`)).json()) as StateSnapshot;
    const one = body.sessions[0];
    assert.equal(one?.task, TASK);
    assert.equal(one?.agents[0]?.task, BRIEF);
    assert.equal(one?.agents[0]?.description, LABEL);
    // The tree carries the same agents as the flat list, so a canvas drawing
    // from `roots` and a hover card reading `agents` cannot disagree.
    assert.equal(one?.roots[0]?.agent.task, BRIEF);

    // The stream is where it matters: the canvas is drawn from SSE frames and a
    // snapshot fetch is the fallback.
    const frame = await firstFrame(`${url}api/events?task=1`);
    assert.equal(frame.sessions[0]?.task, TASK);
    const off = await firstFrame(`${url}api/events`);
    assert.equal('task' in (off.sessions[0] as object), false);

    // History, under the same gate: a frozen card that lost its task line would
    // be the feature working everywhere except the last place anybody looks.
    const frozen = (await (
      await fetch(`${url}api/history/00000000-0000-4000-8000-000000000002?task=1`)
    ).json()) as History;
    assert.equal(frozen.task, TASK);
    assert.equal(frozen.agents[0]?.task, BRIEF);

    const plain = (await (
      await fetch(`${url}api/history/00000000-0000-4000-8000-000000000002`)
    ).json()) as History;
    assert.equal('task' in plain, false);
    assert.equal('task' in (plain.agents[0] as object), false);
  });
});

/* ------------------------------------------------------------------ *
 * The hard switch
 * ------------------------------------------------------------------ */

test('--no-task-text outranks the caller, on every route', async () => {
  await withServer(false, async (url) => {
    const body = (await (await fetch(`${url}api/state?task=1`)).json()) as StateSnapshot;
    assert.equal('task' in (body.sessions[0] as object), false);
    assert.equal('task' in (body.sessions[0]?.agents[0] as object), false);

    const frame = await firstFrame(`${url}api/events?task=1`);
    assert.equal('task' in (frame.sessions[0] as object), false);

    const frozen = (await (
      await fetch(`${url}api/history/00000000-0000-4000-8000-000000000002?task=1`)
    ).json()) as History;
    assert.equal('task' in frozen, false);

    /*
     * Note what this test can and cannot prove. It shows the *wire* refuses,
     * using a state source that was handed a task on purpose — which is a
     * situation the real product cannot be in, because `serve()` passes the
     * same flag to the readers and with it off they never produce one.
     * `packages/core/test/task-text.test.ts` is the other half, and the two
     * together are the claim: nothing is read, and nothing would be sent even
     * if it had been.
     */
  });
});

/* ------------------------------------------------------------------ *
 * The last gate
 * ------------------------------------------------------------------ */

test('task text goes through the same redaction as a path, at its own length', () => {
  const home = 'C:/Users/example';
  const wired = toWireSession(
    { ...session(), task: 'deploy with --token=abcdef0123456789 from C:/Users/example/proj' },
    { task: true, home },
  );
  assert.ok(wired.task !== undefined);
  // Masked before anything else: truncating first can leave the readable head
  // of a token on screen, which is the rule `redact.ts` is built around.
  assert.equal(wired.task.includes('abcdef0123456789'), false);
  assert.ok(wired.task.includes('[redacted]'));
  // The home directory collapses **mid-sentence**, which a `cwd` never needs
  // and a sentence always does. The account name is the most common accidental
  // disclosure in a shared screenshot, and a canvas is a screenshot.
  assert.equal(wired.task.includes('C:/Users/example'), false);
  assert.ok(wired.task.includes('~/proj'));

  // And the length is the task's own cap, not the 80-character one that
  // identifier-shaped fields get — cutting a task to 80 here would make the
  // setting look as though it worked while showing a fragment.
  const long = 'w'.repeat(MAX_TASK_TEXT + 100);
  const cut = toWireAgent({ ...agent(), task: long }, { task: true });
  assert.equal(cut.task?.length, MAX_TASK_TEXT + 1);
  assert.equal(cut.task?.endsWith('…'), true);
});

test('a sentence is swept more carefully than a path, and still swept', () => {
  /*
   * The trade N-WP15a made in `redact.ts`, asserted from both sides.
   *
   * A path is a value nobody has to read, so the keyword rule there accepts a
   * bare space and over-masks happily. A task line is a value somebody *does*
   * have to read, and the same rule turns half of ordinary English into
   * `[redacted]` — a feature that looks broken rather than careful. So prose
   * requires an actual assignment, and every literal credential shape is caught
   * either way.
   */
  const keeps = [
    'Secret sweep before the public flip',
    'rotate the auth keys next week',
    'check the token rotation script',
  ];
  for (const text of keeps) {
    assert.equal(toWireAgent({ ...agent(), task: text }, { task: true }).task, text);
  }

  const masks: ReadonlyArray<readonly [string, string]> = [
    ['use token=hunter2 for the staging box', 'hunter2'],
    ['API_KEY: hunter2 is the one', 'hunter2'],
    ['the key is sk-ant-abcdefghijklmnop', 'sk-ant-abcdefghijklmnop'],
    ['paste ghp_abcdefghijklmnopqrst somewhere', 'ghp_abcdefghijklmnopqrst'],
  ];
  for (const [text, secret] of masks) {
    const out = toWireAgent({ ...agent(), task: text }, { task: true }).task;
    assert.equal(out?.includes(secret), false, text);
    assert.ok(out?.includes('[redacted]'), text);
  }
});

test('the wire helpers take the flag per call, so two browsers can differ', () => {
  // The flag belongs to a request and is not remembered anywhere. One browser
  // asking must not change what another one is sent on the same frame.
  const one = toWireAgent(agent(), { task: true });
  const other = toWireAgent(agent());
  assert.equal(one.task, BRIEF);
  assert.equal('task' in other, false);
  assert.equal('description' in other, false);
});
