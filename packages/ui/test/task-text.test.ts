/**
 * N-WP15a, the browser's half: the switch, the query string, the geometry, and
 * the gate that keeps the demo canvas honest.
 *
 * Node has no DOM, so the drawing is asserted the way the rest of this package
 * asserts drawing — as a contract between the files that have to agree. That is
 * not a weaker test than a rendered one would be for what is being claimed
 * here: the claim is *the page never draws a task line unless the setting is
 * on, and the measure pass and the draw pass are told the same thing*, and both
 * halves of that are visible in the source.
 */
import assert from 'node:assert/strict';

import '../test/catalogs.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { catalogs } from '../test/catalogs.ts';
import { DEMO_AGENT_LABELS, DEMO_BRIEFS, DEMO_TASKS, makeDemoState } from '../src/demo.ts';
import { LOCALES } from '../src/i18n.ts';
import {
  TASK_TEXT_KEY,
  readTaskText,
  taskQuery,
  withTaskQuery,
  writeTaskText,
} from '../src/task-text.ts';
import { memoryStorage, type StorageLike } from '../src/workspace.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
const canvas = readFileSync(path.join(webDir, 'canvas.ts'), 'utf8');
const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');
const css = readFileSync(path.join(webDir, 'styles.css'), 'utf8');

/* ------------------------------------------------------------------ *
 * The preference
 * ------------------------------------------------------------------ */

test('off is the default, and everything that is not a yes is a no', () => {
  // The single most important line in this package. A fresh install, a new
  // browser, a private window, a profile whose storage was cleared: all of them
  // show no task text, and none of them inherits the answer from anywhere.
  assert.equal(readTaskText(memoryStorage()), false);

  for (const stored of [
    'true',
    '1',
    '{}',
    '{"on":"yes"}',
    '{"on":1}',
    '{"v":1}',
    'not json at all',
    '[]',
    'null',
  ]) {
    assert.equal(
      readTaskText(memoryStorage({ [TASK_TEXT_KEY]: stored })),
      false,
      `"${stored}" is not a document this module wrote`,
    );
  }
});

test('the choice round-trips and is versioned', () => {
  const storage = memoryStorage();
  writeTaskText(storage, true);
  assert.equal(readTaskText(storage), true);
  // Versioned rather than a bare boolean, like every other preference here, so
  // a later setting can join it without a migration.
  assert.deepEqual(JSON.parse(storage.getItem(TASK_TEXT_KEY) ?? 'null'), { v: 1, on: true });

  writeTaskText(storage, false);
  assert.equal(readTaskText(storage), false);
});

test('a storage that throws is a canvas that works and forgets', () => {
  // A private window with site data blocked. The switch stops being remembered
  // across a reload; nothing else changes, and nothing throws into the frame.
  const hostile: StorageLike = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => undefined,
  };
  assert.equal(readTaskText(hostile), false);
  assert.doesNotThrow(() => writeTaskText(hostile, true));
});

test('the query string is the whole protocol, and it is one string', () => {
  assert.equal(taskQuery(false), '');
  assert.equal(taskQuery(true), 'task=1');
  assert.equal(withTaskQuery('/api/events', false), '/api/events');
  assert.equal(withTaskQuery('/api/events', true), '/api/events?task=1');
  // A path that already carries a query keeps it. The history routes take
  // `limit` and `offset`, so a `?` here would have swallowed them.
  assert.equal(withTaskQuery('/api/history?limit=50', true), '/api/history?limit=50&task=1');
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

test('the setting reaches all four places, and they cannot disagree', () => {
  /*
   * The four are not a list of call sites, they are four different bugs:
   *
   * - the measure pass, or a tree is drawn outside the card sized around it;
   * - the draw pass, or the line is missing from a card that made room for it;
   * - the stream, or the field is never sent at all;
   * - the history fetch, or the line works everywhere except the last place
   *   anybody looks.
   */
  assert.ok(app.includes('let taskText = readTaskText(storage);'), 'read once, at start-up');
  assert.match(app, /measureCards\(sessions, collapsed, \{[\s\S]{0,200}taskText,/);
  assert.match(app, /renderer\.update\([\s\S]{0,400}taskText,\s*\}\)\.bounds;/);
  assert.ok(app.includes("withTaskQuery('/api/events', taskText)"), 'the stream carries it');
  assert.ok(app.includes('httpTransport(() => taskText)'), 'so does a history open');

  // The resize gesture asks the same question, because the minimum width of a
  // card depends on a tree whose nodes are a line taller.
  assert.ok(app.includes('cardMinimumFor(session, metric.collapsed, taskText)'));
});

test('moving the switch re-opens the stream, because the server decided at subscribe', () => {
  // The server reads `?task=1` once, when it accepts the subscription, so a
  // change of mind is a new connection rather than a new frame on the old one.
  // Leaving the old one open would go on pushing frames of the old shape.
  //
  // N-WP15b: and the last of the four is a whole frame — measure, place, draw —
  // because both card geometries move with the setting now. That frame is
  // driven in `test/dom/task-line.test.ts`; what is asserted here is only that
  // the four steps are present and in this order.
  assert.match(
    app,
    /taskText = next;\s*\n\s*writeTaskText\(storage, taskText\);[\s\S]{0,160}restartStream\(\);\s*\n\s*schedule\(\);/,
    'the switch has to save, reconnect and redraw',
  );
  assert.ok(app.includes('source.close();'), 'the old stream is closed, not abandoned');
});

test('both geometries pay for the line, and both pay through one function', () => {
  /*
   * N-WP15b corrects what N-WP15a claimed here.
   *
   * The old version of this test asserted that a session card is the same
   * height in both states, on the reasoning that the header "already had a
   * 28 px gap" between the folder path and the identity line. It does not: that
   * 28 px is the ordinary leading between two consecutive rows of this header,
   * the same step it puts between identity and model. The line went into it and
   * landed 12 px above the identity line — two rows of 11.5 px type touching —
   * and this test passed anyway, because it asserted the premise instead of the
   * pixels. `test/dom/task-line.test.ts` asserts the pixels now.
   *
   * So the card pays for its row exactly as the node has always paid for its
   * own, and the two constants are the two answers: `CARD_TASK_LINE` for the
   * header and `AGENT.taskLine` for the node. What has *not* changed is the
   * promise underneath: a stored height is a floor and a stored position is
   * read back unchanged, so a card the user placed keeps its corner.
   */
  assert.ok(canvas.includes('headerHeight: 180'), 'the header height moved off its constant');
  assert.ok(canvas.includes('export const CARD_TASK_LINE = 16'), 'the card pays for its row');
  assert.match(
    canvas,
    /const CARD_TASK: CardSpec & \{ readonly radius: number \} = \{\s*\n\s*\.\.\.CARD,\s*\n\s*headerHeight: CARD\.headerHeight \+ CARD_TASK_LINE,/,
  );
  assert.match(canvas, /const task = svg\('text', 'nz-session__task'\);/);
  assert.match(canvas, /setAttr\(task, 'y', HEADER\.task\);/, 'still under the folder path');
  assert.match(canvas, /task: CARD\.pad \+ 46,/, 'and still where N-WP15a put it');

  assert.ok(canvas.includes('taskLine: 15'), 'the node pays for its extra line');
  assert.match(canvas, /export const TREE_SPEC_TASK: TreeSpec = \{/);
  assert.match(
    canvas,
    /export function treeSpecFor\(showTask: boolean\): TreeSpec \{\s*\n\s*return showTask \? TREE_SPEC_TASK : TREE_SPEC;/,
    'one function, so the measure pass and the draw pass cannot drift',
  );
  assert.match(
    canvas,
    /export function cardSpecFor\(showTask: boolean\): CardSpec & \{ readonly radius: number \} \{\s*\n\s*return showTask \? CARD_TASK : CARD;/,
    'and one for the card, for the same reason',
  );
  // Both halves of the measure pass ask the same question on the same frame.
  assert.match(canvas, /const spec = treeSpecFor\(showTask\);/);
  assert.match(canvas, /const card = cardSpecFor\(showTask\);/);
  // The background grows with the spec, or the extra line is drawn outside the
  // rectangle it belongs to.
  assert.ok(
    canvas.includes("setAttr(agentEls.bg, 'height', showTask ? AGENT.height + AGENT.taskLine : AGENT.height)"),
  );
});

test('the header is positioned on every frame, not once when the card is born', () => {
  /*
   * The other half of the N-WP15b bug, and the half that made it look like a
   * *live switch* problem: every conditional row was written in
   * `createSession`, which runs once. An element born on a frame with the
   * setting off kept that y for ever, so the page was only right if it had been
   * loaded with the setting already on.
   *
   * `test/dom/task-line.test.ts` drives the two frames and compares them. What
   * is asserted here is that the numbers have no second home to drift back to:
   * the rows live in one table and nothing writes a literal y into a header
   * element at creation.
   */
  assert.match(canvas, /const HEADER = \{/, 'the rows are not in one table');
  assert.match(canvas, /const shift = label\.taskText === true \? CARD_TASK_LINE : 0;/);
  for (const row of ['identity', 'model', 'meta']) {
    assert.ok(
      canvas.includes(`setAttr(els.${row}, 'y', HEADER.`),
      `the ${row} row is not written on every frame`,
    );
  }
  // The rule, the folded-tree chips and the chevron ride on the header too.
  assert.ok(canvas.includes("setAttr(els.ruleGroup, 'transform'"));
  assert.ok(canvas.includes("setAttr(els.hiddenRow, 'transform'"));
  assert.ok(canvas.includes("setAttr(els.chevron, 'transform'"));
  const created = canvas.slice(
    canvas.indexOf('private createSession('),
    canvas.indexOf('private createAgent('),
  );
  assert.equal(
    /setAttr\((?:identity|activity|model|meta|cost|context|blocked), 'y'/.test(created),
    false,
    'a header row is still positioned once, at creation',
  );
});

test('with the switch off there is no task line in the DOM at all', () => {
  /*
   * Not "an empty one", and not "one with `visibility: hidden`". Both elements
   * are created once and reused across frames — that is how this renderer keeps
   * a wheel gesture at 60 fps — so what is asserted is that the *content* is
   * cleared and the element is taken out of the layout whenever the setting is
   * off, on the same statement, so the two can never fall out of step.
   */
  assert.match(
    canvas,
    /const taskLine = label\.taskText === true \? session\.task : undefined;\s*\n\s*setAttr\(els\.task, 'display', taskLine === undefined \? 'none' : 'inline'\);\s*\n[\s\S]{0,260}setText\(els\.task, taskLine === undefined \? '' : /,
    'the session card clears the text and hides the node together',
  );
  assert.match(
    canvas,
    /const brief = showTask \? \(agent\.description \?\? agent\.task\) : undefined;\s*\n\s*setAttr\(agentEls\.task, 'display', brief === undefined \? 'none' : 'inline'\);\s*\n\s*setText\(agentEls\.task, brief === undefined \? '' : /,
    'and so does the subagent node',
  );

  // The hover card's block is hidden rather than filled with `unknown`: an
  // absent task is a session nobody has typed at, not a missing measurement.
  assert.match(
    app,
    /private setTask\(text: string \| undefined\): void \{\s*\n\s*this\.task\.hidden = text === undefined;\s*\n\s*setText\(this\.task, text \?\? ''\);/,
  );
});

test('the node shows the label and the hover card shows the brief', () => {
  // Opposite choices for opposite reasons: a node is 156 px wide and the
  // `Agent` tool's three-word `description` is what fits there, while the hover
  // card has room for the 300 characters that say what the job actually was.
  assert.ok(canvas.includes('const brief = showTask ? (agent.description ?? agent.task) : undefined;'));
  assert.ok(app.includes('this.setTask(agent.task ?? agent.description);'));
  assert.ok(app.includes('this.setTask(session.task);'));
});

test('the two switches are in the markup and the styles have a rule for the line', () => {
  assert.ok(html.includes('id="task-text-toggle"'));
  assert.ok(html.includes('data-nz-t="settings.taskText"'));
  assert.ok(html.includes('data-nz-t="settings.taskTextNote"'));
  // The hard switch is the shell's: it restarts the child server, and in a
  // browser the same thing is a CLI flag. So it lives inside the group that is
  // hidden unless `window.__TAURI__` is there.
  const shellGroup = html.slice(html.indexOf('id="shell-group"'), html.indexOf('id="auto-tabs"'));
  assert.ok(shellGroup.includes('id="recording-toggle"'), 'recording mode is shell-only');
  assert.ok(shellGroup.includes('data-nz-t="settings.recording"'));

  assert.ok(css.includes('.nz-session__task'), 'the card line has a rule of its own');
  assert.ok(css.includes('.nz-agent__task'), 'so does the node line');
  assert.ok(css.includes('.nz-card__task'), 'and the hover card block');
});

test('the shell speaks the two commands the recording switch needs', () => {
  const shell = readFileSync(path.join(webDir, 'shell.ts'), 'utf8');
  assert.ok(shell.includes("this.call<boolean>('get_task_text_off')"));
  assert.ok(shell.includes("this.call<boolean>('set_task_text_off', { off })"));
  // A shell that did not answer is not "on": the safe direction leaves the
  // browser's own switch in charge, and that switch is off by default.
  assert.ok(app.includes('void shell.taskTextOff().then((off) => paintRecording(off ?? false));'));
});

/* ------------------------------------------------------------------ *
 * The demo gate
 * ------------------------------------------------------------------ */

test('every task on the demo canvas is invented', () => {
  /*
   * The gate that matters most in this file, and the reason it exists is
   * narrow: a demo screenshot is what ends up in a README. Every other value in
   * `demo.ts` is a number or a placeholder path, where a slip produces a wrong
   * pid. These are *sentences*, and a slip produces a picture of what somebody
   * was actually working on.
   *
   * So: every task the demo state carries has to come out of one of the three
   * hand-written lists, and nothing may be read from a machine, a transcript or
   * a fixture to build them.
   */
  const state = makeDemoState({ now: 1_788_756_000_000 });
  const tasks = new Set(DEMO_TASKS);
  const briefs = new Set(DEMO_BRIEFS);
  const labels = new Set(DEMO_AGENT_LABELS);

  assert.ok(state.sessions.length > 0);
  for (const session of state.sessions) {
    assert.ok(session.task !== undefined, `${session.id} carries no task to check`);
    assert.ok(tasks.has(session.task), `${session.id}: ${session.task}`);
    for (const agent of session.agents) {
      assert.ok(agent.task !== undefined && briefs.has(agent.task), `${agent.id}: ${agent.task}`);
      assert.ok(
        agent.description !== undefined && labels.has(agent.description),
        `${agent.id}: ${agent.description}`,
      );
    }
  }
});

test('the demo is the same canvas on every run, tasks included', () => {
  // Determinism is the whole reason the demo exists, and the task picker is a
  // character sum rather than the shared pseudo-random generator precisely
  // because that generator's answer depends on how many times it has been
  // called before.
  const one = makeDemoState({ now: 1_788_756_000_000 });
  const two = makeDemoState({ now: 1_788_756_000_000 });
  assert.deepEqual(
    one.sessions.map((session) => session.task),
    two.sessions.map((session) => session.task),
  );
});

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

test('the new strings are in all six catalogues', () => {
  // `i18n.test.ts` already asserts key parity across the six files; this names
  // the keys, so deleting one from all six at once still fails here.
  const keys = [
    'settings.taskText',
    'settings.taskTextNote',
    'settings.recording',
    'settings.recordingNote',
    'menu.openLink',
    'menu.copyLink',
    'hint.recordingFailed',
  ];
  for (const locale of LOCALES) {
    for (const key of keys) {
      const value = catalogs[locale][key];
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `${locale} is missing ${key}`,
      );
    }
  }

  // The note is the whole privacy contract in one line, and it has to say all
  // three parts of it in every language, or somebody switches on a feature
  // whose terms they were only told in English.
  assert.match(catalogs.en['settings.taskTextNote'] ?? '', /transcript/i);
  assert.match(catalogs.en['settings.taskTextNote'] ?? '', /disk/i);
  assert.match(catalogs.en['settings.taskTextNote'] ?? '', /browser/i);
});
