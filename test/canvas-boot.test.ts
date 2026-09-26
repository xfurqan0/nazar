/**
 * The canvas comes back live after a reload, whatever it was left looking like.
 *
 * Every other suite drives the page's modules one at a time, and none of them
 * runs `start()` in `web/app.ts` — the one function that builds the whole page,
 * restores what the browser remembered, and opens the stream. That function
 * had a bug no module test could see: restoring a drawer left open called
 * `schedule()` about a thousand lines before `schedule` was declared, so the
 * page threw a `ReferenceError` in the temporal dead zone, `start()` stopped
 * before it reached `new EventSource`, and the pill said *connecting…* forever.
 * A reload did not help, because the drawer was still remembered as open. It
 * was in the first commit and in 0.1.0, and it looked like a network problem
 * in the desktop shell, whose webview is the one browser that had the drawer
 * open.
 *
 * So this loads the real bundle from the real server in a real browser, opens
 * the drawer the way a user does, reloads, and asks the page two things: did
 * anything throw, and did the stream come up. It is the only test in the
 * repository that starts a browser, and it uses the client the screenshots and
 * the tour already use rather than a third one.
 *
 * **Nothing on this machine is drawn.** The server gets an empty home, so it
 * reads no transcript, and `startServer` passes `--no-task-text` besides.
 *
 * **No browser, no run — except in CI.** A contributor without Chrome or Edge
 * sees this skipped and told why. CI has one on every runner, and a gate that
 * skips there is a gate that never ran, so there a missing browser fails.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  Cdp,
  evaluate,
  findBrowser,
  freePort,
  startBrowser,
  startServer,
} from '../scripts/screenshots.mjs';

/** How long a page gets to open its stream. A healthy one takes well under a second. */
const LIVE_WITHIN_MS = 15_000;

/** The browser to drive, or `undefined` when there is none and that is allowed. */
function browserOrNothing(): string | undefined {
  try {
    return findBrowser();
  } catch (error) {
    if (process.env['CI'] !== undefined) throw error;
    return undefined;
  }
}

/**
 * Poll the connection pill until it says `wanted`, or fail saying what it said
 * instead — and what the page threw, which is nearly always the reason.
 */
async function waitForStatus(
  cdp: Cdp,
  session: string,
  wanted: string,
  thrown: readonly string[],
): Promise<void> {
  const deadline = Date.now() + LIVE_WITHIN_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, session, `document.getElementById('conn')?.dataset.status`);
    if (last === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(
    `the connection pill said ${JSON.stringify(last)} for ${LIVE_WITHIN_MS} ms, not ${wanted}` +
      (thrown.length > 0 ? `; the page threw:\n  ${thrown.join('\n  ')}` : ''),
  );
}

test('a canvas reloaded with its drawer open opens its stream', async (t) => {
  const executable = browserOrNothing();
  if (executable === undefined) {
    t.skip('no Chrome or Edge on this machine; CI runs this');
    return;
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'nazar-boot-'));
  const home = path.join(scratch, 'home');
  const profile = path.join(scratch, 'profile');
  mkdirSync(home);
  mkdirSync(profile);

  const port = await freePort();
  const server = await startServer(port, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
  });
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let cdp: Cdp | undefined;
  try {
    browser = await startBrowser(executable, profile);
    cdp = await Cdp.connect(browser.endpoint);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const thrown: string[] = [];
    cdp.on('Runtime.exceptionThrown', sessionId, (params) => {
      const details = params.exceptionDetails;
      thrown.push(String(details.exception?.description ?? details.text).split('\n')[0] ?? '');
    });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    // A first visit, drawer closed: the case that always worked, and the baseline.
    let loaded = cdp.once('Page.loadEventFired', sessionId, 20_000);
    await cdp.send('Page.navigate', { url: `${server.origin}/` }, sessionId);
    await loaded;
    await waitForStatus(cdp, sessionId, 'live', thrown);
    assert.deepEqual(thrown, [], 'the first load threw');

    // Open the drawer as a user does, and leave it open.
    await evaluate(cdp, sessionId, `document.getElementById('menu-toggle').click()`);
    assert.equal(
      await evaluate(cdp, sessionId, `document.getElementById('sidebar').hidden`),
      false,
      'the menu button did not open the drawer',
    );

    // Come back to it: this is the load that used to stop before the stream.
    loaded = cdp.once('Page.loadEventFired', sessionId, 20_000);
    await cdp.send('Page.reload', {}, sessionId);
    await loaded;
    await waitForStatus(cdp, sessionId, 'live', thrown);
    assert.deepEqual(thrown, [], 'reloading with the drawer open threw');
    assert.equal(
      await evaluate(cdp, sessionId, `document.getElementById('sidebar').hidden`),
      false,
      'the drawer was remembered as open and should have come back open',
    );
  } finally {
    cdp?.close();
    server.child.kill();
    if (browser !== undefined) {
      const gone = new Promise((resolve) => browser?.child.once('exit', resolve));
      browser.child.kill();
      await gone;
    }
    // Windows holds a profile open for a moment after the browser exits; see
    // the same note in `scripts/screenshots.mjs`.
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // A temporary directory left behind is not a failure of the canvas.
    }
  }
});
