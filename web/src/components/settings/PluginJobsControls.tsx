/**
 * A plugin's jobs on its page, while it is on (src/core/plugin-jobs/): which machine runs
 * them ("Runs on"), and one row per job with its state, its last run, its numbers and its
 * log. The daemon of the chosen machine keeps them running; this page only reads and moves.
 * Words: plugin-jobs-model.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPut } from '@/api/client'
import { SettingsRow, SettingsTag } from './SettingsSection'
import { SettingsButton } from './inputs/SettingsButton'
import {
  formatLogLine, hostOptionLabel, jobHelp, jobTag, placementHelp, placementTone, readPluginJobsState,
  type PluginJobsState,
} from './plugin-jobs-model'
import '@/styles/settings-sections-addons.css'
import '@/styles/plugin-jobs.css'

/** How often an open page asks again (each ask is one daemon read, 5 s deadline). */
const REFRESH_MS = 10_000

function JobLog({ pluginId, job, host }: { pluginId: string; job: string; host: string }) {
  const [lines, setLines] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  const load = useCallback(() => {
    setError(null)
    apiGet<{ lines?: unknown }>(`/api/plugin-runtime/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(job)}/logs`, { lines: '200', ...(host ? { host } : {}) }, { quietStatuses: [404, 409, 503] })
      .then((r) => setLines(Array.isArray(r.lines) ? r.lines.map(String) : []))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [pluginId, job, host])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight }, [lines])
  return (
    <div className="plugin-job-log" data-testid={`plugin-job-log-${pluginId}-${job}`}>
      <div className="plugin-job-log-bar">
        <span>{error ? `Could not read the log: ${error}` : lines === null ? 'Reading...' : lines.length === 0 ? 'Nothing logged yet.' : `Last ${lines.length} lines`}</span>
        <SettingsButton variant="text" onClick={load} data-testid={`plugin-job-log-refresh-${pluginId}-${job}`}>Refresh</SettingsButton>
      </div>
      {lines && lines.length > 0 && <pre ref={pre} className="plugin-job-log-text">{lines.map(formatLogLine).join('\n')}</pre>}
    </div>
  )
}

export function PluginJobsControls({ pluginId }: { pluginId: string }) {
  const base = `/api/plugin-runtime/${encodeURIComponent(pluginId)}/jobs`
  const [view, setView] = useState<PluginJobsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(() => {
    return apiGet<unknown>(base, undefined, { quietStatuses: [404, 503], priority: 'low' })
      .then((answer) => { setView(readPluginJobsState(answer)); setNow(Date.now()) })
      .catch(() => { /* no jobs, an older server, or the plugins still loading: keep what is shown */ })
  }, [base])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  if (!view || view.declared.length === 0) return null

  const move = async (runOn: string) => {
    if (runOn === view.runOn) return
    setBusy(true)
    setError(null)
    try {
      await apiPut(`${base}/run-on`, { runOn })
      setView({ ...view, runOn, runOnLabel: view.hosts.find((h) => h.key === runOn)?.label ?? runOn, placement: { state: 'pending', message: 'moving' }, jobs: [] })
      // The daemons hear the new set in about a second; read it back after that.
      setTimeout(() => { void refresh() }, 1_500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const hostKnown = view.hosts.some((h) => h.key === view.runOn)
  return (
    <div className="settings-addons-rows plugin-app-controls" data-testid={`plugin-jobs-${pluginId}`} data-placement={view.placement.state}>
      <SettingsRow
        indent
        className="plugin-app-controls-row"
        state={placementTone(view.placement.state) === 'error' ? 'error' : undefined}
        label={<span className="plugin-app-controls-label">Runs on</span>}
        help={<span data-testid={`plugin-jobs-placement-${pluginId}`}>{placementHelp(view, now)}</span>}
        error={error ?? undefined}
        control={
          <select
            className="settings-select"
            aria-label="Machine that runs this plugin's jobs"
            data-testid={`plugin-jobs-run-on-${pluginId}`}
            value={view.runOn}
            disabled={busy}
            onChange={(e) => void move(e.target.value)}
          >
            {!hostKnown && <option value={view.runOn}>{`${view.runOn} (not in Hosts)`}</option>}
            {view.hosts.map((h) => <option key={h.key} value={h.key}>{hostOptionLabel(h)}</option>)}
          </select>
        }
      />
      {view.declared.map((decl) => {
        const row = view.jobs.find((j) => j.job === decl.name)
        const tag = jobTag(row, view.placement.state)
        const logOpen = openLog === decl.name
        return (
          <div key={decl.name} data-testid={`plugin-job-row-${pluginId}-${decl.name}`} data-state={row?.state ?? 'none'}>
            <SettingsRow
              indent
              className="plugin-app-controls-row"
              state={tag.tone === 'error' ? 'error' : undefined}
              label={
                <span className="settings-addons-inline plugin-app-controls-label">
                  <span className="settings-addons-ellipsis" title={decl.name}>{`Job: ${decl.name}`}</span>
                  <SettingsTag tone={tag.tone}>{tag.label}</SettingsTag>
                </span>
              }
              help={<span data-testid={`plugin-job-help-${pluginId}-${decl.name}`}>{jobHelp(decl, row, now)}</span>}
              control={
                <SettingsButton
                  variant="default"
                  aria-expanded={logOpen}
                  data-testid={`plugin-job-log-toggle-${pluginId}-${decl.name}`}
                  disabled={!row && view.placement.state !== 'running'}
                  onClick={() => setOpenLog(logOpen ? null : decl.name)}
                >
                  {logOpen ? 'Hide log' : 'Log'}
                </SettingsButton>
              }
            />
            {logOpen && <JobLog pluginId={pluginId} job={decl.name} host={row?.host ?? ''} />}
          </div>
        )
      })}
    </div>
  )
}
