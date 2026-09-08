/**
 * WP4g: folders that own a tab.
 *
 * A *project* is a folder path and nothing else. Every session whose working
 * directory is that folder, or lives under it, is drawn on the project's tab —
 * live and in history, without anybody filing anything. The rule is a string
 * comparison, which is the whole design: **nothing here touches the disk.** It
 * cannot, because the canvas is a browser page, and it must not, because a
 * monitoring tool that starts stat-ing directories to decide what to draw has
 * quietly become something else.
 *
 * ## What it compares, and why that is safe
 *
 * `toWireSession` already sends `cwd` — the whole path, through `redact()`:
 * the home directory collapsed to `~`, credential-shaped runs masked, and the
 * result cut to 80 characters. That is not a basename, it is a path, and it is
 * already on the card and already in every screenshot anybody has taken. So a
 * project matcher needs no new field on the wire at all, and this module adds
 * none: it compares the strings the page was already showing.
 *
 * Two consequences are worth stating out loud, because they are the price of
 * that decision and they are documented rather than hidden:
 *
 * - A root is only ever a string the page was already drawing. N-WP11 took the
 *   typed form away for that reason: a folder tab is opened from a session on
 *   screen, so the root *is* that session's `cwd` — or one of its parents — and
 *   the mistake the form invited cannot be made any more. A session under the
 *   home directory reads `~/proj/app` on its card, so its tab is `~/proj/app`;
 *   nobody can type the expanded `/home/you/proj/app` at it, which would never
 *   have matched, because the browser has never been told what `~` stands for
 *   and asking the server to say would undo the one redaction that matters
 *   most. {@link rootProblem} stays for a path that did not come from a card,
 *   which now means a stored or hand-edited one.
 * - A working directory longer than 80 characters arrives truncated with an
 *   ellipsis. Prefix matching still works — truncation keeps the head — so any
 *   project root shorter than the cut still owns it. A root longer than the cut
 *   cannot be built from a card and will match nothing.
 *
 * ## Matching rules
 *
 * Separator-tolerant (`/` and `\` are the same thing) and case-insensitive as
 * soon as **either** side looks like a Windows path, which is what makes a root
 * typed `c:/proj` own a session reported in `C:\proj\app`. Two POSIX paths stay
 * case-sensitive, because there `Proj` and `proj` really are two directories.
 */

/** Longest project root worth storing. A path, not a paragraph. */
export const MAX_ROOT_LENGTH = 200;

/**
 * Does this string look like a Windows path? A drive letter, a UNC prefix, or
 * a backslash anywhere in it. Used to decide case folding, never to decide what
 * the host actually is: the page has no business knowing that.
 */
export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\');
}

/** A path that is rooted somewhere, including the `~` the canvas writes. */
export function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true; // C:\ or C:/
  if (/^\\\\[^\\/]/.test(trimmed)) return true; // \\server\share
  if (trimmed.startsWith('/')) return true; // POSIX
  return trimmed === '~' || /^~[\\/]/.test(trimmed); // the form the canvas shows
}

/**
 * Tidy a path the user typed or the wire sent: no surrounding whitespace, no
 * surrounding quotes (a drag from a file manager brings them), no repeated
 * separators, no trailing separator unless the path *is* a root.
 *
 * The separator style is left exactly as it came in. `C:\proj` stays a Windows
 * path on screen and `~/proj` stays a POSIX-looking one; only {@link pathKey}
 * folds the two together, and only for comparison.
 */
export function cleanPath(value: string): string {
  let out = value.trim();
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      out = out.slice(1, -1).trim();
    }
  }
  // A UNC path opens with exactly two backslashes, so its head is protected
  // from the run-collapsing below and restored afterwards.
  const unc = /^\\\\[^\\/]/.test(out);
  out = out.replace(/[\\/]{2,}/g, (run) => run[0] ?? '/');
  if (unc) out = `\\${out}`;
  // A trailing separator is noise except on a root, where it is the root.
  if (out.length > 1 && /[\\/]$/.test(out) && !/^[A-Za-z]:[\\/]$/.test(out)) {
    out = out.replace(/[\\/]+$/, '');
  }
  return out.slice(0, MAX_ROOT_LENGTH);
}

/**
 * The comparable form of a path: one separator, no trailing separator, and
 * lower case when `windows` says case does not distinguish two directories.
 */
export function pathKey(value: string, windows: boolean): string {
  const unified = cleanPath(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
  return windows ? trimmed.toLowerCase() : trimmed;
}

/** Whether `cwd` is `root` or lives under it. The whole project rule. */
export function pathIsInside(root: string, cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  const windows = isWindowsPath(root) || isWindowsPath(cwd);
  const r = pathKey(root, windows);
  const c = pathKey(cwd, windows);
  if (r.length === 0 || c.length === 0) return false;
  if (c === r) return true;
  return c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** The folder's own name: what a project tab is called before it is renamed. */
export function folderName(value: string): string {
  const cleaned = cleanPath(value);
  if (cleaned.length === 0) return '';
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  const name = cut === -1 ? cleaned : cleaned.slice(cut + 1);
  return name.length === 0 ? cleaned : name;
}

/**
 * N-WP11: what a folder's tab is called, decided rather than asked for.
 *
 * Opening a tab from a session on screen means nobody is at a keyboard when the
 * tab appears, so the name has to be right without a question: it is the
 * folder's own name, which is the word the maintainer used for it in the first
 * place. Renaming afterwards is unchanged and still the way to call it anything
 * else.
 *
 * The one case a basename cannot answer is two folders that end in the same
 * word — `srv\api` and `web\api` — where one tab called `api` and a second tab
 * called `api` is a tab bar nobody can read. Then the parent goes on the end
 * (`api · srv`), and if that still collides the grandparent after it, until the
 * name is either unique or has run out of ancestors; a path with no ancestors
 * left falls back to a number, which is ugly and unambiguous and only reachable
 * on a machine with two identically-named roots.
 *
 * `taken` is every name already on the tab bar, compared case-insensitively —
 * two tabs that differ only in case are two tabs nobody can tell apart.
 */
export function folderTabName(root: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  const free = (name: string): boolean => !used.has(name.trim().toLowerCase());

  const folders = ancestorPaths(root);
  const base = folderName(root);
  if (base.length === 0) return base;

  let candidate = base;
  for (let depth = 1; depth < folders.length; depth += 1) {
    if (free(candidate)) return candidate;
    candidate = `${candidate} · ${folderName(folders[depth] ?? '')}`;
  }
  if (free(candidate)) return candidate;

  for (let n = 2; n < 100; n += 1) {
    const numbered = `${base} ${n}`;
    if (free(numbered)) return numbered;
  }
  return base;
}

/** The part of a path that is its root: `C:\`, `\\server\share`, `/`, or `~`. */
function rootOf(value: string): string {
  const drive = /^[A-Za-z]:[\\/]/.exec(value);
  if (drive !== null) return drive[0];
  const unc = /^\\\\[^\\/]+[\\/][^\\/]+/.exec(value);
  if (unc !== null) return unc[0];
  if (value.startsWith('/')) return '/';
  if (value === '~' || /^~[\\/]/.test(value)) return '~';
  return '';
}

/**
 * Every folder a session's `cwd` could sensibly become a project of, deepest
 * first: `C:\proj\app\src` offers itself, `C:\proj\app` and `C:\proj`.
 *
 * The bare root is left out on purpose. `C:\` or `~` as a project would be a
 * tab that owns every session on the machine, which is what the `All` tab
 * already is; offering it in a dropdown is offering a mistake. A `cwd` that
 * *is* a root is the one exception — then there is nothing else to offer.
 */
export function ancestorPaths(value: string): string[] {
  const cleaned = cleanPath(value);
  if (cleaned.length === 0) return [];
  const root = rootOf(cleaned);
  if (root.length === 0) return [cleaned];
  const rest = cleaned.slice(root.length).replace(/^[\\/]+/, '');
  if (rest.length === 0) return [cleaned];
  const separator = cleaned.includes('\\') ? '\\' : '/';
  const head = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root;
  const segments = rest.split(/[\\/]/).filter((one) => one.length > 0);
  const out: string[] = [];
  for (let take = segments.length; take >= 1; take -= 1) {
    out.push(`${head}${separator}${segments.slice(0, take).join(separator)}`);
  }
  return out;
}

/**
 * The `~/.claude/projects` directory name a folder would produce.
 *
 * History never sees a working directory — a transcript's `cwd` is on the
 * never-extracted list — so a past session is known by its project slug alone,
 * and the only way to say "these belong to my project" is to slug the project
 * root the same way and compare. The rule is Claude Code's own, recovered in
 * `@nazar/core`'s `project-slug.ts`: every non-alphanumeric character becomes a
 * dash. It is restated here rather than imported because that package's entry
 * point reaches `node:fs`, which has no business in a browser bundle; the
 * truncation-and-hash half is left out because it only applies past 200
 * characters, which {@link MAX_ROOT_LENGTH} does not allow a root to reach.
 *
 * The home directory keeps the `~/` head the scanner already gave it.
 */
export function projectSlugish(root: string): string {
  const cleaned = cleanPath(root);
  if (cleaned === '~') return '~';
  if (/^~[\\/]/.test(cleaned)) return `~/${cleaned.slice(2).replace(/[^a-zA-Z0-9]/g, '-')}`;
  return cleaned.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Whether a history group belongs to a project. **Exact slug equality, never a
 * prefix.** A slug turned every separator into a dash and cannot turn them
 * back: `C--proj-nazar-tray` is `C:\proj\nazar-tray` and not a child of
 * `C:\proj\nazar`, and a prefix rule would claim it. So history says only what
 * it can prove — this project's own folder — and a nested project's past
 * sessions stay under their own heading.
 */
export function historyProjectMatches(root: string, project: string): boolean {
  const slug = projectSlugish(root);
  if (slug.length === 0) return false;
  return isWindowsPath(root) ? slug.toLowerCase() === project.toLowerCase() : slug === project;
}

/** Anything with a root: a project tab, or a candidate for one. */
export interface Rooted {
  readonly root: string;
}

/**
 * The project that owns a working directory: the **deepest** one that contains
 * it. `C:\proj` and `C:\proj\app` can both exist, and a session in
 * `C:\proj\app\src` belongs to the second — the more specific answer is always
 * the more useful one, and it is the only rule under which adding a project
 * cannot move sessions off a tab they were already on for a *narrower* reason.
 */
export function deepestMatch<T extends Rooted>(
  projects: readonly T[],
  cwd: string | undefined,
): T | undefined {
  if (cwd === undefined) return undefined;
  let best: T | undefined;
  let depth = -1;
  for (const project of projects) {
    if (!pathIsInside(project.root, cwd)) continue;
    const length = pathKey(project.root, isWindowsPath(project.root)).length;
    if (length > depth) {
      best = project;
      depth = length;
    }
  }
  return best;
}

/** Why a typed path is not a project root, or `undefined` when it is one. */
export function rootProblem(value: string): string | undefined {
  const cleaned = cleanPath(value);
  if (cleaned.length === 0) return 'type a folder path';
  if (!isAbsolutePath(cleaned)) {
    return 'a project is a whole folder path — C:\\proj\\app, /home/you/app, or ~/app';
  }
  if (value.trim().length > MAX_ROOT_LENGTH) return `keep it under ${MAX_ROOT_LENGTH} characters`;
  return undefined;
}
