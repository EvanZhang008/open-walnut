/**
 * Entry of the `trigger-check-core.cjs` sidecar the source-deployed daemon
 * loads (scripts/build-daemon.sh): the check contract plus the fire envelope,
 * which that daemon needs to deliver a fire no server claimed. The standalone
 * twin imports both modules directly.
 */
export * from './trigger-check-core.js';
export { buildTriggerMessage } from './trigger-envelope-core.js';
