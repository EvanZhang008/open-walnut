/**
 * Every Playwright run under a Walnut session or a Mac queue runner is silent, whatever branch
 * it builds. Generated from src/providers/pw-silence-core.ts (scripts/pw-silence-preload.ts);
 * edit it there. Loaded with NODE_OPTIONS="--require <this file>": every Playwright library a
 * Node process loads (the runner, its workers, a script) adds the page silencer to every browser context, at document start in
 * every frame. Gated on navigator.webdriver, so a person's browser is untouched; a process
 * that never loads playwright-core is not touched. On a Mac, every WebKit browser it starts
 * can never become the frontmost app (src/providers/pw-noactivate-core.ts), and a machine on hold
 * or in its quiet night launches no browser at all (src/lib/machine-hold.ts).
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
        try { if (isPlaywrightCore(filename)) { const root = filename.replace(/[\\/](index|lib[\\/]inprocess)\.js$/, ''); install(module.exports); holdBrowsers(root); quietWebkit(root); } else if (isBrowserTypeServer(filename)) holdBrowserTypes(module.exports); else if (isWebkitServer(filename)) quietWebkitServer(module.exports); } catch (e) {
          console.warn('[pw-silence-preload] could not silence test browsers: ' + (e && e.message));
        }
        return result;
      };
    }
  } catch (e) {
    console.warn('[pw-silence-preload] could not silence test browsers: ' + (e && e.message));
  }
}

// A held machine, or one in its quiet night, launches no test browser (src/lib/machine-hold.ts).
function machineHold(home, now) {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(home || require('node:os').homedir(), '.config', 'walnut');
  const hold = path.join(dir, 'hold');
  if (fs.existsSync(hold)) {
    let why = '';
    try { why = fs.readFileSync(hold, 'utf8').split('\n')[0].trim(); } catch (e) {}
    return 'this machine holds every new test run for now (~/.config/walnut/hold' + (why ? ': ' + why : '') + '). ' +
      'Run it elsewhere (a remote dev host, a container, CI) or once the hold is lifted.';
  }
  const h = (now || new Date()).getHours();
  if (fs.existsSync(path.join(dir, 'night-quiet')) && (h >= 22 || h < 8)) {
    return 'this machine runs no test from 22:00 to 08:00 (~/.config/walnut/night-quiet). ' +
      'Run it elsewhere (a remote dev host, a container, CI) or after 08:00.';
  }
  return null;
}
/** The deploy's first-paint check (scripts/devprod-render-check.mjs) is no test run: a deploy on a held machine still checks its bundle. */
function deployCheck() {
  return /[\\/]scripts[\\/]devprod-render-check\.mjs$/.test(String(process.argv[1] || ''));
}
const HELD = Symbol.for('walnut.pwSilence.machineHold');
/** Every launch of one Playwright library's browser types refuses on a held machine; once per library. */
function holdBrowserTypes(mod) {
  const proto = mod && mod.BrowserType && mod.BrowserType.prototype;
  if (!proto || Object.prototype.hasOwnProperty.call(proto, HELD)) return false;
  const prepare = proto._prepareToLaunch;
  if (typeof prepare !== 'function') return false;
  proto[HELD] = true;
  proto._prepareToLaunch = function () {
    const why = deployCheck() ? null : machineHold();
    if (why) throw new Error('[machine-hold] This browser did not start: ' + why);
    return prepare.apply(this, arguments);
  };
  return true;
}
/** Playwright's server-side BrowserType file, in node_modules or Bun's cache. */
function isBrowserTypeServer(file) {
  return typeof file === 'string' && /[\\/]playwright-core(@[^\\/]*)?[\\/]lib[\\/]server[\\/]browserType\.js$/.test(file);
}
/** The same, from a Playwright library's folder. */
function holdBrowsers(root) {
  try { return holdBrowserTypes(require(require('node:path').join(root, 'lib', 'server', 'browserType.js'))); }
  catch (e) { return false; }
}

// A Mac WebKit test browser never becomes the frontmost app (src/providers/pw-noactivate-core.ts).
const NOACT_M = "#import <AppKit/AppKit.h>\n#import <objc/runtime.h>\nstatic IMP walnutSetPolicy;\nstatic BOOL walnutProhibited(id self, SEL cmd, NSApplicationActivationPolicy policy) {\n  return ((BOOL (*)(id, SEL, NSApplicationActivationPolicy))walnutSetPolicy)(self, cmd, NSApplicationActivationPolicyProhibited);\n}\nstatic void walnutNoActivate(id self, SEL cmd, BOOL flag) {}\nstatic void walnutNoActivateNow(id self, SEL cmd) {}\nstatic IMP walnutSwap(SEL sel, IMP imp) {\n  Method m = class_getInstanceMethod([NSApplication class], sel);\n  return m ? method_setImplementation(m, imp) : NULL;\n}\n__attribute__((constructor)) static void walnutQuietApp(void) {\n  walnutSetPolicy = walnutSwap(@selector(setActivationPolicy:), (IMP)walnutProhibited);\n  walnutSwap(@selector(activateIgnoringOtherApps:), (IMP)walnutNoActivate);\n  walnutSwap(NSSelectorFromString(@\"activate\"), (IMP)walnutNoActivateNow);\n  dispatch_async(dispatch_get_main_queue(), ^{ [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited]; });\n}\n";
const QUIET = Symbol.for('walnut.pwSilence.noActivate');
let noActWarned = false;
function noActWarn(e) {
  if (noActWarned) return;
  noActWarned = true;
  console.warn('[pw-silence-preload] a WebKit test browser may come to the front: ' + (e && e.message || e));
}

/** A clang and its macOS SDK from the Command Line Tools or Xcode, or null (never the /usr/bin shim: with no tools it shows an install dialog). */
function clangPath() {
  const fs = require('node:fs');
  const tools = [
    ['/Library/Developer/CommandLineTools/usr/bin/clang', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'],
    ['/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang', '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'],
  ];
  for (const t of tools) if (fs.existsSync(t[0]) && fs.existsSync(t[1])) return t;
  return null;
}

/** A name no other process or worker thread uses: two cold-cache workers of one process build at once. */
function tmpTag() {
  let thread = 0;
  try { thread = require('node:worker_threads').threadId; } catch (e) {}
  return process.pid + '.' + thread + '.' + require('node:crypto').randomBytes(6).toString('hex');
}

/** A runner script that starts this WebKit build with the no-activation library loaded, or null. */
function quietRunner(pwRun) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
  const dir = path.dirname(pwRun);
  const app = path.join(dir, 'Playwright.app', 'Contents', 'MacOS', 'Playwright');
  if (!fs.existsSync(app)) return null;
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  let base = path.join(path.dirname(__filename), 'pw-noactivate');
  try { fs.mkdirSync(base, { recursive: true }); fs.accessSync(base, fs.constants.W_OK); } catch (e) {
    base = path.join(os.tmpdir(), 'walnut-pw-noactivate-' + process.getuid());
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  }
  const lib = path.join(base, 'noactivate-' + hash(NOACT_M) + '.dylib');
  if (!fs.existsSync(lib)) {
    const clang = clangPath();
    if (!clang) throw new Error('no Command Line Tools clang to build the no-activation library');
    const tmp = lib + '.' + tmpTag();
    fs.writeFileSync(tmp + '.m', NOACT_M);
    try {
      require('node:child_process').execFileSync(clang[0], ['-isysroot', clang[1], '-dynamiclib', '-fobjc-arc', '-arch', 'arm64', '-arch', 'x86_64', '-framework', 'AppKit', '-o', tmp, tmp + '.m'], { stdio: 'pipe', timeout: 120000 });
      fs.renameSync(tmp, lib);
    } finally { fs.rmSync(tmp + '.m', { force: true }); fs.rmSync(tmp, { force: true }); }
  }
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  // The DYLD_ variables are set here, past /bin/bash, which drops any it inherits.
  const body = '#!/bin/bash\nDYLD_FRAMEWORK_PATH=' + q(dir) + ' DYLD_LIBRARY_PATH=' + q(dir) + ' DYLD_INSERT_LIBRARIES=' + q(lib) + ' exec ' + q(app) + ' "$@"\n';
  const sh = path.join(base, 'webkit-' + hash(body) + '.sh');
  if (!fs.existsSync(sh)) {
    const tmp = sh + '.' + tmpTag();
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, sh);
  }
  return sh;
}

/** Playwright's own WebKit browser type (lib/server/webkit/webkit.js), where every launch picks its
  * executable: a client in this process, a test runner, a run-server or launchServer alike. A launch
  * that names its own executablePath (an option or the config default) keeps it. */
function quietWebkitServer(mod) {
  if (process.platform !== 'darwin' || process.env.WALNUT_PW_ACTIVATE === '1') return false;
  const proto = mod && mod.WebKit && mod.WebKit.prototype;
  if (!proto || Object.prototype.hasOwnProperty.call(proto, QUIET)) return false;
  const prepare = proto._prepareToLaunch;
  if (typeof prepare !== 'function') { noActWarn(new Error('this Playwright picks its executable elsewhere')); return false; }
  proto[QUIET] = true;
  proto._prepareToLaunch = async function (options) {
    const prepared = await prepare.apply(this, arguments);
    try {
      if (!(options && options.executablePath) && prepared && /[\\/]pw_run\.sh$/.test(String(prepared.executable))) {
        const run = quietRunner(prepared.executable);
        if (run) prepared.executable = run;
      }
    } catch (e) { noActWarn(e); }
    return prepared;
  };
  return true;
}

/** The same, from a Playwright library's folder (playwright-core's package root). */
function quietWebkit(root) {
  if (process.platform !== 'darwin' || process.env.WALNUT_PW_ACTIVATE === '1') return false;
  try { return quietWebkitServer(require(require('node:path').join(root, 'lib', 'server', 'webkit', 'webkit.js'))); }
  catch (e) { noActWarn(e); return false; }
}

/** Playwright's WebKit browser type file, in node_modules or Bun's cache. */
function isWebkitServer(file) {
  return typeof file === 'string' && /[\\/]playwright-core(@[^\\/]*)?[\\/]lib[\\/]server[\\/]webkit[\\/]webkit\.js$/.test(file);
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

module.exports = { SILENCE_JS, install, isPlaywrightCore, quietWebkit, quietWebkitServer, isWebkitServer, machineHold, holdBrowserTypes, holdBrowsers, isBrowserTypeServer };
