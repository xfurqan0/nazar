/**
 * The per-session watcher, end to end.
 *
 * Every test builds a fake `~/.claude/projects/<slug>` in a temporary
 * directory from the shipped fixtures. The real transcript store is never
 * watched, opened or written to here.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { DirectoryWatcher } from '../src/fs-watch.ts';
import { SessionTreeWatcher } from '../src/session-tree.ts';
import type { SessionTreeSnapshot } from '../src/session-tree.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', 'fixtures');
const SESSION = '00000000-0000-4000-8000-000000000005';

/**
 * The bound the watcher promises: one poll interval (2 s by default) plus one
 * pass, on every platform, with a whole further interval of margin for a
 * loaded CI runner.
 *
 * The old budget was 2 s and rested on `fs.watch` being prompt, which is not
 * something any platform owes us: on macOS a directory watch goes through
 * FSEvents, which coalesces and delivers on its own schedule, and this budget
 * duly failed once on `macos-latest` while Windows and Ubuntu passed. The
 * watcher now polls unconditionally, so what is below is met even where no
 * watch exists at all, and the `fs.watch` half is asserted through an injected
 * factory rather than by waiting on a filesystem.
 */
const BOUND_MS = 4000;

/** An `fs.watch` handle a test drives by hand. */
class FakeWatcher extends EventEmitter implements DirectoryWatcher {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

/** A project directory holding one session, its subagents and their files. */
async function project(options: { withAgents: boolean }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nazar-tree-'));
  await copyFile(path.join(fixtures, 'subagents', 'parent-slice.jsonl'), path.join(dir, `${SESSION}.jsonl`));
  if (!options.withAgents) return dir;

  const subagents = path.join(dir, SESSION, 'subagents');
  await mkdir(subagents, { recursive: true });
  for (const id of ['a0000000000000005', 'a0000000000000006', 'a0000000000000007']) {
    await copyFile(
      path.join(fixtures, 'subagents', `agent-${id}.meta.json`),
      path.join(subagents, `agent-${id}.meta.json`),
    );
  }
  await copyFile(
    path.join(fixtures, 'subagents', 'agent-a0000000000000006.jsonl'),
    path.join(subagents, 'agent-a0000000000000006.jsonl'),
  );
  return dir;
}

function nextChange(
  watcher: SessionTreeWatcher,
  budgetMs = BOUND_MS,
): Promise<SessionTreeSnapshot> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onChange = (snapshot: SessionTreeSnapshot): void => {
      clearTimeout(timer);
      resolve(snapshot);
    };
    timer = setTimeout(() => {
      watcher.off('change', onChange);
      reject(new Error(`no change event within ${budgetMs} ms`));
    }, budgetMs);
    watcher.once('change', onChange);
  });
}

test('a session with three subagents comes up with tokens, tree and bridges', async (t) => {
  const dir = await project({ withAgents: true });
  const watcher = new SessionTreeWatcher({ sessionId: SESSION, projectDir: dir, watch: false, pollIntervalMs: 60_000 });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  const snapshot = watcher.snapshot();

  assert.equal(snapshot.sessionId, SESSION);
  assert.deepEqual(snapshot.tokens, { in: 663, out: 17371, cacheRead: 1100486, cacheWrite: 21031 });
  assert.deepEqual(snapshot.treeTokens, {
    in: 675,
    out: 18471,
    cacheRead: 1325013,
    cacheWrite: 42622,
  });
  assert.equal(snapshot.model, 'claude-fable-5-1');
  assert.equal(snapshot.effort, 'xhigh');
  assert.equal(snapshot.currentTool, 'Agent');
  assert.equal(snapshot.dedupeFallbacks, 0);
  assert.equal(snapshot.warnings, 0);
  assert.equal(snapshot.filesTailed, 2, 'the session transcript plus the one agent transcript');
  assert.ok((snapshot.writeAgeMs ?? -1) >= 0);

  assert.equal(snapshot.agents.length, 3);
  assert.deepEqual(snapshot.orphans, []);
  const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));

  // The whole point of the bridge: meta.json says `opus`, the parent's
  // toolUseResult says which opus.
  assert.equal(byId.get('a0000000000000006')?.model, 'opus');
  assert.equal(byId.get('a0000000000000006')?.modelId, 'claude-opus-5[1m]');
  assert.equal(byId.get('a0000000000000005')?.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(byId.get('a0000000000000005')?.model, undefined);

  // Only the agent with a transcript has numbers; the others show nothing.
  assert.deepEqual(byId.get('a0000000000000006')?.tokens, {
    in: 12,
    out: 1100,
    cacheRead: 224527,
    cacheWrite: 21591,
  });
  assert.equal(byId.get('a0000000000000006')?.effort, 'xhigh');
  assert.equal(byId.get('a0000000000000006')?.toolCalls, 9);
  // The slice ends inside a message, on its `thinking` block: no tool has been
  // written for that message yet, so the honest answer is "nothing known", not
  // the tool of the message before. Live, this state lasts milliseconds.
  assert.equal(byId.get('a0000000000000006')?.currentTool, undefined);
  assert.equal(byId.get('a0000000000000007')?.tokens, undefined);
});

test('appending to a transcript costs only the appended bytes', async (t) => {
  const dir = await project({ withAgents: true });
  const watcher = new SessionTreeWatcher({ sessionId: SESSION, projectDir: dir, watch: false, pollIntervalMs: 60_000 });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  const first = watcher.snapshot();
  const readAfterFirstPass = first.bytesRead;
  assert.ok(readAfterFirstPass > 20_000, 'the first pass reads both files whole');

  await watcher.refresh();
  assert.equal(watcher.snapshot().bytesRead, readAfterFirstPass, 'an idle pass reads nothing');

  const line = `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-07T00:00:00.000Z',
    sessionId: SESSION,
    agentId: 'a0000000000000006',
    isSidechain: true,
    requestId: 'req_000000000000000000000999',
    effort: 'xhigh',
    message: {
      id: 'msg_000000000000000000000999',
      model: 'claude-opus-5',
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Grep' }],
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_creation_input_tokens: 11,
        cache_read_input_tokens: 13,
      },
    },
  })}\n`;
  await appendFile(path.join(dir, SESSION, 'subagents', 'agent-a0000000000000006.jsonl'), line, 'utf8');

  await watcher.refresh();
  const second = watcher.snapshot();
  assert.equal(
    second.bytesRead - readAfterFirstPass,
    Buffer.byteLength(line),
    'the 9 MB session transcript is not re-read to see one new line',
  );

  const agent = second.agents.find((one) => one.id === 'a0000000000000006');
  assert.deepEqual(agent?.tokens, { in: 17, out: 1107, cacheRead: 224540, cacheWrite: 21602 });
  assert.equal(agent?.currentTool, 'Grep');
});

/**
 * The one test that touches a real filesystem watch, and it asserts the bound
 * rather than the watch: shipped defaults, no injected timings, and a budget a
 * machine whose `fs.watch` delivers nothing at all would still meet.
 */
test('a new agent lands inside the cross-platform bound', async (t) => {
  const dir = await project({ withAgents: true });
  const watcher = new SessionTreeWatcher({ sessionId: SESSION, projectDir: dir });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  assert.equal(watcher.pollIntervalMs, 2000, 'the bound below is made of the shipped default');
  assert.equal(watcher.debounceMs, 100);
  // The workflows directory does not exist in this fixture, so it is absent
  // from the list: an unwatchable path costs latency, never correctness.
  const subagentsDir = path.join(dir, SESSION, 'subagents');
  assert.deepEqual(
    [...watcher.watchedPaths].sort(),
    [
      path.join(dir, `${SESSION}.jsonl`),
      subagentsDir,
      path.join(subagentsDir, 'agent-a0000000000000006.jsonl'),
    ].sort(),
    'the transcript, the subagents directory and the agent transcript are really watched',
  );

  const pending = nextChange(watcher);
  await writeFile(
    path.join(dir, SESSION, 'subagents', 'agent-a0000000000000009.meta.json'),
    JSON.stringify({ agentType: 'Explore', model: 'opus', spawnDepth: 1, description: 'task placeholder' }),
    'utf8',
  );
  const snapshot = await pending;
  assert.equal(snapshot.agents.length, 4);
});

test('the poll alone sees the same change when fs.watch is off', async (t) => {
  const dir = await project({ withAgents: true });
  const watcher = new SessionTreeWatcher({
    sessionId: SESSION,
    projectDir: dir,
    watch: false,
    pollIntervalMs: 40,
  });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  assert.deepEqual(watcher.watchedPaths, []);
  const pending = nextChange(watcher);
  await writeFile(
    path.join(dir, SESSION, 'subagents', 'agent-a0000000000000009.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }),
    'utf8',
  );
  const snapshot = await pending;
  assert.equal(snapshot.agents.length, 4);
});

/**
 * The macOS failure mode, made deterministic: watches that are established,
 * never error, and simply never deliver. This is what a coalesced FSEvents
 * stream looks like from inside the process — and it is the shape of the run
 * that failed on `macos-latest` — so the poll has to carry it. The interval is
 * shortened so the suite does not sit through the shipped 2 s; the arithmetic
 * is the same one the bound is made of, and the test above pins the shipped
 * value itself.
 */
test('watches that never deliver still land the change on the poll', async (t) => {
  const dir = await project({ withAgents: true });
  const watcher = new SessionTreeWatcher({
    sessionId: SESSION,
    projectDir: dir,
    pollIntervalMs: 200,
    watchFactory: () => new FakeWatcher(),
  });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  assert.ok(watcher.watchedPaths.length > 0, 'the watches are held; they are just mute');

  const pending = nextChange(watcher);
  await writeFile(
    path.join(dir, SESSION, 'subagents', 'agent-a0000000000000009.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }),
    'utf8',
  );
  assert.equal((await pending).agents.length, 4);
});

test('fs.watch is taken on every path of the tree and its event drives a pass', async (t) => {
  const dir = await project({ withAgents: true });
  const fired = new Map<string, () => void>();
  const watcher = new SessionTreeWatcher({
    sessionId: SESSION,
    projectDir: dir,
    debounceMs: 20,
    // Long enough that only the watch can deliver the change below.
    pollIntervalMs: 60_000,
    watchFactory: (target, onChange) => {
      fired.set(target, onChange);
      return new FakeWatcher();
    },
  });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  const subagents = path.join(dir, SESSION, 'subagents');
  // The session transcript, the subagents directory, the workflows directory
  // and the one agent transcript the fixture ships. The real `fs.watch` cannot
  // take the workflows directory because it does not exist; a factory that
  // never throws shows the full set the watcher asks for.
  assert.deepEqual([...fired.keys()].sort(), [
    path.join(dir, `${SESSION}.jsonl`),
    subagents,
    path.join(subagents, 'agent-a0000000000000006.jsonl'),
    path.join(subagents, 'workflows'),
  ].sort());

  const pending = nextChange(watcher);
  await writeFile(
    path.join(subagents, 'agent-a0000000000000009.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }),
    'utf8',
  );
  const onChange = fired.get(subagents);
  assert.ok(onChange !== undefined);
  onChange();
  assert.equal((await pending).agents.length, 4);
});

test('a watch that errors is closed and dropped, and the poll carries on alone', async (t) => {
  const dir = await project({ withAgents: true });
  const handles = new Map<string, FakeWatcher>();
  const watcher = new SessionTreeWatcher({
    sessionId: SESSION,
    projectDir: dir,
    pollIntervalMs: 40,
    watchFactory: (target) => {
      const handle = new FakeWatcher();
      handles.set(target, handle);
      return handle;
    },
  });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  const subagents = path.join(dir, SESSION, 'subagents');
  const handle = handles.get(subagents);
  assert.ok(handle !== undefined);

  // What a filesystem that stops supporting the watch looks like from here.
  handle.emit('error', new Error('EPERM'));
  assert.equal(handle.closed, true, 'the dead handle is released, not leaked');
  assert.ok(!watcher.watchedPaths.includes(subagents));

  const pending = nextChange(watcher);
  await writeFile(
    path.join(subagents, 'agent-a0000000000000009.meta.json'),
    JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }),
    'utf8',
  );
  assert.equal(
    (await pending).agents.length,
    4,
    'the poll was already running; nothing had to take over',
  );
});

test('a session with no subagents yet is a valid, empty tree', async (t) => {
  const dir = await project({ withAgents: false });
  const watcher = new SessionTreeWatcher({ sessionId: SESSION, projectDir: dir, watch: false, pollIntervalMs: 60_000 });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  const snapshot = watcher.snapshot();
  assert.deepEqual(snapshot.agents, []);
  assert.deepEqual(snapshot.workflowRuns, []);
  assert.equal(snapshot.filesTailed, 1);
  assert.notEqual(snapshot.tokens, undefined);
});

test('a session whose transcript does not exist yet shows nothing and does not throw', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nazar-tree-empty-'));
  const watcher = new SessionTreeWatcher({ sessionId: SESSION, projectDir: dir, watch: false, pollIntervalMs: 60_000 });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  const snapshot = watcher.snapshot();
  assert.equal(snapshot.tokens, undefined);
  assert.equal(snapshot.lastWriteAt, undefined);
  assert.deepEqual(snapshot.agents, []);
});

test('a truncated transcript is recounted rather than double counted', async (t) => {
  const dir = await project({ withAgents: false });
  const watcher = new SessionTreeWatcher({ sessionId: SESSION, projectDir: dir, watch: false, pollIntervalMs: 60_000 });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  assert.equal((watcher.snapshot().tokens as { out: number }).out, 17371);

  await writeFile(
    path.join(dir, `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: 'assistant',
      requestId: 'req_000000000000000000000001',
      message: { id: 'msg_000000000000000000000001', model: 'claude-opus-5', usage: { output_tokens: 3 } },
    })}\n`,
    'utf8',
  );
  await watcher.refresh();
  assert.equal((watcher.snapshot().tokens as { out: number }).out, 3, 'the old totals were thrown away');
});

test('workflow runs reach the snapshot', async (t) => {
  const dir = await project({ withAgents: true });
  const runDir = path.join(dir, SESSION, 'subagents', 'workflows', 'run-0001');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'agent-a0000000000000010.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', model: 'sonnet', spawnDepth: 1 }),
    'utf8',
  );
  const watcher = new SessionTreeWatcher({ sessionId: SESSION, projectDir: dir, watch: false, pollIntervalMs: 60_000 });
  t.after(async () => {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await watcher.start();
  const snapshot = watcher.snapshot();
  assert.deepEqual(
    snapshot.workflowRuns.map((run) => [run.runId, run.agentIds]),
    [['run-0001', ['a0000000000000010']]],
  );
  assert.equal(
    snapshot.agents.find((agent) => agent.id === 'a0000000000000010')?.workflowRunId,
    'run-0001',
  );
});
