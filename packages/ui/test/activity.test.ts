/**
 * WP4d: the one rule that decides what a card's frame says.
 *
 * `activityOf` is a five-way decision over four fields and a clock, which is
 * exactly the shape of thing that gets "obviously right" wrong. It is
 * therefore tested as a table: every input combination that can occur, with
 * the answer written out next to it, and `now` injected so the thirty-second
 * write window is asserted at chosen instants rather than at whatever time the
 * suite happens to run.
 *
 * The three precedence questions the table exists to pin:
 *
 * - a **waiting** session is also `busy` in Claude Code's status file, and it
 *   must read as waiting;
 * - a session whose process failed a signal-0 probe is **unknown** even if its
 *   transcript was appended to a second ago;
 * - a **frozen** node is finished whatever its file said, because history does
 *   not change.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Activity, ActivityNode } from '../src/activity.ts';
import {
  ACTIVITIES,
  ACTIVITY_CLASSES,
  activityClass,
  activityLabel,
  activityOf,
  agentActivity,
  RECENT_WRITE_MS,
  sessionActivity,
} from '../src/activity.ts';

const NOW = 1_788_756_000_000;

/** A write that lands inside the window, and one that lands outside it. */
const FRESH = NOW - 5_000;
const STALE = NOW - 5 * 60_000;

interface Row {
  readonly why: string;
  readonly node: ActivityNode;
  readonly want: Activity;
}

const SESSIONS: readonly Row[] = [
  {
    why: 'busy and alive is the plain working case',
    node: { kind: 'session', status: 'busy', state: 'alive' },
    want: 'working',
  },
  {
    why: 'busy, alive, and writing',
    node: { kind: 'session', status: 'busy', state: 'alive', lastWriteAt: FRESH },
    want: 'working',
  },
  {
    why: 'idle and alive, silent for five minutes',
    node: { kind: 'session', status: 'idle', state: 'alive', lastWriteAt: STALE },
    want: 'idle',
  },
  {
    why: 'idle and alive with no transcript at all',
    node: { kind: 'session', status: 'idle', state: 'alive' },
    want: 'idle',
  },
  {
    why: 'the status file lags: idle, but the transcript moved five seconds ago',
    node: { kind: 'session', status: 'idle', state: 'alive', lastWriteAt: FRESH },
    want: 'working',
  },
  {
    why: 'waiting beats working, even though a waiting session is also busy',
    node: { kind: 'session', status: 'waiting', state: 'alive', lastWriteAt: FRESH },
    want: 'waiting',
  },
  {
    why: 'a waitingFor with no waiting status is still waiting',
    node: { kind: 'session', status: 'busy', state: 'alive', waitingFor: 'permission prompt' },
    want: 'waiting',
  },
  {
    why: 'a waiting session whose process is gone is still what the user has to answer',
    node: { kind: 'session', status: 'waiting', state: 'unknown' },
    want: 'waiting',
  },
  {
    why: 'the probe failed: a fresh write does not bring the process back',
    node: { kind: 'session', status: 'busy', state: 'unknown', lastWriteAt: FRESH },
    want: 'unknown',
  },
  {
    why: 'idle status, dead probe',
    node: { kind: 'session', status: 'idle', state: 'unknown', lastWriteAt: STALE },
    want: 'unknown',
  },
  {
    why: 'no status from any source, and nothing written recently: unknown, never idle',
    node: { kind: 'session', status: 'unknown', state: 'alive', lastWriteAt: STALE },
    want: 'unknown',
  },
  {
    why: 'no status, but the transcript is moving',
    node: { kind: 'session', status: 'unknown', state: 'alive', lastWriteAt: FRESH },
    want: 'working',
  },
  {
    why: 'a frozen session is finished, whatever the snapshot said',
    node: { kind: 'session', status: 'busy', state: 'alive', lastWriteAt: FRESH, frozen: true },
    want: 'done',
  },
  {
    why: 'history speaks in unknowns too, and it is still finished',
    node: { kind: 'session', status: 'unknown', state: 'unknown', frozen: true },
    want: 'done',
  },
];

const AGENTS: readonly Row[] = [
  {
    why: 'a running agent is working',
    node: { kind: 'agent', state: 'running' },
    want: 'working',
  },
  {
    why: 'a running agent that has not written for five minutes is still running',
    node: { kind: 'agent', state: 'running', lastWriteAt: STALE },
    want: 'working',
  },
  {
    why: 'done is done, however fresh the last write is',
    node: { kind: 'agent', state: 'done', lastWriteAt: FRESH },
    want: 'done',
  },
  {
    why: 'no end-signal and no transcript: unknown, never idle and never working',
    node: { kind: 'agent', state: 'unknown' },
    want: 'unknown',
  },
  {
    why: 'no end-signal, but the transcript moved a moment ago: evidence, not a guess',
    node: { kind: 'agent', state: 'unknown', lastWriteAt: FRESH },
    want: 'working',
  },
  {
    why: 'no end-signal and a stale transcript',
    node: { kind: 'agent', state: 'unknown', lastWriteAt: STALE },
    want: 'unknown',
  },
  {
    why: 'a frozen agent is finished',
    node: { kind: 'agent', state: 'running', lastWriteAt: FRESH, frozen: true },
    want: 'done',
  },
  {
    why: 'except one history never classified, which stays unknown',
    node: { kind: 'agent', state: 'unknown', frozen: true },
    want: 'unknown',
  },
];

for (const [group, rows] of [
  ['session', SESSIONS],
  ['agent', AGENTS],
] as const) {
  test(`activityOf: ${group} table`, () => {
    for (const row of rows) {
      assert.equal(activityOf(row.node, NOW), row.want, row.why);
    }
  });
}

test('the table covers every answer the canvas can draw', () => {
  const seen = new Set([...SESSIONS, ...AGENTS].map((row) => row.want));
  for (const activity of ACTIVITIES) {
    assert.ok(seen.has(activity), `no row in the table produces "${activity}"`);
  }
});

test('the write window is exactly 30 seconds, and it is closed at the far edge', () => {
  assert.equal(RECENT_WRITE_MS, 30_000);
  const at = (offset: number): Activity =>
    activityOf({ kind: 'session', status: 'idle', state: 'alive', lastWriteAt: NOW - offset }, NOW);

  assert.equal(at(0), 'working', 'written this instant');
  assert.equal(at(29_999), 'working', 'a millisecond inside the window');
  assert.equal(at(RECENT_WRITE_MS), 'working', 'exactly 30 s still counts');
  assert.equal(at(30_001), 'idle', 'a millisecond outside it does not');
  assert.equal(at(60_000), 'idle');
});

test('a write from the future is a clock disagreement, not evidence of work', () => {
  // Two machines' clocks, or a transcript on a network share. Whatever the
  // cause, "written in 20 seconds" is not a reason to claim a session is busy.
  assert.equal(
    activityOf({ kind: 'session', status: 'idle', state: 'alive', lastWriteAt: NOW + 20_000 }, NOW),
    'idle',
  );
  assert.equal(
    activityOf({ kind: 'agent', state: 'unknown', lastWriteAt: NOW + 20_000 }, NOW),
    'unknown',
  );
  assert.equal(
    activityOf({ kind: 'agent', state: 'unknown', lastWriteAt: Number.NaN }, NOW),
    'unknown',
  );
});

test('the same node at two instants moves from working to idle on its own', () => {
  // Nothing about the node changes; only the clock does. This is the whole
  // reason `now` is a parameter.
  const node: ActivityNode = { kind: 'session', status: 'idle', state: 'alive', lastWriteAt: NOW };
  assert.equal(activityOf(node, NOW + 10_000), 'working');
  assert.equal(activityOf(node, NOW + 40_000), 'idle');
});

test('the adapters read the fields the canvas actually holds', () => {
  // `SessionView` calls the transcript's mtime `transcriptAt`; `Session`'s own
  // `lastWriteAt` is the *session file*, which is not what this rule is about.
  // Getting those two the wrong way round would make every card read idle.
  assert.equal(
    sessionActivity({ status: 'idle', state: 'alive', transcriptAt: FRESH }, NOW),
    'working',
  );
  assert.equal(sessionActivity({ status: 'idle', state: 'alive' }, NOW), 'idle');
  assert.equal(
    sessionActivity({ status: 'busy', state: 'alive', waitingFor: 'input needed' }, NOW),
    'waiting',
  );
  assert.equal(sessionActivity({ status: 'busy', state: 'alive' }, NOW, true), 'done');

  assert.equal(agentActivity({ state: 'running' }, NOW), 'working');
  assert.equal(agentActivity({ state: 'running' }, NOW, true), 'done');
  assert.equal(agentActivity({ state: 'unknown', lastWriteAt: FRESH }, NOW), 'working');
});

test('every activity maps to one class and one word', () => {
  assert.deepEqual([...ACTIVITY_CLASSES], [
    'is-working',
    'is-waiting',
    'is-idle',
    'is-done',
    'is-unknown',
  ]);
  for (const activity of ACTIVITIES) {
    assert.equal(activityClass(activity), `is-${activity}`);
    assert.equal(activityLabel(activity), activity);
    // Colour is not a state: there is always a word to read.
    assert.ok(activityLabel(activity).length > 0);
  }
  assert.equal(new Set(ACTIVITY_CLASSES).size, ACTIVITIES.length, 'two activities share a class');
});

/* ------------------------------------------------------------------ *
 * The class mapping, end to end.
 *
 * Node has no DOM, so the link between "the renderer sets this class" and
 * "the stylesheet gives it a frame" is a contract between two files rather
 * than something a unit test can observe. Break either half — rename a class,
 * delete a rule, forget the light-mode token — and the canvas silently loses
 * the whole feature. These read the files instead.
 * ------------------------------------------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const css = readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const canvas = readFileSync(path.join(webDir, 'canvas.ts'), 'utf8');

/**
 * Every declaration block whose selector list names `selector`.
 *
 * Crude, and it has to be: a selector can appear in a rule of its own, in a
 * comma-separated group, and again inside a media query, and a test that only
 * looked at the first occurrence would have asserted things about the
 * reduced-motion override instead of about the rule it meant.
 */
function rulesFor(selector: string): string[] {
  const found: string[] = [];
  let at = 0;
  for (;;) {
    const hit = css.indexOf(selector, at);
    if (hit === -1) return found;
    at = hit + selector.length;
    const open = css.indexOf('{', hit);
    const close = css.indexOf('}', open);
    if (open === -1 || close === -1) return found;
    // The selector list of this block: everything between the previous `}` or
    // `{` and this one. If our selector is not in it, this was a substring of
    // some other rule's body and does not count.
    const listStart = Math.max(css.lastIndexOf('}', hit), css.lastIndexOf('{', hit)) + 1;
    if (css.slice(listStart, open).includes(selector)) found.push(css.slice(open + 1, close));
  }
}

test('every activity a session can have paints its frame', () => {
  // `waiting` keeps the amber treatment it has had since WP4; the other four
  // are WP4d's.
  const frames: ReadonlyArray<readonly [string, string]> = [
    ['is-working', '--nz-state-working'],
    ['is-idle', '--nz-state-alive'],
    ['is-done', '--nz-state-done'],
    ['is-unknown', '--nz-state-unknown'],
    ['is-waiting', '--nz-state-waiting'],
  ];
  for (const [className, token] of frames) {
    const selector = `.nz-session.${className} .nz-session__bg`;
    const bodies = rulesFor(selector);
    assert.ok(bodies.length > 0, `${selector} is set by the renderer but styled nowhere`);
    assert.ok(
      bodies.some((body) => body.includes(`stroke: var(${token})`)),
      `${className} does not paint its frame with ${token}`,
    );
  }
});

test('only the working frame moves, and it breathes rather than blinks', () => {
  assert.ok(css.includes('@keyframes nz-frame-pulse'), 'the frame pulse is not defined');

  for (const selector of [
    '.nz-session.is-working .nz-session__bg',
    '.nz-agent.is-working .nz-agent__bg',
  ]) {
    assert.ok(
      rulesFor(selector).some((body) =>
        /animation: nz-frame-pulse 1\.6s ease-in-out infinite/.test(body),
      ),
      `${selector} does not breathe`,
    );
  }

  // Nothing else animates its frame: a fixed colour is the point of `idle` and
  // `done`, and that is exactly what was asked for.
  for (const selector of [
    '.nz-session.is-idle .nz-session__bg',
    '.nz-session.is-done .nz-session__bg',
    '.nz-session.is-unknown .nz-session__bg',
    '.nz-agent.is-done .nz-agent__bg',
  ]) {
    for (const body of rulesFor(selector)) {
      assert.equal(
        /animation:\s*nz-/.test(body),
        false,
        `${selector} animates and should be fixed`,
      );
    }
  }
});

test('reduced motion stops the frame and leaves the word', () => {
  const at = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at !== -1);
  const block = css.slice(at);
  assert.ok(block.includes('.nz-session.is-working .nz-session__bg'), 'the session frame still moves');
  assert.ok(block.includes('.nz-agent.is-working .nz-agent__bg'), 'the agent frame still moves');
  assert.match(block, /animation: none/);
  // The label is drawn on every card in every mode, which is what makes the
  // static frame readable at all.
  assert.ok(css.includes('.nz-session__activity'), 'the session card has no activity label');
  assert.ok(css.includes('.nz-agent__activity'), 'the agent card has no activity label');
});

test('the renderer sets the classes and writes the word, and rebuilds nothing', () => {
  assert.ok(canvas.includes('setActivityClass(els.g, activity)'), 'session cards are not classed');
  assert.ok(canvas.includes('setActivityClass(agentEls.g, activity)'), 'agent cards are not classed');
  assert.ok(canvas.includes('sessionActivity(session, now, frozen)'));
  assert.ok(canvas.includes('agentActivity(agent, now, frozen)'));
  // The state update is a class toggle on a group that already exists. All
  // five classes are written every frame — four off, one on — because a node
  // that stops working has to lose `is-working` as surely as it gains
  // `is-done`, and `setClass` writes nothing when the state already agrees.
  const helper = canvas.slice(
    canvas.indexOf('function setActivityClass('),
    canvas.indexOf('interface ChipEls'),
  );
  assert.match(helper, /for \(const one of ACTIVITIES\)/);
  assert.match(helper, /setClass\(node, activityClass\(one\), one === activity\)/);
  assert.equal(helper.includes('svg('), false, 'a state change creates an element');
});
