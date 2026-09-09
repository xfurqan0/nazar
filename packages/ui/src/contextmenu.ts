/**
 * WP4e, N-WP14: what a right-click means, everywhere on this page.
 *
 * The maintainer's first complaint was one sentence: *right-clicking a card
 * gives me the browser's menu*. The second, after a week of use, was that it
 * gives the browser's menu everywhere *else* too — the top bar, the drawer, the
 * tab bar, a note — and that on a page whose whole content is a picture you
 * arrange, "Save image as", "Reload" and "View page source" answer none of the
 * questions any of those raise. So the page owns the gesture now, and the rules
 * below are what it does with it.
 *
 * Suppressing a browser menu is still a thing to do carefully, and the care is
 * now one exception rather than a list of places:
 *
 * - **A text field keeps the native menu.** An `<input>`, a `<textarea>` or a
 *   `contenteditable` region is where Cut, Copy, Paste, Undo and the
 *   spell-checker live, and no menu this application could draw carries them —
 *   a browser's own menu is the only one allowed to touch the clipboard
 *   unasked. Replacing it would take away the only menu that is any use inside
 *   a text box.
 * - **A sticky note is a text field only while it is being typed into.** A note
 *   is mostly `<textarea>` by area, so treating it as a text box whenever the
 *   pointer is over its middle would leave the note's own ⋯ menu reachable from
 *   an 18 px grip and nowhere else. The caret decides instead: a note with the
 *   caret in it is being edited and keeps Cut and Paste; a note that is merely
 *   under the pointer is an object on a canvas, and a right-click opens the
 *   same menu the ⋯ button opens.
 * - **Everywhere else the browser's menu goes, and what replaces it depends on
 *   what is there.** A card gets the card's ⋯ menu, the background gets the
 *   canvas menu, a note gets the note's — and the chrome (top bar, drawer, tab
 *   bar) and the frozen history tree get nothing at all, because there is
 *   nothing there to offer and a menu of refusals is worse than none. The
 *   browser's menu still does not come back for them: a page is one surface,
 *   and one that answers a gesture in four places out of five looks broken in
 *   the fifth.
 *
 * The mapping is a pure function over a description of what was under the
 * pointer, so it is testable in Node: `app.ts` does the `closest()` calls and
 * this decides. That split is the same one `activity.ts` uses, and for the same
 * reason — the rule is the part worth pinning.
 */

/** What a right-click should do. */
export type ContextAction =
  /** Open the card's own ⋯ menu, at the pointer. */
  | 'card-menu'
  /** Open the canvas menu: add a note here, arrange, fit. */
  | 'canvas-menu'
  /** Open the note's own ⋯ menu, at the pointer. */
  | 'note-menu'
  /** Take the browser's menu away and put nothing in its place. */
  | 'suppress'
  /** Leave the browser's menu alone. */
  | 'native';

/** What was under the pointer, as `app.ts` reads it off the DOM. */
export interface ContextHit {
  /**
   * The pointer is over an `<input>`, a `<textarea>` or a `contenteditable`
   * region — the one place the browser's own menu is the useful one.
   */
  readonly editable: boolean;
  /** The pointer is over the canvas host: the cards, the notes, the background. */
  readonly onCanvas: boolean;
  /** The sticky note the pointer is over, if it is over one. */
  readonly noteId?: string;
  /** True when that note is the one being typed into — the caret is in it. */
  readonly editing?: boolean;
  /** The card the pointer is over, if it is over one. */
  readonly sessionId?: string;
  /** True while the canvas is showing a finished session out of history. */
  readonly frozen: boolean;
}

/**
 * The one decision. Order matters and is the order of the rules above.
 */
export function contextActionOf(hit: ContextHit): ContextAction {
  // The note is answered first, because it is the one element where "is this a
  // text field" is not settled by what the pointer is over but by where the
  // caret is.
  if (hit.noteId !== undefined) return hit.editing === true ? 'native' : 'note-menu';
  if (hit.editable) return 'native';
  // The chrome, and a frozen tree: nothing to offer, and the browser's menu is
  // still not this page's menu.
  if (!hit.onCanvas || hit.frozen) return 'suppress';
  return hit.sessionId === undefined ? 'canvas-menu' : 'card-menu';
}

/** Whether this action means the page has to call `preventDefault`. */
export function suppressesNativeMenu(action: ContextAction): boolean {
  return action !== 'native';
}

/** Whether this action opens a menu of the page's own. */
export function opensOwnMenu(action: ContextAction): boolean {
  return action === 'card-menu' || action === 'canvas-menu' || action === 'note-menu';
}

/** The entries of the canvas menu, in order. `add-note` carries the point. */
export const CANVAS_MENU_ITEMS = [
  { id: 'add-note', labelKey: 'menu.addNoteHere' },
  { id: 'arrange', labelKey: 'menu.arrange' },
  { id: 'fit', labelKey: 'menu.fit' },
] as const;

export type CanvasMenuItem = (typeof CANVAS_MENU_ITEMS)[number]['id'];
