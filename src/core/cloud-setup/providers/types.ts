/**
 * Provider driver contract for cloud-companion provisioning.
 *
 * A driver either creates the VM itself (`createVM` present — the one-click
 * path) or only describes what the operator must do (`instructions` only — the
 * manual path). The job runner branches on `createVM` being present, so adding
 * a provider never touches the state machine.
 */

import type { CloudSetupDomainMode, CloudSetupProviderId } from '../job-types.js'

export interface CreateVMParams {
  /** First-boot script from buildUserData(). Drivers base64 it if needed. */
  userData: string
  region?: string
  instanceType?: string
  /** Operator-visible resource name (stack name, server name, …). */
  name: string
  domainMode: CloudSetupDomainMode
  domain?: string
  /**
   * Provider API token / key when the driver needs one. In-memory only — the
   * runner never persists this and never puts it in a log line or event.
   */
  credentials?: string
}

export interface CreateVMResult {
  ip: string
  /** Handle for teardown (CDK stack name, provider server id, …). */
  instanceRef: string
  /** Resolved hostname: the operator's domain, or the derived sslip name. */
  domain: string
}

export interface DetectCredsResult {
  available: boolean
  /** One operator-facing sentence: what was found, or what to do about it. */
  detail: string
  /** What the operator must supply when `available` is false. */
  needs?: 'api-token' | 'cli-login' | 'nothing'
}

export interface InstructionsParams {
  userData: string
  domain: string
  domainMode: CloudSetupDomainMode
  region?: string
  instanceType?: string
}

export interface DriverInstructions {
  steps: string[]
  userData: string
  consoleUrl?: string
}

export interface CloudProviderDriver {
  id: CloudSetupProviderId
  label: string
  /** Rough monthly cost, e.g. '~$15/mo (t4g.small + 30 GB gp3)'. */
  costHint: string
  detectCreds(): Promise<DetectCredsResult>
  createVM?(params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult>
  instructions(params: InstructionsParams): DriverInstructions
  teardown?(instanceRef: string, onLog: (line: string) => void): Promise<void>
}
