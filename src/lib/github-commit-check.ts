/**
 * A GitHub commit link in words for the user that opens nothing: the commit is not in that
 * repository on GitHub. The note that tells the writer, beside missing-links.ts's.
 *
 * Why (2026-11-20, the Walnut VP): a task gave it https://github.com/<owner>/<repo>/commit/<hash>
 * where <hash> was the commit on the maintainer's own main, which reaches GitHub as a copy under
 * another hash; the VP wrote the dead link into the user's thread. The link check only asked
 * whether a link was there, not whether it opened.
 *
 * How it asks: the way the user's click would, one HEAD request for the commit's page on github.com
 * (GitHub's REST API refuses unauthenticated calls from a busy shared address: 2026-11-20, clouddev
 * got 403 "rate limit exceeded" on its first call). 200 is there; 404 is missing only when the
 * repository's own page opens, since a private repository answers 404 too. Answers are kept in a
 * small file in the temp dir: a commit GitHub has stays known for good (a pushed commit does not
 * leave), one it lacks for 10 minutes (it may be pushed any minute). At most 5 commits a text,
 * 3 s in all; a network error, a rate limit or any other answer says nothing.
 * WALNUT_GITHUB_COMMIT_CHECK=0 turns it off.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const COMMIT_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/commit\/([0-9a-f]{7,40})\b/gi
const MAX_CHECKS = 5
const TIMEOUT_MS = 3_000
const MISSING_TTL_MS = 10 * 60_000
const CACHE_MAX = 2_000

export interface DeadCommitLink { url: string; repo: string; hash: string }

type Verdict = 'exists' | 'missing' | 'unknown'
type Fetcher = (url: string, init: { method: 'HEAD'; redirect: 'follow'; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }>

let fetcher: Fetcher = (url, init) => fetch(url, init)
let cacheFile = path.join(os.tmpdir(), `walnut-github-commits-${typeof process.getuid === 'function' ? process.getuid() : 'u'}.json`)

/** Test seam: the HTTP call and the cache file. */
export function _setGithubCommitCheck(o: { fetch?: Fetcher; cacheFile?: string }): void {
  if (o.fetch) fetcher = o.fetch
  if (o.cacheFile) cacheFile = o.cacheFile
}

/** key "owner/repo@hash" -> exists, or the time GitHub said it was missing. */
type Cache = Record<string, true | number>

function readCache(): Cache {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Cache } catch { return {} }
}

function writeCache(c: Cache): void {
  try {
    const keys = Object.keys(c)
    const kept = keys.length > CACHE_MAX ? Object.fromEntries(keys.slice(-CACHE_MAX).map((k) => [k, c[k]])) : c
    const tmp = `${cacheFile}.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 })
    fs.renameSync(tmp, cacheFile)
  } catch { /* a cache that cannot be written only costs a call next time */ }
}

async function ask(repo: string, hash: string): Promise<Verdict> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  const head = (url: string) => fetcher(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'walnut-link-check' }, signal: ctl.signal })
  try {
    const r = await head(`https://github.com/${repo}/commit/${hash}`)
    if (r.status === 200) return 'exists'
    if (r.status !== 404) return 'unknown'
    // A private repository answers 404 too: missing only when the repository's own page opens.
    return (await head(`https://github.com/${repo}`)).status === 200 ? 'missing' : 'unknown'
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

/** The GitHub commit links in the text whose commit GitHub does not have, each once. */
export async function findDeadCommitLinks(text: string): Promise<DeadCommitLink[]> {
  if (process.env.WALNUT_GITHUB_COMMIT_CHECK === '0' || !text || !text.includes('github.com/')) return []
  const links = new Map<string, DeadCommitLink>()
  for (const m of text.matchAll(COMMIT_URL_RE)) {
    const repo = `${m[1]}/${m[2]}`
    const hash = m[3].toLowerCase()
    const key = `${repo.toLowerCase()}@${hash}`
    if (!links.has(key)) links.set(key, { url: m[0], repo, hash })
    if (links.size >= MAX_CHECKS) break
  }
  if (!links.size) return []
  const cache = readCache()
  const now = Date.now()
  let changed = false
  const dead: DeadCommitLink[] = []
  await Promise.all([...links].map(async ([key, link]) => {
    const known = cache[key]
    if (known === true) return
    if (typeof known === 'number' && now - known < MISSING_TTL_MS) { dead.push(link); return }
    const v = await ask(link.repo, link.hash)
    if (v === 'exists') { cache[key] = true; changed = true }
    else if (v === 'missing') { cache[key] = now; changed = true; dead.push(link) }
  }))
  if (changed) writeCache(cache)
  return [...links.values()].filter((l) => dead.includes(l))
}

/** The note for dead commit links, or null. `what` and `fix` as in missing-links.ts. */
export function deadCommitLinksNote(dead: readonly DeadCommitLink[], what: string, fix: string): string | null {
  if (!dead.length) return null
  const list = dead.map((d) => d.url).join(', ')
  return `Walnut note: ${what} links ${list}, a commit GitHub does not have in that repository, so the link opens nothing. `
    + 'A commit that reached GitHub as a copy (a rebase, a cherry-pick, a replayed push) has another hash there: link that one. '
    + `One not on GitHub yet: say it is on main and not yet on GitHub, with no link. ${fix}`
}
