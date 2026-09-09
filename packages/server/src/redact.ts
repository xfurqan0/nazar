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
 * N-WP15a: the assignment-only form of the keyword rule, for prose.
 *
 * The rule above accepts whitespace as a separator, and that is right for a path
 * or a command line — a value nobody has to be able to *read*, where
 * over-masking costs nothing. It is wrong for a **sentence**, which is a value
 * somebody has to be able to read: *Secret sweep before the flip* and *rotate
 * the auth keys* are both eaten by it, and a task line masked down to
 * `[redacted]` is a feature that looks broken rather than careful.
 *
 * So prose gets this instead: the same keywords, the same values, but an actual
 * `:` or `=` between them. `token=abc` and `API_KEY: hunter2` are still masked;
 * *the token rotation* is not. What is given up is a secret written with a bare
 * space after the word — and every shape a real credential actually arrives in
 * (`sk-ant-…`, `ghp_…`, a JWT, a bearer, a URL with a password in it) has its
 * own literal pattern above and is caught whatever separates it from anything.
 */
const PROSE_ASSIGNMENT =
  /[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|credential|auth)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&"']+)/gi;

/**
 * Which entry of {@link SECRET_PATTERNS} is the loose keyword rule.
 *
 * Found rather than written down, so adding a vendor prefix above cannot
 * silently point this at the wrong rule and quietly stop masking assignments in
 * every task line on the canvas.
 */
const KEYWORD_PATTERN_INDEX = SECRET_PATTERNS.findIndex((pattern) =>
  pattern.source.includes('passwd'),
);

/** The keyword rule a value of this kind should be swept with. */
function patternsFor(prose: boolean): readonly RegExp[] {
  if (!prose) return SECRET_PATTERNS;
  return SECRET_PATTERNS.map((pattern, index) =>
    index === KEYWORD_PATTERN_INDEX ? PROSE_ASSIGNMENT : pattern,
  );
}

/**
 * Replace anything credential-shaped with {@link SECRET_MASK}. The URL rule
 * keeps its scheme so the result still reads as a URL.
 *
 * `prose` swaps the one rule that is a heuristic rather than a literal; see
 * {@link PROSE_ASSIGNMENT} for what that gives up and what it does not.
 */
export function redactSecrets(value: string, prose = false): string {
  let out = value;
  for (const pattern of patternsFor(prose)) {
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
  /**
   * N-WP15a: this value is a **sentence somebody typed**, not a path.
   *
   * Two things change, and they change in opposite directions:
   *
   * - the keyword sweep gets stricter about what it calls a secret
   *   ({@link PROSE_ASSIGNMENT}), because a masked sentence is unreadable and
   *   an unreadable task line is a broken feature rather than a careful one;
   * - the home directory is collapsed **anywhere** in the string rather than
   *   only at the front, because a path in a sentence is in the middle of it —
   *   and the account name is the single most common accidental disclosure in
   *   a shared screenshot, which is exactly what a canvas becomes.
   */
  readonly prose?: boolean;
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
 * N-WP15a: the same collapse, but **wherever** the home directory appears.
 *
 * `collapseHome` above answers the question a `cwd` raises — *does this value
 * start with the home directory* — and that is the right question for a value
 * that is entirely a path. A sentence is not: "look at C:/Users/example/proj
 * again" carries the account name in the middle of it, and one screenshot of a
 * canvas is all it takes for that to be the disclosure the whole redaction
 * module exists to prevent.
 *
 * Case-insensitively, because Windows paths are, and on both separators,
 * because a person types whichever one they are looking at.
 */
export function collapseHomeAnywhere(value: string, home: string = os.homedir()): string {
  let out = value;
  for (const variant of homeVariants(home)) {
    if (variant.length === 0) continue;
    const lowered = variant.toLowerCase();
    for (;;) {
      const at = out.toLowerCase().indexOf(lowered);
      if (at === -1) break;
      out = `${out.slice(0, at)}~${out.slice(at + variant.length)}`;
    }
  }
  return out;
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
  const prose = options.prose === true;
  const home = options.home ?? os.homedir();
  const swept = redactSecrets(value, prose);
  const masked = prose ? collapseHomeAnywhere(swept, home) : collapseHome(swept, home);
  if (masked.length <= head) return masked;
  return `${masked.slice(0, head)}…`;
}
