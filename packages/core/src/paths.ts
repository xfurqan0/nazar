/**
 * Every path Nazar reads inside Claude Code's configuration directory is
 * declared here as a template string rooted at the home-relative form.
 *
 * `test/pinned-paths.test.ts` greps this package's sources for those literals
 * and fails when one of them is missing from `docs/pinned-internal-formats.md`:
 * code that reads an unlisted path breaks the test. Adding a path means adding
 * a row to that table first.
 */
import os from 'node:os';
import path from 'node:path';

/** Directory Claude Code keeps one JSON file per live session in. */
export const CLAUDE_SESSIONS_DIR = '~/.claude/sessions';

/** One live session, named after its process id. The only file WP1 opens. */
export const CLAUDE_SESSION_FILE = '~/.claude/sessions/<pid>.json';

/**
 * Credential material sitting next to the session files. Nazar never opens it;
 * the reader accepts `<digits>.json` and nothing else, and a test asserts it.
 */
export const CLAUDE_SESSION_KEY_FILE = '~/.claude/sessions/<pid>.<hash>.key';

/** Root of the per-project transcript store. */
export const CLAUDE_PROJECTS_DIR = '~/.claude/projects';

/** Per-project directory whose name is the slug `projectSlugFor()` reproduces. */
export const CLAUDE_PROJECT_DIR = '~/.claude/projects/<slug>';

/** A session's own transcript. Append-only; WP2 tails it by byte offset. */
export const CLAUDE_SESSION_TRANSCRIPT = '~/.claude/projects/<slug>/<session>.jsonl';

/** Side-car directory a session gets once it spawns its first subagent. */
export const CLAUDE_SUBAGENTS_DIR = '~/.claude/projects/<slug>/<session>/subagents';

/** One subagent's tree metadata: type, model, parent, depth, tool-use id. */
export const CLAUDE_AGENT_META_FILE =
  '~/.claude/projects/<slug>/<session>/subagents/agent-*.meta.json';

/** One subagent's transcript, tailed exactly like the session's own. */
export const CLAUDE_AGENT_TRANSCRIPT = '~/.claude/projects/<slug>/<session>/subagents/agent-*.jsonl';

/** Workflow runs group their agents under a run id. Listed, never opened blind. */
export const CLAUDE_WORKFLOW_RUN_DIR =
  '~/.claude/projects/<slug>/<session>/subagents/workflows/<runId>';

/**
 * Root of Claude Code's configuration. `CLAUDE_CONFIG_DIR` overrides it (the
 * variable is honoured by Claude Code 2.1.263 and must be absolute); otherwise
 * it is `<home>/.claude`.
 */
export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return path.join(home, '.claude');
}

/**
 * Turn one of the literals above into a real path. Templates carrying a
 * placeholder (`<pid>`, `<slug>`, `<hash>`) describe a file name pattern rather
 * than a directory and cannot be resolved.
 */
export function resolveClaudePath(
  literal: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const prefix = '~/.claude/';
  if (!literal.startsWith(prefix)) {
    throw new Error(`not a Claude Code path literal: ${literal}`);
  }
  const rest = literal.slice(prefix.length);
  if (rest.includes('<') || rest.includes('*')) {
    throw new Error(`path literal is a pattern, not a directory: ${literal}`);
  }
  return path.join(claudeConfigDir(env, home), ...rest.split('/'));
}

/** Absolute path of the sessions registry directory on this machine. */
export function sessionsDirPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return resolveClaudePath(CLAUDE_SESSIONS_DIR, env, home);
}

/** Absolute path of the per-project transcript store on this machine. */
export function projectsDirPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return resolveClaudePath(CLAUDE_PROJECTS_DIR, env, home);
}

/**
 * The four places one session's data lives, given the project directory that
 * holds it. Kept together because every WP2 reader needs the same set, and
 * because deriving them in one place keeps the pinned-path grep meaningful.
 */
export interface SessionTranscriptPaths {
  /** `<projectDir>/<sessionId>.jsonl`. */
  readonly transcript: string;
  /** `<projectDir>/<sessionId>`, the side-car directory. */
  readonly sessionDir: string;
  /** `<projectDir>/<sessionId>/subagents`. */
  readonly subagentsDir: string;
  /** `<projectDir>/<sessionId>/subagents/workflows`. */
  readonly workflowsDir: string;
}

export function sessionTranscriptPaths(
  projectDir: string,
  sessionId: string,
): SessionTranscriptPaths {
  const sessionDir = path.join(projectDir, sessionId);
  const subagentsDir = path.join(sessionDir, 'subagents');
  return {
    transcript: path.join(projectDir, `${sessionId}.jsonl`),
    sessionDir,
    subagentsDir,
    workflowsDir: path.join(subagentsDir, 'workflows'),
  };
}

/** `agent-<id>.jsonl` / `agent-<id>.meta.json` naming, in one place. */
export const AGENT_FILE_PREFIX = 'agent-';
export const AGENT_META_SUFFIX = '.meta.json';
export const AGENT_TRANSCRIPT_SUFFIX = '.jsonl';

/** The agent id a `agent-*.meta.json` name encodes, or `undefined`. */
export function agentIdFromMetaFileName(name: string): string | undefined {
  if (!name.startsWith(AGENT_FILE_PREFIX) || !name.endsWith(AGENT_META_SUFFIX)) return undefined;
  const id = name.slice(AGENT_FILE_PREFIX.length, name.length - AGENT_META_SUFFIX.length);
  return id.length > 0 ? id : undefined;
}

/** The agent id a `agent-*.jsonl` name encodes, or `undefined`. */
export function agentIdFromTranscriptFileName(name: string): string | undefined {
  if (!name.startsWith(AGENT_FILE_PREFIX) || !name.endsWith(AGENT_TRANSCRIPT_SUFFIX)) {
    return undefined;
  }
  if (name.endsWith(AGENT_META_SUFFIX)) return undefined;
  const id = name.slice(AGENT_FILE_PREFIX.length, name.length - AGENT_TRANSCRIPT_SUFFIX.length);
  return id.length > 0 ? id : undefined;
}

/* ------------------------------------------------------------------ *
 * WP3'/WP5: the two optional sources under `~/.nazar`
 *
 * Neither file belongs to Nazar. `nazar-statusline` (a nazar-tray binary)
 * writes the captures; nazar-tray itself writes `limits.json`. Nazar is a
 * consumer of both and **never writes anything here** — the no-writes gate in
 * `test/no-writes.test.ts` is what makes that a property of the code rather
 * than a promise in a README. Both are absent on a machine that has neither
 * installed, which is the normal case and not an error.
 * ------------------------------------------------------------------ */

/** Directory nazar-tray and its wrapper keep their files in. */
export const NAZAR_HOME_DIR = '~/.nazar';

/** The quota contract nazar-tray writes. Read-only, one writer, many readers. */
export const NAZAR_LIMITS_FILE = '~/.nazar/limits.json';

/** One capture per live Claude Code session, written by `nazar-statusline`. */
export const NAZAR_STATUSLINE_DIR = '~/.nazar/statusline';

/** A single capture. Keyed by session id, never one fixed path. */
export const NAZAR_CAPTURE_FILE = '~/.nazar/statusline/<session_id>.json';

/**
 * Record of the status line that was configured before the wrapper was
 * installed. **Nazar never opens it** — it is listed here so the directory
 * listing can skip it by name rather than trying to parse it as a capture.
 */
export const NAZAR_CHAIN_FILE = '~/.nazar/statusline/chain.json';

/**
 * Root of nazar-tray's directory. `NAZAR_HOME` overrides it — the same
 * variable the wrapper honours, which is how both test suites run without
 * touching the machine they are on — otherwise it is `<home>/.nazar`.
 */
export function nazarHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configured = env['NAZAR_HOME'];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return path.join(home, '.nazar');
}

/** Absolute path of `~/.nazar/limits.json` on this machine. */
export function nazarLimitsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return path.join(nazarHomeDir(env, home), 'limits.json');
}

/** Absolute path of `~/.nazar/statusline` on this machine. */
export function statuslineCapturesDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  return path.join(nazarHomeDir(env, home), 'statusline');
}
