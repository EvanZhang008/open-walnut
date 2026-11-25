/**
 * Approvals: a script, hook, CI step or agent asks a person to say yes before it goes on
 * (`walnut approve "<what>"`), and blocks until a person answers on one of their devices.
 *
 * Any device the person is signed in on answers, with one tap: the web console, the Mac app, the
 * iPhone app (2026-11-21, the user: "这个东西我只要是登录了这个，它就可以用啊 ... 只要我这个手机连到了
 * 这里面，或者其他的 device ... 就可以签"). No device key, no enrollment, no device an approval is
 * bound to. Only a person answers: a session caller is refused on the answer route
 * (tests/core/agent-parity-ratchet.test.ts lists that refusal with its reason). An answer names the
 * request's digest (digest.ts), is used once, and is recorded with the device that gave it.
 */
import type { AskerContext } from './asker-context.js'

/**
 * Every approval Walnut makes now is `tap`. `biometric` is only in records an older Walnut wrote (it
 * asked for a device key's signature then); such a record is answered with a tap like any other.
 */
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
  /** It asked from the machine Walnut runs on (not through a host's gateway): shown as "this computer", never its host name. */
  local?: boolean
}

export interface ApprovalAnswer {
  decision: ApprovalDecision
  at: string
  mode: ApprovalMode
  /** The device that answered, as its client named it (an older Walnut's records also carry a key id). */
  device: { id?: string; name: string; kind: ApprovalDeviceKind }
  /** Only in records an older Walnut wrote: the device key that signed that answer. */
  keyId?: string
  signature?: string
}

/** `setting`: nobody was asked, because the person turned approvals off (ask-me.ts). */
export type ApprovalDeviceKind = 'iphone' | 'mac-app' | 'web' | 'cli' | 'setting'

export interface ApprovalRecord {
  id: string
  what: string
  detail?: string
  /**
   * `summary`: the detail is the request said in words for the person (Walnut's own asks: a browser
   * step, a sign-in, a password), so every screen shows it whole, never in a fold; else it is
   * technical (a command's context, a diff) and waits in Details (2026-11-14, the user: "summayr
   * 一直都显示不需要点detail detail只是xommend detail啥的").
   */
  detailRole?: 'summary'
  /** What the person is asked: sha256 hex of canonicalText() (digest.ts); an answer names it. */
  digest: string
  mode: ApprovalMode
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
  /** Wait reads the decision; consume spends it once, with no retry grace. */
  singleUse?: boolean
  /** Not asked: approvals were off, so the step went ahead and this records it (ask-me.ts: which gate). */
  unasked?: string
  /** An ask the Approvals switch never answers, so its card offers no "stop asking me". */
  outsideSwitch?: boolean
  /**
   * Approving it needs Passwords unlocked in the window that answers, so the master password was
   * typed there: an agent's ask to read or change a locked note (docs/reference/locked-notes.md).
   * A deny needs nothing. An older Walnut ignores it and takes a tap.
   */
  needsPasswords?: true
  /** When the asker first read how it ended, whatever it was (an expiry too): it knows. */
  readAt?: string
  /** When Walnut told the asking session the decision (tell-asker.ts), at most once. */
  askerToldAt?: string
  /** sha256 of the asker's wait token: only it may read and use the decision. */
  waitTokenHash: string
  /** Only in records an older Walnut wrote: its "Let … sign your approvals" ask for this device key. */
  enrollsKey?: string
  canceledReason?: string
  /** When it was withdrawn (absent on one an older Walnut canceled). */
  canceledAt?: string
  /**
   * The test run that asked (core/test-run.ts): such an approval is shown only to that test
   * run and never pushed, so a test or a demo on the user's own Walnut never reaches their
   * devices, and an automated browser never sees (or clicks) one of the user's real ones.
   */
  testRun?: string
}

/** What clients see: never the wait token's hash. */
export type ApprovalView = Omit<ApprovalRecord, 'waitTokenHash'>

export interface ApprovalsFile {
  version: 1
  approvals: ApprovalRecord[]
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

/** For the asking agent: where the person is asked. */
export const WHERE_ASKED = 'They are asked in Walnut, on any device they are signed in on (a notification wherever it is open)'

export function isTerminal(status: ApprovalStatus): boolean {
  return status !== 'pending'
}
