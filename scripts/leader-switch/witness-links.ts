/**
 * WALNUT_REHEARSAL_WITNESS_LINKS={"<host>": <port>, ...}: a rehearsal server's links to those hosts' services
 * (way c, as the leader's daemon link is): each a leader door on a loopback port that serves the
 * host's witness route (tests/helpers/witness-machines.ts), one HTTP request per connection as on a
 * relayed stream. Only the machine whose env names it has the link; nothing in production sets it.
 * Like the daemon link it stands for, it opens only once this server has led (runtime.ts everLed): a
 * server that waits for its first lead reaches no host over it. Shared by rehearsal-server.ts and
 * machine-server.ts.
 */
export async function linkRehearsalWitnesses(): Promise<void> {
  const links = process.env.WALNUT_REHEARSAL_WITNESS_LINKS
  if (!links) return
  const ports = JSON.parse(links) as Record<string, number>
  const [{ addWitnessReach }, { requestOver }, net, { currentLeaderPermit }] = await Promise.all([
    import('../../src/core/leader/switch/witness-transport.js'), import('../../src/core/host-server/request-over.js'), import('node:net'),
    import('../../src/core/leader/switch/boot.js'),
  ])
  addWitnessReach((host, urlPath, body, timeoutMs) => {
    const port = ports[host]
    const p = currentLeaderPermit()
    if (!port || !p || p.trial || !p.runtime.hasLed()) return null
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1')
      sock.on('error', reject)
      requestOver(sock, 'POST', urlPath, Buffer.from(JSON.stringify(body)), timeoutMs)
        .then(async (res) => resolve({ status: res.status, body: await res.json().catch(() => null) }), reject)
    })
  })
}
