/**
 * How long the console waits on a change this Mac makes on its cloud companion
 * for it: pairing a phone there, re-pairing one, removing one. The Mac's own
 * waits on the companion (src/web/routes/devices.ts CLOUD_RELAY_WORST_MS: a
 * re-pair is two calls, a removal one call and a list) end first, so the console
 * hears the Mac's sentence, never its own deadline. The client's default 15s
 * raced the first of those: a companion that did not answer read "signal timed
 * out", and a removal that finished at 16s was reported as failed.
 * tests/web/cloud-change-timeout-order.test.ts keeps the two in order.
 */
export const CLOUD_CHANGE_CLIENT_TIMEOUT_MS = 45_000;
