/**
 * Downloads an agent started. The browser does not say which tab a download came from, so one
 * is the agent's when it starts while the agent acts in one of its tabs (or shortly after) from
 * that tab's site, or from the very page an agent tab shows. `downloads` lists the owner's and
 * can wait for the next one to finish.
 */
import { more, type DownloadItem } from './agent-api'
import { ext } from './ext'
import { tabStore } from './tab-store'
import { AgentError, acting, agentTabs, sleep } from './agent-shared'
import { downloadOwner, type AgentTabNow } from './download-owner'

interface Dl { owner: string; tab: number; at: number; told?: boolean }
const downloads = tabStore<Dl>('agentDownloads')
const KEEP_MS = 24 * 3600_000

/** Whose download it is, from what the browser says of it and of the agent tabs (download-owner.ts). */
async function ownerOf(item: DownloadItem): Promise<{ owner: string; tab: number } | undefined> {
  const now = Date.now()
  const tabs: AgentTabNow[] = []
  for (const id of await agentTabs.keys()) {
    const rec = await agentTabs.get(id)
    const t = await ext.tabs.get(id).catch(() => null)
    if (!rec || !t) continue
    tabs.push({ id, owner: rec.owner, url: t.url, history: rec.history, acting: (acting.get(id) ?? 0) > now })
  }
  return downloadOwner({ referrer: item.referrer, url: item.finalUrl || item.url }, tabs)
}

/** The files an owner's finished downloads wrote: the only local files a trusted upload may send. */
export async function downloadedFiles(owner: string): Promise<string[]> {
  if (!more.downloads) return []
  return (await mine(owner)).filter((x) => x.item.state === 'complete' && x.item.filename).map((x) => x.item.filename)
}

export function watchDownloads(): void {
  more.downloads?.onCreated.addListener((item) => {
    void ownerOf(item).then(async (o) => {
      if (!o) return
      await downloads.sweep((d) => Date.now() - d.at > KEEP_MS)
      await downloads.set(item.id, { ...o, at: Date.now() })
    })
  })
}

function view(d: DownloadItem): Record<string, unknown> {
  return {
    id: d.id, filename: d.filename, url: d.finalUrl || d.url, state: d.state, bytes: d.bytesReceived,
    ...(d.totalBytes > 0 ? { total: d.totalBytes } : {}), ...(d.mime ? { mime: d.mime } : {}), ...(d.error ? { error: d.error } : {}),
    started: d.startTime, ...(d.endTime ? { ended: d.endTime } : {}), ...(d.exists === false ? { exists: false } : {}),
  }
}

async function mine(owner: string): Promise<Array<{ item: DownloadItem; rec: Dl }>> {
  const out: Array<{ item: DownloadItem; rec: Dl }> = []
  for (const id of await downloads.keys()) {
    const rec = await downloads.get(id)
    if (!rec || rec.owner !== owner) continue
    const [item] = await more.downloads!.search({ id }).catch(() => [])
    if (item) out.push({ item, rec })
  }
  return out.sort((a, b) => a.rec.at - b.rec.at)
}

/** `downloads {wait?, ms?}`: the owner's downloads; with wait, the next one to finish (one not yet told of). */
export async function downloadsAction(owner: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!more.downloads) throw new AgentError('This browser does not let the extension see downloads.', 'no_downloads')
  if (args.wait !== true) return { downloads: (await mine(owner)).map((x) => view(x.item)) }
  const ms = typeof args.ms === 'number' ? Math.max(0, Math.min(30_000, args.ms)) : 25_000
  const until = Date.now() + ms
  for (;;) {
    const list = await mine(owner)
    const done = list.find((x) => !x.rec.told && x.item.state !== 'in_progress')
    if (done) {
      await downloads.update(done.item.id, (d) => ({ ...d, told: true }))
      return { finished: view(done.item), downloads: list.map((x) => view(x.item)) }
    }
    if (Date.now() >= until) {
      const going = list.filter((x) => x.item.state === 'in_progress')
      throw new AgentError(going.length ? `A download is still going after ${Math.round(ms / 1000)} s: wait again.` : `No download started within ${Math.round(ms / 1000)} s.`, 'wait_timeout', { downloads: list.map((x) => view(x.item)) })
    }
    await sleep(400)
  }
}
