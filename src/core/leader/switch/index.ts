/**
 * The switchable leader (docs/reference/leader-switch.md): the manual switch (flow.ts: its two jobs and the command), the
 * server's write permission at boot and while it runs (boot.ts, runtime.ts), the outward
 * doors (doors.ts), witnesses in local directories (local-witnesses.ts). Experiment
 * `switchable_leader` with a `leader_switch` section; off, none of it runs.
 */
export { readSwitchState, readTargetState, switchStateFile, SwitchRefused, type SwitchState, type TargetState, type SwitchStep } from './flow.js'
export { runLeaderSwitch, switchStatus, type SwitchCommandOptions, type SwitchOutcome } from './switch-command.js'
export { leaderPermitAtBoot, currentLeaderPermit, LeaderBootRefused } from './boot.js'
export { setUpLocalWitnesses, serveLocalWitness, forgetLocalWitnesses } from './local-witnesses.js'
export { createWitnessTransport, setUpRemoteWitness, addWitnessReach } from './witness-transport.js'
export { setUpRemoteWitnesses, evidenceFor } from './witness-setup.js'
export { readHomeSwitchConfig, parseSwitchSettings, machineById, machineByHome, type LeaderSwitchSettings, type MachinePlace, type WitnessPlace, type LocalWitnessPlace, type RemoteWitnessPlace, isLocalWitness, isRemoteWitness } from './settings.js'
export { readMarker, readHistory, readMayAct, type HandedOverMarker, type MayActLine } from './records.js'
export { permitHolderId, machineIdFile } from './machine-id.js'
export { LocalSide, type SwitchSide } from './side.js'
