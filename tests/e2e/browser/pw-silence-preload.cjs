/**
 * Every Playwright run under a Walnut session or a Mac queue runner is silent, whatever branch
 * it builds. Generated from src/providers/pw-silence-core.ts (scripts/pw-silence-preload.ts);
 * edit it there. Loaded with NODE_OPTIONS="--require <this file>": every Playwright library a
 * Node process loads (the runner, its workers, a script) adds the page silencer to every browser context, at document start in
 * every frame. Gated on navigator.webdriver, so a person's browser is untouched; a process
 * that never loads playwright-core is not touched.
 */
'use strict';
const SILENCE_JS = '(function(){if(!(globalThis.navigator&&globalThis.navigator.webdriver))return;' + "(function(){try{var w=globalThis;if(w.__walnutSilent)return;w.__walnutSilent=true;var T={contexts:0,blocked:0,plays:0,speech:0};w.__walnutAudio=T;var R=function(n){var E=w.DOMException;return E?new E('No audio in a test run',n):new Error('No audio in a test run')};var M=w.HTMLMediaElement&&w.HTMLMediaElement.prototype;if(M){var d=Object.getOwnPropertyDescriptor(M,'muted'),ms=d&&d.set;if(d&&d.get&&d.set){Object.defineProperty(M,'muted',{configurable:true,enumerable:d.enumerable,get:d.get,set:function(){ms.call(this,true)}})}var ad=Object.getOwnPropertyDescriptor(M,'autoplay'),as=ad&&ad.set;if(ad&&ad.get&&ad.set){Object.defineProperty(M,'autoplay',{configurable:true,enumerable:ad.enumerable,get:ad.get,set:function(){as.call(this,false)}})}var hold=function(t,e){try{if(ms)ms.call(t,true);else t.muted=true;if(as)as.call(t,false);if(e&&e.type==='play'&&t.pause){T.plays++;t.pause()}}catch(x){}};var q=function(e){var t=e.target;if(t&&M.isPrototypeOf(t))hold(t,e)};var listen=function(n){if(n&&n.addEventListener){n.addEventListener('loadstart',q,true);n.addEventListener('play',q,true);n.addEventListener('volumechange',q,true)}};var seen=w.WeakSet?new w.WeakSet():null;var guard=function(t){if(!t||!M.isPrototypeOf(t)||(seen&&seen.has(t)))return t;if(seen)seen.add(t);hold(t);listen(t);return t};listen(w.document);if(typeof M.play==='function'){M.play=function(){guard(this);T.plays++;try{if(this.pause)this.pause()}catch(e){}return w.Promise.reject(R('NotAllowedError'))}}var lo=M.load;if(typeof lo==='function'){M.load=function(){guard(this);return lo.apply(this,arguments)}}var ks=['src','srcObject'];for(var j=0;j<ks.length;j++){(function(k){var sd=Object.getOwnPropertyDescriptor(M,k);if(!sd||!sd.set)return;var ss=sd.set;Object.defineProperty(M,k,{configurable:true,enumerable:sd.enumerable,get:sd.get,set:function(v){guard(this);ss.call(this,v)}})})(ks[j])}var EP=w.Element&&w.Element.prototype;if(EP){var sa=EP.setAttribute;if(typeof sa==='function'){EP.setAttribute=function(n){if(M.isPrototypeOf(this)){guard(this);if(String(n).toLowerCase()==='autoplay')return}return sa.apply(this,arguments)}}var at=EP.attachShadow;if(typeof at==='function'){EP.attachShadow=function(){var r=at.apply(this,arguments);listen(r);return r}}}var DP=w.Document&&w.Document.prototype;if(DP){var cs=['createElement','createElementNS'];for(var c2=0;c2<cs.length;c2++){(function(k){var f=DP[k];if(typeof f==='function'){DP[k]=function(){return guard(f.apply(this,arguments))}}})(cs[c2])}}var A=w.Audio;if(typeof A==='function'){var SA=function(s){return guard(arguments.length?new A(s):new A())};SA.prototype=A.prototype;w.Audio=SA}}var names=['AudioContext','webkitAudioContext'];for(var i=0;i<names.length;i++){(function(name){var N=w[name];if(typeof N!=='function'||N.__walnutSilent)return;var dl=!!N.prototype&&typeof N.prototype.setSinkId==='function';var S=function(o){T.contexts++;if(!dl){if(/ WalnutVoiceTest$/.test((w.navigator&&w.navigator.userAgent)||''))return new N(o);T.blocked++;throw R('NotSupportedError')}var p={};if(o)for(var k in o)p[k]=o[k];p.sinkId={type:'none'};return new N(p)};S.prototype=N.prototype;S.__walnutSilent=true;if(dl)N.prototype.setSinkId=function(){return w.Promise.resolve()};w[name]=S})(names[i])}var P=w.AudioNode&&w.AudioNode.prototype,D=w.AudioDestinationNode;if(P&&D&&typeof P.connect==='function'){var c=P.connect,z=new WeakMap();P.connect=function(t){var r=Array.prototype.slice.call(arguments,1),x=t instanceof D?t.context:null;if(!x||(w.OfflineAudioContext&&x instanceof w.OfflineAudioContext))return c.apply(this,[t].concat(r));var g=z.get(x);if(!g){g=x.createGain();g.gain.value=0;c.call(g,t);z.set(x,g)}c.apply(this,[g].concat(r));return t}}var S2=w.SpeechSynthesis&&w.SpeechSynthesis.prototype;if(S2&&typeof S2.speak==='function'){S2.speak=function(){T.speech++}}}catch(e){}})();" + '})();';
const FLAG = Symbol.for('walnut.pwSilence');
const SEEN = Symbol.for('walnut.pwSilence.seen');
const HOOKED = Symbol.for('walnut.pwSilence.hooked');

/** Adds the silencer to every browser context of one Playwright library; once per library. */
function install(core) {
  const inst = core && core._instrumentation;
  if (!inst || typeof inst.addListener !== 'function') return false;
  const seen = globalThis[SEEN] || (globalThis[SEEN] = new WeakSet());
  if (seen.has(inst)) return false;
  seen.add(inst);
  globalThis[FLAG] = true;
  inst.addListener({
    runAfterCreateBrowserContext: async (context) => { await context.addInitScript({ content: SILENCE_JS }); },
  });
  return true;
}

/** A file of the Playwright library whose exports are the library (index.js, lib/inprocess.js), in node_modules or Bun's cache. */
function isPlaywrightCore(file) {
  return typeof file === 'string' && /[\\/]playwright-core(@[^\\/]*)?[\\/](index|lib[\\/]inprocess)\.js$/.test(file);
}

// Every CommonJS file Node and Bun load passes the .js loader, whatever imports it (the runner,
// a worker, a script of its own or its helper, require or import, from any folder): the
// Playwright library it loads gets the silencer before it can make a browser.
if (!globalThis[HOOKED]) {
  globalThis[HOOKED] = true;
  try {
    const exts = require('node:module')._extensions;
    const loadJs = exts && exts['.js'];
    if (typeof loadJs === 'function') {
      exts['.js'] = function (module, filename) {
        const result = loadJs.apply(this, arguments);
        try { if (isPlaywrightCore(filename)) install(module.exports); } catch (e) {
          console.warn('[pw-silence-preload] could not silence test browsers: ' + (e && e.message));
        }
        return result;
      };
    }
  } catch (e) {
    console.warn('[pw-silence-preload] could not silence test browsers: ' + (e && e.message));
  }
}

// A Bun Worker (the web one and node:worker_threads') starts without BUN_OPTIONS' preload,
// unlike a Node one, which keeps NODE_OPTIONS: every Worker made here gets this file first.
const WORKERS = Symbol.for('walnut.pwSilence.workers');
if (process.versions && process.versions.bun && !globalThis[WORKERS]) {
  globalThis[WORKERS] = true;
  const withPreload = (options) => {
    const o = Object.assign({}, options);
    const list = o.preload == null ? [] : [].concat(o.preload);
    if (list.indexOf(__filename) < 0) list.unshift(__filename);
    o.preload = list;
    return o;
  };
  const silent = (Native) => {
    if (typeof Native !== 'function') return Native;
    return class extends Native { constructor(url, options) { super(url, withPreload(options)); } };
  };
  try {
    if (typeof globalThis.Worker === 'function') globalThis.Worker = silent(globalThis.Worker);
    const threads = require('node:worker_threads');
    threads.Worker = silent(threads.Worker);
  } catch (e) {
    console.warn('[pw-silence-preload] could not silence test browsers in workers: ' + (e && e.message));
  }
}

module.exports = { SILENCE_JS, install, isPlaywrightCore };
