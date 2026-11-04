/**
 * Whose download it is (agent-downloads.ts), decided from facts alone so it can be tested. The
 * browser does not say which tab a download came from. The page it came from (its referrer) is
 * an agent tab's page now or a moment ago: that tab's owner's (one owner only). A referrer cut to
 * the origin (a cross-site link) counts only when one agent tab alone is being acted in and the
 * referrer is that tab's origin. No referrer at all counts only then too, and only when the
 * file's own address is on the origin of one of that owner's agent tabs, so the person's own
 * download from elsewhere in that moment is not the agent's. Anything else is no agent's.
 */
export interface AgentTabNow { id: number; owner: string; url?: string; history?: string[]; acting: boolean }

const origin = (u: string | undefined) => { try { return new URL(u ?? '').origin } catch { return '' } }

export function downloadOwner(item: { referrer?: string; url?: string }, tabs: readonly AgentTabNow[]): { owner: string; tab: number } | undefined {
  const from = item.referrer || ''
  const bare = !from || from === `${origin(from)}/`
  const byPage: Array<{ owner: string; tab: number }> = []
  const busy: AgentTabNow[] = []
  const originsOf = new Map<string, Set<string>>()
  for (const t of tabs) {
    const o = origin(t.url)
    if (o) originsOf.set(t.owner, new Set([...(originsOf.get(t.owner) ?? []), o]))
    const pages = [t.url, ...(t.history ?? []).slice(-5)]
    if (from && !bare && pages.includes(from)) byPage.push({ owner: t.owner, tab: t.id })
    if (t.acting) busy.push(t)
  }
  if (byPage.length) return new Set(byPage.map((x) => x.owner)).size === 1 ? byPage[0] : undefined
  if (!bare || busy.length !== 1) return undefined
  const one = busy[0]
  if (from) return origin(from) === origin(one.url) ? { owner: one.owner, tab: one.id } : undefined
  const fileOrigin = origin(item.url)
  return fileOrigin && originsOf.get(one.owner)?.has(fileOrigin) ? { owner: one.owner, tab: one.id } : undefined
}
