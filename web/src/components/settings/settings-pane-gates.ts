/**
 * Server facts that decide whether a core Settings pane has anything to show
 * here. A contribution naming a gate (`requires`) gets no nav entry, and no
 * Find-a-setting hit, while its gate is closed: an entry whose pane renders
 * nothing on this server reads as broken (macOS Access on a Linux host or the
 * companion). A gate not known yet, or a server older than the fact, stays open,
 * so a Mac never loses the entry to a slow or failed answer.
 *
 * An experiment's gate (`experiment:<id>`, src/core/experimental.ts) is the other
 * way round: closed until the switch reads on, since an experiment is off unless
 * the user chose it (the page's last read of the flags counts, so it does not
 * flash in or out while the config loads).
 */
import { useEffect, useMemo, useState } from 'react'
import { EXPERIMENTAL_FEATURES, experimentalEnabled, type ExperimentalFeatureId, type ExperimentalFlags } from '@open-walnut/core'
import { fetchMacAccess, peekMacAccess } from '@/api/config'
import { useIsReplicaServer } from '@/hooks/useServerRole'
import { useExperimentalFlags } from '@/hooks/useExperimental'

export type ExperimentGate = `experiment:${ExperimentalFeatureId}`

/**
 * `primary`: the console of the Mac itself (Tailscale, a browser link), never a replica answering without it.
 * `experiment:<id>`: that experiment is on (the page's last read of the flags), e.g. Focus's `experiment:focus_workspace`.
 */
export type SettingsPaneGate = 'mac-access' | 'primary' | ExperimentGate

type GateState = Readonly<Record<'mac-access', boolean | null>>

function peekGates(): GateState {
  return { 'mac-access': peekMacAccess() }
}

export const experimentGate = (id: ExperimentalFeatureId): ExperimentGate => `experiment:${id}`

/** The gates that are known closed on this server. */
export function closedGates(state: GateState, replica = false, flags: ExperimentalFlags = {}): ReadonlySet<SettingsPaneGate> {
  const closed = new Set<SettingsPaneGate>((Object.keys(state) as Array<keyof GateState>).filter((g) => state[g] === false))
  if (replica) closed.add('primary')
  for (const { id } of EXPERIMENTAL_FEATURES) {
    if (!experimentalEnabled(flags, id)) closed.add(experimentGate(id))
  }
  return closed
}

export function useClosedPaneGates(): ReadonlySet<SettingsPaneGate> {
  const [state, setState] = useState<GateState>(peekGates)
  // Unknown reads as the Mac (false), so the Mac never loses an entry to a slow answer.
  const replica = useIsReplicaServer()
  const flags = useExperimentalFlags()
  useEffect(() => {
    let live = true
    void fetchMacAccess().then((macAccess) => {
      if (live) setState((prev) => (prev['mac-access'] === macAccess ? prev : { ...prev, 'mac-access': macAccess }))
    })
    return () => { live = false }
  }, [])
  return useMemo(() => closedGates(state, replica, flags), [state, replica, flags])
}
