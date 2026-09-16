/**
 * Types for `check-binary-paths.mjs`, so `test/binary-paths.test.ts` can import it.
 *
 * The script itself stays plain JavaScript, like `check-licenses.mjs` beside it and for
 * the same reason: it runs against a built artifact on a machine where nothing of this
 * repository's own TypeScript has to be compiled first. This declares the pieces the test
 * drives and nothing more — the entry point is not exported and is not meant to be called.
 */

/** One thing that must not be in an artifact, and why. */
export interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly why: string;
  /** Whether a match only counts when neither side of it is a letter or a digit. */
  readonly whole?: boolean;
}

/** One path found inside an artifact. */
export interface Finding {
  readonly rule: string;
  readonly why: string;
  readonly encoding: string;
  readonly at: number;
  readonly text: string;
}

/** The machine-independent rules: a Windows profile, a Linux home, a macOS home. */
export const RULES: readonly Rule[];

/** Those three, plus the running machine's own home directory and account name. */
export function rulesFor(machine?: { account?: string; home?: string }): Rule[];

/** Every match in one run of text, duplicates kept — the count is the measurement. */
export function findLeaks(text: string, rules: readonly Rule[], encoding?: string): Finding[];

/** One buffer, read as UTF-8 and as UTF-16LE at both byte alignments. */
export function scanBuffer(buffer: Buffer, rules: readonly Rule[]): Finding[];

/** The members of an `ar` archive, which is all a `.deb` is. */
export function arMembers(buffer: Buffer): { name: string; data: Buffer }[];

/** A gzip, zstd or already-plain member, or `undefined` when nothing here opens it. */
export function decompress(data: Buffer): Buffer | undefined;

/** The decompressed payload of an `.rpm`, found by its magic bytes. */
export function rpmPayload(buffer: Buffer): Buffer | undefined;

/** Every file under a path, or the path itself when it is one. */
export function walk(target: string): string[];

/** The release artifacts of a tree that exist, for a run with no arguments. */
export function defaultTargets(root?: string): string[];
