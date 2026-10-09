/**
 * Cloud REPLICA: the sentences a phone send is answered with, and the small
 * helpers the send path shares (cloud-session-send.ts, cloud-send-direct.ts).
 * Every sentence names the hop that failed, in one plain sentence.
 */

import type { Response } from 'express'
import { inHostTerms } from '../../core/hosts/host-display-name.js'

/** The bridge alias of the Mac's own daemon. */
export const MAC_BRIDGE_ALIAS = '__local__'

export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

/** Resolves 'deadline' at `by` (epoch ms). */
export function untilDeadline(by: number): Promise<'deadline'> {
  return new Promise((resolve) => { setTimeout(() => resolve('deadline'), Math.max(0, by - Date.now())).unref?.() })
}

/** A sentence that starts with a host's name ("your Mac" included) starts with a capital. */
export function capitalized(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The host has no bridge to the companion at all. */
export function notConnectedSentence(host: string, hostName: string): string {
  return host === MAC_BRIDGE_ALIAS
    ? "Your Mac isn't connected to the companion right now. Try again shortly."
    : `${capitalized(hostName)} isn't connected to the companion right now. Try again shortly.`
}

/**
 * One plain sentence for a send that could not be handed over, naming the hop
 * that failed. A field matrix found 503s reading "Send relay failed: bridge
 * disconnected" (the Mac's link) and "session.message: primary server timed
 * out" (the Mac's link to the host). The lower layer's words stay, in
 * parentheses, only when none of the known shapes fits.
 */
export function relayFailureSentence(err: string, host: string, hostName: string, label?: unknown): string {
  const e = err.toLowerCase()
  const isMac = host === MAC_BRIDGE_ALIAS
  if (e.includes('bridge disconnected') || e.includes('no live bridge')) return notConnectedSentence(host, hostName)
  // The host's daemon answered for the hop behind it: the Mac, or its link to the host.
  if (e.includes('primary server') || e.includes('no primary')) {
    return isMac ? "Your Mac isn't answering right now. Try again shortly." : `Your Mac can't reach ${hostName} right now. Try again shortly.`
  }
  // Nothing came back over the companion's own link to the host.
  if (e.includes('bridge request timed out')) {
    return isMac ? "Your Mac didn't answer in time. Try again shortly." : `${capitalized(hostName)} didn't answer in time. Try again shortly.`
  }
  // A lower layer's command name is not a word a person reads.
  const detail = inHostTerms(err, host, label).replace(/^(?:session\.message|send relay failed)\s*:\s*/i, '').replace(/[.\s]+$/, '')
  return `Couldn't hand the message to ${hostName} (${detail}). Try again shortly.`
}

/** A retry that waited out the deadline behind an earlier try of the same message. */
export function stillHandingOverSentence(hostName: string): string {
  return `An earlier try of this message is still being handed to ${hostName}. Try again shortly.`
}

/** The companion could not write down a message it would otherwise hold. */
export const NOT_SAVED_SENTENCE = "The companion couldn't save this message. Try again shortly."

/** Drop a banked row whose fate was settled by the attempt that held it. */
export async function unbankSend(messageId: string): Promise<void> {
  try {
    const { dropBankedSend } = await import('../../core/send-queue.js')
    await dropBankedSend(messageId)
  } catch { /* the sweep reads the settled outcome and drops it */ }
}

/** Fire-and-forget drain of anything banked during an earlier outage. */
export async function drainBankedSends(): Promise<void> {
  try {
    const { flushSendQueue } = await import('../../core/send-queue.js')
    await flushSendQueue()
  } catch { /* the 60s sweep and the reconnect hook remain */ }
}
