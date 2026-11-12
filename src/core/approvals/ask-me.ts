/**
 * Whether Walnut's own asks wait for the person's yes (2026-11-12, the user: "can we make this
 * optional, and I want it to be off by default don't need my approval for anything"; later the
 * same day, of what it covers: browser steps never ask, and an approval the person put in place
 * on purpose always does).
 *
 * `config.approvals.ask_me` absent or false (the default): none of Walnut's own asks waits. A
 * post, a mail, a browser step that buys, sends or deletes, a hand-off outside a router's area,
 * an agent's use of a saved password, a command on a new host, all go ahead, and each is recorded
 * where the person reads it afterwards (`unasked` on an approved record: `walnut approvals list
 * --all`, the plugin's own sent log). `true`: every one asks, as before.
 *
 * What it never covers: an explicit `walnut approve` (or approval_request), which the person put
 * in a script, hook or CI step to be asked, so it always asks (routes/approvals-v1.ts); a signed
 * single-use approval (only its device can sign it); a new signing
 * device without its app's proof (the trust root), an OS dialog the system itself shows, a
 * password item the person marked never or sensitive, and the person-only doors (settings,
 * answering an approval). Only a person changes the switch (routes/config.ts).
 *
 * Turning it off while it is on needs a device's signature (2026-11-12, after a review of the Git
 * gate: a process here could turn every approval off with one unsigned PUT /api/config). While a
 * device signs approvals, the off is an approval of its own (`requestAskMeOff`), and only a Face
 * ID or Touch ID Approve of it turns the switch off (`applyAskMeOff`). The switch Walnut set last
 * is kept beside the keys (approvals/switch.json, read at boot and then held in memory), and
 * `askMeOf` reads on while either it or config.yaml says on: so a config.yaml edited by hand or by
 * another write path, or a whole-config PUT, can turn it on but never off. `setAskMe` is the one
 * writer (tests/core/approvals/ask-me-signed-off-guard.test.ts). Turning it on needs nothing.
 * Known limits: with no device that signs, the person's unsigned off is taken (nothing could sign
 * it); and a process of this account can still write the files under approvals/ (keys.json, this
 * latch) before a restart, which the sessions' hook refuses (providers/approvals-guard-hook.ts).
 *
 * Every gate that waits for the person reads `asksPerson()`; tests/core/approvals/ask-me-gates-guard.test.ts
 * lists them from the source and fails on a new one that does not.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { getConfig } from '../config-manager.js'
import { WALNUT_HOME } from '../../constants.js'
import { writeJsonFile } from '../../utils/fs.js'
import { log } from '../../logging/index.js'
import type { ApprovalRequester, ApprovalView } from './types.js'

/** The gates the switch covers, by name (the `unasked` mark on a record). */
export const ASK_ME_GATES = {
  browserOutward: 'A browser step that buys, sends or deletes',
  browserSignIn: 'A fresh sign-in on a site open in your own tab',
  routerHandoff: 'A hand-off outside a router task’s area',
  mailSend: 'Sending a mail',
  mailUnsubscribe: 'Unsubscribing from a mailing list',
  slackPost: 'Posting to Slack',
  hostExec: 'Running commands on a host',
  calendarWrite: 'Changing a calendar event Walnut did not create',
  vaultUse: 'An agent using a saved password',
  pluginStep: 'A plugin’s outward step (a post, a send)',
} as const
export type AskMeGate = keyof typeof ASK_ME_GATES

/**
 * The switch as config.yaml stores it: true only when the person turned approvals on. With
 * nothing stored, `WALNUT_APPROVALS_ASK=1` makes the default "ask" (the test setup's default, as
 * with WALNUT_ORG_AUTOSTART); a stored value always wins.
 */
export function storedAskMe(config: { approvals?: { ask_me?: boolean } } | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const stored = config?.approvals?.ask_me
  if (typeof stored === 'boolean') return stored
  return env.WALNUT_APPROVALS_ASK === '1'
}

/** The switch now: on while config.yaml or the switch Walnut set last (the latch) says on. */
export function askMeOf(config: { approvals?: { ask_me?: boolean } } | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return storedAskMe(config, env) || latch?.on === true
}

/** Who turned it off: a device's signed Approve, or the person with no device that could sign. */
type SwitchBy = { approvalId: string; keyId: string } | { unsigned: string } | { person: true }
interface SwitchFile { version: 1; on: boolean; at: string; by?: SwitchBy }

/** Not read yet (a unit test, a replica): config.yaml alone decides. */
let latch: SwitchFile | null = null

function switchFile(): string {
  return path.join(WALNUT_HOME, 'approvals', 'switch.json')
}

/**
 * On boot, before the server listens (web/server.ts; store.ts initApprovals reads it again): the
 * latch. The first boot of this version, with no file, starts it where config.yaml stands; a file
 * that is there but does not read (truncated, unreadable) reads as on, never as off.
 */
export async function loadAskMeLatch(): Promise<void> {
  let text: string | null = null
  try { text = await fs.readFile(switchFile(), 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { latch = brokenLatch(err); return }
  }
  if (text !== null) {
    try {
      const file = JSON.parse(text) as SwitchFile
      latch = file && typeof file.on === 'boolean' && typeof file.at === 'string' ? file : brokenLatch('not a switch record')
    } catch (err) { latch = brokenLatch(err) }
    return
  }
  try {
    latch = { version: 1, on: storedAskMe(await getConfig()), at: new Date().toISOString() }
    await writeJsonFile(switchFile(), latch, { mode: 0o600 })
  } catch (err) {
    latch = brokenLatch(err)
  }
}

function brokenLatch(err: unknown): SwitchFile {
  log.web.warn('approvals: the switch file does not read, so approvals stay on', { error: err instanceof Error ? err.message : String(err) })
  return { version: 1, on: true, at: new Date().toISOString(), by: { unsigned: 'the switch file did not read' } }
}

/** Since when approvals have been on, as Walnut set them (undefined: off, or not read). */
export function askMeOnSince(): string | undefined {
  return latch?.on ? latch.at : undefined
}

/** A config as clients see it (config-broadcast.ts): the switch as it acts, on while Walnut holds it on. */
export function withSwitchAsItIs<T>(config: T): T {
  const c = config as { approvals?: { ask_me?: boolean } } | null
  if (!c || typeof c !== 'object' || c.approvals?.ask_me === true || !askMeOnSince()) return config
  return { ...c, approvals: { ...c.approvals, ask_me: true } } as T
}

/**
 * The one writer of the switch: the latch and config.yaml together. Off is written to the latch
 * first, on to config.yaml first, so a write that fails halfway leaves the switch on.
 */
export async function setAskMe(on: boolean, by: SwitchBy): Promise<void> {
  const { updateConfig } = await import('../config-manager.js')
  // `at` is when approvals went on: saving on again keeps it (keyMayTurnOff reads it).
  const wasOn = latch?.on === true
  const at = on && wasOn ? latch!.at : new Date().toISOString()
  const next: SwitchFile = { version: 1, on, at, by: on && wasOn && latch!.by ? latch!.by : by }
  const writeConfig = async () => updateConfig({ approvals: { ...(await getConfig()).approvals, ask_me: on } })
  const writeLatch = async () => { await writeJsonFile(switchFile(), next, { mode: 0o600 }); latch = next }
  if (on) { await writeConfig(); await writeLatch() } else { await writeLatch(); await writeConfig() }
  log.web.info(on ? 'approvals: turned on' : 'approvals: turned off', { by })
  // On again after an off: a turn-off still open (asked before that off) is withdrawn.
  if (on && !wasOn) {
    const { cancelInternal, listApprovals } = await import('./store.js')
    for (const a of (await listApprovals({ status: 'pending' })).filter((x) => x.turnsAskMeOff)) {
      await cancelInternal(a.id, 'approvals were turned on again').catch(() => undefined)
    }
  }
  // Every window's Settings and cards read the new switch (a signed off lands from another device).
  const { emitConfigChanged } = await import('../config-broadcast.js')
  emitConfigChanged(await getConfig(), ['web-ui'], { source: 'approvals' })
}

/**
 * Whether turning approvals off needs a device's signature: some device signs approvals, or the
 * keys file is there but does not read (a broken file never reads as "no device").
 */
export async function offNeedsSignature(): Promise<boolean> {
  let text: string
  try { text = await fs.readFile(path.join(WALNUT_HOME, 'approvals', 'keys.json'), 'utf8') } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  try {
    const file = JSON.parse(text) as { keys?: Array<{ status?: string }> }
    return !Array.isArray(file?.keys) || file.keys.some((k) => k?.status === 'active')
  } catch { return true }
}

/** How long a phone's key is active before it may turn approvals off even when it was added while they were on. */
export const PHONE_KEY_SETTLE_MS = 24 * 60 * 60_000

/**
 * Which device key may sign a turn-off: the Mac app's (its key comes only from the signed app's
 * own process, or a signed enrollment: keys.ts), or a phone's that was active before approvals
 * went on or for a day. A phone key rides a device token, which a process here can mint (keys.ts
 * known limit), so one an agent adds while approvals are on cannot turn them off at once; the
 * person's own new phone can after a day, and the Mac app at any time.
 */
export function keyMayTurnOff(key: { kind: string; activatedAt?: string; createdAt: string } | undefined, now = Date.now()): boolean {
  if (!key) return false
  if (key.kind === 'mac-app') return true
  const active = Date.parse(key.activatedAt ?? key.createdAt)
  if (Number.isNaN(active)) return false
  const since = latch?.on ? Date.parse(latch.at) : NaN
  return !(active > since) || now - active >= PHONE_KEY_SETTLE_MS
}

export const TURN_OFF_SIGNER_WORDS = 'This device was added after approvals were turned on, so for its first day it cannot turn them off: approve it in the Walnut Mac app with Touch ID, or with a device you had before.'

export const ASK_ME_OFF_WHAT = 'Turn approvals off: agents will post, send mail and run steps without asking you'

/** The approval that turns approvals off; one open at a time, so a repeated request asks once. */
export async function requestAskMeOff(requester: ApprovalRequester): Promise<ApprovalView> {
  const { createApproval, listApprovals } = await import('./store.js')
  const open = (await listApprovals({ status: 'pending' })).find((a) => a.turnsAskMeOff)
  if (open) return open
  const since = askMeOnSince()
  const { approval } = await createApproval({
    what: ASK_ME_OFF_WHAT,
    detail: `${since ? `Approvals have been on since ${since}. ` : ''}Approve only if you just turned approvals off yourself, in Settings or from a request. Every step that then goes ahead is listed in Settings, General.`,
    mode: 'biometric', outsideSwitch: true, turnsAskMeOff: true, timeoutMs: 10 * 60_000, requester,
  })
  return approval
}

/**
 * Called when an approval is decided (routes/approvals-v1.ts): a turn-off approved with an active
 * device key's signature over its own digest turns approvals off. Anything else changes nothing.
 */
export async function applyAskMeOff(a: ApprovalView): Promise<boolean> {
  if (!a.turnsAskMeOff || a.status !== 'approved' || a.answer?.mode !== 'biometric' || !a.answer.keyId || !a.answer.signature) return false
  const { activeKey } = await import('./keys.js')
  const { answerMessage, approvalDigest, verifySignature } = await import('./digest.js')
  const key = await activeKey(a.answer.keyId)
  const digest = approvalDigest({ id: a.id, mode: a.mode, createdAt: a.createdAt, expiresAt: a.expiresAt, host: a.requester.host, taskId: a.requester.taskId, what: a.what, detail: a.detail })
  if (!key || !keyMayTurnOff(key) || a.what !== ASK_ME_OFF_WHAT || digest !== a.digest || !verifySignature(key.publicKey, answerMessage(digest, 'approve'), a.answer.signature)) {
    log.web.warn('approvals: a turn-off approval did not carry a valid device signature; the switch stays on', { approvalId: a.id })
    return false
  }
  await setAskMe(false, { approvalId: a.id, keyId: key.id })
  return true
}

export function _resetAskMeLatchForTesting(): void {
  latch = null
}

/** Whether a step waits for the person now. */
export async function asksPerson(): Promise<boolean> {
  return askMeOf(await getConfig())
}

/**
 * Approvals are off: the step goes ahead, recorded as an approved approval nobody was asked
 * (no notice, no push, no word to the asker). Returns that record.
 */
export async function goAheadUnasked(gate: AskMeGate, input: { what: string; detail?: string; requester: ApprovalRequester; testRun?: string }): Promise<ApprovalView> {
  const { createApproval } = await import('./store.js')
  const { approval } = await createApproval({
    what: input.what.length > 300 ? `${input.what.slice(0, 299)}…` : input.what, ...(input.detail ? { detail: input.detail } : {}), mode: 'tap', requester: input.requester,
    unasked: gate, ...(input.testRun ? { testRun: input.testRun } : {}),
  })
  return approval
}

/**
 * The same record for a step that already went ahead on its own path (a mail sent through its
 * ledger, a host grant, a released password, a plugin's post): the person's list of what went
 * ahead unasked (Settings, General) reads these. Never throws: the step is done either way.
 */
export async function recordUnasked(gate: AskMeGate, input: { what: string; detail?: string; requester?: ApprovalRequester; testRun?: string }): Promise<void> {
  try {
    const { ambientTestRun } = await import('../test-run.js')
    const testRun = input.testRun ?? ambientTestRun()
    await goAheadUnasked(gate, { what: input.what, ...(input.detail ? { detail: input.detail } : {}), requester: input.requester ?? { host: (await import('node:os')).hostname() || 'this computer', local: true }, ...(testRun ? { testRun } : {}) })
  } catch (err) {
    const { log } = await import('../../logging/index.js')
    log.web.warn('approvals: recording a step that went ahead unasked failed', { gate, error: err instanceof Error ? err.message : String(err) })
  }
}
