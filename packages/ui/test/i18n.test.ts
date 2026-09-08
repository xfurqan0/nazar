/**
 * N-WP13: the six languages, and the two gates that keep them honest.
 *
 * The first is the one nazar-tray wrote (`ui/test/i18n.test.mjs` there, and
 * `docs/PROJECT.md` WP6: *two tests that grep the sources*): **no visible
 * string is written in code**. It greps `web/*.ts` and `index.html` for Latin
 * prose and fails on anything not in the allow-list. Without it a hard-coded
 * sentence looks perfectly right in English and is simply wrong in the other
 * five, which is exactly the kind of bug nobody who speaks English finds.
 *
 * The second is parity: the six files carry the same keys, the same
 * placeholders, and a complete set of plural forms for every counted key.
 *
 * The rest is the runtime — interpolation, the Russian plural rule, the
 * language guess, and the storage round-trip.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCALES_DIR, catalogs, localeText, readCatalog } from '../test/catalogs.ts';
import type { Locale } from '../src/i18n.ts';
import {
  FALLBACK_LOCALE,
  LOCALES,
  LOCALE_KEY,
  currentLocale,
  interpolate,
  isLocale,
  pluralCategory,
  pluralKey,
  primarySubtag,
  readLocaleChoice,
  resolveLocale,
  setLocale,
  t,
  tCount,
  writeLocaleChoice,
} from '../src/i18n.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');

const english = catalogs[FALLBACK_LOCALE];

/** Every key that carries a count, taken from the `.one/.few/.other` triples. */
function countedKeys(): string[] {
  const stems = new Set<string>();
  for (const key of Object.keys(english)) {
    const match = /^(.*)\.(one|few|other)$/.exec(key);
    if (match !== null) stems.add(match[1]!);
  }
  return [...stems].sort();
}

/* ------------------------------------------------------------------ *
 * The files themselves
 * ------------------------------------------------------------------ */

test('there are exactly six catalogues, and nothing else in the directory', () => {
  const files = readdirSync(LOCALES_DIR).sort();
  assert.deepEqual(files, ['README.md', 'en.json', 'es.json', 'ko.json', 'ru.json', 'tr.json', 'zh.json']);
  assert.deepEqual([...LOCALES].sort(), ['en', 'es', 'ko', 'ru', 'tr', 'zh']);
});

test('every value in every catalogue is a plain, non-empty, unpadded string', () => {
  /*
   * Not a style rule. `apps/desktop/src/i18n.rs` parses these same files as
   * `BTreeMap<String, String>` for the tray menu, and **one nested object makes
   * the whole file fail to parse** — silently, because a damaged translation
   * must not stop the shell from starting. That language would then quietly
   * fall back to English while still being offered in the picker.
   */
  for (const locale of LOCALES) {
    const catalog: unknown = JSON.parse(localeText(locale));
    assert.ok(
      typeof catalog === 'object' && catalog !== null && !Array.isArray(catalog),
      `${locale}.json is not a flat object`,
    );
    for (const [key, value] of Object.entries(catalog as Record<string, unknown>)) {
      assert.equal(typeof value, 'string', `${locale}.${key} is not a string`);
      const text = value as string;
      assert.ok(text.length > 0, `${locale}.${key} is empty — an invisible label`);
      assert.equal(text.trim(), text, `${locale}.${key} is padded with whitespace`);
    }
  }
});

test('the six carry exactly the same keys', () => {
  // English is the fallback, so a missing key would silently show the English
  // string and never be noticed by anybody reading the other language.
  const wanted = Object.keys(english).sort();
  for (const locale of LOCALES) {
    if (locale === FALLBACK_LOCALE) continue;
    assert.deepEqual(
      Object.keys(catalogs[locale]).sort(),
      wanted,
      `${locale}.json does not carry English's keys`,
    );
  }
});

test('the six carry the same placeholders, in whatever order they like', () => {
  const holes = (template: string): string[] =>
    [...template.matchAll(/\{(\w+)\}/g)].map((one) => one[1]!).sort();
  for (const locale of LOCALES) {
    if (locale === FALLBACK_LOCALE) continue;
    for (const [key, template] of Object.entries(english)) {
      assert.deepEqual(
        holes(catalogs[locale][key] ?? ''),
        holes(template),
        `${locale}.${key} does not fill the same holes as English`,
      );
    }
  }
});

test('every counted key has all three forms in all six languages', () => {
  const counted = countedKeys();
  assert.ok(counted.length > 5, `only ${counted.length} counted keys — the scan has broken`);
  for (const stem of counted) {
    for (const locale of LOCALES) {
      for (const form of ['one', 'few', 'other']) {
        assert.ok(
          catalogs[locale][`${stem}.${form}`] !== undefined,
          `${locale} has no ${form} form for ${stem}`,
        );
      }
      // A count with no number in it is a sentence that lies about a plural.
      assert.match(
        catalogs[locale][`${stem}.one`]!,
        /\{count\}/,
        `${locale}.${stem}.one prints no count`,
      );
    }
  }
});

test('a language names itself, and a product name is never translated', () => {
  // The picker's own words live in `web/lang.ts` and not in the catalogues,
  // because somebody looking for their language wants to read it in their
  // language — `Korean` spelled in Russian helps nobody.
  const picker = readFileSync(path.join(webDir, 'lang.ts'), 'utf8');
  for (const own of ['English', 'Türkçe', '中文', '한국어', 'Русский', 'Español']) {
    assert.ok(picker.includes(own), `the picker does not name ${own}`);
  }
  for (const locale of LOCALES) {
    assert.match(catalogs[locale]['bar.demo']!, /.+/);
    for (const brand of ['Nazar', 'nazar-tray', 'Claude']) {
      const uses = Object.values(catalogs[locale]).filter((line) => line.includes(brand));
      assert.ok(uses.length > 0, `${locale} never writes ${brand}`);
    }
  }
});

test('N-WP13b: the picker lists the six languages and nothing else', () => {
  /*
   * The report was one line — *there will be no "follow the system" in the
   * language option* — and it is a test rather than a deletion because the
   * entry can come back from three separate directions: a seventh row in the
   * name table, a second `append` beside the loop that walks the six, or a
   * catalogue key that hands somebody a word to draw it with.
   */
  const picker = readFileSync(path.join(webDir, 'lang.ts'), 'utf8');
  const from = picker.indexOf('LANGUAGE_NAMES');
  const table = picker.slice(from, picker.indexOf('}', from));
  const named = [...table.matchAll(/^\s+(\w+):/gm)].map((one) => one[1]!);
  assert.deepEqual(named, [...LOCALES], 'the picker names something that is not one of the six');

  // One button per language, and the loop that walks `LOCALES` is the only
  // place an option can come from.
  assert.match(picker, /for \(const locale of LOCALES\) \{/);
  assert.equal(
    (picker.match(/root\.append\(/g) ?? []).length,
    1,
    'the picker appends an option somewhere other than the loop over the six',
  );
  assert.equal(picker.includes("'system'"), false, 'system is a choice in the picker again');

  // And no catalogue carries a word for it any more: `settings.language` is the
  // heading and `settings.languageNote` the paragraph under it, so anything
  // *below* `settings.language.` is an entry in the list.
  for (const locale of LOCALES) {
    const strays = Object.keys(catalogs[locale]).filter((key) =>
      key.startsWith('settings.language.'),
    );
    assert.deepEqual(strays, [], `${locale} still translates a picker entry that is not a language`);
  }
});

/* ------------------------------------------------------------------ *
 * The sweep: no visible string is written in code
 * ------------------------------------------------------------------ */

/**
 * Runs of Latin prose that are not user-visible text.
 *
 * Every entry is a *category*, not an exception for one string: class names,
 * DOM and CSS vocabulary, message keys themselves, storage keys, addresses, and
 * the product names a translated catalogue would not translate either.
 */
const ALLOWED = [
  /^[\w$-]*$/, // one bare word: a class, an id, an attribute, a property
  /^[\w-]+(?:\s+[\w-]+)*$/u, // several — `nz-note is-current`, `M 4 7 L 9 12`
  /^[\d\s.,%:;/#()+-]*$/, // pure geometry and numbers
  /^[a-z][\w.]*\.[\w.]+$/, // a message key: `card.metaLive`
  /^[.#]?nz-/, // a class name or a selector for one
  /^nazar[.-]/, // a storage key, an id prefix
  /^--nz-/, // a custom property
  /^https?:\/\//, // an address
  /^[.\w/-]+\.(?:ts|json|css|html|mjs)$/, // a module specifier
  /^@[\w/-]+$/, // a package name
  /^\/api\//, // an endpoint
  /^[\w-]+\/[\w-]+$/, // a MIME type or a path fragment
  /^[a-z-]+(?::\s*[\w%.-]+)?$/, // a CSS declaration: `pointer-events: none`
  /^[[#.][\w[\]"=.-]*$/, // a selector: `[data-action="menu"]`, `#history`
  /^\s*[\w-]+(?:\s+[\w-]+)*\s*$/, // a class list with padding: ` nz-resize__grip--edge`
  /^[a-z]+\([\d\s,.-]*\)$/, // an SVG transform: `translate(0,42)`
  /^assets\//, // a shipped asset
];

/** Is this literal something a user could read? */
function looksVisible(text: string): boolean {
  if (text.length < 4) return false;
  if (!/[A-Za-z]{2}/.test(text)) return false;
  return !ALLOWED.some((pattern) => pattern.test(text));
}

test('N-WP13: no page module writes a user-visible string of its own', () => {
  /*
   * The gate nazar-tray's WP6 wrote, in Nazar's shape. It reads the page
   * modules — the ten files under `web/` — and fails on a quoted run of prose
   * that is not obviously a class name, a key, an address or a number.
   *
   * `t(...)` calls are stripped first, because the key inside one *is* a
   * literal and is exactly what should be there.
   */
  const files = readdirSync(webDir)
    .filter((name) => name.endsWith('.ts'))
    // The one module that holds words on purpose: `LANGUAGE_NAMES` is what each
    // language calls itself, which is the same in all six catalogues — so it is
    // in none of them. The test above is what checks it is complete.
    .filter((name) => name !== 'lang.ts');
  assert.ok(files.length >= 10, `only ${files.length} page modules — the scan has broken`);
  const offences: string[] = [];
  for (const name of files) {
    const source = readFileSync(path.join(webDir, name), 'utf8')
      // comments carry English on purpose: they are for whoever reads the code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      // a module specifier is an address, not a sentence
      .replace(/from\s*'[^']*'/g, '')
      .replace(/import\s*'[^']*'/g, '');
    for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
      const text = match[1]!;
      if (looksVisible(text)) offences.push(`${name}: '${text}'`);
    }
  }
  assert.deepEqual(offences, [], 'these strings must come from the catalogues');
});

test('N-WP13: the page markup carries no words either', () => {
  /*
   * Every visible string in `index.html` was replaced by a `data-nz-*`
   * attribute naming a message key, and `web/lang.ts` writes them. What is left
   * between tags is punctuation, a product name, and the two glyphs that are
   * the same in every language.
   */
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '');
  const words: string[] = [];
  for (const match of body.matchAll(/>([^<>]+)</g)) {
    const text = match[1]!.trim();
    if (text.length === 0) continue;
    // The product's own name, the command it prints, and the one key cap.
    if (['Nazar', 'nazar doctor', 'Enter', 'claude', '⋯'].includes(text)) continue;
    // An address is not a sentence, and a translated one would not resolve.
    if (/^[\w.-]+\.[a-z]{2,}\//.test(text)) continue;
    if (looksVisible(text)) words.push(text);
  }
  assert.deepEqual(words, [], 'index.html still says these words itself');

  // And no `title`, `aria-label` or `placeholder` written as English either.
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    const written = [...html.matchAll(new RegExp(`\\s${attribute}="([^"]+)"`, 'g'))].map(
      (one) => one[1]!,
    );
    assert.deepEqual(
      written.filter(looksVisible),
      [],
      `index.html writes ${attribute} in English instead of naming a key`,
    );
  }
});

test('N-WP13: every key the page names exists in English', () => {
  const named = new Set<string>();
  for (const match of html.matchAll(/data-nz-(?:t|title|label|rich)="([\w.]+)"/g)) {
    named.add(match[1]!);
  }
  assert.ok(named.size > 20, `only ${named.size} keys in the markup — the scan has broken`);
  for (const key of named) {
    assert.ok(english[key] !== undefined, `index.html names ${key}, which no catalogue defines`);
  }
});

test('N-WP13: a rich line fills its slots from its own children', () => {
  // `Nazar 0.1.0 — empty canvas? Run `nazar doctor` in a terminal` has a version
  // and a `<code>` inside the sentence. Splitting it into "before" and "after"
  // halves would nail English's word order into the markup.
  for (const match of html.matchAll(/data-nz-rich="([\w.]+)"([\s\S]*?)<\/p>/g)) {
    const [, key, inner] = match;
    const slots = [...inner!.matchAll(/data-nz-slot="(\w+)"/g)].map((one) => one[1]!);
    const holes = [...english[key!]!.matchAll(/\{(\w+)\}/g)].map((one) => one[1]!);
    for (const hole of holes) {
      assert.ok(slots.includes(hole), `${key} has a {${hole}} that no child fills`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The runtime
 * ------------------------------------------------------------------ */

test('a placeholder is filled, and one with no value is left visible', () => {
  assert.equal(interpolate('{a} and {b}', { a: 1, b: 2 }), '1 and 2');
  assert.equal(
    interpolate('{a} and {b}', { a: 1 }),
    '1 and {b}',
    'a missing value must be visible, not silently blank',
  );
  assert.equal(interpolate('nothing to fill'), 'nothing to fill');
  assert.equal(interpolate('{unclosed', { unclosed: 1 }), '{unclosed');
});

test('a key nobody wrote reads as the key', () => {
  assert.equal(t('nothing.like.this'), 'nothing.like.this');
});

test('a language falls back to English rather than to a gap', () => {
  try {
    setLocale('tr');
    assert.equal(t('state.working'), 'çalışıyor');
    assert.equal(currentLocale(), 'tr');
    for (const locale of LOCALES) {
      setLocale(locale);
      assert.ok(t('settings.title').length > 0, `${locale} has no word for Settings`);
    }
  } finally {
    setLocale(FALLBACK_LOCALE);
  }
});

test('Russian takes three plural forms and the others take one or two', () => {
  // 1, then 2–4, then 5 and up, with the teens 11–14 in neither of the first two.
  assert.equal(pluralCategory(1, 'ru'), 'one');
  assert.equal(pluralCategory(21, 'ru'), 'one');
  assert.equal(pluralCategory(2, 'ru'), 'few');
  assert.equal(pluralCategory(24, 'ru'), 'few');
  assert.equal(pluralCategory(5, 'ru'), 'other');
  assert.equal(pluralCategory(11, 'ru'), 'other');
  assert.equal(pluralCategory(112, 'ru'), 'other', 'the teens are taken out at every hundred');
  assert.equal(pluralCategory(122, 'ru'), 'few');
  assert.equal(pluralCategory(111, 'ru'), 'other');
  for (const locale of ['en', 'es'] as const) {
    assert.equal(pluralCategory(1, locale), 'one');
    assert.equal(pluralCategory(0, locale), 'other');
    assert.equal(pluralCategory(2, locale), 'other');
  }
  for (const locale of ['tr', 'zh', 'ko'] as const) {
    assert.equal(pluralCategory(1, locale), 'other', `${locale} needs no plural rule`);
    assert.equal(pluralCategory(5, locale), 'other');
  }
  assert.equal(pluralKey('bar.sessions', 1, 'en'), 'bar.sessions.one');
  assert.equal(pluralKey('bar.sessions', 3, 'ru'), 'bar.sessions.few');
});

test('a counted word picks its form and fills its count', () => {
  try {
    setLocale('en');
    assert.equal(tCount('bar.sessions', 1, { count: '1' }), '1 session');
    assert.equal(tCount('bar.sessions', 4, { count: '4' }), '4 sessions');
    setLocale('ru');
    assert.equal(tCount('bar.sessions', 1, { count: '1' }), '1 сессия');
    assert.equal(tCount('bar.sessions', 3, { count: '3' }), '3 сессии');
    assert.equal(tCount('bar.sessions', 8, { count: '8' }), '8 сессий');
  } finally {
    setLocale(FALLBACK_LOCALE);
  }
});

test('the language is the stored choice, then the machine, then English', () => {
  assert.equal(resolveLocale('tr', ['en-GB']), 'tr', "the user's choice wins");
  assert.equal(resolveLocale(undefined, ['tr-TR']), 'tr', "then the machine's");
  assert.equal(resolveLocale(undefined, []), 'en', 'and English is the floor');
  assert.equal(
    resolveLocale(undefined, ['de-DE', 'ru']),
    'ru',
    'a language nobody translated is skipped rather than selected',
  );
  assert.equal(resolveLocale('TR_tr', []), 'tr', 'tags are normalised');
  assert.equal(primarySubtag('zh-Hans-CN'), 'zh');
  for (const locale of LOCALES) {
    assert.equal(resolveLocale(locale, []), locale, 'every offered language is selectable');
    assert.ok(isLocale(locale));
  }
  assert.equal(isLocale('de'), false);
});

test('the stored choice round-trips, and a value this build cannot paint is no choice', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => void store.set(key, value),
    removeItem: (key: string): void => void store.delete(key),
  };
  assert.equal(readLocaleChoice(storage), undefined, 'no choice means follow the machine');
  writeLocaleChoice(storage, 'ko');
  assert.equal(store.get(LOCALE_KEY), 'ko');
  assert.equal(readLocaleChoice(storage), 'ko');
  // A tag a later version dropped must not strand somebody on message keys.
  store.set(LOCALE_KEY, 'de');
  assert.equal(readLocaleChoice(storage), undefined);
  // N-WP13b: and neither must the word a build before it could write here, back
  // when *follow the machine* was an entry in the picker. It is not a language,
  // so it is not a choice, so the machine decides — which is what it meant.
  store.set(LOCALE_KEY, 'system');
  assert.equal(readLocaleChoice(storage), undefined, 'an old `system` is read as a language');
  assert.equal(resolveLocale(readLocaleChoice(storage), ['ru-RU']), 'ru');
  assert.equal(readLocaleChoice(undefined), undefined);
});

test("N-WP13b: nothing stored still opens in the machine's language", () => {
  /*
   * The entry left the picker; the behaviour it named did not. An untouched
   * Nazar reads `navigator.languages` and paints itself in the first language
   * it has a catalogue for — the picker simply shows that language ticked,
   * rather than showing *system* ticked and the language beside it not.
   */
  const empty = {
    getItem: (): string | null => null,
    setItem: (): void => {},
    removeItem: (): void => {},
  };
  assert.equal(readLocaleChoice(empty), undefined);
  assert.equal(resolveLocale(readLocaleChoice(empty), ['ko-KR', 'en-US']), 'ko');
  assert.equal(resolveLocale(readLocaleChoice(empty), ['de-DE']), 'en', 'English is the floor');
  // Whatever it resolves to is one of the six, so the picker always has exactly
  // one option to tick — which is what makes a seventh entry unnecessary.
  for (const machine of [['tr-TR'], ['zh-Hans-CN'], ['es-MX', 'fr'], []]) {
    assert.ok(LOCALES.includes(resolveLocale(readLocaleChoice(empty), machine)));
  }
});

test('the shell reads the same four keys the tray menu needs', () => {
  // `apps/desktop/src/i18n.rs` compiles these very files in with `include_str!`,
  // so a key it draws and a catalogue lacks would be an English word in an
  // otherwise Korean tray.
  const rust = readFileSync(
    path.join(here, '..', '..', '..', 'apps', 'desktop', 'src', 'i18n.rs'),
    'utf8',
  );
  const used = [...rust.matchAll(/\.text\("([\w.]+)"\)/g)]
    .map((one) => one[1]!)
    // The one deliberate non-key in those sources: its own test proves an
    // unknown key renders as itself.
    .filter((key) => key !== 'nothing.like.this');
  assert.ok(used.length >= 4, `the scan found only ${used.length} keys in the shell`);
  for (const key of used) {
    for (const locale of LOCALES) {
      assert.ok(catalogs[locale][key] !== undefined, `${locale} does not translate ${key}`);
    }
  }
  // And it reads the shipped files rather than keeping a table of its own.
  for (const locale of LOCALES) {
    assert.ok(
      rust.includes(`../../../packages/ui/locales/${locale}.json`),
      `the shell does not compile in ${locale}.json`,
    );
  }
});

test('every language v1 ships is left to right', () => {
  // Adding Arabic, Hebrew, Persian or Urdu is more than a JSON file: it needs a
  // direction table in `src/i18n.ts` and an audit of `web/styles.css`, which
  // still uses physical `margin-left` and `text-align: right` in a dozen places.
  const rtl = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd']);
  for (const locale of LOCALES as readonly Locale[]) {
    assert.equal(rtl.has(locale), false, `${locale} is right-to-left and the stylesheet is not`);
  }
  const css = readFileSync(path.join(webDir, 'styles.css'), 'utf8');
  assert.ok(css.includes('margin-left') || css.includes('text-align: right'), 'the audit is real');
  assert.equal(readCatalog('en')['word.unknown'], 'unknown');
});
