/**
 * `walnut.ui.useExperimental(id)`: whether one of Walnut's experiments (src/core/experimental.ts)
 * is on, for a plugin's view. An id Walnut does not know reads false.
 */
import { EXPERIMENTAL_FEATURES, type ExperimentalFeatureId } from '@open-walnut/core'
import { useExperimental } from '@/hooks/useExperimental'

const KNOWN: ReadonlySet<string> = new Set(EXPERIMENTAL_FEATURES.map((f) => f.id))

export function usePluginExperimental(id: string): boolean {
  // A hook must run on every render: an unknown id asks for a known one and answers false.
  const known = KNOWN.has(id)
  const on = useExperimental((known ? id : EXPERIMENTAL_FEATURES[0].id) as ExperimentalFeatureId)
  return known && on
}
