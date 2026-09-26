/**
 * Restoring the drawer on load is not a change, so it reports none.
 *
 * `app.ts` used to restore a remembered drawer through `set`, which calls
 * `onChange` — and the `onChange` it passes asks for a frame through a
 * `schedule` declared a thousand lines further down `start()`. A drawer left
 * open therefore threw on every load and the canvas never opened its stream.
 * `test/canvas-boot.test.ts` drives that whole page in a browser; this pins the
 * drawer's half of it without one: `restore` puts the drawer where it was and
 * calls nobody, and `set` — what the button and Escape use — still reports.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeElement, root } from './double.ts';
import { Sidebar } from '../../web/sidebar.ts';

function drawer(): { sidebar: Sidebar; panel: FakeElement; toggle: FakeElement; changes: boolean[] } {
  const panel = root();
  panel.hidden = true;
  const toggle = new FakeElement('button');
  const changes: boolean[] = [];
  const sidebar = new Sidebar({
    root: panel as unknown as HTMLElement,
    toggle: toggle as unknown as HTMLButtonElement,
    onChange: (open) => changes.push(open),
  });
  return { sidebar, panel, toggle, changes };
}

const body = (): FakeElement => (document as unknown as { body: FakeElement }).body;

test('a restored drawer opens without reporting a change', () => {
  const { sidebar, panel, toggle, changes } = drawer();

  sidebar.restore(true);

  assert.equal(sidebar.isOpen, true);
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(body().classList.contains('has-sidebar'), true);
  assert.deepEqual(changes, [], 'a restore on load must not call onChange');
  assert.equal(toggle.focusCount, 0, 'a restore on load must not move focus');

  sidebar.restore(false);
  assert.equal(panel.hidden, true);
  assert.equal(body().classList.contains('has-sidebar'), false);
  assert.deepEqual(changes, []);
});

test('the button still reports, so the choice is still stored', () => {
  const { sidebar, toggle, changes } = drawer();
  sidebar.restore(true);

  toggle.dispatch('click');
  assert.equal(sidebar.isOpen, false);
  toggle.dispatch('click');
  assert.equal(sidebar.isOpen, true);
  assert.deepEqual(changes, [false, true]);
});
