/**
 * An engine switch or move whose new session a setting refuses is answered as that setting
 * (422 engine_config, its own words), whether the switch's check found it first (settingPreflight)
 * or the start refused it after all (settingRefusal, task-start.ts puts the setting's error on the
 * cause); any other failure is not read as one. The end-to-end path is
 * tests/e2e/engine-switch-codex-host-provider-e2e.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { settingPreflight, settingRefusal } from '../../../src/core/sessions/engine-switch-setting.js'
import { CodexEngineConfigError } from '../../../src/providers/codex-engine-config.js'
import { QuickStartError } from '../../../src/core/sessions/quick-start.js'

class Answer extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message) }
}
const make = (message: string, status: number, code: string) => new Answer(message, status, code)

const setting = new CodexEngineConfigError('provider "local-proxy" is at http://127.0.0.1:8402/v1, so it reaches nothing on host "devbox". See "A provider per host" in docs/reference/codex-engine.md.')
/** What task-start.ts throws for it: its own sentence, the setting's error as the cause. */
const started = Object.assign(new QuickStartError(`Task t1 could not start: ${setting.message}. A setting stops it, so a retry fails the same way until that setting is changed; then retry task_start with the same id.`, 422, { code: 'engine_config' }), { cause: setting })

describe('settingRefusal', () => {
  it('a switch: the setting\'s words, 422 engine_config, and what the task does now', () => {
    const r = settingRefusal(started, { engine: 'codex', host: 'devbox' }, { engine: 'claude', move: false }, make)!
    expect(r.words.message).toBe('engines.codex: provider "local-proxy" is at http://127.0.0.1:8402/v1, so it reaches nothing on host "devbox". See "A provider per host" in docs/reference/codex-engine.md')
    expect(r.as).toMatchObject({ status: 422, code: 'engine_config' })
    expect(r.as.message).toMatch(/^The switch to Codex did not start: engines\.codex: provider "local-proxy"/)
    expect(r.as.message).toMatch(/codex-engine\.md\. The task stays on Claude; pick Codex again once that setting is changed\.$/)
    expect(r.as.message).not.toContain('task_start')
  })

  it('a move says where the task stays', () => {
    const r = settingRefusal(setting, { engine: 'codex', host: 'devbox' }, { engine: 'claude', move: true }, make)!
    expect(r.as.message).toMatch(/^The move to devbox did not happen: engines\.codex: /)
    expect(r.as.message).toContain('The task stays where it was')
  })

  it('a move refused after its work was copied says where that work is kept', () => {
    const stays = 'The task stays on this Mac; the copied work is kept at /work/t1.'
    const r = settingRefusal(setting, { engine: 'codex', host: 'devbox' }, { engine: 'claude', move: true, stays }, make)!
    expect(r.as.message).toMatch(/did not happen: engines\.codex: .*\. The task stays on this Mac; the copied work is kept at \/work\/t1\. Move it again once that setting is changed\.$/)
  })

  it('a start answered engine_config with no cause still reads as the setting', () => {
    const bare = new QuickStartError('Task t1 could not start: engines.codex: provider.base_url is required.', 422, { code: 'engine_config' })
    expect(settingRefusal(bare, { engine: 'codex', host: '__local__' }, { engine: 'claude', move: false }, make)?.as).toMatchObject({ status: 422, code: 'engine_config' })
  })

  it('no setting: a transient refusal (no copy of the leader\'s settings yet), any other start failure', () => {
    const to = { engine: 'codex' as const, host: 'devbox' }
    const from = { engine: 'claude' as const, move: false }
    expect(settingRefusal(new CodexEngineConfigError('this server holds no copy yet', { transient: true }), to, from, make)).toBeNull()
    expect(settingRefusal(Object.assign(new QuickStartError('could not start: the worker exited', 502), { cause: new Error('exit 1') }), to, from, make)).toBeNull()
    expect(settingRefusal(new Error('boom'), to, from, make)).toBeNull()
  })
})

describe('settingPreflight', () => {
  it('asks nothing for an engine that has no setting to refuse it', async () => {
    expect(await settingPreflight({ engine: 'claude', host: 'devbox' }, { engine: 'codex', move: false }, make)).toBeNull()
  })
})
