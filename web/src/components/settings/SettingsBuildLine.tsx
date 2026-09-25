import { useEffect, useState } from 'react'
import { fetchBuildInfo, peekBuildInfo, type BuildInfo } from '@/api/config'
import { buildLineTitle, formatBuildLine } from './build-line'

/** Muted build identity under the open pane; renders nothing until it is known. */
export function SettingsBuildLine() {
  const [info, setInfo] = useState<BuildInfo | null>(() => peekBuildInfo())
  useEffect(() => {
    if (info) return
    let live = true
    void fetchBuildInfo().then((next) => { if (live) setInfo(next) })
    return () => { live = false }
  }, [info])
  if (!info) return null
  return (
    <p className="settings-build-line" data-testid="settings-build-line" title={buildLineTitle(info)}>
      {formatBuildLine(info)}
    </p>
  )
}
