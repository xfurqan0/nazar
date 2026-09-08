/**
 * The browser opener, which is all failure modes and no happy path worth
 * testing: every assertion here is about what happens when a link of the chain
 * is missing, lies, or never answers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_OPEN_TIMEOUT_MS,
  OPEN_HINT,
  browserOpenChain,
  describeOpenAttempt,
  openInBrowser,
} from '../src/open.ts';
import type { OpenChild, OpenSpawn } from '../src/open.ts';

const URL = 'http://127.0.0.1:4676/';

class Capture {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** A child that reports `code` on the next tick, or nothing at all when null. */
function child(code: number | null, mode: 'exit' | 'error' | 'silent' = 'exit'): OpenChild {
  const listeners = new Map<string, (arg: never) => void>();
  queueMicrotask(() => {
    if (mode === 'silent') return;
    const listener = listeners.get(mode);
    if (listener === undefined) return;
    listener((mode === 'error' ? new Error('ENOENT') : code) as never);
  });
  return {
    on(event: string, listener: (arg: never) => void) {
      listeners.set(event, listener);
      return this;
    },
    unref() {
      return this;
    },
  } as OpenChild;
}

/** Records every command it is asked to run and answers from a script. */
function recorder(script: ReadonlyArray<() => OpenChild>): {
  spawn: OpenSpawn;
  calls: string[][];
  options: unknown[];
} {
  const calls: string[][] = [];
  const options: unknown[] = [];
  const spawn: OpenSpawn = (command, args, opts) => {
    calls.push([command, ...args]);
    options.push(opts);
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error('spawn called more times than scripted');
    return next();
  };
  return { spawn, calls, options };
}

test('the Windows chain is cmd, then rundll32, then explorer', () => {
  const chain = browserOpenChain(URL, 'win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' });
  assert.deepEqual(
    chain.map(describeOpenAttempt),
    [
      `C:\\WINDOWS\\system32\\cmd.exe /c start "" ${URL}`,
      `rundll32 url.dll,FileProtocolHandler ${URL}`,
      `explorer.exe ${URL}`,
    ],
    'the fallback order is part of the contract',
  );
  // Not one of them can tell us a browser opened, which is why the hint exists.
  assert.deepEqual(
    chain.map((attempt) => attempt.confirms),
    [false, false, false],
  );
  // Explorer answers 1 on success as often as 0.
  assert.deepEqual(chain[2]?.okCodes, [0, 1]);
});

test('ComSpec is preferred over the bare name, in either spelling', () => {
  assert.equal(browserOpenChain(URL, 'win32', { ComSpec: 'D:\\alt\\cmd.exe' })[0]?.command, 'D:\\alt\\cmd.exe');
  assert.equal(browserOpenChain(URL, 'win32', { COMSPEC: 'D:\\alt\\cmd.exe' })[0]?.command, 'D:\\alt\\cmd.exe');
  // An empty or absent ComSpec must not produce an empty command.
  assert.equal(browserOpenChain(URL, 'win32', {})[0]?.command, 'cmd.exe');
  assert.equal(browserOpenChain(URL, 'win32', { ComSpec: '' })[0]?.command, 'cmd.exe');
});

test('macOS and Linux keep one opener each, and theirs can confirm', () => {
  const mac = browserOpenChain(URL, 'darwin', {});
  assert.deepEqual(mac.map(describeOpenAttempt), [`open ${URL}`]);
  assert.equal(mac[0]?.confirms, true);

  const linux = browserOpenChain(URL, 'linux', {});
  assert.deepEqual(linux.map(describeOpenAttempt), [`xdg-open ${URL}`]);
  assert.equal(linux[0]?.confirms, true);
});

test('the first opener that answers stops the chain', async () => {
  const rec = recorder([() => child(0)]);
  const out = new Capture();
  const outcome = await openInBrowser(URL, {
    spawn: rec.spawn,
    platform: 'win32',
    env: { ComSpec: 'cmd.exe' },
    out,
  });

  assert.equal(rec.calls.length, 1, 'a working first link must not fall through');
  assert.deepEqual(rec.calls[0], ['cmd.exe', '/c', 'start', '', URL]);
  assert.equal(outcome.status, 'launched');
  // Windows can never confirm, so the hint goes out even on the good path.
  assert.equal(outcome.hinted, true);
  assert.equal(out.text, `${OPEN_HINT}\n`);
});

test('a missing cmd falls through to rundll32, and a failing rundll32 to explorer', async () => {
  const rec = recorder([
    () => child(null, 'error'), // cmd is not on PATH
    () => child(1), // rundll32 answers badly
    () => child(1), // explorer's success code
  ]);
  const outcome = await openInBrowser(URL, {
    spawn: rec.spawn,
    platform: 'win32',
    env: {},
  });

  assert.deepEqual(rec.calls, [
    ['cmd.exe', '/c', 'start', '', URL],
    ['rundll32', 'url.dll,FileProtocolHandler', URL],
    ['explorer.exe', URL],
  ]);
  assert.equal(outcome.status, 'launched');
  assert.deepEqual(outcome.attempted, browserOpenChain(URL, 'win32', {}).map(describeOpenAttempt));
});

test('every link failing is reported, not thrown', async () => {
  const rec = recorder([
    () => child(null, 'error'),
    () => child(null, 'error'),
    () => child(null, 'error'),
  ]);
  const out = new Capture();
  const outcome = await openInBrowser(URL, {
    spawn: rec.spawn,
    platform: 'win32',
    env: {},
    out,
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(rec.calls.length, 3);
  assert.equal(out.text, `${OPEN_HINT}\n`);
});

test('a spawn that throws outright is just another failed link', async () => {
  let calls = 0;
  const spawn: OpenSpawn = (command) => {
    calls += 1;
    if (command !== 'explorer.exe') throw new Error('EACCES');
    return child(0);
  };
  const outcome = await openInBrowser(URL, { spawn, platform: 'win32', env: {} });
  assert.equal(calls, 3);
  assert.equal(outcome.status, 'launched');
});

test('a silent opener is assumed to be running rather than waited on', async () => {
  const rec = recorder([() => child(null, 'silent')]);
  const started = Date.now();
  const outcome = await openInBrowser(URL, {
    spawn: rec.spawn,
    platform: 'win32',
    env: {},
    timeoutMs: 20,
  });
  assert.equal(outcome.status, 'launched');
  assert.equal(rec.calls.length, 1, 'a timeout must not cascade into the next opener');
  assert.ok(Date.now() - started < DEFAULT_OPEN_TIMEOUT_MS, 'the default timeout was not overridden');
});

test('a confirming opener suppresses the hint; a failing one does not', async () => {
  const good = new Capture();
  const okOutcome = await openInBrowser(URL, {
    spawn: recorder([() => child(0)]).spawn,
    platform: 'darwin',
    env: {},
    out: good,
  });
  assert.equal(okOutcome.status, 'opened');
  assert.equal(okOutcome.hinted, false);
  assert.equal(good.text, '', 'a confirmed open says nothing');

  const bad = new Capture();
  const badOutcome = await openInBrowser(URL, {
    spawn: recorder([() => child(3)]).spawn,
    platform: 'darwin',
    env: {},
    out: bad,
  });
  assert.equal(badOutcome.status, 'failed');
  assert.equal(bad.text, `${OPEN_HINT}\n`);
});

test('the hint text lives in exactly one place', async () => {
  const out = new Capture();
  await openInBrowser(URL, {
    spawn: recorder([() => child(0)]).spawn,
    platform: 'win32',
    env: {},
    out,
  });
  assert.equal(out.text.trim(), OPEN_HINT);
  assert.match(OPEN_HINT, /open the URL above/);
});

test('every attempt is detached, silent and window-less', async () => {
  const rec = recorder([() => child(null, 'error'), () => child(null, 'error'), () => child(0)]);
  await openInBrowser(URL, { spawn: rec.spawn, platform: 'win32', env: {} });
  for (const options of rec.options) {
    assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: true });
  }
});

test('a child with no event support still settles through the timeout', async () => {
  const spawn: OpenSpawn = () =>
    ({
      on() {
        throw new Error('this stub has no events');
      },
    }) as unknown as OpenChild;
  const outcome = await openInBrowser(URL, {
    spawn,
    platform: 'linux',
    env: {},
    timeoutMs: 10,
  });
  assert.equal(outcome.status, 'launched');
});
