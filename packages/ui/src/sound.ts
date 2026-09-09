/**
 * N-WP16: when a finished session is allowed to make a sound, and what makes it.
 *
 * A monitor that watches agents for you is only useful while you are looking at
 * it, and the whole point of a long agent run is that you are not. So the canvas
 * gets one small voice: a 250 ms tick when a session ends. Everything hard about
 * that is *restraint* — a notification that fires too often is uninstalled long
 * before one that fires too rarely — so the rules live here as a pure function
 * with a table test, rather than as four conditions scattered through `app.ts`.
 *
 * **Five rules, and each one is a burst that has actually happened.**
 *
 * 1. **One sound per session.** The end of a session is a fact about that
 *    session and it happens once, whatever the stream does.
 * 2. **Two seconds of debounce.** Closing four terminals is one gesture; four
 *    ticks would be a machine reporting on itself instead of telling you
 *    something.
 * 3. **Five seconds of silence after the page opens.** The one burst that is
 *    purely an artefact: reconnecting, reloading, or opening the canvas for the
 *    first time must not ring for work that finished while nobody was watching.
 *    The server's own event stream already does most of this — an event is heard
 *    by whoever is listening at the time and is never replayed — and this closes
 *    the remaining gap, which is a session that ends in the same second the page
 *    is loading.
 * 4. **Quiet hours.** Wall-clock local time, nazar-tray's semantics exactly
 *    (`crates/nazar-core/src/config.rs` there): `HH:MM` endpoints, a range that
 *    wraps midnight, equal endpoints meaning *empty* rather than *all day*, and
 *    an unparseable endpoint suppressing **nothing** — the failure mode of a
 *    typo has to be more sound, never silence.
 * 5. **No sound in the demo.** `?demo=1` is what the screenshots are taken with
 *    and what somebody clicks to see the product. Neither should make a noise.
 *
 * **Why this file is not in `web/`.** Everything here is arithmetic and
 * bookkeeping, so it belongs where Node can run it — which includes the audio
 * player, whose four Web Audio calls are behind the small interfaces below
 * rather than behind the DOM lib. A test can therefore hand the player a fake
 * context and assert the thing that actually matters: *with the setting off,
 * nothing is asked to play*. The browser half (`web/sound.ts`) is the twelve
 * lines that build a real `AudioContext` and `fetch` the clip.
 */
import type { StorageLike } from './workspace.js';

/* ------------------------------------------------------------------ *
 * The settings
 * ------------------------------------------------------------------ */

/** Where the sound preferences live. One key, one document, this browser only. */
export const SOUND_KEY = 'nazar.sound.v1';

/** The stored document. Four controls, and one flag that is not a control. */
export interface SoundSettings {
  /**
   * A tick when a session ends. **On by default**, and the only default in this
   * file that is on: it is the feature, and a notification switched off out of
   * the box is a notification nobody discovers.
   */
  readonly onSessionEnd: boolean;
  /**
   * A tick when a session starts waiting for permission. **Off by default.** A
   * permission prompt is answered by looking at the terminal you are already in
   * as often as not, and a machine running several sessions produces these far
   * more often than it produces endings.
   */
  readonly onWaiting: boolean;
  /** Whether {@link SoundSettings.from}–{@link SoundSettings.to} silences it. Off by default. */
  readonly quietHours: boolean;
  /** When quiet starts, `HH:MM` on the local clock. */
  readonly from: string;
  /** When quiet ends, `HH:MM` on the local clock. */
  readonly to: string;
  /**
   * Not a control: whether the one-time line about the browser's autoplay rule
   * has been shown. It is in this document rather than in a key of its own
   * because it is a fact about this feature in this browser, and a second key
   * would be a second thing to forget in a private window.
   */
  readonly hinted: boolean;
}

/** What a browser that has never been asked plays. */
export const DEFAULT_SOUND: SoundSettings = {
  onSessionEnd: true,
  onWaiting: false,
  quietHours: false,
  from: '22:00',
  to: '07:00',
  hinted: false,
};

function boolAt(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function stringAt(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

/**
 * The stored preferences, or {@link DEFAULT_SOUND}.
 *
 * Every failure — a missing key, unparseable JSON, a document of the wrong
 * shape, a storage that threw — reads as the defaults, and is read field by
 * field so a document written by an older build keeps whatever it does carry.
 * Unlike `task-text.ts`, "could not read it" is **not** the same as "off" here:
 * the safe answer there was silence about what a session was doing, and the
 * safe answer here is the product working as it was designed to.
 */
export function readSound(storage: StorageLike | undefined): SoundSettings {
  if (storage === undefined) return DEFAULT_SOUND;
  let raw: string | null;
  try {
    raw = storage.getItem(SOUND_KEY);
  } catch {
    return DEFAULT_SOUND;
  }
  if (raw === null) return DEFAULT_SOUND;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SOUND;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SOUND;
  const source = parsed as Record<string, unknown>;
  return {
    onSessionEnd: boolAt(source, 'onSessionEnd', DEFAULT_SOUND.onSessionEnd),
    onWaiting: boolAt(source, 'onWaiting', DEFAULT_SOUND.onWaiting),
    quietHours: boolAt(source, 'quietHours', DEFAULT_SOUND.quietHours),
    from: stringAt(source, 'from', DEFAULT_SOUND.from),
    to: stringAt(source, 'to', DEFAULT_SOUND.to),
    hinted: boolAt(source, 'hinted', DEFAULT_SOUND.hinted),
  };
}

/** Remember the preferences. A storage that refuses is not worth an error. */
export function writeSound(storage: StorageLike | undefined, settings: SoundSettings): void {
  if (storage === undefined) return;
  try {
    storage.setItem(SOUND_KEY, JSON.stringify({ v: 1, ...settings }));
  } catch {
    // A private window with storage disabled still gets a working canvas; the
    // switches simply go back to their defaults on reload.
  }
}

/* ------------------------------------------------------------------ *
 * Quiet hours
 * ------------------------------------------------------------------ */

/** Minutes in a day. A range endpoint is always below this. */
export const MINUTES_IN_A_DAY = 24 * 60;

/**
 * `HH:MM` as minutes past midnight, or `undefined`.
 *
 * Strict — two digits, a colon, two digits — because the value comes from an
 * `<input type="time">`, which produces exactly that. A lenient parser would
 * have to decide what `7:00` means to somebody who typed it meaning `07:00`,
 * and being wrong about that is being quiet for an hour nobody asked for.
 */
export function parseClock(text: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/**
 * Whether `minutes` past local midnight is inside `from`–`to`.
 *
 * The range wraps midnight when `to` is earlier than `from`, which is the only
 * shape anybody wants: quiet hours are for the night. Equal endpoints are an
 * **empty** range rather than a whole day — somebody who wants no sound at all
 * turns the switch off, and reading `22:00–22:00` as *always* would silence the
 * product by accident.
 */
export function inQuietHours(from: string, to: string, minutes: number): boolean {
  const start = parseClock(from);
  const end = parseClock(to);
  if (start === undefined || end === undefined) return false;
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Minutes past local midnight for an epoch timestamp, on this machine's clock. */
export function minutesOfDay(at: number): number {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/** How long one sound silences the next. */
export const SOUND_DEBOUNCE_MS = 2000;

/** How long the canvas stays silent after it loads. */
export const SOUND_OPENING_SILENCE_MS = 5000;

/** The two things that can ring. */
export type SoundKind = 'ended' | 'waiting';

/** One thing that happened, and to which session. */
export interface SoundEvent {
  readonly kind: SoundKind;
  readonly sessionId: string;
}

/**
 * Why the canvas did or did not make a sound.
 *
 * A named reason rather than a bare boolean because every one of them is a rule
 * somebody will one day be surprised by, and a test that can only assert *no
 * sound* cannot tell "the setting is off" from "it is half past three".
 */
export type SoundReason = 'play' | 'off' | 'demo' | 'repeat' | 'opening' | 'quiet' | 'debounce';

export interface SoundDecision {
  readonly play: boolean;
  readonly reason: SoundReason;
}

/** Everything the verdict is allowed to depend on. No clock of its own, no state. */
export interface SoundGate {
  /** Whether the switch for this kind of event is on. */
  readonly enabled: boolean;
  /** `?demo=1`. The demo canvas is silent whatever the switches say. */
  readonly demo: boolean;
  /** This session has already rung for this kind of event. */
  readonly alreadyPlayed: boolean;
  readonly now: number;
  /** When the canvas loaded. */
  readonly openedAt: number;
  /** When a sound last played, on any session. Absent until one has. */
  readonly lastPlayedAt?: number;
  /** The quiet range, or absent when the switch is off. */
  readonly quiet?: { readonly from: string; readonly to: string };
  /** Minutes past local midnight at {@link SoundGate.now}. */
  readonly localMinutes: number;
  /** Defaults to {@link SOUND_OPENING_SILENCE_MS}. */
  readonly openingSilenceMs?: number;
  /** Defaults to {@link SOUND_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
}

/**
 * Decide one event. Pure, total, and silent whenever it is unsure.
 *
 * The order is the order the reasons are worth reporting in: what the user set
 * beats what the page is, which beats what has already happened, which beats
 * the clock. Nothing here queues: an event that is refused is refused for good,
 * because a notification that arrives when the burst is over is worse than none.
 */
export function soundDecision(gate: SoundGate): SoundDecision {
  if (!gate.enabled) return { play: false, reason: 'off' };
  if (gate.demo) return { play: false, reason: 'demo' };
  if (gate.alreadyPlayed) return { play: false, reason: 'repeat' };

  const openingSilenceMs = gate.openingSilenceMs ?? SOUND_OPENING_SILENCE_MS;
  if (gate.now - gate.openedAt < openingSilenceMs) return { play: false, reason: 'opening' };

  const quiet = gate.quiet;
  if (quiet !== undefined && inQuietHours(quiet.from, quiet.to, gate.localMinutes)) {
    return { play: false, reason: 'quiet' };
  }

  const debounceMs = gate.debounceMs ?? SOUND_DEBOUNCE_MS;
  if (gate.lastPlayedAt !== undefined && gate.now - gate.lastPlayedAt < debounceMs) {
    return { play: false, reason: 'debounce' };
  }

  return { play: true, reason: 'play' };
}

/* ------------------------------------------------------------------ *
 * The bookkeeping around it
 * ------------------------------------------------------------------ */

export interface SoundRulesOptions {
  /** Make the sound. Called only when {@link soundDecision} said to. */
  readonly play: () => void;
  /** The preferences as of now. A function, so moving a switch needs no wiring. */
  readonly settings: () => SoundSettings;
  /** Clock, injected by tests. */
  readonly now: () => number;
  /** When the canvas loaded. Defaults to the first `now()`. */
  readonly openedAt?: number;
  /** Local minutes for a timestamp. Injected by tests so quiet hours have a clock. */
  readonly localMinutes?: (at: number) => number;
  /** `?demo=1`. */
  readonly demo?: boolean;
  readonly openingSilenceMs?: number;
  readonly debounceMs?: number;
}

/**
 * The rules plus the two pieces of state they need: which sessions have rung,
 * and when the last sound was.
 *
 * The played set is per kind as well as per session (`ended:<id>`), so a session
 * that waited for permission and later ended is allowed both. It grows by one
 * short string per session for as long as the page is open, which on the
 * heaviest machine this was written against is a few hundred bytes a day.
 */
export class SoundRules {
  private readonly options: SoundRulesOptions;

  private readonly played = new Set<string>();

  private readonly openedAt: number;

  private lastPlayedAt: number | undefined;

  constructor(options: SoundRulesOptions) {
    this.options = options;
    this.openedAt = options.openedAt ?? options.now();
  }

  /** How many sessions have rung. The test's window onto the played set. */
  get playedCount(): number {
    return this.played.size;
  }

  /**
   * Put one event through the rules, and play it if they allow it.
   *
   * The key is recorded **whatever the verdict**, and that is deliberate: a
   * session's ending is not owed a sound later because it happened during quiet
   * hours. Silence now is silence, not a queue.
   */
  handle(event: SoundEvent): SoundDecision {
    const key = `${event.kind}:${event.sessionId}`;
    const settings = this.options.settings();
    const now = this.options.now();
    const minutes = (this.options.localMinutes ?? minutesOfDay)(now);

    const gate: {
      -readonly [K in keyof SoundGate]: SoundGate[K];
    } = {
      enabled: event.kind === 'ended' ? settings.onSessionEnd : settings.onWaiting,
      demo: this.options.demo === true,
      alreadyPlayed: this.played.has(key),
      now,
      openedAt: this.openedAt,
      localMinutes: minutes,
    };
    if (this.lastPlayedAt !== undefined) gate.lastPlayedAt = this.lastPlayedAt;
    if (settings.quietHours) gate.quiet = { from: settings.from, to: settings.to };
    if (this.options.openingSilenceMs !== undefined) {
      gate.openingSilenceMs = this.options.openingSilenceMs;
    }
    if (this.options.debounceMs !== undefined) gate.debounceMs = this.options.debounceMs;

    const decision = soundDecision(gate);
    this.played.add(key);
    if (!decision.play) return decision;
    this.lastPlayedAt = now;
    this.options.play();
    return decision;
  }

  /**
   * The Test button. Plays regardless of every rule above, which is the point of
   * it: it is a gesture asking *what does it sound like*, not an event, and it
   * is also the one control that reliably unlocks the browser's audio.
   */
  demonstrate(): void {
    this.lastPlayedAt = this.options.now();
    this.options.play();
  }
}

/* ------------------------------------------------------------------ *
 * The waiting transition
 * ------------------------------------------------------------------ */

/** The two fields "is this session waiting for you?" is answered from. */
export interface WaitingSession {
  readonly id: string;
  readonly status: string;
  readonly waitingFor?: string;
}

/**
 * Which sessions in a snapshot are waiting for the user.
 *
 * The same test `web/canvas.ts` draws the banner from, because a sound that
 * disagreed with the banner would be a bug nobody could describe.
 */
export function waitingIds(sessions: readonly WaitingSession[]): Set<string> {
  const out = new Set<string>();
  for (const session of sessions) {
    if (session.status === 'waiting' || session.waitingFor !== undefined) out.add(session.id);
  }
  return out;
}

/**
 * The sessions that have *started* waiting between two frames.
 *
 * A transition rather than a state, so a session that sits waiting for ten
 * minutes rings once. The caller seeds `before` from the first frame it sees and
 * fires nothing for it: on a canvas that opens onto three already-waiting
 * sessions, none of the three just started waiting.
 */
export function newlyWaiting(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): readonly string[] {
  const out: string[] = [];
  for (const id of after) if (!before.has(id)) out.push(id);
  return out;
}

/* ------------------------------------------------------------------ *
 * The player
 * ------------------------------------------------------------------ */

/** Where the tick is served from. `build.mjs` copies `assets/` next to the page. */
export const SOUND_CLIP_URL = 'assets/bead-tick.wav';

/** The one node the player builds. Real `AudioBufferSourceNode` satisfies it. */
export interface SoundSourceNode {
  buffer: unknown;
  connect(destination: unknown): unknown;
  start(): void;
}

/**
 * The sliver of Web Audio the player uses.
 *
 * Written out here rather than taken from the DOM lib because this package is
 * compiled for Node as well as bundled for a browser, and because it is what
 * makes a fake context a plain object in a test. A real `AudioContext` satisfies
 * it structurally; `web/sound.ts` is where one is built.
 */
export interface SoundAudioContext {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<unknown>;
  createBufferSource(): SoundSourceNode;
}

export interface SoundPlayerOptions {
  /** Build the audio context. Called once, on the first gesture, never before. */
  readonly create: () => SoundAudioContext;
  /** Read the clip's bytes. Called once, and only after the context exists. */
  readonly load: () => Promise<ArrayBuffer>;
}

/**
 * The clip, and the browser's rule about when it may be heard.
 *
 * Every browser refuses to start audio on a page the user has not interacted
 * with, and refuses *silently* — an `AudioContext` built before the first click
 * is created suspended and everything played through it goes nowhere. So the
 * context is not built until {@link SoundPlayer.unlock} is called from a real
 * gesture, which is also the moment the clip is fetched and decoded: a page
 * nobody has clicked downloads nothing, and after the first click there is one
 * decoded buffer that every later tick reuses.
 *
 * Nothing here throws. A browser with no `AudioContext` at all, a fetch that
 * 404s, a context the machine closed on sleep: each of them ends as a player
 * that makes no sound, and a canvas that makes no sound is a canvas.
 */
export class SoundPlayer {
  private readonly options: SoundPlayerOptions;

  private context: SoundAudioContext | undefined;

  private clip: unknown;

  private loading: Promise<void> | undefined;

  private broken = false;

  constructor(options: SoundPlayerOptions) {
    this.options = options;
  }

  /** Whether a context exists. False means every {@link SoundPlayer.play} is silent. */
  get unlocked(): boolean {
    return this.context !== undefined;
  }

  /** Whether the clip is decoded and ready. */
  get ready(): boolean {
    return this.clip !== undefined;
  }

  /**
   * Build and resume the context, and start fetching the clip. Idempotent, so it
   * can be the handler for both `pointerdown` and `keydown` without a flag of
   * its own.
   *
   * Resolves `true` when the context is running, which is the answer to *may
   * this page make a sound now*.
   */
  async unlock(): Promise<boolean> {
    if (this.context === undefined) {
      try {
        this.context = this.options.create();
      } catch {
        this.broken = true;
        return false;
      }
    }
    try {
      await this.context.resume();
    } catch {
      // Some browsers reject `resume()` outside a gesture and still run. The
      // state below is the answer, not this promise.
    }
    void this.load();
    return this.context.state !== 'suspended';
  }

  /**
   * Play the tick.
   *
   * `false` means nothing was started and nothing was queued — there is no
   * context yet, or the clip could not be had. A tick that arrives in the
   * seconds before the fetch lands is started when it lands rather than dropped:
   * the delay is a few milliseconds from a local file, and it happens at most
   * once per page.
   */
  play(): boolean {
    const context = this.context;
    if (context === undefined) return false;
    if (this.clip !== undefined) {
      this.start(context, this.clip);
      return true;
    }
    if (this.broken) return false;
    void this.load().then(() => {
      if (this.clip !== undefined) this.start(context, this.clip);
    });
    return true;
  }

  private load(): Promise<void> {
    if (this.loading !== undefined) return this.loading;
    if (this.context === undefined) return Promise.resolve();
    const context = this.context;
    this.loading = this.options
      .load()
      .then((bytes) => context.decodeAudioData(bytes))
      .then((clip) => {
        this.clip = clip;
      })
      .catch(() => {
        this.broken = true;
      });
    return this.loading;
  }

  private start(context: SoundAudioContext, clip: unknown): void {
    try {
      const source = context.createBufferSource();
      source.buffer = clip;
      source.connect(context.destination);
      source.start();
    } catch {
      // A context the machine closed under us on sleep. The next gesture builds
      // nothing new — but nothing is broken either, and silence is the failure.
    }
  }
}
