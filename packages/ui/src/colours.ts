/**
 * WP4e: the activity colours, overridden by the person looking at them.
 *
 * The five frame colours are theme tokens (WP4d) and every theme picks its own
 * (WP4e). That answers "the colours should differ per theme"; it does not
 * answer "I cannot tell your green from your blue", which is a property of an
 * eye and not of a palette. So the five are also *settable*, in the sidebar,
 * per browser, and the override wins over whichever theme is on.
 *
 * Three rules, and the second is the one worth arguing about:
 *
 * 1. **An override is a CSS custom property and nothing else.** It is written
 *    onto the document element with `style.setProperty`, which is a CSSOM write
 *    and therefore not the inline-style *attribute* the page's own
 *    `style-src 'self'` silently drops (WP5's bug, `chrome.test.ts` is the
 *    gate). Every rule that draws a frame already reads `--nz-state-*`, so
 *    nothing else in the stylesheet has to know this feature exists.
 * 2. **The contrast gate does not apply to an override, and the ratio is shown
 *    anyway.** Refusing a colour someone chose deliberately would be the tool
 *    telling its user they cannot read their own screen; saying `2.1:1` next to
 *    it is the same information without the veto. The gate stays where it
 *    belongs — on the palettes Nazar ships, which are its own work.
 * 3. **Only the five.** An override set is a closed record over `STATE_KEYS`;
 *    anything else in storage is dropped on read. A stored document is a thing
 *    a user can hand-edit, so it is validated rather than trusted.
 */
import { t } from './i18n.js';
import { HEX_COLOR, STATE_KEYS, contrastRatio, kebab, type StateKey } from './theme.js';
import type { StorageLike } from './workspace.js';

export const COLOURS_KEY = 'nazar.colours.v1';

/** The five overridable colours, in the order the settings panel lists them. */
export const COLOUR_KEYS = STATE_KEYS;

/**
 * The message key for each one. The word on the card, not the token.
 *
 * N-WP13 replaced the words with keys: the same five words label the activity
 * of a card, so the picker and the card read the same string out of the same
 * `state.*` entries and cannot drift into two vocabularies.
 */
export const COLOUR_LABEL_KEYS: Readonly<Record<StateKey, string>> = {
  stateWorking: 'state.working',
  stateAlive: 'state.idle',
  stateDone: 'state.done',
  stateWaiting: 'state.waiting',
  stateUnknown: 'state.unknown',
};

/** What one of the five is called, in the language now in force. */
export function colourLabel(key: StateKey): string {
  return t(COLOUR_LABEL_KEYS[key]);
}

/** A sparse set of overrides: absent means "whatever the theme says". */
export type ColourOverrides = Readonly<Partial<Record<StateKey, string>>>;

export const NO_COLOURS: ColourOverrides = {};

/** The custom property one override writes. `stateWorking` → `--nz-state-working`. */
export function colourVariable(key: StateKey): string {
  return `--nz-${kebab(key)}`;
}

/** `#abc` is not accepted: the themes are six or eight digits and so is this. */
export function isColour(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/**
 * Normalise a colour the way an `<input type="color">` hands it over.
 *
 * Browsers report `#rrggbb` in lower case; the theme files are written in
 * upper. Storing one shape means a stored override and a theme token can be
 * compared as strings, which is how "is this still the theme's colour" is
 * answered without a second source of truth.
 */
export function cleanColour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return HEX_COLOR.test(trimmed) ? trimmed : undefined;
}

/** Read the stored overrides, dropping anything that is not one of the five. */
export function readColours(storage: StorageLike): ColourOverrides {
  const raw = storage.getItem(COLOURS_KEY);
  if (raw === null) return NO_COLOURS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return NO_COLOURS;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_COLOURS;
  const source = parsed as Record<string, unknown>;
  const out: Partial<Record<StateKey, string>> = {};
  for (const key of COLOUR_KEYS) {
    const value = cleanColour(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function writeColours(storage: StorageLike, colours: ColourOverrides): void {
  const out: Record<string, string> = {};
  for (const key of COLOUR_KEYS) {
    const value = colours[key];
    if (value !== undefined) out[key] = value;
  }
  storage.setItem(COLOURS_KEY, JSON.stringify({ v: 1, ...out }));
}

/** Set one colour. An invalid value clears the override rather than storing it. */
export function withColour(
  colours: ColourOverrides,
  key: StateKey,
  value: string | undefined,
): ColourOverrides {
  const cleaned = cleanColour(value);
  const out: Partial<Record<StateKey, string>> = { ...colours };
  if (cleaned === undefined) delete out[key];
  else out[key] = cleaned;
  return out;
}

/** Back to the theme, for one colour. */
export function withoutColour(colours: ColourOverrides, key: StateKey): ColourOverrides {
  return withColour(colours, key, undefined);
}

/** How many of the five are the user's rather than the theme's. */
export function overriddenCount(colours: ColourOverrides): number {
  return COLOUR_KEYS.filter((key) => colours[key] !== undefined).length;
}

/**
 * The custom properties to write, and the ones to clear.
 *
 * Returned as data rather than applied here so the whole rule is testable in
 * Node: the DOM half in `web/colours.ts` walks these two lists and does nothing
 * else. Clearing is as important as setting — a *reset* has to remove the
 * property, not overwrite it with the theme's current value, or the next theme
 * change would find the old one nailed down.
 */
export interface ColourApplication {
  readonly set: ReadonlyArray<readonly [string, string]>;
  readonly clear: readonly string[];
}

export function colourApplication(colours: ColourOverrides): ColourApplication {
  const set: Array<readonly [string, string]> = [];
  const clear: string[] = [];
  for (const key of COLOUR_KEYS) {
    const value = colours[key];
    if (value === undefined) clear.push(colourVariable(key));
    else set.push([colourVariable(key), value]);
  }
  return { set, clear };
}

/* ------------------------------------------------------------------ *
 * The hint
 * ------------------------------------------------------------------ */

/** The floor a frame — a graphic, not text — has to clear to be WCAG-legible. */
export const NON_TEXT_MINIMUM = 3;

export interface ContrastHint {
  /** The measured ratio against the card ground, one decimal. */
  readonly ratio: number;
  /** `4.4:1`. What the sidebar prints next to the picker. */
  readonly text: string;
  /** Whether it clears the 3:1 non-text minimum. Advice, never a veto. */
  readonly passes: boolean;
  /** One sentence, for the `title` and for a screen reader. */
  readonly description: string;
}

/**
 * How this colour would read as a frame on the card it is drawn on.
 *
 * The ground is the card's own fill (`--nz-node`) rather than the canvas: a
 * frame sits on the edge of a card, and the card is what is behind it. A
 * ground that cannot be parsed answers `undefined` — the panel then shows no
 * hint at all, which is honest, rather than a number measured against a guess.
 */
export function contrastHint(colour: string, ground: string): ContrastHint | undefined {
  const one = cleanColour(colour);
  const other = cleanColour(ground);
  if (one === undefined || other === undefined) return undefined;
  const ratio = Math.round(contrastRatio(one, other) * 10) / 10;
  const passes = ratio >= NON_TEXT_MINIMUM;
  return {
    ratio,
    text: `${ratio.toFixed(1)}:1`,
    passes,
    description: t(passes ? 'colour.contrastPasses' : 'colour.contrastLow', {
      ratio: ratio.toFixed(1),
    }),
  };
}
