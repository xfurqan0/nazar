/**
 * Synthetic history for `?demo=1`.
 *
 * The live demo (`demo.ts`) freezes its clock at the snapshot's own
 * `generatedAt` so relative ages do not move between two screenshots. History
 * shows *absolute* times, so the epoch itself has to be fixed as well, or the
 * same screenshot taken tomorrow carries a different date.
 *
 * It reproduces the panel's *behaviour*, not only its shape: a row is
 * unhydrated until it has been opened, and opening it fills the measured
 * columns in. That is the honest state — a listing has read no transcript, so
 * it cannot claim a token count — and a screenshot of the panel shows both.
 */
import type {
  Agent,
  History,
  HistoryListPage,
  HistorySummary,
  SessionTokens,
} from '@nazar/core';

import { forestOf } from './demo.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The moment the demo history is drawn at. Fixed, so screenshots agree. */
export const DEMO_HISTORY_EPOCH = Date.UTC(2026, 8, 6, 18, 46, 0);

function tokens(inTokens: number, out: number, read: number, write: number): SessionTokens {
  return { in: inTokens, out, cacheRead: read, cacheWrite: write };
}

/** The same all-zero agent ids the live demo uses. Nothing here is real. */
const A = (n: number): string => `agent-a${String(n).padStart(16, '0')}`;

interface AgentSeed {
  readonly id: string;
  readonly parentAgentId?: string;
  readonly spawnDepth: number;
  readonly agentType: string;
  readonly model?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly tokens: SessionTokens;
  readonly toolCalls: number;
}

interface HistorySeed {
  readonly sessionId: string;
  readonly project: string;
  /** Hours before {@link DEMO_HISTORY_EPOCH} the last line was written. */
  readonly endedHoursAgo: number;
  readonly ranMinutes: number;
  readonly transcriptBytes: number;
  readonly model: string;
  readonly effort: string;
  readonly toolCalls: number;
  readonly tokens: SessionTokens;
  readonly agents: readonly AgentSeed[];
}

const SEEDS: readonly HistorySeed[] = [
  {
    sessionId: '7f3a1c04-0000-4000-8000-0000000000a1',
    project: 'C--proj-nazar',
    endedHoursAgo: 2,
    ranMinutes: 214,
    transcriptBytes: 6_412_800,
    model: 'claude-opus-5[1m]',
    effort: 'high',
    toolCalls: 486,
    tokens: tokens(41_902, 154_100, 8_214_507, 402_440),
    agents: [
      {
        id: A(31),
        spawnDepth: 1,
        agentType: 'general-purpose',
        model: 'opus',
        modelId: 'claude-opus-5[1m]',
        effort: 'high',
        tokens: tokens(9_204, 24_133, 1_188_402, 92_288),
        toolCalls: 118,
      },
      {
        id: A(32),
        parentAgentId: A(31),
        spawnDepth: 2,
        agentType: 'Explore',
        model: 'sonnet',
        modelId: 'claude-sonnet-5',
        effort: 'medium',
        tokens: tokens(3_902, 8_744, 461_004, 24_096),
        toolCalls: 47,
      },
      {
        id: A(33),
        parentAgentId: A(32),
        spawnDepth: 3,
        agentType: 'Explore',
        model: 'haiku',
        modelId: 'claude-haiku-4-5-20251001',
        tokens: tokens(1_612, 3_208, 118_440, 9_024),
        toolCalls: 16,
      },
      {
        id: A(34),
        spawnDepth: 1,
        agentType: 'code-review',
        model: 'opus',
        modelId: 'claude-opus-5[1m]',
        effort: 'high',
        tokens: tokens(6_301, 11_580, 722_880, 48_192),
        toolCalls: 64,
      },
      {
        id: A(35),
        parentAgentId: A(34),
        spawnDepth: 2,
        agentType: 'general-purpose',
        model: 'sonnet',
        modelId: 'claude-sonnet-5',
        tokens: tokens(2_880, 5_402, 230_720, 12_048),
        toolCalls: 29,
      },
    ],
  },
  {
    sessionId: '2b91de55-0000-4000-8000-0000000000a2',
    project: 'C--proj-nazar',
    endedHoursAgo: 21,
    ranMinutes: 46,
    transcriptBytes: 1_204_224,
    model: 'claude-sonnet-5',
    effort: 'medium',
    toolCalls: 91,
    tokens: tokens(12_044, 24_216, 1_402_112, 74_576),
    agents: [
      {
        id: A(41),
        spawnDepth: 1,
        agentType: 'general-purpose',
        model: 'sonnet',
        modelId: 'claude-sonnet-5',
        effort: 'medium',
        tokens: tokens(4_204, 6_012, 271_680, 16_144),
        toolCalls: 38,
      },
      {
        id: A(42),
        spawnDepth: 1,
        agentType: 'Explore',
        model: 'haiku',
        modelId: 'claude-haiku-4-5-20251001',
        tokens: tokens(1_704, 2_288, 90_480, 5_024),
        toolCalls: 12,
      },
    ],
  },
  {
    sessionId: 'c40e7b12-0000-4000-8000-0000000000a3',
    project: 'C--proj-nazar-tray',
    endedHoursAgo: 29,
    ranMinutes: 132,
    transcriptBytes: 3_985_408,
    model: 'claude-opus-5[1m]',
    effort: 'xhigh',
    toolCalls: 265,
    tokens: tokens(28_118, 74_402, 3_284_507, 161_440),
    agents: [
      {
        id: A(51),
        spawnDepth: 1,
        agentType: 'general-purpose',
        model: 'opus',
        modelId: 'claude-opus-5[1m]',
        effort: 'xhigh',
        tokens: tokens(7_820, 15_133, 688_402, 42_288),
        toolCalls: 81,
      },
      {
        id: A(52),
        spawnDepth: 1,
        agentType: 'claude-code-guide',
        model: 'haiku',
        modelId: 'claude-haiku-4-5-20251001',
        tokens: tokens(902, 1_744, 41_004, 3_096),
        toolCalls: 9,
      },
      {
        id: A(53),
        parentAgentId: A(51),
        spawnDepth: 2,
        agentType: 'Explore',
        model: 'sonnet',
        modelId: 'claude-sonnet-5',
        tokens: tokens(2_212, 4_074, 126_144, 8_512),
        toolCalls: 24,
      },
    ],
  },
  {
    sessionId: '9d5a02ef-0000-4000-8000-0000000000a4',
    project: 'C--proj-dile',
    endedHoursAgo: 51,
    ranMinutes: 18,
    transcriptBytes: 421_888,
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    toolCalls: 22,
    tokens: tokens(3_070, 6_128, 188_064, 9_096),
    agents: [],
  },
  {
    // A project under the home directory: the scanner collapses the home slug
    // to `~`, so the listing never shows the account name.
    sessionId: '11c8f4a7-0000-4000-8000-0000000000a5',
    project: '~/AppData-Local-Temp-nazar-smoke',
    endedHoursAgo: 76,
    ranMinutes: 4,
    transcriptBytes: 63_488,
    model: 'claude-sonnet-5',
    effort: 'medium',
    toolCalls: 6,
    tokens: tokens(806, 1_190, 22_288, 2_024),
    agents: [],
  },
];

function sumTokens(base: SessionTokens, agents: readonly Agent[]): SessionTokens {
  return agents.reduce<SessionTokens>(
    (sum, agent) => ({
      in: (sum.in ?? 0) + (agent.tokens?.in ?? 0),
      out: (sum.out ?? 0) + (agent.tokens?.out ?? 0),
      cacheRead: (sum.cacheRead ?? 0) + (agent.tokens?.cacheRead ?? 0),
      cacheWrite: (sum.cacheWrite ?? 0) + (agent.tokens?.cacheWrite ?? 0),
    }),
    base,
  );
}

function historyOf(seed: HistorySeed): History {
  const lastWriteAt = DEMO_HISTORY_EPOCH - seed.endedHoursAgo * HOUR;
  const firstWriteAt = lastWriteAt - seed.ranMinutes * MINUTE;

  // Every agent in a frozen tree is finished, by construction: nothing will
  // ever be appended to a session that ended.
  const agents = seed.agents.map((one, index): Agent => {
    const startedAt = Math.round(
      firstWriteAt + ((index + 1) * seed.ranMinutes * MINUTE) / (seed.agents.length + 2),
    );
    const durationMs = Math.round(((index % 4) + 1) * 3.5 * MINUTE + 27_000);
    const agent: {
      -readonly [K in keyof Agent]: Agent[K];
    } = {
      id: one.id,
      sessionId: seed.sessionId,
      spawnDepth: one.spawnDepth,
      agentType: one.agentType,
      state: 'done',
      doneSignal: 'parent-result',
      startedAt,
      endedAt: startedAt + durationMs,
      durationMs,
      tokens: one.tokens,
      toolCalls: one.toolCalls,
    };
    if (one.parentAgentId !== undefined) agent.parentAgentId = one.parentAgentId;
    if (one.model !== undefined) agent.model = one.model;
    if (one.modelId !== undefined) agent.modelId = one.modelId;
    if (one.effort !== undefined) agent.effort = one.effort;
    return agent;
  });

  return {
    sessionId: seed.sessionId,
    project: seed.project,
    firstWriteAt,
    lastWriteAt,
    durationMs: seed.ranMinutes * MINUTE,
    model: seed.model,
    effort: seed.effort,
    tokens: seed.tokens,
    treeTokens: sumTokens(seed.tokens, agents),
    toolCalls: seed.toolCalls,
    agentCount: agents.length,
    agents,
    roots: forestOf(agents),
    orphans: [],
    dedupeFallbacks: 0,
    bytesRead: seed.transcriptBytes,
  };
}

function summaryOf(seed: HistorySeed, hydrated: boolean): HistorySummary {
  const summary: {
    -readonly [K in keyof HistorySummary]: HistorySummary[K];
  } = {
    sessionId: seed.sessionId,
    project: seed.project,
    transcriptBytes: seed.transcriptBytes,
    lastWriteAt: DEMO_HISTORY_EPOCH - seed.endedHoursAgo * HOUR,
    agentCount: seed.agents.length,
    hydrated,
  };
  if (!hydrated) return summary;

  const full = historyOf(seed);
  if (full.firstWriteAt !== undefined) summary.firstWriteAt = full.firstWriteAt;
  if (full.durationMs !== undefined) summary.durationMs = full.durationMs;
  summary.model = seed.model;
  summary.tokens = seed.tokens;
  if (full.treeTokens !== undefined) summary.treeTokens = full.treeTokens;
  return summary;
}

/** The session ids the demo listing offers, newest first. */
export const DEMO_HISTORY_IDS: readonly string[] = SEEDS.map((seed) => seed.sessionId);

export interface DemoHistorySource {
  list(limit: number): Promise<HistoryListPage>;
  open(sessionId: string): Promise<History | undefined>;
}

/** The `?demo=1` history source: the same two calls the real scanner answers. */
export function makeDemoHistory(): DemoHistorySource {
  const opened = new Set<string>();
  return {
    list: async (limit) => ({
      generatedAt: DEMO_HISTORY_EPOCH,
      total: SEEDS.length,
      offset: 0,
      sessions: SEEDS.slice(0, Math.max(1, limit)).map((seed) =>
        summaryOf(seed, opened.has(seed.sessionId)),
      ),
      projects: [...new Set(SEEDS.map((seed) => seed.project))],
      listMs: 18,
      warnings: 0,
    }),
    open: async (sessionId) => {
      const seed = SEEDS.find((one) => one.sessionId === sessionId);
      if (seed === undefined) return undefined;
      opened.add(sessionId);
      return historyOf(seed);
    },
  };
}
