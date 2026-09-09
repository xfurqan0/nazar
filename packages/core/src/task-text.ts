/**
 * N-WP15a: the one string Nazar reads on purpose, and never by default.
 *
 * Everything else in this package is metadata. `transcript-extract.ts` is built
 * so that no prose *can* leave a transcript line: the reader rebuilds a new
 * object from a closed list of fields and lets the text fall on the floor with
 * the parse result. That is still the rule, and this file does not weaken it.
 *
 * What it adds is a second, **opt-in** reader for exactly one question a person
 * looking at a canvas of forty cards actually has: *which of these is the one I
 * asked to do the thing?* Answering it needs one line — the task — and nothing
 * else. So:
 *
 * - The extractor here is only ever called when a caller asks for it
 *   ({@link ExtractOptions.taskText}), and nothing in this package asks for it
 *   on its own. With the flag off the code path below never runs at all, which
 *   is why `nazar --no-task-text` is a *hard* switch and not a filter.
 * - What it reads is the **human turn**, not the model's: a `type: "user"`
 *   line's own text. The assistant's prose, its thinking, tool inputs and tool
 *   results are all still unreachable, from here as from anywhere else.
 * - What it returns is one cleaned line of at most {@link MAX_TASK_TEXT}
 *   characters. It is never written to disk (`test/no-writes.test.ts` is the
 *   static gate), never logged, and never put in a fixture.
 *
 * ## What is thrown away, and why each one matters
 *
 * A `user` line is not the same thing as "something a person typed". Claude
 * Code writes four other shapes into that slot, and every one of them would be
 * a worse answer than no answer:
 *
 * - **`tool_result` blocks.** The overwhelming majority of `user` lines are a
 *   tool's output being handed back to the model. Showing those would turn the
 *   line into a rolling window of file contents and command output — the exact
 *   thing this product exists not to do.
 * - **`<system-reminder>` blocks.** Injected by the harness, never typed by
 *   anyone, and long. They are also the one piece of a user line that can carry
 *   instructions, so treating them as the task would be reading an untrusted
 *   string and calling it the user's.
 * - **`<command-name>`, `<command-message>`, `<command-args>` and the
 *   `<local-command-stdout>` / `<local-command-stderr>` wrappers.** A slash
 *   command's own bookkeeping. `/compact` is not a task.
 * - **`[Request interrupted by user]` markers.** Written where a turn was, and
 *   the one thing that is certainly not what the session is doing now.
 *
 * If nothing is left after all that, the answer is `undefined` — no line on the
 * card — rather than an empty string. A card that shows a blank row is a card
 * that has learned a fourth state nobody asked for.
 */

/**
 * Longest task text that leaves this module.
 *
 * Long enough for a real brief's first sentences and short enough that a card
 * cannot become a document. The cut is marked, so a truncated task reads as
 * truncated rather than as a task that happened to end oddly.
 */
export const MAX_TASK_TEXT = 300;

/** What the extractor is asked for. Absent and `false` both mean "nothing". */
export interface ExtractOptions {
  /**
   * Read the human turn's text out of a `user` line.
   *
   * Off by default and off everywhere the caller has not said otherwise, which
   * is what makes the CLI's `--no-task-text` a switch on a code path rather
   * than a filter over its output.
   */
  readonly taskText?: boolean;
}

/**
 * Is this code point a line break, in anybody's reckoning?
 *
 * Tab, the two ASCII breaks, vertical tab and form feed, plus NEL and the two
 * Unicode separators. All of them become a single space: the card has one line
 * and a task that arrived as a bulleted list has to read as a sentence on it.
 *
 * Written as code-point ranges rather than as a character class because this
 * file is edited by tools that rewrite escape sequences, and a `[ ]` that
 * silently becomes a literal line separator inside a regular expression is a
 * bug nobody would see in a diff.
 */
function isBreak(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x85 ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/**
 * Is this code point invisible, or worse than invisible?
 *
 * The C0 and C1 control characters, the soft hyphen, the zero-width set, the
 * bidirectional overrides and isolates, the invisible-operator block and the
 * byte-order mark. They are dropped rather than replaced with a space: none of
 * them is a word boundary and every one of them is something a reader cannot
 * see.
 *
 * The bidirectional overrides are why this is not simply "control characters".
 * A right-to-left override in a task line reverses the text that follows it, on
 * a page that has no direction handling at all — `i18n.ts` ships six
 * left-to-right languages and sets no `dir` — so a card could be made to
 * display a sentence backwards, or to display one sentence while holding
 * another.
 */
function isInvisible(code: number): boolean {
  if (code <= 0x1f) return !isBreak(code);
  if (code >= 0x7f && code <= 0x9f) return code !== 0x85;
  if (code === 0xad) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2060 && code <= 0x2064) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0xfeff;
}

/**
 * The harness wrappers, with their contents.
 *
 * Each pattern also matches an *unterminated* opening tag to the end of the
 * string: a transcript is tailed, so the last line in the file can be half
 * written, and half a system reminder must not become the task.
 */
const WRAPPERS: readonly RegExp[] = [
  /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g,
  /<command-name>[\s\S]*?(?:<\/command-name>|$)/g,
  /<command-message>[\s\S]*?(?:<\/command-message>|$)/g,
  /<command-args>[\s\S]*?(?:<\/command-args>|$)/g,
  /<local-command-stdout>[\s\S]*?(?:<\/local-command-stdout>|$)/g,
  /<local-command-stderr>[\s\S]*?(?:<\/local-command-stderr>|$)/g,
  /*
   * N-WP18. Codex writes its own injections into the same slot: a rollout's
   * `user` turns carry the environment block, the plugin catalogue, the
   * delegation notice and a skill's own text alongside anything a person typed
   * — 51 of the 228 user turns measured on the maintainer's machine. They are
   * the same category as a system reminder and are dropped for the same two
   * reasons: nobody typed them, and they are the part of a user turn that can
   * carry instructions.
   *
   * Stripping them from a Claude Code line costs nothing — the tags never
   * appear there — which is why there is one list rather than one per provider.
   * A second cleaner is a second thing that can drift.
   */
  /<environment_context>[\s\S]*?(?:<\/environment_context>|$)/g,
  /<user_instructions>[\s\S]*?(?:<\/user_instructions>|$)/g,
  /<recommended_plugins>[\s\S]*?(?:<\/recommended_plugins>|$)/g,
  /<realtime_delegation>[\s\S]*?(?:<\/realtime_delegation>|$)/g,
  /<skill>[\s\S]*?(?:<\/skill>|$)/g,
];

/** What Claude Code writes where a turn was abandoned. */
const INTERRUPTIONS: readonly RegExp[] = [
  /\[Request interrupted by user[^\]]*\]/g,
  /\[Request cancelled by user[^\]]*\]/g,
];

/**
 * One line, clean, capped.
 *
 * Deliberately **not** markup-aware in the other direction: `<b>hi</b>` comes
 * out as the eight characters somebody typed. The canvas draws this into an SVG
 * text node and the hover card into a `textContent`, so there is nothing to
 * escape and nothing that could be interpreted; escaping it here would show
 * `&lt;b&gt;` to a user who wrote `<b>`, which is a bug rather than a defence.
 *
 * Returns `undefined` when nothing readable is left, so "no task" is one value
 * everywhere rather than an empty string in some places and `undefined` in
 * others.
 */
export function cleanTaskText(raw: string): string | undefined {
  let out = '';
  let space = false;
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (isInvisible(code)) continue;
    if (isBreak(code) || character === ' ') {
      space = out.length > 0;
      continue;
    }
    if (space) out += ' ';
    space = false;
    out += character;
    // Stop one character past the cap: that is all it takes to know the text
    // was longer, and it keeps a ten-thousand-character paste from being walked
    // to the end on every frame.
    if (out.length > MAX_TASK_TEXT) break;
  }
  if (out.length === 0) return undefined;
  if (out.length <= MAX_TASK_TEXT) return out;
  return `${out.slice(0, MAX_TASK_TEXT)}…`;
}

/** Strip the harness's own wrappers and the interruption markers. */
export function stripHarnessText(raw: string): string {
  let out = raw;
  for (const pattern of WRAPPERS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, ' ');
  }
  for (const pattern of INTERRUPTIONS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, ' ');
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The human text of one `message`, or `undefined`.
 *
 * `content` is either a bare string (the older shape, still written for a plain
 * typed turn) or an array of blocks. In the array case the blocks are read in
 * order and the **first** one that survives the stripping wins: a turn that
 * opens with a system reminder and then says what to do is one task, and it is
 * the part the person wrote.
 */
export function extractTaskText(message: unknown): string | undefined {
  if (typeof message === 'string') return cleanTaskText(stripHarnessText(message));
  if (!isRecord(message)) return undefined;

  const content = message['content'];
  if (typeof content === 'string') return cleanTaskText(stripHarnessText(content));
  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    if (typeof block === 'string') {
      const loose = cleanTaskText(stripHarnessText(block));
      if (loose !== undefined) return loose;
      continue;
    }
    if (!isRecord(block)) continue;
    // `tool_result`, `image`, `document`, `thinking`: everything that is not a
    // text block is not the human turn, and none of it is read.
    if (block['type'] !== 'text') continue;
    const text = block['text'];
    if (typeof text !== 'string') continue;
    const cleaned = cleanTaskText(stripHarnessText(text));
    if (cleaned !== undefined) return cleaned;
  }
  return undefined;
}
