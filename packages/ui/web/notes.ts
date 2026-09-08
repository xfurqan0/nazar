/**
 * WP4e: sticky notes, drawn.
 *
 * The model is in `../src/notes.ts` and the storage with it. This file is the
 * layer they live on, and the one design decision worth writing down is why
 * that layer is **HTML on top of the SVG** rather than more SVG.
 *
 * A note is a text box. SVG has no text box: editing inside it means either a
 * `foreignObject` (an HTML box in a trench coat) or re-implementing a caret,
 * selection, wrapping and the clipboard, which is a year of somebody's life and
 * is already in every browser. So the notes are ordinary `<div>`s with a
 * `<textarea>` inside, in a layer that carries **the same transform the SVG
 * viewport group carries** — one `translate(...) scale(...)` written through
 * the CSSOM on every pan and zoom. The notes therefore pan, zoom and sit in
 * canvas coordinates exactly like a card, and a person editing one gets their
 * own keyboard, their own spell-checker and their own right-click menu.
 *
 * The costs of that choice, both accepted deliberately:
 *
 * - The layer must not swallow the canvas's gestures, so it is
 *   `pointer-events: none` and only the notes themselves take clicks.
 * - Text scales with the canvas, so a note read at 0.4× is small. That is what
 *   a note pinned to a place on a map should do; the alternative — text that
 *   stays 13 px while the card it annotates shrinks — is a label, not a note.
 */
import type { Note, NoteColour, NotesState } from '../src/notes.ts';
import {
  MAX_NOTE_LENGTH,
  NOTE_COLOURS,
  NOTE_COLOUR_CLASSES,
  NOTE_SIZE,
  clampSize,
  noteColourClass,
  noteVariable,
  notesOnTab,
  remaining,
} from '../src/notes.ts';
import type { Viewport } from '../src/layout.ts';
import { t } from '../src/i18n.ts';
import { clear, html, setAttr, setClass, setText } from './dom.ts';

interface NoteEls {
  readonly root: HTMLDivElement;
  readonly grip: HTMLDivElement;
  readonly text: HTMLTextAreaElement;
  readonly count: HTMLSpanElement;
  readonly menu: HTMLDivElement;
  readonly menuButton: HTMLButtonElement;
  readonly resize: HTMLDivElement;
}

export interface NotesLayerOptions {
  /** The layer, a child of the canvas host and a sibling of the SVG. */
  readonly root: HTMLElement;
  /** The current zoom, so a drag moves a note by the distance the pointer moved. */
  readonly scale: () => number;
  /** Persist a change. Called on every edit; the caller decides how to store it. */
  readonly onChange: (change: NoteChange) => void;
}

/** One change to one note. `remove` carries no fields. */
export type NoteChange =
  | { readonly kind: 'move'; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly kind: 'resize';
      readonly id: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'colour'; readonly id: string; readonly colour: NoteColour }
  | { readonly kind: 'remove'; readonly id: string };

/** How long after the last keystroke a note is written to storage. */
const SAVE_DEBOUNCE_MS = 300;

/** How few characters have to be left before the counter shows itself unasked. */
const NEAR_THE_CAP = 200;

export class NotesLayer {
  private readonly options: NotesLayerOptions;

  private readonly notes = new Map<string, NoteEls>();

  private drag:
    | {
        readonly kind: 'move' | 'resize';
        readonly id: string;
        readonly pointerId: number;
        readonly startX: number;
        readonly startY: number;
        readonly originX: number;
        readonly originY: number;
        x: number;
        y: number;
      }
    | undefined;

  private saveTimer = 0;

  private pendingText: { id: string; text: string } | undefined;

  constructor(options: NotesLayerOptions) {
    this.options = options;
  }

  /** Put the layer in the same place as the SVG viewport group. */
  applyView(view: Viewport): void {
    // A CSSOM write, not a style attribute: the page's own CSP drops the
    // attribute silently (see `web/quota.ts`).
    this.options.root.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  /** Show or hide the whole layer — a frozen history tree has no notes. */
  setVisible(visible: boolean): void {
    this.options.root.hidden = !visible;
  }

  /** Draw the notes of one tab, creating and removing elements as needed. */
  render(state: NotesState, tab: string): void {
    const wanted = notesOnTab(state, tab);
    const live = new Set<string>();
    for (const note of wanted) {
      live.add(note.id);
      const els = this.notes.get(note.id) ?? this.create(note);
      this.paint(els, note);
    }
    for (const [id, els] of this.notes) {
      if (live.has(id)) continue;
      els.root.remove();
      this.notes.delete(id);
    }
  }

  /** Put the caret in a note, which is what a freshly added one deserves. */
  focus(id: string): void {
    const els = this.notes.get(id);
    if (els === undefined) return;
    els.text.focus();
    els.text.setSelectionRange(els.text.value.length, els.text.value.length);
  }

  /** Close any open note menu. The canvas closes them on an outside press. */
  closeMenus(except?: string): void {
    for (const [id, els] of this.notes) {
      if (id === except) continue;
      els.menu.hidden = true;
      els.menuButton.setAttribute('aria-expanded', 'false');
    }
  }

  /** Flush a pending text edit, e.g. before the page unloads. */
  flush(): void {
    if (this.saveTimer !== 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = 0;
    }
    const pending = this.pendingText;
    this.pendingText = undefined;
    if (pending !== undefined) {
      this.options.onChange({ kind: 'text', id: pending.id, text: pending.text });
    }
  }

  private create(note: Note): NoteEls {
    const root = html('div', 'nz-note');
    root.dataset['noteId'] = note.id;

    const grip = html('div', 'nz-note__grip');
    grip.title = t('note.drag');

    const menuButton = html('button', 'nz-note__menu');
    menuButton.type = 'button';
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', t('note.actions'));
    setText(menuButton, '⋯');

    const menu = html('div', 'nz-note__panel');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const chips = html('div', 'nz-note__chips');
    for (const colour of NOTE_COLOURS) {
      const chip = html('button', 'nz-note__chip');
      chip.type = 'button';
      chip.setAttribute('role', 'menuitemradio');
      chip.dataset['colour'] = String(colour);
      chip.setAttribute('aria-label', t('note.colour', { n: colour }));
      chip.title = t('note.colour', { n: colour });
      // The chip paints itself with the theme's own note ground, through the
      // CSSOM, so the four chips change with the theme without a second list of
      // hexes anywhere in this file.
      chip.style.background = `var(${noteVariable(colour)})`;
      chip.addEventListener('click', () => {
        this.options.onChange({ kind: 'colour', id: note.id, colour });
        this.closeMenus();
      });
      chips.append(chip);
    }

    const remove = html('button', 'nz-note__delete');
    remove.type = 'button';
    remove.setAttribute('role', 'menuitem');
    setText(remove, t('note.delete'));
    remove.addEventListener('click', () => {
      this.flush();
      this.options.onChange({ kind: 'remove', id: note.id });
    });

    menu.append(chips, remove);

    menuButton.addEventListener('click', () => {
      const open = menu.hidden;
      this.closeMenus(note.id);
      menu.hidden = !open;
      menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    const text = html('textarea', 'nz-note__text');
    text.maxLength = MAX_NOTE_LENGTH;
    text.spellcheck = true;
    text.rows = 3;
    text.setAttribute('aria-label', t('note.text'));
    text.placeholder = t('note.placeholder');

    const count = html('span', 'nz-note__count');

    const resize = html('div', 'nz-note__resize');
    resize.title = t('note.resize');
    resize.setAttribute('aria-hidden', 'true');

    text.addEventListener('input', () => {
      this.paintCount(count, text.value);
      this.pendingText = { id: note.id, text: text.value };
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = 0;
        this.flush();
      }, SAVE_DEBOUNCE_MS);
    });
    // Leaving the note is a commit: a blur that loses the last five characters
    // because a timer had not fired is the one bug a text box must not have.
    text.addEventListener('blur', () => this.flush());
    // Escape gives the canvas its keyboard back without closing anything else.
    text.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.flush();
        text.blur();
      }
    });

    grip.addEventListener('pointerdown', (event) => this.begin(event, 'move', note.id, root));
    resize.addEventListener('pointerdown', (event) => this.begin(event, 'resize', note.id, root));

    root.append(grip, menuButton, menu, text, count, resize);
    this.options.root.append(root);

    const els: NoteEls = { root, grip, text, count, menu, menuButton, resize };
    this.notes.set(note.id, els);
    return els;
  }

  private paint(els: NoteEls, note: Note): void {
    // Position and size through the CSSOM, in canvas units: the layer's own
    // transform turns them into screen pixels.
    const style = els.root.style;
    const left = `${note.x}px`;
    const top = `${note.y}px`;
    const width = `${note.width}px`;
    const height = `${note.height}px`;
    if (style.left !== left) style.left = left;
    if (style.top !== top) style.top = top;
    if (style.width !== width) style.width = width;
    if (style.height !== height) style.height = height;

    for (const name of NOTE_COLOUR_CLASSES) {
      setClass(els.root, name, name === noteColourClass(note.colour));
    }
    for (const chip of els.menu.querySelectorAll<HTMLButtonElement>('.nz-note__chip')) {
      const on = chip.dataset['colour'] === String(note.colour);
      chip.setAttribute('aria-checked', on ? 'true' : 'false');
      setClass(chip, 'is-current', on);
    }

    // The text box is only written when it is not the thing being typed into:
    // rewriting `value` under a caret would move it to the end on every frame.
    if (document.activeElement !== els.text && els.text.value !== note.text) {
      els.text.value = note.text;
    }
    this.paintCount(els.count, els.text.value);
    setAttr(els.root, 'aria-label', t('note.label', { text: note.text.slice(0, 60) }));
  }

  /**
   * How much room is left.
   *
   * Drawn on every note but only *visible* while one is being typed into, or
   * once the cap is close enough to matter — a permanent counter on twelve
   * notes is twelve numbers nobody asked for, and no counter at all makes the
   * 2,000-character cut arrive without warning.
   */
  private paintCount(count: HTMLSpanElement, text: string): void {
    const left = remaining(text);
    setText(count, `${left}`);
    setClass(count, 'is-near', left <= NEAR_THE_CAP);
  }

  private begin(
    event: PointerEvent,
    kind: 'move' | 'resize',
    id: string,
    root: HTMLDivElement,
  ): void {
    if (event.button !== 0) return;
    // The canvas pans on a press anywhere it does not recognise, so this one is
    // claimed here rather than filtered out of every gesture on the host.
    event.preventDefault();
    event.stopPropagation();
    const rect = { x: root.offsetLeft, y: root.offsetTop };
    this.drag = {
      kind,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: kind === 'move' ? rect.x : root.offsetWidth,
      originY: kind === 'move' ? rect.y : root.offsetHeight,
      x: kind === 'move' ? rect.x : root.offsetWidth,
      y: kind === 'move' ? rect.y : root.offsetHeight,
    };
    // Capture keeps the drag alive when the pointer leaves the note, which at
    // 0.4× zoom it does immediately. It can throw when the pointer is not
    // active — a synthetic event, or a browser that has already released it —
    // and a drag that works slightly worse is better than one that dies here.
    try {
      root.setPointerCapture(event.pointerId);
    } catch {
      // Nothing to do: the listeners below still see the move on this element.
    }
    setClass(root, 'is-moving', true);

    const move = (moved: PointerEvent): void => {
      const drag = this.drag;
      if (drag === undefined || moved.pointerId !== drag.pointerId) return;
      const scale = Math.max(0.01, this.options.scale());
      const dx = (moved.clientX - drag.startX) / scale;
      const dy = (moved.clientY - drag.startY) / scale;
      if (drag.kind === 'move') {
        drag.x = Math.round(drag.originX + dx);
        drag.y = Math.round(drag.originY + dy);
        root.style.left = `${drag.x}px`;
        root.style.top = `${drag.y}px`;
      } else {
        const size = clampSize(drag.originX + dx, drag.originY + dy);
        drag.x = size.width;
        drag.y = size.height;
        root.style.width = `${size.width}px`;
        root.style.height = `${size.height}px`;
      }
    };

    const end = (ended: PointerEvent): void => {
      const drag = this.drag;
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', end);
      root.removeEventListener('pointercancel', end);
      setClass(root, 'is-moving', false);
      try {
        if (root.hasPointerCapture(ended.pointerId)) root.releasePointerCapture(ended.pointerId);
      } catch {
        // The capture was never taken, or the browser has already dropped it.
      }
      this.drag = undefined;
      if (drag === undefined) return;
      this.options.onChange(
        drag.kind === 'move'
          ? { kind: 'move', id: drag.id, x: drag.x, y: drag.y }
          : { kind: 'resize', id: drag.id, width: drag.x, height: drag.y },
      );
    };

    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
  }

  /** Drop every element. Used when the canvas swaps between live and frozen. */
  reset(): void {
    for (const els of this.notes.values()) els.root.remove();
    this.notes.clear();
    clear(this.options.root);
  }
}

/** The size a note is created at, re-exported so `app.ts` can centre one. */
export { NOTE_SIZE };
