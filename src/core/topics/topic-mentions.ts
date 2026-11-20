/**
 * Who "@Name" names in a topic message: ONE rule for the server (topics-model.ts mentionsOf, which
 * decides who is woken or mailed) and the web (topic-model.ts, which shows the names a message will
 * reach), so what the composer shows is what the server does. Pure and browser-safe: no imports.
 *
 * A live member (pending or active, never one who left) is named by its full name, and by a short
 * form while that form is no other live member's full name or short form: "@Robin" names
 * "Robin (test)", but names no one while "Robin Hale" is in the topic too. Full names are tried
 * first, each group longest first, so "@Acme VP" is the VP and not a member called "Acme", and the
 * longest exact full name always wins.
 */

const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c)

export interface MentionMember<Id extends string = string> {
  id: Id
  name: string
  status?: string
}

/** A member's short names, lowercased: its name without a trailing "(note)", and its first word. */
export function mentionShortForms(name: string): string[] {
  const full = name.trim().toLowerCase()
  const bare = full.replace(/\s*\([^()]*\)\s*$/, '').trim()
  const first = full.split(/\s+/)[0] ?? ''
  return [...new Set([bare, first])].filter((f) => f && f !== full)
}

/** The forms "@" may use, in the order they are tried (see the file comment). */
function mentionForms<Id extends string>(members: readonly MentionMember<Id>[]): Array<{ id: Id; form: string }> {
  const live = members.filter((m) => m.status !== 'left' && m.name.trim())
  const owners = new Map<string, Set<Id>>()
  const own = (form: string, id: Id): void => {
    const set = owners.get(form) ?? new Set<Id>()
    set.add(id)
    owners.set(form, set)
  }
  for (const m of live) {
    own(m.name.trim().toLowerCase(), m.id)
    for (const f of mentionShortForms(m.name)) own(f, m.id)
  }
  const byLength = (a: { form: string }, b: { form: string }): number => b.form.length - a.form.length
  const full = live.map((m) => ({ id: m.id, form: m.name.trim().toLowerCase() })).sort(byLength)
  const short = live
    .flatMap((m) => mentionShortForms(m.name).filter((f) => owners.get(f)!.size === 1).map((form) => ({ id: m.id, form })))
    .sort(byLength)
  return [...full, ...short]
}

/**
 * The members "@Name" names in `text`, once each, in the order they first appear. Matched
 * case-insensitively, only after the start or a non-word character (an email's "a@b" names no one)
 * and only where the name ends ("@Marinas" does not name Marina).
 */
export function parseMentions<Id extends string>(text: string, members: readonly MentionMember<Id>[]): Id[] {
  const forms = mentionForms(members)
  const lower = text.toLowerCase()
  const found: Id[] = []
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    if (isWordChar(text[i - 1])) continue
    const hit = forms.find(({ form }) => lower.startsWith(form, i + 1) && !isWordChar(text[i + 1 + form.length]))
    if (hit && !found.includes(hit.id)) found.push(hit.id)
  }
  return found
}
