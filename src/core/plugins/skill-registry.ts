/**
 * Owner-scoped registry for plugin-contributed SKILL.md directories.
 *
 * A plugin registers a DIRECTORY (absolute path) that holds one or more skills in
 * the layout the skill loader already understands (`<dir>/<name>/SKILL.md`, or
 * `<dir>/<category>/<name>/SKILL.md`). No virtual URIs and no inline skill content:
 * a registered directory is just one more search root, so everything downstream
 * (discovery, disabled-skill settings, `skill_view`, the palette) keeps working
 * unchanged, and a missing directory stays fail-soft in the loader.
 *
 * Leaf module on purpose (owned-registry + ids + node:path): `skill-loader` sits on
 * the prompt path and must not gain a heavy import through this file.
 */
import path from 'node:path'
import { OwnedRegistry } from './owned-registry.js'
import { namespacePluginId, validatePluginId } from './ids.js'
import type { Disposable } from './disposable.js'

/** What a plugin passes to `walnut.registry.skill(...)`. */
export interface PluginSkillDefinition {
  id: string
  directory: string
}

export interface PluginSkillDirRecord {
  /** `<pluginId>:<localId>` — the host-owned registry key. */
  name: string
  owner: string
  directory: string
}

const pluginSkillDirs = new OwnedRegistry<PluginSkillDirRecord>()

export function registerOwnedSkillDir(owner: string, definition: PluginSkillDefinition): Disposable {
  validatePluginId(owner)
  const name = namespacePluginId(owner, definition.id)
  if (typeof definition.directory !== 'string' || !definition.directory.trim()) {
    throw new Error(`Plugin skill "${name}" requires a directory path`)
  }
  if (!path.isAbsolute(definition.directory)) {
    throw new Error(`Plugin skill "${name}" directory must be an absolute path: ${JSON.stringify(definition.directory)}`)
  }
  return pluginSkillDirs.register(owner, name, {
    name,
    owner,
    directory: path.resolve(definition.directory),
  })
}

/**
 * Registered directories in registration order. Returns the SAME empty array shape
 * when nothing is registered — the skill loader relies on `length === 0` to skip its
 * dedupe pass entirely, so a Walnut with no skill-contributing plugin builds a
 * byte-identical skills prompt.
 */
export function listOwnedSkillDirs(): string[] {
  return pluginSkillDirs.values().map((record) => record.directory)
}

export function listOwnedSkillDirRecords(): PluginSkillDirRecord[] {
  return pluginSkillDirs.values()
}

export function removeOwnedSkillDirs(owner: string): number {
  return pluginSkillDirs.removeOwner(owner)
}

/** Test-only reset — production disposal goes through the per-plugin Disposable. */
export function resetOwnedSkillDirsForTesting(): void {
  pluginSkillDirs.clear()
}
