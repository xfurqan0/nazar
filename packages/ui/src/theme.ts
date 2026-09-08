/**
 * Theme tokens, and the rules a theme file has to satisfy.
 *
 * `theme.nazar.json` is the first place the bead palette is written down
 * (report §1.3: Nazar ships before nazar-tray, so the sibling copies these
 * hexes rather than the other way round). The values are a **brand** decision,
 * so this file validates them and measures them; it never invents one.
 *
 * Two things are checked, and both are checked by tests rather than by eye:
 *
 * - every token exists, in both modes, as a `#RRGGBB` or `#RRGGBBAA` string;
 * - every token used for *text* clears WCAG AA (4.5:1) against the surface it
 *   is drawn on, and every token used for a *ring or edge* clears 3:1.
 *
 * The bead's light blue clears AA on the navy ground but not on the light
 * one, which is why the light mode carries a darker `accentText` of the same
 * hue. That is a derived shade, not a change to the four bead colours.
 *
 * `stateWorking` (WP4d) is the one token that is not a shade of anything
 * already here, and it had to be: `stateAlive` is the bead's own light blue, so
 * a "working" frame drawn in the accent would be the same colour as an idle
 * one. It is a green, because green is what a running thing is everywhere else
 * a person looks, and it is measured against the card surfaces like every
 * other ring colour. The four bead hexes are untouched.
 */

/** The four colours of the bead. Identical in every theme: it is the mark. */
export const BEAD_KEYS = ['deepBlue', 'lightBlue', 'white', 'blackDot'] as const;

/** Typography tokens. Font stacks only: nothing is fetched at runtime. */
export const TYPOGRAPHY_KEYS = [
  'fontFamily',
  'monoFamily',
  'sizeXs',
  'sizeSm',
  'sizeMd',
  'sizeLg',
  'sizeXl',
  'weightRegular',
  'weightMedium',
  'weightStrong',
  'trackingWide',
] as const;

/** Every colour token a mode must define. */
export const MODE_KEYS = [
  'canvas',
  'grid',
  'panel',
  'panelBorder',
  'node',
  'nodeBorder',
  'nodeHeader',
  'agent',
  'agentBorder',
  'edge',
  'text',
  'textMuted',
  'textFaint',
  'accent',
  'accentText',
  'stateAlive',
  'stateWorking',
  'stateUnknown',
  'stateRemoved',
  'stateWaiting',
  'stateDone',
  'warn',
  'warnText',
  'danger',
  'dangerText',
  'unknownGrey',
  'unknownGreyText',
  'bannerBg',
  'bannerBorder',
  'bannerText',
  'focusRing',
  'shadow',
  // WP4e: sticky notes. Four grounds because four is how many a person can tell
  // apart at a glance without a legend, one ink that has to clear AA on all
  // four, and one edge so a note reads as a card on any canvas colour.
  'note1',
  'note2',
  'note3',
  'note4',
  'noteInk',
  'noteEdge',
] as const;

export const THEME_MODES = ['light', 'dark'] as const;

/**
 * The five activity colours (WP4d), named once so the contrast gate, the
 * per-theme separation gate and the user's own overrides all read from one
 * list rather than from three copies of it.
 */
export const STATE_KEYS = [
  'stateWorking',
  'stateAlive',
  'stateDone',
  'stateWaiting',
  'stateUnknown',
] as const;

/** The four sticky-note grounds, in the order the colour chips are drawn. */
export const NOTE_KEYS = ['note1', 'note2', 'note3', 'note4'] as const;

export type BeadKey = (typeof BEAD_KEYS)[number];
export type TypographyKey = (typeof TYPOGRAPHY_KEYS)[number];
export type ModeKey = (typeof MODE_KEYS)[number];
export type ThemeMode = (typeof THEME_MODES)[number];
export type StateKey = (typeof STATE_KEYS)[number];
export type NoteKey = (typeof NOTE_KEYS)[number];

export type ModeTokens = Readonly<Record<ModeKey, string>>;

export interface Theme {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly bead: Readonly<Record<BeadKey, string>>;
  /** Bead fill turns amber at 60 % of a window and red at 85 % (report §1.3). */
  readonly thresholds: { readonly amberAtPercent: number; readonly redAtPercent: number };
  readonly typography: Readonly<Record<TypographyKey, string>>;
  readonly modes: Readonly<Record<ThemeMode, ModeTokens>>;
}

/** `#RRGGBB` or `#RRGGBBAA`. Nothing else: no names, no `rgb()`, no `hsl()`. */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function readHex(source: Record<string, unknown>, key: string, where: string): string {
  const value = readString(source, key, where);
  if (!HEX_COLOR.test(value)) {
    throw new TypeError(`${where}.${key} must be #RRGGBB or #RRGGBBAA, got "${value}"`);
  }
  return value;
}

/**
 * Parse a theme file, or throw with the exact token that is wrong. Used by the
 * build (so a bad theme never reaches the browser) and by the theme test.
 */
export function assertTheme(value: unknown, where = 'theme'): Theme {
  if (!isRecord(value)) throw new TypeError(`${where} must be an object`);

  const name = readString(value, 'name', where);
  const label = readString(value, 'label', where);

  const beadSource = value['bead'];
  if (!isRecord(beadSource)) throw new TypeError(`${where}.bead must be an object`);
  const bead: Record<string, string> = {};
  for (const key of BEAD_KEYS) bead[key] = readHex(beadSource, key, `${where}.bead`);

  const thresholdSource = value['thresholds'];
  if (!isRecord(thresholdSource)) throw new TypeError(`${where}.thresholds must be an object`);
  const amberAtPercent = thresholdSource['amberAtPercent'];
  const redAtPercent = thresholdSource['redAtPercent'];
  for (const [key, threshold] of [
    ['amberAtPercent', amberAtPercent],
    ['redAtPercent', redAtPercent],
  ] as const) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
      throw new TypeError(`${where}.thresholds.${key} must be a percentage`);
    }
  }
  if ((amberAtPercent as number) >= (redAtPercent as number)) {
    throw new TypeError(`${where}.thresholds: amber must come before red`);
  }

  const typographySource = value['typography'];
  if (!isRecord(typographySource)) throw new TypeError(`${where}.typography must be an object`);
  const typography: Record<string, string> = {};
  for (const key of TYPOGRAPHY_KEYS) {
    typography[key] = readString(typographySource, key, `${where}.typography`);
  }

  const modesSource = value['modes'];
  if (!isRecord(modesSource)) throw new TypeError(`${where}.modes must be an object`);
  const modes: Record<string, Record<string, string>> = {};
  for (const mode of THEME_MODES) {
    const modeSource = modesSource[mode];
    if (!isRecord(modeSource)) throw new TypeError(`${where}.modes.${mode} must be an object`);
    const tokens: Record<string, string> = {};
    for (const key of MODE_KEYS) tokens[key] = readHex(modeSource, key, `${where}.modes.${mode}`);
    modes[mode] = tokens;
  }

  const theme: Theme = {
    name,
    label,
    bead: bead as Readonly<Record<BeadKey, string>>,
    thresholds: {
      amberAtPercent: amberAtPercent as number,
      redAtPercent: redAtPercent as number,
    },
    typography: typography as Readonly<Record<TypographyKey, string>>,
    modes: modes as Readonly<Record<ThemeMode, ModeTokens>>,
  };

  const description = value['description'];
  return typeof description === 'string' ? { ...theme, description } : theme;
}

/** `nodeBorder` becomes `node-border`, so the CSS reads like CSS. */
export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Custom properties that do not change between light and dark. */
export function staticVariables(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BEAD_KEYS) out[`--nz-bead-${kebab(key)}`] = theme.bead[key];
  for (const key of TYPOGRAPHY_KEYS) out[`--nz-${kebab(key)}`] = theme.typography[key];
  out['--nz-amber-at'] = String(theme.thresholds.amberAtPercent);
  out['--nz-red-at'] = String(theme.thresholds.redAtPercent);
  return out;
}

/** Custom properties for one mode of one theme. */
export function modeVariables(theme: Theme, mode: ThemeMode): Record<string, string> {
  const out: Record<string, string> = {};
  const tokens = theme.modes[mode];
  for (const key of MODE_KEYS) out[`--nz-${kebab(key)}`] = tokens[key];
  return out;
}

function block(selector: string, variables: Record<string, string>, indent = '  '): string {
  const body = Object.entries(variables)
    .map(([name, value]) => `${indent}${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}

/**
 * The whole token stylesheet.
 *
 * The first theme is the default and is written unscoped; the rest are scoped
 * by `[data-palette="<name>"]`. Each theme gets three blocks, in the order the
 * cascade needs them: light as the base, dark under `prefers-color-scheme`
 * unless the document asked for light, and dark again under an explicit
 * `data-theme="dark"` so the toggle wins in both directions.
 */
export function themeCss(themes: readonly Theme[]): string {
  const chunks: string[] = [
    '/* Generated from packages/ui/theme.*.json by build.mjs. Do not edit. */',
  ];

  themes.forEach((theme, index) => {
    const scope = index === 0 ? ':root' : `[data-palette="${theme.name}"]`;
    const guard = index === 0 ? ':root:not([data-theme="light"])' : `${scope}:not([data-theme="light"])`;
    const explicit = index === 0 ? ':root[data-theme="dark"]' : `${scope}[data-theme="dark"]`;

    chunks.push(`/* ${theme.label}: ${theme.description ?? theme.name} */`);
    chunks.push(block(scope, { ...staticVariables(theme), ...modeVariables(theme, 'light') }));
    chunks.push(
      `@media (prefers-color-scheme: dark) {\n${block(guard, modeVariables(theme, 'dark'), '    ')
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}\n}`,
    );
    chunks.push(block(explicit, modeVariables(theme, 'dark')));
  });

  return `${chunks.join('\n\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * Contrast. Small enough to keep here, and the only way the AA claim
 * in the report is anything more than an assertion.
 * ------------------------------------------------------------------ */

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#RRGGBB` colour. Alpha is ignored. */
export function relativeLuminance(hex: string): number {
  if (!HEX_COLOR.test(hex)) throw new TypeError(`not a hex colour: ${hex}`);
  const body = hex.slice(1);
  const r = Number.parseInt(body.slice(0, 2), 16);
  const g = Number.parseInt(body.slice(2, 4), 16);
  const b = Number.parseInt(body.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. Order of arguments does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Straight-line distance between two `#RRGGBB` colours in the sRGB cube.
 *
 * `contrastRatio` is deliberately not the tool for "are these two the same
 * colour": it measures luminance, and a green and a blue of equal luminance
 * measure 1.0:1 while being obviously different. This is the crude but honest
 * measure of *these do not look alike*, and it is what both colour-separation
 * gates use — `stateWorking` against its neighbours inside one theme (WP4d),
 * and one theme's activity palette against another's (WP4e).
 */
export function channelDistance(a: string, b: string): number {
  if (!HEX_COLOR.test(a) || !HEX_COLOR.test(b)) throw new TypeError(`not a hex colour: ${a} ${b}`);
  const parse = (hex: string): readonly [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}
