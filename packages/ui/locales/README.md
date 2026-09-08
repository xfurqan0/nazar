# Translations

Six languages, one flat JSON file each, and **one copy of each file**. The canvas bundles
them with esbuild (`web/locales.ts`) and the desktop shell compiles the very same paths in
with `include_str!` (`apps/desktop/src/i18n.rs`), so the tray menu and the canvas cannot
drift apart. There is no translation table anywhere in the Rust sources.

**Corrections are welcome as pull requests.** English and Turkish were written by hand;
Chinese, Korean, Russian and Spanish were machine-translated first, and none of the four has
been reviewed by a native speaker yet. If something reads badly to you, that is not a
nuisance — it is the thing this table is for.

## Status

| File | Language | Written by | Reviewed by a speaker |
|---|---|---|---|
| `en.json` | English | maintainer | — (source language) |
| `tr.json` | Türkçe | maintainer | maintainer (native) |
| `zh.json` | 中文 (简体) | machine-translated, N-WP13 | not yet |
| `ko.json` | 한국어 | machine-translated, N-WP13 | not yet |
| `ru.json` | Русский | machine-translated, N-WP13 | not yet |
| `es.json` | Español | machine-translated, N-WP13 | not yet |

The status lives in this table rather than in a `_meta` key inside the files, and that is a
finding rather than a preference. `apps/desktop/src/i18n.rs` parses each file as
`BTreeMap<String, String>`; a nested object makes the **whole file** fail to parse, and the
failure is deliberately silent — a damaged translation must not stop the shell from starting
— so the language would quietly fall back to English while still being offered in the picker.
Keep every value a string.

## Fixing a translation

1. Edit the string in `packages/ui/locales/<lang>.json`. Nothing else needs to change: the
   sidebar, the cards, the menus and the tray menu all read these files, and none of them
   has a copy of a word.
2. `npm test` — the checks below run in `packages/ui/test/i18n.test.ts`.
3. `cargo test -p nazar-desktop` — the shell checks the same files from its own side.
4. Open a pull request. Say which language you speak; that is what moves a row in the table
   above from *not yet* to reviewed.

## The rules a locale file has to keep

Each of these is a test, so getting one wrong fails the build rather than reaching a user.

- **Exactly English's keys.** A missing key fails; so does an invented one. English is the
  fallback, so a missing key would silently show the English string and never be noticed by
  anybody reading the other language.
- **No empty and no padded values.** A blank string is an invisible label.
- **The same placeholders.** `{count}`, `{name}`, `{folder}`, `{duration}`, `{session}` and
  the rest. A placeholder with no value is printed as written — `{count}` on somebody's
  screen — rather than blanked, so a typo is loud. They may be **reordered** freely; that is
  most of what translating these strings is.
- **Three plural forms for every counted key**, in every language, even where all three are
  the same word. The rule is Russian's — **1**, then **2–4**, then **5 and up**, with the
  teens 11–14 in neither of the first two — and `pluralCategory` in `packages/ui/src/i18n.ts`
  implements exactly that. English and Spanish use two of the three; Turkish, Chinese and
  Korean leave a noun alone after a numeral and use `other` for all of them. **Every `one`
  form must contain `{count}`**: a sentence that writes "1" in words is a sentence that lies
  the moment another language reuses it.
- **Product names are left alone**: `Nazar`, `nazar-tray`, `nazar doctor`, `Claude`,
  `Claude Code`, `Codex`, `statusLine`, `cleanupPeriodDays`, `/rename`. A translated brand
  is the wrong brand, and a translated command does not run.
- **Language names are not in these files at all.** `English`, `Türkçe`, `中文`, `한국어`,
  `Русский`, `Español` live in `packages/ui/web/lang.ts`, because a picker is read by
  somebody looking for **their own** language in it — the same six words in all six files
  would be six copies of one fact.
- **Flat strings only.** See above.

## Numbers, units and plurals

Durations, byte sizes, token counts and timestamps are **not** translated: they are formatted
by `packages/ui/src/format.ts` and `history-view.ts` in one shape everywhere — `2h 14m`,
`159,283`, `2026-09-08 21:40`. The *words around* them are the catalogue's; the numbers are
not. That is deliberate: a monitoring canvas is read at a glance and next to other tools that
print the same numbers, and a locale-swapped thousands separator makes two readings of one
machine look like two machines.

Percent signs follow the language: Turkish writes `%88`, Chinese and Korean write `88%` with
no space, English, Russian and Spanish write `88 %`.

## What is deliberately **not** translated

- **Anything the machine said about itself.** A session's name, a folder path, a model id, a
  process status, a `waitingFor` string, and the desktop shell's own sentence about which
  window it found (`apps/desktop/src/jump.rs`). No catalogue can know in advance what a
  machine will say.
- **Demo data.** The `?demo=1` canvas's sessions, folders, card names and sticky notes live
  in `packages/ui/src/demo.ts` and are fixtures, not interface — the same category as a real
  session's name.
- **The command line.** `bin/nazar.mjs`, `nazar doctor` and `--print` answer in English.
  Standard output is a maintainer's surface, and `docs/PROJECT.md` keeps it in English on
  purpose.
- **The desktop boot screen** (`apps/desktop/shell/`). It is the page shown when the machine
  has no Node to run the canvas with, so it cannot load a catalogue the canvas has not
  started yet. English, and noted in `docs/PROJECT.md` §7.
- **Addresses.** `github.com/xfurqan0/nazar`, and every link in the page.

## Writing direction

All six languages are left to right, so the page sets `<html lang>` and never `dir`. Adding
Arabic, Hebrew, Persian or Urdu is more than a JSON file: it needs a direction table in
`packages/ui/src/i18n.ts` and an audit of `packages/ui/web/styles.css`, which still uses
physical `margin-left` and `text-align: right` in a dozen places. A test fails if an RTL tag
is added to `LOCALES` before that work is done.
