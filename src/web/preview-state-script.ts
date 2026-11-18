/**
 * A page in the Files preview keeps what a browser keeps for it, and its place.
 *
 * 2026-11-17, the user, reading an agent's step-by-step HTML page in the preview when the agent
 * wrote the file again: "all the progress i have in that page is lost ... like I am in 3rd tab".
 * 2026-11-18, the user again: "how about regular browser storage like cache etc, these should be
 * same as well right". The page runs in an opaque origin (untrusted-doc.ts: it must never read
 * Walnut's sign-in, cookies or storage), where every storage API of the browser throws. So this
 * script, put into the page before its own first script (preview-bridge.ts), gives it each one
 * (src/web/preview-storage-apis.ts lists them, and the ones it cannot have, with why):
 *  - `localStorage` and `sessionStorage`, each its own store (src/lib/page-storage-shim.ts);
 *  - `document.cookie` and `cookieStore` (preview-runtime/cookie-script.ts), page-only;
 *  - IndexedDB (preview-runtime/idb-script.ts) and the Cache API (preview-runtime/cache-script.ts);
 *  - `navigator.storage` and the storage-access calls, answering as a page with its own storage;
 *  - its URL hash and its place in the DOM (preview-dom-state-script.ts).
 * All of it is back before the page's first line runs.
 *
 * Where it lives (src/lib/preview-state-envelope.ts): what a browser keeps for a site goes to disk
 * per file, sent through the console (the server puts it back into the page it serves, `SEED`),
 * so it outlives a reload of Walnut and a restart of the app; what a browser keeps for a tab
 * (sessionStorage, session cookies) stays with this Walnut window; and the frame's `window.name`
 * carries all of it from one document of the frame to the next (the page's own name is kept inside
 * and handed back to the page). The newer of the frame's copy and the disk's wins. A copy is used
 * only by the file it was written for, and only a frame Walnut's console holds itself hands its
 * state on (a page framing another file gets nothing of it).
 *
 * Plain ES5 in a string, like the bridge it runs before.
 */
import { PAGE_STORAGE_SHIM_JS } from '../lib/page-storage-shim.js'
import { PREVIEW_NAME_MAX, PREVIEW_SESSION_MAX, PREVIEW_STATE_MAX, PREVIEW_STATE_PREFIX } from '../lib/preview-state-envelope.js'
import { PREVIEW_CODEC_JS } from './preview-runtime/codec-script.js'
import { PREVIEW_COOKIE_JS } from './preview-runtime/cookie-script.js'
import { PREVIEW_CACHE_JS } from './preview-runtime/cache-script.js'
import { PREVIEW_IDB_JS } from './preview-runtime/idb-script.js'
import { PREVIEW_DOM_STATE_JS } from './preview-dom-state-script.js'

/**
 * A function expression the bridge calls. The disk copy of the page's state is in the data block
 * before it (`script[data-walnut-seed]`, preview-bridge.ts), written with every `<` escaped.
 */
export const PREVIEW_STATE_JS = String.raw`(function(){
'use strict';
if (window.parent === window || window.__walnutPreviewState) return;
var D = document, W = window, PFX = ${JSON.stringify(PREVIEW_STATE_PREFIX)};
var MAX = ${PREVIEW_STATE_MAX}, SMAX = ${PREVIEW_SESSION_MAX}, NMAX = ${PREVIEW_NAME_MAX};
var HIDE_MS = 1500, CHASE_MS = 5000;
var me = { restored: false };
try { Object.defineProperty(W, '__walnutPreviewState', { value: me }); } catch (e) {}
var here = location.pathname;
/* Only the console's own frame gets its state and hands it on: a page framing another file, or
   another site framing this one, gets none of it (not the disk's copy, not one in the frame's name). */
var ao = location.ancestorOrigins;
var handsOn = W.parent === W.top && (!ao || ao[0] === location.origin);
var SEED = null;
try {
  var sb = D.querySelector('script[data-walnut-seed]');
  if (sb) { if (handsOn) SEED = JSON.parse(sb.textContent || 'null'); sb.parentNode.removeChild(sb); }
} catch (x) { SEED = null; }

/* The copies: the frame's name (the last document of this frame), the disk's (SEED). */
function ours(e){ return !!e && typeof e === 'object' && e.v === 2 && e.p === here; }
var fromName = null, pageName = '';
try {
  var nm = String(W.name || '');
  if (nm.indexOf(PFX) === 0) {
    var e0 = JSON.parse(nm.slice(PFX.length));
    pageName = e0 && typeof e0.n === 'string' ? e0.n : '';
    W.name = pageName;
    if (ours(e0) && handsOn) fromName = e0;
  } else pageName = nm;
} catch (x) { try { W.name = ''; } catch (y) {} }
var fromDisk = ours(SEED) ? SEED : null;
var newer = fromName && (!fromDisk || (+fromName.t || 0) >= (+fromDisk.t || 0)) ? fromName : fromDisk;
var older = newer === fromName ? fromDisk : fromName;
/* A part the newer copy lacks (too big for the frame's name) comes from the other; a part it has
   as null (clicks not to put back again) is its answer. */
function pick(k){ var a = newer ? newer[k] : undefined; return a !== undefined ? a : older ? older[k] : undefined; }
function strings(o){
  var m = Object.create(null);
  if (o && typeof o === 'object') for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'string') m[k] = o[k];
  return m;
}
function cookies(list, keep){
  var out = [];
  if (Array.isArray(list)) list.forEach(function(c){
    if (c && typeof c.n === 'string' && typeof c.v === 'string' && keep(+c.e || 0)) out.push({ n: c.n, v: c.v, e: +c.e || 0, p: typeof c.p === 'string' ? c.p : '/' });
  });
  return out;
}
var LS = strings(pick('ls'));
var SS = strings(fromName && fromName.ss);
/* The tab's copy names its session cookies sk, so they never stand for the site's ck. */
var JAR = cookies(pick('ck'), function(e){ return e > 0; }).concat(cookies(fromName && (fromName.sk || fromName.ck), function(e){ return e === 0; }));
var CA = pick('ca'); if (!CA || typeof CA !== 'object' || Array.isArray(CA)) CA = {};
var IDB0 = pick('idb');
var HASH = pick('h');
var DOM0 = pick('s'); if (!DOM0 || typeof DOM0 !== 'object') DOM0 = null;

/* The page's storage, each API over its part. */
${PAGE_STORAGE_SHIM_JS}
${PREVIEW_CODEC_JS}
${PREVIEW_COOKIE_JS}
${PREVIEW_CACHE_JS}
${PREVIEW_IDB_JS}
var sandboxed = false, idb = null;
try { W.localStorage.length; } catch (x) { sandboxed = true; }
if (sandboxed) {
  wnPutStorage('localStorage', wnStore(LS, dirty));
  wnPutStorage('sessionStorage', wnStore(SS, dirty));
  wnCookies(JAR, dirty);
  wnCaches(CA, dirty);
  idb = wnIdb(Array.isArray(IDB0) ? IDB0 : null, dirty);
  var sm = {
    estimate: function(){ var j = sent.persist || ''; return Promise.resolve({ usage: j.length, quota: MAX }); },
    persist: function(){ return Promise.resolve(true); },
    persisted: function(){ return Promise.resolve(true); },
    getDirectory: function(){ return Promise.reject(new DOMException('The Files preview keeps no file system for a page', 'NotSupportedError')); }
  };
  try { Object.defineProperty(navigator, 'storage', { configurable: true, value: sm }); } catch (x) {}
  var yes = function(){ return Promise.resolve(true); }, done = function(){ return Promise.resolve(); };
  [['hasStorageAccess', yes], ['hasUnpartitionedCookieAccess', yes], ['requestStorageAccess', done], ['requestStorageAccessFor', done]].forEach(function(p){
    try { Object.defineProperty(D, p[0], { configurable: true, writable: true, value: p[1] }); } catch (x) {}
  });
}

/* The hash. */
if (typeof HASH === 'string' && HASH.length > 1 && HASH.charAt(0) === '#' && !location.hash) {
  try { history.replaceState(history.state, '', HASH); } catch (x) {}
}

${PREVIEW_DOM_STATE_JS}

/* The copies again, after every change. */
function parts(withName){
  var t = Date.now();
  var p = { v: 2, p: here, t: t, h: location.hash || '', s: dropDom ? null : snapDom(), ls: LS,
    ck: JAR.filter(function(c){ return c.e > 0; }), idb: idb ? idb.dump() : (Array.isArray(IDB0) ? IDB0 : []), ca: CA };
  /* Every < escaped: the server puts this text into a script element as it is (preview-bridge.ts). */
  var persist = JSON.stringify(p).replace(/</g, '\u003c');
  /* Too big for the disk: nothing is sent, and the disk keeps its last whole copy (a copy without
     a part would empty that part there). */
  if (persist.length > MAX) persist = '';
  var sess = { v: 2, p: here, t: t, ss: SS, sk: JAR.filter(function(c){ return !c.e; }) };
  var session = JSON.stringify(sess);
  if (session.length > SMAX) session = '';
  var name = '';
  if (withName) {
    var all = { v: 2, p: here, t: t, n: pageName, h: p.h, s: p.s, ls: LS, ss: SS, ck: JAR, idb: p.idb, ca: p.ca };
    name = JSON.stringify(all);
    /* Too big for the frame's name: the next document takes those two from the disk's copy. */
    if (name.length > NMAX) { delete all.idb; delete all.ca; name = JSON.stringify(all); }
    if (name.length > NMAX) name = '';
  }
  return { persist: persist, session: session, name: name };
}
var dt = 0, gone = false, sent = { persist: '', session: '' };
function post(r){
  if (!handsOn || (r.persist === sent.persist && r.session === sent.session)) return;
  sent = { persist: r.persist, session: r.session };
  /* To Walnut's own window only: location.origin is the URL's, while this document's is opaque. */
  try { W.parent.postMessage({ walnutPreview: 1, type: 'page-state', persist: r.persist, session: r.session }, location.origin); } catch (x) {}
}
function send(){ dt = 0; if (gone || restoring) return; post(parts()); }
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
  var r = parts(handsOn);
  gone = true;
  if (r.name) { try { W.name = PFX + r.name; } catch (x) {} }
  post(r);
});
['click', 'change', 'input', 'toggle', 'hashchange', 'keyup'].forEach(function(t){ W.addEventListener(t, dirty, true); });
})`
