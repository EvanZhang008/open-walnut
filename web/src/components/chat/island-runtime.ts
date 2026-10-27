/**
 * What an html-app island can do beyond drawing: keep its state and hand a result back.
 *
 * 2026-10-27, the user, halfway through a 15-question quiz in a reply: "when new thing
 * start, the html just get reset". An island is a sandboxed iframe with an opaque
 * origin, so the page inside has no storage of its own (`localStorage` throws), and
 * every time the frame is built again it starts from nothing. This runtime is injected
 * at the top of every island document and gives it what a real page has:
 *
 *  · `localStorage` / `sessionStorage` that work. Reads are synchronous from a copy
 *    the parent wrote INTO the document when it built it (the seed), so a script that
 *    reads its state on load sees it on the very first line. Writes post the whole
 *    store up to the parent (one post per burst, before the task ends), which keeps it per island
 *    (island-store.ts). Both names are one store: a reload of a real page keeps both.
 *  · `walnut.report(value)`: offer a result to the AI. The parent shows the exact text
 *    under the island with a "Send to AI" button; nothing is sent unless the user
 *    presses it. A string is sent as written, anything else as pretty JSON.
 *
 * Plain ES5 inside the string: it runs in whatever engine renders the frame.
 * iOS injects the same protocol (ios-native/Walnut/Markdown/RichHTMLDocument.swift).
 */

/** Message types the frame posts. Keep in step with the iOS twin. */
export const ISLAND_STATE_MSG = 'wn-island-state';
export const ISLAND_RESULT_MSG = 'wn-island-result';

/** The longest result a user can send in one press (characters). */
export const ISLAND_RESULT_MAX = 16000;
/**
 * The most an island may keep (characters of its serialized store): with a result
 * beside it the record still fits the draft mirror's 64 KB, so it reaches every
 * browser of this Walnut.
 */
export const ISLAND_STATE_MAX = 48 * 1024;

/**
 * Characters that change what the reader sees without being seen: bidi overrides and
 * isolates, zero-width spaces and joiners other than ZWJ (emoji need it), the BOM. A
 * result keeps none of them, so the text the user reads is the text the AI gets.
 */
const INVISIBLE_RE = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function cleanResultText(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

/** A result that would run as a slash command instead of reaching the AI as words. */
export function isCommandLike(text: string): boolean {
  return text.trimStart().startsWith('/');
}

export type IslandItems = Record<string, string>;

/** JSON that is safe inside a `<script>` element (no `</script>`, no `<!--`). */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The `<script>` that gives an island its storage and `walnut.report`.
 *
 * `key` names the island in every message it posts; the parent also checks the
 * message came from ITS frame (`event.source`), so one island cannot write another's
 * state. It must run before any of the model's own scripts, so callers put it first
 * in the document.
 */
export function islandRuntimeScript(key: string, seed: IslandItems): string {
  return '<script>(function(){'
    + `var K=${scriptJson(key)},S=${scriptJson(seed)};`
    + 'var m=Object.create(null),t=null,has=Object.prototype.hasOwnProperty;'
    + 'for(var s in S){if(has.call(S,s))m[s]=String(S[s]);}'
    + 'function post(){t=null;var o={};for(var k in m)o[k]=m[k];'
    + `try{parent.postMessage({t:${scriptJson(ISLAND_STATE_MSG)},k:K,items:o},'*')}catch(e){}}`
    // One post per burst of writes, sent before the task ends (a microtask), so a
    // frame taken down right after a click has already handed its state up.
    + 'var P=typeof Promise==="function"?Promise.resolve():null;'
    + 'function dirty(){if(t===null){t=1;if(P)P.then(function(){if(t!==null)post()});else setTimeout(function(){if(t!==null)post()},0)}}'
    + 'function flush(){if(t!==null)post();}'
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
    + "['localStorage','sessionStorage'].forEach(function(n){"
    + 'try{Object.defineProperty(window,n,{value:store,configurable:true})}catch(e){}});'
    + "addEventListener('pagehide',flush);"
    + "document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush()});"
    + 'var w=window.walnut||{};'
    + 'w.report=function(v){var x;if(typeof v==="string")x=v;'
    + 'else{try{x=JSON.stringify(v,null,2)}catch(e){x=String(v)}}'
    + `try{parent.postMessage({t:${scriptJson(ISLAND_RESULT_MSG)},k:K,text:String(x)},'*')}catch(e){}};`
    + 'window.walnut=w;'
    + '})()</script>';
}

/** Is this a well-formed state message for `key`? Returns the items when it is. */
export function readStateMessage(data: unknown, key: string): IslandItems | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { t?: unknown; k?: unknown; items?: unknown };
  if (d.t !== ISLAND_STATE_MSG || d.k !== key) return null;
  if (!d.items || typeof d.items !== 'object' || Array.isArray(d.items)) return null;
  const out: IslandItems = {};
  for (const [k, v] of Object.entries(d.items as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Is this a well-formed result message for `key`? Returns the text when it is. */
export function readResultMessage(data: unknown, key: string): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { t?: unknown; k?: unknown; text?: unknown };
  if (d.t !== ISLAND_RESULT_MSG || d.k !== key || typeof d.text !== 'string') return null;
  return cleanResultText(d.text);
}
