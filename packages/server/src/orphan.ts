/**
 * Not outliving the thing that started us.
 *
 * The desktop shell starts this server as a child process and navigates its
 * webview at it. When the shell exits normally it kills the child on the way
 * out, and on Windows the child is also in a job object marked kill-on-close,
 * so even a shell that is killed outright takes its server with it.
 *
 * Neither of those covers a shell that dies ungracefully on macOS or Linux, and
 * that is not a rare case: `kill`, a crash, a debugger detaching, a desktop
 * session ending. What was left behind was measured on Fedora 44 — the shell was
 * killed, the node child kept running, and it kept holding the port. The next
 * launch then found its own port busy.
 *
 * `apps/desktop/src/server.rs` answers that from the other side, with
 * `PR_SET_PDEATHSIG` on Linux and a process group on both. This is the portable
 * half of the same answer, and the two are complementary rather than
 * alternatives: the kernel's version is instant and needs no timer but exists
 * only on Linux, and this one is a second late but works anywhere the operating
 * system reparents an orphan — which is every unix.
 *
 * **The signal is the parent's identity changing, not its identity being 1.**
 * When a parent dies, the child is handed to a reaper. The textbook reaper is
 * `init` at pid 1, and the code that looked for pid 1 was written from the
 * textbook; on a systemd machine the reaper is the *user manager*, whose pid is
 * an ordinary four-digit number. Measured on Fedora 44: a child whose parent
 * exited was reparented to pid 3284, not to 1. So the watch remembers who the
 * parent was at startup and fires when it is somebody else, whoever that is.
 *
 * Nothing here is on by default. It costs a timer, and a `nazar` started from a
 * terminal must not exit because that terminal's shell was replaced. The desktop
 * shell asks for it with `--exit-with-parent`, which is a flag on the command
 * line and therefore visible in a process list, the same way `--no-task-text`
 * and `--remote` are.
 */

/** How often the parent is looked at. One second: a stale port is not an emergency. */
export const PARENT_POLL_MS = 1000;

/** A watch in progress. */
export interface ParentWatch {
  /** Stop looking. Idempotent. */
  readonly stop: () => void;
  /** Whether a timer is running. For the tests, and for nothing else. */
  readonly watching: () => boolean;
}

/** What {@link watchParent} needs. `read` and `every` are injected by the tests. */
export interface ParentWatchOptions {
  /** The parent as it was when this process started. */
  readonly parent: number;
  /** The parent as it is now. `() => process.ppid` in the real program. */
  readonly read: () => number;
  /** Called once, when the parent is gone. */
  readonly onGone: () => void;
  /** Milliseconds between looks. Defaults to {@link PARENT_POLL_MS}. */
  readonly every?: number;
}

/**
 * Whether the parent that started this process has gone.
 *
 * A parent id of 0 or 1 at startup is not a parent this can reason about — a
 * process already owned by the reaper has nothing left to be orphaned from — so
 * such a watch never fires rather than firing immediately.
 */
export function parentIsGone(started: number, current: number): boolean {
  if (!Number.isInteger(started) || started <= 1) return false;
  if (!Number.isInteger(current) || current <= 0) return false;
  return current !== started;
}

/**
 * Watch the parent, and call `onGone` once when it is no longer there.
 *
 * The timer is unreferenced: this watch is never the reason the process stays
 * alive, it only notices when it should not be.
 */
export function watchParent(options: ParentWatchOptions): ParentWatch {
  const { parent, read, onGone, every = PARENT_POLL_MS } = options;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  // Nothing to watch. Said once, here, so the caller can pass `process.ppid`
  // without asking what it is.
  if (!Number.isInteger(parent) || parent <= 1) {
    return { stop, watching: () => false };
  }

  timer = setInterval(() => {
    if (!parentIsGone(parent, read())) return;
    stop();
    onGone();
  }, every);
  timer.unref();

  return { stop, watching: () => timer !== undefined };
}
