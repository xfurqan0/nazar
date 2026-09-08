/**
 * WP4g: the project rule, as a table.
 *
 * Every property this module claims is a property somebody will trip over on a
 * machine that is not the one it was written on — a Windows path typed with
 * forward slashes, a POSIX directory that differs from its neighbour only in
 * case, a nested repository, a `cwd` the wire truncated. So the rules are
 * asserted one row at a time rather than through the tab model, and each row
 * says which of them it is defending.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  ancestorPaths,
  cleanPath,
  deepestMatch,
  folderName,
  folderTabName,
  historyProjectMatches,
  isAbsolutePath,
  isWindowsPath,
  MAX_ROOT_LENGTH,
  pathIsInside,
  pathKey,
  projectSlugish,
  rootProblem,
} from '../src/projects.ts';

const WIN = 'C:\\proj\\app';
const POSIX = '/home/you/app';

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

test('a folder owns itself and everything under it, on either separator', () => {
  const rows: ReadonlyArray<readonly [string, string, boolean, string]> = [
    [WIN, 'C:\\proj\\app', true, 'the folder itself'],
    [WIN, 'C:\\proj\\app\\src', true, 'a child'],
    [WIN, 'C:\\proj\\app\\src\\deep\\down', true, 'a grandchild'],
    [WIN, 'C:/proj/app/src', true, 'a child written with the other separator'],
    [WIN, 'C:\\proj\\app\\', true, 'a trailing separator is not a different folder'],
    [WIN, 'C:\\proj\\application', false, 'a longer sibling is not a child'],
    [WIN, 'C:\\proj', false, 'the parent is not inside the child'],
    [WIN, 'D:\\proj\\app', false, 'another drive'],
    [POSIX, '/home/you/app', true, 'the folder itself, POSIX'],
    [POSIX, '/home/you/app/src', true, 'a child, POSIX'],
    [POSIX, '/home/you/apples', false, 'a longer sibling, POSIX'],
    ['~/app', '~/app/src', true, 'the home form the cards write'],
    ['~/app', '~\\app\\src', true, 'and the same one with backslashes'],
    ['~/app', '/home/you/app/src', false, 'an expanded home is a different string'],
    ['/', '/anything', true, 'the POSIX root contains everything'],
    ['C:\\', 'C:\\proj', true, 'and so does a drive root'],
  ];
  for (const [root, cwd, want, why] of rows) {
    assert.equal(pathIsInside(root, cwd), want, `${root} ∋ ${cwd}: ${why}`);
  }
});

test('case folds on Windows and does not on POSIX', () => {
  assert.equal(pathIsInside('c:\\proj\\app', 'C:\\PROJ\\App\\src'), true);
  assert.equal(pathIsInside('C:/proj/app', 'c:\\proj\\APP'), true, 'either side may be the Windows-looking one');
  // Two directories that really are two directories.
  assert.equal(pathIsInside('/home/you/App', '/home/you/app/src'), false);
  assert.equal(pathIsInside('/home/you/app', '/home/you/app/SRC'), true, 'only the root has to match');
});

test('a truncated working directory still lands on its project', () => {
  // `redact()` cuts a path at 80 characters and marks it with an ellipsis. The
  // head survives, so a project shorter than the cut still owns the session.
  const deep = `${WIN}\\${'segment\\'.repeat(12)}`;
  const truncated = `${deep.slice(0, 80)}…`;
  assert.equal(pathIsInside(WIN, truncated), true);
  assert.equal(pathIsInside('C:\\other', truncated), false);
});

test('a session with no working directory is on no project', () => {
  assert.equal(pathIsInside(WIN, undefined), false);
  assert.equal(pathIsInside('', 'C:\\proj\\app'), false, 'and an empty root owns nothing');
});

test('the deepest project wins, whatever order they were made in', () => {
  const projects = [
    { id: 'outer', root: 'C:/proj' },
    { id: 'inner', root: 'C:/proj/app' },
    { id: 'other', root: 'D:/x' },
  ];
  assert.equal(deepestMatch(projects, 'C:/proj/app/src')?.id, 'inner');
  assert.equal(deepestMatch([...projects].reverse(), 'C:/proj/app/src')?.id, 'inner');
  assert.equal(deepestMatch(projects, 'C:/proj/other')?.id, 'outer');
  assert.equal(deepestMatch(projects, 'E:/nowhere'), undefined);
  assert.equal(deepestMatch(projects, undefined), undefined);
});

/* ------------------------------------------------------------------ *
 * The strings themselves
 * ------------------------------------------------------------------ */

test('cleanPath tidies without changing which folder is meant', () => {
  assert.equal(cleanPath('  C:\\proj\\app  '), 'C:\\proj\\app');
  assert.equal(cleanPath('"C:\\proj\\app"'), 'C:\\proj\\app', 'a drag from a file manager brings quotes');
  assert.equal(cleanPath('C:\\proj\\\\app\\'), 'C:\\proj\\app');
  assert.equal(cleanPath('C:\\'), 'C:\\', 'a drive root keeps its separator');
  assert.equal(cleanPath('/'), '/', 'and so does the POSIX root');
  assert.equal(cleanPath('\\\\server\\share\\app'), '\\\\server\\share\\app', 'a UNC head survives');
  assert.equal(cleanPath('x'.repeat(400)).length, MAX_ROOT_LENGTH);
});

test('folderName is the last segment, whatever the separator', () => {
  assert.equal(folderName(WIN), 'app');
  assert.equal(folderName('C:/proj/app/'), 'app');
  assert.equal(folderName(POSIX), 'app');
  assert.equal(folderName('~'), '~');
  assert.equal(folderName(''), '');
});

test('ancestorPaths offers every folder up to but not including the root', () => {
  assert.deepEqual(ancestorPaths('C:\\proj\\app\\src'), [
    'C:\\proj\\app\\src',
    'C:\\proj\\app',
    'C:\\proj',
  ]);
  assert.deepEqual(ancestorPaths('/home/you/app'), ['/home/you/app', '/home/you', '/home']);
  assert.deepEqual(ancestorPaths('~/proj/app'), ['~/proj/app', '~/proj']);
  // A `cwd` that is a root has nothing above it, so it offers itself.
  assert.deepEqual(ancestorPaths('C:\\'), ['C:\\']);
  assert.deepEqual(ancestorPaths(''), []);
  // The separator style is the one the path came in with, so what the menu
  // shows matches what the card shows.
  assert.deepEqual(ancestorPaths('C:/proj/app'), ['C:/proj/app', 'C:/proj']);
});

/* ------------------------------------------------------------------ *
 * N-WP11: what the tab is called
 * ------------------------------------------------------------------ */

test('a folder tab is called after its folder, and is not asked about', () => {
  assert.equal(folderTabName(WIN, []), 'app');
  assert.equal(folderTabName('C:/proj/app/', []), 'app');
  assert.equal(folderTabName(POSIX, ['All']), 'app');
  assert.equal(folderTabName('~/proj/app', ['All', 'nazar']), 'app');
});

test('two folders ending in the same word are told apart by their parent', () => {
  // The case the maintainer will hit on any machine with a service layout:
  // `srv/api` and `web/api` are two folders and must be two readable tabs.
  assert.equal(folderTabName('C:\\srv\\api', ['All', 'api']), 'api · srv');
  assert.equal(folderTabName('/home/you/web/api', ['All', 'api']), 'api · web');
  // A third one goes on up the tree rather than inventing a number.
  assert.equal(
    folderTabName('C:\\one\\srv\\api', ['All', 'api', 'api · srv']),
    'api · srv · one',
  );
});

test('the collision test ignores case, because two such tabs are one tab to read', () => {
  assert.equal(folderTabName('C:\\srv\\api', ['All', 'API']), 'api · srv');
  assert.equal(folderTabName('C:\\srv\\api', ['All', ' api ']), 'api · srv');
});

test('a name that has run out of ancestors falls back to a number', () => {
  // Only reachable with two identically-named roots, which is why it is ugly
  // and unambiguous rather than clever.
  assert.equal(folderTabName('C:\\app', ['All', 'app']), 'app 2');
  assert.equal(folderTabName('C:\\app', ['All', 'app', 'app 2']), 'app 3');
});

test('a path with no folder in it names nothing', () => {
  assert.equal(folderTabName('', []), '');
});

test('isWindowsPath and isAbsolutePath know the four shapes there are', () => {
  assert.equal(isWindowsPath(WIN), true);
  assert.equal(isWindowsPath('C:/proj'), true);
  assert.equal(isWindowsPath(POSIX), false);
  assert.equal(isWindowsPath('~/app'), false);

  for (const good of [WIN, 'C:/proj', POSIX, '~', '~/app', '~\\app', '\\\\server\\share']) {
    assert.equal(isAbsolutePath(good), true, `${good} is a rooted path`);
  }
  for (const bad of ['app', './app', '../app', '', '   ', 'C:app']) {
    assert.equal(isAbsolutePath(bad), false, `${bad} is not`);
  }
});

test('rootProblem explains a bad path and stays quiet about a good one', () => {
  assert.equal(rootProblem(WIN), undefined);
  assert.equal(rootProblem('~/app'), undefined);
  assert.match(rootProblem('') ?? '', /folder path/);
  assert.match(rootProblem('app') ?? '', /whole folder path/);
  assert.match(rootProblem(`C:\\${'x'.repeat(400)}`) ?? '', /under 200/);
});

test('pathKey folds only what the platform folds', () => {
  assert.equal(pathKey('C:\\Proj\\App\\', true), 'c:/proj/app');
  assert.equal(pathKey('/home/You/App', false), '/home/You/App');
});

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

test('a folder maps to the transcript-store directory Claude Code names it', () => {
  // The four the demo history ships, which are the shapes a real store has.
  assert.equal(projectSlugish('C:/proj/nazar'), 'C--proj-nazar');
  assert.equal(projectSlugish('C:\\proj\\nazar-tray'), 'C--proj-nazar-tray');
  assert.equal(projectSlugish('~\\AppData\\Local\\Temp\\nazar-smoke'), '~/AppData-Local-Temp-nazar-smoke');
  assert.equal(projectSlugish('~'), '~');
});

/**
 * The reason history matches exactly and never by prefix.
 *
 * A slug turned every separator into a dash and cannot turn them back:
 * `C--proj-nazar-tray` is `C:\proj\nazar-tray`, a *sibling* of `C:\proj\nazar`,
 * and a prefix rule would file its sessions under the wrong project. So a
 * nested project's past sessions stay under their own heading, which is the
 * conservative half of the trade and the only one that cannot be wrong.
 */
test('history is matched by exact slug, never by prefix', () => {
  assert.equal(historyProjectMatches('C:/proj/nazar', 'C--proj-nazar'), true);
  assert.equal(historyProjectMatches('C:/proj/nazar', 'C--proj-nazar-tray'), false);
  assert.equal(historyProjectMatches('C:/proj/nazar', 'C--proj-nazar-src'), false);
  assert.equal(historyProjectMatches('C:/proj', 'C--proj-nazar'), false, 'nesting is not claimed');
  assert.equal(historyProjectMatches('c:\\proj\\nazar', 'C--proj-nazar'), true, 'case folds');
  assert.equal(historyProjectMatches('', 'C--proj-nazar'), false);
});
