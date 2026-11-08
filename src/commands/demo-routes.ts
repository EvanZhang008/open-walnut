/**
 * The Demo server's own front door (demo-server.ts), ahead of every Walnut route:
 *
 *   - a request for any other host than the Demo's own address is turned away (a GET page is sent
 *     to the Demo's address, an API call answers 421);
 *   - once the Demo stops nothing new is accepted (503);
 *   - GET  /api/demo/generation -> { generation, signInCommand, realSsh, realSshAvailable }
 *   - a write, or any request naming a generation, from another generation's page: 409 (the page
 *     reloads into the current one);
 *   - POST /api/demo/ssh-hosts -> { realSsh: true }: "Use my SSH hosts" (demo-real-ssh.ts). It
 *     dials nothing: the hosts it finds wait for their own Add, and the settings lists refresh
 *     through config:changed.
 */
import type { RequestHandler } from 'express'
import type { DemoPaths } from './demo-home.js'
import { demoRealSshAvailable, demoRealSshOn, enableDemoRealSsh } from './demo-real-ssh.js'

export interface DemoRouteOptions {
  paths: DemoPaths
  generation: string
  signInCommand: string | null
  /** The Host header the Demo answers (`127.0.0.1:<port>`). */
  host: string
  /** The Demo's own address, for the redirect. */
  url: string
  /** The Demo is stopping or failed. */
  closed: () => boolean
}

/**
 * Before "Use my SSH hosts" may list anything, found hosts must wait for a yes: the server's boot
 * records that (found-hosts-store.ts settleFoundHosts), and a Demo whose boot could not gets it
 * here, so no host of the person's config is ever merged on as already said yes to.
 */
async function foundHostsWaitForYes(): Promise<void> {
  const { modifyConfigDoc } = await import('../core/config-store.js')
  await modifyConfigDoc((doc) => {
    const marker = doc.hosts_found as { asking_since?: unknown } | undefined
    if (typeof marker?.asking_since === 'string' && marker.asking_since) return { write: false, result: false }
    doc.hosts_found = { ...(marker && typeof marker === 'object' ? marker : {}), asking_since: new Date().toISOString() }
    return { write: true, result: true }
  })
}

export function demoBeforeRoutes(o: DemoRouteOptions): RequestHandler {
  return (req, res, next) => {
    if (req.headers.host !== o.host) {
      res.setHeader('cache-control', 'no-store')
      if (req.method === 'GET' && !req.path.startsWith('/api/')) res.redirect(308, o.url)
      else res.status(421).json({ error: 'Open Walnut Demo at its own address: ' + o.url })
      return
    }
    if (o.closed()) { res.status(503).json({ error: 'Demo is stopping; no new work is accepted' }); return }
    if (req.method === 'GET' && req.path === '/api/demo/generation') {
      res.setHeader('cache-control', 'no-store')
      void Promise.all([demoRealSshOn(o.paths), demoRealSshAvailable(o.paths)]).then(([realSsh, realSshAvailable]) => {
        res.json({ generation: o.generation, signInCommand: o.signInCommand, realSsh, realSshAvailable })
      }, () => res.json({ generation: o.generation, signInCommand: o.signInCommand, realSsh: false, realSshAvailable: false }))
      return
    }
    const clientGeneration = req.headers['x-walnut-demo-generation']
    if (clientGeneration !== undefined && clientGeneration !== o.generation
      || req.path.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD' && clientGeneration !== o.generation) {
      res.status(409).json({ error: 'Demo was reset. Reload before continuing.' })
      return
    }
    if (req.path === '/api/demo/ssh-hosts') {
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'POST') { res.status(405).json({ error: 'POST turns on "Use my SSH hosts"' }); return }
      void (async () => {
        if (!await demoRealSshAvailable(o.paths)) {
          res.status(409).json({ error: 'Walnut Demo found no ~/.ssh/config in your account to read.', code: 'no_ssh_config' })
          return
        }
        await foundHostsWaitForYes()
        await enableDemoRealSsh(o.paths)
        const [{ getConfig }, { emitSettingsConfigChanged }] = await Promise.all([
          import('../core/config-manager.js'), import('../core/config-broadcast.js'),
        ])
        emitSettingsConfigChanged(await getConfig())
        res.json({ realSsh: true })
      })().catch((error: unknown) => {
        if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
      })
      return
    }
    next()
  }
}
