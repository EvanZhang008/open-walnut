/**
 * What Settings, Browser extension says about each connected browser (BrowserExtensionGroup.tsx):
 * whether it is connected now, the version it runs against the one Walnut ships, how it updates,
 * and whether agents may use it. Pure, so the words are tested once for every install kind.
 */
import { AGENTS_IN_BROWSER } from './browser-labels'
import { timeAgo } from '@/utils/time'

export type InstallKind = 'walnut-folder' | 'unpacked' | 'store' | 'other'

/** One paired extension (a device named `extension-*`). */
export interface ExtDevice { name: string; info?: { deviceName?: string }; createdAt: string; lastUsedAt?: string }
/** What it last said about itself (GET /api/v1/browser/status `extensions`, src/core/browser-control/extension-seen.ts). */
export interface ExtSeen { device: string; version: string; build?: string; install?: InstallKind; at: string }
export interface ExtShipped { version: string; build: string }

export type ExtUpdate = 'current' | 'updating' | 'reload' | 'store' | 'unknown'

export interface ExtRowModel {
  device: string
  label: string
  /** Heard from in the last 15 minutes (its update check runs every 10), or polling for agents now. */
  live: boolean
  version?: string
  update: ExtUpdate
  /** One short line: connected or when last heard from, the version, how it updates, agents. */
  line: string
  /** The rest, for the row's hover: the build and why the update or version is what it is. */
  detail: string
}

/** The extension checks in every 10 minutes (self-update.ts); a little more than that still reads as connected. */
export const LIVE_MS = 15 * 60_000

/**
 * How this copy updates. Builds change without a new version number, so only a named build is
 * compared; an extension older than these reports names none (`unknown`), and one whose update
 * check has not said how it was installed yet (a Walnut restarted since) is `unknown` until it
 * does, unless it already runs this build.
 */
export function updateOf(seen: ExtSeen | undefined, shipped: ExtShipped | null | undefined): ExtUpdate {
  if (!seen?.version) return 'unknown'
  if (seen.install === 'store') return 'store'
  if (!seen.build) return 'unknown'
  if (!shipped || seen.build === shipped.build) return 'current'
  if (seen.install === 'walnut-folder') return 'updating'
  return seen.install ? 'reload' : 'unknown'
}

/** Short words for the row's line; UPDATE_DETAIL says the rest on hover. */
const UPDATE_WORDS: Record<ExtUpdate, string> = {
  current: 'up to date',
  updating: 'updates itself within 10 minutes',
  reload: 'outdated: set it up again below',
  store: 'updates through its store',
  unknown: 'how it updates is not known yet',
}
const NOT_REPORTED_WHY = 'An older extension, or one that has not checked in since Walnut started.'
const UPDATE_DETAIL: Record<ExtUpdate, string> = {
  current: 'It runs the build this Walnut ships.',
  updating: 'A newer build is ready: it updates itself within 10 minutes.',
  reload: 'Older than this Walnut. Set it up from Walnut\'s folder below once, and it updates itself from then on.',
  store: 'It updates through the browser\'s store.',
  unknown: `How it updates is not reported yet. ${NOT_REPORTED_WHY}`,
}

/** `polling`: the browsers that let agents in now (device → its caps, GET /api/v1/browser/status `browsers`). */
export function extRows(devices: ExtDevice[], seen: ExtSeen[], polling: ReadonlyMap<string, readonly string[]>, shipped: ExtShipped | null | undefined, now = Date.now()): ExtRowModel[] {
  const byDevice = new Map(seen.map((s) => [s.device, s]))
  return devices.map((d) => {
    const s = byDevice.get(d.name)
    const heard = s ? new Date(s.at).getTime() : NaN
    const live = polling.has(d.name) || (Number.isFinite(heard) && now - heard < LIVE_MS)
    const update = updateOf(s, shipped)
    const heardAt = s?.at ?? d.lastUsedAt
    const parts = [
      live ? 'Connected' : `Last heard ${heardAt ? timeAgo(heardAt, { long: true, now }) : 'not yet'}`,
      s?.version ? `Version ${s.version}, ${UPDATE_WORDS[update]}` : 'Version not reported yet',
      !polling.has(d.name) ? AGENTS_IN_BROWSER.none : polling.get(d.name)!.includes('handed-tabs-only') ? AGENTS_IN_BROWSER.shared : AGENTS_IN_BROWSER.all,
    ]
    const detail = s?.version ? `${s.build ? `Build ${s.build.slice(0, 7)}. ` : ''}${UPDATE_DETAIL[update]}` : `Version not reported yet. ${NOT_REPORTED_WHY}`
    return { device: d.name, label: d.info?.deviceName ?? 'Walnut extension', live, ...(s?.version ? { version: s.version } : {}), update, line: `${parts.join('. ')}.`, detail }
  })
}
