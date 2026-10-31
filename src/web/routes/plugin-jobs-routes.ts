/**
 * A plugin's jobs in Settings (src/core/plugin-jobs/): where they run, how each is,
 * its log, and the "Runs on" choice. Mounted under /api/plugin-runtime/:pluginId/jobs.
 *
 *   GET  /:pluginId/jobs                     the view (5 s deadline on the daemon, else its last answer)
 *   GET  /:pluginId/jobs/:job/logs?lines&host the newest lines of one job's log (10 s deadline)
 *   PUT  /:pluginId/jobs/run-on {runOn}      "" / "__local__" (this computer) or a host key
 *
 * Only the Mac says what runs where: a replica answers 503, except to the GET.
 * The GET is a status the plugin page reads every 10 s, so a normal state (a plugin
 * with no jobs, a replica, a test server, which places none) answers 200 with no
 * jobs and the reason, never an error status the browser logs on every read.
 */
import type { Router } from 'express'
import { validatePluginId } from '../../core/plugins/ids.js'

function idOf(value: string | string[] | undefined): string {
  return validatePluginId(Array.isArray(value) ? value[0] ?? '' : value ?? '')
}

function statusOf(error: unknown): number {
  const s = (error as { status?: unknown } | null)?.status
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 400
}

export function mountPluginJobsRoutes(router: Router, opts: { cloudMode: boolean }): void {
  const onMacOnly = (res: { status(n: number): { json(b: unknown): void } }): boolean => {
    if (!opts.cloudMode) return false
    res.status(503).json({ error: 'plugin jobs are shown and placed on the Mac' })
    return true
  }

  router.get('/:pluginId/jobs', async (req, res) => {
    try {
      const pluginId = idOf(req.params.pluginId)
      const none = (reason: string) => ({ pluginId, declared: [], jobs: [], reason })
      if (opts.cloudMode) { res.json(none('plugin jobs are shown and placed on the Mac')); return }
      const { getPluginJobsManager, pluginJobsOffReason } = await import('../../core/plugin-jobs/index.js')
      const m = getPluginJobsManager()
      if (!m) { res.json(none(pluginJobsOffReason() ?? 'plugin jobs are not available here')); return }
      res.json(await m.status(pluginId) ?? none('this plugin has no jobs'))
    } catch (error) {
      res.status(statusOf(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.get('/:pluginId/jobs/:job/logs', async (req, res) => {
    if (onMacOnly(res)) return
    try {
      const pluginId = idOf(req.params.pluginId)
      const job = Array.isArray(req.params.job) ? req.params.job[0] ?? '' : req.params.job
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(job)) throw new Error('Invalid job name')
      const lines = Math.max(1, Math.min(2000, Number(req.query.lines) || 200))
      const host = typeof req.query.host === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(req.query.host) ? req.query.host : undefined
      const { getPluginJobsManager, pluginJobsOffReason } = await import('../../core/plugin-jobs/index.js')
      const m = getPluginJobsManager()
      if (!m) { res.status(503).json({ error: pluginJobsOffReason() ?? 'plugin jobs are not available here' }); return }
      res.json(await m.logs(pluginId, job, lines, host))
    } catch (error) {
      res.status(statusOf(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.put('/:pluginId/jobs/run-on', async (req, res) => {
    if (onMacOnly(res)) return
    try {
      const pluginId = idOf(req.params.pluginId)
      const raw = (req.body as { runOn?: unknown } | undefined)?.runOn
      const runOn = typeof raw === 'string' ? raw.trim() : ''
      const { getConfig, setPluginJobsRunOn } = await import('../../core/config-manager.js')
      const { CLOUD_BOX_HOST_ALIAS } = await import('../../core/hosts/cloud-box-host.js')
      if (runOn && runOn !== '__local__') {
        const hosts = (await getConfig()).hosts ?? {}
        if (runOn === CLOUD_BOX_HOST_ALIAS || !Object.prototype.hasOwnProperty.call(hosts, runOn)) {
          res.status(400).json({ error: `${runOn} is not a host in Settings, Hosts` })
          return
        }
      }
      await setPluginJobsRunOn(pluginId, runOn)
      const { emitConfigChanged } = await import('../../core/config-broadcast.js')
      // The whole config, as every writer sends it: a client takes the payload as its config.
      emitConfigChanged(await getConfig(), ['web-ui'], { source: 'api' })
      res.json({ pluginId, runOn: runOn || '__local__' })
    } catch (error) {
      res.status(statusOf(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
