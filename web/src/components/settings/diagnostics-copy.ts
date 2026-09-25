/**
 * Pure helpers behind the "Copy diagnostics" buttons (CopyDiagnostics.tsx),
 * kept React-free so they are testable on their own.
 */
import type { Config } from '@open-walnut/core'

export type DiagnosticsSection = 'all' | 'hosts'

export function diagnosticsQuery(section: DiagnosticsSection): Record<string, string> {
  return section === 'hosts' ? { format: 'text', section: 'hosts' } : { format: 'text' }
}

/**
 * Whether the SAVED config has a host the diagnostics would report: the same
 * rule as listStatusHosts on the server (not `__local__`, not disabled). An
 * unsaved draft row is not a host yet.
 */
export function hasStatusHosts(config: Pick<Config, 'hosts'>): boolean {
  return Object.entries(config.hosts ?? {}).some(([key, h]) => key !== '__local__' && h?.enabled !== false)
}
