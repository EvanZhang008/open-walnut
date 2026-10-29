/**
 * Pure model of the Apps page's plugins: the registry row shape, which plugin is a part
 * of another, what a card says, and the plain-word answers the detail page gives to
 * "where does this come from?" and "is it current?". No React: unit tested in
 * tests/web/plugin-store-model.test.ts.
 */
import type { PluginCategory } from '../../../../src/core/plugins/plugin-category'
import type { DependencyPlanItem, MissingDependencyView } from '@/components/settings/sections/PluginDependencyRows'
import type { PluginSource } from '@/components/settings/sections/PluginSourcesGroup'
import { RESTART_PENDING_STATE, type UpdateState } from '@/components/settings/plugin-update-types'
import { npmToVersion, shortenHome } from '@/components/settings/plugin-update-view'

/** Mirrors PluginRegistryRow in src/core/plugins/plugin-catalog.ts. */
export interface RegistryRow {
  id: string
  name: string
  description?: string
  adds?: string[]
  /** The Apps page group. Optional here: an older server sends none, which reads as 'other'. */
  category?: PluginCategory
  homepage?: string
  docs?: string
  source: {
    /** `local`: a plain folder under the plugins dir that no source owns; nothing can update it. */
    /** `bundled`: ships in this build's plugin-store folder; installed only on request. */
    kind: 'builtin' | 'git' | 'npm' | 'example' | 'bundled' | 'linked' | 'local'
    url?: string
    ref?: string
    spec?: string
    /** example: repo-relative dir. linked: the absolute plugin dir the link points at. */
    path?: string
    /** linked only. */
    checkout?: string
    branch?: string
    sha?: string
    remote?: string
    dirty?: boolean
    /** linked only: `checkout` with the home directory folded to `~` by the server. */
    checkoutDisplay?: string
  }
  /** linked only: the registry's checkout scan ran out of budget before this row. */
  linkedScanSkipped?: boolean
  installed: boolean
  status: 'active' | 'disabled' | 'needs-config' | 'needs-dependency' | 'unsupported' | 'failed' | 'quarantined' | 'pending-restart' | 'available'
  state?: string
  version?: string
  builtin: boolean
  capabilities?: string[]
  missingConfig?: string[]
  /** Which other plugins hold this row back, and what could be done about each. */
  missingDependencies?: MissingDependencyView[]
  dependencyPlan?: DependencyPlanItem[]
  blockedBy?: string[]
  reason?: string
  error?: string
  configurable: boolean
  /** `'app'`: the plugin's own App draws its settings, so Settings goes to the App. */
  settingsIn?: 'plugins' | 'app'
  catalog: boolean
  sourceSlug?: string
  toggleable: boolean
  /** Present only when the manifest's icon exists on the server; otherwise the tile is a monogram. */
  iconUrl?: string
  /** Installed only: the folder its code loads from on the server's host. An older server sends none. */
  dir?: string
  /** Installed only: it ships a web entry (an App, a page, a panel), on or off. */
  hasUi?: boolean
}

export interface RegistryResponse {
  rows: RegistryRow[]
  installedCount: number
  availableCount: number
  sourcesUnavailable?: boolean
  cloud?: boolean
  /** The server's home directory, for folding paths to `~` on the client. */
  homeDir?: string
}

/** Only rows from one of these origins have an update state; built-in rows never do. */
const UPDATABLE_KINDS = new Set<RegistryRow['source']['kind']>(['linked', 'git', 'npm'])

/**
 * Rows that get an update state: a linked checkout, a store source, or a plain folder the
 * registry's linked scan never reached (it may be a link; only a check can tell, C30).
 */
export const isUpdatableRow = (row: RegistryRow): boolean =>
  UPDATABLE_KINDS.has(row.source.kind) || row.linkedScanSkipped === true

/** A row that IS (or may be) a linked checkout. */
export const isLinkedRow = (row: RegistryRow): boolean => row.source.kind === 'linked' || row.linkedScanSkipped === true

/** A plugin whose files an update replaced runs its old code until a restart, so it reads on. */
export const isRunning = (row: RegistryRow): boolean => row.status === 'active' || row.state === RESTART_PENDING_STATE

/**
 * Which installed plugin each installed plugin is a part of. A plugin is a part of another
 * when its id extends that one's (`slack-mcp` of `slack`, `mail-imap` of `mail`): the
 * naming every provider and helper plugin already follows. The longest such id wins, and
 * a part is never itself a parent, so the page shows one level. A part whose parent is not
 * installed stands on its own.
 */
export function partParents(installed: readonly Pick<RegistryRow, 'id'>[]): Map<string, string> {
  const ids = installed.map((row) => row.id)
  const parentOf = new Map<string, string>()
  for (const id of ids) {
    let best: string | undefined
    for (const other of ids) {
      if (other !== id && id.startsWith(`${other}-`) && (!best || other.length > best.length)) best = other
    }
    if (best) parentOf.set(id, best)
  }
  // One level: a parent that is itself a part hands its parts to its own parent.
  for (const [id, parent] of parentOf) {
    const top = parentOf.get(parent)
    if (top) parentOf.set(id, top)
  }
  return parentOf
}

export type CardTone = 'on' | 'off' | 'warn' | 'bad' | 'update' | 'get' | 'fixed'

/** The one status a card shows: what most needs the user first, then on or off. */
export function cardStatus(
  row: Pick<RegistryRow, 'status' | 'state' | 'installed'>,
  opts: { update?: UpdateState; connectionAlert?: string } = {},
): { text: string; tone: CardTone } {
  if (!row.installed) return { text: 'Get', tone: 'get' }
  switch (row.status) {
    case 'failed':
    case 'quarantined': return { text: 'Failed', tone: 'bad' }
    case 'needs-config': return { text: 'Needs setup', tone: 'warn' }
    case 'needs-dependency': return { text: 'Needs another plugin', tone: 'warn' }
    case 'unsupported': return { text: 'Needs newer Walnut', tone: 'off' }
    case 'disabled': return { text: 'Off', tone: 'off' }
    default: break
  }
  if (row.state === RESTART_PENDING_STATE || row.status === 'pending-restart') return { text: 'Restart to finish', tone: 'warn' }
  if (opts.connectionAlert) return { text: opts.connectionAlert, tone: 'warn' }
  if (opts.update?.kind === 'available') return { text: 'Update available', tone: 'update' }
  return { text: 'On', tone: 'on' }
}

/** Where the code comes from, in two or three words, for the card's corner and the header. */
export function originKind(row: Pick<RegistryRow, 'builtin' | 'source'>): string {
  if (row.builtin || row.source.kind === 'builtin') return 'Built in'
  switch (row.source.kind) {
    case 'bundled': return 'Comes with Walnut'
    case 'linked': return 'Git checkout'
    case 'local': return 'Local folder'
    case 'git': return 'Git'
    case 'npm': return 'npm'
    case 'example': return 'Example'
  }
}

export interface SourceFact {
  label: string
  /** What the row shows; a path is already folded to `~`. */
  value: string
  /** Shown in monospace (a path, a URL, a branch). */
  mono?: boolean
  /** The full value a Copy button copies, when there is one. */
  copy?: string
}

export interface PlainNote {
  title: string
  text: string
  tone: 'neutral' | 'warn' | 'info'
}

/**
 * "Where it comes from": what kind of source, the folder it runs from, the remote, the
 * branch or version, each a row; and one plain note when the kind needs explaining (a
 * local folder nothing can update).
 */
export function sourceFacts(
  row: RegistryRow,
  source: PluginSource | undefined,
  homeDir: string | undefined,
  /** `cloud`: a replica, which reads the Mac's plugins but not its sources or checkouts.
   *  `sourcesUnavailable`: the Mac could not read its installed-source list. In both, a
   *  plugin the server calls `local` may really be a git, npm or linked install. */
  where: { cloud?: boolean; sourcesUnavailable?: boolean } = {},
): { facts: SourceFact[]; note?: PlainNote } {
  const path = (value: string): SourceFact['value'] => shortenHome(value, homeDir)
  const runsFrom = (dir: string | undefined): SourceFact[] =>
    dir ? [{ label: 'Runs from', value: path(dir), mono: true, copy: dir }] : []
  const facts: SourceFact[] = []
  const kind = row.builtin ? 'builtin' : row.source.kind
  if (!row.installed) {
    if (kind === 'example') {
      facts.push({ label: 'Comes from', value: 'An example in the Walnut source' })
      if (row.source.path) facts.push({ label: 'Folder', value: row.source.path, mono: true, copy: row.source.path })
    } else if (kind === 'bundled') {
      facts.push({ label: 'Comes from', value: 'Comes with Walnut. Install turns it on.' })
    } else if (kind === 'npm') {
      facts.push({ label: 'Comes from', value: 'An npm package' }, { label: 'Package', value: row.source.spec ?? row.id, mono: true, copy: row.source.spec ?? row.id })
    } else if (kind === 'git') {
      facts.push({ label: 'Comes from', value: 'A git repository' })
      if (row.source.url) facts.push({ label: 'Remote', value: row.source.url, mono: true, copy: row.source.url })
      if (row.source.ref) facts.push({ label: 'Branch or tag', value: row.source.ref, mono: true })
    } else {
      facts.push({ label: 'Comes from', value: 'Ships with Walnut, but not in this build' })
    }
    return { facts }
  }
  switch (kind) {
    case 'builtin':
      // How it updates is the Version section's line ("Comes with each new Walnut version").
      facts.push({ label: 'Comes from', value: 'Built into Walnut' }, { label: 'Runs from', value: 'Inside the Walnut app' })
      return { facts }
    case 'bundled':
      facts.push({ label: 'Comes from', value: 'Comes with Walnut, installed when you turned it on' }, { label: 'Runs from', value: 'Inside the Walnut app' })
      return { facts }
    case 'linked': {
      facts.push({ label: 'Comes from', value: 'A git checkout on this computer, linked into Walnut' }, ...runsFrom(row.source.path ?? row.dir))
      const checkout = row.source.checkout
      if (checkout && checkout !== (row.source.path ?? row.dir)) facts.push({ label: 'Repository', value: path(checkout), mono: true, copy: checkout })
      facts.push(row.source.remote
        ? { label: 'Remote', value: row.source.remote, mono: true, copy: row.source.remote }
        : { label: 'Remote', value: 'None: this checkout has no remote' })
      if (row.source.branch) facts.push({ label: 'Branch', value: `${row.source.branch}${row.source.sha ? ` at ${row.source.sha.slice(0, 7)}` : ''}`, mono: true })
      return { facts }
    }
    case 'git': {
      facts.push({ label: 'Comes from', value: 'A git repository Walnut installed' })
      const url = source?.url ?? row.source.url
      if (url) facts.push({ label: 'Remote', value: url, mono: true, copy: url })
      facts.push({ label: 'Branch or tag', value: source?.ref ?? row.source.ref ?? 'The default branch', mono: Boolean(source?.ref ?? row.source.ref) })
      if (source?.lastSha) facts.push({ label: 'Installed commit', value: source.lastSha.slice(0, 7), mono: true })
      facts.push(...runsFrom(row.dir))
      return { facts }
    }
    case 'npm': {
      facts.push({ label: 'Comes from', value: 'An npm package Walnut installed' })
      const spec = source?.packageName ?? source?.spec ?? row.source.spec
      if (spec) facts.push({ label: 'Package', value: spec, mono: true, copy: spec })
      const version = source?.version ?? (source?.resolved ? npmToVersion(source.resolved) : undefined)
      if (version) facts.push({ label: 'Installed version', value: `v${version}`, mono: true })
      facts.push(...runsFrom(row.dir))
      return { facts }
    }
    case 'local':
    default:
      if (where.cloud) {
        facts.push({ label: 'Comes from', value: 'Installed on your Mac' })
        return { facts, note: { title: 'Read from your Mac', text: 'This copy of Walnut reads your plugins from the Mac but not where each one came from. Open Walnut on the Mac to see its folder, remote and updates.', tone: 'neutral' } }
      }
      if (where.sourcesUnavailable) {
        facts.push({ label: 'Comes from', value: 'Not known right now' }, ...runsFrom(row.dir))
        return { facts, note: { title: 'Could not read the installed sources', text: 'Walnut could not read its list of installed git and npm sources, so it cannot tell whether this plugin came from one. Reload the page to try again.', tone: 'warn' } }
      }
      facts.push({ label: 'Comes from', value: 'A folder on this computer' }, ...runsFrom(row.dir), { label: 'Remote', value: 'None' })
      if (row.linkedScanSkipped) {
        return { facts, note: { title: 'Not checked yet', text: 'Walnut ran out of time before it looked at this folder, so it may still be a git checkout. Press Check again to find out.', tone: 'neutral' } }
      }
      return {
        facts,
        note: {
          title: 'Local folder',
          text: 'This folder was put into the plugins folder by hand, so Walnut has no record of where it came from and cannot check for or install updates. To update it, replace the folder, or install it again from its git or npm link.',
          tone: 'neutral',
        },
      }
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What the update state means and what to do about it, in plain words. `null` for a state
 * the version row's own words already say in full (current, checking, not yet loaded).
 */
export function updateNote(
  state: UpdateState | undefined,
  ctx: { checkout?: string; branch?: string; homeDir?: string } = {},
): PlainNote | null {
  if (!state) return null
  const where = ctx.checkout ? ` at ${shortenHome(ctx.checkout, ctx.homeDir)}` : ''
  switch (state.kind) {
    case 'dirty': {
      const waiting = typeof state.behind === 'number' && state.behind > 0
        ? ` The remote has ${plural(state.behind, 'new commit')} waiting.`
        : ''
      return {
        title: 'Local changes: Walnut will not update this',
        text: `The checkout${where} has edits that are not committed. Updating would pull new code over them, so Walnut leaves it alone and never overwrites your work.${waiting} Commit or discard the edits in that folder, then press Check again.`,
        tone: 'warn',
      }
    }
    case 'unsupported':
      return {
        title: 'Cannot compare: Walnut cannot tell whether there is a newer version',
        text: `Walnut checks for updates by comparing this copy with where it came from, and here there is nothing to compare it with. ${state.reason.trim()}${/[.!?]$/.test(state.reason.trim()) ? '' : '.'} ${state.hint}`.trim(),
        tone: 'neutral',
      }
    case 'diverged':
      return {
        title: 'Both sides changed',
        text: `This checkout has ${plural(state.ahead, 'commit')} the remote does not, and the remote has ${plural(state.behind, 'commit')} it does not. Walnut will not pick one for you: rebase or merge in the checkout, then press Check again.`,
        tone: 'warn',
      }
    case 'available': {
      const to = state.toVersion ? `v${npmToVersion(state.toVersion)}` : typeof state.behind === 'number' && state.behind > 0 ? `the newest of ${plural(state.behind, 'new commit')}` : 'the newest version'
      return { title: 'An update is ready', text: `Update moves this plugin to ${to}.`, tone: 'info' }
    }
    case 'unreachable':
      return state.cause === 'auth'
        ? { title: 'Sign-in needed', text: 'The remote refused your credentials. Renew them, then press Check again.', tone: 'warn' }
        : { title: 'Could not reach the remote', text: `The last check could not reach where this plugin comes from, so what you see may be old. ${state.reason}`.trim(), tone: 'neutral' }
    case 'missing':
      return { title: 'Its files are gone', text: 'The files for this plugin are not on this computer. Restore clones them again.', tone: 'warn' }
    case 'unchecked':
      return { title: 'Not checked yet', text: state.reason ?? 'Walnut has not checked this plugin yet. Press Check again.', tone: 'neutral' }
    default:
      return null
  }
}

