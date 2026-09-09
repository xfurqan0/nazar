/**
 * N-WP17a: the Hermes reader, against a database this test builds.
 *
 * **No binary fixture is committed.** A real `state.db` is 40 MB of somebody's
 * conversations, and a sanitised one would be a file nobody could check by
 * reading. So every case below writes its own database with `node:sqlite` — the
 * same module the reader loads — into a temporary directory, which makes the
 * schema in the test the schema under test and leaves nothing behind.
 *
 * A runtime without `node:sqlite` skips these rather than failing: the reader's
 * whole contract on such a machine is "disabled, with a reason", and that is
 * asserted separately in the one case that does not need a database.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ENDED_WINDOW_MS,
  HERMES_DELEGATION_COLUMNS,
  HERMES_SESSION_COLUMNS,
  HermesReader,
  discoverHermesSources,
  hermesHomeDir,
  hermesSessionId,
  loadSqlite,
  readOnlyUri,
  toEpochMs,
} from '../src/hermes-state.ts';

const NOW = 1_788_000_000_000;
const SECOND = 1000;

/** Seconds since the epoch, which is how Hermes was observed writing time. */
function secs(ms: number): number {
  return Math.round(ms / 1000);
}

interface Row {
  readonly id: string;
  readonly title?: string;
  readonly model?: string;
  readonly source?: string;
  readonly parent?: string;
  readonly cwd?: string;
  readonly tokens?: readonly [number, number, number, number, number];
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly lastActivityAt?: number;
  readonly toolCalls?: number;
}

interface Lease {
  readonly id: string;
  readonly expiresAt: number;
}

/**
 * Write a `state.db` with the three tables the reader reads and the two it
 * refuses to.
 *
 * `messages` and `system_prompts` are created **on purpose**: a reader that
 * only passes because the forbidden tables were not there would prove nothing.
 * They are filled with text that would be unmistakable in any output.
 */
async function makeDb(
  file: string,
  rows: readonly Row[],
  leases: readonly Lease[] = [],
  delegations: ReadonlyArray<readonly [string, string]> = [],
  leaseKey: 'conversation_id' | 'session_id' = 'conversation_id',
): Promise<void> {
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(file);
  /*
   * The counters and the timestamps are declared `INTEGER` and the rest `TEXT`,
   * which is the shape a session store has. It matters: SQLite affinity decides
   * what comes back out of a column, and a reader tested only against `TEXT`
   * would be a reader that had never seen a number.
   */
  const numeric = new Set([
    'message_count',
    'tool_call_count',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'started_at',
    'ended_at',
    'last_activity_at',
  ]);
  db.exec(
    `CREATE TABLE sessions (${HERMES_SESSION_COLUMNS.map(
      (column) => `${column} ${numeric.has(column) ? 'INTEGER' : 'TEXT'}`,
    ).join(', ')})`,
  );
  db.exec(`CREATE TABLE session_turn_leases (${leaseKey} TEXT, holder TEXT, acquired_at INTEGER, expires_at INTEGER)`);
  db.exec(
    `CREATE TABLE async_delegations (${HERMES_DELEGATION_COLUMNS.join(' TEXT, ')} TEXT, task_json TEXT, result_json TEXT)`,
  );
  db.exec('CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, content TEXT)');
  db.exec('CREATE TABLE system_prompts (hash TEXT, body TEXT)');
  db.exec("INSERT INTO messages VALUES ('m1','s1','user','SECRET-PROMPT-TEXT')");
  db.exec("INSERT INTO system_prompts VALUES ('h1','SECRET-SYSTEM-PROMPT')");

  const insert = db.prepare(
    `INSERT INTO sessions (${HERMES_SESSION_COLUMNS.join(', ')}) VALUES (${HERMES_SESSION_COLUMNS.map(() => '?').join(', ')})`,
  );
  for (const row of rows) {
    const tokens = row.tokens ?? [0, 0, 0, 0, 0];
    insert.run(
      row.id,
      row.title ?? null,
      row.model ?? null,
      row.source ?? 'cli',
      row.parent ?? null,
      row.cwd ?? null,
      null,
      null,
      row.toolCalls ?? null,
      tokens[0],
      tokens[1],
      tokens[2],
      tokens[3],
      tokens[4],
      row.startedAt === undefined ? null : secs(row.startedAt),
      row.endedAt === undefined ? null : secs(row.endedAt),
      row.lastActivityAt === undefined ? null : secs(row.lastActivityAt),
    );
  }

  const lease = db.prepare(
    `INSERT INTO session_turn_leases (${leaseKey}, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)`,
  );
  for (const one of leases) lease.run(one.id, 'gateway', secs(NOW), secs(one.expiresAt));

  const delegate = db.prepare(
    `INSERT INTO async_delegations (${HERMES_DELEGATION_COLUMNS.join(', ')}, task_json, result_json) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [child, parent] of delegations) {
    delegate.run(`d-${child}`, child, parent, '{"task":"SECRET"}', '{"result":"SECRET"}');
  }
  db.close();
}

/** A temporary Hermes home, and the reader over it. Cleaned up by the caller. */
async function scratch(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'nazar-hermes-'));
}

const sqliteHere = (await loadSqlite()) !== undefined;
const withDb = { skip: sqliteHere ? false : 'node:sqlite is not available on this runtime' };

/* ------------------------------------------------------------------ *
 * The parts that need no database
 * ------------------------------------------------------------------ */

test('HERMES_HOME moves the whole installation', () => {
  assert.equal(hermesHomeDir({ HERMES_HOME: '/srv/h' }, '/home/x'), '/srv/h');
  assert.equal(hermesHomeDir({}, path.join('/home', 'x')), path.join('/home', 'x', '.hermes'));
  // An empty variable is not a configured one.
  assert.equal(hermesHomeDir({ HERMES_HOME: '' }, path.join('/home', 'x')), path.join('/home', 'x', '.hermes'));
});

test('every connection is a read-only URI', () => {
  const uri = readOnlyUri(path.join('a', 'b', 'state.db'));
  assert.ok(uri.startsWith('file:'));
  assert.ok(uri.endsWith('?mode=ro'));
  assert.ok(!uri.includes('\\'), 'a backslash in a SQLite URI is not a separator');
  // The three characters that would end a path early inside a URI.
  assert.ok(readOnlyUri('a?b#c%d.db').includes('%3f'));
});

test('a timestamp is read as seconds, milliseconds or a date, and never guessed', () => {
  assert.equal(toEpochMs(secs(NOW)), NOW);
  assert.equal(toEpochMs(NOW), NOW);
  assert.equal(toEpochMs('2026-09-09T00:00:00Z'), Date.parse('2026-09-09T00:00:00Z'));
  for (const value of [null, undefined, 0, -1, 'later', {}]) {
    assert.equal(toEpochMs(value), undefined, `${JSON.stringify(value)} is not a timestamp`);
  }
});

test('a Hermes id is namespaced by profile, because two profiles can share one', () => {
  assert.equal(hermesSessionId('default', 'abc'), 'hermes:default:abc');
  assert.notEqual(hermesSessionId('default', 'abc'), hermesSessionId('other', 'abc'));
});

test('a machine with no Hermes is an empty scan, not an error', async () => {
  const dir = await scratch();
  try {
    assert.deepEqual(await discoverHermesSources(path.join(dir, 'nope')), []);
    const reader = new HermesReader({ homeDir: path.join(dir, 'nope'), now: () => NOW });
    await reader.start();
    reader.stop();
    const scan = reader.snapshot();
    assert.deepEqual(scan.sources, []);
    assert.deepEqual(scan.sessions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Against a real database
 * ------------------------------------------------------------------ */

test('the default profile and every named one is its own source', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(path.join(dir, 'state.db'), [{ id: 'a' }]);
    await mkdir(path.join(dir, 'profiles', 'work'), { recursive: true });
    await makeDb(path.join(dir, 'profiles', 'work', 'state.db'), [{ id: 'a' }]);
    // A profile directory with no database in it is not a source.
    await mkdir(path.join(dir, 'profiles', 'empty'), { recursive: true });
    // Neither is a stray file next to the databases.
    await writeFile(path.join(dir, 'notes.txt'), 'x', 'utf8');

    const found = await discoverHermesSources(dir);
    assert.deepEqual(
      found.map((ref) => ref.profile),
      ['default', 'work'],
    );

    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    assert.equal(scan.available, true);
    assert.deepEqual(
      scan.sources.map((source) => source.state),
      ['ok', 'ok'],
    );
    // The same session id in two profiles is two cards, not one.
    assert.deepEqual(
      scan.sessions.map((session) => session.id),
      ['hermes:default:a', 'hermes:work:a'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live lease is running, a stale one is not, and an ended session is over', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(
      path.join(dir, 'state.db'),
      [
        { id: 'running', startedAt: NOW - 60 * SECOND, lastActivityAt: NOW - SECOND },
        { id: 'idle', startedAt: NOW - 60 * SECOND, lastActivityAt: NOW - 30 * SECOND },
        { id: 'stale', startedAt: NOW - 60 * SECOND, lastActivityAt: NOW - 40 * SECOND },
        { id: 'over', startedAt: NOW - 600 * SECOND, endedAt: NOW - 60 * SECOND },
      ],
      [
        { id: 'running', expiresAt: NOW + 200 * SECOND },
        // Hermes never sweeps this table: the installation this was written
        // against held three leases that had expired three weeks earlier.
        { id: 'stale', expiresAt: NOW - 21 * 24 * 3600 * SECOND },
      ],
    );
    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    const by = new Map(scan.sessions.map((session) => [session.id, session]));

    assert.equal(by.get('hermes:default:running')?.status, 'busy');
    assert.equal(by.get('hermes:default:running')?.state, 'alive');
    assert.equal(by.get('hermes:default:idle')?.status, 'idle');
    assert.equal(by.get('hermes:default:stale')?.status, 'idle', 'an expired lease is not a running turn');
    assert.equal(by.get('hermes:default:over')?.state, 'unknown');

    // Never, on any of them: Hermes writes no waiting signal to any file.
    for (const session of scan.sessions) {
      assert.notEqual(session.status, 'waiting');
      assert.equal(session.waitingFor, undefined);
      assert.equal(session.provider, 'hermes');
      assert.equal(session.pid, 0, 'a Hermes session has no process to jump to');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a session that ended long ago is not drawn; one that just ended is', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(path.join(dir, 'state.db'), [
      { id: 'ancient', startedAt: NOW - 90000 * SECOND, endedAt: NOW - DEFAULT_ENDED_WINDOW_MS - SECOND },
      { id: 'recent', startedAt: NOW - 900 * SECOND, endedAt: NOW - 60 * SECOND },
      { id: 'open', startedAt: NOW - 90 * SECOND },
    ]);
    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    assert.deepEqual(
      scan.sessions.map((session) => session.id),
      ['hermes:default:recent', 'hermes:default:open'],
      'the canvas is the live picture plus what just finished, not the whole history',
    );
    // The source still reports every row it read: the window is a drawing
    // decision, and doctor should not be told a database is smaller than it is.
    assert.equal(scan.sources[0]?.sessions, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subagents hang off their parent at the depth the chain gives them', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(
      path.join(dir, 'state.db'),
      [
        { id: 'root', startedAt: NOW - 300 * SECOND, lastActivityAt: NOW - SECOND },
        { id: 'kid', source: 'subagent', parent: 'root', startedAt: NOW - 200 * SECOND },
        { id: 'grandkid', source: 'subagent', parent: 'kid', startedAt: NOW - 100 * SECOND },
      ],
      [{ id: 'kid', expiresAt: NOW + 100 * SECOND }],
    );
    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    assert.equal(scan.sessions.length, 1, 'a subagent is a node under a card, not a card');
    const session = scan.sessions[0]!;
    assert.equal(session.agents.length, 2);
    const depths = new Map(session.agents.map((agent) => [agent.id, agent.spawnDepth]));
    assert.equal(depths.get('hermes:default:kid'), 1);
    assert.equal(depths.get('hermes:default:grandkid'), 2);

    assert.equal(session.roots.length, 1);
    assert.equal(session.roots[0]?.agent.id, 'hermes:default:kid');
    assert.equal(session.roots[0]?.agent.state, 'running', 'a live lease is a running agent');
    assert.equal(session.roots[0]?.children[0]?.agent.id, 'hermes:default:grandkid');
    assert.equal(
      session.roots[0]?.children[0]?.agent.state,
      'unknown',
      'no lease and no end is not a guess in either direction',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a delegation supplies the edge a session row left empty', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(
      path.join(dir, 'state.db'),
      [
        { id: 'root', startedAt: NOW - 300 * SECOND },
        { id: 'async', source: 'subagent', startedAt: NOW - 100 * SECOND },
      ],
      [],
      [['async', 'root']],
    );
    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0]?.agents[0]?.id, 'hermes:default:async');
    assert.equal(scan.sessions[0]?.agents[0]?.parentAgentId, 'hermes:default:root');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a parent cycle is dropped rather than followed forever', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(path.join(dir, 'state.db'), [
      { id: 'a', source: 'subagent', parent: 'b', startedAt: NOW - 100 * SECOND },
      { id: 'b', source: 'subagent', parent: 'a', startedAt: NOW - 100 * SECOND },
    ]);
    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    assert.deepEqual(scan.sessions, [], 'two sessions each claiming the other as parent draw nothing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the lease key is taken from the schema, not assumed', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(
      path.join(dir, 'state.db'),
      [{ id: 'one', startedAt: NOW - 60 * SECOND }],
      [{ id: 'one', expiresAt: NOW + 100 * SECOND }],
      [],
      'session_id',
    );
    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    assert.equal(scan.sessions[0]?.status, 'busy');
    assert.equal(scan.sources[0]?.running, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the title crosses only when task text is on, and never otherwise', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(path.join(dir, 'state.db'), [
      { id: 'one', title: 'rewrite the importer', startedAt: NOW - 60 * SECOND },
      { id: 'kid', source: 'subagent', parent: 'one', title: 'find the leak', startedAt: NOW - 30 * SECOND },
    ]);

    const off = await new HermesReader({ homeDir: dir, now: () => NOW }).scan();
    assert.equal(off.sessions[0]?.task, undefined, "Hermes's own summary of a conversation is still prose");
    assert.equal(off.sessions[0]?.agents[0]?.task, undefined);
    assert.ok(!JSON.stringify(off).includes('rewrite the importer'));

    const on = await new HermesReader({ homeDir: dir, taskText: true, now: () => NOW }).scan();
    assert.equal(on.sessions[0]?.task, 'rewrite the importer');
    assert.equal(on.sessions[0]?.agents[0]?.task, 'find the leak');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the five token counters are copied by name and nothing is invented', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(path.join(dir, 'state.db'), [
      { id: 'one', startedAt: NOW - 60 * SECOND, tokens: [11, 22, 33, 44, 55], toolCalls: 7 },
      {
        id: 'kid',
        source: 'subagent',
        parent: 'one',
        startedAt: NOW - 30 * SECOND,
        tokens: [1, 2, 3, 4, 5],
      },
    ]);
    const scan = await new HermesReader({ homeDir: dir, now: () => NOW }).scan();
    const session = scan.sessions[0]!;
    assert.deepEqual(session.tokens, { in: 11, out: 22, cacheRead: 33, cacheWrite: 44 });
    // `reasoning_tokens` is read and deliberately not mapped: Nazar's `out` is
    // output tokens, and folding a fifth counter into it would invent a number
    // no source reported. See the module note and the pinned formats table.
    assert.equal(JSON.stringify(session.tokens).includes('55'), false);
    assert.deepEqual(session.treeTokens, { in: 12, out: 24, cacheRead: 36, cacheWrite: 48 });
    assert.equal(session.toolCalls, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing from the message or system-prompt tables reaches a card', withDb, async () => {
  const dir = await scratch();
  try {
    await makeDb(
      path.join(dir, 'state.db'),
      [{ id: 'one', title: 'a title', startedAt: NOW - 60 * SECOND }],
      [],
      [['kid', 'one']],
    );
    // With task text on as well, which is the widest the reader ever opens.
    const scan = await new HermesReader({ homeDir: dir, taskText: true, now: () => NOW }).scan();
    const serialised = JSON.stringify(scan);
    assert.ok(!serialised.includes('SECRET-PROMPT-TEXT'));
    assert.ok(!serialised.includes('SECRET-SYSTEM-PROMPT'));
    assert.ok(!serialised.includes('SECRET'), 'no delegation payload either');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a database it cannot read is one unknown source, not a crash', withDb, async () => {
  const dir = await scratch();
  try {
    // A file with the right name and the wrong bytes: the shape of a Hermes
    // upgrade that moved the schema, or of a half-copied file.
    await writeFile(path.join(dir, 'state.db'), 'this is not a database', 'utf8');
    const reader = new HermesReader({ homeDir: dir, now: () => NOW });
    const scan = await reader.scan();
    assert.equal(scan.available, true);
    assert.equal(scan.sources.length, 1);
    assert.equal(scan.sources[0]?.state, 'unknown');
    assert.ok((scan.sources[0]?.error ?? '').length > 0);
    assert.deepEqual(scan.sessions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the reader writes nothing to the database it read', withDb, async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, 'state.db');
    await makeDb(file, [{ id: 'one', startedAt: NOW - 60 * SECOND }]);
    const { statSync } = await import('node:fs');
    const before = statSync(file);
    await new HermesReader({ homeDir: dir, now: () => NOW }).scan();
    const after = statSync(file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs, 'a read-only connection does not touch mtime');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
