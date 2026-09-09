/**
 * N-WP21: the Needs-you strip, driven rather than read.
 *
 * `test/needs-you.test.ts` proves the decisions; this proves the screen. It
 * builds a real `NeedsYouStrip` over the DOM double, feeds it real snapshots
 * frame by frame, clicks its real rows and presses its real keys, and counts
 * the elements that actually exist — which is the only way to catch the four
 * bugs this shape of component has, every one of which leaves the source
 * saying exactly the right thing:
 *
 * - a badge that is drawn when nobody is waiting, or hidden when somebody is;
 * - a list whose *order* is the order rows were created rather than the order
 *   they were sorted into, so the longest wait is wherever it happens to land;
 * - a row whose handler never fires, or fires with the wrong session;
 * - a jump offered in a browser, where nothing can answer it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import '../catalogs.ts';
import { FakeElement, root } from './double.ts';
import type { NeedsYouSession } from '../../src/needs-you.ts';
import { NeedsYouStrip } from '../../web/needs-you.ts';

const NOW = 1_788_000_000_000;

type Seed = Partial<NeedsYouSession> & { readonly id: string };

function session(seed: Seed): NeedsYouSession {
  return { cwd: `C:\\proj\\${seed.id}`, status: 'idle', state: 'alive', agents: [], ...seed };
}

function waiting(id: string, waitingFor: string): NeedsYouSession {
  return session({ id, status: 'waiting', waitingFor });
}

function busy(id: string): NeedsYouSession {
  return session({ id, status: 'busy' });
}

interface Mounted {
  readonly strip: NeedsYouStrip;
  readonly button: FakeElement;
  readonly count: FakeElement;
  readonly longest: FakeElement;
  readonly live: FakeElement;
  readonly panel: FakeElement;
  readonly list: FakeElement;
  readonly empty: FakeElement;
  readonly finishedGroup: FakeElement;
  readonly finishedToggle: FakeElement;
  readonly finishedList: FakeElement;
  /** Every `onGo`, in order. */
  readonly went: string[];
  /** Every `onJump`. Empty for ever in a browser, which is the point. */
  readonly jumped: string[];
}

/** Build the strip over a detached tree, as the page builds it over its own. */
function mount(options: { shell?: boolean; names?: Record<string, string> } = {}): Mounted {
  const button = root();
  const count = root();
  const longest = root();
  const live = root();
  const panel = root();
  const title = root();
  const list = root();
  const empty = root();
  const finishedGroup = root();
  const finishedToggle = root();
  const finishedList = root();
  const went: string[] = [];
  const jumped: string[] = [];

  const strip = new NeedsYouStrip({
    button: button as unknown as HTMLButtonElement,
    count: count as unknown as HTMLElement,
    longest: longest as unknown as HTMLElement,
    live: live as unknown as HTMLElement,
    panel: panel as unknown as HTMLElement,
    title: title as unknown as HTMLElement,
    list: list as unknown as HTMLElement,
    empty: empty as unknown as HTMLElement,
    finishedGroup: finishedGroup as unknown as HTMLElement,
    finishedToggle: finishedToggle as unknown as HTMLElement,
    finishedList: finishedList as unknown as HTMLElement,
    names: () => options.names ?? {},
    onGo: (id) => went.push(id),
    ...(options.shell === true ? { onJump: (id: string) => jumped.push(id) } : {}),
  });

  return {
    strip,
    button,
    count,
    longest,
    live,
    panel,
    list,
    empty,
    finishedGroup,
    finishedToggle,
    finishedList,
    went,
    jumped,
  };
}

/** The rows in the order the DOM holds them, which is the order the eye reads. */
function rowsOf(list: FakeElement): FakeElement[] {
  return list.children;
}

/** The text a row shows, column by column. */
function columns(row: FakeElement): string[] {
  return row.byClass('nz-needs__name').concat(
    row.byClass('nz-needs__folder'),
    row.byClass('nz-needs__what'),
    row.byClass('nz-needs__since'),
  ).map((node) => node.textContent);
}

/* ------------------------------------------------------------------ *
 * The badge and the list
 * ------------------------------------------------------------------ */

test('two waiting and one working: the badge counts two and the longest wait is first', () => {
  const ui = mount();
  // `a` starts waiting first; `c` joins nine minutes later. `b` never waits.
  ui.strip.render([waiting('a', 'permission prompt'), busy('b')], NOW, NOW);
  ui.strip.render(
    [waiting('a', 'permission prompt'), busy('b'), waiting('c', 'input needed')],
    NOW + 9 * 60_000,
    NOW + 9 * 60_000,
  );

  assert.equal(ui.button.hidden, false, 'the badge is not drawn while two sessions wait');
  assert.equal(ui.count.textContent, 'Needs you · 2');
  assert.equal(ui.longest.textContent, '9m 00s');
  assert.equal(ui.button.classList.contains('is-waiting'), true);
  assert.match(ui.button.getAttribute('aria-label') ?? '', /2 sessions are waiting for you/);

  const rows = rowsOf(ui.list);
  assert.equal(rows.length, 2, `expected two rows, found ${String(rows.length)}`);
  assert.deepEqual(
    rows.map((row) => row.dataset['sessionId']),
    ['a', 'c'],
  );
  assert.deepEqual(columns(rows[0]!), ['a', 'C:\\proj\\a', 'permission prompt', '9m 00s']);
  assert.deepEqual(columns(rows[1]!), ['c', 'C:\\proj\\c', 'input needed', '0s']);
});

test('the list re-sorts itself: a newer wait that outlives an older one moves up', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  ui.strip.render(
    [waiting('a', 'permission prompt'), waiting('b', 'input needed')],
    NOW + 60_000,
    NOW + 60_000,
  );
  assert.deepEqual(
    rowsOf(ui.list).map((row) => row.dataset['sessionId']),
    ['a', 'b'],
  );

  // `a` answers its prompt and asks a new question; `b` has now been waiting
  // longer than `a` has, so `b` is the row at the top. The nodes move rather
  // than being rebuilt — the ids are the same objects — and the *order* is
  // what this test is about.
  ui.strip.render(
    [waiting('a', 'input needed'), waiting('b', 'input needed')],
    NOW + 120_000,
    NOW + 120_000,
  );
  assert.deepEqual(
    rowsOf(ui.list).map((row) => row.dataset['sessionId']),
    ['b', 'a'],
  );
  assert.equal(rowsOf(ui.list)[1]?.byClass('nz-needs__since')[0]?.textContent, '0s');
});

test('a change of what a session waits for resets the number on its row', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  ui.strip.render([waiting('a', 'permission prompt')], NOW + 300_000, NOW + 300_000);
  assert.equal(rowsOf(ui.list)[0]?.byClass('nz-needs__since')[0]?.textContent, '5m 00s');

  ui.strip.render([waiting('a', 'sandbox request')], NOW + 300_000, NOW + 300_000);
  const row = rowsOf(ui.list)[0]!;
  assert.equal(row.byClass('nz-needs__what')[0]?.textContent, 'sandbox request');
  assert.equal(row.byClass('nz-needs__since')[0]?.textContent, '0s');
});

test('nobody waiting and nothing finished: the badge goes, the announcement stays', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.live.textContent, '1 session is waiting for you');

  // The terminal was closed, so the machine lists nothing at all: no wait, and
  // nothing that finished either, because a row whose card is gone would be a
  // button that goes nowhere.
  ui.strip.render([], NOW + 1_000, NOW + 1_000);
  assert.equal(ui.button.hidden, true, 'there is a Needs you · 0 on screen');
  assert.equal(rowsOf(ui.list).length, 0);
  // The live region is never hidden, so this is the sentence that gets read
  // out at the moment the badge disappears.
  assert.equal(ui.live.textContent, 'Nobody is waiting for you.');
});

test('an open panel closes itself when the last waiting session is answered', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  ui.strip.set(true, false);
  assert.equal(ui.panel.hidden, false);

  ui.strip.render([busy('a')], NOW + 1_000, NOW + 1_000);
  assert.equal(ui.panel.hidden, true, 'the panel stayed open over an empty list');
  assert.equal(ui.strip.isOpen, false);
});

test('the empty line names the age of the reading behind it', () => {
  const ui = mount();
  // A session finished, so the badge exists; opening it with nothing waiting is
  // what the empty line is for.
  ui.strip.render([busy('a')], NOW, NOW);
  ui.strip.render([session({ id: 'a' })], NOW + 1_000, NOW + 1_000);
  assert.equal(ui.button.hidden, false, 'a finished run alone should still open the list');
  assert.equal(ui.empty.hidden, true, 'the finished cluster is not nothing');

  ui.strip.render([], NOW + 2_000, NOW - 10_000);
  assert.equal(ui.empty.hidden, false);
  assert.equal(ui.empty.textContent, 'Nobody is waiting for you. Last read 12s ago.');
});

/* ------------------------------------------------------------------ *
 * Finished while you were away
 * ------------------------------------------------------------------ */

test('a run that ends enters the second cluster, and leaves it when it starts again', () => {
  const ui = mount();
  const done = session({
    id: 'a',
    startedAt: NOW - 600_000,
    transcriptAt: NOW - 300_000,
    costUsd: 9.6005,
    treeTokens: { in: 12_043, out: 3_120 },
  });

  ui.strip.render([busy('a')], NOW, NOW);
  assert.equal(ui.finishedGroup.hidden, true);

  ui.strip.render([done], NOW + 1_000, NOW + 1_000);
  assert.equal(ui.finishedGroup.hidden, false);
  const rows = rowsOf(ui.finishedList);
  assert.equal(rows.length, 1);
  assert.deepEqual(columns(rows[0]!), [
    'a',
    'C:\\proj\\a',
    'ran 5m 00s · 12,043 in · 3,120 out · $9.60',
    'just now',
  ]);

  ui.strip.render([busy('a')], NOW + 2_000, NOW + 2_000);
  assert.equal(rowsOf(ui.finishedList).length, 0, 'a session that came back is still listed as done');
  assert.equal(ui.finishedGroup.hidden, true);
});

test('the second cluster folds away and back, and keeps no key to remember it by', () => {
  const ui = mount();
  ui.strip.render([busy('a')], NOW, NOW);
  ui.strip.render([session({ id: 'a' })], NOW + 1_000, NOW + 1_000);
  assert.equal(ui.finishedList.hidden, false, 'the cluster does not start open');
  assert.equal(ui.finishedToggle.getAttribute('aria-expanded'), 'true');

  ui.finishedToggle.dispatch('click');
  assert.equal(ui.finishedList.hidden, true);
  assert.equal(ui.finishedToggle.getAttribute('aria-expanded'), 'false');

  ui.finishedToggle.dispatch('click');
  assert.equal(ui.finishedList.hidden, false);
  assert.equal(ui.finishedToggle.getAttribute('aria-expanded'), 'true');
});

/* ------------------------------------------------------------------ *
 * The row is a button
 * ------------------------------------------------------------------ */

test('clicking a row asks for that card and closes the panel over it', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  ui.strip.render(
    [waiting('a', 'permission prompt'), waiting('b', 'input needed')],
    NOW + 60_000,
    NOW + 60_000,
  );
  ui.strip.set(true, false);

  rowsOf(ui.list)[1]!.dispatch('click');
  assert.deepEqual(ui.went, ['b'], 'the row took us to the wrong session');
  // The panel overlays the canvas it has just scrolled: leaving it open would
  // be a gesture that half worked.
  assert.equal(ui.panel.hidden, true);
});

test('the jump is offered in the shell and nowhere else', () => {
  const shell = mount({ shell: true });
  shell.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  rowsOf(shell.list)[0]!.dispatch('click');
  assert.deepEqual(shell.went, ['a']);
  assert.deepEqual(shell.jumped, ['a']);

  const browser = mount();
  browser.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  rowsOf(browser.list)[0]!.dispatch('click');
  assert.deepEqual(browser.went, ['a'], 'the card is reached in a browser too');
  assert.deepEqual(browser.jumped, [], 'a browser was offered a jump it cannot answer');
});

test('a named card is listed by its name, in the row and in its label', () => {
  const ui = mount({ names: { a: 'release build' } });
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  const row = rowsOf(ui.list)[0]!;
  assert.equal(row.byClass('nz-needs__name')[0]?.textContent, 'release build');
  assert.match(row.getAttribute('aria-label') ?? '', /^release build in C:\\proj\\a — waiting for/);
});

/* ------------------------------------------------------------------ *
 * The keyboard
 * ------------------------------------------------------------------ */

test('the arrows walk the list in the order it is drawn, and wrap', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  ui.strip.render(
    [waiting('a', 'permission prompt'), waiting('b', 'input needed')],
    NOW + 60_000,
    NOW + 60_000,
  );
  ui.strip.set(true, false);

  const [first, second] = rowsOf(ui.list);
  ui.panel.dispatch('keydown', { key: 'ArrowDown', target: first });
  assert.equal(second?.focusCount, 1, 'ArrowDown did not reach the next row');

  ui.panel.dispatch('keydown', { key: 'ArrowDown', target: second });
  assert.equal(first?.focusCount, 1, 'the list did not wrap at the bottom');

  ui.panel.dispatch('keydown', { key: 'ArrowUp', target: first });
  assert.equal(second?.focusCount, 2, 'the list did not wrap at the top');
});

test('the arrows cross into the finished cluster, and stop at its fold', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt'), busy('b')], NOW, NOW);
  ui.strip.render(
    [waiting('a', 'permission prompt'), session({ id: 'b' })],
    NOW + 1_000,
    NOW + 1_000,
  );
  ui.strip.set(true, false);

  const waitingRow = rowsOf(ui.list)[0]!;
  const finishedRow = rowsOf(ui.finishedList)[0]!;
  ui.panel.dispatch('keydown', { key: 'ArrowDown', target: waitingRow });
  assert.equal(finishedRow.focusCount, 1);

  // Folded away, the finished rows are not on screen and the arrows must not
  // move focus onto something nobody can see.
  ui.finishedToggle.dispatch('click');
  ui.panel.dispatch('keydown', { key: 'ArrowDown', target: waitingRow });
  assert.equal(finishedRow.focusCount, 1, 'the arrows walked into a folded-away cluster');
  assert.equal(waitingRow.focusCount, 1, 'a one-row ring did not come back to itself');
});

test('Escape closes the panel and hands the keyboard back to the badge', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  ui.strip.set(true, false);

  let stopped = 0;
  ui.panel.dispatch('keydown', { key: 'Escape', stopPropagation: () => (stopped += 1) });
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.button.focusCount, 1, 'focus was left inside a hidden panel');
  // The page's own Escape handler closes the sidebar; an Escape answered here
  // must not also close that.
  assert.equal(stopped, 1);
});

test('opening from the keyboard lands on the longest wait', () => {
  const ui = mount();
  ui.strip.render([waiting('a', 'permission prompt')], NOW, NOW);
  ui.strip.render(
    [waiting('a', 'permission prompt'), waiting('b', 'input needed')],
    NOW + 60_000,
    NOW + 60_000,
  );

  ui.button.dispatch('click');
  assert.equal(ui.strip.isOpen, true);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.button.getAttribute('aria-expanded'), 'true');
  assert.equal(rowsOf(ui.list)[0]?.focusCount, 1, 'the keyboard did not land on the top row');
  assert.equal(rowsOf(ui.list)[1]?.focusCount, 0, 'focus went somewhere other than the top row');
});
