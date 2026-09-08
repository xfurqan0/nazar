/**
 * The theme files are a **brand** asset (report §1.3): Nazar ships before
 * nazar-tray, so `theme.nazar.json` is the first place the bead palette is
 * written down and nazar-tray's `themes/nazar.json` copies these hexes.
 *
 * These tests are therefore not decoration. They assert that
 *
 * - both files carry every token, in both modes, as a hex colour;
 * - the thresholds are the ones the report fixes (amber 60 %, red 85 %);
 * - the four bead colours are identical across themes, because the bead is the
 *   mark and only the surfaces around it change;
 * - every colour used for text clears WCAG AA against the surface it is drawn
 *   on, and every ring or edge clears the 3:1 non-text minimum.
 *
 * The last one is why `contrastRatio` exists at all: "AA" in a report is a
 * claim, and a claim about colour has to be measured.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertTheme,
  BEAD_KEYS,
  channelDistance,
  contrastRatio,
  HEX_COLOR,
  MODE_KEYS,
  modeVariables,
  NOTE_KEYS,
  STATE_KEYS,
  staticVariables,
  themeCss,
  THEME_MODES,
  TYPOGRAPHY_KEYS,
  type Theme,
  type ThemeMode,
} from '../src/theme.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, '..');

/**
 * Every theme the build compiles in, in the order `build.mjs` lists them —
 * `nazar` first, because the first one is written unscoped and is therefore the
 * default. WP4e added the last two.
 */
const FILES = [
  'theme.nazar.json',
  'theme.graphite.json',
  'theme.sepia.json',
  'theme.midnight.json',
] as const;

function load(file: string): Theme {
  return assertTheme(JSON.parse(readFileSync(path.join(packageDir, file), 'utf8')), file);
}

const themes = FILES.map((file) => [file, load(file)] as const);

for (const [file, theme] of themes) {
  test(`${file} carries every token, in hex, in both modes`, () => {
    for (const key of BEAD_KEYS) assert.match(theme.bead[key], HEX_COLOR);
    for (const key of TYPOGRAPHY_KEYS) assert.ok(theme.typography[key].length > 0);
    for (const mode of THEME_MODES) {
      for (const key of MODE_KEYS) {
        assert.match(theme.modes[mode][key], HEX_COLOR, `${file} ${mode}.${key}`);
      }
    }
  });

  test(`${file} keeps the thresholds the report fixed`, () => {
    assert.equal(theme.thresholds.amberAtPercent, 60);
    assert.equal(theme.thresholds.redAtPercent, 85);
  });
}

test('the bead is the same mark in every theme', () => {
  const [first] = themes;
  assert.ok(first !== undefined);
  for (const [file, theme] of themes) {
    assert.deepEqual(theme.bead, first[1].bead, `${file} changed the bead colours`);
  }
});

test('the nazar theme carries the four documented bead colours', () => {
  const nazar = themes[0]?.[1];
  assert.ok(nazar !== undefined);
  // Deep blue / light blue / white / black dot, in that order (report §1.3).
  assert.equal(nazar.bead.deepBlue, '#0E2A5A');
  assert.equal(nazar.bead.lightBlue, '#3FA9F5');
  assert.equal(nazar.bead.white, '#FFFFFF');
  assert.equal(nazar.bead.blackDot, '#0A0A0F');
});

/**
 * WP4d. A frame the eye cannot separate from the next frame is not a state,
 * however well documented it is, so "working is a different colour from idle"
 * is asserted rather than assumed — and it is the assertion that would have
 * caught the obvious first implementation, which reached for the accent and
 * got `stateAlive` back.
 */
test('every theme carries a working colour that is not already taken', () => {
  const neighbours = ['stateAlive', 'stateDone', 'stateWaiting', 'stateUnknown'] as const;
  for (const [file, theme] of themes) {
    for (const mode of THEME_MODES) {
      const tokens = theme.modes[mode];
      assert.match(tokens.stateWorking, HEX_COLOR, `${file} ${mode}.stateWorking`);
      for (const other of neighbours) {
        assert.notEqual(
          tokens.stateWorking.toUpperCase(),
          tokens[other].toUpperCase(),
          `${file} ${mode}: stateWorking is the same colour as ${other}`,
        );
      }
      // And not merely a different hex. `contrastRatio` is deliberately *not*
      // the tool for this one: it measures luminance, and a green and a blue
      // of the same luminance are 1.0:1 apart while being obviously different
      // colours. Distance in sRGB is the crude but honest measure of "these
      // two frames do not look alike", and 60 is roughly a quarter of the
      // longest diagonal of the cube.
      for (const other of neighbours) {
        const apart = channelDistance(tokens.stateWorking, tokens[other]);
        assert.ok(
          apart >= 60,
          `${file} ${mode}: stateWorking and ${other} are ${apart.toFixed(0)} apart in sRGB`,
        );
      }
    }
  }
});

/**
 * WP4e. "The frame colours must follow the theme" was already true — they have
 * been tokens since WP4d — and it was not what the maintainer meant. He meant
 * *the themes should not all look the same*, and copying one palette's five
 * activity hexes into the next is exactly how a theme ends up differing only in
 * its background. So the palettes are measured against each other.
 *
 * Two floors, because one would be the wrong shape:
 *
 * - **no token identical**, with a small per-token distance under it, catches
 *   the copy-paste this test exists for;
 * - **a mean across the five**, because a *per-token* floor of any useful size
 *   would be a bad rule: green is what "working" looks like everywhere, and two
 *   themes are both allowed to pick a green. It is the palette as a whole that
 *   has to be its own.
 *
 * The closest pair on record is the one that predates this rule — nazar against
 * graphite in light mode, min 12 and mean 25 — which is where the floors sit.
 */
const MIN_TOKEN_DISTANCE = 10;
const MIN_MEAN_DISTANCE = 20;

test('no two themes share an activity palette', () => {
  for (let i = 0; i < themes.length; i += 1) {
    for (let j = i + 1; j < themes.length; j += 1) {
      const [fileA, themeA] = themes[i]!;
      const [fileB, themeB] = themes[j]!;
      for (const mode of THEME_MODES) {
        const distances = STATE_KEYS.map((key) =>
          channelDistance(themeA.modes[mode][key], themeB.modes[mode][key]),
        );
        for (const [index, apart] of distances.entries()) {
          const key = STATE_KEYS[index];
          assert.ok(
            apart >= MIN_TOKEN_DISTANCE,
            `${fileA} and ${fileB} ${mode}: ${key} is ${apart.toFixed(0)} apart in sRGB — ` +
              'the same colour in two themes is a palette that was copied, not chosen',
          );
        }
        const mean = distances.reduce((sum, one) => sum + one, 0) / distances.length;
        assert.ok(
          mean >= MIN_MEAN_DISTANCE,
          `${fileA} and ${fileB} ${mode}: the five activity colours average ` +
            `${mean.toFixed(0)} apart, below ${MIN_MEAN_DISTANCE}`,
        );
      }
    }
  }
});

/**
 * WP4e. The four note grounds have to be four *different* grounds — a colour
 * chip that changes nothing is a control that lies — and the ink has to be
 * readable on every one of them, which the contrast gate below also asserts.
 */
test('every theme carries four note colours that can be told apart', () => {
  for (const [file, theme] of themes) {
    for (const mode of THEME_MODES) {
      const tokens = theme.modes[mode];
      for (let i = 0; i < NOTE_KEYS.length; i += 1) {
        for (let j = i + 1; j < NOTE_KEYS.length; j += 1) {
          const one = NOTE_KEYS[i]!;
          const other = NOTE_KEYS[j]!;
          const apart = channelDistance(tokens[one], tokens[other]);
          assert.ok(
            apart >= 15,
            `${file} ${mode}: ${one} and ${other} are ${apart.toFixed(0)} apart in sRGB`,
          );
        }
      }
    }
  }
});

test('assertTheme names the token it rejects', () => {
  const good = JSON.parse(readFileSync(path.join(packageDir, 'theme.nazar.json'), 'utf8')) as {
    modes: Record<string, Record<string, string>>;
    thresholds: Record<string, number>;
  };

  const badHex = structuredClone(good);
  badHex.modes['dark']!['canvas'] = 'navy';
  assert.throws(() => assertTheme(badHex), /modes\.dark\.canvas/);

  const missing = structuredClone(good);
  delete missing.modes['light']!['bannerText'];
  assert.throws(() => assertTheme(missing), /modes\.light\.bannerText/);

  const backwards = structuredClone(good);
  backwards.thresholds['amberAtPercent'] = 90;
  assert.throws(() => assertTheme(backwards), /amber must come before red/);

  assert.throws(() => assertTheme(null), /must be an object/);
});

/* ------------------------------------------------------------------ *
 * Contrast
 * ------------------------------------------------------------------ */

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** Which surface each text token is actually drawn on, per the stylesheet. */
const TEXT_ON: ReadonlyArray<readonly [string, string]> = [
  ['text', 'node'],
  ['textMuted', 'node'],
  ['textFaint', 'node'],
  ['accentText', 'node'],
  ['warnText', 'node'],
  ['dangerText', 'node'],
  ['unknownGreyText', 'node'],
  ['text', 'panel'],
  ['textMuted', 'panel'],
  ['textFaint', 'panel'],
  ['accentText', 'panel'],
  ['bannerText', 'bannerBg'],
  ['text', 'agent'],
  ['textMuted', 'agent'],
  ['textFaint', 'agent'],
  ['warnText', 'agent'],
  // WP4e. One ink, four grounds: a note whose own words are hard to read is
  // the one thing on this canvas that is entirely the user's, so it clears AA
  // on every colour the chips can put behind it.
  ['noteInk', 'note1'],
  ['noteInk', 'note2'],
  ['noteInk', 'note3'],
  ['noteInk', 'note4'],
];

/**
 * Rings, dots, **card frames** and edges: graphics, so the 3:1 minimum
 * applies.
 *
 * WP4d made the card's own border the state indicator, so every activity
 * colour is now drawn on both card surfaces and both are measured here. A
 * frame that clears 3:1 on a session card and not on the smaller agent card
 * would fail exactly where the trees are densest.
 */
const GRAPHIC_ON: ReadonlyArray<readonly [string, string]> = [
  ['stateAlive', 'node'],
  ['stateAlive', 'agent'],
  ['stateWorking', 'node'],
  ['stateWorking', 'agent'],
  ['stateUnknown', 'node'],
  ['stateUnknown', 'agent'],
  ['stateWaiting', 'node'],
  ['stateDone', 'node'],
  ['stateDone', 'agent'],
  ['unknownGrey', 'agent'],
  ['bannerBorder', 'bannerBg'],
  ['focusRing', 'node'],
  // A note's edge is what makes it read as a card on a canvas of cards, so it
  // is measured on the lightest and the darkest ground it can sit on.
  ['noteEdge', 'note1'],
  ['noteEdge', 'note4'],
];

for (const [file, theme] of themes) {
  for (const mode of THEME_MODES) {
    test(`${file} ${mode}: text clears WCAG AA on the surface it sits on`, () => {
      const tokens = theme.modes[mode as ThemeMode];
      for (const [fg, bg] of TEXT_ON) {
        const ratio = contrastRatio(
          tokens[fg as (typeof MODE_KEYS)[number]],
          tokens[bg as (typeof MODE_KEYS)[number]],
        );
        assert.ok(
          ratio >= AA_TEXT,
          `${file} ${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below AA ${AA_TEXT}:1`,
        );
      }
    });

    test(`${file} ${mode}: rings and edges clear the 3:1 non-text minimum`, () => {
      const tokens = theme.modes[mode as ThemeMode];
      for (const [fg, bg] of GRAPHIC_ON) {
        const ratio = contrastRatio(
          tokens[fg as (typeof MODE_KEYS)[number]],
          tokens[bg as (typeof MODE_KEYS)[number]],
        );
        assert.ok(
          ratio >= AA_NON_TEXT,
          `${file} ${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below ${AA_NON_TEXT}:1`,
        );
      }
    });
  }
}

test('contrastRatio agrees with the two values everybody knows', () => {
  assert.ok(Math.abs(contrastRatio('#FFFFFF', '#000000') - 21) < 1e-6);
  assert.ok(Math.abs(contrastRatio('#FFFFFF', '#FFFFFF') - 1) < 1e-6);
  assert.equal(contrastRatio('#000000', '#FFFFFF'), contrastRatio('#FFFFFF', '#000000'));
});

/* ------------------------------------------------------------------ *
 * Generated CSS
 * ------------------------------------------------------------------ */

test('every token becomes one custom property', () => {
  const theme = themes[0]?.[1];
  assert.ok(theme !== undefined);
  const statics = staticVariables(theme);
  const dark = modeVariables(theme, 'dark');

  assert.equal(Object.keys(dark).length, MODE_KEYS.length);
  assert.equal(dark['--nz-node-border'], theme.modes.dark.nodeBorder);
  assert.equal(statics['--nz-bead-light-blue'], theme.bead.lightBlue);
  assert.equal(statics['--nz-amber-at'], '60');
  assert.equal(statics['--nz-red-at'], '85');
});

test('themeCss writes the default unscoped and the rest by palette', () => {
  const css = themeCss(themes.map(([, theme]) => theme));

  assert.match(css, /^\/\* Generated from/);
  assert.ok(css.includes(':root {'));
  assert.ok(css.includes(':root[data-theme="dark"] {'));
  assert.ok(css.includes(':root:not([data-theme="light"])'));
  for (const name of ['graphite', 'sepia', 'midnight']) {
    assert.ok(css.includes(`[data-palette="${name}"] {`), `${name} has no scoped block`);
    assert.ok(
      css.includes(`[data-palette="${name}"][data-theme="dark"] {`),
      `${name} cannot be forced dark`,
    );
  }
  // The default one is written unscoped, which is why `applyPalette` *removes*
  // the attribute for it rather than setting `data-palette="nazar"`.
  assert.ok(!css.includes('[data-palette="nazar"]'));
  // Nothing but tokens: no rule, no selector the stylesheet owns.
  assert.ok(!css.includes('.nz-'));
});

test('the build compiles exactly the themes this test measures', () => {
  const build = readFileSync(path.join(packageDir, 'build.mjs'), 'utf8');
  const listed = [...build.matchAll(/'(theme\.[a-z]+\.json)'/g)].map((match) => match[1]);
  assert.deepEqual(listed, [...FILES], 'build.mjs and theme.test.ts disagree about the theme set');
});
