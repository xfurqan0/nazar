/**
 * The WP4c chrome that lives in markup and CSS rather than in a function.
 *
 * Node has no DOM, so this is a contract test between four files that have to
 * agree: `index.html` carries the controls, `styles.css` is the only place that
 * gives their class names a meaning, and `app.ts`/`canvas.ts` are the only
 * places that attach behaviour. Rename a control or delete a rule and the
 * canvas silently loses its drag handle or its tab bar; this fails instead.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');
const css = readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
const canvas = readFileSync(path.join(webDir, 'canvas.ts'), 'utf8');
const quota = readFileSync(path.join(webDir, 'quota.ts'), 'utf8');
const notes = readFileSync(path.join(webDir, 'notes.ts'), 'utf8');
const colours = readFileSync(path.join(webDir, 'colours.ts'), 'utf8');
const layoutSrc = readFileSync(path.join(here, '..', 'src', 'layout.ts'), 'utf8');

test('the page carries every control WP4c and WP4e wire up', () => {
  for (const id of [
    'menu-toggle',
    'sidebar',
    'tabs',
    'cardmenu',
    'canvasmenu',
    'theme-toggle',
    'palette',
    'colours',
    'arrange',
    'fit',
    'add-note',
    'notes',
    'demo-toggle',
    'history-toggle',
    'version',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
    assert.ok(app.includes(`'${id}'`), `#${id} is in the page but nothing looks it up`);
  }
});

test('the hamburger is announced as the control it is', () => {
  assert.match(html, /id="menu-toggle"[\s\S]{0,260}aria-expanded="false"/);
  assert.match(html, /id="menu-toggle"[\s\S]{0,260}aria-controls="sidebar"/);
  assert.ok(html.includes('<aside id="sidebar"'), 'the drawer is an aside, not a div');
});

test('the controls that left the top bar are in the sidebar and nowhere else', () => {
  // The counts and the connection pill stay in the bar; the waiting banner is
  // the loudest element on the page and never goes behind a click.
  const bar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  for (const id of ['theme-toggle', 'fit', 'history-toggle']) {
    assert.equal(bar.includes(`id="${id}"`), false, `#${id} is still in the top bar`);
  }
  assert.ok(bar.includes('id="counts"'));
  assert.ok(bar.includes('id="conn"'));
  assert.ok(html.includes('<div id="banner"'), 'the waiting banner is still its own region');

  const sidebar = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('id="canvas-host"'));
  for (const id of [
    'theme-toggle',
    'palette',
    'colours',
    'arrange',
    'fit',
    'add-note',
    'history-toggle',
    'demo-toggle',
  ]) {
    assert.ok(sidebar.includes(`id="${id}"`), `#${id} did not make it into the sidebar`);
  }
});

test('every class the canvas sets has a rule that gives it a meaning', () => {
  for (const marker of [
    '.nz-hamburger',
    '.nz-tabs',
    '.nz-tab.is-active',
    '.nz-tab.is-drop',
    '.nz-tab__input',
    '.nz-sidebar',
    '.nz-item',
    '.nz-menu__item',
    '.nz-session__handle',
    '.nz-session.is-moving',
    '.nz-chevron__mark',
    '.nz-cardmenu__dot',
    '.nz-chip--running',
    '.nz-session__activity',
    '.nz-agent__activity',
    '.nz-session.is-working',
    '.nz-session.is-idle',
    '.nz-agent.is-working',
    // WP4e
    '.nz-usage-bead',
    '.nz-usage',
    '.nz-palette.is-current',
    '.nz-colour__hint.is-low',
    '.nz-note',
    '.nz-note__grip',
    '.nz-note__resize',
    '.nz-note__chip.is-current',
    '.nz-session__context',
  ]) {
    assert.ok(css.includes(marker), `${marker} is set somewhere but styled nowhere`);
  }
});

test('a drawer and a tab bar that are hidden are actually hidden', () => {
  // `display: flex` beats the `hidden` attribute unless a rule says otherwise,
  // which is a bug that only shows up on the page.
  for (const marker of [
    '.nz-sidebar[hidden]',
    '.nz-tabs[hidden]',
    '.nz-menu[hidden]',
    '.nz-usage[hidden]',
    '.nz-usage-bead[hidden]',
    '.nz-notes[hidden]',
    '.nz-note__panel[hidden]',
  ]) {
    assert.ok(css.includes(marker), `${marker} would still be laid out`);
  }
});

test('the card header is a drag handle and the body still pans', () => {
  assert.ok(canvas.includes("handle.dataset['drag'] = 'card'"));
  assert.ok(app.includes('[data-drag="card"]'), 'nothing starts a card drag');
  assert.ok(app.includes('setClass(host, \'is-dragging\', true)'), 'the pan gesture is still there');
  assert.ok(css.includes('cursor: grab'), 'the handle says what it is');
});

test('the two card buttons take their own clicks instead of panning', () => {
  assert.ok(canvas.includes("chevron.dataset['action'] = 'collapse'"));
  assert.ok(canvas.includes("menu.dataset['action'] = 'menu'"));
  assert.ok(app.includes("node.closest('[data-action]') !== null) return"));
  // And they are reachable without a pointer.
  assert.ok(canvas.includes("chevron.setAttribute('tabindex', '0')"));
  assert.ok(canvas.includes("menu.setAttribute('tabindex', '0')"));
  assert.ok(app.includes("event.key !== 'Enter' && event.key !== ' '"));
});

/* ------------------------------------------------------------------ *
 * WP5, as WP4e left it: the bead in the bar and the panel behind it
 * ------------------------------------------------------------------ */

test('the bead is in the top bar, left of everything, above the tab bar', () => {
  assert.ok(html.includes('id="usage-bead"'), '#usage-bead is missing from index.html');
  assert.ok(app.includes("'usage-bead'"), '#usage-bead is in the page but nothing looks it up');

  const bar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(bar.includes('id="usage-bead"'), 'the bead left the top bar');
  // Left of the brand, and the whole header is above the tab bar, which is
  // where the maintainer asked for it.
  assert.ok(
    bar.indexOf('id="usage-bead"') < bar.indexOf('class="nz-brand"'),
    'the bead should lead the bar, not trail it',
  );
  assert.ok(html.indexOf('id="usage-bead"') < html.indexOf('<nav id="tabs"'));

  // And it is a real button that announces the panel it controls.
  assert.match(html, /id="usage-bead"[\s\S]{0,300}aria-expanded="false"/);
  assert.match(html, /id="usage-bead"[\s\S]{0,300}aria-controls="usage"/);
  assert.match(html, /id="usage-bead"[\s\S]{0,300}hidden/);
});

test('the panel is a popover with a title and an explanation, not a strip', () => {
  assert.ok(html.includes('id="usage"'), '#usage is missing');
  assert.ok(html.includes('id="usage-explainer"'), 'the panel has no explanation line');
  assert.ok(html.includes('id="usage-list"'), 'the windows have nowhere to go');
  assert.ok(html.includes('id="usage-source"'), 'the panel does not say where the numbers came from');
  assert.match(html, /id="usage"[\s\S]{0,200}role="dialog"/);
  assert.match(html, /id="usage"[\s\S]{0,300}aria-describedby="usage-explainer"/);
  // The strip is gone: it was a permanent row for a number that moves a few
  // times an hour, which is what WP4e removed.
  assert.equal(html.includes('<div id="quota"'), false, 'the old strip is still in the page');
  assert.equal(css.includes('.nz-quota {'), false, 'the strip still has a container rule');
});

test('the explanation is written once, in the source, and injected', () => {
  // Not typed into `index.html`: the sentence is part of the contract the
  // rename created, so `usage-popover.ts` owns it and a test can read it.
  assert.ok(quota.includes('usageExplainer'), 'nothing writes the explanation');
  assert.match(html, /<p id="usage-explainer"[^>]*><\/p>/, 'the element must start empty');
});

test('every class the panel sets has a rule that gives it a meaning', () => {
  for (const marker of [
    '.nz-quota__item',
    '.nz-quota__bead',
    '.nz-quota__bead-fill',
    '.nz-quota__label',
    '.nz-quota__percent',
    '.nz-quota__bar',
    '.nz-quota__fill',
    '.nz-quota__reset',
    '.nz-quota__item.is-warn',
    '.nz-quota__item.is-critical',
    '.nz-quota__item.is-unknown',
    '.nz-quota__item.is-aging',
    '.nz-quota__item.is-stale',
    '.nz-quota__item.is-binding',
  ]) {
    assert.ok(css.includes(marker), `${marker} is set somewhere but styled nowhere`);
  }
});

test('the panel writes every severity class it can produce', () => {
  for (const name of ['is-ok', 'is-warn', 'is-critical', 'is-unknown']) {
    assert.ok(quota.includes(`'${name}'`), `${name} is a severity the stylesheet expects`);
  }
  // And the bead in the bar takes the same three, so one colour cannot say one
  // thing in the bar and another in the panel. The **fill** especially: a bead
  // that stayed blue at 88 % would be a green light on a machine nearly out of
  // quota, which is exactly the failure the collapse could have introduced.
  for (const marker of [
    '.nz-usage-bead.is-warn .nz-quota__bead-fill',
    '.nz-usage-bead.is-critical .nz-quota__bead-fill',
    '.nz-usage-bead.is-unknown .nz-quota__bead-fill',
    '.nz-usage-bead.is-warn .nz-usage-bead__percent',
    '.nz-usage-bead.is-critical .nz-usage-bead__percent',
  ]) {
    assert.ok(css.includes(marker), `${marker} is set somewhere but styled nowhere`);
  }
});

test('an unknown window is grey and empty rather than a full-looking bar', () => {
  // The one rule the whole strip exists not to break: "I could not read it"
  // must not look like "you have used nothing".
  const rule = css.slice(css.indexOf('.nz-quota__item.is-unknown .nz-quota__bar'));
  assert.match(rule.slice(0, 200), /background: transparent/);
});

test('no shipped page code writes a style *attribute*', () => {
  // The page is served under `style-src 'self'`, which blocks inline style
  // attributes: `setAttribute('style', …)` lands in the DOM, shows up in a DOM
  // dump, and is then silently not applied. Every quota bar was drawn full
  // width for exactly that reason until one was measured. A CSSOM write
  // (`el.style.width = …`) is not an inline style and is not blocked.
  for (const [name, source] of [
    ['app.ts', app],
    ['canvas.ts', canvas],
    ['quota.ts', quota],
    ['notes.ts', notes],
    ['colours.ts', colours],
  ] as const) {
    assert.doesNotMatch(
      source,
      /setAttr\([^,]+,\s*'style'/,
      `${name} writes a style attribute, which the page's own CSP drops on the floor`,
    );
    assert.doesNotMatch(source, /setAttribute\(\s*'style'/, `${name} writes a style attribute`);
  }
  assert.ok(css.includes("style-src 'self'") === false, 'the policy lives in the server, not here');
});

test('the sidebar says where the numbers come from', () => {
  assert.ok(html.includes('id="quota-source"'));
  assert.ok(app.includes("'quota-source'"));
  assert.ok(app.includes('quotaSourceLabel'), 'nothing writes the source line');
  // And it links to the section of the README that says how to get them, under
  // the name WP4e gave it.
  assert.ok(html.includes('#usage-limits-cost-and-context'), 'the sidebar link has no target');
});

test('cost and context are rows that appear, not rows that say unknown', () => {
  assert.ok(app.includes('OPTIONAL_ROWS'), 'the hover card has no optional rows');
  assert.ok(app.includes('setOptional'), 'nothing hides a row that has no value');
  // On the card itself neither is drawn when there is nothing in it, and each
  // is drawn with the word in front of it when there is (WP4e).
  assert.ok(canvas.includes("setAttr(els.cost, 'display'"));
  assert.ok(canvas.includes("setAttr(els.context, 'display'"));
  assert.ok(canvas.includes('cardCostLabel'), 'the card writes a bare number again');
  assert.ok(canvas.includes('cardContextLabel'));
  for (const marker of ['.nz-session__cost', '.nz-session__context']) {
    assert.ok(css.includes(marker), `${marker} is styled nowhere`);
  }
});

/* ------------------------------------------------------------------ *
 * WP4e: notes, colours, and the words
 * ------------------------------------------------------------------ */

test('the notes layer sits over the canvas and takes no gestures of its own', () => {
  assert.ok(html.includes('<div id="notes"'), 'the notes layer is missing');
  const layer = css.slice(css.indexOf('.nz-notes {'), css.indexOf('.nz-notes[hidden]'));
  // The layer must not eat the pan gesture: everywhere there is no note, a
  // press has to reach the SVG underneath.
  assert.match(layer, /pointer-events: none/);
  assert.match(layer, /transform-origin: 0 0/);
  assert.match(css.slice(css.indexOf('.nz-note {')), /pointer-events: auto/);
  // And it carries the same transform as the SVG viewport group, or a note
  // would drift away from the card it annotates on every pan.
  assert.ok(notes.includes('applyView'), 'nothing moves the layer');
  assert.ok(app.includes('notesLayer.applyView(view)'), 'the layer is not moved with the canvas');
});

test('a note takes its own presses so the canvas does not pan under it', () => {
  assert.ok(app.includes("node.closest('.nz-note')"), 'nothing tells a note from the canvas');
  assert.ok(notes.includes('event.stopPropagation()'), 'a note drag would also pan the canvas');
  assert.ok(notes.includes('maxLength'), 'the 2,000-character cap is not on the text box');
});

test('the colour pickers write custom properties, not a second stylesheet', () => {
  assert.ok(colours.includes('style.setProperty'), 'an override reaches the page how?');
  assert.ok(colours.includes('style.removeProperty'), 'a reset must remove, never overwrite');
  assert.ok(colours.includes('--nz-node'), 'the hint is measured against the card ground');
  assert.ok(html.includes('id="colours"'));
});

test('the palette picker offers exactly the themes the build compiled in', () => {
  // The list is injected by `build.mjs` from the same array it generated the
  // token blocks from, so a picker entry with no rules behind it is impossible.
  const build = readFileSync(path.join(webDir, '..', 'build.mjs'), 'utf8');
  assert.ok(build.includes('__NAZAR_THEMES__'), 'the build injects no theme list');
  assert.ok(app.includes('__NAZAR_THEMES__'), 'the picker invents its own list');
  assert.ok(app.includes('data-palette'), 'nothing applies a palette');
});

test('only the document root ever carries data-palette', () => {
  /*
   * The bug this pins, found on the Sepia screenshot: the picker's buttons were
   * given `data-palette="<name>"` as a plain label, and `data-palette` is the
   * attribute the generated stylesheet **scopes a whole theme by**. Each button
   * therefore became a palette root and drew itself out of that theme's block —
   * and out of its *dark* block, because the guard is
   * `[data-palette="x"]:not([data-theme="light"])` and a button has no
   * `data-theme` of its own. A scoping attribute is not a free label.
   */
  assert.equal(
    app.includes("dataset['palette']"),
    false,
    'an element other than the root is being labelled with the theme scoping attribute',
  );
  const writes = [...app.matchAll(/setAttribute\('data-palette'/g)];
  assert.equal(writes.length, 1, 'data-palette should be written in exactly one place');
  assert.match(
    app,
    /root\.setAttribute\('data-palette', name\)/,
    'and that place is the document root',
  );
  assert.equal(
    html.includes('data-palette'),
    false,
    'the markup must not carry a palette scope either',
  );
});

test('nothing a user reads says "quota"', () => {
  // The maintainer does not know the word, and the code keeps it: the wire
  // format, the file name and the functions are all still `quota`, which is why
  // this test looks at the markup and not at the sources.
  const visible = html
    // strip HTML comments and attribute values that are ids or hrefs
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sid="[^"]*"/g, '')
    .replace(/\shref="[^"]*"/g, '')
    .replace(/\saria-controls="[^"]*"/g, '');
  assert.equal(/quota/i.test(visible), false, 'the page still says "quota" to the user');
  assert.ok(html.includes('Usage limits'), 'and it has to say something instead');
});

test('the arrangement, the notes and the colours are stored in the browser only', () => {
  assert.ok(app.includes('window.localStorage'), 'the only store a page has');
  for (const forbidden of ['node:fs', 'writeFile', "fetch('/api/layout", "fetch('/api/notes"]) {
    assert.equal(app.includes(forbidden), false, `app.ts reaches for ${forbidden}`);
  }
  for (const key of ['nazar.notes.v1', 'nazar.colours.v1', 'nazar.usage.v1']) {
    const found = [
      readFileSync(path.join(webDir, '..', 'src', 'notes.ts'), 'utf8'),
      readFileSync(path.join(webDir, '..', 'src', 'colours.ts'), 'utf8'),
      readFileSync(path.join(webDir, '..', 'src', 'usage-popover.ts'), 'utf8'),
    ].some((source) => source.includes(key));
    assert.ok(found, `${key} is named nowhere`);
  }
});

/* ------------------------------------------------------------------ *
 * WP4f: the pattern, the grips and the two new card affordances
 *
 * Node has no DOM, so the contract between the four files is the test. Every
 * one of these is a rename away from silently losing a control: the pattern
 * that no longer pans, four grips nothing can press, a chip nothing brings
 * back, a hint nothing explains.
 * ------------------------------------------------------------------ */

test('the background pattern is a pattern the canvas can move', () => {
  assert.ok(html.includes('id="nz-grid"'), 'the pattern needs an id to be reached');
  assert.ok(html.includes('patternUnits="userSpaceOnUse"'), 'a pattern in screen units, not in %');
  assert.ok(html.includes('patternTransform='), 'it starts with the attribute the frame rewrites');
  assert.ok(app.includes("element<SVGPatternElement>('nz-grid')"), 'nothing looks the pattern up');
  assert.ok(
    app.includes("setAttr(gridPattern, 'patternTransform', patternTransform(patternOffset(view, GRID_TILE)))"),
    'the pattern is not moved on the frame that moves everything else',
  );
});

test('the pattern tile in the page and the one in the code are the same number', () => {
  // The offset is reduced modulo the tile, so a mismatch makes the dots crawl.
  const tile = /<pattern[^>]*id="nz-grid"[\s\S]*?width="(\d+)"[\s\S]*?height="(\d+)"/.exec(html);
  assert.ok(tile !== null, 'the pattern has no tile size');
  assert.equal(tile[1], tile[2], 'a square tile, or the dots are a lattice');
  const constant = /const GRID_TILE = (\d+);/.exec(app);
  assert.ok(constant !== null, 'GRID_TILE is gone');
  assert.equal(constant[1], tile[1], 'index.html and app.ts disagree about the tile');
});

test('a card can be resized from all four corners', () => {
  assert.ok(canvas.includes("const CORNERS = ['nw', 'ne', 'sw', 'se'] as const"));
  assert.ok(canvas.includes("grip.dataset['resize'] = handle"));
  assert.ok(app.includes('[data-resize]'), 'nothing starts a resize');
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    assert.ok(
      css.includes(`.nz-resize__grip--${corner}`),
      `the ${corner} grip has no cursor of its own`,
    );
  }
  assert.ok(css.includes('nwse-resize') && css.includes('nesw-resize'));
});

test('N-WP10: a card can be resized from all four edges too', () => {
  assert.ok(canvas.includes("const EDGES = ['n', 's', 'w', 'e'] as const"));
  assert.ok(canvas.includes('const HANDLES = [...EDGES, ...CORNERS] as const'), 'not eight handles');
  assert.ok(canvas.includes('export function handleRect('), 'nothing places the handles');
  // An edge strip has to be thick enough to be a pointer target at all.
  const thickness = /const EDGE_GRIP = (\d+);/.exec(canvas);
  assert.ok(thickness !== null, 'the edge strips have no thickness');
  assert.ok(Number(thickness[1]) >= 8, 'an edge strip under 8 px is not a pointer target');
  for (const edge of ['n', 's', 'w', 'e']) {
    assert.ok(
      css.includes(`.nz-resize__grip--${edge},`) || css.includes(`.nz-resize__grip--${edge} {`),
      `the ${edge} edge has no cursor of its own`,
    );
  }
  assert.ok(css.includes('ns-resize') && css.includes('ew-resize'));
});

test('a grip is checked before the drag handle it lies on top of', () => {
  // Three of the eight sit inside the header, which is the card's drag handle,
  // and the rest sit over the tree or down its sides. Order in `pointerdown` is
  // what settles the gesture.
  const grip = app.indexOf("closest<SVGRectElement>('[data-resize]')");
  const drag = app.indexOf("closest<SVGRectElement>('[data-drag=\"card\"]')");
  assert.ok(grip > 0 && drag > 0, 'one of the two gestures is gone');
  assert.ok(grip < drag, 'the drag handle would swallow the top grips');
  // And in the DOM: the grips are the last children of the card.
  assert.ok(
    canvas.indexOf('      treeGroup,\n      resize,\n    );') > 0,
    'the grips are not the last children of the card group',
  );
  // Within the group a corner is painted after the two edges it overlaps, and
  // the last one painted is the one a press reaches.
  assert.ok(
    canvas.includes('const HANDLES = [...EDGES, ...CORNERS] as const'),
    'an edge would take a press meant for the corner sitting on it',
  );
});

test('a resize is a re-layout, not a scale', () => {
  // The width *is* the tree's wrapping budget. A transform would leave the tree
  // laid out for the old width and hanging out of the new one.
  assert.ok(canvas.includes('maxWidth: width === undefined ? TREE_MAX_WIDTH : width - CARD.pad * 2'));
  assert.ok(app.includes('layout = withWidth(layout, drag.id, box.width)'));
  // N-WP10: the geometry is one pure function, so the gesture holds no maths.
  assert.ok(app.includes('resizeCard(drag.handle, drag.start, dx, dy, drag.bounds)'));
  assert.ok(app.includes('minWidth: cardMinimumFor(session, metric.collapsed).width'));
  assert.ok(
    app.includes(
      'minHeight: isCornerHandle(handle) ? minCardHeight(CARD) : metric.box.contentHeight',
    ),
    'an edge drag could push the card under its own tree, or a corner could only grow',
  );
});

test('N-WP10: only the axis a handle drags is stored', () => {
  // Pinning the height on an east-edge drag would leave a card holding rows it
  // no longer needs the moment its tree unwraps.
  assert.ok(app.includes('if (changesWidth(drag.handle)) layout = withWidth('));
  assert.ok(app.includes('if (changesHeight(drag.handle)) layout = withHeight('));
  // A west or north pull holds the opposite edge still, which moves the card.
  assert.ok(app.includes('layout = withPosition(layout, drag.id, { x: box.x, y: box.y })'));
  // And a stored height is a floor under the tree's own, never a value over it.
  assert.ok(layoutSrc.includes('Math.max(contentHeight, Math.min(maxCardHeight(spec)'));
});

test('a card the user has sized says so, and can be reset without a pointer', () => {
  assert.ok(
    canvas.includes(
      "setClass(els.g, 'is-sized', metric.width !== undefined || metric.height !== undefined)",
    ),
  );
  assert.ok(css.includes('.nz-session.is-sized'), 'a sized card looks like every other one');
  assert.ok(css.includes('.nz-session.is-resizing'), 'a card being resized looks unchanged');
  assert.ok(app.includes('resetSize'), 'a size dragged by accident cannot be undone');
});

test('cleared subagents are offered back on the card itself', () => {
  assert.ok(canvas.includes("hiddenChip.g.dataset['action'] = 'restore'"));
  assert.ok(canvas.includes("hiddenChip.g.setAttribute('tabindex', '0')"), 'not reachable by key');
  assert.ok(app.includes("action === 'restore'"), 'the chip does nothing');
  assert.ok(css.includes('.nz-chip--hidden'), 'the chip is styled as nothing in particular');
  assert.ok(
    css.includes('.nz-chip--hidden:focus-visible .nz-chip__bg'),
    'a pressable chip with no focus ring',
  );
});

test('clearing hides and never deletes, and the history view never reads it', () => {
  // Three separate promises, each with one line that keeps it.
  assert.ok(app.includes('const shownSessions = ()'), 'the filter is gone');
  assert.ok(app.includes("if (isFrozen()) return { sessions: base, hidden: {} }"));
  assert.ok(
    app.includes("hideAgents(session, clearedFor(layout, session.id))"),
    'the cleared set is not applied where the cards are measured',
  );
});

test('a missing cost and context can carry its reason', () => {
  assert.ok(canvas.includes('session.captureBlockedBy'), 'the card never asks why');
  assert.ok(canvas.includes('captureBlockedLabel'));
  assert.ok(css.includes('.nz-session__blocked'), 'the reason is set but styled nowhere');
  // It takes the line the two numbers would have used, so no card changes size.
  assert.ok(canvas.includes("setAttr(blocked, 'y', 182)"));
  assert.ok(canvas.includes("setAttr(cost, 'y', 182)"));
});

test('every WP4f class the canvas sets has a rule that gives it a meaning', () => {
  for (const marker of [
    '.nz-resize__grip',
    '.nz-resize__grip--edge',
    '.nz-session.is-resizing',
    '.nz-session.is-sized',
    '.nz-chip--hidden',
    '.nz-session__blocked',
  ]) {
    assert.ok(css.includes(marker), `${marker} is set somewhere but styled nowhere`);
  }
});

/* ------------------------------------------------------------------ *
 * N-WP12: a lean drawer, and a gear that opens the settings
 *
 * The report was one sentence — *the left menu looks very cluttered, tidy it
 * up* — and every test here pins one half of the answer: what stayed in the
 * drawer, what moved behind the gear, and the two component rules that replaced
 * a column of buttons whose labels ended in `: on` and `: off`.
 * ------------------------------------------------------------------ */

const settingsSrc = readFileSync(path.join(webDir, 'settings.ts'), 'utf8');

/** One shipped catalogue, for the assertions that are about a sentence. */
function catalog(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(path.join(webDir, '..', 'locales', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}
const projectsSrc = readFileSync(path.join(webDir, 'projects.ts'), 'utf8');

/** The drawer's everyday view, from `#sidebar-main` to the settings panel. */
function drawerView(): string {
  return html.slice(html.indexOf('<div id="sidebar-main"'), html.indexOf('<div id="settings"'));
}

/** The settings panel, from its own element to the foot bar. */
function settingsView(): string {
  return html.slice(html.indexOf('<div id="settings"'), html.indexOf('<div class="nz-sidebar__foot">'));
}

/**
 * Every section heading in a slice of markup, in document order.
 *
 * N-WP13 emptied the elements and gave them a message key, so the assertion is
 * on the key rather than on the English word — which is the point: a heading
 * with a word still in it would fail the i18n sweep as well as this.
 */
function headings(slice: string): string[] {
  return [...slice.matchAll(/<h2 class="nz-sidebar__heading" data-nz-t="([\w.]+)"/g)].map(
    (one) => one[1]!,
  );
}

test('N-WP12: the drawer holds the three things you use while you work', () => {
  assert.deepEqual(
    headings(drawerView()),
    ['sidebar.sessions', 'sidebar.folderTabs', 'sidebar.view'],
    'the drawer grew a section again — a setting belongs behind the gear',
  );
  // And the order is the one use put them in: the sessions first, because that
  // is what the drawer is opened for.
  const view = drawerView();
  assert.ok(view.indexOf('id="sessions"') < view.indexOf('id="projects"'));
  assert.ok(view.indexOf('id="projects"') < view.indexOf('id="arrange"'));
  // The three keyboard shortcuts are unchanged and still shown where they act.
  assert.ok(view.includes('<kbd class="nz-kbd">h</kbd>'));
  assert.ok(view.includes('<kbd class="nz-kbd">a</kbd>'));
  assert.ok(view.includes('<kbd class="nz-kbd">0</kbd>'));
});

test('N-WP12: the gear and the version sit outside both scrolling areas', () => {
  const foot = html.slice(html.indexOf('<div class="nz-sidebar__foot">'), html.indexOf('</aside>'));
  assert.ok(foot.includes('id="settings-toggle"'), 'the gear is not in the foot bar');
  assert.ok(foot.includes('id="version"'), 'the version is not in the foot bar');
  assert.match(foot, /id="settings-toggle"[\s\S]{0,240}aria-controls="settings"/);
  assert.match(foot, /id="settings-toggle"[\s\S]{0,240}data-nz-label="settings.title"/);
  // A drawer whose only way out scrolls off the bottom is a drawer with a
  // trapdoor, so the foot is a flex row of its own and the views scroll inside.
  assert.ok(css.includes('.nz-sidebar__foot {'), '.nz-sidebar__foot is styled nowhere');
  assert.ok(css.includes('.nz-sidebar__scroll,'), 'the scrolling half has no rule');
  const drawer = css.slice(css.indexOf('.nz-sidebar {'), css.indexOf('.nz-sidebar[hidden]'));
  assert.match(drawer, /overflow: hidden/, 'the drawer itself must not be the scroller');
  assert.equal(drawerView().includes('id="settings-toggle"'), false);
});

test('N-WP12: the settings take the drawer\'s place instead of covering it', () => {
  // Inside the same `<aside>`, at the same width, with no overlay and no focus
  // trap: the canvas behind is a live picture of running work and it has to
  // stay visible while a colour is being chosen.
  const aside = html.slice(html.indexOf('<aside id="sidebar"'), html.indexOf('</aside>'));
  assert.ok(aside.includes('<div id="settings"'), 'the panel is not inside the drawer');
  assert.match(html, /id="settings"[^>]*hidden/, 'the panel would flash on load');
  assert.ok(css.includes('.nz-settings[hidden]'), 'a hidden panel would still be laid out');
  for (const forbidden of ['nz-backdrop', 'nz-overlay', 'nz-modal']) {
    assert.equal(css.includes(forbidden), false, `${forbidden} — the panel is not a modal`);
  }
  // The two views are always opposites, which is what makes "neither" and
  // "both" unreachable states rather than bugs waiting to be found.
  assert.match(settingsSrc, /this\.options\.panel\.hidden = !open;/);
  assert.match(settingsSrc, /this\.options\.main\.hidden = open;/);
  assert.match(settingsSrc, /gear\.setAttribute\('aria-expanded'/);
});

test('N-WP12: the panel carries every setting that left the drawer', () => {
  assert.deepEqual(headings(settingsView()), [
    'settings.appearance',
    'settings.behaviour',
    'settings.language',
    'usage.title',
    'settings.about',
  ]);
  const panelMarkup = settingsView();
  for (const id of [
    'theme-toggle',
    'palette',
    'colours',
    'shell-group',
    'autostart-toggle',
    'auto-tabs',
    'demo-toggle',
    'quota-source',
  ]) {
    assert.ok(panelMarkup.includes(`id="${id}"`), `#${id} is not in the settings panel`);
    assert.ok(app.includes(`'${id}'`) || projectsSrc.includes(`'${id}'`), `#${id} is unwired`);
  }
  // N-WP13 filled the Language section and unhid it.
  assert.ok(panelMarkup.includes('id="language"'));
  assert.equal(/id="language-group"[^>]*hidden/.test(html), false);
  // The three-line paragraph that explained contrast ratios is one line now.
  assert.ok(panelMarkup.includes('data-nz-t="settings.coloursNote"'));
  assert.match(catalog('en')['settings.coloursNote']!, /Below 3:1 contrast/);
});

test('N-WP13b: the language picker is handed a language and stores a language', () => {
  /*
   * `web/lang.ts` draws the six options; this is the half in `app.ts` — what
   * the picker is handed, and what a click does with it. Every click now means
   * the same thing, which is why no branch is left in the callback: a language,
   * stored, painted, and the page written again in it.
   */
  assert.match(app, /let localeChoice: Locale = resolveLocale\(/);
  assert.match(app, /fillLanguagePicker\(languageRoot, \(locale\) => \{/);
  assert.match(app, /writeLocaleChoice\(localeStorage, locale\);/);
  // Nothing stored still resolves through the machine's list, so the option the
  // picker ticks on a first run is the language the machine asked for.
  assert.match(app, /readLocaleChoice\(localeStorage\),\s*machineLanguages,/);
  // And the choice is never compared against a word that is not a language.
  assert.equal(app.includes("localeChoice === 'system'"), false);
  assert.equal(/\bLocaleChoice\b/.test(app), false, 'the seventh choice still has a type');
  // Light/dark keeps its own *system*: a different setting, and it stays.
  assert.ok(app.includes("{ value: 'system', key: 'settings.mode.system' }"));
});

test('N-WP12: Escape closes the panel before it closes the drawer', () => {
  // Registered in the *capture* phase on the drawer, so it runs before the
  // drawer's own Escape handler whichever was constructed first — and stops the
  // event only when it actually closed something.
  assert.match(settingsSrc, /\{ capture: true \}/);
  assert.match(settingsSrc, /if \(event\.key !== 'Escape' \|\| !this\.open\) return;/);
  assert.match(settingsSrc, /event\.stopPropagation\(\);/);
  // And from the canvas, where the keystroke reaches the window instead.
  assert.match(app, /if \(settings\.isOpen\) \{[\s\S]{0,80}settings\.set\(false, true\);/);
  assert.ok(
    app.indexOf('if (settings.isOpen)') < app.indexOf('if (sidebar.isOpen) sidebar.set(false'),
    'Escape would close the whole drawer while the panel was open',
  );
});

test('N-WP12: a setting is a switch or a segment, never a label ending in ": off"', () => {
  // Three switches: two written in the page, one built by the folder-tab panel.
  for (const id of ['autostart-toggle', 'demo-toggle']) {
    const at = html.indexOf(`id="${id}"`);
    const control = html.slice(at, at + 220);
    assert.match(control, /role="switch"/, `#${id} is not announced as a switch`);
    assert.match(control, /aria-checked="false"/, `#${id} does not announce its state`);
  }
  assert.match(projectsSrc, /createSwitch\(t\('settings.autoTabs'\)\)/);
  assert.match(projectsSrc, /getAttribute\('aria-checked'\)/);
  assert.match(settingsSrc, /button\.setAttribute\('role', 'switch'\)/);
  // A `<button>` carries Space and Enter for free, which is the keyboard half.
  assert.match(settingsSrc, /const button = html\('button', 'nz-switch'\);/);
  // Nothing left says its state in its own label.
  for (const gone of ['demo data: ', 'start with ${machine}: ', 'light or dark: ']) {
    assert.equal(app.includes(gone), false, `"${gone}" is still a label carrying a state`);
  }
  assert.equal(projectsSrc.includes('auto-create projects for new folders: '), false);
});

test('N-WP12: light and dark are three visible choices rather than a cycle', () => {
  assert.match(app, /const THEME_CHOICE_KEYS/);
  assert.match(app, /fillSegment\(themeGroup, themeChoices\(\)/);
  assert.match(html, /id="theme-toggle"[\s\S]{0,160}role="group"/);
  // The cycling branch is gone: it took two presses to reach the third state
  // and could not show the two you were not in.
  assert.equal(app.includes("theme === 'system' ? 'dark' :"), false);
  assert.ok(css.includes('.nz-segment__option.is-current'));
});

test('N-WP12: the panel changed no schema and remembers nothing of its own', () => {
  // Every other mode in this page is remembered. This one is not, and that is
  // the reason the package added no storage key at all.
  assert.equal(settingsSrc.includes('localStorage'), false, 'the panel invented a storage key');
  assert.equal(settingsSrc.includes('nazar.'), false);
  for (const key of ['nazar.layout.v1', 'nazar.tabs.v1', 'nazar.colours.v1', 'nazar.usage.v1']) {
    assert.equal(app.includes(`${key}.v2`), false, `${key} was versioned by a tidy-up`);
  }
  // Shutting the drawer resets it to the menu, so reopening it for a session
  // never lands on a colour picker.
  assert.match(app, /if \(!open\) settings\.set\(false, false\);/);
});

test('N-WP12: every class the drawer and the panel set has a rule', () => {
  for (const marker of [
    '.nz-sidebar__foot',
    '.nz-sidebar__version',
    '.nz-gear',
    ".nz-gear[aria-expanded='true']",
    '.nz-settings__head',
    '.nz-settings__back',
    '.nz-settings__title',
    '.nz-settings__subheading',
    '.nz-settings__slot',
    '.nz-segment',
    '.nz-segment__option',
    '.nz-switch',
    '.nz-switch__label',
    '.nz-switch__track',
    ".nz-switch[aria-checked='true'] .nz-switch__track",
    '.nz-language__option',
  ]) {
    assert.ok(css.includes(marker), `${marker} is set somewhere but styled nowhere`);
  }
  // The switch has to survive a palette change, so not one of its colours is
  // written as a literal.
  const switchRules = css.slice(css.indexOf('.nz-switch {'), css.indexOf('.nz-language {'));
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(switchRules), false, 'a switch colour is hard-coded');
  assert.equal(/\brgba?\(/.test(switchRules), false, 'a switch colour is hard-coded');
});
