/**
 * The left drawer behind the hamburger.
 *
 * It holds the controls that are *modes* rather than moment-to-moment
 * information: theme, arrange, fit, the history drawer, the demo switch, and
 * what version this is. The top bar keeps only the two things you have to be
 * able to read without opening anything — the counts and the connection pill —
 * plus the waiting banner, which is the loudest element on the page and does
 * not belong behind a click.
 *
 * Open or closed is a mode too, so it is remembered.
 */
import { setClass } from './dom.ts';

export interface SidebarOptions {
  readonly root: HTMLElement;
  readonly toggle: HTMLButtonElement;
  /** Called whenever the drawer opens or closes, so the choice can be stored. */
  readonly onChange: (open: boolean) => void;
}

export class Sidebar {
  private readonly root: HTMLElement;

  private readonly toggle: HTMLButtonElement;

  private readonly onChange: (open: boolean) => void;

  private open = false;

  constructor(options: SidebarOptions) {
    this.root = options.root;
    this.toggle = options.toggle;
    this.onChange = options.onChange;

    this.toggle.addEventListener('click', () => {
      this.set(!this.open, true);
    });

    // Escape closes it from anywhere inside; focus goes back to the button that
    // opened it, which is the whole of "keyboard accessible" for a drawer.
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.set(false, true);
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Apply a state. `focus` moves focus, which a restore on load must not. */
  set(open: boolean, focus: boolean): void {
    if (open === this.open) {
      if (open && focus) this.focusFirst();
      return;
    }
    this.open = open;
    this.root.hidden = !open;
    this.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    setClass(document.body, 'has-sidebar', open);
    if (focus) {
      if (open) this.focusFirst();
      else this.toggle.focus();
    }
    this.onChange(open);
  }

  private focusFirst(): void {
    this.root.querySelector<HTMLButtonElement>('button')?.focus();
  }
}
