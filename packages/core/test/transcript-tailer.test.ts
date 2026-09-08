/**
 * The incremental tailer.
 *
 * Every test writes into a temporary directory. The real transcript store is
 * never opened here, and nothing under `~/.claude` is written at any point.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TranscriptTailer } from '../src/transcript-tailer.ts';

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'nazar-tailer-'));
}

test('a missing file is not an error and does not consume the offset', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tailer = new TranscriptTailer(path.join(dir, 'absent.jsonl'));
  const first = await tailer.read();
  assert.deepEqual(first.lines, []);
  assert.equal(first.missing, true);
  assert.equal(first.bytesRead, 0);
  assert.equal(tailer.position, 0);
});

test('appended bytes are read once and only once', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');

  const first = '{"n":1}\n{"n":2}\n';
  await writeFile(file, first, 'utf8');

  const tailer = new TranscriptTailer(file);
  const one = await tailer.read();
  assert.deepEqual(one.lines, ['{"n":1}', '{"n":2}']);
  assert.equal(one.bytesRead, Buffer.byteLength(first));

  // Nothing appended: no syscall budget spent, no lines.
  const idle = await tailer.read();
  assert.deepEqual(idle.lines, []);
  assert.equal(idle.bytesRead, 0);

  const second = '{"n":3}\n';
  await appendFile(file, second, 'utf8');
  const two = await tailer.read();
  assert.deepEqual(two.lines, ['{"n":3}']);
  assert.equal(two.bytesRead, Buffer.byteLength(second), 'only the appended bytes');

  // The whole point of the package: a 9 MB transcript is never re-read.
  assert.equal(tailer.bytesRead, Buffer.byteLength(first) + Buffer.byteLength(second));
  assert.equal(tailer.position, Buffer.byteLength(first + second));
});

test('a partial trailing line is buffered until its newline arrives', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'partial.jsonl');

  await writeFile(file, '{"n":1}\n{"half":', 'utf8');
  const tailer = new TranscriptTailer(file);
  const one = await tailer.read();
  assert.deepEqual(one.lines, ['{"n":1}'], 'the half line is held back, not emitted broken');

  await appendFile(file, 'true}\n', 'utf8');
  const two = await tailer.read();
  assert.deepEqual(two.lines, ['{"half":true}']);
  assert.equal(two.bytesRead, Buffer.byteLength('true}\n'), 'the buffered half is not re-read');
});

test('a multi-byte character split across two reads survives', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'utf8.jsonl');

  // "ö" is 0xc3 0xb6. Write the lead byte, read, then write the rest: a string
  // buffer would have decoded a replacement character here.
  await writeFile(file, Buffer.concat([Buffer.from('{"s":"', 'utf8'), Buffer.from([0xc3])]));
  const tailer = new TranscriptTailer(file);
  assert.deepEqual((await tailer.read()).lines, []);

  await appendFile(file, Buffer.concat([Buffer.from([0xb6]), Buffer.from('"}\n', 'utf8')]));
  const two = await tailer.read();
  assert.deepEqual(two.lines, ['{"s":"ö"}']);
  assert.equal((JSON.parse(two.lines[0] as string) as { s: string }).s, 'ö');
});

test('CRLF line endings are stripped and blank lines are dropped', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'crlf.jsonl');

  await writeFile(file, '{"n":1}\r\n\r\n{"n":2}\r\n', 'utf8');
  const tailer = new TranscriptTailer(file);
  assert.deepEqual((await tailer.read()).lines, ['{"n":1}', '{"n":2}']);
});

test('a UTF-8 BOM is stripped once, at offset zero only', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bom.jsonl');

  await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"n":1}\n')]));
  const tailer = new TranscriptTailer(file);
  const one = await tailer.read();
  assert.deepEqual(one.lines, ['{"n":1}']);
  assert.doesNotThrow(() => JSON.parse(one.lines[0] as string) as unknown);

  // A byte sequence that happens to look like a BOM mid-file is content.
  await appendFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\n')]));
  const two = await tailer.read();
  assert.equal(two.lines.length, 1);
  assert.equal(two.lines[0], '﻿');
});

test('truncation restarts the offset and says so', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rotate.jsonl');

  await writeFile(file, '{"n":1}\n{"n":2}\n{"n":3}\n', 'utf8');
  const tailer = new TranscriptTailer(file);
  assert.equal((await tailer.read()).lines.length, 3);

  await truncate(file, 0);
  await writeFile(file, '{"n":9}\n', 'utf8');
  const after = await tailer.read();
  assert.equal(after.restarted, true, 'a shorter file is not the file we had an offset into');
  assert.deepEqual(after.lines, ['{"n":9}']);
  assert.equal(tailer.restartCount, 1);
});

test('a truncation that leaves a partial line does not glue it to the new file', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'glue.jsonl');

  await writeFile(file, '{"n":1}\n{"partial"', 'utf8');
  const tailer = new TranscriptTailer(file);
  await tailer.read();

  await writeFile(file, '{"n":2}\n', 'utf8');
  const after = await tailer.read();
  assert.equal(after.restarted, true);
  assert.deepEqual(after.lines, ['{"n":2}']);
});

test('a file that grows past one chunk is still read in a single pass', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'big.jsonl');

  const lines = Array.from({ length: 500 }, (_, i) => `{"n":${i}}`);
  const body = `${lines.join('\n')}\n`;
  await writeFile(file, body, 'utf8');

  const tailer = new TranscriptTailer(file, { chunkBytes: 64 });
  const result = await tailer.read();
  assert.equal(result.lines.length, 500);
  assert.equal(result.bytesRead, Buffer.byteLength(body));
  assert.equal(result.lines[499], '{"n":499}');
});
