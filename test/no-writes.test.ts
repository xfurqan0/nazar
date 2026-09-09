/**
 * "Nazar writes nothing, anywhere" is the promise the whole design rests on:
 * no hooks, no settings change, no state directory, no copy of a transcript.
 * A promise that only lives in a README rots, so this is the gate.
 *
 * It reads the shipped sources — the three packages plus the launcher, and not
 * the build tooling, which of course writes — and asserts three things:
 *
 * 1. Every binding imported from `node:fs` or `node:fs/promises` is on a
 *    read-only allow-list. A write cannot happen without one of them.
 * 2. The one call that opens a file handle passes the `'r'` flag, because
 *    `open()` is the only allowed name that could still write.
 * 3. Claude Code's settings are named in exactly one place and only ever read.
 *    **WP4f narrowed this rule rather than dropping it.** v1 named
 *    `settings.json` nowhere at all; then live use turned up a project-level
 *    `statusLine` that replaces the user-level status-line wrapper, which is
 *    the reason cost and context vanish from some cards and not others — and
 *    that is only diagnosable by reading `<cwd>/.claude/settings.json`. So one
 *    reader may name it.
 *
 *    **N-WP9 narrowed it a second time, and this one deserves the longer
 *    note**, because the earlier version of this file said the user-level
 *    file was untouchable and meant two different things by it. `nazar doctor`
 *    could name a project's own status line as the reason a session had no
 *    capture, and could not name the three commoner reasons — the wrapper was
 *    never installed, something replaced it, or the session predates it — all
 *    of which are answered by `~/.claude/settings.json` and none of which is
 *    answerable without it. So the same reader now opens that file too, for
 *    the same one key, and the rule it is held to is the one that was always
 *    the point: **it may be read and it may not be written.** Precision mode
 *    (v1.1, WP7) is still the only thing that will ever *change* it, with a
 *    backup, a shown diff and an exact uninstall — and every test below still
 *    proves no shipped source can write anything, anywhere.
 *
 * A static gate, not a runtime one, which is the point: a runtime test proves
 * that one code path did not write, and this proves that none of them can.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** Everything that ends up in the published tarball, by way of the bundler. */
const SHIPPED = [
  'packages/core/src',
  'packages/server/src',
  'packages/ui/src',
  'packages/ui/web',
  'bin',
];

/**
 * Names from `node:fs` and `node:fs/promises` that cannot modify anything.
 * `open` is here because the tailer needs a handle to read a file by offset;
 * the flag it passes is asserted separately below.
 */
const READ_ONLY_FS = new Set([
  'constants',
  'createReadStream',
  'existsSync',
  'lstat',
  'open',
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'realpath',
  'stat',
  'statSync',
  'watch',
  'FSWatcher',
]);

interface SourceFile {
  readonly name: string;
  readonly text: string;
}

function sources(): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        found.push({
          name: path.relative(root, full).split(path.sep).join('/'),
          text: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  for (const dir of SHIPPED) {
    const full = path.join(root, dir);
    if (existsSync(full)) walk(full);
  }
  return found;
}

/** Named bindings of every `node:fs*` import in a source file. */
export function fsBindings(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/)[0]?.trim();
      if (name !== undefined && name.length > 0) names.push(name);
    }
  }
  return names;
}

const files = sources();

test('there are shipped sources to check', () => {
  assert.ok(files.length > 10, `only ${files.length} sources found; the walk is wrong`);
});

test('every filesystem binding in shipped code is read-only', () => {
  for (const file of files) {
    for (const name of fsBindings(file.text)) {
      assert.ok(
        READ_ONLY_FS.has(name),
        `${file.name} imports "${name}" from node:fs — Nazar writes nothing, anywhere`,
      );
    }
  }
});

test('no shipped source imports node:fs as a namespace or dynamically', () => {
  for (const file of files) {
    assert.doesNotMatch(
      file.text,
      /import\s+(?:\*\s+as\s+)?[A-Za-z_$][\w$]*\s+from\s*'node:fs/,
      `${file.name} imports node:fs wholesale, which defeats the allow-list`,
    );
    assert.doesNotMatch(
      file.text,
      /(?:^|[^.\w])require\s*\(\s*'node:fs/,
      `${file.name} requires node:fs at runtime, which defeats the allow-list`,
    );
  }
});

test('the one file handle Nazar opens is opened read-only', () => {
  let opens = 0;
  for (const file of files) {
    // Only a file that imported `open` from `node:fs` can call the fs `open` —
    // the two tests above prove there is no other way to reach it — so this is
    // where the search belongs. Scanning every source instead matched a browser
    // component with an `open(...)` method of its own, which is not a file
    // handle and never could be.
    if (!fsBindings(file.text).includes('open')) continue;
    for (const match of file.text.matchAll(/(?<![.\w])open\(\s*([^)]*)\)/g)) {
      const args = match[1] ?? '';
      // Interface declarations and method calls on our own objects are not the
      // fs `open`; only a call with a flag argument is.
      if (!args.includes(',')) continue;
      opens += 1;
      assert.match(
        args,
        /,\s*'r'\s*$/,
        `${file.name} opens a file with flags ${args.split(',').slice(1).join(',').trim()}`,
      );
    }
  }
  /*
   * The gate is the `'r'` asserted above: *every* call, wherever it is, opens
   * read-only. This count is the second half of it — a number small enough that
   * a new file handle has to be a deliberate edit to this line rather than
   * something that slips in among two hundred.
   *
   * N-WP20 took it from one to two. `TranscriptTailer` now identifies a file by
   * hashing a fixed window at its head when the platform gives no usable inode,
   * and reading those bytes is a second `open(this.file, 'r')`. Both calls are
   * in `transcript-tailer.ts` and both are read-only, which is the property
   * this file exists to hold.
   */
  assert.equal(opens, 2, `expected exactly two fs.open calls, found ${opens}`);
});

/**
 * The files allowed to name a settings file at all (WP4f).
 *
 * One reader, one caller and one report. Everything else in the tree still may
 * not so much as mention the name — which is what keeps this a gate rather than
 * a comment, because a second reader appearing anywhere else fails the build.
 */
const SETTINGS_READERS = new Set([
  'packages/core/src/project-settings.ts',
  'packages/core/src/index.ts',
  'packages/server/src/doctor.ts',
]);

test('only the project-settings reader names a settings file', () => {
  for (const file of files) {
    if (!file.text.includes('settings.json')) continue;
    assert.ok(
      SETTINGS_READERS.has(file.name),
      `${file.name} names settings.json; only the WP4f project reader may`,
    );
  }
});

/**
 * The files allowed to name the **user-level** settings file (N-WP9).
 *
 * A shorter list than the one above, and deliberately so: the project reader is
 * the only thing that opens this file, the barrel re-exports its constant, and
 * the report prints what it found. Nothing else in the tree may so much as
 * spell the path.
 */
const USER_SETTINGS_READERS = new Set([
  'packages/core/src/project-settings.ts',
  'packages/core/src/index.ts',
]);

test('only the one reader names the user-level settings file', () => {
  for (const file of files) {
    if (!file.text.includes('~/.claude/settings')) continue;
    assert.ok(
      USER_SETTINGS_READERS.has(file.name),
      `${file.name} names ~/.claude/settings; only the N-WP9 reader may, and only to read it`,
    );
  }
});

test('the project-settings reader is read-only and reads one key', () => {
  const reader = files.find((file) => file.name === 'packages/core/src/project-settings.ts');
  assert.ok(reader !== undefined, 'the WP4f reader is missing; the allow-list is now a lie');
  // The allow-list test above already proves every fs binding here is read-only.
  // This adds the narrower claim the pinned table makes: one key leaves the
  // parser, and it is the command. `readdir` and `stat` arrived with N-WP9, to
  // date the wrapper's install by its own backup file; neither can change a
  // byte, and neither opens the file it names.
  assert.deepEqual(fsBindings(reader.text), ['readFile', 'readdir', 'stat']);
  for (const key of ['permissions', 'hooks', 'env', 'model', 'apiKeyHelper']) {
    assert.ok(
      !reader.text.includes(`'${key}'`),
      `the project-settings reader names ${key}; it reads statusLine.command and nothing else`,
    );
  }
});

/**
 * Every key the canvas is allowed to keep in a browser (N-WP21).
 *
 * The disk half of "Nazar writes nothing" has been a gate since v1; the browser
 * half was a promise in a README. It is a shorter list than it looks and every
 * entry is the same kind of thing — *the user's own arrangement of the picture*:
 * where the cards are, which tabs exist, the names and notes and colours they
 * typed, the language they picked, whether the usage panel is open, whether
 * they want task text. Nothing derived from a session is in here, and nothing
 * here is ever sent anywhere.
 *
 * The list is pinned rather than counted so that a diff has to say which key
 * was added and why. N-WP21 in particular adds none: the Needs-you strip holds
 * how long each session has been waiting **in memory**, and a reload starts
 * those clocks again, which is honest about what a fresh page can know.
 */
const STORAGE_KEYS = [
  'nazar.colours.v1',
  'nazar.layout.v1',
  'nazar.locale.v1',
  'nazar.names.v1',
  'nazar.notes.v1',
  'nazar.palette',
  'nazar.tabs.v1',
  'nazar.taskText.v1',
  'nazar.theme',
  'nazar.usage.v1',
];

test('the browser keeps exactly the keys it is allowed to keep', () => {
  const found = new Set<string>();
  for (const file of files) {
    if (!file.name.startsWith('packages/ui/')) continue;
    for (const match of file.text.matchAll(/'(nazar\.[\w.]+)'/g)) {
      const key = match[1]!;
      // `nazar.mjs` is the launcher's own file name, not a storage key.
      if (key.endsWith('.mjs')) continue;
      found.add(key);
    }
  }
  assert.deepEqual(
    [...found].sort(),
    STORAGE_KEYS,
    'the canvas gained or lost a browser storage key — say which, and why, in the diff',
  );
});

test('the gate bites', () => {
  assert.deepEqual(fsBindings("import { writeFile } from 'node:fs/promises';"), ['writeFile']);
  assert.equal(READ_ONLY_FS.has('writeFile'), false);
  assert.equal(READ_ONLY_FS.has('mkdir'), false);
  assert.equal(READ_ONLY_FS.has('rm'), false);
  assert.equal(READ_ONLY_FS.has('appendFile'), false);
  assert.equal(READ_ONLY_FS.has('createWriteStream'), false);
});
