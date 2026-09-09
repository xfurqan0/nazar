/**
 * N-WP20: the history drawer, driven rather than read.
 *
 * `test/history-markup.test.ts` is the contract test between `history.ts`,
 * `styles.css` and `index.html` — it greps, on purpose, because a class name
 * agreeing across three files is a text-level fact. This suite is the other
 * half and deliberately never looks at the source: it builds a real
 * `HistoryPanel` over the DOM double, clicks its real buttons, resolves its
 * transport by hand, and counts the elements the panel actually produced.
 *
 * Both bugs it covers were invisible to a source scan, because in both the
 * source said exactly the right thing:
 *
 * - **The listing stopped at 200.** `PAGE_SIZE` was 200 and `list(PAGE_SIZE)`
 *   is what the file said; the server had been returning `nextOffset` for the
 *   rest all along and nothing asked for it. The drawer printed "200 of 201".
 * - **An old answer overwrote a new one.** `select()` awaited and then drew,
 *   which reads correctly until two selections are in flight — then the tree on
 *   the canvas is whichever request the disk happened to finish last, and an
 *   answer arriving after the drawer closed re-opened it onto a frozen canvas
 *   whose back button was no longer wired to anything.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import '../catalogs.ts';
import { FakeElement, root } from './double.ts';
import type { History, HistoryListPage, HistorySummary } from '@nazar/core';
import { HistoryPanel } from '../../web/history.ts';
import type { HistoryTransport } from '../../web/history.ts';

/**
 * Let the panel finish whatever it started.
 *
 * `open()`, a click on a row and a click on "load more" all kick off async work
 * with `void`, and the panel guards itself with a `loading` flag — so calling
 * `await panel.refresh()` straight after `open()` would return *immediately*,
 * having done nothing, while the real load was still in flight. Draining to the
 * next macrotask is what actually waits for it, and it keeps every test driving
 * the panel the way a user does rather than by calling its internals.
 */
function settle(): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, 0);
  });
}

const PROJECT = 'C--proj-alpha';

/** `count` listing rows, newest first, in one project. */
function summaries(count: number): HistorySummary[] {
  return Array.from({ length: count }, (_unused, index) => ({
    sessionId: `session-${String(index).padStart(3, '0')}`,
    project: PROJECT,
    transcriptBytes: 1024 + index,
    lastWriteAt: 1_788_000_000_000 - index * 1000,
    hydrated: false,
  }));
}

/** A frozen tree with nothing in it: this suite is about the plumbing. */
function history(sessionId: string): History {
  return {
    sessionId,
    project: PROJECT,
    agentCount: 0,
    agents: [],
    roots: [],
    orphans: [],
    dedupeFallbacks: 0,
    bytesRead: 0,
  };
}

/** A transport backed by an array, paging exactly as the server does. */
function pagingTransport(rows: readonly HistorySummary[]): {
  transport: HistoryTransport;
  calls: { limit: number; offset: number }[];
} {
  const calls: { limit: number; offset: number }[] = [];
  const transport: HistoryTransport = {
    list: async (limit, offset = 0) => {
      calls.push({ limit, offset });
      const page = rows.slice(offset, offset + limit);
      const result: {
        -readonly [K in keyof HistoryListPage]: HistoryListPage[K];
      } = {
        generatedAt: 1_788_000_000_000,
        total: rows.length,
        offset,
        sessions: page,
        projects: [PROJECT],
        listMs: 4,
        warnings: 0,
      };
      if (offset + page.length < rows.length) result.nextOffset = offset + page.length;
      return result;
    },
    open: async (sessionId) => history(sessionId),
    ids: async () => rows.map((row) => row.sessionId),
  };
  return { transport, calls };
}

/** The rows the panel actually built, as session ids in document order. */
function shownIds(host: FakeElement): string[] {
  return host
    .byClass('nz-hrow')
    .map((node) => node.dataset['sessionId'])
    .filter((id): id is string => id !== undefined);
}

function moreButton(host: FakeElement): FakeElement | undefined {
  return host.byClass('nz-history__more')[0];
}

/* ------------------------------------------------------------------ *
 * Item 3: the store past the first page
 * ------------------------------------------------------------------ */

test('N-WP20: a 201-session store shows 200 rows, and "load more" reaches the 201st', async () => {
  const rows = summaries(201);
  const { transport, calls } = pagingTransport(rows);
  const host = root();
  const panel = new HistoryPanel({
    root: host as unknown as HTMLElement,
    transport,
    onSelect: () => undefined,
    onClose: () => undefined,
  });

  panel.open();
  await settle();

  // The bug, stated as an assertion: one page, and the 201st is not on screen.
  assert.equal(shownIds(host).length, 200, 'the first page is 200 rows');
  assert.equal(panel.hasMore, true, 'the server said there was more');
  assert.equal(shownIds(host).includes('session-200'), false);

  const more = moreButton(host);
  assert.ok(more !== undefined, 'a listing with more to come offers a way to it');
  assert.equal(more.hidden, false);
  assert.equal(more.tag, 'button', 'it is a real button, so it is tabbable');
  assert.equal(more.type, 'button', 'and it submits no form');

  // The actual gesture: click it. Not "the source mentions loadMore".
  more.dispatch('click');
  await settle();

  const after = shownIds(host);
  assert.equal(after.length, 201, 'the second page was appended, not swapped in');
  assert.equal(after[200], 'session-200', 'and the 201st session is now on screen');
  assert.deepEqual(
    after.slice(0, 200),
    rows.slice(0, 200).map((row) => row.sessionId),
    'the first page kept its rows and its order',
  );
  assert.equal(panel.hasMore, false, 'nothing follows the last page');
  assert.equal(moreButton(host)?.hidden, true, 'so the control that promised more is gone');

  // Two requests, at the two offsets, and no third: paging must not re-walk.
  assert.deepEqual(calls, [
    { limit: 200, offset: 0 },
    { limit: 200, offset: 200 },
  ]);
});

test('N-WP20: scrolling to the end of the list loads the next page too', async () => {
  const rows = summaries(201);
  const { transport } = pagingTransport(rows);
  const host = root();
  const panel = new HistoryPanel({
    root: host as unknown as HTMLElement,
    transport,
    onSelect: () => undefined,
    onClose: () => undefined,
  });
  panel.open();
  await settle();
  assert.equal(shownIds(host).length, 200);

  const list = host.byClass('nz-history__list')[0];
  assert.ok(list !== undefined);
  assert.equal(list.listensFor('scroll'), true);

  // Not at the end yet: 4000 px of list, 400 px of window, scrolled to 100.
  list.scrollHeight = 4000;
  list.clientHeight = 400;
  list.scrollTop = 100;
  list.dispatch('scroll');
  await settle();
  assert.equal(shownIds(host).length, 200, 'the middle of the list asks for nothing');

  // At the end: the remaining gap is under the threshold.
  list.scrollTop = 3600;
  list.dispatch('scroll');
  await settle();
  assert.equal(shownIds(host).length, 201, 'reaching the end appends the next page');
});

test('N-WP20: a project split across a page boundary is one heading, not two', async () => {
  const rows = summaries(201);
  const { transport } = pagingTransport(rows);
  const host = root();
  const panel = new HistoryPanel({
    root: host as unknown as HTMLElement,
    transport,
    onSelect: () => undefined,
    onClose: () => undefined,
  });
  panel.open();
  await settle();
  await panel.loadMore();

  // All 201 rows are in one project, so grouping the *merged* list gives one
  // section. Grouping page by page would give two, and the drawer would show
  // the same folder name twice with a rule between them.
  assert.equal(host.byClass('nz-history__group').length, 1);
  assert.equal(host.byClass('nz-history__rows').length, 1);
  assert.equal(host.byClass('nz-hrow').length, 201);
});

test('N-WP20: refreshing after a row is opened keeps the pages already loaded', async () => {
  const rows = summaries(201);
  const { transport, calls } = pagingTransport(rows);
  const host = root();
  const panel = new HistoryPanel({
    root: host as unknown as HTMLElement,
    transport,
    onSelect: () => undefined,
    onClose: () => undefined,
  });
  panel.open();
  await settle();
  await panel.loadMore();
  assert.equal(shownIds(host).length, 201);

  calls.length = 0;
  // `select()` refreshes so the row it just opened can show its own numbers.
  // That refresh must not silently take the user back to page one.
  await panel.refresh();
  assert.equal(shownIds(host).length, 201, 'the second page survived the refresh');
  assert.deepEqual(calls, [
    { limit: 200, offset: 0 },
    { limit: 200, offset: 200 },
  ]);
});

/* ------------------------------------------------------------------ *
 * Item 4: only the newest request may write to the screen
 * ------------------------------------------------------------------ */

/** A transport whose `open` is resolved by the test, one session at a time. */
function manualTransport(rows: readonly HistorySummary[]): {
  transport: HistoryTransport;
  resolve: (sessionId: string) => void;
  aborted: string[];
} {
  const waiting = new Map<string, (value: History) => void>();
  const aborted: string[] = [];
  const paging = pagingTransport(rows);
  return {
    transport: {
      list: paging.transport.list,
      ids: paging.transport.ids,
      open: (sessionId, signal) =>
        new Promise<History>((done) => {
          waiting.set(sessionId, done);
          signal?.addEventListener('abort', () => aborted.push(sessionId));
        }),
    },
    resolve: (sessionId) => {
      const done = waiting.get(sessionId);
      assert.ok(done !== undefined, `nothing was waiting for ${sessionId}`);
      done(history(sessionId));
    },
    aborted,
  };
}

test('N-WP20: the second click wins, however slow the first request is', async () => {
  const rows = summaries(3);
  const { transport, resolve } = manualTransport(rows);
  const selected: string[] = [];
  const host = root();
  const panel = new HistoryPanel({
    root: host as unknown as HTMLElement,
    transport,
    onSelect: (one) => selected.push(one.sessionId),
    onClose: () => undefined,
  });
  panel.open();
  await settle();

  const rowsOnScreen = host.byClass('nz-hrow');
  const first = rowsOnScreen.find((node) => node.dataset['sessionId'] === 'session-000');
  const second = rowsOnScreen.find((node) => node.dataset['sessionId'] === 'session-001');
  assert.ok(first !== undefined && second !== undefined);

  // Click A, then B — through the rows' own click handlers.
  first.dispatch('click');
  second.dispatch('click');

  // B answers first, then A. A is the older question and must be dropped.
  resolve('session-001');
  await Promise.resolve();
  resolve('session-000');
  await settle();

  assert.deepEqual(
    selected,
    ['session-001'],
    'the canvas was drawn once, with the session the user asked for last',
  );
  assert.equal(
    first.classList.contains('is-selected'),
    false,
    'and the row nobody is looking at is not marked as the selected one',
  );
  assert.equal(second.classList.contains('is-selected'), true);
});

test('N-WP20: an answer that arrives after the drawer closed does not re-open it', async () => {
  const rows = summaries(3);
  const { transport, resolve, aborted } = manualTransport(rows);
  const events: string[] = [];
  const host = root();
  const panel = new HistoryPanel({
    root: host as unknown as HTMLElement,
    transport,
    onSelect: (one) => events.push(`selected:${one.sessionId}`),
    onClose: () => events.push('closed'),
  });
  panel.open();
  await settle();

  const row = host.byClass('nz-hrow').find((node) => node.dataset['sessionId'] === 'session-000');
  assert.ok(row !== undefined);
  row.dispatch('click');

  // The user gives up waiting and closes the drawer — with Escape, through the
  // real key handler, not by calling `close()`.
  host.dispatch('keydown', { key: 'Escape' });
  assert.equal(panel.isOpen, false);

  // ...and only then does the transcript finish parsing.
  resolve('session-000');
  await settle();

  assert.deepEqual(events, ['closed'], 'the canvas was never frozen by a withdrawn question');
  assert.equal(panel.isOpen, false, 'and the drawer stayed shut');
  assert.deepEqual(aborted, ['session-000'], 'the request nobody wanted was aborted');
});

test('N-WP20: a selection still draws when it is the only one in flight', async () => {
  // The guard must not be so eager that the ordinary case stops working, which
  // is the failure mode a sequence number invites.
  const rows = summaries(3);
  const { transport, resolve } = manualTransport(rows);
  const selected: string[] = [];
  const host = root();
  const panel = new HistoryPanel({
    root: host as unknown as HTMLElement,
    transport,
    onSelect: (one) => selected.push(one.sessionId),
    onClose: () => undefined,
  });
  panel.open();
  await settle();

  const row = host.byClass('nz-hrow').find((node) => node.dataset['sessionId'] === 'session-001');
  assert.ok(row !== undefined);
  row.dispatch('click');
  resolve('session-001');
  await settle();

  assert.deepEqual(selected, ['session-001']);
  assert.equal(row.classList.contains('is-selected'), true);
});
