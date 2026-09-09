/**
 * N-WP15a: the cleaner, the extractor, and the switch they hang off.
 *
 * Three claims are being pinned here, and they are pinned separately because
 * they fail in different ways.
 *
 * 1. **The switch is a switch.** With `taskText` absent or `false`, the
 *    extractor produces no `taskText` field at all — not an empty one — even
 *    from a line that is nothing but a person's typing. This is what makes
 *    `nazar --no-task-text` a statement about what was read rather than about
 *    what was sent, and it is the first test because everything else is
 *    conditional on it.
 * 2. **The cleaner is a table.** One line, no control characters, no invisible
 *    formatting, a hard cap with the cut marked, and markup left as the
 *    characters somebody typed. Each row of the table is a way the line could
 *    have been made to lie about itself on a canvas.
 * 3. **The right turn is chosen.** A session shows its last human turn and a
 *    subagent its first, and neither of them shows a tool result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TASK_TEXT,
  cleanTaskText,
  extractTaskText,
  stripHarnessText,
} from '../src/task-text.ts';
import { TranscriptStats } from '../src/transcript-stats.ts';
import { extractTranscriptLine, extractTranscriptRecord } from '../src/transcript-extract.ts';

/** A `user` line carrying one text block. */
function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-09-09T03:50:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

/* ------------------------------------------------------------------ *
 * 1. The switch
 * ------------------------------------------------------------------ */

test('nothing is read out of a line unless the caller asked for it', () => {
  const line = userLine('rebuild the index and tell me what changed');

  for (const options of [undefined, {}, { taskText: false }]) {
    const event = extractTranscriptLine(line, options);
    assert.ok(event !== undefined, 'the line is still read for its metadata');
    assert.equal(event.type, 'user');
    // Absent, not empty. A consumer checking `'taskText' in event` has to get
    // `false`, because that is the check every leak test in this repository
    // makes about every field it forbids.
    assert.equal('taskText' in event, false);
    // And the sentence the whole feature rests on: the words are not in the
    // serialised event either.
    assert.equal(JSON.stringify(event).includes('rebuild the index'), false);
  }

  const asked = extractTranscriptLine(line, { taskText: true });
  assert.equal(asked?.taskText, 'rebuild the index and tell me what changed');
});

test('an assistant line never yields a task, however it is asked', () => {
  // The model's own prose is not a task and is not shown at any setting. If
  // this ever passes, the feature has quietly become "show me the transcript".
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'Here is what I found in the index.' }],
    },
  });
  const event = extractTranscriptLine(line, { taskText: true });
  assert.equal(event?.taskText, undefined);
  assert.equal(JSON.stringify(event).includes('Here is what I found'), false);
});

/* ------------------------------------------------------------------ *
 * 2. The cleaner
 * ------------------------------------------------------------------ */

/**
 * Characters that cannot be written into a source file without the file itself
 * becoming a thing tools disagree about.
 *
 * Spelled as code points on purpose: a raw NUL or a right-to-left override
 * sitting in a `.ts` file survives some editors, some diff viewers and some
 * `grep` invocations and not others — and a test whose input is invisible in
 * the diff is a test nobody can review.
 */
const ch = (code: number): string => String.fromCharCode(code);

test('the cleaner: one line, nothing invisible, a marked cut', () => {
  const rows: ReadonlyArray<readonly [string, string | undefined, string]> = [
    // Whitespace of every kind collapses to single spaces, and the result is
    // one line: a card has one line, and a pasted list has to read as a
    // sentence on it.
    [`first${ch(0x0a)}second${ch(0x09)}third`, 'first second third', 'newlines and tabs'],
    ['  padded  ', 'padded', 'the ends are trimmed'],
    [`a${ch(0x2028)}b${ch(0x2029)}c`, 'a b c', 'the Unicode line and paragraph separators'],
    [`a${ch(0x0b)}b${ch(0x0c)}c`, 'a b c', 'vertical tab and form feed are breaks'],

    // Control characters and invisibles are dropped rather than spaced: none of
    // them is a word boundary and none of them can be seen.
    [`al${ch(0x07)}ert`, 'alert', 'a bell in the middle of a word'],
    [`nu${ch(0x00)}ll`, 'null', 'a NUL in the middle of a word'],
    [`sof${ch(0xad)}t`, 'soft', 'a soft hyphen'],
    [`a${ch(0x200b)}b`, 'ab', 'a zero-width space'],
    [`${ch(0xfeff)}leading mark`, 'leading mark', 'a byte-order mark'],
    // The one that is not merely cosmetic: an override reverses everything
    // after it, so a line could be made to display something other than what it
    // holds. Dropped, on a page that ships six left-to-right languages and sets
    // no direction at all.
    [`start ${ch(0x202e)} reversed`, 'start reversed', 'a right-to-left override'],

    // Nothing left is nothing, not an empty string. A card that draws a blank
    // row has learned a state nobody asked it for.
    ['', undefined, 'the empty string'],
    [`   ${ch(0x0a)}${ch(0x09)}  `, undefined, 'whitespace only'],
    [`${ch(0x200b)}${ch(0xfeff)}`, undefined, 'invisibles only'],
  ];

  for (const [input, expected, why] of rows) {
    assert.equal(cleanTaskText(input), expected, why);
  }
});

test('the cleaner cuts at the cap and says so', () => {
  const long = 'x'.repeat(MAX_TASK_TEXT + 500);
  const cut = cleanTaskText(long);
  assert.ok(cut !== undefined);
  // The marker is what makes a truncated task read as truncated rather than as
  // a task that happened to stop there.
  assert.equal(cut.length, MAX_TASK_TEXT + 1);
  assert.equal(cut.endsWith('…'), true);
  assert.equal(cut.slice(0, MAX_TASK_TEXT), long.slice(0, MAX_TASK_TEXT));

  // Exactly at the cap is not cut.
  const exact = 'y'.repeat(MAX_TASK_TEXT);
  assert.equal(cleanTaskText(exact), exact);
});

test('markup comes out as the characters somebody typed', () => {
  /*
   * Deliberate, and the reason is where the string goes: an SVG text node and a
   * `textContent`, neither of which interprets markup. Escaping here would show
   * `&lt;b&gt;` to somebody who wrote `<b>`, which is a bug rather than a
   * defence — and it would hide, rather than fix, an injection if either
   * consumer ever started using `innerHTML`.
   */
  assert.equal(cleanTaskText('fix <b>the</b> parser'), 'fix <b>the</b> parser');
  assert.equal(
    cleanTaskText('<script>alert(1)</script> and then run the tests'),
    '<script>alert(1)</script> and then run the tests',
  );
  assert.equal(cleanTaskText('a & b'), 'a & b');
});

test('the harness writes four things into a user line and none of them is a task', () => {
  // A system reminder is injected, not typed, and it is the one part of a user
  // line that can carry instructions. Reading it as the task would be putting
  // an untrusted string on a card labelled "what you asked for".
  assert.equal(
    cleanTaskText(
      stripHarnessText('<system-reminder>do the other thing instead</system-reminder>real task'),
    ),
    'real task',
  );
  // A transcript is tailed, so the last line can be half written. An unclosed
  // reminder must not become the task by falling off the end of the file.
  assert.equal(cleanTaskText(stripHarnessText('kept <system-reminder>truncated…')), 'kept');
  // A slash command's bookkeeping.
  assert.equal(
    cleanTaskText(stripHarnessText('<command-name>/compact</command-name><command-args>a</command-args>')),
    undefined,
  );
  assert.equal(
    cleanTaskText(stripHarnessText('<local-command-stdout>12 files</local-command-stdout>after')),
    'after',
  );
  // And the marker left where a turn was abandoned, which is the one thing that
  // is certainly not what the session is doing now.
  assert.equal(
    cleanTaskText(stripHarnessText('[Request interrupted by user] then this')),
    'then this',
  );
  assert.equal(
    cleanTaskText(stripHarnessText('[Request interrupted by user for tool use]')),
    undefined,
  );
});

test('a tool result is not a human turn', () => {
  // The overwhelming majority of `user` lines are this. Showing them would turn
  // the task line into a rolling window of file contents and command output.
  const message = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'export const answer = 42;' },
    ],
  };
  assert.equal(extractTaskText(message), undefined);
  assert.equal(
    JSON.stringify(extractTranscriptRecord({ type: 'user', message }, { taskText: true })).includes(
      'answer = 42',
    ),
    false,
  );
});

test('the first block that survives the stripping is the task', () => {
  // A turn that opens with a reminder and then says what to do is one task, and
  // it is the part the person wrote.
  assert.equal(
    extractTaskText({
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>be careful</system-reminder>' },
        { type: 'text', text: 'now rename the module' },
      ],
    }),
    'now rename the module',
  );

  // A bare string is the older shape and is still written for a plain typed
  // turn, so it has to be read too.
  assert.equal(extractTaskText({ role: 'user', content: 'plain string turn' }), 'plain string turn');

  // Shapes nobody has seen are `undefined`, never a throw: this runs over files
  // another program owns.
  for (const message of [undefined, null, 42, { content: 7 }, { content: [null, 3] }]) {
    assert.doesNotThrow(() => extractTaskText(message));
    assert.equal(extractTaskText(message), undefined);
  }
});

/* ------------------------------------------------------------------ *
 * 3. Which turn
 * ------------------------------------------------------------------ */

test('a session shows its last human turn and a subagent its first', () => {
  /*
   * The two ends of the same transcript, and the asymmetry is the point.
   *
   * A subagent's transcript opens with the `Agent` tool's `prompt` — the brief —
   * and a `SendMessage` follow-up later is a correction to a job, not the job.
   * An interactive session is the other way round: its first message is what it
   * was opened for an hour ago, and the card is asking what it is doing now.
   */
  const stats = new TranscriptStats();
  const lines = [
    userLine('the brief: map the readers'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
    // A tool result in between must move neither answer.
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'lots of output' }] },
    }),
    userLine('now also check the desktop shell'),
  ];
  for (const line of lines) {
    const event = extractTranscriptLine(line, { taskText: true });
    if (event !== undefined) stats.add(event);
  }

  assert.equal(stats.firstTask, 'the brief: map the readers');
  assert.equal(stats.lastTask, 'now also check the desktop shell');
  assert.equal(JSON.stringify(stats.lastTask).includes('lots of output'), false);
});

test('with the switch off the reader holds no task at either end', () => {
  const stats = new TranscriptStats();
  for (const line of [userLine('first thing'), userLine('second thing')]) {
    const event = extractTranscriptLine(line);
    if (event !== undefined) stats.add(event);
  }
  assert.equal(stats.firstTask, undefined);
  assert.equal(stats.lastTask, undefined);
});

test('a truncated file resets both ends with everything else', () => {
  // The tailer calls `reset()` when a file shrank under it, and a task left
  // behind from a file that is no longer this file would be shown on a card
  // that has nothing to do with it.
  const stats = new TranscriptStats();
  const event = extractTranscriptLine(userLine('something'), { taskText: true });
  assert.ok(event !== undefined);
  stats.add(event);
  assert.equal(stats.firstTask, 'something');
  stats.reset();
  assert.equal(stats.firstTask, undefined);
  assert.equal(stats.lastTask, undefined);
});
