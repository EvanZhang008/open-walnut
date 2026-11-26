/**
 * A service's PATH taken from a shell never carries an entry its config check refuses.
 *
 * 2026-11-26: the session that ran a land had an empty entry in its PATH (`...::...`). The deploy
 * passed that PATH as is to `walnut __service-launcher-script`, whose config check refuses an empty
 * entry, so the Mac's production deploy stopped before the switch and every later land waited
 * behind it. Every PATH a service config gets from an environment goes through absoluteSearchPath
 * (or servicePath, which uses it); the source scan below fails on a new raw `path: env.PATH`.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { absoluteSearchPath, servicePath } from '../../src/providers/daemon-service-config.js'
import { serveLauncherScript } from '../../src/providers/serve-launcher-script-cli.js'

const SRC = path.join(__dirname, '../../src')

// Data handed to the renderer, never to a child process.
const DEPLOY_SHELL_PATH = '/usr/bin::/bin:'
const NOTHING_ABSOLUTE = '::'
const exportedPath = (script: string) => script.match(/export PATH\x3d'([^']*)'/)?.[1]

/** Raw environment PATHs that never reach a service config's check, and why. */
const RAW_ALLOWED = new Map<string, string>([
  ['providers/local-daemon-replace.ts', 'the PATH of a trial spawn (proveDaemonBoot), never checked or written into a service'],
])

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(full))
    else if (e.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('a service PATH from the environment', () => {
  it('keeps only the absolute entries, in order, each once', () => {
    expect(absoluteSearchPath('/usr/bin::/bin:relative/bin:/usr/bin: /opt/x:')).toBe('/usr/bin:/bin')
    expect(absoluteSearchPath(':')).toBe('')
    expect(absoluteSearchPath(undefined)).toBe('')
    expect(servicePath('/a::/b', '/h')).toBe('/a:/b:/h/.local/bin:/h/bin:/h/.bun/bin:/usr/local/bin:/usr/bin:/bin')
  })

  it('the deploy launcher renders from a PATH with empty entries', () => {
    const text = serveLauncherScript(
      ['--state', '/tmp/wl-state', '--seed', '/tmp/wl-state/v1/run', '--self', '/tmp/wl-state/walnut-launcher.sh'],
      { HOME: '/tmp/wl-home', PATH: DEPLOY_SHELL_PATH },
    )
    expect(exportedPath(text)).toBe('/usr/bin:/bin')
  })

  it('falls back to the system dirs when nothing absolute is left', () => {
    const text = serveLauncherScript(
      ['--state', '/tmp/wl-state', '--seed', '/tmp/wl-state/v1/run', '--self', '/tmp/wl-state/walnut-launcher.sh'],
      { HOME: '/tmp/wl-home', PATH: NOTHING_ABSOLUTE },
    )
    expect(exportedPath(text)).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('no source passes a raw environment PATH as a config path', () => {
    const raw: string[] = []
    for (const file of tsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      const text = fs.readFileSync(file, 'utf8')
      if (/\bpath:\s*(?:process\.)?env\.PATH\b/.test(text) && !RAW_ALLOWED.has(rel)) raw.push(rel)
    }
    expect(raw, 'Pass the PATH through absoluteSearchPath or servicePath (daemon-service-config.ts)').toEqual([])
  })

  it('lists no allowed file that no longer has one', () => {
    for (const rel of RAW_ALLOWED.keys()) {
      expect(fs.readFileSync(path.join(SRC, rel), 'utf8')).toMatch(/\bpath:\s*(?:process\.)?env\.PATH\b/)
    }
  })
})
