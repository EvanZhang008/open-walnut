/**
 * The live preview of an html-app block that is still arriving.
 *
 * 2026-10-29: a reply's interactive block sat as an empty "building interactive
 * block…" box for the whole time it streamed, so the user waited with nothing to
 * read. The block now shows its layout as it arrives: the partial HTML and CSS,
 * drawn in a sandboxed frame of their own, with every script of the model's left
 * out. Running half a script is the one thing this must never do, so the model's
 * code is kept out three ways:
 *
 *  1. The partial HTML is parsed with `DOMParser`, whose document runs nothing and
 *     loads nothing, and every element that could run or load code (`<script>`,
 *     `<iframe>`, `<object>`, `<meta>`, `<base>`, `<link>`) is dropped, as are
 *     every `on…` attribute and `javascript:` URL, BEFORE the nodes enter the
 *     visible document.
 *  2. Nodes moved in that way never run as scripts anyway (only a parser of the
 *     document itself starts a script).
 *  3. The frame's CSP allows ONE script, the preview's own, by nonce: an inline
 *     handler or a `javascript:` URL that slipped past (1) is refused by the
 *     browser.
 *
 * The frame is built once and fed the newest text by `postMessage`, so the preview
 * grows in place instead of reloading (a new `srcDoc` would flash white on every
 * update). When the block is complete, RichBlocks mounts the real island, which runs
 * the whole page with its saved state (island-runtime.ts), and drops this frame
 * once that one has drawn.
 */

export const PREVIEW_MSG = 'wn-pv';
export const PREVIEW_READY_MSG = 'wn-pv-ready';
export const PREVIEW_HEIGHT_MSG = 'wn-pv-h';

/**
 * The base frame a fragment island gets (RichBlocks `wrapIslandHtml`), applied
 * the same way here so the preview and the island it gives way to draw alike.
 */
export const FRAGMENT_BASE_CSS = 'html,body{margin:0;background:transparent}'
  + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px}';

/**
 * Is this html a whole document (it keeps its own head), not a fragment?
 *
 * With `partial`, a text that may still BECOME `<!doctype` or `<html` counts as a
 * document, so the first few characters of a stream do not flip the base styling.
 */
export function isIslandDocument(html: string, partial = false): boolean {
  const head = html.trimStart().slice(0, 32).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return true;
  if (!partial) return false;
  // Nothing yet, or a prefix such as `<!do` / `<ht` that is still arriving.
  return head === '' || '<!doctype'.startsWith(head) || '<html'.startsWith(head);
}

/** What the frame needs to draw one update. */
export interface PreviewUpdate {
  t: typeof PREVIEW_MSG;
  k: string;
  html: string;
  fragment: boolean;
}

export function previewUpdate(key: string, html: string): PreviewUpdate {
  return { t: PREVIEW_MSG, k: key, html, fragment: !isIslandDocument(html, true) };
}

/** A frame's height report: its document height and whether it shows anything yet. */
export function readPreviewHeight(data: unknown, key: string): { h: number; filled: boolean } | null {
  const d = data as { t?: unknown; k?: unknown; h?: unknown; filled?: unknown } | null;
  if (!d || d.t !== PREVIEW_HEIGHT_MSG || d.k !== key || typeof d.h !== 'number' || !Number.isFinite(d.h)) return null;
  return { h: d.h, filled: d.filled === true };
}

export function isPreviewReady(data: unknown, key: string): boolean {
  const d = data as { t?: unknown; k?: unknown } | null;
  return !!d && d.t === PREVIEW_READY_MSG && d.k === key;
}

/**
 * The script that runs inside the preview frame (and nothing else does).
 *
 * Kept as plain ES5 text: it runs in whatever engine the window has, the Mac app's
 * WebKit included, and is never bundled.
 */
function previewRuntime(key: string): string {
  return `(function(){var k=${JSON.stringify(key)};`
    + `var css=document.getElementById('wn-pv-css'),base=document.getElementById('wn-pv-base');`
    + `var BASE=${JSON.stringify(FRAGMENT_BASE_CSS)};`
    + `var DROP='script,noscript,iframe,frame,frameset,object,embed,applet,portal,base,meta,link';`
    + `var URLS={href:1,src:1,action:1,formaction:1,'xlink:href':1,data:1,poster:1,background:1,srcset:1};`
    + `function bad(a){var n=a.name.toLowerCase();if(n.slice(0,2)==='on'||n==='srcdoc'||n==='autofocus')return true;`
    + `return URLS[n]===1&&/^[\\s\\u0000-\\u001f]*(javascript|vbscript|data:text\\/html)/i.test(a.value)}`
    + `function clean(d){var x=d.querySelectorAll(DROP);for(var i=0;i<x.length;i++)x[i].parentNode.removeChild(x[i]);`
    + `var all=d.getElementsByTagName('*');for(var j=0;j<all.length;j++){var el=all[j];`
    + `for(var m=el.attributes.length-1;m>=0;m--){if(bad(el.attributes[m]))el.removeAttribute(el.attributes[m].name)}}}`
    + `function copyAttrs(from,to){for(var i=to.attributes.length-1;i>=0;i--)to.removeAttribute(to.attributes[i].name);`
    // A name the parser takes but setAttribute refuses (`@click`) is skipped, so
    // one odd attribute cannot freeze the preview for the rest of the stream.
    + `if(!from)return;for(var j=0;j<from.attributes.length;j++){try{to.setAttribute(from.attributes[j].name,from.attributes[j].value)}catch(x){}}}`
    + `function filled(){var b=document.body;return b.textContent.replace(/\\s/g,'')!==''`
    + `||!!b.querySelector('img,svg,canvas,input,button,select,textarea,video,hr,progress,meter')}`
    // The content's own height, not scrollHeight: that is never less than the
    // frame's current height, so one tall moment mid-stream would stick.
    + `function r(){try{var e=document.documentElement,b=document.body;`
    + `parent.postMessage({t:${JSON.stringify(PREVIEW_HEIGHT_MSG)},k:k,`
    + `h:Math.max(e.getBoundingClientRect().height,b?b.scrollHeight:0),filled:filled()},'*')}catch(x){}}`
    + `function apply(html,fragment){var d=new DOMParser().parseFromString(html,'text/html');clean(d);`
    + `var s='',st=d.head?d.head.getElementsByTagName('style'):[];for(var i=0;i<st.length;i++)s+=st[i].textContent+'\\n';`
    + `css.textContent=s;base.textContent=fragment?BASE:'';`
    + `copyAttrs(d.documentElement,document.documentElement);copyAttrs(d.body,document.body);`
    + `var b=document.body;while(b.firstChild)b.removeChild(b.firstChild);`
    + `if(d.body)while(d.body.firstChild)b.appendChild(document.adoptNode(d.body.firstChild));r()}`
    + `addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data;`
    + `if(!m||m.t!==${JSON.stringify(PREVIEW_MSG)}||m.k!==k)return;apply(String(m.html),!!m.fragment)});`
    + `if(window.ResizeObserver)new ResizeObserver(r).observe(document.documentElement);`
    + `try{parent.postMessage({t:${JSON.stringify(PREVIEW_READY_MSG)},k:k},'*')}catch(e){}})()`;
}

/**
 * The preview frame's document: a CSP that allows only its own script, two style
 * slots (the fragment base, the model's head styles) and an empty body.
 */
export function islandPreviewDoc(key: string, nonce: string): string {
  const csp = "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; "
    + `script-src 'nonce-${nonce}'`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<style id="wn-pv-base"></style><style id="wn-pv-css"></style>'
    + `<script nonce="${nonce}">${previewRuntime(key)}</script></head><body></body></html>`;
}
