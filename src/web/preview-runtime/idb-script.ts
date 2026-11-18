/**
 * IndexedDB for a page in the Files preview (preview-state-script.ts puts it in). In the preview's
 * opaque origin the browser's own throws, so the page gets fake-indexeddb (a complete IndexedDB in
 * JavaScript, fake-indexeddb.generated.ts), run only the first time the page reaches for it.
 *
 * What it holds is kept as a dump: every database's version, stores (key path, key generator,
 * indexes) and records, values through PREVIEW_CODEC_JS. A dump is taken again after each write
 * that completes. The dump the page left last time is put back before the page's own first
 * script: its first `open` queues behind that restore, as IndexedDB orders opens of one database.
 *
 * Plain ES5 in a string, after PREVIEW_CODEC_JS. `wnIdb(seed, changed)` installs `indexedDB`, the
 * `IDB*` classes and WebKit's `webkitIndexedDB`, restores `seed` (a dump, or null), and returns
 * `{ dump() }`, the latest dump; `changed()` is called once a new dump is ready.
 */
import { FAKE_INDEXEDDB_JS } from './fake-indexeddb.generated.js'

const NAMES = ['indexedDB', 'IDBKeyRange', 'IDBFactory', 'IDBDatabase', 'IDBTransaction', 'IDBObjectStore', 'IDBIndex',
  'IDBCursor', 'IDBCursorWithValue', 'IDBRequest', 'IDBOpenDBRequest', 'IDBVersionChangeEvent']

export const PREVIEW_IDB_NAMES: readonly string[] = [...NAMES, 'webkitIndexedDB']

export const PREVIEW_IDB_JS = String.raw`function wnIdb(seed, changed){
  var F = null, open0 = null, cur = Array.isArray(seed) ? seed : [], names = {}, dt = 0, busy = false, again = false;
  cur.forEach(function(d){ names[d.n] = 1; });
  function load(){
    if (F) return F;
    (function(){ ` + FAKE_INDEXEDDB_JS + String.raw` })();
    F = window.__wnFakeIDB;
    try { delete window.__wnFakeIDB; } catch (e) { window.__wnFakeIDB = undefined; }
    var fac = F.indexedDB, del0 = fac.deleteDatabase, tx0 = F.IDBDatabase.prototype.transaction;
    open0 = fac.open;
    fac.open = function(name){
      names[String(name)] = 1;
      var r = open0.apply(this, arguments);
      r.addEventListener('upgradeneeded', function(){ if (r.transaction) r.transaction.addEventListener('complete', soon); });
      return r;
    };
    fac.deleteDatabase = function(name){
      var r = del0.apply(this, arguments);
      r.addEventListener('success', function(){ delete names[String(name)]; soon(); });
      return r;
    };
    F.IDBDatabase.prototype.transaction = function(stores, mode){
      var t = tx0.apply(this, arguments);
      if (mode && mode !== 'readonly') t.addEventListener('complete', soon);
      return t;
    };
    return F;
  }
  ${JSON.stringify(NAMES)}.forEach(function(n){
    try {
      Object.defineProperty(window, n, { configurable: true, enumerable: true,
        get: function(){ return load()[n]; },
        set: function(v){ Object.defineProperty(window, n, { configurable: true, writable: true, value: v }); } });
    } catch (e) {}
  });
  try { Object.defineProperty(window, 'webkitIndexedDB', { configurable: true, get: function(){ return load().indexedDB; } }); } catch (e) {}

  /* Put the last dump back, in the upgrade of a fresh database, before any open of the page's. */
  if (cur.length) {
    load();
    cur.forEach(function(d){
      try {
        var r = open0.call(F.indexedDB, d.n, Math.max(1, Math.floor(+d.v) || 1));
        r.onupgradeneeded = function(){
          var db = r.result;
          (d.s || []).forEach(function(st){
            var os = db.createObjectStore(st.n, { keyPath: st.kp === null ? undefined : st.kp, autoIncrement: !!st.ai });
            (st.ix || []).forEach(function(ix){ os.createIndex(ix.n, ix.kp, { unique: !!ix.u, multiEntry: !!ix.me }); });
            (st.r || []).forEach(function(kv){
              /* One record that no longer fits (a unique index) is left out, never the whole database. */
              try { var pr = st.kp === null ? os.put(wnDecode(kv[1]), wnDecode(kv[0])) : os.put(wnDecode(kv[1])); pr.onerror = function(ev){ ev.preventDefault(); ev.stopPropagation(); }; } catch (e) {}
            });
          });
        };
        r.onsuccess = function(){ r.result.close(); };
      } catch (e) {}
    });
  }

  /* At most one dump per 250 ms, however often the page writes (a wait that restarts never ends). */
  function soon(){ if (!dt) dt = setTimeout(take, 250); }
  function req(r){ return new Promise(function(ok, no){ r.onsuccess = function(){ ok(r.result); }; r.onerror = function(){ no(r.error); }; }); }
  function one(name){
    return new Promise(function(ok){
      var r = open0.call(F.indexedDB, name);
      r.onupgradeneeded = function(){ try { r.transaction.abort(); } catch (e) {} };
      r.onerror = function(){ ok(null); };
      r.onsuccess = function(){
        var db = r.result, sn = Array.prototype.slice.call(db.objectStoreNames);
        if (!sn.length) { var v0 = db.version; db.close(); ok({ n: name, v: v0, s: [] }); return; }
        var t = db.transaction(sn, 'readonly');
        Promise.all(sn.map(function(n){
          var os = t.objectStore(n);
          var ix = Array.prototype.slice.call(os.indexNames).map(function(i){ var x = os.index(i); return { n: i, kp: x.keyPath, u: x.unique, me: x.multiEntry }; });
          return Promise.all([req(os.getAllKeys()), req(os.getAll())]).then(function(kv){
            return { n: n, kp: os.keyPath === undefined ? null : os.keyPath, ai: os.autoIncrement, ix: ix, keys: kv[0], vals: kv[1] };
          });
        })).then(function(stores){
          var v = db.version; db.close();
          return Promise.all(stores.map(function(st){
            return Promise.all(st.keys.map(function(k, i){ return Promise.all([wnEncode(k), wnEncode(st.vals[i])]); })).then(function(r2){
              return { n: st.n, kp: st.kp, ai: st.ai, ix: st.ix, r: r2 };
            });
          })).then(function(s){ ok({ n: name, v: v, s: s }); });
        }).catch(function(){ try { db.close(); } catch (e) {} ok(null); });
      };
    });
  }
  function take(){
    dt = 0;
    if (!F) return;
    if (busy) { again = true; return; }
    busy = true;
    Promise.all(Object.keys(names).map(one)).then(function(dbs){
      cur = dbs.filter(function(d){ return !!d; });
      busy = false;
      changed();
      if (again) { again = false; soon(); }
    });
  }
  return { dump: function(){ return cur; } };
}`
