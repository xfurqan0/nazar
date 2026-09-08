/**
 * The last gate before anything reaches the browser.
 *
 * Nazar never reads `tool_input`, so no command line or file body ever gets
 * this far (packages/core/src/transcript-extract.ts is where that is enforced).
 * What does reach the wire is a small set of strings Claude Code wrote about
 * the *shape* of a session: the working directory, the session name a user may
 * have typed, and tool names. Those are still the user's, and a screenshot of
 * the canvas ends up in a bug report, so they are shortened and swept for
 * anything that looks like a credential first.
 *
 * Three rules, in this order:
 *
 * 1. **Mask before truncating.** Truncating first can leave the readable head
 *    of a token on screen; masking first cannot.
 * 2. **Collapse the home directory to `~`.** The user name is the single most
 *    common accidental disclosure in a shared screenshot.
 * 3. **Keep the first 80 characters** (docs/PROJECT.md section 3, Privacy) and
 *    mark the cut with a single ellipsis, so a long path reads as truncated
 *    rather than as a different path.
 */
import os from 'node:os';

/** Characters kept from a path or command before the ellipsis. */
export const REDACTION_HEAD = 80;

/** What a matched secret is replaced with. Fixed width, obviously not a value. */
export const SECRET_MASK = '[redacted]';

/**
 * Patterns that mean "this run of characters is a credential".
 *
 * They are deliberately literal: a generic "long random-looking string" rule
 * eats commit hashes, uuids and agent ids, all of which Nazar shows on purpose.
 * Each entry is a vendor prefix, an assignment to a secret-shaped name, or a
 * structure only a token has.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Vendor-prefixed keys: Anthropic, OpenAI, GitHub, Slack, Stripe, Google.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  // `--token=abc`, `API_KEY: abc`, `--password "abc"`, `?access_token=abc`.
  // The separator may be whitespace, which over-masks a phrase like
  // "password rotation" — the safe direction for a value nobody needs to read.
  // The `[A-Za-z0-9_]*` prefix is what catches `access_token=` and `my_secret:`,
  // where the underscore means there is no word boundary before the keyword.
  /[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|credential|auth)\b(?:\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s&"']+)/gi,
  // `Authorization: Bearer abc` and bare bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // A JWT: three dot-separated base64url runs starting with a JSON header.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // `https://user:pass@host`.
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
];

/**
 * Replace anything credential-shaped with {@link SECRET_MASK}. The URL rule
 * keeps its scheme so the result still reads as a URL.
 */
export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (_match, scheme?: string) =>
      typeof scheme === 'string' ? `${scheme}${SECRET_MASK}@` : SECRET_MASK,
    );
  }
  return out;
}

export interface RedactOptions {
  /** Home directory collapsed to `~`. Defaults to this process's home. */
  readonly home?: string;
  /** Characters kept before the ellipsis. Defaults to {@link REDACTION_HEAD}. */
  readonly head?: number;
}

/** Both separators, so a Windows path is collapsed whichever way it is written. */
function homeVariants(home: string): readonly string[] {
  const trimmed = home.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return [];
  const forward = trimmed.replace(/\\/g, '/');
  const backward = trimmed.replace(/\//g, '\\');
  return forward === backward ? [trimmed] : [backward, forward];
}

/** Replace a leading home directory with `~`, on either separator. */
export function collapseHome(value: string, home: string = os.homedir()): string {
  for (const variant of homeVariants(home)) {
    if (value.length < variant.length) continue;
    if (value.slice(0, variant.length).toLowerCase() !== variant.toLowerCase()) continue;
    const rest = value.slice(variant.length);
    if (rest.length === 0) return '~';
    if (rest.startsWith('/') || rest.startsWith('\\')) return `~${rest}`;
  }
  return value;
}

/**
 * Mask, collapse, then cut to the first {@link REDACTION_HEAD} characters.
 * `undefined` in, `undefined` out, so a caller can pipe an optional field
 * straight through without inventing an empty string for it.
 */
export function redact(value: string, options?: RedactOptions): string;
export function redact(value: undefined, options?: RedactOptions): undefined;
export function redact(value: string | undefined, options?: RedactOptions): string | undefined;
export function redact(value: string | undefined, options: RedactOptions = {}): string | undefined {
  if (value === undefined) return undefined;
  const head = options.head ?? REDACTION_HEAD;
  const masked = collapseHome(redactSecrets(value), options.home ?? os.homedir());
  if (masked.length <= head) return masked;
  return `${masked.slice(0, head)}…`;
}
