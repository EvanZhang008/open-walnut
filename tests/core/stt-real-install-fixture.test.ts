/**
 * The real Whisper install spec (stt-install.spec.ts, weekly nightly) runs on the shared fixture
 * server, which is isolated, so voice is off there unless the fixture turns it on. On 2026-11-10
 * the install finished and the setup row never went away, because the engine was never started.
 * This checks the fixture's settings for that run against the real rules: voice on, no Qwen
 * install at boot, and none of the speech ports a person's own server uses.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { voiceOffReason } from '../../src/core/stt/voice-here.js'
import { autoSetupDecision } from '../../src/core/stt/auto-setup.js'
import type { Config } from '../../src/core/types.js'
import { REAL_VOICE_STT, realVoiceInstall } from '../e2e/browser/real-voice-fixture.js'

const ROOT = path.resolve(__dirname, '../..')

describe('the fixture of the real Whisper install', () => {
  const env = { WALNUT_STT_REAL_INSTALL: '1', WALNUT_STT_AUTO_SETUP: '1' }

  it('runs voice on an isolated server only for that run', () => {
    expect(realVoiceInstall(env)).toBe(true)
    expect(realVoiceInstall({})).toBe(false)
    expect(voiceOffReason('fake-home', env)).toBeNull()
    // Every other spec's server keeps voice off.
    expect(voiceOffReason('fake-home', {})).toMatch(/Voice is off on this isolated server/)
  })

  it('installs no Qwen at boot beside the Whisper it tests', () => {
    const d = autoSetupDecision({ config: { stt: REAL_VOICE_STT } as unknown as Config, env, isolated: true, plan: { runtime: 'mlx', model: 'm' } })
    expect(d).toEqual({ run: false, reason: 'engine whisper-server chosen' })
  })

  it("keeps off the speech ports a person's own server uses", () => {
    const types = fs.readFileSync(path.join(ROOT, 'src/core/types.ts'), 'utf8')
    for (const key of ['whisper_server_port', 'mlx_port', 'cleanup_port']) expect(types, key).toContain(`${key}?: number`)
    const dir = path.join(ROOT, 'src/core/stt')
    const defaults = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).flatMap((f) =>
      [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\bDEFAULT_[A-Z_]*PORT\s*=\s*(\d+)/g)].map((m) => Number(m[1])))
    expect(defaults.length).toBeGreaterThanOrEqual(2)
    for (const port of [REAL_VOICE_STT.whisper_server_port, REAL_VOICE_STT.mlx_port, REAL_VOICE_STT.cleanup_port]) expect(defaults).not.toContain(port)
  })

  it('test-server.ts applies it: voice on and the Whisper config, only under the flag', () => {
    const server = fs.readFileSync(path.join(ROOT, 'tests/e2e/browser/test-server.ts'), 'utf8')
    expect(server).toContain("if (REAL_VOICE_INSTALL) process.env.WALNUT_STT_AUTO_SETUP = '1'")
    expect(server).toContain('...(REAL_VOICE_INSTALL ? { stt: REAL_VOICE_STT } : {}),')
    // Set before the server modules load.
    expect(server.indexOf("process.env.WALNUT_STT_AUTO_SETUP = '1'")).toBeLessThan(server.indexOf("await import('../../../src/"))
  })
})
