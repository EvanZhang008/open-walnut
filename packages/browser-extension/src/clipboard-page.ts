/**
 * Chrome's offscreen document for the clipboard (bg-clipboard.ts): a service worker has no
 * clipboard, a document does. It runs as popup.html?clipboard=1 and answers only the
 * background, never a content script or another page.
 */
import { ext } from './ext'

function copy(text: string): boolean {
  // A copy event sets exactly this text (an empty one clears the clipboard).
  const onCopy = (e: ClipboardEvent) => { e.clipboardData?.setData('text/plain', text); e.preventDefault() }
  document.addEventListener('copy', onCopy)
  try { return document.execCommand('copy') } finally { document.removeEventListener('copy', onCopy) }
}

function paste(): string | null {
  const area = document.createElement('textarea')
  document.body.append(area)
  area.focus()
  try { return document.execCommand('paste') ? area.value : null } finally { area.remove() }
}

export function startClipboardPage(): void {
  const background = ext.runtime.getURL('background.js')
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.target !== 'walnut-clipboard' || sender.id !== ext.runtime.id || sender.tab || (sender.url && sender.url !== background)) return
    if (msg.op === 'write') { sendResponse({ ok: copy(String(msg.text ?? '')) }); return }
    if (msg.op === 'read') { const t = paste(); sendResponse(t === null ? { ok: false } : { ok: true, text: t }); return }
  })
}
