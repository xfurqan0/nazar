/**
 * WP5's strip, collapsed by WP4e into a bead in the bar and a panel behind it.
 *
 * The strip was a permanent row of six windows across the top of the page. It
 * answered "how much is left" without being asked, which is the right shape for
 * a number that changes while you watch — and quota is not that number. It
 * moves a few times an hour, the maintainer looks at it twice a day, and it was
 * costing 60 px of canvas the whole time in between. So:
 *
 * - **one bead in the top bar**, filled by the window closest to being spent,
 *   in the same four colours the tray icon uses;
 * - **the rows behind a click**, in a panel that opens under it — the same
 *   gesture nazar-tray has in the Windows tray, which is where he already looks
 *   for these numbers;
 * - **open or closed is remembered**, because it is a mode: someone who wants
 *   the old strip back leaves it open and gets it.
 *
 * The rows themselves are unchanged, and so is the rule they obey: nothing here
 * decides anything. `../src/quota-strip.ts` works out every label, colour,
 * percentage and countdown and `../src/usage-popover.ts` works out the bead;
 * this file writes strings into elements it created once, keyed by
 * `<provider>/<window>`.
 *
 * One CSP rule governs every visual write below and it cost WP5 a day: the page
 * is served under `style-src 'self'`, so a `style` **attribute** is dropped
 * silently. Widths and heights are written as SVG attributes or through the
 * CSSOM (`el.style.width = …`), and never through the element's `style`
 * attribute; `chrome.test.ts` fails the build if that ever changes.
 */
import {
  BEAD_SIZE,
  beadFillRows,
  beadLayerPath,
  beadRingPath,
  beadSolidPath,
} from '../src/bead.ts';
import type { QuotaItem, QuotaLike } from '../src/quota-strip.ts';
import { quotaItems, severityClass, freshnessClass, quotaSourceLabel } from '../src/quota-strip.ts';
import type { UsageBead } from '../src/usage-popover.ts';
import { usageBead, usageExplainer, usageNone, usageTitle } from '../src/usage-popover.ts';
import { html, setAttr, setClass, setText, svg } from './dom.ts';

/**
 * Side of a bead glyph, in CSS pixels.
 *
 * The mark is a 16-cell grid, so the sizes that keep it crisp are whole
 * multiples of 16 and — on the 1.5x and 2x screens a Windows desktop actually
 * runs at — 24. The panel's beads used to be 22 and the bar's 26, the bar's
 * being larger because it is the only one on screen when the panel is closed.
 * Neither number survives a pixel grid, 24 does, and the bar's bead earns its
 * prominence from the percentage written next to it instead of from two pixels.
 */
const BEAD = 24;

/** The one in the top bar. Same grid, same size — see above. */
const BAR_BEAD = 24;

/** Every severity class, so exactly one can be on at a time. */
const SEVERITIES = ['is-ok', 'is-warn', 'is-critical', 'is-unknown'] as const;

/** Every freshness class, same rule. */
const FRESHNESS = ['is-fresh', 'is-aging', 'is-stale', 'is-unknown-age'] as const;

interface ItemEls {
  readonly root: HTMLDivElement;
  readonly level: SVGRectElement;
  readonly label: HTMLSpanElement;
  readonly percent: HTMLSpanElement;
  readonly reset: HTMLSpanElement;
  readonly bar: HTMLDivElement;
}

interface BeadEls {
  readonly root: SVGSVGElement;
  /** The clip rect that decides how many whole rows of the bead are filled. */
  readonly level: SVGRectElement;
}

/**
 * The bead, drawn as the mark plus a fill that rises from the bottom.
 *
 * Same gauge as before the icon changed, on the pixel grid rather than on four
 * circles. The layers, in painter's order:
 *
 * 1. **ground** — every drawn cell of the silhouette, in the card's own colour,
 *    so an empty bead is the mark and not a hole;
 * 2. **fill** — the same silhouette in the severity colour, clipped to whole
 *    rows counted from the bottom (`beadFillRows`). The clip rect is the only
 *    thing that moves when a percentage changes;
 * 3. **iris and pupil** — on top of the fill, so the bead still reads as an eye
 *    at 88 % as it does at 4 %. The iris takes the mark's *white*, exactly as
 *    the round gauge did: a light-blue iris over a blue fill is one blue shape;
 * 4. **rim** — the outline ring, which used to be a 1 px stroke and is now the
 *    outermost cells (see `.nz-quota__bead-rim` in the stylesheet).
 *
 * Its own `clipPath` per instance, because ids have to be unique in one
 * document and there is no shared `<defs>` on this page.
 */
function makeBead(clipId: string, size: number, className: string): BeadEls {
  const root = svg('svg', className);
  // The viewBox is the grid, never the pixel size: the cells are the unit, and
  // `size` only decides how many device pixels each one lands on.
  setAttr(root, 'viewBox', `0 0 ${BEAD_SIZE} ${BEAD_SIZE}`);
  setAttr(root, 'width', size);
  setAttr(root, 'height', size);
  root.setAttribute('shape-rendering', 'crispEdges');
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');

  const defs = svg('defs');
  const clip = svg('clipPath');
  clip.setAttribute('id', clipId);
  const level = svg('rect');
  setAttr(level, 'x', 0);
  setAttr(level, 'width', BEAD_SIZE);
  clip.append(level);
  defs.append(clip);

  const silhouette = beadSolidPath();

  const ground = svg('path', 'nz-quota__bead-ground');
  setAttr(ground, 'd', silhouette);

  const fill = svg('path', 'nz-quota__bead-fill');
  setAttr(fill, 'd', silhouette);
  fill.setAttribute('clip-path', `url(#${clipId})`);

  const iris = svg('path', 'nz-quota__bead-iris');
  setAttr(iris, 'd', beadLayerPath('I'));
  const pupil = svg('path', 'nz-quota__bead-pupil');
  setAttr(pupil, 'd', beadLayerPath('P'));
  const rim = svg('path', 'nz-quota__bead-rim');
  setAttr(rim, 'd', beadRingPath());

  root.append(defs, ground, fill, iris, pupil, rim);
  return { root, level };
}

/**
 * Fill a bead from the bottom, a whole cell at a time.
 *
 * The clip rect is in grid units, so it can only ever land on a cell boundary —
 * which is what keeps the one moving part of a hard-edged mark hard-edged.
 * `beadFillRows` owns the rounding and is tested on its own.
 */
function fillBead(level: SVGRectElement, percent: number): void {
  const rows = beadFillRows(percent);
  setAttr(level, 'y', BEAD_SIZE - rows);
  setAttr(level, 'height', rows);
}

export interface UsagePanelOptions {
  /** The bead button in the top bar. Hidden outright when there is no source. */
  readonly button: HTMLButtonElement;
  /** The percentage drawn next to it, so the bead is never colour alone. */
  readonly buttonPercent: HTMLElement;
  /** The popover. */
  readonly panel: HTMLElement;
  /** Where the rows go. */
  readonly list: HTMLElement;
  /** The one-line explanation of what a usage limit is. */
  readonly explainer: HTMLElement;
  /** Where the numbers come from, in words. */
  readonly source: HTMLElement;
  /** Called when the panel opens or closes, so the choice can be stored. */
  readonly onToggle: (open: boolean) => void;
}

/**
 * The bead, the panel, and the rows in it.
 *
 * `render` is total: given no quota it hides the button *and* the panel and
 * removes every row, which is the state on a machine with neither nazar-tray
 * nor the wrapper. There is no empty panel and no placeholder window — and no
 * bead sitting at zero, which would read as "nothing used" rather than as
 * "nothing known".
 */
export class UsagePanel {
  private readonly options: UsagePanelOptions;

  private readonly bead: BeadEls;

  private readonly items = new Map<string, ItemEls>();

  private nextClipId = 0;

  private open = false;

  private available = false;

  constructor(options: UsagePanelOptions) {
    this.options = options;
    this.bead = makeBead('nz-usage-bead-clip', BAR_BEAD, 'nz-usage-bead__mark');
    options.button.prepend(this.bead.root);
    setText(options.explainer, usageExplainer());

    options.button.addEventListener('click', () => this.toggle());
    // Escape closes it from inside, and focus goes back to the bead: the whole
    // of "keyboard accessible" for a popover.
    options.panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.set(false, true);
    });
  }

  /** True while the panel is on screen. */
  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Rewrite the words this panel wrote once, in the language now in force.
   *
   * The explanation is the only string set in the constructor; everything else
   * goes through `render`, which the language switch calls straight after.
   */
  retranslate(): void {
    setText(this.options.explainer, usageExplainer());
  }

  /** True while there is a source to draw at all. */
  get hasSource(): boolean {
    return this.available;
  }

  toggle(): void {
    this.set(!this.open, true);
  }

  /** Apply a state. `focus` moves focus, which a restore on load must not. */
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
      if (wanted) this.options.panel.querySelector<HTMLButtonElement>('button')?.focus();
      else this.options.button.focus();
    }
    this.options.onToggle(open);
  }

  /** Whether a click at this element should leave the panel open. */
  contains(node: Node): boolean {
    return this.options.panel.contains(node) || this.options.button.contains(node);
  }

  render(quota: QuotaLike | undefined, now: number): void {
    const items = quotaItems(quota, now);
    const bead = usageBead(items);

    this.available = bead !== undefined;
    this.options.button.hidden = bead === undefined;
    if (bead === undefined) {
      // Nothing to say, so nothing is drawn — not an empty bead, not a panel of
      // placeholders. The sidebar's source line is where a machine with no
      // wrapper is told why.
      if (this.open) this.set(false, false);
      this.options.panel.hidden = true;
      for (const els of this.items.values()) els.root.remove();
      this.items.clear();
      this.options.button.setAttribute('aria-label', usageNone());
      return;
    }

    this.paintButton(bead);
    setText(this.options.source, quotaSourceLabel(quota));

    const live = new Set<string>();
    let previous: HTMLElement | undefined;

    for (const item of items) {
      live.add(item.id);
      const els = this.items.get(item.id) ?? this.create(item);
      this.paint(els, item);
      // Keep file order without rebuilding: only a node that is out of place
      // moves, and on a panel of six items that is almost never.
      const wanted =
        previous === undefined ? this.options.list.firstElementChild : previous.nextElementSibling;
      if (wanted !== els.root) this.options.list.insertBefore(els.root, wanted ?? null);
      previous = els.root;
    }

    for (const [id, els] of this.items) {
      if (live.has(id)) continue;
      els.root.remove();
      this.items.delete(id);
    }

    if (this.open) this.place();
  }

  private paintButton(bead: UsageBead): void {
    const button = this.options.button;
    for (const name of SEVERITIES) setClass(button, name, name === severityClass(bead.severity));
    fillBead(this.bead.level, bead.percent);
    // The number next to the bead, always: a fill level is a colour and a shape,
    // and neither survives a greyscale screenshot or a reader who cannot
    // separate amber from red. Same rule the strip had.
    setText(this.options.buttonPercent, bead.percentText);
    button.title = bead.description;
    button.setAttribute('aria-label', bead.description);
  }

  /**
   * Put the panel under the bead.
   *
   * A CSSOM write, never a style *attribute*: see the note at the top of this
   * file. It is anchored to the button rather than centred on the page because
   * a popover that does not come out of the thing you clicked is a dialog, and
   * this is not one.
   */
  private place(): void {
    const anchor = this.options.button.getBoundingClientRect();
    const panel = this.options.panel;
    const width = panel.offsetWidth || 320;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(anchor.bottom + 8)}px)`;
  }

  private create(item: QuotaItem): ItemEls {
    const root = html('div', 'nz-quota__item');
    root.dataset['window'] = item.id;

    this.nextClipId += 1;
    const bead = makeBead(`nz-quota-clip-${this.nextClipId}`, BEAD, 'nz-quota__bead');

    const text = html('div', 'nz-quota__text');
    const head = html('div', 'nz-quota__head');
    const label = html('span', 'nz-quota__label');
    const percent = html('span', 'nz-quota__percent');
    head.append(label, percent);

    const bar = html('div', 'nz-quota__bar');
    const fill = html('div', 'nz-quota__fill');
    bar.append(fill);

    const reset = html('span', 'nz-quota__reset');
    text.append(head, bar, reset);

    root.append(bead.root, text);
    this.options.list.append(root);

    const els: ItemEls = { root, level: bead.level, label, percent, reset, bar: fill };
    this.items.set(item.id, els);
    return els;
  }

  private paint(els: ItemEls, item: QuotaItem): void {
    for (const name of SEVERITIES) setClass(els.root, name, name === severityClass(item.severity));
    for (const name of FRESHNESS) {
      const wanted = item.freshness === 'unknown' ? 'is-unknown-age' : freshnessClass(item.freshness);
      setClass(els.root, name, name === wanted);
    }
    setClass(els.root, 'is-binding', item.binding);
    setClass(els.root, 'is-detailed', item.detailed);

    fillBead(els.level, item.barPercent);

    setText(els.label, item.label);
    setText(els.percent, item.percentText);
    /*
     * A CSSOM write, never a style *attribute*. See the file header: under
     * `style-src 'self'` the attribute lands in the DOM and the browser
     * silently declines to apply it, which is how every bar here was drawn full
     * width until one was measured.
     */
    const width = `${item.barPercent.toFixed(1)}%`;
    if (els.bar.style.width !== width) els.bar.style.width = width;
    // The countdown and the age share one line: a stale reading has both to say
    // and a fresh one has only the countdown, so they are joined rather than
    // given a row each that would be empty most of the time.
    setText(
      els.reset,
      [item.countdown, item.ageText].filter((part) => part.length > 0).join(' · '),
    );

    els.root.title = item.description;
    els.root.setAttribute('aria-label', item.description);
  }
}

/** Re-exported so the page has one import for the panel and its wording. */
export { usageTitle };
