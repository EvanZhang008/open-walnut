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
import { useIsReplicaServer } from '@/hooks/useServerRole'

/** `primary`: the console of the Mac itself (Tailscale, a browser link), never a replica answering without it. */
export type SettingsPaneGate = 'mac-access' | 'primary'

type GateState = Readonly<Record<'mac-access', boolean | null>>

function peekGates(): GateState {
  return { 'mac-access': peekMacAccess() }
}

/** The gates that are known closed on this server. */
export function closedGates(state: GateState, replica = false): ReadonlySet<SettingsPaneGate> {
  const closed = new Set<SettingsPaneGate>((Object.keys(state) as Array<keyof GateState>).filter((g) => state[g] === false))
  if (replica) closed.add('primary')
  return closed
}

export function useClosedPaneGates(): ReadonlySet<SettingsPaneGate> {
  const [state, setState] = useState<GateState>(peekGates)
  // Unknown reads as the Mac (false), so the Mac never loses an entry to a slow answer.
  const replica = useIsReplicaServer()
  useEffect(() => {
    let live = true
    void fetchMacAccess().then((macAccess) => {
      if (live) setState((prev) => (prev['mac-access'] === macAccess ? prev : { ...prev, 'mac-access': macAccess }))
    })
    return () => { live = false }
  }, [])
  return useMemo(() => closedGates(state, replica), [state, replica])
}
