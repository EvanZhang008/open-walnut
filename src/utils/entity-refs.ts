/**
 * Entity-ref helpers — shared parsing/stripping of the agent's inline reference
 * markup. Walnut agents emit `<task-ref id label/>` / `<session-ref id label/>` /
 * `<project-ref id label/>` (and a legacy `[id|label]` bracket form) so rich UIs
 * can render clickable pills. Plain-text surfaces (mobile messages, the
 * notification feed) must strip them down to the label instead of showing raw XML.
 *
 * A project has no separate identifier — its NAME is its identity (the
 * `task_projects` registry keys on it, case-insensitively), so a project ref
 * carries the name in `id` and keeps the attribute shape identical to the other
 * two kinds. One shape means one regex, one stripper, one extractor.
 */

// Module-private on purpose: a shared `g`-flag regex is a lastIndex footgun for
// any consumer using .test()/.exec(). The only safe operations (replace,
// matchAll — which clones per spec) live in this file.
const ENTITY_REF_RE = /<(task|session|project)-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g

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

/**
 * Build a `<project-ref/>` tag. `name` IS the identity, so it lands in `id`; the
 * label defaults to the name because a project pill has nothing else to show
 * (unlike a task, whose id is opaque and whose title is the label).
 */
export function projectRefTag(name: string, label?: string): string {
  const esc = (s: string): string => s.replace(/"/g, '&quot;')
  return `<project-ref id="${esc(name)}" label="${esc(label ?? name)}"/>`
}

/** Undo taskRefTag's attribute escaping when a label leaves attribute context. */
function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"')
}

/** Replace every ref of every kind (XML + legacy bracket) with its label (or id
 *  if unlabeled — for a project ref that id IS the name, so an unlabeled project
 *  ref reads as the project's name). */
export function stripEntityRefs(text: string): string {
  return text
    .replace(ENTITY_REF_RE, (_m, _kind, id: string, label?: string) => decodeAttr(label || id))
    .replace(LEGACY_REF_RE, (_m, _id, label: string) => label)
}

/** One parsed ref. `id` holds the entity's identity — for a project that IS its
 *  name — and `label` is whatever the emitter wrote (absent when unlabeled). */
export interface EntityRef {
  kind: 'task' | 'session' | 'project'
  id: string
  label?: string
}

/**
 * Every ref in the text, in the order it appears. Exists so a consumer that
 * needs MORE than the first of each kind (reference cards resolve up to eight)
 * does not have to keep a second copy of the pattern: ENTITY_REF_RE stays
 * module-private, and this hands back plain data instead of a stateful regex.
 * Attribute escaping is undone here — callers get the real id/label text.
 */
export function listEntityRefs(text: string): EntityRef[] {
  const out: EntityRef[] = []
  // matchAll clones the regex per spec, so the shared g-flag instance is safe.
  for (const m of text.matchAll(ENTITY_REF_RE)) {
    const [, kind, id, label] = m
    if (!id) continue
    out.push({
      kind: kind as EntityRef['kind'],
      id: decodeAttr(id),
      ...(label ? { label: decodeAttr(label) } : {}),
    })
  }
  return out
}

/**
 * Pull the first session/task id (and project name) referenced in a text, so a
 * notification built from agent output can carry a deep-link target even though
 * its body is stripped to plain text.
 *
 * Legacy `[id|label]` refs are intentionally skipped: the bracket form carries
 * no task/session marker, so a deep link built from one would be a guess.
 * Mirrored client-side by extractFirstRefIds in web/src/utils/markdown.ts —
 * keep the two in sync.
 */
export function extractFirstRefs(text: string): { sessionId?: string; taskId?: string; projectName?: string } {
  const out: { sessionId?: string; taskId?: string; projectName?: string } = {}
  // matchAll clones the regex per spec, so the shared g-flag instance is safe.
  for (const m of text.matchAll(ENTITY_REF_RE)) {
    const [, kind, id] = m
    if (kind === 'session' && !out.sessionId && id) out.sessionId = id
    else if (kind === 'task' && !out.taskId && id) out.taskId = id
    // A project ref carries its NAME in `id` (projects have no other identity).
    else if (kind === 'project' && !out.projectName && id) out.projectName = decodeAttr(id)
    if (out.sessionId && out.taskId && out.projectName) break
  }
  return out
}
