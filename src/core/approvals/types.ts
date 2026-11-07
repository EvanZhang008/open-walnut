/**
 * Approvals: a script, hook, CI step or agent asks a person to say yes before it goes on
 * (`walnut approve "<what>"`), and blocks until a person answers on one of their devices.
 *
 * Two strengths:
 *  - `tap`: a plain Approve / Deny from the web console, the Mac app or the phone;
 *  - `biometric`: Approve needs a signature by a device key that lives in that device's
 *    Secure Enclave and signs only after Face ID or Touch ID (keys.ts), over the request's
 *    digest (digest.ts), so no agent and no click-through can make one.
 *
 * Only a person answers: a session caller is refused on the answer route (see
 * tests/core/agent-parity-ratchet.test.ts, which lists that refusal with its reason).
 */
import type { AskerContext } from './asker-context.js'

export type ApprovalMode = 'tap' | 'biometric'
export type ApprovalDecision = 'approve' | 'deny'
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'canceled'

/** Who asked: what the asking process could tell about itself. */
export interface ApprovalRequester {
  /** The machine the asking process ran on (a host name, or this machine's). */
  host: string
  /** The Walnut task whose session asked, when one did. */
  taskId?: string
  taskTitle?: string
  sessionId?: string
  /** The asking process's working directory and command line, when given. */
  cwd?: string
  command?: string
  /**
   * Whether Walnut saw the asking process inside the session it named (caller-proof.ts):
   * verified, unverified (another process named it, or Walnut could not look), none (no session).
   */
  identity?: 'verified' | 'unverified' | 'none'
  /** Why unverified: Walnut looked and the asking process is outside that session, or it could not look. */
  check?: 'outside' | 'unchecked'
  /** It came from a terminal Walnut opened for the task, not from the task's agent. */
  via?: 'terminal'
  /** A process on this machine sent it claiming to be a host's relay; it is read as its own. */
  relayClaimed?: true
  /** For a request from no session: the process that ran `walnut approve`, and the account. */
  process?: string
  /** The command line that ran `walnut approve`, read from the process table (the person reads what really runs). */
  ranBy?: string
  user?: string
}

export interface ApprovalAnswer {
  decision: ApprovalDecision
  at: string
  mode: ApprovalMode
  /** The device that answered: a registered key's id for a signed answer, else what the client said. */
  device: { id?: string; name: string; kind: ApprovalDeviceKind }
  /** For a signed answer: the key and its base64 DER signature over answerMessage(). */
  keyId?: string
  signature?: string
}

export type ApprovalDeviceKind = 'iphone' | 'mac-app' | 'web' | 'cli'

/**
 * An approval whose unsigned Approve from this machine is not enough (any process here can send
 * one): `vault`/`vault-sensitive` give an agent a password; `person` lets an agent's step in the
 * browser buy, send or delete (browser-control/outward-asks.ts). The proof is a device key's
 * signature, or this window's Passwords unlock (approvals-v1.ts).
 */
export type ApprovalGuard = 'vault' | 'vault-sensitive' | 'person'

export interface ApprovalRecord {
  id: string
  what: string
  detail?: string
  /** What the person was asked to sign: sha256 hex of canonicalText() (digest.ts). */
  digest: string
  mode: ApprovalMode
  /** Set when the asker wanted `biometric` but no device can sign yet, with the reason. */
  downgraded?: string
  requester: ApprovalRequester
  createdAt: string
  expiresAt: string
  status: ApprovalStatus
  answer?: ApprovalAnswer
  /** When the asker read the decision; an approval is used once. */
  consumedAt?: string
  /** Why it asks, the task's goal and its last steps, read when it asked (asker-context.ts). */
  context?: AskerContext
  /** Asked with `walnut approve --request-only`: the session reruns with --approval <id>. */
  requestOnly?: boolean
  /** Wait reads the signed decision; consume spends it once, with no retry grace. */
  singleUse?: boolean
  signingKeyId?: string
  /** When the asker first read how it ended, whatever it was (an expiry too): it knows. */
  readAt?: string
  /** When Walnut told the asking session the decision (tell-asker.ts), at most once. */
  askerToldAt?: string
  /** sha256 of the asker's wait token: only it may read and use the decision. */
  waitTokenHash: string
  /** An enrollment approval: approving it activates this pending device key. */
  enrollsKey?: string
  /**
   * Approving gives an agent a vault item, so Approve needs proof only the person has
   * (approvals-v1.ts vaultApprover): a device key's signature, or for `vault` also a Passwords
   * unlock in the answering window. `vault-sensitive` takes only a signature while a device can
   * sign. Not part of the signed digest.
   */
  guard?: ApprovalGuard
  /** A removal approval: approving it removes this device key. */
  removesKey?: string
  canceledReason?: string
  /**
   * The test run that asked (core/test-run.ts): such an approval is shown only to that test
   * run and never pushed, so a test or a demo on the user's own Walnut never reaches their
   * devices, and an automated browser never sees (or clicks) one of the user's real ones.
   */
  testRun?: string
}

/** What clients see: never the wait token's hash. */
export type ApprovalView = Omit<ApprovalRecord, 'waitTokenHash'>

export interface ApprovalKey {
  id: string
  name: string
  kind: 'iphone' | 'mac-app'
  /** base64 DER SubjectPublicKeyInfo of a P-256 key. */
  publicKey: string
  createdAt: string
  /** pending until an active key signs its enrollment approval (the first key is active at once). */
  status: 'active' | 'pending'
  activatedAt?: string
  lastUsedAt?: string
  /** The approval that enrolls it, while pending. */
  enrollApprovalId?: string
}

export interface ApprovalsFile {
  version: 1
  approvals: ApprovalRecord[]
}

export interface ApprovalKeysFile {
  version: 1
  keys: ApprovalKey[]
}

export const APPROVAL_WHAT_MAX = 300
export const APPROVAL_DETAIL_MAX = 32_000
export const APPROVAL_DEFAULT_TIMEOUT_MS = 10 * 60_000
export const APPROVAL_MAX_TIMEOUT_MS = 24 * 60 * 60_000
export const APPROVAL_MIN_TIMEOUT_MS = 10_000
/** Decided approvals are kept this long for the record. */
export const APPROVAL_KEEP_MS = 30 * 24 * 60 * 60_000
export const APPROVAL_KEEP_MAX = 500
/** One wait call holds at most this long, so it passes every relay on the way. */
export const APPROVAL_WAIT_MAX_MS = 12_000

export function isTerminal(status: ApprovalStatus): boolean {
  return status !== 'pending'
}
