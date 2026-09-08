/**
 * WP4f: the project-level `statusLine`, against real directories.
 *
 * The whole point of this reader is a case nobody can reproduce from a fixture
 * string — a settings file that exists, in a project, on disk, next to two
 * sessions that behave differently because of it. So the three shapes that
 * matter get real temporary directories: a project that overrides the status
 * line, a project that points its own at the wrapper, and a project with no
 * settings at all. The parser's edge cases are cheaper as strings and stay
 * that way.
 *
 * Nothing here writes outside `mkdtemp`, and nothing here reads the machine it
 * runs on.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CAPTURE_GRACE_MS,
  MAX_COMMAND_LENGTH,
  MAX_SETTINGS_ANCESTORS,
  ProjectStatusLineProbe,
  WRAPPER_BACKUP_PREFIX,
  WRAPPER_COMMAND,
  hasUnquotedBackslash,
  overridesIn,
  readProjectStatusLines,
  readProjectStatusLinesUpward,
  readUserStatusLine,
  statusLineOf,
} from '../src/project-settings.ts';

/** A temporary project directory, optionally with settings files in it. */
async function withProject(
  files: Readonly<Record<string, unknown>>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nazar-project-'));
  try {
    const names = Object.keys(files);
    if (names.length > 0) await mkdir(path.join(cwd, '.claude'), { recursive: true });
    for (const name of names) {
      const body = files[name];
      await writeFile(
        path.join(cwd, '.claude', name),
        typeof body === 'string' ? body : JSON.stringify(body, null, 2),
        'utf8',
      );
    }
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The three shapes, on disk
 * ------------------------------------------------------------------ */

test('a project that overrides the status line is found and named', async () => {
  await withProject(
    {
      'settings.json': {
        statusLine: { type: 'command', command: 'powershell -File ./scripts/status.ps1' },
        permissions: { allow: ['Bash(git status)'] },
      },
    },
    async (cwd) => {
      const found = await readProjectStatusLines(cwd);
      assert.equal(found.length, 1);
      const [one] = found;
      assert.equal(one?.overrides, true);
      assert.equal(one?.command, 'powershell -File ./scripts/status.ps1');
      assert.equal(one?.file, path.join(cwd, '.claude', 'settings.json'));
      // The rest of the file never left the parser.
      assert.deepEqual(Object.keys(one ?? {}).sort(), ['command', 'file', 'overrides']);
      assert.ok(!JSON.stringify(found).includes('git status'));
    },
  );
});

test('a project pointing its own status line at the wrapper is not an override', async () => {
  await withProject(
    { 'settings.json': { statusLine: { type: 'command', command: WRAPPER_COMMAND } } },
    async (cwd) => {
      const found = await readProjectStatusLines(cwd);
      assert.equal(found.length, 1, 'it is still read: doctor may want to say it is fine');
      assert.equal(found[0]?.overrides, false);
      assert.deepEqual(overridesIn(found), []);
    },
  );
});

test('a project with no settings at all says nothing', async () => {
  await withProject({}, async (cwd) => {
    assert.deepEqual(await readProjectStatusLines(cwd), []);
  });
});

test('a settings file with no statusLine key says nothing either', async () => {
  await withProject({ 'settings.json': { permissions: { allow: [] }, model: 'opus' } }, async (cwd) => {
    assert.deepEqual(await readProjectStatusLines(cwd), []);
  });
});

test('settings.local.json is read as well, and comes second', async () => {
  await withProject(
    {
      'settings.json': { statusLine: { command: WRAPPER_COMMAND } },
      'settings.local.json': { statusLine: { command: 'starship prompt' } },
    },
    async (cwd) => {
      const found = await readProjectStatusLines(cwd);
      assert.equal(found.length, 2);
      assert.equal(found[0]?.overrides, false, 'the committed file points at the wrapper');
      assert.equal(found[1]?.overrides, true, 'the local one, merged last, does not');
      assert.equal(overridesIn(found).length, 1);
      assert.match(overridesIn(found)[0]?.file ?? '', /settings\.local\.json$/);
    },
  );
});

test('a half-written settings file is not evidence of anything', async () => {
  await withProject({ 'settings.json': '{ "statusLine": { "comm' }, async (cwd) => {
    assert.deepEqual(await readProjectStatusLines(cwd), []);
  });
});

test('a directory where a settings file should be is simply absent', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nazar-project-'));
  try {
    await mkdir(path.join(cwd, '.claude', 'settings.json'), { recursive: true });
    assert.deepEqual(await readProjectStatusLines(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * The parser, as strings
 * ------------------------------------------------------------------ */

test('a statusLine with no readable command still displaces the user-level one', () => {
  // Claude Code takes the project's block whole. A block that renders nothing
  // is still a block that is not the wrapper.
  assert.equal(statusLineOf('{"statusLine":{"type":"command"}}', 'f')?.overrides, true);
  assert.equal(statusLineOf('{"statusLine":{}}', 'f')?.overrides, true);
  assert.equal(statusLineOf('{"statusLine":{"command":""}}', 'f')?.overrides, true);
  assert.equal(statusLineOf('{"statusLine":{"type":"command"}}', 'f')?.command, undefined);
});

test('a bare string statusLine is read the same way', () => {
  assert.equal(statusLineOf('{"statusLine":"my-prompt"}', 'f')?.overrides, true);
  assert.equal(statusLineOf(`{"statusLine":"${WRAPPER_COMMAND} --json"}`, 'f')?.overrides, false);
});

test('an absent, null or non-object document says nothing', () => {
  assert.equal(statusLineOf('{}', 'f'), undefined);
  assert.equal(statusLineOf('{"statusLine":null}', 'f'), undefined);
  assert.equal(statusLineOf('[]', 'f'), undefined);
  assert.equal(statusLineOf('"a string"', 'f'), undefined);
  assert.equal(statusLineOf('', 'f'), undefined);
});

test('a wrapper command survives being wrapped in something else', () => {
  // The wrapper is usually installed as a shell line rather than as a bare
  // binary, so the test is containment and not equality.
  for (const command of [
    WRAPPER_COMMAND,
    `${WRAPPER_COMMAND} --chain`,
    `sh -c "${WRAPPER_COMMAND}"`,
    `C:\\\\Users\\\\me\\\\.nazar\\\\bin\\\\${WRAPPER_COMMAND}.exe`,
  ]) {
    assert.equal(
      statusLineOf(JSON.stringify({ statusLine: { command } }), 'f')?.overrides,
      false,
      command,
    );
  }
});

test('a command longer than the cap is truncated, not carried whole', () => {
  const long = `x${'y'.repeat(500)}`;
  const read = statusLineOf(JSON.stringify({ statusLine: { command: long } }), 'f');
  assert.equal(read?.command?.length, MAX_COMMAND_LENGTH);
  assert.equal(read?.overrides, true);
});

/* ------------------------------------------------------------------ *
 * The probe
 * ------------------------------------------------------------------ */

test('the probe answers nothing until it has read, then answers from the cache', async () => {
  let reads = 0;
  let clock = 1_000;
  const probe = new ProjectStatusLineProbe({
    ttlMs: 10_000,
    now: () => clock,
    read: async (cwd) => {
      reads += 1;
      return cwd === '/over' ? [{ file: '/over/.claude/settings.json', overrides: true }] : [];
    },
  });

  assert.equal(probe.lookup('/over'), undefined, 'a directory nobody has read is unknown');
  assert.equal(probe.overrides('/over'), false, 'unknown draws nothing, never a guess');

  await probe.probe('/over');
  assert.equal(reads, 1);
  assert.equal(probe.overrides('/over'), true);

  await probe.probe('/over');
  assert.equal(reads, 1, 'inside the TTL it does not read again');

  clock += 10_001;
  await probe.probe('/over');
  assert.equal(reads, 2, 'past the TTL it does');
});

test('the probe never rejects, and a failed read is an empty answer', async () => {
  const probe = new ProjectStatusLineProbe({
    read: async () => {
      throw new Error('EACCES');
    },
  });
  await probe.probe('/nope');
  assert.deepEqual(probe.lookup('/nope'), []);
  assert.equal(probe.overrides('/nope'), false);
});

test('the probe de-duplicates concurrent reads of one directory', async () => {
  let reads = 0;
  let release: (() => void) | undefined;
  const probe = new ProjectStatusLineProbe({
    read: async () => {
      reads += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    },
  });
  const first = probe.probe('/slow');
  const second = probe.probe('/slow');
  release?.();
  await Promise.all([first, second]);
  assert.equal(reads, 1, 'a publish every two seconds must not stack reads on one directory');
});

test('the probe answers false for a session with no working directory', () => {
  assert.equal(new ProjectStatusLineProbe().overrides(undefined), false);
});

test('the grace period is long past a first status-line redraw', () => {
  assert.equal(CAPTURE_GRACE_MS, 90_000);
});

test('a real project reaches the probe end to end', async () => {
  await withProject(
    { 'settings.json': { statusLine: { type: 'command', command: 'my-prompt' } } },
    async (cwd) => {
      const probe = new ProjectStatusLineProbe();
      await probe.probe(cwd);
      assert.equal(probe.overrides(cwd), true);
      assert.equal(probe.lookup(cwd)?.[0]?.command, 'my-prompt');
      probe.clear();
      assert.equal(probe.lookup(cwd), undefined);
    },
  );
});

/* ------------------------------------------------------------------ *
 * N-WP9: the ancestor walk, and the user-level status line
 * ------------------------------------------------------------------ */

/** A temporary configuration directory, with whatever files a case needs. */
async function withConfigDir(
  files: Readonly<Record<string, unknown>>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nazar-config-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(
        path.join(dir, name),
        typeof body === 'string' ? body : JSON.stringify(body, null, 2),
        'utf8',
      );
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a status line set at the top of a repository is found from a directory inside it', async () => {
  await withProject(
    { 'settings.json': { statusLine: { command: 'starship prompt' } } },
    async (root) => {
      const deep = path.join(root, 'packages', 'server', 'src');
      await mkdir(deep, { recursive: true });

      assert.deepEqual(await readProjectStatusLines(deep), [], 'the leaf itself declares nothing');

      const upward = await readProjectStatusLinesUpward(deep, { stopAt: homedir() });
      assert.equal(upward.length, 1, 'the ancestor declares one');
      assert.equal(upward[0]?.command, 'starship prompt');
      assert.equal(upward[0]?.overrides, true);
      assert.equal(upward[0]?.file, path.join(root, '.claude', 'settings.json'));
    },
  );
});

test('the nearest declaration comes first, so the closest explanation wins', async () => {
  await withProject({ 'settings.json': { statusLine: { command: 'outer' } } }, async (root) => {
    const inner = path.join(root, 'app');
    await mkdir(path.join(inner, '.claude'), { recursive: true });
    await writeFile(
      path.join(inner, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { command: 'inner' } }),
      'utf8',
    );

    const upward = await readProjectStatusLinesUpward(inner, { stopAt: homedir() });
    assert.deepEqual(
      upward.map((line) => line.command),
      ['inner', 'outer'],
    );
  });
});

test('the walk up ends at the filesystem root rather than running forever', async () => {
  await withProject({}, async (cwd) => {
    // Nothing declares anything anywhere above a temporary directory, so this
    // answers empty — and the value of the test is that it answers at all.
    assert.deepEqual(await readProjectStatusLinesUpward(cwd, { stopAt: homedir() }), []);
    assert.ok(MAX_SETTINGS_ANCESTORS > 8, 'the bound has to clear a real path');
  });
});

test('the walk stops before the home directory, which is the user level and not a project', async () => {
  // A session working directly in the home directory. `<home>/.claude` holds
  // the *user-level* settings file the wrapper installs itself into, and
  // reading it here would report the machine's own status line as a project
  // override for every session started anywhere under the home directory.
  const home = await mkdtemp(path.join(tmpdir(), 'nazar-home-'));
  try {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { command: 'starship prompt' } }),
      'utf8',
    );
    const project = path.join(home, 'proj', 'app');
    await mkdir(project, { recursive: true });

    assert.deepEqual(
      await readProjectStatusLinesUpward(project, { stopAt: home }),
      [],
      'the user-level file is not a project override',
    );
    // Without the stop it would be found, which is the failure this pins.
    const unbounded = await readProjectStatusLinesUpward(project);
    assert.equal(unbounded[0]?.command, 'starship prompt');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a machine with no user settings file says so rather than guessing', async () => {
  await withConfigDir({}, async (dir) => {
    const user = await readUserStatusLine(dir);
    assert.equal(user.exists, false);
    assert.equal(user.isWrapper, false);
    assert.equal(user.command, undefined);
    assert.equal(user.file, path.join(dir, 'settings.json'));
    // No settings file and no backup: there is nothing to date an install by.
    assert.equal(user.installedAt, undefined);
  });
});

test('the user-level status line is read, and the wrapper is recognised', async () => {
  await withConfigDir(
    {
      'settings.json': {
        statusLine: { type: 'command', command: 'C:/tools/nazar-statusline.exe' },
      },
    },
    async (dir) => {
      const user = await readUserStatusLine(dir);
      assert.equal(user.exists, true);
      assert.equal(user.isWrapper, true);
      assert.equal(user.command, 'C:/tools/nazar-statusline.exe');
      assert.ok(user.command?.includes(WRAPPER_COMMAND));
    },
  );
});

test('a user-level status line that is something else is not the wrapper', async () => {
  await withConfigDir(
    { 'settings.json': { statusLine: { command: 'starship prompt' } } },
    async (dir) => {
      const user = await readUserStatusLine(dir);
      assert.equal(user.isWrapper, false);
      assert.equal(user.command, 'starship prompt');
    },
  );
});

test('a settings file with no statusLine key is not an override and not the wrapper', async () => {
  await withConfigDir({ 'settings.json': { theme: 'dark' } }, async (dir) => {
    const user = await readUserStatusLine(dir);
    assert.equal(user.exists, true);
    assert.equal(user.command, undefined);
    assert.equal(user.isWrapper, false);
  });
});

test('a damaged user settings file reads as an absent status line, not as an error', async () => {
  await withConfigDir({ 'settings.json': '{ half way through an edit' }, async (dir) => {
    const user = await readUserStatusLine(dir);
    assert.equal(user.exists, true, 'the file is there');
    assert.equal(user.command, undefined, 'and says nothing this reader can use');
    assert.equal(user.isWrapper, false);
  });
});

test('nothing but statusLine.command leaves the user settings file', async () => {
  await withConfigDir(
    {
      'settings.json': {
        statusLine: { command: 'nazar-statusline' },
        permissions: { allow: ['Bash(curl evil)'] },
        env: { ANTHROPIC_API_KEY: 'sk-never-read-this' },
        apiKeyHelper: 'print-the-secret',
      },
    },
    async (dir) => {
      const user = await readUserStatusLine(dir);
      const serialised = JSON.stringify(user);
      for (const sentinel of ['curl evil', 'sk-never-read-this', 'print-the-secret', 'ANTHROPIC']) {
        assert.ok(!serialised.includes(sentinel), `${sentinel} reached the output of the reader`);
      }
    },
  );
});

test('the install is dated by the wrapper backup when there is one', async () => {
  const stamp = `${WRAPPER_BACKUP_PREFIX}20260101T000000Z`;
  await withConfigDir(
    {
      'settings.json': { statusLine: { command: 'nazar-statusline' } },
      [stamp]: { statusLine: { command: 'starship prompt' } },
    },
    async (dir) => {
      // The backup is the artefact the install leaves behind; the settings file
      // is touched by every later edit. Both exist here, and the backup wins.
      const when = new Date('2026-01-01T00:00:00Z');
      await utimes(path.join(dir, stamp), when, when);

      const user = await readUserStatusLine(dir);
      assert.equal(user.installedAtSource, 'backup');
      assert.equal(user.installedAt, when.getTime());
    },
  );
});

test('the oldest backup dates the install, because a reinstall writes another one', async () => {
  const first = `${WRAPPER_BACKUP_PREFIX}first`;
  const second = `${WRAPPER_BACKUP_PREFIX}second`;
  await withConfigDir(
    {
      'settings.json': { statusLine: { command: 'nazar-statusline' } },
      [first]: '{}',
      [second]: '{}',
    },
    async (dir) => {
      const early = new Date('2026-01-01T00:00:00Z');
      const late = new Date('2026-06-01T00:00:00Z');
      await utimes(path.join(dir, first), early, early);
      await utimes(path.join(dir, second), late, late);

      const user = await readUserStatusLine(dir);
      assert.equal(user.installedAt, early.getTime(), 'the first install, not the latest');
    },
  );
});

test('with no backup the settings file dates the install, and the source says which', async () => {
  await withConfigDir(
    { 'settings.json': { statusLine: { command: 'nazar-statusline' } } },
    async (dir) => {
      const when = new Date('2026-03-04T05:06:07Z');
      await utimes(path.join(dir, 'settings.json'), when, when);

      const user = await readUserStatusLine(dir);
      assert.equal(user.installedAtSource, 'settings');
      assert.equal(user.installedAt, when.getTime());
    },
  );
});

test('a file that only looks like a backup is not one', async () => {
  await withConfigDir(
    {
      'settings.json': { statusLine: { command: 'nazar-statusline' } },
      'settings.json.bak': '{}',
      'settings.local.json': '{}',
    },
    async (dir) => {
      const when = new Date('2026-03-04T05:06:07Z');
      await utimes(path.join(dir, 'settings.json'), when, when);
      const decoy = new Date('2020-01-01T00:00:00Z');
      await utimes(path.join(dir, 'settings.json.bak'), decoy, decoy);

      const user = await readUserStatusLine(dir);
      assert.equal(user.installedAtSource, 'settings', 'only the wrapper prefix counts');
      assert.equal(user.installedAt, when.getTime());
    },
  );
});

/* ------------------------------------------------------------------ *
 * T-WP8: the command Claude Code's shell cannot start
 *
 * The wrapper installed itself with an unquoted Windows path, Claude Code ran
 * it through Git Bash, and every backslash was read as an escape — so the
 * command was never spawned once and doctor called it "no status-line tick
 * yet". These pin the predicate and the flag the report is built on.
 * ------------------------------------------------------------------ */

/** A Windows path as it reaches the shell: unquoted, backslashes and all. */
const UNRUNNABLE_PATH = String.raw`C:\tools\nazar\nazar-statusline.exe`;

test('only an unquoted backslash is one the shell would eat', () => {
  for (const command of [
    UNRUNNABLE_PATH,
    String.raw`node C:\tools\statusline.js`,
    String.raw`a\b`,
  ]) {
    assert.equal(hasUnquotedBackslash(command), true, command);
  }
  for (const command of [
    `"${UNRUNNABLE_PATH}"`,
    `'${UNRUNNABLE_PATH}'`,
    String.raw`node "C:\tools\statusline.js"`,
    'C:/tools/nazar/nazar-statusline.exe',
    'npx ccstatusline@latest',
    '',
    // An escaped quote inside a quoted run must not flip the quote state and
    // turn the backslashes after it into unquoted ones.
    String.raw`"a\"b\c"`,
  ]) {
    assert.equal(hasUnquotedBackslash(command), false, command);
  }
});

test('a Windows path with no quotes round it is a status line that never runs', async () => {
  await withConfigDir(
    {
      'settings.json': {
        statusLine: { type: 'command', command: UNRUNNABLE_PATH },
      },
    },
    async (dir) => {
      const onWindows = await readUserStatusLine(dir, 'win32');
      assert.equal(onWindows.isWrapper, true, 'it is the wrapper');
      assert.equal(onWindows.bashUnsafe, true, 'and it has never been spawned');

      // The same string somewhere else is a command line somebody meant.
      const elsewhere = await readUserStatusLine(dir, 'linux');
      assert.equal(elsewhere.bashUnsafe, false);
    },
  );
});

test('the spellings that do run are not reported as broken', async () => {
  for (const command of [
    'C:/tools/nazar/nazar-statusline.exe',
    `"${UNRUNNABLE_PATH}"`,
    'nazar-statusline',
  ]) {
    await withConfigDir(
      { 'settings.json': { statusLine: { type: 'command', command } } },
      async (dir) => {
        const user = await readUserStatusLine(dir, 'win32');
        assert.equal(user.isWrapper, true, command);
        assert.equal(user.bashUnsafe, false, command);
      },
    );
  }
});

test('a machine with no status line at all has nothing to call unsafe', async () => {
  await withConfigDir({ 'settings.json': { theme: 'dark' } }, async (dir) => {
    assert.equal((await readUserStatusLine(dir, 'win32')).bashUnsafe, false);
  });
});
