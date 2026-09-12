/**
 * Record the one-minute-shorter tour that replaced twenty-three screenshots.
 *
 *     npm run tour
 *
 * writes `docs/media/tour.mp4` and `docs/media/tour.gif`: about twenty-five
 * seconds of the demo canvas being used — the cards and their subagent trees,
 * the permission-wait banner and the Needs-you strip, a hover card, the History
 * panel and a frozen past run, a theme changed, and the Codex thread.
 *
 * # Why this file exists
 *
 * The README carried twenty-three inline images. Every one of them was true and
 * together they were a contact sheet: a reader scrolled past a wall of pictures
 * before reaching the first paragraph that said what the program *is*. One
 * short recording answers "what is this" in the time it takes to read the
 * tagline, and the twenty-three still exist — the gallery in
 * `docs/screenshots/README.md` embeds every one of them under the feature it
 * belongs to, and `npm run screenshots` still writes them all.
 *
 * # Why it is not a second driver
 *
 * Everything under the recording is {@link file://./screenshots.mjs}: the
 * eighty-line CDP client, the step vocabulary, the demo server on a free port,
 * the browser found on the machine rather than downloaded. This file imports
 * them. No dependency is added for it either — the frames come out of Chrome's
 * own `Page.startScreencast` and the two files are encoded by `ffmpeg`, which
 * is a program on the PATH and not an `npm install`.
 *
 * # A recording, not a slideshow
 *
 * `Page.startScreencast` hands over a JPEG **every time the page paints**,
 * stamped with the instant it painted at, which is a real recording of a real
 * browser rather than a sequence of stills pretending to be one. It also means
 * the frames arrive irregularly: a canvas holding still paints rarely, and a
 * drawer sliding open paints sixty times a second. So nothing is resampled
 * here. Each frame is written out with the gap to the next one as its duration
 * and handed to ffmpeg's `concat` demuxer, which is exactly the shape the
 * screencast already has — a still second costs one frame and a moving one
 * costs sixty, and both come out the right length.
 *
 * # What is pinned, and what deliberately is not
 *
 * The clock is pinned to {@link CLOCK}, the same instant every screenshot is
 * taken at, so the history stamps and the ages on the cards are the ones the
 * pictures show. The timezone is UTC and the language is `?lang=en`, for the
 * reason `screenshots.mjs` gives at length: a recording must not be a video of
 * the desktop that took it.
 *
 * What is **not** pinned is motion. `screenshots.mjs` pauses every animation
 * and zeroes every transition, because a still of a moving thing is a coin
 * flip; a tour of a moving thing is the point of a tour. The drawer slides, the
 * waiting ring pulses, the panels fade in. Nor is the browser launched with the
 * compositor knobs that make two captures byte-identical — they exist to make a
 * *still* reproducible and all they would do here is cap the frame rate.
 *
 * # Nothing on this machine is in it
 *
 * Every scene loads `?demo=1`, the server is started with `--no-task-text`, and
 * on top of both {@link NEEDLES} is searched for in the rendered document
 * before each beat: a home directory, a user name, a `C:\Users` or a `/home/`
 * anywhere in the page fails the run rather than being encoded into a file that
 * goes in a README.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CLOCK,
  Cdp,
  SETTLE,
  centreOf,
  evaluate,
  findBrowser,
  freePort,
  mouse,
  runStep,
  startServer,
} from './screenshots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MEDIA = path.join(REPO, 'docs', 'media');
const UI_DIR = path.join(REPO, 'packages', 'ui', 'dist', 'web');

/** The frame the tour is recorded at. 1280×800 halves and quarters cleanly. */
const VIEW = { width: 1280, height: 800 };

/** Everything after `?`. Dark, the default palette, English, and the demo canvas. */
const QUERY = 'demo=1&theme=dark&palette=nazar&lang=en';

/* ------------------------------------------------------------------ *
 * The tour
 * ------------------------------------------------------------------ */

/**
 * One beat of the tour: something to do, and how long to hold afterwards.
 *
 * A beat is a step from `screenshots.mjs`'s own vocabulary — `click`, `focus`,
 * `contextmenu`, `scroll`, `key` — plus two verbs a recording needs and a still
 * does not:
 *
 * - `point` glides the pointer to an element over a third of a second instead
 *   of teleporting it. The canvas opens its hover card on `pointerover`, so a
 *   jump would make the card appear out of nowhere; a glide makes it the answer
 *   to a movement. It is also what keeps frames flowing — the screencast paints
 *   when something changes.
 * - `park` glides to the bottom-right corner, where nothing reacts, which is
 *   how a hover card is dismissed without clicking something.
 *
 * `hold` is the pause *after* the beat, in milliseconds, and it is where the
 * length of the film is: the sum below plus the glides is the running time, and
 * the target is twenty to thirty seconds.
 */
const BEATS = [
  /* --- 1. The canvas, as it opens ----------------------------------- */
  // Five sessions, their subagent trees, the amber card waiting on a
  // permission prompt and the banner across the top saying the same thing.
  { hold: 2400 },

  /* --- 2. Who needs you --------------------------------------------- */
  { point: '#needs-you', hold: 200 },
  { click: '#needs-you', hold: 2200 },
  { click: '#needs-you-close', hold: 350 },

  /* --- 3. The hover card -------------------------------------------- */
  // The second card rather than the first: the first is the one the strip has
  // just been talking about, and the hover card should land on a different
  // session so the two beats are not a picture of the same thing twice.
  { point: { selector: '.nz-session .nz-session__handle', index: 1 }, hold: 2100 },
  { park: true, hold: 350 },

  /* --- 4. History, and a past run frozen ----------------------------- */
  { click: '#menu-toggle', hold: 500 },
  { point: '#history-toggle', hold: 150 },
  { click: '#history-toggle', hold: 900 },
  // The drawer closes again before the row is opened: the frozen tree is the
  // picture, and it is drawn on the canvas the drawer is covering.
  { click: '#menu-toggle', hold: 400 },
  { point: { selector: '.nz-hrow', index: 0 }, hold: 150 },
  { click: { selector: '.nz-hrow', index: 0 }, hold: 2300 },
  // One click out of both: `frozen-back` closes the panel, and the panel's own
  // close handler is what puts the canvas back to live.
  { click: '#frozen-back', hold: 450 },

  /* --- 5. A theme, changed once -------------------------------------- */
  { click: '#menu-toggle', hold: 350 },
  { click: '#settings-toggle', hold: 550 },
  { point: '#palette [data-theme-name="midnight"]', hold: 150 },
  { click: '#palette [data-theme-name="midnight"]', hold: 1900 },
  { click: '#settings-back', hold: 200 },
  { click: '#menu-toggle', hold: 450 },

  /* --- 6. The Codex thread ------------------------------------------- */
  // Found by the badge it draws rather than by its place in the row, the way
  // `n-wp18-codex-session-dark` finds it.
  { point: '.nz-session:has(image[href*="codex"]) .nz-session__handle', hold: 2200 },
  { park: true, hold: 500 },
];

/* ------------------------------------------------------------------ *
 * Page-side
 * ------------------------------------------------------------------ */

/**
 * Pin the clock, and nothing else.
 *
 * `screenshots.mjs`'s own preamble goes further — it seeds `Math.random`, steps
 * `performance.now` by a fixed frame and zeroes every transition — and all
 * three of those are wrong here. A stepped `performance.now` breaks any
 * animation driven from `requestAnimationFrame`, and zeroed transitions turn
 * the drawer into a cut. The clock stays pinned because the ages on the cards
 * and the stamps in the history panel are content, and content should agree
 * with the screenshots taken beside it.
 */
const TOUR_PREAMBLE = `(() => {
  const FIXED = ${CLOCK};
  const Real = Date;
  const Fake = function Date(...args) {
    if (!new.target) return new Real(FIXED).toString();
    return args.length === 0 ? new Real(FIXED) : new Real(...args);
  };
  Fake.prototype = Real.prototype;
  Fake.now = () => FIXED;
  Fake.parse = Real.parse;
  Fake.UTC = Real.UTC;
  globalThis.Date = Fake;
})();`;

/**
 * What must never appear in a frame.
 *
 * The demo canvas invents everything it draws, so this should never fire — and
 * that is the point of checking it. A file that goes in a README is published;
 * a home directory that reached one would be published with it, and it is far
 * cheaper to fail a recording than to rewrite history over a video. Needles
 * shorter than three characters are dropped, because a user name of `ab` would
 * match half the page.
 */
const NEEDLES = [
  os.homedir(),
  os.homedir().replaceAll('\\', '/'),
  os.userInfo().username,
  'C:\\Users',
  'C:/Users',
  '/Users/',
  '/home/',
].filter((needle) => typeof needle === 'string' && needle.length >= 3);

/** An expression that answers the first needle found in the page, or `null`. */
function leakProbe(needles) {
  return `(() => {
    const page = document.documentElement.outerHTML.toLowerCase();
    for (const needle of ${JSON.stringify(needles)}) {
      if (page.includes(needle.toLowerCase())) return needle;
    }
    return null;
  })()`;
}

/* ------------------------------------------------------------------ *
 * Driving
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ease in and out, so a glide starts and stops rather than jerking. */
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Move the pointer from where it is to `to`, painting on the way.
 *
 * Roughly a frame between positions: fewer and the movement is a stutter in
 * the recording, more and the beat costs longer than it is worth.
 */
async function glide(cdp, session, pointer, to, ms = 280) {
  // A hop every 20 ms rather than every frame. Each one is a round trip to the
  // browser on top of the sleep, so asking for sixty a second makes the glide
  // take half again as long as it says and the film longer than the beats add
  // up to; three a frame is not a movement anybody can see anyway.
  const hops = Math.max(2, Math.round(ms / 20));
  const from = { ...pointer };
  for (let hop = 1; hop <= hops; hop += 1) {
    const t = ease(hop / hops);
    pointer.x = from.x + (to.x - from.x) * t;
    pointer.y = from.y + (to.y - from.y) * t;
    await mouse(cdp, session, 'mouseMoved', pointer.x, pointer.y);
    await sleep(20);
  }
}

/** Run one beat: the tour's own two verbs, then `screenshots.mjs` for the rest. */
async function runBeat(cdp, session, pointer, beat) {
  if (beat.park === true) {
    await glide(cdp, session, pointer, { x: VIEW.width - 4, y: VIEW.height - 4 }, 260);
    return;
  }

  if (beat.point !== undefined) {
    const { selector, index } =
      typeof beat.point === 'string' ? { selector: beat.point, index: 0 } : beat.point;
    const at = await centreOf(cdp, session, selector, index ?? 0);
    await glide(cdp, session, pointer, at);
    return;
  }

  // A click lands where the pointer already is when the beat before it pointed
  // there, and `runStep` moves the mouse itself when it did not — either way
  // the pointer is left on the thing that was clicked, so it is tracked here.
  if (beat.click !== undefined) {
    const { selector, index } =
      typeof beat.click === 'string' ? { selector: beat.click, index: 0 } : beat.click;
    const at = await centreOf(cdp, session, selector, index ?? 0);
    if (Math.hypot(at.x - pointer.x, at.y - pointer.y) > 2) {
      await glide(cdp, session, pointer, at, 180);
    }
    await mouse(cdp, session, 'mousePressed', at.x, at.y);
    await sleep(70);
    await mouse(cdp, session, 'mouseReleased', at.x, at.y);
    return;
  }

  // A beat with nothing but a `hold` is a beat that lets the canvas be looked
  // at, which is half of what a tour is.
  const { hold: _hold, ...step } = beat;
  if (Object.keys(step).length === 0) return;
  await runStep(cdp, session, step);
}

/* ------------------------------------------------------------------ *
 * The screencast
 * ------------------------------------------------------------------ */

/**
 * Play the tour in a fresh tab and write every painted frame to `frames`.
 *
 * Returns the list of `{ file, at }`, `at` being the instant the browser says
 * the frame was painted, in seconds. The caller turns the gaps between them
 * into durations.
 */
async function record(cdp, origin, frames) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const shots = [];
  let stop;
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }, sessionId);
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: TOUR_PREAMBLE }, sessionId);

    const loaded = cdp.once('Page.loadEventFired', sessionId, 20000);
    await cdp.send('Page.navigate', { url: `${origin}/?${QUERY}` }, sessionId);
    await loaded;
    await evaluate(
      cdp,
      sessionId,
      `new Promise((resolve, reject) => {
        const deadline = performance.now() + 10000;
        const look = () => {
          if (document.querySelector('.nz-session') !== null) return resolve(true);
          if (performance.now() > deadline) return reject(new Error('the canvas never drew'));
          requestAnimationFrame(look);
        };
        look();
      })`,
      { awaitPromise: true },
    );
    // The canvas frames itself on its first render with sessions on it, and
    // that fit is a view change worth not recording: the tour should open on a
    // canvas, not on one settling.
    await evaluate(cdp, sessionId, SETTLE, { awaitPromise: true });
    await sleep(250);

    stop = cdp.on('Page.screencastFrame', sessionId, (params) => {
      const file = `f${String(shots.length + 1).padStart(5, '0')}.jpg`;
      writeFileSync(path.join(frames, file), Buffer.from(params.data, 'base64'));
      shots.push({ file, at: params.metadata.timestamp });
      // Chrome stops sending until the frame it sent is acknowledged, so a
      // missed ack is a recording that ends after one picture.
      void cdp
        .send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId)
        .catch(() => undefined);
    });

    await cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: 92,
        maxWidth: VIEW.width,
        maxHeight: VIEW.height,
        everyNthFrame: 1,
      },
      sessionId,
    );

    /*
     * The pointer starts high on the right, above the top row of cards.
     *
     * Not in the middle of the window, which is where it was: the first glide
     * is to the `Needs you` badge in the top-left corner, and a diagonal from
     * the centre of the canvas crosses two session cards on the way — so the
     * tour opened by flashing a hover card at nothing in particular for half a
     * second. Everything above the cards is the banner and the top bar, and
     * neither of them answers a pointer passing over it.
     */
    const pointer = { x: VIEW.width - 60, y: 100 };
    for (const [index, beat] of BEATS.entries()) {
      const leak = await evaluate(cdp, sessionId, leakProbe(NEEDLES));
      if (leak !== null) {
        throw new Error(
          `beat ${index + 1} has "${leak}" in the page — this recording is not demo data`,
        );
      }
      await runBeat(cdp, sessionId, pointer, beat);
      await sleep(beat.hold ?? 0);
    }

    await cdp.send('Page.stopScreencast', {}, sessionId);
    // One last stamp, so the final frame gets the length of the hold that
    // followed it rather than an arbitrary tail.
    const endedAt = shots.length === 0 ? 0 : shots[shots.length - 1].at + 0.4;
    return { shots, endedAt };
  } finally {
    stop?.();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

/**
 * The concat list ffmpeg reads: every frame, and how long it is on screen.
 *
 * The last entry is repeated without a duration, which is the documented way
 * to make the concat demuxer honour the duration of the final frame instead of
 * showing it for one tick and cutting.
 */
function concatList(shots, endedAt) {
  const lines = ['ffconcat version 1.0'];
  for (const [index, shot] of shots.entries()) {
    const next = index + 1 < shots.length ? shots[index + 1].at : endedAt;
    // A frame is on screen for at least a millisecond: two paints inside the
    // same microsecond would otherwise be a zero-length entry the demuxer
    // drops, and the file would be a frame short of what was recorded.
    const seconds = Math.max(0.001, next - shot.at);
    lines.push(`file '${shot.file}'`, `duration ${seconds.toFixed(4)}`);
  }
  const last = shots[shots.length - 1];
  if (last !== undefined) lines.push(`file '${last.file}'`);
  return lines.join('\n') + '\n';
}

function ffmpeg(args, cwd) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd,
    stdio: 'inherit',
  });
}

/** H.264 in an MP4: the copy worth attaching to a release, and the one to keep. */
function encodeMp4(frames, out) {
  ffmpeg(
    [
      '-f', 'concat', '-safe', '0', '-i', 'frames.txt',
      // A constant rate on the way out even though the input has none: a
      // variable-frame-rate MP4 plays back differently in every player, and
      // thirty is enough for a drawer sliding.
      '-vf', 'fps=30',
      // 20 rather than the 23 x264 defaults to, and the reason is the budget:
      // twenty-six seconds of a canvas that mostly holds still comes out under
      // a megabyte either way, and the whole point of the MP4 is to be the
      // copy where the eight-point text on a subagent node is still readable.
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
      // The pixel format every browser and every player agrees on. Without it
      // ffmpeg picks yuvj444p from the JPEGs and Safari shows nothing.
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      out,
    ],
    frames,
  );
}

/**
 * A GIF, because GitHub renders one inline and will not render an MP4.
 *
 * Twelve frames a second at 960 wide, with a palette generated from the film
 * itself. `stats_mode=diff` weights the palette towards what *changes* rather
 * than towards the dark background that fills most of every frame, and
 * `diff_mode=rectangle` lets the encoder leave the unchanged part of a frame
 * alone — which on a canvas that holds still for three seconds at a time is
 * most of the file.
 */
function encodeGif(frames, out, { fps = 12, width = 960, colours = 192 } = {}) {
  ffmpeg(
    [
      '-f', 'concat', '-safe', '0', '-i', 'frames.txt',
      '-filter_complex',
      `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];` +
        `[a]palettegen=max_colors=${colours}:stats_mode=diff[p];` +
        `[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      '-loop', '0',
      out,
    ],
    frames,
  );
}

/* ------------------------------------------------------------------ *
 * The browser, and the command line
 * ------------------------------------------------------------------ */

/**
 * A headless Chrome that is allowed to move.
 *
 * `screenshots.mjs` launches the same browser with eight compositor flags that
 * exist to make two captures byte-identical — partial raster off, every
 * compositor stage run before each draw, animation and scrolling forced onto
 * the main thread. Every one of them costs frames, and none of them buys
 * anything here: a recording is never compared to another recording. What is
 * kept is `--disable-gpu`, because headless has no GPU worth using and
 * software raster is what it falls back to anyway, and `--hide-scrollbars`,
 * because a scrollbar in a tour is a picture of a browser.
 */
async function startBrowser(executable, profile) {
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--font-render-hinting=none',
      '--disable-gpu',
      // A tab that the compositor thinks is in the background paints once and
      // then stops, which for a screencast is a recording of a still image.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-size=${VIEW.width + 40},${VIEW.height + 40}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the browser did not start in 30 s:\n${output}`)),
      30000,
    );
    child.stderr.on('data', (chunk) => {
      output += chunk;
      const match = /(ws:\/\/\S+)/.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser exited with ${code}:\n${output}`));
    });
  });
  return { child, endpoint };
}

function parseArgs(argv) {
  const options = { build: true, keep: false, out: MEDIA, chrome: undefined, port: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[(index += 1)];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    switch (argument) {
      case '--no-build':
        options.build = false;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--out':
        options.out = path.resolve(value());
        break;
      case '--chrome':
        options.chrome = value();
        break;
      case '--port':
        options.port = Number(value());
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${argument}`);
    }
  }
  return options;
}

const HELP = `node scripts/tour.mjs [options]

Record docs/media/tour.mp4 and docs/media/tour.gif from the demo canvas.

  --out <dir>       write the two files here instead of docs/media
  --no-build        reuse packages/ui/dist/web instead of rebuilding
  --chrome <path>   the browser to drive (default: the installed Chrome or Edge)
  --port <number>   the port to serve the canvas on (default: a free one)
  --keep            leave the frames and the browser profile behind, and say where
  -h, --help        this

ffmpeg must be on the PATH. Nothing is installed: the frames come from Chrome's
own screencast and the driver is the one in scripts/screenshots.mjs.
`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('no ffmpeg on the PATH. Install it (winget install Gyan.FFmpeg) and retry.');
  }

  if (options.build) {
    process.stdout.write('building the canvas...\n');
    execFileSync('npm', ['run', 'build'], {
      cwd: REPO,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
  if (!existsSync(path.join(UI_DIR, 'index.html'))) {
    throw new Error(`no bundle at ${UI_DIR}. Run "npm run build" (or drop --no-build).`);
  }

  const executable = findBrowser(options.chrome);
  const port = options.port ?? (await freePort());
  const profile = mkdtempSync(path.join(os.tmpdir(), 'nazar-tour-'));
  const frames = mkdtempSync(path.join(os.tmpdir(), 'nazar-frames-'));
  mkdirSync(options.out, { recursive: true });

  const server = await startServer(port);
  let browser;
  let cdp;
  let recorded;
  try {
    browser = await startBrowser(executable, profile);
    cdp = await Cdp.connect(browser.endpoint);
    process.stdout.write(
      `${server.origin} · ${path.basename(executable)} · ${BEATS.length} beats · ${VIEW.width}x${VIEW.height}\n`,
    );
    recorded = await record(cdp, server.origin, frames);
  } finally {
    cdp?.close();
    server.child.kill();
    if (browser !== undefined) {
      const gone = new Promise((resolve) => browser.child.once('exit', resolve));
      browser.child.kill();
      await gone;
    }
    if (!options.keep) {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        process.stderr.write(`(left ${profile} behind: the browser still had it open)\n`);
      }
    }
  }

  const { shots, endedAt } = recorded;
  if (shots.length < 60) {
    throw new Error(`only ${shots.length} frames were painted — the screencast did not run`);
  }
  const seconds = endedAt - shots[0].at;
  writeFileSync(path.join(frames, 'frames.txt'), concatList(shots, endedAt));
  process.stdout.write(
    `\n${shots.length} frames · ${seconds.toFixed(1)} s · ${(shots.length / seconds).toFixed(1)} fps captured\n`,
  );

  const mp4 = path.join(options.out, 'tour.mp4');
  const gif = path.join(options.out, 'tour.gif');
  encodeMp4(frames, mp4);
  encodeGif(frames, gif);

  for (const file of [mp4, gif]) {
    const kb = statSync(file).size / 1024;
    process.stdout.write(`${path.relative(REPO, file).padEnd(20)} ${(kb / 1024).toFixed(2)} MB\n`);
  }

  if (options.keep) process.stdout.write(`\nframes: ${frames}\n`);
  else rmSync(frames, { recursive: true, force: true });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`tour: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
