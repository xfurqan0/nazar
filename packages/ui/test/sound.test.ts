/**
 * N-WP16: the rules, the settings, the player, and the file it plays.
 *
 * The whole feature is *restraint* — a notification that fires too often is
 * switched off within a week — so almost everything here is about the canvas
 * staying quiet: one sound per session, a debounce, an opening silence, quiet
 * hours, and no sound at all in the demo. The one case worth naming twice is the
 * last test in the second block: with the setting off, the audio context is
 * never asked for a source. A feature that decides not to make a sound and then
 * makes one anyway is the bug that would be reported as *this thing beeps at me*
 * and never reproduced by whoever reads the switch.
 *
 * The asset block re-runs `scripts/render-sound.mjs` and compares the bytes to
 * the committed file, which is the icon discipline applied to a sound: the WAV
 * ships in the repository, and what keeps it honest is that it can be rebuilt.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SoundAudioContext, SoundSettings, SoundSourceNode } from '../src/sound.ts';
import {
  DEFAULT_SOUND,
  SOUND_DEBOUNCE_MS,
  SOUND_KEY,
  SOUND_OPENING_SILENCE_MS,
  SoundPlayer,
  SoundRules,
  inQuietHours,
  minutesOfDay,
  newlyWaiting,
  parseClock,
  readSound,
  soundDecision,
  waitingIds,
  writeSound,
} from '../src/sound.ts';
import type { StorageLike } from '../src/workspace.ts';
import { memoryStorage } from '../src/workspace.ts';

const NOW = 1_788_756_000_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');

/* ------------------------------------------------------------------ *
 * The stored settings
 * ------------------------------------------------------------------ */

test('a browser nobody has asked plays on an ending and not on a prompt', () => {
  assert.equal(DEFAULT_SOUND.onSessionEnd, true, 'the feature is off out of the box');
  assert.equal(DEFAULT_SOUND.onWaiting, false, 'permission prompts are the common case');
  assert.equal(DEFAULT_SOUND.quietHours, false);
  assert.equal(DEFAULT_SOUND.hinted, false);
  assert.deepEqual(readSound(memoryStorage()), DEFAULT_SOUND);
  assert.deepEqual(readSound(undefined), DEFAULT_SOUND, 'a browser with no storage still rings');
});

test('the settings round-trip, and a document from an older build keeps what it has', () => {
  const storage = memoryStorage();
  const chosen: SoundSettings = {
    onSessionEnd: false,
    onWaiting: true,
    quietHours: true,
    from: '23:30',
    to: '06:15',
    hinted: true,
  };
  writeSound(storage, chosen);
  assert.deepEqual(readSound(storage), chosen);

  // A document written before a field existed: the field it does carry survives,
  // and the ones it does not fall back rather than blanking the whole document.
  const older = memoryStorage({ [SOUND_KEY]: JSON.stringify({ v: 1, onWaiting: true }) });
  assert.deepEqual(readSound(older), { ...DEFAULT_SOUND, onWaiting: true });
});

test('anything this build did not write reads as the defaults rather than as silence', () => {
  for (const raw of ['', 'not json', '[]', 'null', '"on"', '42']) {
    assert.deepEqual(
      readSound(memoryStorage({ [SOUND_KEY]: raw })),
      DEFAULT_SOUND,
      `${raw} was not read as the defaults`,
    );
  }
  // A field of the wrong type is one field, not a broken document.
  const wrong = memoryStorage({ [SOUND_KEY]: JSON.stringify({ onSessionEnd: 'yes', from: 7 }) });
  assert.deepEqual(readSound(wrong), DEFAULT_SOUND);
});

test('a storage that throws is a working canvas that forgets the switches', () => {
  const angry: StorageLike = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => undefined,
  };
  assert.deepEqual(readSound(angry), DEFAULT_SOUND);
  assert.doesNotThrow(() => writeSound(angry, DEFAULT_SOUND));
});

/* ------------------------------------------------------------------ *
 * Quiet hours — nazar-tray's semantics, in TypeScript
 * ------------------------------------------------------------------ */

test('a clock is two digits, a colon and two digits, and nothing else', () => {
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('07:30'), 450);
  assert.equal(parseClock('23:59'), 1439);
  for (const bad of ['7:00', '24:00', '12:60', '0700', '', 'ab:cd', '07:30:00', ' 07:30']) {
    assert.equal(parseClock(bad), undefined, `${bad} was read as a time`);
  }
});

test('a quiet range wraps midnight, and equal endpoints are empty rather than all day', () => {
  // The night range: 22:00 to 07:00 is two pieces of one stretch.
  assert.equal(inQuietHours('22:00', '07:00', 22 * 60), true);
  assert.equal(inQuietHours('22:00', '07:00', 23 * 60 + 59), true);
  assert.equal(inQuietHours('22:00', '07:00', 0), true, 'midnight is inside the night');
  assert.equal(inQuietHours('22:00', '07:00', 6 * 60 + 59), true);
  assert.equal(inQuietHours('22:00', '07:00', 7 * 60), false, 'the end is exclusive');
  assert.equal(inQuietHours('22:00', '07:00', 12 * 60), false);

  // A daytime range, which is the same rule read forwards.
  assert.equal(inQuietHours('13:00', '14:00', 13 * 60), true);
  assert.equal(inQuietHours('13:00', '14:00', 14 * 60), false);
  assert.equal(inQuietHours('13:00', '14:00', 12 * 60), false);

  // Somebody who wants no sound at all turns the switch off; `22:00–22:00`
  // reading as *always* would silence the product by accident.
  assert.equal(inQuietHours('22:00', '22:00', 22 * 60), false);

  // And a range nobody can parse suppresses nothing: the failure mode of a typo
  // has to be more sound, never silence.
  assert.equal(inQuietHours('', '07:00', 2 * 60), false);
  assert.equal(inQuietHours('22:00', 'evening', 2 * 60), false);
});

test('local minutes are read off the machine clock, not off UTC', () => {
  const at = new Date(2026, 8, 9, 3, 17, 0).getTime();
  assert.equal(minutesOfDay(at), 3 * 60 + 17);
});

/* ------------------------------------------------------------------ *
 * The decision table
 * ------------------------------------------------------------------ */

/** A gate that would play, so each case below changes exactly one thing. */
function gate(over: Partial<Parameters<typeof soundDecision>[0]> = {}) {
  return {
    enabled: true,
    demo: false,
    alreadyPlayed: false,
    now: NOW,
    openedAt: NOW - 60_000,
    localMinutes: 12 * 60,
    ...over,
  };
}

test('the table: every silence has a reason, and only one case rings', () => {
  const cases: ReadonlyArray<readonly [string, ReturnType<typeof gate>, string, boolean]> = [
    ['nothing in the way', gate(), 'play', true],
    ['the switch is off', gate({ enabled: false }), 'off', false],
    ['the demo canvas', gate({ demo: true }), 'demo', false],
    ['this session already rang', gate({ alreadyPlayed: true }), 'repeat', false],
    ['the page has just opened', gate({ openedAt: NOW - 1000 }), 'opening', false],
    ['the page opened this instant', gate({ openedAt: NOW }), 'opening', false],
    [
      'the opening silence is over',
      gate({ openedAt: NOW - SOUND_OPENING_SILENCE_MS }),
      'play',
      true,
    ],
    [
      'inside quiet hours',
      gate({ quiet: { from: '22:00', to: '07:00' }, localMinutes: 2 * 60 }),
      'quiet',
      false,
    ],
    [
      'outside quiet hours',
      gate({ quiet: { from: '22:00', to: '07:00' }, localMinutes: 12 * 60 }),
      'play',
      true,
    ],
    ['a sound half a second ago', gate({ lastPlayedAt: NOW - 500 }), 'debounce', false],
    [
      'a sound exactly the debounce ago',
      gate({ lastPlayedAt: NOW - SOUND_DEBOUNCE_MS }),
      'play',
      true,
    ],
  ];
  for (const [name, input, reason, plays] of cases) {
    const decision = soundDecision(input);
    assert.equal(decision.reason, reason, name);
    assert.equal(decision.play, plays, name);
  }
});

test('the switch outranks the clock: an off setting is reported as off', () => {
  // Order matters for what the reason *says*, and the reason is what a bug
  // report is written from. "It is quiet hours" would be a wrong explanation of
  // a canvas whose owner had simply turned the sound off.
  const decision = soundDecision(
    gate({ enabled: false, demo: true, quiet: { from: '00:00', to: '23:59' }, localMinutes: 60 }),
  );
  assert.equal(decision.reason, 'off');
});

/* ------------------------------------------------------------------ *
 * The bookkeeping
 * ------------------------------------------------------------------ */

/** A rules object over a clock the test moves by hand. */
function makeRules(over: { settings?: Partial<SoundSettings>; demo?: boolean } = {}) {
  let now = NOW;
  let plays = 0;
  const settings: SoundSettings = { ...DEFAULT_SOUND, ...over.settings };
  const rules = new SoundRules({
    play: () => {
      plays += 1;
    },
    settings: () => settings,
    now: () => now,
    // Well past the opening silence, so a test about the debounce is about the
    // debounce.
    openedAt: NOW - 60_000,
    localMinutes: () => 12 * 60,
    ...(over.demo === undefined ? {} : { demo: over.demo }),
  });
  return {
    rules,
    get plays() {
      return plays;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('one session rings once, however many times it is announced', () => {
  const box = makeRules();
  assert.equal(box.rules.handle({ kind: 'ended', sessionId: 'a' }).reason, 'play');
  box.advance(10_000);
  assert.equal(box.rules.handle({ kind: 'ended', sessionId: 'a' }).reason, 'repeat');
  assert.equal(box.plays, 1);
});

test('four sessions ending together are one sound', () => {
  const box = makeRules();
  for (const id of ['a', 'b', 'c', 'd']) {
    box.rules.handle({ kind: 'ended', sessionId: id });
    box.advance(80);
  }
  assert.equal(box.plays, 1, 'closing four terminals is one gesture');
  // And the debounce lets go on its own.
  box.advance(SOUND_DEBOUNCE_MS);
  assert.equal(box.rules.handle({ kind: 'ended', sessionId: 'e' }).reason, 'play');
  assert.equal(box.plays, 2);
});

test('a sound refused is not owed later', () => {
  // A session that ended inside quiet hours does not ring when they end. Silence
  // is silence, not a queue — a canvas that emptied a backlog at seven in the
  // morning would be the loudest thing on the machine.
  const box = makeRules({ settings: { quietHours: true, from: '00:00', to: '23:59' } });
  assert.equal(box.rules.handle({ kind: 'ended', sessionId: 'a' }).reason, 'quiet');
  assert.equal(box.plays, 0);
  assert.equal(box.rules.playedCount, 1, 'the session was recorded even though it was refused');
});

test('the two kinds are two switches and two keys', () => {
  const box = makeRules({ settings: { onWaiting: true } });
  assert.equal(box.rules.handle({ kind: 'waiting', sessionId: 'a' }).reason, 'play');
  box.advance(SOUND_DEBOUNCE_MS);
  // The same session ending afterwards is a different event and rings again.
  assert.equal(box.rules.handle({ kind: 'ended', sessionId: 'a' }).reason, 'play');
  assert.equal(box.plays, 2);

  const quietOnPrompts = makeRules();
  assert.equal(quietOnPrompts.rules.handle({ kind: 'waiting', sessionId: 'a' }).reason, 'off');
});

test('the demo canvas is silent whatever the switches say', () => {
  const box = makeRules({ demo: true, settings: { onSessionEnd: true, onWaiting: true } });
  assert.equal(box.rules.handle({ kind: 'ended', sessionId: 'a' }).reason, 'demo');
  assert.equal(box.plays, 0);
});

test('the Test button plays through every rule, because it is a question', () => {
  const box = makeRules({ settings: { onSessionEnd: false, quietHours: true, from: '00:00', to: '23:59' } });
  box.rules.demonstrate();
  assert.equal(box.plays, 1);
});

/* ------------------------------------------------------------------ *
 * The waiting transition
 * ------------------------------------------------------------------ */

test('waiting is a transition between frames, not a state', () => {
  const before = waitingIds([
    { id: 'a', status: 'waiting' },
    { id: 'b', status: 'busy' },
  ]);
  assert.deepEqual([...before], ['a']);

  const after = waitingIds([
    { id: 'a', status: 'waiting' },
    { id: 'b', status: 'busy', waitingFor: 'permission prompt' },
    { id: 'c', status: 'idle' },
  ]);
  assert.deepEqual([...after].sort(), ['a', 'b']);
  assert.deepEqual(newlyWaiting(before, after), ['b'], 'a is still waiting, not newly waiting');
  assert.deepEqual(newlyWaiting(after, after), []);
});

/* ------------------------------------------------------------------ *
 * The player, over a fake audio context
 * ------------------------------------------------------------------ */

class FakeSource implements SoundSourceNode {
  buffer: unknown = null;

  connectedTo: unknown;

  started = 0;

  connect(destination: unknown): unknown {
    this.connectedTo = destination;
    return destination;
  }

  start(): void {
    this.started += 1;
  }
}

class FakeContext implements SoundAudioContext {
  state = 'suspended';

  readonly destination = { speakers: true };

  resumes = 0;

  decodes = 0;

  readonly sources: FakeSource[] = [];

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = 'running';
  }

  async decodeAudioData(data: ArrayBuffer): Promise<unknown> {
    this.decodes += 1;
    return { bytes: data.byteLength };
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

/** Let every pending microtask and `then` chain finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('nothing is built and nothing is fetched until the first gesture', async () => {
  const context = new FakeContext();
  let created = 0;
  let loaded = 0;
  const player = new SoundPlayer({
    create: () => {
      created += 1;
      return context;
    },
    load: async () => {
      loaded += 1;
      return new ArrayBuffer(8);
    },
  });

  assert.equal(player.unlocked, false);
  assert.equal(player.play(), false, 'a page nobody has clicked cannot make a sound');
  await settle();
  assert.equal(created, 0, 'an audio context was built before the user touched the page');
  assert.equal(loaded, 0, 'the clip was fetched by a page nobody clicked');
});

test('the first gesture builds one context, and the clip is decoded once and reused', async () => {
  const context = new FakeContext();
  let created = 0;
  let loaded = 0;
  const player = new SoundPlayer({
    create: () => {
      created += 1;
      return context;
    },
    load: async () => {
      loaded += 1;
      return new ArrayBuffer(8);
    },
  });

  assert.equal(await player.unlock(), true);
  // Idempotent: two gestures, one context.
  assert.equal(await player.unlock(), true);
  assert.equal(created, 1);
  assert.ok(context.resumes >= 1);

  assert.equal(player.play(), true);
  assert.equal(player.play(), true);
  await settle();

  assert.equal(loaded, 1, 'the clip was fetched more than once');
  assert.equal(context.decodes, 1, 'the clip was decoded more than once');
  assert.equal(context.sources.length, 2, 'each tick needs its own source node');
  for (const source of context.sources) {
    assert.equal(source.started, 1);
    assert.equal(source.connectedTo, context.destination);
    assert.deepEqual(source.buffer, { bytes: 8 });
  }
});

test('a tick that arrives before the clip lands is played when it does', async () => {
  const context = new FakeContext();
  let release: ((bytes: ArrayBuffer) => void) | undefined;
  const player = new SoundPlayer({
    create: () => context,
    load: () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      }),
  });

  await player.unlock();
  assert.equal(player.play(), true);
  await settle();
  assert.equal(context.sources.length, 0, 'nothing can be played before it is decoded');

  release?.(new ArrayBuffer(4));
  await settle();
  assert.equal(context.sources.length, 1, 'the tick was dropped instead of being played late');
});

test('a clip that cannot be had is a silent canvas, not an error', async () => {
  const context = new FakeContext();
  const player = new SoundPlayer({
    create: () => context,
    load: () => Promise.reject(new Error('404')),
  });

  await player.unlock();
  await settle();
  assert.equal(player.play(), false);
  await settle();
  assert.equal(context.sources.length, 0);
});

test('a browser with no audio at all is a silent canvas too', async () => {
  const player = new SoundPlayer({
    create: () => {
      throw new Error('AudioContext is not defined');
    },
    load: async () => new ArrayBuffer(8),
  });
  assert.equal(await player.unlock(), false);
  assert.equal(player.play(), false);
});

test('with the setting off, the audio context is never asked for a sound', async () => {
  // The one that matters. Every other silence in this file is a decision; this
  // is the proof that the decision reaches the speaker.
  const context = new FakeContext();
  const player = new SoundPlayer({ create: () => context, load: async () => new ArrayBuffer(8) });
  await player.unlock();
  await settle();

  const rules = new SoundRules({
    play: () => {
      player.play();
    },
    settings: () => ({ ...DEFAULT_SOUND, onSessionEnd: false }),
    now: () => NOW,
    openedAt: NOW - 60_000,
    localMinutes: () => 12 * 60,
  });

  assert.equal(rules.handle({ kind: 'ended', sessionId: 'a' }).reason, 'off');
  await settle();
  assert.equal(context.sources.length, 0, 'a switched-off canvas made a sound');
});

/* ------------------------------------------------------------------ *
 * The asset
 * ------------------------------------------------------------------ */

const CLIP = path.join(repo, 'packages', 'ui', 'assets', 'bead-tick.wav');
const SCRIPT = path.join(repo, 'scripts', 'render-sound.mjs');

test('the committed tick is exactly what the script renders, byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nazar-tick-'));
  try {
    const rendered = path.join(dir, 'again.wav');
    execFileSync(process.execPath, [SCRIPT, rendered], { cwd: repo, stdio: 'pipe' });
    assert.ok(
      readFileSync(CLIP).equals(readFileSync(rendered)),
      'the asset and the script have drifted — re-run scripts/render-sound.mjs',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tick is a 250 ms 16-bit mono WAV, under the size ceiling', () => {
  const wav = readFileSync(CLIP);
  assert.ok(wav.length <= 25 * 1024, `the tick is ${wav.length} bytes`);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1, 'uncompressed PCM, so every browser can decode it');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 44_100);
  assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');

  const data = wav.readUInt32LE(40);
  assert.equal(wav.length, 44 + data, 'the header and the payload disagree about the length');
  assert.equal(data / 2 / 44_100, 0.25, 'the tick is not 250 ms long');

  // Silence at both ends — the attack ramp and the tail that reaches zero — so
  // the clip cannot click, and a peak with headroom, so it cannot be the
  // loudest thing on the machine.
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(wav.length - 2), 0);
  let peak = 0;
  for (let at = 44; at < wav.length; at += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(at)));
  assert.equal(peak, 16_422, 'the peak is not −6 dBFS');
});

/* ------------------------------------------------------------------ *
 * The seam: the markup, the wiring and the storage key
 * ------------------------------------------------------------------ */

const webDir = path.join(here, '..', 'web');
const html = readFileSync(path.join(webDir, 'index.html'), 'utf8');
const app = readFileSync(path.join(webDir, 'app.ts'), 'utf8');
const css = readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const settingsSrc = readFileSync(path.join(webDir, 'settings.ts'), 'utf8');
const soundSrc = readFileSync(path.join(here, '..', 'src', 'sound.ts'), 'utf8');

test('the page carries every sound control and app.ts looks each one up', () => {
  for (const id of [
    'sound-end-toggle',
    'sound-waiting-toggle',
    'sound-quiet-toggle',
    'sound-quiet-row',
    'sound-from',
    'sound-to',
    'sound-test',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
    assert.ok(app.includes(`'${id}'`), `#${id} is in the page but nothing looks it up`);
  }
  // The three settings are switches, like every other setting in the panel.
  for (const id of ['sound-end-toggle', 'sound-waiting-toggle', 'sound-quiet-toggle']) {
    const at = html.indexOf(`id="${id}"`);
    const control = html.slice(at, at + 240);
    assert.match(control, /role="switch"/, `#${id} is not announced as a switch`);
    assert.match(control, /aria-checked="false"/, `#${id} does not announce its state`);
  }
  // And the clock fields are the native control, which carries the keyboard and
  // the locale's own 12- or 24-hour presentation for free.
  assert.match(html, /id="sound-from"[^>]*type="time"/);
  assert.match(html, /id="sound-to"[^>]*type="time"/);
});

test('every class the sound settings set has a rule that gives it a meaning', () => {
  for (const marker of ['.nz-quiet', '.nz-quiet[hidden]', '.nz-quiet__field', '.nz-quiet__label', '.nz-quiet__time']) {
    assert.ok(css.includes(marker), `${marker} is set somewhere but styled nowhere`);
  }
});

test('the sound lives in this browser, and the panel still invents no key', () => {
  assert.equal(SOUND_KEY, 'nazar.sound.v1');
  assert.ok(soundSrc.includes(SOUND_KEY), 'the key is named nowhere');
  // N-WP12's rule, still true: the settings panel component owns no storage.
  assert.equal(settingsSrc.includes('localStorage'), false);
  assert.equal(settingsSrc.includes('nazar.'), false);
  // And nothing about the sound reaches the disk or the wire.
  assert.equal(app.includes('new AudioContext'), false, 'app.ts builds its own audio context');
  assert.equal(soundSrc.includes('new AudioContext'), false, 'the pure half reached for the DOM');
});
