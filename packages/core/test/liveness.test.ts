/**
 * Liveness. The child process spawned here is this test's own: no Claude Code
 * session is ever probed by signal, listed, or ended.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { isPidAlive } from '../src/liveness.ts';

test('this process is alive', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('a pid that cannot exist is not alive', () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(1.5), false);
  assert.equal(isPidAlive(Number.NaN), false);
});

test('a child process is alive until it ends, then it is not', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    stdio: 'ignore',
  });
  await once(child, 'spawn');

  const pid = child.pid;
  assert.ok(pid !== undefined);
  assert.equal(isPidAlive(pid), true);

  child.kill();
  await once(child, 'exit');
  // On Windows the process object is reaped before the pid is released; give
  // the OS a beat rather than racing it.
  for (let attempt = 0; attempt < 50 && isPidAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(isPidAlive(pid), false, 'the pid should be gone once the child has exited');
});
