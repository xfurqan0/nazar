/**
 * N-WP-L8: the scanner that reads a built artifact for the build machine's paths.
 *
 * `scripts/build-desktop.mjs` remaps those paths away; this is the check that says
 * whether the remapping worked, and a check nobody has tested is a green tick with
 * nothing behind it. What it has to get right is exactly what a naive version gets
 * wrong:
 *
 * 1. **Both encodings.** A Windows binary carries wide strings, so a scanner that only
 *    read UTF-8 would report an installer full of `C:\Users\…` as clean.
 * 2. **A boundary on the account name**, which is the lesson `history-leak.test.ts`
 *    learned: an account called `ada` must not fire on `adaptive-layout`.
 * 3. **The containers.** A `.deb` is an `ar` archive whose payload is compressed, and a
 *    scan of the outer bytes sees nothing of the binary inside it.
 * 4. **No silent pass.** A container it cannot open must be reported as unread, never as
 *    clean.
 *
 * The script is plain JavaScript on purpose — `check-binary-paths.d.mts` beside it
 * declares what is used here. Nothing in this file runs a build: the artifacts are
 * synthesised, so the suite says the same thing on a machine that has never compiled the
 * shell.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  RULES,
  arMembers,
  borrowed,
  decompress,
  findLeaks,
  rpmPayload,
  rulesFor,
  scanBuffer,
} from '../scripts/check-binary-paths.mjs';

/** A synthetic account, for the same reason the leak tests use one: this repo is public. */
const ACCOUNT = 'ada';
const HOME = `/home/${ACCOUNT}`;

const machine = () => rulesFor({ account: ACCOUNT, home: HOME });

test('a home directory is found whichever platform wrote it', () => {
  const rules = RULES;
  const windows = findLeaks(String.raw`panicked at C:\Users\ada\.cargo\registry\src\x.rs`, rules);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.rule, 'windows-profile');

  const linux = findLeaks('panicked at /home/ada/.cargo/registry/src/x.rs', rules);
  assert.equal(linux.length, 1);
  assert.equal(linux[0]?.rule, 'unix-home');

  const macos = findLeaks('panicked at /Users/ada/.cargo/registry/src/x.rs', rules);
  assert.equal(macos.length, 1);
  assert.equal(macos[0]?.rule, 'macos-home');

  // A remapped path is what a clean build looks like: `crates/tauri-2.11.5/src/app.rs`.
  assert.deepEqual(findLeaks('panicked at crates/tauri-2.11.5/src/app.rs', rules), []);
});

test('every copy is counted, because the count is the measurement', () => {
  // 238 in one executable was what said the registry path is written once per panic site
  // rather than once. A scanner that de-duplicated would have reported a single hit and
  // read like a rounding error.
  const text = Array.from({ length: 17 }, (_, at) => `/home/ada/src/${at}.rs`).join(' ');
  assert.equal(findLeaks(text, RULES).length, 17);
});

test('the account name needs a boundary, and the home directory does not', () => {
  const rules = machine();
  const account = (text: string): number =>
    findLeaks(text, rules).filter((one) => one.rule === 'this-account').length;

  assert.equal(account('/home/ada/.cargo'), 1);
  assert.equal(account('"ada"'), 1);
  // The false alarm that made this rule: a longer name that contains the shorter one.
  assert.equal(account('~/2-notes-adaOS'), 0);
  assert.equal(account('adaptive-layout'), 0);
  assert.equal(account('nomada'), 0);
  // An underscore is part of a word too, which a CI runner proved: its account is
  // `runner`, and GStreamer's `runner_run` and `runner->async_tasks` are symbols rather
  // than anybody's home directory.
  assert.equal(account('ada_run'), 0);
  assert.equal(account('gst_ada_thread'), 0);
  // But an arrow is not part of one.
  assert.equal(account('ada->tasks'), 1);

  const home = findLeaks(`${HOME}/nazar/target`, rules).filter((one) => one.rule === 'this-home');
  assert.equal(home.length, 1);
});

test('a home that is not under /home is still this machine', () => {
  // Fedora Silverblue puts an account in /var/home/<name>, and the category patterns were
  // written for the usual shape. The machine's own path is asked for by path for exactly
  // this case — the machine most likely to be building is the one it would have missed.
  const rules = rulesFor({ account: ACCOUNT, home: '/var/home/ada' });
  const found = findLeaks('/var/home/ada/nazar/apps/desktop/src/main.rs', rules);
  assert.ok(found.some((one) => one.rule === 'this-home'));
});

test('a wide string is read as well as a narrow one', () => {
  // The bug this exists to stop: a Windows binary whose paths are all UTF-16LE, scanned
  // by something that only decodes UTF-8, comes back clean.
  const wide = Buffer.from(String.raw`C:\Users\ada\.cargo\registry`, 'utf16le');
  const narrow = Buffer.from('nothing to see', 'utf8');
  const buffer = Buffer.concat([narrow, wide]);

  const found = scanBuffer(buffer, RULES);
  assert.ok(found.length > 0, 'a UTF-16LE path was missed');
  assert.ok(
    found.every((one) => one.encoding.startsWith('utf16le')),
    'the narrow read invented a match',
  );

  // And at an odd offset, which is where half of them start.
  const shifted = Buffer.concat([Buffer.from('x'), wide]);
  assert.ok(scanBuffer(shifted, RULES).length > 0, 'an odd-aligned wide string was missed');
});

test('a .deb is an ar archive, and its payload is what has to be read', () => {
  const payload = gzipSync(Buffer.from('ustar /home/ada/.cargo/registry/src/x.rs'));
  const archive = Buffer.concat([
    Buffer.from('!<arch>\n'),
    member('debian-binary', Buffer.from('2.0\n')),
    member('data.tar.gz', payload),
  ]);

  const members = arMembers(archive);
  assert.deepEqual(
    members.map((one) => one.name),
    ['debian-binary', 'data.tar.gz'],
  );

  // The outer bytes say nothing: gzip is why the scan has to unpack rather than grep.
  assert.deepEqual(scanBuffer(archive, RULES), []);
  const inside = decompress(members[1]!.data);
  assert.ok(inside !== undefined);
  assert.equal(scanBuffer(inside, RULES).length, 1);
});

test('an rpm payload is found by its magic rather than by a header parser', () => {
  const lead = Buffer.alloc(200, 0x55);
  const rpm = Buffer.concat([lead, gzipSync(Buffer.from('/home/ada/nazar/apps/desktop'))]);
  const payload = rpmPayload(rpm);
  assert.ok(payload !== undefined, 'the payload was not found');
  assert.equal(scanBuffer(payload, RULES).length, 1);
});

test('nothing a scanner cannot open is reported as empty', () => {
  // The failure mode that matters most: `decompress` answering "nothing found" for bytes
  // it never read would turn every unreadable container into a pass.
  assert.equal(decompress(Buffer.from('\u00fd7zXZ\u0000', 'latin1')), undefined);
  assert.equal(rpmPayload(Buffer.alloc(4096, 0x41)), undefined);
  assert.deepEqual(arMembers(Buffer.from('not an archive')), []);
});

test('a library the bundler copied in is not this build\'s to be clean', () => {
  // `libgtk-3.so.0` has carried `/home/<name>/Projects/gtk/…` — upstream GTK's own artist
  // — in every copy for years, and an AppImage is those libraries in one file. Reported,
  // never failed: no flag in this repository can change a binary it did not compile.
  assert.equal(borrowed('target/release/bundle/appimage/nazar-desktop.AppDir/usr/lib/libgtk-3.so.0'), true);
  assert.equal(borrowed('/x/libgstvideo-1.0.so'), true);
  assert.equal(borrowed('/x/libsomething.dylib'), true);
  assert.equal(borrowed('/x/nazar-desktop_0.1.0_amd64.AppImage'), true);
  // Ours, wherever it is standing — including inside the AppDir the bundler built.
  assert.equal(borrowed('target/release/nazar-desktop'), false);
  assert.equal(borrowed('target/release/bundle/deb/nazar-desktop_0.1.0_amd64.deb'), false);
  assert.equal(borrowed('target/debug/nazar-desktop.exe'), false);
});

/** One `ar` member: sixty bytes of header, then the data, padded to an even length. */
function member(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(60, 0x20);
  header.write(name.padEnd(16, ' '), 0, 'latin1');
  header.write('0'.padEnd(12, ' '), 16, 'latin1');
  header.write('0'.padEnd(6, ' '), 28, 'latin1');
  header.write('0'.padEnd(6, ' '), 34, 'latin1');
  header.write('100644'.padEnd(8, ' '), 40, 'latin1');
  header.write(String(data.length).padEnd(10, ' '), 48, 'latin1');
  header.write('`\n', 58, 'latin1');
  return data.length % 2 === 0 ? Buffer.concat([header, data]) : Buffer.concat([header, data, Buffer.from('\n')]);
}
