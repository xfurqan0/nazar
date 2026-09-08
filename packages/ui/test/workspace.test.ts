/**
 * The arrangement, in the browser and nowhere else.
 *
 * Nazar writes nothing to disk — `test/no-writes.test.ts` is the static proof —
 * so "remember where I put that card" has exactly one home: `localStorage` on
 * the page's own origin. That makes it awkward to test in Node, which is why
 * every function here takes a `StorageLike`: three methods, satisfied by
 * `localStorage` in the browser and by a `Map` here. No jsdom, and the
 * round-trip is the real one.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  ALL_TAB,
  cleanTabName,
  clearedFor,
  createProjectTab,
  createTab,
  EMPTY_LAYOUT,
  EMPTY_TABS,
  folderTabAt,
  followProject,
  guarded,
  isCollapsed,
  isPinned,
  LAYOUT_KEY,
  memoryStorage,
  moveSession,
  openFolderTab,
  projectTabFor,
  projectTabs,
  pruneLayout,
  pruneTabs,
  readLayout,
  readTabs,
  removeTab,
  renameTab,
  sessionsOnTab,
  setActiveTab,
  setAutoProjects,
  TABS_KEY,
  tabCounts,
  tabOf,
  widthOf,
  withCleared,
  withCollapsed,
  withPosition,
  withRestored,
  withWidth,
  withAutoSize,
  withHeight,
  heightOf,
  isSized,
  writeLayout,
  writeTabs,
} from '../src/workspace.ts';

/* ------------------------------------------------------------------ *
 * Positions
 * ------------------------------------------------------------------ */

test('a dragged position survives the round trip', () => {
  const storage = memoryStorage();
  let layout = readLayout(storage);
  assert.deepEqual(layout, EMPTY_LAYOUT);

  layout = withPosition(layout, 'session-a', { x: -420.5, y: 1180 });
  layout = withPosition(layout, 'session-b', { x: 0, y: 0 });
  writeLayout(storage, layout);

  const back = readLayout(storage);
  assert.deepEqual(back.positions['session-a'], { x: -420.5, y: 1180 });
  assert.deepEqual(back.positions['session-b'], { x: 0, y: 0 });
});

test('moving the same card twice leaves one position, the last one', () => {
  const storage = memoryStorage();
  let layout = withPosition(readLayout(storage), 's', { x: 10, y: 10 });
  layout = withPosition(layout, 's', { x: 90, y: 90 });
  writeLayout(storage, layout);
  assert.deepEqual(readLayout(storage).positions, { s: { x: 90, y: 90 } });
});

test('a folded tree and an open sidebar are remembered too', () => {
  const storage = memoryStorage();
  let layout = withCollapsed(readLayout(storage), 's', true);
  layout = { ...layout, sidebar: true };
  writeLayout(storage, layout);

  const back = readLayout(storage);
  assert.equal(isCollapsed(back, 's'), true);
  assert.equal(back.sidebar, true);

  writeLayout(storage, withCollapsed(back, 's', false));
  assert.equal(isCollapsed(readLayout(storage), 's'), false);
});

test('nonsense in storage is ignored rather than drawn', () => {
  assert.deepEqual(readLayout(memoryStorage({ [LAYOUT_KEY]: 'not json' })), EMPTY_LAYOUT);
  assert.deepEqual(readLayout(memoryStorage({ [LAYOUT_KEY]: '[]' })), EMPTY_LAYOUT);
  const partial = readLayout(
    memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({
        positions: { good: { x: 1, y: 2 }, bad: { x: 'left' }, worse: null, nan: { x: 0, y: NaN } },
        collapsed: ['a', 7],
      }),
    }),
  );
  assert.deepEqual(partial.positions, { good: { x: 1, y: 2 } });
  assert.deepEqual(partial.collapsed, ['a']);
});

test('a storage that throws downgrades to memory instead of blanking the canvas', () => {
  const hostile = guarded({
    getItem: () => {
      throw new Error('site data blocked');
    },
    setItem: () => {
      throw new Error('quota exceeded');
    },
    removeItem: () => {
      throw new Error('nope');
    },
  });
  assert.deepEqual(readLayout(hostile), EMPTY_LAYOUT);
  writeLayout(hostile, withPosition(EMPTY_LAYOUT, 's', { x: 4, y: 5 }));
  assert.deepEqual(readLayout(hostile).positions, { s: { x: 4, y: 5 } });
});

test('pruneLayout forgets sessions the machine no longer has', () => {
  let layout = withPosition(EMPTY_LAYOUT, 'live', { x: 1, y: 1 });
  layout = withPosition(layout, 'gone', { x: 2, y: 2 });
  layout = withCollapsed(layout, 'gone', true);
  layout = withCollapsed(layout, 'live', true);

  const kept = pruneLayout(layout, new Set(['live']));
  assert.deepEqual(Object.keys(kept.positions), ['live']);
  assert.deepEqual(kept.collapsed, ['live']);
});

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

test('a fresh install has exactly one tab and no membership at all', () => {
  const state = readTabs(memoryStorage());
  assert.deepEqual(state, EMPTY_TABS);
  assert.deepEqual(state.tabs, [{ id: ALL_TAB, name: 'All', kind: 'manual' }]);
  assert.equal(state.autoProjects, false, 'projects are never created for you by default');
});

test('create, rename and remove round-trip through storage', () => {
  const storage = memoryStorage();
  const made = createTab(readTabs(storage), '  nazar   work  ');
  assert.equal(made.state.tabs.length, 2);
  assert.equal(made.state.tabs[1]?.name, 'nazar work', 'whitespace is squeezed');

  writeTabs(storage, setActiveTab(renameTab(made.state, made.id, 'Nazar'), made.id));
  const back = readTabs(storage);
  assert.equal(back.tabs[1]?.name, 'Nazar');
  assert.equal(back.active, made.id);

  writeTabs(storage, removeTab(back, made.id));
  const after = readTabs(storage);
  assert.deepEqual(after.tabs, [{ id: ALL_TAB, name: 'All', kind: 'manual' }]);
  assert.equal(after.active, ALL_TAB, 'the removed tab cannot stay active');
});

test('All can be neither renamed nor removed', () => {
  const state = renameTab(removeTab(EMPTY_TABS, ALL_TAB), ALL_TAB, 'Everything');
  assert.deepEqual(state.tabs, [{ id: ALL_TAB, name: 'All', kind: 'manual' }]);
});

test('cleanTabName never returns an empty label', () => {
  assert.equal(cleanTabName('   '), 'Tab');
  assert.equal(cleanTabName('', 'fallback'), 'fallback');
  assert.equal(cleanTabName('x'.repeat(80)).length, 40);
});

/** The invariant the whole model rests on. */
test('a session lives on exactly one tab, whatever it is moved through', () => {
  const first = createTab(EMPTY_TABS, 'A');
  const second = createTab(first.state, 'B');
  const sessions = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
  const ids = sessions.map((one) => one.id);

  let state = moveSession(second.state, 's1', first.id);
  state = moveSession(state, 's1', second.id);
  state = moveSession(state, 's2', first.id);

  assert.equal(tabOf(state, { id: 's1' }), second.id, 'a move replaces, it does not add');
  assert.equal(tabOf(state, { id: 's2' }), first.id);
  assert.equal(tabOf(state, { id: 's3' }), ALL_TAB, 'unfiled means All');

  // The user's own tabs partition the filed sessions; All is every session.
  const own = state.tabs.filter((tab) => tab.id !== ALL_TAB);
  const seen = own.flatMap((tab) => sessionsOnTab(state, tab.id, sessions));
  assert.equal(new Set(seen).size, seen.length, 'no session appears on two tabs');
  assert.deepEqual(sessionsOnTab(state, ALL_TAB, sessions), ids, 'All shows everything');
});

/**
  * WP4g changed this one. A move to `All` used to delete the membership; now it
  * records a **pin**, because "put this card back on All" and "this card has
  * never been filed" stopped being the same state the moment a project could
  * claim a session on its own. `followProject` is the delete.
  */
test('moving a session back to All pins it there rather than forgetting it', () => {
  const made = createTab(EMPTY_TABS, 'A');
  const filed = moveSession(made.state, 's1', made.id);
  assert.deepEqual(filed.assign, { s1: { tab: made.id, pinned: true } });
  const unfiled = moveSession(filed, 's1', ALL_TAB);
  assert.deepEqual(unfiled.assign, { s1: { tab: ALL_TAB, pinned: true } });
  assert.equal(tabOf(unfiled, { id: 's1' }), ALL_TAB);
  assert.deepEqual(followProject(unfiled, 's1').assign, {}, 'and following is the way back');
});

test('moving to a tab that does not exist changes nothing', () => {
  assert.equal(moveSession(EMPTY_TABS, 's1', 'ghost'), EMPTY_TABS);
  assert.equal(setActiveTab(EMPTY_TABS, 'ghost'), EMPTY_TABS);
});

test('removing a tab sends its sessions back to All', () => {
  const made = createTab(EMPTY_TABS, 'A');
  const filed = moveSession(made.state, 's1', made.id);
  const gone = removeTab(filed, made.id);
  assert.equal(tabOf(gone, { id: 's1' }), ALL_TAB);
  assert.deepEqual(gone.assign, {});
});

test('a membership pointing at a tab that no longer exists reads as All', () => {
  const state = readTabs(
    memoryStorage({
      [TABS_KEY]: JSON.stringify({ tabs: [{ id: 't1', name: 'A' }], assign: { s1: 't9' } }),
    }),
  );
  assert.equal(tabOf(state, { id: 's1' }), ALL_TAB);
  assert.deepEqual(state.assign, {}, 'and it is not kept');
});

test('tabCounts says how many sessions each tab would show', () => {
  const made = createTab(EMPTY_TABS, 'A');
  const state = moveSession(moveSession(made.state, 's1', made.id), 's2', made.id);
  const counts = tabCounts(state, [{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
  assert.equal(counts.get(ALL_TAB), 3);
  assert.equal(counts.get(made.id), 2);
});

/**
 * A session that ended keeps its place for as long as Claude Code keeps its
 * transcript — that is the "it stays where it was until removed" — and goes
 * only when it is neither running nor openable from history.
 */
test('pruneTabs drops memberships for sessions that are gone for good', () => {
  const made = createTab(EMPTY_TABS, 'A');
  let state = moveSession(made.state, 'running-now', made.id);
  state = moveSession(state, 'ended-this-morning', made.id);
  state = moveSession(state, 'expired-last-month', made.id);

  const kept = pruneTabs(state, new Set(['running-now', 'ended-this-morning']));
  assert.deepEqual(Object.keys(kept.assign).sort(), ['ended-this-morning', 'running-now']);
  assert.equal(tabOf(kept, { id: 'expired-last-month' }), ALL_TAB);
  assert.equal(kept.tabs.length, 2, 'an empty tab is not removed with its last session');
});

test('writeTabs never stores the All tab, which is not the user’s to lose', () => {
  const storage = memoryStorage();
  const made = createTab(EMPTY_TABS, 'A');
  writeTabs(storage, made.state);
  const raw = JSON.parse(storage.getItem(TABS_KEY) ?? '{}') as { tabs: { id: string }[] };
  assert.deepEqual(
    raw.tabs.map((one) => one.id),
    [made.id],
  );
  assert.equal(readTabs(storage).tabs[0]?.id, ALL_TAB, 'and it comes back anyway');
});

/* ------------------------------------------------------------------ *
 * WP4f: dragged widths
 * ------------------------------------------------------------------ */

test('a dragged width round-trips through storage', () => {
  const storage = memoryStorage();
  let layout = withWidth(EMPTY_LAYOUT, 's1', 517);
  layout = withWidth(layout, 's2', 940.6);
  writeLayout(storage, layout);

  const read = readLayout(storage);
  assert.equal(widthOf(read, 's1'), 517);
  assert.equal(widthOf(read, 's2'), 941, 'whole pixels, rounded on the way in');
  assert.equal(widthOf(read, 's3'), undefined, 'a card nobody sized has no entry');
});

test('resetting a width removes the entry rather than storing a default', () => {
  let layout = withWidth(EMPTY_LAYOUT, 's1', 517);
  assert.deepEqual(Object.keys(layout.widths), ['s1']);
  layout = withWidth(layout, 's1', undefined);
  assert.deepEqual(layout.widths, {}, 'sizing itself is the absence of a width, not a value');
});

test('an impossible width is dropped on the way in', () => {
  const storage = memoryStorage({
    [LAYOUT_KEY]: JSON.stringify({
      widths: { a: 400, b: 0, c: -20, d: 'wide', e: null, f: Number.NaN },
    }),
  });
  // NaN survives `JSON.stringify` as `null`, so `f` is covered by the same rule.
  assert.deepEqual(readLayout(storage).widths, { a: 400 });
});

test('a width and a position are independent facts about one card', () => {
  let layout = withPosition(EMPTY_LAYOUT, 's1', { x: 10, y: 20 });
  layout = withWidth(layout, 's1', 517);
  assert.deepEqual(layout.positions['s1'], { x: 10, y: 20 });
  assert.equal(layout.widths['s1'], 517);
  layout = withWidth(layout, 's1', undefined);
  assert.deepEqual(layout.positions['s1'], { x: 10, y: 20 }, 'resetting a width moves nothing');
});

/* ------------------------------------------------------------------ *
 * N-WP10: dragged heights
 * ------------------------------------------------------------------ */

test('a dragged height round-trips through storage beside the width', () => {
  const storage = memoryStorage();
  let layout = withHeight(EMPTY_LAYOUT, 's1', 640);
  layout = withHeight(layout, 's2', 512.4);
  layout = withWidth(layout, 's1', 517);
  writeLayout(storage, layout);

  const read = readLayout(storage);
  assert.equal(heightOf(read, 's1'), 640);
  assert.equal(heightOf(read, 's2'), 512, 'whole pixels, rounded on the way in');
  assert.equal(heightOf(read, 's3'), undefined, 'a card nobody sized has no entry');
  assert.equal(widthOf(read, 's1'), 517, 'the two axes are stored apart and stay apart');
  assert.equal(widthOf(read, 's2'), undefined, 'a height must not imply a width');
});

test('the two axes are set and cleared one at a time', () => {
  let layout = withWidth(EMPTY_LAYOUT, 's1', 517);
  assert.ok(isSized(layout, 's1'));
  assert.ok(!isSized(layout, 's2'));

  layout = withHeight(layout, 's1', 640);
  layout = withWidth(layout, 's1', undefined);
  assert.deepEqual(layout.widths, {}, 'clearing the width took the height with it');
  assert.equal(heightOf(layout, 's1'), 640);
  assert.ok(isSized(layout, 's1'), 'a card with only a height is still a sized card');

  // *Reset size* is the one that clears both, which is what the menu offers.
  layout = withAutoSize(layout, 's1');
  assert.deepEqual(layout.widths, {});
  assert.deepEqual(layout.heights, {});
  assert.ok(!isSized(layout, 's1'));
});

test('an impossible height is dropped on the way in', () => {
  const storage = memoryStorage({
    [LAYOUT_KEY]: JSON.stringify({
      heights: { a: 400, b: 0, c: -20, d: 'tall', e: null, f: Number.NaN },
    }),
  });
  // NaN survives `JSON.stringify` as `null`, so `f` is covered by the same rule.
  assert.deepEqual(readLayout(storage).heights, { a: 400 });
});

test('a height and a position are independent facts about one card', () => {
  let layout = withPosition(EMPTY_LAYOUT, 's1', { x: 10, y: 20 });
  layout = withHeight(layout, 's1', 640);
  assert.deepEqual(layout.positions['s1'], { x: 10, y: 20 });
  assert.equal(layout.heights['s1'], 640);
  layout = withHeight(layout, 's1', undefined);
  assert.deepEqual(layout.positions['s1'], { x: 10, y: 20 }, 'resetting a height moves nothing');
});

test('a v1 layout written before N-WP10 still reads, heights and all', () => {
  // The key is still `nazar.layout.v1`. A browser carrying a WP4f arrangement —
  // positions, dragged widths, cleared subagents — must not lose any of it to a
  // field it has never heard of.
  const storage = memoryStorage({
    [LAYOUT_KEY]: JSON.stringify({
      v: 1,
      positions: { s1: { x: 5, y: 6 } },
      widths: { s1: 744 },
      collapsed: ['s1'],
      cleared: { s1: ['a1'] },
      sidebar: true,
    }),
  });
  const read = readLayout(storage);
  assert.deepEqual(read.positions, { s1: { x: 5, y: 6 } });
  assert.deepEqual(read.widths, { s1: 744 });
  assert.deepEqual(read.collapsed, ['s1']);
  assert.deepEqual(read.cleared, { s1: ['a1'] });
  assert.equal(read.sidebar, true);
  assert.deepEqual(read.heights, {}, 'a card with no stored height sizes its own');
  assert.equal(heightOf(read, 's1'), undefined);
});

/* ------------------------------------------------------------------ *
 * WP4f: cleared subagents
 * ------------------------------------------------------------------ */

test('cleared subagents round-trip through storage', () => {
  const storage = memoryStorage();
  const layout = withCleared(EMPTY_LAYOUT, 's1', ['a1', 'a2']);
  writeLayout(storage, layout);

  const read = readLayout(storage);
  assert.deepEqual([...clearedFor(read, 's1')].sort(), ['a1', 'a2']);
  assert.equal(clearedFor(read, 's2').size, 0, 'a card nobody cleared has nothing hidden');
});

test('clearing again is a union, not a replacement', () => {
  let layout = withCleared(EMPTY_LAYOUT, 's1', ['a1', 'a2']);
  layout = withCleared(layout, 's1', ['a2', 'a3']);
  assert.deepEqual([...clearedFor(layout, 's1')].sort(), ['a1', 'a2', 'a3']);
});

test('clearing nothing changes nothing', () => {
  const layout = withCleared(EMPTY_LAYOUT, 's1', []);
  assert.equal(layout, EMPTY_LAYOUT, 'the same object, so no frame is scheduled for it');
});

test('restoring removes the key rather than emptying it', () => {
  let layout = withCleared(EMPTY_LAYOUT, 's1', ['a1']);
  layout = withCleared(layout, 's2', ['b1']);
  layout = withRestored(layout, 's1');
  assert.deepEqual(Object.keys(layout.cleared), ['s2']);
  assert.equal(clearedFor(layout, 's1').size, 0);
  assert.equal(withRestored(layout, 'nobody'), layout, 'restoring nothing is a no-op');
});

test('cleared ids and collapse are separate answers to separate questions', () => {
  let layout = withCleared(EMPTY_LAYOUT, 's1', ['a1']);
  layout = withCollapsed(layout, 's1', true);
  assert.ok(isCollapsed(layout, 's1'));
  assert.deepEqual([...clearedFor(layout, 's1')], ['a1']);
  layout = withCollapsed(layout, 's1', false);
  assert.deepEqual([...clearedFor(layout, 's1')], ['a1'], 'expanding does not un-clear');
});

test('a hand-edited cleared list keeps only the strings in it', () => {
  const storage = memoryStorage({
    [LAYOUT_KEY]: JSON.stringify({ cleared: { a: ['x', 3, null, 'y'], b: [], c: 'nope' } }),
  });
  const read = readLayout(storage);
  assert.deepEqual(read.cleared, { a: ['x', 'y'] }, 'an empty or non-list entry is dropped');
});

test('pruning forgets the widths and the cleared lists of sessions that are gone', () => {
  let layout = withPosition(EMPTY_LAYOUT, 'gone', { x: 1, y: 2 });
  layout = withPosition(layout, 'here', { x: 3, y: 4 });
  layout = withWidth(layout, 'gone', 517);
  layout = withWidth(layout, 'here', 744);
  layout = withHeight(layout, 'gone', 600);
  layout = withHeight(layout, 'here', 620);
  layout = withCleared(layout, 'gone', ['a1']);
  layout = withCleared(layout, 'here', ['b1']);
  layout = withCollapsed(layout, 'gone', true);

  const pruned = pruneLayout(layout, new Set(['here']));
  assert.deepEqual(Object.keys(pruned.positions), ['here']);
  assert.deepEqual(Object.keys(pruned.widths), ['here']);
  assert.deepEqual(Object.keys(pruned.heights), ['here']);
  assert.deepEqual(Object.keys(pruned.cleared), ['here']);
  assert.deepEqual(pruned.collapsed, []);
});

test('a v1 layout written before WP4f still reads', () => {
  // The key is `nazar.layout.v1` and it stays that: the two new fields are
  // additive, and a browser that has been carrying an arrangement since WP4c
  // must not lose it to a schema bump it gains nothing from.
  const storage = memoryStorage({
    [LAYOUT_KEY]: JSON.stringify({ v: 1, positions: { s1: { x: 5, y: 6 } }, collapsed: ['s1'] }),
  });
  const read = readLayout(storage);
  assert.deepEqual(read.positions, { s1: { x: 5, y: 6 } });
  assert.deepEqual(read.collapsed, ['s1']);
  assert.deepEqual(read.widths, {});
  assert.deepEqual(read.cleared, {});
});

test('a blocked storage loses the width and nothing else', () => {
  const blocked = guarded({
    getItem: () => {
      throw new Error('site data blocked');
    },
    setItem: () => {
      throw new Error('site data blocked');
    },
    removeItem: () => {
      throw new Error('site data blocked');
    },
  });
  writeLayout(blocked, withWidth(EMPTY_LAYOUT, 's1', 517));
  // It falls back to memory, so the arrangement survives the session but not a
  // reload. That is the whole cost, and it is the same cost every other key
  // here pays.
  assert.equal(widthOf(readLayout(blocked), 's1'), 517);
});

/* ------------------------------------------------------------------ *
 * WP4g: projects
 * ------------------------------------------------------------------ */

/** A session as the tab model sees it: an id and a working directory. */
function at(id: string, cwd?: string): { id: string; cwd?: string } {
  return cwd === undefined ? { id } : { id, cwd };
}

test('a project tab owns every session inside its folder, and nothing else', () => {
  const made = createProjectTab(EMPTY_TABS, 'C:/proj/app');
  const state = made.state;
  assert.equal(state.tabs[1]?.kind, 'project');
  assert.equal(state.tabs[1]?.name, 'app', 'a project is called after its folder');

  assert.equal(tabOf(state, at('s1', 'C:/proj/app')), made.id, 'the folder itself');
  assert.equal(tabOf(state, at('s2', 'C:\\proj\\app\\src')), made.id, 'and anything under it');
  assert.equal(tabOf(state, at('s3', 'C:/proj/app-two')), ALL_TAB, 'a sibling with a longer name');
  assert.equal(tabOf(state, at('s4', 'C:/other')), ALL_TAB);
  assert.equal(tabOf(state, at('s5')), ALL_TAB, 'a session with no cwd is on no project');
  // Nothing was filed: the tab fills itself and the membership record is empty.
  assert.deepEqual(state.assign, {});
});

test('the deepest project wins, and adding a shallower one moves nothing', () => {
  const outer = createProjectTab(EMPTY_TABS, 'C:/proj');
  const inner = createProjectTab(outer.state, 'C:/proj/app');
  const state = inner.state;
  assert.equal(tabOf(state, at('s1', 'C:/proj/app/src')), inner.id);
  assert.equal(tabOf(state, at('s2', 'C:/proj/other')), outer.id);
  assert.equal(projectTabFor(state, 'C:/proj/app')?.id, inner.id);
});

test('a manual move beats the project rule until Follow project', () => {
  const project = createProjectTab(EMPTY_TABS, 'C:/proj/app');
  const shelf = createTab(project.state, 'Later');
  let state = shelf.state;
  assert.equal(tabOf(state, at('s1', 'C:/proj/app')), project.id, 'the rule, before anyone drags');

  state = moveSession(state, 's1', shelf.id);
  assert.equal(isPinned(state, 's1'), true);
  assert.equal(tabOf(state, at('s1', 'C:/proj/app')), shelf.id, 'the pin wins');

  state = followProject(state, 's1');
  assert.equal(isPinned(state, 's1'), false);
  assert.equal(tabOf(state, at('s1', 'C:/proj/app')), project.id, 'and the rule takes it back');
});

test('one folder, one project: asking twice hands back the tab that exists', () => {
  const first = createProjectTab(EMPTY_TABS, 'C:/proj/app');
  const again = createProjectTab(first.state, 'c:\\proj\\app\\');
  assert.equal(again.id, first.id, 'separators and case do not make a second project');
  assert.equal(projectTabs(again.state).length, 1);
});

test('project tabs round-trip through storage, name and folder both', () => {
  const storage = memoryStorage();
  const made = createProjectTab(EMPTY_TABS, 'C:/proj/app');
  writeTabs(storage, setAutoProjects(renameTab(made.state, made.id, 'Backend'), true));

  const back = readTabs(storage);
  assert.equal(back.tabs[1]?.name, 'Backend', 'a project can be renamed');
  assert.equal(back.tabs[1]?.root, 'C:/proj/app', 'and keeps the folder it owns');
  assert.equal(back.tabs[1]?.kind, 'project');
  assert.equal(back.autoProjects, true);
  assert.equal(tabOf(back, at('s1', 'C:/proj/app/src')), made.id);
});

test('removing a project deletes the rule and nothing else', () => {
  const made = createProjectTab(EMPTY_TABS, 'C:/proj/app');
  const gone = removeTab(made.state, made.id);
  assert.deepEqual(projectTabs(gone), []);
  assert.equal(tabOf(gone, at('s1', 'C:/proj/app')), ALL_TAB);
});

test('counts and membership agree once projects are in play', () => {
  const made = createProjectTab(EMPTY_TABS, 'C:/proj/app');
  const state = made.state;
  const sessions = [at('s1', 'C:/proj/app'), at('s2', 'C:/proj/app/src'), at('s3', 'C:/other')];
  assert.deepEqual(sessionsOnTab(state, made.id, sessions), ['s1', 's2']);
  const counts = tabCounts(state, sessions);
  assert.equal(counts.get(ALL_TAB), 3);
  assert.equal(counts.get(made.id), 2);
});

/* ------------------------------------------------------------------ *
 * N-WP11: opening a folder tab from a session
 * ------------------------------------------------------------------ */

test('opening a folder tab names it after the folder and owns what it should', () => {
  const opened = openFolderTab(EMPTY_TABS, 'C:/proj/app');
  assert.ok(opened !== undefined);
  assert.equal(opened.created, true);
  const state = opened.state;
  assert.equal(state.tabs[1]?.name, 'app', 'nobody was asked what to call it');
  assert.equal(state.tabs[1]?.kind, 'project');
  assert.equal(state.tabs[1]?.root, 'C:/proj/app');
  // The ownership rule is WP4g's and N-WP11 does not touch it.
  assert.equal(tabOf(state, at('s1', 'C:/proj/app')), opened.id);
  assert.equal(tabOf(state, at('s2', 'C:\\proj\\app\\src')), opened.id);
  assert.equal(tabOf(state, at('s3', 'C:/proj/app-two')), ALL_TAB);
  assert.deepEqual(state.assign, {}, 'nothing was filed by hand');
});

test('opening a folder that already has a tab hands back that tab', () => {
  const first = openFolderTab(EMPTY_TABS, 'C:/proj/app');
  assert.ok(first !== undefined);
  const again = openFolderTab(first.state, 'c:\\proj\\app\\');
  assert.ok(again !== undefined);
  assert.equal(again.id, first.id, 'separators and case do not make a second tab');
  assert.equal(again.created, false, 'and the page can say so instead of guessing');
  assert.equal(projectTabs(again.state).length, 1);
});

test('the second tab of a name takes its parent folder with it', () => {
  const first = openFolderTab(EMPTY_TABS, 'C:/srv/api');
  assert.ok(first !== undefined);
  const second = openFolderTab(first.state, 'C:/web/api');
  assert.ok(second !== undefined);
  assert.equal(second.created, true, 'two folders, two tabs');
  assert.equal(second.state.tabs[1]?.name, 'api', 'the first one keeps the plain name');
  assert.equal(second.state.tabs[2]?.name, 'api · web');
  // Both rules still hold, and the deepest still wins over the shallower.
  assert.equal(tabOf(second.state, at('s1', 'C:/srv/api/lib')), first.id);
  assert.equal(tabOf(second.state, at('s2', 'C:/web/api/lib')), second.id);
});

test('a session with no working directory opens nothing', () => {
  assert.equal(openFolderTab(EMPTY_TABS, ''), undefined);
  assert.equal(openFolderTab(EMPTY_TABS, '   '), undefined);
});

test('folderTabAt answers for the folder itself and not for its children', () => {
  const opened = openFolderTab(EMPTY_TABS, 'C:/proj/app');
  assert.ok(opened !== undefined);
  const state = opened.state;
  assert.equal(folderTabAt(state, 'C:/proj/app')?.id, opened.id);
  assert.equal(folderTabAt(state, 'c:\\proj\\app')?.id, opened.id, 'the other separator, too');
  assert.equal(folderTabAt(state, 'C:/proj/app/src'), undefined, 'a child is not the folder');
  assert.equal(folderTabAt(state, 'C:/proj'), undefined, 'and neither is the parent');
  assert.equal(folderTabAt(state, ''), undefined);
});

/* ------------------------------------------------------------------ *
 * WP4g: reading what WP4c and WP4e wrote
 * ------------------------------------------------------------------ */

test('a tabs store written before WP4g still reads, and its moves stay manual', () => {
  // Exactly the shape `writeTabs` produced at v1: no `kind`, no `root`, and an
  // `assign` of plain tab ids.
  const storage = memoryStorage({
    [TABS_KEY]: JSON.stringify({
      v: 1,
      tabs: [{ id: 't1', name: 'Work' }],
      assign: { s1: 't1' },
      active: 't1',
    }),
  });
  const state = readTabs(storage);
  assert.equal(state.tabs[1]?.kind, 'manual', 'every old tab was a manual one');
  assert.equal(state.tabs[1]?.root, undefined);
  assert.equal(state.active, 't1');
  assert.equal(state.autoProjects, false);
  assert.equal(isPinned(state, 's1'), true, 'an old move was a manual move and stays one');

  // The point of that pin: a project created later must not take the card away.
  const project = createProjectTab(state, 'C:/proj/app');
  assert.equal(tabOf(project.state, at('s1', 'C:/proj/app')), 't1');
});

test('N-WP11 reads a v1 store unchanged, and opens a folder tab beside it', () => {
  // The same v1 record as above, and the assertion the maintainer cares about:
  // an arrangement made before folder tabs existed loads exactly as it was, and
  // the new gesture adds to it rather than rewriting it.
  const storage = memoryStorage({
    [TABS_KEY]: JSON.stringify({
      v: 1,
      tabs: [{ id: 't1', name: 'Work' }],
      assign: { s1: 't1' },
      active: 't1',
    }),
  });
  const state = readTabs(storage);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs[1]?.name, 'Work');
  assert.equal(state.tabs[1]?.kind, 'manual');
  assert.equal(state.active, 't1');

  const opened = openFolderTab(state, 'C:/proj/app');
  assert.ok(opened !== undefined);
  assert.equal(opened.state.tabs[1]?.name, 'Work', 'the old tab is untouched');
  assert.equal(opened.state.tabs[2]?.name, 'app');
  assert.equal(isPinned(opened.state, 's1'), true, 'and the old move is still a pin');
  assert.equal(tabOf(opened.state, at('s1', 'C:/proj/app')), 't1');
});

test('a hand-edited store cannot invent a project without a folder', () => {
  const state = readTabs(
    memoryStorage({
      [TABS_KEY]: JSON.stringify({
        v: 2,
        tabs: [
          { id: 't1', name: 'Ghost', kind: 'project' },
          { id: 't2', name: 'Empty', kind: 'project', root: '   ' },
        ],
        assign: {},
      }),
    }),
  );
  assert.deepEqual(projectTabs(state), [], 'a rule with no folder is not a rule');
  assert.equal(state.tabs.length, 3, 'the tabs themselves survive as plain ones');
  assert.equal(state.tabs[1]?.kind, 'manual');
});

test('an unpinned membership yields to a project, a pinned one does not', () => {
  const stored = {
    v: 2,
    tabs: [
      { id: 't1', name: 'Shelf' },
      { id: 't2', name: 'App', kind: 'project', root: 'C:/proj/app' },
    ],
    assign: { s1: { tab: 't1', pinned: false }, s2: { tab: 't1', pinned: true } },
  };
  const state = readTabs(memoryStorage({ [TABS_KEY]: JSON.stringify(stored) }));
  assert.equal(tabOf(state, at('s1', 'C:/proj/app')), 't2', 'the rule outranks a plain record');
  assert.equal(tabOf(state, at('s2', 'C:/proj/app')), 't1', 'but not a pin');
  assert.equal(tabOf(state, at('s1', 'C:/elsewhere')), 't1', 'and the record still places it');
});
