/**
 * Review round 1, item 14: the CLI collector (no server running) writes
 * nothing. getConfig() would put config.yaml back from its .bak; the doctor
 * must report the missing file instead, and leave the data dir as it found it.
 * The config and version-floor probes here are the real CLI defaults.
 */
import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-doctor-cli-collector'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { collectDiagnostics } from '../../../src/core/diagnostics/doctor.js'
import { ENV, fakeProbes } from './fakes.js'

function cliProbes() {
  // Everything but the config and the floor, which must be the CLI's real read-only ones.
  const { config: _config, claudeFloor: _floor, ...rest } = fakeProbes()
  return rest
}

describe('the CLI collector', () => {
  it('reports a missing config.yaml and never restores it from the backup', async () => {
    fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
    fs.mkdirSync(WALNUT_HOME, { recursive: true })
    fs.writeFileSync(`${CONFIG_FILE}.bak`, 'version: 1\nagent:\n  main_model: claude-opus-5-5\n')
    const before = fs.readdirSync(WALNUT_HOME).sort()
    const r = await collectDiagnostics({ collector: 'cli', probes: cliProbes(), env: ENV })
    expect(r.config).toBeNull()
    expect(r.warnings).toContain('config: no config.yaml (first run, or it is missing); nothing was changed')
    expect(fs.existsSync(CONFIG_FILE)).toBe(false)
    expect(fs.readdirSync(WALNUT_HOME).sort()).toEqual(before)
  })

  it('reads config.yaml as it is when it exists', async () => {
    fs.writeFileSync(CONFIG_FILE, 'version: 1\nprovider:\n  type: bedrock\nagent:\n  main_model: claude-opus-5-5\n')
    const text = fs.readFileSync(CONFIG_FILE, 'utf-8')
    const r = await collectDiagnostics({ collector: 'cli', probes: cliProbes(), env: ENV })
    expect(r.config).toMatchObject({ provider: 'bedrock', mainModel: 'claude-opus-5-5' })
    expect(fs.readFileSync(CONFIG_FILE, 'utf-8')).toBe(text)
  })
})
