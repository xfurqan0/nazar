# The screenshots, and the tour

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

**This page is the gallery.** The README carried twenty-three of these inline;
it now carries a short recording and five stills, and every picture that left
it is [below](#the-gallery), under the feature it belongs to, with the sentence
that used to sit beside it.

## Options

| | |
|---|---|
| `npm run screenshots` | rebuild the canvas and rewrite every PNG here |
| `npm run screenshots -- --check` | take them all and **compare**; prints what differs and exits 1, writes nothing |
| `npm run screenshots -- --out docs/screenshots/_preview` | write somewhere else — `_preview/` is gitignored |
| `npm run screenshots -- --only wp4e` | just the scenarios whose name contains this (comma-separate for several) |
| `npm run screenshots -- --list` | print the scenarios from the source of truth, with what each one shows and where it is used |
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

## The tour

The recording at the top of the README is written by a second command, over the
same demo canvas and through the same driver:

```sh
npm run tour
```

It writes two files into [`docs/media/`](../media):

| File | What it is | For |
|---|---|---|
| `tour.gif` | 960 × 600, 12 fps, palette-optimised | the README — GitHub renders a GIF inline and will not render an MP4 from a repository path |
| `tour.mp4` | 1280 × 800, 30 fps, H.264 / yuv420p | the sharp copy, for attaching to a release (`gh release upload v0.1.0 docs/media/tour.mp4`) |

Both are the same twenty-six seconds of the same twenty-one beats, listed as
`BEATS` at the top of [`scripts/tour.mjs`](../../scripts/tour.mjs): the canvas
with its running sessions and subagent trees, the permission-wait banner and
the `Needs you` strip, a hover card, the History panel opening a past run as a
frozen tree, the Midnight palette, and the Codex thread.

**How it records.** Chrome's own `Page.startScreencast` hands over a JPEG every
time the page paints, stamped with the instant it painted at — a real recording
of a real browser rather than a sequence of stills pretending to be one. The
frames arrive irregularly, which is correct: a canvas holding still paints
rarely and a drawer sliding open paints sixty times a second. Nothing is
resampled, so nothing is invented; each frame is written out with the gap to
the next one as its duration and handed to `ffmpeg`'s `concat` demuxer, and a
still second costs one frame while a moving one costs sixty. **`ffmpeg` must be
on the PATH** (`winget install Gyan.FFmpeg`); it is the only thing this command
needs that `npm run screenshots` does not, and it is still not a dependency of
the package.

**What is deliberately not pinned.** `screenshots.mjs` pauses every animation
and zeroes every transition, because a still of a moving thing is a coin flip;
a tour of a moving thing is the point of a tour. The clock stays pinned to the
same instant every screenshot is taken at, so the ages and the history stamps
agree with the stills on this page — but the drawer slides, the waiting ring
pulses, and the browser is launched without the compositor flags that exist to
make two captures byte-identical, which here would only cap the frame rate.
Two runs of `npm run tour` are therefore *not* byte-identical, and there is no
`--check` for them.

**And the same promise as the stills.** `?demo=1`, `--no-task-text`, and on top
of both the rendered document is searched before every beat for a home
directory, a user name, a `C:\Users` or a `/home/` — a hit fails the run rather
than being encoded into a file that goes in a README.

Options are `--out <dir>`, `--no-build`, `--chrome <path>`, `--port <n>` and
`--keep` (which leaves the frames behind and says where), plus `--help`.

## The gallery

Thirty-nine pictures. The five marked **README** are the ones still inline over
there; the rest live here, which is what this page is for.

### The canvas

![The Nazar canvas: five session cards, each with its subagent tree drawn underneath. A green ring reads working, a blue one idle and a dashed grey one unknown; the card waiting on a permission prompt is the only one wearing a colour on its own border, in amber, with the same words repeated on a banner across the top of the page](n-wp15-quiet-cards-dark.png)

`n-wp15-quiet-cards-dark.png` — the quieter card: a neutral frame, the pulse
moved to the ring, working and idle and waiting side by side. **README.**

![The same canvas with the drawer open on the left: a Sessions list naming all five cards with the folder each one runs in, a Folder tabs section saying there are none yet and how to open one, and a View group with arrange, fit and add note](wp4c-overview-dark.png)

`wp4c-overview-dark.png` — sessions with their trees, the tab bar, the waiting
banner, the drawer open.

![The same canvas in light mode: five session cards on a pale ground with their subagent trees, the drawer open on the left and the waiting banner across the top](wp4c-overview-light.png)

`wp4c-overview-light.png` — the same, light.

![The empty canvas: no session on the machine, and a panel in the middle naming which of the three ways of having nothing to draw this one is, with the next step under it](wp4-empty-dark.png)

`wp4-empty-dark.png` — the empty state, and the lines that say why it is empty.

![The hover card open over the first session: the model, the effort level, elapsed time, current tool, tool calls, the four token counters separately, and the folder the session runs in](wp4-hover-dark.png)

`wp4-hover-dark.png` — tokens, context window, the folder.

![Four session cards in four states — working, idle, waiting and unknown — each framed in the colour of its state with the word beside it](wp4d-activity-dark.png)

`wp4d-activity-dark.png` — the four activity states as WP4d shipped them,
framed and labelled. `n-wp15-quiet-cards-dark.png` above draws the same four on
the quieter card; this pair stays as the record of what WP4d looked like.

![The same four activity states in light mode](wp4d-activity-light.png)

`wp4d-activity-light.png` — the same four states, light.

### A Needs you badge in the top bar

![The Needs you badge in the top bar, reading Needs you · 1 and 4m 00s, with its panel open underneath: one row naming the card nazar-tray, the folder it runs in, what it is waiting for — permission prompt — the same 4m 00s, and an arrow that takes you to the card](n-wp21-needs-you-dark.png)

`n-wp21-needs-you-dark.png` — who is waiting for you, for how long, and a way
to jump there. **README.**

### A History panel

![The History panel down the right-hand side: five past sessions grouped under the four project folders they ran in, newest first, with one of them opened on the canvas as a frozen tree of five subagents, each carrying the time it ran for and how many tools it called](wp4b-history-dark.png)

`wp4b-history-dark.png` — past sessions grouped by project, one opened as a
frozen tree. **README.**

### A Codex thread

![A Codex thread on the canvas beside four Claude Code sessions: its card carries the Codex badge, reads pid unknown · thread-e · busy and no subagents, and the hover card open next to it lists the model, the current tool and the exact token counts with the cost and context rows empty](n-wp18-codex-session-dark.png)

`n-wp18-codex-session-dark.png` — its own badge, no pid, no subagents, no cost
or context. **README.**

### Sticky notes

![Three sticky notes in a row on the canvas below the session cards: an olive one reading the long one on the left is the release build — leave it alone until the installer is signed, a green one reading weekly window resets Sunday 04:00, and a red one reading waiting on a permission prompt again: check the sandbox rule before answering, each with its own ⋯ button on its top edge](wp4e-notes-dark.png)

`wp4e-notes-dark.png` — one note per colour that has something to say.
**README.**

![The same three sticky notes on the light canvas](wp4e-notes-light.png)

`wp4e-notes-light.png` — the same three notes, light.

### Themes and colours

![The Sepia theme in its light mode: warm paper behind the canvas, four session cards with their subagent trees, and the sidebar open on Theme with Sepia chosen, the five colour pickers reading 5.9:1, 5.6:1, 4.5:1, 5.5:1 and 5.4:1, and the Usage limits source line reading from nazar-tray](wp4e-themes-sepia.png)

`wp4e-themes-sepia.png` — the Sepia palette in light mode, settings open on
Appearance.

![The Midnight theme in dark mode: a near-black canvas with saturated green, cyan and amber frames on the same four cards, the sidebar open on Theme with Midnight chosen, and the five colour pickers reading 14.4:1, 11.6:1, 7.7:1, 11.9:1 and 9.9:1](wp4e-themes-midnight.png)

`wp4e-themes-midnight.png` — the Midnight palette in dark mode. This is the one
the tour switches to.

![The Nazar theme with two activity colours overridden: working set to orange and idle to violet, both rows highlighted with a live reset link, the button below them reading reset to theme (2 changed), and the cards on the canvas already ringed in the new colours](wp4e-colours-dark.png)

`wp4e-colours-dark.png` — two activity colours overridden, with the cards
already reframed.

### The sidebar and the settings panel

![The settings panel filling the drawer's place, with a back arrow beside the word Settings: an Appearance group with a system, light and dark segment and the four theme buttons, a Colours group with a swatch, a contrast reading and a reset link for each of the five activity colours, and a Behaviour group with switches for auto-create tabs, show task text and demo data](n-wp12-settings-dark.png)

`n-wp12-settings-dark.png` — Appearance, Behaviour, Language, Usage, About, in
the drawer's own place.

![The settings panel scrolled to its Sound group: a switch on for sound when a session ends, one off for sound when a session waits for permission, quiet hours switched on, and under it the two time fields it reveals, from 22:00 to 07:00, then a test the sound button and the line explaining the tick](n-wp16-sound-setting-dark.png)

`n-wp16-sound-setting-dark.png` — an ending, a permission prompt, and quiet
hours.

![The whole canvas drawn in Turkish — Seni bekliyor in the top bar, the waiting banner, çalışıyor and bitti on the cards — with the settings panel open beside it and scrolled to Dil, where the six languages are listed and Türkçe is the one chosen](n-wp13-language-tr-dark.png)

`n-wp13-language-tr-dark.png` — the canvas in Turkish, with the six-language
picker.

### Task text

![The canvas with task text switched on: each of the five session cards carries one extra line in italics under its folder saying what it was last asked to do, and each subagent node carries the three-word label the Agent tool wrote for it. Every sentence in the picture is invented](n-wp15a-task-text-dark.png)

`n-wp15a-task-text-dark.png` — one line per session saying what it was asked to
do. Off by default, and every sentence in it is invented.

### Cards: name, menu, fold, resize, clear, drag

![Five cards on the dark canvas. Two are titled with names their user typed — release build and tray installer — each with the folder it was named after on the line below; a third has an inline text field open over its title with importer rewrite in it; the last two are still titled by their folders, atlas and puantaj](wp4g-rename-dark.png)

`wp4g-rename-dark.png` — cards titled by their user, one with the inline name
field open.

![A card's own menu opened at the pointer over its header, listing Name this card…, a Move to group with the tab All under it, New tab…, an Open a tab for group offering the folders nazar and proj with their paths beside them, and a Tree group with Collapse subagents and Clear finished subagents (2)](n-wp19-card-menu-dark.png)

`n-wp19-card-menu-dark.png` — the canvas's own right-click menu on a card,
rather than the browser's.

![One session card holding sixty subagents: the card has grown down the whole page to fit them, the tree wraps onto row after row of nodes, and every connector between a parent and its children stays inside the card's frame](wp4c-sixty-agents-dark.png)

`wp4c-sixty-agents-dark.png` — the card grows, the tree wraps, connectors stay
inside.

![The same session with its tree folded away: the card is now a few lines tall, and where the tree was there is one row of chips reading 60 subagents, 37 running, 22 done and 1 unknown](wp4c-collapsed-dark.png)

`wp4c-collapsed-dark.png` — the same session folded away: one row of chips
counting the tree.

![Two session cards on the dark canvas. The left one has been pulled in from its right-hand edge, so it is narrower than its neighbour and its sixteen subagents have re-wrapped from five columns into four, making the card taller; small grips are drawn at its corners and along its edges](n-wp10-resize-dark.png)

`n-wp10-resize-dark.png` — all eight resize handles: a card dragged from its
east edge rather than a corner.

![Two session cards on the dark canvas; the left one has been dragged narrower from its bottom-right corner, so its sixteen subagents have re-wrapped from three columns into two and the card has grown taller, with the four corner grips drawn at its corners](wp4f-resize-dark.png)

`wp4f-resize-dark.png` — a card dragged narrower from its corner: the tree
re-wraps, the grips are drawn.

![A session card whose tree now reads subagents · 10 rather than · 16, with a dashed chip on its rule reading 6 finished hidden · show. Every running subagent is still drawn; the one finished agent left in the tree is the one with a child still running under it](wp4f-cleared-dark.png)

`wp4f-cleared-dark.png` — finished subagents hidden, and the chip that brings
them back.

![A session card dragged out of the grid and standing clear of its neighbours, to show that the arrangement belongs to the user](wp4c-dragged-dark.png)

`wp4c-dragged-dark.png` — a card dragged out of the grid, to show the
arrangement is the user's.

### Folder tabs

![The tab bar reading All 5, then two folder tabs with folder icons — nazar 1 and dile 1 — with the nazar tab selected, so the canvas below holds the single card that runs in that folder and nothing else](n-wp11-folder-tab-dark.png)

`n-wp11-folder-tab-dark.png` — a folder tab selected: only the sessions under
that folder.

![The same tab bar with All selected, and the drawer open beside it: a Sessions list with a button on each row to open a tab for its folder, and a Folder tabs section listing nazar as 1 live · 2 past and dile as 1 live · 1 past, each with a button to close it](wp4g-projects-dark.png)

`wp4g-projects-dark.png` — two folder tabs, and the drawer listing each with
its live and past counts.

### Usage limits, cost and context

![The usage-limits panel open under its bead in the top bar: six bead-fills — Claude's five-hour, weekly and two model-scoped weeklies, then Codex's two — each with its percentage, a countdown to its reset, and the older Codex readings drawn faded with their age](wp4e-popover-dark.png)

`wp4e-popover-dark.png` — six windows, every severity, two sources.

![The same usage-limits panel in light mode](wp4e-popover-light.png)

`wp4e-popover-light.png` — the same panel, light.

![The usage-limits bead in the top bar on a machine that has nazar-tray installed, filled to the window closest to being spent](wp5-quota-dark.png)

`wp5-quota-dark.png` — the bead in the top bar on a machine that has
nazar-tray installed.

![The same usage-limits bead in light mode](wp5-quota-light.png)

`wp5-quota-light.png` — the same bead, light.

### The same canvas at three device pixel ratios

The trio that proves the SVG stays crisp when the window is not at 1×. One
viewport, three ratios, both modes.

![The whole canvas, dark, at 1× device pixel ratio](wp4-100-dark.png)

`wp4-100-dark.png` — 1×, dark.

![The whole canvas, light, at 1× device pixel ratio](wp4-100-light.png)

`wp4-100-light.png` — 1×, light.

![The same canvas at 1.5×, where the SVG has to stay crisp](wp4-150-dark.png)

`wp4-150-dark.png` — 1.5×, dark.

![The same canvas at 1.5×, light](wp4-150-light.png)

`wp4-150-light.png` — 1.5×, light.

![The same canvas at 2×](wp4-200-dark.png)

`wp4-200-dark.png` — 2×, dark.

![The same canvas at 2×, light](wp4-200-light.png)

`wp4-200-light.png` — 2×, light.

## Adding one

Add a row to `SCENARIOS` in `scripts/screenshots.mjs`. Reach for a URL
parameter before reaching for `steps`: `packages/ui/web/app.ts` already carries
`sidebar`, `collapse`, `notes`, `projects`, `history`, `session`, `quota`,
`usage`, `sessions`, `agents`, `theme`, `palette` and `lang` *because*
screenshots need them, and a URL cannot go out of step with itself the way a
sequence of clicks can. `steps` exist for the states that have no parameter —
the settings panel, the Needs-you popover, a context menu, a drag, a resize.

Then add it to the gallery above, under the feature it shows, with an alt text
that is a sentence describing the picture rather than a caption — that is the
form every alt text in this project takes, and it is the only copy of the
picture a screen reader gets. A row's `where` field is what `--list` prints, so
it should name the page the picture is actually on.

Keep the file names of the shots that already exist. The README and this page
refer to them by path, and each carries a hand-written alt text, so a rename is
a broken image and a lost sentence.

## Adding a beat to the tour

Add an entry to `BEATS` in `scripts/tour.mjs`. A beat is one of
`screenshots.mjs`'s own step verbs plus `hold`, the pause after it in
milliseconds, and the two verbs a recording needs that a still does not:
`point`, which glides the pointer to an element instead of teleporting it, and
`park`, which glides to a corner where nothing reacts. The sum of the holds
plus the glides is the running time; **keep it between twenty and thirty
seconds**, because the recording is the first thing in the README and a reader
who has to wait for the good part has already scrolled past it.
