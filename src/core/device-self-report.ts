/**
 * What this computer says about itself to its cloud companion, the way a
 * phone says it is a phone: in the setup claim (cloud-setup/steps.ts) and in
 * every pairing's first contact (POST /api/v1/devices/self,
 * hosts/cloud-box-probe.ts). The companion records the first one it hears for
 * good (device-store.ts `platform`), so both say the same thing.
 */

import { getVersion } from './version.js'

export interface ComputerSelfReport { model: string; os: string; appVersion: string }

export function computerSelfReport(): ComputerSelfReport {
  return process.platform === 'darwin'
    ? { model: 'Mac', os: 'macOS', appVersion: getVersion() }
    : { model: 'Computer', os: process.platform === 'linux' ? 'Linux' : process.platform, appVersion: getVersion() }
}
