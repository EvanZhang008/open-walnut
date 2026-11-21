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
 * in a script, hook or CI step to be asked, so it always asks (routes/approvals-v1.ts); a
 * single-use approval; an OS dialog the system itself shows, a password item the person marked
 * never or sensitive, and the person-only doors (settings, answering an approval). Only a person
 * changes the switch (routes/config.ts), on any device they are signed in on, like an approval.
 *
 * The switch Walnut set last is kept in approvals/switch.json (read at boot, then held in memory),
 * and `askMeOf` reads on while either it or config.yaml says on: so a config.yaml edited by hand or
 * by another write path, or a whole-config PUT, can turn it on but never off. `setAskMe` is the one
 * writer (tests/core/approvals/ask-me-one-writer-guard.test.ts). Known limit: a process of this
 * account can still write the files under approvals/ before a restart, which the sessions' hook
 * refuses (providers/approvals-guard-hook.ts).
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
  browserUpload: 'Uploading a file from this computer into a web page',
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

/** Who set it: the person (an older Walnut also wrote a signed approval's id, or why it read as on). */
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
  // `at` is when approvals went on: saving on again keeps it.
  const wasOn = latch?.on === true
  const at = on && wasOn ? latch!.at : new Date().toISOString()
  const next: SwitchFile = { version: 1, on, at, by: on && wasOn && latch!.by ? latch!.by : by }
  const writeConfig = async () => updateConfig({ approvals: { ...(await getConfig()).approvals, ask_me: on } })
  const writeLatch = async () => { await writeJsonFile(switchFile(), next, { mode: 0o600 }); latch = next }
  if (on) { await writeConfig(); await writeLatch() } else { await writeLatch(); await writeConfig() }
  log.web.info(on ? 'approvals: turned on' : 'approvals: turned off', { by })
  // Every window's Settings and cards read the new switch (one set from another device too).
  const { emitConfigChanged } = await import('../config-broadcast.js')
  emitConfigChanged(await getConfig(), ['web-ui'], { source: 'approvals' })
}

export function _resetAskMeLatchForTesting(): void {
  latch = null
}

/**
 * The steps that still wait for the person's yes with approvals off: this list and nothing else
 * (2026-11-17, the user: "Only as me for payment, that is it."). A new one fails
 * tests/core/approvals/ask-me-gates-guard.test.ts until it is named here. A payment asks while the
 * person turned on the experiment `payments_always_ask` (Settings, Experimental).
 */
export const ASKS_WITH_APPROVALS_OFF = {
  payment: 'A step that buys or pays',
} as const
export type AlwaysAsked = keyof typeof ASKS_WITH_APPROVALS_OFF

/** Whether this step waits for the person: approvals on, or a step on ASKS_WITH_APPROVALS_OFF. */
export async function asksPerson(step?: AlwaysAsked): Promise<boolean> {
  const config = await getConfig()
  if (askMeOf(config)) return true
  if (step === 'payment') {
    const { experimentalEnabled } = await import('../experimental.js')
    return experimentalEnabled(config.experimental, 'payments_always_ask')
  }
  return false
}

/**
 * Approvals are off: the step goes ahead, recorded as an approved approval nobody was asked
 * (no notice, no push, no word to the asker). Returns that record.
 */
export async function goAheadUnasked(gate: AskMeGate, input: { what: string; detail?: string; requester: ApprovalRequester; testRun?: string }): Promise<ApprovalView> {
  const { createApproval } = await import('./store.js')
  const { approval } = await createApproval({
    what: input.what.length > 300 ? `${input.what.slice(0, 299)}…` : input.what, ...(input.detail ? { detail: input.detail, detailRole: 'summary' as const } : {}), requester: input.requester,
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
