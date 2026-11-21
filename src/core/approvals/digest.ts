/**
 * What an approval binds to, in a form every client can rebuild byte for byte.
 *
 * canonicalText() is plain lines, the free text in base64, so no client needs a JSON
 * canonicalizer and no newline in the text can forge a field. An answer names the digest of the
 * request its device showed (store.ts answerApproval refuses another), and a script that spends a
 * single-use approval rebuilds it from what it is about to run (cli-core.ts), so a yes fits one
 * request only.
 */

import crypto from 'node:crypto'
import type { ApprovalMode } from './types.js'

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
