/**
 * The keyboard map, as data.
 *
 * Kept out of the listener for the same reason the zoom arithmetic is: a
 * shortcut table is exactly the kind of thing that grows a wrong branch —
 * <kbd>Ctrl</kbd>+<kbd>1</kbd> firing the plain <kbd>1</kbd> action, a
 * shortcut stealing a keystroke from a text field — and a table can be
 * asserted where an event handler cannot.
 *
 * Two rules the table encodes:
 *
 * - a bare letter is only a shortcut when **no** modifier is held, so browser
 *   and OS chords keep working;
 * - <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>1</kbd>..<kbd>9</kbd> are the tab
 *   switches, and nothing else uses that modifier.
 */

export type ShortcutAction =
  /** Switch to the nth tab, counting from zero. */
  | { readonly kind: 'tab'; readonly index: number }
  | { readonly kind: 'fit' }
  | { readonly kind: 'arrange' }
  | { readonly kind: 'zoom-in' }
  | { readonly kind: 'zoom-out' }
  | { readonly kind: 'history' }
  | { readonly kind: 'sidebar' }
  | { readonly kind: 'close' };

/** The part of a `KeyboardEvent` that decides an action. */
export interface KeyLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/** What a keystroke means on the canvas, or nothing if it means nothing. */
export function shortcutFor(event: KeyLike): ShortcutAction | undefined {
  const ctrl = event.ctrlKey === true || event.metaKey === true;
  const alt = event.altKey === true;

  if (alt) return undefined;

  if (ctrl) {
    // Digits only. Ctrl+anything-else belongs to the browser.
    if (/^[1-9]$/.test(event.key)) return { kind: 'tab', index: Number(event.key) - 1 };
    return undefined;
  }

  switch (event.key) {
    case 'Escape':
      return { kind: 'close' };
    case '0':
      return { kind: 'fit' };
    case 'a':
    case 'A':
      return { kind: 'arrange' };
    case 'h':
    case 'H':
      return { kind: 'history' };
    case 'm':
    case 'M':
      return { kind: 'sidebar' };
    case '+':
    case '=':
      return { kind: 'zoom-in' };
    case '-':
    case '_':
      return { kind: 'zoom-out' };
    default:
      return undefined;
  }
}

/** The label a help list shows for an action, on this platform. */
export function shortcutLabel(action: ShortcutAction, apple = false): string {
  switch (action.kind) {
    case 'tab':
      return `${apple ? '⌘' : 'Ctrl'}+${action.index + 1}`;
    case 'fit':
      return '0';
    case 'arrange':
      return 'a';
    case 'history':
      return 'h';
    case 'sidebar':
      return 'm';
    case 'zoom-in':
      return '+';
    case 'zoom-out':
      return '-';
    case 'close':
      return 'Esc';
  }
}
