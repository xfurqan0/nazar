/**
 * The six catalogues, bundled into the page.
 *
 * Bundled rather than fetched: the six files together are a few tens of
 * kilobytes, and a canvas that fetched its own words would show a page of
 * message keys for a frame on a slow disk — and would need a network call the
 * moment somebody switched language. They are the same files
 * `apps/desktop/src/i18n.rs` compiles in with `include_str!`, so the tray menu
 * and the canvas cannot drift apart.
 *
 * This is the only file that names them, and it lives in `web/` rather than in
 * `src/` for one mechanical reason: `packages/ui/tsconfig.json` roots the
 * package build at `src/`, so a module there cannot import `../locales`.
 */
import type { Catalogs } from '../src/i18n.ts';
import en from '../locales/en.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import ru from '../locales/ru.json';
import tr from '../locales/tr.json';
import zh from '../locales/zh.json';

export const catalogs: Catalogs = { en, tr, zh, ko, ru, es };
