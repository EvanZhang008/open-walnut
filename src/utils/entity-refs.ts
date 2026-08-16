/**
 * Entity-ref helpers — shared parsing/stripping of the agent's inline reference
 * markup. Walnut agents emit `<task-ref id label/>` / `<session-ref id label/>`
 * (and a legacy `[id|label]` bracket form) so rich UIs can render clickable
 * pills. Plain-text surfaces (mobile messages, the notification feed) must strip
 * them down to the label instead of showing raw XML.
 */

// Module-private on purpose: a shared `g`-flag regex is a lastIndex footgun for
// any consumer using .test()/.exec(). The only safe operations (replace,
// matchAll — which clones per spec) live in this file.
const ENTITY_REF_RE = /<(task|session)-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g

/** Legacy bracket ref: [mr9i88ys-87a4|Some Label] → Some Label. */
const LEGACY_REF_RE = /\[([a-z0-9]{7,10}-[a-f0-9]{4})\|([^\]]+)\]/g

/**
 * Build a `<task-ref/>` tag. Shared so every emitter (the Personal AI's tools, the
 * CLI's task-mutating commands) produces byte-identical markup for the UI's
 * pill renderer + the ENTITY_REF_RE above.
 */
export function taskRefTag(id: string, label: string): string {
  const esc = (s: string): string => s.replace(/"/g, '&quot;')
  return `<task-ref id="${esc(id)}" label="${esc(label)}"/>`
}

/** Build a `<session-ref/>` tag — same contract as taskRefTag. */
export function sessionRefTag(id: string, label: string): string {
  const esc = (s: string): string => s.replace(/"/g, '&quot;')
  return `<session-ref id="${esc(id)}" label="${esc(label)}"/>`
}

/** Undo taskRefTag's attribute escaping when a label leaves attribute context. */
function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"')
}

/** Replace every ref (XML + legacy bracket) with its label (or id if unlabeled). */
export function stripEntityRefs(text: string): string {
  return text
    .replace(ENTITY_REF_RE, (_m, _kind, id: string, label?: string) => decodeAttr(label || id))
    .replace(LEGACY_REF_RE, (_m, _id, label: string) => label)
}

/**
 * Pull the first session/task id referenced in a text, so a notification built
 * from agent output can carry a deep-link target even though its body is
 * stripped to plain text.
 *
 * Legacy `[id|label]` refs are intentionally skipped: the bracket form carries
 * no task/session marker, so a deep link built from one would be a guess.
 * Mirrored client-side by extractFirstRefIds in web/src/utils/markdown.ts —
 * keep the two in sync.
 */
export function extractFirstRefs(text: string): { sessionId?: string; taskId?: string } {
  const out: { sessionId?: string; taskId?: string } = {}
  // matchAll clones the regex per spec, so the shared g-flag instance is safe.
  for (const m of text.matchAll(ENTITY_REF_RE)) {
    const [, kind, id] = m
    if (kind === 'session' && !out.sessionId && id) out.sessionId = id
    else if (kind === 'task' && !out.taskId && id) out.taskId = id
    if (out.sessionId && out.taskId) break
  }
  return out
}
