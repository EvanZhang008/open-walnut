/** One of Walnut's own addresses the server named (`host` or `host:port`): its tunnel, the companion, this Mac's LAN. */
export function walnutAddress(list: string[] | undefined, url: string): boolean {
  try {
    const u = new URL(url)
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    return !!list && (list.includes(u.hostname) || list.includes(`${u.hostname}:${port}`))
  } catch { return false }
}
