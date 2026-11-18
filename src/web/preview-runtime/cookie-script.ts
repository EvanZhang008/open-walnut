/**
 * `document.cookie` and `cookieStore` for a page in the Files preview (preview-state-script.ts puts
 * it in). The page runs in an opaque origin, where Chromium throws on `document.cookie` and WebKit
 * drops every write. These cookies live in the page only: they are never sent with a request (a
 * page opened from a file has none either), and never mix with Walnut's own.
 *
 * Plain ES5 in a string. `wnCookies(jar, dirty)` installs both over the jar, an array of
 * `{ n: name, v: value, e: expiry in ms (0: a session cookie), p: path }`, and calls `dirty()` on
 * every change. Expired cookies drop out on the next read.
 */
export const PREVIEW_COOKIE_JS = String.raw`function wnCookies(jar, dirty){
  function now(){ return Date.now(); }
  function live(){
    var t = now(), out = [];
    for (var i = 0; i < jar.length; i++) if (!jar[i].e || jar[i].e > t) out.push(jar[i]);
    if (out.length !== jar.length) { jar.length = 0; Array.prototype.push.apply(jar, out); }
    return jar;
  }
  function onPath(c){ var p = c.p || '/', here = location.pathname; return here === p || here.indexOf(p.charAt(p.length - 1) === '/' ? p : p + '/') === 0; }
  function put(name, value, expires, path){
    path = path || '/';
    for (var i = 0; i < jar.length; i++) if (jar[i].n === name && (jar[i].p || '/') === path) { jar.splice(i, 1); break; }
    if (expires && expires <= now()) { dirty(); return; }
    if (jar.length >= 300) jar.shift();
    jar.push({ n: name, v: value, e: expires || 0, p: path });
    dirty();
  }
  function parse(str){
    var parts = String(str).split(';'), first = parts.shift(), eq = first.indexOf('=');
    var name = (eq < 0 ? '' : first.slice(0, eq)).trim(), value = (eq < 0 ? first : first.slice(eq + 1)).trim();
    if (name.length + value.length > 4096) return;
    var expires = 0, path = '';
    for (var i = 0; i < parts.length; i++) {
      var a = parts[i], k = a.indexOf('='), key = (k < 0 ? a : a.slice(0, k)).trim().toLowerCase(), val = k < 0 ? '' : a.slice(k + 1).trim();
      if (key === 'max-age') { var s = parseInt(val, 10); if (!isNaN(s)) expires = s <= 0 ? 1 : now() + s * 1000; }
      else if (key === 'expires' && !expires) { var d = Date.parse(val); if (!isNaN(d)) expires = d <= now() ? 1 : d; }
      else if (key === 'path' && val.charAt(0) === '/') path = val;
    }
    put(name, value, expires, path);
  }
  function text(){
    return live().filter(onPath).map(function(c){ return c.n ? c.n + '=' + c.v : c.v; }).join('; ');
  }
  try {
    Object.defineProperty(document, 'cookie', { configurable: true, get: text, set: function(v){ parse(v); } });
  } catch (e) {}
  /* cookieStore (Chromium and newer WebKit), over the same jar. */
  function item(c){ return { name: c.n, value: c.v, expires: c.e || null, path: c.p || '/', domain: null, secure: false, sameSite: 'strict', partitioned: false }; }
  function nameOf(a){ return a && typeof a === 'object' ? a.name : a; }
  var store = {
    get: function(a){ var n = nameOf(a); var c = live().filter(onPath).filter(function(x){ return n === undefined || x.n === String(n); })[0]; return Promise.resolve(c ? item(c) : null); },
    getAll: function(a){ var n = nameOf(a); return Promise.resolve(live().filter(onPath).filter(function(x){ return n === undefined || x.n === String(n); }).map(item)); },
    set: function(a, b){
      var o = a && typeof a === 'object' ? a : { name: a, value: b };
      put(String(o.name), String(o.value), o.expires ? +new Date(o.expires) : 0, o.path || '/');
      return Promise.resolve();
    },
    'delete': function(a){ var o = a && typeof a === 'object' ? a : { name: a }; put(String(o.name), '', 1, o.path || '/'); return Promise.resolve(); },
    addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; }, onchange: null
  };
  try { Object.defineProperty(window, 'cookieStore', { configurable: true, value: store }); } catch (e) {}
}`
