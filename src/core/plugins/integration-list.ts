/**
 * The plugin list the console and agents read (GET /api/integrations and /api/v1/integrations):
 * each plugin's display metadata, its one sentence (`description`), whether a project can sync
 * to it (`syncsTasks`), and for those who reads what Walnut sends there (`audience`). 2026-11-01: the new project picker and agents saw
 * bare plugin names, and private tasks were filed into a tracker the user's team reads. One
 * builder, so the two routes cannot drift apart.
 */
import { registry } from '../integration-registry.js'
import { getConfig } from '../config-manager.js'
import type { Config, SyncAudience } from '../types.js'

/** Who reads a service: the user's own setting for it (an older Settings wrote it), else the
 *  plugin's manifest, else shared (a plugin that says nothing is the safe case). */
export function serviceAudienceOf(config: Pick<Config, 'private_tasks'>, id: string, manifest: SyncAudience | undefined): SyncAudience {
  const set = config.private_tasks?.audience?.[id]
  if (set === 'self' || set === 'shared') return set
  return manifest ?? 'shared'
}

export interface IntegrationListItem {
  id: string
  name: string
  description?: string
  badge: string
  badgeColor: string
  externalLinkLabel: string
  syncsTasks: boolean
  audience?: SyncAudience
}

export async function integrationList(): Promise<IntegrationListItem[]> {
  const config = await getConfig()
  const syncing = new Set(registry.getSyncPlugins().map((p) => p.id))
  return registry.getAll()
    .filter((p) => p.id !== 'local' && p.display)
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      badge: p.display!.badge,
      badgeColor: p.display!.badgeColor,
      externalLinkLabel: p.display!.externalLinkLabel,
      syncsTasks: syncing.has(p.id),
      ...(syncing.has(p.id) ? { audience: serviceAudienceOf(config, p.id, p.syncAudience) } : {}),
    }))
}

/** The shortest quote of the user that counts as their words (as for Sync on a held task). */
const MIN_USER_WORDS = 10

/**
 * Why a session may not create a project syncing to `source`, or null. A project on a service
 * other people read is the user's choice (its tasks go where colleagues see them), so a session
 * passes the user's own words asking for it, as for sending a held task there. A person (no
 * session header), a local project and a service only the user reads need none.
 */
export async function projectSourceRefusal(source: string, callerSid: string | undefined, userWords: unknown): Promise<string | null> {
  if (!callerSid || !source || source === 'local') return null
  const plugin = registry.get(source)
  const audience = serviceAudienceOf(await getConfig(), source, plugin?.syncAudience)
  if (audience !== 'shared') return null
  if (typeof userWords === 'string' && userWords.trim().length >= MIN_USER_WORDS) return null
  return `A project that syncs to ${plugin?.name ?? source} puts its tasks where other people can see them, which is the user's decision. `
    + 'Pass user_words with what the user said asking for it (quoted), or create it local.'
}
