/**
 * The menu and save bar learn their nonce from the content script that framed them, by
 * postMessage (content.ts extFrame), never from their URL, which the page around them can read.
 * Only a message from the parent window counts; a page posting a wrong one only breaks its own
 * menu, since every request still needs the right nonce at the background.
 */
import { ext } from './ext'

let nonce = ''
const listeners: Array<() => void> = []

addEventListener('message', (e) => {
  if (e.source !== window.parent) return
  const n = (e.data as { walnutNonce?: unknown } | null)?.walnutNonce
  if (typeof n !== 'string' || !n || n === nonce) return
  nonce = n
  for (const f of listeners) f()
})

export const currentNonce = (): string => nonce

export function onNonce(f: () => void): void {
  listeners.push(f)
  if (nonce) f()
}

/** The vault was unlocked or locked (in the popup, elsewhere): what the frame shows may change. */
export function onUnlockChange(f: () => void): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && 'vaultSession' in changes && nonce) f()
  })
}
