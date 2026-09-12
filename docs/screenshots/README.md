# The screenshots

Every image in this directory is produced by one command:

```sh
npm run screenshots
```

It builds the canvas, starts `bin/nazar.mjs` on a free port with `--no-open`,
drives a headless Chrome through the scenario table in
[`scripts/screenshots.mjs`](../../scripts/screenshots.mjs), and writes one PNG
per row. Nothing is installed to run it: the browser is the Chrome or Edge
already on the machine, and the driver is a small DevTools-protocol client
written against Node's own `WebSocket`, so `package.json` gains nothing —
neither a runtime dependency nor a dev one.

**Every shot is a demo canvas.** Each scenario loads `?demo=1`, so the picture
is built in the browser from `packages/ui/src/demo.ts` and
`demo-history.ts` — invented sessions, invented task text, placeholder pids,
`C:/proj/...` folders. Nothing under `~/.claude`, `~/.codex` or `~/.nazar` is
read to take one, and the server is additionally started with
`--no-task-text`, so there is no path by which a sentence somebody actually
typed can reach a file in this directory.

## Options

| | |
|---|---|
| `npm run screenshots` | rebuild the canvas and rewrite every PNG here |
| `npm run screenshots -- --check` | take them all and **compare**; prints what differs and exits 1, writes nothing |
| `npm run screenshots -- --out docs/screenshots/_preview` | write somewhere else — `_preview/` is gitignored |
| `npm run screenshots -- --only wp4e` | just the scenarios whose name contains this (comma-separate for several) |
| `npm run screenshots -- --list` | print the table below from the source of truth |
| `npm run screenshots -- --no-build` | reuse `packages/ui/dist/web` instead of rebuilding |
| `npm run screenshots -- --chrome <path>` | drive a particular browser |
| `npm run screenshots -- --port <n>` | serve the canvas on a chosen port |

`--check` is a command you type, not a CI job. There is no web font to wait
for — the canvas uses a system stack in every palette — which is exactly why
the text is rendered by whatever `ui-sans-serif` resolves to locally: two runs
on one machine are byte-identical, a run on Windows and a run on Linux are not.

## Determinism

Two runs of the same command produce byte-identical files. Four things are
pinned to get there, all of them in the driver, none of them in the page:

- **the clock** — `Date.now()` and `new Date()` answer a fixed instant, so the
  history panel's absolute stamps do not move (relative ages were already
  stable, because the demo measures them against its own `generatedAt`);
- **the timezone**, pinned to UTC, because `formatStamp` uses local getters;
- **the language**, pinned with `?lang=en` unless a scenario asks for another —
  without it the pictures come out in the language of the desktop that took
  them, which the first run of this script demonstrated in Turkish;
- **motion** — every running animation is paused at its first keyframe, and
  transition durations and the caret are zeroed, before anything is captured.

Each shot is then taken twice and only accepted when the two agree.

## The scenarios

| File | What it shows | Where it is used |
|---|---|---|
| `wp4-100-dark.png` | The whole canvas, dark, at 1× device pixel ratio | PROJECT.md §8, WP4 |
| `wp4-100-light.png` | The whole canvas, light, at 1× | PROJECT.md §8, WP4 |
| `wp4-150-dark.png` | The same canvas at 1.5×, where the SVG has to stay crisp | PROJECT.md §8, WP4 |
| `wp4-150-light.png` | The same canvas at 1.5×, light | PROJECT.md §8, WP4 |
| `wp4-200-dark.png` | The same canvas at 2× | PROJECT.md §8, WP4 |
| `wp4-200-light.png` | The same canvas at 2×, light | PROJECT.md §8, WP4 |
| `wp4-empty-dark.png` | The empty state: no session on the machine, and the lines that say why | PROJECT.md §8, WP4 |
| `wp4-hover-dark.png` | The hover card over a session: tokens, context window, the folder | PROJECT.md §8, WP4 |
| `wp4b-history-dark.png` | The History panel, past sessions grouped by project, one opened as a frozen tree | **README**, *What it looks like*, 4th image |
| `wp4c-overview-dark.png` | Sessions with their trees, the tab bar, the waiting banner, the drawer open | **README**, *What it looks like*, 2nd image |
| `wp4c-overview-light.png` | The same, light | PROJECT.md §8, WP4c |
| `wp4c-sixty-agents-dark.png` | One session with sixty subagents: the card grows, the tree wraps | **README**, *Fold a big tree away* |
| `wp4c-collapsed-dark.png` | The same session folded away: one row of chips counting the tree | **README**, *Fold a big tree away*, 2nd image |
| `wp4c-dragged-dark.png` | A card dragged out of the grid, to show the arrangement is the user's | PROJECT.md §8, WP4c |
| `wp4d-activity-dark.png` | Sessions in four states — working, idle, waiting, unknown — framed and labelled | PROJECT.md §8, WP4d |
| `wp4d-activity-light.png` | The same four states, light | PROJECT.md §8, WP4d |
| `wp4e-themes-sepia.png` | The Sepia palette in light mode, settings open on Appearance | **README**, *Themes* |
| `wp4e-themes-midnight.png` | The Midnight palette in dark mode, settings open on Appearance | **README**, *Themes* |
| `wp4e-colours-dark.png` | Two activity colours overridden, with the cards already reframed | **README**, *Themes*, 3rd image |
| `wp4e-notes-dark.png` | Three sticky notes on the canvas under the cards, one per colour | **README**, *Sticky notes* |
| `wp4e-notes-light.png` | The same three notes, light | PROJECT.md §8, WP4e |
| `wp4e-popover-dark.png` | The usage-limits panel: six windows, every severity, two sources | **README**, *Usage limits, cost and context* |
| `wp4e-popover-light.png` | The same panel, light | PROJECT.md §8, WP4e |
| `wp4f-resize-dark.png` | A card dragged narrower from its corner: the tree re-wraps, the grips are drawn | **README**, *Themes and colours*, 4th image |
| `wp4f-cleared-dark.png` | The same card with its finished subagents hidden, and the chip that brings them back | **README**, *Clear finished subagents* |
| `wp4g-projects-dark.png` | Two folder tabs, and the drawer listing each with its live and past counts | **README**, *Folder tabs are folders that own a tab* |
| `wp4g-rename-dark.png` | Cards titled by their user, one with the inline name field open | **README**, *Name a card*, 2nd image |
| `wp5-quota-dark.png` | The bead in the top bar on a machine with nazar-tray installed | PROJECT.md §8, WP5 |
| `wp5-quota-light.png` | The same bead, light | PROJECT.md §8, WP5 |
| `n-wp10-resize-dark.png` | All eight resize handles: a card dragged from its east edge | **README**, *Resize a card from any edge or corner* |
| `n-wp11-folder-tab-dark.png` | A folder tab selected: only the sessions under that folder | **README**, *Folder tabs are folders that own a tab* |
| `n-wp12-settings-dark.png` | The settings panel in the drawer's own place | **README**, *The sidebar* |
| `n-wp13-language-tr-dark.png` | The whole canvas in Turkish, with the settings panel scrolled to the six-language picker | **README**, *Six UI languages* |
| `n-wp15-quiet-cards-dark.png` | The quieter card: neutral frame, the pulse moved to the ring | **README**, *What it looks like*, 1st image |
| `n-wp15a-task-text-dark.png` | Task text on the cards: one line per session saying what it was asked to do | **README**, *Task text* |
| `n-wp16-sound-setting-dark.png` | The sound switches under Behaviour, with quiet hours open | **README**, *A sound when a session ends* |
| `n-wp18-codex-session-dark.png` | A Codex thread: its own badge, no pid, no subagents, no cost | **README**, *Principles*, the Codex entry |
| `n-wp19-card-menu-dark.png` | The canvas's own right-click menu on a card | **README**, *Right-click anything* |
| `n-wp21-needs-you-dark.png` | The Needs-you strip open: who is waiting, and for how long | **README**, *What it looks like*, 3rd image |

Eight of the ten `n-wp*` files were placed in the README by N-WP22, which also
retook seven shots whose window was too small for what the paragraph beside
them claims. The last two — `n-wp13-language-tr-dark.png` and
`n-wp18-codex-session-dark.png` — went in with the release, each beside the
paragraph that wanted it: adding an image means writing the alt text that goes
with it, and the alt texts in this project are hand-written sentences
describing the picture, not captions. Every file in this table is now used
somewhere, and this column says where.

Two of the older shots left the README in the same round.
`wp4d-activity-{dark,light}.png` drew the four activity states on the card as
WP4d shipped it; `n-wp15-quiet-cards-dark.png` draws the same four on the
quieter card and took the first image with it. They stay here as the record of
what WP4d looked like.

## Adding one

Add a row to `SCENARIOS` in `scripts/screenshots.mjs`. Reach for a URL
parameter before reaching for `steps`: `packages/ui/web/app.ts` already carries
`sidebar`, `collapse`, `notes`, `projects`, `history`, `session`, `quota`,
`usage`, `sessions`, `agents`, `theme`, `palette` and `lang` *because*
screenshots need them, and a URL cannot go out of step with itself the way a
sequence of clicks can. `steps` exist for the states that have no parameter —
the settings panel, the Needs-you popover, a context menu, a drag, a resize.

Keep the file names of the shots that already exist. The README refers to them
by path and carries a hand-written alt text for each, so a rename is a broken
image and a lost sentence.
