/**
 * Provider driver registry.
 *
 * Every provider in the CloudSetupProviderId union is registered here, so adding
 * one is a single map entry plus its driver file.
 *
 * Order is display order in the provider picker, and it is deliberate: the two
 * drivers that can provision with no credential typed (aws, hetzner) come first,
 * then the two that depend on a vendor CLI being installed and signed in (azure,
 * gcp — which degrade to "CLI missing or signed out" and the manual path), then
 * the universal paste fallback.
 *
 * Tests inject a fake driver via _setCloudProviderDriverForTesting rather than
 * mocking this module: the job runner resolves drivers through getDriver() on
 * every step, so an injected entry is picked up by an already-running job.
 */

import type { CloudSetupProviderId } from '../job-types.js'
import { awsDriver } from './aws.js'
import { azureDriver } from './azure.js'
import { fakeDriver, FAKE_DRIVER_ENV } from './fake.js'
import { gcpDriver } from './gcp.js'
import { hetznerDriver } from './hetzner.js'
import { manualDriver } from './manual.js'
import type { CloudProviderDriver } from './types.js'

const drivers = new Map<string, CloudProviderDriver>([
  [awsDriver.id, awsDriver],
  [hetznerDriver.id, hetznerDriver],
  [azureDriver.id, azureDriver],
  [gcpDriver.id, gcpDriver],
  [manualDriver.id, manualDriver],
])

// Fixture-only provisioning driver, so the browser wizard test can drive a real
// job through the real state machine without a cloud account. Gated on an env
// flag the Playwright fixture sets — never present in a normal build.
if (process.env[FAKE_DRIVER_ENV] === '1') {
  drivers.set(fakeDriver.id, fakeDriver)
}

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
