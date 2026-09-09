/**
 * Synthetic state for `?demo=1`.
 *
 * Screenshots and the frame-rate check must not depend on what happens to be
 * running on the machine that takes them, so this module builds the same
 * canvas every time from the shapes in `fixtures/`: the same placeholder pids,
 * the same all-zero agent ids, the same `C:/proj/...` working directories.
 * Nothing here is read off disk and nothing here is real.
 *
 * The four sessions are chosen to cover the states that are easy to get
 * wrong rather than the states that look good:
 *
 * - one **waiting for a permission prompt**, which has to dominate the canvas;
 * - one whose process stopped answering (`state: 'unknown'`), which must read
 *   as *unknown* and never as `0`;
 * - one with a depth-3 tree, a finished agent, an agent with no transcript
 *   yet, and an orphan whose written parent does not resolve;
 * - one **alive and idle**, which is the state WP4d's activity frames exist to
 *   tell apart from *alive and working*.
 */
import type {
  Agent,
  AgentNode,
  SessionContextWindow,
  SessionTokens,
  SessionView,
  StateSnapshot,
} from '@nazar/core';

import type { DemoQuotaSource } from './demo-quota.js';
import { makeDemoQuota } from './demo-quota.js';

const MINUTE = 60_000;

/* ------------------------------------------------------------------ *
 * N-WP15a: invented task text
 * ------------------------------------------------------------------ */

/**
 * The tasks the demo canvas shows, and every one of them is made up.
 *
 * This is the one part of the demo where "nothing here is real" stops being a
 * convention and becomes a rule with a test behind it. Everything else in this
 * file is a number, an id or a placeholder path, and a slip would produce a
 * screenshot with a wrong pid in it. These are *sentences*, and a slip would
 * produce a screenshot of what somebody was actually working on — which is the
 * single worst thing this repository could publish, because a demo screenshot
 * is exactly what ends up in a README.
 *
 * So they are written here, by hand, about work that does not exist, and
 * `test/demo.test.ts` asserts that every task the demo state carries came out
 * of one of these three lists. Nothing is read from a machine, a transcript, a
 * fixture or an environment variable to build them.
 */
export const DEMO_TASKS: readonly string[] = [
  'Sweep the repository for secrets before the public flip',
  'Work out why the canvas empties itself when the socket drops',
  'Rewrite the release notes so a stranger can follow them',
  'Find every place the port is assumed to be the default one',
  'Make the frozen tree read the same tomorrow as it does today',
];

/** The briefs a subagent's hover card shows: longer, and equally invented. */
export const DEMO_BRIEFS: readonly string[] = [
  'Read every file under packages/ and list the ones that could write to disk, with the call that would do it. Report the list; change nothing.',
  'Map how a snapshot travels from the reader to the browser and name each place a field could be dropped without anybody noticing.',
  'Check the six catalogues against each other: same keys, same placeholders, and a complete set of plural forms for every counted key.',
  'Reproduce the resize bug at 200 % zoom, then say which of the eight handles is taking the press it should not.',
  'Compare the two ways a session can be found and describe what each one knows that the other does not.',
];

/** The three-to-five-word labels the `Agent` tool writes as its description. */
export const DEMO_AGENT_LABELS: readonly string[] = [
  'Secret sweep',
  'Trace the snapshot',
  'Catalogue parity check',
  'Resize handle repro',
  'Compare the two sources',
];

/**
 * Pick one entry for an id, deterministically.
 *
 * The demo has to be identical from one run to the next — that is the whole
 * reason it exists — so this is a character sum rather than the shared
 * `mulberry` generator, whose state depends on how many times it has been
 * called and therefore on the order the seeds happen to be walked in.
 */
function pickFor<T>(list: readonly T[], key: string): T {
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum = (sum + key.charCodeAt(i) * (i + 1)) % 65_536;
  return list[sum % list.length] as T;
}

/** Deterministic pseudo-random, so a generated canvas is the same every run. */
function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tokens(inTokens: number, out: number, read: number, write: number): SessionTokens {
  return { in: inTokens, out, cacheRead: read, cacheWrite: write };
}

interface AgentSeed {
  readonly id: string;
  readonly parentAgentId?: string;
  readonly spawnDepth: number;
  readonly agentType: string;
  readonly model?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly currentTool?: string;
  readonly tokens?: SessionTokens;
  readonly toolCalls?: number;
  readonly startedMinutesAgo?: number;
  readonly writeSecondsAgo?: number;
  readonly orphan?: boolean;
  readonly state: Agent['state'];
  /** Which WP4b signal ended it. Defaults to the quiet closing turn. */
  readonly doneSignal?: Agent['doneSignal'];
}

function buildAgents(sessionId: string, seeds: readonly AgentSeed[], now: number): Agent[] {
  return seeds.map((seed) => {
    const agent: {
      -readonly [K in keyof Agent]: Agent[K];
    } = {
      id: seed.id,
      sessionId,
      spawnDepth: seed.spawnDepth,
      agentType: seed.agentType,
      state: seed.state,
    };
    if (seed.parentAgentId !== undefined) agent.parentAgentId = seed.parentAgentId;
    if (seed.model !== undefined) agent.model = seed.model;
    if (seed.modelId !== undefined) agent.modelId = seed.modelId;
    if (seed.effort !== undefined) agent.effort = seed.effort;
    if (seed.currentTool !== undefined) agent.currentTool = seed.currentTool;
    if (seed.tokens !== undefined) agent.tokens = seed.tokens;
    if (seed.toolCalls !== undefined) agent.toolCalls = seed.toolCalls;
    if (seed.orphan !== undefined) agent.orphan = seed.orphan;
    // N-WP15a. Every demo agent carries both, so a screenshot taken with the
    // setting on shows the feature rather than a canvas of blank lines. The
    // canvas still only draws them when the switch is on.
    agent.description = pickFor(DEMO_AGENT_LABELS, seed.id);
    agent.task = pickFor(DEMO_BRIEFS, seed.id);
    if (seed.startedMinutesAgo !== undefined) {
      agent.startedAt = now - seed.startedMinutesAgo * MINUTE;
    }
    if (seed.writeSecondsAgo !== undefined) {
      agent.lastWriteAt = now - seed.writeSecondsAgo * 1000;
      agent.writeAgeMs = seed.writeSecondsAgo * 1000;
    }
    // A finished agent knows when it stopped and how long it ran — that is the
    // whole content of WP4b's `done · 12m 03s` chip, so the demo has to carry
    // it or the screenshot shows a chip saying `unknown`.
    if (seed.state === 'done' && agent.startedAt !== undefined && agent.lastWriteAt !== undefined) {
      agent.endedAt = agent.lastWriteAt;
      agent.durationMs = Math.max(0, agent.lastWriteAt - agent.startedAt);
      agent.doneSignal = seed.doneSignal ?? 'quiet-turn';
    }
    return agent;
  });
}

/** Hang the flat list into the forest the layout draws. */
export function forestOf(agents: readonly Agent[]): AgentNode[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];

  for (const agent of agents) {
    const parent = agent.parentAgentId;
    if (parent === undefined || !byId.has(parent) || agent.orphan === true) {
      roots.push(agent);
      continue;
    }
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [agent]);
    else list.push(agent);
  }

  const build = (agent: Agent): AgentNode => ({
    agent,
    children: (children.get(agent.id) ?? []).map(build),
  });

  return roots.map(build);
}

interface SessionSeed {
  readonly id: string;
  readonly pid: number;
  readonly cwd: string;
  readonly name: string;
  readonly status: SessionView['status'];
  readonly waitingFor?: string;
  readonly state: SessionView['state'];
  readonly source: SessionView['source'];
  readonly model?: string;
  readonly effort?: string;
  readonly currentTool?: string;
  readonly tokens?: SessionTokens;
  readonly toolCalls?: number;
  readonly startedMinutesAgo?: number;
  readonly writeSecondsAgo?: number;
  readonly agents: readonly AgentSeed[];
  readonly orphans?: readonly string[];
  readonly treeRead?: boolean;
  /**
   * WP3': what a status-line capture would say about this session. Filled only
   * when the demo is asked for a quota source, because both come from the same
   * wrapper — a machine with no capture has neither of them, and the canvas has
   * to be able to show that state too.
   */
  readonly costUsd?: number;
  readonly contextWindow?: SessionContextWindow;
}

function buildSession(seed: SessionSeed, now: number, captures: boolean): SessionView {
  const agents = buildAgents(seed.id, seed.agents, now);
  const roots = forestOf(agents);

  const view: {
    -readonly [K in keyof SessionView]: SessionView[K];
  } = {
    id: seed.id,
    provider: 'claude',
    pid: seed.pid,
    cwd: seed.cwd,
    kind: 'interactive',
    name: seed.name,
    status: seed.status,
    state: seed.state,
    source: seed.source,
    lastSeenAt: now,
    version: '2.1.263',
    agents,
    roots,
    orphans: seed.orphans ?? [],
    treeRead: seed.treeRead ?? true,
  };

  if (seed.waitingFor !== undefined) view.waitingFor = seed.waitingFor;
  if (seed.model !== undefined) view.model = seed.model;
  if (seed.effort !== undefined) view.effort = seed.effort;
  if (seed.currentTool !== undefined) view.currentTool = seed.currentTool;
  // N-WP15a: invented, from the list above, and keyed on the session id so the
  // same card shows the same task on every run.
  view.task = pickFor(DEMO_TASKS, seed.id);
  if (seed.tokens !== undefined) {
    view.tokens = seed.tokens;
    view.treeTokens = agents.reduce<SessionTokens>(
      (sum, agent) => ({
        in: (sum.in ?? 0) + (agent.tokens?.in ?? 0),
        out: (sum.out ?? 0) + (agent.tokens?.out ?? 0),
        cacheRead: (sum.cacheRead ?? 0) + (agent.tokens?.cacheRead ?? 0),
        cacheWrite: (sum.cacheWrite ?? 0) + (agent.tokens?.cacheWrite ?? 0),
      }),
      seed.tokens,
    );
  }
  if (seed.toolCalls !== undefined) view.toolCalls = seed.toolCalls;
  if (seed.startedMinutesAgo !== undefined) {
    view.startedAt = now - seed.startedMinutesAgo * MINUTE;
  }
  if (seed.writeSecondsAgo !== undefined) {
    view.transcriptAt = now - seed.writeSecondsAgo * 1000;
    view.writeAgeMs = seed.writeSecondsAgo * 1000;
    view.lastWriteAt = view.transcriptAt;
    view.statusUpdatedAt = view.transcriptAt;
  }
  if (captures) {
    if (seed.costUsd !== undefined) view.costUsd = seed.costUsd;
    if (seed.contextWindow !== undefined) view.contextWindow = seed.contextWindow;
    if (seed.costUsd !== undefined || seed.contextWindow !== undefined) {
      view.capturedAt = now - 6 * 1000;
    }
  }

  return view;
}

const A = (n: number): string => `agent-a${String(n).padStart(16, '0')}`;

const SEEDS: readonly SessionSeed[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    pid: 1001,
    cwd: 'C:/proj/nazar',
    name: 'session-a',
    status: 'busy',
    state: 'alive',
    source: 'files+command',
    model: 'claude-opus-5[1m]',
    effort: 'high',
    currentTool: 'Agent',
    tokens: tokens(24_118, 9_402, 1_284_507, 61_440),
    toolCalls: 214,
    startedMinutesAgo: 137,
    writeSecondsAgo: 3,
    // The numbers in `fixtures/statusline-payload.json`, which is a real
    // capture with its paths replaced.
    costUsd: 9.60050075,
    contextWindow: { used: 159_283, size: 1_000_000, percent: 16 },
    agents: [
      {
        id: A(1),
        spawnDepth: 1,
        agentType: 'general-purpose',
        model: 'opus',
        modelId: 'claude-opus-5',
        effort: 'high',
        currentTool: 'Grep',
        tokens: tokens(4_820, 2_133, 188_402, 12_288),
        toolCalls: 41,
        startedMinutesAgo: 22,
        writeSecondsAgo: 2,
        state: 'running',
      },
      {
        id: A(2),
        parentAgentId: A(1),
        spawnDepth: 2,
        agentType: 'Explore',
        model: 'sonnet',
        modelId: 'claude-sonnet-5',
        effort: 'medium',
        currentTool: 'Read',
        tokens: tokens(1_902, 744, 61_004, 4_096),
        toolCalls: 17,
        startedMinutesAgo: 9,
        writeSecondsAgo: 5,
        state: 'running',
      },
      {
        id: A(3),
        parentAgentId: A(2),
        spawnDepth: 3,
        agentType: 'Explore',
        model: 'haiku',
        modelId: 'claude-haiku-5',
        tokens: tokens(612, 208, 18_440, 1_024),
        toolCalls: 6,
        startedMinutesAgo: 4,
        writeSecondsAgo: 41,
        state: 'done',
      },
      {
        id: A(4),
        spawnDepth: 1,
        agentType: 'code-review',
        model: 'opus',
        modelId: 'claude-opus-5',
        effort: 'high',
        currentTool: 'Bash',
        tokens: tokens(3_301, 1_580, 122_880, 8_192),
        toolCalls: 28,
        startedMinutesAgo: 15,
        writeSecondsAgo: 1,
        state: 'running',
      },
      {
        id: A(5),
        parentAgentId: A(4),
        spawnDepth: 2,
        agentType: 'general-purpose',
        model: 'sonnet',
        tokens: tokens(880, 402, 30_720, 2_048),
        toolCalls: 9,
        startedMinutesAgo: 6,
        writeSecondsAgo: 96,
        state: 'done',
      },
      {
        // No transcript has appeared for this one yet: every measured field is
        // absent, and the card has to say so.
        id: A(6),
        spawnDepth: 1,
        agentType: 'statusline-setup',
        state: 'unknown',
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    pid: 1002,
    cwd: 'C:/proj/nazar-tray',
    name: 'session-b',
    status: 'waiting',
    waitingFor: 'permission prompt',
    state: 'alive',
    source: 'files+command',
    model: 'claude-sonnet-5',
    effort: 'medium',
    currentTool: 'Bash',
    tokens: tokens(11_044, 4_216, 402_112, 24_576),
    toolCalls: 88,
    startedMinutesAgo: 41,
    writeSecondsAgo: 12,
    costUsd: 2.4471,
    contextWindow: { used: 412_904, size: 1_000_000, percent: 41 },
    agents: [
      {
        id: A(11),
        spawnDepth: 1,
        agentType: 'general-purpose',
        model: 'sonnet',
        modelId: 'claude-sonnet-5',
        effort: 'medium',
        currentTool: 'Edit',
        tokens: tokens(2_204, 1_012, 71_680, 6_144),
        toolCalls: 22,
        startedMinutesAgo: 12,
        writeSecondsAgo: 4,
        state: 'running',
      },
      {
        id: A(12),
        parentAgentId: A(11),
        spawnDepth: 2,
        agentType: 'Explore',
        model: 'haiku',
        tokens: tokens(704, 288, 20_480, 1_024),
        toolCalls: 7,
        startedMinutesAgo: 5,
        writeSecondsAgo: 8,
        state: 'running',
      },
      {
        id: A(13),
        spawnDepth: 1,
        agentType: 'Plan',
        model: 'opus',
        modelId: 'claude-opus-5',
        effort: 'high',
        tokens: tokens(1_488, 903, 55_296, 4_096),
        toolCalls: 11,
        startedMinutesAgo: 30,
        writeSecondsAgo: 420,
        state: 'done',
      },
      {
        id: A(14),
        spawnDepth: 1,
        agentType: 'general-purpose',
        model: 'sonnet',
        currentTool: 'WebSearch',
        tokens: tokens(980, 461, 28_672, 2_048),
        toolCalls: 8,
        startedMinutesAgo: 3,
        writeSecondsAgo: 2,
        state: 'running',
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    pid: 1003,
    cwd: 'C:/proj/dile',
    name: 'session-c',
    status: 'idle',
    // The process stopped answering a signal-0 probe on this pass. It survives
    // one liveness gate as `unknown` and is then dropped.
    state: 'unknown',
    source: 'files',
    model: 'claude-haiku-5',
    effort: 'low',
    tokens: tokens(3_070, 1_128, 88_064, 4_096),
    toolCalls: 19,
    startedMinutesAgo: 8,
    writeSecondsAgo: 184,
    agents: [
      {
        id: A(21),
        spawnDepth: 1,
        agentType: 'general-purpose',
        model: 'haiku',
        tokens: tokens(506, 190, 12_288, 1_024),
        toolCalls: 4,
        startedMinutesAgo: 6,
        writeSecondsAgo: 190,
        state: 'done',
      },
      {
        // Its `parentAgentId` names an agent with no meta file. It still
        // renders, attached to the session root, marked orphan.
        id: A(22),
        parentAgentId: A(99),
        spawnDepth: 2,
        agentType: 'Explore',
        model: 'haiku',
        orphan: true,
        tokens: tokens(212, 74, 6_144, 512),
        toolCalls: 2,
        startedMinutesAgo: 5,
        writeSecondsAgo: 240,
        state: 'unknown',
      },
    ],
    orphans: [A(22)],
  },
  {
    // WP4d: alive and *not* working. Before the activity frames this state had
    // no picture of its own — a live idle session looked exactly like a live
    // busy one — so the demo had no example of it either. It has one now,
    // because "which of these is working" cannot be answered by a canvas on
    // which nothing is resting.
    id: '00000000-0000-4000-8000-000000000004',
    pid: 1004,
    cwd: 'C:/proj/atlas',
    name: 'session-d',
    status: 'idle',
    state: 'alive',
    source: 'files+command',
    model: 'claude-sonnet-5',
    effort: 'medium',
    tokens: tokens(6_812, 2_904, 214_016, 12_288),
    toolCalls: 37,
    costUsd: 0.8125,
    contextWindow: { used: 88_402, size: 200_000, percent: 44 },
    startedMinutesAgo: 63,
    // Four minutes of silence: well outside the 30 s window that would promote
    // an idle session back to `working`.
    writeSecondsAgo: 240,
    agents: [
      {
        id: A(31),
        spawnDepth: 1,
        agentType: 'code-review',
        model: 'sonnet',
        modelId: 'claude-sonnet-5',
        effort: 'medium',
        tokens: tokens(1_640, 812, 47_104, 3_072),
        toolCalls: 14,
        startedMinutesAgo: 19,
        writeSecondsAgo: 300,
        state: 'done',
      },
      {
        id: A(32),
        parentAgentId: A(31),
        spawnDepth: 2,
        agentType: 'Explore',
        model: 'haiku',
        tokens: tokens(430, 168, 11_264, 1_024),
        toolCalls: 5,
        startedMinutesAgo: 16,
        writeSecondsAgo: 380,
        state: 'done',
      },
    ],
  },
];

export interface DemoOptions {
  /** Epoch ms the canvas is drawn at. Defaults to now. */
  readonly now?: number;
  /** Repeat the three fixture sessions until there are this many. */
  readonly sessions?: number;
  /** Extra generated agents per session, on top of the seeded ones. */
  readonly agentsPerSession?: number;
  /**
   * WP5. Which quota source to pretend is installed, or omitted for a machine
   * that has neither — which is what `?demo=1` alone shows, so every screenshot
   * taken before the strip existed still reproduces exactly.
   *
   * Both sources come with captures: nazar-tray ships the wrapper, and a
   * wrapper on its own is the other source. So asking for either also fills the
   * per-session cost and context window.
   */
  readonly quota?: DemoQuotaSource;
}

/**
 * The demo canvas. With no options: four sessions, fourteen agents, one session
 * waiting for a permission prompt and one resting. `sessions` and
 * `agentsPerSession` grow it for the frame-rate check.
 */
export function makeDemoState(options: DemoOptions = {}): StateSnapshot {
  const now = options.now ?? Date.now();
  // Zero is allowed and means "an empty canvas": the empty state is a state
  // the UI has to draw, so it has to be reachable from the demo too.
  const wanted = Math.max(0, options.sessions ?? SEEDS.length);
  const extra = Math.max(0, options.agentsPerSession ?? 0);
  const random = mulberry(0x5eed);

  const sessions: SessionView[] = [];
  for (let index = 0; index < wanted; index += 1) {
    const seed = SEEDS[index % SEEDS.length];
    if (seed === undefined) continue;
    const round = Math.floor(index / SEEDS.length);

    const grown: AgentSeed[] = [...seed.agents];
    for (let n = 0; n < extra; n += 1) {
      const parent = grown[Math.floor(random() * grown.length)];
      const depth = parent !== undefined && random() > 0.55 ? Math.min(3, parent.spawnDepth + 1) : 1;
      const agentSeed: AgentSeed = {
        id: `${A(500 + n)}-${index}`,
        ...(depth > 1 && parent !== undefined ? { parentAgentId: parent.id } : {}),
        spawnDepth: depth,
        agentType: 'general-purpose',
        model: 'sonnet',
        currentTool: 'Read',
        tokens: tokens(
          400 + Math.floor(random() * 4000),
          120 + Math.floor(random() * 1800),
          10_000 + Math.floor(random() * 90_000),
          1024 * (1 + Math.floor(random() * 8)),
        ),
        toolCalls: 1 + Math.floor(random() * 30),
        startedMinutesAgo: 1 + Math.floor(random() * 40),
        writeSecondsAgo: 1 + Math.floor(random() * 300),
        state: random() > 0.3 ? 'running' : 'done',
      };
      grown.push(agentSeed);
    }

    const suffix = round === 0 ? '' : `-${round + 1}`;
    sessions.push(
      buildSession(
        {
          ...seed,
          id: `${seed.id}${suffix}`,
          pid: seed.pid + round * 100,
          name: `${seed.name}${suffix}`,
          agents: grown.map((agent) => ({
            ...agent,
            id: `${agent.id}${suffix}`,
            ...(agent.parentAgentId === undefined
              ? {}
              : { parentAgentId: `${agent.parentAgentId}${suffix}` }),
          })),
          ...(seed.orphans === undefined
            ? {}
            : { orphans: seed.orphans.map((id) => `${id}${suffix}`) }),
        },
        now,
        options.quota !== undefined,
      ),
    );
  }

  const snapshot: {
    -readonly [K in keyof StateSnapshot]: StateSnapshot[K];
  } = { generatedAt: now, sessions, commandAvailable: true, warnings: 0 };
  // Absent unless asked for, which is the state of a machine with neither
  // nazar-tray nor the wrapper — and the state every screenshot taken before
  // WP5 was taken in.
  if (options.quota !== undefined) snapshot.quota = makeDemoQuota(options.quota, now);
  return snapshot;
}

/* ------------------------------------------------------------------ *
 * The fixtures the demo canvas dresses itself with (moved here by N-WP13)
 *
 * They used to sit in `web/app.ts`, where the i18n sweep found them and was
 * right to: a sentence in a page module is indistinguishable from one that
 * should have come out of a catalogue. These are neither. They are *demo data*
 * — the same category as the session names and the folder paths above — and
 * they are deliberately not translated, for the same reason a real session's
 * name is not: a screenshot of the demo is a picture of somebody's machine, and
 * a machine's own words are its own.
 * ------------------------------------------------------------------ */

/** One sticky note the `?demo=1&notes=1` canvas puts on screen. */
export interface DemoNote {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly colour: 1 | 2 | 3 | 4;
}

/**
 * Three notes, because three is enough to show that they are separate objects,
 * that they carry colours, and that one of them wraps. The words are the kind
 * of thing a note on this canvas is actually for — a reminder attached to a
 * place on a map — rather than lorem ipsum, which would prove nothing about the
 * width the text has to survive.
 */
export const DEMO_NOTES: readonly DemoNote[] = [
  {
    x: 790,
    y: 500,
    colour: 1,
    text: 'the long one on the left is the release build — leave it alone until the installer is signed',
  },
  { x: 1035, y: 500, colour: 3, text: 'weekly window resets Sunday 04:00' },
  {
    x: 1280,
    y: 500,
    colour: 4,
    text: 'waiting on a permission prompt again: check the sandbox rule before answering',
  },
];

/**
 * The two folders `?demo=1&projects=1` opens tabs for.
 *
 * `nazar-tray` is a *sibling* of `nazar` among the demo's four working
 * directories and must not be claimed by it; these two are what make that
 * visible in a still frame.
 */
export const DEMO_PROJECT_ROOTS: readonly string[] = ['C:/proj/nazar', 'C:/proj/dile'];

/** Two cards titled by their user rather than by their folder. */
export const DEMO_CARD_NAMES: readonly [string, string] = ['release build', 'tray installer'];
