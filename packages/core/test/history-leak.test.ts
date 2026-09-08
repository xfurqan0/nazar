/**
 * The WP4b leak gate: **ten real transcripts, from this machine, through the
 * history builder.**
 *
 * `transcript-extract.test.ts` proves the parser drops everything it is not
 * allowed to keep, using a line whose every free-text field holds a sentinel.
 * That test is synthetic on purpose — a sentinel is unambiguous. This one is
 * the other half: it runs the *whole history path* over files nobody wrote for
 * a test, and asks whether anything a person typed came out the far end.
 *
 * Four probes, in order of strength:
 *
 * 1. **Structural.** Every string in the result is walked, and its *key* must
 *    be on a closed list. A field that is not an id, a model, an agent type, a
 *    project label or an enum has no business holding a string here, whatever
 *    it contains. This is the probe that would catch a new field added later
 *    without thinking.
 * 2. **Length.** No string over 200 characters. Every value on the list above
 *    is an id, a name or a timestamp; a longer one is not what we think it is.
 * 3. **Vocabulary.** Words are sampled at test time from each file's `text` and
 *    `thinking` blocks — the prompt and the model's own prose, the most
 *    sensitive thing in the file — and none of them may turn up in a string
 *    *value* of the output unless the session's own structural sources explain
 *    it. The words are used and thrown away; nothing is written anywhere, and a
 *    failure names the field, never the word.
 * 4. **Identity.** No path under the user's home directory, no account name, no
 *    e-mail address.
 *
 * The test needs a real transcript store, so it skips on a machine that has
 * none (CI runners, a fresh checkout). It reads; it writes nothing under
 * `~/.claude`, and it prints no transcript content on failure — only which
 * probe fired, on which hashed file, and under which key path.
 *
 * ---
 *
 * ## Why the sampler looks the way it does
 *
 * Probe 3 needs words, and the store does not promise them. Three facts about a
 * real `~/.claude/projects` shape the sampler:
 *
 * - **Not every transcript holds prose.** Claude Code writes a session file the
 *   moment a session exists, and a session that was opened and never spoken in
 *   is a single `bridge-session` record: 267 bytes, no `user` line, no
 *   `assistant` line, nothing a person typed. It is a real transcript, and
 *   because it was just written it is often the *newest* one. A gate that
 *   demanded prose from the ten most recent files therefore failed on a fact
 *   about the store rather than a defect in the code. Such a file is now passed
 *   over for the next candidate. Sampling nothing is only evidence of a broken
 *   sampler when the file plainly held prose — `PROSE_CHAR_FLOOR` characters of
 *   it — and not one word came out, and that case still fails.
 * - **Prose is not always at the top.** A transcript opens with whatever the
 *   session opened with, which is often a long stretch of tool calls and their
 *   results. Reading a fixed number of leading lines can miss the prose on a
 *   large file, so a file over the byte budget is now read at both ends rather
 *   than only at its head, and a file under it is read entire. Reading past the
 *   word budget is not waste either: the tool names and model ids that probe 3
 *   excuses words with are collected in the same pass, and a tool used late in
 *   a long session used to fall outside the window that explained it.
 * - **Subagents write prose too**, into `subagents/agent-*.jsonl`, and the
 *   history builder reads those files. They are sampled after the session's own
 *   transcript, which both widens the probe and carries a session whose own
 *   file is thin.
 *
 * Skipping must not become a way to pass. The run probes at least
 * `MIN_TOTAL_WORDS` words across every transcript it used, and a store that
 * yields no prose at all is an explicit skip rather than a quiet success.
 *
 * ---
 *
 * ## Why probe 3 looks the way it does
 *
 * The first version asked a cruder question — *does this word appear anywhere
 * in `JSON.stringify(history)`?* — and excused a word if it appeared anywhere
 * in the output's own string values. Both halves were wrong, in opposite
 * directions:
 *
 * - **Too coarse.** `JSON.stringify` contains this codebase's *own schema*: the
 *   key names `project`, `model`, `state`, `agent`, `tokens`, `children`. A
 *   prose word equal to one of them matched the serialised text while never
 *   appearing in any value. On this machine that is exactly what fired: an
 *   ordinary noun in an assistant `thinking` block, matched against the key
 *   `"project"`. The probe now walks string **values** with their key path and
 *   matches those; the key names are ours, not the user's.
 * - **Too lenient.** The old excusal was circular. A word was forgiven if it
 *   appeared anywhere in the output, so prose that had leaked *excused itself*.
 *   `Agent.description` — the one free-text field in the node model — was
 *   therefore invisible to this gate by construction. The excusal is now built
 *   from the session's own **structural sources** (the tool names in its
 *   transcript, the agent types and models in its `meta.json` files, its
 *   project slug, its ids, the closed enums) and never from the output. Prose
 *   cannot appear in any of those, so prose can no longer forgive itself, and
 *   `description` is now dropped by the history builder instead of whitelisted
 *   here.
 *
 * The two remaining softenings — a four-character floor and a two-word
 * threshold — do not weaken the guarantee, because probe 3 is not what holds
 * it. Probes 1 and 2 do: a field not on the closed key list fails outright
 * whatever it contains, and nothing over 200 characters passes. Probe 3 only
 * asks whether the *contents* of an already-allowed field look like prose, and
 * every allowed field is an id, an enum, a model name or a slug. A real leak
 * into one of those carries a sentence, not one word, so demanding two distinct
 * unexplained words costs nothing a leak would not pay. To keep that from
 * becoming a slow drip, a single unexplained word is tolerated in one session
 * and not in two: a coincidence does not repeat, a leak does.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

import { buildAgentTree } from '../src/agent-tree.ts';
import { HistoryScanner } from '../src/history.ts';
import { projectsDirPath, sessionTranscriptPaths } from '../src/paths.ts';
import { projectSlugFor } from '../src/project-slug.ts';
import { readSubagentsDir } from '../src/subagent-meta.ts';

/** How many prose-bearing sessions the gate covers. The brief's number. */
const SAMPLE_SESSIONS = 10;

/** Words lifted from each session's prose and probed for. Never persisted. */
const WORDS_PER_FILE = 200;

/**
 * Bytes read from one transcript. Session transcripts on this machine run to
 * 22 MB, so the read is budgeted; a file over the budget is sampled at both
 * ends and a file under it is read entire.
 */
const SAMPLE_BYTES_PER_FILE = 4 * 1024 * 1024;

/**
 * Prose characters that make "no words were sampled" a defect rather than a
 * fact about the file. Two hundred characters of prose without a single word of
 * four letters cannot happen; two hundred characters of `bridge-session` can.
 */
const PROSE_CHAR_FLOOR = 200;

/**
 * Words the whole run must probe before it may pass. Passing over prose-free
 * transcripts is how the gate survives a store full of stubs; this is what
 * stops it becoming a way to check nothing at all.
 */
const MIN_TOTAL_WORDS = 100;

/**
 * Transcripts opened while looking for `SAMPLE_SESSIONS` that carry prose. A
 * bound, so a store of nothing but stubs costs a hundred small reads and not a
 * full scan.
 */
const CANDIDATE_LIMIT = SAMPLE_SESSIONS * 10;

/**
 * Shortest sampled word. Below four characters a match says nothing: `the`,
 * `bir`, `run` and `id` collide with everything.
 */
const MIN_WORD_LENGTH = 4;

/**
 * Distinct unexplained words needed before one session fails the vocabulary
 * probe. One is a coincidence; a leak into an id-shaped field brings a phrase.
 */
const MIN_LEAKED_WORDS = 2;

/** The extractor's own cap, restated here as an assertion rather than a hope. */
const MAX_STRING = 200;

/**
 * Every key in a `History` whose value may be a string.
 *
 * This is the list the structural probe enforces, and it is deliberately
 * written out rather than derived: adding a field to `History` must mean
 * adding a line here, which is where somebody stops and asks what the field
 * can contain.
 *
 * `description` is **not** on it, and that is the point. It is the one field in
 * the node model holding prose a person wrote about their own work, so the
 * history builder is passed `omitDescription: true` and never constructs it. If
 * it is ever put back, this probe fails on the key before anybody has to notice
 * what the value said.
 */
const ALLOWED_STRING_KEYS = new Set([
  // History
  'sessionId',
  'project',
  'cwd',
  'model',
  'effort',
  // Agent
  'id',
  'parentAgentId',
  'agentType',
  'modelId',
  'workflowRunId',
  'state',
  'doneSignal',
  'currentTool',
  'toolUseId',
  // orphans[] is an array of agent ids and has no key of its own
  'orphans',
]);

/**
 * Values the node model writes itself rather than reading from a file: the
 * agent states, the three done signals, and the effort levels Claude Code
 * records. A prose word equal to one of these is explained by the schema.
 */
const SCHEMA_ENUM_TOKENS = [
  'running',
  'done',
  'unknown',
  'parent',
  'result',
  'session',
  'gone',
  'quiet',
  'turn',
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
];

/** Date-shaped tokens: a bare number, a year, an ISO date. Never prose. */
const DATE_SHAPES: readonly RegExp[] = [/^\d+$/, /^\d{4}-\d{2}(-\d{2})?$/];

function hashName(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** Split a value the way the sampler splits prose, so the two are comparable. */
function tokensOf(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9_]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

/**
 * Every string in a structure, with the key it was found under and the path
 * that reaches it. The path is what a failure reports: it names the field
 * without quoting a character of what the field held.
 */
function walkStrings(
  value: unknown,
  keyPath: string,
  visit: (key: string, text: string, keyPath: string) => void,
): void {
  if (typeof value === 'string') {
    const last = keyPath.slice(keyPath.lastIndexOf('.') + 1);
    visit(last.replace(/\[\d+\]$/, ''), value, keyPath);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${keyPath}[${index}]`, visit));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, child] of Object.entries(value)) {
      walkStrings(child, `${keyPath}.${childKey}`, visit);
    }
  }
}

interface ProseSample {
  /** Distinct words from `text` and `thinking` blocks. Thrown away after use. */
  readonly words: readonly string[];
  /** `tool_use` names these transcripts used. Structural: the hover card shows them. */
  readonly toolNames: readonly string[];
  /** `message.model` and `toolUseResult.resolvedModel`. Structural. */
  readonly modelIds: readonly string[];
  /**
   * Characters of prose the sampler actually read. Counted, never kept: it is
   * what tells a file with nothing to say from a sampler that has stopped
   * working, and it is the only thing reported about the file's contents.
   */
  readonly proseChars: number;
  /** How many transcripts the sample was drawn from. */
  readonly files: number;
}

/** The sets a sample is built up in, shared across the files of one session. */
interface SampleSink {
  readonly words: Set<string>;
  readonly toolNames: Set<string>;
  readonly modelIds: Set<string>;
  proseChars: number;
  files: number;
}

function newSink(): SampleSink {
  return {
    words: new Set<string>(),
    toolNames: new Set<string>(),
    modelIds: new Set<string>(),
    proseChars: 0,
    files: 0,
  };
}

/** The prose a content block carries, if it carries any. */
function proseOf(block: unknown): string | undefined {
  if (typeof block === 'string') return block;
  if (typeof block !== 'object' || block === null) return undefined;
  const typed = block as { text?: unknown; thinking?: unknown };
  if (typeof typed.text === 'string') return typed.text;
  if (typeof typed.thinking === 'string') return typed.thinking;
  return undefined;
}

/**
 * One transcript line.
 *
 * Words come only from `text` and `thinking` blocks of `user` and `assistant`
 * lines: those are the prompt and the model's reasoning, which is exactly what
 * must never reach the canvas. A `system` line, a `summary` line, an
 * `attachment` or a `bridge-session` is not the user's prose, and sampling it
 * only manufactures coincidences.
 *
 * The same pass collects tool names and model ids, because they are free here
 * and they are the structural vocabulary probe 3 needs. They keep accumulating
 * after the word budget is full — a tool used in the last minute of a long
 * session is exactly the one likeliest to be sitting in `currentTool`.
 */
function sampleLine(line: string, into: SampleSink, limit: number): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const record = parsed as {
    type?: unknown;
    message?: { model?: unknown; content?: unknown };
    toolUseResult?: { resolvedModel?: unknown };
  };

  const model = record.message?.model;
  if (typeof model === 'string') into.modelIds.add(model);
  const resolved = record.toolUseResult?.resolvedModel;
  if (typeof resolved === 'string') into.modelIds.add(resolved);

  const content = record.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [content] : [];
  const carriesProse = record.type === 'user' || record.type === 'assistant';

  for (const block of blocks) {
    if (typeof block === 'object' && block !== null) {
      const typed = block as { type?: unknown; name?: unknown };
      if (typed.type === 'tool_use' && typeof typed.name === 'string') {
        into.toolNames.add(typed.name);
      }
    }
    if (!carriesProse) continue;
    const text = proseOf(block);
    if (text === undefined) continue;
    into.proseChars += text.length;
    if (into.words.size >= limit) continue;
    for (const word of text.split(/[^A-Za-z0-9_]+/)) {
      if (word.length < MIN_WORD_LENGTH) continue;
      into.words.add(word);
      if (into.words.size >= limit) break;
    }
  }
}

/**
 * One byte range of one transcript, streamed a line at a time so a 22 MB file
 * costs the budget and not its size.
 */
async function sampleRange(
  file: string,
  into: SampleSink,
  limit: number,
  start: number,
  end: number,
): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8', start, end });
  const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  // A range that does not begin at byte 0 begins inside a record; drop that
  // first fragment rather than trust `JSON.parse` to reject every truncation.
  let atFragment = start > 0;
  try {
    for await (const line of lines) {
      if (atFragment) {
        atFragment = false;
        continue;
      }
      sampleLine(line, into, limit);
    }
  } finally {
    lines.close();
    stream.close();
  }
}

/**
 * One transcript, whole where it fits in the budget and at both ends where it
 * does not. Reading only the head is what let a session that opens with a long
 * run of tool calls look like a session nobody spoke in.
 */
async function sampleFile(
  file: string,
  into: SampleSink,
  limit: number,
  budget: number,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return;
  }
  if (size === 0) return;
  into.files += 1;
  if (size <= budget) {
    await sampleRange(file, into, limit, 0, size - 1);
    return;
  }
  const half = Math.floor(budget / 2);
  await sampleRange(file, into, limit, 0, half - 1);
  await sampleRange(file, into, limit, size - half, size - 1);
}

/**
 * Sample a session: its own transcript first, then its subagents'.
 *
 * The first file is always read. The rest are opened only while the word budget
 * is short, so a session that speaks for itself costs one file and a session
 * whose own transcript is thin is carried by the agents it spawned. Everything
 * lives in this function's caller for the length of the test and is written
 * nowhere.
 */
async function sampleTranscripts(
  files: readonly string[],
  limit: number,
  budget: number = SAMPLE_BYTES_PER_FILE,
): Promise<ProseSample> {
  const into = newSink();
  for (const [index, file] of files.entries()) {
    if (index > 0 && into.words.size >= limit) break;
    await sampleFile(file, into, limit, budget);
  }
  return {
    words: [...into.words],
    toolNames: [...into.toolNames],
    modelIds: [...into.modelIds],
    proseChars: into.proseChars,
    files: into.files,
  };
}

/** One transcript, for the synthetic tests that hand the sampler a known file. */
async function sampleProse(
  file: string,
  limit: number,
  budget: number = SAMPLE_BYTES_PER_FILE,
): Promise<ProseSample> {
  return sampleTranscripts([file], limit, budget);
}

/** The identifying fields of a `meta.json`. `description` is pointedly not one. */
interface StructuralMeta {
  readonly id: string;
  readonly agentType?: string;
  readonly model?: string;
  readonly parentAgentId?: string;
  readonly toolUseId?: string;
  readonly workflowRunId?: string;
}

/**
 * Everything one session may legitimately say, as lowercase tokens.
 *
 * Built from the session's **sources**, never from the history object: the
 * directory name, the session id, the tool names and model ids in the
 * transcript, and the identifying fields of the `meta.json` files.
 * `meta.json`'s `description` is deliberately not read here — a leak must not
 * be allowed to write its own alibi.
 */
function structuralVocabulary(input: {
  readonly slug: string;
  readonly project: string;
  readonly sessionId: string;
  readonly toolNames: readonly string[];
  readonly modelIds: readonly string[];
  readonly metas: readonly StructuralMeta[];
}): Set<string> {
  const vocabulary = new Set<string>(SCHEMA_ENUM_TOKENS);
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const token of tokensOf(value)) vocabulary.add(token);
  };

  add(input.slug);
  add(input.project);
  add(input.sessionId);
  for (const name of input.toolNames) add(name);
  for (const id of input.modelIds) add(id);
  for (const meta of input.metas) {
    add(meta.id);
    add(meta.agentType);
    add(meta.model);
    add(meta.parentAgentId);
    add(meta.toolUseId);
    add(meta.workflowRunId);
    // `meta.description` is deliberately absent: see the doc comment above.
  }
  return vocabulary;
}

function isExplained(token: string, vocabulary: ReadonlySet<string>): boolean {
  if (vocabulary.has(token)) return true;
  return DATE_SHAPES.some((shape) => shape.test(token));
}

/** One sampled word found in a string value that nothing structural explains. */
interface Leak {
  /** Where it was found. Reported. */
  readonly keyPath: string;
  /** Which sampled word it was. **Never reported** — used only to count. */
  readonly word: string;
}

/**
 * Probe 3, as a function, so the positive tests below run the same code the
 * real-store test runs rather than a lookalike of it.
 */
function findProseLeaks(
  value: unknown,
  words: readonly string[],
  vocabulary: ReadonlySet<string>,
): Leak[] {
  const wanted = new Map<string, string>();
  for (const word of words) {
    const lower = word.toLowerCase();
    if (isExplained(lower, vocabulary)) continue;
    wanted.set(lower, word);
  }
  if (wanted.size === 0) return [];

  const leaks: Leak[] = [];
  walkStrings(value, 'root', (_key, text, keyPath) => {
    for (const token of new Set(tokensOf(text))) {
      const word = wanted.get(token);
      if (word !== undefined) leaks.push({ keyPath, word });
    }
  });
  return leaks;
}

interface SessionCandidate {
  readonly sessionId: string;
  readonly file: string;
  readonly slug: string;
  readonly projectDir: string;
  readonly mtimeMs: number;
}

/**
 * Every session transcript in the store, most recently written first.
 *
 * All of them, not the first ten: the newest file is as likely as not to be a
 * session that was opened and never spoken in, and the caller walks this list
 * until it has the transcripts it needs.
 */
async function recentSessions(root: string): Promise<SessionCandidate[]> {
  const found: SessionCandidate[] = [];
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return found;
  }
  for (const project of projects) {
    const dir = path.join(root, project);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      try {
        const info = await stat(file);
        if (info.size === 0) continue;
        found.push({
          sessionId: entry.name.slice(0, -'.jsonl'.length),
          file,
          slug: project,
          projectDir: dir,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

test(`no content from ${SAMPLE_SESSIONS} real transcripts reaches the history builder's output`, async (t) => {
  const root = projectsDirPath();
  const candidates = await recentSessions(root);
  if (candidates.length === 0) {
    t.skip('needs a real transcript store under the project directory; found none');
    return;
  }

  const home = os.homedir();
  const account = path.basename(home);
  const homeSlug = projectSlugFor(home);
  const scanner = new HistoryScanner();

  let examined = 0;
  let used = 0;
  let passedOver = 0;
  let wordsProbed = 0;
  let filesSampled = 0;
  let stringsWalked = 0;
  let agentsSeen = 0;
  let vocabularySize = 0;
  const sessionsWithOneUnexplained: string[] = [];

  for (const session of candidates) {
    if (used >= SAMPLE_SESSIONS || examined >= CANDIDATE_LIMIT) break;
    examined += 1;
    const label = hashName(session.file);

    // The excusal set comes from this session's own sources — never from the
    // output, or a leak would forgive itself. The same scan names the subagent
    // transcripts, which are sampled after the session's own.
    const scan = await readSubagentsDir(
      sessionTranscriptPaths(session.projectDir, session.sessionId).subagentsDir,
    );
    const sample = await sampleTranscripts(
      [session.file, ...scan.transcripts.map((transcript) => transcript.file)],
      WORDS_PER_FILE,
    );

    // A transcript nobody spoke in proves nothing either way, so it is passed
    // over for the next candidate rather than failed. A transcript that plainly
    // held prose and yielded no word is a broken sampler, and says so.
    assert.ok(
      sample.words.length > 0 || sample.proseChars < PROSE_CHAR_FLOOR,
      `${label}: ${sample.proseChars} characters of prose were read and not one word came ` +
        `out of them, so it is the sampler that is broken, not the file`,
    );
    if (sample.words.length === 0) {
      passedOver += 1;
      continue;
    }

    const history = await scanner.open(session.sessionId);
    assert.ok(history !== undefined, `${label} is in the store but the scanner would not open it`);
    used += 1;
    wordsProbed += sample.words.length;
    filesSampled += sample.files;
    agentsSeen += history.agentCount;

    /* ---- 1 and 2: structure and length ------------------------------ */

    walkStrings(history, 'root', (key, text, keyPath) => {
      stringsWalked += 1;
      assert.ok(
        ALLOWED_STRING_KEYS.has(key),
        `${label}: a string turned up at ${keyPath}, whose key is not on the allowed list`,
      );
      assert.ok(
        text.length <= MAX_STRING,
        `${label}: a string of ${text.length} characters at ${keyPath} is not an identifier`,
      );
    });

    /* ---- 3: vocabulary --------------------------------------------- */

    const vocabulary = structuralVocabulary({
      slug: session.slug,
      project: history.project,
      sessionId: session.sessionId,
      toolNames: sample.toolNames,
      modelIds: sample.modelIds,
      metas: scan.metas,
    });
    vocabularySize += vocabulary.size;

    const leaks = findProseLeaks(history, sample.words, vocabulary);
    const distinctWords = new Set(leaks.map((leak) => leak.word)).size;
    const fields = [...new Set(leaks.map((leak) => leak.keyPath))].slice(0, 5).join(', ');
    assert.ok(
      distinctWords < MIN_LEAKED_WORDS,
      `${label}: ${distinctWords} distinct words from the transcript's own prose reached ` +
        `the history output at ${fields}`,
    );
    if (distinctWords > 0) sessionsWithOneUnexplained.push(`${label} (${fields})`);

    /* ---- 4: identity ------------------------------------------------ */

    const serialised = JSON.stringify(history);
    assert.ok(!serialised.includes(home), `${label}: the home directory reached the output`);
    assert.ok(
      !serialised.toLowerCase().includes(account.toLowerCase()),
      `${label}: the account name reached the output`,
    );
    assert.ok(
      !serialised.includes(homeSlug),
      `${label}: the home directory's slug reached the output; it must collapse to "~"`,
    );
    assert.ok(
      !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(serialised),
      `${label}: something e-mail shaped reached the output`,
    );
    assert.ok(
      !/[A-Za-z]:[\\/]/.test(serialised) && !/(^|")\/(home|Users)\//.test(serialised),
      `${label}: an absolute path reached the output`,
    );
  }

  // A store of nothing but stubs is not a pass. The gate says so and stops.
  if (used === 0) {
    t.skip(
      `needs a transcript somebody spoke in; ${examined} of ${candidates.length} were read ` +
        'and none carried prose',
    );
    return;
  }

  // A single unexplained word in one file is a collision with a structural
  // token nobody enumerated. The same thing in two files is a pattern, and a
  // pattern is a leak.
  assert.ok(
    sessionsWithOneUnexplained.length <= 1,
    `${sessionsWithOneUnexplained.length} sessions each carried an unexplained prose word: ` +
      sessionsWithOneUnexplained.join(' · '),
  );

  // A gate that checked nothing would also pass, so say what it checked. The
  // word floor is what the passing-over above is paid for with: fewer than ten
  // sessions is allowed, proving nothing is not.
  assert.ok(
    wordsProbed >= MIN_TOTAL_WORDS,
    `only ${wordsProbed} words were probed across ${used} sessions`,
  );
  assert.ok(stringsWalked > used, `only ${stringsWalked} strings were walked`);
  assert.ok(vocabularySize > 0, 'the structural vocabulary was empty, so nothing was excused');
  t.diagnostic(
    `${used} of ${examined} sessions read · ${passedOver} carried no prose · ` +
      `${filesSampled} transcripts sampled · ${agentsSeen} agents · ` +
      `${stringsWalked} strings walked · ${wordsProbed} prose words probed · ` +
      `${vocabularySize} structural tokens · ` +
      `${sessionsWithOneUnexplained.length} single-word coincidences`,
  );

  /* ---- and the listing, which is the other thing the panel shows ---- */

  const page = await scanner.list({ limit: 200 });
  const listing = JSON.stringify(page);
  assert.ok(!listing.includes(home));
  assert.ok(!listing.includes(homeSlug), 'the listing must collapse the home slug too');
  assert.ok(
    !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(listing),
    'something e-mail shaped reached the listing',
  );
  walkStrings(page, 'root', (key, text, keyPath) => {
    assert.ok(
      ALLOWED_STRING_KEYS.has(key) || key === 'projects',
      `a string turned up in the listing at ${keyPath}`,
    );
    assert.ok(text.length <= MAX_STRING, `a ${text.length}-character string reached the listing`);
  });
});

/* ------------------------------------------------------------------ *
 * The probes must bite. Everything below is synthetic: not a line of it comes
 * from a real transcript, and nothing is read from or written to `~/.claude`.
 * ------------------------------------------------------------------ */

/** Two words no vocabulary, tool name, model id or slug will ever contain. */
const SENTINELS = ['zephyrquell', 'brindlewax'] as const;

test('probe 3 bites: prose in an allowed field is caught, by the same function', () => {
  const vocabulary = structuralVocabulary({
    slug: 'C--proj-alpha',
    project: 'C--proj-alpha',
    sessionId: '00000000-0000-4000-8000-000000000001',
    toolNames: ['Read', 'Bash'],
    modelIds: ['claude-opus-5[1m]'],
    metas: [{ id: 'a0000000000000001', agentType: 'general-purpose', model: 'opus' }],
  });

  // A history that carried prose: the phrase lands in `agentType`, which is on
  // the allowed key list, so probes 1 and 2 both wave it through.
  const leaked = {
    sessionId: '00000000-0000-4000-8000-000000000001',
    project: 'C--proj-alpha',
    agents: [{ id: 'a0000000000000001', agentType: `${SENTINELS[0]} the ${SENTINELS[1]}` }],
  };
  const leaks = findProseLeaks(leaked, [...SENTINELS, 'Read', 'opus'], vocabulary);
  const distinct = new Set(leaks.map((leak) => leak.word));
  assert.equal(distinct.size, SENTINELS.length);
  assert.ok(
    distinct.size >= MIN_LEAKED_WORDS,
    'a two-word leak must clear the threshold that stops single-token coincidence',
  );
  assert.ok(leaks.every((leak) => leak.keyPath === 'root.agents[0].agentType'));

  // And the structural words handed to the same call are explained, not
  // reported: the probe tells a tool name from a sentence.
  assert.ok(!leaks.some((leak) => leak.word === 'Read' || leak.word === 'opus'));
});

test('probe 3 does not fire on structural tokens that also read as prose', () => {
  const vocabulary = structuralVocabulary({
    slug: 'C--work-project',
    project: 'C--work-project',
    sessionId: '00000000-0000-4000-8000-000000000001',
    toolNames: ['Read', 'Bash', 'Skill'],
    modelIds: ['claude-opus-5[1m]'],
    metas: [{ id: 'a0000000000000001', agentType: 'general-purpose', model: 'opus' }],
  });

  // Every one of these is a real word somebody could write in a prompt, and
  // every one is also something this session structurally contains.
  const clean = {
    sessionId: '00000000-0000-4000-8000-000000000001',
    project: 'C--work-project',
    agents: [
      {
        id: 'a0000000000000001',
        agentType: 'general-purpose',
        model: 'opus',
        state: 'done',
        doneSignal: 'session-gone',
        currentTool: 'Skill',
      },
    ],
  };
  const words = ['project', 'general', 'purpose', 'session', 'gone', 'done', 'Skill', 'work'];
  assert.deepEqual(findProseLeaks(clean, words, vocabulary), []);

  // The schema's own key names are this codebase's, not the user's: a prose
  // word equal to one of them is not a leak, and matching values rather than
  // the serialised JSON is what makes that true.
  assert.ok(JSON.stringify(clean).includes('"project"'));
  assert.deepEqual(findProseLeaks(clean, ['children', 'agents', 'tokens'], vocabulary), []);
});

test('probe 1 bites: a string under an unknown key fails whatever it says', () => {
  let caught = false;
  walkStrings({ sessionId: 'x', note: 'anything at all' }, 'root', (key) => {
    if (!ALLOWED_STRING_KEYS.has(key)) caught = true;
  });
  assert.ok(caught, 'an unexpected string key must fail the structural probe');

  // `description` is now one of those unknown keys: putting it back fails here.
  let description = false;
  walkStrings({ agents: [{ description: 'anything' }] }, 'root', (key) => {
    if (!ALLOWED_STRING_KEYS.has(key)) description = true;
  });
  assert.ok(description, 'description must not be whitelisted back onto the history object');
});

/**
 * The regression this gate was rebuilt around, end to end and entirely
 * synthetic: a session whose `meta.json` carries a `description` holding two
 * sentinel words that also appear in the transcript's prose.
 *
 * Two assertions, and the pair is the point:
 *
 * - the history builder produces no `description` at all, so the probe is
 *   quiet — the guarantee holds at the builder, not at a later filter;
 * - the *same* tree built without `omitDescription` does leak both sentinels,
 *   which is what proves the silence above is a fixed bug rather than a blind
 *   probe.
 */
test('a description written by a person never reaches the history object', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-leak-'));
  try {
    const sessionId = '00000000-0000-4000-8000-0000000000aa';
    const agentId = 'a00000000000000aa';
    const slug = 'C--proj-synthetic';
    const projectDir = path.join(root, slug);
    await mkdir(projectDir, { recursive: true });

    // A hand-written transcript. Two lines, both shapes the extractor reads,
    // with the sentinels in the places a person's words actually live.
    const lines = [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-0000000000b1',
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `please ${SENTINELS[0]} it` }] },
      },
      {
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-0000000000b2',
        parentUuid: '00000000-0000-4000-8000-0000000000b1',
        sessionId,
        timestamp: '2026-01-01T00:00:10.000Z',
        message: {
          id: 'msg_0000000000000001',
          role: 'assistant',
          model: 'claude-opus-5[1m]',
          content: [
            { type: 'thinking', thinking: `the ${SENTINELS[1]} needs doing` },
            { type: 'tool_use', id: 'toolu_0000000000000001', name: 'Read', input: { file: 'x' } },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        requestId: 'req_0000000000000001',
      },
    ];
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const subagents = path.join(projectDir, sessionId, 'subagents');
    await mkdir(subagents, { recursive: true });
    const meta = {
      agentType: 'general-purpose',
      model: 'opus',
      spawnDepth: 1,
      toolUseId: 'toolu_0000000000000001',
      // The field this test exists for: prose, echoing the transcript's words.
      description: `${SENTINELS[0]} and ${SENTINELS[1]}`,
    };
    await writeFile(
      path.join(subagents, `agent-${agentId}.meta.json`),
      JSON.stringify(meta),
      'utf8',
    );

    const scanner = new HistoryScanner({ projectsDir: root, home: path.join(root, 'nobody') });
    const history = await scanner.open(sessionId);
    assert.ok(history !== undefined, 'the synthetic session must open');
    assert.equal(history.agentCount, 1, 'the synthetic subagent must be in the tree');

    // The key is gone from the object, not merely from the wire.
    assert.ok(
      !JSON.stringify(history).includes('description'),
      'the history builder must not construct a description at all',
    );
    walkStrings(history, 'root', (key, _text, keyPath) => {
      assert.ok(ALLOWED_STRING_KEYS.has(key), `an unexpected string survived at ${keyPath}`);
    });

    const sample = await sampleProse(path.join(projectDir, `${sessionId}.jsonl`), WORDS_PER_FILE);
    assert.ok(
      SENTINELS.every((word) => sample.words.includes(word)),
      'the sampler must pick both sentinels out of the text and thinking blocks',
    );
    const scan = await readSubagentsDir(sessionTranscriptPaths(projectDir, sessionId).subagentsDir);
    const vocabulary = structuralVocabulary({
      slug,
      project: history.project,
      sessionId,
      toolNames: sample.toolNames,
      modelIds: sample.modelIds,
      metas: scan.metas,
    });
    assert.deepEqual(
      findProseLeaks(history, sample.words, vocabulary),
      [],
      'the built history must carry none of the prose',
    );

    // Now the same tree with the drop undone. If the gate were blind this would
    // be quiet too — it is not, which is what makes the silence above mean
    // something.
    const unguarded = buildAgentTree({ sessionId, metas: scan.metas, sessionGone: true });
    const leaks = findProseLeaks(unguarded, sample.words, vocabulary);
    assert.equal(
      new Set(leaks.map((leak) => leak.word)).size,
      SENTINELS.length,
      'without the drop, both sentinels must be caught — otherwise the probe proves nothing',
    );
    assert.ok(leaks.every((leak) => leak.keyPath.endsWith('.description')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * The two facts about a real store that the gate above now has to live with,
 * as fixtures rather than as hopes about what `~/.claude` happens to contain.
 * ------------------------------------------------------------------ */

test('a transcript nobody spoke in yields no prose, and that is a fact not a fault', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-leak-'));
  try {
    // The shape that broke this gate: a session Claude Code opened and nobody
    // typed into. One record, no `user` line, no `assistant` line; the real one
    // on this machine was 267 bytes and the newest file in the store.
    const file = path.join(root, '00000000-0000-4000-8000-0000000000cc.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({
        type: 'bridge-session',
        sessionId: '00000000-0000-4000-8000-0000000000cc',
        bridgeSessionId: '00000000-0000-4000-8000-0000000000cd',
        lastSequenceNum: 0,
      })}\n`,
      'utf8',
    );

    const sample = await sampleProse(file, WORDS_PER_FILE);
    assert.deepEqual(sample.words, [], 'a bridge-session record is nobody speaking');
    assert.equal(sample.proseChars, 0, 'and there was no prose for the sampler to have missed');

    // Which is exactly what lets the gate pass the file over: under the floor,
    // no words is a fact about the file. Over it, the same result is a defect,
    // and the assertion in the gate fires on it.
    assert.ok(sample.proseChars < PROSE_CHAR_FLOOR);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the sampler reads both ends of a transcript that is over the byte budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-leak-'));
  try {
    const file = path.join(root, '00000000-0000-4000-8000-0000000000dd.jsonl');
    const speaks = (word: string): string =>
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-5[1m]',
          content: [{ type: 'thinking', thinking: `the ${word} needs doing` }],
        },
      });
    const works = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_0000000000000001', name: 'Read', input: {} }],
      },
    });

    // A session that opens and closes with a person and does nothing but work
    // in between — the shape a head-only sampler reads as a session with no
    // prose in it at all.
    const stretch = Array.from({ length: 400 }, () => works);
    const lines = [
      speaks('zephyrquell'),
      ...stretch,
      speaks('middlemarker'),
      ...stretch,
      speaks('brindlewax'),
    ];
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

    const budget = 4096;
    const size = (await stat(file)).size;
    assert.ok(size > budget * 4, 'the fixture has to be well over the budget to prove anything');

    const sample = await sampleProse(file, WORDS_PER_FILE, budget);
    assert.ok(sample.words.includes('zephyrquell'), 'the head is sampled');
    assert.ok(
      sample.words.includes('brindlewax'),
      'and so is the tail, which is what a head-only read walked past',
    );
    assert.ok(
      !sample.words.includes('middlemarker'),
      'and the budget is real: the middle of an over-budget file is not read',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
