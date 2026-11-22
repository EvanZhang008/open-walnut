/**
 * The switchable leader (docs/reference/leader-switch.md): the manual switch (flow.ts), the
 * server's write permission at boot and while it runs (boot.ts, runtime.ts), the outward
 * doors (doors.ts), witnesses in local directories (local-witnesses.ts). Experiment
 * `switchable_leader` with a `leader_switch` section; off, none of it runs.
 */
export { runLeaderSwitch, readSwitchState, switchStateFile, SwitchRefused, type SwitchState, type SwitchStep, type SwitchOptions } from './flow.js'
export { leaderPermitAtBoot, currentLeaderPermit, LeaderBootRefused } from './boot.js'
export { setUpLocalWitnesses, serveLocalWitness, localWitnessTransport, forgetLocalWitnesses } from './local-witnesses.js'
export { readHomeSwitchConfig, parseSwitchSettings, type LeaderSwitchSettings, type MachinePlace, type WitnessPlace } from './settings.js'
export { readMarker, readHistory, readMayAct, type HandedOverMarker, type MayActLine } from './records.js'
export { permitHolderId, machineIdFile } from './machine-id.js'
export { LocalSide, type SwitchSide } from './side.js'
