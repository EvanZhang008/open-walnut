/**
 * The template registry and the stored command's shape
 * (src/core/routines/trigger-templates.ts). The command is what the host policy
 * exempts, so its parser must accept exactly what `templateRun` builds.
 */
import { afterEach, describe, it, expect } from 'vitest'
import {
  exemptTemplateRun, listTriggerTemplates, parseTemplateRun, prepareTemplate, registerTriggerTemplate,
  removeTriggerTemplatesForTesting, requireTriggerTemplate, runTemplateCheck, templateOptions, templateRun,
} from '../../../src/core/routines/trigger-templates.js'

afterEach(() => removeTriggerTemplatesForTesting())

function register(extra: Record<string, unknown> = {}) {
  return registerTriggerTemplate('demo', 'Demo', {
    id: 'thing',
    title: 'A thing happens',
    description: 'Fires when a thing happens.',
    params: [{ key: 'name', label: 'Name', required: true }],
    prepare: (params) => ({ params, label: `Thing ${params.name}`, description: 'Watches a thing.', prompt: 'Act on it.' }),
    check: async () => ({ fire: false }),
    ...extra,
  })
}

describe('the stored command', () => {
  it('round-trips params, including quotes and Unicode, as one shell word', () => {
    const params = { name: "it's \"quoted\" $(id) `x`", other: 'caf\u00e9 \u4e2d\u6587' } // Unicode data: e-acute, two CJK characters
    const run = templateRun('demo:thing', params)
    expect(run.split("'").length).toBe(3)
    expect(parseTemplateRun(run)).toEqual({ name: 'demo:thing', params })
  })

  it('rejects anything templateRun would not build', () => {
    for (const run of [
      "walnut trigger-check demo:thing '{}' ; rm -rf /tmp/x",
      "walnut trigger-check demo:thing '{}'&& curl x",
      'walnut trigger-check demo:thing "{}"',
      "walnut trigger-check demo '{}'",
      "walnut trigger-check demo:thing '[1]'",
      "walnut trigger-check demo:thing '{\"n\":1}'",
      "walnut trigger-check Demo:thing '{}'",
      "bash -c 'walnut trigger-check demo:thing {}'",
    ]) {
      expect(parseTemplateRun(run), run).toBeNull()
    }
  })

  it('is exempt only for a registered template on this machine, with no directory', () => {
    const run = templateRun('demo:thing', { name: 'a' })
    expect(exemptTemplateRun({ run, host: '__local__' }, '__local__')).toBeNull()
    const reg = register()
    expect(exemptTemplateRun({ run, host: '__local__' }, '__local__')).toBe(run)
    expect(exemptTemplateRun({ run, host: '' }, '__local__')).toBe(run)
    expect(exemptTemplateRun({ run, host: 'remote-dev' }, '__local__')).toBeNull()
    // The `walnut` it runs is found on PATH; a directory could put another one first.
    expect(exemptTemplateRun({ run, host: '__local__', cwd: '/tmp/elsewhere' }, '__local__')).toBeNull()
    reg.dispose()
    expect(exemptTemplateRun({ run, host: '__local__' }, '__local__')).toBeNull()
  })

  it('stores the command rebuilt from cleaned params, and refuses one missing a required param', () => {
    register()
    const raw = "walnut trigger-check demo:thing '{\"name\":\"  a \",\"sneaky\":\"x\"}'"
    expect(exemptTemplateRun({ run: raw }, '__local__')).toBe(templateRun('demo:thing', { name: 'a' }))
    expect(exemptTemplateRun({ run: "walnut trigger-check demo:thing '{}'" }, '__local__')).toBeNull()
  })

  it('a session on another host may use a template only when it says remote', async () => {
    const run = templateRun('demo:thing', { name: 'a' })
    const reg = register()
    expect(exemptTemplateRun({ run }, 'host:remote-dev')).toBeNull()
    expect(exemptTemplateRun({ run }, 'remote-http')).toBe(run)
    await expect(runTemplateCheck('demo:thing', { name: 'a' }, {}, 'host:remote-dev')).rejects.toMatchObject({ status: 403 })
    reg.dispose()
    register({ remote: true })
    expect(exemptTemplateRun({ run }, 'host:remote-dev')).toBe(run)
    await expect(runTemplateCheck('demo:thing', { name: 'a' }, {}, 'host:remote-dev')).resolves.toEqual({ fire: false })
  })
})

describe('the registry', () => {
  it('names a template after its plugin and drops it with the registration', () => {
    const reg = register()
    expect(listTriggerTemplates()).toEqual([expect.objectContaining({ id: 'demo:thing', pluginName: 'Demo', every: '5m' })])
    expect(() => register()).toThrow(/already registered/)
    reg.dispose()
    expect(listTriggerTemplates()).toEqual([])
  })

  it('refuses a template it could not run', () => {
    expect(() => registerTriggerTemplate('demo', 'Demo', { id: 'Bad Id' } as never)).toThrow(/Invalid trigger template id/)
    expect(() => register({ check: undefined })).toThrow(/requires prepare\(\) and check\(\)/)
    expect(() => register({ params: [{ key: 'bad key', label: 'x' }] })).toThrow(/invalid param key/)
  })

  it('prepare keeps declared params only, requires the required ones, and turns a throw into a 400', async () => {
    register({ prepare: (params: Record<string, string>) => {
      if (params.name === 'nope') throw new Error('No such name')
      return { params, label: '', description: '', prompt: '' }
    } })
    const record = requireTriggerTemplate('demo:thing')
    const ok = await prepareTemplate(record, { name: '  a  ', extra: 'dropped' })
    expect(ok.params).toEqual({ name: 'a' })
    expect(ok.label).toBe('A thing happens')
    expect(ok.prompt).toMatch(/Read each new item/)
    await expect(prepareTemplate(record, {})).rejects.toMatchObject({ status: 400, message: 'Name is required' })
    await expect(prepareTemplate(record, { name: 'nope' })).rejects.toMatchObject({ status: 400, message: 'No such name' })
  })

  it('a check without a boolean fire, or one that throws, is a plugin error', async () => {
    register({ check: async () => ({ items: [] }) })
    await expect(runTemplateCheck('demo:thing', { name: 'a' }, {})).rejects.toMatchObject({ status: 502 })
    removeTriggerTemplatesForTesting()
    register({ check: async () => { throw new Error('boom') } })
    await expect(runTemplateCheck('demo:thing', { name: 'a' }, {})).rejects.toMatchObject({ status: 502, message: /boom/ })
    await expect(runTemplateCheck('demo:missing', {}, {})).rejects.toMatchObject({ status: 404 })
  })

  it('a check gets the declared params only, and none of them missing', async () => {
    const seen: unknown[] = []
    register({ check: async (params: Record<string, string>) => { seen.push(params); return { fire: false } } })
    await runTemplateCheck('demo:thing', { name: 'a', extra: 'dropped' }, {})
    expect(seen).toEqual([{ name: 'a' }])
    await expect(runTemplateCheck('demo:thing', {}, {})).rejects.toMatchObject({ status: 400, message: 'Name is required' })
  })

  it('an options lookup that throws is a plugin error', async () => {
    register({
      params: [{ key: 'name', label: 'Name', required: true, options: true }],
      options: () => { throw new Error('no list') },
    })
    await expect(templateOptions('demo:thing', 'name', '')).rejects.toMatchObject({ status: 502, message: /no list/ })
  })
})
