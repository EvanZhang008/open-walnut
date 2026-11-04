/**
 * The id a host gives a trigger it created while this server was away
 * (offline-host-core.ts opTriggerCreate): the routine id shape (cron/jobs.ts generateId)
 * with 8 hex digits where the server's have 4, so the two can never name the same routine.
 * A fire under such an id that this server has not recorded yet belongs to a create still
 * in the host's journal: it is neither claimed nor acked here (trigger-events.ts).
 */
export const HOST_TRIGGER_ID_RE = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/;
