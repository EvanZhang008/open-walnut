/**
 * The Cache API (`caches`, CacheStorage and Cache) for a page in the Files preview
 * (preview-state-script.ts puts it in). In the preview's opaque origin the browser's own throws.
 *
 * Plain ES5 in a string, after PREVIEW_CODEC_JS. `wnCaches(data, dirty)` installs `caches` over
 * `data`, `{ <cache name>: [ { u: url, s: status, st: statusText, h: [[name, value]], b: base64 body } ] }`,
 * and calls `dirty()` after each change. Only GET requests are kept, as the spec says; a response
 * the page cannot read (an opaque cross-origin one) is kept without its body.
 */
export const PREVIEW_CACHE_JS = String.raw`function wnCaches(data, dirty){
  function urlOf(r){ var u = typeof r === 'string' ? r : r && r.url; try { return new URL(u, location.href).href; } catch (e) { return String(u); } }
  function bare(u){ var i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); }
  function noSearch(u){ var i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }
  function methodOf(r){ return r && typeof r === 'object' && r.method ? String(r.method).toUpperCase() : 'GET'; }
  function same(e, req, o){
    var a = bare(e.u), b = bare(urlOf(req));
    if (o && o.ignoreSearch) { a = noSearch(a); b = noSearch(b); }
    return a === b;
  }
  function toResponse(e){ return new Response(e.b ? wnUnB64(e.b) : null, { status: e.s, statusText: e.st, headers: e.h }); }
  function toRequest(e){ return new Request(e.u); }
  function Cache(name){ this._n = name; }
  function list(c){ return data[c._n] || (data[c._n] = []); }
  Cache.prototype.match = function(req, o){ return this.matchAll(req, o).then(function(a){ return a[0]; }); };
  Cache.prototype.matchAll = function(req, o){
    var es = list(this);
    if (req !== undefined && methodOf(req) !== 'GET' && !(o && o.ignoreMethod)) return Promise.resolve([]);
    return Promise.resolve(es.filter(function(e){ return req === undefined || same(e, req, o); }).map(toResponse));
  };
  Cache.prototype.put = function(req, res){
    var self = this, u = urlOf(req);
    if (methodOf(req) !== 'GET') return Promise.reject(new TypeError('Cache.put only takes a GET request'));
    if (!res || res.status === 206) return Promise.reject(new TypeError('Cache.put needs a whole response'));
    var head = [];
    try { res.headers.forEach(function(v, k){ head.push([k, v]); }); } catch (e) {}
    var body = res.type === 'opaque' ? Promise.resolve(null) : res.arrayBuffer();
    return body.then(function(buf){
      var es = list(self);
      for (var i = es.length - 1; i >= 0; i--) if (bare(es[i].u) === bare(u)) es.splice(i, 1);
      es.push({ u: bare(u), s: res.status || 200, st: res.statusText || '', h: head, b: buf ? wnB64(new Uint8Array(buf)) : '' });
      dirty();
    });
  };
  Cache.prototype.add = function(req){ return this.addAll([req]); };
  Cache.prototype.addAll = function(reqs){
    var self = this;
    return Promise.all(reqs.map(function(r){
      return fetch(r).then(function(res){ if (!res.ok) throw new TypeError('Cache.addAll: ' + res.status + ' for ' + urlOf(r)); return [r, res]; });
    })).then(function(pairs){ return Promise.all(pairs.map(function(p){ return self.put(p[0], p[1]); })); }).then(function(){});
  };
  Cache.prototype['delete'] = function(req, o){
    var es = list(this), n = es.length;
    data[this._n] = es.filter(function(e){ return !same(e, req, o); });
    if (data[this._n].length !== n) { dirty(); return Promise.resolve(true); }
    return Promise.resolve(false);
  };
  Cache.prototype.keys = function(req, o){
    return Promise.resolve(list(this).filter(function(e){ return req === undefined || same(e, req, o); }).map(toRequest));
  };
  var storage = {
    open: function(n){ n = String(n); if (!data[n]) { data[n] = []; dirty(); } return Promise.resolve(new Cache(n)); },
    has: function(n){ return Promise.resolve(Object.prototype.hasOwnProperty.call(data, String(n))); },
    'delete': function(n){ n = String(n); if (!Object.prototype.hasOwnProperty.call(data, n)) return Promise.resolve(false); delete data[n]; dirty(); return Promise.resolve(true); },
    keys: function(){ return Promise.resolve(Object.keys(data)); },
    match: function(req, o){
      var names = o && o.cacheName !== undefined ? [String(o.cacheName)] : Object.keys(data);
      var hit; for (var i = 0; i < names.length && !hit; i++) { var es = data[names[i]] || []; for (var j = 0; j < es.length; j++) if (same(es[j], req, o)) { hit = es[j]; break; } }
      return Promise.resolve(hit ? toResponse(hit) : undefined);
    }
  };
  try { Object.defineProperty(window, 'caches', { configurable: true, value: storage }); } catch (e) {}
  try { Object.defineProperty(window, 'Cache', { configurable: true, writable: true, value: Cache }); } catch (e) {}
}`
