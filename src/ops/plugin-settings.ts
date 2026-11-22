import { z } from 'zod'
import { defineOp } from './registry.js'
import { clipText } from './doc-page.js'
import { withOutcome } from './outcome.js'

type Change = { key: string; label: string; from?: unknown; to?: unknown; removed?: boolean }
type Refusal = { key: string; label: string; reason: string }
interface SetBody {
  plugin?: string; name?: string; written?: boolean; page?: string
  changes?: Change[]; unchanged?: string[]; refused?: Refusal[]; needsPerson?: Refusal[]
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const show = (v: unknown): string => (v === undefined ? '(unset)' : JSON.stringify(v))
const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v ? clipText(v, max) : undefined

/** A value an agent reads in the field list; a longer one is told by its size, and `key` reads it. */
const VALUE_MAX = 200
const HELP_MAX = 120
const ENUM_SHOWN = 20
/** plugin_settings' cap: an agent's shell keeps about 10,000 characters. */
const SETTINGS_MAX = 10_000

/** A long value in a line: what it is and how big, never the value. */
function sized(v: unknown): unknown {
  const json = JSON.stringify(v)
  if (json === undefined || json.length <= VALUE_MAX) return v
  const what = Array.isArray(v) ? `a list of ${v.length}` : v && typeof v === 'object' ? `an object of ${Object.keys(v).length} keys` : 'a text'
  return `(${what}, ${json.length} characters: read it with key)`
}

/**
 * One setting as an agent picks from: what it is, whether it is set, and its value when short. A
 * long value, a long allowed list and the schema inside a list or an object are read with `key`.
 */
function fieldLine(value: unknown): Record<string, unknown> {
  const f = rec(value)
  const choices = Array.isArray(f.enum) ? f.enum : null
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.required ? { required: true } : {}),
    ...(f.secret ? { secret: true } : {}),
    ...(f.declared === false ? { declared: false } : {}),
    set: f.set,
    ...('value' in f ? { value: sized(f.value) } : {}),
    ...('default' in f ? { default: sized(f.default) } : {}),
    ...(choices ? { enum: choices.length > ENUM_SHOWN ? [...choices.slice(0, ENUM_SHOWN), `(${choices.length - ENUM_SHOWN} more: read it with key)`] : choices } : {}),
    ...(typeof f.minimum === 'number' ? { minimum: f.minimum } : {}),
    ...(typeof f.maximum === 'number' ? { maximum: f.maximum } : {}),
    ...(clip(f.help, HELP_MAX) ? { help: clip(f.help, HELP_MAX) } : {}),
    ...(f.items !== undefined || f.properties !== undefined ? { schema: 'what is inside: read it with key' } : {}),
  }
}

defineOp({
  name: 'plugin_settings',
  title: 'Read a plugin\'s settings',
  description:
    'Every plugin\'s settings, the same ones its page in Apps shows. Without `plugin`: every running plugin '
    + '(or one waiting for required settings), one line each. With `plugin` (its id or name): each setting with its '
    + 'label, help, type, allowed values, whether it is required or a secret, its value now (secrets masked), and where its '
    + 'page is; a long value or help reads short, and `key` reads one setting whole (the schema of a list or an object too). '
    + 'Read this before plugin_settings_set. Skill `walnut-configure-plugin` has the whole way to configure a plugin.',
  input: {
    plugin: z.string().min(1).max(120).optional().describe('Plugin id or name; omit for the list of plugins'),
    key: z.string().min(1).max(120).optional().describe('With plugin: one setting key, that setting whole'),
  },
  handler: async (args, call) => {
    const plugin = typeof args.plugin === 'string' ? args.plugin : ''
    if (!plugin) return call('GET', '/plugin-settings')
    const view = await call('GET', `/plugin-settings/${encodeURIComponent(plugin)}`)
    const key = typeof args.key === 'string' ? args.key : ''
    const v = rec(view)
    if (!key || !Array.isArray(v.fields)) return view
    const fields = v.fields.filter((f) => rec(f).key === key)
    return fields.length ? { ...v, fields } : {
      ...v,
      fields: [],
      hint: `${String(v.name ?? plugin)} has no setting "${key}". Its keys: ${v.fields.map((f) => String(rec(f).key)).join(', ') || 'none'}.`,
    }
  },
  routes: [{ method: 'GET', path: '/plugin-settings' }, { method: 'GET', path: '/plugin-settings/:plugin' }],
  // A plugin's settings in a line each (2026-11-21: one plugin answered up to 21,000 characters);
  // `key` reads one whole. The list of plugins is short already: its page links are left to one plugin's read.
  answer: {
    kind: 'content',
    max: SETTINGS_MAX,
    shape: ({ result, args }) => {
      const r = rec(result)
      if (Array.isArray(r.plugins)) {
        return { ...r, plugins: r.plugins.map((p) => { const { page: _page, ...rest } = rec(p); return rest }) }
      }
      if (!Array.isArray(r.fields) || typeof args.key === 'string') return result
      // The settings that fit, in the plugin's order; the rest by key, each read with `key`.
      const fields: Record<string, unknown>[] = []
      // Room for the plugin's own fields, the note and the keys left out.
      let used = JSON.stringify({ ...r, fields: [] }).length + 1_200
      for (const f of r.fields) {
        const line = fieldLine(f)
        const n = JSON.stringify(line).length + 1
        if (fields.length && used + n > SETTINGS_MAX) break
        fields.push(line)
        used += n
      }
      const left = r.fields.slice(fields.length).map((f) => String(rec(f).key))
      return {
        ...r,
        fields,
        ...(left.length ? { moreKeys: left, more: `${left.length} more setting(s) by key: plugin_settings ${JSON.stringify({ plugin: args.plugin, key: '<key>' })} reads one whole.` } : {}),
      }
    },
  },
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
