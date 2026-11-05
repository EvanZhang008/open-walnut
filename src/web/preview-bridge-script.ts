/**
 * The script Walnut puts into every HTML document the Files preview shows (preview-bridge.ts
 * puts it in; web/src/components/common/preview-frame.ts is the console's side). It is plain
 * browser JavaScript in a string because it runs in the page, in the page's own sandboxed
 * origin, with nothing of Walnut's bundle around it.
 *
 * What it tells the console: the page's URL once loaded, its scroll position, the reader's
 * selection (as text, a rect and offsets into the page's text), the page's text itself (so the
 * console can locate its anchors there with its own code), link clicks, a right-click on a link a
 * plugin handles, clicks and hovers on the marks it drew, the rects of the marks the console
 * places a card or a line by, ⌘F, Esc and find results.
 *
 * What it does when the console asks: scroll, clear the selection, add a style, paint marks
 * (CSS Custom Highlights from offsets into its text), bring a mark on screen, and find text.
 *
 * Every message it takes is checked: it comes from the parent window, is one of the named
 * types, and has the fields that type needs, of the right kind and size. Every message it sends
 * the page's own scripts could send too, and the console checks them the same way.
 */

export const PREVIEW_BRIDGE_JS = String.raw`(function(){
'use strict';
if (window.parent === window || window.__walnutPreview) return;
window.__walnutPreview = 1;
var P = window.parent, D = document;
var MAX_TEXT = 4000000, MAX_ID = 64, MAX_ITEMS = 2000, MAX_RECT_IDS = 200, MAX_RECTS = 400, MAX_HREF = 8192;
function post(m){ m.walnutPreview = 1; try { P.postMessage(m, '*'); } catch (e) {} }
function isNum(x){ return typeof x === 'number' && isFinite(x); }
function isStr(x, max){ return typeof x === 'string' && x.length <= max; }
function isName(x){ return typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x); }
function box(r){ return { left: r.left, top: r.top, width: r.width, height: r.height }; }
function list(l){ var o = []; for (var k = 0; k < l.length && k < MAX_RECTS; k++) o.push([l[k].left, l[k].top, l[k].width, l[k].height]); return o; }
function reg(){ return window.CSS && CSS.highlights && window.Highlight ? CSS.highlights : null; }
/* WebKit keeps a highlight's words painted when it leaves the registry or is replaced, unless it
   is emptied first (web/src/utils/highlight-repaint.ts). */
function setHl(r, name, ranges, p){
  var old = r.get(name); if (old && old.clear) old.clear();
  if (!ranges.length) { r.delete(name); return; }
  var h = new Highlight(); for (var k = 0; k < ranges.length; k++) h.add(ranges[k]);
  h.priority = p; r.set(name, h);
}

/* The page's text, walked as the console's buildTextIndex walks a body (web/src/utils/
   text-quote-anchor.ts, dom-text-search.ts): text nodes under body, minus scripts, styles and
   controls. Anchors travel as offsets into it, tagged with its version v. */
var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
var SKIP_SEL = '.session-msg-actions, button, select, textarea, input';
function walk(skip){
  var nodes = [], starts = [], parts = [], len = 0;
  if (D.body) {
    var w = D.createTreeWalker(D.body, 4, { acceptNode: function(n){
      var p = n.parentElement;
      if (p && SKIP_TAGS[p.tagName] === 1) return 2;
      if (skip && p && p.closest(SKIP_SEL)) return 2;
      return 1;
    } });
    for (var n = w.nextNode(); n; n = w.nextNode()) { nodes.push(n); starts.push(len); parts.push(n.data); len += n.data.length; }
  }
  return { nodes: nodes, starts: starts, text: parts.join('') };
}
var idx = null, txt = null, v = 0, sentV = 0;
function index(){
  if (!idx) { idx = walk(true); if (idx.text !== txt) { txt = idx.text; v++; } }
  return idx;
}
function pushText(){
  var i = index();
  if (sentV === v) return;
  sentV = v;
  var over = i.text.length > MAX_TEXT;
  post({ type: 'text', v: v, text: over ? '' : i.text, over: over });
}
function nodeAt(i, off){
  var s = i.starts, lo = 0, hi = s.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (s[mid] <= off) lo = mid; else hi = mid - 1; }
  var node = i.nodes[lo]; return { node: node, off: Math.min(off - s[lo], node.data.length) };
}
function rangeOf(i, start, end){
  if (!(end > start)) return null;
  var a = nodeAt(i, start), b = nodeAt(i, end - 1);
  if (!a || !b) return null;
  try { var r = D.createRange(); r.setStart(a.node, a.off); r.setEnd(b.node, Math.min(b.off + 1, b.node.data.length)); return r; } catch (e) { return null; }
}
function offsetOf(i, c, o){
  for (var k = 0; k < i.nodes.length; k++) if (i.nodes[k] === c) return i.starts[k] + Math.min(o, c.data.length);
  var probe; try { probe = D.createRange(); probe.setStart(c, o); probe.collapse(true); } catch (e) { return 0; }
  for (var j = 0; j < i.nodes.length; j++) { try { if (probe.comparePoint(i.nodes[j], 0) >= 0) return i.starts[j]; } catch (e) {} }
  return i.text.length;
}
function isLive(r){ return !r.collapsed && r.startContainer.isConnected && r.endContainer.isConnected && r.startContainer.nodeType === 3 && r.endContainer.nodeType === 3; }

/* Selection. */
function selRange(){ var s = getSelection(); return s && !s.isCollapsed && s.rangeCount && String(s).trim() ? s.getRangeAt(0) : null; }
function selRect(){ var r = selRange(); return r ? box(r.getBoundingClientRect()) : null; }
addEventListener('mouseup', function(e){
  var r = selRange(), m = { type: 'selection', text: '', rect: null, x: e.clientX, y: e.clientY };
  if (r) {
    var i = index(); pushText();
    m.text = String(getSelection()).trim().slice(0, 20000); m.rect = box(r.getBoundingClientRect());
    m.v = v; m.start = offsetOf(i, r.startContainer, r.startOffset); m.end = offsetOf(i, r.endContainer, r.endOffset);
  }
  post(m);
});

/* Marks: groups of offsets the console located in the text, each painted under a highlight name. */
var groups = {}, painted = {}, hadRects = false;
function setMarks(d){
  if (!isName(d.group) || !isNum(d.v) || !Array.isArray(d.items)) return;
  var items = [];
  for (var k = 0; k < d.items.length && items.length < MAX_ITEMS; k++) {
    var m = d.items[k];
    if (!m || typeof m !== 'object' || !isStr(m.id, MAX_ID) || !(m.name === '' || isName(m.name)) || !isNum(m.start) || !isNum(m.end)) continue;
    items.push({ id: m.id, name: m.name, priority: isNum(m.priority) ? m.priority : 0, start: m.start, end: m.end,
      click: m.click === true, stop: m.stop === true, rects: m.rects === true, lines: m.lines === true, range: null });
  }
  if (items.length) groups[d.group] = { v: d.v, items: items }; else delete groups[d.group];
  repaint();
}
function each(fn){ Object.keys(groups).forEach(function(g){ groups[g].items.forEach(function(m){ fn(m, g, groups[g]); }); }); }
function repaint(){
  var i = index(), by = {};
  each(function(m, g, G){
    if (G.v === v) m.range = rangeOf(i, m.start, m.end);
    else if (m.range && !isLive(m.range)) m.range = null;
    if (!m.range || !m.name) return;
    (by[m.name] || (by[m.name] = { p: m.priority, r: [] })).r.push(m.range);
  });
  var r = reg();
  if (r) {
    Object.keys(painted).forEach(function(n){ if (!by[n]) setHl(r, n, [], 0); });
    painted = {};
    Object.keys(by).forEach(function(n){ setHl(r, n, by[n].r, by[n].p); painted[n] = 1; });
  }
  sendRects();
}
function textRects(r){
  var out = [];
  function push(n, a, b){ if (b <= a) return; var x = D.createRange(); x.setStart(n, a); x.setEnd(n, b); var l = x.getClientRects(); for (var k = 0; k < l.length; k++) out.push(l[k]); }
  var root = r.commonAncestorContainer;
  if (root.nodeType === 3) { push(root, r.startOffset, r.endOffset); return out; }
  var w = D.createTreeWalker(root, 4);
  for (var n = w.nextNode(); n; n = w.nextNode()) { if (r.intersectsNode(n)) push(n, n === r.startContainer ? r.startOffset : 0, n === r.endContainer ? r.endOffset : n.length); }
  return out;
}
function clipOf(r){
  var c = null, el = r.commonAncestorContainer;
  if (el.nodeType !== 1) el = el.parentElement;
  for (; el && el !== D.documentElement; el = el.parentElement) {
    var cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      var b = el.getBoundingClientRect();
      c = c ? [Math.max(c[0], b.left), Math.max(c[1], b.top), Math.min(c[2], b.right), Math.min(c[3], b.bottom)] : [b.left, b.top, b.right, b.bottom];
    }
  }
  return c;
}
var rt = 0;
function sendRects(){
  if (rt) return;
  rt = requestAnimationFrame(function(){
    rt = 0;
    var out = [];
    each(function(m, g){
      if (!(m.rects || m.lines) || out.length >= MAX_RECT_IDS) return;
      var e = { group: g, id: m.id, r: [] };
      if (m.range) { e.r = list(m.range.getClientRects()); if (m.lines) { e.t = list(textRects(m.range)); e.c = clipOf(m.range); } }
      out.push(e);
    });
    if (out.length || hadRects) post({ type: 'rects', marks: out });
    hadRects = out.length > 0;
  });
}
function inRects(l, x, y){ for (var k = 0; k < l.length; k++) { var b = l[k]; if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true; } return false; }
function hits(x, y){
  var out = [];
  Object.keys(groups).forEach(function(g){
    var items = groups[g].items;
    for (var k = 0; k < items.length; k++) {
      var m = items[k];
      if (m.click && m.range && inRects(m.range.getClientRects(), x, y)) { out.push({ group: g, id: m.id, stop: m.stop }); return; }
    }
  });
  return out;
}
function bare(h){ return h.map(function(x){ return { group: x.group, id: x.id }; }); }
function find(g, id){ var G = groups[g]; if (!G) return null; for (var k = 0; k < G.items.length; k++) if (G.items[k].id === id) return G.items[k]; return null; }
function scrollerOf(n){
  var el = n.nodeType === 1 ? n : n.parentElement;
  while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  return el || D.scrollingElement;
}
function reveal(m){
  if (!m || !m.range) return;
  var el = scrollerOf(m.range.startContainer); if (!el) return;
  var rect = m.range.getBoundingClientRect(), root = el === D.scrollingElement;
  var b = root ? { top: 0, height: innerHeight } : el.getBoundingClientRect();
  el.scrollTop += rect.top - (b.top + b.height / 2);
}
/* A click on a mark (with nothing selected) opens its card; one elsewhere lets the card go. */
addEventListener('click', function(e){
  if (e.button !== 0) return;
  var s = getSelection(); if (s && !s.isCollapsed) return;
  var h = hits(e.clientX, e.clientY);
  if (h.some(function(x){ return x.stop; })) { e.preventDefault(); e.stopPropagation(); }
  post({ type: 'click', hits: bare(h) });
}, true);
var hoverKey = '', hv = 0, hp = null;
function hover(h){
  var key = h.map(function(x){ return x.group + ' ' + x.id; }).join('\n');
  if (key === hoverKey) return;
  hoverKey = key;
  if (h.length) D.documentElement.setAttribute('data-walnut-mark-hover', ''); else D.documentElement.removeAttribute('data-walnut-mark-hover');
  post({ type: 'hover', hits: bare(h) });
}
addEventListener('pointermove', function(e){
  if (e.buttons || e.pointerType === 'touch' || !Object.keys(groups).length) return;
  hp = [e.clientX, e.clientY];
  if (!hv) hv = requestAnimationFrame(function(){ hv = 0; hover(hits(hp[0], hp[1])); });
}, { passive: true, capture: true });
D.addEventListener('mouseout', function(e){ if (!e.relatedTarget) hover([]); });

/* Find (⌘F), painted under the console's search highlight names. */
var F = { q: '', cs: false, ranges: [], active: -1 };
function fold(s){
  if (!/[^\x00-\x7F]/.test(s)) return s.toLowerCase();
  var o = ''; for (var ch of s) { var l = ch.toLowerCase(); o += l.length === ch.length ? l : ch; } return o;
}
function paintFind(){ var r = reg(); if (!r) return; setHl(r, 'walnut-search', F.ranges, 10); setHl(r, 'walnut-search-active', F.active >= 0 ? [F.ranges[F.active]] : [], 11); }
function toActive(){ var r = F.ranges[F.active]; if (!r) return; var b = r.getBoundingClientRect(); scrollTo({ top: b.top + scrollY - innerHeight / 2 }); }
function findResult(){ post({ type: 'find-result', count: F.ranges.length, index: F.active + 1 }); }
function findRun(q, cs){
  var same = q === F.q && cs === F.cs, prev = F.active, ranges = [];
  if (q) {
    var i = walk(false), h = cs ? i.text : fold(i.text), n = cs ? q : fold(q), at = 0;
    while (ranges.length < 5000 && (at = h.indexOf(n, at)) !== -1) { var r = rangeOf(i, at, at + q.length); if (r) ranges.push(r); at += Math.max(1, n.length); }
  }
  F = { q: q, cs: cs, ranges: ranges, active: !ranges.length ? -1 : same && prev >= 0 ? Math.min(prev, ranges.length - 1) : 0 };
  paintFind();
  if (F.active >= 0 && !same) toActive();
  findResult();
}
function findNav(dir){ var n = F.ranges.length; if (n) { F.active = (F.active + dir + n) % n; paintFind(); toActive(); } findResult(); }

/* Styles the console adds (its mark and search paint). */
function setStyle(id, css){
  var el = D.querySelector('style[data-walnut-preview-style="' + id + '"]');
  if (!el) { el = D.createElement('style'); el.setAttribute('data-walnut-preview-style', id); (D.head || D.documentElement).appendChild(el); }
  if (el.textContent !== css) el.textContent = css;
}

/* Links: the console opens a file of this host in its panel, a link a plugin handles there, and
   knows which links a plugin handles before a click needs it (probe). */
var handled = {}, nHandled = 0;
function anchorOf(t){ return t && t.closest ? t.closest('a[href]') : null; }
function probe(e){ var a = anchorOf(e.target); if (a && !(a.href in handled) && a.href.length <= MAX_HREF) post({ type: 'probe', href: a.href }); }
addEventListener('pointerover', probe, true);
addEventListener('pointerdown', function(e){
  probe(e);
  var a = anchorOf(e.target); if (a && a.href.length <= MAX_HREF) post({ type: 'press', href: a.href });
}, true);
addEventListener('click', function(e){
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  var a = anchorOf(e.target); if (!a || a.hasAttribute('download')) return;
  var u; try { u = new URL(a.href, location.href); } catch (x) { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  var target = (a.getAttribute('target') || '').toLowerCase();
  var self = !target || target === '_self';
  if (handled[u.href] === true) { e.preventDefault(); post({ type: 'link', href: u.href, handled: true }); return; }
  if (u.origin !== location.origin) {
    if (!self) return;
    e.preventDefault(); window.open(u.href, '_blank', 'noopener,noreferrer'); post({ type: 'external', href: u.href }); return;
  }
  if (!self || (u.pathname === location.pathname && u.search === location.search && u.hash)) return;
  e.preventDefault(); post({ type: 'link', href: u.href });
});
/* The console's link menu for a link a plugin handles. WebKit selects the word under a right
   press: what was selected before is put back. */
var pressSel = null;
addEventListener('pointerdown', function(e){
  if (e.button !== 2) return;
  var s = getSelection(); pressSel = s && s.rangeCount && !s.isCollapsed ? s.getRangeAt(0).cloneRange() : null;
}, true);
addEventListener('contextmenu', function(e){
  if (e.defaultPrevented) return;
  var a = anchorOf(e.target); if (!a || handled[a.href] !== true) return;
  e.preventDefault();
  var s = getSelection(); if (s) { s.removeAllRanges(); if (pressSel) s.addRange(pressSel); }
  post({ type: 'link-menu', href: a.href, x: e.clientX, y: e.clientY });
});

/* Scroll, the reader's own moves, keys. */
var st = 0;
addEventListener('scroll', function(){
  if (st) return;
  st = setTimeout(function(){ st = 0; post({ type: 'scroll', top: scrollY, rect: selRect() }); }, 80);
}, { passive: true });
D.addEventListener('scroll', sendRects, { capture: true, passive: true });
addEventListener('resize', sendRects);
var ut = 0;
function user(){ var n = Date.now(); if (n - ut > 300) { ut = n; post({ type: 'user' }); } }
addEventListener('wheel', user, { passive: true });
addEventListener('touchstart', user, { passive: true });
addEventListener('pointerdown', user, true);
addEventListener('keydown', function(e){
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); post({ type: 'find-key' }); return; }
  if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) post({ type: 'escape' }); else user();
});

/* The console's requests. */
addEventListener('message', function(e){
  if (e.source !== P) return;
  var d = e.data;
  if (!d || typeof d !== 'object' || d.walnutPreview !== 1 || typeof d.type !== 'string') return;
  switch (d.type) {
    case 'scroll-to': if (isNum(d.top)) scrollTo(0, d.top); break;
    case 'scroll-by': if (isNum(d.dy)) scrollBy(0, d.dy); break;
    case 'clear-selection': try { getSelection().removeAllRanges(); } catch (x) {} break;
    case 'handled':
      if (isStr(d.href, MAX_HREF) && typeof d.handled === 'boolean' && nHandled < 5000) { if (!(d.href in handled)) nHandled++; handled[d.href] = d.handled; }
      break;
    case 'style': if (isName(d.id) && isStr(d.css, 20000)) setStyle(d.id, d.css); break;
    case 'marks': setMarks(d); break;
    case 'reveal': if (isName(d.group) && isStr(d.id, MAX_ID)) reveal(find(d.group, d.id)); break;
    case 'find': if (isStr(d.query, 1000) && typeof d.caseSensitive === 'boolean') findRun(d.query, d.caseSensitive); break;
    case 'find-nav': if (d.dir === 1 || d.dir === -1) findNav(d.dir); break;
    case 'find-close': F = { q: '', cs: false, ranges: [], active: -1 }; paintFind(); break;
  }
});

/* The page changing: its text is walked again, sent when it changed, and the marks re-placed. */
var mt = 0;
new MutationObserver(function(){
  idx = null;
  if (!mt) mt = setTimeout(function(){ mt = 0; pushText(); repaint(); }, 150);
}).observe(D.documentElement, { childList: true, subtree: true, characterData: true });
function ready(){
  post({ type: 'ready', href: location.href, top: scrollY });
  pushText();
  if (window.ResizeObserver) { var ro = new ResizeObserver(sendRects); ro.observe(D.documentElement); if (D.body) ro.observe(D.body); }
}
if (D.readyState === 'complete') ready(); else addEventListener('load', ready);
})();`
