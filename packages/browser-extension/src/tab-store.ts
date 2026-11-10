/**
 * Per-tab state that must outlive the background: Chrome stops an idle service worker after
 * about 30 s, and a sign in that leaves the page, or a person reading the connect page, takes
 * longer. storage.session is memory only, gone when the browser quits or the extension reloads
 * (the agent's own stores come back after a reload: agent-keep.ts), and closed to content
 * scripts (TRUSTED_CONTEXTS).
 */
import { ext } from './ext'

/** `ready`: awaited before every read (the agent's stores wait for agent-keep.ts to put them back after a reload). */
export function tabStore<T>(key: string, ready?: () => Promise<void>) {
  const all = async (): Promise<Record<string, T>> => { if (ready) await ready(); return ((await ext.storage.session.get(key))[key] ?? {}) as Record<string, T> }
  // Writes one at a time, so two tabs' writes never read the same old map.
  let chain: Promise<unknown> = Promise.resolve()
  const write = (f: (a: Record<string, T>) => void) => {
    const run = chain.then(async () => { const a = await all(); f(a); await ext.storage.session.set({ [key]: a }) })
    chain = run.catch(() => undefined)
    return run
  }
  return {
    async get(tabId: number): Promise<T | undefined> { await chain; return (await all())[String(tabId)] },
    set: (tabId: number, v: T) => write((a) => { a[String(tabId)] = v }),
    delete: (tabId: number) => write((a) => { delete a[String(tabId)] }),
    /** Change an entry inside the write, only while it still exists (a delete meanwhile wins). */
    update: (tabId: number, f: (v: T) => T) => write((a) => { const v = a[String(tabId)]; if (v !== undefined) a[String(tabId)] = f(v) }),
    /** Every entry `stale` says is done, decided inside the write (a newer one set meanwhile stays). */
    sweep: (stale: (v: T) => boolean) => write((a) => { for (const k of Object.keys(a)) if (stale(a[k])) delete a[k] }),
    /** Set an entry only if `ok` accepts what is there now, decided inside the write: true when it was set. */
    setIf: async (tabId: number, ok: (cur: T | undefined) => boolean, v: T): Promise<boolean> => {
      let done = false
      await write((a) => { if (ok(a[String(tabId)])) { a[String(tabId)] = v; done = true } })
      return done
    },
    /** Delete an entry only if `ok` accepts it, decided inside the write: true when it was deleted. */
    deleteIf: async (tabId: number, ok: (cur: T) => boolean): Promise<boolean> => {
      let done = false
      await write((a) => { const v = a[String(tabId)]; if (v !== undefined && ok(v)) { delete a[String(tabId)]; done = true } })
      return done
    },
    async keys(): Promise<number[]> { await chain; return Object.keys(await all()).map(Number) },
  }
}
