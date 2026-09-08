/**
 * WP2: the subagent tree source on disk.
 *
 * `~/.claude/projects/<slug>/<session>/subagents/` holds two files per subagent,
 * `agent-<id>.meta.json` and `agent-<id>.jsonl`, and the meta file is the whole
 * tree: 346 of them were read on this machine and the schema is exactly six
 * keys, `parentAgentId` closes 100 % (59 links, 0 dangling), `spawnDepth` is
 * written rather than computed (287 at depth 1, 31 at depth 2, 28 at depth 3),
 * and every meta file has its transcript and every transcript its meta file.
 *
 * `description` is the exception. It is written by a person, describing their
 * own work, and docs/pinned-internal-formats.md keeps it in the "not read"
 * table. It is parsed here, capped, and kept in memory for the live hover card
 * only; it is never written to disk, never serialised into an event, dropped by
 * `toWireAgent` before the wire, and **never built into a history tree at all**
 * (`buildAgentTree`'s `omitDescription`, which `HistoryScanner` always sets).
 * The leak tests cover both halves.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { agentIdFromMetaFileName, agentIdFromTranscriptFileName } from './paths.js';

/** Longest `description` kept in memory. Longer means "not a description". */
export const MAX_DESCRIPTION_LENGTH = 200;

/** One `agent-<id>.meta.json`, reduced to the fields the tree needs. */
export interface AgentMeta {
  /** The 17-hex id in the file name, which is also `toolUseResult.agentId`. */
  readonly id: string;
  readonly agentType?: string;
  /** Shortcut form (`opus`). The full id comes from the parent transcript. */
  readonly model?: string;
  /** Absent on a root; observed absent, never empty, on this machine. */
  readonly parentAgentId?: string;
  /** As written by Claude Code. `undefined` only if the key were ever missing. */
  readonly spawnDepth?: number;
  readonly toolUseId?: string;
  /** User-authored. Hover card only, capped, never persisted. */
  readonly description?: string;
  /** Set when the agent lives under `subagents/workflows/<runId>/`. */
  readonly workflowRunId?: string;
}

/** One `agent-<id>.jsonl` found on disk. */
export interface AgentTranscriptFile {
  readonly agentId: string;
  readonly file: string;
  readonly workflowRunId?: string;
}

/**
 * A `subagents/workflows/<runId>/` directory. Not observed on this machine
 * (0 of 33 session directories had one), so the shape is handled defensively:
 * a run whose directory carries meta files contributes ordinary agents tagged
 * with its `runId`; a run with none is still surfaced, as a group with no
 * members, rather than being silently dropped.
 */
export interface WorkflowRun {
  readonly runId: string;
  readonly dir: string;
  readonly agentIds: readonly string[];
}

export interface SubagentsScan {
  readonly metas: readonly AgentMeta[];
  readonly transcripts: readonly AgentTranscriptFile[];
  readonly workflowRuns: readonly WorkflowRun[];
  /** Files that looked like ours but could not be parsed. */
  readonly warnings: number;
  /** True when the directory is absent, which is the normal case. */
  readonly missingDirectory: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/**
 * Parse one meta file. `fileName` supplies the id, because the file name is the
 * agent's identity everywhere else (the transcript is named after it, and so is
 * `toolUseResult.agentId`). Returns `undefined` for anything unparseable.
 */
export function parseAgentMeta(
  fileName: string,
  raw: string,
  workflowRunId?: string,
): AgentMeta | undefined {
  const id = agentIdFromMetaFileName(fileName);
  if (id === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const meta: {
    -readonly [K in keyof AgentMeta]: AgentMeta[K];
  } = { id };

  const agentType = readString(parsed['agentType']);
  if (agentType !== undefined) meta.agentType = agentType;
  const model = readString(parsed['model']);
  if (model !== undefined) meta.model = model;
  // A root writes no `parentAgentId` at all on this machine; the WP0 audit also
  // saw it as an empty string, so both spellings mean "root".
  const parentAgentId = readString(parsed['parentAgentId']);
  if (parentAgentId !== undefined) meta.parentAgentId = parentAgentId;
  const spawnDepth = parsed['spawnDepth'];
  if (typeof spawnDepth === 'number' && Number.isFinite(spawnDepth)) meta.spawnDepth = spawnDepth;
  const toolUseId = readString(parsed['toolUseId']);
  if (toolUseId !== undefined) meta.toolUseId = toolUseId;
  const description = readString(parsed['description'], MAX_DESCRIPTION_LENGTH);
  if (description !== undefined) meta.description = description;
  if (workflowRunId !== undefined) meta.workflowRunId = workflowRunId;

  return meta;
}

interface DirScan {
  readonly metas: AgentMeta[];
  readonly transcripts: AgentTranscriptFile[];
  warnings: number;
}

async function scanAgentFiles(dir: string, workflowRunId: string | undefined): Promise<DirScan> {
  const out: DirScan = { metas: [], transcripts: [], warnings: 0 };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }

  for (const name of names) {
    const transcriptId = agentIdFromTranscriptFileName(name);
    if (transcriptId !== undefined) {
      const entry: { agentId: string; file: string; workflowRunId?: string } = {
        agentId: transcriptId,
        file: path.join(dir, name),
      };
      if (workflowRunId !== undefined) entry.workflowRunId = workflowRunId;
      out.transcripts.push(entry);
      continue;
    }
    if (agentIdFromMetaFileName(name) === undefined) continue;

    let raw: string;
    try {
      raw = await readFile(path.join(dir, name), 'utf8');
    } catch {
      // The session was cleaned up between readdir and readFile.
      continue;
    }
    const meta = parseAgentMeta(name, raw, workflowRunId);
    if (meta === undefined) {
      out.warnings += 1;
      continue;
    }
    out.metas.push(meta);
  }

  return out;
}

/**
 * Read one session's `subagents/` directory, workflow runs included. A missing
 * directory is the normal state of a session that never spawned a subagent and
 * is reported, not thrown.
 */
export async function readSubagentsDir(
  subagentsDir: string,
  workflowsDirName = 'workflows',
): Promise<SubagentsScan> {
  let entries;
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      metas: [],
      transcripts: [],
      workflowRuns: [],
      warnings: code === 'ENOENT' || code === 'ENOTDIR' ? 0 : 1,
      missingDirectory: code === 'ENOENT' || code === 'ENOTDIR',
    };
  }

  const top = await scanAgentFiles(subagentsDir, undefined);
  const metas = [...top.metas];
  const transcripts = [...top.transcripts];
  let warnings = top.warnings;
  const workflowRuns: WorkflowRun[] = [];

  const hasWorkflows = entries.some(
    (entry) => entry.isDirectory() && entry.name === workflowsDirName,
  );
  if (hasWorkflows) {
    const workflowsDir = path.join(subagentsDir, workflowsDirName);
    let runs: string[] = [];
    try {
      runs = (await readdir(workflowsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      runs = [];
    }
    for (const runId of runs.sort()) {
      const runDir = path.join(workflowsDir, runId);
      const scan = await scanAgentFiles(runDir, runId);
      metas.push(...scan.metas);
      transcripts.push(...scan.transcripts);
      warnings += scan.warnings;
      const agentIds = [
        ...new Set([
          ...scan.metas.map((meta) => meta.id),
          ...scan.transcripts.map((entry) => entry.agentId),
        ]),
      ].sort();
      workflowRuns.push({ runId, dir: runDir, agentIds });
    }
  }

  metas.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  transcripts.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));

  return { metas, transcripts, workflowRuns, warnings, missingDirectory: false };
}
