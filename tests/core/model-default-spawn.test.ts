/**
 * Walnut's "Default" model is the user's own default (settings.json `model`),
 * never the CLI's `default` alias.
 *
 * Why: `claude --model default` and `set_model default` skip settings.model and
 * run the model Claude Code itself recommends. On 2026-11-02 that recommendation
 * moved from Opus 5.5 to Sonnet 5.5 (the Sonnet alias was pinned in settings
 * env), and every session a user had once put on "Default (Opus 5.5)" ran Sonnet
 * from its next spawn on, on the Mac and on a remote host, while settings.json
 * still named Opus. Measured on CLI 2.1.284: no --model = Opus 5.5 [1m];
 * --model default = Sonnet 5.5 [1m]; get_settings effective.model = Opus.
 *
 * The ratchet at the bottom lists every source file that puts `--model` on a
 * claude argv; a new one fails until it is shown to keep `default` off it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isCliDefaultModel, spawnModelArg, withConfiguredDefaultRow,
  type SessionModelCatalogEntry,
} from '../../src/core/types.js'
import { createHostResume } from '../../src/providers/host-resume-core.js'
import { MODE_CLI } from '../../src/providers/daemon-core.js'
import { ClaudeCodeSession, configuredModelFromSettings } from '../../src/providers/claude-code-session.js'

const OPUS = 'global.anthropic.claude-opus-5-5[1m]'

// The CLI 2.1.284 catalog on a Bedrock host whose settings pin the Sonnet alias (trimmed).
const CATALOG: SessionModelCatalogEntry[] = [
  {
    value: 'default', resolvedModel: 'global.anthropic.claude-sonnet-5-5[1m]', displayName: 'Default',
    description: 'Use the default model (currently Sonnet 5.5)', supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: OPUS, resolvedModel: 'global.anthropic.claude-opus-5-5', displayName: 'Opus',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', resolvedModel: 'global.anthropic.claude-haiku-5-5', displayName: 'Haiku 5.5' },
]

describe('spawnModelArg: the CLI default alias is Auto', () => {
  it.each(['default', 'Default', ' default ', '', undefined, null])('%j spawns with no --model', (m) => {
    expect(spawnModelArg(m)).toBeUndefined()
  })
  it('keeps a real choice and maps a legacy picker alias', () => {
    expect(spawnModelArg(OPUS)).toBe(OPUS)
    expect(spawnModelArg('sonnet-1m')).toBe('sonnet[1m]')
    expect(spawnModelArg('haiku')).toBe('haiku')
  })
  it('isCliDefaultModel names only the alias', () => {
    expect(isCliDefaultModel('DEFAULT')).toBe(true)
    expect(isCliDefaultModel('default-model')).toBe(false)
    expect(isCliDefaultModel(OPUS)).toBe(false)
  })
})

describe('withConfiguredDefaultRow: the Default row says what Walnut runs', () => {
  it('points the row at the settings model, with that model\'s effort levels', () => {
    const rows = withConfiguredDefaultRow(CATALOG, OPUS)
    expect(rows[0]).toMatchObject({
      value: 'default', resolvedModel: 'global.anthropic.claude-opus-5-5',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(rows[0]!.description).not.toMatch(/Sonnet/)
    expect(rows.slice(1)).toEqual(CATALOG.slice(1))
  })
  it('a settings model with no row of its own still names it, with its own effort levels', () => {
    const row = withConfiguredDefaultRow(CATALOG, 'opus')[0]!
    expect(row.resolvedModel).toBe('opus')
    expect(row.supportedEffortLevels).toContain('max')
  })
  it('settings naming no model leave the CLI row as it is', () => {
    expect(withConfiguredDefaultRow(CATALOG, null)).toBe(CATALOG)
    expect(withConfiguredDefaultRow(CATALOG, 'default')).toBe(CATALOG)
  })
})

describe('configuredModelFromSettings: what a spawn with no --model runs', () => {
  // get_settings on CLI 2.1.284 after a live switch to Haiku (trimmed).
  const afterHaiku = {
    effective: { model: 'haiku', env: {} },
    sources: [
      { source: 'userSettings', settings: { model: OPUS } },
      { source: 'flagSettings', settings: { model: 'haiku' } },
    ],
  }
  it('skips the flag layer a live switch writes', () => {
    expect(configuredModelFromSettings(afterHaiku)).toBe(OPUS)
  })
  it('a later layer wins, ANTHROPIC_MODEL wins over all', () => {
    const project = { ...afterHaiku, sources: [...afterHaiku.sources.slice(0, 1), { source: 'projectSettings', settings: { model: 'opus' } }] }
    expect(configuredModelFromSettings(project)).toBe('opus')
    expect(configuredModelFromSettings({ ...afterHaiku, effective: { env: { ANTHROPIC_MODEL: 'sonnet' } } })).toBe('sonnet')
  })
  it('no settings model, or the CLI default named in settings, is none', () => {
    expect(configuredModelFromSettings({ effective: {}, sources: [{ source: 'userSettings', settings: {} }] })).toBeNull()
    expect(configuredModelFromSettings({ effective: {}, sources: [{ source: 'userSettings', settings: { model: 'default' } }] })).toBeNull()
  })
  it('an older CLI without layers reads the merge', () => {
    expect(configuredModelFromSettings({ effective: { model: OPUS } })).toBe(OPUS)
  })
})

describe('host resume drops --model default from an older spawn argv', () => {
  const hr = createHostResume({
    fs, path, dir: '/nonexistent-walnut-test', now: () => 0, log: () => {}, modeCli: MODE_CLI,
  })
  it('removes the alias pair, keeps a real model', () => {
    const sid = 'aaaaaaaa-1111-4111-8111-111111111111'
    const out = hr.resumeArgs(['claude', '-p', '--model', 'default', '--effort', 'high', '--session-id', sid], sid)
    expect(out).not.toContain('default')
    expect(out).not.toContain('--model')
    expect(out).toContain('--effort')
    const kept = hr.resumeArgs(['claude', '-p', '--model', OPUS, '--session-id', sid], sid)
    expect(kept[kept.indexOf('--model') + 1]).toBe(OPUS)
  })
})

describe('ClaudeCodeSession.applyModel(default) sets the settings model live', () => {
  function stub() {
    const session = new ClaudeCodeSession('task-default-model', 'proj', 'claude')
    const writes: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    s._transport = { writeRaw: (json: string) => { writes.push(json); return Promise.resolve(true) } }
    s._active = true
    return { session, s, writes }
  }
  const flagWrite = (writes: string[]) =>
    writes.map((w) => JSON.parse(w)).find((e) => e.request?.subtype === 'apply_flag_settings')

  it('sends the settings model, keeps default as the stored choice', async () => {
    const { session, s, writes } = stub()
    s._configuredModel = OPUS
    session.applyModel('default').catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    expect(flagWrite(writes)?.request.settings.model).toBe(OPUS)
    expect(s._cliModel).toBe('default')
  })
  it('with no settings model the CLI default is the user default', async () => {
    const { session, s, writes } = stub()
    s._configuredModel = null
    session.applyModel('default').catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    expect(flagWrite(writes)?.request.settings.model).toBe('default')
  })
})

// ── Ratchet: every `--model` a claude argv gets ─────────────────────────────
// Each file that writes '--model' into an argv, and how `default` stays off it.
const MODEL_FLAG_SITES: Record<string, string> = {
  'src/providers/claude-code-session.ts': 'spawnModelArg(model)',
  'src/providers/host-resume-core.ts': "=== 'default') { args.splice(i, 2)",
  'src/providers/host-start-core.ts': "raw === 'default') return null",
  // bridgeResume without a resume record: the model hint comes from direct-host-send.
  'src/providers/daemon-source.ts': 'hostResume.resumeArgs(spawn.args',
  'src/providers/daemon-standalone.ts': 'hostResume.resumeArgs(spawn.args',
  // Utility children (search lane, inline subagents, model adapter): a model id
  // from Walnut's own config or a caller, never a session's picker choice.
  'src/providers/inline-subagent.ts': '',
  'src/providers/micro-claude-warm.ts': '',
  'src/model/providers/adapter-claude-cli.ts': '',
  // Not an argv writer: the list of flags a supervised cron spawn may carry.
  'src/providers/daemon-cron-supervision.ts': '',
  // Not an argv writer: reads a live process's flags for a fork's prefix.
  'src/core/sessions/spawn-prefix.ts': '',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('ratchet: every --model site keeps the CLI default alias off the argv', () => {
  const root = path.resolve(__dirname, '../..')
  const found = walk(path.join(root, 'src'))
    .filter((f) => fs.readFileSync(f, 'utf8').includes("'--model'"))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))

  it('lists every file that writes --model', () => {
    const unlisted = found.filter((f) => !(f in MODEL_FLAG_SITES))
    expect(unlisted, 'a new --model site: route its value through spawnModelArg and list it here').toEqual([])
  })
  it('each listed guard is still in its file', () => {
    for (const [file, guard] of Object.entries(MODEL_FLAG_SITES)) {
      if (!guard) continue
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toContain(guard)
    }
    expect(fs.readFileSync(path.join(root, 'src/core/sessions/direct-host-send.ts'), 'utf8'))
      .toContain('model: spawnModelArg(input.model)')
  })
})
