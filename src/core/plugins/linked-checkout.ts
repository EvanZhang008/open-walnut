/**
 * Linked plugin checkouts: the plugin you are DEVELOPING, and how to pull the latest code.
 *
 * `walnut-plugin link` drops a symlink at `~/.open-walnut/plugins/<id>` pointing at a
 * working copy somewhere else on the machine, and the loader deliberately follows it
 * (`discoverPluginDirs`), canonicalizing to the realpath. So a linked plugin is
 * indistinguishable from an installed one in the lifecycle records: no source slug, no
 * URL, nothing the store can act on. This module gives that row its truth back (which
 * checkout it lives in, on what branch, at what commit, and whether the tree is clean),
 * plus the two things a person wants from it: "is there anything newer?" and "get it".
 *
 * Rules this file encodes:
 *
 *   - The LINK on disk is the truth, never a path recorded at boot. The dir may have been
 *     a real directory when Walnut started and a symlink since; the recorded path then
 *     points at something that no longer describes the plugin.
 *   - Nothing is cached across calls. These are a handful of cheap git calls and a wrong
 *     "up to date" is worse than a slow answer. What IS bounded is the clock: every git
 *     call has a timeout and the listing takes a total budget, so a store page degrades
 *     to "no linked info" instead of hanging (the deadline rule every route here follows).
 *   - Uncommitted work is never discarded. `updateLinkedCheckout` refuses a dirty tree and
 *     only ever fast-forwards; a diverged branch is reported, not merged or reset.
 *   - Credentials never reach a response or a log line, in a URL or in a git error.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { execGitArgsGroup } from '../../integrations/git-sync.js'

/** Cheap local plumbing (rev-parse, status). Bounded so a wedged git cannot pin a route. */
const GIT_TIMEOUT = 10_000
/** Talks to a remote, so it gets the network-shaped budget instead. */
const GIT_NETWORK_TIMEOUT = 60_000
/** Total spend for a whole-directory listing, after which remaining links are skipped. */
const LIST_BUDGET_MS = 5_000

export interface LinkedCheckoutInfo {
  /** The plugin directory the link points at (realpath). */
  path: string
  /** Root of the git work tree that holds it. Often the same as `path`. */
  checkout: string
  /** Branch name, or `HEAD` when the checkout is detached. */
  branch: string
  sha: string
  /** `origin`, with any embedded credentials masked. Absent when there is no remote. */
  remote?: string
  /** True when `git status --porcelain` reports anything at all. */
  dirty: boolean
}

export interface LinkedCheckoutStatus {
  /** Commits the checkout is behind its upstream. `null` when there is nothing to count. */
  behind: number | null
  ahead: number | null
  dirty: boolean
  sha: string
  branch: string
  /** False when the fetch itself failed (offline, no access). */
  fetched: boolean
  /** Why `behind` could not be counted, in plain words. */
  reason?: string
  /** The upstream commit the counts were taken against (what the update cache keeps as `remoteRef`). */
  upstreamSha?: string
}

export interface LinkedUpdateResult {
  sha: string
  fromSha: string
  /** False when the pull was already at the upstream commit. */
  updated: boolean
}

/** A refusal the caller has to render as a question, not as a crash. */
export class LinkedCheckoutError extends Error {
  constructor(message: string, readonly code: 'dirty' | 'diverged') {
    super(message)
    this.name = 'LinkedCheckoutError'
  }
}

export interface LinkedCheckoutOptions {
  /** Overridable so a test can point at a temp WALNUT_HOME. */
  externalDir?: string
}

/** Where `walnut-plugin link` puts its links. Mirrors EXTERNAL_DIR in the loader. */
export function externalPluginsDir(opts: LinkedCheckoutOptions = {}): string {
  return opts.externalDir ?? path.join(WALNUT_HOME, 'plugins')
}

/** https://user:token@host/… → https://***@host/… (the rule in plugin-sources maskSourceUrl,
 *  repeated here so this module stays off the config-reading import path). */
function maskUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/, '$1***@')
}

/** The same rule under the name the rest of the update-status code uses. */
export const maskRemote = maskUrl

/** Any credential that rode into a git message, in any position. */
export function maskMessage(message: string): string {
  return message.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@')
}

/** Knobs a caller may pass to any git-running function here. Omitted = today's behaviour. */
export interface LinkedGitOptions {
  /** Environment for the git child (an unattended fetch passes `fetchEnv()`). */
  env?: NodeJS.ProcessEnv
  /** Budget for the one call that talks to the remote. */
  fetchTimeoutMs?: number
}

async function git(args: string[], cwd: string, timeout = GIT_TIMEOUT, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await execGitArgsGroup(args, { cwd, timeout, ...(env ? { env } : {}) })
  } catch (error) {
    throw new Error(maskMessage(error instanceof Error ? error.message : String(error)))
  }
}

/** The git call that is ALLOWED to fail: absent upstream, no remote, not a repo. */
async function gitOrNull(
  args: string[],
  cwd: string,
  timeout = GIT_TIMEOUT,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    return await git(args, cwd, timeout, env)
  } catch {
    return null
  }
}

/** The link's target, or null when the entry is not a symlink or dangles. */
async function resolveLink(linkPath: string): Promise<string | null> {
  let stats: fs.Stats
  try {
    stats = await fsp.lstat(linkPath)
  } catch {
    return null
  }
  if (!stats.isSymbolicLink()) return null
  try {
    const real = await fsp.realpath(linkPath)
    return (await fsp.stat(real)).isDirectory() ? real : null
  } catch {
    return null // dangling link: the checkout was moved or deleted
  }
}

/** Everything git can say about the checkout that holds `realDir`, or null when there is none. */
async function describeCheckout(realDir: string, timeout = GIT_TIMEOUT): Promise<LinkedCheckoutInfo | null> {
  const top = await gitOrNull(['rev-parse', '--show-toplevel'], realDir, timeout)
  if (!top) return null
  let checkout: string
  try {
    checkout = await fsp.realpath(top)
  } catch {
    return null
  }
  const sha = await gitOrNull(['rev-parse', 'HEAD'], checkout, timeout)
  // No HEAD at all (a repo with no commits) is not something to offer an update for.
  if (!sha) return null
  const branch = await gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD'], checkout, timeout)
  const remote = await gitOrNull(['config', '--get', 'remote.origin.url'], checkout, timeout)
  const dirty = await isDirty(checkout, timeout)
  return {
    path: realDir,
    checkout,
    branch: branch || 'HEAD',
    sha,
    ...(remote ? { remote: maskUrl(remote) } : {}),
    dirty,
  }
}

async function isDirty(checkout: string, timeout = GIT_TIMEOUT): Promise<boolean> {
  // A failure here must not read as "clean": that is the one direction where a wrong
  // answer discards work, so an unanswerable status counts as dirty.
  const status = await gitOrNull(['status', '--porcelain'], checkout, timeout)
  return status === null ? true : status.length > 0
}

/**
 * Is this plugin a linked checkout?
 *
 * The id-named link is tried first (what the CLI creates), then the directory is scanned
 * for any link that lands on `pluginDir`. A link whose name does not match the manifest
 * id is unusual but perfectly legal, and a plugin that is really there should not be
 * reported as "not linked".
 */
export async function detectLinkedCheckout(
  pluginId: string,
  pluginDir?: string,
  opts: LinkedCheckoutOptions = {},
): Promise<LinkedCheckoutInfo | null> {
  const dir = externalPluginsDir(opts)
  const byId = await resolveLink(path.join(dir, pluginId))
  if (byId) return describeCheckout(byId)
  if (!pluginDir) return null

  let target: string
  try {
    target = await fsp.realpath(pluginDir)
  } catch {
    return null
  }
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null // no external plugins dir on this machine
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || entry.name === pluginId) continue
    const real = await resolveLink(path.join(dir, entry.name))
    if (real === target) return describeCheckout(real)
  }
  return null
}

/** The manifest id a plugin directory claims, or null when it cannot be read. */
async function manifestId(pluginDir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(pluginDir, 'manifest.json'), 'utf-8')) as { id?: unknown }
    return typeof raw.id === 'string' && raw.id.trim() ? raw.id : null
  } catch {
    return null
  }
}

/**
 * Every linked checkout under the external plugins dir, keyed by plugin id.
 *
 * Used by the store list, so it is bounded by a total budget: past the deadline the
 * remaining links are simply left out and their rows read exactly as they do today. A
 * page that renders without the extra line beats a page that waits on git.
 */
export async function listLinkedCheckouts(
  opts: LinkedCheckoutOptions & { budgetMs?: number } = {},
): Promise<Map<string, LinkedCheckoutInfo>> {
  return (await listLinkedCheckoutsDetailed(opts)).found
}

export interface LinkedCheckoutListing {
  found: Map<string, LinkedCheckoutInfo>
  /** Link names the budget ran out before, so a caller can say "not scanned" instead of nothing. */
  skipped: string[]
}

/**
 * `listLinkedCheckouts` plus the names it had to leave out. A row whose link was never
 * looked at must not read as "not linked": the store marks it `linkedScanSkipped`.
 */
export async function listLinkedCheckoutsDetailed(
  opts: LinkedCheckoutOptions & { budgetMs?: number } = {},
): Promise<LinkedCheckoutListing> {
  const dir = externalPluginsDir(opts)
  const found = new Map<string, LinkedCheckoutInfo>()
  const skipped: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return { found, skipped }
  }
  const links = entries.filter((entry) => entry.isSymbolicLink())
  const deadline = Date.now() + (opts.budgetMs ?? LIST_BUDGET_MS)
  for (let i = 0; i < links.length; i++) {
    const entry = links[i]
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      for (const rest of links.slice(i)) skipped.push(rest.name)
      break
    }
    const real = await resolveLink(path.join(dir, entry.name))
    if (!real) continue
    const info = await describeCheckout(real, Math.min(remaining, GIT_TIMEOUT))
    if (!info) {
      // Ran out of clock mid-describe: that is a skip, not "no checkout".
      if (deadline - Date.now() <= 0) skipped.push(entry.name)
      continue
    }
    found.set(await manifestId(real) ?? entry.name, info)
  }
  return { found, skipped }
}

/** The branch this checkout tracks (`origin/main`), or null when nothing is set. */
async function upstreamOf(checkout: string): Promise<string | null> {
  return gitOrNull(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], checkout)
}

/**
 * Fetch, then say how far the checkout is from its upstream. Never touches the work tree.
 *
 * `behind: null` is the honest answer whenever there is nothing to count against: a
 * detached HEAD or a branch with no upstream. A fetch that could not run still counts
 * against the LAST fetch, flagged `fetched: false` with the reason, so the caller must
 * never present that count as "up to date".
 */
export async function checkLinkedCheckout(
  info: LinkedCheckoutInfo,
  opts: LinkedGitOptions = {},
): Promise<LinkedCheckoutStatus> {
  const { checkout } = info
  let fetched = true
  let fetchError: string | undefined
  try {
    await git(['fetch'], checkout, opts.fetchTimeoutMs ?? GIT_NETWORK_TIMEOUT, opts.env)
  } catch (error) {
    fetched = false
    fetchError = error instanceof Error ? error.message : String(error)
  }
  const sha = await gitOrNull(['rev-parse', 'HEAD'], checkout) ?? info.sha
  const branch = await gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD'], checkout) ?? info.branch
  const dirty = await isDirty(checkout)
  const base = { dirty, sha, branch, fetched }

  const upstream = await upstreamOf(checkout)
  if (!upstream) {
    return {
      ...base,
      behind: null,
      ahead: null,
      reason: branch === 'HEAD'
        ? 'This checkout is on a detached HEAD, so there is no branch to compare.'
        : `No upstream branch is set for ${branch}, so there is nothing to compare against.`,
    }
  }
  const behindRaw = await gitOrNull(['rev-list', '--count', 'HEAD..@{upstream}'], checkout)
  const aheadRaw = await gitOrNull(['rev-list', '--count', '@{upstream}..HEAD'], checkout)
  const upstreamSha = await gitOrNull(['rev-parse', '@{upstream}'], checkout)
  if (behindRaw === null) {
    return { ...base, behind: null, ahead: null, reason: `Could not compare with ${upstream}.` }
  }
  return {
    ...base,
    behind: Number.parseInt(behindRaw, 10) || 0,
    ahead: aheadRaw === null ? null : Number.parseInt(aheadRaw, 10) || 0,
    ...(upstreamSha ? { upstreamSha } : {}),
    ...(fetched ? {} : { reason: `Could not fetch: ${gitErrorGist(fetchError ?? 'unknown error')}` }),
  }
}

/** The one line of a git failure worth showing a person: no exit code, no "Please make sure" advice. */
export function gitErrorGist(message: string): string {
  const lines = message
    .replace(/^git exited \d+:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^please make sure|^and the repository exists/i.test(line))
  return (lines[0] ?? message).replace(/\.$/, '').slice(0, 200)
}

/** git's own words when a fast-forward is not possible. */
function isDivergedMessage(message: string): boolean {
  const text = message.toLowerCase()
  return text.includes('not possible to fast-forward')
    || text.includes('cannot fast-forward')
    || text.includes('diverging')
    || text.includes('diverged')
    || text.includes('refusing to merge unrelated histories')
}

/**
 * Fast-forward the checkout to its upstream.
 *
 * Refuses a dirty tree (checked FRESH, never from a flag someone passed in) and never
 * does anything but a fast-forward, so no local commit or edit can be lost here.
 */
export async function updateLinkedCheckout(
  info: LinkedCheckoutInfo,
  opts: LinkedGitOptions = {},
): Promise<LinkedUpdateResult> {
  const { checkout } = info
  if (await isDirty(checkout)) {
    throw new LinkedCheckoutError(
      'This checkout has uncommitted changes. Commit or stash them, then update.',
      'dirty',
    )
  }
  const fromSha = await gitOrNull(['rev-parse', 'HEAD'], checkout) ?? info.sha
  try {
    await git(['pull', '--ff-only'], checkout, opts.fetchTimeoutMs ?? GIT_NETWORK_TIMEOUT, opts.env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isDivergedMessage(message)) {
      throw new LinkedCheckoutError(
        `This checkout has commits the remote does not, so it cannot be fast-forwarded: ${message}`,
        'diverged',
      )
    }
    throw new Error(message)
  }
  const sha = await gitOrNull(['rev-parse', 'HEAD'], checkout) ?? fromSha
  return { sha, fromSha, updated: sha !== fromSha }
}
