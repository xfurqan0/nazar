/**
 * Nazar server: static UI, one JSON endpoint, one SSE stream, bound to
 * 127.0.0.1, plus the `nazar` command.
 */
export {
  CliError,
  DEFAULT_PORT,
  TASK_TEXT_VAR,
  USAGE,
  VERSION,
  main,
  parseOpen,
  parsePort,
  parseTaskText,
  serve,
  unknownFlag,
  unknownFlagMessage,
} from './cli.js';
export type { OutputStream, ServeHandle, ServeOptions } from './cli.js';

export { VERSION_HEADER } from './version.js';

export {
  DEFAULT_OPEN_TIMEOUT_MS,
  OPEN_HINT,
  browserOpenChain,
  describeOpenAttempt,
  openInBrowser,
} from './open.js';
export type {
  OpenAttempt,
  OpenChild,
  OpenOptions,
  OpenOutcome,
  OpenSpawn,
  OpenStatus,
} from './open.js';

export { DOCTOR_SAMPLE_BYTES, displayPath, runDoctor } from './doctor.js';
export type { DoctorOptions, DoctorReport } from './doctor.js';

export {
  DEFAULT_HEARTBEAT_MS,
  HOST,
  SSE_RETRY_MS,
  createRequestListener,
  isLocalHost,
  resolveStaticPath,
  startNazarServer,
} from './http.js';
export type { HistorySource, NazarServer, NazarServerOptions, StateSource } from './http.js';

export {
  REDACTION_HEAD,
  SECRET_MASK,
  collapseHome,
  collapseHomeAnywhere,
  redact,
  redactSecrets,
} from './redact.js';
export type { RedactOptions } from './redact.js';

export {
  MAX_WIRE_STRING,
  toWireAgent,
  toWireHistory,
  toWireHistoryPage,
  toWireHistorySummary,
  toWireSession,
  toWireState,
} from './snapshot.js';
export type { WireOptions } from './snapshot.js';

export { WEB_DIR_NAME, resolveUiDir } from './ui-assets.js';
