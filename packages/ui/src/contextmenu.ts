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
  /**
   * N-WP15a: open the link menu — open in browser, copy address.
   *
   * `8526e9a` took the browser's menu away everywhere on the page, and that was
   * right for a canvas and wrong for the three links on it. *Open link in new
   * tab* and *Copy link address* are the only two things anybody wants from a
   * link, and suppressing them left the drawer's own GitHub link answering a
   * right-click with silence.
   *
   * Inside the desktop shell the browser's entry was never the right answer
   * anyway: a Tauri webview has no tabs, so *open in new tab* either did
   * nothing useful or replaced the canvas with a web page and left the user
   * with no way back. The page's own menu says *Open in browser*, which is the
   * true thing in both modes and the same words in both.
   */
  | 'link-menu'
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
  /**
   * N-WP15a: the address of the `<a href>` the pointer is over, if it is over
   * one. Read off the DOM by `app.ts`, like every other field here.
   */
  readonly href?: string;
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
  /*
   * N-WP15a. A link is answered before the surfaces it sits on, and above the
   * `suppress` rule that used to swallow it: every link this page has is in the
   * drawer, which is chrome, so deciding by surface first would mean the link
   * menu could never open. A link is a thing, and a right-click on a thing is
   * about the thing rather than about what it is lying on.
   */
  if (hit.href !== undefined && hit.href.length > 0) return 'link-menu';
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
  return (
    action === 'card-menu' ||
    action === 'canvas-menu' ||
    action === 'note-menu' ||
    action === 'link-menu'
  );
}

/** The entries of the canvas menu, in order. `add-note` carries the point. */
export const CANVAS_MENU_ITEMS = [
  { id: 'add-note', labelKey: 'menu.addNoteHere' },
  { id: 'arrange', labelKey: 'menu.arrange' },
  { id: 'fit', labelKey: 'menu.fit' },
] as const;

export type CanvasMenuItem = (typeof CANVAS_MENU_ITEMS)[number]['id'];

/**
 * N-WP15a: the entries of the link menu, in order.
 *
 * Two, and there is no third worth having. *Open in browser* is the reason
 * somebody right-clicked a link at all, and *Copy address* is the reason they
 * did not simply left-click it. Everything else the browser's own menu offers a
 * link — save, open in a private window, inspect — either has no meaning inside
 * a Tauri webview or belongs to a browser rather than to this page.
 *
 * *Open in browser* rather than *Open in new tab*, because that is the true
 * sentence in both modes: in a browser the machine's default handler opens a
 * new tab, and in the shell it opens the machine's browser, which is where an
 * external link was always meant to go.
 */
export const LINK_MENU_ITEMS = [
  { id: 'open', labelKey: 'menu.openLink' },
  { id: 'copy', labelKey: 'menu.copyLink' },
] as const;

export type LinkMenuItem = (typeof LINK_MENU_ITEMS)[number]['id'];
