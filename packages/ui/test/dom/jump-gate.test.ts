/**
 * N-WP21: the jump is offered only where it can be answered.
 *
 * `ShellInfo.jumpSupported` has been on the wire since WP8 and nothing read it.
 * That was harmless for as long as Windows was the only bundle, and became a
 * bug the day N-WP19a shipped macOS and Linux ones: `apps/desktop/src/jump.rs`
 * is `cfg!(windows)` and its own doc comment says *the canvas asks
 * `supported()` before offering the entry* — which the canvas did not do. A mac
 * user therefore had a **Jump to terminal** item in every card menu whose only
 * possible answer was "jumping to a terminal is not available on this platform
 * yet", and a Needs-you row that called it.
 *
 * Both are driven here rather than grepped, because both were bugs of exactly
 * the shape a source scan cannot see: the option was passed, the handler was
 * wired, the entry was built — and the feature behind all three was absent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import '../catalogs.ts';
import { FakeElement, root } from './double.ts';
import type { NeedsYouSession } from '../../src/needs-you.ts';
import { EMPTY_TABS, ALL_TAB } from '../../src/workspace.ts';
import { NeedsYouStrip } from '../../web/needs-you.ts';
import { CardMenu, type CardMenuView } from '../../web/tabbar.ts';

const NOW = 1_788_000_000_000;

const VIEW: CardMenuView = {
  tabs: EMPTY_TABS,
  current: ALL_TAB,
  collapsed: false,
  finished: 0,
  hidden: 0,
  sized: false,
  folders: [],
  folderTabs: new Map(),
  pinned: false,
};

const ANCHOR = { left: 100, top: 100, bottom: 120 };

/** A card menu over the double, with the jump wired and gated as asked. */
function menu(options: { jump: boolean; canJump?: boolean }): {
  readonly node: FakeElement;
  readonly jumped: string[];
} {
  const node = root();
  const jumped: string[] = [];
  const nothing = (): void => undefined;
  const card = new CardMenu({
    root: node as unknown as HTMLElement,
    onMove: nothing,
    onNewTab: nothing,
    onCollapse: nothing,
    onClearFinished: nothing,
    onRestore: nothing,
    onResetSize: nothing,
    onRename: nothing,
    onClearName: nothing,
    onOpenFolder: nothing,
    onGoToTab: nothing,
    onFollowProject: nothing,
    ...(options.canJump === undefined ? {} : { canJump: () => options.canJump === true }),
    ...(options.jump ? { onJump: (sessionId: string) => jumped.push(sessionId) } : {}),
  });
  card.open('s1', ANCHOR, VIEW);
  return { node, jumped };
}

/** The Needs-you strip over the double, with one session waiting. */
function strip(options: { jump: boolean; canJump?: boolean }): {
  readonly list: FakeElement;
  readonly went: string[];
  readonly jumped: string[];
} {
  const list = root();
  const went: string[] = [];
  const jumped: string[] = [];
  const node = (): FakeElement => root();
  const instance = new NeedsYouStrip({
    button: node() as unknown as HTMLButtonElement,
    count: node() as unknown as HTMLElement,
    longest: node() as unknown as HTMLElement,
    live: node() as unknown as HTMLElement,
    panel: node() as unknown as HTMLElement,
    title: node() as unknown as HTMLElement,
    list: list as unknown as HTMLElement,
    empty: node() as unknown as HTMLElement,
    finishedGroup: node() as unknown as HTMLElement,
    finishedToggle: node() as unknown as HTMLElement,
    finishedList: node() as unknown as HTMLElement,
    names: () => ({}),
    onGo: (id) => went.push(id),
    ...(options.canJump === undefined ? {} : { canJump: () => options.canJump === true }),
    ...(options.jump ? { onJump: (id: string) => jumped.push(id) } : {}),
  });
  const waiting: NeedsYouSession = {
    id: 's1',
    cwd: 'C:\\proj\\app',
    status: 'waiting',
    waitingFor: 'permission prompt',
    state: 'alive',
    agents: [],
  };
  instance.render([waiting], NOW, NOW);
  return { list, went, jumped };
}

/** The jump entry of a card menu, if it drew one. */
function jumpEntry(node: FakeElement): FakeElement | undefined {
  return node.byClass('nz-menu__item--jump')[0];
}

test('a shell that can jump gets the menu entry, and it works', () => {
  const card = menu({ jump: true, canJump: true });
  const entry = jumpEntry(card.node);
  assert.ok(entry !== undefined, 'the entry is missing on a platform that supports it');
  assert.equal(entry.textContent, 'Jump to terminal');
  entry.dispatch('click');
  assert.deepEqual(card.jumped, ['s1']);
});

test('a shell that cannot jump gets no entry at all', () => {
  // Not a disabled row and not a row that answers with an apology: the rule
  // this menu has always followed is that an item which can never work is worse
  // than an item that is not there.
  assert.equal(jumpEntry(menu({ jump: true, canJump: false }).node), undefined);
  // And it is the *only* thing that goes: the rest of the menu is untouched.
  assert.ok(menu({ jump: true, canJump: false }).node.children.length > 0);
});

test('a browser gets no entry either, and asking nothing means yes', () => {
  assert.equal(jumpEntry(menu({ jump: false }).node), undefined);
  // A caller that never passes `canJump` behaves exactly as it did before the
  // option existed — which is what keeps this a gate and not a rewrite.
  assert.ok(jumpEntry(menu({ jump: true }).node) !== undefined);
});

test('a Needs-you row still reaches the card where the jump is unsupported', () => {
  const unsupported = strip({ jump: true, canJump: false });
  unsupported.list.children[0]!.dispatch('click');
  assert.deepEqual(unsupported.went, ['s1'], 'the row stopped taking us to the card');
  assert.deepEqual(unsupported.jumped, [], 'a jump was called on a platform that has none');

  const supported = strip({ jump: true, canJump: true });
  supported.list.children[0]!.dispatch('click');
  assert.deepEqual(supported.jumped, ['s1']);
});
