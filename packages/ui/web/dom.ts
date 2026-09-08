/**
 * The whole "framework".
 *
 * Every update path in the canvas goes through `setAttr` and `setText`, which
 * write only when the value actually moved. That is the entire diffing story:
 * elements are created once per node id and never rebuilt, so a token counter
 * ticking over touches one text node and nothing else. No virtual DOM, and no
 * `innerHTML = ...` anywhere near the render loop.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element with an optional class. */
export function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  className?: string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  if (className !== undefined) element.setAttribute('class', className);
  return element;
}

/** Create an HTML element with an optional class. */
export function html<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(name);
  if (className !== undefined) element.className = className;
  return element;
}

/** Write an attribute only when it differs from what is already there. */
export function setAttr(element: Element, name: string, value: string | number): void {
  const next = typeof value === 'number' ? roundString(value) : value;
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

/** Write text content only when it differs. */
export function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

/** Toggle a class only when the state differs. */
export function setClass(element: Element, name: string, on: boolean): void {
  if (element.classList.contains(name) === on) return;
  element.classList.toggle(name, on);
}

/** Two decimals at most: SVG coordinates do not need more, and diffs do. */
export function roundString(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Remove every child of an element. Used only outside the render loop. */
export function clear(element: Element): void {
  while (element.firstChild !== null) element.removeChild(element.firstChild);
}

/**
 * Rough width of a run of text at a given font size.
 *
 * `getBBox()` would be exact but forces a layout for every chip on every
 * frame, which is precisely the jank this file exists to avoid. Chips are
 * padded generously so an estimate a few pixels out never clips.
 */
export function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const character of text) {
    if (character === ' ' || character === '.' || character === ',' || character === 'i') units += 0.34;
    else if (character === character.toUpperCase() && character !== character.toLowerCase()) units += 0.68;
    else units += 0.55;
  }
  return units * fontSize;
}
