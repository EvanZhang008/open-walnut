/**
 * The cloud companion's copy of the pictures and files in the Mac's notes (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md). The copy itself is the one every
 * replica keeps (providers/attachment-copy-core.ts: a host daemon keeps the same one);
 * this file adds what only the box has: the door, and the pictures pasted on it.
 *
 *   rounds   the Mac's round (core/attachment-replica.ts) reaches the copy through the
 *            door of the notes copy (`POST /bridge/host-replica`, `attachments.*`), so
 *            the box answers `/api/notes-v2/attachment` and `/api/v1/notes/attachment`
 *            without its git-written disk.
 *   pastes   a picture pasted here is a pending `note-attachment` record (its bytes are a
 *            journal blob, read by companionAttachmentRead); when the Mac takes it, its
 *            bytes are kept in the copy as the box's own row until a manifest from after
 *            the ack names the path (the Mac wrote it there), or 10 minutes.
 *
 * Cloud companion only.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import type { JournalRecord } from '../providers/offline-journal-core.js'
import { createAttachmentCopy, type AttachmentCopy } from '../providers/attachment-copy-core.js'
import { followerKind } from './server-role.js'

/** The one home of the box's copy (it has one Mac). */
const HOME = 'mac'

export const companionAttachmentCopyDir = (): string => path.join(WALNUT_HOME, 'cache', 'replica', 'attachments')

let copy: AttachmentCopy | null = null
function theCopy(): AttachmentCopy {
  copy ??= createAttachmentCopy({
    fs, path, crypto,
    dirOf: () => companionAttachmentCopyDir(),
    log: (level, msg, data) => log.session[level](`companion ${msg}`, data),
  })
  return copy
}

const onCompanion = (): boolean => followerKind() === 'companion'

/** A vault-relative attachment path the copy may name, or null. */
export function attachmentKeyOf(raw: unknown): string | null {
  return theCopy().keyOf(raw)
}

/** One command of the Mac's attachments round (the door: web/routes/bridge-host-replica.ts). Never throws. */
export async function companionAttachmentCommand(cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!onCompanion()) return { ok: false, error: 'not a cloud companion' }
  return theCopy().command(HOME, cmd, params)
}

// ── reads ──

/** A whole manifest arrived at least once: the box's pictures come from here. */
export function companionAttachmentsHeld(): boolean {
  return onCompanion() && theCopy().held(HOME)
}

/** The pictures pasted here that the Mac has not taken: path -> the journal blob's sha. */
async function pendingPastes(): Promise<Map<string, string>> {
  const { companionJournalRecords } = await import('./companion-journal.js')
  const out = new Map<string, string>()
  for (const r of companionJournalRecords()) {
    if (r.kind === 'note-attachment' && !r.dropped && typeof r.path === 'string' && typeof r.oursBlob === 'string') out.set(r.path, r.oursBlob)
  }
  return out
}

/**
 * The file an embed names, as the box shows it: a picture pasted here first, then the
 * copy. `null` when the copy is held and names no such file; `undefined` when the box
 * should read its own disk (not a companion, or no whole manifest yet, and no paste of
 * that exact path).
 */
export async function companionAttachmentRead(raw: string, notePath?: string): Promise<{ rel: string; bytes: Buffer } | null | undefined> {
  if (!onCompanion()) return undefined
  const c = theCopy()
  const pastes = await pendingPastes()
  let rel: string | null
  if (c.held(HOME)) {
    const { resolveAttachmentInIndex } = await import('../web/routes/notes-attachment.js')
    rel = resolveAttachmentInIndex(raw, notePath, [...new Set([...pastes.keys(), ...c.keys(HOME)])])
  } else {
    // Before the first whole manifest the box's disk answers, but never for a picture pasted here.
    const exact = raw.split('|')[0]!.trim().replace(/^\/+/, '')
    rel = pastes.has(exact) || c.row(HOME, exact)?.own ? exact : null
    if (!rel) return undefined
  }
  if (!rel) return null
  const paste = pastes.get(rel)
  if (paste) {
    const { companionJournalBlobBody } = await import('./companion-journal.js')
    const bytes = companionJournalBlobBody(paste)
    if (bytes) return { rel, bytes }
  }
  const bytes = await c.readFile(HOME, rel)
  return bytes ? { rel, bytes } : null
}

/** Is `rel` a file the box shows (a paste here or the copy)? For a paste's name check. */
export async function companionAttachmentExists(rel: string): Promise<boolean> {
  if (!onCompanion()) return false
  return (await pendingPastes()).has(rel) || !!theCopy().row(HOME, rel)?.h
}

/**
 * The Mac took these pictures (its clock `macNow` once it wrote them), before the journal
 * lets their bytes go: each is kept here as the box's own until a manifest from after the
 * ack names it, so the picture never disappears from the box in between.
 */
export async function companionAttachmentsAcked(records: JournalRecord[], macNow: number): Promise<void> {
  if (!onCompanion()) return
  const { companionJournalBlobBody } = await import('./companion-journal.js')
  const c = theCopy()
  const files: Array<{ k: string; bytes: Buffer }> = []
  for (const r of records) {
    const k = c.keyOf(r.path)
    if (r.kind !== 'note-attachment' || r.dropped || !k || typeof r.oursBlob !== 'string') continue
    const bytes = companionJournalBlobBody(r.oursBlob)
    if (bytes) files.push({ k, bytes })
  }
  if (files.length === 0) return
  const n = await c.keepOwn(HOME, files, macNow)
  if (n > 0) log.session.info('companion attachments: the Mac took the pasted pictures; they show from here until its copy does', { pictures: n })
}

/** Tests: a fresh state over the files on disk. */
export function _resetCompanionAttachmentCopyForTesting(): void {
  copy?.forgetState()
}
