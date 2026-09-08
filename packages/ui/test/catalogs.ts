/**
 * The six catalogues, read off disk for the tests. Not a suite — a helper.
 *
 * The browser gets them through `web/locales.ts`, which imports the JSON and
 * lets esbuild inline it. Node has no such import here (`packages/ui`'s build is
 * rooted at `src/`, so nothing under it may reach `../locales`), and reading the
 * files is the better contract for a test anyway: it proves the shipped files
 * parse, rather than a copy of them compiled in.
 *
 * Importing this module installs English and returns the page to English —
 * every suite that asserts on a word gets a known language, whichever one ran
 * before it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Catalog, Catalogs, Locale } from '../src/i18n.ts';
import { FALLBACK_LOCALE, LOCALES, installCatalogs, setLocale } from '../src/i18n.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the six files live, for the tests that check the directory itself. */
export const LOCALES_DIR = path.join(here, '..', 'locales');

/** The raw text of one catalogue. */
export function localeText(locale: Locale | string): string {
  return readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8');
}

/** One catalogue, parsed. Throws on a file that is not flat JSON. */
export function readCatalog(locale: Locale | string): Catalog {
  const parsed: unknown = JSON.parse(localeText(locale));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${locale}.json is not an object`);
  }
  return parsed as Catalog;
}

/** Every catalogue, parsed. */
export const catalogs: Catalogs = Object.fromEntries(
  LOCALES.map((locale) => [locale, readCatalog(locale)]),
) as Catalogs;

installCatalogs(catalogs);
setLocale(FALLBACK_LOCALE);
