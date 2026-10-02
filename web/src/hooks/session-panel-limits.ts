// The session-panel count range, on its own so pure modules (the column queue in
// pages/sessionColumns.ts) can read it without pulling in the hook's config and
// WebSocket imports. useSessionPanelMode re-exports both.

export const MIN_PANELS = 1;
/**
 * Most panels the picker offers, and the hard ceiling of the column budget (the
 * lock grant never goes past it). Not arbitrary: the session strip maxes out at 70%
 * of the viewport, so on a 2560px screen 5 columns is ~360px each — about the floor
 * for a usable session panel (composer + header + code blocks). Narrower than that
 * is unreadable, and each column is a live CLI session's worth of DOM and streaming.
 */
export const MAX_PANELS = 5;
