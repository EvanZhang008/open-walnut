/**
 * The leader's write permission (docs/reference/leader-write-permission.md). Not wired
 * to any running path yet: nothing in the server or the daemons imports it.
 */
export * from './types.js'
export { judge, isMember, checkTiming, maxSafeDrift, holderLeaseMs, witnessHoldMs, grantable, holdsForHolder, type WitnessState, type Judgement } from './rules.js'
export { createFilePermitStore, bootstrapWitnessStore, encodeStored, decodeStored, PermitStoreCorrupt, type PermitStore, type StoredWitness } from './store.js'
export { PermitWitness, type WitnessOptions } from './witness.js'
export { PermitClient, PermitNotHeld, type ClientOptions, type ProposalOutcome } from './client.js'
export { createHolderClock, createWitnessClock, DISTRUST_STEP_MS, WALL_BACK_TOLERANCE_MS, type ClockSources } from './clock.js'
export { mayAskForTakeover, type TakeoverRuleInput, type TakeoverRuleAnswer } from './takeover-rule.js'
