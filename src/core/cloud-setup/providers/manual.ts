/**
 * Manual driver — the universal fallback: Walnut generates the first-boot
 * script, the operator pastes it into whatever VM they already have, and the
 * job waits for the box to report in (POST /job/input with its IP).
 *
 * No createVM, so it works with any host and needs no credentials at all.
 */

import { manualUserDataSteps } from '../user-data.js'
import type {
  CloudProviderDriver,
  DetectCredsResult,
  DriverInstructions,
  InstructionsParams,
} from './types.js'

async function detectCreds(): Promise<DetectCredsResult> {
  return {
    available: true,
    detail: 'No credentials needed — you create the VM, Walnut hands you the boot script.',
    needs: 'nothing',
  }
}

function instructions(params: InstructionsParams): DriverInstructions {
  return { steps: manualUserDataSteps(params.domain), userData: params.userData }
}

export const manualDriver: CloudProviderDriver = {
  id: 'manual',
  label: 'Any VM (paste a script)',
  costHint: 'whatever your host charges — a 2 GB VM is enough',
  detectCreds,
  instructions,
}
