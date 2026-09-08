/**
 * N-WP13: the whole i18n runtime — a catalogue lookup, `{placeholder}`
 * substitution, a language guess and a plural rule.
 *
 * The shape is nazar-tray's (`ui/src/i18n.ts` in that repo), adapted rather
 * than copied. What is the same, because it was right there: flat key/value
 * JSON files with `{name}` placeholders, English behind every miss, a key
 * printed as itself when nobody wrote it, and a hand-written plural rule
 * instead of `Intl.PluralRules`. What is different is below.
 *
 * **The chosen language is module state, and that is a decision.** The tray
 * threads a `Translate` through its render functions; Nazar's canvas builds
 * text in about a dozen modules and four of them are pure helpers with their
 * own unit tests (`format.ts`, `quota-strip.ts`, `hidden.ts`, `colours.ts`).
 * Threading a translator through those would have put an argument on forty
 * signatures to express one fact — *this page is in one language at a time* —
 * that is genuinely global. So the language lives here, `t()` reads it, and
 * changing it is one call followed by a redraw.
 *
 * **The catalogues are installed rather than imported.** This module is
 * compiled for the package as well as bundled for the browser, and
 * `packages/ui/tsconfig.json` roots its build at `src/`, so it cannot reach
 * `../locales`. The browser half (`web/locales.ts`) imports the six JSON files
 * and installs them before the first frame; the tests read the same files off
 * disk and install them too. With nothing installed `t()` returns the key,
 * which is loud rather than blank — and is what the parity tests assert on.
 *
 * **Flat strings only.** Every value in a locale file is a string. Not a
 * stylistic rule: `apps/desktop/src/i18n.rs` parses the same files as
 * `BTreeMap<String, String>` for the tray menu and the window title, and one
 * nested object anywhere makes the whole file fail to parse — silently, because
 * a damaged translation must not stop the shell from starting. So that language
 * would quietly fall back to English. The translation status therefore lives in
 * `locales/README.md` and not in a `_meta` key inside the files.
 *
 * **Writing direction.** All six languages v1 ships are left to right, so the
 * page sets `<html lang>` and never `dir`. Adding Arabic, Hebrew or Persian
 * means a direction table here *and* an audit of `web/styles.css`, which still
 * uses physical `margin-left` and `text-align: right` in a dozen places;
 * `i18n.test.ts` fails if an RTL tag is added to {@link LOCALES} before that
 * work is done.
 */

/** Every language v1 ships, in the order the picker lists them. */
export const LOCALES = ['en', 'tr', 'zh', 'ko', 'ru', 'es'] as const;

/** One of {@link LOCALES}. */
export type Locale = (typeof LOCALES)[number];

/** The language every missing string falls back to. */
export const FALLBACK_LOCALE: Locale = 'en';

/** Where the chosen language is kept. Absent until somebody picks one. */
export const LOCALE_KEY = 'nazar.locale.v1';

/** A flat map of message key to message template. */
export type Catalog = Readonly<Record<string, string>>;

/** Every catalogue, keyed by language. */
export type Catalogs = Readonly<Record<Locale, Catalog>>;

/** Values substituted into `{placeholder}` slots. */
export type Params = Readonly<Record<string, string | number>>;

/** Narrow an arbitrary string to a language this build can paint itself in. */
export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** The primary subtag of a language tag: `tr-TR` and `TR_tr` both become `tr`. */
export function primarySubtag(tag: string): string {
  return (tag.split(/[-_]/)[0] ?? '').toLowerCase();
}

/**
 * Replace `{name}` with `params.name`.
 *
 * A placeholder with no matching parameter is left as written rather than
 * blanked, so a missing value shows up as `{count}` on screen instead of
 * disappearing quietly.
 */
export function interpolate(template: string, params?: Params): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/* ------------------------------------------------------------------ *
 * Plurals
 * ------------------------------------------------------------------ */

/** The plural category a count falls into, for the languages this product ships. */
export type PluralCategory = 'one' | 'few' | 'other';

/**
 * The plural category of `count` in `locale`.
 *
 * Three of the six need no rule at all — Chinese, Korean and Turkish leave a
 * noun alone after a numeral — English and Spanish need two forms, and Russian
 * needs the three the grammar books give: **1** (`one`), **2–4** (`few`), **5
 * and up** (`other`), with the teens 11–14 taken out of both, so 21 is `one`
 * and 111 is `other`.
 *
 * `Intl.PluralRules` would answer the same question and is deliberately not
 * used: it would put a shipped string at the mercy of the WebView2 version on
 * the user's machine, and `apps/desktop/src/i18n.rs` has no `Intl` to agree
 * with. Fifteen lines both halves can read is the cheaper contract.
 */
export function pluralCategory(count: number, locale: Locale): PluralCategory {
  const n = Math.abs(Math.trunc(count));
  if (locale === 'ru') {
    const tens = n % 100;
    const units = n % 10;
    if (tens >= 11 && tens <= 14) return 'other';
    if (units === 1) return 'one';
    if (units >= 2 && units <= 4) return 'few';
    return 'other';
  }
  if (locale === 'en' || locale === 'es') return n === 1 ? 'one' : 'other';
  return 'other';
}

/**
 * The message key for a counted word, chosen by the count.
 *
 * Nazar has real counted **words** where the tray had only unit abbreviations —
 * *3 sessions*, *1 subagent*, *2 finished subagents hidden* — so unlike the
 * tray this helper is used, and used from the first day. A key `x.sessions`
 * becomes `x.sessions.one`, `x.sessions.few` or `x.sessions.other`, and every
 * catalogue carries all three for every counted key: `i18n.test.ts` fails on a
 * key whose forms are not complete, in any language, including the ones whose
 * three forms are the same word.
 */
export function pluralKey(key: string, count: number, locale: Locale): string {
  return `${key}.${pluralCategory(count, locale)}`;
}

/* ------------------------------------------------------------------ *
 * The chosen language
 * ------------------------------------------------------------------ */

const EMPTY: Catalog = {};

let catalogs: Catalogs | undefined;
let locale: Locale = FALLBACK_LOCALE;

/** Bind the six catalogues. Called once, before the first frame. */
export function installCatalogs(next: Catalogs): void {
  catalogs = next;
}

/** The language in force. */
export function currentLocale(): Locale {
  return locale;
}

/** Switch language. `true` when it actually moved, which is what asks for a redraw. */
export function setLocale(next: Locale): boolean {
  if (next === locale) return false;
  locale = next;
  return true;
}

/**
 * The language the page is in: the stored choice, then the browser's list, then English.
 *
 * A tag no catalogue answers for falls through rather than being selected, so a
 * machine set to German gets an English page instead of a page full of message
 * keys. Only the primary subtag is compared: there is one Spanish here, not
 * `es-MX` and `es-ES`.
 */
export function resolveLocale(
  chosen: string | undefined,
  preferred: readonly string[] = [],
): Locale {
  for (const tag of chosen === undefined ? preferred : [chosen, ...preferred]) {
    const primary = primarySubtag(tag);
    if (isLocale(primary)) return primary;
  }
  return FALLBACK_LOCALE;
}

/**
 * The message for a key, with its placeholders filled in.
 *
 * Lookup order is the chosen language, then English, then the key itself.
 * Returning the key makes an untranslated string obvious on screen — a menu
 * entry reading `menu.jump` — instead of rendering as a gap nobody notices.
 */
export function t(key: string, params?: Params): string {
  const chosen = catalogs?.[locale] ?? EMPTY;
  const fallback = catalogs?.[FALLBACK_LOCALE] ?? EMPTY;
  return interpolate(chosen[key] ?? fallback[key] ?? key, params);
}

/** {@link t}, for a counted word: picks the form and fills `{count}` in. */
export function tCount(key: string, count: number, params?: Params): string {
  return t(pluralKey(key, count, locale), { count, ...params });
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/** The sliver of `localStorage` this module uses. Mirrors `workspace.ts`. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The stored choice, or `undefined` when nobody has picked a language yet.
 *
 * Only the primary subtag is ever stored, and **anything this build cannot
 * paint itself in is read as no choice at all** rather than kept. That covers
 * two cases with one rule: a language dropped from a later version must not
 * leave somebody stuck on message keys, and a build before N-WP13b could write
 * the word `system` here — the picker offered *follow the machine* as if it
 * were a seventh language. It no longer does, and the value it left behind
 * means what it always meant: resolve the language from the machine.
 */
export function readLocaleChoice(storage: StorageLike | undefined): Locale | undefined {
  if (storage === undefined) return undefined;
  const raw = storage.getItem(LOCALE_KEY);
  if (raw === null) return undefined;
  const primary = primarySubtag(raw);
  return isLocale(primary) ? primary : undefined;
}

/**
 * Store the picked language.
 *
 * There is no way back to *follow the machine* because there is nothing to go
 * back to: following the machine is what an empty key already means, and the
 * picker has no entry that would clear it.
 */
export function writeLocaleChoice(storage: StorageLike | undefined, choice: Locale): void {
  if (storage === undefined) return;
  try {
    storage.setItem(LOCALE_KEY, choice);
  } catch {
    // Storage can be blocked. The choice simply does not survive a reload.
  }
}
