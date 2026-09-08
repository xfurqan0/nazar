/**
 * Route tests. Everything binds port 0, so the suite never fights with a
 * canvas the maintainer already has open on 4676, and nothing here reads
 * `~/.claude`: the state source is a plain object.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SessionView, StateSnapshot } from '@nazar/core';

import { isLocalHost, resolveStaticPath, startNazarServer, type StateSource } from '../src/http.ts';

const INDEX_BODY = '<!doctype html><title>Nazar</title><body>canvas</body>';
const SECRET_FILE_BODY = 'this file is outside the ui directory';

function demoSession(): SessionView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    provider: 'claude',
    pid: 1001,
    cwd: 'C:/proj/nazar',
    name: 'session-a',
    status: 'waiting',
    waitingFor: 'permission prompt',
    state: 'alive',
    source: 'files+command',
    lastSeenAt: 1_788_756_000_000,
    tokens: { in: 24_118, out: 9402, cacheRead: 1_284_507, cacheWrite: 61_440 },
    agents: [],
    roots: [],
    orphans: [],
    treeRead: true,
  };
}

/** A state source with no watchers behind it. */
class FakeState implements StateSource {
  private current: StateSnapshot;

  private readonly listeners = new Set<(snapshot: StateSnapshot) => void>();

  constructor(snapshot: StateSnapshot) {
    this.current = snapshot;
  }

  snapshot(): StateSnapshot {
    return this.current;
  }

  on(_event: 'change', listener: (snapshot: StateSnapshot) => void): this {
    this.listeners.add(listener);
    return this;
  }

  off(_event: 'change', listener: (snapshot: StateSnapshot) => void): this {
    this.listeners.delete(listener);
    return this;
  }

  push(snapshot: StateSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

async function withServer(
  run: (context: {
    url: string;
    state: FakeState;
    uiDir: string;
    outside: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'nazar-http-'));
  const uiDir = path.join(root, 'web');
  const outside = path.join(root, 'secret.txt');
  await writeFile(outside, SECRET_FILE_BODY, 'utf8');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), INDEX_BODY, 'utf8');
  await writeFile(path.join(uiDir, 'bundle.js'), 'console.log(1)', 'utf8');

  const state = new FakeState({
    generatedAt: 1_788_756_000_000,
    sessions: [demoSession()],
    commandAvailable: true,
    warnings: 0,
  });

  const server = await startNazarServer({ state, uiDir, port: 0, heartbeatMs: 50 });
  try {
    await run({ url: server.url, state, uiDir, outside });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('the server binds 127.0.0.1 and reports the port it got', async () => {
  await withServer(async ({ url }) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(!url.includes('0.0.0.0'));
  });
});

test('GET /api/state answers the current snapshot as JSON', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}api/state`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = (await response.json()) as StateSnapshot;
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0]?.cwd, 'C:/proj/nazar');
    assert.deepEqual(body.sessions[0]?.tokens, {
      in: 24_118,
      out: 9402,
      cacheRead: 1_284_507,
      cacheWrite: 61_440,
    });
    assert.equal(body.commandAvailable, true);
  });
});

test('GET /api/events opens an SSE stream whose first frame is the whole state', async () => {
  await withServer(async ({ url, state }) => {
    const controller = new AbortController();
    const response = await fetch(`${url}api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    const decoder = new TextDecoder();

    let buffer = '';
    const readUntil = async (needle: string): Promise<string> => {
      while (!buffer.includes(needle)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`stream ended before "${needle}"`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    };

    const first = await readUntil('\n\n');
    assert.match(first, /retry: \d+/, 'the client is told how long to wait before reconnecting');

    const frame = await readUntil('event: state');
    const line = frame.split('\n').find((one) => one.startsWith('data: '));
    assert.ok(line !== undefined);
    const payload = JSON.parse(line.slice('data: '.length)) as StateSnapshot;
    assert.equal(payload.sessions[0]?.waitingFor, 'permission prompt');

    // A change is pushed without the client asking for one.
    buffer = '';
    state.push({
      generatedAt: 1_788_756_009_000,
      sessions: [],
      commandAvailable: false,
      warnings: 1,
    });
    const second = await readUntil('event: state');
    const secondLine = second.split('\n').find((one) => one.startsWith('data: '));
    const secondPayload = JSON.parse((secondLine ?? '').slice('data: '.length)) as StateSnapshot;
    assert.equal(secondPayload.sessions.length, 0);
    assert.equal(secondPayload.warnings, 1);

    // Heartbeats keep the connection from idling out.
    buffer = '';
    await readUntil(': heartbeat');

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

test('a closed SSE client stops being a listener', async () => {
  await withServer(async ({ url, state }) => {
    const controller = new AbortController();
    const response = await fetch(`${url}api/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    assert.equal(state.listenerCount, 1);

    controller.abort();
    await reader?.cancel().catch(() => undefined);

    const deadline = Date.now() + 2000;
    while (state.listenerCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state.listenerCount, 0, 'the change listener was not detached');
  });
});

test('GET / serves the canvas with a policy that forbids fetching from a CDN', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await response.text(), INDEX_BODY);

    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(!csp.includes('unsafe-inline'));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('a static file next to the index is served with its own type', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}bundle.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/javascript/);
  });
});

test('an unknown route is a 404, and an unknown API route does not fall through to a file', async () => {
  await withServer(async ({ url }) => {
    assert.equal((await fetch(`${url}nope.txt`)).status, 404);
    assert.equal((await fetch(`${url}api/anything`)).status, 404);
  });
});

test('only GET and HEAD are accepted', async () => {
  await withServer(async ({ url }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${url}api/state`, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  });
});

test('a Host header that is not this machine is refused', async () => {
  await withServer(async ({ url }) => {
    // `fetch` refuses to set Host, so this one goes out over raw http.
    const port = Number(new URL(url).port);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/state',
          method: 'GET',
          headers: { Host: 'nazar.example.invalid' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403, 'DNS rebinding must not reach the canvas');
  });
});

test('the traversal escape hatches are all closed', async () => {
  await withServer(async ({ url }) => {
    for (const attempt of [
      '../secret.txt',
      '..%2Fsecret.txt',
      '%2e%2e%2fsecret.txt',
      '....//secret.txt',
      '/..\\secret.txt',
    ]) {
      const response = await fetch(`${url}${attempt}`);
      const body = await response.text();
      assert.ok(!body.includes(SECRET_FILE_BODY), `escaped with ${attempt}`);
    }
  });
});

test('resolveStaticPath rejects what it cannot keep inside the root', () => {
  const root = path.resolve('/srv/ui');
  assert.equal(resolveStaticPath(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveStaticPath(root, '/assets/claude-color.png'), path.join(root, 'assets', 'claude-color.png'));
  assert.equal(resolveStaticPath(root, '/../secret'), undefined);
  assert.equal(resolveStaticPath(root, '/%2e%2e/secret'), undefined);
  assert.equal(resolveStaticPath(root, '/a%00b'), undefined);
  assert.equal(resolveStaticPath(root, '/%zz'), undefined, 'a broken escape is a 404, not a crash');
});

test('isLocalHost accepts exactly the six forms this machine answers to', () => {
  for (const good of ['127.0.0.1:4676', 'localhost:4676', '[::1]:4676', '127.0.0.1', 'LOCALHOST']) {
    assert.equal(isLocalHost(good, 4676), true, good);
  }
  for (const bad of ['nazar.example.invalid', '127.0.0.1:9999', 'evil.local:4676', undefined]) {
    assert.equal(isLocalHost(bad, 4676), false, String(bad));
  }
});
