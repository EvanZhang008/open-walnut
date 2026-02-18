/**
 * Heartbeat system type definitions.
 *
 * The heartbeat periodically wakes the AI agent to check a HEARTBEAT.md
 * checklist and decide whether anything needs the user's attention.
 */

/** Heartbeat configuration — lives under `config.heartbeat` in config.yaml. */
export interface HeartbeatConfig {
  /** Whether heartbeat is enabled. Default: false (opt-in). */
  enabled?: boolean;

  /**
   * Interval between heartbeats as a duration string.
   * Examples: "30m", "1h", "15m". Set to "0" or "0m" to disable.
   * Default: "30m".
   */
  every?: string;

  /**
   * Active hours window — heartbeat only fires during this range.
   * Format: "HH:MM-HH:MM" in local time. Example: "08:00-22:00".
   * If unset, heartbeat runs 24/7.
   */
  activeHours?: string;
}

/** Internal state for the heartbeat runner. */
export interface HeartbeatState {
  /** The pending setTimeout timer, if any. */
  timer: ReturnType<typeof setTimeout> | null;

  /** Whether a heartbeat turn is currently running. */
  running: boolean;

  /** Timestamp of last heartbeat execution (epoch ms). */
  lastRunAt: number | null;

  /** Timestamp of next scheduled heartbeat (epoch ms). */
  nextDueAt: number | null;

  /** Whether the runner has been stopped. */
  stopped: boolean;
}

/** Reason why a heartbeat was triggered. */
export type HeartbeatTriggerReason =
  | 'interval'          // Periodic timer fired
  | 'session-ended'     // A Claude Code session finished
  | 'cron-completed'    // A cron job finished
  | 'manual';           // Manually requested (e.g. from API)

/** The magic token that signals "nothing needs attention". */
export const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';

/** Default heartbeat interval. */
export const DEFAULT_HEARTBEAT_EVERY = '30m';

/** Default heartbeat prompt sent to the AI agent. */
export const DEFAULT_HEARTBEAT_PROMPT =
  'Below is the contents of HEARTBEAT.md. Follow it strictly. ' +
  'Do not infer or repeat old tasks from prior chats. ' +
  `If nothing needs attention, reply exactly: ${HEARTBEAT_OK_TOKEN}`;

/**
 * Check whether a response contains the HEARTBEAT_OK token on its own line.
 * Line-based matching prevents false positives when the token is quoted
 * in an explanation (e.g. "I replied HEARTBEAT_OK because…").
 */
export function isHeartbeatOk(response: string): boolean {
  return response.trim().split('\n').some(
    (line) => line.trim() === HEARTBEAT_OK_TOKEN,
  );
}
