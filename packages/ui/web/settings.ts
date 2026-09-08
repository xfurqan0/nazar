/**
 * N-WP12: the settings panel, and the two small components it is made of.
 *
 * The maintainer's report was one sentence — *the left menu looks very
 * cluttered, tidy it up* — and the screenshot said why: eight sections, of
 * which five were things you touch once and then never again. Frame colours
 * alone took a third of the height, behind a three-line paragraph explaining
 * what a contrast ratio is.
 *
 * So the drawer keeps the three sections you use while you work — the sessions,
 * the folder tabs they open, and the three view actions — and everything that
 * is a *setting* moved behind a gear at the foot. The gear opens this panel,
 * which takes the drawer's own place at the drawer's own width.
 *
 * Three decisions worth naming:
 *
 * - **It is not a modal.** No overlay, no focus trap, no dimmed canvas. The
 *   canvas is a live picture of running work and it stays visible and stays
 *   updating while a colour is being chosen — which is the only way to see what
 *   the colour did.
 * - **Open or closed is not remembered.** Every other mode in this page is
 *   (the drawer, the history view, the usage popover), and this one deliberately
 *   is not: the drawer exists for the session list, and a menu that opens on the
 *   page you left last is a menu you have to read before you can use it. It also
 *   saves a storage key, and this package changed no schema at all.
 * - **Escape is taken on the way down.** The handler is registered on the drawer
 *   in the *capture* phase, so it runs before the drawer's own Escape handler no
 *   matter which was constructed first, and stops the event only when it
 *   actually closed something. With the panel shut, Escape closes the drawer
 *   exactly as it did before.
 */
import { html, setClass, setText } from './dom.ts';

export interface SettingsPanelOptions {
  /** The drawer itself. Escape is caught here, above both views. */
  readonly sidebar: HTMLElement;
  /** The everyday view: sessions, folder tabs, view actions. */
  readonly main: HTMLElement;
  /** The panel that takes its place. */
  readonly panel: HTMLElement;
  /** The gear at the foot of the drawer. */
  readonly gear: HTMLButtonElement;
  /** The arrow at the head of the panel. */
  readonly back: HTMLButtonElement;
}

/**
 * The settings view of the drawer.
 *
 * One flag and two elements swapped: `main.hidden` and `panel.hidden` are
 * always opposites, so there is no state in which the drawer shows both or
 * neither.
 */
export class SettingsPanel {
  private readonly options: SettingsPanelOptions;

  private open = false;

  constructor(options: SettingsPanelOptions) {
    this.options = options;

    options.gear.addEventListener('click', () => this.set(!this.open, true));
    options.back.addEventListener('click', () => this.set(false, true));

    options.sidebar.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !this.open) return;
        event.stopPropagation();
        this.set(false, true);
      },
      { capture: true },
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Show or hide the panel. `focus` moves focus, which a silent close must not. */
  set(open: boolean, focus: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.options.panel.hidden = !open;
    this.options.main.hidden = open;
    this.options.gear.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!focus) return;
    if (open) this.options.back.focus();
    else this.options.gear.focus();
  }
}

/* ------------------------------------------------------------------ *
 * The two components the panel is written in
 * ------------------------------------------------------------------ */

/**
 * A switch: a label on the left, a track on the right.
 *
 * `role="switch"` on a real `<button>`, so Space and Enter operate it for free
 * and a screen reader says *on* or *off* rather than reading a label that ends
 * in `: off`. The old controls were buttons whose text carried the state
 * (`demo data: off`), which is a sentence to read where a switch is a shape to
 * glance at, and which said nothing to a screen reader that the label had not
 * already said.
 *
 * Every colour in `styles.css` comes from a palette token, so Sepia and
 * Midnight get their own switch instead of a blue one hard-coded against the
 * light theme.
 */
export function createSwitch(label: string): HTMLButtonElement {
  const button = html('button', 'nz-switch');
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', 'false');

  const text = html('span', 'nz-switch__label');
  setText(text, label);

  const track = html('span', 'nz-switch__track');
  track.setAttribute('aria-hidden', 'true');

  button.append(text, track);
  return button;
}

/**
 * Paint a switch, whether it was built here or written in `index.html`.
 *
 * The label is optional because two of the three switches never change theirs
 * and the third (`start with Windows`) is named by the platform the shell
 * reports.
 */
export function paintSwitch(button: HTMLElement, on: boolean, label?: string): void {
  button.setAttribute('aria-checked', on ? 'true' : 'false');
  if (label === undefined) return;
  const text = button.querySelector('.nz-switch__label');
  if (text !== null) setText(text, label);
}

/** One choice in a segmented control. */
export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly title?: string;
}

/**
 * A segmented control: every state visible, the current one marked.
 *
 * It replaces the button that cycled `system → dark → light` and printed which
 * one it was on. A cycling control has to be read before it can be used, cannot
 * show the states you are not in, and takes two presses to reach the one you
 * want. Three buttons take one.
 */
export function fillSegment<T extends string>(
  root: HTMLElement,
  options: readonly SegmentOption<T>[],
  onPick: (value: T) => void,
): (current: T) => void {
  const buttons = new Map<T, HTMLButtonElement>();
  for (const option of options) {
    const button = html('button', 'nz-segment__option');
    button.type = 'button';
    setText(button, option.label);
    if (option.title !== undefined) button.title = option.title;
    button.addEventListener('click', () => onPick(option.value));
    root.append(button);
    buttons.set(option.value, button);
  }
  return (current: T): void => {
    for (const [value, button] of buttons) {
      const on = value === current;
      setClass(button, 'is-current', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
}
