/**
 * The redaction gate. A failure here is a leak, not a cosmetic bug, so the
 * cases below are the ones that actually happen: a Windows home directory in
 * a working directory, a key pasted into a shell line, a token in a URL.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { collapseHome, redact, REDACTION_HEAD, redactSecrets, SECRET_MASK } from '../src/redact.ts';

const HOME = 'C:\\Users\\example';

test('a path is cut to the first 80 characters and marked', () => {
  const long = `C:/proj/${'a'.repeat(200)}`;
  const out = redact(long, { home: HOME });
  assert.equal(out.length, REDACTION_HEAD + 1);
  assert.ok(out.endsWith('…'));
  assert.ok(out.startsWith('C:/proj/aaa'));
});

test('a short path comes back untouched', () => {
  assert.equal(redact('C:/proj/nazar', { home: HOME }), 'C:/proj/nazar');
});

test('the home directory collapses to a tilde on either separator', () => {
  assert.equal(collapseHome('C:\\Users\\example\\proj\\nazar', HOME), '~\\proj\\nazar');
  assert.equal(collapseHome('C:/Users/example/proj/nazar', HOME), '~/proj/nazar');
  assert.equal(collapseHome('C:\\Users\\example', HOME), '~');
  assert.equal(collapseHome('/home/example/x', '/home/example'), '~/x');
});

test('a directory that merely starts with the same letters is not collapsed', () => {
  assert.equal(collapseHome('C:\\Users\\example2\\proj', HOME), 'C:\\Users\\example2\\proj');
});

test('the home match ignores case, because Windows does', () => {
  assert.equal(collapseHome('c:\\users\\EXAMPLE\\proj', HOME), '~\\proj');
});

test('vendor-prefixed keys are masked', () => {
  const cases = [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    'sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    'github_pat_DDDDDDDDDDDDDDDDDDDDDD',
    'xoxb-111111111111-EEEEEEEEEEEE',
    'AIzaFFFFFFFFFFFFFFFFFFFFFFFF',
    'AKIAGGGGGGGGGGGGGGGG',
  ];
  for (const secret of cases) {
    const out = redactSecrets(`run --key ${secret} now`);
    assert.ok(out.includes(SECRET_MASK), `${secret} was not masked`);
    assert.ok(!out.includes(secret), `${secret} survived`);
  }
});

test('a secret-shaped assignment is masked whatever the quoting', () => {
  for (const line of [
    'export API_KEY=hunter2hunter2',
    'psql --password "hunter2 hunter2"',
    "curl -H 'token: abc123def456'",
    'GET /x?access_token=abc123def456',
    'SECRET = abc123def456',
  ]) {
    const out = redactSecrets(line);
    assert.ok(out.includes(SECRET_MASK), `not masked: ${line}`);
    assert.ok(!out.includes('hunter2'), `not masked: ${line}`);
    assert.ok(!out.includes('abc123def456'), `not masked: ${line}`);
  }
});

test('bearer tokens, JWTs and credentials in a URL are masked', () => {
  assert.ok(
    !redactSecrets('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'),
  );
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.ok(!redactSecrets(`token ${jwt}`).includes(jwt));

  const url = redactSecrets('https://user:s3cr3tpass@example.invalid/repo.git');
  assert.ok(url.startsWith('https://'), 'the scheme survives so it still reads as a URL');
  assert.ok(!url.includes('s3cr3tpass'));
});

test('masking happens before truncation, so no head of a token survives', () => {
  const line = `C:/very/long/path/that/goes/on/and/on/and/on/x --token=SUPERSECRETVALUE${'z'.repeat(60)}`;
  const out = redact(line, { home: HOME });
  assert.ok(!out.includes('SUPERSECRET'), `truncated head leaked: ${out}`);
});

test('things that only look random are left alone', () => {
  // Commit hashes, uuids and agent ids are shown on purpose; a generic
  // "long random string" rule would eat all three.
  for (const keep of [
    'C:/proj/nazar',
    '00000000-0000-4000-8000-000000000001',
    'agent-a0000000000000001',
    'toolu_000000000000000000000001',
    'claude-opus-5[1m]',
    'token-counter',
  ]) {
    assert.equal(redactSecrets(keep), keep, `${keep} was mangled`);
  }
});

test('undefined survives as undefined rather than becoming an empty string', () => {
  assert.equal(redact(undefined), undefined);
});
