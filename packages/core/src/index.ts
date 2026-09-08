/**
 * Nazar core: watchers, parsers and state.
 *
 * WP1 ships the session registry; WP2 adds the subagent tree, the incremental
 * transcript tailer and the deduplicated token totals; WP4 joins the two into
 * the single snapshot the canvas draws.
 */

/** Package version, kept in step with the root package version by hand. */
export const version = '0.1.0';

export {
  AGENT_FILE_PREFIX,
  AGENT_META_SUFFIX,
  AGENT_TRANSCRIPT_SUFFIX,
  CLAUDE_AGENT_META_FILE,
  CLAUDE_AGENT_TRANSCRIPT,
  CLAUDE_PROJECT_DIR,
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SESSION_FILE,
  CLAUDE_SESSION_KEY_FILE,
  CLAUDE_SESSION_TRANSCRIPT,
  CLAUDE_SESSIONS_DIR,
  CLAUDE_SUBAGENTS_DIR,
  CLAUDE_WORKFLOW_RUN_DIR,
  NAZAR_CAPTURE_FILE,
  NAZAR_CHAIN_FILE,
  NAZAR_HOME_DIR,
  NAZAR_LIMITS_FILE,
  NAZAR_STATUSLINE_DIR,
  agentIdFromMetaFileName,
  agentIdFromTranscriptFileName,
  claudeConfigDir,
  nazarHomeDir,
  nazarLimitsPath,
  projectsDirPath,
  resolveClaudePath,
  sessionTranscriptPaths,
  sessionsDirPath,
  statuslineCapturesDir,
} from './paths.js';
export type { SessionTranscriptPaths } from './paths.js';

export {
  PROJECT_SLUG_MAX_LENGTH,
  projectDisplayFor,
  projectSlugFor,
  projectSlugHash,
  projectSlugIsTruncated,
} from './project-slug.js';

export { KNOWN_SESSION_STATUS, KNOWN_WAITING_FOR, providers, toSessionStatus } from './types.js';
export type {
  Agent,
  AgentNode,
  CaptureBlockReason,
  History,
  HistorySummary,
  KnownSessionStatus,
  KnownWaitingFor,
  Provider,
  Session,
  SessionChange,
  SessionContextWindow,
  SessionSource,
  SessionState,
  SessionStatus,
  SessionTokens,
} from './types.js';

/* WP3'/WP5: the two optional sources under `~/.nazar`. */

export {
  CAPTURE_SCHEMA_VERSION,
  MAX_CAPTURE_STRING,
  StatuslineCaptures,
  captureAgeSource,
  newestCapture,
  parseStatuslineCapture,
  readCapturesDir,
  readResetsAt,
} from './statusline-captures.js';
export type {
  CaptureContextWindow,
  CaptureRateLimits,
  CaptureRateWindow,
  CaptureScan,
  StatuslineCapture,
  StatuslineCapturesEvents,
  StatuslineCapturesOptions,
} from './statusline-captures.js';

export {
  LIMITS_SCHEMA_VERSION,
  LimitsWatcher,
  bindingWindow,
  parseLimitsDocument,
  readLimitsFile,
  readStamp,
} from './limits-file.js';
export type {
  LimitsDocument,
  LimitsProvider,
  LimitsScan,
  LimitsWatcherEvents,
  LimitsWatcherOptions,
  LimitsWindow,
} from './limits-file.js';

/* WP4f: why a session on a wrapper-equipped machine still has no capture. */

export {
  CAPTURE_GRACE_MS,
  CLAUDE_PROJECT_SETTINGS,
  CLAUDE_PROJECT_SETTINGS_LOCAL,
  CLAUDE_USER_SETTINGS,
  DEFAULT_PROBE_TTL_MS,
  MAX_COMMAND_LENGTH,
  MAX_SETTINGS_ANCESTORS,
  PROJECT_SETTINGS_FILES,
  ProjectStatusLineProbe,
  WRAPPER_BACKUP_PREFIX,
  WRAPPER_COMMAND,
  hasUnquotedBackslash,
  overridesIn,
  readProjectStatusLines,
  readProjectStatusLinesUpward,
  readUserStatusLine,
  statusLineOf,
} from './project-settings.js';
export type {
  ProjectStatusLine,
  ProjectStatusLineProbeOptions,
  UpwardOptions,
  UserStatusLine,
} from './project-settings.js';

export { quotaFromCapture, selectQuota, windowCount } from './quota.js';
export type { Quota, QuotaProvider, QuotaSource, QuotaWindow } from './quota.js';

export { isPidAlive } from './liveness.js';
export type { LivenessProbe } from './liveness.js';

export {
  DEFAULT_AGENTS_ARGS,
  DEFAULT_AGENTS_COMMAND,
  DEFAULT_AGENTS_TIMEOUT_MS,
  createClaudeAgentsRunner,
  parseAgentsOutput,
} from './claude-agents.js';
export type {
  AgentsEntry,
  AgentsRunResult,
  AgentsRunner,
  AgentsRunnerOptions,
} from './claude-agents.js';

export {
  isSessionFileName,
  parseSessionFile,
  pidFromSessionFileName,
  readSessionsDir,
} from './session-file.js';
export type { SessionFileEntry, SessionFileScan } from './session-file.js';

export { watchPath } from './fs-watch.js';
export type { DirectoryWatcher, WatchFactory } from './fs-watch.js';

export { SessionRegistry } from './session-registry.js';
export type { SessionRegistryEvents, SessionRegistryOptions } from './session-registry.js';

export { TranscriptTailer } from './transcript-tailer.js';
export type { TailerReadResult, TranscriptTailerOptions } from './transcript-tailer.js';

export {
  MAX_EXTRACTED_STRING,
  READ_LINE_TYPES,
  extractTranscriptLine,
  extractTranscriptRecord,
} from './transcript-extract.js';
export type {
  ExtractedToolUseResult,
  ExtractedUsage,
  ReadLineType,
  TranscriptEvent,
} from './transcript-extract.js';

export { TranscriptStats, addTotals } from './transcript-stats.js';
export type { AgentBridge, TokenTotals } from './transcript-stats.js';

export { MAX_DESCRIPTION_LENGTH, parseAgentMeta, readSubagentsDir } from './subagent-meta.js';
export type {
  AgentMeta,
  AgentTranscriptFile,
  SubagentsScan,
  WorkflowRun,
} from './subagent-meta.js';

export {
  DEFAULT_RUNNING_WINDOW_MS,
  DONE_QUIET_MS,
  agentDoneState,
} from './agent-done.js';
export type { AgentDoneInput, AgentDoneSignal, AgentDoneVerdict } from './agent-done.js';

export { buildAgentTree, walkAgentTree } from './agent-tree.js';
export type { AgentActivity, AgentTree, BuildAgentTreeOptions } from './agent-tree.js';

export {
  DEFAULT_CACHE_LIMIT,
  DEFAULT_CONCURRENCY,
  DEFAULT_INDEX_TTL_MS,
  DEFAULT_PAGE_SIZE,
  HistoryScanner,
  MAX_PAGE_SIZE,
} from './history.js';
export type {
  HistoryListOptions,
  HistoryListPage,
  HistoryScannerOptions,
  HistoryScannerStats,
} from './history.js';

export { SessionTreeWatcher } from './session-tree.js';
export type {
  SessionTreeEvents,
  SessionTreeOptions,
  SessionTreeSnapshot,
} from './session-tree.js';

export { DEFAULT_COALESCE_MS, NazarState } from './state.js';
export type {
  NazarStateEvents,
  NazarStateOptions,
  SessionView,
  StateSnapshot,
  StateTreeOptions,
} from './state.js';
