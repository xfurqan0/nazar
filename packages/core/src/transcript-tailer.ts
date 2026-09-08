/**
 * WP2: the incremental transcript tailer.
 *
 * Transcripts are append-only JSONL and reach 9 MB on this machine, so the one
 * thing this file must never do is read a file twice. It keeps a byte offset
 * per file and reads only what was appended since the last pass; a test asserts
 * the read sizes, and `bytesRead` is exported so callers can assert them too.
 *
 * Four details the format forces, all of them tested:
 *
 * - **Partial trailing line.** Claude Code writes asynchronously, so a read can
 *   land mid-line. The remainder is buffered as bytes (not as a string: a UTF-8
 *   sequence can be split across the boundary too) and completed by the next
 *   read.
 * - **Truncation and rotation.** If the file is shorter than our offset it is
 *   not the file we were reading. The offset restarts at zero and the caller is
 *   told, so it can throw its derived state away rather than double-count.
 * - **CRLF.** A trailing `\r` is stripped. Real files on this machine use LF
 *   even on Windows (346 of 346 checked), but the copy in a bug report may not.
 * - **BOM.** Stripped once, and only at offset zero.
 *
 * Nothing here parses JSON or looks inside a line: this file moves bytes.
 */
import { open, stat } from 'node:fs/promises';

/** Bytes pulled from disk in one `read()` syscall. Bounds the allocation. */
const DEFAULT_CHUNK_BYTES = 1 << 20;

const LF = 0x0a;
const CR = 0x0d;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface TailerReadResult {
  /** Complete lines appended since the last read, in file order. Never empty strings. */
  readonly lines: readonly string[];
  /** Bytes actually pulled off disk in this pass. Zero when nothing was appended. */
  readonly bytesRead: number;
  /** True when the file shrank and the offset had to restart from zero. */
  readonly restarted: boolean;
  /** True when the file does not exist (yet). Not an error. */
  readonly missing: boolean;
  /** Size of the file as of this pass. */
  readonly size: number;
  /** `mtimeMs` of the file: Nazar's `lastWriteAt`. */
  readonly mtimeMs?: number;
}

export interface TranscriptTailerOptions {
  /** Largest single `read()`. Only affects allocation, never the result. */
  readonly chunkBytes?: number;
  /**
   * Most bytes one `read()` will return, however far behind the offset is.
   *
   * The live tailer never needs this: it is always a few kilobytes behind. The
   * history reader does, because it starts at byte zero of a file that can be
   * **76 MB** on this machine (measured: the largest single subagent transcript
   * in a 90-day store), and concatenating that into one buffer with four such
   * reads in flight is a third of a gigabyte for no reason. With a cap the
   * caller loops until `bytesRead` is zero and the peak stays at the cap.
   *
   * Unset means "no cap", which is the WP2 behaviour and what the live watcher
   * uses. It never changes *what* is returned, only how much per call.
   */
  readonly maxBytesPerRead?: number;
  /**
   * Start reading from the end of the file rather than from byte zero. Used by
   * nothing in v1 (token totals need the whole file) but kept because a "follow
   * from now" mode is the obvious next ask.
   */
  readonly fromEnd?: boolean;
}

const EMPTY = Buffer.alloc(0);

/**
 * One file, one offset. Construct it once per path and call `read()` as often
 * as you like: the second and later calls cost only the appended bytes.
 */
export class TranscriptTailer {
  readonly file: string;

  private readonly chunkBytes: number;

  private readonly maxBytesPerRead: number;

  private readonly fromEnd: boolean;

  private offset = 0;

  private pending: Buffer = EMPTY;

  private opened = false;

  private totalBytes = 0;

  private passes = 0;

  private restarts = 0;

  constructor(file: string, options: TranscriptTailerOptions = {}) {
    this.file = file;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxBytesPerRead = Math.max(1, options.maxBytesPerRead ?? Number.POSITIVE_INFINITY);
    this.fromEnd = options.fromEnd ?? false;
  }

  /** Byte offset the next read starts at. */
  get position(): number {
    return this.offset;
  }

  /** Total bytes this tailer has pulled off disk, over all passes. */
  get bytesRead(): number {
    return this.totalBytes;
  }

  /** How many times `read()` actually opened the file. */
  get readCount(): number {
    return this.passes;
  }

  /** How many times the file shrank under us. */
  get restartCount(): number {
    return this.restarts;
  }

  /** True once the file has been opened at least once. */
  get hasOpened(): boolean {
    return this.opened;
  }

  /**
   * Read everything appended since the last call. Never throws for a missing
   * file, a file that shrank, or a file being written to while we read it.
   */
  async read(): Promise<TailerReadResult> {
    let size: number;
    let mtimeMs: number | undefined;
    try {
      const info = await stat(this.file);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { lines: [], bytesRead: 0, restarted: false, missing: true, size: 0 };
      }
      return { lines: [], bytesRead: 0, restarted: false, missing: false, size: 0 };
    }

    let restarted = false;
    if (size < this.offset) {
      // Truncated or rotated: this is not the file we had an offset into.
      this.offset = 0;
      this.pending = EMPTY;
      this.opened = false;
      this.restarts += 1;
      restarted = true;
    }

    if (!this.opened && this.fromEnd) {
      this.offset = size;
      this.opened = true;
      return { lines: [], bytesRead: 0, restarted, missing: false, size, mtimeMs };
    }

    if (size === this.offset) {
      return { lines: [], bytesRead: 0, restarted, missing: false, size, mtimeMs };
    }

    // Never past the cap, and never past the end of the file as it stands now.
    const ceiling = Math.min(size, this.offset + this.maxBytesPerRead);

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let handle;
    try {
      handle = await open(this.file, 'r');
    } catch {
      return { lines: [], bytesRead: 0, restarted, missing: false, size, mtimeMs };
    }
    try {
      while (this.offset + bytesRead < ceiling) {
        const want = Math.min(this.chunkBytes, ceiling - this.offset - bytesRead);
        const buffer = Buffer.allocUnsafe(want);
        const result = await handle.read(buffer, 0, want, this.offset + bytesRead);
        if (result.bytesRead <= 0) break;
        chunks.push(
          result.bytesRead === want ? buffer : buffer.subarray(0, result.bytesRead),
        );
        bytesRead += result.bytesRead;
      }
    } finally {
      await handle.close();
    }

    this.opened = true;
    this.passes += 1;
    this.offset += bytesRead;
    this.totalBytes += bytesRead;

    let data = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
    if (this.pending.length > 0) {
      data = Buffer.concat([this.pending, data]);
      this.pending = EMPTY;
    } else if (this.offset - bytesRead === 0 && data.subarray(0, 3).equals(BOM)) {
      data = data.subarray(3);
    }

    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== LF) continue;
      let end = i;
      if (end > start && data[end - 1] === CR) end -= 1;
      if (end > start) lines.push(data.toString('utf8', start, end));
      start = i + 1;
    }
    this.pending = start < data.length ? Buffer.from(data.subarray(start)) : EMPTY;

    return { lines, bytesRead, restarted, missing: false, size, mtimeMs };
  }

  /** Forget the offset and the partial line. The next read starts over. */
  reset(): void {
    this.offset = 0;
    this.pending = EMPTY;
    this.opened = false;
  }
}
