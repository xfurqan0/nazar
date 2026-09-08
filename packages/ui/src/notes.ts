/**
 * WP4e: sticky notes on the canvas.
 *
 * A note is the one thing on this canvas that is *not* derived from the
 * machine. Everything else — a card, a tree, a frame colour, a percentage — is
 * a reading of something Claude Code wrote, and Nazar's job is to be exactly as
 * right as its sources. A note is the user's own sentence, put next to a card
 * because the canvas is where they were looking when they thought of it.
 *
 * That difference decides every rule in this file:
 *
 * - **A note belongs to a tab, not to a session.** Sessions come and go — a
 *   note pinned to one would disappear with it, which is exactly when you want
 *   to still have written *"this is the run that ate the weekly quota"*. Tabs
 *   are the user's own division of the canvas, so a note lives on one.
 * - **Plain text, capped at {@link MAX_NOTE_LENGTH}.** No markdown, no links,
 *   no HTML: the note is drawn into a `textarea` and read back out as a string,
 *   so there is nothing to sanitise because there is nothing to interpret.
 * - **It never leaves the browser.** `localStorage`, on the page's own
 *   `127.0.0.1` origin, exactly like the card positions and the tabs — Nazar
 *   writes nothing to disk and a static gate fails the build if it tries. So a
 *   note is not backed up, not synced, and not readable by anything but this
 *   browser profile. The README says so under Privacy, because a text box that
 *   *looks* like it saves somewhere is a promise this tool cannot keep.
 *
 * Pure over a `StorageLike`, like `workspace.ts`: the tests hand it a `Map`,
 * the page hands it `localStorage`, and no jsdom is involved in either.
 */
import type { StorageLike } from './workspace.js';

export const NOTES_KEY = 'nazar.notes.v1';

/**
 * The cap, in characters.
 *
 * Two thousand is about a screenful at the note's own type size, and it is
 * also the point past which `localStorage` starts to matter: a canvas with
 * thirty notes at the cap is 60 kB, comfortably inside the 5 MB an origin gets,
 * and the card positions and tabs it shares that budget with are tiny.
 */
export const MAX_NOTE_LENGTH = 2000;

/** How many colours a note can be. Four: enough to sort by, few enough to tell apart. */
export const NOTE_COLOURS = [1, 2, 3, 4] as const;

export type NoteColour = (typeof NOTE_COLOURS)[number];

/** The size a new note starts at, and the smallest a drag may make one. */
export const NOTE_SIZE = {
  width: 220,
  height: 148,
  minWidth: 140,
  minHeight: 96,
  maxWidth: 720,
  maxHeight: 720,
} as const;

export interface Note {
  readonly id: string;
  /** The tab it lives on. `all` is a real tab and notes live there too. */
  readonly tab: string;
  /** Canvas coordinates of its top-left corner, in the same space as a card. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly colour: NoteColour;
}

export interface NotesState {
  readonly notes: readonly Note[];
}

export const EMPTY_NOTES: NotesState = { notes: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp a size into the range a note is allowed to have. */
export function clampSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.round(Math.min(NOTE_SIZE.maxWidth, Math.max(NOTE_SIZE.minWidth, width))),
    height: Math.round(Math.min(NOTE_SIZE.maxHeight, Math.max(NOTE_SIZE.minHeight, height))),
  };
}

/**
 * Cut text to the cap.
 *
 * `slice` and not a refusal: a paste of three thousand characters should leave
 * the first two thousand on the note rather than nothing at all, and the panel
 * shows the remaining count so the cut is visible before it happens.
 */
export function cleanNoteText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Normalise the line endings a paste from anywhere can carry, so the count
  // the user is shown matches the count that is stored.
  return value.replace(/\r\n?/g, '\n').slice(0, MAX_NOTE_LENGTH);
}

export function cleanNoteColour(value: unknown): NoteColour {
  return NOTE_COLOURS.find((one) => one === value) ?? 1;
}

/** Parse one stored note, or `undefined` if it is not one. */
function readNote(value: unknown): Note | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  const tab = value['tab'];
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof tab !== 'string' || tab.length === 0) return undefined;
  const size = clampSize(
    finite(value['width'], NOTE_SIZE.width),
    finite(value['height'], NOTE_SIZE.height),
  );
  return {
    id,
    tab,
    x: Math.round(finite(value['x'], 0)),
    y: Math.round(finite(value['y'], 0)),
    width: size.width,
    height: size.height,
    text: cleanNoteText(value['text']),
    colour: cleanNoteColour(value['colour']),
  };
}

export function readNotes(storage: StorageLike): NotesState {
  const raw = storage.getItem(NOTES_KEY);
  if (raw === null) return EMPTY_NOTES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return EMPTY_NOTES;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['notes'])) return EMPTY_NOTES;
  const notes: Note[] = [];
  const seen = new Set<string>();
  for (const value of parsed['notes']) {
    const note = readNote(value);
    if (note === undefined || seen.has(note.id)) continue;
    seen.add(note.id);
    notes.push(note);
  }
  return { notes };
}

export function writeNotes(storage: StorageLike, state: NotesState): void {
  storage.setItem(NOTES_KEY, JSON.stringify({ v: 1, notes: state.notes }));
}

/**
 * An id that needs no `crypto` and cannot collide with what is already stored.
 *
 * `crypto.randomUUID` exists in every browser this page runs in, but it is not
 * in Node's global scope on every version this file is *tested* on, and a
 * counter over the existing ids is both deterministic and enough: the ids are
 * local to one browser profile and never travel.
 */
export function nextNoteId(state: NotesState): string {
  let n = state.notes.length + 1;
  let id = `n${n}`;
  while (state.notes.some((note) => note.id === id)) {
    n += 1;
    id = `n${n}`;
  }
  return id;
}

export interface NewNote {
  readonly tab: string;
  readonly x: number;
  readonly y: number;
  readonly text?: string;
  readonly colour?: NoteColour;
}

/** Add a note and say which one it is, so the caller can focus it. */
export function addNote(state: NotesState, spec: NewNote): { state: NotesState; id: string } {
  const id = nextNoteId(state);
  const note: Note = {
    id,
    tab: spec.tab,
    x: Math.round(spec.x),
    y: Math.round(spec.y),
    width: NOTE_SIZE.width,
    height: NOTE_SIZE.height,
    text: cleanNoteText(spec.text ?? ''),
    colour: cleanNoteColour(spec.colour ?? 1),
  };
  return { id, state: { notes: [...state.notes, note] } };
}

/** Change one note. An id nobody has is not an error; nothing happens. */
export function updateNote(
  state: NotesState,
  id: string,
  change: Partial<Omit<Note, 'id'>>,
): NotesState {
  return {
    notes: state.notes.map((note) => {
      if (note.id !== id) return note;
      const size = clampSize(change.width ?? note.width, change.height ?? note.height);
      return {
        ...note,
        ...(change.tab === undefined ? {} : { tab: change.tab }),
        x: Math.round(change.x ?? note.x),
        y: Math.round(change.y ?? note.y),
        width: size.width,
        height: size.height,
        ...(change.text === undefined ? {} : { text: cleanNoteText(change.text) }),
        ...(change.colour === undefined ? {} : { colour: cleanNoteColour(change.colour) }),
      };
    }),
  };
}

export function removeNote(state: NotesState, id: string): NotesState {
  return { notes: state.notes.filter((note) => note.id !== id) };
}

/** The notes one tab shows, in creation order. */
export function notesOnTab(state: NotesState, tab: string): Note[] {
  return state.notes.filter((note) => note.tab === tab);
}

/** How many notes each tab holds, for the sidebar's count. */
export function noteCounts(state: NotesState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of state.notes) counts.set(note.tab, (counts.get(note.tab) ?? 0) + 1);
  return counts;
}

/**
 * Move the notes of a removed tab back to `all` rather than deleting them.
 *
 * A tab is a view; closing one is a tidying gesture and its sessions already
 * fall back to `all` (`workspace.removeTab`). Deleting somebody's sentences as
 * a side effect of that would be the one destructive thing on this canvas.
 */
export function reassignNotes(state: NotesState, from: string, to: string): NotesState {
  return {
    notes: state.notes.map((note) => (note.tab === from ? { ...note, tab: to } : note)),
  };
}

/** How much room is left on a note, for the counter under the text box. */
export function remaining(text: string): number {
  return Math.max(0, MAX_NOTE_LENGTH - text.length);
}

/** The custom property one colour chip paints itself with. */
export function noteVariable(colour: NoteColour): string {
  return `--nz-note${colour}`;
}

/** The class that gives a note its ground. One per colour, exactly one on. */
export function noteColourClass(colour: NoteColour): string {
  return `is-colour-${colour}`;
}

/** Every class `noteColourClass` can produce, so the renderer can clear them all. */
export const NOTE_COLOUR_CLASSES: readonly string[] = NOTE_COLOURS.map(noteColourClass);
