/**
 * The portable half of "do not outlive the shell that started you".
 *
 * The bug this pins was measured on Fedora 44: the desktop shell was killed,
 * its node child kept running, and it kept holding the port it had been given.
 * The Windows job object has no equivalent there, so the child has to notice for
 * itself — and the thing it can notice is that the operating system handed it to
 * a reaper.
 *
 * Nothing here starts a process. The parent id is injected, which is what makes
 * the two cases that matter testable at all: a parent that is still there, and a
 * parent that has been replaced by a reaper whose pid is *not* 1.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PARENT_POLL_MS, parentIsGone, watchParent } from '../src/orphan.js';

/** Let the injected interval fire a few times. */
function tick(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the parent is gone when it is somebody else, whoever that somebody is', () => {
  // Still there.
  assert.equal(parentIsGone(4242, 4242), false);

  // The textbook reaper.
  assert.equal(parentIsGone(4242, 1), true);

  // The reaper this was actually measured against: on a systemd machine an
  // orphan is handed to the user manager, not to init. A check for pid 1 would
  // have looked right and never fired.
  assert.equal(parentIsGone(4242, 3284), true);
});

test('a process that never had a parent to lose is not treated as orphaned', () => {
  // pid 1 and pid 0 are not parents this can reason about: something already
  // owned by the reaper has nothing left to be orphaned from.
  assert.equal(parentIsGone(1, 1), false);
  assert.equal(parentIsGone(0, 1), false);
  assert.equal(parentIsGone(Number.NaN, 1), false);
  // An unreadable current parent is not evidence either.
  assert.equal(parentIsGone(4242, 0), false);
  assert.equal(parentIsGone(4242, Number.NaN), false);
});

test('the watch fires once when the parent is replaced, and then stops looking', async () => {
  let parent = 4242;
  let reads = 0;
  let fired = 0;

  const watch = watchParent({
    parent,
    read: () => {
      reads += 1;
      return parent;
    },
    onGone: () => {
      fired += 1;
    },
    every: 1,
  });

  await tick();
  assert.equal(fired, 0, 'a parent that is still there is not a reason to exit');
  assert.ok(reads > 0, 'the watch is actually looking');

  parent = 3284;
  await tick();
  assert.equal(fired, 1);

  // Once is once: the timer is cleared before the callback, so a slow shutdown
  // cannot be started twice.
  const after = reads;
  await tick();
  assert.equal(fired, 1);
  assert.equal(reads, after, 'the watch stopped looking after it fired');
  assert.equal(watch.watching(), false);
});

test('stop() ends the watch before it can fire', async () => {
  let fired = 0;
  const watch = watchParent({
    parent: 4242,
    read: () => 1,
    onGone: () => {
      fired += 1;
    },
    every: 1,
  });
  watch.stop();
  watch.stop(); // idempotent
  await tick();
  assert.equal(fired, 0);
  assert.equal(watch.watching(), false);
});

test('a parent of 1 starts no timer at all', async () => {
  let reads = 0;
  const watch = watchParent({
    parent: 1,
    read: () => {
      reads += 1;
      return 9999;
    },
    onGone: () => assert.fail('nothing to be orphaned from'),
    every: 1,
  });
  await tick();
  assert.equal(reads, 0);
  assert.equal(watch.watching(), false);
});

test('the default interval is a second, which is what an idle timer is worth', () => {
  assert.equal(PARENT_POLL_MS, 1000);
});
