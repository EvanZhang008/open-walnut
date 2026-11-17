/**
 * The page's own state, carried across a reload of the Files preview.
 *
 * 2026-11-17, the user, reading an agent's step-by-step HTML page in the preview when the agent
 * wrote the file again: "all the progress i have in that page is lost ... like I am in 3rd tab".
 * The preview loads the file again on every write (FileContentView's diskVersion), and the new
 * document starts from its top, on its first tab, with nothing selected. The page cannot keep
 * anything itself: it runs in an opaque origin (untrusted-doc.ts), where its storage throws.
 *
 * So this script, put into the page before its own first script (preview-bridge.ts), keeps:
 *  - the page's `localStorage` / `sessionStorage` (one store, src/lib/page-storage-shim.ts),
 *    filled before the page's first line runs, so a page that keeps its state there gets it back;
 *  - its URL hash, put back before the page's first line too (a page that keeps a step in it);
 *  - what can be read off the DOM in any page: the window's and every scrolled box's scroll
 *    position, the items on show marked selected, current, pressed or expanded (an aria state, or
 *    a class like `active`), open `<details>`, checked boxes and radios, typed values. After the
 *    page has drawn itself it is put back: an item by clicking it the way the reader did (so the
 *    page's own code shows what goes with it), a value with the events a typed one fires.
 *    An element is found by its id, or else its path from the nearest id, checked by its text;
 *    one that is gone or changed is skipped, quietly.
 * While that happens the page stays invisible (at most RESTORE_HIDE_MS), so it never shows its top
 * and then jumps.
 *
 * Where it lives between documents: `window.name` of the frame, which a navigation of the same
 * frame keeps (the page's own name is kept inside it and handed back to the page), and a copy the
 * console holds per file (preview-frame.ts `pageStateFor`), which it names a new frame with, for
 * the next open of the file. An envelope is used only by the file it was written for.
 *
 * Plain ES5 in a string, like the bridge it runs before.
 */
import { PAGE_STORAGE_SHIM_JS } from '../lib/page-storage-shim.js'
import { PREVIEW_STATE_MAX, PREVIEW_STATE_PREFIX } from '../lib/preview-state-envelope.js'

export const PREVIEW_STATE_JS = String.raw`(function(){
'use strict';
if (window.parent === window || window.__walnutPreviewState) return;
var D = document, W = window, PFX = ${JSON.stringify(PREVIEW_STATE_PREFIX)}, MAX = ${PREVIEW_STATE_MAX};
var HIDE_MS = 1500, CHASE_MS = 5000;
var me = { restored: false };
try { Object.defineProperty(W, '__walnutPreviewState', { value: me }); } catch (e) {}
var here = location.pathname;

/* The envelope the last document of this frame left, if it was this file's. */
var env = null, pageName = '';
try {
  var nm = String(W.name || '');
  if (nm.indexOf(PFX) === 0) {
    var e0 = JSON.parse(nm.slice(PFX.length));
    pageName = e0 && typeof e0.n === 'string' ? e0.n : '';
    W.name = pageName;
    if (e0 && e0.v === 1 && e0.p === here) env = e0;
  } else pageName = nm;
} catch (x) { try { W.name = ''; } catch (y) {} }

/* Storage. */
var m = Object.create(null), has = Object.prototype.hasOwnProperty;
if (env && env.ls && typeof env.ls === 'object') for (var k0 in env.ls) if (has.call(env.ls, k0) && typeof env.ls[k0] === 'string') m[k0] = env.ls[k0];
${PAGE_STORAGE_SHIM_JS}
var blocked = false;
try { W.localStorage.length; } catch (x) { blocked = true; }
if (blocked) wnInstallStorage(m, dirty);

/* The hash. */
if (env && typeof env.h === 'string' && env.h.length > 1 && !location.hash) {
  try { history.replaceState(history.state, '', env.h); } catch (x) {}
}

/* Paths: from the nearest element with an id, each step a tag and its index among siblings of
   that tag; with a little of the element's text to check it by. */
function fp(el){ return String(el.textContent || '').slice(0, 400).replace(/\s+/g, ' ').trim().slice(0, 80); }
function uniqueId(el){ return el.id && D.getElementById(el.id) === el && el.id.length <= 200; }
function pathOf(el){
  var out = [];
  for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (uniqueId(e)) { out.unshift('#' + e.id); return out; }
    if (e === D.documentElement) return out;
    var i = 0, s = e; while ((s = s.previousElementSibling)) if (s.tagName === e.tagName) i++;
    out.unshift(e.tagName.toLowerCase() + ':' + i);
    if (out.length > 40) return null;
  }
  return out;
}
function atPath(p){
  if (!p || !p.length) return null;
  var el = D.documentElement, k = 0;
  if (p[0].charAt(0) === '#') { el = D.getElementById(p[0].slice(1)); k = 1; }
  for (; el && k < p.length; k++) {
    var c = p[k].split(':'), tag = c[0].toUpperCase(), n = +c[1], hit = null;
    for (var ch = el.firstElementChild; ch; ch = ch.nextElementSibling) if (ch.tagName === tag && n-- === 0) { hit = ch; break; }
    el = hit;
  }
  return el;
}
/* The element a saved entry names, now: at its path when its text agrees; else the one element of
   its tag under the same parent path whose text does; else at its path when nothing has that text
   (the item is still there, its words were rewritten). */
function resolve(r){
  var el = atPath(r.p);
  if (el && (r.t === undefined || fp(el) === r.t)) return el;
  if (r.t !== undefined && r.p.length) {
    var parent = atPath(r.p.slice(0, -1)), last = r.p[r.p.length - 1];
    var tag = last.charAt(0) === '#' ? null : last.split(':')[0].toUpperCase();
    if (parent && tag) {
      var same = [];
      for (var ch = parent.firstElementChild; ch; ch = ch.nextElementSibling) if (ch.tagName === tag && fp(ch) === r.t) same.push(ch);
      if (same.length === 1) return same[0];
      if (same.length > 1) return null;
    }
  }
  return el && (!r.tag || el.tagName === r.tag) ? el : null;
}
/* A form field: at its path when its name and type agree, else the one field of that name and
   type (a field added before it moves its path); none when its name is not unique. */
function field(r){
  var ok = function(el){ return !!el && el.tagName === r.tag && (el.name || '') === (r.nm || '') && (el.type || '').toLowerCase() === (r.ty || ''); };
  var el = atPath(r.p);
  if (ok(el)) return el;
  if (!r.nm) return null;
  var byName = D.getElementsByName(r.nm), hit = null, n = 0;
  for (var k = 0; k < byName.length; k++) if (ok(byName[k])) { hit = byName[k]; n++; }
  return n === 1 ? hit : null;
}
function shown(el){ return el.getClientRects().length > 0; }

/* What the reader picked: aria states and class tokens that say "this one". */
var CLS = /^(is-)?(active|selected|current|checked|expanded|open|chosen)$/i;
var MARK_SEL = '[aria-selected="true"],[aria-current]:not([aria-current="false"]),[aria-pressed="true"],[aria-expanded="true"],[aria-checked="true"],[class]';
function marksOf(el){
  var out = [];
  ['aria-selected', 'aria-pressed', 'aria-expanded', 'aria-checked'].forEach(function(a){ if (el.getAttribute(a) === 'true') out.push(a); });
  var cur = el.getAttribute('aria-current'); if (cur && cur !== 'false') out.push('aria-current');
  var cl = el.classList; if (cl) for (var i = 0; i < cl.length; i++) if (CLS.test(cl[i])) out.push('.' + cl[i]);
  return out;
}
function hasMark(el, mk){
  if (mk.charAt(0) === '.') return el.classList.contains(mk.slice(1));
  var v = el.getAttribute(mk);
  return mk === 'aria-current' ? !!v && v !== 'false' : v === 'true';
}
/* Clicking it does what the reader's click did, and nothing that leaves the page or sends it. */
function clickable(el){
  var t = el.tagName;
  if (t === 'A') { var h = (el.getAttribute('href') || '').trim(); if (h && h !== '#' && !/^javascript:/i.test(h)) return false; }
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || t === 'OPTION' || t === 'FORM' || t === 'BODY' || t === 'HTML') return false;
  // Their state is the <details>' and the box's, put back directly: a click would toggle it again.
  if (t === 'SUMMARY' || t === 'LABEL' || el.closest('summary, label')) return false;
  if (t === 'BUTTON' && el.form && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit') return false;
  if (el.closest('a[href]:not([href="#"]):not([href^="javascript:"])')) return false;
  if (t === 'A' || t === 'BUTTON' || t === 'LI' || t === 'TR' || t === 'TD' || t === 'TH') return true;
  if (el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('onclick')) return true;
  try { return getComputedStyle(el).cursor === 'pointer'; } catch (x) { return false; }
}

/* Scrolled boxes, as the reader scrolls them. */
var scrolled = [];
D.addEventListener('scroll', function(e){
  var t = e.target;
  if (t && t.nodeType === 1 && scrolled.indexOf(t) < 0 && scrolled.length < 60) scrolled.push(t);
  dirty(e);
}, { capture: true, passive: true });

/* The DOM's state now. Null while the page has no layout (a hidden frame): the last one stays. */
var dropDom = false, lastDom = env && env.s && typeof env.s === 'object' ? env.s : null;
function snapDom(){
  if (!innerWidth || !innerHeight || !D.body) return lastDom;
  // While its place is still being held, the place is the one being put back (a page still
  // growing clamps the window's offset).
  var held = restoring && !userMoved && S;
  var s = { x: held ? +S.x || 0 : scrollX, y: held ? +S.y || 0 : scrollY, sc: [], mk: [], dt: [], f: [] };
  for (var i = 0; i < scrolled.length; i++) {
    var b = scrolled[i];
    if (b.isConnected && (b.scrollTop || b.scrollLeft)) { var bp = pathOf(b); if (bp) s.sc.push({ p: bp, x: b.scrollLeft, y: b.scrollTop }); }
  }
  var all = D.querySelectorAll(MARK_SEL);
  for (var j = 0; j < all.length && s.mk.length < 300; j++) {
    var el = all[j], mk = marksOf(el);
    if (!mk.length || !shown(el) || !clickable(el)) continue;
    var p = pathOf(el); if (p) s.mk.push({ p: p, t: fp(el), tag: el.tagName, m: mk });
  }
  var ds = D.querySelectorAll('details');
  for (var d = 0; d < ds.length && d < 500; d++) { var dp = pathOf(ds[d]); if (dp) s.dt.push({ p: dp, o: ds[d].open }); }
  var fs = D.querySelectorAll('input,textarea,select');
  for (var q = 0; q < fs.length && s.f.length < 300; q++) {
    var f = fs[q], ty = (f.type || '').toLowerCase(), r = null;
    if (ty === 'password' || ty === 'file' || ty === 'hidden' || ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') continue;
    if (ty === 'checkbox' || ty === 'radio') { if (f.checked !== f.defaultChecked) r = { c: f.checked }; }
    else if (f.tagName === 'SELECT') { var dirtySel = false; for (var o = 0; o < f.options.length; o++) if (f.options[o].selected !== f.options[o].defaultSelected) dirtySel = true; if (dirtySel) r = { i: f.selectedIndex }; }
    else if (f.value !== f.defaultValue && f.value.length <= 20000) r = { val: f.value };
    if (!r) continue;
    var fpth = pathOf(f); if (!fpth) continue;
    r.p = fpth; r.tag = f.tagName; r.nm = f.name || ''; r.ty = ty; s.f.push(r);
  }
  return (lastDom = s);
}
function envelope(){
  var e = { v: 1, p: here, n: pageName, h: location.hash || '', s: dropDom ? null : snapDom(), ls: m };
  var j = JSON.stringify(e);
  if (j.length > MAX) { e.ls = {}; j = JSON.stringify(e); }
  return j.length > MAX ? null : j;
}

/* Kept: in the frame's name when the document goes, and with the console after every change. */
var dt = 0, gone = false, sent = '';
function post(j){ if (j === sent) return; sent = j; try { W.parent.postMessage({ walnutPreview: 1, type: 'page-state', state: j }, '*'); } catch (x) {} }
function send(){ dt = 0; if (gone || restoring) return; var j = envelope(); if (j) post(j); }
/* A scroll comes in bursts and changes only offsets: it waits longer than a click. */
function dirty(e){ if (!dt && !gone) dt = setTimeout(send, e && e.type === 'scroll' ? 1000 : 300); }
W.addEventListener('pagehide', function(){
  if (gone) return;
  // A name the console gave the frame since (Chromium applies a changed name attribute to the
  // live frame) is an envelope, not the page's own.
  var nm2 = String(W.name || ''); if (nm2.indexOf(PFX) !== 0) pageName = nm2;
  // Left while being put back (a restored click that navigates, or reloads the page): the next
  // document gets the storage and the hash, not the clicks again.
  if (clicking) dropDom = true;
  var j = envelope();
  gone = true;
  if (!j) return;
  try { W.name = PFX + j; } catch (x) {}
  post(j);
});
['click', 'change', 'input', 'toggle', 'hashchange', 'keyup'].forEach(function(t){ W.addEventListener(t, dirty, true); });

/* Putting it back. */
var S = env && env.s && typeof env.s === 'object' ? env.s : null;
var restoring = !!S, clicking = !!S, tried = {}, hide = null, userMoved = false;
me.restored = !!S;
if (S) {
  hide = D.createElement('style');
  hide.textContent = 'html{opacity:0 !important}';
  (D.head || D.documentElement).appendChild(hide);
  setTimeout(reveal, HIDE_MS);
}
function reveal(){ if (hide) { if (hide.parentNode) hide.parentNode.removeChild(hide); hide = null; } }
function fire(el, t){ try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (x) {} }
function scrollTo2(x, y){ try { W.scrollTo({ left: x, top: y, behavior: 'instant' }); } catch (e) { W.scrollTo(x, y); } }
function apply(pass){
  if (!S) return;
  var i, el;
  if (Array.isArray(S.f)) for (i = 0; i < S.f.length; i++) {
    var r = S.f[i]; if (!r || tried['f' + i]) continue;
    el = field(r); if (!el) continue;
    tried['f' + i] = 1;
    if (typeof r.c === 'boolean') { if (el.checked !== r.c) { el.checked = r.c; fire(el, 'input'); fire(el, 'change'); } }
    else if (typeof r.i === 'number' && el.tagName === 'SELECT') { if (el.selectedIndex !== r.i && r.i < el.options.length) { el.selectedIndex = r.i; fire(el, 'input'); fire(el, 'change'); } }
    else if (typeof r.val === 'string' && 'value' in el) { if (el.value !== r.val) { el.value = r.val; fire(el, 'input'); fire(el, 'change'); } }
  }
  if (Array.isArray(S.dt)) for (i = 0; i < S.dt.length; i++) {
    var d = S.dt[i]; if (!d || tried['d' + i]) continue;
    el = resolve(d); if (!el || el.tagName !== 'DETAILS') continue;
    tried['d' + i] = 1;
    if (el.open !== !!d.o) el.open = !!d.o;
  }
  /* One click per item and pass, only while it is not marked: a page that sets its first tab in
     its load handler undoes the first pass, and a click on a marked item could toggle it off. */
  if (Array.isArray(S.mk)) for (i = 0; i < S.mk.length; i++) {
    var it = S.mk[i]; if (!it || !Array.isArray(it.m) || tried['m' + i] === pass) continue;
    el = resolve(it); if (!el) continue;
    var ok = false; for (var q = 0; q < it.m.length; q++) if (typeof it.m[q] === 'string' && hasMark(el, it.m[q])) ok = true;
    if (ok) continue;
    if (tried['m' + i] || !clickable(el)) { tried['m' + i] = pass; continue; }
    tried['m' + i] = pass;
    try { el.click(); } catch (x) {}
  }
  if (Array.isArray(S.sc)) for (i = 0; i < S.sc.length; i++) {
    var sc = S.sc[i]; if (!sc) continue;
    el = resolve(sc); if (el) { el.scrollLeft = +sc.x || 0; el.scrollTop = +sc.y || 0; }
  }
  if (!userMoved) scrollTo2(+S.x || 0, +S.y || 0);
}
/* The page lays out further after load (images, fonts): the window's place is held for a moment,
   until the reader moves. */
function chase(){
  var until = Date.now() + CHASE_MS;
  (function tick(){
    if (userMoved || Date.now() > until) { restoring = false; dirty(); return; }
    if (Math.abs(scrollY - (+S.y || 0)) > 1 || Math.abs(scrollX - (+S.x || 0)) > 1) scrollTo2(+S.x || 0, +S.y || 0);
    setTimeout(tick, 100);
  })();
}
function moved(){ userMoved = true; }
if (S) {
  W.addEventListener('wheel', moved, { passive: true, capture: true });
  W.addEventListener('touchstart', moved, { passive: true, capture: true });
  W.addEventListener('keydown', moved, true);
  W.addEventListener('pointerdown', moved, true);
  /* After the page's own handlers of the same event: they draw the page. */
  D.addEventListener('DOMContentLoaded', function(){ setTimeout(function(){ apply(1); }, 0); });
  W.addEventListener('load', function(){ setTimeout(function(){ apply(2); clicking = false; reveal(); chase(); }, 0); });
}
})();`
