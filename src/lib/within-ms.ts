/** `work`'s value, or `fallback` once `ms` passed first; `work` runs on either way. */
export function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.() })
  return Promise.race([work, bound]).finally(() => clearTimeout(timer))
}
