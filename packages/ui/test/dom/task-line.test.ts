/**
 * N-WP15b: the task line, driven rather than grepped.
 *
 * The bug this suite exists for was invisible to every test the package had,
 * and both halves of it were invisible for the same reason: the source said
 * exactly the right thing.
 *
 * 1. **The row was never paid for.** N-WP15a put the session card's task line
 *    at `pad + 46` on the strength of "the header already has a 28 px gap
 *    between the folder path and the identity line, so no card changes size".
 *    That 28 px is not spare room — it is this header's ordinary leading, the
 *    same step that separates identity from model and model from meta. So the
 *    line landed 12 px above the identity line and, at 11.5 px type, the two
 *    rows of glyphs touched: the task was drawn *on* the identity row rather
 *    than in a row of its own. `test/task-text.ts` asserted the premise rather
 *    than the pixels and passed throughout.
 *
 * 2. **The header was positioned once.** Every conditional row was written in
 *    `createSession`, which runs the first time a card is drawn and never
 *    again. An element born on a frame with the switch off keeps that y for
 *    ever, so the page could only be right if it had been *loaded* with the
 *    setting already on — press the switch live and the drawing and the
 *    measuring disagreed for the rest of the session.
 *
 * Which is why this drives the real `CanvasRenderer` over the DOM double and
 * reads the attributes it actually wrote. The two frames a *live* switch
 * produces are compared against a canvas that was handed the setting from its
 * first frame, and they have to be the same canvas.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import '../catalogs.ts';
import { FakeElement, root } from './double.ts';
import { makeDemoState } from '../../src/demo.ts';
import type { Placement } from '../../src/pack.ts';
import { CARD, CARD_TASK_LINE, CanvasRenderer, cardSpecFor, measureCards } from '../../web/canvas.ts';

const NOW = 1_788_000_000_000;

/** The demo canvas, which carries a task on every session and every subagent. */
const SESSIONS = makeDemoState({ now: NOW }).sessions;

interface Canvas {
  readonly renderer: CanvasRenderer;
  readonly host: FakeElement;
}

function canvas(): Canvas {
  const host = root();
  return { renderer: new CanvasRenderer(host as unknown as SVGGElement), host };
}

/**
 * One frame, exactly as `app.ts` draws one: measure, place, draw.
 *
 * The placements are stored positions and not a re-pack, which is the other
 * half of the promise — a card the user dragged keeps its corner when the
 * switch moves, and only its height is allowed to change.
 */
function frame(on: Canvas, taskText: boolean, heights: Record<string, number> = {}): void {
  const metrics = measureCards(SESSIONS, new Set(), { taskText, heights });
  const placements = new Map<string, Placement>();
  let y = 0;
  for (const session of SESSIONS) {
    const metric = metrics.get(session.id);
    if (metric === undefined) continue;
    placements.set(session.id, {
      id: session.id,
      x: 0,
      y,
      width: metric.box.width,
      height: metric.box.height,
    });
    y += 1000;
  }
  on.renderer.update(SESSIONS, metrics, placements, NOW, { taskText });
}

/** The `<g>` one session was drawn as. */
function card(on: Canvas, index = 0): FakeElement {
  const cards = on.host.byClass('nz-session');
  const found = cards[index];
  assert.ok(found !== undefined, 'the canvas drew no card');
  return found;
}

/** A number the renderer wrote, by the class of the element it wrote it on. */
function attr(within: FakeElement, className: string, name: string): number {
  const node = within.byClass(className)[0];
  assert.ok(node !== undefined, `the card has no .${className}`);
  const value = node.getAttribute(name);
  assert.ok(value !== null, `.${className} has no ${name}`);
  return Number(value);
}

/** Every row of the header a card drew, as baselines. */
interface Rows {
  readonly title: number;
  readonly path: number;
  readonly task: number;
  readonly identity: number;
  readonly model: number;
  readonly meta: number;
}

function rows(within: FakeElement): Rows {
  return {
    title: attr(within, 'nz-session__title', 'y'),
    path: attr(within, 'nz-session__path', 'y'),
    task: attr(within, 'nz-session__task', 'y'),
    identity: attr(within, 'nz-session__identity', 'y'),
    model: attr(within, 'nz-session__model', 'y'),
    meta: attr(within, 'nz-session__meta', 'y'),
  };
}

test('the demo canvas is a fair test of this: every session carries a task', () => {
  assert.ok(SESSIONS.length > 1);
  for (const session of SESSIONS) {
    assert.ok(
      typeof session.task === 'string' && session.task.length > 0,
      `${session.id} has nothing to draw on the line`,
    );
  }
});

test('the task line has a row of its own, and the identity line moved out of it', () => {
  const on = canvas();
  frame(on, true);
  const drawn = rows(card(on));

  // Below the folder, where N-WP15a put it: what the session was asked to do
  // belongs with what the session *is*, not with its pid and its status.
  assert.ok(drawn.task > drawn.path, 'the task line is not under the folder path');
  assert.equal(drawn.task, CARD.pad + 46, 'the line moved off the row N-WP15a chose');

  /*
   * And the row underneath it is a whole row away. This is the assertion the
   * bug would have failed: 74 − 62 = 12 px between two 11.5 px baselines is not
   * a gap, it is an overlap, and it is what "drawn on the identity line" meant.
   * The floor is the header's own tightest step — title to path — so the task
   * can never again be closer to the line under it than two rows of this card
   * ever are to each other.
   */
  const tightest = drawn.path - drawn.title;
  assert.ok(
    drawn.identity - drawn.task >= tightest,
    `the task line is ${drawn.identity - drawn.task}px above the identity line, tighter than the ${tightest}px this header ever puts between two rows`,
  );
});

test('switching it on moves the identity line down by exactly the line it paid for', () => {
  const off = canvas();
  frame(off, false);
  const before = rows(card(off));

  const on = canvas();
  frame(on, true);
  const after = rows(card(on));

  // The rows above the task are where they were, so the top of every card on
  // the canvas is the top it always had.
  assert.equal(after.title, before.title);
  assert.equal(after.path, before.path);
  assert.equal(after.task, before.task);
  // And everything under it moved by one line — the same line `measureCards`
  // sized the card with, which is what keeps WP4c's containment rule true.
  for (const row of ['identity', 'model', 'meta'] as const) {
    assert.equal(after[row], before[row] + CARD_TASK_LINE, `${row} did not move`);
  }
  assert.equal(
    cardSpecFor(true).headerHeight - cardSpecFor(false).headerHeight,
    CARD_TASK_LINE,
    'the header height and the rows inside it disagree',
  );
});

test('a canvas switched on live is the canvas that was loaded switched on', () => {
  /*
   * The regression, in one comparison.
   *
   * The left-hand canvas is a page opened with the setting off and switched on
   * afterwards — two frames through the same renderer, reusing the elements the
   * first frame created. The right-hand one is a page loaded with the setting
   * already on: one frame, fresh elements. Every number on the two cards has to
   * match, because to the person looking at the screen they are the same page.
   */
  const toggled = canvas();
  frame(toggled, false);
  frame(toggled, true);

  const loaded = canvas();
  frame(loaded, true);

  assert.deepEqual(rows(card(toggled)), rows(card(loaded)));
  assert.equal(
    attr(card(toggled), 'nz-session__bg', 'height'),
    attr(card(loaded), 'nz-session__bg', 'height'),
    'the card that was switched on live is a different height',
  );
  // The rule, the chevron and the folded-tree chips ride on the header too, and
  // all three were positioned once at creation before N-WP15b.
  const toggledCard = card(toggled);
  const loadedCard = card(loaded);
  for (const marker of ['nz-hidden', 'nz-chevron', 'nz-summary']) {
    assert.equal(
      toggledCard.byClass(marker)[0]?.getAttribute('transform'),
      loadedCard.byClass(marker)[0]?.getAttribute('transform'),
      `.${marker} kept the geometry of the frame it was created on`,
    );
  }
  // The subagent nodes are the half N-WP15a did get right; they are here so a
  // fix to the card cannot quietly break them.
  assert.equal(
    attr(toggledCard, 'nz-agent__bg', 'height'),
    attr(loadedCard, 'nz-agent__bg', 'height'),
  );
});

test('switching it off again gives back exactly the card that was there before', () => {
  const on = canvas();
  frame(on, false);
  const before = rows(card(on));
  const height = attr(card(on), 'nz-session__bg', 'height');

  frame(on, true);
  assert.notEqual(attr(card(on), 'nz-session__bg', 'height'), height, 'nothing grew');

  frame(on, false);
  assert.deepEqual(rows(card(on)), before);
  assert.equal(attr(card(on), 'nz-session__bg', 'height'), height);
  // And the line is gone rather than merely moved: an off canvas has no task in
  // its text at all, which is the promise N-WP15a made about the setting.
  assert.equal(card(on).byClass('nz-session__task')[0]?.getAttribute('display'), 'none');
});

test('a card the user sized keeps its corner and grows by the line', () => {
  /*
   * N-WP10 and WP4c together. A stored height is a *floor* and never a value,
   * so a card that was dragged taller than its tree keeps that height when the
   * line appears — and one that was dragged down to its contents grows, because
   * the alternative is a header drawn outside the card it was sized around.
   * Either way the placement is the placement it had: the switch never moves a
   * card somebody put somewhere.
   */
  const first = SESSIONS[0];
  assert.ok(first !== undefined);
  // Folded, so the tree contributes a fixed strip and the only thing that can
  // move is the header. An open tree grows too — every node in it is a line
  // taller — and that sum would hide the number this is about.
  const folded = new Set([first.id]);
  const snug = measureCards([first], folded, { taskText: false }).get(first.id);
  assert.ok(snug !== undefined);
  assert.equal(snug.box.height, CARD.headerHeight + CARD.collapsedHeight);

  const heights = { [first.id]: snug.box.contentHeight };
  const grown = measureCards([first], folded, { taskText: true, heights }).get(first.id);
  assert.ok(grown !== undefined);
  assert.equal(grown.box.height, snug.box.height + CARD_TASK_LINE, 'the header row was not paid for');

  const roomy = { [first.id]: snug.box.contentHeight + 400 };
  const kept = measureCards([first], folded, { taskText: true, heights: roomy }).get(first.id);
  assert.equal(
    kept?.box.height,
    snug.box.contentHeight + 400,
    'a dragged height stopped being a floor',
  );
});
