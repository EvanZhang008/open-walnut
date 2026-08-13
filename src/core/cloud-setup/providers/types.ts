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
   * Which local CLI credential profile to provision with (aws: an ~/.aws profile
   * name). Persisted with the job, because a resumed deploy MUST target the same
   * account as the first attempt — resolving it again from the ambient environment
   * could silently point a retry at a different account.
   *
   * Not a secret (it names no credential material), but still never logged: see
   * DetectCredsResult.profiles.
   */
  profile?: string
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
  /**
   * Selectable local credential profiles, when the driver has more than one to
   * offer (aws: ~/.aws profiles). The wizard renders these as a picker.
   *
   * UI-ONLY, and deliberately NOT folded into `detail`: `detail` is written to the
   * log, while a profile name is the operator's own label for an account and can
   * carry a client, employer or project name. Keep them in this field, keep this
   * field out of log lines and out of the persisted job.
   */
  profiles?: string[]
  /** Which profile this probe actually used, when one was requested. */
  activeProfile?: string
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
  /**
   * `profile` selects among local CLI credential profiles (aws). Drivers that have
   * no such concept ignore the argument — the caller may always pass it.
   */
  detectCreds(profile?: string): Promise<DetectCredsResult>
  createVM?(params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult>
  instructions(params: InstructionsParams): DriverInstructions
  /**
   * `opts` pins WHERE the deletion happens (aws: the profile + region the job
   * deployed with). Omitting it lets the driver fall back to the ambient
   * environment, which for a destroy is how you delete the wrong account's box —
   * callers that know the job's profile must pass it.
   */
  teardown?(
    instanceRef: string,
    onLog: (line: string) => void,
    opts?: { profile?: string; region?: string },
  ): Promise<void>
}
