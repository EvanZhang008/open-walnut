/**
 * Pure view logic for the plugin update chip, the Update button and the feedback line.
 *
 * Framework-free on purpose: the root vitest tier has no jsdom, so every sentence and
 * every state-to-look decision lives here and the React pieces only render the result.
 * The rendering table is spec 4.1; the button matrix is spec 6.3; the copy is spec 7.
 */
import type { UpdateState } from './plugin-update-types'
import { timeAgo } from '@/utils/time'

export type IconName =
  | 'check'
  | 'arrow-up'
  | 'pencil'
  | 'arrows-up-down'
  | 'cloud-off'
  | 'key'
  | 'slash-circle'
  | 'circle-dashed'
  | 'info'
  | 'spinner'

export type BusyKind = 'checking' | 'updating'

/** Mirror of the server sentence returned by the 501 in replica mode. Keep identical. */
export const CLOUD_LINKED_NOTE =
  'Linked plugin checkouts live on your Mac. Open Settings → Plugins there to check or update one.'

/** Tooltip when /registry ran out of linked-scan budget for a row (spec C30). */
export const LINKED_SCAN_SKIPPED_NOTE = 'The checkout scan ran out of time. Click to check.'

export const CLICK_TO_CHECK_SUFFIX = ' Click to check again.'
export const LOCK_TRANSIENT_NOTE = 'Another git command was running; retry in 30 s.'

const REASON_CAP = 120

/** `@acme/plugin@1.3.0` -> `1.3.0`; a bare version passes through unchanged. */
export function npmToVersion(resolved: string): string {
  const version = resolved.slice(resolved.lastIndexOf('@') + 1)
  return version.startsWith('v') ? version.slice(1) : version
}

/** A bare `host.tld[:port]` token; dotted file names (`index.lock`, `plugins.git`) are not hosts. */
const HOSTNAME_TOKEN = /(?<![\w/.'@-])(?:[a-z0-9-]+\.)+([a-z]{2,})(?::\d+)?(?![\w/.-])/gi
const FILE_SUFFIXES = new Set(['git', 'lock', 'json', 'md', 'txt', 'js', 'mjs', 'cjs', 'ts', 'yaml', 'yml', 'pack', 'idx'])

/** Cut at a word boundary under the cap and end with an ellipsis, so a suffix never glues onto a half word. */
export function capReason(text: string, cap = REASON_CAP): string {
  if (text.length <= cap) return text
  const head = text.slice(0, cap - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > cap / 2 ? head.slice(0, space) : head).replace(/[\s,;:]+$/, '')}…`
}

/**
 * Client twin of the server scrub (spec 5.4, C18): drop the `git exited N:` and `fatal:`
 * framing and git's "Please make sure" advice, a `user@host:` prefix, a parenthesised auth
 * method list, every URL and bare hostname (they name a private remote), and every
 * absolute path down to its last segment; cap at 120 characters with an ellipsis. The
 * server already scrubs what it sends; this keeps a stale or third-party reason honest too.
 */
export function scrubReason(text: string): string {
  const lines = (text ?? '')
    .replace(/^git exited \d+:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^please make sure|^and the repository exists|^fatal: could not read from remote/i.test(line))
  const gist = (lines[0] ?? text ?? '').replace(/\.$/, '')
  const out = gist
    .replace(/^\S+@\S+:\s*/, '')
    .replace(/\s*\([a-z-]+(,[a-z-]+)*\)/g, '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]*[^\s'":.,;)]/gi, 'the remote')
    .replace(/(^|[\s'"(])(?:\.\/|~\/|\/)(?:[^\s'"/]+\/)*([^\s'"/]+)\/?/g, '$1$2')
    .replace(/\b[\w.-]+@[\w-]+(?:\.[\w-]+)+(?::[^\s'"]*[^\s'":])?/g, 'the remote')
    .replace(HOSTNAME_TOKEN, (token: string, tld: string) => (FILE_SUFFIXES.has(tld.toLowerCase()) ? token : 'the remote'))
    .replace(/(^|\s)(?:fatal|error|warning):\s*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return capReason(out)
}

/** `/home/me/code/x` -> `~/code/x` when `home` is a prefix; otherwise unchanged. */
export function shortenHome(path: string, home?: string | null): string {
  if (!home) return path
  const base = home.replace(/\/+$/, '')
  if (!base) return path
  if (path === base) return '~'
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}

/**
 * `https://user:tok@github.com/acme/plugins.git` -> `github.com/acme/plugins`;
 * `git@github.com:acme/plugins.git` -> `github.com/acme/plugins`.
 */
export function shortRemote(url: string): string {
  let out = url.trim()
  // A local remote (`file:///home/me/repos/x.git`, or a bare absolute path) would shorten to
  // an absolute path, which a row never shows: only the repository folder's name survives.
  const local = /^(?:file:\/\/)?(\/.*)$/i.exec(out)
  if (local) {
    const folder = local[1].split('/').filter(Boolean).pop() ?? ''
    return (folder || 'local repository').replace(/\.git$/i, '')
  }
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(out)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(out)) {
    out = `${scp[1]}/${scp[2].replace(/^\/+/, '')}`
  } else {
    out = out.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    out = out.replace(/^[^/@\s]+@/, '')
  }
  out = out.replace(/\/+$/, '').replace(/\.git$/i, '')
  return out
}

export interface SourceShortInput {
  kind?: 'git' | 'npm'
  type?: 'npm'
  url?: string
  spec?: string
  packageName?: string
  resolved?: string
}

/** `git · host/owner/repo` or `npm · @acme/plugin` for the source line under a row. */
export function sourceShortLabel(source: SourceShortInput): string {
  const isNpm = source.kind === 'npm' || source.type === 'npm'
  if (isNpm) {
    const name = source.packageName
      ?? (source.resolved ? source.resolved.slice(0, Math.max(0, source.resolved.lastIndexOf('@'))) : undefined)
      ?? (source.spec ? source.spec.replace(/(?!^)@.*$/, '') : undefined)
      ?? 'package'
    return `npm · ${name}`
  }
  return `git · ${source.url ? shortRemote(source.url) : 'remote'}`
}

// ---------------------------------------------------------------------------------
// Chip (spec 4.1)
// ---------------------------------------------------------------------------------

export interface ChipView {
  /** Value of data-update-kind: a state kind, or `pending` before the first GET. */
  kind: string
  label: string
  /** Native title; empty for pending and checking. */
  title: string
  /** BEM-ish modifiers without the block prefix, e.g. `--available`, `--stale`. */
  modifiers: string[]
  icon: IconName | null
  stale: boolean
  busy: boolean
  clickable: boolean
}

export interface ChipViewOptions {
  checkedAt: string | null
  now?: number
  /** Replica mode: the chip is a static span carrying this sentence as its title. */
  staticNote?: string
  busy?: BusyKind | null
  /** Server kept the previous entry after a lock collision (UpdateStatusRow.transient). */
  transient?: boolean
  /** Sha the Update would move to (UpdateStatusRow.target.toRef); shown as sha7. */
  toRef?: string
  /**
   * The browser is offline (C49, N3-13): every known state keeps its words and takes the
   * stale marking, since none of them can be confirmed until the network is back.
   */
  offline?: boolean
  /** This chip sits on a Sources card whose Update verb lives on the Installed row (N3-11). */
  updateElsewhere?: boolean
}

export interface ResolveRowStateInput {
  /** The server's row for this key, if any. */
  known: UpdateState | undefined
  /** The first GET has answered. */
  loaded: boolean
  /** The server is running a batch right now (`refreshing: true` or a poll in flight). */
  refreshing: boolean
  /** The registry admits its checkout scan skipped this row (C30). */
  scanSkipped?: boolean
}

/**
 * What a row shows when the server has no settled answer for it (N3-2). Before the first
 * GET: the pending placeholder. While the server says it is checking and this row has no
 * cache (or its cache says `unchecked`): the Checking spinner, never a "Not checked" that
 * flips to "Up to date" two seconds later. "Not checked" is reserved for a row the server
 * is NOT about to check: the batch finished without it, or the scan skipped it.
 */
export function resolveRowState(input: ResolveRowStateInput): UpdateState | undefined {
  const { known, loaded, refreshing, scanSkipped } = input
  if (known && known.kind !== 'unchecked') return known
  if (!loaded) return undefined
  if (refreshing) return { kind: 'checking' }
  if (known) return known
  return { kind: 'unchecked', ...(scanSkipped ? { reason: LINKED_SCAN_SKIPPED_NOTE } : {}) }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const withSuffix = (title: string): string =>
  title.endsWith(CLICK_TO_CHECK_SUFFIX.trim()) || title.endsWith('Click to check.')
    ? title
    : `${title}${CLICK_TO_CHECK_SUFFIX}`

const checkedSentence = (checkedAt: string | null, now?: number): string =>
  checkedAt ? ` Checked ${timeAgo(checkedAt, { long: true, now })}.` : ''

const ICON_FOR: Record<'current' | 'available' | 'dirty' | 'diverged' | 'unchecked', IconName> = {
  current: 'check',
  available: 'arrow-up',
  dirty: 'pencil',
  diverged: 'arrows-up-down',
  unchecked: 'circle-dashed',
}

/** Label for a kind we only know by name (the unreachable chip keeps the last known text). */
function lastKnownLabel(kind: NonNullable<Extract<UpdateState, { kind: 'unreachable' }>['lastKnown']>, s: {
  behind?: number | null
  ahead?: number
  toVersion?: string
}): string {
  switch (kind) {
    case 'current':
      return s.ahead && s.ahead > 0 ? `Up to date · ${s.ahead} ahead` : 'Up to date'
    case 'available':
      if (s.toVersion) return `v${npmToVersion(s.toVersion)} available`
      return typeof s.behind === 'number' && s.behind > 0 ? `${plural(s.behind, 'commit')} behind` : 'Update available'
    case 'dirty':
      return typeof s.behind === 'number' && s.behind > 0 ? `${s.behind} behind · Local changes` : 'Local changes'
    case 'diverged':
      return typeof s.behind === 'number' && typeof s.ahead === 'number'
        ? `${s.behind} behind · ${s.ahead} ahead`
        : 'Behind and ahead'
    case 'unchecked':
      return 'Not checked'
  }
}

const base = (kind: string, label: string, icon: IconName | null, modifiers: string[]): ChipView => ({
  kind, label, title: '', modifiers, icon, stale: false, busy: false, clickable: true,
})

/**
 * The one place that turns an UpdateState into what the chip shows. Exhaustive over
 * `state.kind`; `undefined` is the pending placeholder before the first GET returns.
 */
export function chipView(state: UpdateState | undefined, opts: ChipViewOptions): ChipView {
  if (opts.staticNote !== undefined) {
    const inner = state
      ? chipView(state, { ...opts, staticNote: undefined, busy: null })
      : base('unsupported', 'Cannot compare', 'slash-circle', ['--unsupported'])
    return { ...inner, title: opts.staticNote, clickable: false, busy: false }
  }
  if (opts.busy === 'checking' || opts.busy === 'updating' || state?.kind === 'checking') {
    const label = opts.busy === 'updating' ? 'Updating…' : 'Checking…'
    return { ...base('checking', label, 'spinner', ['--busy']), busy: true, clickable: false }
  }
  if (!state) {
    return { ...base('pending', '', null, ['--pending']), busy: true, clickable: false }
  }
  const view = chipViewFor(state, opts)
  if (opts.transient && view.clickable) view.title = withSuffix(LOCK_TRANSIENT_NOTE)
  // Offline: the words are the last known truth and are marked as such (C49). The header
  // carries the "Offline" sentence; the chip only says "this may be old".
  if (opts.offline && !view.stale && view.kind !== 'missing') {
    view.stale = true
    view.modifiers = [...view.modifiers, '--stale']
  }
  return view
}

/** The Installed row owns Update (spec 6.2): the Sources chip must not promise a button it lacks (N3-11). */
const UPDATE_ELSEWHERE = 'Update from its Installed row'

function chipViewFor(state: UpdateState, opts: ChipViewOptions): ChipView {
  const { checkedAt, now } = opts
  switch (state.kind) {
    case 'unchecked': {
      const v = base('unchecked', 'Not checked', 'circle-dashed', ['--unchecked'])
      v.title = withSuffix(state.reason ?? 'Walnut has not checked this plugin yet.')
      return v
    }
    case 'checking':
      return { ...base('checking', 'Checking…', 'spinner', ['--busy']), busy: true, clickable: false }
    case 'current': {
      const v = base('current', lastKnownLabel('current', state), 'check', ['--current'])
      // Ahead is not "the same": the sentence matches the label (N2-7).
      const ahead = typeof state.ahead === 'number' && state.ahead > 0 ? state.ahead : 0
      const same = ahead > 0
        ? `Nothing newer on the remote; you have ${plural(ahead, 'commit')} it does not.`
        : 'Same as the remote.'
      v.title = withSuffix(`${same}${checkedSentence(checkedAt, now)}`)
      return v
    }
    case 'available': {
      const v = base('available', lastKnownLabel('available', state), 'arrow-up', ['--available'])
      const to = state.toVersion ? `v${npmToVersion(state.toVersion)}` : opts.toRef ? opts.toRef.slice(0, 7) : null
      const verb = opts.updateElsewhere ? UPDATE_ELSEWHERE : 'Update'
      v.title = withSuffix(to ? `${verb} moves this plugin to ${to}.` : `${verb} moves this plugin to the newest commit on the remote.`)
      return v
    }
    case 'dirty': {
      const behind = typeof state.behind === 'number' ? state.behind : 0
      const v = base('dirty', lastKnownLabel('dirty', state), 'pencil', ['--dirty'])
      v.title = withSuffix(behind > 0
        ? `${plural(behind, 'new commit')} on the remote. Commit or stash your changes to take them.`
        : 'The checkout has uncommitted changes. Commit or stash them first.')
      return v
    }
    case 'diverged': {
      const v = base('diverged', lastKnownLabel('diverged', state), 'arrows-up-down', ['--diverged'])
      v.title = withSuffix('Both you and the remote have new commits. Rebase or merge in the checkout, then check again.')
      return v
    }
    case 'missing': {
      const v = base('missing', 'Not installed here', 'slash-circle', ['--missing'])
      v.title = 'The files for this plugin are not on this machine. Restore will clone them again.'
      v.clickable = false
      return v
    }
    case 'unreachable': {
      if (state.cause === 'auth') {
        const v = base('unreachable', 'Sign-in needed', 'key', ['--auth'])
        v.title = withSuffix('Your credentials for this remote were refused. Renew them and check again.')
        return v
      }
      const last = state.lastKnown ?? 'unchecked'
      const v = base('unreachable', lastKnownLabel(last, state as { behind?: number; ahead?: number; toVersion?: string }), ICON_FOR[last], [`--${last}`, '--stale'])
      v.stale = true
      const reason = scrubReason(state.reason)
      const when = checkedAt ? ` Last checked ${timeAgo(checkedAt, { long: true, now })}.` : ''
      // The reason is its own sentence: a period (unless it already ends one, or was cut with
      // an ellipsis) so the "Click to check again." suffix never reads as its tail.
      const tail = reason ? ` ${/[.!?…]$/.test(reason) ? reason : `${reason}.`}` : ''
      v.title = withSuffix(`Could not reach the remote just now.${when}${tail}`)
      return v
    }
    case 'unsupported': {
      const v = base('unsupported', 'Cannot compare', 'slash-circle', ['--unsupported'])
      const reason = scrubReason(state.reason).replace(/\.$/, '')
      v.title = withSuffix(`${reason}. ${state.hint}`.trim())
      return v
    }
  }
}

// ---------------------------------------------------------------------------------
// Update button (spec 6.3, three states, never two identical grey verbs)
// ---------------------------------------------------------------------------------

export const REASON_DIRTY = 'Commit or stash your changes in the checkout first.'
export const REASON_DIVERGED = 'Rebase or merge in the checkout, then check again.'
export const REASON_OFFLINE = 'Could not reach the remote. Check again when you are back online.'
export const REASON_AUTH = 'Your credentials for this remote were refused. Renew them and check again.'
export const RESTORE_TITLE = 'Update will clone it again.'

export type UpdateButtonMode =
  | { render: false }
  | { render: true; primary: true; label: 'Update' | 'Restore'; title?: string }
  | { render: true; disabled: true; label: 'Update' | 'Restore' | 'Updating…'; reason: string | null }

export interface UpdateButtonOptions {
  /** Display names of the OTHER plugins served from the same checkout (N3-4). */
  siblingNames?: string[]
}

/** `Also updates Acme Notes (same checkout).`; two or more list every name. */
export function sharedCheckoutNote(siblingNames: string[] | undefined): string | undefined {
  const names = (siblingNames ?? []).filter(Boolean)
  if (names.length === 0) return undefined
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Also updates ${list} (same checkout).`
}

/**
 * `pressed` is whether THIS row's button was the one clicked: while a shared row key is
 * updating, the pressed row reads `Updating…` and its siblings a disabled `Update`
 * (spec 5.1: the label changes only on the row that was pressed).
 *
 * While the row is being CHECKED the button stays where it is (no layout jump) but is
 * disabled: pressing Update against a state the server is about to replace would race the
 * check (N3-12).
 */
export function updateButtonMode(
  state: UpdateState | undefined,
  busy?: BusyKind | null,
  pressed = true,
  opts: UpdateButtonOptions = {},
): UpdateButtonMode {
  if (busy === 'updating') return { render: true, disabled: true, label: pressed ? 'Updating…' : 'Update', reason: null }
  if (busy === 'checking') {
    const settled = updateButtonMode(state, null, pressed, opts)
    if (!settled.render) return settled
    return { render: true, disabled: true, label: settled.label === 'Restore' ? 'Restore' : 'Update', reason: null }
  }
  if (!state) return { render: false }
  const shared = sharedCheckoutNote(opts.siblingNames)
  switch (state.kind) {
    case 'available':
      return { render: true, primary: true, label: 'Update', ...(shared ? { title: shared } : {}) }
    case 'missing':
      return { render: true, primary: true, label: 'Restore', title: RESTORE_TITLE }
    case 'dirty':
      return { render: true, disabled: true, label: 'Update', reason: REASON_DIRTY }
    case 'diverged':
      return { render: true, disabled: true, label: 'Update', reason: REASON_DIVERGED }
    case 'unreachable':
      if (state.lastKnown !== 'available') return { render: false }
      return { render: true, disabled: true, label: 'Update', reason: state.cause === 'auth' ? REASON_AUTH : REASON_OFFLINE }
    case 'current':
    case 'unchecked':
    case 'checking':
    case 'unsupported':
      return { render: false }
  }
}

// ---------------------------------------------------------------------------------
// Feedback line (spec 7)
// ---------------------------------------------------------------------------------

export interface Feedback {
  kind: 'ok' | 'error'
  text: string
  /** Raw (masked) git or npm text for the Details disclosure. */
  detail?: string
  /** Native title on the sentence: the full list behind an `and 2 more` (N3-16). */
  title?: string
}

export interface LinkedUpdateBody {
  sha?: string
  fromSha?: string
  updated?: boolean
  reloaded?: string[]
  skipped?: string[]
  failed?: Array<{ id: string; error: string }>
}

export interface SourceUpdateBody {
  updated?: boolean
  fromSha?: string
  toSha?: string
  fromResolved?: string
  resolved?: string
  restartRequired?: boolean
  error?: string
}

const sha7 = (sha?: string): string => (sha ? sha.slice(0, 7) : '')

/** `Acme Tracker` / `Acme Tracker and 2 more`; ids go through `nameOf` and never show. */
export function nameList(ids: string[], nameOf: (id: string) => string): string {
  if (ids.length === 0) return ''
  const first = nameOf(ids[0])
  if (ids.length === 1) return first
  return `${first} and ${ids.length - 1} more`
}

export function successFeedback(
  kind: 'linked' | 'git' | 'npm',
  body: LinkedUpdateBody & SourceUpdateBody,
  nameOf: (id: string) => string,
): Feedback {
  if (kind === 'linked') {
    const at = sha7(body.sha ?? body.toSha)
    const failedNote = body.failed?.length
      ? ` · ${nameList(body.failed.map((f) => f.id), nameOf)} could not be reloaded.`
      : ''
    const detail = body.failed?.length ? body.failed.map((f) => `${f.id}: ${f.error}`).join('\n') : undefined
    if (body.updated === false) {
      return { kind: 'ok', text: `Already up to date at ${at}`.trim() + failedNote, ...(detail ? { detail } : {}) }
    }
    const reloaded = body.reloaded ?? []
    const tail = reloaded.length > 0 ? `reloaded ${nameList(reloaded, nameOf)}` : 'nothing was running from it'
    // "and 1 more" names the rest on hover: the sibling that was reloaded is never anonymous.
    const title = reloaded.length > 1 ? `Reloaded ${reloaded.map(nameOf).join(', ')}` : undefined
    return { kind: 'ok', text: `Updated to ${at} · ${tail}${failedNote}`, ...(detail ? { detail } : {}), ...(title ? { title } : {}) }
  }
  if (kind === 'npm') {
    const version = body.resolved ? `v${npmToVersion(body.resolved)}` : ''
    if (body.updated === false) return { kind: 'ok', text: `Already up to date at ${version}`.trim() }
    return { kind: 'ok', text: `Updated to ${version} · restart Walnut to run the new code`.replace('  ', ' ') }
  }
  const at = sha7(body.toSha ?? body.sha)
  if (body.updated === false) return { kind: 'ok', text: `Already up to date at ${at}`.trim() }
  const tail = body.restartRequired ? 'restart Walnut to run the new code' : 'reloaded'
  return { kind: 'ok', text: `Updated to ${at} · ${tail}` }
}

export interface FailureBody {
  error?: string
  code?: 'dirty' | 'diverged' | string
  /** The server's classification of a git failure (spec 5.4). */
  cause?: 'network' | 'auth' | 'timeout' | 'lock' | 'unknown' | string
  detail?: string
  stderr?: string
}

/** The one sentence per failure cause; `unknown` falls back to the scrubbed server sentence. */
const CAUSE_SENTENCE: Record<string, string> = {
  network: 'the remote could not be reached.',
  timeout: 'the remote could not be reached.',
  auth: 'your credentials for the remote were refused.',
  lock: 'another git command was running; try again.',
}

/** Looks like raw git output rather than a sentence for a person: framing, a path, a URL or a host. */
const RAW_GIT_TEXT = /^git exited|\bfatal:|(^|[\s'"])\/[^\s'"]+\/|[a-z][a-z0-9+.-]*:\/\/|\S+@\S+/i

export function failureFeedback(status: number, body: FailureBody | null | undefined, fallback?: string): Feedback {
  const raw = body?.error ?? fallback ?? ''
  const explicitDetail = body?.detail ?? body?.stderr
  // Details holds the raw text whenever the row cannot show it whole: explicitly sent,
  // too long for a line, or git output the scrub will rewrite.
  const detail = explicitDetail ?? (raw && (raw.length > REASON_CAP || RAW_GIT_TEXT.test(raw)) ? raw : undefined)
  const withDetail = (text: string): Feedback => ({ kind: 'error', text, ...(detail ? { detail } : {}) })
  if (status === 409) {
    if (body?.code === 'dirty') return withDetail('Could not update: the checkout has uncommitted changes.')
    if (body?.code === 'diverged') return withDetail('Could not update: your branch and the remote have both moved.')
  }
  if (status === 504 || /timed out/i.test(raw)) return withDetail('Could not update: git did not finish in 60 s.')
  const byCause = body?.cause ? CAUSE_SENTENCE[body.cause] : undefined
  if (byCause) return withDetail(`Could not update: ${byCause}`)
  const sentence = scrubReason(raw) || 'the server returned an error.'
  // Lowercase a leading capital so the sentence reads on from the colon, but leave an
  // acronym (HEAD, SSH) alone.
  const lead = /^[A-Z][a-z]/.test(sentence) ? sentence.charAt(0).toLowerCase() + sentence.slice(1) : sentence
  return withDetail(`Could not update: ${lead}${/[.!?…]$/.test(lead) ? '' : '.'}`)
}
