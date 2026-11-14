/**
 * The Browser replay: a picture of each step an agent takes in the person's browser, kept on this
 * machine so the task's Browser view can play the run back later (2026-11-14, the user: "can we
 * make sure the browser action screenshot or video is saved for 7 days (configurable), and can be
 * played back").
 *
 * How a step is recorded (one capture path, the live view's own: the extension's agent-replay.ts):
 *   1. an agent's acting step (click, type, open, navigate...) leaves the act route with a one-use
 *      token in its `allow` (expectStep): only a step Walnut itself sent can be recorded;
 *   2. after its answer, the extension takes one picture of the tab, the way the live view and an
 *      agent's screenshot do (never switching, raising or focusing anything), shrunk to at most
 *      1280 px wide, and posts it with the token (POST /browser/view/replay);
 *   3. acceptStep checks the token, the browser and that the tab is still that task's, and writes
 *      the picture and one index line here.
 *
 * Where: WALNUT_HOME/browser/replays/<task id>/ (index.jsonl and one JPEG per step). `browser/` is
 * left out of the data repo's git sync (integrations/git-sync.ts GITIGNORE_BODY) and of the S3
 * backup (core/backup/scan.ts EXCLUDED_DIRS): the pictures can show private pages (a DM, a mail),
 * so they never leave this machine (tests/core/browser-control/replay-store.test.ts guards both).
 *
 * How long: `replayDays` in browser-control.json (Settings, Browser extension), 7 by default; 0
 * records nothing and deletes what was kept. The sweep (sweepReplays) runs at start, every hour and
 * on a change of the setting, and deletes every step older than that. Disk is bounded twice: by the
 * days, and by MAX_TOTAL_BYTES over all tasks, the oldest steps going first.
 *
 * Who reads: only a person (the routes refuse agents, as the live frame does): a picture is not
 * masked, so a password a page shows as text would show in it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** The default number of days a step's picture is kept. */
export const DEFAULT_REPLAY_DAYS = 7
/** The choices Settings offers (0: off). */
export const REPLAY_DAY_CHOICES = [0, 1, 3, 7, 14, 30] as const
/** All tasks' replays together stay under this; past it the oldest steps go. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
/** One step's picture at most (a 1280 px JPEG is about 50 to 200 KB). */
export const MAX_PICTURE_BYTES = 3 * 1024 * 1024
/** A token is good for this long after its step was sent (the longest step plus its picture). */
export const TOKEN_MS = 3 * 60_000
/** The most steps one list answer carries (the newest). */
export const LIST_MAX = 5000

/** One recorded step, as the index keeps it. */
export interface ReplayStep {
  id: string
  /** ISO time the picture was taken. */
  at: string
  action: string
  /** What the step did, in words ("Click button \"Send\""): never what was typed. */
  label: string
  ok: boolean
  /** The step's error code when it failed. */
  code?: string
  url?: string
  title?: string
  tab: number
  /** The picture's file in the task's folder; none when the tab could not be pictured. */
  file?: string
  bytes: number
}

const TASK_RE = /^[A-Za-z0-9_-]{1,100}$/
const ID_RE = /^[a-z0-9]{1,16}-[a-z0-9]{1,12}$/
const clean = (s: unknown, n: number): string | undefined => {
  if (typeof s !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : undefined
}

let homeOverride: string | undefined
async function root(): Promise<string> {
  if (homeOverride) return path.join(homeOverride, 'browser', 'replays')
  const { WALNUT_HOME } = await import('../../constants.js')
  return path.join(WALNUT_HOME, 'browser', 'replays')
}
async function taskDir(taskId: string): Promise<string> {
  if (!TASK_RE.test(taskId)) throw new Error(`bad task id ${taskId.slice(0, 40)}`)
  return path.join(await root(), taskId)
}

// ── one writer per task (appends and the sweep's rewrite never interleave) ──

const chains = new Map<string, Promise<unknown>>()
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = chains.get(key) ?? Promise.resolve()
  const mine = before.catch(() => undefined).then(work)
  const tail = mine.catch(() => undefined)
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return mine
}

// ── the setting ──

/** The days kept, from the browser settings file (sites.ts); a bad value reads as the default. */
export function daysOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 365 ? v : DEFAULT_REPLAY_DAYS
}
async function keptDays(): Promise<number> {
  const { readSites } = await import('./sites.js')
  return (await readSites()).replayDays
}

// ── tokens: only a step Walnut sent is recorded ──

interface Expect { taskId: string; device: string; action: string; args: Record<string, unknown>; at: number; used: boolean }
const expects = new Map<string, Expect>()

/** A step goes out: its token for the extension's picture, or none (not a task's, recording off). */
export async function expectStep(o: { owner: string; device: string; action: string; args: Record<string, unknown> }, now = Date.now()): Promise<string | undefined> {
  if (!o.owner.startsWith('task:')) return undefined
  const taskId = o.owner.slice(5)
  if (!TASK_RE.test(taskId)) return undefined
  if ((await keptDays()) === 0) return undefined
  for (const [k, e] of expects) if (now - e.at > TOKEN_MS) expects.delete(k)
  if (expects.size > 5000) return undefined
  const token = crypto.randomBytes(12).toString('hex')
  // Only what the label reads: never typed text or a file's bytes.
  const a = o.args
  const args: Record<string, unknown> = {}
  for (const k of ['url', 'key', 'ref', 'label', 'x', 'y', 'direction', 'accept'] as const) if (a[k] !== undefined && (typeof a[k] !== 'string' || (a[k] as string).length <= 4000)) args[k] = a[k]
  if (Array.isArray(a.fields)) args.fields = a.fields.length
  if (Array.isArray(a.files)) args.files = a.files.length
  else if (Array.isArray(a.paths)) args.files = a.paths.length
  expects.set(token, { taskId, device: o.device, action: o.action, args, at: now, used: false })
  return token
}

/** A web address as a line shows it: host and path, no query or fragment. */
export function shortUrl(u: unknown): string {
  if (typeof u !== 'string') return ''
  try {
    const x = new URL(u)
    const p = x.pathname === '/' ? '' : x.pathname
    const s = `${x.host}${p}`
    return s.length > 80 ? `${s.slice(0, 79)}…` : s
  } catch { return clean(u, 80) ?? '' }
}

/**
 * The step in words. `said` is the extension's own answer ("button \"Send\"", "12 characters into
 * textbox \"Search\""): names on the page, never the typed text.
 */
export function stepLabel(action: string, args: Record<string, unknown>, said?: string): string {
  const s = clean(said, 160)
  switch (action) {
    case 'open': return `Open ${shortUrl(args.url)}`.trim()
    case 'navigate': return `Go to ${shortUrl(args.url)}`.trim()
    case 'back': return 'Back'
    case 'click': return s ? `Click ${s}` : typeof args.label === 'number' ? `Click label ${args.label}` : typeof args.ref === 'string' ? `Click ${args.ref}` : typeof args.x === 'number' && typeof args.y === 'number' ? `Click at ${Math.round(args.x)}, ${Math.round(args.y)}` : 'Click'
    case 'type': return s ? `Type ${s}` : 'Type'
    case 'press': return `Press ${s ?? clean(args.key, 40) ?? 'a key'}`
    case 'select': return s ? `Select ${s}` : 'Select'
    case 'hover': return s ? `Hover ${s}` : 'Hover'
    case 'scroll': return s ? `Scroll ${s}` : `Scroll${typeof args.direction === 'string' ? ` ${clean(args.direction, 10)}` : ''}`
    case 'fill_form': return typeof args.fields === 'number' ? `Fill ${args.fields} field${args.fields === 1 ? '' : 's'}` : 'Fill a form'
    case 'drag': return s ? `Drag ${s}` : 'Drag'
    case 'upload': return typeof args.files === 'number' ? `Upload ${args.files} file${args.files === 1 ? '' : 's'}` : 'Upload'
    case 'fill_login': return 'Fill the sign-in'
    case 'fill_code': return 'Fill the one-time code'
    case 'dialog': return args.accept === false ? 'Dismiss a dialog' : 'Answer a dialog'
    default: return clean(action, 40) ?? 'Step'
  }
}

type Hub = Pick<typeof import('./hub.js'), 'tabOwner'>
/** A step's failure that is no step of its own: the act route sends it again (browser-v1.ts). */
const HELD_CODES = new Set(['outward_needs_ok', 'site_not_allowed'])

/** The page's address as kept: no query or fragment (a search's words, a token in a link). */
export function pageAddress(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined
  try {
    const x = new URL(u)
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return clean(`${x.protocol}`, 20)
    return `${x.origin}${x.pathname}`.slice(0, 2000)
  } catch { return undefined }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Decode a data: URL JPEG, or null (anything else, or too big). */
function pictureOf(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v.length > MAX_PICTURE_BYTES * 1.4) return null
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(v)
  if (!m) return null
  const b = Buffer.from(m[1], 'base64')
  // A JPEG starts FF D8.
  return b.length > 2 && b.length <= MAX_PICTURE_BYTES && b[0] === 0xff && b[1] === 0xd8 ? b : null
}

let seq = 0
/** A step's id: its time, then a counter (sorts as written). */
const newId = (at: number) => `${at.toString(36)}-${(++seq).toString(36)}`

/**
 * The extension's picture of a step (POST /browser/view/replay). Kept only for a token Walnut
 * gave this browser, once, for a tab that is still that task's.
 */
export async function acceptStep(h: Hub, device: string, b: Record<string, unknown>, now = Date.now()): Promise<{ kept: boolean; why?: string }> {
  const token = typeof b.token === 'string' ? b.token : ''
  const e = expects.get(token)
  if (!e || e.used || now - e.at > TOKEN_MS) return { kept: false, why: 'unknown_step' }
  if (e.device !== device) return { kept: false, why: 'other_browser' }
  const tab = typeof b.tab === 'number' && Number.isInteger(b.tab) && b.tab >= 0 ? b.tab : undefined
  if (tab === undefined) return { kept: false, why: 'bad_request' }
  // Used from here on, so two posts with one token never both count.
  e.used = true
  expects.delete(token)
  // The page held the step for a yes, or the site was not allowed yet: the act route sends it
  // again with a token of its own, and that send is the step.
  if (b.ok === false && typeof b.code === 'string' && HELD_CODES.has(b.code)) return { kept: false, why: 'held' }
  const owner = `task:${e.taskId}`
  // An open's new tab is the task's a moment after the extension's answer (the act route owns it).
  for (let i = 0; i < 6 && h.tabOwner(device, tab) === undefined && e.action === 'open'; i++) await sleep(250)
  if (h.tabOwner(device, tab) !== owner) return { kept: false, why: 'not_your_tab' }
  const days = await keptDays()
  if (days === 0) return { kept: false, why: 'off' }
  const picture = pictureOf(b.image)
  const at = typeof b.at === 'string' && !Number.isNaN(Date.parse(b.at)) && Math.abs(Date.parse(b.at) - now) < TOKEN_MS ? Date.parse(b.at) : now
  const id = newId(at)
  const step: ReplayStep = {
    id, at: new Date(at).toISOString(), action: e.action,
    label: stepLabel(e.action, e.args, typeof b.said === 'string' ? b.said : undefined),
    ok: b.ok !== false,
    ...(b.ok === false && typeof b.code === 'string' && /^[a-z_]{1,40}$/.test(b.code) ? { code: b.code } : {}),
    ...(pageAddress(b.url) ? { url: pageAddress(b.url) } : {}),
    ...(clean(b.title, 300) ? { title: clean(b.title, 300) } : {}),
    tab,
    ...(picture ? { file: `${id}.jpg` } : {}),
    bytes: picture?.length ?? 0,
  }
  await serial(e.taskId, async () => {
    const dir = await taskDir(e.taskId)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    if (picture) await fs.writeFile(path.join(dir, step.file!), picture, { mode: 0o600 })
    await fs.appendFile(path.join(dir, 'index.jsonl'), `${JSON.stringify(step)}\n`, { mode: 0o600 })
  })
  // Read again at the next ask (an increment could race a read under way).
  counts.delete(e.taskId)
  if (sweepRead.has(e.taskId)) addedSinceSweep += step.bytes
  totalKnown = totalKnown === undefined ? undefined : totalKnown + step.bytes
  // Past the cap: the oldest steps go now, not at the next hour.
  if (totalKnown !== undefined && totalKnown > MAX_TOTAL_BYTES) void sweepReplays().catch(() => undefined)
  return { kept: true }
}

// ── reading ──

async function readIndex(taskId: string): Promise<ReplayStep[]> {
  let text = ''
  try { text = await fs.readFile(path.join(await taskDir(taskId), 'index.jsonl'), 'utf8') } catch { return [] }
  const out: ReplayStep[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const s = JSON.parse(line) as ReplayStep
      if (typeof s?.id === 'string' && ID_RE.test(s.id) && typeof s.at === 'string') out.push(s)
    } catch { /* a line cut by a crash */ }
  }
  return out
}

/** How many steps a task has and when its last was (the Browser view's pill), cached. */
const counts = new Map<string, { steps: number; last?: string }>()

export async function replaySummary(taskId: string, now = Date.now()): Promise<{ steps: number; last?: string } | undefined> {
  if (!TASK_RE.test(taskId)) return undefined
  let c = counts.get(taskId)
  if (!c) {
    const steps = await listSteps(taskId, now)
    c = { steps: steps.length, ...(steps.length ? { last: steps[steps.length - 1].at } : {}) }
    if (counts.size > 500) counts.clear()
    counts.set(taskId, c)
  }
  return c.steps ? c : undefined
}

/** The task's steps, oldest first, inside the days kept (the newest LIST_MAX). */
export async function listSteps(taskId: string, now = Date.now()): Promise<ReplayStep[]> {
  if (!TASK_RE.test(taskId)) return []
  const days = await keptDays()
  if (days === 0) return []
  const cut = now - days * 86_400_000
  const all = (await readIndex(taskId)).filter((s) => Date.parse(s.at) >= cut)
  // In time order: two tabs' steps may land out of order.
  all.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  return all.slice(-LIST_MAX)
}

/** One step's picture, or null (gone, or never taken). */
export async function stepPicture(taskId: string, id: string, now = Date.now()): Promise<Buffer | null> {
  if (!TASK_RE.test(taskId) || !ID_RE.test(id)) return null
  // The id begins with the step's time: one past the days kept is gone, sweep or not, with no
  // read of the whole index per picture (a scrub through thousands of steps).
  const days = await keptDays()
  const at = parseInt(id.split('-')[0], 36)
  if (days === 0 || !Number.isFinite(at) || at < now - days * 86_400_000) return null
  try { return await fs.readFile(path.join(await taskDir(taskId), `${id}.jpg`)) } catch { return null }
}

// ── the sweep: days, then the cap ──

let totalKnown: number | undefined
/**
 * Bytes written to a task after the running sweep read it (they are added to its total), and
 * which tasks it read so far: a write before that read is in the sweep's own count.
 */
let addedSinceSweep = 0
const sweepRead = new Set<string>()

/** All tasks' steps on disk now, in bytes (Settings shows it). */
export async function replayBytes(): Promise<number> {
  if (totalKnown !== undefined) return totalKnown
  await sweepReplays()
  return totalKnown ?? 0
}

let sweeping: Promise<{ deleted: number; bytes: number }> | undefined
/** A sweep asked for while one ran: one more after it, with the setting as it is then. */
let again: Promise<{ deleted: number; bytes: number }> | undefined

/**
 * Delete every step older than the days kept (all of them when off), then the oldest over the cap.
 * A task left with no step loses its folder. Files no index line names (a crash between the
 * picture and its line) go too.
 */
export function sweepReplays(now?: number, cap = MAX_TOTAL_BYTES): Promise<{ deleted: number; bytes: number }> {
  if (sweeping) {
    again ??= sweeping.catch(() => undefined).then(() => { again = undefined; return sweepReplays(now, cap) })
    return again
  }
  sweeping = (async () => {
    try { return await sweepOnce(now ?? Date.now(), cap) } finally { sweeping = undefined }
  })()
  return sweeping
}

async function sweepOnce(now: number, cap: number): Promise<{ deleted: number; bytes: number }> {
  addedSinceSweep = 0
  sweepRead.clear()
  const days = await keptDays()
  const cut = days === 0 ? Infinity : now - days * 86_400_000
  const base = await root()
  let tasks: string[] = []
  try { tasks = (await fs.readdir(base)).filter((t) => TASK_RE.test(t)) } catch { totalKnown = 0; return { deleted: 0, bytes: 0 } }
  let deleted = 0
  const kept: Array<{ taskId: string; step: ReplayStep }> = []
  for (const taskId of tasks) {
    await serial(taskId, async () => {
      const dir = await taskDir(taskId)
      const steps = await readIndex(taskId)
      sweepRead.add(taskId)
      const keep = steps.filter((s) => Date.parse(s.at) >= cut)
      deleted += steps.length - keep.length
      await rewrite(dir, keep, steps.length)
      for (const s of keep) kept.push({ taskId, step: s })
    })
    counts.delete(taskId)
  }
  // Over the cap: the oldest steps of any task, until under nine tenths of it.
  let total = kept.reduce((n, k) => n + (k.step.bytes || 0), 0)
  if (total > cap) {
    kept.sort((a, b) => a.step.at.localeCompare(b.step.at))
    const drop = new Map<string, Set<string>>()
    for (const k of kept) {
      if (total <= cap * 0.9) break
      total -= k.step.bytes || 0
      if (!drop.has(k.taskId)) drop.set(k.taskId, new Set())
      drop.get(k.taskId)!.add(k.step.id)
      deleted++
    }
    for (const [taskId, ids] of drop) {
      await serial(taskId, async () => {
        const dir = await taskDir(taskId)
        const all = await readIndex(taskId)
        await rewrite(dir, all.filter((s) => !ids.has(s.id)), all.length)
      })
      counts.delete(taskId)
    }
  }
  // Steps written while this sweep ran (not in its count) still take room.
  totalKnown = total + addedSinceSweep
  sweepRead.clear()
  return { deleted, bytes: total }
}

/** The folder holds exactly these steps: the index rewritten whole, other pictures deleted, an empty folder removed. */
async function rewrite(dir: string, keep: ReplayStep[], before: number): Promise<void> {
  if (!keep.length) { await fs.rm(dir, { recursive: true, force: true }); return }
  // The index first: a crash between the two leaves a picture no line names (the next sweep
  // deletes it), never a line naming a deleted picture.
  if (keep.length !== before) {
    const tmp = path.join(dir, `.index-${crypto.randomBytes(4).toString('hex')}.tmp`)
    await fs.writeFile(tmp, keep.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 })
    await fs.rename(tmp, path.join(dir, 'index.jsonl'))
  }
  const names = new Set(keep.map((s) => s.file).filter(Boolean) as string[])
  let files: string[] = []
  try { files = await fs.readdir(dir) } catch { return }
  for (const f of files) {
    if ((f.endsWith('.jpg') && !names.has(f)) || (f.startsWith('.index-') && f.endsWith('.tmp'))) await fs.rm(path.join(dir, f), { force: true })
  }
}

// ── the hourly sweep ──

let timer: ReturnType<typeof setInterval> | undefined
let first: ReturnType<typeof setTimeout> | undefined

export function startReplaySweeper(): { stop: () => void } {
  const go = () => { void sweepReplays().catch(() => undefined) }
  if (!timer) {
    first = setTimeout(go, 60_000)
    first.unref?.()
    timer = setInterval(go, 60 * 60_000)
    timer.unref?.()
  }
  return { stop: () => { if (first) clearTimeout(first); if (timer) clearInterval(timer); first = undefined; timer = undefined } }
}

export function _resetReplayForTesting(home?: string): void {
  homeOverride = home
  expects.clear()
  counts.clear()
  chains.clear()
  totalKnown = undefined
  addedSinceSweep = 0
  sweeping = undefined
  again = undefined
}
