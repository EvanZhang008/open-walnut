/**
 * Provider driver registry.
 *
 * Only aws + manual are registered in this version; the CloudSetupProviderId
 * union already covers the providers that land later, so adding one is a single
 * register() call plus its driver file.
 *
 * Tests inject a fake driver via _setCloudProviderDriverForTesting rather than
 * mocking this module: the job runner resolves drivers through getDriver() on
 * every step, so an injected entry is picked up by an already-running job.
 */

import type { CloudSetupProviderId } from '../job-types.js'
import { awsDriver } from './aws.js'
import { manualDriver } from './manual.js'
import type { CloudProviderDriver } from './types.js'

const drivers = new Map<string, CloudProviderDriver>([
  [awsDriver.id, awsDriver],
  [manualDriver.id, manualDriver],
])

/** Registered driver, or undefined for an id this build does not support yet. */
export function getDriver(id: string): CloudProviderDriver | undefined {
  return drivers.get(id)
}

/** Registration order = display order in the provider picker. */
export function listDrivers(): CloudProviderDriver[] {
  return [...drivers.values()]
}

/**
 * Test-only: register (or with `undefined`, remove) a driver under any id,
 * including one outside the shipped set. Returns a restore function.
 */
export function _setCloudProviderDriverForTesting(
  id: CloudSetupProviderId | string,
  driver: CloudProviderDriver | undefined,
): () => void {
  const previous = drivers.get(id)
  if (driver) drivers.set(id, driver)
  else drivers.delete(id)
  return () => {
    if (previous) drivers.set(id, previous)
    else drivers.delete(id)
  }
}

export type { CloudProviderDriver, CreateVMParams, CreateVMResult, DetectCredsResult, DriverInstructions, InstructionsParams } from './types.js'
