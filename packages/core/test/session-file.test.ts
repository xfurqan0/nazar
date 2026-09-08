/**
 * Reader for `~/.claude/sessions/<pid>.json`.
 *
 * The load-bearing test here is the key-file skip. The sessions directory holds
 * `<pid>.<hash>.key` files next to the JSON, they are credential material, and
 * Nazar must never open one. The reader's only defence is the file-name gate,
 * so the gate is tested from both sides: names that must be rejected, and a
 * real directory where a key file's contents must not turn up anywhere, not
 * even as a parse warning.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isSessionFileName, parseSessionFile, pidFromSessionFileName, readSessionsDir } from '../src/session-file.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'sessions');

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'nazar-sessions-'));
}

test('the file-name gate accepts only <digits>.json', () => {
  for (const name of ['1.json', '1001.json', '15592.json']) {
    assert.equal(isSessionFileName(name), true, `${name} should be a session file`);
  }
  for (const name of [
    // A key file. This is the one that matters.
    '1001.0000000000000000000000000000000000000000000000000000000000000000.key',
    '1001.key',
    '1001.json.bak',
    '1001.JSON',
    'session.json',
    '.json',
    '',
    '1001',
    'a1001.json',
    '1001 .json',
  ]) {
    assert.equal(isSessionFileName(name), false, `${name} should not be a session file`);
  }
});

test('a key file sitting next to a session file is never opened', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const secret = 'THIS-IS-CREDENTIAL-MATERIAL-AND-NOT-JSON';
  await writeFile(path.join(dir, '1001.json'), readFileSync(path.join(fixturesDir, '1001.json'), 'utf8'));
  await writeFile(
    path.join(dir, `1001.${'0'.repeat(64)}.key`),
    secret,
    'utf8',
  );

  const scan = await readSessionsDir(dir);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0]?.pid, 1001);
  // Had the key file been opened it would have failed to parse and shown up
  // here as a warning. Zero warnings is the proof it was skipped by name.
  assert.equal(scan.warnings, 0);
  assert.ok(!JSON.stringify(scan).includes(secret));
});

test('malformed JSON is skipped and counted', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, '1001.json'), '{"pid":1001,"status":"busy"', 'utf8');
  await writeFile(path.join(dir, '1002.json'), '', 'utf8');
  await writeFile(path.join(dir, '1003.json'), '[1,2,3]', 'utf8');
  await writeFile(path.join(dir, '1004.json'), '{"pid":1004,"status":"idle"}', 'utf8');

  const scan = await readSessionsDir(dir);
  assert.equal(scan.warnings, 3);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0]?.pid, 1004);
});

test('a missing sessions directory is a normal state, not an error', async () => {
  const scan = await readSessionsDir(path.join(os.tmpdir(), 'nazar-does-not-exist-4676'));
  assert.equal(scan.missingDirectory, true);
  assert.equal(scan.warnings, 0);
  assert.deepEqual(scan.entries, []);
});

test('unknown fields are ignored and missing fields never throw', () => {
  const entry = parseSessionFile(
    '1001.json',
    JSON.stringify({ someFieldClaudeCodeAddsLater: { nested: true }, status: 'busy' }),
  );
  assert.ok(entry !== undefined);
  assert.equal(entry.pid, 1001);
  assert.equal(entry.status, 'busy');
  assert.equal(entry.sessionId, undefined);
  assert.equal(entry.cwd, undefined);
  assert.equal(entry.startedAt, undefined);
});

test('a missing or unrecognised status reads as unknown, never as running', () => {
  const missing = parseSessionFile('1001.json', '{}');
  assert.equal(missing?.status, 'unknown');
  const invented = parseSessionFile('1001.json', '{"status":"transcending"}');
  assert.equal(invented?.status, 'unknown');
  const wrongType = parseSessionFile('1001.json', '{"status":7}');
  assert.equal(wrongType?.status, 'unknown');
});

test('a file whose name is not a pid is refused outright', () => {
  assert.equal(parseSessionFile('1001.key', '{"pid":1001}'), undefined);
  assert.equal(pidFromSessionFileName('1001.json'), 1001);
  assert.equal(pidFromSessionFileName('0.json'), undefined);
  assert.equal(pidFromSessionFileName('nope.json'), undefined);
});

test('the sanitized fixtures parse into the fields the pinned table names', async () => {
  const scan = await readSessionsDir(fixturesDir);
  assert.equal(scan.warnings, 0);
  assert.equal(scan.entries.length, 3);

  const byPid = new Map(scan.entries.map((entry) => [entry.pid, entry]));

  const busy = byPid.get(1001);
  assert.equal(busy?.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(busy?.cwd, 'C:/proj/example');
  assert.equal(busy?.kind, 'interactive');
  assert.equal(busy?.name, 'session-a');
  assert.equal(busy?.status, 'busy');
  assert.equal(busy?.version, '2.1.263');
  assert.equal(busy?.startedAt, 1788697701170);
  assert.equal(busy?.updatedAt, 1788751348625);
  assert.equal(busy?.statusUpdatedAt, 1788751348625);

  // The backslash form real payloads actually use, JSON-escaped on disk.
  assert.equal(byPid.get(1002)?.cwd, 'C:\\proj\\example');
  assert.equal(byPid.get(1002)?.status, 'idle');

  // The session file knows a session is waiting; it never says what for.
  assert.equal(byPid.get(1003)?.status, 'waiting');
});
