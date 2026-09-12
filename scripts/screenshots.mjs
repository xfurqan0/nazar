/**
 * Regenerate every image under `docs/screenshots/`, from one command.
 *
 * Until now the pictures in the README were taken by hand, on the maintainer's
 * own machine, at three DPIs — which is why `docs/PROJECT.md` §8 has carried
 * the line "the screenshots still show the old drawer ... and cannot be
 * regenerated here" through three UI packages in a row. A picture that can
 * only be retaken by the one person who has the window open is a picture that
 * goes stale, and this file exists so that the answer to "the canvas changed"
 * is `npm run screenshots` rather than an afternoon.
 *
 * # What it does
 *
 * Builds the canvas, starts `bin/nazar.mjs` on a free port with `--no-open`,
 * drives a headless Chrome over the DevTools protocol through the {@link
 * SCENARIOS} table below, and writes one PNG per row. Every row loads
 * `?demo=1`, so **nothing on the machine taking the shots is read or drawn**:
 * the canvas is built in the browser out of `packages/ui/src/demo.ts`, the
 * history panel out of `demo-history.ts`, and the server's own watchers are
 * never subscribed to — `app.ts` returns before it opens the stream when the
 * URL says `demo=1`.
 *
 * # Why no Playwright, and no Puppeteer
 *
 * The same reason `render-bead-png.mjs` rasterises a PNG by hand rather than
 * pulling a rasteriser: this project has zero runtime dependencies and keeps
 * the dev list short on purpose. A browser driver is a big dependency to add
 * for the four calls actually needed here — set the viewport, navigate, click,
 * capture — and Node has carried a `WebSocket` global since 22, which is the
 * one piece a CDP client cannot write for itself. So {@link Cdp} below is
 * about eighty lines and the dependency list is unchanged.
 *
 * The browser itself is not a dependency either: it is the Chrome (or Edge)
 * already installed on the machine, found by {@link findBrowser}. Nothing is
 * downloaded, and `--chrome <path>` overrides the search.
 *
 * # Determinism
 *
 * The contract is that two runs of the same command produce byte-identical
 * PNGs, and `--check` is the gate that says so. Five things had to be pinned to
 * get there, and all five are pinned *in the driver* — the page is not modified
 * and does not know it is being screenshotted:
 *
 * 1. **The clock.** `makeDemoState` defaults `now` to `Date.now()`, and while
 *    every *relative* age on the canvas is measured against that same stamp
 *    (`app.ts` returns `generatedAt` from `clock()` in demo mode, so the ages
 *    are already stable), the absolute stamps in the history panel are not.
 *    {@link PREAMBLE} replaces `Date.now` and the zero-argument `new Date()`
 *    with {@link CLOCK} before a single line of the bundle runs.
 * 2. **The timezone.** `formatStamp` is hand-rolled but uses
 *    `getHours()`/`getDate()`, so the history stamps move with the machine's
 *    timezone; `Emulation.setTimezoneOverride` pins it to UTC.
 * 3. **The language.** `resolveLocale` falls back to `navigator.languages`, so
 *    the first run of this file produced a canvas, a drawer and a context menu
 *    in Turkish. `?lang=en` is appended unless a scenario asked for a language
 *    of its own — for the same reason `theme` is written out on every row: a
 *    screenshot must not be a picture of the desktop that took it.
 * 4. **Animation.** {@link FREEZE} pauses every running animation at
 *    `currentTime = 0`, which for the waiting ring's `nz-pulse` is its most
 *    visible frame and for anything added later is that animation's own start.
 *
 *    Emulating `prefers-reduced-motion` instead was tried and rejected. It
 *    changes the picture rather than only stopping it — the reduced-motion
 *    block repaints the activity word in `--nz-text` and pins the waiting ring
 *    at half opacity — so the shot would stop being a picture of the default
 *    canvas. And at the time it did not even work: the frame pulse N-WP15 has
 *    since removed had its rule written *after* the `@media` block at the same
 *    specificity, so the later rule won and the subagent frames kept breathing
 *    through a reduced-motion emulation. The animation is gone, the shape of
 *    the mistake is worth remembering — a reduced-motion block is only as good
 *    as its position in the file — and the driver depends on the media query
 *    for nothing.
 * 5. **Transitions and the caret.** {@link PREAMBLE} zeroes every transition
 *    duration and makes the caret transparent, because one scenario opens an
 *    inline text field and a blinking caret is a coin flip on every capture.
 *
 * On top of that, {@link captureStable} takes each shot twice and only accepts
 * it when the two are byte-identical, retrying a few times before giving up
 * loudly. That turns a flake into a failed run rather than a committed
 * difference.
 *
 * **Same machine, not any machine.** There is no web font to wait for — every
 * palette uses the same system stack — which also means the text is rendered
 * by whatever `ui-sans-serif` resolves to locally. Two runs on one machine are
 * identical; a run on Windows and a run on Linux are not, which is why
 * `--check` is a command you type and not a CI job.
 *
 * # Usage
 *
 *     npm run screenshots                 write docs/screenshots/*.png
 *     npm run screenshots -- --check      compare instead of writing; exit 1 on a difference
 *     npm run screenshots -- --out <dir>  write somewhere else (a preview run)
 *     npm run screenshots -- --only wp4e  run the scenarios whose name contains this
 *     npm run screenshots -- --list       print the scenario table and exit
 *     npm run screenshots -- --no-build   reuse the bundle already in packages/ui/dist
 *     npm run screenshots -- --chrome <path> --port <n> --keep
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SHOTS = path.join(REPO, 'docs', 'screenshots');
const UI_DIR = path.join(REPO, 'packages', 'ui', 'dist', 'web');

/**
 * The instant every shot is taken at, in UTC.
 *
 * Two days after `DEMO_HISTORY_EPOCH` (`packages/ui/src/demo-history.ts`), so
 * the history listing has something to say about how long ago a run ended and
 * the group headings are not all today. Changing this number changes every
 * picture that shows an age, which is the whole point of it being a constant.
 */
const CLOCK = Date.UTC(2026, 8, 8, 12, 0, 0);

/* ------------------------------------------------------------------ *
 * The scenarios
 * ------------------------------------------------------------------ */

/**
 * Every picture, and how it is taken.
 *
 * - `name` is the file name without `.png`, and **the twenty-nine that already
 *   exist keep theirs**: the README refers to them by path and carries a
 *   hand-written alt text for each, so a rename is a broken image and a lost
 *   sentence.
 * - `what` is what the picture shows, and `where` is the paragraph it belongs
 *   to. Both are printed by `--list` and copied into
 *   `docs/screenshots/README.md`, which is the index a reader of the README
 *   needs when they want to know which shot to retake.
 * - `query` is everything after `?`. Reach for a URL parameter before reaching
 *   for `steps`: `app.ts` deliberately carries `sidebar`, `collapse`, `notes`,
 *   `projects`, `history`, `quota`, `usage`, `theme`, `palette` and `lang` as
 *   parameters *because* screenshots need them, and a URL cannot go out of
 *   step with itself the way a sequence of clicks can.
 * - `steps` drive the states that have no parameter — the settings panel, the
 *   Needs-you popover, a context menu, a drag, a resize, the task-text switch.
 * - `width`/`height` are CSS pixels and `scale` is the device pixel ratio, so
 *   the file is `width*scale` by `height*scale`. The `wp4-100/150/200` trio is
 *   one viewport at three ratios, which is what those three files have always
 *   been.
 *
 * The `theme` parameter is always written out even when `dark` is what the
 * machine would have chosen: a screenshot must not depend on the colour scheme
 * of the desktop that took it.
 */
const SCENARIOS = [
  /* --- WP4: the canvas at three device pixel ratios ------------------ */
  {
    name: 'wp4-100-dark',
    what: 'The whole canvas, dark, at 1× device pixel ratio',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=dark',
    width: 1500,
    height: 950,
    scale: 1,
  },
  {
    name: 'wp4-100-light',
    what: 'The whole canvas, light, at 1×',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=light',
    width: 1500,
    height: 950,
    scale: 1,
  },
  {
    name: 'wp4-150-dark',
    what: 'The same canvas at 1.5×, where the SVG has to stay crisp',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=dark',
    width: 1500,
    height: 950,
    scale: 1.5,
  },
  {
    name: 'wp4-150-light',
    what: 'The same canvas at 1.5×, light',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=light',
    width: 1500,
    height: 950,
    scale: 1.5,
  },
  {
    name: 'wp4-200-dark',
    what: 'The same canvas at 2×',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=dark',
    width: 1500,
    height: 950,
    scale: 2,
  },
  {
    name: 'wp4-200-light',
    what: 'The same canvas at 2×, light',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=light',
    width: 1500,
    height: 950,
    scale: 2,
  },
  {
    name: 'wp4-empty-dark',
    what: 'The empty state: no session on the machine, and the four lines that say why',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=dark&sessions=0',
    width: 1500,
    height: 950,
    scale: 1,
  },
  {
    name: 'wp4-hover-dark',
    what: 'The hover card over the first session: tokens, context window, the folder',
    where: 'docs/PROJECT.md §8, WP4 (not in the README)',
    query: 'demo=1&theme=dark',
    width: 1500,
    height: 950,
    scale: 1.5,
    // `focusin` opens the same card `pointerover` does, and a focused element
    // is a state the page can be asked for rather than a mouse position that
    // has to be guessed from a layout that moves.
    steps: [{ focus: '.nz-session' }],
  },

  /* --- WP4b: history ------------------------------------------------- */
  {
    name: 'wp4b-history-dark',
    what: 'The History panel, past sessions grouped by project, one opened as a frozen tree',
    where: 'README, "What it looks like", fourth image',
    query: 'demo=1&theme=dark&history=1',
    width: 1440,
    height: 900,
    scale: 1,
  },

  /* --- WP4c: wrapping, tabs, the sidebar ----------------------------- */
  {
    name: 'wp4c-overview-dark',
    what: 'Four sessions with their trees, the tab bar, the waiting banner, the drawer open',
    where: 'README, "What it looks like", second image',
    query: 'demo=1&theme=dark&sidebar=1',
    width: 1500,
    height: 950,
    scale: 1,
  },
  {
    name: 'wp4c-overview-light',
    what: 'The same, light',
    where: 'docs/PROJECT.md §8, WP4c (not in the README)',
    query: 'demo=1&theme=light&sidebar=1',
    width: 1500,
    height: 950,
    scale: 1,
  },
  {
    name: 'wp4c-sixty-agents-dark',
    what: 'One session with sixty subagents: the card grows, the tree wraps, connectors stay inside',
    where: 'README, "Fold a big tree away"',
    // Six seeded agents on the first session plus fifty-four generated ones.
    // The count is written as a sum rather than as `60` so that a change to the
    // fixture is a visible arithmetic error here rather than a silent 58.
    query: `demo=1&theme=dark&sessions=1&agents=${60 - 6}`,
    width: 1500,
    // Taller than every other scenario because the card is: sixty subagents
    // wrap into nine rows and the point of the picture is that the card grew to
    // hold all of them. At 950 the card ran off the bottom of the window, which
    // is a picture of a crop rather than of a card.
    height: 1900,
    scale: 1,
  },
  {
    name: 'wp4c-collapsed-dark',
    what: 'The same session folded away: one row of chips counting the tree',
    where: 'README, "Fold a big tree away", second image',
    query: `demo=1&theme=dark&sessions=1&agents=${60 - 6}&collapse=1`,
    width: 1500,
    height: 950,
    scale: 1,
  },
  {
    name: 'wp4c-dragged-dark',
    what: 'A card dragged out of the grid, to show the arrangement is the user’s',
    where: 'docs/PROJECT.md §8, WP4c (not in the README)',
    query: 'demo=1&theme=dark',
    width: 1500,
    height: 950,
    scale: 1,
    // Low in the handle, under the rename strip that covers its top 20 px —
    // see `centreOf`. The grab point is the difference between a dragged card
    // and a card standing still with its name field open.
    steps: [
      { drag: { from: '.nz-session .nz-session__handle', at: { y: 0.8 }, dx: 150, dy: 90 } },
    ],
  },

  /* --- WP4d: activity frames ----------------------------------------- */
  {
    name: 'wp4d-activity-dark',
    what: 'Four sessions in four states — working, idle, waiting, unknown — framed and labelled',
    // N-WP22 gave the README's first image to `n-wp15-quiet-cards-dark`, which
    // draws the same four states on the quieter card. This pair stays as the
    // record of what WP4d shipped.
    where: 'docs/PROJECT.md §8, WP4d (not in the README)',
    query: 'demo=1&theme=dark',
    width: 1500,
    height: 1240,
    scale: 1,
  },
  {
    name: 'wp4d-activity-light',
    what: 'The same four states, light',
    where: 'docs/PROJECT.md §8, WP4d (not in the README)',
    query: 'demo=1&theme=light',
    width: 1500,
    height: 1240,
    scale: 1,
  },

  /* --- WP4e: themes, colours, notes, the usage popover ---------------- */
  {
    name: 'wp4e-themes-sepia',
    what: 'The Sepia palette in light mode, with the settings panel open on Appearance',
    where: 'README, "Themes"',
    query: 'demo=1&theme=light&palette=sepia&sidebar=1&quota=limits',
    width: 1560,
    height: 980,
    scale: 1,
    steps: [{ click: '#settings-toggle' }],
  },
  {
    name: 'wp4e-themes-midnight',
    what: 'The Midnight palette in dark mode, settings open on Appearance',
    where: 'README, "Themes"',
    query: 'demo=1&theme=dark&palette=midnight&sidebar=1&quota=limits',
    width: 1560,
    height: 980,
    scale: 1,
    steps: [{ click: '#settings-toggle' }],
  },
  {
    name: 'wp4e-colours-dark',
    what: 'Two activity colours overridden — WORKING orange, IDLE violet — with the cards already reframed',
    where: 'README, "Themes", third image',
    query: 'demo=1&theme=dark&sidebar=1',
    width: 1560,
    height: 980,
    scale: 1,
    steps: [
      { click: '#settings-toggle' },
      // The picker is an `<input type="color">`, which no amount of clicking
      // can drive from here: the value comes from the platform's colour dialog.
      // Writing the value and dispatching `input` is the same event the dialog
      // would have produced, and it is the only step in this table that reaches
      // past the pixels into the DOM.
      { set: { selector: '#colour-stateWorking', value: '#E8892B' } },
      { set: { selector: '#colour-stateAlive', value: '#8B5CF6' } },
    ],
  },
  {
    name: 'wp4e-notes-dark',
    what: 'Three sticky notes on the canvas under the cards, one per colour that has something to say',
    where: 'README, "Sticky notes"',
    query: 'demo=1&theme=dark&notes=1',
    width: 1560,
    // The notes sit in a row of their own below the second row of cards, so
    // this pair is taller than the plain canvas: see `DEMO_NOTES`.
    height: 1180,
    scale: 1,
  },
  {
    name: 'wp4e-notes-light',
    what: 'The same three notes, light',
    where: 'docs/PROJECT.md §8, WP4e (not in the README)',
    query: 'demo=1&theme=light&notes=1',
    width: 1560,
    height: 1180,
    scale: 1,
  },
  {
    name: 'wp4e-popover-dark',
    what: 'The usage-limits panel open under its bead: six windows, every severity, two sources',
    where: 'README, "Usage limits, cost and context"',
    query: 'demo=1&theme=dark&quota=limits&usage=1',
    width: 1560,
    height: 980,
    scale: 1,
  },
  {
    name: 'wp4e-popover-light',
    what: 'The same panel, light',
    where: 'docs/PROJECT.md §8, WP4e (not in the README)',
    query: 'demo=1&theme=light&quota=limits&usage=1',
    width: 1560,
    height: 980,
    scale: 1,
  },

  /* --- WP4f: resizing, and clearing what finished --------------------- */
  {
    name: 'wp4f-resize-dark',
    what: 'A card dragged narrower from its corner: the tree re-wraps, the grips are drawn',
    where: 'README, "Resize a card"',
    query: 'demo=1&theme=dark&sessions=2&agents=10',
    width: 1560,
    height: 800,
    scale: 1,
    // Focus first: the corner grips are transparent until the card is hovered
    // or focused, and the shot is of the grips as much as of the re-wrap.
    steps: [
      { focus: '.nz-session' },
      { resize: { card: 0, handle: 'se', dx: -170, dy: 60 } },
      { focus: '.nz-session' },
    ],
  },
  {
    name: 'wp4f-cleared-dark',
    what: 'The same card with its finished subagents hidden, and the chip that brings them back',
    where: 'README, "Resize a card", second image',
    query: 'demo=1&theme=dark&sessions=2&agents=10',
    width: 1560,
    height: 800,
    scale: 1,
    steps: [
      { contextmenu: '.nz-session .nz-session__handle' },
      { clickText: { in: '#cardmenu', text: 'Clear finished subagents' } },
    ],
  },

  /* --- WP4g: projects and card names ---------------------------------- */
  {
    name: 'wp4g-projects-dark',
    what: 'Two folder tabs, and the drawer listing each with its live and past counts',
    where: 'README, "Folder tabs are folders that own a tab"',
    query: 'demo=1&theme=dark&projects=1&sidebar=1',
    width: 1560,
    // 800 cut the second row of cards in half. The tab bar adds a row to the
    // top of every `projects=1` shot, so these two are taller than the plain
    // canvas rather than the same height as it.
    height: 1020,
    scale: 1,
  },
  {
    name: 'wp4g-rename-dark',
    what: 'Two cards titled by their user, one with the inline name field open, three still by their folder',
    where: 'README, "Name a card", second image',
    query: 'demo=1&theme=dark&projects=1',
    width: 1560,
    height: 1020,
    scale: 1,
    steps: [
      // The third card is the one still titled by its folder, so the field is
      // opened on it and the picture keeps an example of both.
      { click: { selector: '.nz-session [data-action="rename"]', index: 2 } },
      { type: 'importer rewrite' },
    ],
  },

  /* --- WP5: the quota strip ------------------------------------------- */
  {
    name: 'wp5-quota-dark',
    what: 'The bead in the top bar with a machine that has nazar-tray installed',
    where: 'docs/PROJECT.md §8, WP5 (not in the README)',
    query: 'demo=1&theme=dark&quota=limits',
    width: 1600,
    height: 1000,
    scale: 1,
  },
  {
    name: 'wp5-quota-light',
    what: 'The same bead, light',
    where: 'docs/PROJECT.md §8, WP5 (not in the README)',
    query: 'demo=1&theme=light&quota=limits',
    width: 1600,
    height: 1000,
    scale: 1,
  },

  /* ------------------------------------------------------------------ *
   * New since the last hand-taken round: every one of them is a package
   * shipped after WP5 with nothing to show for it, which is exactly how
   * the last set went stale. Eight of the ten were placed in the README by
   * N-WP22; `n-wp13` and `n-wp18` are still waiting for the paragraph that
   * wants them, because an image costs an alt text and the alt texts here
   * are hand-written sentences rather than captions.
   * ------------------------------------------------------------------ */
  {
    name: 'n-wp10-resize-dark',
    what: 'All eight resize handles: a card dragged from its east edge rather than a corner',
    where: 'README, "Resize a card from any edge or corner"',
    query: 'demo=1&theme=dark&sessions=2&agents=10',
    width: 1560,
    height: 800,
    scale: 1,
    steps: [
      { focus: '.nz-session' },
      { resize: { card: 0, handle: 'e', dx: -150, dy: 0 } },
      { focus: '.nz-session' },
    ],
  },
  {
    name: 'n-wp11-folder-tab-dark',
    what: 'A folder tab selected: the canvas showing only the sessions under that folder',
    where: 'README, "Folder tabs are folders that own a tab"',
    query: 'demo=1&theme=dark&projects=1',
    width: 1560,
    height: 800,
    scale: 1,
    steps: [{ click: { selector: '#tabs .nz-tab', index: 1 } }],
  },
  {
    name: 'n-wp12-settings-dark',
    what: 'The settings panel in the drawer’s own place: Appearance, Behaviour, Language, Usage, About',
    where: 'README, "The sidebar"',
    query: 'demo=1&theme=dark&sidebar=1&quota=limits',
    width: 1560,
    height: 980,
    scale: 1,
    steps: [{ click: '#settings-toggle' }],
  },
  {
    name: 'n-wp13-language-tr-dark',
    what: 'The whole canvas in Turkish, with the settings panel scrolled to the six-language picker',
    where: 'new — N-WP13, not yet in the README',
    query: 'demo=1&theme=dark&sidebar=1&lang=tr',
    width: 1560,
    height: 980,
    scale: 1,
    // Language is the fifth section of a panel that scrolls, so opening the
    // panel is not the same as showing the picker: without this the shot was
    // a Turkish canvas beside Appearance, which is a picture of the theme.
    steps: [{ click: '#settings-toggle' }, { scroll: '[data-nz-t="settings.language"]' }],
  },
  {
    name: 'n-wp15a-task-text-dark',
    what: 'Task text on the cards: one line per session saying what it was asked to do',
    where: 'README, "Task text"',
    query: 'demo=1&theme=dark&sidebar=1',
    width: 1560,
    height: 980,
    scale: 1,
    // There is no parameter for this one and there cannot be a pre-seeded
    // `localStorage` either: under `?demo=1` the page swaps its storage for an
    // in-memory map, so the switch has to be pressed.
    steps: [
      { click: '#settings-toggle' },
      { click: '#task-text-toggle' },
      { click: '#settings-back' },
      // And then *Arrange*, which is not decoration. Switching task text on
      // makes every card one line taller and cards are never re-packed under
      // somebody who placed them, so a canvas that was packed edge to edge
      // overlaps by that line until it is asked to re-pack — documented
      // behaviour, and a picture of it reads as a rendering fault. `43664f2`
      // says *Arrange* is the answer; this shot presses it.
      { click: '#arrange' },
    ],
  },
  {
    name: 'n-wp15-quiet-cards-dark',
    what: 'The quieter card: a neutral frame, the pulse moved to the ring, working and idle and waiting side by side',
    where: 'README, "What it looks like", first image',
    query: 'demo=1&theme=dark',
    width: 1560,
    height: 980,
    scale: 1,
  },
  {
    name: 'n-wp16-sound-setting-dark',
    what: 'The sound switches under Behaviour: an ending, a permission prompt, and quiet hours',
    where: 'README, "A sound when a session ends"',
    query: 'demo=1&theme=dark&sidebar=1',
    width: 1560,
    height: 980,
    scale: 1,
    steps: [
      { click: '#settings-toggle' },
      // Quiet hours are hidden until they are switched on, and the row with the
      // two time fields is the half of this setting worth a picture. The panel
      // scrolls, and Sound is below the fold in every window this file uses, so
      // the section is brought into view rather than the window made taller —
      // a screenshot of a settings panel should look like a settings panel.
      { click: '#sound-quiet-toggle' },
      { scroll: '[data-nz-t="settings.sound"]' },
    ],
  },
  {
    name: 'n-wp18-codex-session-dark',
    what: 'A Codex thread on the canvas: its own badge, no pid, no subagents, no cost or context',
    where: 'new — N-WP18, not yet in the README',
    query: 'demo=1&theme=dark',
    width: 1560,
    height: 980,
    scale: 1,
    // Found by the badge it draws rather than by its place in the row: the
    // demo's fifth seed is the Codex one today, and a sixth would move it.
    steps: [{ focus: '.nz-session:has(image[href*="codex"])' }],
  },
  {
    name: 'n-wp19-card-menu-dark',
    what: 'The canvas’s own right-click menu on a card, rather than the browser’s',
    where: 'README, "Right-click anything"',
    query: 'demo=1&theme=dark',
    width: 1560,
    height: 980,
    scale: 1,
    steps: [{ contextmenu: '.nz-session .nz-session__handle' }],
  },
  {
    name: 'n-wp21-needs-you-dark',
    what: 'The Needs-you strip open: who is waiting for you, for how long, and a way to jump there',
    where: 'README, "What it looks like", third image',
    query: 'demo=1&theme=dark',
    width: 1560,
    height: 980,
    scale: 1,
    steps: [{ click: '#needs-you' }],
  },
];

/* ------------------------------------------------------------------ *
 * Page-side determinism
 * ------------------------------------------------------------------ */

/**
 * Injected before any of the bundle runs, on every document.
 *
 * `Date` is replaced rather than shimmed so that `makeDemoState`'s default
 * `now` and `formatStamp`'s `new Date(ms)` both come out of the same fixed
 * instant; `parse` and `UTC` are carried across because the demo history
 * builder uses `Date.UTC` to place its epoch and would otherwise lose it.
 * `Math.random` is seeded defensively — the UI has no call to it today, and a
 * screenshot run is exactly where a new one would be noticed a week late.
 */
const PREAMBLE = `(() => {
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

  let frame = 0;
  performance.now = () => (frame += 1000 / 60);

  let seed = 0x9e3779b9;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent =
      '*, *::before, *::after { transition-duration: 0s !important;' +
      ' transition-delay: 0s !important; caret-color: transparent !important; }';
    document.head.append(style);
  }, { once: true });
})();`;

/**
 * Stop every animation on its first keyframe.
 *
 * `currentTime = 0` and not `finish()`: the animations on this canvas loop
 * forever, so they have no finished state to jump to, and their zeroth frame is
 * the one somebody would draw if asked for a still — the waiting ring at full
 * opacity and its smallest radius rather than faded out at its largest.
 * `cancel()` would be wrong for the same reason in reverse: it reverts the
 * element to the style it has with no animation at all, which for the ring is
 * not a frame of the animation but the absence of one. Returns how many were
 * paused, which is the cheapest evidence that the page had actually painted.
 */
const FREEZE = `(() => {
  let paused = 0;
  for (const animation of document.getAnimations()) {
    try {
      animation.pause();
      animation.currentTime = 0;
      paused += 1;
    } catch {
      // An animation belonging to a detached element throws; it is not on
      // screen either, so there is nothing to pause.
    }
  }
  return paused;
})()`;

/** Two frames of quiet, which is what the draw scheduler needs to have run. */
const SETTLE = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`;

/* ------------------------------------------------------------------ *
 * A DevTools protocol client
 * ------------------------------------------------------------------ */

/**
 * One WebSocket to the browser, and a flat session per tab.
 *
 * "Flat" is the whole reason this is short: with `flatten: true` a target's
 * messages travel on the browser's own socket carrying a `sessionId`, so there
 * is one connection, one message loop and one place where a protocol error
 * turns into a rejected promise.
 */
class Cdp {
  #socket;
  #next = 0;
  #pending = new Map();
  #watchers = new Set();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        for (const watcher of [...this.#watchers]) watcher(message);
        return;
      }
      const waiter = this.#pending.get(message.id);
      if (waiter === undefined) return;
      this.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${waiter.method})`));
      else waiter.resolve(message.result);
    });
  }

  /**
   * Resolve on the next `method` from `sessionId`, or after `timeout` ms.
   *
   * A timeout rather than a rejection on purpose: the only caller is the wait
   * for `Page.loadEventFired`, and a page that has drawn its canvas without
   * firing one is a page worth screenshotting. The check that the picture is
   * actually there is the poll that follows, which does reject.
   */
  once(method, sessionId, timeout) {
    return new Promise((resolve) => {
      const watcher = (message) => {
        if (message.method !== method) return;
        if (sessionId !== undefined && message.sessionId !== sessionId) return;
        this.#watchers.delete(watcher);
        clearTimeout(timer);
        resolve(message.params);
      };
      const timer = setTimeout(() => {
        this.#watchers.delete(watcher);
        resolve(undefined);
      }, timeout);
      this.#watchers.add(watcher);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot reach ${url}`)), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = (this.#next += 1);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#socket.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
      );
    });
  }

  close() {
    this.#socket.close();
  }
}

/**
 * Evaluate an expression in a page and hand back its value.
 *
 * Every exception is re-thrown here rather than returned as an `undefined`,
 * because a step that silently did nothing is the failure mode this whole file
 * exists to avoid: the picture would still be written, and it would be wrong.
 */
async function evaluate(cdp, session, expression, { awaitPromise = false } = {}) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    session,
  );
  if (result.exceptionDetails) {
    const thrown =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown';
    throw new Error(`page threw: ${String(thrown).split('\n')[0]}`);
  }
  return result.result.value;
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

/**
 * The eight resize grips, in the order `canvas.ts` appends them.
 *
 * Edges first, corners after, so that where a corner overlaps an edge the
 * corner takes the press. Kept here as a list rather than derived, because
 * this file has to be able to say "the third grip of the second card" without
 * importing anything from a package that only builds after `tsc`.
 */
const HANDLES = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];

/** The verbs that move the mouse, and therefore leave a cursor somewhere. */
const POINTER_STEPS = ['click', 'clickText', 'contextmenu', 'drag', 'resize'];

/** The browser window every scenario is emulated inside: the largest one, with room. */
const WINDOW = {
  width: Math.max(...SCENARIOS.map((one) => one.width)) + 40,
  height: Math.max(...SCENARIOS.map((one) => one.height)) + 40,
};

/**
 * Where a selector is on screen, in CSS pixels, or a thrown error naming it.
 *
 * `index` picks among matches, because several of the things worth clicking —
 * a tab, a card's rename control — have no id of their own and are identified
 * by their position in a list the renderer controls.
 *
 * `at` is a fraction of the box, and it exists for exactly one element: the
 * card's drag handle, whose middle is *not* a place you can start a drag. The
 * handle is the whole width of the header and 62 px tall, and the rename target
 * — a transparent strip over the title, appended after it so it takes the press
 * first — covers the top 20 px of it. A press at the handle's centre therefore
 * lands on `[data-action="rename"]`, which `app.ts` answers by neither dragging
 * nor panning; the card stays put and the release opens the name field instead,
 * which is exactly the picture `wp4c-dragged-dark` used to be.
 */
async function centreOf(cdp, session, selector, index = 0, at = { x: 0.5, y: 0.5 }) {
  const box = await evaluate(
    cdp,
    session,
    `(() => {
      const all = document.querySelectorAll(${JSON.stringify(selector)});
      const element = all[${index}];
      if (element === undefined) {
        return { error: 'no element ' + ${JSON.stringify(selector)} + ' [' + ${index} + '] (' + all.length + ' matched)' };
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return { error: ${JSON.stringify(selector)} + ' has no box on screen' };
      }
      return { x: rect.left + rect.width * ${at.x ?? 0.5}, y: rect.top + rect.height * ${at.y ?? 0.5} };
    })()`,
  );
  if (box.error) throw new Error(box.error);
  return box;
}

/** A real press-and-release, so the page sees pointer events and not a synthetic click. */
async function mouse(cdp, session, type, x, y, button = 'left', clickCount = 1) {
  await cdp.send(
    'Input.dispatchMouseEvent',
    {
      type,
      x,
      y,
      button,
      buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1,
      clickCount,
      pointerType: 'mouse',
    },
    session,
  );
}

/**
 * Run one step.
 *
 * The vocabulary is deliberately small and every verb maps to something the
 * page already listens for. Anything that needs a fifteenth verb probably
 * wants a URL parameter instead, and `app.ts` has been happy to grow those.
 */
async function runStep(cdp, session, step) {
  if (step.wait !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, step.wait));
    return;
  }

  if (step.click !== undefined) {
    const { selector, index } =
      typeof step.click === 'string' ? { selector: step.click, index: 0 } : step.click;
    const at = await centreOf(cdp, session, selector, index ?? 0);
    await mouse(cdp, session, 'mousePressed', at.x, at.y);
    await mouse(cdp, session, 'mouseReleased', at.x, at.y);
    return;
  }

  if (step.contextmenu !== undefined) {
    const at = await centreOf(cdp, session, step.contextmenu);
    await mouse(cdp, session, 'mousePressed', at.x, at.y, 'right');
    await mouse(cdp, session, 'mouseReleased', at.x, at.y, 'right');
    return;
  }

  if (step.focus !== undefined) {
    await evaluate(
      cdp,
      session,
      `(() => {
        const element = document.querySelector(${JSON.stringify(step.focus)});
        if (element === null) throw new Error('nothing to focus: ' + ${JSON.stringify(step.focus)});
        element.focus();
        return true;
      })()`,
    );
    return;
  }

  if (step.clickText !== undefined) {
    // A menu item has no id — the menus are built in `tabbar.ts` out of
    // catalogue strings — so it is found by the words it shows. A miss lists
    // what was on offer, because "the menu did not have that item" is a
    // question about the menu and not about this file.
    const { in: root, text } = step.clickText;
    const found = await evaluate(
      cdp,
      session,
      `(() => {
        const menu = document.querySelector(${JSON.stringify(root)});
        if (menu === null) return { error: 'no menu ' + ${JSON.stringify(root)} };
        const items = [...menu.querySelectorAll('.nz-menu__item')];
        const hit = items.findIndex((item) => (item.textContent ?? '').startsWith(${JSON.stringify(text)}));
        if (hit < 0) return { error: 'no item starting "' + ${JSON.stringify(text)} + '"; the menu offers: ' + items.map((i) => i.textContent).join(' | ') };
        return { index: hit };
      })()`,
    );
    if (found.error) throw new Error(found.error);
    const at = await centreOf(cdp, session, `${root} .nz-menu__item`, found.index);
    await mouse(cdp, session, 'mousePressed', at.x, at.y);
    await mouse(cdp, session, 'mouseReleased', at.x, at.y);
    return;
  }

  if (step.scroll !== undefined) {
    // `instant` and not the default: a smooth scroll is an animation, and an
    // animation is a capture that disagrees with the one before it.
    await evaluate(
      cdp,
      session,
      `(() => {
        const element = document.querySelector(${JSON.stringify(step.scroll)});
        if (element === null) throw new Error('nothing to scroll to: ' + ${JSON.stringify(step.scroll)});
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      })()`,
    );
    return;
  }

  if (step.set !== undefined) {
    await evaluate(
      cdp,
      session,
      `(() => {
        const field = document.querySelector(${JSON.stringify(step.set.selector)});
        if (field === null) throw new Error('no field ' + ${JSON.stringify(step.set.selector)});
        field.value = ${JSON.stringify(step.set.value)};
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
    return;
  }

  if (step.type !== undefined) {
    for (const character of step.type) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: character }, session);
    }
    return;
  }

  if (step.key !== undefined) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key, text: step.key }, session);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key }, session);
    return;
  }

  if (step.drag !== undefined) {
    const from = await centreOf(cdp, session, step.drag.from, 0, step.drag.at ?? { x: 0.5, y: 0.5 });
    await pointerDrag(cdp, session, from, step.drag);
    return;
  }

  if (step.resize !== undefined) {
    const { card, handle, dx, dy } = step.resize;
    const slot = HANDLES.indexOf(handle);
    if (slot < 0) throw new Error(`no such resize handle: ${handle}`);
    // Eight grips per card, appended in the order `canvas.ts` lists them, so
    // the nth card's grip for a handle is at `n * 8 + slot`. Selecting by
    // `[data-resize="se"]` alone would work too and read better, but this way
    // an extra grip appearing on a card is an off-by-one that shows in the
    // picture rather than a silent match on the wrong card.
    const at = await centreOf(cdp, session, '.nz-session [data-resize]', card * HANDLES.length + slot);
    await pointerDrag(cdp, session, at, { dx, dy });
    return;
  }

  throw new Error(`unknown step: ${JSON.stringify(step)}`);
}

/**
 * Press, move in a few increments, release.
 *
 * In increments because the canvas reads a gesture rather than a jump, and
 * **with a frame's wait after every one of them**, which is the part that
 * turned out to matter. Without it the first `--check` run reported the two
 * resize pictures as different from the run five minutes earlier: the browser
 * coalesces mouse moves that arrive inside one frame, so whether the last
 * `pointermove` before the release was seen at all was a race, and a card that
 * settled one increment short is a card of a different width. Waiting for the
 * page to have painted each position makes the gesture a sequence the renderer
 * has actually followed.
 */
async function pointerDrag(cdp, session, from, { dx, dy }) {
  await mouse(cdp, session, 'mousePressed', from.x, from.y);
  for (let step = 1; step <= 3; step += 1) {
    await mouse(cdp, session, 'mouseMoved', from.x + (dx * step) / 3, from.y + (dy * step) / 3);
    await evaluate(cdp, session, SETTLE, { awaitPromise: true });
  }
  await mouse(cdp, session, 'mouseReleased', from.x + dx, from.y + dy);
  await evaluate(cdp, session, SETTLE, { awaitPromise: true });
}

/* ------------------------------------------------------------------ *
 * Taking one picture
 * ------------------------------------------------------------------ */

/**
 * Capture until two captures in a row agree.
 *
 * A run that cannot settle is a failure with a name attached rather than a
 * picture that differs from the last one for a reason nobody will find later.
 */
async function captureStable(cdp, session, scenario) {
  const { name } = scenario;
  let previous;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await evaluate(cdp, session, SETTLE, { awaitPromise: true });
    await evaluate(cdp, session, FREEZE);
    await evaluate(cdp, session, SETTLE, { awaitPromise: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
    const png = Buffer.from(shot.data, 'base64');
    if (previous !== undefined && previous.equals(png)) return png;
    previous = png;
  }
  throw new Error(`${name}: two captures in a row never agreed — something on the page is moving`);
}

/** One scenario, from a blank tab to a PNG in memory. */
async function shoot(cdp, scenario, origin) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: scenario.width,
        height: scenario.height,
        deviceScaleFactor: scenario.scale,
        mobile: false,
      },
      sessionId,
    );
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }, sessionId);
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PREAMBLE }, sessionId);

    /*
     * The language is pinned for the same reason the theme is.
     *
     * `resolveLocale` falls back to `navigator.languages`, and
     * `Emulation.setLocaleOverride` moves ICU without moving that — so on a
     * Turkish desktop the first run of this file produced a canvas, a drawer
     * and a context menu in Turkish, which is a picture of *this machine*
     * rather than of the program. `lang=en` is appended unless the scenario
     * asked for a language of its own, which is how the six-language shot
     * keeps its `lang=tr`.
     */
    const query = /(^|&)lang=/.test(scenario.query)
      ? scenario.query
      : `${scenario.query}&lang=en`;

    const loaded = cdp.once('Page.loadEventFired', sessionId, 20000);
    await cdp.send('Page.navigate', { url: `${origin}/?${query}` }, sessionId);
    await loaded;
    // The canvas is drawn from a `requestAnimationFrame` callback after the
    // load event, so waiting for the load is not waiting for the picture. The
    // empty-state scenario has no card at all, which is why this waits for
    // either a card or the empty panel.
    await evaluate(
      cdp,
      sessionId,
      `new Promise((resolve, reject) => {
        const deadline = performance.now() + 10000;
        const look = () => {
          if (document.querySelector('.nz-session') !== null) return resolve(true);
          const empty = document.getElementById('empty');
          if (empty !== null && !empty.hidden) return resolve(true);
          if (performance.now() > deadline) return reject(new Error('the canvas never drew'));
          requestAnimationFrame(look);
        };
        look();
      })`,
      { awaitPromise: true },
    );

    let touched = false;
    for (const step of scenario.steps ?? []) {
      await evaluate(cdp, sessionId, SETTLE, { awaitPromise: true });
      await runStep(cdp, sessionId, step);
      touched ||= POINTER_STEPS.some((verb) => step[verb] !== undefined);
    }

    /*
     * Park the pointer where nothing reacts to it.
     *
     * A click leaves the cursor where it landed, and `pointerover` on a card
     * opens the hover card — so the first run of `wp4f-cleared-dark` came out
     * with the whole tooltip drawn over the neighbouring session, on top of
     * the chip the picture exists to show. Moving to the bottom-right corner
     * afterwards is the cheapest way to say "nothing is under the mouse", and
     * it is only done when a step actually used the mouse, so the hover shot —
     * which opens its card by focus and never touches the pointer — is left
     * alone.
     */
    if (touched && scenario.park !== false) {
      await mouse(cdp, sessionId, 'mouseMoved', scenario.width - 2, scenario.height - 2);
    }

    return await captureStable(cdp, sessionId, scenario);
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * The browser, the server, and the command line
 * ------------------------------------------------------------------ */

/** Where Chrome or Edge usually is, per platform. Overridden by `--chrome`. */
const BROWSERS = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
};

function findBrowser(override) {
  if (override !== undefined) {
    if (!existsSync(override)) throw new Error(`no browser at ${override}`);
    return override;
  }
  const candidates = BROWSERS[process.platform] ?? BROWSERS.linux;
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `no Chrome or Edge found. Looked in:\n  ${candidates.join('\n  ')}\nPass --chrome <path>.`,
    );
  }
  return found;
}

/** A port nothing is listening on, asked of the operating system rather than guessed. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the canvas server and wait for it to say where it is.
 *
 * `--no-open` because a screenshot run has no use for a browser window, and
 * `--no-task-text` because the server must not read a transcript on this
 * machine: every scenario is a demo canvas whose task lines come from
 * `DEMO_TASKS` in the browser, so the flag costs the pictures nothing and
 * removes the one path by which a real sentence could reach one.
 */
async function startServer(port) {
  const child = spawn(
    process.execPath,
    [path.join(REPO, 'bin', 'nazar.mjs'), '--port', String(port), '--no-open', '--no-task-text'],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NAZAR_UI_DIR: UI_DIR } },
  );
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the server did not start in 20 s:\n${output}`)),
      20000,
    );
    const read = (chunk) => {
      output += chunk;
      const match = /canvas: (http:\/\/\S+?)\/?\s/.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${code}:\n${output}`));
    });
  });
  return { child, origin };
}

/** Launch a headless browser and hand back its DevTools endpoint. */
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
      // Rendering knobs, all of them there so that one machine agrees with
      // itself: a fixed colour profile, greyscale antialiasing rather than
      // subpixel, and no hinting that depends on the display.
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--font-render-hinting=none',
      /*
       * And then the compositor, which is where this file spent its afternoon.
       *
       * Two tabs driven identically, with byte-identical DOM and byte-identical
       * geometry — the card rectangles were measured and agreed to the
       * hundredth of a pixel — were still producing different PNGs. Never
       * between two captures of the *same* page, which is what made it look
       * like a screenshot problem rather than a rasterising one; always between
       * two pages, and always small: twelve pixels of one rounded border, each
       * off by one unit in one channel.
       *
       * Two rounds fixed it, and both are worth keeping. The first —
       * `--disable-gpu` and friends — took the raster off the GPU thread and
       * off its own animation and scrolling threads, and settled the two
       * pictures that resize a card while its hover panel, a `will-change`
       * layer, is on screen. The second — **`--disable-partial-raster`** — is
       * the one that settled the last of them: the compositor reuses tiles it
       * has already rastered when only part of a layer is invalidated, so a
       * pill in the header that had been painted before the right-click menu
       * opened kept whichever antialiasing it happened to be given first, and
       * "whichever it happened to be given" is exactly the thing a screenshot
       * run cannot have. Eight consecutive runs of the scenario that used to
       * flake one time in four now agree.
       */
      '--disable-gpu',
      '--run-all-compositor-stages-before-draw',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-new-content-rendering-timeout',
      '--disable-image-animation-resync',
      '--disable-partial-raster',
      '--disable-gpu-rasterization',
      // Big enough for the largest scenario, so that every
      // `setDeviceMetricsOverride` shrinks the viewport rather than growing it
      // past the window it lives in. This one did *not* turn out to be what
      // fixed the flake above — it was tried first and the flake survived it —
      // but emulating a page larger than its own widget is a thing to be
      // avoided on its own merits, so it stays.
      `--window-size=${WINDOW.width},${WINDOW.height}`,
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
  const options = {
    check: false,
    list: false,
    build: true,
    keep: false,
    out: SHOTS,
    only: [],
    chrome: undefined,
    port: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[(index += 1)];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    switch (argument) {
      case '--check':
        options.check = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--no-build':
        options.build = false;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--out':
        options.out = path.resolve(value());
        break;
      case '--only':
        options.only.push(...value().split(',').filter(Boolean));
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

const HELP = `node scripts/screenshots.mjs [options]

Regenerate every image under docs/screenshots/ from the demo canvas.

  --check           take the pictures and compare them with the ones on disk,
                    printing what differs and exiting 1; writes nothing
  --out <dir>       write here instead of docs/screenshots
  --only <a,b>      only the scenarios whose name contains one of these
  --list            print the scenario table and exit
  --no-build        reuse packages/ui/dist/web instead of rebuilding
  --chrome <path>   the browser to drive (default: the installed Chrome or Edge)
  --port <number>   the port to serve the canvas on (default: a free one)
  --keep            leave the temporary browser profile behind
  -h, --help        this
`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const wanted =
    options.only.length === 0
      ? SCENARIOS
      : SCENARIOS.filter((scenario) => options.only.some((needle) => scenario.name.includes(needle)));

  if (options.list) {
    for (const scenario of SCENARIOS) {
      const size = `${scenario.width}x${scenario.height}@${scenario.scale}`;
      process.stdout.write(
        `${scenario.name.padEnd(26)} ${size.padEnd(14)} ?${scenario.query}\n` +
          `${' '.repeat(26)} ${scenario.what}\n` +
          `${' '.repeat(26)} ${scenario.where}\n\n`,
      );
    }
    return 0;
  }

  if (wanted.length === 0) {
    process.stderr.write(`screenshots: --only matched nothing\n`);
    return 2;
  }

  if (options.build) {
    process.stdout.write('building the canvas...\n');
    execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  if (!existsSync(path.join(UI_DIR, 'index.html'))) {
    throw new Error(`no bundle at ${UI_DIR}. Run "npm run build" (or drop --no-build).`);
  }

  const executable = findBrowser(options.chrome);
  const port = options.port ?? (await freePort());
  const profile = mkdtempSync(path.join(os.tmpdir(), 'nazar-screenshots-'));

  const server = await startServer(port);
  let browser;
  let cdp;
  const results = [];
  try {
    browser = await startBrowser(executable, profile);
    cdp = await Cdp.connect(browser.endpoint);
    process.stdout.write(`${server.origin} · ${path.basename(executable)} · ${wanted.length} scenarios\n\n`);

    if (!options.check) mkdirSync(options.out, { recursive: true });

    for (const scenario of wanted) {
      const started = Date.now();
      try {
        const png = await shoot(cdp, scenario, server.origin);
        const file = path.join(options.out, `${scenario.name}.png`);
        if (options.check) {
          const existing = existsSync(file) ? readFileSync(file) : undefined;
          const state =
            existing === undefined ? 'missing' : existing.equals(png) ? 'same' : 'differs';
          results.push({ scenario, state, ms: Date.now() - started });
        } else {
          writeFileSync(file, png);
          results.push({ scenario, state: 'written', ms: Date.now() - started, bytes: png.length });
        }
      } catch (error) {
        results.push({ scenario, state: 'failed', ms: Date.now() - started, error });
      }
      const last = results[results.length - 1];
      process.stdout.write(
        `${last.state === 'failed' ? 'FAIL' : last.state.padEnd(7)} ${scenario.name.padEnd(26)} ${String(last.ms).padStart(5)} ms` +
          `${last.bytes ? ` ${(last.bytes / 1024).toFixed(0)} KB` : ''}` +
          `${last.error ? `\n       ${last.error.message}` : ''}\n`,
      );
    }
  } finally {
    cdp?.close();
    server.child.kill();
    if (browser !== undefined) {
      const gone = new Promise((resolve) => browser.child.once('exit', resolve));
      browser.child.kill();
      await gone;
    }
    // Windows keeps the profile's files open until the last of the browser's
    // processes is gone, which is a moment after the one we started exits. A
    // temporary directory left behind is worth nothing next to a run that
    // reports a failure it did not have, so this is a try and not a step.
    if (!options.keep) {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        process.stderr.write(`(left ${profile} behind: the browser still had it open)\n`);
      }
    }
  }

  const failed = results.filter((one) => one.state === 'failed');
  const different = results.filter((one) => one.state === 'differs' || one.state === 'missing');
  process.stdout.write(
    `\n${results.length} scenarios · ${failed.length} failed` +
      (options.check ? ` · ${different.length} differ` : '') +
      '\n',
  );
  if (options.check && different.length > 0) {
    process.stdout.write(
      `\nout of date:\n${different.map((one) => `  ${one.state.padEnd(8)} ${one.scenario.name}.png`).join('\n')}\n`,
    );
  }
  return failed.length > 0 || different.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`screenshots: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
