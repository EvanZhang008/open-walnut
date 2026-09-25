/**
 * The doctor report as text a user pastes into an issue or a chat (redaction
 * that makes it safe to paste in public lives in redact.ts).
 *
 * Text rules: one fact per line, labels in one column, one line per host with
 * the host columns aligned, plain ASCII punctuation so it survives any paste
 * target. The redacted form is what the UI copies and the CLI prints by default.
 */

import type { DiagnosticsReport, HostDiagnostics, PathSummary } from './types.js'

const LABEL_WIDTH = 11

export interface RenderOptions {
  /** 'hosts' = the build line plus the hosts block only (Settings > Remote Hosts). */
  section?: 'all' | 'hosts'
}

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`
}

export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function buildValue(r: DiagnosticsReport): string {
  const b = r.build
  const parts = [b.version]
  if (b.commit) parts.push(`commit ${b.commit}${b.dirty ? '+dirty' : ''}`)
  else if (b.dirty) parts.push('+dirty')
  if (b.branch) parts.push(`branch ${b.branch}`)
  parts.push(b.builtAt ? `built ${b.builtAt}` : 'from source')
  return parts.join('  ')
}

function pathValue(p: PathSummary | null): string {
  if (!p) return 'not captured'
  if (p.count === 0) return 'empty'
  const more = p.count > p.entries.length ? ` (+${p.count - p.entries.length} more)` : ''
  return `${p.count} entries  ${p.entries.join(':')}${more}`
}

/** Sign-in and version floor as short tokens: `signed-in`, `not signed in`, `needs 2.1.280`. */
export function claudeStateTokens(c: { auth?: string; versionOk?: boolean; minVersion?: string }, detail?: string): string[] {
  const out: string[] = []
  if (c.auth === 'ok') out.push(detail ? `signed-in (${detail})` : 'signed-in')
  else if (c.auth === 'not-logged-in') out.push('not signed in')
  else if (c.auth === 'unknown') out.push(detail ? `sign-in unknown (${detail})` : 'sign-in unknown')
  if (c.versionOk === false) out.push(`needs ${c.minVersion ?? 'a newer version'}`)
  return out
}

function claudeValue(r: DiagnosticsReport): string {
  const c = r.local.claude
  if (c.unknown) return [`unknown (${c.unknown})`, ...(c.path ? [c.path] : [])].join('  ')
  if (!c.found) return 'not found'
  const parts = [c.version ?? 'version unknown']
  if (c.kind) parts.push(c.node ? `${c.kind} (node ${c.node.found ? c.node.version ?? 'found' : 'missing'})` : c.kind)
  parts.push(...claudeStateTokens(c, c.authDetail))
  if (c.path) parts.push(c.path)
  if (r.local.preflightSource === 'daemon') parts.push('(checked by the local daemon)')
  return parts.join('  ')
}

function compilerValue(c: DiagnosticsReport['local']['compiler']): string {
  if (c.unknown) return `unknown (${c.unknown})`
  return c.found ? c.name ?? 'found' : 'none'
}

function dtachValue(d: DiagnosticsReport['local']['dtach']): string {
  if (d.found) return `${d.path ?? '?'} (${d.source ?? 'found'})`
  if (d.unknown) return d.unknown
  return d.note ? `not found (${d.note})` : 'not found'
}

function configValue(r: DiagnosticsReport): string {
  const c = r.config
  if (!c) return 'unavailable'
  const parts: string[] = []
  parts.push(`provider ${c.mainProvider ?? c.provider ?? 'default'}`)
  if (c.mainModel) parts.push(`main model ${c.mainModel}`)
  if (c.fastModel) parts.push(`fast model ${c.fastModel}`)
  parts.push(`engine ${c.engine}`)
  parts.push(`search ${c.searchDisabled ? 'off' : 'on'}`)
  if (c.providers.length) parts.push(`providers ${c.providers.join(', ')}`)
  return parts.join('  ')
}

function hostStatus(h: HostDiagnostics): string {
  if (h.lastError) return `error: ${h.lastError.replace(/\s+/g, ' ').slice(0, 120)}`
  if (!h.connected) {
    if (h.phase === 'idle') return 'not connected'
    if (h.phase === 'failed') return 'connect failed'
    if (h.phase === 'queued') return 'waiting to connect'
    return `connecting (${h.phase})`
  }
  const r = h.readiness
  if (!r) return 'not checked yet'
  const kinds = r.problems.map((p) => p.fix?.state === 'running' ? `${p.kind} (fixing)` : p.kind)
  if (r.checkError) kinds.push(`check failed: ${r.checkError.replace(/\s+/g, ' ').slice(0, 80)}`)
  return kinds.length ? `problems: ${kinds.join(', ')}` : 'ok'
}

function hostCells(h: HostDiagnostics): string[] {
  const r = h.connected ? h.readiness : null
  const daemon = h.daemonVersion || h.runtime ? `daemon ${h.daemonVersion ?? '?'}${h.runtime ? ` ${h.runtime}` : ''}` : '-'
  const dir = h.daemonDir ? `dir ${h.daemonDir.display}${h.daemonDir.fallback ? ' (fallback)' : ''}` : '-'
  const platform = r?.platform ? `${r.platform}/${r.arch ?? '?'}` : '-'
  let claude = '-'
  if (r) {
    claude = r.claude.found
      ? [`claude ${r.claude.version ?? '?'}`, r.claude.kind ?? '', ...claudeStateTokens(r.claude)].filter(Boolean).join(' ')
      : 'no claude'
  }
  const warnings = (h.warnings ?? []).map((w) => `warning: ${w.replace(/\s+/g, ' ')}`)
  const status = [hostStatus(h), ...warnings].join('; ')
  return [h.alias, h.user ? `${h.user}@${h.hostname}` : h.hostname, h.connected ? 'connected' : h.phase, daemon, dir, platform, claude, status]
}

function hostLines(r: DiagnosticsReport): string[] {
  if (r.collector === 'cli' && r.hosts.length === 0) return [line('hosts', 'not checked (server not running)')]
  if (r.hosts.length === 0) return [line('hosts', 'none configured')]
  const rows = r.hosts.map(hostCells)
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)))
  const out = [line('hosts', `${r.hosts.length} configured`)]
  for (const row of rows) {
    out.push(`  ${row.map((cell, col) => col === row.length - 1 ? cell : cell.padEnd(widths[col])).join('  ')}`.trimEnd())
  }
  return out
}

function warningLines(warnings: string[]): string[] {
  if (warnings.length === 0) return [line('warnings', 'none')]
  return [line('warnings', String(warnings.length)), ...warnings.map((w) => `  - ${w}`)]
}

/** Warnings about hosts: the probe's own `host <alias>:` lines and the `hosts:` listing. */
function hostWarnings(warnings: string[]): string[] {
  return warnings.filter((w) => w.startsWith('host'))
}

/** The hosts section alone, as JSON (`--hosts --json`, `?section=hosts&format=json`). */
export function hostsSection(r: DiagnosticsReport): Pick<DiagnosticsReport, 'generatedAt' | 'collector' | 'build' | 'hosts' | 'warnings'> {
  return { generatedAt: r.generatedAt, collector: r.collector, build: r.build, hosts: r.hosts, warnings: hostWarnings(r.warnings) }
}

export function renderDiagnosticsText(r: DiagnosticsReport, opts: RenderOptions = {}): string {
  if (opts.section === 'hosts') {
    return [
      `Open Walnut host diagnostics (${r.generatedAt})`,
      line('build', buildValue(r)),
      ...hostLines(r),
      ...warningLines(hostWarnings(r.warnings)),
    ].join('\n')
  }
  const s = r.server
  const serverValue = s
    ? [`pid ${s.pid}`, `port ${s.port ?? '?'}`, `node ${s.node}`, `${s.platform}/${s.arch}`, `nice ${s.nice ?? '?'}`, `up ${formatUptime(s.uptimeMs)}`, s.mode].join('  ')
    : 'not running (collected by the CLI)'
  const l = r.local
  const out = [
    `Open Walnut doctor (${r.collector}, ${r.generatedAt})`,
    line('build', buildValue(r)),
    line('server', serverValue),
  ]
  if (s) out.push(line('data dir', s.dataDir))
  out.push(
    line('node', `${l.node.version}  ${l.node.path}`),
    line('claude', claudeValue(r)),
    line('shell', l.shell ?? 'unknown'),
    line('login PATH', pathValue(l.loginShellPath)),
    line('proc PATH', pathValue(l.processPath)),
    line('compiler', compilerValue(l.compiler)),
    line('dtach', dtachValue(l.dtach)),
    line('sqlite', l.sqliteOk === null ? 'not checked' : l.sqliteOk ? `ok${l.sqliteVersion ? ` ${l.sqliteVersion}` : ''}` : 'FAILED'),
    line('web assets', l.webAssetsOk === null ? 'not served by this process' : l.webAssetsOk ? 'ok' : 'MISSING'),
    line('config', configValue(r)),
    ...hostLines(r),
    ...warningLines(r.warnings),
  )
  return out.join('\n')
}

// Redaction lives in redact.ts; re-exported for the callers that render and redact together.
export { redactDiagnostics } from './redact.js'
