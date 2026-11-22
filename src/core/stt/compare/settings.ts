/**
 * Voice Accuracy settings as code reads them: the experiment's switch, each
 * engine's switch and upload consent, and the ElevenLabs key (a managed secret
 * file under <WALNUT_HOME>/secrets/, the config keeping only its `${file:...}`
 * ref). A write edits `stt.compare` only, inside the config lock, so nothing
 * else of the stored config is rewritten.
 */
import { experimentCache } from '../../experimental-cache.js'
import { removeManagedSecret, resolveSecret, writeManagedSecret } from '../../../model/providers/secret.js'
import type { Config } from '../../types.js'

export const compareFlag = experimentCache('stt_compare')

/** The managed key file's name under secrets/. */
export const ELEVENLABS_KEY_NAME = 'elevenlabs-api.key'

type CompareSection = NonNullable<NonNullable<Config['stt']>['compare']>

export function compareSection(config: Config): CompareSection {
  return config.stt?.compare ?? {}
}

/** An engine is switched on unless the user switched it off. */
export function engineEnabled(config: Config, id: string): boolean {
  return compareSection(config).engines?.[id]?.enabled !== false
}

/** Upload consent is never assumed: only an explicit tick gives it. */
export function uploadAllowed(config: Config, id: string): boolean {
  return compareSection(config).engines?.[id]?.allow_upload === true
}

export function elevenLabsKey(config: Config): string | undefined {
  return resolveSecret(compareSection(config).elevenlabs_api_key)
}

export interface CompareSettingsPatch {
  engines?: Record<string, { enabled?: unknown; allow_upload?: unknown }>
  nightly?: unknown
  elevenlabs_api_key?: unknown
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Edit `stt.compare` of the stored config under its lock; `edit` gets a copy and may run more than once. */
async function editStoredSection(edit: (section: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const { migrateStoredConfig } = await import('../../config-manager.js')
  let next: Record<string, unknown> = {}
  await migrateStoredConfig((doc) => {
    const stt: Record<string, unknown> = isObject(doc.stt) ? { ...doc.stt } : {}
    const before = isObject(stt.compare) ? stt.compare : undefined
    const section = before ? structuredClone(before) : {}
    edit(section)
    next = section
    if (JSON.stringify(section) === JSON.stringify(before ?? {})) return false
    if (Object.keys(section).length) stt.compare = section
    else delete stt.compare
    doc.stt = stt
    return true
  })
  return next
}

/** What a settings change means for work already going: the key's known state goes, an upload in flight stops. */
async function afterSettingsChange(keyChanged: boolean): Promise<void> {
  if (keyChanged) (await import('./elevenlabs.js')).forgetElevenLabsKeyState()
  ;(await import('./runner.js')).settingsChanged()
}

/** A settings write, checked. Throws a message for the user on a bad field. */
export async function writeCompareSettings(patch: CompareSettingsPatch, knownEngines: string[]): Promise<CompareSection> {
  const rows: Record<string, { enabled?: boolean; allow_upload?: boolean }> = {}
  if (patch.engines !== undefined) {
    if (!isObject(patch.engines)) throw new Error('engines must be an object')
    for (const [id, value] of Object.entries(patch.engines)) {
      if (!knownEngines.includes(id)) throw new Error(`unknown engine: ${id}`)
      const row: { enabled?: boolean; allow_upload?: boolean } = {}
      for (const field of ['enabled', 'allow_upload'] as const) {
        const v = (value as Record<string, unknown> | undefined)?.[field]
        if (v === undefined) continue
        if (typeof v !== 'boolean') throw new Error(`${id}.${field} must be true or false`)
        row[field] = v
      }
      rows[id] = row
    }
  }
  if (patch.nightly !== undefined && typeof patch.nightly !== 'boolean') throw new Error('nightly must be true or false')
  // undefined: the key is not touched; '': removed; else the new key.
  let key: string | undefined
  if (patch.elevenlabs_api_key !== undefined) {
    if (typeof patch.elevenlabs_api_key !== 'string') throw new Error('elevenlabs_api_key must be a string')
    key = patch.elevenlabs_api_key.trim()
    if (key && (/\s/.test(key) || key.length < 8 || key.length > 512)) throw new Error('that does not look like an API key')
  }
  const ref = key ? await writeManagedSecret(ELEVENLABS_KEY_NAME, key) : undefined
  let priorRef: unknown
  const next = await editStoredSection((section) => {
    const engines = isObject(section.engines) ? section.engines : {}
    for (const [id, row] of Object.entries(rows)) engines[id] = { ...(isObject(engines[id]) ? engines[id] : {}), ...row }
    section.engines = engines
    if (patch.nightly !== undefined) section.nightly = patch.nightly
    if (key !== undefined) {
      priorRef = section.elevenlabs_api_key
      if (ref) section.elevenlabs_api_key = ref
      else delete section.elevenlabs_api_key
    }
  })
  // Cleared: our managed file goes; a key the user keeps elsewhere is theirs.
  if (key === '') await removeManagedSecret(ELEVENLABS_KEY_NAME, typeof priorRef === 'string' ? priorRef : undefined)
  await afterSettingsChange(key !== undefined)
  return next as CompareSection
}

/**
 * Delete everything Voice Accuracy kept: the running and queued jobs stop, the
 * compared takes (<WALNUT_HOME>/stt-compare/) go, and so do the stored key and
 * the pane's settings (`stt.compare`). The recordings themselves are never touched.
 */
export async function deleteCompareData(): Promise<void> {
  const [{ stopAllRuns }, { compareStore }] = await Promise.all([import('./runner.js'), import('./store.js')])
  await stopAllRuns()
  await compareStore.clear()
  let priorRef: unknown
  await editStoredSection((section) => {
    priorRef = section.elevenlabs_api_key
    for (const k of Object.keys(section)) delete section[k]
  })
  await removeManagedSecret(ELEVENLABS_KEY_NAME, typeof priorRef === 'string' ? priorRef : undefined)
  await afterSettingsChange(true)
}
