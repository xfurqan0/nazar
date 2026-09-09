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
  stopPropagation?: () => void;
  preventDefault?: () => void;
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

  constructor(tag: string) {
    this.tag = tag;
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

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  removeChild(node: FakeElement): void {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parent = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
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

/** Put a `document` on `globalThis`. Idempotent, so every suite may call it. */
export function install(): void {
  const existing = (globalThis as { document?: unknown }).document;
  if (existing !== undefined) return;
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string): FakeElement => new FakeElement(tag),
  };
}

install();

/** A detached root to hang a component off. */
export function root(): FakeElement {
  return new FakeElement('div');
}
