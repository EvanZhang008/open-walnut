/**
 * Every Playwright run a machine starts is silent, whatever branch it tests (2026-11-08: runs of
 * branches cut before tests/e2e/browser/pw-silence.ts landed had no silence in their configs, and
 * a WebKit run on a Mac with a person near it switched its speaker on 278 times in one night).
 *
 * The runners that drive browsers on a Mac (the Mac queue's WebKit job, here and on another Mac)
 * load this file from the Mac's main with NODE_OPTIONS="--require <file>", so the Playwright
 * runner and each of its workers add the page silencer to every browser context, at document
 * start in every frame, before the config is read. Plain CommonJS with no imports of the repo, so
 * an old checkout runs it as it is. SILENCE_JS is the iOS app's AudioSilence.webScript (ES5, the
 * same rules as src/lib/automation-silence.ts; tests/web/automation-silence.test.ts checks both
 * are one text and runs it against the same checks) behind a gate,
 * `navigator.webdriver`, so a person's browser is never touched. A process that is not a
 * Playwright one (a fixture server, a build) loads nothing.
 */
'use strict';
const SILENCE_JS = '(function(){if(!(globalThis.navigator&&globalThis.navigator.webdriver))return;' + "(function(){try{var w=globalThis;if(w.__walnutSilent)return;w.__walnutSilent=true;var T={contexts:0,blocked:0,plays:0,speech:0};w.__walnutAudio=T;var R=function(n){var E=w.DOMException;return E?new E('No audio in a test run',n):new Error('No audio in a test run')};var M=w.HTMLMediaElement&&w.HTMLMediaElement.prototype;if(M){var d=Object.getOwnPropertyDescriptor(M,'muted');if(d&&d.get&&d.set){var s=d.set;Object.defineProperty(M,'muted',{configurable:true,enumerable:d.enumerable,get:d.get,set:function(){s.call(this,true)}})}if(typeof M.play==='function'){M.play=function(){T.plays++;try{this.muted=true;if(this.pause)this.pause()}catch(e){}return w.Promise.reject(R('NotAllowedError'))}}var q=function(e){var t=e.target;if(!t||!M.isPrototypeOf(t))return;try{if(!t.muted)t.muted=true;if(e.type==='play'&&t.pause){T.plays++;t.pause()}}catch(x){}};if(w.document&&w.document.addEventListener){w.document.addEventListener('loadstart',q,true);w.document.addEventListener('play',q,true);w.document.addEventListener('volumechange',q,true)}}var names=['AudioContext','webkitAudioContext'];for(var i=0;i<names.length;i++){(function(name){var N=w[name];if(typeof N!=='function'||N.__walnutSilent)return;var dl=!!N.prototype&&typeof N.prototype.setSinkId==='function';var S=function(o){T.contexts++;if(!dl){if(/ WalnutVoiceTest$/.test((w.navigator&&w.navigator.userAgent)||''))return new N(o);T.blocked++;throw R('NotSupportedError')}var p={};if(o)for(var k in o)p[k]=o[k];p.sinkId={type:'none'};return new N(p)};S.prototype=N.prototype;S.__walnutSilent=true;if(dl)N.prototype.setSinkId=function(){return w.Promise.resolve()};w[name]=S})(names[i])}var P=w.AudioNode&&w.AudioNode.prototype,D=w.AudioDestinationNode;if(P&&D&&typeof P.connect==='function'){var c=P.connect,z=new WeakMap();P.connect=function(t){var r=Array.prototype.slice.call(arguments,1),x=t instanceof D?t.context:null;if(!x||(w.OfflineAudioContext&&x instanceof w.OfflineAudioContext))return c.apply(this,[t].concat(r));var g=z.get(x);if(!g){g=x.createGain();g.gain.value=0;c.call(g,t);z.set(x,g)}c.apply(this,[g].concat(r));return t}}var S2=w.SpeechSynthesis&&w.SpeechSynthesis.prototype;if(S2&&typeof S2.speak==='function'){S2.speak=function(){T.speech++}}}catch(e){}})();" + '})();';
const FLAG = Symbol.for('walnut.pwSilence');

function install(core) {
  if (globalThis[FLAG] || !core || !core._instrumentation) return false;
  globalThis[FLAG] = true;
  core._instrumentation.addListener({
    runAfterCreateBrowserContext: async (context) => { await context.addInitScript({ content: SILENCE_JS }); },
  });
  return true;
}

if (/playwright/i.test(process.argv.slice(1).join(' '))) {
  try {
    install(require('node:module').createRequire(process.cwd() + '/')('playwright-core'));
  } catch (e) {
    console.warn('[pw-silence-preload] could not silence test browsers: ' + (e && e.message));
  }
}

module.exports = { SILENCE_JS, install };
