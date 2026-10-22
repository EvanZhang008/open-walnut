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
  const OP_INPUTS = ['subject', 'type', 'markdown', 'html', 'text', 'actions', 'task_refs', 'pin']

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const filled = (v: unknown): boolean => typeof v === 'string' && v.length > 0

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
