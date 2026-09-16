/**
 * N-WP-L7: a Linux shell that cannot jump says *which* no.
 *
 * Before this, every platform without a jump got one sentence — *jumping to a terminal
 * is not available on this platform yet* — and on Wayland that sentence was wrong twice
 * over. *Yet* promised a later version where double-clicking a card raises a terminal,
 * and there will not be one: the protocol does not let a client raise another client's
 * window, by design. And it told the user nothing they could act on, when there is
 * something — their terminal's own window switcher.
 *
 * So the shell now names the display server (`apps/desktop/src/jump.rs`), the canvas
 * turns that one word into a key, and the key picks a sentence out of the catalogues
 * like every other sentence on the page. This drives the mapping and reads the sentences
 * it lands on: the two session types must not get the same one, and neither may be the
 * generic sentence the mapping is there to replace.
 *
 * `web/shell.ts` is imported rather than grepped, which is why this suite lives here
 * rather than in `test/shell.test.ts`: that file is compiled against Node's lib and this
 * directory is the one with the DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LOCALES, setLocale, t } from '../../src/i18n.ts';
import { catalogs } from '../catalogs.ts';
import { jumpBlockedKey } from '../../web/shell.ts';

test('the two Linux session types are refused in different words', () => {
  assert.equal(jumpBlockedKey('wayland'), 'about.jump.wayland');
  assert.equal(jumpBlockedKey('x11'), 'about.jump.x11');

  const wayland = t('about.jump.wayland');
  const x11 = t('about.jump.x11');
  assert.notEqual(wayland, x11);

  // Wayland: the compositor is the thing saying no, and it always will be. A sentence
  // that ends in "yet" here is a promise nobody can keep.
  assert.match(wayland, /compositor/i);
  assert.ok(!/ yet[.\s]/i.test(wayland), `Wayland is not a port that is coming: ${wayland}`);
  // X11: a port nobody has written, which is a different thing and reads like one.
  assert.match(x11, /X11/);
  assert.match(x11, /yet/i);
});

test('a shell with nothing to add gets no sentence at all', () => {
  // Windows (the jump works), macOS (*not yet* is the whole of it), a Linux session that
  // would not say what it is running on, and an older shell whose `shell_info` predates
  // the field. Each of these leaves the canvas doing exactly what it did before N-WP-L7.
  assert.equal(jumpBlockedKey(undefined), undefined);
  assert.equal(jumpBlockedKey(null), undefined);
  assert.equal(jumpBlockedKey(''), undefined);
  // Not a prefix match and not a case fold: the shell sends one of two words, and a
  // canvas that accepted "Wayland-ish" would be inventing a contract of its own.
  assert.equal(jumpBlockedKey('Wayland'), undefined);
  assert.equal(jumpBlockedKey('wayland-0'), undefined);
  assert.equal(jumpBlockedKey('mir'), undefined);
});

test('both sentences are in all six catalogues, and the page reads the right one', () => {
  /*
   * Read out of the catalogues rather than through `t`, which falls back to English
   * rather than to a gap: a language missing both keys would answer in English and pass
   * a test that only asked whether a sentence came back.
   */
  for (const locale of LOCALES) {
    const catalog = catalogs[locale];
    for (const key of ['about.jump.wayland', 'about.jump.x11']) {
      const sentence = catalog[key];
      assert.ok(sentence !== undefined && sentence.length > 0, `${locale} has no ${key}`);
    }
    assert.notEqual(
      catalog['about.jump.wayland'],
      catalog['about.jump.x11'],
      `${locale} says the same thing for both`,
    );
  }

  // And the lookup the canvas actually makes lands in the language in force, because the
  // refusal is a sentence like any other and a Turkish canvas must not answer in English.
  setLocale('tr');
  try {
    assert.equal(t(jumpBlockedKey('wayland')!), catalogs.tr['about.jump.wayland']);
    assert.notEqual(t(jumpBlockedKey('wayland')!), catalogs.en['about.jump.wayland']);
  } finally {
    setLocale('en');
  }
});
