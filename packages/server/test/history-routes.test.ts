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
// N-WP20: the canvas's own prune, run against what this server actually
// serves. Asserting the route's ids in isolation would prove the endpoint and
// miss the thing that was broken, which was the join between the two.
import { pruneNames } from '@nazar/ui';

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
      ids: async () => {
        throw new Error('the disk went away');
      },
    },
    port: 0,
  });
  try {
    assert.equal((await fetch(`${server.url}api/history`)).status, 503);
    assert.equal((await fetch(`${server.url}api/history/${SESSION}`)).status, 503);
    // N-WP20. The id sweep fails the same way, and failing is the *point*: the
    // canvas prunes against this answer, so a 503 has to stay a 503 rather than
    // degrade into an empty list — which would read as "every session you
    // remember is gone" and take its layout, tab and name with it.
    assert.equal((await fetch(`${server.url}api/history/ids`)).status, 503);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * N-WP20: pruning is decided against the whole store
 * ------------------------------------------------------------------ */

test('N-WP20: /api/history/ids sweeps past the page the drawer asks for', async () => {
  /*
   * The end of the chain that used to delete people's work, run for real: a
   * transcript store of 201 sessions, the actual `HistoryScanner`, the actual
   * request listener over an actual socket, and then the actual `pruneNames`
   * the canvas calls with the answer.
   *
   * The old path asked `/api/history?limit=200`, took the ids off that page,
   * and handed them to `pruneNames` as "everything the machine still has". The
   * 201st session was not on the page, so its typed-in card name was deleted —
   * while the session itself was two clicks away in the drawer, openable, with
   * its transcript still on disk. This asserts the whole way through: the sweep
   * carries the omitted id, and the name survives the prune.
   */
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-hroutes-many-'));
  const uiDir = path.join(root, 'web');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Nazar</title>', 'utf8');

  const store = path.join(root, 'store');
  const project = path.join(store, 'C--proj-many');
  await mkdir(project, { recursive: true });
  const line = `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-01T00:00:00Z',
    requestId: 'req-parent',
    message: { id: 'parent', model: 'test-model', usage: { input_tokens: 1, output_tokens: 1 } },
  })}\n`;
  for (let index = 0; index < 201; index += 1) {
    const id = `session-${String(index).padStart(3, '0')}`;
    await writeFile(path.join(project, `${id}.jsonl`), line, 'utf8');
  }

  const scanner = new HistoryScanner({ projectsDir: store, home: HOME, indexTtlMs: 0 });
  const server = await startNazarServer({
    state: {
      snapshot: () => ({ generatedAt: 0, sessions: [], commandAvailable: false, warnings: 0 }),
      on: () => undefined,
      off: () => undefined,
    },
    uiDir,
    history: scanner,
    port: 0,
  });

  try {
    // What the drawer asks for, and what it therefore does not see.
    const listed = (await (await fetch(`${server.url}api/history?limit=200`)).json()) as {
      total: number;
      nextOffset?: number;
      sessions: { sessionId: string }[];
    };
    assert.equal(listed.total, 201);
    assert.equal(listed.sessions.length, 200);
    assert.equal(listed.nextOffset, 200);

    // What the prune is now decided from.
    const response = await fetch(`${server.url}api/history/ids`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    const sweep = (await response.json()) as { total: number; sessionIds: string[] };
    assert.equal(sweep.total, 201);
    assert.equal(sweep.sessionIds.length, 201, 'the sweep is unpaged');

    const onPage = new Set(listed.sessions.map((one) => one.sessionId));
    const omitted = sweep.sessionIds.filter((id) => !onPage.has(id));
    assert.equal(omitted.length, 1, 'exactly one session falls off the first page');
    const beyond = omitted[0];
    assert.ok(beyond !== undefined);

    // The bug, and the fix, in the two calls the canvas actually makes.
    const named = { names: { [beyond]: 'the one I care about' } };
    const fromPage = pruneNames(named, new Set(onPage));
    assert.equal(fromPage.names[beyond], undefined, 'pruning from a page loses the name');

    const fromSweep = pruneNames(named, new Set(sweep.sessionIds));
    assert.equal(
      fromSweep.names[beyond],
      'the one I care about',
      'pruning from the sweep keeps it',
    );

    // And the session it names is not gone at all: it opens.
    assert.equal((await fetch(`${server.url}api/history/${beyond}`)).status, 200);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('N-WP20: the sweep carries ids and nothing else', async () => {
  // It is served to decide what to forget, so it has no business carrying a
  // project label, a byte count or a timestamp — the listing's job, and the
  // things the redaction rules exist for.
  await withServer(async ({ url }) => {
    const body = (await (await fetch(`${url}api/history/ids`)).json()) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ['generatedAt', 'listMs', 'sessionIds', 'total', 'warnings'].sort(),
    );
    const ids = body['sessionIds'];
    assert.ok(Array.isArray(ids));
    for (const id of ids) assert.equal(typeof id, 'string');
    assert.equal(JSON.stringify(body).includes('somebody'), false, 'no account name on the wire');
  });
});
