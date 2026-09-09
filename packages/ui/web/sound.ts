/**
 * N-WP16: the browser half of the sound — twelve lines of Web Audio, and the
 * gesture that is allowed to start it.
 *
 * Everything that can be reasoned about is in `../src/sound.ts`: the rules, the
 * settings, the decoded-clip cache, the failure paths. What is left here is the
 * part that can only exist in a browser — building an `AudioContext` and
 * fetching a file — and the one browser rule that shapes the whole feature:
 *
 * **Audio may not start on a page nobody has touched.** Every engine enforces
 * it, and enforces it *silently*: a context built at load time comes up
 * `suspended` and everything played through it goes nowhere, with no error and
 * no warning. So nothing is built until the first `pointerdown` or `keydown`,
 * both listened for in the capture phase so a press something else stops still
 * counts as the gesture it was. Until then the canvas is simply silent, and
 * `app.ts` says so once.
 *
 * The clip is served from the canvas's own origin, which is what `connect-src
 * 'self'` in the server's Content-Security-Policy allows and the whole of what
 * this page is allowed to ask the network for.
 */
import { SOUND_CLIP_URL, SoundPlayer } from '../src/sound.ts';

/** The events that count as *the user is here*. Capture phase, so nothing eats them. */
const GESTURES = ['pointerdown', 'keydown'] as const;

/**
 * A player wired to this browser.
 *
 * Neither closure runs until {@link SoundPlayer.unlock} is called, so a page
 * that is never clicked builds no audio graph and fetches no clip.
 */
export function createSoundPlayer(): SoundPlayer {
  return new SoundPlayer({
    create: () => new AudioContext(),
    load: () =>
      fetch(SOUND_CLIP_URL).then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.arrayBuffer();
      }),
  });
}

/**
 * Unlock the player on the first gesture anywhere in the window.
 *
 * The listeners take themselves off before unlocking, so the audio graph is
 * built once however many presses arrive together; `unlock()` is idempotent
 * anyway, which is what makes that safe rather than merely tidy.
 */
export function armSoundUnlock(player: SoundPlayer): void {
  const unlock = (): void => {
    for (const name of GESTURES) window.removeEventListener(name, unlock, true);
    void player.unlock();
  };
  for (const name of GESTURES) window.addEventListener(name, unlock, true);
}
