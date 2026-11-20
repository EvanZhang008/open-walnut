/**
 * The model picker's engine rail (ModelPicker.tsx ProviderRail) and its Settings group
 * (PickerEnginesGroup): the rail shows Claude Code, Codex, OpenCode and Pi unless
 * `session.picker_engines` names others, the engine a session runs on always shows, and the
 * Settings saves keep every sibling key of `session` and `engines`.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_PICKER_ENGINES, SESSION_ENGINE_IDS, type Config, type SessionEngine } from '../../src/core/types'
import { pickerRailEngines, shownInPicker, type EngineCatalog, type EngineCatalogEntry } from '../../web/src/utils/engines'
import { argvText, commandArgv, customAdapterSave, pickerChecked, pickerEnginesSave } from '../../web/src/components/settings/sections/picker-engines-select'

function entry(id: SessionEngine, inPicker?: boolean): EngineCatalogEntry {
  return {
    id, displayName: id, runtimeKind: id === 'claude' ? 'native' : 'acp', isDefault: id === 'claude', localOnly: id === 'custom',
    ...(inPicker === undefined ? {} : { inPicker }),
    capabilities: { rewind: false, fork: false, modelCatalog: 'provider-advertised', modeControl: 'config-options', idProvisioning: 'provider-issued', settings: false },
    availability: { installed: true, version: null, reason: null },
  }
}
const ids = (rows: EngineCatalog) => rows.map((e) => e.id)

describe('the engines the picker shows', () => {
  it('defaults to Claude Code, Codex, OpenCode and Pi, also in an older server\'s catalog', () => {
    expect([...DEFAULT_PICKER_ENGINES]).toEqual(['claude', 'codex', 'opencode', 'pi'])
    // No inPicker (an older server): the client falls back to the same four.
    const old = SESSION_ENGINE_IDS.map((id) => entry(id))
    expect(ids(old.filter(shownInPicker))).toEqual(['claude', 'codex', 'opencode', 'pi'])
  })

  it('follows the server\'s inPicker, and always keeps the engine in use', () => {
    const catalog = SESSION_ENGINE_IDS.map((id) => entry(id, id === 'claude' || id === 'goose'))
    expect(ids(pickerRailEngines(catalog, 'claude'))).toEqual(['claude', 'goose'])
    // A session on Gemini, turned off in Settings: its picker still shows Gemini, in catalog order.
    expect(ids(pickerRailEngines(catalog, 'gemini'))).toEqual(['claude', 'gemini', 'goose'])
  })
})

describe('Settings saves', () => {
  const catalog = SESSION_ENGINE_IDS.map((id) => entry(id))

  it('checks the saved list, else the defaults', () => {
    expect(pickerChecked({}, catalog)).toEqual(['claude', 'codex', 'opencode', 'pi'])
    expect(pickerChecked({ session: { picker_engines: ['pi', 'dsh'] } } as Config, catalog)).toEqual(['pi', 'dsh'])
    expect(pickerChecked({ session: { picker_engines: [] } } as Config, catalog)).toEqual([])
  })

  it('writes the list in registry order and keeps every other session setting', () => {
    const config = { session: { cron_policy: 'session-only', tag_requests: true } } as unknown as Config
    expect(pickerEnginesSave(config, ['pi', 'claude', 'gemini', 'pi'], catalog)).toEqual({
      session: { cron_policy: 'session-only', tag_requests: true, picker_engines: ['claude', 'gemini', 'pi'] },
    })
  })

  it('reads a command line as argv, quotes kept whole, and back', () => {
    expect(commandArgv('  npx -y my-acp  --stdio ')).toEqual(['npx', '-y', 'my-acp', '--stdio'])
    expect(commandArgv('"/Applications/My Agent/agent" acp \'--name=a b\'')).toEqual(['/Applications/My Agent/agent', 'acp', '--name=a b'])
    expect(argvText(['/Applications/My Agent/agent', 'acp'])).toBe('"/Applications/My Agent/agent" acp')
    expect(argvText(undefined)).toBe('')
  })

  it('saves the custom engine\'s command beside every other engine, and an empty line removes it', () => {
    const config = { engines: { codex: { model: 'gpt' }, custom: { env: { A: '1' }, adapter_cmd: ['old'] } } } as unknown as Config
    expect(customAdapterSave(config, 'npx -y my-acp')).toEqual({
      engines: { codex: { model: 'gpt' }, custom: { env: { A: '1' }, adapter_cmd: ['npx', '-y', 'my-acp'] } },
    })
    expect(customAdapterSave(config, '   ')).toEqual({ engines: { codex: { model: 'gpt' }, custom: { env: { A: '1' } } } })
  })
})
