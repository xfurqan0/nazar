/**
 * The parts of the history panel that live in markup and CSS rather than in a
 * function, and would otherwise be tested by nobody.
 *
 * Node has no DOM, so this is not a rendering test: it is a contract test
 * between three files that have to agree. `canvas.ts` writes the class names
 * and `data-state` values, `styles.css` is the only place that gives them a
 * meaning, and `index.html` carries the controls the panel attaches to. Delete
 * a rule or rename a control and the canvas silently loses its faded `done`
 * agents or its keyboard entry point; this fails instead.
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
const canvas = readFileSync(path.join(webDir, 'canvas.ts'), 'utf8');
const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
const panel = readFileSync(path.join(webDir, 'history.ts'), 'utf8');

test('the page carries the controls the history panel attaches to', () => {
  for (const id of ['history', 'history-toggle', 'frozen-bar', 'frozen-text', 'frozen-back']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
  }
});

test('the history toggle is announced as the control it is', () => {
  // A button that opens a region has to say so, or a screen reader announces a
  // word with no relationship to what appeared.
  assert.match(html, /id="history-toggle"[\s\S]{0,220}aria-expanded="false"/);
  assert.match(html, /id="history-toggle"[\s\S]{0,220}aria-controls="history"/);
  assert.ok(html.includes('<aside id="history"'), 'the drawer is an aside, not a div');
  assert.ok(html.includes('type="button"'), 'buttons declare their type so none submits a form');
});

test('the panel builds real buttons in a real list, and gives focus back', () => {
  // Rows are `<button>` inside `<li>`: tabbable, activatable with Enter and
  // Space, and announced as a list. A div with a click handler is none of that.
  assert.ok(panel.includes("html('button', 'nz-hrow')"));
  assert.ok(panel.includes("html('ul', 'nz-history__rows')"));
  assert.ok(panel.includes("html('li')"));
  assert.ok(panel.includes("button.type = 'button'"));
  // Each row's accessible name says which session and which project, because
  // "2026-09-06 19:46" read aloud on its own identifies nothing.
  assert.match(panel, /button\.setAttribute\(\s*'aria-label',/);
  assert.ok(panel.includes("t('history.openLabel'"));
  assert.ok(panel.includes("this.opener?.focus()"), 'closing must return focus to the opener');
  assert.ok(panel.includes("event.key !== 'Escape'"), 'Escape closes the drawer');
  assert.ok(panel.includes("this.root.setAttribute('role', 'region')"));
});

test('every state the renderer sets has a rule that gives it meaning', () => {
  // The renderer writes these; if the stylesheet does not answer, a `done`
  // agent looks exactly like a running one and the whole package is invisible.
  for (const marker of [
    '.nz-agent.is-done',
    ".nz-agent__dot[data-state='done']",
    // The folded tree's summary row still has one: `60 subagents · 22 done`
    // stands in for sixty nodes, which is a set and not a reading.
    '.nz-chip--done',
    ".nz-ring[data-state='frozen']",
    '.nz-session.is-frozen .nz-ring__pulse',
    '.nz-history',
    '.nz-hrow',
    '.nz-frozen-bar',
  ]) {
    assert.ok(css.includes(marker), `${marker} is set somewhere but styled nowhere`);
  }

  // WP4d: `is-done` is now one of five activity classes, and the renderer sets
  // all five through one helper so exactly one is ever on. The class the
  // stylesheet answers is unchanged; only who writes it moved.
  assert.ok(canvas.includes('setActivityClass(agentEls.g, activity)'));
  assert.ok(canvas.includes('setClass(node, activityClass(one), one === activity)'));
  assert.ok(canvas.includes("setClass(els.g, 'is-frozen', frozen)"));
  assert.ok(canvas.includes("'data-state', frozen ? 'frozen'"));
  /*
   * N-WP15: `done · 12m 03s` is text on the node's third line rather than a
   * chip on a line of its own. The sentence is the same one WP4b wrote and it
   * is still the only place a finished subagent says so in words — which is
   * exactly why it had to survive the node losing three of its six lines.
   */
  assert.ok(canvas.includes("t('agent.done', { duration })"), 'the done reading is gone');
  assert.equal(
    canvas.includes("makeChip(chipRow, 'done')"),
    false,
    'the subagent node is wearing a pill again',
  );
});

test('a frozen canvas does not animate and does not count', () => {
  // The pulse is the one moving thing on the canvas, and a session that ended
  // has nothing to pulse about.
  const frozenBlock = css.slice(css.indexOf('.nz-session.is-frozen .nz-ring__pulse'));
  assert.match(frozenBlock.slice(0, 120), /animation:\s*none/);

  // Nor does a frozen card's own frame move: `activityOf` answers `done` for
  // every node in history, and the stylesheet blocks the animation a second
  // time in case someone ever changes that.
  const frozenFrame = css.slice(css.indexOf('.nz-session.is-frozen .nz-session__bg,'));
  assert.match(frozenFrame.slice(0, 160), /animation:\s*none/);

  // And nothing treats a frozen session as waiting for anything: the activity
  // of a frozen node is `done`, which is not `waiting`.
  assert.ok(canvas.includes('const activity = sessionActivity(session, now, frozen)'));
  assert.ok(canvas.includes("const waiting = activity === 'waiting'"));
  assert.ok(app.includes('const waiting = frozen ? [] :'));

  // A frozen tree is a read of the past: it is not draggable and belongs to no
  // tab, so neither WP4c control is drawn on it.
  assert.ok(canvas.includes("setAttr(els.menu, 'display', frozen ? 'none' : 'inline')"));
  assert.ok(canvas.includes("setAttr(els.handle, 'display', frozen ? 'none' : 'inline')"));
});

test('reduced motion is still honoured, so the pulse rule is not the only guard', () => {
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
});
