/**
 * Liveness probe. "No news" is never treated as running: a session is only
 * alive while its process answers, and a session file left behind by a crash
 * proves nothing.
 */

/**
 * Whether a process id is still alive, via signal-0 semantics on both Windows
 * and POSIX.
 *
 * `EPERM` means the process exists but belongs to somebody else, which counts
 * as alive. Every other failure, `ESRCH` first among them, counts as gone.
 * Signal 0 never reaches the target: it only asks the kernel whether it could.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signature the registry takes so tests can decide liveness themselves. */
export type LivenessProbe = (pid: number) => boolean;
