/**
 * The Apps page groups the installed plugins by where they come from: the ones built into
 * Walnut, one section per installed source (a git repo or an npm package, which can carry
 * several plugins and is what gets updated or removed), and the ones that only live in a
 * folder on this computer. Pure: unit tested in tests/web/apps-source-sections.test.ts.
 */
import type { PluginSource } from '@/components/settings/sections/PluginSourcesGroup'
import type { InstallLinkTarget } from '../../../../src/core/plugin-install-link'
import type { RegistryRow } from './plugin-store-model'

export type SourceSectionKind = 'builtin' | 'source' | 'local'

export interface SourceSection {
  /** Stable key: `builtin`, `local`, or `source:<slug>`. */
  id: string
  kind: SourceSectionKind
  title: string
  rows: RegistryRow[]
  /** Only for `source`: the installed source the section stands for. */
  source?: PluginSource
}

export const BUILTIN_SECTION_TITLE = 'Built-in plugins'
export const LOCAL_SECTION_TITLE = 'On this computer'

/** A source's name as a person says it: the repo's last path part, or the npm package. */
export function sourceDisplayName(source: Pick<PluginSource, 'slug' | 'kind' | 'type' | 'url' | 'spec' | 'packageName'>): string {
  if (source.kind === 'npm' || source.type === 'npm') {
    return source.packageName ?? (source.spec ? source.spec.replace(/(?!^)@[^/]*$/, '') : source.slug)
  }
  const url = (source.url ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const last = url.split(/[/:]/).filter(Boolean).pop()
  return last || source.slug
}

/**
 * The sections, in page order: built in, each source (by name), then this computer. A source
 * whose plugins did not load (its clone is gone, every plugin failed) still gets its section,
 * so its Restore, Update and Remove stay reachable.
 */
export function sourceSections(rows: readonly RegistryRow[], sources: readonly PluginSource[]): SourceSection[] {
  const bySlug = new Map(sources.map((source) => [source.slug, source]))
  const builtin: RegistryRow[] = []
  const local: RegistryRow[] = []
  const owned = new Map<string, RegistryRow[]>()
  for (const row of rows) {
    if (row.builtin || row.source.kind === 'builtin' || row.source.kind === 'bundled') builtin.push(row)
    else if (row.sourceSlug && bySlug.has(row.sourceSlug)) owned.set(row.sourceSlug, [...(owned.get(row.sourceSlug) ?? []), row])
    else local.push(row)
  }
  const sourceList = [...sources]
    .map((source) => ({ source, title: sourceDisplayName(source) }))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(({ source, title }): SourceSection => ({ id: `source:${source.slug}`, kind: 'source', title, rows: owned.get(source.slug) ?? [], source }))
  return [
    ...(builtin.length > 0 ? [{ id: 'builtin', kind: 'builtin' as const, title: BUILTIN_SECTION_TITLE, rows: builtin }] : []),
    ...sourceList,
    ...(local.length > 0 ? [{ id: 'local', kind: 'local' as const, title: LOCAL_SECTION_TITLE, rows: local }] : []),
  ]
}

/** One form of a git URL for comparing two spellings of the same repo. */
function gitKey(url: string): string {
  return url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
    .replace(/^(ssh|https?|git|file):\/\/(?:[^@/]+@)?/, '').replace(/^[^@/]+@([^:/]+):/, '$1/')
}

/** The installed source an install link names, if it is installed already. */
export function installedSourceFor(target: InstallLinkTarget, sources: readonly PluginSource[]): PluginSource | null {
  if (target.kind === 'npm') {
    const name = target.spec.replace(/(?!^)@[^/]*$/, '')
    return sources.find((source) => (source.kind === 'npm' || source.type === 'npm')
      && (source.packageName === name || (source.spec ?? '').replace(/(?!^)@[^/]*$/, '') === name)) ?? null
  }
  const want = gitKey(target.url)
  // By repo alone: one repo is installed once, whichever branch the link names.
  return sources.find((source) => source.kind !== 'npm' && source.type !== 'npm' && source.url && gitKey(source.url) === want) ?? null
}
