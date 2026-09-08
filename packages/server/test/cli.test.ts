import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CliError,
  DEFAULT_PORT,
  USAGE,
  main,
  parseOpen,
  parsePort,
  serve,
  unknownFlag,
  unknownFlagMessage,
} from '../src/cli.ts';
import { OPEN_HINT } from '../src/open.ts';
import { resolveUiDir } from '../src/ui-assets.ts';

class Capture {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

test('parsePort falls back to the default port', () => {
  assert.equal(parsePort([]), DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 4676);
  assert.equal(parsePort(['--verbose']), DEFAULT_PORT);
});

test('parsePort accepts both --port forms, last one wins', () => {
  assert.equal(parsePort(['--port', '8080']), 8080);
  assert.equal(parsePort(['--port=8080']), 8080);
  assert.equal(parsePort(['--port=1', '--port', '65535']), 65535);
});

test('parsePort rejects values that are not ports', () => {
  for (const argv of [['--port', 'abc'], ['--port=0'], ['--port=65536'], ['--port=-1'], ['--port']]) {
    assert.throws(() => parsePort(argv), CliError, `expected ${JSON.stringify(argv)} to be rejected`);
  }
});

test('the browser opens by default and --no-open wins over --open', () => {
  assert.equal(parseOpen([]), true);
  assert.equal(parseOpen(['--open']), true);
  assert.equal(parseOpen(['--no-open']), false);
  assert.equal(parseOpen(['--open', '--no-open']), false);
});

test('--help describes the flags without starting anything', async () => {
  const out = new Capture();
  const err = new Capture();

  assert.equal(await main(['--help'], out, err), 0);
  assert.match(out.text, /--port <number>/);
  assert.match(out.text, /--no-open/);
  assert.match(out.text, /127\.0\.0\.1/);
  assert.equal(err.text, '');
});

test('main reports a bad port on stderr with exit code 2', async () => {
  const out = new Capture();
  const err = new Capture();

  assert.equal(await main(['--port', 'nope'], out, err), 2);
  assert.equal(out.text, '');
  assert.match(err.text, /--port must be a number/);
});

test('the UI directory resolves to the built canvas', () => {
  const uiDir = resolveUiDir();
  assert.ok(path.isAbsolute(uiDir));
  assert.equal(path.basename(uiDir), 'web');
  // Only meaningful after `npm run build`; a fresh clone still runs the rest.
  if (existsSync(uiDir)) {
    assert.ok(existsSync(path.join(uiDir, 'index.html')), 'the canvas has no index.html');
    assert.ok(existsSync(path.join(uiDir, 'bundle.js')));
    assert.ok(existsSync(path.join(uiDir, 'styles.css')));
    assert.ok(existsSync(path.join(uiDir, 'assets', 'claude-color.png')));
  }
});

test('NAZAR_UI_DIR overrides where the canvas is served from', () => {
  const overridden = resolveUiDir({ NAZAR_UI_DIR: path.join('some', 'where') });
  assert.equal(overridden, path.resolve('some', 'where'));
});

test('serve prints the canvas URL on its own line before anything is opened', async (t) => {
  // Only meaningful after `npm run build`; a fresh clone still runs the rest.
  if (!existsSync(resolveUiDir())) return t.skip('the canvas is not built');

  const out = new Capture();
  const err = new Capture();
  // Port 0 lets the OS pick, so a busy 4676 cannot fail this test.
  const handle = await serve({ port: 0, open: false, out, err });
  try {
    const lines = out.text.split('\n');
    const urlLine = lines.findIndex((line) => line.includes(handle.url));
    assert.ok(urlLine > -1, `no line carried the URL:\n${out.text}`);
    assert.equal(lines[urlLine], `canvas: ${handle.url}`, 'the URL shares its line with nothing else');
    assert.equal(urlLine, 1, 'the URL is the second line, before any session counting');
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    // --no-open means no chain ran at all, and the hint is not printed.
    assert.equal(await handle.opening, undefined);
    assert.ok(!out.text.includes(OPEN_HINT), 'the hint belongs to a run that tried to open');
  } finally {
    await handle.close();
  }
});

/* ------------------------------------------------------------------ *
 * N-WP9: the two ways the parser was wrong
 *
 * `nazar doctor -v` printed the version and never ran doctor, and a
 * misspelled flag changed nothing and said nothing. Both came from one shape:
 * a search of the whole argument list for every flag the program knew, and no
 * opinion at all about the ones it did not.
 * ------------------------------------------------------------------ */

test('doctor -v runs doctor, verbosely, instead of printing the version', async () => {
  const out = new Capture();
  const err = new Capture();

  assert.equal(await main(['doctor', '-v'], out, err), 0);
  assert.match(out.text, /^nazar doctor \d+\.\d+\.\d+ · node /, 'doctor ran');
  assert.ok(!/^\d+\.\d+\.\d+\n$/.test(out.text), 'and did not merely print a version');
  // --verbose prints absolute paths, so the hint about them is not printed.
  assert.ok(!out.text.includes('Add --verbose for the'), 'the run was verbose');
  assert.equal(err.text, '');
});

test('doctor --verbose is the long form of the same flag', async () => {
  const out = new Capture();
  const err = new Capture();

  assert.equal(await main(['doctor', '--verbose'], out, err), 0);
  assert.match(out.text, /^nazar doctor /);
  assert.ok(!out.text.includes('Add --verbose for the'));
});

test('doctor without the flag is quiet, and says how to make it loud', async () => {
  const out = new Capture();
  const err = new Capture();

  assert.equal(await main(['doctor'], out, err), 0);
  assert.match(out.text, /Add --verbose for the/);
});

test('--version prints the version at the top level, and -V is its short form', async () => {
  for (const flag of ['--version', '-V']) {
    const out = new Capture();
    const err = new Capture();
    assert.equal(await main([flag], out, err), 0, flag);
    assert.match(out.text, /^\d+\.\d+\.\d+\n$/, flag);
    assert.equal(err.text, '');
  }
});

test('-v at the top level is refused, and named, because this program made it ambiguous', async () => {
  const out = new Capture();
  const err = new Capture();

  assert.equal(await main(['-v'], out, err), 2);
  assert.equal(out.text, '');
  assert.match(err.text, /unknown option "-v"/);
  // Both of the things it could have meant, since it used to mean one of them.
  assert.match(err.text, /--verbose/);
  assert.match(err.text, /nazar --version/);
});

test('an unknown flag exits 2, names itself, and prints one line of usage', async () => {
  for (const argv of [['--prot', '8080'], ['--verbos'], ['--no-opne'], ['-x']]) {
    const out = new Capture();
    const err = new Capture();

    assert.equal(await main(argv, out, err), 2, JSON.stringify(argv));
    assert.equal(out.text, '', 'nothing is printed on stdout');
    assert.ok(err.text.includes(`unknown option "${argv[0]}"`), err.text);
    assert.ok(err.text.includes(USAGE), err.text);
    assert.equal(err.text.trimEnd().split('\n').length, 2, 'the flag, then one usage line');
  }
});

test('an unknown flag after doctor is refused by doctor rather than ignored', async () => {
  const out = new Capture();
  const err = new Capture();

  assert.equal(await main(['doctor', '--porcelain'], out, err), 2);
  assert.equal(out.text, '', 'doctor did not run');
  assert.match(err.text, /unknown option "--porcelain"/);
});

test('a flag one level owns is unknown at the other', async () => {
  // `--port` belongs to the serve path and `--verbose` to doctor. Each is an
  // unknown option at the other level, which is the whole point of splitting
  // the parser in two.
  const out = new Capture();
  const err = new Capture();
  assert.equal(await main(['doctor', '--port', '4676'], out, err), 2);
  assert.match(err.text, /unknown option "--port"/);

  const out2 = new Capture();
  const err2 = new Capture();
  assert.equal(await main(['--verbose'], out2, err2), 2);
  assert.match(err2.text, /unknown option "--verbose"/);
});

test('--help and --version still work after doctor', async () => {
  const help = new Capture();
  assert.equal(await main(['doctor', '--help'], help, new Capture()), 0);
  assert.match(help.text, /nazar - keep a watchful eye/);

  const version = new Capture();
  assert.equal(await main(['doctor', '--version'], version, new Capture()), 0);
  assert.match(version.text, /^\d+\.\d+\.\d+\n$/);
});

test('unknownFlag skips a --port value and both --port spellings', () => {
  const serve = ['--open', '--no-open', '--port'];
  assert.equal(unknownFlag(['--port', '8080'], serve), undefined);
  assert.equal(unknownFlag(['--port=8080'], serve), undefined);
  assert.equal(unknownFlag(['--port', '8080', '--no-open'], serve), undefined);
  // A missing value is parsePort's error to report, not this one's.
  assert.equal(unknownFlag(['--port'], serve), undefined);
  assert.equal(unknownFlag(['--port', '--no-open'], serve), undefined);
  // And an unknown flag is still found after one that took a value.
  assert.equal(unknownFlag(['--port', '8080', '--nope'], serve), '--nope');
  assert.equal(unknownFlag(['--nope=1'], serve), '--nope=1', 'the whole argument is reported');
  // Everything that is not a flag is somebody else's business.
  assert.equal(unknownFlag(['doctor', '8080', '-'], serve), undefined);
});

test('the usage line names both the serve form and the subcommand', () => {
  assert.match(USAGE, /nazar \[--port <number>\]/);
  assert.match(USAGE, /nazar doctor/);
  assert.equal(USAGE.split('\n').length, 1, 'one line, as the message promises');
  assert.equal(unknownFlagMessage('--nope'), `nazar: unknown option "--nope"\n${USAGE}\n`);
});
