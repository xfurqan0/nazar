/**
 * The one place `fs.watch` is called, and the reason nothing depends on it.
 *
 * `fs.watch` is the cheap way to hear that a file moved, but its delivery is
 * not a contract. Node's own documentation opens the section with "the
 * `fs.watch` API is not 100% consistent across platforms, and is unavailable
 * in some situations": Linux uses inotify, Windows `ReadDirectoryChangesW`,
 * and on macOS a *directory* watch goes through FSEvents, which coalesces
 * events and delivers them on its own schedule rather than on the writer's.
 * Establishing the watch can fail outright too — the sessions directory does
 * not exist on a machine that has never run Claude Code, and some network and
 * virtualised filesystems support no watches at all.
 *
 * So Nazar treats a watch as an accelerator and never as the guarantee. Both
 * watchers poll unconditionally at `pollIntervalMs` *and* take the watch when
 * it can be had. The bound is therefore "poll interval + one pass" on every
 * platform, and the typical latency is "debounce + one pass" wherever the
 * watch is timely — which is every platform observed so far, but that is a
 * measurement, not a promise the product rests on.
 *
 * Injecting a `WatchFactory` is what lets the tests assert the watch pipeline
 * — attempted here, dropped on error, event drives a refresh — without asking
 * a real filesystem to be punctual.
 */
import { watch } from 'node:fs';

/**
 * The part of `fs.FSWatcher` the watchers use. Narrow on purpose: a test
 * double is an `EventEmitter` with a `close()`, not a real handle.
 */
export interface DirectoryWatcher {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Builds a watcher for one file or directory. Throws when the target cannot be
 * watched, which callers treat as "the poll covers it" and not as an error.
 */
export type WatchFactory = (target: string, onChange: () => void) => DirectoryWatcher;

/**
 * The real one: `fs.watch`, non-persistent so it never holds the process open,
 * with the event payload dropped. Neither watcher cares *what* changed — both
 * answer by rescanning — and `filename` is not reported on every platform.
 */
export const watchPath: WatchFactory = (target, onChange) =>
  watch(target, { persistent: false }, () => {
    onChange();
  });
