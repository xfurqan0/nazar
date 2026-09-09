/**
 * N-WP21: the Needs-you strip — the badge in the bar and the list behind it.
 *
 * The shape is the usage popover's, deliberately: a button in the top bar that
 * is **not drawn at all** when it has nothing to say, and a panel anchored under
 * it that opens on a click and closes on Escape, on a click outside, or on the
 * button again. Somebody who has learned one of the two has learned the other,
 * and the page grows a second gesture rather than a second vocabulary.
 *
 * What is different is what the panel holds, and both halves are lists of rows
 * whose whole area is a button:
 *
 * - **who is waiting for you**, longest first, each row saying what it is
 *   waiting for and for how long — and taking you to its card;
 * - **what finished while you were away**, newest first, with the run's
 *   duration and its totals where a status-line capture supplied them.
 *
 * Every decision about *what* is in those lists is in `../src/needs-you.ts` and
 * is pure. This file owns elements: it creates one row per session id, keeps it
 * across frames, and writes text into it. Rebuilding the list every frame would
 * be simpler and would also throw the keyboard's focus on the floor every two
 * seconds, which is the whole of why the cache exists.
 *
 * The one CSS rule that governs every write below is the one `web/quota.ts`
 * paid a day for: the page is served under `style-src 'self'`, so a `style`
 * **attribute** is dropped silently. The panel's position is written through
 * the CSSOM (`el.style.transform = …`) and never as an attribute.
 */
import type { FinishedRow, NeedsYouSession, NeedsYouState, WaitingRow } from '../src/needs-you.ts';
import {
  NO_NEEDS_YOU,
  finishedRows,
  finishedTitle,
  needsYouAnnouncement,
  needsYouBadge,
  needsYouEmpty,
  needsYouTitle,
  observeSessions,
  waitingRows,
} from '../src/needs-you.ts';
import { html, setClass, setText } from './dom.ts';

/** The glyph on the trailing edge of a row. The same one the sidebar uses. */
const GO = '→';

export interface NeedsYouOptions {
  readonly button: HTMLButtonElement;
  /** `Needs you · 2`. */
  readonly count: HTMLElement;
  /** How long the one at the top has been waiting. */
  readonly longest: HTMLElement;
  /** A region that stays in the page so a count of zero can be announced. */
  readonly live: HTMLElement;
  readonly panel: HTMLElement;
  readonly title: HTMLElement;
  readonly list: HTMLElement;
  /** What the panel says when nobody is waiting and nothing has finished. */
  readonly empty: HTMLElement;
  readonly finishedGroup: HTMLElement;
  readonly finishedToggle: HTMLElement;
  readonly finishedList: HTMLElement;
  /** The card names this browser has typed, read fresh on every frame. */
  readonly names: () => Readonly<Record<string, string>>;
  /** Take me to this session's card: switch tab, centre on it, focus it. */
  readonly onGo: (sessionId: string) => void;
  /**
   * And raise the terminal running it — **present only inside the desktop
   * shell**, the same way the card menu's *Jump to terminal* entry is. A
   * browser gets the card and no apology: it already knows where the jump
   * lives, because a double-click on the card says so.
   */
  readonly onJump?: (sessionId: string) => void;
  /**
   * Whether the shell hosting this page can *actually* jump — the same option
   * the card menu takes, for the same reason: since N-WP19a there are macOS and
   * Linux bundles and `apps/desktop/src/jump.rs` is `cfg!(windows)`. Asked when
   * a row is clicked rather than when the strip was built, because `shell_info`
   * answers a moment after the page loads. Absent means yes.
   */
  readonly canJump?: () => boolean;
}

/** The elements of one row, kept so a frame writes text rather than markup. */
interface RowEls {
  readonly root: HTMLButtonElement;
  readonly name: HTMLSpanElement;
  readonly folder: HTMLSpanElement;
  readonly what: HTMLSpanElement;
  readonly since: HTMLSpanElement;
}

export class NeedsYouStrip {
  private readonly options: NeedsYouOptions;

  /** In memory, for the life of the page. No storage key, by design. */
  private memory: NeedsYouState = NO_NEEDS_YOU;

  private readonly waitingEls = new Map<string, RowEls>();

  private readonly finishedEls = new Map<string, RowEls>();

  /**
   * The two lists in the order they are drawn, which is not the order their
   * caches were filled: the first cluster is sorted by how long a session has
   * been waiting, and a session that starts waiting later can sort above one
   * created earlier. The arrows walk *this*, so the keyboard and the eye agree.
   */
  private waitingOrder: HTMLButtonElement[] = [];

  private finishedOrder: HTMLButtonElement[] = [];

  private open = false;

  /** True while there is a badge to click. */
  private available = false;

  /** The second cluster is open by default and folds away for the session. */
  private finishedOpen = true;

  constructor(options: NeedsYouOptions) {
    this.options = options;
    setText(options.title, needsYouTitle());
    setText(options.finishedToggle, finishedTitle());
    options.finishedToggle.setAttribute('aria-expanded', 'true');

    options.button.addEventListener('click', () => this.toggle());
    options.finishedToggle.addEventListener('click', () => {
      this.finishedOpen = !this.finishedOpen;
      this.paintFinishedGroup();
    });
    options.panel.addEventListener('keydown', (event) => this.onKey(event));
  }

  /** True while the panel is on screen. */
  get isOpen(): boolean {
    return this.open;
  }

  /** Rewrite the strings written once, in the language now in force. */
  retranslate(): void {
    setText(this.options.title, needsYouTitle());
    setText(this.options.finishedToggle, finishedTitle());
    // The rows carry words too, and they are rebuilt rather than rewritten:
    // dropping the caches is how the next frame says everything again.
    this.reset();
  }

  /** Drop every cached row. The next `render` rebuilds them. */
  reset(): void {
    for (const els of this.waitingEls.values()) els.root.remove();
    for (const els of this.finishedEls.values()) els.root.remove();
    this.waitingEls.clear();
    this.finishedEls.clear();
    this.waitingOrder = [];
    this.finishedOrder = [];
  }

  toggle(): void {
    this.set(!this.open, true);
  }

  /** Apply a state. `focus` moves focus, which an automatic close must not. */
  set(open: boolean, focus: boolean): void {
    const wanted = open && this.available;
    if (wanted === this.open) {
      if (wanted) this.place();
      return;
    }
    this.open = wanted;
    this.options.panel.hidden = !wanted;
    this.options.button.setAttribute('aria-expanded', wanted ? 'true' : 'false');
    if (wanted) this.place();
    if (focus) {
      if (wanted) this.rows()[0]?.focus();
      else this.options.button.focus();
    }
  }

  /** Whether a click at this element should leave the panel open. */
  contains(node: Node): boolean {
    return this.options.panel.contains(node) || this.options.button.contains(node);
  }

  /**
   * One frame.
   *
   * `sessions` is the **live** state and never the frozen one, for the reason
   * the usage bead reads the live quota while a history tree is on screen: a
   * session waiting for a permission prompt is waiting for you whatever you
   * happen to be looking at. `generatedAt` is the age of the reading, which the
   * empty state prints so that "nobody is waiting" cannot be mistaken for a
   * stale page saying nothing.
   */
  render(
    sessions: readonly NeedsYouSession[],
    now: number,
    generatedAt: number | undefined,
  ): void {
    this.memory = observeSessions(this.memory, sessions, now);
    const names = this.options.names();
    const waiting = waitingRows(this.memory, sessions, now, names);
    const finished = finishedRows(this.memory, sessions, now, names);
    const badge = needsYouBadge(waiting);

    this.available = badge !== undefined || finished.length > 0;
    this.options.button.hidden = !this.available;
    if (!this.available && this.open) this.set(false, false);

    if (badge === undefined) {
      // No badge and no `Needs you · 0`: a control that is always there and
      // usually says nothing is a control people stop reading. The button can
      // still be drawn — for the finished cluster alone — and then it is the
      // panel's own title that names it.
      setText(this.options.count, needsYouTitle());
      setText(this.options.longest, '');
      setClass(this.options.button, 'is-waiting', false);
      this.options.button.setAttribute('aria-label', needsYouTitle());
      this.options.button.title = needsYouTitle();
    } else {
      setText(this.options.count, badge.label);
      setText(this.options.longest, badge.longest);
      setClass(this.options.button, 'is-waiting', true);
      this.options.button.setAttribute('aria-label', badge.description);
      this.options.button.title = badge.description;
    }

    // The announcement is the one string that is written whether the badge is
    // drawn or not: "nobody is waiting for you" is exactly the sentence
    // somebody wants when the badge has just gone away, and a hidden element
    // announces nothing.
    setText(this.options.live, needsYouAnnouncement(waiting));

    this.paintWaiting(waiting);
    this.paintFinished(finished);

    this.options.empty.hidden = waiting.length > 0 || finished.length > 0;
    if (!this.options.empty.hidden) setText(this.options.empty, needsYouEmpty(generatedAt, now));

    this.options.finishedGroup.hidden = finished.length === 0;
    this.paintFinishedGroup();

    if (this.open) this.place();
  }

  private paintWaiting(rows: readonly WaitingRow[]): void {
    const live = new Set<string>();
    const order: HTMLButtonElement[] = [];
    let previous: Element | undefined;
    for (const row of rows) {
      live.add(row.id);
      const els = this.waitingEls.get(row.id) ?? this.create(this.options.list, this.waitingEls, row.id);
      setText(els.name, row.label);
      setText(els.folder, row.folder);
      setText(els.what, row.what);
      setText(els.since, row.waited);
      els.root.title = row.description;
      els.root.setAttribute('aria-label', row.description);
      // Keep the sorted order without rebuilding: only a row that is out of
      // place moves, which on a list of three is almost never.
      const wanted =
        previous === undefined ? this.options.list.firstElementChild : previous.nextElementSibling;
      if (wanted !== els.root) this.options.list.insertBefore(els.root, wanted ?? null);
      previous = els.root;
      order.push(els.root);
    }
    this.sweep(this.waitingEls, live);
    this.waitingOrder = order;
  }

  private paintFinished(rows: readonly FinishedRow[]): void {
    const live = new Set<string>();
    const order: HTMLButtonElement[] = [];
    let previous: Element | undefined;
    for (const row of rows) {
      live.add(row.id);
      const els =
        this.finishedEls.get(row.id) ??
        this.create(this.options.finishedList, this.finishedEls, row.id);
      setText(els.name, row.label);
      setText(els.folder, row.folder);
      // A finished row has no question outstanding, so the middle column
      // carries what the run cost instead: duration, totals, money — each of
      // them dropped rather than drawn as `unknown` when no source had it.
      setText(
        els.what,
        [row.ranFor, row.tokens, row.cost].filter((part) => part !== undefined).join(' · '),
      );
      setText(els.since, row.ago);
      els.root.title = row.description;
      els.root.setAttribute('aria-label', row.description);
      const wanted =
        previous === undefined
          ? this.options.finishedList.firstElementChild
          : previous.nextElementSibling;
      if (wanted !== els.root) this.options.finishedList.insertBefore(els.root, wanted ?? null);
      previous = els.root;
      order.push(els.root);
    }
    this.sweep(this.finishedEls, live);
    this.finishedOrder = order;
  }

  private paintFinishedGroup(): void {
    this.options.finishedToggle.setAttribute('aria-expanded', this.finishedOpen ? 'true' : 'false');
    this.options.finishedList.hidden = !this.finishedOpen;
  }

  private sweep(cache: Map<string, RowEls>, live: ReadonlySet<string>): void {
    for (const [id, els] of cache) {
      if (live.has(id)) continue;
      els.root.remove();
      cache.delete(id);
    }
  }

  private create(parent: HTMLElement, cache: Map<string, RowEls>, id: string): RowEls {
    const root = html('button', 'nz-needs__row');
    root.type = 'button';
    root.dataset['sessionId'] = id;

    const text = html('span', 'nz-needs__text');
    const name = html('span', 'nz-needs__name');
    const folder = html('span', 'nz-needs__folder');
    const what = html('span', 'nz-needs__what');
    text.append(name, folder, what);

    const since = html('span', 'nz-needs__since');
    const arrow = html('span', 'nz-needs__go');
    setText(arrow, GO);

    root.append(text, since, arrow);
    root.addEventListener('click', () => {
      // Closing first, because the panel overlays the canvas it is about to
      // scroll: a row that took you to a card and then sat on top of it would
      // be a gesture that half worked.
      this.set(false, false);
      this.options.onGo(id);
      if (this.options.canJump?.() !== false) this.options.onJump?.(id);
    });
    parent.append(root);

    const els: RowEls = { root, name, folder, what, since };
    cache.set(id, els);
    return els;
  }

  /** Every row on screen, in the order the eye reads them. */
  private rows(): HTMLButtonElement[] {
    return this.finishedOpen ? [...this.waitingOrder, ...this.finishedOrder] : [...this.waitingOrder];
  }

  /**
   * The keyboard, which is the whole of what makes this a list rather than a
   * picture of one: the arrows walk it, Enter is the click a button already
   * has, and Escape closes and hands focus back to the badge.
   */
  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.set(false, true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = this.rows();
    if (rows.length === 0) return;
    const at = rows.indexOf(event.target as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    // Wrapping, because a list this short is a ring rather than a page: the
    // longest wait is one press up from the bottom of it.
    const next = at === -1 ? 0 : (at + step + rows.length) % rows.length;
    event.preventDefault();
    rows[next]?.focus();
  }

  /**
   * Put the panel under the badge.
   *
   * A CSSOM write, never a style *attribute* — see the note at the top of this
   * file. Anchored to the button rather than centred on the page, because a
   * popover that does not come out of the thing you clicked is a dialog and
   * this is not one.
   */
  private place(): void {
    const anchor = this.options.button.getBoundingClientRect();
    const panel = this.options.panel;
    const width = panel.offsetWidth || 360;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(anchor.bottom + 8)}px)`;
  }
}
