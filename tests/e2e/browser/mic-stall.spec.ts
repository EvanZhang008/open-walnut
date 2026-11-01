/**
 * The mic warning never fires on a pipeline stall after speech, in Chromium.
 * Scenarios and why: mic-stall-helpers.ts.
 */
import { registerMicStallScenarios } from './mic-stall-helpers'

registerMicStallScenarios()
