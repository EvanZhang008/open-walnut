/**
 * What a command of the transfer client (daemon-transfer-client.ts) answers when it does not
 * get its work done, told apart by kind: the host away, this server stopping, the daemon's refusal.
 * And which commands may go again when the link was lost under them.
 */
import { ServerStoppingError, serverStopNote } from '../server-stopping.js'

/** The host is not connected (and could not be dialed in time, nor came back within a link wait). */
export class TransferHostOfflineError extends Error {
  constructor(public host: string, waitedMs = 0) {
    super(`Walnut is not connected to ${host === '__local__' ? 'this Mac' : host} right now`
      + (waitedMs >= 60_000 ? ` (it waited ${Math.round(waitedMs / 60_000)} min for the link to come back).` : '.'))
    this.name = 'TransferHostOfflineError'
  }
}

/**
 * This Walnut server is stopping (server-stopping.ts): the command found no link, or lost the one it
 * was on, because the stop closes every daemon link. Says nothing about the host, so it is never a
 * TransferHostOfflineError (2026-11-12: three moves cut by a deploy read "not connected to this Mac").
 */
export class TransferServerStoppingError extends ServerStoppingError {
  constructor(public host: string, readonly command?: string) {
    super(`The Walnut server is restarting${serverStopNote()}; that closed its link to ${host === '__local__' ? 'this Mac' : host}, which is still fine.`)
    this.name = 'TransferServerStoppingError'
  }
}

/** A daemon answered `ok:false`: its message (without the command prefix), code and extra fields. */
export class TransferCommandError extends Error {
  constructor(message: string, public host: string, public command: string, public code: string, public data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'TransferCommandError'
  }
}

/**
 * Commands that may run twice with no harm, sent again inside a link wait when the link was lost
 * under them and their answer never came: reads, and a pack into a folder of its own (the first may
 * still be writing its own). transfer.apply, transfer.clear, transfer.fetch, fs.writePart and
 * upload.part are never here: a second run of those could do the work twice (a relay resumes its
 * parts from the receiver's own count instead).
 */
const same = (p: Record<string, unknown>) => p
export const RESEND_ON_LOST: Readonly<Record<string, (params: Record<string, unknown>, attempt: number) => Record<string, unknown>>> = {
  'transfer.scan': same, 'transfer.realpath': same, 'transfer.reach': same, 'transfer.recent': same,
  'host.facts': same, 'host.load': same, 'host.endpoint': same,
  'transfer.pack': (p, n) => ({ ...p, outDir: `${String(p.outDir).replace(/\/+$/, '')}-again-${n}` }),
}

