/**
 * The one seam between the canvas and the desktop shell.
 *
 * The canvas is served over http by the same Node process `npx @xfurqan0/nazar` runs,
 * whether it is being read in Firefox or inside the Tauri window. **There is one
 * bundle**, and browser mode is not a degraded version of anything: it is the default.
 * So everything the shell adds has to be *detected* rather than assumed, and this module
 * is the only place that does the detecting.
 *
 * Detection is `window.__TAURI__`. The shell sets `withGlobalTauri`, so the global is
 * present exactly when the page is inside it; in a browser it is `undefined` and every
 * method below answers `undefined` rather than throwing. Nothing here imports
 * `@tauri-apps/api` — the canvas has no runtime dependencies and is not about to grow
 * one for a feature most of its users cannot reach.
 *
 * The commands are the shell's own (`apps/desktop/src/main.rs`). They are reachable from
 * this origin because `apps/desktop/capabilities/canvas.json` names the loopback address;
 * that file is where the reasoning about *why* a remote origin gets IPC at all lives.
 */
import { t } from '../src/i18n.ts';

/** What the shell reports about itself. Mirrors `ShellInfo` in `main.rs`. */
export interface ShellInfo {
  readonly shell: boolean;
  readonly version: string;
  readonly platform: string;
  readonly jumpSupported: boolean;
}

/** What rung (b) found. Mirrors `TabOutcome` in `apps/desktop/src/jump.rs`. */
export interface TabOutcome {
  readonly matched: boolean;
  readonly title?: string | null;
  readonly index?: number | null;
  readonly window?: number | null;
  readonly source?: string | null;
  readonly tier?: string | null;
  readonly ambiguous: boolean;
  readonly selected: boolean;
  readonly candidates: number;
  readonly reason?: string | null;
}

/** What a jump did. Mirrors `JumpOutcome` in `apps/desktop/src/jump.rs`. */
export interface JumpOutcome {
  readonly raised: boolean;
  readonly rung: string;
  readonly host?: string;
  readonly depth?: number;
  readonly title?: string;
  readonly tab?: TabOutcome | null;
  readonly message: string;
}

/** The sliver of the injected global this file uses. */
interface TauriGlobal {
  readonly core?: {
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  };
}

declare global {
  interface Window {
    readonly __TAURI__?: TauriGlobal;
  }
}

/**
 * The desktop shell, when the canvas is running inside it.
 *
 * Every method resolves rather than rejects: a command that fails is a shell that could
 * not do the thing, which the canvas reports as a sentence in a hint. It is never a
 * reason for an unhandled rejection in a monitoring tool.
 */
export class Shell {
  private readonly invoke: (
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;

  private constructor(invoke: TauriGlobal['core']) {
    this.invoke = invoke!.invoke.bind(invoke);
  }

  /** The shell hosting this page, or `undefined` in a browser. */
  static detect(host: Window = window): Shell | undefined {
    const core = host.__TAURI__?.core;
    return typeof core?.invoke === 'function' ? new Shell(core) : undefined;
  }

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
    try {
      return (await this.invoke(command, args)) as T;
    } catch {
      return undefined;
    }
  }

  /** What the shell is and what it can do. */
  info(): Promise<ShellInfo | undefined> {
    return this.call<ShellInfo>('shell_info');
  }

  /** Bring the terminal running this process to the front. */
  jump(pid: number): Promise<JumpOutcome | undefined> {
    return this.call<JumpOutcome>('jump_to_session', { pid });
  }

  /** Whether the machine starts Nazar at login. */
  autostart(): Promise<boolean | undefined> {
    return this.call<boolean>('get_autostart');
  }

  /** Turn the startup entry on or off; resolves with what it is now. */
  setAutostart(enabled: boolean): Promise<boolean | undefined> {
    return this.call<boolean>('set_autostart', { enabled });
  }

  /**
   * N-WP15a: is this machine in recording mode — task text hard-disabled?
   *
   * `true` means the child server was started with `--no-task-text`, so no
   * browser talking to it can be shown a task line however its own switch is
   * set. `undefined` means the shell did not answer, which the canvas reads as
   * "not on": the safe direction here is the one that leaves the browser's own
   * switch in charge, and that switch is itself off by default.
   */
  taskTextOff(): Promise<boolean | undefined> {
    return this.call<boolean>('get_task_text_off');
  }

  /**
   * Turn recording mode on or off; resolves with what it is **now**.
   *
   * The shell rewrites `desktop.json` and restarts the child server, so this
   * call takes about as long as a server start and the canvas has to re-open
   * its stream once it resolves. It answers with the state it reached rather
   * than the one it was asked for, so a restart that failed paints the switch
   * back instead of leaving a control that lies.
   */
  setTaskTextOff(off: boolean): Promise<boolean | undefined> {
    return this.call<boolean>('set_task_text_off', { off });
  }

  /**
   * N-WP17a: which `~/.ssh/config` aliases this machine is also reading.
   *
   * `undefined` from a browser, and from a shell too old to answer — both of which the
   * canvas paints as "none", because a machine that cannot say what it is reading is not
   * a machine to claim things about.
   */
  remotes(): Promise<readonly string[] | undefined> {
    return this.call<string[]>('get_remotes');
  }

  /**
   * Replace the list; resolves with the list the machine actually reached.
   *
   * Like {@link setTaskTextOff}, and underneath it is the same mechanism: the hosts are
   * a flag on the child server's command line, so this restarts it and takes about as
   * long as a server start. The answer is validated and de-duplicated, so a field typed
   * loosely — a trailing comma, a repeated host — is repainted with what is actually
   * running rather than with what was typed. A rejected alias resolves `undefined`,
   * which the canvas shows as a hint rather than as a silent revert.
   */
  setRemotes(aliases: readonly string[]): Promise<readonly string[] | undefined> {
    return this.call<string[]>('set_remotes', { aliases: [...aliases] });
  }
}

/** What a browser is told when it double-clicks a card. */
export function jumpNeedsShell(): string {
  return t('hint.jumpNeedsShell');
}

/**
 * What to do about a terminal whose tabs Nazar could not tell apart.
 *
 * The shell matches a tab by its title, and a terminal's title is the session's own
 * generated one. A session that has not been titled yet — a brand new one, or one whose
 * terminal a shell prompt has overwritten — leaves nothing to match on, and `/rename` is
 * the one action that fixes it from where the user is sitting.
 */
export function tabNeedsAName(): string {
  return t('hint.tabNeedsAName');
}

/**
 * The sentence a jump produces, from either mode.
 *
 * One function so the hint reads the same wherever it came from, and so the "no shell"
 * case is a sentence rather than a missing feature nobody explains.
 *
 * The tip is added only when it would help. A terminal with one tab needed no matching, and
 * a terminal that published no tabs at all is not going to publish one because a session
 * was renamed — in both cases the advice would be noise on top of a jump that worked.
 */
export function jumpHint(outcome: JumpOutcome | undefined): string {
  if (outcome === undefined) return t('hint.shellSilent');
  const tab = outcome.tab;
  // `outcome.message` is the shell's own sentence about what it found, built in
  // `apps/desktop/src/jump.rs` from window titles and process names. It stays in
  // English for the same reason a reader's error does: no catalogue can know in
  // advance what a machine will say about its own windows.
  if (!tab || tab.matched || tab.candidates < 2) return outcome.message;
  return `${outcome.message} — ${tabNeedsAName()}`;
}
