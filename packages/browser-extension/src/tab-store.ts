/**
 * Per-tab state that must outlive the background: Chrome stops an idle service worker after
 * about 30 s, and a sign in that leaves the page, or a person reading the connect page, takes
 * longer. storage.session is memory only, gone when the browser quits, and closed to content
 * scripts (TRUSTED_CONTEXTS).
 */
import { ext } from './ext'

export function tabStore<T>(key: string) {
  const all = async (): Promise<Record<string, T>> => ((await ext.storage.session.get(key))[key] ?? {}) as Record<string, T>
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
    /** Every entry `stale` says is done, decided inside the write (a newer one set meanwhile stays). */
    sweep: (stale: (v: T) => boolean) => write((a) => { for (const k of Object.keys(a)) if (stale(a[k])) delete a[k] }),
    async keys(): Promise<number[]> { await chain; return Object.keys(await all()).map(Number) },
  }
}
