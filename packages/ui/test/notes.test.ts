/**
 * WP4e: sticky notes.
 *
 * Notes are the only thing on this canvas that is not a reading of the machine,
 * so the tests here are about not losing somebody's words: a round trip through
 * storage, a cap that cuts rather than refuses, a tab that closes without
 * taking its notes with it, and a stored document that has been hand-edited
 * being read for the parts that are notes.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import test from 'node:test';

import {
  addNote,
  clampSize,
  cleanNoteColour,
  cleanNoteText,
  EMPTY_NOTES,
  MAX_NOTE_LENGTH,
  nextNoteId,
  noteColourClass,
  NOTE_COLOURS,
  NOTE_COLOUR_CLASSES,
  NOTE_SIZE,
  noteCounts,
  notesOnTab,
  noteVariable,
  reassignNotes,
  readNotes,
  remaining,
  removeNote,
  updateNote,
  writeNotes,
  type NotesState,
} from '../src/notes.ts';
import { ALL_TAB, memoryStorage } from '../src/workspace.ts';

function seeded(): NotesState {
  let state = EMPTY_NOTES;
  state = addNote(state, { tab: ALL_TAB, x: 10, y: 20, text: 'first' }).state;
  state = addNote(state, { tab: 't1', x: 30, y: 40, text: 'second' }).state;
  return state;
}

test('a note is added with a size, a colour and an id nobody else has', () => {
  const made = addNote(EMPTY_NOTES, { tab: ALL_TAB, x: 12.6, y: -4.2 });
  const note = made.state.notes[0];
  assert.ok(note !== undefined);
  assert.equal(note.id, made.id);
  assert.equal(note.tab, ALL_TAB);
  // Whole pixels: a note placed at 0.4x zoom would otherwise store a position
  // with eleven decimal places, exactly as a dragged card would.
  assert.equal(note.x, 13);
  assert.equal(note.y, -4);
  assert.equal(note.width, NOTE_SIZE.width);
  assert.equal(note.height, NOTE_SIZE.height);
  assert.equal(note.colour, 1);
  assert.equal(note.text, '');

  const second = addNote(made.state, { tab: ALL_TAB, x: 0, y: 0 });
  assert.notEqual(second.id, made.id);
  assert.equal(nextNoteId(second.state).startsWith('n'), true);
});

test('an id is never reused, even after the note in the middle is deleted', () => {
  let state = EMPTY_NOTES;
  const a = addNote(state, { tab: ALL_TAB, x: 0, y: 0 });
  const b = addNote(a.state, { tab: ALL_TAB, x: 0, y: 0 });
  const c = addNote(b.state, { tab: ALL_TAB, x: 0, y: 0 });
  state = removeNote(c.state, b.id);
  const d = addNote(state, { tab: ALL_TAB, x: 0, y: 0 });
  assert.notEqual(d.id, a.id);
  assert.notEqual(d.id, c.id);
});

test('text is cut at the cap rather than refused, and line endings are normalised', () => {
  const long = 'x'.repeat(MAX_NOTE_LENGTH + 500);
  assert.equal(cleanNoteText(long).length, MAX_NOTE_LENGTH);
  // A paste of three thousand characters leaves the first two thousand on the
  // note; refusing the whole paste would be the worse of the two.
  assert.equal(cleanNoteText('a\r\nb\rc').split('\n').length, 3);
  assert.equal(cleanNoteText(undefined), '');
  assert.equal(remaining('abc'), MAX_NOTE_LENGTH - 3);
  assert.equal(remaining(long.slice(0, MAX_NOTE_LENGTH)), 0);
});

test('a size is clamped into the range a note is allowed to have', () => {
  assert.deepEqual(clampSize(10, 10), {
    width: NOTE_SIZE.minWidth,
    height: NOTE_SIZE.minHeight,
  });
  assert.deepEqual(clampSize(10_000, 10_000), {
    width: NOTE_SIZE.maxWidth,
    height: NOTE_SIZE.maxHeight,
  });
  assert.deepEqual(clampSize(220.6, 148.2), { width: 221, height: 148 });
});

test('a colour is one of the four, and anything else is the first', () => {
  for (const colour of NOTE_COLOURS) assert.equal(cleanNoteColour(colour), colour);
  assert.equal(cleanNoteColour(9), 1);
  assert.equal(cleanNoteColour('2'), 1);
  assert.equal(cleanNoteColour(undefined), 1);
  assert.equal(noteColourClass(3), 'is-colour-3');
  assert.equal(noteVariable(2), '--nz-note2');
  assert.equal(NOTE_COLOUR_CLASSES.length, NOTE_COLOURS.length);
});

test('a note belongs to exactly one tab, and a tab knows how many it has', () => {
  const state = seeded();
  assert.equal(notesOnTab(state, ALL_TAB).length, 1);
  assert.equal(notesOnTab(state, 't1').length, 1);
  assert.equal(notesOnTab(state, 't2').length, 0);

  const counts = noteCounts(state);
  assert.equal(counts.get(ALL_TAB), 1);
  assert.equal(counts.get('t1'), 1);
  assert.equal(counts.get('t2'), undefined);
});

test('closing a tab moves its notes to All rather than deleting them', () => {
  const state = reassignNotes(seeded(), 't1', ALL_TAB);
  assert.equal(notesOnTab(state, ALL_TAB).length, 2);
  assert.equal(notesOnTab(state, 't1').length, 0);
  // Nothing was lost: closing a *view* must not delete the user's own words.
  assert.equal(state.notes.length, 2);
});

test('an update touches one note and clamps what it is given', () => {
  const state = seeded();
  const id = state.notes[0]?.id ?? '';
  const moved = updateNote(state, id, { x: 99.4, y: -3.7 });
  assert.equal(moved.notes[0]?.x, 99);
  assert.equal(moved.notes[0]?.y, -4);
  assert.equal(moved.notes[1]?.x, 30, 'the other note did not move');

  const squashed = updateNote(state, id, { width: 1, height: 1 });
  assert.equal(squashed.notes[0]?.width, NOTE_SIZE.minWidth);

  const capped = updateNote(state, id, { text: 'y'.repeat(MAX_NOTE_LENGTH + 1) });
  assert.equal(capped.notes[0]?.text.length, MAX_NOTE_LENGTH);

  // An id nobody has is not an error; nothing happens.
  assert.deepEqual(updateNote(state, 'nope', { x: 1 }), state);
});

test('notes round-trip through storage', () => {
  const storage = memoryStorage();
  const state = updateNote(seeded(), seeded().notes[0]?.id ?? '', { colour: 3 });
  writeNotes(storage, state);
  assert.deepEqual(readNotes(storage), state);
});

test('a stored document that was hand-edited is read for the parts that are notes', () => {
  const storage = memoryStorage({
    'nazar.notes.v1': JSON.stringify({
      v: 1,
      notes: [
        { id: 'n1', tab: 'all', x: 1, y: 2, width: 10, height: 10, text: 'ok', colour: 2 },
        { id: 'n1', tab: 'all', x: 0, y: 0, text: 'a duplicate id' },
        { tab: 'all', x: 0, y: 0 },
        { id: 'n3', x: 0, y: 0 },
        'not an object',
        { id: 'n4', tab: 'all', x: 'left', y: null, colour: 99, text: 42 },
      ],
    }),
  });

  const state = readNotes(storage);
  assert.equal(state.notes.length, 2, 'the duplicate and the two malformed rows are dropped');
  assert.equal(state.notes[0]?.width, NOTE_SIZE.minWidth, 'a stored size is clamped on read');
  assert.equal(state.notes[1]?.id, 'n4');
  assert.equal(state.notes[1]?.x, 0, 'a non-numeric position falls back rather than poisoning it');
  assert.equal(state.notes[1]?.colour, 1);
  assert.equal(state.notes[1]?.text, '');

  assert.deepEqual(readNotes(memoryStorage({ 'nazar.notes.v1': 'not json' })), EMPTY_NOTES);
  assert.deepEqual(readNotes(memoryStorage({ 'nazar.notes.v1': '{"v":1}' })), EMPTY_NOTES);
  assert.deepEqual(readNotes(memoryStorage()), EMPTY_NOTES);
});
