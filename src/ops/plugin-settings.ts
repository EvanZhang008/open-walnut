import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'

type Change = { key: string; label: string; from?: unknown; to?: unknown; removed?: boolean }
type Refusal = { key: string; label: string; reason: string }
interface SetBody {
  plugin?: string; name?: string; written?: boolean; page?: string
  changes?: Change[]; unchanged?: string[]; refused?: Refusal[]; needsPerson?: Refusal[]
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const show = (v: unknown): string => (v === undefined ? '(unset)' : JSON.stringify(v))

defineOp({
  name: 'plugin_settings',
  title: 'Read a plugin\'s settings',
  description:
    'Every plugin\'s settings, the same ones its page in Apps shows. Without `plugin`: every running plugin '
    + '(or one waiting for required settings), one line each. With `plugin` (its id or name): each setting with its '
    + 'label, help, type, allowed values, whether it is required or a secret, its value now (secrets masked), and where its '
    + 'page is. Read this before plugin_settings_set. Skill `walnut-configure-plugin` has the whole way to configure a plugin.',
  input: {
    plugin: z.string().min(1).max(120).optional().describe('Plugin id or name; omit for the list of plugins'),
  },
  handler: async (args, call) => {
    const plugin = typeof args.plugin === 'string' ? args.plugin : ''
    return plugin ? call('GET', `/plugin-settings/${encodeURIComponent(plugin)}`) : call('GET', '/plugin-settings')
  },
  routes: [{ method: 'GET', path: '/plugin-settings' }, { method: 'GET', path: '/plugin-settings/:plugin' }],
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'plugin_settings_set',
  title: 'Change a plugin\'s settings',
  description:
    'Change one plugin\'s settings, as a Save on its page does: `set` maps setting keys to new values (the whole value: a '
    + 'list or an object is replaced, so read it first and send it back edited), `unset` removes keys so the plugin\'s '
    + 'default applies. Each value is checked against what the plugin declares; all or nothing, one refused key writes '
    + 'nothing. Before calling, tell the person in one sentence what you will change; after, tell them each setting that '
    + 'changed (from `changes`). Never set or remove a secret (API key, token, password): those come back in '
    + '`needsPerson`, and the person types them on the plugin\'s page. The page shows the change at once.',
  input: {
    plugin: z.string().min(1).max(120).describe('Plugin id or name'),
    set: z.record(z.string().max(120), z.unknown()).optional().describe('Setting key to its new value'),
    unset: z.array(z.string().max(120)).max(100).optional().describe('Setting keys to remove (their default applies)'),
  },
  bind: { method: 'PATCH', path: '/plugin-settings/:plugin' },
  mapResult: ({ body }) => {
    const b = rec(body) as SetBody
    const changes = b.changes ?? []
    const refused = b.refused ?? []
    const needs = b.needsPerson ?? []
    if (refused.length || needs.length) {
      const lines = [...refused, ...needs].map((r) => `${r.label}: ${r.reason}`)
      return withOutcome({ ...rec(body) }, `Nothing was written. ${lines.join(' ')}`,
        needs.length
          ? `Ask the person to type ${needs.map((n) => n.label).join(', ')} on the plugin's page (${b.page ?? 'Apps'}); send the rest again without it.`
          : 'Fix the refused values (plugin_settings shows what each takes) and call again.')
    }
    if (changes.length === 0 || !b.written) {
      return withOutcome({ ...rec(body) }, 'Nothing changed: every value was already set that way.', 'Nothing else is required.')
    }
    const what = changes.map((c) => (c.removed ? `${c.label} removed (was ${show(c.from)})` : `${c.label}: ${show(c.from)} -> ${show(c.to)}`))
    return withOutcome({ ...rec(body) }, `${b.name ?? b.plugin} settings changed. ${what.join('; ')}.`,
      'Tell the person each setting that changed, in their words.')
  },
  resultError: (result) => {
    const b = rec(result) as SetBody
    const n = (b.refused?.length ?? 0) + (b.needsPerson?.length ?? 0)
    return n > 0 ? `plugin_settings_set: nothing written, ${n} setting(s) refused` : undefined
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})
