/**
 * Puts the Files preview's bridge (preview-bridge-script.ts) into an HTML document the file-raw
 * route serves. The document runs sandboxed in an origin of its own (untrusted-doc.ts), so the
 * console cannot reach into it; the bridge carries what the console used to read and draw there
 * itself (web/src/components/common/preview-frame.ts is the console's side). It does nothing in
 * a tab of its own (no parent).
 */
import { PREVIEW_BRIDGE_JS } from './preview-bridge-script.js'
import { AUTOMATION_SILENCE_JS } from '../lib/automation-silence.js'
import { VIDEO_CONTROLS_JS } from '../lib/video-controls.js'

// The page silencer first: in a browser under automation the previewed page plays no
// sound, from before its own first script (2026-11-08).
const TAG = `<script data-walnut-preview>${(AUTOMATION_SILENCE_JS + VIDEO_CONTROLS_JS).replace(/<\/script/gi, '<\\/script')}${PREVIEW_BRIDGE_JS}</script>`

/** `html` with the bridge put in first thing in its head (after any doctype, so no quirks mode). */
export function withPreviewBridge(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + TAG + html.slice(head.index + head[0].length)
  const lead = /^(\s*(<!--[\s\S]*?-->\s*)*<!doctype[^>]*>)?(\s*<html(\s[^>]*)?>)?/i.exec(html)
  const at = lead ? lead[0].length : 0
  return html.slice(0, at) + TAG + html.slice(at)
}

/** The extensions whose documents get the bridge. */
export function takesPreviewBridge(ext: string): boolean {
  return ext === 'html' || ext === 'htm'
}
