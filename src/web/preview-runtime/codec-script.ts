/**
 * Turns what a page keeps in IndexedDB (any value structured clone takes: Dates, Maps, Sets,
 * binary data, Blobs, nested objects) into JSON and back, so the Files preview can keep it on disk
 * between documents (preview-state-script.ts). Plain ES5 in a string.
 *
 *  - `wnEncode(value)` -> Promise of a JSON-safe value: a Blob's bytes are read first.
 *  - `wnDecode(json)` -> the value again.
 *  - `wnB64(bytes)` / `wnUnB64(text)`: a Uint8Array to base64 and back.
 * A cycle, a function or a host object it does not know comes back as null: structured clone
 * would refuse most of them anyway.
 */
export const PREVIEW_CODEC_JS = String.raw`function wnB64(u8){
  var s = '', CH = 0x8000;
  for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function wnUnB64(t){
  var s = atob(t), u = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
var WN_VIEWS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
function wnEncode(value){
  var blobs = [], seen = [];
  function enc(v){
    var t = typeof v;
    if (v === null || t === 'boolean' || t === 'string') return v;
    if (t === 'number') return isFinite(v) && !(v === 0 && 1 / v < 0) ? v : { $t: 'n', v: String(1 / v < 0 && v === 0 ? '-0' : v) };
    if (t === 'undefined') return { $t: 'u' };
    if (t === 'bigint') return { $t: 'I', v: String(v) };
    if (t !== 'object') return null;
    if (seen.indexOf(v) >= 0) return null;
    seen.push(v);
    try {
      if (Array.isArray(v)) return v.map(enc);
      if (v instanceof Date) return { $t: 'D', v: v.getTime() };
      if (v instanceof RegExp) return { $t: 'R', s: v.source, f: v.flags };
      if (typeof Blob !== 'undefined' && v instanceof Blob) {
        blobs.push(v);
        var b = { $t: 'L', i: blobs.length - 1, ty: v.type };
        if (typeof File !== 'undefined' && v instanceof File) { b.nm = v.name; b.lm = v.lastModified; }
        return b;
      }
      if (v instanceof ArrayBuffer) return { $t: 'B', v: wnB64(new Uint8Array(v)) };
      if (ArrayBuffer.isView(v)) {
        var u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        var c = v instanceof DataView ? 'DataView' : (v.constructor && v.constructor.name) || 'Uint8Array';
        return { $t: 'T', c: c, v: wnB64(u) };
      }
      if (v instanceof Map) { var mo = []; v.forEach(function(x, k){ mo.push([enc(k), enc(x)]); }); return { $t: 'M', v: mo }; }
      if (v instanceof Set) { var so = []; v.forEach(function(x){ so.push(enc(x)); }); return { $t: 'S', v: so }; }
      if (v instanceof Error) return { $t: 'E', n: v.name, m: v.message };
      if (v instanceof Boolean || v instanceof Number || v instanceof String) return { $t: 'P', v: enc(v.valueOf()) };
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = enc(v[k]);
      return { $t: 'o', v: o };
    } finally { seen.pop(); }
  }
  var out = enc(value);
  if (!blobs.length) return Promise.resolve(out);
  return Promise.all(blobs.map(function(b){ return b.arrayBuffer(); })).then(function(bufs){
    function fill(x){
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(fill); return; }
      if (x.$t === 'L') { x.v = wnB64(new Uint8Array(bufs[x.i])); delete x.i; return; }
      if (x.$t === 'o') { for (var k in x.v) fill(x.v[k]); return; }
      if (x.$t === 'M' || x.$t === 'S') { x.v.forEach(fill); return; }
      if (x.$t === 'P') fill(x.v);
    }
    fill(out);
    return out;
  });
}
function wnDecode(x){
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(wnDecode);
  switch (x.$t) {
    case 'n': return x.v === '-0' ? -0 : Number(x.v);
    case 'u': return undefined;
    case 'I': return typeof BigInt === 'function' ? BigInt(x.v) : Number(x.v);
    case 'D': return new Date(x.v);
    case 'R': return new RegExp(x.s, x.f);
    case 'L': {
      var parts = [wnUnB64(x.v || '')];
      if (x.nm !== undefined && typeof File === 'function') return new File(parts, x.nm, { type: x.ty, lastModified: x.lm });
      return new Blob(parts, { type: x.ty });
    }
    case 'B': return wnUnB64(x.v).buffer;
    case 'T': {
      var u = wnUnB64(x.v);
      if (x.c === 'DataView') return new DataView(u.buffer);
      var C = WN_VIEWS.indexOf(x.c) >= 0 ? window[x.c] : Uint8Array;
      return new C(u.buffer, 0, u.byteLength / (C.BYTES_PER_ELEMENT || 1));
    }
    case 'M': { var m = new Map(); x.v.forEach(function(p){ m.set(wnDecode(p[0]), wnDecode(p[1])); }); return m; }
    case 'S': { var s = new Set(); x.v.forEach(function(e){ s.add(wnDecode(e)); }); return s; }
    case 'E': { var er = new Error(x.m); er.name = x.n; return er; }
    case 'P': return Object(wnDecode(x.v));
    case 'o': { var o = {}; for (var k in x.v) o[k] = wnDecode(x.v[k]); return o; }
  }
  return null;
}`
