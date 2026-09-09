/**
 * Nazar canvas. SVG and CSS only: no framework, no WebGL
 * (docs/PROJECT.md section 3).
 *
 * This entry point carries the *pure* half of the package — layout maths, card
 * packing, the persisted workspace model, the keyboard map, formatting, theme
 * validation, demo data — so every rule is testable in Node. The DOM half lives
 * in `web/` and is bundled straight to `dist/web/bundle.js` by `build.mjs`; it
 * is never imported from here.
 */
export {
  MAX_SCALE,
  MIN_CARD_WIDTH,
  MIN_SCALE,
  RESIZE_HANDLES,
  boundsOf,
  cardMinimum,
  cardSize,
  changesHeight,
  changesWidth,
  clampCardHeight,
  clampCardWidth,
  clampScale,
  columnsFor,
  edgePath,
  fitToBox,
  initialViewport,
  isCornerHandle,
  isResizeHandle,
  layerTree,
  maxCardHeight,
  maxCardWidth,
  minCardHeight,
  patternOffset,
  patternTransform,
  pullsNorth,
  pullsWest,
  resizeCard,
  screenToCanvas,
  treeMaxWidth,
  zoomAt,
} from './layout.js';
export type {
  Box,
  CardBox,
  CardMinimum,
  CardSizeOptions,
  CardSpec,
  PatternOffset,
  PlacedTreeNode,
  Point,
  ResizeBounds,
  ResizeBox,
  ResizeHandle,
  TreeEdge,
  TreeInput,
  TreeLayout,
  TreeSpec,
  Viewport,
} from './layout.js';

export { finishedAgentIds, hiddenLabel, hideAgents } from './hidden.js';
export type { HiddenResult } from './hidden.js';

/* N-WP20: the two lines an empty canvas shows instead of "no sessions found". */
export { emptyStateLines } from './empty.js';
export type { EmptyStateLines } from './empty.js';

/*
 * WP4g: the name a card carries. N-WP20 puts `pruneNames` on the public surface
 * beside `pruneLayout` and `pruneTabs`, which were always here — the three are
 * pruned by one rule from one set of ids, and leaving one of them off meant the
 * test that checks that rule end to end could not reach it.
 */
export { MAX_NAME_LENGTH, NAMES_KEY, cleanName, nameOf, pruneNames, readNames, withName, writeNames } from './names.js';
export type { NamesState } from './names.js';

export { boundsOfPlacements, firstFreeSlot, overlaps, packShelves, shelfWidth } from './pack.js';
export type { PackResult, PackSpec, Placement, SizedBox } from './pack.js';

export {
  ALL_TAB,
  EMPTY_LAYOUT,
  EMPTY_TABS,
  LAYOUT_KEY,
  TABS_KEY,
  cleanTabName,
  clearedFor,
  createTab,
  guarded,
  heightOf,
  isCollapsed,
  isSized,
  memoryStorage,
  moveSession,
  pruneLayout,
  pruneTabs,
  readLayout,
  readTabs,
  removeTab,
  renameTab,
  sessionsOnTab,
  setActiveTab,
  tabCounts,
  tabOf,
  widthOf,
  withAutoSize,
  withCleared,
  withCollapsed,
  withHeight,
  withPosition,
  withRestored,
  withWidth,
  writeLayout,
  writeTabs,
} from './workspace.js';
export type { LayoutState, StorageLike, TabDef, TabsState } from './workspace.js';

export { shortcutFor, shortcutLabel } from './shortcuts.js';
export type { KeyLike, ShortcutAction } from './shortcuts.js';

/* N-WP13: the six UI languages. The catalogues themselves are JSON under
   `packages/ui/locales/`; this is the runtime that reads them. */
export {
  FALLBACK_LOCALE,
  LOCALES,
  LOCALE_KEY,
  currentLocale,
  installCatalogs,
  interpolate,
  isLocale,
  pluralCategory,
  pluralKey,
  primarySubtag,
  readLocaleChoice,
  resolveLocale,
  setLocale,
  t,
  tCount,
  writeLocaleChoice,
} from './i18n.js';
export type { Catalog, Catalogs, Locale, Params, PluralCategory } from './i18n.js';

export {
  ACTIVITIES,
  ACTIVITY_CLASSES,
  RECENT_WRITE_MS,
  activityClass,
  activityLabel,
  activityOf,
  agentActivity,
  isWaiting,
  sessionActivity,
} from './activity.js';
export type {
  Activity,
  ActivityNode,
  ActivitySessionStatus,
  AgentActivityLike,
  AgentActivityNode,
  SessionActivityLike,
  SessionActivityNode,
  WaitingLike,
} from './activity.js';

/* N-WP21: who is waiting for you, for how long, and what just finished. */
export {
  FINISHED_WINDOW_MS,
  NO_NEEDS_YOU,
  finishedRows,
  finishedTitle,
  needsYouAnnouncement,
  needsYouBadge,
  needsYouEmpty,
  needsYouTitle,
  observeSessions,
  waitingForLabel,
  waitingRows,
} from './needs-you.js';
export type {
  FinishedRow,
  FinishedSince,
  NeedsYouAgent,
  NeedsYouBadge,
  NeedsYouSession,
  NeedsYouState,
  WaitSince,
  WaitingRow,
} from './needs-you.js';

/*
 * N-WP17a. `hostLabel` is on this list for one reason: **two** places draw it —
 * the card's title line and the Needs-you strip — and the label has to be the
 * same characters in both, or the canvas looks like it is describing two
 * different machines. It is the same argument `isWaiting` won in N-WP21.
 */
export {
  MAX_HOST_LABEL,
  hostLabel,
  hostTitle,
  unknownWord,
  basename,
  cardContextLabel,
  cardCostLabel,
  formatAge,
  formatContextWindow,
  formatCostUsd,
  formatCount,
  formatDuration,
  formatElapsed,
  formatTokens,
  modelChip,
  orUnknown,
  pidLabel,
  summarize,
  summaryChips,
} from './format.js';
export type { ContextLike, StateLike, TokenLike, TreeSummary } from './format.js';

export {
  BEAD_KEYS,
  HEX_COLOR,
  MODE_KEYS,
  NOTE_KEYS,
  STATE_KEYS,
  THEME_MODES,
  TYPOGRAPHY_KEYS,
  assertTheme,
  channelDistance,
  contrastRatio,
  kebab,
  modeVariables,
  relativeLuminance,
  staticVariables,
  themeCss,
} from './theme.js';
export type {
  BeadKey,
  ModeKey,
  ModeTokens,
  NoteKey,
  StateKey,
  Theme,
  ThemeMode,
  TypographyKey,
} from './theme.js';

/* WP4e: the user's own frame colours, over whatever the theme says. */
export {
  COLOURS_KEY,
  COLOUR_KEYS,
  COLOUR_LABEL_KEYS,
  colourLabel,
  NON_TEXT_MINIMUM,
  NO_COLOURS,
  cleanColour,
  colourApplication,
  colourVariable,
  contrastHint,
  isColour,
  overriddenCount,
  readColours,
  withColour,
  withoutColour,
  writeColours,
} from './colours.js';
export type { ColourApplication, ColourOverrides, ContrastHint } from './colours.js';

/* WP4e: sticky notes, per tab, in the browser and nowhere else. */
export {
  EMPTY_NOTES,
  MAX_NOTE_LENGTH,
  NOTES_KEY,
  NOTE_COLOURS,
  NOTE_COLOUR_CLASSES,
  NOTE_SIZE,
  addNote,
  clampSize,
  cleanNoteColour,
  cleanNoteText,
  nextNoteId,
  noteColourClass,
  noteCounts,
  noteVariable,
  notesOnTab,
  reassignNotes,
  readNotes,
  remaining,
  removeNote,
  updateNote,
  writeNotes,
} from './notes.js';
export type { NewNote, Note, NoteColour, NotesState } from './notes.js';

/* The mark itself, as sixteen rows of sixteen cells. Direction 04, docs/design. */
export {
  BEAD_COLOURS,
  BEAD_GRID,
  BEAD_LAYERS,
  BEAD_SIZE,
  BEAD_TOKENS,
  beadCellIsSet,
  beadCellLayer,
  beadFillRows,
  beadLayerPath,
  beadPathOf,
  beadRingPath,
  beadSolidPath,
} from './bead.js';
export type { BeadLayer } from './bead.js';

/* WP4e: what a right-click means, and where a browser menu is left alone. */
export {
  CANVAS_MENU_ITEMS,
  contextActionOf,
  opensOwnMenu,
  suppressesNativeMenu,
} from './contextmenu.js';
export type { CanvasMenuItem, ContextAction, ContextHit } from './contextmenu.js';

/* WP4e: the strip, collapsed to one bead and a panel behind it. */
export {
  usageExplainer,
  USAGE_KEY,
  usageNone,
  usageTitle,
  beadItem,
  readUsageOpen,
  usageBead,
  usageBeadOf,
  writeUsageOpen,
} from './usage-popover.js';
export type { UsageBead } from './usage-popover.js';

export {
  DEFAULT_SOUND,
  MINUTES_IN_A_DAY,
  SOUND_CLIP_URL,
  SOUND_DEBOUNCE_MS,
  SOUND_KEY,
  SOUND_OPENING_SILENCE_MS,
  SoundPlayer,
  SoundRules,
  inQuietHours,
  minutesOfDay,
  newlyWaiting,
  parseClock,
  readSound,
  soundDecision,
  waitingIds,
  writeSound,
} from './sound.js';
export type {
  SoundAudioContext,
  SoundDecision,
  SoundEvent,
  SoundGate,
  SoundKind,
  SoundPlayerOptions,
  SoundReason,
  SoundRulesOptions,
  SoundSettings,
  SoundSourceNode,
  WaitingSession,
} from './sound.js';

export { forestOf, makeDemoState } from './demo.js';
export type { DemoOptions } from './demo.js';

export { makeDemoQuota } from './demo-quota.js';
export type { DemoQuotaSource } from './demo-quota.js';

/* WP5: the quota strip's pure half. */
export {
  AGING_MS,
  AMBER_AT_PERCENT,
  FRESH_MS,
  RED_AT_PERCENT,
  ageLabel,
  barPercent,
  countdownLabel,
  freshnessClass,
  freshnessOf,
  hasQuota,
  itemLabel,
  percentLabel,
  providerLabel,
  quotaItems,
  quotaSourceLabel,
  severityClass,
  severityForPercent,
  severityOf,
  windowLabel,
} from './quota-strip.js';
export type {
  Freshness,
  ProviderLike,
  QuotaItem,
  QuotaLike,
  Severity,
  WindowLike,
} from './quota-strip.js';
