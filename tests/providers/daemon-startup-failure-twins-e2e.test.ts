/**
 * A resumed CLI that fails at startup, run by both daemon twins booted for real,
 * with a stand-in CLI (tests/helpers/startup-failure-twins.ts). The same check with
 * a real Claude Code: daemon-startup-failure-twins.live.test.ts.
 */
import { STAND_IN_CLI, startupFailureTwinsSuite } from '../helpers/startup-failure-twins.js'

startupFailureTwinsSuite(STAND_IN_CLI)
