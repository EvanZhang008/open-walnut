/**
 * An agent's ask for a locked note (docs/reference/locked-notes.md, "Agents"): the user's words of
 * 2026-11-24, "only human can edit it, or ai can also do it with my password". An agent never gets
 * the key or a vault session. It asks to read (or to change) one locked note and says why; the person
 * gets an approval card that always asks, whatever the Approvals switch says, and approving it needs
 * Passwords unlocked in the window that answers (`needsPasswords`), so the master password was typed
 * there. The yes covers that note, that task and that session only:
 *
 *   read: the same ask may read the text for READ_MS after the yes (a long note comes in pages);
 *   edit: the same, for EDIT_MS, and the same task may save the note in that time.
 *
 * The window starts at the yes, not at the first read: an ask read days later gives nothing. An ask
 * that names a task's session must come from inside it (approvals/seen-inside.ts), every call: a
 * session id is only a name, which another process can copy with the wait token. One that names
 * none asks as its host.
 *
 * Asks are kept across a restart (kept-asks.ts: the token only as its hash, never the text), so a
 * deploy during a wait asks the person nothing twice; Lock all ends them (endAllLockedNoteAsks).
 * Brakes per asker: at most 2 waiting, and 3 denials in 30 minutes pause its asks for 30 minutes.
 */
import crypto from 'node:crypto'
import { HIDDEN_NOTE_AGENT_TEXT, LockedNoteError } from './locked-note.js'
import { keptMap } from '../kept-asks.js'
import { notSeenInsideWhy } from '../approvals/seen-inside.js'
import type { ApprovalRequester } from '../approvals/types.js'

export const EDIT_MS = 30 * 60_000
export const READ_MS = 10 * 60_000
export const ASK_TIMEOUT_MS = 10 * 60_000
const ASK_MAX = 2
const DENY_MAX = 3
const DENY_WINDOW_MS = 30 * 60_000

export type LockedNoteAccess = 'read' | 'edit'

/** Who asked: the approval's requester (host, task, session), as the approval keeps it. */
export type LockedNoteRequester = ApprovalRequester

interface Ask {
  approvalId: string
  /** When it was asked. */
  at: number
  /** When its approval runs out (absent in one an older Walnut kept: ASK_TIMEOUT_MS after `at`): a pending ask past it is swept. */
  until?: number
  tokenHash: string
  path: string
  access: LockedNoteAccess
  asker: string
  requester: LockedNoteRequester
  /** The note's id when asked: the yes is for that note, never another one put at its path since. */
  noteId: string
  /** Set once the person said yes and the text was first released. */
  releasedAt?: number
  /** Until when the same ask may read the text again (pages of a long note), from the yes. */
  readUntil?: number
  /** Until when a save is allowed (edit only), from the yes. */
  editUntil?: number
}

export interface AskDeps {
  /** `untilBack`: the ask stays open until the person answers (approvals/store.ts). */
  askPerson(input: { what: string; detail: string; timeoutMs: number; untilBack?: boolean; requester: LockedNoteRequester; testRun?: string }): Promise<{ id: string; waitToken: string; expiresAt: string }>
  /** `answeredAt`: when the person answered (the approval's answer.at), where the window starts. */
  waitApproval(id: string, waitToken: string, waitMs: number): Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired' | 'canceled'; answeredBy?: string; answeredAt?: string }>
  cancelApproval(id: string): Promise<void>
  /** The note's text, as the person reads it (locked-note-store.ts readLockedNote). */
  read(path: string): Promise<{ content: string; contentHash: string; updatedAt: string; path: string }>
  /** Save the note's text sealed (locked-note-store.ts writeLockedNote). */
  save(path: string, content: unknown, expectedHash: unknown): Promise<{ contentHash: string; updatedAt: string; path: string }>
  /** The id of the locked note at `path` now ('' when it has none), or null when no locked note is there. */
  lockedNoteId(path: string): Promise<string | null>
  /** Whether a hidden note is at `path` (docs/reference/locked-notes.md, "Hidden notes"): no ask opens one. */
  hiddenNote?(path: string): Promise<boolean>
  /** The approval's state now (undefined: cannot tell): an ask the person answered no longer counts as waiting. */
  approvalStatus?(id: string): Promise<string | undefined>
  now?: () => number
}

const asks = keptMap<Ask>('locked-note-asks')
const denials = keptMap<number[]>('locked-note-denials')
/** Bumped by Lock all: a wait that began before it gives nothing after it. */
let epoch = 0

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const refuse = (status: number, code: string, message: string): never => { throw new LockedNoteError(message, status, code) }

function askerOf(r: LockedNoteRequester): string {
  return r.taskId ? `task:${r.taskId}` : `host:${r.host}`
}

/** A call that names a task's session comes from inside it, as Walnut saw (403 unverified_session). */
function seenInside(r: LockedNoteRequester): void {
  if (!r.taskId && !r.sessionId) return
  if (r.identity === 'verified') return
  refuse(403, 'unverified_session', `Only the session that asked opens a locked note, and Walnut must see the call come from inside it: ${notSeenInsideWhy(r) ?? 'it was not seen there'}. `
    + 'Call it from that session through its own Walnut tools (its MCP tools, or the walnut CLI in its shell). Nothing was given.')
}

/** The ask's own task, seen from inside its session. */
function sameAsker(a: Ask, requester: LockedNoteRequester): void {
  seenInside(requester)
  if (askerOf(requester) !== a.asker) refuse(403, 'not_your_ask', 'Only the task that asked may use this ask.')
}

function cleanPurpose(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (p.length < 4) refuse(400, 'purpose_required', 'Say why in `purpose` (at least a few words the user reads before deciding).')
  return p.length > 200 ? `${p.slice(0, 199)}…` : p
}

function noteName(p: string): string {
  return p.replace(/\.md$/i, '').split('/').pop() || p
}

/** Ask to read (or change) a locked note. Answers the request id and the wait token. */
export async function askLockedNote(input: { path: unknown; purpose: unknown; access?: unknown; requester: LockedNoteRequester; testRun?: string }, deps: AskDeps) {
  const path = typeof input.path === 'string' ? input.path.trim().replace(/^\/+/, '') : ''
  if (!path) refuse(400, 'bad_path', 'path is required')
  const notePath = path.endsWith('.md') ? path : `${path}.md`
  const access: LockedNoteAccess = input.access === 'edit' ? 'edit' : 'read'
  const purpose = cleanPurpose(input.purpose)
  // A card naming a task the call is not seen inside would be a yes nobody can use, or the wrong one.
  seenInside(input.requester)
  const noteId = await deps.lockedNoteId(notePath)
  if (noteId === null && await deps.hiddenNote?.(notePath)) {
    refuse(409, 'note_hidden', `This note is hidden, not locked, and no ask opens it: no tool reads a hidden note. ${HIDDEN_NOTE_AGENT_TEXT}`)
  }
  if (noteId === null) refuse(409, 'not_locked', 'This note is not locked: read it with note_read.')
  const now = (deps.now ?? Date.now)()
  for (const [id, a] of asks) if (a.readUntil ? now > a.readUntil : now > (a.until ?? a.at + ASK_TIMEOUT_MS) + 60_000) asks.delete(id)
  const asker = askerOf(input.requester)
  // Only asks still open on the person's devices count as waiting (an ask stays open until they
  // answer). A no the agent was told about and never read is taken as the wait takes it: counted
  // toward the pause, and the ask dropped.
  const mine = [...asks.values()].filter((a) => a.asker === asker && !a.releasedAt)
  const states = await Promise.all(mine.map(async (a) => (await deps.approvalStatus?.(a.approvalId).catch(() => undefined)) ?? 'pending'))
  mine.forEach((a, i) => {
    if (states[i] !== 'denied') return
    asks.delete(a.approvalId)
    denials.set(asker, [...(denials.get(asker) ?? []).filter((t) => now - t < DENY_WINDOW_MS), now])
  })
  const recent = (denials.get(asker) ?? []).filter((t) => now - t < DENY_WINDOW_MS)
  if (recent.length >= DENY_MAX) refuse(429, 'agent_paused', 'The user said no three times in the last half hour: do not ask again now; ask them in words if it is still needed.')
  // Unknown (the record cannot be read) counts as waiting.
  const waiting = states.filter((st) => st === 'pending').length
  if (waiting >= ASK_MAX) refuse(429, 'too_many_asks', 'This task already waits for the user on locked notes: wait for that answer first.')
  const who = input.requester.taskTitle ? `the task "${input.requester.taskTitle}"` : `an agent on ${input.requester.host}`
  const what = access === 'edit'
    ? `Let ${who} read and change your locked note "${noteName(notePath)}"`
    : `Let ${who} read your locked note "${noteName(notePath)}"`
  const detail = [
    `Why: ${purpose}`,
    `Note: ${notePath}`,
    access === 'edit'
      ? `If you approve, it may read this note and save changes to it for the next ${EDIT_MS / 60_000} minutes. Nothing else.`
      : `If you approve, it may read this note for the next ${READ_MS / 60_000} minutes. It cannot change it.`,
    'Approving asks for your Passwords master password.',
    `The text then goes into that agent's conversation on ${input.requester.host} (a long answer may also be written to a file there), and what it writes about the note can be searched like any of its words.`,
  ].join('\n')
  // Open until the person answers, while they are away too; the asking session is told the answer.
  const made = await deps.askPerson({ what, detail, timeoutMs: ASK_TIMEOUT_MS, untilBack: true, requester: input.requester, ...(input.testRun ? { testRun: input.testRun } : {}) })
  const until = Date.parse(made.expiresAt)
  asks.set(made.id, { approvalId: made.id, at: now, ...(Number.isFinite(until) ? { until } : {}), tokenHash: sha(made.waitToken), path: notePath, access, asker, requester: input.requester, noteId: noteId! })
  return { status: 'pending' as const, requestId: made.id, waitToken: made.waitToken, expiresAt: made.expiresAt, access, path: notePath }
}

function own(id: string, token: unknown): Ask {
  const a = asks.get(id)
  if (!a || typeof token !== 'string' || sha(token) !== a.tokenHash) refuse(404, 'not_found', 'No such ask (a restart or Lock all ends asks): ask again if it is still needed.')
  return a!
}

function released(a: Ask, note: { path: string; content: string; contentHash: string }, answeredBy?: string) {
  return {
    status: 'released' as const, path: note.path, content: note.content, contentHash: note.contentHash,
    readUntil: new Date(a.readUntil!).toISOString(),
    ...(a.access === 'edit' ? { editUntil: new Date(a.editUntil!).toISOString() } : {}),
    ...(answeredBy ? { approvedOn: answeredBy } : {}),
  }
}

/** Only while the same note (by its id) is at the ask's path. */
async function sameNote(id: string, a: Ask, deps: AskDeps): Promise<void> {
  if ((await deps.lockedNoteId(a.path)) !== a.noteId) {
    asks.delete(id)
    refuse(409, 'note_changed', 'The note at this path is no longer the one the user approved (moved, replaced or unlocked): nothing was given. Ask again if it is still needed.')
  }
}

/** Wait for the person's answer; on a yes, the text, again (by pages) until the ask's window ends. */
export async function waitLockedNote(id: string, token: unknown, waitMs: number, requester: LockedNoteRequester, deps: AskDeps) {
  const a = own(id, token)
  sameAsker(a, requester)
  if (a.releasedAt) {
    if ((deps.now ?? Date.now)() > a.readUntil!) { asks.delete(id); refuse(403, 'read_ended', 'The time to read this note ended: ask again if it is still needed.') }
    await sameNote(id, a, deps)
    return released(a, await deps.read(a.path))
  }
  const since = epoch
  const r = await deps.waitApproval(id, token as string, waitMs)
  if (since !== epoch || !asks.has(id)) refuse(409, 'withdrawn', 'The ask was withdrawn (Passwords locked everywhere): nothing was given.')
  if (r.status === 'pending') return { status: 'pending' as const, requestId: id }
  if (r.status === 'denied') {
    asks.delete(id)
    const now = (deps.now ?? Date.now)()
    denials.set(a.asker, [...(denials.get(a.asker) ?? []).filter((t) => now - t < DENY_WINDOW_MS), now])
    refuse(403, 'denied', 'The user said no. Do not ask again unless they say so.')
  }
  if (r.status !== 'approved') { asks.delete(id); return { status: r.status } }
  // The window runs from the yes (the card said "for the next 10 minutes"), never from a first read
  // days later. No answer time (an older record) counts from the ask, which came before it.
  const now = (deps.now ?? Date.now)()
  const answered = r.answeredAt ? Date.parse(r.answeredAt) : NaN
  const until = Math.min(now, Number.isFinite(answered) ? answered : a.at) + (a.access === 'edit' ? EDIT_MS : READ_MS)
  if (now > until) { asks.delete(id); refuse(403, 'read_ended', 'The time to read this note ended before it was read: ask again if it is still needed. Nothing was given.') }
  await sameNote(id, a, deps)
  const note = await deps.read(a.path)
  a.releasedAt = now
  a.readUntil = until
  if (a.access === 'edit') a.editUntil = until
  asks.changed()
  return released(a, note, r.answeredBy)
}

/** Save a locked note under an approved edit ask (same task, same note, inside its window). */
export async function saveLockedNoteForAgent(id: string, token: unknown, content: unknown, expectedHash: unknown, requester: LockedNoteRequester, deps: AskDeps) {
  const a = own(id, token)
  sameAsker(a, requester)
  // A save on no hash would overwrite whatever the person saved meanwhile, with no conflict shown.
  if (typeof expectedHash !== 'string' || !expectedHash.trim()) {
    refuse(400, 'expected_hash_required', 'Pass expectedHash: the contentHash locked_note_wait gave, or the one your last save answered. Nothing was saved.')
  }
  const now = (deps.now ?? Date.now)()
  if (a.access !== 'edit' || !a.editUntil) refuse(403, 'not_approved', 'This ask was not approved for changes: ask with access "edit".')
  if (now > a.editUntil!) { asks.delete(id); refuse(403, 'edit_ended', 'The time to change this note ended: ask again if it is still needed.') }
  await sameNote(id, a, deps)
  return deps.save(a.path, content, expectedHash)
}

/** Withdraw an ask still waiting (the step is no longer needed). */
export async function cancelLockedNoteAsk(id: string, token: unknown, deps: Pick<AskDeps, 'cancelApproval'>): Promise<void> {
  own(id, token)
  asks.delete(id)
  await deps.cancelApproval(id).catch(() => undefined)
}

/** Lock all: every ask ends, waiting or approved for edit. Answers the approval ids to withdraw. */
export function endAllLockedNoteAsks(): string[] {
  epoch++
  const ids = [...asks.keys()]
  asks.clear()
  return ids
}

export function resetLockedNoteAsksForTest(): void {
  asks.clear()
  denials.clear()
  epoch++
}
