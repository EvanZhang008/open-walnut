/**
 * The exact model windows Claude Code reported, kept on disk per host+model
 * (`WALNUT_HOME/cache/model-windows.json`), so a restart does not send every session back to the
 * name rule until its first turn ends.
 *
 * 2026-11-07, the user: "how to find the actual model context window for the current model ... not
 * by string matching which is flaky". The CLI gives its window only at a turn END
 * (`result.modelUsage[model].contextWindow`) or, when no setting clamps it, in `get_context_usage`;
 * the cache in context-window.ts held both in memory only, so each deploy emptied it and a
 * reloaded Opus 5.5 session read its 200K name guess again.
 *
 * Only exact readings are kept (context-window.ts refuses anything else). A session's own reading
 * always wins over the file, and every new reading rewrites it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'
import {
  learnedModelWindows, onModelWindowLearned, seedModelWindows, type LearnedModelWindow,
} from './context-window.js'

let filePath: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let started = false

async function storePath(): Promise<string> {
  if (filePath) return filePath
  const { WALNUT_HOME } = await import('../constants.js')
  filePath = path.join(WALNUT_HOME, 'cache', 'model-windows.json')
  return filePath
}

async function save(): Promise<void> {
  try {
    const file = await storePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const { writeFileAtomic } = await import('../core/config-store.js')
    await writeFileAtomic(file, JSON.stringify({ version: 1, windows: learnedModelWindows() }))
  } catch (err) {
    log.session.warn('model windows: not saved', { error: err instanceof Error ? err.message : String(err) })
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; void save() }, 1_000)
  saveTimer.unref?.()
}

/**
 * Boot: load what was learned before the restart, and keep every new reading. When the file does
 * not exist yet, the session records seed it: each holds the window its CLI reported, the model it
 * is for, and where it came from. Idempotent.
 */
export async function startModelWindowStore(): Promise<number> {
  if (started) return 0
  started = true
  onModelWindowLearned(() => scheduleSave())
  let loaded = 0
  let found = false
  try {
    const raw = JSON.parse(await fs.readFile(await storePath(), 'utf8')) as { windows?: Record<string, LearnedModelWindow> }
    found = true
    loaded = seedModelWindows(raw.windows ?? {})
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.session.warn('model windows: file unreadable, starting empty', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!found) loaded = await seedFromSessionRecords()
  if (loaded) log.session.info('model windows: loaded', { windows: loaded, from: found ? 'file' : 'session records' })
  return loaded
}

/** Every session record whose window the CLI itself reported, newest first per host+model. */
async function seedFromSessionRecords(): Promise<number> {
  try {
    const { listSessions } = await import('../core/session-tracker.js')
    const { isExactWindowSource, shortModelId } = await import('./context-window.js')
    const entries: Record<string, LearnedModelWindow> = {}
    for (const r of await listSessions()) {
      if (!r.modelMaxWindow || !r.modelMaxWindowModel || !isExactWindowSource(r.modelMaxWindowSource)) continue
      if (r.modelMaxWindowSource !== 'cli-model-usage') continue
      const key = `${r.host || '__local__'}::${shortModelId(r.modelMaxWindowModel).toLowerCase()}`
      const at = Date.parse(r.lastActiveAt ?? '') || 0
      if (!entries[key] || entries[key].at < at) entries[key] = { window: r.modelMaxWindow, source: 'cli-model-usage', at }
    }
    const n = seedModelWindows(entries)
    if (n) scheduleSave()
    return n
  } catch (err) {
    log.session.warn('model windows: session records not read', { error: err instanceof Error ? err.message : String(err) })
    return 0
  }
}

/** Test seam only. */
export function resetModelWindowStore(file?: string): void {
  started = false
  filePath = file ?? null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  onModelWindowLearned(undefined)
}

/** Test seam: write now. */
export async function flushModelWindowStore(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  await save()
}
