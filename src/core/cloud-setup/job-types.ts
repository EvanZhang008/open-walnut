/**
 * Types for the one-click cloud-companion setup job.
 *
 * The job is a resumable state machine persisted to
 * <WALNUT_HOME>/cloud-setup-job.json (a CRITICAL_IGNORE — it briefly holds the
 * pairing code, so it must never enter the git-synced data repo). One job at a
 * time; the Mac drives it, and every surface (web wizard, shipped skill) talks
 * to the same REST endpoints rather than re-implementing the sequence.
 */

import type { SessionEngine } from '../types.js'

/**
 * Step order is the execution order. `dns` is skipped in sslip mode and
 * `await-vm` only runs on the manual path — a skipped step still occupies its
 * slot in `steps` so the UI can render a stable checklist.
 */
export type CloudSetupStepId =
  | 'preflight'
  | 'generate'
  | 'provision'
  | 'await-vm'
  | 'dns'
  | 'await-server'
  | 'claim-and-wire'
  | 'verify-sync'
  | 'done'

export const CLOUD_SETUP_STEP_IDS: readonly CloudSetupStepId[] = [
  'preflight',
  'generate',
  'provision',
  'await-vm',
  'dns',
  'await-server',
  'claim-and-wire',
  'verify-sync',
  'done',
] as const

/** 'fake' is the fixture-only driver (WALNUT_CLOUD_SETUP_FAKE=1) — never shipped in the UI's picker outside tests. */
export type CloudSetupProviderId = 'aws' | 'hetzner' | 'azure' | 'gcp' | 'manual' | 'fake'

/** 'sslip' = derive the hostname from the public IP (no DNS registrar step). */
export type CloudSetupDomainMode = 'own-domain' | 'sslip'

export type CloudSetupJobStatus = 'running' | 'awaiting-input' | 'failed' | 'done' | 'cancelled'

export type CloudSetupStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface CloudSetupStepState {
  status: CloudSetupStepStatus
  error?: string
  startedAt?: string
  endedAt?: string
}

/** What the runner is blocked on. Resolved via POST /api/cloud-setup/job/input. */
export interface CloudSetupAwaitingInput {
  kind: 'vm-ip' | 'credentials' | 'dns-confirm'
  prompt: string
}

/**
 * The cloud place a job builds in. Non-secret identifiers only: never a token,
 * a key or a profile name. Each driver fills the fields it has.
 */
export interface CloudSetupTarget {
  /** aws: the account id the credentials resolved to. */
  account?: string
  /** aws: the region the stack deploys in (the chosen one, else the CLI default at resolve time). */
  region?: string
  /** gcp: the project id. */
  project?: string
  /** azure: the subscription id (never logged; the name is). */
  subscription?: string
  /** azure: the subscription's display name, for log lines and errors. */
  subscriptionName?: string
  /**
   * hetzner: id of the walnut-cloud firewall in the token's project. The API has
   * no call that names a token's project, but every resource id is global and a
   * token only sees its own project's, so this id is what proves "same project".
   */
  firewallId?: number
}

export interface CloudSetupJobState {
  version: 1
  id: string
  provider: CloudSetupProviderId
  domainMode: CloudSetupDomainMode
  /** Own-domain: the operator's hostname. sslip: filled in once the IP is known. */
  domain?: string
  ip?: string
  /** Provider-scoped placement hints, echoed back to the driver on resume. */
  region?: string
  instanceType?: string
  /**
   * Local CLI credential profile chosen in the wizard (aws: an ~/.aws profile).
   * Persisted so a resumed or retried deploy targets the SAME account as the first
   * attempt rather than re-resolving from the ambient environment. Not a secret,
   * but never written to a log line — it is the operator's own label for an
   * account (see DetectCredsResult.profiles).
   */
  profile?: string
  /**
   * WHERE this job builds, resolved once from the operator's CLI (preflight, or
   * the provision step for a job an older Walnut started) and written to disk
   * before any VM is created. Every later createVM builds exactly there or
   * refuses, so a crash followed by a change of the ambient default (another
   * gcloud project, az subscription, AWS account) never makes a second VM in
   * another place. Optional: older files have none, and older readers ignore it.
   */
  target?: CloudSetupTarget
  /**
   * Coding-agent engine the box installs (next to Claude Code, which it always
   * gets) and seeds as its own `defaults.engine`. Captured from this machine's
   * config at job creation, so a resume or retry provisions what the operator
   * had chosen when they started. Optional so older job files still load;
   * absent means claude.
   */
  engine?: SessionEngine
  /**
   * Region Claude Code on the box calls Bedrock in, through the instance role.
   * Not the box's own region. Optional for older files; absent means us-west-2.
   */
  bedrockRegion?: string
  /** Provider-scoped handle for teardown (EC2 instance id, stack name, …). */
  instanceRef?: string
  /**
   * The provisioned setup token burned into the VM's cloud-init. SECRET:
   * redactCloudSetupJob() strips it from every REST/SSE/bus payload, and the
   * runner erases it from the persisted state the moment the claim succeeds.
   */
  pairingCode?: string
  /**
   * The operator started this job with force, i.e. explicitly consented to
   * replace an existing companion. Persisted on purpose (optional, so older
   * files still load): preflight deliberately refuses when cloud sync is already
   * configured, and without this a restart would drop the consent and make
   * every retry re-throw "already configured" with no way to re-assert it.
   */
  force?: boolean
  status: CloudSetupJobStatus
  currentStep: CloudSetupStepId
  steps: Record<CloudSetupStepId, CloudSetupStepState>
  awaitingInput?: CloudSetupAwaitingInput
  /** Ring-capped operator-visible log (CLOUD_SETUP_LOG_TAIL_MAX lines). */
  logTail: string[]
  createdAt: string
  updatedAt: string
  error?: string
}

/** Redacted view — the only shape that leaves the process. */
export type RedactedCloudSetupJobState = Omit<CloudSetupJobState, 'pairingCode'>

/** SSE payload on the 'cloud-setup' channel. Never carries the pairing code. */
export interface SetupProgressEvent {
  jobId: string
  status: CloudSetupJobStatus
  currentStep: CloudSetupStepId
  steps: Record<CloudSetupStepId, CloudSetupStepState>
  /** New log lines since the previous event (not the whole tail). */
  logLines?: string[]
  awaitingInput?: CloudSetupAwaitingInput
  error?: string
  updatedAt: string
}

export const CLOUD_SETUP_LOG_TAIL_MAX = 200
