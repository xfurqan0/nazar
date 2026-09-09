/**
 * N-WP17a: the Hermes reader touches three tables and names every column.
 *
 * This sits beside `no-writes.test.ts` and for the same reason. That file makes
 * "Nazar writes nothing" a property of the code rather than a promise in a
 * README; this one does it for the other half of the Hermes bargain — **Nazar
 * reads metadata and nothing else** — which is a much easier promise to break.
 *
 * The whole risk is one file. `state.db` holds a session's identity, its token
 * counters and its working directory in `sessions`; it also holds every message
 * of every conversation in `messages` and every system prompt in
 * `system_prompts`, in the same database, reachable by the same connection.
 * A single `SELECT *`, or one join written to answer "what is it doing right
 * now", turns a metadata reader into a transcript reader in one line — and the
 * runtime test that would catch it is the one nobody writes, because the
 * offending line looks completely reasonable.
 *
 * So this is static, and it is deliberately blunt:
 *
 * 1. No `SELECT *` anywhere in the reader.
 * 2. Every `FROM` and `JOIN` names a table on the allow-list. The message and
 *    system-prompt tables are not on it, and cannot be reached.
 * 3. Every statement's column list is built from the exported constants rather
 *    than written inline, so widening what is read means editing a documented
 *    array — which is a diff somebody has to justify — and not a string.
 * 4. Those constants match docs/pinned-internal-formats.md, which is where the
 *    column-by-column reasoning lives.
 *
 * The prose above is allowed to *name* the tables it refuses to read. The gate
 * is about SQL, not about vocabulary: a comment that says "never touch
 * `messages`" is the documentation this rule needs, and a test that forbade the
 * word would forbid the explanation along with the bug.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HERMES_DELEGATION_COLUMNS,
  HERMES_LEASE_EXPIRY,
  HERMES_LEASE_KEYS,
  HERMES_SESSION_COLUMNS,
  HERMES_TABLES_READ,
} from '../packages/core/src/hermes-state.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const readerPath = path.join(root, 'packages', 'core', 'src', 'hermes-state.ts');
const reader = readFileSync(readerPath, 'utf8');
const pinned = readFileSync(path.join(root, 'docs', 'pinned-internal-formats.md'), 'utf8');

/**
 * Comments removed, so the scan below sees code and not prose.
 *
 * The reader's own doc comments say things like *never joined* and *read from
 * the sessions table*, and a scanner that could not tell those from SQL would
 * force the explanation out of the file to keep the gate quiet — which is
 * exactly backwards. Block comments first, then line comments.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every identifier that appears after `FROM` or `JOIN` in a source file's code. */
export function sqlTables(source: string): string[] {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(
    /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
  )) {
    found.add((match[1] ?? '').toLowerCase());
  }
  return [...found].sort();
}

test('the reader is where it says it is', () => {
  assert.ok(reader.length > 1000, 'the Hermes reader is missing; this gate is now a lie');
});

test('there is no SELECT * in the Hermes reader', () => {
  // Comments stripped, for the reason `stripComments` gives: the file's own
  // note says *there is no `SELECT *` in this file*, and a gate that failed on
  // its own documentation would be a gate whose first effect was to delete the
  // sentence explaining it.
  assert.doesNotMatch(
    stripComments(reader),
    /select\s+\*/i,
    'a SELECT * on state.db reaches the message and system-prompt columns in one line',
  );
});

test('the reader names only the three tables it is allowed to name', () => {
  assert.deepEqual(sqlTables(reader), [...HERMES_TABLES_READ].sort());
});

test('the gate bites: a message join would be caught', () => {
  // The rule is about SQL, so the test is too. A prose mention of the table is
  // not a read of it, and the extractor above has to agree.
  assert.deepEqual(sqlTables('const sql = `SELECT content FROM messages`;'), ['messages']);
  assert.deepEqual(sqlTables('// never touch messages or system_prompts'), []);
  assert.deepEqual(sqlTables('/* read from the messages table? never. */'), []);
  assert.deepEqual(sqlTables('const q = `select id from messages`;'), ['messages']);
  assert.deepEqual(
    sqlTables('SELECT s.id FROM sessions JOIN system_prompts p ON p.hash = s.system_prompt_hash'),
    ['sessions', 'system_prompts'],
  );
});

test('every statement builds its column list from the exported constants', () => {
  // Three statements, three constants. A statement that listed its columns
  // inline would pass the SELECT * check and defeat the point of the arrays.
  for (const built of [
    'SELECT ${HERMES_SESSION_COLUMNS.join(\', \')} FROM sessions',
    'SELECT ${leaseKey}, ${HERMES_LEASE_EXPIRY} FROM session_turn_leases',
    'SELECT ${HERMES_DELEGATION_COLUMNS.join(\', \')} FROM async_delegations',
  ]) {
    assert.ok(reader.includes(built), `the reader no longer builds: ${built}`);
  }
});

test('the lease key is chosen from the schema out of two known names', () => {
  assert.deepEqual([...HERMES_LEASE_KEYS], ['conversation_id', 'session_id']);
  assert.equal(HERMES_LEASE_EXPIRY, 'expires_at');
  assert.ok(
    reader.includes('leaseColumns.has(name)'),
    'the lease key must come from PRAGMA table_info, not from an assumption',
  );
});

test('the session column list carries no free-form column but the title', () => {
  /*
   * The one prose column is `title`, and it is behind the N-WP15a task-text
   * gate. Everything else on the list is an identifier, a counter or a
   * timestamp. The four columns named here are the ones that would each, on
   * their own, put somebody's words on the wire.
   */
  for (const forbidden of ['system_prompt', 'origin_json', 'last_activity_description', 'model_config']) {
    assert.ok(
      !(HERMES_SESSION_COLUMNS as readonly string[]).includes(forbidden),
      `${forbidden} is prose or a blob; it is not on the card`,
    );
  }
  assert.ok((HERMES_SESSION_COLUMNS as readonly string[]).includes('title'));
  assert.ok(
    reader.includes('if (taskText && row.title !== undefined)'),
    'the title is the one prose column and it is gated',
  );
});

test('the delegation read is edges only', () => {
  assert.deepEqual(
    [...HERMES_DELEGATION_COLUMNS],
    ['delegation_id', 'origin_session', 'parent_session_id'],
  );
  for (const forbidden of ['task_json', 'result_json', 'event_json']) {
    assert.ok(
      !(HERMES_DELEGATION_COLUMNS as readonly string[]).includes(forbidden),
      `${forbidden} is model or user text on the same row`,
    );
  }
});

test('every column the reader reads is in docs/pinned-internal-formats.md', () => {
  const index = pinned.indexOf('## Hermes (N-WP17a)');
  assert.ok(index > 0, 'the Hermes section is where the column-by-column reasoning lives');
  const section = pinned.slice(index);
  for (const column of [
    ...HERMES_SESSION_COLUMNS,
    ...HERMES_LEASE_KEYS,
    HERMES_LEASE_EXPIRY,
    ...HERMES_DELEGATION_COLUMNS,
  ]) {
    assert.ok(section.includes(column), `${column} is read and is not in the pinned table`);
  }
  for (const table of HERMES_TABLES_READ) {
    assert.ok(section.includes(table), `${table} is read and is not in the pinned table`);
  }
});

test('the pinned section says which tables are never opened', () => {
  const index = pinned.indexOf('## Hermes (N-WP17a)');
  const section = pinned.slice(index);
  for (const table of ['messages', 'system_prompts']) {
    assert.ok(
      section.includes(table),
      `${table} is in the same file and must be named as one Nazar does not read`,
    );
  }
});
