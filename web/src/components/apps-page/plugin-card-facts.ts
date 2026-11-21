/**
 * What a card says about a plugin: its one status (a part that fails or needs setup speaks
 * on its parent's card, since a part has no card), and the parts it includes. One answer for
 * a plugin's own card and for the built-in app card that holds a plugin (Calendar, Mail).
 */
import { CONNECTION_BADGE } from '@/components/settings/PluginConnectionPanel'
import { cardStatus, partParents, type CardTone, type RegistryRow } from './plugin-store-model'
import type { PluginStore } from './usePluginStore'

export interface PluginCardFacts {
  status: { text: string; tone: CardTone }
  /** "Includes IMAP Mail, ..." when it has parts. */
  note?: string
  parts: RegistryRow[]
}

export function pluginCardFacts(store: Pick<PluginStore, 'installed' | 'connections' | 'stateFor'>, row: RegistryRow): PluginCardFacts {
  const parentOf = partParents(store.installed)
  const parts = store.installed.filter((other) => parentOf.get(other.id) === row.id)
  const connection = store.connections[row.id]
  const connectionAlert = connection && connection.state !== 'connected' && connection.state !== 'signing-in'
    ? CONNECTION_BADGE[connection.state]?.label
    : undefined
  const own = cardStatus(row, { update: store.stateFor(row), connectionAlert })
  const partAlert = own.tone === 'on' || own.tone === 'update'
    ? parts.map((part) => ({ part, status: cardStatus(part) })).find(({ status }) => status.tone === 'bad')
      ?? parts.map((part) => ({ part, status: cardStatus(part) })).find(({ status }) => status.tone === 'warn')
    : undefined
  return {
    status: partAlert ? { text: `${partAlert.part.name}: ${partAlert.status.text}`, tone: partAlert.status.tone } : own,
    ...(parts.length > 0 ? { note: `Includes ${parts.map((part) => part.name).join(', ')}` } : {}),
    parts,
  }
}
