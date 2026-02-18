/**
 * Heartbeat system — periodic AI self-check mechanism.
 *
 * The heartbeat wakes the AI agent at regular intervals to read HEARTBEAT.md
 * and decide whether anything needs the user's attention. If nothing does,
 * the agent replies HEARTBEAT_OK and the user is not notified.
 *
 * Two trigger modes:
 * 1. Periodic (setTimeout recursive) — default every 30 minutes
 * 2. Event-driven — immediate wake on session end, cron completion, etc.
 */

export {
  type HeartbeatConfig,
  type HeartbeatTriggerReason,
  HEARTBEAT_OK_TOKEN,
  DEFAULT_HEARTBEAT_EVERY,
  DEFAULT_HEARTBEAT_PROMPT,
  isHeartbeatOk,
} from './types.js';

export {
  startHeartbeatRunner,
  parseDuration,
  isWithinActiveHours,
  type HeartbeatRunnerDeps,
  type HeartbeatRunnerHandle,
} from './heartbeat-runner.js';

export { readHeartbeatChecklist, writeHeartbeatChecklist } from './checklist-io.js';
