/**
 * The text of a web page a person asks about from the Walnut extension's side panel. It goes into
 * a file in this machine's cache (never synced, kept 7 days, the newest 200), and the ask's first message names
 * that file, so the chat shows the person's question rather than a page of text, and the agent
 * reads the page only when the question needs it.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export interface BrowserPageText {
  url: string
  title?: string
  text: string
}

export const MAX_PAGE_TEXT = 200_000
const KEEP_MS = 7 * 24 * 3600_000

/** The page from a request body, or null when it is not one (a web page's address and some text). */
export function cleanPageText(raw: unknown): BrowserPageText | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const url = typeof r.url === 'string' ? r.url.slice(0, 4000) : ''
  if (!/^https?:\/\//i.test(url)) return null
  const text = typeof r.text === 'string' ? r.text.slice(0, MAX_PAGE_TEXT) : ''
  if (!text.trim()) return null
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined
  return { url, ...(title ? { title } : {}), text }
}

export function pageTextDir(home: string): string {
  return path.join(home, 'cache', 'browser-pages')
}

/** At most this many pages are kept, the newest. */
const KEEP_FILES = 200

async function prune(dir: string, now: number): Promise<void> {
  try {
    const files: Array<{ p: string; at: number }> = []
    for (const name of await fsp.readdir(dir)) {
      const p = path.join(dir, name)
      const st = await fsp.stat(p).catch(() => null)
      if (!st) continue
      if (now - st.mtimeMs > KEEP_MS) await fsp.rm(p, { force: true })
      else files.push({ p, at: st.mtimeMs })
    }
    files.sort((a, b) => b.at - a.at)
    for (const f of files.slice(KEEP_FILES - 1)) await fsp.rm(f.p, { force: true })
  } catch { /* nothing to prune */ }
}

/** Writes the page's text (owner-only) and returns the file's path. */
export async function savePageText(page: BrowserPageText, home: string, now = Date.now()): Promise<string> {
  const dir = pageTextDir(home)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  await prune(dir, now)
  const file = path.join(dir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.md`)
  await fsp.writeFile(file, `# ${page.title ?? page.url}\n\n${page.url}\n\n${page.text}\n`, { mode: 0o600 })
  return file
}
