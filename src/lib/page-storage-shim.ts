/**
 * `localStorage` and `sessionStorage` for a page that runs in an opaque origin.
 *
 * Walnut runs a page a model wrote in a sandboxed frame with no origin of its own (an html-app
 * island in a reply, web/src/components/chat/island-runtime.ts; an HTML file in the Files
 * preview, src/web/preview-state-script.ts), so the page's own storage throws. This is ONE
 * store both of them put in its place: reads are synchronous from a map the caller seeded
 * before the page's first script, every write calls the caller's `dirty()`, and the caller
 * keeps the map wherever it can survive the frame being built again.
 *
 * Plain ES5 in a string: it runs in whatever engine renders the frame. It defines
 * `wnStore(m, dirty)`, one Storage over the `Object.create(null)` map of strings `m`;
 * `wnPutStorage(name, store)`, which puts it over one of the window's two names; and
 * `wnInstallStorage(m, dirty)`, one store under both names (an island: its two names are one
 * store), returned. The Files preview gives each name a store of its own, as a browser does.
 */
export const PAGE_STORAGE_SHIM_JS = 'function wnStore(m,dirty){'
  + 'var api={'
  + 'getItem:function(k){k=String(k);return k in m?m[k]:null},'
  + 'setItem:function(k,v){m[String(k)]=String(v);dirty()},'
  + 'removeItem:function(k){k=String(k);if(k in m){delete m[k];dirty()}},'
  + 'clear:function(){var n=0;for(var k in m){delete m[k];n++}if(n)dirty()},'
  + 'key:function(i){var ks=Object.keys(m);return i>=0&&i<ks.length?ks[i]:null}};'
  + "Object.defineProperty(api,'length',{get:function(){return Object.keys(m).length}});"
  // `localStorage.score = 3` and `localStorage.score` work on a real page too.
  // The proxy's target is an empty object: a target holding the methods would make
  // `Object.keys(localStorage)` break the proxy invariants on its own `length`.
  + 'var store=api;if(typeof Proxy==="function"){store=new Proxy({},{'
  + 'get:function(o,p){if(p in api||typeof p!=="string")return api[p];return p in m?m[p]:undefined},'
  + 'set:function(o,p,v){if(p in api||typeof p!=="string")return false;api.setItem(p,v);return true},'
  + 'deleteProperty:function(o,p){api.removeItem(p);return true},'
  + 'has:function(o,p){return p in api||p in m},'
  + 'ownKeys:function(){return Object.keys(m)},'
  + 'getOwnPropertyDescriptor:function(o,p){return p in m?{value:m[p],writable:true,enumerable:true,configurable:true}:undefined}'
  + '})}'
  + 'return store}'
  + 'function wnPutStorage(n,store){try{Object.defineProperty(window,n,{value:store,configurable:true})}catch(e){}}'
  + 'function wnInstallStorage(m,dirty){var s=wnStore(m,dirty);wnPutStorage("localStorage",s);wnPutStorage("sessionStorage",s);return s}'
