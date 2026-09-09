/**
 * N-WP13: the DOM half of the language machinery.
 *
 * Three jobs, and nothing else:
 *
 * 1. **The static words in `index.html`.** Every visible string in the markup
 *    was replaced by an attribute naming a message key, and {@link applyStatic}
 *    walks them. That is what makes a language switch redraw the page rather
 *    than reload it, and it is also what lets `i18n.test.ts` prove the markup
 *    carries no English at all: a page with hard-coded words would still look
 *    right in English and would be wrong in the other five.
 * 2. **Sentences with something inside them.** *Nazar 0.1.0 — empty canvas? Run
 *    `nazar doctor` in a terminal* has a version number and a `<code>` in the
 *    middle of it. Splitting the sentence into "before" and "after" halves
 *    would nail English's word order into the markup, so the template keeps its
 *    `{slot}` placeholders and {@link applyStatic} interleaves the real
 *    elements — which a translator may reorder freely.
 * 3. **The picker.** Six languages, each written in its own language, and
 *    nothing else — see {@link fillLanguagePicker}.
 * 4. **The tab title** (N-WP15). The tagline used to be a line of the top bar
 *    and is the browser tab now, so it is a sentence that has to be translated
 *    like every other one.
 */
import type { Locale } from '../src/i18n.ts';
import { LOCALES, currentLocale, t } from '../src/i18n.ts';
import { clear, html, setClass, setText } from './dom.ts';

/** Text content. */
const TEXT = 'data-nz-t';
/** A `title` attribute. */
const TITLE = 'data-nz-title';
/** An `aria-label`. */
const LABEL = 'data-nz-label';
/** A template with `{slot}` holes, filled by the element's own children. */
const RICH = 'data-nz-rich';
/** Which hole a child fills. */
const SLOT = 'data-nz-slot';
/** The product's own name. The one word on this page nobody translates. */
const BRAND = 'Nazar';

/**
 * The slot elements of a rich line, kept from the first pass.
 *
 * They have to survive being taken out of the element and put back in a
 * different order, and the version number written into one of them by `app.ts`
 * has to survive too — so the elements themselves are reused rather than
 * rebuilt from the markup each time.
 */
const slots = new WeakMap<Element, ReadonlyMap<string, Element>>();

/** Remember (or recall) the slot children of a rich element. */
function slotsOf(element: Element): ReadonlyMap<string, Element> {
  const known = slots.get(element);
  if (known !== undefined) return known;
  const found = new Map<string, Element>();
  for (const child of element.querySelectorAll(`[${SLOT}]`)) {
    const name = child.getAttribute(SLOT);
    if (name !== null) found.set(name, child);
  }
  slots.set(element, found);
  return found;
}

/**
 * Rebuild one rich line from its template.
 *
 * `{version}` and `{command}` are replaced by the elements that carry those
 * slot names; a placeholder a translation invented, or one whose element is
 * missing, is left as written, which is the same rule `interpolate` follows and
 * for the same reason — a hole nobody filled must be visible, not blank.
 */
function fillRich(element: Element, template: string): void {
  const parts = slotsOf(element);
  const pieces = template.split(/(\{\w+\})/g);
  clear(element);
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    const slot = name === undefined ? undefined : parts.get(name);
    if (slot !== undefined) element.append(slot);
    else element.append(document.createTextNode(piece));
  }
}

/**
 * Write every static string in a tree, in the language now in force.
 *
 * Called once before the first frame and again on every language change. It is
 * a full rewrite rather than a diff because it runs at most a handful of times
 * in a session and touches a couple of hundred nodes; `setText` still skips the
 * write when the string has not moved, so switching to the language you are
 * already in costs nothing.
 */
export function applyStatic(root: ParentNode = document): void {
  for (const element of root.querySelectorAll(`[${TEXT}]`)) {
    const key = element.getAttribute(TEXT);
    if (key !== null) setText(element, t(key));
  }
  for (const element of root.querySelectorAll(`[${RICH}]`)) {
    const key = element.getAttribute(RICH);
    if (key !== null) fillRich(element, t(key));
  }
  for (const element of root.querySelectorAll(`[${TITLE}]`)) {
    const key = element.getAttribute(TITLE);
    if (key !== null) element.setAttribute('title', t(key));
  }
  for (const element of root.querySelectorAll(`[${LABEL}]`)) {
    const key = element.getAttribute(LABEL);
    if (key !== null) element.setAttribute('aria-label', t(key));
  }
  /*
   * N-WP15: the tab title, which is where the tagline went when it came off the
   * top bar. Written here rather than in `index.html` for the reason every other
   * word on this page is: the markup carries the product's name, the catalogues
   * carry the sentence, and a browser tab in Korean must not say
   * "watches, does not drive".
   */
  document.title = `${BRAND} — ${t('bar.tagline')}`;
  document.documentElement.lang = currentLocale();
}

/* ------------------------------------------------------------------ *
 * The picker
 * ------------------------------------------------------------------ */

/**
 * What each language calls itself.
 *
 * Written here rather than in the catalogues, and that is deliberate: a picker
 * is read by somebody looking for **their own** language in it, and *Korean*
 * spelled in Russian helps nobody. So these six strings are the same in all six
 * files — which is why they are not in the files at all.
 */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  tr: 'Türkçe',
  zh: '中文',
  ko: '한국어',
  ru: 'Русский',
  es: 'Español',
};

/**
 * Fill the picker and return its painter.
 *
 * Buttons rather than a `<select>`, for the reason the palette picker uses
 * them: the chosen one has to be visible without opening anything, and a native
 * select on Windows draws its own list in the system font at the system size,
 * which in Chinese and Korean is a different height from everything around it.
 *
 * **Six entries, and no *follow the machine* among them** (N-WP13b). The
 * machine's language is still what an untouched Nazar paints itself in —
 * `resolveLocale` reads `navigator.languages` when nothing is stored — but it
 * is a *starting point*, not a thing to choose. Offering it as a seventh
 * option made a list of six languages and one instruction about languages, and
 * the entry it drew was the one nobody needed: whoever opens this list is
 * looking for a language, and the one the machine already gave them is
 * standing right there with a tick beside it. So the list is the six, the
 * ticked one is the language on screen whether or not anybody chose it, and
 * every entry does the same thing when clicked.
 */
export function fillLanguagePicker(
  root: HTMLElement,
  onPick: (locale: Locale) => void,
): (current: Locale) => void {
  const buttons = new Map<Locale, HTMLButtonElement>();
  for (const locale of LOCALES) {
    const button = html('button', 'nz-language__option');
    button.type = 'button';
    // A language names itself, so this text is written once and never again:
    // switching language does not change what `Русский` is called.
    setText(button, LANGUAGE_NAMES[locale]);
    button.addEventListener('click', () => onPick(locale));
    root.append(button);
    buttons.set(locale, button);
  }

  return (current: Locale): void => {
    for (const [locale, button] of buttons) {
      const on = locale === current;
      setClass(button, 'is-current', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
}
