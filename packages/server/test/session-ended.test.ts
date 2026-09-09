/**
 * N-WP16: the `session-ended` frame on the SSE stream.
 *
 * Everything binds port 0 and nothing here reads `~/.claude`: the state and the
 * endings are plain objects. What is checked is the seam — that the frame is
 * announced under its own event name, that it carries the shape the canvas
 * parses, that its two free-form fields are redacted like every other path on
 * this wire, and that a closed browser is no longer a listener.
 *
 * The last one has teeth. A `session-ended` listener that outlives its response
 * writes to a dead socket for the life of the process, once per ended session,
 * and on a machine that opens and closes the canvas fifty times a day that is a
 * leak nobody would find by looking at the canvas.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SessionEnded, StateSnapshot } from '@nazar/core';

import type { EndingsSource, StateSource } from '../src/http.ts';
import { startNazarServer } from '../src/http.ts';

const EMPTY: StateSnapshot = {
  generatedAt: 1_788_756_000_000,
  sessions: [],
  commandAvailable: true,
  warnings: 0,
};

/** A state source with no watchers behind it. */
const state: StateSource = {
  snapshot: () => EMPTY,
  on: () => undefined,
  off: () => undefined,
};

/** An endings source the test fires by hand. */
class FakeEndings implements EndingsSource {
  private readonly listeners = new Set<(ended: SessionEnded) => void>();

  on(_event: 'session-ended', listener: (ended: SessionEnded) => void): this {
    this.listeners.add(listener);
    return this;
  }

  off(_event: 'session-ended', listener: (ended: SessionEnded) => void): this {
    this.listeners.delete(listener);
    return this;
  }

  end(ended: SessionEnded): void {
    for (const listener of this.listeners) listener(ended);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

async function withServer(
  run: (context: { url: string; endings: FakeEndings }) => Promise<void>,
  options: { readonly endings?: boolean } = {},
): Promise<void> {
  const uiDir = await mkdtemp(path.join(tmpdir(), 'nazar-ended-ui-'));
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Nazar</title>', 'utf8');
  // A stand-in for the shipped tick, so the type table can be asserted without
  // this suite depending on a build having happened.
  await mkdir(path.join(uiDir, 'assets'), { recursive: true });
  await writeFile(path.join(uiDir, 'assets', 'bead-tick.wav'), Buffer.from('RIFF', 'ascii'));
  const endings = new FakeEndings();
  const server = await startNazarServer({
    state,
    uiDir,
    port: 0,
    heartbeatMs: 50,
    // The home directory the redaction collapses is pinned, so the assertion
    // below is about the rule and not about the machine the test runs on.
    redact: { home: 'C:/Users/tester' },
    ...(options.endings === false ? {} : { endings }),
  });
  try {
    await run({ url: server.url, endings });
  } finally {
    await server.close();
    await rm(uiDir, { recursive: true, force: true });
  }
}

/** Read the stream until `needle` shows up, or give up rather than hang. */
function reading(response: Response): {
  readUntil: (needle: string) => Promise<string>;
  reset: () => void;
} {
  const reader = response.body?.getReader();
  assert.ok(reader !== undefined);
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    readUntil: async (needle) => {
      while (!buffer.includes(needle)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`stream ended before "${needle}"`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    },
    reset: () => {
      buffer = '';
    },
  };
}

/** The `data:` line of the last frame in a buffer, parsed. */
function payloadOf(frame: string): Record<string, unknown> {
  const line = frame.split('\n').find((one) => one.startsWith('data: '));
  assert.ok(line !== undefined, 'the frame carried no data line');
  return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
}

test('an ended session arrives as its own frame, named and redacted', async () => {
  await withServer(async ({ url, endings }) => {
    const controller = new AbortController();
    const response = await fetch(`${url}api/events`, { signal: controller.signal });
    const stream = reading(response);
    // Wait for the opening state frame, so the subscription is certainly in
    // place before anything is announced.
    await stream.readUntil('event: state');
    stream.reset();

    endings.end({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'session-a',
      cwd: 'C:/Users/tester/proj/nazar',
      at: 1_788_756_009_000,
    });

    const payload = payloadOf(await stream.readUntil('event: session-ended'));
    assert.equal(payload['type'], 'session-ended', 'the frame has to name itself');
    assert.equal(payload['id'], '00000000-0000-4000-8000-000000000001');
    assert.equal(payload['name'], 'session-a');
    assert.equal(payload['at'], 1_788_756_009_000);
    // The same rule the live cards follow: the account name never leaves.
    assert.equal(payload['cwd'], '~/proj/nazar');

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });
});

test('a session that ended with no name and no folder invents neither', async () => {
  await withServer(async ({ url, endings }) => {
    const controller = new AbortController();
    const response = await fetch(`${url}api/events`, { signal: controller.signal });
    const stream = reading(response);
    await stream.readUntil('event: state');
    stream.reset();

    endings.end({ id: 'pid-4242', at: 1_788_756_009_000 });

    const payload = payloadOf(await stream.readUntil('event: session-ended'));
    assert.deepEqual(Object.keys(payload).sort(), ['at', 'id', 'type']);

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });
});

test('a closed browser stops being an endings listener too', async () => {
  await withServer(async ({ url, endings }) => {
    const controller = new AbortController();
    const response = await fetch(`${url}api/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    assert.equal(endings.listenerCount, 1);

    controller.abort();
    await reader?.cancel().catch(() => undefined);

    const deadline = Date.now() + 2000;
    while (endings.listenerCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(endings.listenerCount, 0, 'the session-ended listener was not detached');
  });
});

test('a server built without an endings source still serves the stream', async () => {
  // Which is what makes the option optional: the frames are an addition to the
  // stream, not a change to it, and every route test that does not care about
  // them goes on handing in one object.
  await withServer(
    async ({ url }) => {
      const controller = new AbortController();
      const response = await fetch(`${url}api/events`, { signal: controller.signal });
      assert.equal(response.status, 200);
      const stream = reading(response);
      await stream.readUntil('event: state');
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
    },
    { endings: false },
  );
});

test('the tick is served with an audio type rather than as an unknown blob', async () => {
  // `decodeAudioData` takes an ArrayBuffer and does not care what the type says,
  // so this is not what makes the sound work — it is what makes the file
  // *readable* from a browser's network panel, from `curl`, and from anything
  // that ever plays it through an element rather than through Web Audio.
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}assets/bead-tick.wav`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    await response.body?.cancel().catch(() => undefined);
  });
});
