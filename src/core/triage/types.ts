/**
 * Inbox Triage type definitions.
 *
 * Triage reads a BATCH of new mail and Slack, decides what each item means for
 * work the user already has, keeps the project tracking notes true, and asks the
 * user about anything that needs a decision. Every run is a NEW task + a NEW
 * session (the `claude-code` executor); the memory that carries across runs
 * lives in notes and in the agent's standing memory file, never in a long-lived
 * session — see docs and the `walnut-inbox-triage` skill.
 *
 * Shaped one-for-one on src/heartbeat/types.ts: a small config interface plus
 * DEFAULT_* constants, and the defaults live at the READER
 * (src/core/triage/config.ts), never in DEFAULT_CONFIG — config-manager spreads
 * the parsed file over its defaults at the TOP level, so anything seeded under a
 * key a real config.yaml already has is dropped.
 */

/** Which inbox a batch may draw from. */
export const TRIAGE_SOURCES = ['mail', 'slack'] as const;
export type TriageSource = (typeof TRIAGE_SOURCES)[number];

/**
 * How much a run may do on its own.
 *  - 'ask'    — only safe writes (notes, asking a task); every send / post /
 *               unsubscribe / mark-read goes to the user as a letter.
 *  - 'assist' — may also create and update tasks, update the tracking notes,
 *               one-click unsubscribe and mark mail read. Sending mail, posting
 *               to Slack and marking Slack read STILL need approval.
 */
export const TRIAGE_MODES = ['ask', 'assist'] as const;
export type TriageMode = (typeof TRIAGE_MODES)[number];

/** Triage configuration — lives under `config.triage` in config.yaml. */
export interface TriageConfig {
  /** Whether Inbox Triage is enabled. Default: false (opt-in). */
  enabled?: boolean;

  /**
   * Interval between timed batches as a duration string ("30m", "1h").
   * Clamped up to MIN_TRIAGE_EVERY_MS; "0" / "0m" disables triage entirely
   * (same vocabulary as `heartbeat.every`). Default: "30m".
   */
  every?: string;

  /**
   * Run early once this many new items have arrived (the routine's `wake`
   * threshold). 0 = the clock is the only trigger. Default: 20.
   */
  every_messages?: number;

  /**
   * Which inboxes feed a batch. An ABSENT key means both; an explicitly EMPTY
   * array means no event sources at all, which leaves the clock as the only
   * trigger. Default: ['mail', 'slack'].
   */
  sources?: TriageSource[];

  /** How much a run may do without asking. Default: 'ask'. */
  mode?: TriageMode;

  /**
   * Let an 'assist' run mark triaged mail as read. Slack is never auto-marked.
   * Default: false.
   */
  auto_mark_read?: boolean;

  /**
   * Only run inside this window — "HH:MM-HH:MM" in local time. An empty string
   * means 24/7. Default: "08:00-22:00" (a run writes letters a human reads).
   */
  active_hours?: string;
}

/** Default batch interval. */
export const DEFAULT_TRIAGE_EVERY = '30m';

/**
 * Floor for the batch interval. A triage run costs a whole session, reads two
 * inboxes and may write letters — five minutes is already aggressive, and a
 * typo'd "30s" would otherwise mint a session every half minute.
 */
export const MIN_TRIAGE_EVERY_MS = 5 * 60_000;

/** Default wake threshold: run early once this many new items have arrived. */
export const DEFAULT_TRIAGE_EVERY_MESSAGES = 20;

/** Default sources. */
export const DEFAULT_TRIAGE_SOURCES: readonly TriageSource[] = ['mail', 'slack'];

/** Default mode. */
export const DEFAULT_TRIAGE_MODE: TriageMode = 'ask';

/** Default active-hours window. */
export const DEFAULT_TRIAGE_ACTIVE_HOURS = '08:00-22:00';

/** The console agent a triage run speaks as (src/core/agent-registry.ts). */
export const TRIAGE_AGENT_ID = 'triage';

/** Its display name — also the routine's name and the "Ask <name>" project stem. */
export const TRIAGE_AGENT_NAME = 'Inbox Triage';

/** The one routine triage owns. Found-or-created by bootstrap.ts. */
export const TRIAGE_ROUTINE_NAME = TRIAGE_AGENT_NAME;

/**
 * The init-processor action that builds the batch (src/actions/, landing in
 * S13). Also the marker bootstrap.ts recognises its own routine by, so a user
 * who renames the routine does not get a second one on the next enable.
 */
export const TRIAGE_ACTION_ID = 'inbox-triage-batch';

/** How long the batch action may take before the run is failed. */
export const TRIAGE_ACTION_TIMEOUT_SECONDS = 30;

/**
 * The bus event each source emits per poll tick. The counter adds the event's
 * `count` field (CronWake.countField), so one tick reporting 14 new messages
 * moves the threshold by 14 rather than by 1.
 */
export const TRIAGE_WAKE_EVENTS: Readonly<Record<TriageSource, string>> = {
  mail: 'plugin:mail:messages-received',
  slack: 'plugin:slack:messages-received',
};

/** The payload field holding "how many items this tick brought". */
export const TRIAGE_WAKE_COUNT_FIELD = 'count';

/**
 * The run's task title. `{time}` is the local HH:MM of the run; `{count}` is how
 * many items the batch carried, which only the batch action knows — see
 * readTriageCountHint in the claude-code executor for how it travels.
 */
export const TRIAGE_TITLE_TEMPLATE = 'Triage · {time} · {count} items';
