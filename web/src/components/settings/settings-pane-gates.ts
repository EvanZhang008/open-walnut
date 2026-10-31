/**
 * Server facts that decide whether a core Settings pane has anything to show
 * here. A contribution naming a gate (`requires`) gets no nav entry, and no
 * Find-a-setting hit, while its gate is closed: an entry whose pane renders
 * nothing on this server reads as broken (macOS Access on a Linux host or the
 * companion). A gate not known yet, or a server older than the fact, stays open,
 * so a Mac never loses the entry to a slow or failed answer.
 */
import { useEffect, useMemo, useState } from 'react'
import { fetchMacAccess, peekMacAccess } from '@/api/config'

export type SettingsPaneGate = 'mac-access'

type GateState = Readonly<Record<SettingsPaneGate, boolean | null>>

function peekGates(): GateState {
  return { 'mac-access': peekMacAccess() }
}

/** The gates that are known closed on this server. */
export function closedGates(state: GateState): ReadonlySet<SettingsPaneGate> {
  return new Set((Object.keys(state) as SettingsPaneGate[]).filter((g) => state[g] === false))
}

export function useClosedPaneGates(): ReadonlySet<SettingsPaneGate> {
  const [state, setState] = useState<GateState>(peekGates)
  useEffect(() => {
    let live = true
    void fetchMacAccess().then((macAccess) => {
      if (live) setState((prev) => (prev['mac-access'] === macAccess ? prev : { ...prev, 'mac-access': macAccess }))
    })
    return () => { live = false }
  }, [])
  return useMemo(() => closedGates(state), [state])
}
