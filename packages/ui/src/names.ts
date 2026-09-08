/**
 * WP4g: the name you give a card.
 *
 * A session's card is titled with the basename of its working directory, which
 * is the right default and a poor answer to "which of these three `app` cards
 * is the one rewriting the importer". So the title can be typed over: click it,
 * type, press Enter. The label belongs to *this browser* and to nothing else.
 *
 * Three properties, and each of them is a deliberate limit:
 *
 * - **Names never leave the browser.** They are not sent to the server, not
 *   written to disk, and not pushed into Claude Code. Nazar reads the machine;
 *   it does not write to it. Renaming the *terminal* is a thing the user can do
 *   themselves — `/rename` in that session — and the card menu says so, so the
 *   two titles can converge without Nazar reaching into anybody's session.
 * - **A name is not an identity.** The jump matcher still matches terminal
 *   titles, because that is what the operating system has; a label typed here
 *   would match nothing.
 * - **Empty clears.** Committing an empty field is how a card goes back to its
 *   folder name, so the gesture that made a name is also the one that removes
 *   it and nobody has to find a second control.
 *
 * Pruned with the same rule as tabs: a session that ended keeps its name for as
 * long as Claude Code keeps its transcript, and loses it when that expires.
 */
import type { StorageLike } from './workspace.js';

export const NAMES_KEY = 'nazar.names.v1';

/** As long as a card title can be and still fit on a card. */
export const MAX_NAME_LENGTH = 48;

export interface NamesState {
  /** Session id to the label the user typed. Absent means "use the folder". */
  readonly names: Readonly<Record<string, string>>;
}

export const EMPTY_NAMES: NamesState = { names: {} };

/** Collapse whitespace and cut to length. An empty result means "no name". */
export function cleanName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export function readNames(storage: StorageLike): NamesState {
  const raw = storage.getItem(NAMES_KEY);
  if (raw === null) return EMPTY_NAMES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // A half-written or hand-edited value is not worth a broken canvas.
    return EMPTY_NAMES;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_NAMES;
  const source = (parsed as Record<string, unknown>)['names'];
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return EMPTY_NAMES;

  const names: Record<string, string> = {};
  for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const name = cleanName(value);
    if (name.length > 0) names[id] = name;
  }
  return { names };
}

export function writeNames(storage: StorageLike, state: NamesState): void {
  storage.setItem(NAMES_KEY, JSON.stringify({ v: 1, names: state.names }));
}

/** Set a card's label, or clear it: an empty name removes the entry. */
export function withName(state: NamesState, id: string, name: string): NamesState {
  const cleaned = cleanName(name);
  const names = { ...state.names };
  if (cleaned.length === 0) delete names[id];
  else names[id] = cleaned;
  return { names };
}

export function nameOf(state: NamesState, id: string): string | undefined {
  return state.names[id];
}

/** Forget every session the machine no longer knows about. */
export function pruneNames(state: NamesState, known: ReadonlySet<string>): NamesState {
  const names: Record<string, string> = {};
  for (const [id, name] of Object.entries(state.names)) {
    if (known.has(id)) names[id] = name;
  }
  return { names };
}
