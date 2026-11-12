/** Claude Code owns its defaults. The requested Auto fallback applies only when
 * no settings layer names a mode; never rewrite the engine's settings files. */
import { readEngineSettings, type EngineSettingsView } from '../core/agents/engine-settings-service.js'
import { DaemonFileReader } from '../core/daemon-file-reader.js'
import { sessionModeFromCli, type SessionMode } from '../core/types.js'
import { claudeVersionAtLeast } from '../core/hosts/claude-version-floor.js'

export interface ClaudeLaunchMode {
  mode: SessionMode
  source: 'settings' | 'fallback' | 'engine'
  /** Only the fallback needs a flag. Settings and managed policy stay engine-owned. */
  cli?: string
  /**
   * The settings could not be read (a failed or slow read through the host's daemon): this
   * is the safe default, not what the host says. A spawn template built from it differs
   * from one built from a real read, so a push must not replace a template on its account
   * (2026-11-12: the template's hash flipped with the link's speed, and each flip sent its
   * 110 to 220 KB again on the session link).
   */
  degraded?: true
}

export function selectClaudeLaunchMode(view: EngineSettingsView | null, version?: string): ClaudeLaunchMode {
  const item = view?.groups.flatMap(g => g.items).find(i => i.key === 'permissions.defaultMode')
  if (!item || item.invalid) return { mode: 'default', source: 'engine' }
  if (item.source !== 'default') {
    const mode = typeof item.value === 'string' ? sessionModeFromCli(item.value) : null
    return { mode: mode ?? 'default', source: 'settings' }
  }
  // 2.1.199 is the oldest build whose Auto spawn and live switch we verified.
  // Unknown/older engines retain their own default, without an unsupported flag.
  if (claudeVersionAtLeast(version, '2.1.199') !== true) return { mode: 'default', source: 'engine' }
  return { mode: 'auto', source: 'fallback', cli: 'auto' }
}

/** Managed files and the engine's cached remote policy outrank the fallback.
 * Probe named files only; the engine remains the authority for their merge. */
export async function managedModePresent(read: (path: string) => Promise<Buffer | null>, configDir = '~/.claude'): Promise<boolean> {
  const paths = [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/etc/claude-code/managed-settings.json',
    '/etc/claude-code/managed-settings.d',
    '/Library/Application Support/ClaudeCode/managed-settings.d',
    ...(process.platform === 'win32' ? ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'] : []),
    `${configDir}/remote-settings.json`,
    '/Library/Managed Preferences/com.anthropic.claudecode.plist',
  ]
  const answers = await Promise.all(paths.map(async p => {
    try { return !!(await read(p)) } catch { return true }
  }))
  return answers.some(Boolean)
}

export async function resolveClaudeLaunchMode(host = '__local__', cwd?: string): Promise<ClaudeLaunchMode> {
  const reader = new DaemonFileReader(host)
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (): Promise<ClaudeLaunchMode> => {
    const view = await readEngineSettings('claude', host, {
      read: (p, max) => reader.readFileBytes(p, max),
      writeAtomic: async () => { throw new Error('Launch mode is read-only') },
      ...(host === '__local__' ? { env: process.env } : {}),
    }, { cwd })
    const saved = selectClaudeLaunchMode(view)
    if (saved.source === 'settings' || view.groups.flatMap(g => g.items).some(i => i.key === 'permissions.defaultMode' && i.invalid)) return saved
    const policyDirs = await Promise.all(['/etc/claude-code/managed-settings.d', '/Library/Application Support/ClaudeCode/managed-settings.d'].map(p => reader.stat(p).catch(() => ({ size: 0 }))))
    if (policyDirs.some(Boolean)) return { mode: 'default', source: 'engine' }
    if (await managedModePresent(p => reader.readFileBytes(p, 1024 * 1024), host === '__local__' ? process.env.CLAUDE_CONFIG_DIR || '~/.claude' : '~/.claude')) return { mode: 'default', source: 'engine' }
    const version = host === '__local__'
      ? (await (await import('../core/hosts/local-readiness.js')).refreshLocalClaude({ maxAgeMs: 60_000 }))?.claude.version
      : (await import('../core/hosts/host-readiness.js')).getHostReadiness(host)?.claude.version
    // An engine version not known yet (a host whose readiness has not come in since this
    // server started) gives the safe default, not the host's answer.
    return version ? selectClaudeLaunchMode(view, version) : { ...selectClaudeLaunchMode(view, undefined), degraded: true }
  }
  try {
    return await Promise.race([
      read().catch((): ClaudeLaunchMode => ({ mode: 'default', source: 'engine', degraded: true })),
      new Promise<ClaudeLaunchMode>(resolve => { timer = setTimeout(() => resolve({ mode: 'default', source: 'engine', degraded: true }), 4000) }),
    ])
  } finally { clearTimeout(timer) }
}

/** This SDK does not advertise Auto, so only its implicit default falls back. */
export async function resolveSdkClaudeLaunchMode(host: string, cwd?: string): Promise<SessionMode | undefined> {
  const chosen = await resolveClaudeLaunchMode(host, cwd)
  // Missing Auto support changes only our fallback, never an engine setting.
  return chosen.source === 'fallback' ? 'default' : undefined
}
