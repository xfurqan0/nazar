/**
 * N-WP18: the Codex rollout reader.
 *
 * Three things are worth testing here and the rest follows from them:
 *
 * 1. **The parser reads a closed list of fields and nothing else.** The
 *    fixtures deliberately still carry the command, the output, the diff and
 *    the system prompt, so a leak test over the emitted events is a real test
 *    rather than a tautology.
 * 2. **The verdicts are the ones the audit found on disk**, not the ones the
 *    Claude Code side happens to produce: an open turn is `busy`, a lock is the
 *    whole of `alive`, and `waiting` is unreachable.
 * 3. **The tailer discipline holds.** A rollout is read once, incrementally,
 *    and appending to it costs only the appended bytes.
 *
 * Every test runs over a temporary store. Nothing here touches `~/.codex`, and
 * `test/no-writes.test.ts` is what proves the shipped code cannot write to it.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CodexRollout,
  CodexSessions,
  extractCodexLine,
  readCodexStore,
  threadIdFromLockName,
  threadIdFromRolloutName,
} from '../src/codex-rollout.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'codex');

const THREAD = '00000000-0000-7000-8000-000000000001';
const CHILD = '00000000-0000-7000-8000-000000000002';
const NOW = 1_788_756_000_000;

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

/**
 * A temporary Codex store: `<root>/sessions/2026/09/09` plus a lock directory.
 * The date is the fixture's own, which is what makes the day walk meaningful.
 */
async function store(): Promise<{
  readonly root: string;
  readonly sessionsDir: string;
  readonly locksDir: string;
  readonly dayDir: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'nazar-codex-'));
  const sessionsDir = path.join(root, 'sessions');
  const dayDir = path.join(sessionsDir, '2026', '09', '09');
  const locksDir = path.join(root, 'thread-writer-locks');
  await mkdir(dayDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });
  return { root, sessionsDir, locksDir, dayDir };
}

async function put(dayDir: string, name: string, fixtureName: string): Promise<string> {
  const file = path.join(dayDir, name);
  await writeFile(file, await fixture(fixtureName), 'utf8');
  return file;
}

async function lock(locksDir: string, threadId: string): Promise<void> {
  await writeFile(path.join(locksDir, `${threadId}.lock`), '', 'utf8');
}

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

test('a rollout name gives up the thread id, and a forked one gives up the child', () => {
  assert.equal(threadIdFromRolloutName(`rollout-2026-09-09T04-00-00-${THREAD}.jsonl`), THREAD);
  // A thread forked out of another is named `<parent>_<child>`; the file is the
  // child's, so the child is the id.
  assert.equal(
    threadIdFromRolloutName(`rollout-2026-09-09T04-00-00-${THREAD}_${CHILD}.jsonl`),
    CHILD,
  );
  assert.equal(threadIdFromRolloutName('rollout-nothing-uuid-shaped.jsonl'), undefined);
  assert.equal(threadIdFromRolloutName('auth.json'), undefined);
  assert.equal(threadIdFromRolloutName(`${THREAD}.jsonl`), undefined);
});

test('a lock name gives up the thread id, and the global lock is skipped', () => {
  assert.equal(threadIdFromLockName(`${THREAD}.lock`), THREAD);
  // Codex's own coordination lock is not a thread and outlives every session.
  assert.equal(threadIdFromLockName('.coordination.lock'), undefined);
  assert.equal(threadIdFromLockName('notalock'), undefined);
});

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

test('the parser never throws, whatever it is handed', () => {
  for (const raw of ['', '{', 'null', '[]', '"a string"', '{"type":"session_meta"}', '{"payload":1}']) {
    assert.doesNotThrow(() => extractCodexLine(raw));
  }
});

test('session_meta gives the thread its identity and nothing more', async () => {
  const [first] = (await fixture('rollout-closed.jsonl')).split('\n');
  const event = extractCodexLine(first ?? '');
  assert.equal(event?.kind, 'session_meta');
  assert.equal(event?.threadId, THREAD);
  assert.equal(event?.cwd, '/proj/demo');
  assert.equal(event?.version, '0.0.0');
  assert.equal(event?.origin, 'exec');
  // The model on `session_meta` is only what the base instructions were
  // provenanced from; the real one comes from `turn_context`.
  assert.equal(event?.model, 'gpt-0-demo');
  // And the base instructions themselves are the system prompt.
  assert.equal(JSON.stringify(event).includes('redacted'), false);
});

test('a subagent rollout names its parent thread', async () => {
  const [first] = (await fixture('rollout-subagent.jsonl')).split('\n');
  const event = extractCodexLine(first ?? '');
  assert.equal(event?.threadId, CHILD);
  assert.equal(event?.parentThreadId, THREAD);
  assert.equal(event?.origin, 'subagent');
});

test("Codex's cumulative counters become Nazar's four, with the cache read taken out", async () => {
  const lines = (await fixture('rollout-closed.jsonl')).split('\n').filter((l) => l.length > 0);
  const tokens = lines
    .map((line) => extractCodexLine(line))
    .filter((event) => event?.kind === 'tokens')
    .at(-1)?.tokens;

  // The fixture's totals are 42000 in / 38400 cached / 0 written / 1800 out.
  // Codex's `input_tokens` *includes* the cached read where Claude Code's does
  // not, so the fresh input is the subtraction: 42000 - 38400.
  assert.deepEqual(tokens, { in: 3600, out: 1800, cacheRead: 38400, cacheWrite: 0 });
});

test('the human turn is unreadable unless the caller asked for it', async () => {
  const line = (await fixture('rollout-closed.jsonl'))
    .split('\n')
    .find((one) => one.includes('"role":"user"'));
  assert.ok(line !== undefined);

  // Off: the line produces no event at all, which is what makes `--no-task-text`
  // a switch on a code path rather than a filter over its output.
  assert.equal(extractCodexLine(line), undefined);

  const asked = extractCodexLine(line, { taskText: true });
  assert.equal(asked?.kind, 'user_turn');
  assert.equal(asked?.taskText, 'task placeholder');
});

test("Codex's own injections are stripped, so a turn of harness is no task", async () => {
  const line = (await fixture('rollout-open.jsonl'))
    .split('\n')
    .find((one) => one.includes('environment_context'));
  assert.ok(line !== undefined);
  // The block is the whole of that turn, so nothing readable is left and the
  // answer is no task rather than a paragraph of harness.
  assert.equal(extractCodexLine(line, { taskText: true }), undefined);
});

/* ------------------------------------------------------------------ *
 * One rollout
 * ------------------------------------------------------------------ */

test('a finished rollout reads as a closed turn with its tools counted', async () => {
  const { root, dayDir } = await store();
  try {
    const file = await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-closed.jsonl');
    const rollout = new CodexRollout(file, { taskText: true });
    await rollout.read();
    const facts = rollout.facts();

    assert.equal(facts.threadId, THREAD);
    assert.equal(facts.cwd, '/proj/demo');
    // `turn_context` wins over `session_meta`: it is the model that answered.
    assert.equal(facts.model, 'gpt-0-demo');
    assert.equal(facts.effort, 'high');
    assert.equal(facts.openTurns, 0, 'every turn in this file was completed');
    assert.equal(facts.sawTurn, true);
    assert.equal(facts.toolCalls, 1);
    assert.equal(facts.currentTool, undefined, 'nothing is running: the call got its output');
    assert.equal(facts.task, 'task placeholder');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unfinished rollout keeps its turn open and names the tool still out', async () => {
  const { root, dayDir } = await store();
  try {
    const file = await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-open.jsonl');
    const rollout = new CodexRollout(file, { taskText: true });
    await rollout.read();
    const facts = rollout.facts();

    assert.equal(facts.openTurns, 1);
    assert.equal(facts.toolCalls, 3);
    assert.equal(facts.currentTool, 'exec', 'the third call never got its output');
    // The **last** human turn, not the first: a thread open for an hour is not
    // still doing what it was opened for.
    assert.equal(facts.task, 'second task placeholder');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an MCP call sharpens the tool name from `exec` to what actually ran', async () => {
  const { root, dayDir } = await store();
  try {
    const file = await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-open.jsonl');
    // Read only as far as the MCP item, by writing a prefix of the file: Codex
    // routes shell, patch and MCP through one custom tool called `exec`, so the
    // call's own name says nothing and the completed item is where the name is.
    const lines = (await fixture('rollout-open.jsonl')).split('\n').filter((l) => l.length > 0);
    const upToMcp = lines.slice(0, lines.findIndex((line) => line.includes('McpToolCall')) + 1);
    await writeFile(file, `${upToMcp.join('\n')}\n`, 'utf8');

    const rollout = new CodexRollout(file);
    await rollout.read();
    assert.equal(rollout.facts().currentTool, 'search');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rollout is read once: appending costs only the appended bytes', async () => {
  const { root, dayDir } = await store();
  try {
    const file = await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-closed.jsonl');
    const rollout = new CodexRollout(file);
    await rollout.read();
    const first = rollout.bytesRead;
    assert.ok(first > 0);

    await rollout.read();
    assert.equal(rollout.bytesRead, first, 'a second pass over an unchanged file reads nothing');

    const line = `${JSON.stringify({
      timestamp: '2026-09-09T04:10:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'later' },
    })}\n`;
    await appendFile(file, line, 'utf8');
    await rollout.read();
    assert.equal(rollout.bytesRead, first + Buffer.byteLength(line));
    assert.equal(rollout.facts().openTurns, 1, 'the appended turn is open');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the parser emits no prompt, no command and no output, over every fixture', async () => {
  /*
   * The leak test. The fixtures still carry `stdout`, `stderr`, `command`,
   * `arguments`, `aggregated_output`, `last_agent_message` and the base
   * instructions — all of them as the literal string `[redacted]` — so if any
   * of those fields reached an event, that string would show up in the dump.
   * With task text on, the only readable string that may survive is the human
   * turn's own placeholder.
   */
  for (const name of ['rollout-open.jsonl', 'rollout-closed.jsonl', 'rollout-subagent.jsonl']) {
    const lines = (await fixture(name)).split('\n').filter((line) => line.length > 0);
    const events = lines
      .map((line) => extractCodexLine(line, { taskText: true }))
      .filter((event) => event !== undefined);
    const dump = JSON.stringify(events);
    assert.equal(dump.includes('[redacted]'), false, `${name}: a redacted field reached an event`);
    assert.equal(dump.includes('environment_context'), false, `${name}: harness text survived`);
  }
});

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

test('a locked thread is alive; an unlocked, quiet one is unknown and then gone', async () => {
  const { root, sessionsDir, locksDir, dayDir } = await store();
  try {
    await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-open.jsonl');
    await lock(locksDir, THREAD);

    // The clock has to sit on the *file's* timeline: the rollout was written a
    // moment ago with a real mtime, and the silence window is measured against
    // it. A frozen NOW in the past would make every write look like the future.
    let clock = Date.now();
    const codex = new CodexSessions({
      sessionsDir,
      locksDir,
      watch: false,
      silenceMs: 1000,
      now: () => clock,
    });
    await codex.refresh();

    const [session] = codex.snapshot();
    assert.ok(session !== undefined);
    assert.equal(session.provider, 'codex');
    assert.equal(session.id, THREAD);
    assert.equal(session.pid, 0, 'a rollout names no process');
    assert.equal(session.state, 'alive', 'the lock is the whole of alive');
    assert.equal(session.status, 'busy', 'a turn is open');
    assert.equal(session.cwd, '/proj/demo');
    assert.equal(session.model, 'gpt-0-demo');
    assert.equal(session.toolCalls, 3);
    assert.equal(session.currentTool, 'exec');
    assert.equal(session.agents.length, 0, 'a Codex thread never nests another one');

    // Release the lock. The file has not been appended to for longer than the
    // silence window, so the thread is `unknown` for one window and then gone.
    await rm(path.join(locksDir, `${THREAD}.lock`));
    clock = Date.now() + 5000;
    await codex.refresh();
    assert.equal(codex.snapshot()[0]?.state, 'unknown', 'never promoted back to alive');

    clock = Date.now() + 20_000;
    await codex.refresh();
    assert.equal(codex.snapshot().length, 0, 'one window of "we no longer know", then dropped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a closed rollout is idle, and never waiting', async () => {
  const { root, sessionsDir, locksDir, dayDir } = await store();
  try {
    await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-closed.jsonl');
    await lock(locksDir, THREAD);
    const codex = new CodexSessions({ sessionsDir, locksDir, watch: false, now: () => NOW });
    await codex.refresh();

    const [session] = codex.snapshot();
    assert.equal(session?.status, 'idle');
    // Codex records the approval *policy* and never the request, so this status
    // is unreachable and the banner is never drawn for a Codex card.
    assert.notEqual(session?.status, 'waiting');
    assert.equal(session?.waitingFor, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a spawned thread is a card of its own, beside its parent', async () => {
  const { root, sessionsDir, locksDir, dayDir } = await store();
  try {
    await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-open.jsonl');
    await put(
      dayDir,
      `rollout-2026-09-09T04-00-01-${THREAD}_${CHILD}.jsonl`,
      'rollout-subagent.jsonl',
    );
    await lock(locksDir, THREAD);
    await lock(locksDir, CHILD);

    const codex = new CodexSessions({ sessionsDir, locksDir, watch: false, now: () => NOW });
    await codex.refresh();

    const ids = codex.snapshot().map((session) => session.id).sort();
    assert.deepEqual(ids, [THREAD, CHILD].sort());
    for (const session of codex.snapshot()) {
      assert.equal(session.agents.length, 0, 'siblings, not children');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rollout that was already cold when it was first seen gets no card', async () => {
  const { root, sessionsDir, locksDir, dayDir } = await store();
  try {
    // The store keeps a week of threads and nearly all of them are finished.
    // The default answer for a rollout is *no card*: only the lock, or bytes
    // arriving right now, puts one on the canvas.
    await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-closed.jsonl');
    const codex = new CodexSessions({
      sessionsDir,
      locksDir,
      watch: false,
      // The file was written a moment ago, so the window has to be moved rather
      // than the clock: this asks "what does a thread last written an hour ago
      // look like", which is what 17 of the 18 rollouts on a real machine are.
      silenceMs: 0,
      now: () => Date.now() + 3_600_000,
    });
    await codex.refresh();
    assert.deepEqual([...codex.snapshot()], [], 'a finished thread is history, not a card');
    assert.equal(codex.scan().rollouts, 1, 'it is still listed; it is just not drawn');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a machine with no Codex reports "not installed" rather than failing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nazar-codex-'));
  try {
    const { scan, sessions } = await readCodexStore({
      sessionsDir: path.join(root, 'sessions'),
      locksDir: path.join(root, 'thread-writer-locks'),
    });
    assert.equal(scan.configured, false);
    assert.equal(scan.locksConfigured, false);
    assert.equal(scan.rollouts, 0);
    assert.deepEqual([...sessions], []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the scan counts what doctor prints', async () => {
  const { root, sessionsDir, locksDir, dayDir } = await store();
  try {
    await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-open.jsonl');
    await put(dayDir, `rollout-2026-09-09T04-00-01-${CHILD}.jsonl`, 'rollout-closed.jsonl');
    await lock(locksDir, THREAD);
    // Codex's own global lock is not a thread and must not be counted as one.
    await writeFile(path.join(locksDir, '.coordination.lock'), '', 'utf8');

    const { scan } = await readCodexStore({ sessionsDir, locksDir, now: () => NOW });
    assert.equal(scan.configured, true);
    assert.equal(scan.locksConfigured, true);
    assert.equal(scan.rollouts, 2);
    assert.equal(scan.locks, 1);
    assert.equal(scan.warnings, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file with no session_meta yet produces no card', async () => {
  const { root, sessionsDir, locksDir, dayDir } = await store();
  try {
    // Codex creates the file and writes its first line a moment later. Half a
    // rollout is not a session, and a card keyed on a guessed id would be worse
    // than no card.
    await writeFile(path.join(dayDir, 'rollout-2026-09-09T04-00-00-nothing.jsonl'), '', 'utf8');
    const codex = new CodexSessions({ sessionsDir, locksDir, watch: false, now: () => NOW });
    await codex.refresh();
    assert.deepEqual([...codex.snapshot()], []);
    assert.equal(codex.scan().rollouts, 1, 'the file is listed, it just says nothing yet');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stray file in the date tree does not break the pass', async () => {
  const { root, sessionsDir, locksDir, dayDir } = await store();
  try {
    // The tree belongs to another program. A file where a year directory is
    // expected must not reject the pass — which, through `NazarState.start()`,
    // would take the whole canvas with it.
    await writeFile(path.join(sessionsDir, 'notes.txt'), 'x', 'utf8');
    await put(dayDir, `rollout-2026-09-09T04-00-00-${THREAD}.jsonl`, 'rollout-open.jsonl');
    await lock(locksDir, THREAD);

    const codex = new CodexSessions({ sessionsDir, locksDir, watch: false, now: () => Date.now() });
    await assert.doesNotReject(codex.refresh());
    assert.equal(codex.snapshot().length, 1, 'the readable half is still read');
    assert.equal(codex.scan().configured, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the day walk is bounded, newest first', async () => {
  const { root, sessionsDir, locksDir } = await store();
  try {
    // Ten days, one rollout each. The store gains a directory a day for as long
    // as Codex is installed, and the canvas only ever draws open threads.
    for (let day = 1; day <= 10; day += 1) {
      const dir = path.join(sessionsDir, '2026', '09', String(day).padStart(2, '0'));
      await mkdir(dir, { recursive: true });
      await put(dir, `rollout-2026-09-0${1}T04-00-00-${THREAD}.jsonl`, 'rollout-closed.jsonl');
    }
    const codex = new CodexSessions({ sessionsDir, locksDir, watch: false, days: 3, now: () => NOW });
    await codex.refresh();
    assert.equal(codex.scan().rollouts, 3, 'three days back, not ten');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
