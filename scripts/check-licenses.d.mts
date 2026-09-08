/**
 * Types for `check-licenses.mjs`, so `test/licenses.test.ts` can import it.
 *
 * The script itself stays plain JavaScript: it runs on a machine with the Rust toolchain
 * and nothing else built, which is the whole reason it exists rather than being a
 * `cargo deny` invocation. This declares the four things the test reaches for and nothing
 * more — the script's own entry point is not exported and is not meant to be called.
 */

/** Absolute path of the `deny.toml` the allow-list is read from. */
export const DENY_TOML: string;

/** The SPDX identifiers `deny.toml` allows, parsed at import time. */
export const ALLOWED: ReadonlySet<string>;

/** The `allow` array of a `deny.toml`'s `[licenses]` table. Throws if it has none. */
export function parseAllowedLicenses(toml: string): string[];

/** Whether an SPDX expression is satisfied by {@link ALLOWED}. */
export function isAllowed(expression: string | null | undefined): boolean;
