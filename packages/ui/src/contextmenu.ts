/**
 * WP4e: what a right-click means on this canvas.
 *
 * The maintainer's complaint was one sentence: *right-clicking a card gives me
 * the browser's menu*. On a page whose whole content is a picture you arrange,
 * the browser's menu is the wrong menu — "Save image as", "Reload", "View page
 * source" answer none of the questions a card raises — and the card already has
 * its own, behind a ⋯ button most people never find. So the right-click opens
 * that one.
 *
 * Suppressing a browser menu is a thing to do carefully, though, and the rules
 * below are the care:
 *
 * - **A sticky note keeps the native menu.** A note is a text box, and the
 *   browser's menu is where Cut, Paste, Undo and the spell-checker live.
 *   Replacing it with three canvas commands would take away the only menu that
 *   is any use inside a text field.
 * - **A frozen tree keeps it too.** History is a read of the past: there is no
 *   card menu there (the ⋯ is not drawn), nothing to arrange, and no tab for a
 *   note to live on. A menu whose every entry is refused is worse than the
 *   browser's.
 * - **Everything else on the canvas gets a menu of its own** — the card's, over
 *   a card; the canvas's, over the background.
 *
 * The mapping is a pure function over a description of what was under the
 * pointer, so it is testable in Node: `app.ts` does the `closest()` calls and
 * this decides. That split is the same one `activity.ts` uses, and for the same
 * reason — the rule is the part worth pinning.
 */

/** What a right-click on the canvas should do. */
export type ContextAction =
  /** Open the card's own ⋯ menu, at the pointer. */
  | 'card-menu'
  /** Open the canvas menu: add a note here, arrange, fit. */
  | 'canvas-menu'
  /** Leave the browser's menu alone. */
  | 'native';

/** What was under the pointer, as `app.ts` reads it off the DOM. */
export interface ContextHit {
  /** The card the pointer is over, if it is over one. */
  readonly sessionId?: string;
  /** True when the pointer is inside a sticky note. */
  readonly inNote: boolean;
  /** True while the canvas is showing a finished session out of history. */
  readonly frozen: boolean;
}

/**
 * The one decision. Order matters and is the order of the rules above.
 */
export function contextActionOf(hit: ContextHit): ContextAction {
  if (hit.inNote) return 'native';
  if (hit.frozen) return 'native';
  return hit.sessionId === undefined ? 'canvas-menu' : 'card-menu';
}

/** Whether this action means the page has to call `preventDefault`. */
export function suppressesNativeMenu(action: ContextAction): boolean {
  return action !== 'native';
}

/** The entries of the canvas menu, in order. `add-note` carries the point. */
export const CANVAS_MENU_ITEMS = [
  { id: 'add-note', labelKey: 'menu.addNoteHere' },
  { id: 'arrange', labelKey: 'menu.arrange' },
  { id: 'fit', labelKey: 'menu.fit' },
] as const;

export type CanvasMenuItem = (typeof CANVAS_MENU_ITEMS)[number]['id'];
