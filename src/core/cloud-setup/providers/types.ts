/**
 * Provider driver contract for cloud-companion provisioning.
 *
 * A driver either creates the VM itself (`createVM` present — the one-click
 * path) or only describes what the operator must do (`instructions` only — the
 * manual path). The job runner branches on `createVM` being present, so adding
 * a provider never touches the state machine.
 */

import type { CloudSetupDomainMode, CloudSetupProviderId } from '../job-types.js'
import type { UserDataFlavor } from '../user-data.js'

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
  /**
   * Fires when the operator cancels the job. A driver MUST kill its child
   * process group / abort its in-flight fetches and reject promptly.
   *
   * A cooperative `cancelled` flag can only be observed between steps, so on its
   * own it lets a 30-minute `cdk deploy` / `az vm create` run to completion —
   * creating billable resources — while the UI already says "cancelled". The
   * signal is the only thing that reaches a process that is already live.
   */
  signal?: AbortSignal
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
  /**
   * Base image family the driver boots, so the caller builds a matching
   * first-boot script (buildUserData tries that package manager first). Absent
   * = 'al2023', which is what the aws stack and the manual path assume.
   */
  userDataFlavor?: UserDataFlavor
  /**
   * Set only by drivers whose credential is a value the OPERATOR pasted, which
   * the runner holds in memory and never persists. It is therefore gone after a
   * restart, so a resumed job has to ask for it again — this flag is what tells
   * the resume path to re-prompt.
   *
   * CLI-credential drivers (aws/azure/gcp) leave it unset: they read the
   * operator's signed-in CLI on every call, so there is nothing to re-ask for and
   * a prompt would be a bug.
   */
  credentialInput?: 'api-token'
  detectCreds(): Promise<DetectCredsResult>
  createVM?(params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult>
  instructions(params: InstructionsParams): DriverInstructions
  teardown?(instanceRef: string, onLog: (line: string) => void): Promise<void>
}
