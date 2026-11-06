/**
 * Walnut's word that the vault changed (`vault:changed`: a lock, an unlock, a share, an item saved;
 * it carries no content), passed on to the extension page that frames this view as
 * `{ type: 'vault-changed' }`, so the extension reads its own vault state at once instead of on its
 * next poll (review 2026-11-06 round 3: a Lock in Walnut reached the panel's key in 1.5 to 2.5 s).
 * After a reconnect the word may have been missed, so it goes then too. Both extension views send
 * it (PopoutExtPanel, PopoutExtTasks); the extension reads the state once however many say so.
 */
import { useEffect } from 'react';
import { wsClient } from '@/api/ws';
import { toParent } from './ext-frame';

type Events = Pick<typeof wsClient, 'onEvent' | 'offEvent'>;

/** Pass Walnut's vault events on to `send`; returns the unsubscribe. */
export function relayVaultChanged(ws: Events, send: (msg: { type: 'vault-changed' }) => void): () => void {
  const on = () => send({ type: 'vault-changed' });
  ws.onEvent('vault:changed', on);
  ws.onEvent('_ws:reconnected', on);
  return () => { ws.offEvent('vault:changed', on); ws.offEvent('_ws:reconnected', on); };
}

export function useVaultChangedRelay(): void {
  useEffect(() => relayVaultChanged(wsClient, toParent), []);
}
