/**
 * The two history routes.
 *
 * Everything binds port 0, and the history source is a real `HistoryScanner`
 * over a temporary directory built from the shipped fixtures: the routes are
 * worth testing against the thing they will actually serve, and the real
 * `~/.claude` is never touched.
 *
 * The route tests also carry the wire-level half of the leak gate. The core's
 * gate proves the *builder* emits nothing but identifiers; this one proves the
 * same of the bytes that leave the process, redaction included.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { History, HistoryListPage } from '@nazar/core';
import { HistoryScanner, projectSlugFor } from '@nazar/core';

import { startNazarServer } from '../src/http.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', 'fixtures');

const SESSION = '00000000-0000-4000-8000-000000000005';
const OTHER = '00000000-0000-4000-8000-000000000006';
const HOME = process.platform === 'win32' ? 'C:\\Users\\somebody' : '/home/somebody';

/** A transcript store with two finished sessions, one of them under `$HOME`. */
async function store(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-hroutes-'));

  const alpha = path.join(root, 'C--proj-alpha');
  await mkdir(path.join(alpha, SESSION, 'subagents'), { recursive: true });
  await copyFile(
    path.join(fixtures, 'subagents', 'parent-slice.jsonl'),
    path.join(alpha, `${SESSION}.jsonl`),
  );
  for (const id of ['a0000000000000005', 'a0000000000000006', 'a0000000000000007']) {
    await copyFile(
      path.join(fixtures, 'subagents', `agent-${id}.meta.json`),
      path.join(alpha, SESSION, 'subagents', `agent-${id}.meta.json`),
    );
  }
  await copyFile(
    path.join(fixtures, 'subagents', 'agent-a0000000000000006.jsonl'),
    path.join(alpha, SESSION, 'subagents', 'agent-a0000000000000006.jsonl'),
  );

  // A project under the home directory: its slug carries the account name, and
  // the wire must not.
  const homed = path.join(root, `${projectSlugFor(HOME)}-secret-client-work`);
  await mkdir(homed, { recursive: true });
  await copyFile(path.join(fixtures, 'transcript-slice.jsonl'), path.join(homed, `${OTHER}.jsonl`));

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await utimes(path.join(alpha, `${SESSION}.jsonl`), yesterday, yesterday);
  const before = new Date(yesterday.getTime() - 3_600_000);
  await utimes(path.join(homed, `${OTHER}.jsonl`), before, before);

  return root;
}

async function withServer(
  run: (context: { url: string; root: string; scanner: HistoryScanner }) => Promise<void>,
): Promise<void> {
  const root = await store();
  const uiDir = path.join(root, 'web');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Nazar</title>', 'utf8');

  const scanner = new HistoryScanner({ projectsDir: root, home: HOME, indexTtlMs: 0 });
  const state = {
    snapshot: () => ({ generatedAt: 0, sessions: [], commandAvailable: false, warnings: 0 }),
    on: () => undefined,
    off: () => undefined,
  };

  const server = await startNazarServer({
    state,
    uiDir,
    history: scanner,
    port: 0,
    redact: { home: HOME },
  });
  try {
    await run({ url: server.url, root, scanner });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('GET /api/history lists past sessions newest first and reads no transcript', async () => {
  await withServer(async ({ url, scanner }) => {
    const response = await fetch(`${url}api/history`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const page = (await response.json()) as HistoryListPage;
    assert.equal(page.total, 2);
    assert.equal(page.sessions[0]?.sessionId, SESSION);
    assert.equal(page.sessions[0]?.agentCount, 3);
    assert.equal(page.sessions[0]?.hydrated, false);
    assert.equal(page.sessions[0]?.tokens, undefined, 'a listing has read nothing to count');
    assert.equal(scanner.stats.fileReads, 0, 'the route must not open a transcript to list');
  });
});

test('the listing paginates and filters by project', async () => {
  await withServer(async ({ url }) => {
    const first = (await (await fetch(`${url}api/history?limit=1`)).json()) as HistoryListPage;
    assert.equal(first.sessions.length, 1);
    assert.equal(first.nextOffset, 1);

    const second = (await (
      await fetch(`${url}api/history?limit=1&offset=1`)
    ).json()) as HistoryListPage;
    assert.equal(second.sessions[0]?.sessionId, OTHER);
    assert.equal(second.nextOffset, undefined);

    const filtered = (await (
      await fetch(`${url}api/history?project=${encodeURIComponent('C--proj-alpha')}`)
    ).json()) as HistoryListPage;
    assert.equal(filtered.total, 1);
    assert.equal(filtered.sessions[0]?.sessionId, SESSION);
  });
});

test('GET /api/history/<id> returns the frozen tree', async () => {
  await withServer(async ({ url, scanner }) => {
    const history = (await (await fetch(`${url}api/history/${SESSION}`)).json()) as History;

    assert.equal(history.sessionId, SESSION);
    assert.equal(history.project, 'C--proj-alpha');
    assert.equal(history.agentCount, 3);
    assert.deepEqual(history.tokens, {
      in: 663,
      out: 17371,
      cacheRead: 1100486,
      cacheWrite: 21031,
    });
    assert.equal(history.model, 'claude-fable-5-1');
    assert.deepEqual([...new Set(history.agents.map((agent) => agent.state))], ['done']);
    assert.ok(history.roots.length > 0, 'the tree, not just the flat list');
    assert.ok(scanner.stats.fileReads > 0, 'opening one is what finally reads a file');

    // The listing now carries what the parse learned.
    const page = (await (await fetch(`${url}api/history`)).json()) as HistoryListPage;
    const row = page.sessions.find((one) => one.sessionId === SESSION);
    assert.equal(row?.hydrated, true);
    assert.deepEqual(row?.tokens, history.tokens);
  });
});

test('the wire drops the fields the canvas has no business seeing', async () => {
  await withServer(async ({ url }) => {
    const history = (await (await fetch(`${url}api/history/${SESSION}`)).json()) as History;
    const raw = JSON.stringify(history);

    // `description` is user-authored, `toolUseId` is an id the canvas never
    // uses. Both are parsed into memory and neither leaves the process.
    assert.ok(!raw.includes('"description"'), 'a user-authored description reached the wire');
    assert.ok(!raw.includes('"toolUseId"'));
    assert.ok(!raw.includes('"projectSlug"'), 'the raw slug is a path in disguise');
    assert.ok(!raw.includes('"currentTool"'), 'a finished agent has no current tool');
    assert.equal(history.cwd, undefined);

    // What does survive, so the test is proving a filter and not an empty box.
    assert.ok(raw.includes('claude-opus-5[1m]'));
    assert.ok(raw.includes('"doneSignal"'));
  });
});

test('a project under the home directory never puts the account name on the wire', async () => {
  await withServer(async ({ url }) => {
    const page = (await (await fetch(`${url}api/history`)).json()) as HistoryListPage;
    const row = page.sessions.find((one) => one.sessionId === OTHER);
    assert.equal(row?.project, '~/secret-client-work');

    const body = JSON.stringify(page);
    assert.ok(!body.includes('somebody'), 'the account name reached the listing');
    assert.ok(!body.includes(projectSlugFor(HOME)));

    const history = (await (await fetch(`${url}api/history/${OTHER}`)).json()) as History;
    assert.equal(history.project, '~/secret-client-work');
    assert.ok(!JSON.stringify(history).includes('somebody'));
  });
});

test('an unknown session, a malformed id and a nested path are all 404', async () => {
  await withServer(async ({ url }) => {
    assert.equal((await fetch(`${url}api/history/00000000-0000-4000-8000-0000000000ff`)).status, 404);
    assert.equal((await fetch(`${url}api/history/`)).status, 200, 'a trailing slash is the listing');
    assert.equal((await fetch(`${url}api/history/..%2F..%2Fsecret`)).status, 404);
    assert.equal((await fetch(`${url}api/history/a/b`)).status, 404);
    assert.equal((await fetch(`${url}api/history/${'x'.repeat(200)}`)).status, 404);
  });
});

test('history obeys the same gates as the rest of the server', async () => {
  await withServer(async ({ url }) => {
    for (const method of ['POST', 'DELETE']) {
      const response = await fetch(`${url}api/history`, { method });
      assert.equal(response.status, 405, method);
    }

    // Host allow-list: a rebinding attempt gets nothing here either.
    const { request } = await import('node:http');
    const port = Number(new URL(url).port);
    const status = await new Promise<number>((resolve, reject) => {
      const call = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/history',
          method: 'GET',
          headers: { Host: 'nazar.example.invalid' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      call.on('error', reject);
      call.end();
    });
    assert.equal(status, 403);
  });
});

test('with no history source the routes are absent, not broken', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-hroutes-none-'));
  const uiDir = path.join(root, 'web');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html>', 'utf8');

  const server = await startNazarServer({
    state: {
      snapshot: () => ({ generatedAt: 0, sessions: [], commandAvailable: false, warnings: 0 }),
      on: () => undefined,
      off: () => undefined,
    },
    uiDir,
    port: 0,
  });
  try {
    assert.equal((await fetch(`${server.url}api/history`)).status, 404);
    assert.equal((await fetch(`${server.url}api/history/${SESSION}`)).status, 404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a transcript store that fails mid-request answers 503 rather than crashing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-hroutes-fail-'));
  const uiDir = path.join(root, 'web');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html>', 'utf8');

  const server = await startNazarServer({
    state: {
      snapshot: () => ({ generatedAt: 0, sessions: [], commandAvailable: false, warnings: 0 }),
      on: () => undefined,
      off: () => undefined,
    },
    uiDir,
    history: {
      list: async () => {
        throw new Error('the disk went away');
      },
      open: async () => {
        throw new Error('the disk went away');
      },
    },
    port: 0,
  });
  try {
    assert.equal((await fetch(`${server.url}api/history`)).status, 503);
    assert.equal((await fetch(`${server.url}api/history/${SESSION}`)).status, 503);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
