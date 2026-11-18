/**
 * Puts the Files preview's bridge (preview-bridge-script.ts) into an HTML document the file-raw
 * route serves. The document runs sandboxed in an origin of its own (untrusted-doc.ts), so the
 * console cannot reach into it; the bridge carries what the console used to read and draw there
 * itself (web/src/components/common/preview-frame.ts is the console's side). It does nothing in
 * a tab of its own (no parent).
 */
import { PREVIEW_BRIDGE_JS } from './preview-bridge-script.js'
import { PREVIEW_STATE_JS } from './preview-state-script.js'
import { AUTOMATION_SILENCE_JS } from '../lib/automation-silence.js'
import { VIDEO_CONTROLS_JS } from '../lib/video-controls.js'

// The page silencer first: in a browser under automation the previewed page plays no
// sound, from before its own first script (2026-11-08). The page's state next, so its storage
// and hash are back before its own first script reads them (preview-state-script.ts), with the
// disk copy of that state in a data block before it.
const escapeScript = (js: string) => js.replace(/<\/script/gi, '<\\/script')
const TAG = `<script data-walnut-preview>${escapeScript(AUTOMATION_SILENCE_JS + VIDEO_CONTROLS_JS + PREVIEW_STATE_JS + '();' + PREVIEW_BRIDGE_JS)}</script>`

/**
 * `html` with the bridge put in first thing in its head (after any doctype, so no quirks mode).
 * `seed` is the page's state as Walnut keeps it on disk (preview-storage.ts), a JSON text, or null.
 * It goes in as it is, in a data block the state script reads and removes: the page wrote it with
 * every `<` escaped, so no `</script>` or `<!--` can end the block, and a text holding one is left
 * out (one scan; up to 8 MB is never parsed or copied here). A text that does not parse costs the
 * page only its state.
 */
export function withPreviewBridge(html: string, seed: string | null = null): string {
  const tag = (seed && !seed.includes('<') ? `<script type="application/json" data-walnut-seed>${seed}</script>` : '') + TAG
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
  const lead = /^(\s*(<!--[\s\S]*?-->\s*)*<!doctype[^>]*>)?(\s*<html(\s[^>]*)?>)?/i.exec(html)
  const at = lead ? lead[0].length : 0
  return html.slice(0, at) + tag + html.slice(at)
}

/** The extensions whose documents get the bridge. */
export function takesPreviewBridge(ext: string): boolean {
  return ext === 'html' || ext === 'htm'
}
