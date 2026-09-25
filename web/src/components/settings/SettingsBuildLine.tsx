import { useEffect, useState } from 'react'
import { fetchBuildInfo, peekBuildInfo, type BuildInfo } from '@/api/config'
import { buildLineTitle, formatBuildLine } from './build-line'
import { CopyDiagnosticsLink, DiagnosticsFallback, useCopyDiagnostics } from './CopyDiagnostics'

/** Muted build identity under the open pane; renders nothing until it is known. */
export function SettingsBuildLine() {
  const [info, setInfo] = useState<BuildInfo | null>(() => peekBuildInfo())
  const copy = useCopyDiagnostics('all')
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
        <span className="settings-build-line-sep" aria-hidden="true">{' · '}</span>
        <CopyDiagnosticsLink copy={copy} />
      </p>
      <DiagnosticsFallback copy={copy} testId="settings-diagnostics-fallback" />
    </>
  )
}
