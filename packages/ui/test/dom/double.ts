/**
 * N-WP20: a DOM double, so the page modules can be *run* rather than grepped.
 *
 * Every existing test of `web/` reads the source and asserts on a regular
 * expression — `assert.ok(panel.includes("html('button', 'nz-hrow')"))`. That
 * catches a deletion and nothing else. It cannot see a listing that stops at
 * 200 rows on a store of 201, an answer that arrives after its question was
 * withdrawn, or a button whose handler never fires: in every one of those the
 * source text is exactly what the test wants and the screen is still wrong.
 * This package's bugs were all of that shape, so its tests drive the real
 * classes through real events and count the elements that actually exist.
 *
 * It is a *double*, not an emulator. It implements the handful of DOM the
 * canvas actually uses — creation, class lists, text, attributes, children,
 * `hidden`, listeners, and the three scroll numbers — and nothing else. Two
 * consequences worth stating:
 *
 * - **No layout.** `scrollTop`, `clientHeight` and `scrollHeight` are plain
 *   writable numbers, so a test says "the list is scrolled to the end" by
 *   setting them. There is no engine to disagree with.
 * - **No bubbling.** `dispatch` calls the listeners on one node. Nothing in the
 *   history drawer relies on an event travelling, and inventing a propagation
 *   model would be inventing behaviour to test against.
 *
 * `install()` puts a `document` on `globalThis` and must be called before the
 * module under test builds any element. Importing this file does it.
 */

/** The subset of a DOM event the drawer's handlers read. */
export interface FakeEvent {
  readonly type: string;
  readonly key?: string;
  /**
   * N-WP21: which element the event happened on. The Needs-you strip's arrow
   * keys need it — "move focus off the row that has it" is a question about the
   * target and about nothing else.
   */
  readonly target?: unknown;
  stopPropagation?: () => void;
  preventDefault?: () => void;
}

/**
 * What `getBoundingClientRect()` answers.
 *
 * There is no layout engine here, so it is a plain writable object: a test that
 * cares where a popover is anchored says where the anchor is, exactly as it
 * says where the list is scrolled to.
 */
export interface FakeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

type Listener = (event: FakeEvent) => void;

export class FakeElement {
  readonly tag: string;

  readonly children: FakeElement[] = [];

  readonly attrs = new Map<string, string>();

  readonly dataset: Record<string, string> = {};

  private readonly classes = new Set<string>();

  private readonly listeners = new Map<string, Listener[]>();

  parent: FakeElement | undefined;

  hidden = false;

  type = '';

  title = '';

  textContent = '';

  /** Focus calls, so "closing gives focus back" is a count and not a guess. */
  focusCount = 0;

  /* The three numbers an "am I at the end of the list" check reads. No layout
   * engine sets them; a test does, which is the only way to write "the user has
   * scrolled to the bottom" without a browser. */
  scrollTop = 0;

  clientHeight = 0;

  scrollHeight = 0;

  /*
   * N-WP21. A popover anchored under a button reads three more numbers and
   * writes one property, and all four are the same kind of thing as the scroll
   * numbers above: a test states them, because there is nothing here to measure
   * them. `style` is a plain object rather than a `CSSStyleDeclaration`, which
   * is also the one place the double is stricter than the browser — under
   * `style-src 'self'` a style *attribute* is dropped silently, so the page
   * writes through the CSSOM and this double only implements the CSSOM.
   */
  readonly style: Record<string, string> = {};

  offsetWidth = 0;

  offsetHeight = 0;

  readonly rect: FakeRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

  constructor(tag: string) {
    this.tag = tag;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  readonly classList = {
    contains: (name: string): boolean => this.classes.has(name),
    toggle: (name: string, on?: boolean): void => {
      const wanted = on ?? !this.classes.has(name);
      if (wanted) this.classes.add(name);
      else this.classes.delete(name);
    },
  };

  set className(value: string) {
    this.classes.clear();
    for (const name of value.split(/\s+/)) if (name.length > 0) this.classes.add(name);
  }

  get className(): string {
    return [...this.classes].join(' ');
  }

  /**
   * `null` and not `undefined` when there are no children, because `clear()` in
   * `web/dom.ts` loops `while (element.firstChild !== null)`. A double that
   * answered `undefined` would spin that loop forever — the kind of thing a
   * double gets wrong once and only once.
   */
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  /*
   * N-WP21. The element half of the same three questions. A list that keeps one
   * node per row and *moves* the ones that are out of place — which is what the
   * Needs-you strip and the usage panel both do rather than rebuilding — needs
   * exactly these: where the list starts, what comes after a node, and how to
   * put a node in front of another one.
   */
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get nextElementSibling(): FakeElement | null {
    const siblings = this.parent?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get parentElement(): FakeElement | null {
    return this.parent ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent?.removeChild(node);
      node.parent = this;
      this.children.push(node);
    }
  }

  /** `before === null` appends, exactly as the DOM's own does. */
  insertBefore(node: FakeElement, before: FakeElement | null): FakeElement {
    node.parent?.removeChild(node);
    const at = before === null ? -1 : this.children.indexOf(before);
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
    node.parent = this;
    return node;
  }

  removeChild(node: FakeElement): void {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parent = undefined;
  }

  /** Take this node out of whatever holds it. A no-op on a detached node. */
  remove(): void {
    this.parent?.removeChild(this);
  }

  /*
   * N-WP15b: `class` is the class list and not an entry in the attribute map.
   *
   * `web/dom.ts`'s `svg()` names an element by writing the attribute, while
   * everything afterwards asks `classList`, and a double that kept the two
   * apart would answer "no such element" to every query about a card the canvas
   * had just drawn. The browser has one place for this; so does this.
   */
  setAttribute(name: string, value: string): void {
    if (name === 'class') {
      this.className = value;
      return;
    }
    this.attrs.set(name, value);
    /*
     * N-WP17a. `class` is a real attribute in SVG and the only way to set one
     * there — `svg()` in `web/dom.ts` writes `setAttribute('class', …)` because
     * `className` on an `SVGElement` is a read-only `SVGAnimatedString`. Without
     * this line the class list and the attribute would be two separate stores
     * and `byClass` would find nothing on the canvas, which is a property of
     * the double rather than of the page.
     */
    if (name === 'class') this.className = value;
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return this.classes.size === 0 ? null : this.className;
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    if (name === 'class') {
      this.classes.clear();
      return;
    }
    this.attrs.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) this.listeners.set(type, [listener]);
    else existing.push(listener);
  }

  focus(): void {
    this.focusCount += 1;
  }

  /** Fire every listener registered on *this* node for `type`. No bubbling. */
  dispatch(type: string, event: Partial<FakeEvent> = {}): void {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    const full: FakeEvent = {
      type,
      stopPropagation: (): void => undefined,
      preventDefault: (): void => undefined,
      ...event,
    };
    for (const listener of [...listeners]) listener(full);
  }

  /** True when this node carries a listener for `type`. */
  listensFor(type: string): boolean {
    return (this.listeners.get(type)?.length ?? 0) > 0;
  }

  /** This node and every node under it, in document order. */
  walk(): FakeElement[] {
    const out: FakeElement[] = [this];
    for (const child of this.children) out.push(...child.walk());
    return out;
  }

  /** Every element in this subtree carrying `name`, in document order. */
  byClass(name: string): FakeElement[] {
    return this.walk().filter((node) => node.classList.contains(name));
  }

  /** The first element in this subtree whose tag matches, or `undefined`. */
  byTag(tag: string): FakeElement | undefined {
    return this.walk().find((node) => node !== this && node.tag === tag);
  }

  /** Enough of `querySelector` for the one call the drawer makes: `'button'`. */
  querySelector(selector: string): FakeElement | null {
    return this.byTag(selector) ?? null;
  }
}

/**
 * Put a `document` — and, since N-WP21, a `window` — on `globalThis`.
 * Idempotent, so every suite may call it.
 *
 * The `window` carries one number: how wide the viewport is, which a popover
 * reads to keep itself on screen. Nothing else, and deliberately no
 * `setTimeout`/`requestAnimationFrame`: Node has its own timers and a page
 * module that reached for a scheduler through `window` would be reaching for
 * behaviour this double has not thought about.
 */
export function install(): void {
  const globals = globalThis as { document?: unknown; window?: unknown };
  if (globals.document === undefined) {
    globals.document = {
      createElement: (tag: string): FakeElement => new FakeElement(tag),
      /*
       * N-WP15b: the canvas is SVG, so driving it needs the namespaced half of
       * the same one call. The namespace is dropped on the floor — there is no
       * second document here for it to distinguish, and every element this
       * double makes behaves the same way — so it is `createElement` with an
       * argument in front of it.
       */
      createElementNS: (_ns: string, tag: string): FakeElement => new FakeElement(tag),
    };
  }
  if (globals.window === undefined) globals.window = { innerWidth: 1280, innerHeight: 800 };
}

install();

/** A detached root to hang a component off. */
export function root(): FakeElement {
  return new FakeElement('div');
}
