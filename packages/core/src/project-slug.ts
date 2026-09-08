/**
 * Claude Code stores a session's transcripts under `~/.claude/projects/<slug>`,
 * where the slug is derived from the session's working directory. The rule is
 * not documented, so it was recovered twice on the maintainer's machine under
 * Claude Code 2.1.263:
 *
 * 1. Empirically: every one of the 68 directories under `~/.claude/projects`
 *    was matched against the `cwd` recorded inside its own transcripts.
 *    68 of 68 reproduced exactly with the rule below, none needed an exception.
 * 2. From the shipped binary, which carries the transform verbatim:
 *
 *        var QK = 200;
 *        function Te(e){ return Math.abs(f4(e)).toString(36) }
 *        function k(e){ return e.replace(/[^a-zA-Z0-9]/g, "-") }
 *        function kA(e){ let n = k(e); if (n.length <= QK) return n;
 *                        return `${n.slice(0, QK)}-${Te(e)}` }
 *        function f4(t){ let e = 0;
 *                        for (let r = 0; r < t.length; r++)
 *                          e = (e << 5) - e + t.charCodeAt(r) | 0;
 *                        return e }
 *
 * Two details follow from that source and are easy to get wrong:
 *
 * - The regex has no `u` flag, so it replaces **UTF-16 code units**, not code
 *   points. A BMP character such as `ö` becomes one dash; an astral character
 *   such as an emoji is a surrogate pair and becomes **two**.
 * - Past 200 characters the slug is truncated and a hash suffix is appended,
 *   and that hash is taken over the **original path**, not over the sanitized
 *   string.
 */

/** Length at which Claude Code truncates the slug and appends a hash. */
export const PROJECT_SLUG_MAX_LENGTH = 200;

/**
 * Claude Code's 32-bit string hash (`h = h * 31 + c`, wrapped to a signed
 * 32-bit integer on every step). Only used for paths past the length limit.
 */
export function projectSlugHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * The `~/.claude/projects` directory name for a working directory.
 *
 * `platform` is load-bearing in exactly one place. Claude Code slugs the string
 * `process.cwd()` returned, which on Windows always uses backslashes; a caller
 * holding the same directory with forward slashes must land on the same
 * directory. For slugs under the length limit that is free, because `/` and `\`
 * are both non-alphanumeric and both become `-`. Past the limit the hash is
 * taken over the raw path, so on `win32` forward slashes are folded to
 * backslashes first. On a POSIX platform a backslash is a legal file name
 * character and is left exactly where it is.
 */
export function projectSlugFor(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const source = platform === 'win32' ? cwd.replace(/\//g, '\\') : cwd;
  const sanitized = source.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= PROJECT_SLUG_MAX_LENGTH) return sanitized;
  const suffix = Math.abs(projectSlugHash(source)).toString(36);
  return `${sanitized.slice(0, PROJECT_SLUG_MAX_LENGTH)}-${suffix}`;
}

/** Whether a working directory is long enough to get the truncated form. */
export function projectSlugIsTruncated(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const source = platform === 'win32' ? cwd.replace(/\//g, '\\') : cwd;
  return source.replace(/[^a-zA-Z0-9]/g, '-').length > PROJECT_SLUG_MAX_LENGTH;
}

/**
 * A label for a project directory, given only its slug.
 *
 * History reaches a project through the directory name and nothing else: a
 * transcript's `cwd` is on the never-extracted list, so the slug is all there
 * is. The slug is lossy in one direction and revealing in another — every
 * separator became a dash, and on 52 of the 68 directories on the maintainer's
 * machine the second segment is the account name.
 *
 * So the only transform applied is the one that matters: the home directory's
 * own slug is collapsed to `~`, exactly as `redact()` collapses a real path.
 * Nothing else is guessed back — a dash could have been a separator, a space or
 * a dot, and inventing slashes would produce a path that never existed.
 */
export function projectDisplayFor(
  slug: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const homeSlug = projectSlugFor(home, platform);
  if (homeSlug.length === 0) return slug;
  if (slug === homeSlug) return '~';
  if (slug.startsWith(`${homeSlug}-`)) return `~/${slug.slice(homeSlug.length + 1)}`;
  return slug;
}
