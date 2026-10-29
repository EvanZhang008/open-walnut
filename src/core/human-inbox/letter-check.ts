/**
 * The rules of a new letter, shared by the two places that take one: the letter
 * store (store.ts sendLetter, behind the route, the cloud relay and the drain) and
 * the daemon's offline host, which saves a session's letter while the Walnut server
 * is away (providers/offline-host-core.ts). One set of rules: a letter refused
 * online is refused on the host with the same words, and one the host saved is one
 * the store takes when the Mac drains it.
 *
 * Pure, no state. daemon-standalone.ts imports createLetterCheck; daemon-source.ts
 * inlines `createLetterCheck.toString()` through `__CREATE_LETTER_CHECK__`, so the
 * body references nothing at module scope. Its caps are types.ts's and its op inputs
 * are human_inbox_send's (tests/core/human-inbox-letter-check.test.ts pins both).
 */

export interface LetterShape {
  /** The subject, trimmed. */
  subject: string
  /** The one body lane the letter uses. */
  lane: 'html' | 'html_ref' | 'markdown'
  format: 'html' | 'markdown'
}

export function createLetterCheck() {
  const TYPES = ['completion', 'action_required', 'review', 'info']
  /** LETTER_BODY_MAX_BYTES: markdown, text and every other text field. */
  const BODY_MAX_BYTES = 200 * 1024
  /** LETTER_HTML_MAX_BYTES: the one body that carries inline media. */
  const HTML_MAX_BYTES = 100 * 1024 * 1024
  const MAX_ACTIONS = 12
  const ACTION_ID_MAX_CHARS = 64
  const ACTION_LABEL_MAX_CHARS = 200
  const ACTION_DESCRIPTION_MAX_CHARS = 500
  const MAX_TASK_REFS = 50
  const TASK_REF_MAX_CHARS = 200
  /** human_inbox_send's inputs (src/ops/human-inbox.ts): the op refuses any other key. */
  const OP_INPUTS = ['subject', 'type', 'markdown', 'html', 'text', 'actions', 'items', 'task_refs', 'pin', 'user_asked']

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const filled = (v: unknown): boolean => typeof v === 'string' && v.length > 0
  const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  const INTENTS = ['mark_read', 'find_task', 'create_task', 'attach_task']
  // z.string().datetime({ offset: true }), including leap years and optional seconds.
  const date = '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))'
  const ITEM_TIMESTAMP = new RegExp(`^${date}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`)

  function objectError(value: unknown, path: string, keys: string[]): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path}: must be an object`
    for (const key of Object.keys(value)) if (keys.indexOf(key) === -1) return `${path}.${key}: unrecognized key`
    return null
  }

  function textError(value: unknown, path: string, max: number, nonempty = false): string | null {
    if (typeof value !== 'string') return `${path}: must be a string`
    if (value.length > max) return `${path}: must be at most ${max} chars`
    if (nonempty && !value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()) return `${path}: must not be empty after cleaning`
    return null
  }

  function idError(value: unknown, path: string): string | null {
    return typeof value === 'string' && ITEM_ID.test(value) ? null : `${path}: invalid item or action id`
  }

  function timestampError(value: unknown, path: string): string | null {
    return typeof value === 'string' && ITEM_TIMESTAMP.test(value) ? null : `${path}: must be an ISO datetime with Z or a colon-separated offset`
  }

  /** The new-item schema only. Check bounded lists without changing the host's raw journal args. */
  function itemsError(raw: unknown): string | null {
    if (raw === undefined) return null
    if (!Array.isArray(raw) || raw.length > 100) return 'items: must be an array of at most 100 items'
    for (let i = 0; i < raw.length; i++) {
      const path = `items.${i}`
      let error = objectError(raw[i], path, ['id', 'subject', 'summary', 'source', 'display', 'readObservation', 'actions'])
      if (error) return error
      const item = raw[i] as Record<string, unknown>
      error = idError(item.id, `${path}.id`) || textError(item.subject, `${path}.subject`, 1000, true) || textError(item.summary, `${path}.summary`, 16000)
      if (error) return error
      error = objectError(item.source, `${path}.source`, ['kind', 'account', 'message'])
      if (error) return error
      const source = item.source as Record<string, unknown>
      if (source.kind !== 'mail') return `${path}.source.kind: must be mail`
      for (const [key, max] of [['account', 1024], ['message', 4096]] as const) {
        const value = source[key]
        error = textError(value, `${path}.source.${key}`, max)
        if (error) return error
        if (!filled(value) || /[\u0000-\u001f\u007f]/.test(value as string)) return `${path}.source.${key}: must be non-empty without control characters`
      }
      if (item.display !== undefined) {
        error = objectError(item.display, `${path}.display`, ['sender', 'sentAt', 'accountLabel', 'accountHint'])
        if (error) return error
        const display = item.display as Record<string, unknown>
        if (display.sender !== undefined) {
          error = objectError(display.sender, `${path}.display.sender`, ['name', 'address'])
          if (error) return error
          const sender = display.sender as Record<string, unknown>
          for (const [key, max] of [['name', 300], ['address', 500]] as const) {
            if (sender[key] !== undefined && (error = textError(sender[key], `${path}.display.sender.${key}`, max))) return error
          }
        }
        if (display.sentAt !== undefined && (error = timestampError(display.sentAt, `${path}.display.sentAt`))) return error
        for (const [key, max] of [['accountLabel', 300], ['accountHint', 1000]] as const) {
          if (display[key] !== undefined && (error = textError(display[key], `${path}.display.${key}`, max))) return error
        }
      }
      if (item.readObservation !== undefined) {
        error = objectError(item.readObservation, `${path}.readObservation`, ['read', 'observedAt'])
        if (error) return error
        const observation = item.readObservation as Record<string, unknown>
        if (typeof observation.read !== 'boolean') return `${path}.readObservation.read: must be a boolean`
        if ((error = timestampError(observation.observedAt, `${path}.readObservation.observedAt`))) return error
      }
      if (!Array.isArray(item.actions) || item.actions.length > 8) return `${path}.actions: must be an array of at most 8 actions`
      const intents = new Set<string>()
      for (let j = 0; j < item.actions.length; j++) {
        const actionPath = `${path}.actions.${j}`
        const action = item.actions[j] as Record<string, unknown> | null
        error = objectError(action, actionPath, action?.kind === 'op' ? ['id', 'kind', 'intent'] : ['id', 'kind', 'label', 'question'])
        if (error) return error
        if ((error = idError(action!.id, `${actionPath}.id`))) return error
        if (action!.kind === 'op') {
          if (INTENTS.indexOf(action!.intent as string) === -1) return `${actionPath}.intent: must be one of ${INTENTS.join(' | ')}`
        } else if (action!.kind === 'reply_ai') {
          error = textError(action!.label, `${actionPath}.label`, 200, true) || textError(action!.question, `${actionPath}.question`, 4000, true)
          if (error) return error
        } else return `${actionPath}.kind: must be op or reply_ai`
        const intent = action!.kind === 'op' ? action!.intent as string : `reply_ai:${action!.id}`
        if (intents.has(intent)) return `${actionPath}: duplicate item action intent`
        intents.add(intent)
      }
    }
    return null
  }

  /** Store-level uniqueness spans legacy buttons, every item and every item action. */
  function itemIdsError(raw: unknown, actions: unknown): string | null {
    if (!Array.isArray(raw)) return null
    const used = new Set(Array.isArray(actions) ? actions.map(a => a.id) : [])
    for (const item of raw) {
      for (const id of [item.id, ...item.actions.map((a: Record<string, unknown>) => a.id)]) {
        if (used.has(id)) return `Duplicate item or action id: ${id}`
        used.add(id)
      }
    }
    return null
  }

  /**
   * A new letter as the store takes it: a subject, a known type, exactly one body,
   * and buttons only on the one type that means "I need a decision". Returns its
   * subject and body lane, or the store's refusal.
   */
  function shape(input: Record<string, unknown>): { ok: true; shape: LetterShape } | { ok: false; message: string } {
    const subject = str(input.subject).trim()
    if (!subject) return { ok: false, message: 'subject is required' }
    if (TYPES.indexOf(input.type as string) === -1) return { ok: false, message: `type must be one of ${TYPES.join(', ')}` }
    const hasHtml = filled(input.html)
    const hasHtmlRef = str(input.htmlRef ?? input.html_ref ?? '').length > 0
    const hasMarkdown = filled(input.markdown)
    if ([hasHtml, hasHtmlRef, hasMarkdown].filter(Boolean).length !== 1) {
      return { ok: false, message: 'exactly one of html | html_ref | markdown is required' }
    }
    const actions = input.actions
    // An action_required letter with no buttons is a dead end: the reader shows a
    // decision badge with nothing to decide with (2026-08-30, a real letter).
    if (input.type === 'action_required') {
      if (!Array.isArray(actions) || actions.length === 0) {
        return {
          ok: false,
          message: 'action_required needs at least one action in `actions`: that is what the human taps; '
            + 'use type=review or info if the human only needs to read this',
        }
      }
    } else if (actions !== undefined) {
      return { ok: false, message: 'actions are only allowed when type is action_required' }
    }
    if (actions !== undefined) {
      const list = actions as Array<Record<string, unknown> | null>
      if (list.length > MAX_ACTIONS) {
        return { ok: false, message: `at most ${MAX_ACTIONS} actions: a letter asks ONE question the human can answer with one tap` }
      }
      for (const action of list) {
        if (!action || typeof action !== 'object' || !str(action.id).trim() || !str(action.label).trim()) {
          return { ok: false, message: 'each action needs a non-empty id and label' }
        }
        if (str(action.id).length > ACTION_ID_MAX_CHARS) return { ok: false, message: `action id is over ${ACTION_ID_MAX_CHARS} chars` }
        if (str(action.label).length > ACTION_LABEL_MAX_CHARS) {
          return { ok: false, message: `action label is over ${ACTION_LABEL_MAX_CHARS} chars: a button label, not a paragraph` }
        }
        if (action.description !== undefined && str(action.description).length > ACTION_DESCRIPTION_MAX_CHARS) {
          return { ok: false, message: `action description is over ${ACTION_DESCRIPTION_MAX_CHARS} chars: put the detail in the body` }
        }
      }
      const ids = new Set(list.map((a) => (a as Record<string, unknown>).id))
      if (ids.size !== list.length) return { ok: false, message: 'action ids must be unique' }
    }
    const itemError = itemsError(input.items) || itemIdsError(input.items, actions)
    if (itemError) return { ok: false, message: itemError }
    const lane = hasMarkdown ? 'markdown' as const : hasHtmlRef ? 'html_ref' as const : 'html' as const
    return { ok: true, shape: { subject, lane, format: hasMarkdown ? 'markdown' : 'html' } }
  }

  /** The byte cap of one field: `html` carries inline media, every other text field is 200 KB. */
  function maxBytes(field: string): number {
    return field === 'html' ? HTML_MAX_BYTES : BODY_MAX_BYTES
  }

  /** The first string field over its cap, or null (what the route answers 413 for). */
  function oversize(fields: Record<string, unknown>): { name: string; bytes: number; max: number } | null {
    for (const name of Object.keys(fields)) {
      const value = fields[name]
      if (typeof value !== 'string') continue
      const bytes = Buffer.byteLength(value, 'utf-8')
      const max = maxBytes(name)
      if (bytes > max) return { name, bytes, max }
    }
    return null
  }

  /**
   * The arguments as human_inbox_send takes them (the op's schema, strict): a refusal in
   * the executor's words, or null. For a caller that cannot run the op's own parse (the
   * daemon); the server parses them with the op itself.
   */
  function opArgs(args: Record<string, unknown>): string | null {
    const issues: string[] = []
    const extra = Object.keys(args).filter((k) => OP_INPUTS.indexOf(k) === -1)
    if (extra.length) issues.push(`(root): Unrecognized key(s) in object: ${extra.map((k) => `'${k}'`).join(', ')}`)
    if (!filled(args.subject)) issues.push('subject: a non-empty string is required')
    if (TYPES.indexOf(args.type as string) === -1) issues.push(`type: must be one of ${TYPES.join(' | ')}`)
    for (const k of ['markdown', 'html', 'text']) if (args[k] !== undefined && typeof args[k] !== 'string') issues.push(`${k}: must be a string`)
    if (args.pin !== undefined && typeof args.pin !== 'boolean') issues.push('pin: must be a boolean')
    if (args.user_asked !== undefined && typeof args.user_asked !== 'boolean') issues.push('user_asked: must be a boolean')
    if (args.task_refs !== undefined && (!Array.isArray(args.task_refs) || args.task_refs.some((t) => typeof t !== 'string'))) {
      issues.push('task_refs: must be an array of strings')
    }
    if (args.actions !== undefined) {
      const list = args.actions
      if (!Array.isArray(list) || list.length === 0) issues.push('actions: must be an array of at least one action')
      else {
        list.forEach((a, i) => {
          const o = a as Record<string, unknown> | null
          // Any other key of an action is dropped by the op's parse, not refused (only the root is strict).
          if (!o || typeof o !== 'object' || Array.isArray(o)) { issues.push(`actions.${i}: must be an object`); return }
          if (!filled(o.id)) issues.push(`actions.${i}.id: a non-empty string is required`)
          if (!filled(o.label)) issues.push(`actions.${i}.label: a non-empty string is required`)
          if (o.description !== undefined && typeof o.description !== 'string') issues.push(`actions.${i}.description: must be a string`)
        })
      }
    }
    const itemError = itemsError(args.items)
    if (itemError) issues.push(itemError)
    return issues.length ? `Invalid arguments for human_inbox_send: ${issues.join('; ')}` : null
  }

  /** The task refs a letter keeps: bounded, never refused (pills under the body are a courtesy). */
  function taskRefs(given: unknown): string[] {
    if (!Array.isArray(given)) return []
    return given.filter((t) => typeof t === 'string' && t && t.length <= TASK_REF_MAX_CHARS).slice(0, MAX_TASK_REFS) as string[]
  }

  return { TYPES, BODY_MAX_BYTES, HTML_MAX_BYTES, OP_INPUTS, shape, maxBytes, oversize, opArgs, taskRefs }
}

export type LetterCheck = ReturnType<typeof createLetterCheck>
