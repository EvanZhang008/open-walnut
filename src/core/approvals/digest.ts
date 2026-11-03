/**
 * What an approval binds to, in a form every client can rebuild byte for byte.
 *
 * canonicalText() is plain lines, the free text in base64, so no client needs a JSON
 * canonicalizer and no newline in the text can forge a field. The iPhone and the Mac app
 * rebuild it from the fields they show, hash it, and sign answerMessage() over that hash:
 * the person signs what they read, and a signature fits one request only.
 * Mirrored in ios-native/Walnut/Core/ApprovalSigning.swift and desktop/ApprovalBridge.swift.
 */

import crypto from 'node:crypto'
import type { ApprovalDecision, ApprovalMode } from './types.js'

export interface DigestFields {
  id: string
  mode: ApprovalMode
  createdAt: string
  expiresAt: string
  host: string
  taskId?: string
  what: string
  detail?: string
}

const b64 = (s: string | undefined): string => Buffer.from(s ?? '', 'utf8').toString('base64')

export function canonicalText(f: DigestFields): string {
  return [
    'walnut-approval-v1',
    `id=${f.id}`,
    `mode=${f.mode}`,
    `created=${f.createdAt}`,
    `expires=${f.expiresAt}`,
    `host=${b64(f.host)}`,
    `task=${f.taskId ?? ''}`,
    `what=${b64(f.what)}`,
    `detail=${b64(f.detail)}`,
  ].join('\n')
}

export function approvalDigest(f: DigestFields): string {
  return crypto.createHash('sha256').update(canonicalText(f), 'utf8').digest('hex')
}

/** The bytes a device key signs to answer: one decision on one digest. */
export function answerMessage(digest: string, decision: ApprovalDecision): string {
  return `walnut-approval-answer-v1\n${digest}\n${decision}`
}

/** The bytes a device signs to show it holds its key when it enrolls (no biometry needed). */
export function enrollMessage(publicKey: string): string {
  return `walnut-approval-enroll-v1\n${publicKey}`
}

/** A P-256 public key in base64 DER SPKI, or null when it is not one. */
export function parsePublicKey(spkiB64: string): crypto.KeyObject | null {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec') return null
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null
    return key
  } catch {
    return null
  }
}

/** ECDSA P-256 / SHA-256 over `message`, signature base64 DER (CryptoKit's derRepresentation). */
export function verifySignature(spkiB64: string, message: string, signatureB64: string): boolean {
  const key = parsePublicKey(spkiB64)
  if (!key) return false
  try {
    return crypto.verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'der' }, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

/** A short stable id for a key: the first 16 hex of sha256(SPKI DER). */
export function keyIdOf(spkiB64: string): string {
  return 'ak-' + crypto.createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').slice(0, 16)
}
