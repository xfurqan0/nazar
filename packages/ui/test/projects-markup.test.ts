/**
 * WP4g's half that lives in markup, CSS and wiring rather than in a function,
 * plus the leak gate.
 *
 * Node has no DOM, so this is not a rendering test: it is a contract test
 * between the files that have to agree — `index.html` carries the controls,
 * `styles.css` is the only place that gives their class names a meaning, and
 * the three page modules are the only places that attach behaviour. It also
 * carries the one assertion that is about *privacy* rather than about pixels,
 * and that one is enforced on both sides of the wire.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeDemoState } from '../src/demo.ts';
import { ancestorPaths, folderName, pathIsInside } from '../src/projects.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const srcDir = path.join(here, '..', 'src');
const serverDir = path.join(here, '..', '..', 'server', 'src');

const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');
const css = readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
const canvas = readFileSync(path.join(webDir, 'canvas.ts'), 'utf8');
const tabbar = readFileSync(path.join(webDir, 'tabbar.ts'), 'utf8');
const panel = readFileSync(path.join(webDir, 'projects.ts'), 'utf8');
const projects = readFileSync(path.join(srcDir, 'projects.ts'), 'utf8');
const snapshot = readFileSync(path.join(serverDir, 'snapshot.ts'), 'utf8');

test('the page carries the three controls WP4g and N-WP11 wire up', () => {
  for (const id of ['projects', 'sessions', 'rename']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
    assert.ok(app.includes(`'${id}'`), `#${id} is in the page but nothing looks it up`);
  }
  // N-WP11 renamed the section, because "project" was a word for a thing the
  // user never made — a folder tab is what it always was.
  // N-WP13 emptied the headings and gave them keys; the words are in the six
  // catalogues, and `i18n.test.ts` is what checks they are all there.
  assert.ok(html.includes('data-nz-t="sidebar.folderTabs"'));
  assert.ok(html.includes('data-nz-t="sidebar.sessions"'));
});

test('N-WP11: nothing in the sidebar asks for a path to be typed', () => {
  // The whole of the maintainer's complaint, as a gate. A field that takes a
  // folder path can be filled in a way no card ever writes and then own nothing
  // for ever; the list of sessions cannot, because the folder is already there.
  assert.doesNotMatch(panel, /new project…|rootProblem/);
  assert.doesNotMatch(panel, /nz-projects__form|nz-projects__actions|nz-projects__hint/);
  // The one input left in this panel is the rename editor, which types a name
  // and never a path.
  assert.ok(panel.includes("field.setAttribute('aria-label', t('sidebar.folderTabName'))"));
  assert.doesNotMatch(html, /id="projects"[\s\S]{0,400}<input/);
  // And the empty state points at the gesture that replaced the form.
  assert.ok(panel.includes("t('sidebar.noFolderTabs')"));
});

test('N-WP11: a session row carries the action, and a keyboard can reach it', () => {
  // A real button, so it is in the drawer's tab order and Enter runs it — the
  // row is not a click handler on a `<span>`.
  assert.ok(panel.includes("const action = html('button', 'nz-sessions__open')"));
  assert.ok(panel.includes("action.type = 'button'"));
  assert.ok(panel.includes("const label = t('sidebar.openTabFor', { name: session.folderName })"));
  assert.ok(panel.includes("const label = t('menu.goToTab', { name: tab.name })"));
  assert.ok(panel.includes("action.setAttribute('aria-label', label)"));
  // Right-click on the row goes to the card's own menu, which is the only place
  // the folders further up the tree are offered.
  assert.ok(panel.includes("item.addEventListener('contextmenu'"));
  assert.ok(app.includes('openCardMenu(sessionId, at);'), 'and the row opens the card menu');
});

test('N-WP11: the folder a row acts on is the one it is showing', () => {
  // The button hands `session.folder` back — the redacted path drawn on the row
  // — and never a string the page built for the occasion.
  assert.ok(panel.includes('this.options.onOpenFolder(session.id, session.folder)'));
  // A session with no working directory gets no button rather than a dead one.
  assert.ok(panel.includes('if (session.folder.length > 0) {'));
});

test('the name editor is a real labelled input that cannot grow unbounded', () => {
  assert.match(html, /id="rename"[\s\S]{0,200}data-nz-label="card.nameField"/);
  assert.match(html, /id="rename"[\s\S]{0,200}maxlength="48"/);
  assert.match(html, /id="rename"[\s\S]{0,200}hidden/);
});

test('the title strip is a keyboard-reachable control, not a bare click handler', () => {
  // Without these three lines the only way to name a card is a mouse.
  assert.ok(canvas.includes("nameHit.dataset['action'] = 'rename'"));
  assert.ok(canvas.includes("nameHit.setAttribute('role', 'button')"));
  assert.ok(canvas.includes("nameHit.setAttribute('tabindex', '0')"));
  assert.ok(canvas.includes("els.nameHit.setAttribute(\n      'aria-label',"), 'and it says what it does');
  // `runCardAction` is the one path both a click and Enter/Space arrive on.
  assert.ok(app.includes("else if (action === 'rename') beginRename(sessionId)"));
  // Escape cancels, Enter commits, blur commits: the three the maintainer asked for.
  assert.ok(app.includes("if (event.key === 'Enter') endRename(true)"));
  assert.ok(app.includes("else if (event.key === 'Escape') endRename(false)"));
  assert.ok(app.includes("renameField.addEventListener('blur', () => endRename(true))"));
});

test('a folder tab is marked as one, and says what makes it fill', () => {
  assert.ok(tabbar.includes("setClass(button, 'is-project', true)"));
  assert.ok(tabbar.includes('button.append(folderIcon())'));
  assert.ok(tabbar.includes("t('tab.folderTab', { folder: tab.root })"));
  assert.ok(tabbar.includes("icon.setAttribute('aria-hidden', 'true')"), 'the icon is decoration');
  // The remove control has to say that a folder is not being deleted.
  assert.ok(tabbar.includes("t(tab.kind === 'project' ? 'tab.closeFolder' : 'tab.close'"));
});

test('every class WP4g and N-WP11 write has a rule that gives it meaning', () => {
  for (const name of [
    'nz-session__namehit',
    'nz-rename',
    'nz-tab__folder',
    'nz-menu__note',
    'nz-menu__hint',
    'nz-menu__item--folder',
    'nz-projects__list',
    'nz-projects__item',
    'nz-projects__name',
    'nz-projects__counts',
    'nz-projects__remove',
    'nz-projects__field',
    'nz-sessions__list',
    'nz-sessions__item',
    'nz-sessions__text',
    'nz-sessions__name',
    'nz-sessions__folder',
    'nz-sessions__open',
    'nz-history__slug',
  ]) {
    assert.ok(css.includes(`.${name}`), `${name} is written but the stylesheet never answers`);
  }
});

test('the sidebar never prints a number nobody measured', () => {
  // `undefined` past count means "the transcript store has not been read", and
  // it renders as an em dash. A `0` there would be a measurement nobody made.
  assert.ok(panel.includes("project.past === undefined ? '—' : project.past"));
  assert.ok(panel.includes("t('sidebar.pastUncounted')"));
});

/* ------------------------------------------------------------------ *
 * The leak gate
 * ------------------------------------------------------------------ */

/**
 * The decision this work package had to make, asserted rather than described.
 *
 * `toWireSession` sends `cwd` through `redact()` — the home directory collapsed
 * to `~`, credential-shaped runs masked, the result cut to 80 characters — and
 * that is the *only* path-shaped string the browser has. Projects were built on
 * it rather than on a new field, so the guarantee is structural: every string a
 * project puts on screen is a substring of one the card was already drawing.
 *
 * These two tests are what keeps that true. The first says the server did not
 * grow a second path field to make matching easier; the second says everything
 * the browser derives is cut from the redacted one.
 */
test('no full working directory was added to the wire for projects', () => {
  assert.ok(
    snapshot.includes('out.cwd = redact(session.cwd, options)'),
    'the only cwd on the wire is still the redacted one',
  );
  assert.doesNotMatch(
    snapshot,
    /cwdKey|cwdFull|rawCwd|realCwd|cwdHash/,
    'projects match on the redacted path; a second path-shaped field would be a new disclosure',
  );
  // And the browser never asks for one either.
  assert.doesNotMatch(app, /session\.cwdKey|cwdFull|rawCwd/);
});

test('every string a project shows is already on the card', () => {
  // The demo canvas is the same shape as a real one: sessions with a `cwd` the
  // wire has already redacted. Whatever the project UI derives from one — the
  // dropdown of ancestors, the tab title, the sidebar label, the tooltip — has
  // to be a substring of that `cwd`, because a substring cannot carry a
  // character the page was not already drawing.
  const state = makeDemoState({ now: Date.parse('2026-09-08T12:00:00Z') });
  assert.ok(state.sessions.length > 0);

  for (const session of state.sessions) {
    const cwd = session.cwd;
    if (cwd === undefined) continue;
    const shown: string[] = [];
    for (const folder of ancestorPaths(cwd)) {
      shown.push(folder, folderName(folder));
      assert.equal(pathIsInside(folder, cwd), true, 'an offered ancestor really contains the cwd');
    }
    for (const value of shown) {
      assert.ok(
        cwd.includes(value),
        `"${value}" is not a substring of the redacted cwd "${cwd}" the card already draws`,
      );
    }
  }
});

test('the module that compares paths never reads a disk and never expands a home', () => {
  // A project rule that stat-ed directories would be a monitoring tool that had
  // quietly become something else; one that expanded `~` would need the server
  // to send the user name back, which is the redaction that matters most.
  assert.doesNotMatch(
    projects,
    /^\s*import\s/m,
    'the rule imports nothing at all: it is string comparison and it stays that way',
  );
  assert.doesNotMatch(projects, /readFileSync|existsSync|homedir\(|process\.env/);
  assert.doesNotMatch(app, /homedir/);
});
