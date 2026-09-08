/**
 * WP4e: the Colours section of the sidebar.
 *
 * Five pickers, one per activity state, each overriding whatever the current
 * theme says that state looks like. The rules and the storage are all in
 * `../src/colours.ts`; this file is the DOM, and it does three things that file
 * cannot:
 *
 * 1. **Reads the theme's current value** for a state, so a picker that has no
 *    override still opens on the colour actually on screen. It comes from the
 *    computed custom property rather than from a copy of the theme files, which
 *    is why changing theme or switching to dark updates every swatch for free.
 * 2. **Writes the overrides** as custom properties on the document element —
 *    a CSSOM write, which the page's `style-src 'self'` allows, unlike the
 *    inline style *attribute* it silently drops.
 * 3. **Measures the hint.** The ratio is against `--nz-node`, the card's own
 *    fill, because a frame is drawn on the edge of a card and the card is what
 *    is behind it. The hint never refuses a colour: it is the user's screen and
 *    their eyes, and a tool that vetoes a deliberate choice on a WCAG number is
 *    being obedient to the wrong master. It says what the number is.
 */
import type { ColourOverrides } from '../src/colours.ts';
import {
  COLOUR_KEYS,
  cleanColour,
  colourLabel,
  colourApplication,
  colourVariable,
  contrastHint,
  overriddenCount,
  withColour,
  withoutColour,
} from '../src/colours.ts';
import { t } from '../src/i18n.ts';
import type { StateKey } from '../src/theme.ts';
import { html, setClass, setText } from './dom.ts';

/** The token whose value every hint is measured against. */
const GROUND_VARIABLE = '--nz-node';

interface RowEls {
  readonly label: HTMLLabelElement;
  readonly input: HTMLInputElement;
  readonly hint: HTMLSpanElement;
  readonly reset: HTMLButtonElement;
  readonly row: HTMLDivElement;
}

export interface ColourSettingsOptions {
  readonly root: HTMLElement;
  /** Called with the new set whenever a picker or a reset changes it. */
  readonly onChange: (colours: ColourOverrides) => void;
}

/** Read one custom property off the document element, normalised. */
function currentValue(name: string): string | undefined {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return cleanColour(raw.trim());
}

export class ColourSettings {
  private readonly options: ColourSettingsOptions;

  private readonly rows = new Map<StateKey, RowEls>();

  private readonly resetAll: HTMLButtonElement;

  private colours: ColourOverrides;

  constructor(options: ColourSettingsOptions, colours: ColourOverrides) {
    this.options = options;
    this.colours = colours;

    for (const key of COLOUR_KEYS) {
      const row = html('div', 'nz-colour');

      const label = html('label', 'nz-colour__label');
      const input = html('input', 'nz-colour__input');
      input.type = 'color';
      input.id = `colour-${key}`;
      label.htmlFor = input.id;
      setText(label, colourLabel(key));

      const hint = html('span', 'nz-colour__hint');

      const reset = html('button', 'nz-colour__reset');
      reset.type = 'button';
      setText(reset, t('settings.reset'));
      reset.title = t('settings.resetOne', { state: colourLabel(key) });
      reset.setAttribute('aria-label', t('settings.resetOne', { state: colourLabel(key) }));

      // `input` fires while the picker is open, which is what makes the canvas
      // change under the cursor; that is the whole point of putting the control
      // next to the thing it colours. Storage is written on every change too —
      // the set is five short strings and a write is not worth debouncing.
      input.addEventListener('input', () => this.change(key, input.value));
      reset.addEventListener('click', () => this.change(key, undefined));

      row.append(label, input, hint, reset);
      options.root.append(row);
      this.rows.set(key, { label, input, hint, reset, row });
    }

    this.resetAll = html('button', 'nz-item nz-colour__reset-all');
    this.resetAll.type = 'button';
    setText(this.resetAll, t('settings.resetAll'));
    this.resetAll.addEventListener('click', () => {
      this.colours = {};
      this.apply();
      this.options.onChange(this.colours);
      this.refresh();
    });
    options.root.append(this.resetAll);
  }

  /**
   * Rewrite the five labels and the reset buttons after a language change.
   *
   * The swatches, the ratios and the tooltips are all written by
   * {@link ColourSettings.refresh}, which the caller runs straight after — so
   * this only has to do the strings `refresh` does not touch.
   */
  retranslate(): void {
    for (const key of COLOUR_KEYS) {
      const els = this.rows.get(key);
      if (els === undefined) continue;
      setText(els.label, colourLabel(key));
      setText(els.reset, t('settings.reset'));
      els.reset.title = t('settings.resetOne', { state: colourLabel(key) });
      els.reset.setAttribute('aria-label', t('settings.resetOne', { state: colourLabel(key) }));
    }
  }

  /** The overrides as they stand. */
  get value(): ColourOverrides {
    return this.colours;
  }

  private change(key: StateKey, value: string | undefined): void {
    this.colours = value === undefined
      ? withoutColour(this.colours, key)
      : withColour(this.colours, key, value);
    this.apply();
    this.options.onChange(this.colours);
    this.refresh();
  }

  /**
   * Write the overrides onto the document element.
   *
   * A reset **removes** the property rather than writing the theme's current
   * value into it: leaving a value behind would nail that colour down, and the
   * next theme change would find it there.
   */
  apply(): void {
    const { set, clear } = colourApplication(this.colours);
    const style = document.documentElement.style;
    for (const name of clear) style.removeProperty(name);
    for (const [name, value] of set) style.setProperty(name, value);
  }

  /**
   * Re-read every swatch and every ratio.
   *
   * Called after a theme, palette or mode change as well as after an edit,
   * because all four move the colour a picker with no override is showing and
   * the ground every ratio is measured against.
   */
  refresh(): void {
    const ground = currentValue(GROUND_VARIABLE);
    for (const key of COLOUR_KEYS) {
      const els = this.rows.get(key);
      if (els === undefined) continue;
      const override = this.colours[key];
      const effective = override ?? currentValue(colourVariable(key));
      if (effective !== undefined && els.input.value.toUpperCase() !== effective) {
        els.input.value = effective.slice(0, 7).toLowerCase();
      }
      els.input.title = t(override === undefined ? 'settings.swatchTheme' : 'settings.swatchYours', {
        state: colourLabel(key),
      });

      const hint = effective === undefined || ground === undefined
        ? undefined
        : contrastHint(effective, ground);
      setText(els.hint, hint === undefined ? '' : hint.text);
      els.hint.title = hint?.description ?? '';
      setClass(els.hint, 'is-low', hint !== undefined && !hint.passes);

      els.reset.disabled = override === undefined;
      setClass(els.row, 'is-overridden', override !== undefined);
    }
    const count = overriddenCount(this.colours);
    this.resetAll.disabled = count === 0;
    setText(
      this.resetAll,
      count === 0 ? t('settings.resetAll') : t('settings.resetAllCount', { count }),
    );
  }
}
