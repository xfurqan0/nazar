/**
 * The seam between the canvas and the desktop shell (WP8).
 *
 * Node has no DOM, so this is a contract test rather than a rendering one, and it has an
 * unusual second party: half of the contract lives in a Rust crate. Three things have to
 * agree, and nothing else checks that they do —
 *
 * 1. `web/shell.ts` names the commands, `apps/desktop/src/main.rs` registers them, and
 *    `apps/desktop/capabilities/canvas.json` is what makes them reachable from a page
 *    served over http. A command renamed on one side is a feature that silently stops
 *    working inside the shell and keeps working nowhere.
 * 2. `index.html` carries the controls and `app.ts` is the only place that looks them up.
 * 3. **Browser mode is not degraded.** The detection is one expression, the fallbacks are
 *    sentences rather than silence, and nothing the shell adds is imported at the top
 *    level of a module a browser has to run.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const desktopDir = path.join(here, '..', '..', '..', 'apps', 'desktop');

const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');
const css = readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
const settings = readFileSync(path.join(webDir, 'settings.ts'), 'utf8');
const shell = readFileSync(path.join(webDir, 'shell.ts'), 'utf8');
const tabbar = readFileSync(path.join(webDir, 'tabbar.ts'), 'utf8');
const mainRs = readFileSync(path.join(desktopDir, 'src', 'main.rs'), 'utf8');
const buildRs = readFileSync(path.join(desktopDir, 'build.rs'), 'utf8');
const capability = readFileSync(path.join(desktopDir, 'capabilities', 'canvas.json'), 'utf8');
const localCapability = readFileSync(path.join(desktopDir, 'capabilities', 'default.json'), 'utf8');

/** `allow-shell-info` is the permission generated for the command `shell_info`. */
const permissionFor = (command: string): string => `allow-${command.replaceAll('_', '-')}`;

/** Every command `shell.ts` invokes, read out of the source rather than listed twice. */
const invoked = [...shell.matchAll(/call<[^>]*>\('([a-z_]+)'/g)]
  .map((match) => match[1])
  .filter((name): name is string => name !== undefined);

test('the canvas invokes only commands the shell actually registers', () => {
  assert.ok(invoked.length >= 4, `expected the command set, found ${invoked.join(', ')}`);
  const handler = mainRs.slice(
    mainRs.indexOf('generate_handler!'),
    mainRs.indexOf('.setup('),
  );
  for (const command of invoked) {
    assert.ok(
      handler.includes(command),
      `the canvas invokes "${command}" and apps/desktop/src/main.rs does not register it`,
    );
    assert.match(
      mainRs,
      new RegExp(`#\\[tauri::command\\][\\s\\S]{0,200}fn ${command}\\b`),
      `"${command}" is in the handler list but is not a #[tauri::command]`,
    );
  }
});

test('every command the canvas calls is declared, registered and granted', () => {
  // This is the regression test for the failure that cost the most time in WP8. The
  // canvas loaded, `window.__TAURI__` was there, the sidebar's desktop group appeared —
  // and every call came back "shell_info not allowed. Plugin not found", because a
  // *remote* origin reaches nothing the access-control list has not been told about, and
  // an application's own commands are only in that list once `build.rs` declares them.
  // Three files have to agree and none of them fails loudly when they do not.
  const granted = JSON.parse(capability) as { permissions: string[] };
  for (const command of invoked) {
    assert.ok(
      buildRs.includes(`"${command}"`),
      `apps/desktop/build.rs does not declare "${command}", so no permission exists for it`,
    );
    assert.ok(
      granted.permissions.includes(permissionFor(command)),
      `capabilities/canvas.json does not grant ${permissionFor(command)}`,
    );
  }
});

test('the boot page gets its own two commands and none of the canvas ones', () => {
  const local = JSON.parse(localCapability) as { permissions: string[]; remote?: unknown };
  assert.equal(local.remote, undefined, 'the local capability must not name a remote origin');
  for (const command of ['boot_state', 'open_download_page']) {
    assert.ok(local.permissions.includes(permissionFor(command)), `missing ${command}`);
    assert.ok(buildRs.includes(`"${command}"`), `build.rs does not declare ${command}`);
  }
  for (const command of invoked) {
    assert.ok(
      !local.permissions.includes(permissionFor(command)),
      `the boot page does not call "${command}" and must not be granted it`,
    );
  }
});

test('the loopback origin is the one the capability grants', () => {
  // Without this file the canvas is a remote page with no IPC at all, and every feature
  // in this suite would fail at run time while every test here still passed.
  const parsed = JSON.parse(capability) as { remote?: { urls?: string[] } };
  assert.deepEqual(parsed.remote?.urls, ['http://127.0.0.1:*', 'http://localhost:*']);
});

test('the shell is detected and never assumed', () => {
  // `withGlobalTauri` puts this global on the page inside the shell and nowhere else.
  assert.match(shell, /host\.__TAURI__\?\.core/);
  assert.match(shell, /typeof core\?\.invoke === 'function'/);
  // Nothing is imported from @tauri-apps: the canvas has no runtime dependencies, and an
  // import would be one only half its users could load. The prose in these files names
  // the package on purpose, so this looks for an import rather than for the word.
  const importsTauri = /(?:from|import)\s*\(?\s*['"]@tauri-apps/;
  assert.ok(!importsTauri.test(shell), 'shell.ts must not import the Tauri API package');
  assert.ok(!importsTauri.test(app), 'app.ts must not import the Tauri API package');
});

test('a command that fails resolves rather than rejecting', () => {
  // A monitoring tool that logs unhandled rejections into its own console when a jump
  // fails is a monitoring tool with a bug report attached.
  assert.match(shell, /try \{[\s\S]{0,120}await this\.invoke[\s\S]{0,80}catch \{[\s\S]{0,60}return undefined/);
});

test('the page carries the controls the shell wiring attaches to', () => {
  for (const id of ['hint', 'shell-group', 'autostart-toggle']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
    assert.ok(app.includes(`'${id}'`), `#${id} is in the page but nothing looks it up`);
  }
  // Hidden in markup, not by a script that might not run: a browser must never flash a
  // control it cannot honour.
  assert.match(html, /id="shell-group"[^>]*hidden/);
  assert.match(html, /id="hint"[^>]*hidden/);
});

test('the autostart switch announces its state', () => {
  // N-WP12 made it a real switch: `role="switch"` on a button, with the state in
  // `aria-checked` rather than in a label that ended `: off`.
  assert.match(html, /id="autostart-toggle"[\s\S]{0,160}role="switch"/);
  assert.match(html, /id="autostart-toggle"[\s\S]{0,200}aria-checked="false"/);
  assert.match(app, /paintSwitch\(autostartButton/);
  assert.match(settings, /button\.setAttribute\('aria-checked'/);
});

test('N-WP12: the sentence about jumping is in About, and only in the shell', () => {
  // It used to sit in the sidebar's Desktop app group, where a browser never saw
  // it either. The group is gone; the sentence moved to About and kept the rule.
  assert.match(html, /id="shell-about"[^>]*hidden/);
  assert.match(app, /shellAbout\.hidden = false/);
});

test('the hint is a status, is styled, and goes away on its own', () => {
  assert.match(html, /id="hint"[\s\S]{0,80}role="status"/);
  assert.ok(css.includes('.nz-hint {'), 'the hint has no style, so it would land as raw text');
  assert.ok(css.includes('.nz-hint[hidden]'), 'a hidden hint must not take up space');
  assert.match(app, /window\.setTimeout\([\s\S]{0,80}hintNode\.hidden = true/);
  // It sits over the canvas; a hint that swallowed a click would break the next drag.
  assert.match(css, /\.nz-hint \{[\s\S]{0,700}pointer-events: none/);
});

test('both gestures reach the same jump, and the card menu entry only exists in the shell', () => {
  assert.match(app, /addEventListener\('dblclick'/);
  assert.match(app, /jumpToTerminal\(sessionId\)/);
  // The menu entry is conditional on the detection rather than on a disabled attribute.
  assert.match(app, /shell === undefined \? \{\} : \{ onJump:/);
  assert.match(tabbar, /this\.options\.onJump !== undefined/);
  assert.ok(css.includes('.nz-menu__item--jump'), 'the jump entry has no style of its own');
});

test('Enter on a focused card jumps, and Space is left to the page', () => {
  // The card is `tabindex="0"`, so it is a real keyboard stop; Enter is the double-click
  // and Space stays the scroll key.
  assert.match(app, /focused\.classList\.contains\('nz-session'\)/);
  assert.match(app, /if \(event\.key !== 'Enter'\) return;/);
});

test('a browser is told where the feature lives instead of nothing happening', () => {
  assert.match(shell, /jumpNeedsShell\(\): string \{/);
  assert.match(shell, /t\('hint.jumpNeedsShell'\)/);
  assert.match(app, /jumpNeedsShell\(\)/);
});

test('the jump outcome the canvas reads is the one the shell writes', () => {
  // Three files describe one JSON object and only this test compares them. `tab` is what
  // rung (b) added, and a field that exists on one side alone is a field the hint reads as
  // `undefined` for ever without anything failing.
  const jumpRs = readFileSync(path.join(desktopDir, 'src', 'jump.rs'), 'utf8');
  const tabOutcome = jumpRs.slice(jumpRs.indexOf('pub struct TabOutcome'));
  for (const field of [
    'matched',
    'title',
    'index',
    'window',
    'source',
    'tier',
    'ambiguous',
    'selected',
    'candidates',
    'reason',
  ]) {
    assert.match(
      tabOutcome,
      new RegExp(`pub ${field}:`),
      `apps/desktop/src/jump.rs has no TabOutcome.${field}`,
    );
    assert.match(shell, new RegExp(`readonly ${field}[?]?:`), `shell.ts has no TabOutcome.${field}`);
  }
  assert.match(jumpRs, /pub tab: Option<TabOutcome>/);
  assert.match(shell, /readonly tab\?: TabOutcome \| null/);
});

/**
 * WP4e. The maintainer reported seeing "a terminal open" during a jump. It cannot have
 * been a new one — every rung is a window handle and an accessibility call — but "cannot"
 * was a claim about code nobody was checking.
 *
 * `jump.rs` carries the Windows-only version of this gate, run by `cargo test`. This is
 * the cross-platform half: it runs in `npm test` on every machine, including the ones with
 * no Rust toolchain, and it also checks that the README says what a jump does, because the
 * report was really about an expectation.
 */
test('the jump raises windows and starts no process', () => {
  const jumpRs = readFileSync(path.join(desktopDir, 'src', 'jump.rs'), 'utf8');
  // The shipped half of the file: the test module below it names these markers in order
  // to forbid them, so scanning the whole file would fail on the gate itself.
  const shipped = jumpRs.split('#[cfg(test)]')[0] ?? '';
  assert.ok(shipped.length > 1000, 'the test-module split found nothing');

  for (const marker of [
    'Command::new',
    'process::Command',
    'CreateProcessW',
    'ShellExecute',
    'WinExec',
    '"wt.exe"',
  ]) {
    assert.equal(
      shipped.includes(marker),
      false,
      `apps/desktop/src/jump.rs contains ${marker}: the jump must start nothing`,
    );
  }
  // The one `spawn` in the file is a thread, and that is asserted rather than excluded by
  // a pattern — the difference between spawning a thread and spawning a process is the
  // whole of what this test is about.
  assert.equal(shipped.split('.spawn(').length - 1, 1);
  assert.ok(shipped.includes('std::thread::Builder::new()'));
  // And the Rust side runs the same gate, plus a live one, against a real machine.
  assert.match(jumpRs, /fn the_jump_path_contains_no_way_to_start_a_process/);
  assert.match(jumpRs, /fn nothing_that_looks_like_a_terminal_appears_while_the_jump_runs/);

  const readme = readFileSync(path.join(desktopDir, '..', '..', 'README.md'), 'utf8');
  assert.match(
    readme,
    /never opens a new terminal/,
    'the README has to say what a jump does, because the report was about an expectation',
  );
});

test('the /rename tip is guarded so it only appears where it would help', () => {
  // `web/shell.ts` cannot be imported here: it is compiled against the DOM lib and this
  // suite runs under Node's, so `jumpHint` is asserted the way the rest of this file
  // asserts — by reading it. What matters is the guard, because every clause of it is a
  // case where the advice would be wrong: a tab that *was* found, a terminal with one tab
  // that needed no finding, and a terminal that published no tabs at all and will not
  // start because a session was renamed.
  assert.match(shell, /t\('hint.tabNeedsAName'\)/);
  assert.match(shell, /if \(!tab \|\| tab\.matched \|\| tab\.candidates < 2\) return outcome\.message;/);
  assert.match(shell, /return `\$\{outcome\.message\} — \$\{tabNeedsAName\(\)\}`;/);
  assert.match(app, /showHint\(jumpHint\(outcome\)\)/, 'the canvas shows what jumpHint said');
});

test('a session opened from history is refused before its pid is used', () => {
  // A frozen session ended some time ago and its pid now belongs to whatever the machine
  // has started since. Raising a window for it would be raising the wrong one.
  assert.match(app, /const jumpToTerminal[\s\S]{0,200}if \(isFrozen\(\)\)/);
});

test('N-WP21: the canvas reads jumpSupported, and offers the jump only where it is true', () => {
  /*
   * `ShellInfo.jumpSupported` has been on the wire since WP8 and nothing read
   * it. Harmless while Windows was the only bundle, and a bug the day N-WP19a
   * shipped macOS and Linux ones: `jump.rs` is `cfg!(windows)` and its own doc
   * comment says *the canvas asks `supported()` before offering the entry*.
   *
   * The behaviour is driven in `test/dom/jump-gate.test.ts`; this is the half
   * that cannot be driven, because it lives in `app.ts`'s one big closure — the
   * three places the flag has to reach.
   */
  const jumpRs = readFileSync(path.join(desktopDir, 'src', 'jump.rs'), 'utf8');
  assert.match(jumpRs, /pub const fn supported\(\) -> bool \{\s*cfg!\(windows\)/);
  assert.match(mainRs, /jump_supported: jump::supported\(\)/);
  assert.match(shell, /readonly jumpSupported: boolean;/);

  // 1. It is read out of `shell_info` and held.
  assert.match(app, /jumpSupported = info\.jumpSupported;/);
  // 2. The gesture itself refuses, after the browser has had its hint: a shell
  //    that cannot jump is silent rather than apologising on every double-click.
  assert.match(app, /if \(!jumpSupported\) return;/);
  // 3. Both menus ask before they draw the entry.
  assert.equal(
    (app.match(/canJump: \(\) => jumpSupported,/g) ?? []).length,
    2,
    'the card menu and the Needs-you strip do not both ask',
  );
  assert.match(tabbar, /this\.options\.onJump !== undefined && this\.options\.canJump\?\.\(\) !== false/);
  // And the sentence in About goes with it — a shell that cannot jump has no
  // more use for "double-click a card" than a browser has.
  assert.match(app, /shellAbout\.hidden = !jumpSupported;/);
});
