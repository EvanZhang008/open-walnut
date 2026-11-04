import { useEffect, useState } from 'react'
import { fetchBuildInfo, peekBuildInfo, type BuildInfo } from '@/api/config'
import { useUpdateStatus } from '@/hooks/useUpdateStatus'
import { buildLineTitle, formatBuildLine, formatUpdateSegment } from './build-line'
import { CopyDiagnosticsLink, DiagnosticsFallback, useCopyDiagnostics } from './CopyDiagnostics'
import type { DiagnosticsSection } from './diagnostics-copy'

/**
 * Muted build identity under the open pane; renders nothing until it is known. Its Copy
 * diagnostics copies everything, or only the hosts (`section` 'hosts': Remote Hosts while it
 * has a host to report).
 */
export function SettingsBuildLine({ section = 'all' }: { section?: DiagnosticsSection } = {}) {
  const [info, setInfo] = useState<BuildInfo | null>(() => peekBuildInfo())
  const copy = useCopyDiagnostics(section)
  const hosts = section === 'hosts'
  // The same answer the notification panel's System card shows: one quiet segment
  // on the line when a newer release is published, nothing otherwise.
  const update = useUpdateStatus(true)
  const segment = formatUpdateSegment(update.status)
  useEffect(() => {
    if (info) return
    let live = true
    void fetchBuildInfo().then((next) => { if (live) setInfo(next) })
    return () => { live = false }
  }, [info])
  if (!info) return null
  return (
    <>
      <p className="settings-build-line" data-testid="settings-build-line">
        <span title={buildLineTitle(info)}>{formatBuildLine(info)}</span>
        {segment && (
          <>
            <span className="settings-build-line-sep" aria-hidden="true" />
            <span className="settings-build-line-update" data-testid="settings-build-line-update" title={segment.title}>{segment.text}</span>
          </>
        )}
        <span className="settings-build-line-sep" aria-hidden="true" />
        {hosts ? (
          <CopyDiagnosticsLink
            copy={copy}
            testId="remote-hosts-copy-diagnostics"
            title="Copy each host's connection, daemon and preflight details, with usernames and hostnames masked"
          />
        ) : <CopyDiagnosticsLink copy={copy} />}
      </p>
      <DiagnosticsFallback copy={copy} testId={hosts ? 'remote-hosts-diagnostics-fallback' : 'settings-diagnostics-fallback'} />
    </>
  )
}
