/**
 * Canvases as tabs, and the two menus the canvas opens on a right-click.
 *
 * A tab is a *view* of the same canvas, not a second canvas: the sessions are
 * the machine's and nothing here can create or destroy one. "All" is therefore
 * not a bucket but the whole map, and it is also the fallback for anything the
 * user has not filed — which is why a fresh install has exactly one tab and no
 * membership record at all.
 *
 * Three ways to file a session, because the habits are different: the small ⋯
 * menu on the card (keyboard reachable, discoverable), **a right-click anywhere
 * on the card** (WP4e — the gesture everybody tries first, which used to hand
 * over the browser's own menu instead), and dragging the card onto a tab title
 * (fast, and the reason a canvas is a canvas).
 *
 * WP4e added the second menu: a right-click on the canvas *background* offers
 * the three things there are to do there — add a note here, arrange, fit.
 * `../src/contextmenu.ts` decides which of the two a click gets, and where the
 * browser's own menu is left alone.
 */
import {
  CANVAS_MENU_ITEMS,
  LINK_MENU_ITEMS,
  type CanvasMenuItem,
  type LinkMenuItem,
} from '../src/contextmenu.ts';
import { renameTerminalHint } from '../src/format.ts';
import { t, tCount } from '../src/i18n.ts';
import { folderName } from '../src/projects.ts';
import type { TabsState } from '../src/workspace.ts';
import { ALL_TAB } from '../src/workspace.ts';
import { clear, html, setClass, setText, svg } from './dom.ts';

/**
 * WP4g: the mark that says a tab is a rule rather than a shelf.
 *
 * A folder, drawn rather than written: the tab already carries a name and a
 * count, and a third word ("project") would cost more room than it buys.
 * `aria-hidden`, because the tab's own tooltip says what the icon means and a
 * screen reader announcing "folder" before every project name is noise.
 */
function folderIcon(): SVGSVGElement {
  const icon = svg('svg', 'nz-tab__folder');
  icon.setAttribute('viewBox', '0 0 14 12');
  icon.setAttribute('width', '13');
  icon.setAttribute('height', '11');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  const body = svg('path');
  body.setAttribute(
    'd',
    'M1 2.5A1.5 1.5 0 0 1 2.5 1h2.2c.4 0 .78.16 1.06.44L6.7 2.2h4.8A1.5 1.5 0 0 1 13 3.7v5.8A1.5 1.5 0 0 1 11.5 11h-9A1.5 1.5 0 0 1 1 9.5z',
  );
  body.setAttribute('fill', 'currentColor');
  icon.append(body);
  return icon;
}

/**
 * What a menu opens against.
 *
 * A `DOMRect` satisfies it, which is what the ⋯ button hands over; so does
 * `{ left: x, top: y, bottom: y }`, which is what a right-click hands over. The
 * structural type is the whole reason a pointer position and a button can share
 * one placement rule.
 */
export interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

/** Put a popup near its anchor and inside the window. Shared by both menus. */
function placeMenu(root: HTMLElement, anchor: AnchorRect, fallbackWidth: number): void {
  root.hidden = false;
  const width = root.offsetWidth || fallbackWidth;
  const height = root.offsetHeight || 160;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  const top =
    anchor.bottom + height > window.innerHeight - 8
      ? Math.max(8, anchor.top - height - 6)
      : anchor.bottom + 6;
  // A CSSOM write, never a style attribute: the page's `style-src 'self'` drops
  // the attribute silently (see `web/quota.ts`).
  root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  root.querySelector<HTMLButtonElement>('button')?.focus();
}

export interface TabBarOptions {
  readonly root: HTMLElement;
  readonly onSelect: (tabId: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onRename: (tabId: string, name: string) => void;
  readonly onRemove: (tabId: string) => void;
}

export class TabBar {
  private readonly root: HTMLElement;

  private readonly options: TabBarOptions;

  /** The tab buttons, for the active and drop-target classes. */
  private readonly buttons = new Map<string, HTMLElement>();

  /** Their wrappers, which is what a dragged card is hit-tested against. */
  private readonly slots = new Map<string, HTMLElement>();

  private editing: { readonly kind: 'create' | 'rename'; readonly id?: string } | undefined;

  private signature = '';

  private highlighted: string | undefined;

  private last:
    | {
        state: TabsState;
        counts: ReadonlyMap<string, number>;
        titles: ReadonlyMap<string, readonly string[]>;
      }
    | undefined;

  constructor(options: TabBarOptions) {
    this.root = options.root;
    this.options = options;
  }

  /** Draw again with the last data, after the editing state changed. */
  private redraw(): void {
    this.signature = '';
    if (this.last !== undefined) this.render(this.last.state, this.last.counts, this.last.titles);
  }

  /**
   * Draw the bar. Cheap to call on every frame: the markup is rebuilt only when
   * the tabs, their counts, the active one or the card names on them changed.
   *
   * `titles` is WP4g: the label of each card a tab is showing, so the tooltip
   * can answer "what is on this tab" without opening it. A card that has been
   * named contributes the name, everything else its folder — which is what
   * makes naming a card worth doing on a tab you are not looking at.
   */
  render(
    state: TabsState,
    counts: ReadonlyMap<string, number>,
    titles: ReadonlyMap<string, readonly string[]> = new Map(),
  ): void {
    this.last = { state, counts, titles };
    const signature = JSON.stringify([
      state.tabs,
      state.active,
      [...counts.entries()].sort(),
      [...titles.entries()].sort(),
      this.editing ?? null,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;

    clear(this.root);
    this.buttons.clear();
    this.slots.clear();

    for (const tab of state.tabs) {
      if (this.editing?.kind === 'rename' && this.editing.id === tab.id) {
        this.root.append(this.input(tab.name, (value) => this.options.onRename(tab.id, value)));
        continue;
      }

      const button = html('button', 'nz-tab');
      button.type = 'button';
      button.dataset['tabId'] = tab.id;
      button.setAttribute('aria-pressed', tab.id === state.active ? 'true' : 'false');
      setClass(button, 'is-active', tab.id === state.active);

      const name = html('span', 'nz-tab__name');
      setText(name, tab.name);
      const count = html('span', 'nz-tab__count');
      setText(count, String(counts.get(tab.id) ?? 0));
      if (tab.kind === 'project') {
        setClass(button, 'is-project', true);
        button.append(folderIcon());
      }
      button.append(name, count);

      const index = state.tabs.indexOf(tab);
      /*
       * The tooltip carries three things, in the order a person needs them: the
       * name, what makes this tab fill itself (a folder tab says its folder — the
       * same redacted path the cards show), and who is on it right now.
       */
      const parts: string[] = [
        index < 9 ? t('tab.shortcut', { name: tab.name, index: index + 1 }) : tab.name,
      ];
      if (tab.kind === 'project' && tab.root !== undefined) {
        parts.push(t('tab.folderTab', { folder: tab.root }));
      } else if (tab.id !== ALL_TAB) {
        parts.push(t('tab.doubleClickRename'));
      }
      const on = titles.get(tab.id) ?? [];
      if (on.length > 0) {
        parts.push(
          on.length > 4
            ? t('tab.andMore', { names: on.slice(0, 4).join(', '), more: on.length - 4 })
            : on.join(', '),
        );
      }
      button.title = parts.join(' — ');

      button.addEventListener('click', () => this.options.onSelect(tab.id));
      if (tab.id !== ALL_TAB) {
        button.addEventListener('dblclick', () => {
          this.editing = { kind: 'rename', id: tab.id };
          this.redraw();
        });
      }

      // The close control is a sibling, not a child: a button inside a button
      // is invalid markup and the inner one stops being reliably clickable.
      const slot = html('div', 'nz-tab-slot');
      slot.append(button);
      if (tab.id !== ALL_TAB) {
        const remove = html('button', 'nz-tab__close');
        remove.type = 'button';
        remove.title = t(tab.kind === 'project' ? 'tab.closeFolder' : 'tab.close', {
          name: tab.name,
        });
        remove.setAttribute('aria-label', t('tab.closeLabel', { name: tab.name }));
        setText(remove, '×');
        remove.addEventListener('click', () => this.options.onRemove(tab.id));
        slot.append(remove);
        setClass(button, 'has-close', true);
      }

      this.root.append(slot);
      this.buttons.set(tab.id, button);
      this.slots.set(tab.id, slot);
    }

    if (this.editing?.kind === 'create') {
      this.root.append(this.input('', (value) => this.options.onCreate(value)));
    } else {
      const add = html('button', 'nz-tab nz-tab--add');
      add.type = 'button';
      add.title = t('tab.new');
      add.setAttribute('aria-label', t('tab.new'));
      setText(add, '+');
      add.addEventListener('click', () => {
        this.editing = { kind: 'create' };
        this.redraw();
      });
      this.root.append(add);
    }

    if (this.highlighted !== undefined) this.highlight(this.highlighted);
  }

  /** The inline text field used for both creating and renaming. */
  private input(value: string, commit: (name: string) => void): HTMLInputElement {
    const field = html('input', 'nz-tab__input');
    field.type = 'text';
    field.value = value;
    field.maxLength = 40;
    field.setAttribute('aria-label', t('tab.nameField'));
    let settled = false;
    const done = (name?: string): void => {
      if (settled) return;
      settled = true;
      this.editing = undefined;
      if (name !== undefined && name.trim().length > 0) commit(name);
      else this.redraw();
    };
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') done(field.value);
      else if (event.key === 'Escape') done();
    });
    field.addEventListener('blur', () => done(field.value));
    // The field is created during a render, so focus has to wait for the paint.
    window.requestAnimationFrame(() => field.focus());
    return field;
  }

  /** The tab under a screen point, for a card dropped onto a title. */
  tabAt(clientX: number, clientY: number): string | undefined {
    for (const [id, slot] of this.slots) {
      const rect = slot.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return id;
      }
    }
    return undefined;
  }

  /** Show which tab a dragged card would land on. */
  highlight(tabId: string | undefined): void {
    this.highlighted = tabId;
    for (const [id, button] of this.buttons) setClass(button, 'is-drop', id === tabId);
  }
}

/* ------------------------------------------------------------------ *
 * The per-card menu
 * ------------------------------------------------------------------ */

/**
 * What the menu needs to know about the card it is opening on.
 *
 * An object rather than five positional arguments: WP4f added three entries to
 * this menu and two more facts they depend on, and `open(id, anchor, tabs,
 * current, collapsed, finished, hidden, sized)` is a call nobody can read.
 */
export interface CardMenuView {
  readonly tabs: TabsState;
  /** The tab this card is on now. */
  readonly current: string;
  readonly collapsed: boolean;
  /** WP4f: finished subagents on this card that are still being drawn. */
  readonly finished: number;
  /** WP4f: finished subagents already cleared away. */
  readonly hidden: number;
  /** WP4f: whether this card has a width the user dragged to. */
  /** Whether the user has dragged either of this card's two sizes. */
  readonly sized: boolean;
  /** WP4g: the label the user typed over this card's title, if any. */
  readonly name?: string;
  /**
   * WP4g: the folders this session could have a tab for, deepest first. Empty
   * when the session has no working directory Nazar could read.
   */
  readonly folders: readonly string[];
  /**
   * N-WP11: the tab a folder already has, for the folders in {@link folders}
   * that have one. Those rows say *Go to tab* instead of *Open a tab* — the
   * folder is spoken for either way, and taking the user to the tab is a more
   * useful answer than a greyed-out row saying so.
   */
  readonly folderTabs: ReadonlyMap<string, { readonly id: string; readonly name: string }>;
  /**
   * WP4g: whether the user has pinned this card to a tab by hand. Only then is
   * *Follow project* worth offering — it is the way back out of a manual move.
   */
  readonly pinned: boolean;
}

export interface CardMenuOptions {
  readonly root: HTMLElement;
  readonly onMove: (sessionId: string, tabId: string) => void;
  readonly onNewTab: (sessionId: string) => void;
  readonly onCollapse: (sessionId: string) => void;
  /** WP4f: hide every finished subagent on this card. Nothing is deleted. */
  readonly onClearFinished: (sessionId: string) => void;
  /** WP4f: bring the cleared ones back. */
  readonly onRestore: (sessionId: string) => void;
  /** WP4f: forget the dragged width and let the card size itself again. */
  readonly onResetSize: (sessionId: string) => void;
  /** WP4g: open the inline editor over this card's title. */
  readonly onRename: (sessionId: string) => void;
  /** WP4g: drop the typed label and go back to the folder name. */
  readonly onClearName: (sessionId: string) => void;
  /** N-WP11: open a tab for one of this session's folders. */
  readonly onOpenFolder: (sessionId: string, root: string) => void;
  /** N-WP11: that folder already has a tab — show it rather than make another. */
  readonly onGoToTab: (tabId: string) => void;
  /** WP4g: undo a manual move and let the project rule decide again. */
  readonly onFollowProject: (sessionId: string) => void;
  /**
   * Bring the terminal running this session to the front. Absent in browser mode, where
   * the entry is not drawn at all rather than drawn and refused: a menu item that can
   * never work is worse than one that is not there.
   */
  readonly onJump?: (sessionId: string) => void;
  /**
   * N-WP21: whether the shell hosting this page can *actually* jump.
   *
   * A different question from the first, and N-WP19a is what made it one: there
   * are macOS and Linux bundles now, and `apps/desktop/src/jump.rs` is
   * `cfg!(windows)`. That file's own doc comment says *the canvas asks
   * `supported()` before offering the entry* — and until this option existed
   * the canvas never did, so a mac user got a menu item whose only possible
   * answer was "jumping to a terminal is not available on this platform yet".
   *
   * Asked when the menu opens rather than when it was built, because
   * `shell_info` answers a moment after the page loads. Absent means yes, which
   * leaves every caller that does not ask behaving exactly as it did.
   */
  readonly canJump?: () => boolean;
}

export class CardMenu {
  private readonly root: HTMLElement;

  private readonly options: CardMenuOptions;

  private session: string | undefined;

  constructor(options: CardMenuOptions) {
    this.root = options.root;
    this.options = options;
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.close();
    });
  }

  get openFor(): string | undefined {
    return this.session;
  }

  open(sessionId: string, anchor: AnchorRect, view: CardMenuView): void {
    this.session = sessionId;
    const state = view.tabs;
    const current = view.current;
    clear(this.root);

    // First, because it is the only entry here that acts on the *machine* rather than on
    // the picture, and a user who came for it should not have to read past a tab list to
    // find it. Double-clicking the card does the same thing; this is the discoverable
    // half of the pair, and the one a screen reader can reach.
    if (this.options.onJump !== undefined && this.options.canJump?.() !== false) {
      const jump = html('button', 'nz-menu__item nz-menu__item--jump');
      jump.type = 'button';
      jump.setAttribute('role', 'menuitem');
      setText(jump, t('menu.jump'));
      jump.title = t('menu.jumpNote');
      jump.addEventListener('click', () => {
        this.options.onJump?.(sessionId);
        this.close();
      });
      this.root.append(jump);
    }

    /*
     * WP4g: the card's own name, above everything about tabs.
     *
     * It is the entry that acts on *this card* rather than on where it lives,
     * and it is the discoverable half of the gesture — clicking the title does
     * the same thing, but nobody discovers a click target by looking at it.
     */
    const named = view.name !== undefined && view.name.length > 0;
    const rename = html('button', 'nz-menu__item');
    rename.type = 'button';
    rename.setAttribute('role', 'menuitem');
    setText(rename, t(named ? 'menu.rename' : 'menu.name'));
    rename.title = t('menu.nameNote');
    rename.addEventListener('click', () => {
      this.options.onRename(sessionId);
      this.close();
    });
    this.root.append(rename);

    if (named) {
      const clearName = html('button', 'nz-menu__item');
      clearName.type = 'button';
      clearName.setAttribute('role', 'menuitem');
      setText(clearName, t('menu.clearName'));
      clearName.title = t('menu.clearNameNote');
      clearName.addEventListener('click', () => {
        this.options.onClearName(sessionId);
        this.close();
      });
      this.root.append(clearName);

      /*
       * The one thing Nazar cannot do for you, said where it is useful.
       *
       * A card's name is this browser's note; the terminal's title is the
       * machine's, and the jump matcher uses the second one. Printing the line
       * that makes the two agree is the honest alternative to either pretending
       * they are the same or writing into somebody's session.
       */
      const note = html('p', 'nz-menu__note');
      setText(note, renameTerminalHint());
      this.root.append(note);
    }

    const heading = html('p', 'nz-menu__heading');
    setText(heading, t('menu.moveTo'));
    this.root.append(heading);

    for (const tab of state.tabs) {
      const item = html('button', 'nz-menu__item');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', tab.id === current ? 'true' : 'false');
      setClass(item, 'is-current', tab.id === current);
      setText(item, tab.name);
      if (tab.kind === 'project' && tab.root !== undefined) {
        item.title = t('menu.moveToFolder', { folder: tab.root });
      }
      item.addEventListener('click', () => {
        this.options.onMove(sessionId, tab.id);
        this.close();
      });
      this.root.append(item);
    }

    const fresh = html('button', 'nz-menu__item nz-menu__item--new');
    fresh.type = 'button';
    fresh.setAttribute('role', 'menuitem');
    setText(fresh, t('menu.newTab'));
    fresh.addEventListener('click', () => {
      this.options.onNewTab(sessionId);
      this.close();
    });
    this.root.append(fresh);

    /*
     * WP4g, N-WP11: turn the folder this session is running in into a rule.
     *
     * The list is the point. A session started in `C:\proj\app\src` almost
     * never wants a tab for `src` — it wants `app`, and possibly `proj` — so
     * every folder on the way up is offered and the deepest is listed first.
     * The name is not asked for anywhere: it is the folder's own.
     *
     * A folder that already has a tab is still offered, and takes you to it.
     * The row cannot make a second tab for one folder — the model refuses that
     * — but a disabled row saying "already a project" answered a question
     * nobody asked; *Go to tab app* answers the one they did.
     */
    if (view.folders.length > 0) {
      const folderHeading = html('p', 'nz-menu__heading');
      setText(folderHeading, t('menu.openTabFor'));
      this.root.append(folderHeading);

      for (const folder of view.folders) {
        const item = html('button', 'nz-menu__item nz-menu__item--folder');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        const already = view.folderTabs.get(folder);
        setText(
          item,
          already === undefined ? folderName(folder) : t('menu.goToTab', { name: already.name }),
        );
        item.title =
          already === undefined
            ? t('menu.openTabNote', { folder })
            : t('menu.hasTabNote', { folder });
        const hint = html('span', 'nz-menu__hint');
        setText(hint, folder);
        item.append(hint);
        item.addEventListener('click', () => {
          if (already === undefined) this.options.onOpenFolder(sessionId, folder);
          else this.options.onGoToTab(already.id);
          this.close();
        });
        this.root.append(item);
      }
    }

    // The way back out of a manual move, offered only when there is one to
    // undo. Without it a card dragged onto a tab once could never rejoin its
    // project, and the pin would be a one-way door.
    if (view.pinned) {
      const follow = html('button', 'nz-menu__item');
      follow.type = 'button';
      follow.setAttribute('role', 'menuitem');
      setText(follow, t('menu.followProject'));
      follow.title = t('menu.followProjectNote');
      follow.addEventListener('click', () => {
        this.options.onFollowProject(sessionId);
        this.close();
      });
      this.root.append(follow);
    }

    const rule = html('p', 'nz-menu__heading');
    setText(rule, t('menu.tree'));
    this.root.append(rule);

    const fold = html('button', 'nz-menu__item');
    fold.type = 'button';
    fold.setAttribute('role', 'menuitem');
    setText(fold, t(view.collapsed ? 'menu.expand' : 'menu.collapse'));
    fold.title = t('menu.collapseNote');
    fold.addEventListener('click', () => {
      this.options.onCollapse(sessionId);
      this.close();
    });
    this.root.append(fold);

    /*
     * WP4f. The neighbour of *Collapse*, and deliberately not a replacement for
     * it: collapsing puts the whole tree away and clearing puts away the part
     * of it that has stopped moving. A long session wants the second one — the
     * three agents still running are the point, and the forty that finished are
     * what pushed them off the screen.
     *
     * Neither entry is drawn when it would do nothing. A card with no finished
     * agents has nothing to clear; a card with nothing hidden has nothing to
     * show. A menu of greyed-out items teaches nobody anything.
     */
    if (view.finished > 0) {
      const cleanup = html('button', 'nz-menu__item');
      cleanup.type = 'button';
      cleanup.setAttribute('role', 'menuitem');
      setText(cleanup, t('menu.clearFinished', { count: view.finished }));
      cleanup.title = t('menu.clearFinishedNote');
      cleanup.addEventListener('click', () => {
        this.options.onClearFinished(sessionId);
        this.close();
      });
      this.root.append(cleanup);
    }

    if (view.hidden > 0) {
      const restore = html('button', 'nz-menu__item');
      restore.type = 'button';
      restore.setAttribute('role', 'menuitem');
      setText(restore, tCount('menu.showHidden', view.hidden));
      restore.addEventListener('click', () => {
        this.options.onRestore(sessionId);
        this.close();
      });
      this.root.append(restore);
    }

    // The keyboard's way out of a size somebody dragged to. The eight handles
    // are a pointer gesture and nothing else, so without this a card resized by
    // accident could only be fixed by another pointer gesture. N-WP10 made it
    // clear both axes, because both can now be dragged.
    if (view.sized) {
      const heading = html('p', 'nz-menu__heading');
      setText(heading, t('menu.card'));
      this.root.append(heading);

      const reset = html('button', 'nz-menu__item');
      reset.type = 'button';
      reset.setAttribute('role', 'menuitem');
      setText(reset, t('menu.resetSize'));
      reset.title = t('menu.resetSizeNote');
      reset.addEventListener('click', () => {
        this.options.onResetSize(sessionId);
        this.close();
      });
      this.root.append(reset);
    }

    placeMenu(this.root, anchor, 190);
  }

  close(): void {
    if (this.session === undefined) return;
    this.session = undefined;
    this.root.hidden = true;
    clear(this.root);
  }
}

/* ------------------------------------------------------------------ *
 * The canvas menu (WP4e)
 * ------------------------------------------------------------------ */

export interface CanvasMenuOptions {
  readonly root: HTMLElement;
  /**
   * Run one entry. `at` is the canvas point the right-click happened on, which
   * is what makes "Add note **here**" mean here and not "somewhere sensible".
   */
  readonly onPick: (item: CanvasMenuItem, at: { readonly x: number; readonly y: number }) => void;
}

/**
 * The menu the canvas background offers instead of the browser's.
 *
 * Three entries, and the test is whether each of them answers a question you
 * could have while looking at empty canvas: *I want to write something down
 * here*, *tidy this up*, *show me all of it*. Anything that acts on a session
 * belongs to the card's menu, and anything that is a setting belongs to the
 * sidebar; this menu stays three lines long on purpose.
 */
export class CanvasMenu {
  private readonly root: HTMLElement;

  private readonly options: CanvasMenuOptions;

  private point: { readonly x: number; readonly y: number } | undefined;

  constructor(options: CanvasMenuOptions) {
    this.root = options.root;
    this.options = options;
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.point !== undefined;
  }

  /** `anchor` is where on screen; `at` is where on the canvas. */
  open(anchor: AnchorRect, at: { readonly x: number; readonly y: number }): void {
    this.point = at;
    clear(this.root);

    for (const entry of CANVAS_MENU_ITEMS) {
      const item = html('button', 'nz-menu__item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      setText(item, t(entry.labelKey));
      item.addEventListener('click', () => {
        const point = this.point;
        this.close();
        if (point !== undefined) this.options.onPick(entry.id, point);
      });
      this.root.append(item);
    }

    placeMenu(this.root, anchor, 170);
  }

  close(): void {
    if (this.point === undefined) return;
    this.point = undefined;
    this.root.hidden = true;
    clear(this.root);
  }
}

/* ------------------------------------------------------------------ *
 * The link menu (N-WP15a)
 * ------------------------------------------------------------------ */

export interface LinkMenuOptions {
  readonly root: HTMLElement;
  /** Run one entry against the address the menu was opened on. */
  readonly onPick: (item: LinkMenuItem, href: string) => void;
}

/**
 * The menu an `<a href>` offers instead of the browser's.
 *
 * The same element kind, the same placement rule and the same keyboard contract
 * as the two above — one stylesheet rule, one Escape behaviour, one way to be
 * closed by a press elsewhere. That sameness is the whole design: the page took
 * a gesture away from the browser in `8526e9a`, so what it puts back has to
 * behave like one menu everywhere rather than like three approximations.
 */
export class LinkMenu {
  private readonly root: HTMLElement;

  private readonly options: LinkMenuOptions;

  private target: string | undefined;

  constructor(options: LinkMenuOptions) {
    this.root = options.root;
    this.options = options;
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.target !== undefined;
  }

  /** The address this menu is open on, for anything that has to know. */
  get openFor(): string | undefined {
    return this.target;
  }

  open(anchor: AnchorRect, href: string): void {
    this.target = href;
    clear(this.root);

    for (const entry of LINK_MENU_ITEMS) {
      const item = html('button', 'nz-menu__item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      setText(item, t(entry.labelKey));
      item.addEventListener('click', () => {
        const address = this.target;
        this.close();
        if (address !== undefined) this.options.onPick(entry.id, address);
      });
      this.root.append(item);
    }

    // The address itself, under the two entries and not clickable: a link in
    // the drawer is a word ("how to get usage limits"), and the one question a
    // right-click on it raises that neither entry answers is *where does this
    // go*. It is a `<p>` rather than a `title`, because a menu that has already
    // replaced the browser's should not need a second hover to be read.
    const hint = html('p', 'nz-menu__note nz-menu__note--link');
    setText(hint, href);
    this.root.append(hint);

    placeMenu(this.root, anchor, 190);
  }

  close(): void {
    if (this.target === undefined) return;
    this.target = undefined;
    this.root.hidden = true;
    clear(this.root);
  }
}
