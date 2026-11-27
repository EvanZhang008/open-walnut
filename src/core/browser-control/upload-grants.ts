/**
 * The person's yes for a trusted upload of a file on the browser's machine (routes/browser-v1.ts;
 * the extension's agent-upload.ts takes only these and the task's own downloads). A trusted upload
 * hands the browser a path on its own machine and the browser reads the file there, any size, with
 * no bytes crossing to the session's machine (2026-11-16: a 652 MB screen recording on the Mac, a
 * session on a cloud box).
 *
 * The Approvals switch decides, as for every other step (2026-11-17, the user: "don't ask me ...
 * Only as me for payment, that is it."): off (the default), the upload goes ahead and is recorded
 * where the person reads what went ahead unasked (`grantUnasked`; routes/browser-v1.ts). On, Walnut
 * asks the person (an approval on their Mac and phone, naming the task, the files and the site), and
 * their yes lets that task send those files into that site for a day. A no holds for an hour: the
 * same ask is refused at once, never put to them again and again.
 *
 * Why an ask and not the person's chat: a session's transcript lives on the session's host, where
 * the agent can write it, so a "person" row there proves nothing (review 2026-11-16). The ask is
 * answered like every approval: a tap on any device the person is signed in on.
 */
import { askEndOf, type ApprovalRequester, type AskEnd } from '../approvals/types.js'
import { keptMap } from '../kept-asks.js'

/** How long a yes lets the task send the same file again. */
export const GRANT_MS = 24 * 3600_000
/** How long a no holds. */
export const DENIED_MS = 3600_000
/** An ask's short clock (one an older Walnut kept, or one past store.ts UNTIL_BACK_MAX); else it waits until the person answers (store.ts untilBack). */
export const ASK_MS = 10 * 60_000
/** The extension's cap for taking granted paths (packages/browser-extension/src/agent.ts). */
export const UPLOAD_GRANTED = 'upload-granted'
/** The extension's cap: Chrome lets it hand a page a file from disk ("Allow access to file URLs"). */
export const FILE_ACCESS = 'file-access'

// Kept across a restart (core/kept-asks.ts): the agent's next call after a deploy finds its ask,
// and a yes or a no the person gave still holds.
/** `${taskId}\0${site}\0${path}` → until when the person's yes holds. */
const grants = keptMap<number>('browser-upload-grants')
/** The same key → until when their no holds. */
const denials = keptMap<number>('browser-upload-denials')
/** An ask's id → whose, into which site and for which files; `end`: the approval's own end (absent in one an older Walnut kept: ASK_MS after `at`). */
const asks = keptMap<{ taskId: string; site: string; paths: string[]; at: number; end?: AskEnd }>('browser-upload-asks')
const endOf = (a: { at: number; end?: AskEnd }): AskEnd => a.end ?? { until: a.at + ASK_MS }

/** A yes or a no whose time is over is dropped (the files keep only what still holds). */
function hold(map: Map<string, number>, k: string, until: number, now = Date.now()): void {
  for (const [x, u] of map) if (u <= now) map.delete(x)
  map.set(k, until)
}

const key = (taskId: string, site: string, p: string) => `${taskId}\0${site}\0${p}`

/**
 * A path the browser can read as one file, shown as it is read: absolute, no folder mark (a trailing
 * slash), no `..`, and no character that reads as another or as nothing (controls, bidi marks,
 * zero-width ones) and no space at either end.
 */
export function isFilePath(p: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(p) && !/[\\/]$/.test(p) && !p.split(/[\\/]/).includes('..')
    && p === p.trim() && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(p)
}

/** Which of `paths` the person let this task send into `site`, now. */
export function grantedOf(taskId: string, site: string, paths: string[], now = Date.now()): string[] {
  return paths.filter((p) => (grants.get(key(taskId, site, p)) ?? 0) > now)
}

/** Which of `paths` the person said no to for this task and site within the hour. */
export function deniedOf(taskId: string, site: string, paths: string[], now = Date.now()): string[] {
  return paths.filter((p) => (denials.get(key(taskId, site, p)) ?? 0) > now)
}

export interface AskWords { what: string; detail: string }

/** A path as the person knows it: under `~` for their home folder. */
function shown(p: string): string {
  const m = /^(?:\/Users|\/home)\/[^/]+\/(.+)$/.exec(p)
  return m ? `~/${m[1]}` : p
}

/** What the person reads: the task, the files (by their path) and the site. */
export function askWords(paths: string[], site: string, taskTitle: string | undefined): AskWords {
  const into = site || 'a web page'
  const files = paths.length === 1 ? shown(paths[0]) : paths.length <= 3 ? paths.map((p) => p.split(/[\\/]/).pop() || p).join(', ') : `${paths.length} files`
  return {
    what: `Upload ${files} from this computer into ${into}`,
    detail: `${taskTitle ? `Task "${taskTitle}" asks` : 'An agent asks'} to put ${paths.length === 1 ? 'this file' : 'these files'} into a file field on ${into}. `
      + `Allow lets that task send ${paths.length === 1 ? 'it' : 'them'} into ${into} for a day.\n${paths.join('\n')}`,
  }
}

/** Ask the person, or the open ask for the same task and files. */
export async function askUpload(input: { taskId: string; paths: string[]; site: string; requester: ApprovalRequester; testRun?: string; now?: number }): Promise<{ id: string; reused: boolean; end: AskEnd }> {
  const now = input.now ?? Date.now()
  const want = [...input.paths].sort().join('\n')
  const { getApproval, createApproval } = await import('../approvals/store.js')
  for (const [id, a] of asks) {
    if (now > endOf(a).until) { asks.delete(id); continue }
    if (a.taskId === input.taskId && a.site === input.site && [...a.paths].sort().join('\n') === want && (await getApproval(id))?.status === 'pending') return { id, reused: true, end: endOf(a) }
  }
  const words = askWords(input.paths, input.site, input.requester.taskTitle)
  const { approval } = await createApproval({
    // Open until the person answers, while they are away too; the asking session is told the answer.
    what: words.what, detail: words.detail, detailRole: 'summary', timeoutMs: ASK_MS, untilBack: true,
    requester: input.requester, ...(input.testRun ? { testRun: input.testRun } : {}),
  })
  const end = askEndOf(approval)
  asks.set(approval.id, { taskId: input.taskId, site: input.site, paths: [...input.paths], at: now, end })
  return { id: approval.id, reused: false, end }
}

export type AnswerState = 'approved' | 'pending' | 'denied' | 'unknown'

/**
 * The person's answer to ask `id`, held up to `holdMs` for it. Only the task that asked, into the
 * site it named, and only for the files it named; a yes grants them for GRANT_MS, a no holds DENIED_MS.
 */
export async function answerUpload(input: { id: string; taskId: string; site: string; paths: string[]; holdMs: number }): Promise<AnswerState> {
  const a = asks.get(input.id)
  if (!a || a.taskId !== input.taskId || a.site !== input.site || !input.paths.every((p) => a.paths.includes(p))) return 'unknown'
  const { getApproval } = await import('../approvals/store.js')
  const until = Date.now() + Math.max(0, input.holdMs)
  for (;;) {
    const rec = await getApproval(input.id)
    if (!rec) { asks.delete(input.id); return 'unknown' }
    if (rec.status === 'approved') {
      asks.delete(input.id)
      const at = Date.now()
      for (const p of a.paths) hold(grants, key(a.taskId, a.site, p), at + GRANT_MS, at)
      return 'approved'
    }
    if (rec.status === 'denied') {
      asks.delete(input.id)
      for (const p of a.paths) hold(denials, key(a.taskId, a.site, p), Date.now() + DENIED_MS)
      return 'denied'
    }
    if (rec.status !== 'pending') { asks.delete(input.id); return 'unknown' }
    if (Date.now() >= until) return 'pending'
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(50, until - Date.now()))))
  }
}

/**
 * An ask of this task, into this site, for these files, that the person already answered: claimed
 * as answerUpload would (a yes the agent never came back for, its call cut off on the way, is not
 * asked again).
 */
export async function settledAsk(taskId: string, site: string, paths: string[]): Promise<AnswerState> {
  for (const [id, a] of asks) {
    if (a.taskId !== taskId || a.site !== site || !paths.every((p) => a.paths.includes(p))) continue
    const state = await answerUpload({ id, taskId, site, paths, holdMs: 0 })
    if (state === 'approved' || state === 'denied') return state
  }
  return 'unknown'
}

/** Approvals off: these files went ahead unasked (recorded by the caller), and hold as a yes would. */
export function grantUnasked(taskId: string, site: string, paths: string[], now = Date.now()): void {
  for (const p of paths) hold(grants, key(taskId, site, p), now + GRANT_MS, now)
}

/** When ask `id` ends (undefined: no such ask). */
export function uploadAskEnd(id: string): AskEnd | undefined {
  const a = asks.get(id)
  return a ? endOf(a) : undefined
}

/** Tests: forget every ask and grant. */
export function _resetUploadGrantsForTesting(): void { grants.clear(); denials.clear(); asks.clear() }
